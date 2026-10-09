import { Client, SourceDirs, UsageRecord, SourceSummary } from 'seatledger';

/** One "server reported model" line. */
interface ServedLine {
    ts: number;
    /** Codex's thread id, when the line names one. */
    thread: string | null;
    served: string;
    /** null when the line says the server's model matched the request. */
    requested: string | null;
}
interface CodexLog {
    /** Log databases and text logs found under Codex's home. */
    databases: number;
    textLogs: number;
    /** Databases that could not be opened, and why (an old Node, a locked or corrupt file). */
    unread: {
        reason: string;
        count: number;
    }[];
    /** Lines in what was read, and the time they span. */
    lines: number;
    from: number | null;
    to: number | null;
    /** The "server reported model" lines in range, oldest first. */
    served: ServedLine[];
}
/** The models one log line names, or undefined when it is not a served-model line. */
declare function servedFrom(text: string): {
    served: string;
    requested: string | null;
} | undefined;
/** Codex's home: the directory its sessions directory sits in. */
declare function codexHomeOf(sessionsDirs: readonly string[]): string | null;
/**
 * Merge `lines` into which-model's copy under `home` and return everything kept. Codex prunes its
 * log within days; this keeps the model ids, times and thread ids of the lines it has seen, so a
 * reroute stays on record. Best effort: a copy that cannot be written costs history, not a report.
 */
declare function keepServed(home: string, lines: readonly ServedLine[]): ServedLine[];
/** Every served-model line Codex logged on this machine, from its log database and text log. */
declare function readCodexLog(codexHome: string | null, since?: number): Promise<CodexLog>;

