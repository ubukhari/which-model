/**
 * Which model answered, from seatledger's requests plus the signals in `signals.ts`.
 *
 * 1. **Which models answered**: every response's model as the client wrote it, by day and by
 *    session. Claude Code writes the model the server says answered (`message.model`); Codex writes
 *    the model it asked for (`turn_context.model`) and never the one that answered, so Codex rows
 *    are the requested model.
 * 2. **Switches nothing you did explains** (Claude Code, main thread only; subagents run on their
 *    own models by design): two consecutive main-thread responses in one session answered by
 *    different models. Each switch says what the transcript records just before it: your `/model`,
 *    a fallback notice the client wrote, a client relaunch (the version changed), or nothing. When a
 *    requested model is recorded (your `/model`, or a fallback notice's original model), every
 *    later response served by a different model is counted.
 * 3. **Reasoning tokens per response, by model**, and spikes at fixed values: a count at or above
 *    {@link MIN_SPIKE_TOKENS} tokens that holds at least 1% of the model's responses (and at least
 *    10) and at least {@link SPIKE_RATIO}x the average count of the values within 5% either side.
 * 4. **Step changes** in reasoning tokens per response, tokens per user turn, the largest prompt of
 *    the day, and Claude Code's auto-compaction point, by seatledger's rolling-baseline detector
 *    (`detectSteps`, the same thresholds as `seatledger rates`), with the date and client version
 *    where each starts. Codex's own context-window reading is a recorded value, so every change in
 *    it is listed exactly.
 *
 * It sees requests on this machine, not the vendor's servers, so it never names a cause: it says
 * what moved, when, on which version, and what that is consistent with.
 */
import {
  CLIENT_LABEL,
  dailySeries,
  dayKey,
  detectSteps,
  type Client,
  type Series,
  type SourceSummary,
  type UsageRecord,
} from "seatledger";
import type { Compaction, FallbackNotice, ModelChoice, Signals, WindowReading } from "./signals.js";

type DayPoint = Series["days"][number];

export const MIN_SPIKE_TOKENS = 64;
export const SPIKE_RATIO = 8;
const SPIKE_MIN_SHARE = 0.01;
const SPIKE_MIN_RESPONSES = 10;
const MIN_DAY_RESPONSES = 20;
const MIN_REASONING_RESPONSES = 20;

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface ModelDay {
  day: string;
  client: Client;
  model: string;
  responses: number;
  /** Of this client's responses that day. */
  share: number;
}

export interface ModelCount {
  model: string;
  responses: number;
}

export interface SessionSummary {
  client: Client;
  /** The client's session (Claude Code) or thread (Codex) id. */
  session: string;
  first: string;
  last: string;
  versions: string[];
  /** Claude Code: main-thread responses. Codex: every response, by the model Codex requested. */
  models: ModelCount[];
  /** Claude Code subagent responses, by model. */
  subagentModels: ModelCount[];
  /** Main-thread switches after a fallback notice or with nothing recorded before them. */
  unexplainedSwitches: number;
  /** Main-thread responses served by a model other than the one last recorded as requested. */
  servedNotRequested: number;
}

/** What the transcript records just before a switch. */
export type Recorded =
  "your-model-change" | "fallback-notice" | "client-relaunch" | "nothing" | "codex-request";

export interface Switch {
  client: Client;
  session: string;
  at: string;
  day: string;
  from: string;
  to: string;
  version: string;
  previousVersion: string;
  recorded: Recorded;
  notice: { from: string; to: string; trigger: string } | null;
  /** The model last recorded as requested in this session at that moment, if any. */
  requested: string | null;
  /** The responses served by `to` from here until the next switch or the end of the session. */
  run: { responses: number; hours: number; until: string; ended: "switch" | "session-end" };
  sentence: string;
}

export interface Spike {
  tokens: number;
  responses: number;
  share: number;
  /** Responses at exactly `tokens` over the average of the values within 5% either side. */
  ratio: number;
  firstDay: string;
  lastDay: string;
  versions: string[];
}

export interface ReasoningStats {
  client: Client;
  model: string;
  /** Responses whose reasoning tokens the transcript records. */
  responses: number;
  zeroShare: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  firstDay: string;
  lastDay: string;
  spikes: Spike[];
}

