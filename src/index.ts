/**
 * which-model as a library: the extra signals reader, the analysis and the renderers, for tools
 * that want the same findings the CLI prints. Everything is local; nothing here makes a request.
 */
export {
  analyze,
  baseModel,
  differentModel,
  findSpikes,
  matchSessions,
  sessionDetail,
  METHOD,
  MIN_SPIKE_TOKENS,
  SPIKE_RATIO,
  STEP_LABEL,
  STEP_METRICS,
  type AnalyzeInput,
  type ModelDay,
  type ModelCount,
  type ReasoningStats,
  type Recorded,
  type Report,
  type Run,
  type SessionDetail,
  type SessionSummary,
  type Spike,
  type Step,
  type StepMetric,
  type Switch,
  type WindowChange,
} from "./analyze.js";
export { collect, whichModelHome, type RunOptions } from "./collect.js";
export { runDemo, screenshotText, textToSvg, type Demo } from "./demo.js";
export { HINT, TEAM_LEDGER_URL } from "./hint.js";
export { renderReport, renderSession } from "./render.js";
export {
  loadSignals,
  pickedModel,
  readClaudeCodeSignals,
  readCodexSignals,
  type Compaction,
  type FallbackNotice,
  type ModelChoice,
  type ResponseSignal,
  type SignalExtract,
  type Signals,
  type WindowReading,
} from "./signals.js";
export { writeSyntheticHistory, SYNTHETIC_NOW, type Synthetic } from "./synthetic.js";
