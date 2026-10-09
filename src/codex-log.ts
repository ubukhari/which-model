/**
 * What Codex itself logs about the model that answered. Its rollouts record only the model it
 * requested; the model the server reports is checked by Codex on every turn and written to its
 * own log, not to the rollout:
 *
 * - `codex-rs/core/src/session/mod.rs` (rust-v0.162.0, 8 Oct 2026), on the server's model
 *   (`ResponseEvent::ServerModel`, from the response stream):
 *   `info!("server reported model {server} (matches requested model)")`, or, when they differ,
 *   `warn!("server reported model {server} while requested model was {requested}")` and a
 *   `ModelReroute { from_model, to_model, reason: high_risk_cyber_activity }` event;
 * - `codex-rs/rollout/src/policy.rs` lists `ModelReroute` among the "transient, non-durable"
 *   events, so the reroute never reaches a rollout file;
 * - the tracing lines go to Codex's log database, `$CODEX_HOME/logs_<n>.sqlite` (table `logs`,
 *   text in `feedback_log_body`, `message` before that column was renamed; older versions kept
 *   the table in `state_<n>.sqlite`), and, before 0.162, to the text log `log/codex-tui.log`.
 *
 * So this reads exactly those lines and nothing else: a SQL `LIKE` on the phrase, or a substring
 * test per line of the text log, and from each match only the two model ids, the time and the
 * thread id. Codex prunes its log, so it covers days, not months; a mismatch is a reroute Codex
 * logged itself.
 *
 * SQLite is read with `node:sqlite`, which Node has had since 22.5 (without a flag since 22.13).
 * On an older Node the database is reported as unread, never as empty.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
// types only: the module itself is imported on demand, so an older Node still runs the rest
import type * as NodeSqlite from "node:sqlite";

/** One "server reported model" line. */
export interface ServedLine {
  ts: number;
  /** Codex's thread id, when the line names one. */
  thread: string | null;
  served: string;
  /** null when the line says the server's model matched the request. */
  requested: string | null;
}

export interface CodexLog {
  /** Log databases and text logs found under Codex's home. */
  databases: number;
  textLogs: number;
  /** Databases that could not be opened, and why (an old Node, a locked or corrupt file). */
  unread: { reason: string; count: number }[];
  /** Lines in what was read, and the time they span. */
  lines: number;
  from: number | null;
  to: number | null;
  /** The "server reported model" lines in range, oldest first. */
  served: ServedLine[];
}

const MATCHES = /server reported model (\S+) \(matches requested model\)/;
const DIFFERS = /server reported model (\S+) while requested model was (\S+)/;
export const PHRASE = "server reported model";

/** The models one log line names, or undefined when it is not a served-model line. */
export function servedFrom(text: string): { served: string; requested: string | null } | undefined {
  const d = DIFFERS.exec(text);
  if (d) return { served: d[1]!, requested: d[2]! };
  const m = MATCHES.exec(text);
  if (m) return { served: m[1]!, requested: null };
  return undefined;
}

/** Codex's home: the directory its sessions directory sits in. */
export function codexHomeOf(sessionsDirs: readonly string[]): string | null {
  const first = sessionsDirs[0];
  return first ? path.dirname(first) : null;
}

type Sqlite = typeof NodeSqlite;

let sqlite: Promise<Sqlite | null> | undefined;

/** `node:sqlite`, without the experimental-feature warning it prints on import; null when absent. */
export function loadSqlite(): Promise<Sqlite | null> {
  sqlite ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      if (/SQLite/i.test(text)) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return (await import("node:sqlite")) as Sqlite;
    } catch {
      return null;
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqlite;
}

const DB_NAME = /^(?:logs|state)_\d+\.sqlite$/;

