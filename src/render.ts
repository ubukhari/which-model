/**
 * The human output. Everything it prints is a model id, a client version, a date, a count or a
 * session id: never a prompt, a response, a file path or a project name, so the output can be
 * pasted into a public issue as it is.
 */
import { CLIENT_LABEL, type SourceSummary } from "seatledger";
import { shortDate, type Report, type ReasoningStats, type SessionDetail } from "./analyze.js";

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (x: number) => (x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${shortDate(day)}`;
}

/** "2 Jul 03:01", local time. */
export function when(iso: string): string {
  const t = new Date(iso);
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return `${shortDate(day)} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** Wrap at `width` columns: the first line starts with `first`, the rest with `rest`. */
export function wrap(
  text: string,
  first: string,
  rest = " ".repeat(first.length),
  width = 100,
): string[] {
  const out: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const prefix = out.length === 0 ? first : rest;
    if (line.length > prefix.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = rest + word;
    } else {
      line = line.length > prefix.length ? `${line} ${word}` : `${line}${word}`;
    }
  }
  out.push(line);
  return out;
}

export const shortSession = (id: string) => id.slice(0, 8);

function table(rows: string[][], right: ReadonlySet<number>): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r
      .map((c, i) => (right.has(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd(),
  );
}

export function sourcesLine(sources: readonly SourceSummary[]): string {
  const part = (s: SourceSummary | undefined, noun: string) =>
    `${int(s?.files ?? 0)} ${noun}${s?.retained ? ` (+${int(s.retained)} kept from deleted ones)` : ""}`;
  const cc = sources.find((s) => s.client === "claude-code");
  const cx = sources.find((s) => s.client === "codex");
  return `Read ${part(cc, "Claude Code transcripts")} and ${part(cx, "Codex rollouts")} on this machine. Nothing was sent anywhere.`;
}

export function renderReport(report: Report, opts: { days?: number } = {}): string {
  const out: string[] = [];
  out.push("which-model — which model actually answered, from this machine's transcripts");
  out.push(
    report.since
      ? `Since ${shortDate(report.since)} ${report.since.slice(0, 4)}`
      : "All history on this machine",
  );
  out.push("");

  // 1. Which models answered, by day
  const days = [...new Set(report.days.map((d) => d.day))].slice(0, opts.days ?? 7);
  if (days.length === 0) {
    out.push("No Claude Code or Codex responses found in this range.");
  } else {
    out.push(
      `Models that answered, last ${days.length} active day${days.length === 1 ? "" : "s"} (Codex: the model it requested)`,
    );
    for (const day of days) {
      const rows = report.days.filter((d) => d.day === day);
      let first = true;
      for (const client of ["claude-code", "codex"] as const) {
        const cr = rows.filter((r) => r.client === client);
        if (cr.length === 0) continue;
        const mix = cr.map((r) => `${r.model} ${int(r.responses)} (${pct(r.share)})`).join(" · ");
        out.push(
          `  ${(first ? dayLabel(day) : "").padEnd(10)}  ${CLIENT_LABEL[client].padEnd(11)}  ${mix}`,
        );
        first = false;
      }
    }
    out.push("  --json lists every day and every session.");
  }
  out.push("");

  // 2. Switches
  const claude = report.switches.filter((s) => s.client === "claude-code");
  // Recorded fallbacks first (the client said so), then switches with nothing recorded, newest first.
  const shown = [
    ...claude.filter((s) => s.recorded === "fallback-notice"),
    ...claude.filter((s) => s.recorded === "nothing"),
  ];
  const sessions = new Set(shown.map((s) => s.session));
  out.push(
    `Served-model switches nothing you did explains (Claude Code, main thread): ${shown.length === 0 ? "none" : `${int(shown.length)} in ${int(sessions.size)} session${sessions.size === 1 ? "" : "s"}`}`,
  );
  for (const s of shown.slice(0, 12)) {
    out.push(
      `  ${when(s.at)}  session ${shortSession(s.session)}  Claude Code ${s.version || "?"}`,
    );
    out.push(...wrap(s.sentence, "    "));
  }
  if (shown.length > 12) out.push(`  … and ${int(shown.length - 12)} more (--json lists them all)`);
  const picked = claude.filter((s) => s.recorded === "your-model-change").length;
  const relaunch = claude.filter((s) => s.recorded === "client-relaunch").length;
  const notListed = [
    picked > 0 ? `${int(picked)} after your own /model` : "",
    relaunch > 0 ? `${int(relaunch)} where the session continued on another client version` : "",
  ].filter(Boolean);
  if (notListed.length > 0) out.push(`  Not listed: ${notListed.join(", ")}.`);
  if (report.servedNotRequested.responses > 0)
    out.push(
      `  Answered by a different model than the one last recorded as requested: ${int(report.servedNotRequested.responses)} responses in ${int(report.servedNotRequested.sessions)} session${report.servedNotRequested.sessions === 1 ? "" : "s"}.`,
    );
  const codex = report.switches.filter((s) => s.client === "codex").length;
  if (codex > 0)
    out.push(
      `  Codex: ${int(codex)} change${codex === 1 ? "" : "s"} of the requested model within a thread; its rollouts do not record which model answered.`,
    );
  out.push("");

  // 3. Reasoning
  out.push("Reasoning tokens per response, by model");
  if (report.reasoning.length === 0) {
    out.push("  No responses in this range record their reasoning tokens.");
  } else {
    out.push(...reasoningTable(report.reasoning).map((l) => `  ${l}`));
    for (const r of report.reasoning) {
      for (const s of r.spikes) {
        out.push(
          ...wrap(
            `${CLIENT_LABEL[r.client]} · ${r.model}: ${int(s.responses)} responses (${pct(s.share)}) used exactly ${int(s.tokens)} reasoning tokens, ${s.ratio >= 100 ? "over 100" : int(s.ratio)}x as many as the counts within 5% either side, ${shortDate(s.firstDay)}–${shortDate(s.lastDay)}${s.versions.length ? ` (${s.versions.slice(0, 3).join(", ")}${s.versions.length > 3 ? ", …" : ""})` : ""} — consistent with a cap or budget at that value; it cannot show whether the reasoning was cut short.`,
            "  • ",
          ),
        );
      }
    }
  }
  out.push("");

  // 4. Steps and context windows
  out.push("Step changes (seatledger's rolling baseline)");
  if (report.steps.length === 0) {
    out.push(
      "  None: no step of at least 30% that held for several days in reasoning tokens per response,",
      "  tokens per task, the largest prompt of the day or the auto-compaction point.",
    );
  } else {
    for (const s of report.steps.slice(0, 10)) out.push(...wrap(s.sentence, "  • "));
    if (report.steps.length > 10)
      out.push(`  … and ${int(report.steps.length - 10)} more (--json lists them all)`);
  }
  if (report.windows.length > 0) {
    out.push("");
    out.push("Context window, as Codex reported it");
    for (const w of report.windows) out.push(...wrap(w.sentence, "  • "));
  }
  out.push("");
  for (const n of report.notes) out.push(...wrap(n, ""));
  out.push(...wrap(sourcesLine(report.sources), ""));
  return out.join("\n");
}

function reasoningTable(stats: readonly ReasoningStats[]): string[] {
  const rows = [
    ["model", "responses", "zero", "median", "p90", "p99", "max", "spikes"],
    ...stats.map((r) => [
      `${CLIENT_LABEL[r.client]} · ${r.model}`,
      int(r.responses),
      pct(r.zeroShare),
      int(r.p50),
      int(r.p90),
      int(r.p99),
      int(r.max),
      r.spikes.length === 0
        ? "none"
        : r.spikes.map((s) => `${int(s.tokens)} (${pct(s.share)})`).join(", "),
    ]),
  ];
  return table(rows, new Set([1, 2, 3, 4, 5, 6]));
}

export function renderSession(d: SessionDetail): string {
  const s = d.summary;
  const out: string[] = [];
  out.push(
    `Session ${s.session} (${CLIENT_LABEL[s.client]}), ${when(s.first)} – ${when(s.last)}, ${s.versions.length ? `version${s.versions.length === 1 ? "" : "s"} ${s.versions.join(", ")}` : "version not recorded"}`,
  );
  out.push(
    s.client === "codex"
      ? "Responses in order, by the model Codex requested:"
      : "Main thread, in order:",
  );
  const rows = d.runs.map((r) => [
    when(r.from),
    r.model,
    `${int(r.responses)} response${r.responses === 1 ? "" : "s"}`,
  ]);
  if (rows.length > 0) out.push(...table(rows, new Set([2])).map((l) => `  ${l}`));
  for (const r of d.runs)
    if (r.sentence) out.push(...wrap(`${when(r.from)}: ${r.sentence}`, "  ", "    "));
  if (s.subagentModels.length > 0)
    out.push(
      `Subagents: ${s.subagentModels.map((m) => `${m.model} ${int(m.responses)}`).join(" · ")}`,
    );
  if (s.servedNotRequested > 0)
    out.push(
      `Answered by a different model than the one last recorded as requested: ${int(s.servedNotRequested)} responses.`,
    );
  if (d.reasoning.length > 0) {
    out.push("Reasoning tokens per response in this session:");
    for (const r of d.reasoning)
      out.push(
        `  ${r.model}: ${int(r.responses)} responses, median ${int(r.p50)}, p90 ${int(r.p90)}, max ${int(r.max)}`,
      );
  }
  return out.join("\n");
}