interface ResponseSignal {
    /** seatledger's request id for the same response. */
    key: string;
    /** Reasoning (thinking) tokens, or null when the transcript does not record them. */
    reasoning: number | null;
    /** Claude Code: false for subagent responses. Codex: always true. */
    main: boolean;
}
/** Codex's own reading of the model's context window, at one point in a thread. */
interface WindowReading {
    session: string;
    ts: number;
    window: number;
}
/** A model the person picked with `/model` (Claude Code), as the client printed it. */
interface ModelChoice {
    session: string;
    ts: number;
    model: string;
}
/** A fallback the client wrote into the transcript: requested `from`, served `to`. */
interface FallbackNotice {
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
interface Compaction {
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
interface CodexReroute$1 {
    session: string;
    ts: number;
    from: string;
    to: string;
    reason: string;
}
/** What started a Claude Code session: `cli`, `claude-desktop`, or the Agent SDK's `sdk-ts`, … */
interface SessionEntry {
    session: string;
    ts: number;
    entrypoint: string;
}
interface SignalExtract {
    client: Client;
    responses: ResponseSignal[];
    windows: WindowReading[];
    choices: ModelChoice[];
    fallbacks: FallbackNotice[];
    compactions: Compaction[];
    reroutes: CodexReroute$1[];
    entrypoints: SessionEntry[];
}
/** The model id in the client's "Set model to …" output, lower-cased, without decoration. */
declare function pickedModel(text: string): string | undefined;
declare function readClaudeCodeSignals(file: string): Promise<SignalExtract>;
declare function readCodexSignals(file: string): Promise<SignalExtract>;
interface SignalOptions {
    dirs: SourceDirs;
    home: string;
    since?: number;
    cache?: boolean;
    clients?: readonly Client[];
}
interface Signals {
    responses: Map<string, ResponseSignal>;
    windows: WindowReading[];
    choices: ModelChoice[];
    fallbacks: FallbackNotice[];
    compactions: Compaction[];
    reroutes: CodexReroute$1[];
    /** Claude Code session → what started it (`cli`, `claude-desktop`, `sdk-ts`, …). */
    entrypoints: Map<string, string>;
}
declare function loadSignals(opts: SignalOptions): Promise<Signals>;

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

/** The Codex release whose source this was checked against, and when. */
declare const CODEX_CHECKED: {
    version: string;
    tag: string;
    date: string;
};
/** The Claude Agent SDK's sessions, as Claude Code's transcripts mark them. */
declare const AGENT_SDK_ENTRYPOINTS: ReadonlySet<string>;
/** What the OpenAI Agents SDK keeps on the machine it runs on (read 8 Oct 2026). */
declare const OPENAI_AGENTS_SDK = "the OpenAI Agents SDK (@openai/agents 0.20, openai-agents 0.23) keeps no local log by default: its default trace exporter sends spans to OpenAI's Traces dashboard, so there is nothing on this machine to read";
declare const MIN_SPIKE_TOKENS = 64;
declare const SPIKE_RATIO = 8;
interface ModelDay {
    day: string;
    client: Client;
    model: string;
    responses: number;
    /** Of this client's responses that day. */
    share: number;
}
interface ModelCount {
    model: string;
    responses: number;
}
interface SessionSummary {
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
type Recorded = "your-model-change" | "fallback-notice" | "client-relaunch" | "nothing" | "codex-request";
interface Switch {
    client: Client;
    session: string;
    at: string;
    day: string;
    from: string;
    to: string;
    version: string;
    previousVersion: string;
    recorded: Recorded;
    notice: {
        from: string;
        to: string;
        trigger: string;
    } | null;
    /** The model last recorded as requested in this session at that moment, if any. */
    requested: string | null;
    /** The responses served by `to` from here until the next switch or the end of the session. */
    run: {
        responses: number;
        hours: number;
        until: string;
        ended: "switch" | "session-end";
    };
    sentence: string;
}
interface Spike {
    tokens: number;
    responses: number;
    share: number;
    /** Responses at exactly `tokens` over the average of the values within 5% either side. */
    ratio: number;
    firstDay: string;
    lastDay: string;
    versions: string[];
}
interface ReasoningStats {
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
declare const STEP_METRICS: readonly ["reasoning_per_response", "tokens_per_turn", "largest_prompt", "compaction_point"];
type StepMetric = (typeof STEP_METRICS)[number];
declare const STEP_LABEL: Readonly<Record<StepMetric, string>>;
interface Step {
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
interface WindowChange {
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
/** A response Codex shows was answered by a model other than the one it requested. */
interface CodexReroute {
    at: string;
    /** Codex's thread id, when the record names one. */
    thread: string | null;
    requested: string;
    served: string;
    /** `log`: Codex's own log line. `rollout`: a `model_reroute` event in a rollout. */
    source: "log" | "rollout";
    /** As Codex recorded it (`high_risk_cyber_activity`), or "" when the log line does not say. */
    reason: string;
}
/** Which model answered Codex, from everything Codex writes locally. */
interface CodexSection {
    /** Codex versions whose rollouts are in this range. */
    versions: string[];
    responses: number;
    /** Rollouts record the model Codex requested; true only if a rollout holds a reroute event. */
    rolloutsRecordServed: boolean;
    checked: typeof CODEX_CHECKED;
    /** Codex's log database and text log; null when there is no Codex home to look in. */
    log: {
        databases: number;
        textLogs: number;
        unread: {
            reason: string;
            count: number;
        }[];
        lines: number;
        from: string | null;
        to: string | null;
        /** "server reported model" lines, and those where the served model matched the request. */
        served: number;
        matched: number;
    } | null;
    reroutes: CodexReroute[];
    sentence: string;
}
interface SdkSection {
    /** Claude Agent SDK sessions in the Claude Code transcripts (entrypoint sdk-ts, sdk-py, sdk-cli). */
    claudeAgentSdk: {
        sessions: number;
        responses: number;
        switches: number;
    };
    openaiAgentsSdk: string;
}
interface Report {
    generatedAt: string;
    /** First day covered, YYYY-MM-DD, or null for all history. */
    since: string | null;
    method: string;
    sources: SourceSummary[];
    codex: CodexSection | null;
    sdk: SdkSection;
    days: ModelDay[];
    sessions: SessionSummary[];
    switches: Switch[];
    servedNotRequested: {
        responses: number;
        sessions: number;
    };
    reasoning: ReasoningStats[];
    steps: Step[];
    windows: WindowChange[];
    notes: string[];
}
declare const METHOD: string;
/** Model ids compared without decoration: case, a `[1m]` context suffix, a date suffix. */
declare function baseModel(id: string): string;
/** True when both are full model ids and name different models; false when they match or cannot be compared. */
declare function differentModel(served: string, requested: string): boolean;
interface AnalyzeInput {
    requests: readonly UsageRecord[];
    signals: Signals;
    sources: SourceSummary[];
    /** What Codex logged about the model that answered; null when Codex was not read. */
    codexLog?: CodexLog | null;
    now: number;
    since?: number | undefined;
}
declare function analyze(input: AnalyzeInput): Report;
/** Exact reasoning-token counts that hold far more responses than the values around them. */
declare function findSpikes(list: readonly {
    reasoning: number;
    day: string;
    version: string;
}[]): Spike[];
interface Run {
    model: string;
    from: string;
    to: string;
    responses: number;
    /** What the transcript records just before this run began; null for the first run. */
    recorded: Recorded | null;
    sentence: string | null;
}
interface SessionDetail {
    summary: SessionSummary;
    /** Claude Code: the main thread. Codex: every response, by the model Codex requested. */
    runs: Run[];
    reasoning: {
        model: string;
        responses: number;
        p50: number;
        p90: number;
        max: number;
    }[];
}
/** Sessions whose id starts with `prefix`. */
declare function matchSessions(report: Report, prefix: string): SessionSummary[];
declare function sessionDetail(input: AnalyzeInput, report: Report, summary: SessionSummary): SessionDetail;

/** which-model's own files: `$WHICH_MODEL_HOME`, else `~/.which-model`. */
declare function whichModelHome(env?: NodeJS.ProcessEnv): string;
interface RunOptions {
    dirs: SourceDirs;
    home: string;
    now: number;
    since?: number | undefined;
    cache?: boolean;
    clients?: readonly Client[];
    onRead?: (files: number) => void;
}
/** Read every transcript (or its cached counts) and join the two readers' output. */
declare function collect(opts: RunOptions): Promise<AnalyzeInput>;

interface Demo {
    input: AnalyzeInput;
    report: Report;
    text: string;
    now: number;
}
declare function runDemo(): Promise<Demo>;
/** The README picture: the command, then what it printed. */
declare function screenshotText(demo: Demo): string;
/** Terminal-style SVG of plain text (seatledger's renderer, with this tool's label). */
declare function textToSvg(text: string): string;

declare const TEAM_LEDGER_URL = "https://agentwares-agentcheck.vercel.app/seatledger?ref=which-model";
declare const HINT = "Your whole team's model mix, by model and by day, in one ledger (seatledger, free for up to 3 developers): https://agentwares-agentcheck.vercel.app/seatledger?ref=which-model";

/**
 * The human output. Everything it prints is a model id, a client version, a date, a count or a
 * session id: never a prompt, a response, a file path or a project name, so the output can be
 * pasted into a public issue as it is.
 */

declare function renderReport(report: Report, opts?: {
    days?: number;
}): string;
declare function renderSession(d: SessionDetail): string;

declare const SYNTHETIC_NOW: number;
interface Synthetic {
    claudeDir: string;
    codexDir: string;
    now: number;
}
declare function writeSyntheticHistory(dir: string): Synthetic;

export { AGENT_SDK_ENTRYPOINTS, type AnalyzeInput, CODEX_CHECKED, type CodexLog, type CodexReroute, type CodexSection, type Compaction, type Demo, type FallbackNotice, HINT, METHOD, MIN_SPIKE_TOKENS, type ModelChoice, type ModelCount, type ModelDay, OPENAI_AGENTS_SDK, type ReasoningStats, type Recorded, type Report, type ResponseSignal, type CodexReroute$1 as RolloutReroute, type Run, type RunOptions, SPIKE_RATIO, STEP_LABEL, STEP_METRICS, SYNTHETIC_NOW, type SdkSection, type ServedLine, type SessionDetail, type SessionEntry, type SessionSummary, type SignalExtract, type Signals, type Spike, type Step, type StepMetric, type Switch, type Synthetic, TEAM_LEDGER_URL, type WindowChange, type WindowReading, analyze, baseModel, codexHomeOf, collect, differentModel, findSpikes, keepServed, loadSignals, matchSessions, pickedModel, readClaudeCodeSignals, readCodexLog, readCodexSignals, renderReport, renderSession, runDemo, screenshotText, servedFrom, sessionDetail, textToSvg, whichModelHome, writeSyntheticHistory };
