/**
 * The analysis on the synthetic history, whose story is known (src/synthetic.ts), plus the pieces
 * that decide a finding: what counts as a switch, a spike and a different model. Every sentence
 * says what moved and what it is consistent with, never why.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  baseModel,
  differentModel,
  findSpikes,
  matchSessions,
  sessionDetail,
  type Report,
} from "./analyze.js";
import { runDemo, type Demo } from "./demo.js";

let demo: Demo;
let report: Report;
beforeAll(async () => {
  demo = await runDemo();
  report = demo.report;
});

/** Words that would say why a vendor did something. */
const INTENT =
  /\b(deliberately|intentionally|on purpose|secretly|stealth|to cut costs|to save (money|compute)|nerf(ed)?|downgraded you|shady|lobotomi[sz]ed)\b/i;

describe("served-model switches (Claude Code, main thread)", () => {
  it("labels the fallback the client recorded, and the return with nothing recorded", () => {
    const claude = report.switches.filter((s) => s.client === "claude-code");
    const fallback = claude.find((s) => s.recorded === "fallback-notice")!;
    expect(fallback).toMatchObject({
      day: "2026-07-16",
      from: "claude-fable-5",
      to: "claude-opus-4-8",
      version: "2.1.197",
      notice: { from: "claude-fable-5", to: "claude-opus-4-8", trigger: "refusal" },
      requested: "claude-fable-5",
    });
    expect(fallback.run.responses).toBe(308);
    expect(fallback.run.hours).toBeGreaterThan(20);
    expect(fallback.run.ended).toBe("switch");
    const back = claude.find((s) => s.recorded === "nothing")!;
    expect(back).toMatchObject({
      from: "claude-opus-4-8",
      to: "claude-fable-5",
      session: fallback.session,
    });
    expect(back.run.ended).toBe("session-end");
  });

  it("a /model the person typed is a switch they made, and a subagent's model is never a switch", () => {
    const claude = report.switches.filter((s) => s.client === "claude-code");
    expect(claude.filter((s) => s.recorded === "your-model-change")).toEqual([
      expect.objectContaining({ day: "2026-08-25", from: "claude-fable-5", to: "claude-opus-5" }),
    ]);
    expect(claude.some((s) => s.from.includes("haiku") || s.to.includes("haiku"))).toBe(false);
    expect(claude).toHaveLength(3);
  });

  it("counts responses answered by another model than the one last recorded as requested", () => {
    expect(report.servedNotRequested).toEqual({ responses: 308, sessions: 1 });
  });

  it("one session, in order", () => {
    const fallback = report.switches.find((s) => s.recorded === "fallback-notice")!;
    const [summary] = matchSessions(report, fallback.session.slice(0, 8));
    const detail = sessionDetail(demo.input, report, summary!);
    expect(detail.runs.map((r) => [r.model, r.responses, r.recorded])).toEqual([
      ["claude-fable-5", 10, null],
      ["claude-opus-4-8", 308, "fallback-notice"],
      ["claude-fable-5", 12, "nothing"],
    ]);
    expect(detail.summary.subagentModels.every((m) => m.model.includes("haiku"))).toBe(true);
  });
});

describe("reasoning tokens", () => {
  it("finds the spikes at 516 and 1,034 on gpt-5.5, and none on the smooth distributions", () => {
    const by = new Map(report.reasoning.map((r) => [r.model, r]));
    expect(by.get("gpt-5.5")!.spikes.map((s) => s.tokens)).toEqual([516, 1034]);
    expect(by.get("gpt-5.5")!.spikes[0]!.share).toBeGreaterThan(0.4);
    for (const r of report.reasoning) if (r.model !== "gpt-5.5") expect(r.spikes).toEqual([]);
  });

  it("findSpikes: a smooth spread has none, small counts are ignored, neighbours collapse to the tallest", () => {
    const row = (reasoning: number) => ({ reasoning, day: "2026-07-01", version: "1" });
    const smooth = Array.from({ length: 5000 }, (_, i) => row(100 + (i % 900)));
    expect(findSpikes(smooth)).toEqual([]);
    const small = [...smooth, ...Array.from({ length: 400 }, () => row(6))];
    expect(findSpikes(small)).toEqual([]);
    const capped = [
      ...smooth,
      ...Array.from({ length: 900 }, () => row(516)),
      ...Array.from({ length: 300 }, () => row(517)),
    ];
    const spikes = findSpikes(capped);
    expect(spikes.map((s) => s.tokens)).toEqual([516]);
    expect(spikes[0]!.responses).toBe(capped.filter((x) => x.reasoning === 516).length);
  });
});

describe("step changes and context windows", () => {
  it("lists every change in the window Codex reports, with the version it arrived on", () => {
    expect(report.windows).toContainEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        date: "2026-07-13",
        from: 353_400,
        to: 258_400,
        version: "0.144.3",
        firstDayOnVersion: true,
      }),
    );
  });

  it("finds the drop in the largest prompt with seatledger's detector, on the first day of the new version", () => {
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        client: "codex",
        model: "gpt-5.6-sol",
        metric: "largest_prompt",
        date: "2026-07-13",
        versionChanged: true,
        version: "0.144.3",
        previousVersion: "0.144.2",
      }),
    );
    for (const s of report.steps) expect(s.sentence).toContain("consistent with");
  });

  it("never says why", () => {
    const text = [
      demo.text,
      ...report.switches.map((s) => s.sentence),
      ...report.steps.map((s) => s.sentence),
      ...report.windows.map((w) => w.sentence),
      ...report.notes,
      report.method,
    ].join("\n");
    expect(text).not.toMatch(INTENT);
  });

  it("says Codex records the requested model, not the one that answered", () => {
    expect(report.notes.join(" ")).toContain("Codex records the model it requested");
  });
});

describe("model ids", () => {
  it("compares without decoration, and only full ids", () => {
    expect(baseModel("`Claude-Fable-5[1m]`")).toBe("claude-fable-5");
    expect(baseModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(differentModel("claude-opus-4-8", "claude-fable-5[1m]")).toBe(true);
    expect(differentModel("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(false);
    expect(differentModel("claude-opus-5", "opus")).toBe(false);
  });
});
