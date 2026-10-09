# Changelog

## 0.1.0 (2026-10-08)

First release: which model actually answered your coding agent, from your own machine.

- `npx --allow-git=root github:agentwares/which-model` reads this machine's Claude Code transcripts and Codex rollouts and reports,
  by day and by session, which models answered; served-model switches nothing you did explains in
  a Claude Code session's main thread, labelled by what the transcript records just before them
  (your `/model`, a fallback notice the client wrote, a client relaunch, or nothing), with how many
  responses and hours the other model then served; responses answered by a different model than
  the one last recorded as requested; the reasoning-token distribution per model with spikes at
  fixed values; step changes in reasoning tokens per response, tokens per task, the largest prompt
  of the day and the auto-compaction point, with the date and client version (seatledger's
  rolling-baseline detector); and every change in the context window Codex reports.
- `--since`, `--client`, `--session <id prefix>`, `--json`, `demo` (synthetic history).
- Uses seatledger's readers, loader and step detector rather than copies; adds a narrow reader for
  the fields seatledger does not keep (reasoning tokens, main thread or subagent, `/model` output,
  fallback notices, compaction points, Codex's context window), joined on seatledger's request ids.
- Local only: no network request, no telemetry, no account. Output holds model ids, versions,
  dates, counts and session ids, never text, paths or project names. Counts are cached per
  transcript under `~/.which-model`.
- One dim line after the human output, at most once a day on a terminal, points to seatledger's
  team ledger (the whole team's model mix by model and by day); never with `--json` or `--session`,
  silenced by `--quiet` or `WHICH_MODEL_QUIET=1`.
- A Claude Code plugin with a `which-model` skill (no pre-approved tools).
