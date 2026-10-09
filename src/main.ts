/**
 * `which-model` — which model actually answered your coding agent, from this machine's own
 * Claude Code and Codex transcripts.
 *
 *   which-model                     models by day, switches nothing you did explains, reasoning
 *                                   tokens per model and their spikes, step changes
 *   which-model --session <id>      one session in order
 *   which-model demo                the same on synthetic history (reads nothing of yours)
 *
 * Local only: it reads transcripts, keeps counts (never text) in ~/.which-model, and makes no
 * network request. A terminal may show one dim line about seatledger's team ledger at most once a
 * day (src/hint.ts); it is printed text, and nothing is sent.
 */
import { parseArgs } from "node:util";
import { CLIENTS, parseSince, sourceDirs } from "seatledger";
import { analyze, matchSessions, sessionDetail, type AnalyzeInput } from "./analyze.js";
import { collect, whichModelHome } from "./collect.js";
import { runDemo } from "./demo.js";
import { teamHint } from "./hint.js";
import { INSTALL, REPO } from "./install.js";
import { renderReport, renderSession, shortSession } from "./render.js";
import { version } from "./version.js";

const HELP = `which-model ${version()} — which model actually answered your coding agent, from this machine

Usage
  ${INSTALL} [options]
      models by day and session, served-model switches nothing you did explains, reasoning tokens
      per model with spikes at fixed values, and step changes in reasoning, tokens per task, prompt
      size and the auto-compaction point, with the client version
  ${INSTALL} --session <id>
      one session in order (any unique prefix of its id)
  ${INSTALL} demo
      the report on synthetic history (reads nothing of yours)

Options
  --since 90d|12w|2026-07-01         from this day (default: all history on this machine)
  --client claude-code|codex         one client only
  --json                             machine-readable output
  --claude-dir <dir>                 Claude Code projects dir (default $CLAUDE_CONFIG_DIR/projects,
                                     ~/.claude/projects, ~/.config/claude/projects)
  --codex-dir <dir>                  Codex sessions dir (default $CODEX_HOME/sessions, ~/.codex/sessions)
  --no-cache                         do not read or write ~/.which-model (counts kept per transcript)
  --quiet                            no team-ledger line (also WHICH_MODEL_QUIET=1)
  -h, --help / -v, --version

What it reads: model ids, client versions, timestamps, session ids and token counts from
~/.claude/projects and ~/.codex/sessions. It never prints or keeps prompt or response text, file
paths or project names, so its output can be pasted into an issue as it is. It makes no network
request and has no telemetry.

Claude Code records the model that answered each response. Codex records the model it requested,
not the one that answered, so a Codex reroute cannot be seen from its rollouts.
Findings say what moved, when and on which version, and what it is consistent with; they never
say why: this sees your machine, not the vendor's servers.
Source: ${REPO}`;

class UsageError extends Error {}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${flag} takes ${allowed.join(" | ")}, not "${value}"`);
  return value as T;
}

/** Where output goes; tests pass their own. `out.isTTY` decides whether the team line may show. */
export interface Io {
  out: { write(chunk: string): unknown; isTTY?: boolean };
  err: { write(chunk: string): unknown };
}

export async function main(
  argv: string[],
  io: Io = { out: process.stdout, err: process.stderr },
): Promise<number> {
  const print = (s: string) => io.out.write(s.endsWith("\n") ? s : s + "\n");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        since: { type: "string" },
        session: { type: "string" },
        client: { type: "string" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        "claude-dir": { type: "string" },
        "codex-dir": { type: "string" },
        "no-cache": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    io.err.write(`which-model: ${(err as Error).message}\nRun ${INSTALL} --help for usage.\n`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  if (flags.help) return (print(HELP), 0);
  if (flags.version) return (print(version()), 0);

  const [command = "report", ...rest] = positionals;
  const home = whichModelHome();
  // WHICH_MODEL_NOW pins the clock (reproducible screenshots and tests); otherwise it is now.
  const fixed = process.env.WHICH_MODEL_NOW ? Date.parse(process.env.WHICH_MODEL_NOW) : NaN;
  const now = Number.isFinite(fixed) ? fixed : Date.now();
  const json = (v: unknown) => print(JSON.stringify(v, null, 2));

  try {
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
    if (command !== "report" && command !== "demo")
      throw new UsageError(`unknown command "${command}" (which-model takes no command, or demo)`);
    const client = oneOf(flags.client, CLIENTS, "--client");
    const since = flags.since ? parseSince(flags.since, now) : undefined;
    if (flags.session !== undefined && flags.session.trim().length < 4)
      throw new UsageError("--session takes a session id, or at least its first 4 characters");

    let input: AnalyzeInput;
    if (command === "demo") {
      input = (await runDemo()).input;
    } else {
      input = await collect({
        dirs: sourceDirs({ claudeDir: flags["claude-dir"], codexDir: flags["codex-dir"] }),
        home,
        now,
        since,
        cache: !flags["no-cache"],
        ...(client ? { clients: [client] } : {}),
        onRead: (n) => {
          if (n > 50 && !flags.json)
            io.err.write(
              `which-model: reading ${n} transcripts (later runs reuse the counts kept in ${home})…\n`,
            );
        },
      });
    }
    if (client) input = { ...input, requests: input.requests.filter((r) => r.client === client) };
    const report = analyze(input);

    if (flags.session !== undefined) {
      const found = matchSessions(report, flags.session);
      if (found.length === 0) {
        io.err.write(
          `which-model: no session starting with "${flags.session.trim()}"${since ? " in this range" : ""}. Run ${INSTALL} --json to list them.\n`,
        );
        return 1;
      }
      if (found.length > 1) {
        io.err.write(
          `which-model: ${found.length} sessions start with "${flags.session.trim()}": ${found
            .slice(0, 8)
            .map((s) => shortSession(s.session))
            .join(", ")}${found.length > 8 ? ", …" : ""}. Give more of the id.\n`,
        );
        return 1;
      }
      const detail = sessionDetail(input, report, found[0]!);
      if (flags.json) json(detail);
      else print(renderSession(detail));
      return 0;
    }

    if (flags.json) {
      json(report);
      return 0;
    }
    if (command === "demo")
      print("Synthetic history, generated for this demo: not anyone's usage.\n");
    print(renderReport(report));
    if (command !== "demo") {
      const line = teamHint({
        home,
        now,
        env: process.env,
        tty: io.out.isTTY === true,
        quiet: flags.quiet ?? false,
      });
      if (line) print(line);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError || /--since takes/.test((err as Error).message)) {
      io.err.write(`which-model: ${(err as Error).message}\nRun ${INSTALL} --help for usage.\n`);
      return 2;
    }
    throw err;
  }
}