export const STEP_METRICS = [
  "reasoning_per_response",
  "tokens_per_turn",
  "largest_prompt",
  "compaction_point",
] as const;
export type StepMetric = (typeof STEP_METRICS)[number];

export const STEP_LABEL: Readonly<Record<StepMetric, string>> = {
  reasoning_per_response: "median reasoning tokens per response",
  tokens_per_turn: "tokens per task (user turn)",
  largest_prompt: "largest prompt of the day",
  compaction_point: "median auto-compaction point",
};

export interface Step {
  client: Client;
  model: string;
  metric: StepMetric;
  label: string;
  date: string;
  before: number;
  after: number;
  /** after / before */
  change: number;
  beforeDays: [string, string];
  afterDays: [string, string];
  version: string;
  previousVersion: string;
  /** True when `date` is the first active day on `version` for this model. */
  versionChanged: boolean;
  consistentWith: string;
  sentence: string;
}

export interface WindowChange {
  client: "codex";
  model: string;
  date: string;
  /** null for the first reading in this history. */
  from: number | null;
  to: number;
  version: string;
  firstDayOnVersion: boolean;
  sentence: string;
}

export interface Report {
  generatedAt: string;
  /** First day covered, YYYY-MM-DD, or null for all history. */
  since: string | null;
  method: string;
  sources: SourceSummary[];
  days: ModelDay[];
  sessions: SessionSummary[];
  switches: Switch[];
  servedNotRequested: { responses: number; sessions: number };
  reasoning: ReasoningStats[];
  steps: Step[];
  windows: WindowChange[];
  notes: string[];
}

