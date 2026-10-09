/**
 * The whole pipeline without any output: seatledger reads the requests, `signals.ts` reads what
 * seatledger does not keep, and both keep their counts (never text) under which-model's home.
 */
import { homedir } from "node:os";
import path from "node:path";
import { load, type Client, type SourceDirs } from "seatledger";
import type { AnalyzeInput } from "./analyze.js";
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
  return {
    requests: loaded.requests.filter((r) => r.ts <= opts.now),
    signals,
    sources: loaded.sources,
    now: opts.now,
    since: opts.since,
  };
}
