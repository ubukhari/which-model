/**
 * Codex's own log is where it says which model answered: a "server reported model" line per turn,
 * a warning when it differs from the one requested. These tests build a log database in Codex's
 * schema (codex-rs/state/logs_migrations at rust-v0.162.0) and the legacy text log, and check that
 * only those lines are read, and only their model ids, times and thread ids are kept.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  codexHomeOf,
  KEPT_FILE,
  keepServed,
  loadSqlite,
  readCodexLog,
  servedFrom,
} from "./codex-log.js";

const root = mkdtempSync(path.join(tmpdir(), "which-model-codex-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-10-06T10:00:00Z") / 1000;

describe("servedFrom", () => {
  it("reads the two lines Codex writes, and nothing else", () => {
    expect(servedFrom("server reported model gpt-5.6-sol (matches requested model)")).toEqual({
      served: "gpt-5.6-sol",
      requested: null,
    });
    expect(
      servedFrom("server reported model gpt-5.2 while requested model was gpt-5.3-codex"),
    ).toEqual({ served: "gpt-5.2", requested: "gpt-5.3-codex" });
    expect(servedFrom("model switched to gpt-5.2 by the user")).toBeUndefined();
  });

  it("Codex's home is the directory its sessions directory sits in", () => {
    expect(codexHomeOf(["/u/.codex/sessions", "/u/.codex/archived_sessions"])).toBe("/u/.codex");
    expect(codexHomeOf([])).toBeNull();
  });
});

describe("readCodexLog", () => {
  const home = path.join(root, "codex");
  let sqliteAvailable = false;

  beforeAll(async () => {
    mkdirSync(path.join(home, "log"), { recursive: true });
    const lib = await loadSqlite();
    sqliteAvailable = lib !== null;
    if (lib) {
      const db = new lib.DatabaseSync(path.join(home, "logs_2.sqlite"));
      db.exec(`CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT,
        file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0)`);
      const add = db.prepare(
        "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (?, 0, ?, 'codex_core::session', ?, ?)",
      );
      add.run(T0, "INFO", "server reported model gpt-5.3-codex (matches requested model)", "th-1");
      add.run(
        T0 + 60,
        "WARN",
        "server reported model gpt-5.2 while requested model was gpt-5.3-codex",
        "th-1",
      );
      add.run(T0 + 120, "INFO", "a line with a secret prompt in it", "th-1");
      db.close();
      // an older state database: the log table with `message`, as before the column was renamed
      const old = new lib.DatabaseSync(path.join(home, "state_4.sqlite"));
      old.exec(
        "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, message TEXT)",
      );
      old
        .prepare(
          "INSERT INTO logs (ts, ts_nanos, level, target, message) VALUES (?, 0, 'WARN', 't', ?)",
        )
        .run(T0 - 86_400, "server reported model gpt-5.2 while requested model was gpt-5.5");
      old.close();
      // a state database with no log table is not a log
      const state = new lib.DatabaseSync(path.join(home, "state_5.sqlite"));
      state.exec("CREATE TABLE threads (id TEXT)");
      state.close();
    }
    writeFileSync(
      path.join(home, "log", "codex-tui.log"),
      [
        "2026-10-01T09:00:00.000000Z  INFO codex_core::session: server reported model gpt-5.5 (matches requested model)",
        "2026-10-01T09:00:01.000000Z  INFO codex_core::codex: a prompt that must never be kept",
        "not a log line",
      ].join("\n") + "\n",
    );
  });

  it("reads the served-model lines from the databases and the text log, oldest first", async () => {
    const log = await readCodexLog(home);
    expect(log.textLogs).toBe(1);
    const text = {
      ts: Date.parse("2026-10-01T09:00:00Z"),
      thread: null,
      served: "gpt-5.5",
      requested: null,
    };
    if (!sqliteAvailable) {
      expect(log.served).toEqual([text]);
      expect(log.unread[0]?.reason).toMatch(/cannot read SQLite/);
      return;
    }
    expect(log.databases).toBe(2);
    expect(log.unread).toEqual([]);
    expect(log.served).toEqual([
      text,
      { ts: (T0 - 86_400) * 1000, thread: null, served: "gpt-5.2", requested: "gpt-5.5" },
      { ts: T0 * 1000, thread: "th-1", served: "gpt-5.3-codex", requested: null },
      { ts: (T0 + 60) * 1000, thread: "th-1", served: "gpt-5.2", requested: "gpt-5.3-codex" },
    ]);
    expect(log.lines).toBe(3 + 1 + 3);
    expect(JSON.stringify(log)).not.toMatch(/secret prompt|never be kept/);
    // `since` drops older lines
    const later = await readCodexLog(home, (T0 + 30) * 1000);
    expect(later.served.map((s) => s.served)).toEqual(["gpt-5.2"]);
  });

  it("no Codex home, or one with nothing in it, is nothing read", async () => {
    expect(await readCodexLog(null)).toMatchObject({ databases: 0, textLogs: 0, served: [] });
    const empty = mkdtempSync(path.join(root, "empty-"));
    expect(await readCodexLog(empty)).toMatchObject({ databases: 0, textLogs: 0, served: [] });
  });
});

describe("keepServed", () => {
  it("keeps the lines past Codex's pruning: model ids, times and threads only", () => {
    const home = path.join(root, "which-model-home");
    const a = { ts: 1, thread: "th", served: "gpt-5.2", requested: "gpt-5.3-codex" };
    const b = { ts: 2, thread: null, served: "gpt-5.5", requested: null };
    expect(keepServed(home, [a])).toEqual([a]);
    // Codex pruned `a`; it stays on record
    expect(keepServed(home, [b, b])).toEqual([a, b]);
    const kept = readFileSync(path.join(home, KEPT_FILE), "utf8");
    expect(JSON.parse(kept)).toEqual({
      v: 1,
      rows: [
        [1, "th", "gpt-5.2", "gpt-5.3-codex"],
        [2, null, "gpt-5.5", null],
      ],
    });
  });
});