export const METHOD =
  "Models are as each client wrote them: Claude Code records the model that answered each response, " +
  "Codex records the model it requested. A switch is two consecutive main-thread responses in one " +
  "Claude Code session answered by different models; it is labelled by what the transcript records " +
  "just before it (your /model, a fallback notice, a client relaunch, or nothing). Reasoning spikes " +
  `are counts of at least ${MIN_SPIKE_TOKENS} tokens holding at least 1% of a model's responses and ` +
  `${SPIKE_RATIO}x the values within 5% either side. Step changes use seatledger's rolling baseline: ` +
  "complete days with enough responses, a median of up to 7 active days before against up to 7 from " +
  "the day, at least 30% apart, 3/4 of days on their own side, and more than 3x the day-to-day spread. " +
  "Findings say what moved and what it is consistent with; they cannot see the vendor's side.";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (day: string): string => {
  const [, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? "?"}`;
};

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
}

function mostCommon(xs: Iterable<string>): string {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  let best = "";
  let most = -1;
  for (const [k, c] of n) if (c > most) [best, most] = [k, c];
  return best;
}

const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const counts = (m: Map<string, number>): ModelCount[] =>
  [...m]
    .map(([model, responses]) => ({ model, responses }))
    .sort((a, b) => b.responses - a.responses);

/** Model ids compared without decoration: case, a `[1m]` context suffix, a date suffix. */
export function baseModel(id: string): string {
  return id
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[[0-9a-z]+\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** True when both are full model ids and name different models; false when they match or cannot be compared. */
export function differentModel(served: string, requested: string): boolean {
  const a = baseModel(served);
  const b = baseModel(requested);
  if (!a.startsWith("claude-") || !b.startsWith("claude-")) return false;
  return a !== b;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");

export function movement(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "changed";
  if (ratio >= 1.9 && ratio < 2.15) return "doubled";
  if (ratio >= 2.15) return `rose ${ratio.toFixed(1)}x`;
  if (ratio > 1) return `rose ${Math.round((ratio - 1) * 100)}%`;
  if (ratio <= 0.55 && ratio > 0.45) return "halved";
  return `fell ${Math.round((1 - ratio) * 100)}%`;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface AnalyzeInput {
  requests: readonly UsageRecord[];
  signals: Signals;
  sources: SourceSummary[];
  now: number;
  since?: number | undefined;
}

export function analyze(input: AnalyzeInput): Report {
  const { requests, signals, now } = input;
  const today = dayKey(now);
  const isMain = (r: UsageRecord) =>
    r.client === "codex" || signals.responses.get(r.id)?.main === true;
  const isSub = (r: UsageRecord) =>
    r.client === "claude-code" && signals.responses.get(r.id)?.main === false;

  const switches = [...claudeSwitches(requests, signals, isMain), ...codexChanges(requests)];
  switches.sort((a, b) => b.at.localeCompare(a.at));

  const sessions = sessionSummaries(requests, signals, isMain, isSub, switches);
  const servedNotRequested = {
    responses: sessions.reduce((n, s) => n + s.servedNotRequested, 0),
    sessions: sessions.filter((s) => s.servedNotRequested > 0).length,
  };

  const complete = requests.filter((r) => dayKey(r.ts) !== today);
  const reasoning = reasoningStats(requests, signals);
  const steps = [
    ...reasoningSteps(complete, signals),
    ...turnSteps(complete),
    ...promptSteps(complete),
    ...compactionSteps(
      complete,
      signals.compactions.filter((c) => dayKey(c.ts) !== today),
    ),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));

  const notes: string[] = [];
  if (requests.some((r) => r.client === "codex"))
    notes.push(
      "Codex records the model it requested for each turn, not the model that answered, so a Codex reroute cannot be seen from its rollouts.",
    );
  if (switches.some((s) => s.recorded === "nothing"))
    notes.push(
      "A switch with nothing recorded before it is not proof of a reroute: a model picked in a way the transcript does not record (a picker, or a relaunch with --model on the same version) looks the same.",
    );

  return {
    generatedAt: new Date(now).toISOString(),
    since: input.since === undefined ? null : dayKey(input.since),
    method: METHOD,
    sources: input.sources,
    days: modelDays(requests),
    sessions,
    switches,
    servedNotRequested,
    reasoning,
    steps,
    windows: windowChanges(requests, signals.windows),
    notes,
  };
}

function modelDays(requests: readonly UsageRecord[]): ModelDay[] {
  const by = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const r of requests) {
    const day = dayKey(r.ts);
    inc(by, `${day}\u0000${r.client}\u0000${r.model}`);
    inc(totals, `${day}\u0000${r.client}`);
  }
  return [...by]
    .map(([k, responses]) => {
      const [day, client, model] = k.split("\u0000") as [string, Client, string];
      return {
        day,
        client,
        model,
        responses,
        share: responses / (totals.get(`${day}\u0000${client}`) ?? responses),
      };
    })
    .sort(
      (a, b) =>
        b.day.localeCompare(a.day) || a.client.localeCompare(b.client) || b.responses - a.responses,
    );
}

/** Requests grouped by client and session, each sorted by time. */
function bySession(requests: readonly UsageRecord[]): Map<string, UsageRecord[]> {
  const out = new Map<string, UsageRecord[]>();
  for (const r of requests) {
    const k = `${r.client}\u0000${r.session}`;
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
  return out;
}

function groupEvents<T extends { session: string; ts: number }>(
  xs: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const list = out.get(x.session) ?? [];
    list.push(x);
    out.set(x.session, list);
  }
  return out;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

/** The latest requested model at or before `ts`: your /model, else a fallback notice's original. */
function requestedAt(
  ts: number,
  choices: readonly ModelChoice[],
  fallbacks: readonly FallbackNotice[],
): string | null {
  let best: { ts: number; model: string } | null = null;
  for (const c of choices) if (c.ts <= ts && (!best || c.ts >= best.ts)) best = c;
  for (const f of fallbacks)
    if (f.ts <= ts && (!best || f.ts > best.ts)) best = { ts: f.ts, model: f.from };
  return best?.model ?? null;
}

function claudeSwitches(
  requests: readonly UsageRecord[],
  signals: Signals,
  isMain: (r: UsageRecord) => boolean,
): Switch[] {
  const choices = groupEvents(signals.choices);
  const fallbacks = groupEvents(signals.fallbacks.filter((f) => f.main));
  const out: Switch[] = [];
  const main = requests.filter((r) => r.client === "claude-code" && isMain(r));
  for (const list of bySession(main).values()) {
    const session = list[0]!.session;
    const sc = choices.get(session) ?? [];
    const sf = fallbacks.get(session) ?? [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const r = list[i]!;
      if (prev.model === r.model) continue;
      const between = <T extends { ts: number }>(xs: readonly T[]) =>
        xs.filter((x) => x.ts > prev.ts && x.ts <= r.ts);
      const picked = between(sc);
      const notices = between(sf);
      const notice = notices.find((n) => n.to === r.model) ?? notices[0] ?? null;
      const recorded: Recorded =
        picked.length > 0
          ? "your-model-change"
          : notice
            ? "fallback-notice"
            : prev.version !== r.version
              ? "client-relaunch"
              : "nothing";
      let j = i;
      while (j + 1 < list.length && list[j + 1]!.model === r.model) j++;
      const last = list[j]!;
      const s: Switch = {
        client: "claude-code",
        session,
        at: new Date(r.ts).toISOString(),
        day: dayKey(r.ts),
        from: prev.model,
        to: r.model,
        version: r.version,
        previousVersion: prev.version,
        recorded,
        notice: notice ? { from: notice.from, to: notice.to, trigger: notice.trigger } : null,
        requested: requestedAt(r.ts, sc, sf),
        run: {
          responses: j - i + 1,
          hours: hours(last.ts - r.ts),
          until: new Date(last.ts).toISOString(),
          ended: j + 1 < list.length ? "switch" : "session-end",
        },
        sentence: "",
      };
      s.sentence = switchSentence(s);
      out.push(s);
    }
  }
  return out;
}

/** Codex: the requested model changing within a thread. Counted, never called a reroute. */
function codexChanges(requests: readonly UsageRecord[]): Switch[] {
  const out: Switch[] = [];
  const codex = requests.filter((r) => r.client === "codex");
  for (const list of bySession(codex).values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const r = list[i]!;
      if (prev.model === r.model) continue;
      let j = i;
      while (j + 1 < list.length && list[j + 1]!.model === r.model) j++;
      const last = list[j]!;
      const s: Switch = {
        client: "codex",
        session: r.session,
        at: new Date(r.ts).toISOString(),
        day: dayKey(r.ts),
        from: prev.model,
        to: r.model,
        version: r.version,
        previousVersion: prev.version,
        recorded: "codex-request",
        notice: null,
        requested: r.model,
        run: {
          responses: j - i + 1,
          hours: hours(last.ts - r.ts),
          until: new Date(last.ts).toISOString(),
          ended: j + 1 < list.length ? "switch" : "session-end",
        },
        sentence: "",
      };
      s.sentence = switchSentence(s);
      out.push(s);
    }
  }
  return out;
}

function switchSentence(s: Switch): string {
  const run = `${int(s.run.responses)} response${s.run.responses === 1 ? "" : "s"} over ${s.run.hours} h, ${s.run.ended === "switch" ? "until the next switch" : "to the end of the session"}`;
  const head = `${s.from} → ${s.to}`;
  switch (s.recorded) {
    case "your-model-change":
      return `${head} after your /model; ${run}.`;
    case "fallback-notice":
      return `${head} after a fallback notice the client recorded (${s.notice!.from} → ${s.notice!.to}${s.notice!.trigger ? `, trigger: ${s.notice!.trigger}` : ""}); served ${run}.`;
    case "client-relaunch":
      return `${head} when the session continued on ${CLIENT_LABEL[s.client]} ${s.version || "?"} (previously ${s.previousVersion || "?"}); a model set at launch is not recorded. ${run}.`;
    case "nothing":
      return `${head} with nothing recorded before it (no /model, no fallback notice, same client version); served ${run}.`;
    case "codex-request":
      return `Codex requested ${s.to} instead of ${s.from}; Codex does not record which model answered. ${run}.`;
  }
}

function sessionSummaries(
  requests: readonly UsageRecord[],
  signals: Signals,
  isMain: (r: UsageRecord) => boolean,
  isSub: (r: UsageRecord) => boolean,
  switches: readonly Switch[],
): SessionSummary[] {
  const choices = groupEvents(signals.choices);
  const fallbacks = groupEvents(signals.fallbacks.filter((f) => f.main));
  const unexplained = new Map<string, number>();
  for (const s of switches)
    if (s.recorded === "fallback-notice" || s.recorded === "nothing")
      inc(unexplained, `${s.client}\u0000${s.session}`);
  const out: SessionSummary[] = [];
  for (const [k, list] of bySession(requests)) {
    const first = list[0]!;
    const main = new Map<string, number>();
    const sub = new Map<string, number>();
    const versions = new Set<string>();
    let notRequested = 0;
    const sc = choices.get(first.session) ?? [];
    const sf = fallbacks.get(first.session) ?? [];
    for (const r of list) {
      if (r.version) versions.add(r.version);
      if (isSub(r)) inc(sub, r.model);
      else if (isMain(r)) {
        inc(main, r.model);
        if (r.client === "claude-code") {
          const requested = requestedAt(r.ts, sc, sf);
          if (requested && differentModel(r.model, requested)) notRequested += 1;
        }
      }
    }
    out.push({
      client: first.client,
      session: first.session,
      first: new Date(first.ts).toISOString(),
      last: new Date(list[list.length - 1]!.ts).toISOString(),
      versions: [...versions].sort(),
      models: counts(main),
      subagentModels: counts(sub),
      unexplainedSwitches: unexplained.get(k) ?? 0,
      servedNotRequested: notRequested,
    });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}

// ---------------------------------------------------------------------------------------------
// Reasoning tokens
// ---------------------------------------------------------------------------------------------

interface ReasonedResponse {
  client: Client;
  model: string;
  day: string;
  version: string;
  reasoning: number;
}

function reasoned(requests: readonly UsageRecord[], signals: Signals): ReasonedResponse[] {
  const out: ReasonedResponse[] = [];
  for (const r of requests) {
    const reasoning = signals.responses.get(r.id)?.reasoning;
    if (reasoning === null || reasoning === undefined) continue;
    out.push({
      client: r.client,
      model: r.model,
      day: dayKey(r.ts),
      version: r.version,
      reasoning,
    });
  }
  return out;
}

const groupKey = (x: { client: Client; model: string }) => `${x.client}\u0000${x.model}`;

function groupBy<T extends { client: Client; model: string }>(xs: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = groupKey(x);
    const list = out.get(k) ?? [];
    list.push(x);
    out.set(k, list);
  }
  return out;
}

function reasoningStats(requests: readonly UsageRecord[], signals: Signals): ReasoningStats[] {
  const out: ReasoningStats[] = [];
  for (const list of groupBy(reasoned(requests, signals)).values()) {
    if (list.length < MIN_REASONING_RESPONSES) continue;
    const sorted = list.map((x) => x.reasoning).sort((a, b) => a - b);
    const days = list.map((x) => x.day).sort();
    out.push({
      client: list[0]!.client,
      model: list[0]!.model,
      responses: list.length,
      zeroShare: sorted.filter((v) => v === 0).length / sorted.length,
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      p99: quantile(sorted, 0.99),
      max: sorted[sorted.length - 1]!,
      firstDay: days[0]!,
      lastDay: days[days.length - 1]!,
      spikes: findSpikes(list),
    });
  }
  return out.sort((a, b) => b.responses - a.responses);
}

/** Exact reasoning-token counts that hold far more responses than the values around them. */
export function findSpikes(
  list: readonly { reasoning: number; day: string; version: string }[],
): Spike[] {
  const nonZero = list.filter((x) => x.reasoning > 0);
  const n = nonZero.length;
  if (n === 0) return [];
  const at = new Map<number, number>();
  for (const x of nonZero) at.set(x.reasoning, (at.get(x.reasoning) ?? 0) + 1);
  const minCount = Math.max(SPIKE_MIN_RESPONSES, Math.ceil(n * SPIKE_MIN_SHARE));
  const width = (v: number) => Math.max(8, Math.round(v * 0.05));
  const candidates: { tokens: number; responses: number; ratio: number }[] = [];
  for (const [v, c] of at) {
    if (v < MIN_SPIKE_TOKENS || c < minCount) continue;
    const w = width(v);
    let around = 0;
    for (let u = v - w; u <= v + w; u++) if (u !== v) around += at.get(u) ?? 0;
    const expected = Math.max(around / (2 * w), 1 / (2 * w));
    const ratio = c / expected;
    if (ratio >= SPIKE_RATIO) candidates.push({ tokens: v, responses: c, ratio });
  }
  // Of neighbouring candidates, keep the tallest.
  const kept = candidates.filter(
    (c) =>
      !candidates.some(
        (o) =>
          o !== c &&
          Math.abs(o.tokens - c.tokens) <= width(c.tokens) &&
          (o.responses > c.responses || (o.responses === c.responses && o.tokens < c.tokens)),
      ),
  );
  return kept
    .sort((a, b) => b.responses - a.responses)
    .slice(0, 5)
    .map((c) => {
      const hits = nonZero.filter((x) => x.reasoning === c.tokens);
      const days = hits.map((x) => x.day).sort();
      return {
        tokens: c.tokens,
        responses: c.responses,
        share: c.responses / n,
        ratio: Math.round(c.ratio),
        firstDay: days[0]!,
        lastDay: days[days.length - 1]!,
        versions: [...new Set(hits.map((x) => x.version).filter(Boolean))].sort(),
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Step changes, by seatledger's detector
// ---------------------------------------------------------------------------------------------

interface DayValue {
  day: string;
  value: number;
  samples: number;
}

/** Version per active day for one client and model: the one most of that day's requests used. */
function versionsByDay(requests: readonly UsageRecord[]): Map<string, Map<string, string>> {
  const per = new Map<string, Map<string, string[]>>();
  for (const r of requests) {
    const k = groupKey(r);
    let days = per.get(k);
    if (!days) per.set(k, (days = new Map()));
    const day = dayKey(r.ts);
    const list = days.get(day) ?? [];
    list.push(r.version);
    days.set(day, list);
  }
  const out = new Map<string, Map<string, string>>();
  for (const [k, days] of per) {
    const m = new Map<string, string>();
    for (const [day, vs] of days) m.set(day, mostCommon(vs));
    out.set(k, m);
  }
  return out;
}

const point = (d: DayValue, version: string): DayPoint => ({
  day: d.day,
  requests: d.samples,
  turns: 0,
  version,
  values: { tokens_per_request: d.value },
  cacheReadsPerRequest: 0,
  cacheWritesPerRequest: 0,
});

function stepsFor(
  client: Client,
  model: string,
  metric: StepMetric,
  days: DayPoint[],
  detect: "tokens_per_request" | "tokens_per_turn",
): Step[] {
  return detectSteps(days, detect).map((c) => {
    const at = days.findIndex((d) => d.day === c.date);
    const day = days[at]!;
    const prev = days[at - 1];
    const earlier = new Set(days.slice(0, at).map((d) => d.version));
    const versionChanged = !!prev && day.version !== prev.version && !earlier.has(day.version);
    const s: Step = {
      client,
      model,
      metric,
      label: STEP_LABEL[metric],
      date: c.date,
      before: c.before,
      after: c.after,
      change: c.change,
      beforeDays: c.beforeDays,
      afterDays: c.afterDays,
      version: day.version,
      previousVersion: prev?.version ?? "",
      versionChanged,
      consistentWith: "",
      sentence: "",
    };
    s.consistentWith = interpret(s);
    s.sentence = describe(s);
    return s;
  });
}

function reasoningSteps(requests: readonly UsageRecord[], signals: Signals): Step[] {
  const versions = versionsByDay(requests);
  const out: Step[] = [];
  for (const [k, list] of groupBy(reasoned(requests, signals))) {
    const byDay = new Map<string, number[]>();
    for (const x of list) {
      const vs = byDay.get(x.day) ?? [];
      vs.push(x.reasoning);
      byDay.set(x.day, vs);
    }
    const days = [...byDay]
      .filter(([, vs]) => vs.length >= MIN_DAY_RESPONSES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, vs]) =>
        point({ day, value: median(vs), samples: vs.length }, versions.get(k)?.get(day) ?? ""),
      );
    out.push(
      ...stepsFor(
        list[0]!.client,
        list[0]!.model,
        "reasoning_per_response",
        days,
        "tokens_per_request",
      ),
    );
  }
  return out;
}

function turnSteps(requests: readonly UsageRecord[]): Step[] {
  return dailySeries(requests)
    .filter((s) => s.model !== "all models")
    .flatMap((s) => stepsFor(s.client, s.model, "tokens_per_turn", s.days, "tokens_per_turn"));
}

function promptSteps(requests: readonly UsageRecord[]): Step[] {
  const versions = versionsByDay(requests);
  const out: Step[] = [];
  for (const [k, list] of groupBy(requests)) {
    const byDay = new Map<string, { max: number; n: number }>();
    for (const r of list) {
      const day = dayKey(r.ts);
      const acc = byDay.get(day) ?? { max: 0, n: 0 };
      acc.max = Math.max(acc.max, r.input + r.cacheRead + r.cacheWrite);
      acc.n += 1;
      byDay.set(day, acc);
    }
    const days = [...byDay]
      .filter(([, a]) => a.n >= MIN_DAY_RESPONSES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, a]) =>
        point({ day, value: a.max, samples: a.n }, versions.get(k)?.get(day) ?? ""),
      );
    out.push(
      ...stepsFor(list[0]!.client, list[0]!.model, "largest_prompt", days, "tokens_per_request"),
    );
  }
  return out;
}

function compactionSteps(
  requests: readonly UsageRecord[],
  compactions: readonly Compaction[],
): Step[] {
  // Each compaction belongs to the model of the session's last main-thread response before it.
  const sessions = bySession(requests.filter((r) => r.client === "claude-code"));
  const lastBefore = (session: string, ts: number): UsageRecord | undefined => {
    const list = sessions.get(`claude-code\u0000${session}`);
    if (!list) return undefined;
    let found: UsageRecord | undefined;
    for (const r of list) {
      if (r.ts > ts) break;
      found = r;
    }
    return found;
  };
  const byModel = new Map<string, Map<string, { values: number[]; versions: string[] }>>();
  for (const c of compactions) {
    if (!c.main || c.trigger !== "auto") continue;
    const r = lastBefore(c.session, c.ts);
    if (!r) continue;
    let days = byModel.get(r.model);
    if (!days) byModel.set(r.model, (days = new Map()));
    const day = dayKey(c.ts);
    const acc = days.get(day) ?? { values: [], versions: [] };
    acc.values.push(c.preTokens);
    acc.versions.push(c.version || r.version);
    days.set(day, acc);
  }
  const out: Step[] = [];
  for (const [model, days] of byModel) {
    const points = [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, a]) =>
        point({ day, value: median(a.values), samples: a.values.length }, mostCommon(a.versions)),
      );
    out.push(...stepsFor("claude-code", model, "compaction_point", points, "tokens_per_request"));
  }
  return out;
}

function interpret(s: Step): string {
  const up = s.change > 1;
  const parts: Record<StepMetric, string> = {
    reasoning_per_response: up
      ? "consistent with a larger reasoning budget or effort for this model, or harder work on your side"
      : "consistent with a smaller reasoning budget or effort for this model, a change in your effort setting, or easier work on your side",
    tokens_per_turn: up
      ? "consistent with more requests or larger contexts per task: more tool calls or subagents, or bigger tasks"
      : "consistent with fewer requests or smaller contexts per task: earlier compaction, fewer subagents, or smaller tasks",
    largest_prompt: up
      ? "consistent with a higher context ceiling, later compaction, or longer sessions in your own work"
      : "consistent with a lower context ceiling, earlier compaction, or shorter sessions in your own work",
    compaction_point: up
      ? "consistent with a higher context ceiling or a later auto-compaction threshold"
      : "consistent with a lower context ceiling or an earlier auto-compaction threshold",
  };
  const label = CLIENT_LABEL[s.client];
  const version = s.versionChanged
    ? `It starts with ${label} ${s.version}${s.previousVersion ? ` (previously ${s.previousVersion})` : ""}.`
    : `There was no ${label} version change that day, so a change in your own work is as likely.`;
  return `${parts[s.metric]}. ${version}`;
}

const fmt = (metric: StepMetric, v: number) =>
  metric === "reasoning_per_response"
    ? int(v)
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `${Math.round(v / 1e3)}K`
        : int(v);

function describe(s: Step): string {
  const where = `${CLIENT_LABEL[s.client]} ${s.version || "(version not recorded)"}`;
  const on = s.versionChanged ? `${where}, the first day on it` : where;
  return `From ${shortDate(s.date)} (${on}), the ${s.label} on ${s.model} ${movement(s.change)} (${fmt(s.metric, s.before)} → ${fmt(s.metric, s.after)}) — ${s.consistentWith}`;
}

// ---------------------------------------------------------------------------------------------
// Codex's own context-window readings
// ---------------------------------------------------------------------------------------------

function windowChanges(
  requests: readonly UsageRecord[],
  windows: readonly WindowReading[],
): WindowChange[] {
  const sessions = bySession(requests.filter((r) => r.client === "codex"));
  const nearest = (w: WindowReading): UsageRecord | undefined => {
    const list = sessions.get(`codex\u0000${w.session}`);
    if (!list || list.length === 0) return undefined;
    let best = list[0]!;
    for (const r of list) if (Math.abs(r.ts - w.ts) < Math.abs(best.ts - w.ts)) best = r;
    return best;
  };
  const byModel = new Map<string, { w: WindowReading; r: UsageRecord }[]>();
  for (const w of windows) {
    const r = nearest(w);
    if (!r) continue;
    const list = byModel.get(r.model) ?? [];
    list.push({ w, r });
    byModel.set(r.model, list);
  }
  const codexByModel = new Map<string, UsageRecord[]>();
  for (const r of requests) {
    if (r.client !== "codex") continue;
    const list = codexByModel.get(r.model) ?? [];
    list.push(r);
    codexByModel.set(r.model, list);
  }
  const out: WindowChange[] = [];
  for (const [model, list] of byModel) {
    list.sort((a, b) => a.w.ts - b.w.ts);
    let current: number | null = null;
    for (const { w, r } of list) {
      if (w.window === current) continue;
      const date = dayKey(w.ts);
      const earlier = (codexByModel.get(model) ?? []).filter((x) => dayKey(x.ts) < date);
      const firstDayOnVersion = earlier.length > 0 && !earlier.some((x) => x.version === r.version);
      const c: WindowChange = {
        client: "codex",
        model,
        date,
        from: current,
        to: w.window,
        version: r.version,
        firstDayOnVersion,
        sentence:
          current === null
            ? `Codex reported a context window of ${int(w.window)} tokens for ${model} from ${shortDate(date)} (Codex ${r.version || "?"}), the first reading in this history.`
            : `From ${shortDate(date)} (Codex ${r.version || "?"}${firstDayOnVersion ? ", the first day on it" : ""}), Codex reported a context window of ${int(w.window)} tokens for ${model}, ${w.window < current ? "down" : "up"} from ${int(current)}.`,
      };
      out.push(c);
      current = w.window;
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------------------------
// One session, in order
// ---------------------------------------------------------------------------------------------

export interface Run {
  model: string;
  from: string;
  to: string;
  responses: number;
  /** What the transcript records just before this run began; null for the first run. */
  recorded: Recorded | null;
  sentence: string | null;
}

export interface SessionDetail {
  summary: SessionSummary;
  /** Claude Code: the main thread. Codex: every response, by the model Codex requested. */
  runs: Run[];
  reasoning: { model: string; responses: number; p50: number; p90: number; max: number }[];
}

/** Sessions whose id starts with `prefix`. */
export function matchSessions(report: Report, prefix: string): SessionSummary[] {
  const p = prefix.trim().toLowerCase();
  return report.sessions.filter((s) => s.session.toLowerCase().startsWith(p));
}

export function sessionDetail(
  input: AnalyzeInput,
  report: Report,
  summary: SessionSummary,
): SessionDetail {
  const { signals } = input;
  const list = input.requests
    .filter((r) => r.client === summary.client && r.session === summary.session)
    .sort((a, b) => a.ts - b.ts);
  const main = list.filter(
    (r) => r.client === "codex" || signals.responses.get(r.id)?.main === true,
  );
  const switches = report.switches.filter(
    (s) => s.client === summary.client && s.session === summary.session,
  );
  const runs: Run[] = [];
  for (const r of main) {
    const last = runs[runs.length - 1];
    if (last && last.model === r.model) {
      last.responses += 1;
      last.to = new Date(r.ts).toISOString();
      continue;
    }
    const at = new Date(r.ts).toISOString();
    const sw = switches.find((s) => s.at === at && s.to === r.model);
    runs.push({
      model: r.model,
      from: at,
      to: at,
      responses: 1,
      recorded: last ? (sw?.recorded ?? null) : null,
      sentence: last ? (sw?.sentence ?? null) : null,
    });
  }
  const reasoning = [...groupBy(reasoned(list, signals)).values()].map((xs) => {
    const sorted = xs.map((x) => x.reasoning).sort((a, b) => a - b);
    return {
      model: xs[0]!.model,
      responses: xs.length,
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      max: sorted[sorted.length - 1]!,
    };
  });
  return { summary, runs, reasoning: reasoning.sort((a, b) => b.responses - a.responses) };
}

export { pct };
