/**
 * The few fields seatledger's readers do not keep, read from the same transcripts and keyed the
 * same way, so they join onto seatledger's requests. seatledger (`load`) supplies every request's
 * model, time, client version, session and tokens; this file adds only:
 *
 * - **reasoning tokens per response**: Claude Code's `usage.output_tokens_details.thinking_tokens`,
 *   Codex's `reasoning_output_tokens` (in `token_usage_record.usage` and in `token_count`'s
 *   `last_token_usage`);
 * - **main thread or not** (Claude Code): `isSidechain` and `agentId` mark subagent responses, which
 *   run on their own models by design and are never a switch;
 * - **a model the person picked** (Claude Code): the client's own `/model` output, a
 *   `<local-command-stdout>` line reading "Set model to …", of which only the model id is kept;
 * - **a fallback the client recorded** (Claude Code): a `system` line whose subtype names a
 *   fallback, with `originalModel` and `fallbackModel` (seen as `model_refusal_fallback`);
 * - **auto-compaction points** (Claude Code): `compact_boundary` lines' `compactMetadata.preTokens`;
 * - **the context window Codex reports** for the model: `token_count`'s `model_context_window`;
 * - **what started a session** (Claude Code): `entrypoint`, which the Claude Agent SDK sets to
 *   `sdk-ts`, `sdk-py` or `sdk-cli` (its sessions are written to the same transcripts);
 * - **a Codex reroute in a rollout**: `event_msg` `model_reroute` with `from_model` and `to_model`.
 *   Codex 0.162.0 emits it but does not persist it (`codex-log.ts` reads where it does log it).
 *
 * Verified on 8 Oct 2026 against Claude Code transcripts written by 2.1.170–2.1.286 and Codex
 * rollouts written by 0.144–0.159 on a real machine, reading key names, model ids, counts and
 * dates only, and against the Codex source at rust-v0.162.0. Nothing here can hold prompt or
 * response text: every field is a count, a timestamp, an id, or a name the client wrote.
 *
 * The extracts are cached per transcript by size and modification time under
 * `~/.which-model/signals-v2/`, beside seatledger's own cache of the counts (`cache-v1`), so a
 * second run reads only what changed and history the client has since deleted is kept.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { listSourceFiles, type Client, type SourceDirs } from "seatledger";

export interface ResponseSignal {
  /** seatledger's request id for the same response. */
  key: string;
  /** Reasoning (thinking) tokens, or null when the transcript does not record them. */
  reasoning: number | null;
  /** Claude Code: false for subagent responses. Codex: always true. */
  main: boolean;
}

/** Codex's own reading of the model's context window, at one point in a thread. */
export interface WindowReading {
  session: string;
  ts: number;
  window: number;
}

/** A model the person picked with `/model` (Claude Code), as the client printed it. */
export interface ModelChoice {
  session: string;
  ts: number;
  model: string;
}

/** A fallback the client wrote into the transcript: requested `from`, served `to`. */
export interface FallbackNotice {
  session: string;
  ts: number;
  from: string;
  to: string;
  /** e.g. "refusal", as the client wrote it; "" when absent. */
  trigger: string;
  main: boolean;
  version: string;
}

/** A Claude Code auto- or manual compaction and the prompt size it happened at. */
export interface Compaction {
  session: string;
  ts: number;
  preTokens: number;
  trigger: string;
  main: boolean;
  version: string;
}

/**
 * A Codex reroute written into a rollout: `event_msg` with `type: "model_reroute"`. Codex 0.162.0
 * emits the event but its rollout policy drops it as transient, so no rollout on record has one;
 * it is read here so the day a version persists it, it is counted.
 */
export interface CodexReroute {
  session: string;
  ts: number;
  from: string;
  to: string;
  reason: string;
}

/** What started a Claude Code session: `cli`, `claude-desktop`, or the Agent SDK's `sdk-ts`, … */
export interface SessionEntry {
  session: string;
  ts: number;
  entrypoint: string;
}

export interface SignalExtract {
  client: Client;
  responses: ResponseSignal[];
  windows: WindowReading[];
  choices: ModelChoice[];
  fallbacks: FallbackNotice[];
  compactions: Compaction[];
  reroutes: CodexReroute[];
  entrypoints: SessionEntry[];
}

// ---------------------------------------------------------------------------------------------
// Untrusted JSON, one line at a time
// ---------------------------------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** A non-negative finite count, or undefined. */
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const time = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Stream a JSONL file, parsing only the lines `wanted` lets through. Transcripts run to hundreds of
 * megabytes of prompt and response text this never looks at; a line cut off mid-write is skipped.
 */