function readDatabase(
  lib: Sqlite,
  file: string,
  since: number | undefined,
): { lines: number; from: number | null; to: number | null; served: ServedLine[] } | null {
  const db = new lib.DatabaseSync(file, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'")
      .get();
    if (!table) return null;
    const columns = (db.prepare("PRAGMA table_info(logs)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    const body = columns.includes("feedback_log_body")
      ? "feedback_log_body"
      : columns.includes("message")
        ? "message"
        : null;
    if (!body || !columns.includes("ts")) return null;
    const thread = columns.includes("thread_id") ? "thread_id" : "NULL";
    const span = db.prepare("SELECT count(*) AS n, min(ts) AS a, max(ts) AS b FROM logs").get() as {
      n: number;
      a: number | null;
      b: number | null;
    };
    const rows = db
      .prepare(
        `SELECT ts, ${thread} AS thread, ${body} AS body FROM logs WHERE ${body} LIKE ? AND ts >= ? ORDER BY ts`,
      )
      .all(`%${PHRASE}%`, since === undefined ? 0 : Math.floor(since / 1000)) as {
      ts: number;
      thread: string | null;
      body: string | null;
    }[];
    const served: ServedLine[] = [];
    for (const r of rows) {
      const m = r.body ? servedFrom(r.body) : undefined;
      if (m) served.push({ ts: r.ts * 1000, thread: r.thread ?? null, ...m });
    }
    return {
      lines: span.n,
      from: span.a === null ? null : span.a * 1000,
      to: span.b === null ? null : span.b * 1000,
      served,
    };
  } finally {
    db.close();
  }
}

/** A tracing line's leading RFC 3339 time, as epoch ms. */
const leadingTime = (line: string): number | undefined => {
  const t = Date.parse(line.slice(0, 40).split(/\s+/)[0] ?? "");
  return Number.isFinite(t) ? t : undefined;
};

async function readTextLog(
  file: string,
  since: number | undefined,
): Promise<{ lines: number; from: number | null; to: number | null; served: ServedLine[] }> {
  const served: ServedLine[] = [];
  let lines = 0;
  let from: number | null = null;
  let to: number | null = null;
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      lines += 1;
      const ts = leadingTime(raw);
      if (ts !== undefined) {
        from ??= ts;
        to = ts;
      }
      if (!raw.includes(PHRASE) || ts === undefined) continue;
      if (since !== undefined && ts < since) continue;
      const m = servedFrom(raw);
      const thread = /thread[._]id[=:]\s*"?([0-9a-f-]{8,})/i.exec(raw)?.[1] ?? null;
      if (m) served.push({ ts, thread, ...m });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { lines, from, to, served };
}

/** which-model's own copy of the served-model lines, kept past Codex's pruning of its log. */
export const KEPT_FILE = "codex-served-v1.json";

type KeptRow = [ts: number, thread: string | null, served: string, requested: string | null];

/**
 * Merge `lines` into which-model's copy under `home` and return everything kept. Codex prunes its
 * log within days; this keeps the model ids, times and thread ids of the lines it has seen, so a
 * reroute stays on record. Best effort: a copy that cannot be written costs history, not a report.
 */
export function keepServed(home: string, lines: readonly ServedLine[]): ServedLine[] {
  const file = path.join(home, KEPT_FILE);
  const all = new Map<string, ServedLine>();
  const key = (l: ServedLine) => `${l.ts}|${l.thread ?? ""}|${l.served}|${l.requested ?? ""}`;
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as { v: number; rows: KeptRow[] };
    if (rows.v === 1 && Array.isArray(rows.rows))
      for (const [ts, thread, served, requested] of rows.rows) {
        const l = { ts, thread, served, requested };
        all.set(key(l), l);
      }
  } catch {
    // nothing kept yet, or a partial write: start from what Codex has now
  }
  const before = all.size;
  for (const l of lines) all.set(key(l), l);
  const merged = [...all.values()].sort((a, b) => a.ts - b.ts);
  if (all.size !== before || !existsSync(file)) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const rows: KeptRow[] = merged.map((l) => [l.ts, l.thread, l.served, l.requested]);
      writeFileSync(tmp, JSON.stringify({ v: 1, rows }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // read-only home: the report still has what Codex's log holds now
    }
  }
  return merged;
}

/** Every served-model line Codex logged on this machine, from its log database and text log. */
export async function readCodexLog(codexHome: string | null, since?: number): Promise<CodexLog> {
  const out: CodexLog = {
    databases: 0,
    textLogs: 0,
    unread: [],
    lines: 0,
    from: null,
    to: null,
    served: [],
  };
  if (!codexHome || !existsSync(codexHome)) return out;
  const unread = new Map<string, number>();
  const span = (r: { lines: number; from: number | null; to: number | null }) => {
    out.lines += r.lines;
    if (r.from !== null) out.from = out.from === null ? r.from : Math.min(out.from, r.from);
    if (r.to !== null) out.to = out.to === null ? r.to : Math.max(out.to, r.to);
  };

  let names: string[];
  try {
    names = readdirSync(codexHome).filter((n) => DB_NAME.test(n));
  } catch {
    names = [];
  }
  const miss = (reason: string) => unread.set(reason, (unread.get(reason) ?? 0) + 1);
  for (const name of names.sort()) {
    const lib = await loadSqlite();
    if (!lib) {
      // a state database may or may not hold the log; only a log database is counted unread
      if (name.startsWith("logs_")) {
        out.databases += 1;
        miss(`this Node (${process.version}) cannot read SQLite; Node 22.13 or later can`);
      }
      continue;
    }
    try {
      const r = readDatabase(lib, path.join(codexHome, name), since);
      if (!r) continue; // a state database without a log table
      out.databases += 1;
      span(r);
      out.served.push(...r.served);
    } catch {
      out.databases += 1;
      miss("it could not be opened read-only");
    }
  }

  const text = path.join(codexHome, "log", "codex-tui.log");
  try {
    if (existsSync(text) && statSync(text).isFile()) {
      out.textLogs += 1;
      const r = await readTextLog(text, since);
      span(r);
      out.served.push(...r.served);
    }
  } catch {
    miss("the text log could not be read");
  }

  out.served.sort((a, b) => a.ts - b.ts);
  out.unread = [...unread].map(([reason, count]) => ({ reason, count }));
  return out;
}
