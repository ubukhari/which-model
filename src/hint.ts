/**
 * The one pointer to seatledger's team ledger: the last line of the human output, at most once a
 * day per machine, only to a terminal, never with `--json`, never in `--session` output, and never
 * at all with `--quiet` or `WHICH_MODEL_QUIET=1`.
 *
 * It says what the ledger shows today (the team's model mix, by model and by day) and nothing it
 * does not: the team ledger has no alert on served-model changes. Printing it sends nothing; the
 * day it was last shown is the only state, in `~/.which-model/hint.json`, and if that cannot be
 * written the line is not shown, so a read-only home never turns it into a line on every run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dayKey } from "seatledger";

export const TEAM_LEDGER_URL =
  "https://agentwares-agentcheck.vercel.app/seatledger?ref=which-model";

export const HINT = `Your whole team's model mix, by model and by day, in one ledger (seatledger, free for up to 3 developers): ${TEAM_LEDGER_URL}`;

export interface HintContext {
  home: string;
  now: number;
  env: NodeJS.ProcessEnv;
  /** stdout is a terminal */
  tty: boolean;
  /** --quiet */
  quiet: boolean;
}

export const hintFile = (home: string): string => path.join(home, "hint.json");

/** WHICH_MODEL_QUIET=1 (any value but empty, 0 or false) silences the pointer. */
export function quietFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.WHICH_MODEL_QUIET?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Dim, unless NO_COLOR asks for plain text or the terminal cannot show it. */
export function dim(text: string, env: NodeJS.ProcessEnv): string {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return text;
  if (env.TERM === "dumb") return text;
  return `\u001b[2m${text}\u001b[22m`;
}

function lastShown(home: string): string | null {
  const file = hintFile(home);
  if (!existsSync(file)) return null;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { last_shown?: unknown }).last_shown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The line to print, or null. Showing it records today, so the next call today returns null. */
export function teamHint(ctx: HintContext): string | null {
  if (!ctx.tty || ctx.quiet || quietFromEnv(ctx.env)) return null;
  const today = dayKey(ctx.now);
  if (lastShown(ctx.home) === today) return null;
  try {
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(hintFile(ctx.home), JSON.stringify({ last_shown: today }) + "\n");
  } catch {
    return null;
  }
  return dim(HINT, ctx.env);
}
