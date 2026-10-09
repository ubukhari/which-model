/**
 * Synthetic history in the real Claude Code and Codex transcript formats, for `which-model demo`,
 * the README picture, the page sample and the tests. Nobody's usage: every count comes from a
 * seeded generator. The story mirrors what public issues describe, so the demo shows each kind of
 * finding on data that looks like the reports:
 *
 * - Claude Code: one session a day from 1 Jul. On 16 Jul a fallback notice is written (requested
 *   claude-fable-5, served claude-opus-4-8, trigger refusal) and the session stays on
 *   claude-opus-4-8 for about 23 hours, then returns to claude-fable-5 with nothing recorded (the
 *   pattern anthropics/claude-code#78888 describes). On 25 Aug the person picks claude-opus-5 with
 *   /model (not a finding). Some days have a subagent on claude-haiku-4-5, which is never a switch.
 * - Codex gpt-5.5: about 45% of responses at exactly 516 reasoning tokens and 8% at 1,034 (the
 *   clustering openai/codex#30364 describes).
 * - Codex gpt-5.6-sol: a context window of 353,400 until 12 Jul and 258,400 from 13 Jul, when the
 *   client moves from 0.144.2 to 0.144.3, and the largest prompt of the day falls with it (the cut
 *   openai/codex#32806 describes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAY = 86_400_000;
const MIN = 60_000;
export const SYNTHETIC_NOW = Date.parse("2026-10-07T14:00:00Z");
const START = Date.parse("2026-07-01T00:00:00Z");

export interface Synthetic {
  claudeDir: string;
  codexDir: string;
  now: number;
}

/** A small deterministic generator (mulberry32), so the demo prints the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (t: number) => new Date(t).toISOString();

export function writeSyntheticHistory(dir: string): Synthetic {
  const rand = rng(20260708);
  const int = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo + 1));
  /** Roughly log-normal around `median`. */
  const around = (median: number, spread = 0.8) => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(median * Math.exp(z * spread)));
  };
  const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  const claudeDir = path.join(dir, "claude", "projects");
  const codexDir = path.join(dir, "codex", "sessions");
  const cwd = "/home/dev/demo-app";
  const project = path.join(claudeDir, "-home-dev-demo-app");
  mkdirSync(project, { recursive: true });

  const ccVersion = (t: number) =>
    t < Date.parse("2026-08-01T00:00:00Z")
      ? "2.1.197"
      : t < Date.parse("2026-09-15T00:00:00Z")
        ? "2.1.229"
        : "2.1.270";

  // ------------------------------------------------------------------ Claude Code
  for (let day = START; day <= SYNTHETIC_NOW; day += DAY) {
    const session = uuid();
    const lines: string[] = [];
    const fallbackDay = iso(day).startsWith("2026-07-16");
    const pickDay = iso(day).startsWith("2026-08-25");
    let t = day + (fallbackDay ? 2 * 60 * MIN : 9 * 60 * MIN);
    let model = day < Date.parse("2026-09-01T00:00:00Z") ? "claude-fable-5" : "claude-fable-5-1";
    const total = fallbackDay ? 330 : 32;
    let context = 20_000;
    const base = (ts: number, extra: Record<string, unknown>) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        userType: "external",
        entrypoint: "cli",
        cwd,
        sessionId: session,
        version: ccVersion(ts),
        gitBranch: "main",
        uuid: uuid(),
        timestamp: iso(ts),
        ...extra,
      });
    for (let i = 0; i < total; i++) {
      if (t > SYNTHETIC_NOW - 60 * MIN) break;
      if (i % 4 === 0)
        lines.push(
          base(t - 20_000, {
            type: "user",
            origin: { kind: "human" },
            message: { role: "user", content: "(synthetic prompt)" },
          }),
        );
      if (fallbackDay && i === 10) {
        lines.push(
          base(t - 5_000, {
            type: "system",
            subtype: "model_refusal_fallback",
            level: "warning",
            content: "(synthetic notice)",
            isMeta: false,
            originalModel: "claude-fable-5",
            fallbackModel: "claude-opus-4-8",
            trigger: "refusal",
            direction: "retry",
            requestId: `req_${hex(24)}`,
          }),
        );
        model = "claude-opus-4-8";
      }
      if (fallbackDay && i === 318) model = "claude-fable-5"; // back, with nothing recorded
      if (pickDay && i === 16) {
        lines.push(
          base(t - 10_000, {
            type: "user",
            message: {
              role: "user",
              content: "<local-command-stdout>Set model to claude-opus-5</local-command-stdout>",
            },
          }),
        );
        model = "claude-opus-5";
      }
      context = i % 12 === 11 ? 30_000 : context + int(8_000, 30_000);
      const thinking =
        model === "claude-opus-4-8"
          ? around(300)
          : model === "claude-opus-5"
            ? around(350)
            : around(450);
      lines.push(
        base(t, {
          type: "assistant",
          requestId: `req_${hex(24)}`,
          message: {
            id: `msg_${hex(24)}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: "tool_use",
            usage: {
              input_tokens: int(2, 40),
              cache_creation_input_tokens: int(500, 4_000),
              cache_read_input_tokens: context,
              output_tokens: thinking + int(50, 900),
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: int(500, 4_000),
              },
              output_tokens_details: { thinking_tokens: thinking },
              service_tier: "standard",
              speed: "standard",
            },
          },
        }),
      );
      if (i === 20 && !fallbackDay && iso(day) < "2026-10-07" && rand() < 0.25)
        lines.push(
          base(t + 1_000, {
            type: "system",
            subtype: "compact_boundary",
            level: "info",
            compactMetadata: {
              trigger: "auto",
              preTokens: int(985_000, 1_002_000),
              postTokens: 40_000,
            },
          }),
        );
      t += (fallbackDay ? 4.2 : int(5, 12)) * MIN;
    }
    if (lines.length === 0) continue;
    writeFileSync(path.join(project, `${session}.jsonl`), lines.join("\n") + "\n");

    // A subagent on some days: its own model, by design, never a switch.
    if (rand() < 0.4) {
      const agentId = hex(16);
      const subDir = path.join(project, session, "subagents");
      mkdirSync(subDir, { recursive: true });
      const sub: string[] = [];
      let st = day + 10 * 60 * MIN;
      for (let i = 0; i < 6 && st < SYNTHETIC_NOW - 60 * MIN; i++, st += 2 * MIN)
        sub.push(
          JSON.stringify({
            isSidechain: true,
            agentId,
            cwd,
            sessionId: session,
            version: ccVersion(st),
            uuid: uuid(),
            timestamp: iso(st),
            type: "assistant",
            requestId: `req_${hex(24)}`,
            message: {
              id: `msg_${hex(24)}`,
              model: "claude-haiku-4-5-20251001",
              role: "assistant",
              content: [],
              usage: {
                input_tokens: int(5, 50),
                cache_creation_input_tokens: int(1_000, 6_000),
                cache_read_input_tokens: int(5_000, 30_000),
                output_tokens: int(100, 800),
                output_tokens_details: { thinking_tokens: around(120) },
              },
            },
          }),
        );
      if (sub.length > 0)
        writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), sub.join("\n") + "\n");
    }
  }

  // ------------------------------------------------------------------ Codex
  const cut = Date.parse("2026-07-13T00:00:00Z");
  const rollout = (day: number, model: string, startHour: number, responses: number) => {
    const thread = uuid();
    const start = day + startHour * 60 * MIN;
    if (start > SYNTHETIC_NOW - 2 * 60 * MIN) return;
    const d = new Date(day);
    const folder = path.join(
      codexDir,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
    mkdirSync(folder, { recursive: true });
    const cli = model === "gpt-5.6-sol" ? (day < cut ? "0.144.2" : "0.144.3") : "0.144.3";
    const window = model === "gpt-5.6-sol" && day < cut ? 353_400 : 258_400;
    const lines: string[] = [
      JSON.stringify({
        timestamp: iso(start),
        type: "session_meta",
        payload: {
          id: thread,
          timestamp: iso(start),
          cwd,
          originator: "codex_cli_rs",
          cli_version: cli,
          model_provider: "openai",
        },
      }),
    ];
    let total = 0;
    let t = start;
    for (let i = 0; i < responses; i++) {
      if (i % 4 === 0)
        lines.push(
          JSON.stringify({
            timestamp: iso(t - 1_000),
            type: "turn_context",
            payload: { turn_id: uuid(), cwd, model, effort: "medium" },
          }),
        );
      const ceiling = window * 0.97;
      const prompt = Math.min(ceiling, int(40_000, 80_000) + (i % 10) * int(30_000, 40_000));
      const cached = Math.round(prompt * 0.85);
      const r = rand();
      const reasoning =
        model === "gpt-5.5"
          ? r < 0.45
            ? 516
            : r < 0.53
              ? 1_034
              : around(380, 0.9)
          : around(260, 0.9);
      const output = reasoning + int(40, 700);
      total += prompt + output;
      lines.push(
        JSON.stringify({
          timestamp: iso(t),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: total,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: total,
              },
              last_token_usage: {
                input_tokens: Math.round(prompt),
                cached_input_tokens: cached,
                cache_write_input_tokens: 0,
                output_tokens: output,
                reasoning_output_tokens: reasoning,
                total_tokens: Math.round(prompt) + output,
              },
              model_context_window: window,
            },
            rate_limits: null,
          },
        }),
      );
      t += int(2, 6) * MIN;
    }
    writeFileSync(
      path.join(folder, `rollout-${iso(start).slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`),
      lines.join("\n") + "\n",
    );
  };
  for (let day = START; day <= SYNTHETIC_NOW; day += DAY) {
    rollout(day, "gpt-5.6-sol", 13, 28);
    if (day < Date.parse("2026-09-01T00:00:00Z") && new Date(day).getUTCDay() % 2 === 1)
      rollout(day, "gpt-5.5", 15, 24);
  }

  return { claudeDir, codexDir, now: SYNTHETIC_NOW };
}
