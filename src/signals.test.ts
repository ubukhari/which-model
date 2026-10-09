/**
 * The signals reader keys every response exactly as seatledger's readers do, so the two join; it
 * keeps reasoning tokens, the main-thread flag, /model choices, fallback notices, compactions and
 * Codex's context window, and nothing else.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readClaudeCodeFile, readCodexFile } from "seatledger";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadSignals,
  pickedModel,
  readClaudeCodeSignals,
  readCodexSignals,
  SIGNALS_DIR,
} from "./signals.js";

const root = mkdtempSync(path.join(tmpdir(), "which-model-signals-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const S = "11111111-2222-4333-a444-555555555555";
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const assistant = (
  id: string,
  req: string,
  ts: string,
  model: string,
  thinking: number | undefined,
  extra: Record<string, unknown> = {},
) =>
  line({
    type: "assistant",
    isSidechain: false,
    sessionId: S,
    timestamp: ts,
    version: "2.1.197",
    cwd: "/home/someone/secret-project",
    requestId: req,
    ...extra,
    message: {
      id,
      model,
      role: "assistant",
      content: [{ type: "text", text: "a reply that must never be kept" }],
      usage: {
        input_tokens: 10,
        output_tokens: 300,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
        ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
      },
    },
  });

const CLAUDE = [
  // a session the Claude Agent SDK started: the transcript says so in `entrypoint`
  assistant("msg_1", "req_1", "2026-07-02T00:50:00Z", "claude-fable-5", 100, {
    entrypoint: "sdk-ts",
  }),
  // the same response again, its counts grown: the largest wins
  assistant("msg_1", "req_1", "2026-07-02T00:50:01Z", "claude-fable-5", 250),
  line({
    type: "system",
    subtype: "model_refusal_fallback",
    level: "warning",
    sessionId: S,
    timestamp: "2026-07-02T00:57:00Z",
    version: "2.1.197",
    isSidechain: false,
    originalModel: "claude-fable-5",
    fallbackModel: "claude-opus-4-8",
    trigger: "refusal",
    content: "a notice whose text is never kept",
  }),
  assistant("msg_2", "req_2", "2026-07-02T00:58:00Z", "claude-opus-4-8", undefined),
  assistant("msg_3", "req_3", "2026-07-02T01:00:00Z", "claude-haiku-4-5-20251001", 40, {
    isSidechain: true,
    agentId: "a1b2",
  }),
  assistant("msg_4", "req_4", "2026-07-02T01:01:00Z", "<synthetic>", 0),
  line({
    type: "user",
    isSidechain: false,
    sessionId: S,
    timestamp: "2026-07-03T05:19:00Z",
    message: {
      role: "user",
      content:
        "<local-command-stdout>Set model to \u001b[1m`claude-fable-5[1m]`\u001b[22m</local-command-stdout>",
    },
  }),
  // a person's prompt that happens to contain the words is not a model change
  line({
    type: "user",
    isSidechain: false,
    sessionId: S,
    timestamp: "2026-07-03T05:20:00Z",
    message: { role: "user", content: "Set model to claude-opus-5 in the config file please" },
  }),
  line({
    type: "system",
    subtype: "compact_boundary",
    sessionId: S,
    timestamp: "2026-07-03T06:00:00Z",
    version: "2.1.197",
    isSidechain: false,
    compactMetadata: { trigger: "auto", preTokens: 998_765, postTokens: 40_000 },
  }),
  "{ not json",
].join("\n");

const T = "019a0000-0000-7000-8000-000000000001";
const CODEX = [
  line({
    timestamp: "2026-07-13T10:00:00.000Z",
    type: "session_meta",
    payload: { id: T, cwd: "/home/someone/secret-project", cli_version: "0.144.2" },
  }),
  line({
    timestamp: "2026-07-13T10:00:01.000Z",
    type: "turn_context",
    payload: { turn_id: "t1", model: "gpt-5.6-sol" },
  }),
  line({
    timestamp: "2026-07-13T10:00:05.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 5000 },
        last_token_usage: {
          input_tokens: 4000,
          cached_input_tokens: 3000,
          output_tokens: 1000,
          reasoning_output_tokens: 516,
          total_tokens: 5000,
        },
        model_context_window: 258_400,
      },
    },
  }),
  // repeated event, same running total: the same response
  line({
    timestamp: "2026-07-13T10:00:06.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 5000 },
        last_token_usage: { input_tokens: 4000, output_tokens: 1000, total_tokens: 5000 },
        model_context_window: 258_400,
      },
    },
  }),
  line({
    timestamp: "2026-07-13T10:01:00.000Z",
    type: "token_usage_record",
    payload: {
      response_id: "resp_9",
      turn_id: "t1",
      usage: { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 1034 },
    },
  }),
  // Codex 0.162.0's reroute event, in the shape its protocol serialises; no rollout on record
  // carries one (its rollout policy drops it), so this is what a version that kept it would write
  line({
    timestamp: "2026-07-13T10:01:30.000Z",
    type: "event_msg",
    payload: {
      type: "model_reroute",
      from_model: "gpt-5.3-codex",
      to_model: "gpt-5.2",
      reason: "high_risk_cyber_activity",
    },
  }),
].join("\n");

describe("pickedModel", () => {
  it("takes the model id from the client's /model output, without decoration", () => {
    expect(pickedModel("Set model to claude-opus-5")).toBe("claude-opus-5");
    expect(pickedModel("Set model to `claude-opus-5-5`")).toBe("claude-opus-5-5");
    expect(pickedModel("Set model to \u001b[1mclaude-fable-5[1m]\u001b[22m")).toBe(
      "claude-fable-5[1m]",
    );
    expect(pickedModel("Set model to Default (claude-opus-5-5)")).toBe("claude-opus-5-5");
    expect(pickedModel("Set model to opus")).toBe("opus");
    expect(pickedModel("Kept model as claude-opus-5")).toBeUndefined();
  });
});

describe("Claude Code", () => {
  const file = path.join(root, "claude", "p", `${S}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, CLAUDE + "\n");

  it("keys each response as seatledger does, so every seatledger request joins", async () => {
    const [ours, theirs] = await Promise.all([
      readClaudeCodeSignals(file),
      readClaudeCodeFile(file),
    ]);
    const keys = new Set(ours.responses.map((r) => r.key));
    expect(theirs.requests.length).toBe(3);
    for (const r of theirs.requests) expect(keys.has(r.id)).toBe(true);
  });

  it("keeps reasoning tokens (largest line), the main-thread flag, choices, notices and compactions", async () => {
    const x = await readClaudeCodeSignals(file);
    const by = new Map(x.responses.map((r) => [r.key, r]));
    expect(by.get("msg_1:req_1")).toEqual({ key: "msg_1:req_1", reasoning: 250, main: true });
    expect(by.get("msg_2:req_2")).toEqual({ key: "msg_2:req_2", reasoning: null, main: true });
    expect(by.get("msg_3:req_3")).toEqual({ key: "msg_3:req_3", reasoning: 40, main: false });
    expect(by.has("msg_4:req_4")).toBe(false);
    expect(x.choices).toEqual([
      { session: S, ts: Date.parse("2026-07-03T05:19:00Z"), model: "claude-fable-5[1m]" },
    ]);
    expect(x.fallbacks).toEqual([
      {
        session: S,
        ts: Date.parse("2026-07-02T00:57:00Z"),
        from: "claude-fable-5",
        to: "claude-opus-4-8",
        trigger: "refusal",
        main: true,
        version: "2.1.197",
      },
    ]);
    expect(x.compactions).toEqual([
      {
        session: S,
        ts: Date.parse("2026-07-03T06:00:00Z"),
        preTokens: 998_765,
        trigger: "auto",
        main: true,
        version: "2.1.197",
      },
    ]);
  });

  it("keeps what started each session, which marks the Claude Agent SDK's", async () => {
    const x = await readClaudeCodeSignals(file);
    expect(x.entrypoints).toEqual([
      { session: S, ts: Date.parse("2026-07-02T00:50:00Z"), entrypoint: "sdk-ts" },
    ]);
    expect(x.reroutes).toEqual([]);
  });

  it("holds no text: no reply, notice, prompt or path survives into the extract", async () => {
    const json = JSON.stringify(await readClaudeCodeSignals(file));
    for (const s of ["never be kept", "never kept", "config file", "secret-project", "/home/"])
      expect(json).not.toContain(s);
  });
});

describe("Codex", () => {
  const file = path.join(
    root,
    "codex",
    "2026",
    "07",
    "13",
    `rollout-2026-07-13T10-00-00-${T}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, CODEX + "\n");

  it("keys each response as seatledger does, and keeps reasoning tokens and the window", async () => {
    const [ours, theirs] = await Promise.all([readCodexSignals(file), readCodexFile(file)]);
    const by = new Map(ours.responses.map((r) => [r.key, r]));
    expect(theirs.requests.length).toBeGreaterThan(0);
    for (const r of theirs.requests) expect(by.has(r.id)).toBe(true);
    expect(by.get("codex:resp_9")?.reasoning).toBe(1034);
    expect(by.get("codex-tc:2026-07-13T10:00:05.000Z:5000")?.reasoning).toBe(516);
    expect(ours.windows).toEqual([
      { session: T, ts: Date.parse("2026-07-13T10:00:05.000Z"), window: 258_400 },
    ]);
  });

  it("reads a model_reroute event, should a rollout ever carry one", async () => {
    const ours = await readCodexSignals(file);
    expect(ours.reroutes).toEqual([
      {
        session: T,
        ts: Date.parse("2026-07-13T10:01:30.000Z"),
        from: "gpt-5.3-codex",
        to: "gpt-5.2",
        reason: "high_risk_cyber_activity",
      },
    ]);
  });
});

describe("loadSignals", () => {
  it("caches per transcript and keeps history the client has since deleted", async () => {
    const home = path.join(root, "home");
    const dirs = { "claude-code": [path.join(root, "claude")], codex: [path.join(root, "codex")] };
    const first = await loadSignals({ dirs, home });
    expect(first.responses.size).toBeGreaterThan(3);
    expect(first.fallbacks).toHaveLength(1);
    expect(first.reroutes).toHaveLength(1);
    expect(first.entrypoints.get(S)).toBe("sdk-ts");
    rmSync(path.join(root, "claude", "p", `${S}.jsonl`));
    const second = await loadSignals({ dirs, home });
    expect(second.fallbacks).toHaveLength(1);
    expect(second.entrypoints.get(S)).toBe("sdk-ts");
    expect(second.responses.get("msg_1:req_1")?.reasoning).toBe(250);
    const uncached = await loadSignals({ dirs, home, cache: false });
    expect(uncached.fallbacks).toHaveLength(0);
    // v2 added reroutes and entrypoints; a v1 entry is read again rather than trusted
    expect(SIGNALS_DIR).toBe("signals-v2");
  });
});
