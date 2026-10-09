/**
 * The CLI end to end on synthetic transcripts: the report, --json, --session and --since, the
 * once-a-day hand-off line and every way it stays silent, and what never reaches the output.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report, SessionDetail } from "./analyze.js";
import { dim, HINT, hintFile, quietFromEnv, teamHint, TEAM_LEDGER_URL } from "./hint.js";
import { main } from "./main.js";
import { writeSyntheticHistory, type Synthetic } from "./synthetic.js";

let root: string;
let synth: Synthetic;
let n = 0;
const saved = {
  home: process.env.WHICH_MODEL_HOME,
  now: process.env.WHICH_MODEL_NOW,
  quiet: process.env.WHICH_MODEL_QUIET,
  noColor: process.env.NO_COLOR,
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "which-model-main-"));
  synth = writeSyntheticHistory(path.join(root, "synthetic"));
  process.env.WHICH_MODEL_NOW = new Date(synth.now).toISOString();
  delete process.env.WHICH_MODEL_QUIET;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, env] of [
    ["home", "WHICH_MODEL_HOME"],
    ["now", "WHICH_MODEL_NOW"],
    ["quiet", "WHICH_MODEL_QUIET"],
    ["noColor", "NO_COLOR"],
  ] as const) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
});

async function run(args: string[], opts: { tty?: boolean; home?: string } = {}) {
  process.env.WHICH_MODEL_HOME = opts.home ?? path.join(root, `home-${++n}`);
  let out = "";
  let err = "";
  const code = await main(
    [...args, "--claude-dir", synth.claudeDir, "--codex-dir", synth.codexDir],
    {
      out: { write: (s: string) => (out += s), isTTY: opts.tty ?? false },
      err: { write: (s: string) => (err += s) },
    },
  );
  return { code, out, err };
}

describe("which-model", () => {
  it("prints the report: models by day, switches, reasoning, steps and windows", async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    for (const heading of [
      "Models that answered, last 7 active days",
      "Served-model switches nothing you did explains (Claude Code, main thread): 2 in 1 session",
      "after a fallback notice the client recorded",
      "Reasoning tokens per response, by model",
      "516 (",
      "Step changes (seatledger's rolling baseline)",
      "Context window, as Codex reported it",
      "Nothing was sent anywhere.",
    ])
      expect(out).toContain(heading);
  });

  it("never prints a prompt, a path, a project name or response text", async () => {
    const { out } = await run([]);
    const json = (await run(["--json"])).out;
    for (const text of [out, json]) {
      expect(text).not.toContain("demo-app");
      expect(text).not.toContain("/home/");
      expect(text).not.toContain("synthetic prompt");
      expect(text).not.toContain("synthetic notice");
    }
  });

  it("--json is the whole report, and never carries the hand-off line", async () => {
    const { code, out } = await run(["--json"], { tty: true });
    expect(code).toBe(0);
    const report = JSON.parse(out) as Report;
    expect(report.switches.length).toBeGreaterThan(0);
    expect(report.sessions.length).toBeGreaterThan(90);
    expect(report.since).toBeNull();
    expect(out).not.toContain(TEAM_LEDGER_URL);
  });

  it("--since narrows the range", async () => {
    const report = JSON.parse((await run(["--json", "--since", "2026-09-01"])).out) as Report;
    expect(report.since).toBe("2026-09-01");
    expect(report.days.every((d) => d.day >= "2026-09-01")).toBe(true);
    expect(report.switches.filter((s) => s.client === "claude-code")).toEqual([]);
  });

  it("--session shows one session in order, by any unique prefix", async () => {
    const report = JSON.parse((await run(["--json"])).out) as Report;
    const id = report.switches.find((s) => s.recorded === "fallback-notice")!.session;
    const text = await run(["--session", id.slice(0, 8)]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`Session ${id} (Claude Code)`);
    expect(text.out).toMatch(/claude-opus-4-8\s+308 responses/);
    const detail = JSON.parse((await run(["--session", id, "--json"])).out) as SessionDetail;
    expect(detail.runs).toHaveLength(3);
    const missing = await run(["--session", "ffffffff"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no session starting with");
  });

  it("demo runs on synthetic history and says so", async () => {
    let out = "";
    const code = await main(["demo"], {
      out: { write: (s: string) => (out += s) },
      err: { write: () => 0 },
    });
    expect(code).toBe(0);
    expect(out.startsWith("Synthetic history, generated for this demo: not anyone's usage.")).toBe(
      true,
    );
  });

  it("bad arguments exit 2 with a usage line", async () => {
    for (const args of [
      ["--client", "cursor"],
      ["--since", "yesterday"],
      ["frobnicate"],
      ["--session", "ab"],
    ]) {
      const { code, err } = await run(args);
      expect(code).toBe(2);
      expect(err).toContain("which-model --help");
    }
  });
});

describe("the hand-off line", () => {
  it("is the last line on a terminal, once a day, naming what the ledger shows today", async () => {
    const home = path.join(root, "hint-home");
    const first = await run([], { tty: true, home });
    const lines = first.out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(HINT);
    expect(HINT).toContain("?ref=which-model");
    expect(HINT).toContain("model mix, by model and by day");
    expect(HINT).not.toMatch(/alert|email|notif/i);
    const again = await run([], { tty: true, home });
    expect(again.out).not.toContain(TEAM_LEDGER_URL);
    expect(existsSync(hintFile(home))).toBe(true);
  });

  it("never off a terminal, with --quiet, with WHICH_MODEL_QUIET, in --session or in demo", async () => {
    expect((await run([], { tty: false })).out).not.toContain(TEAM_LEDGER_URL);
    expect((await run(["--quiet"], { tty: true })).out).not.toContain(TEAM_LEDGER_URL);
    process.env.WHICH_MODEL_QUIET = "1";
    try {
      expect((await run([], { tty: true })).out).not.toContain(TEAM_LEDGER_URL);
    } finally {
      delete process.env.WHICH_MODEL_QUIET;
    }
    const report = JSON.parse((await run(["--json"])).out) as Report;
    const id = report.sessions[0]!.session;
    expect((await run(["--session", id], { tty: true })).out).not.toContain(TEAM_LEDGER_URL);
    let demo = "";
    await main(["demo"], {
      out: { write: (s: string) => (demo += s), isTTY: true },
      err: { write: () => 0 },
    });
    expect(demo).not.toContain(TEAM_LEDGER_URL);
  });

  it("quietFromEnv, dim and a read-only home", () => {
    expect(quietFromEnv({ WHICH_MODEL_QUIET: "true" })).toBe(true);
    expect(quietFromEnv({ WHICH_MODEL_QUIET: "0" })).toBe(false);
    expect(quietFromEnv({})).toBe(false);
    expect(dim("x", {})).toBe("\u001b[2mx\u001b[22m");
    expect(dim("x", { NO_COLOR: "1" })).toBe("x");
    const ctx = { home: "/dev/null/nope", now: synth.now, env: {}, tty: true, quiet: false };
    expect(teamHint(ctx)).toBeNull();
  });

  it("names the free seatledger plan as packages/config defines it", () => {
    const products = new URL("../../../packages/config/src/products.ts", import.meta.url);
    if (!existsSync(products)) return; // the public repo has no packages/config
    const src = readFileSync(products, "utf8");
    const free = /lookupKey: "seatledger_free"[\s\S]*?quantity: (\d+)/.exec(src)?.[1];
    expect(HINT).toContain(`free for up to ${free} developers`);
  });
});

describe("local only", () => {
  it("no source file can make a network request", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(
        /\bfetch\(|from "node:(http|https|net|tls|dgram|dns)"|XMLHttpRequest|WebSocket/,
      );
    }
  });
});
