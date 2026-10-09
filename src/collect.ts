/**
 * The whole pipeline without any output: seatledger reads the requests, `signals.ts` reads what
 * seatledger does not keep, and both keep their counts (never text) under which-model's home.
 * `codex-log.ts` reads the lines Codex's own log keeps about the model that answered; Codex prunes
 * its log within days, so which-model keeps the model ids, times and thread ids of those lines.
 */
import { homedir } from "node:os";
import path from "node:path";
import { load, type Client, type SourceDirs } from "seatledger";
import type { AnalyzeInput } from "./analyze.js";
import { codexHomeOf, keepServed, readCodexLog } from "./codex-log.js";
import { loadSignals } from "./signals.js";

/** which-model's own files: `$WHICH_MODEL_HOME`, else `~/.which-model`. */
export function whichModelHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WHICH_MODEL_HOME
    ? path.resolve(env.WHICH_MODEL_HOME)
    : path.join(homedir(), ".which-model");
}

export interface RunOptions {
  dirs: SourceDirs;
  home: string;
  now: number;
  since?: number | undefined;
  cache?: boolean;
  clients?: readonly Client[];
  onRead?: (files: number) => void;
}

/** Read every transcript (or its cached counts) and join the two readers' output. */
export async function collect(opts: RunOptions): Promise<AnalyzeInput> {
  const loaded = await load({
    dirs: opts.dirs,
    home: opts.home,
    cache: opts.cache ?? true,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.clients ? { clients: opts.clients } : {}),
    ...(opts.onRead ? { onRead: opts.onRead } : {}),
  });
  const signals = await loadSignals({
    dirs: opts.dirs,
    home: opts.home,
    cache: opts.cache ?? true,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.clients ? { clients: opts.clients } : {}),
  });
  const codex = !opts.clients || opts.clients.includes("codex");
  const codexLog = codex ? await readCodexLog(codexHomeOf(opts.dirs.codex)) : null;
  // which-model keeps the served-model lines past Codex's pruning; the report filters by range
  if (codexLog && (opts.cache ?? true)) codexLog.served = keepServed(opts.home, codexLog.served);
  return {
    requests: loaded.requests.filter((r) => r.ts <= opts.now),
    signals,
    sources: loaded.sources,
    codexLog,
    now: opts.now,
    since: opts.since,
  };
}
