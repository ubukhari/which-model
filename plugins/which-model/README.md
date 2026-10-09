# which-model

Which model actually answered this machine's Claude Code and Codex sessions, explained inside
Claude Code.

- `/which-model:which-model` runs `npx -y --allow-git=root github:agentwares/which-model` (with your arguments,
  such as `--since 30d` or `--session <id>`) and explains which models answered by day and
  session, the served-model switches nothing you did explains, reasoning-token spikes at fixed
  values, and step changes in context ceiling or tokens per task, with the date and client version
  where each starts.

## What it runs, reads and sends

- **Runs** one command, through the Bash tool. The skill pre-approves nothing, so Claude Code asks
  you before the command runs.
- **Fetches** which-model with `npx`, from where that command names, and its one dependency,
  `seatledger`, from the npm registry.
- **Reads** this machine's Claude Code transcripts (`~/.claude/projects`) and Codex rollouts
  (`~/.codex/sessions`), and keeps counts and model ids, never text, in `~/.which-model`.
- **Sends nothing.** The command makes no network request. No LLM calls of its own, no
  telemetry, no account.

Claude Code records the model that answered each response; Codex records only the model it
requested. Findings say what moved and what it is consistent with, never why.

Source, the full CLI and its documentation: [github.com/agentwares/which-model](https://github.com/agentwares/which-model).
MIT licensed, by agentwares.