async function eachLine(
  file: string,
  wanted: (raw: string) => boolean,
  onObject: (line: Record<string, unknown>) => void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (raw.length === 0 || !wanted(raw)) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const o = obj(value);
      if (o) onObject(o);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

/** Terminal colour codes the client may print around the model name. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** The model id in the client's "Set model to …" output, lower-cased, without decoration. */
export function pickedModel(text: string): string | undefined {
  const clean = text.replace(ANSI, "");
  const at = clean.indexOf("Set model to");
  if (at < 0) return undefined;
  const rest = clean.slice(at + "Set model to".length, at + "Set model to".length + 120);
  const id = /claude-[a-z0-9][a-z0-9.-]*(?:\[[0-9a-z]+\])?/i.exec(rest)?.[0];
  if (id) return id.toLowerCase();
  const word = /^[\s`*"']*([A-Za-z0-9][\w.-]*)/.exec(rest)?.[1];
  return word ? word.toLowerCase() : undefined;
}

function userText(line: Record<string, unknown>): string {
  const content = obj(line.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => str(obj(b)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

export async function readClaudeCodeSignals(file: string): Promise<SignalExtract> {
  const byKey = new Map<string, ResponseSignal>();
  const choices: ModelChoice[] = [];
  const fallbacks: FallbackNotice[] = [];
  const compactions: Compaction[] = [];
  const entrypoints = new Map<string, SessionEntry>();

  await eachLine(
    file,
    (raw) =>
      raw.includes('"usage"') ||
      raw.includes("Set model to") ||
      raw.includes("allback") ||
      raw.includes("compact_boundary"),
    (line) => {
      const main = line.isSidechain !== true && !str(line.agentId);
      const session = str(line.sessionId) ?? "";
      const ts = time(line.timestamp);
      if (line.type === "assistant") {
        const message = obj(line.message);
        const usage = obj(message?.usage);
        const model = str(message?.model);
        if (!message || !usage || !model || model === "<synthetic>") return;
        const entrypoint = str(line.entrypoint);
        if (entrypoint && session && ts !== undefined && !entrypoints.has(session))
          entrypoints.set(session, { session, ts, entrypoint });
        const messageId = str(message.id) ?? str(line.uuid);
        if (!messageId) return;
        // seatledger's request id for the same response (readers/claude-code.ts)
        const key = `${messageId}:${str(line.requestId) ?? ""}`;
        const thinking = count(obj(usage.output_tokens_details)?.thinking_tokens);
        const prev = byKey.get(key);
        byKey.set(key, {
          key,
          // one response is several lines; counts only grow, so keep the largest
          reasoning:
            thinking === undefined
              ? (prev?.reasoning ?? null)
              : Math.max(thinking, prev?.reasoning ?? 0),
          main: (prev?.main ?? false) || main,
        });
        return;
      }
      if (ts === undefined || !session) return;
      if (line.type === "user") {
        if (!main) return;
        const text = userText(line);
        if (!text.trimStart().startsWith("<local-command-stdout>")) return;
        const model = pickedModel(text);
        if (model) choices.push({ session, ts, model });
        return;
      }
      if (line.type !== "system") return;
      const subtype = str(line.subtype) ?? "";
      const from = str(line.originalModel);
      const to = str(line.fallbackModel);
      if (/fallback/i.test(subtype) && from && to) {
        fallbacks.push({
          session,
          ts,
          from,
          to,
          trigger: str(line.trigger) ?? "",
          main,
          version: str(line.version) ?? "",
        });
        return;
      }
      if (subtype === "compact_boundary") {
        const meta = obj(line.compactMetadata);
        const preTokens = count(meta?.preTokens);
        if (preTokens === undefined || preTokens === 0) return;
        compactions.push({
          session,
          ts,
          preTokens,
          trigger: str(meta?.trigger) ?? "",
          main,
          version: str(line.version) ?? "",
        });
      }
    },
  );

  return {
    client: "claude-code",
    responses: [...byKey.values()],
    windows: [],
    choices,
    fallbacks,
    compactions,
    reroutes: [],
    entrypoints: [...entrypoints.values()],
  };
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

export async function readCodexSignals(file: string): Promise<SignalExtract> {
  const byKey = new Map<string, ResponseSignal>();
  const windows: WindowReading[] = [];
  const reroutes: CodexReroute[] = [];
  let thread = "";
  let lastWindow = -1;

  await eachLine(
    file,
    (raw) =>
      raw.includes('"token_count"') ||
      raw.includes('"token_usage_record"') ||
      raw.includes('"session_meta"') ||
      raw.includes('"model_reroute"'),
    (line) => {
      const payload = obj(line.payload) ?? {};
      const ts = time(line.timestamp);
      if (line.type === "session_meta") {
        thread = str(payload.id) ?? thread;
        return;
      }
      if (line.type === "event_msg" && payload.type === "model_reroute") {
        const from = str(payload.from_model);
        const to = str(payload.to_model);
        if (from && to && ts !== undefined)
          reroutes.push({ session: thread, ts, from, to, reason: str(payload.reason) ?? "" });
        return;
      }
      if (line.type === "token_usage_record") {
        const responseId = str(payload.response_id);
        if (!responseId) return;
        // seatledger's request id for the same response (readers/codex.ts)
        const key = `codex:${responseId}`;
        byKey.set(key, {
          key,
          reasoning: count(obj(payload.usage)?.reasoning_output_tokens) ?? null,
          main: true,
        });
        return;
      }
      if (line.type !== "event_msg" || payload.type !== "token_count") return;
      const info = obj(payload.info);
      if (!info) return;
      const window = count(info.model_context_window);
      if (window && ts !== undefined && window !== lastWindow) {
        windows.push({ session: thread, ts, window });
        lastWindow = window;
      }
      const total = count(obj(info.total_token_usage)?.total_tokens) ?? 0;
      const key = `codex-tc:${str(line.timestamp) ?? ""}:${total}`;
      if (byKey.has(key)) return;
      byKey.set(key, {
        key,
        reasoning: count(obj(info.last_token_usage)?.reasoning_output_tokens) ?? null,
        main: true,
      });
    },
  );

  // A reading taken before the thread id was seen belongs to the thread.
  for (const w of windows) if (!w.session) w.session = thread;
  for (const r of reroutes) if (!r.session) r.session = thread;
  return {
    client: "codex",
    responses: [...byKey.values()],
    windows,
    choices: [],
    fallbacks: [],
    compactions: [],
    reroutes,
    entrypoints: [],
  };
}

const READERS: Record<Client, (file: string) => Promise<SignalExtract>> = {
  "claude-code": readClaudeCodeSignals,
  codex: readCodexSignals,
};

// ---------------------------------------------------------------------------------------------
// Cache: one small file per transcript, counts and ids only
// ---------------------------------------------------------------------------------------------

/** v2 (SEAT-2) adds Codex reroute events and each session's entrypoint; v1 entries are re-read. */
export const SIGNALS_DIR = "signals-v2";

interface Wire {
  v: 2;
  src: string;
  size: number;
  mtimeMs: number;
  client: Client;
  /** key, reasoning (-1 = not recorded), main (1/0) */
  r: [string, number, 0 | 1][];
  w: [string, number, number][];
  c: [string, number, string][];
  f: [string, number, string, string, string, 0 | 1, string][];
  k: [string, number, number, string, 0 | 1, string][];
  /** session, ts, from, to, reason */
  x: [string, number, string, string, string][];
  /** session, ts, entrypoint */
  e: [string, number, string][];
}

interface Cached extends SignalExtract {
  src: string;
  size: number;
  mtimeMs: number;
}

const encode = (e: Cached): Wire => ({
  v: 2,
  src: e.src,
  size: e.size,
  mtimeMs: e.mtimeMs,
  client: e.client,
  r: e.responses.map((r) => [r.key, r.reasoning ?? -1, r.main ? 1 : 0]),
  w: e.windows.map((w) => [w.session, w.ts, w.window]),
  c: e.choices.map((c) => [c.session, c.ts, c.model]),
  f: e.fallbacks.map((f) => [f.session, f.ts, f.from, f.to, f.trigger, f.main ? 1 : 0, f.version]),
  k: e.compactions.map((k) => [k.session, k.ts, k.preTokens, k.trigger, k.main ? 1 : 0, k.version]),
  x: e.reroutes.map((x) => [x.session, x.ts, x.from, x.to, x.reason]),
  e: e.entrypoints.map((x) => [x.session, x.ts, x.entrypoint]),
});

const decode = (w: Wire): Cached => ({
  src: w.src,
  size: w.size,
  mtimeMs: w.mtimeMs,
  client: w.client,
  responses: w.r.map(([key, r, m]) => ({ key, reasoning: r < 0 ? null : r, main: m === 1 })),
  windows: w.w.map(([session, ts, window]) => ({ session, ts, window })),
  choices: w.c.map(([session, ts, model]) => ({ session, ts, model })),
  fallbacks: w.f.map(([session, ts, from, to, trigger, main, version]) => ({
    session,
    ts,
    from,
    to,
    trigger,
    main: main === 1,
    version,
  })),
  compactions: w.k.map(([session, ts, preTokens, trigger, main, version]) => ({
    session,
    ts,
    preTokens,
    trigger,
    main: main === 1,
    version,
  })),
  reroutes: (w.x ?? []).map(([session, ts, from, to, reason]) => ({
    session,
    ts,
    from,
    to,
    reason,
  })),
  entrypoints: (w.e ?? []).map(([session, ts, entrypoint]) => ({ session, ts, entrypoint })),
});

function readSignalCache(home: string): Map<string, Cached> {
  const dir = path.join(home, SIGNALS_DIR);
  const out = new Map<string, Cached>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Wire;
      if (wire.v !== 2 || typeof wire.src !== "string") continue;
      out.set(wire.src, decode(wire));
    } catch {
      // an interrupted write; the transcript is read again
    }
  }
  return out;
}

function writeSignalCache(home: string, entry: Cached): void {
  const dir = path.join(home, SIGNALS_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(
      dir,
      createHash("sha256").update(entry.src).digest("hex").slice(0, 32) + ".json",
    );
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // a cache that cannot be written costs speed, never a report
  }
}

// ---------------------------------------------------------------------------------------------
// Loading every transcript
// ---------------------------------------------------------------------------------------------

export interface SignalOptions {
  dirs: SourceDirs;
  home: string;
  since?: number;
  cache?: boolean;
  clients?: readonly Client[];
}

export interface Signals {
  responses: Map<string, ResponseSignal>;
  windows: WindowReading[];
  choices: ModelChoice[];
  fallbacks: FallbackNotice[];
  compactions: Compaction[];
  reroutes: CodexReroute[];
  /** Claude Code session → what started it (`cli`, `claude-desktop`, `sdk-ts`, …). */
  entrypoints: Map<string, string>;
}

const under = (file: string, roots: string[]): boolean =>
  roots.some((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

export async function loadSignals(opts: SignalOptions): Promise<Signals> {
  const clients = opts.clients ?? (["claude-code", "codex"] as const);
  const useCache = opts.cache ?? true;
  const since = opts.since;
  const cache = useCache ? readSignalCache(opts.home) : new Map<string, Cached>();
  const files = listSourceFiles(opts.dirs).filter((f) => clients.includes(f.client));
  const onDisk = new Set(files.map((f) => f.path));
  const extracts: SignalExtract[] = [];
  const toRead: typeof files = [];
  for (const f of files) {
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.client === f.client) {
      extracts.push(hit);
    } else if (since !== undefined && f.mtimeMs < since) {
      if (hit && hit.client === f.client) extracts.push(hit);
    } else {
      toRead.push(f);
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < toRead.length) {
      const f = toRead[next++]!;
      let extract: SignalExtract;
      try {
        extract = await READERS[f.client](f.path);
      } catch {
        continue; // unreadable: skip, never fail the report
      }
      extracts.push(extract);
      if (useCache)
        writeSignalCache(opts.home, { ...extract, src: f.path, size: f.size, mtimeMs: f.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));
  // History the client has since deleted, kept from the cache.
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !clients.includes(entry.client)) continue;
    if (!under(src, opts.dirs[entry.client])) continue;
    extracts.push(entry);
  }

  const responses = new Map<string, ResponseSignal>();
  const keyed = <T extends { session: string; ts: number }>(xs: T[]): T[] => {
    const m = new Map<string, T>();
    for (const x of xs) if (since === undefined || x.ts >= since) m.set(`${x.session}@${x.ts}`, x);
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  };
  const all = {
    windows: [] as WindowReading[],
    choices: [] as ModelChoice[],
    fallbacks: [] as FallbackNotice[],
    compactions: [] as Compaction[],
    reroutes: [] as CodexReroute[],
  };
  const entrypoints = new Map<string, string>();
  for (const e of extracts) {
    for (const x of e.entrypoints ?? [])
      if (!entrypoints.has(x.session)) entrypoints.set(x.session, x.entrypoint);
    all.reroutes.push(...(e.reroutes ?? []));
    for (const r of e.responses) {
      const prev = responses.get(r.key);
      responses.set(
        r.key,
        prev
          ? {
              key: r.key,
              reasoning:
                prev.reasoning === null
                  ? r.reasoning
                  : r.reasoning === null
                    ? prev.reasoning
                    : Math.max(prev.reasoning, r.reasoning),
              main: prev.main || r.main,
            }
          : r,
      );
    }
    all.windows.push(...e.windows);
    all.choices.push(...e.choices);
    all.fallbacks.push(...e.fallbacks);
    all.compactions.push(...e.compactions);
  }
  return {
    responses,
    windows: keyed(all.windows),
    choices: keyed(all.choices),
    fallbacks: keyed(all.fallbacks),
    compactions: keyed(all.compactions),
    reroutes: keyed(all.reroutes),
    entrypoints,
  };
}
