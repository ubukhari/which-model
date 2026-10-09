---
name: which-model
description: Explain which model actually answered this machine's Claude Code and Codex sessions - for Codex, the reroutes its own log records, since its rollouts name only the requested model - models by day and session, served-model switches nothing the user did explains (with any fallback notice the client recorded), reasoning-token spikes at fixed values such as 516, and step changes in context ceiling or tokens per task with the date and client version - by running which-model on the local transcripts. Use when the user suspects Claude Code or Codex switched or rerouted their model, that a model got worse or reasons less, or that Codex cut its context window.
argument-hint: "[--since 90d] [--client claude-code|codex] [--session <id>]"
---

# Explain which model answered

which-model (MIT, [source](https://github.com/agentwares/which-model)) reads this machine's
Claude Code and Codex transcripts and reports which model answered each response, from the fields
the clients themselves write. It makes no network calls and sends nothing anywhere.

Run it with the Bash tool (Claude Code asks the user to approve the command; this skill pre-approves
nothing):

```sh
npx -y --allow-git=root github:agentwares/which-model $ARGUMENTS
```

Then explain it in plain words:

1. **Switches nothing the user did explains.** For each one: the date, the two models, the client
   version, and what the transcript records just before it. A fallback notice means the client
   itself wrote that it moved the session to another model; say how many responses and hours the
   other model then served. "Nothing recorded" means no `/model`, no notice and no client update;
   it is not proof of a reroute, because a model picked in a way the transcript does not record
   looks the same. Ask the user whether they changed models that way.
2. **Reasoning spikes**: an exact reasoning-token count that holds a large share of a model's
   responses. Say it is consistent with a cap or budget at that value, and that it cannot show
   whether any reasoning was cut short.
3. **Step changes and context windows**: what moved, from when, by how much, on which model and
   client version, and the finding's own "consistent with" wording. Codex's context window is the
   value Codex itself reported.
4. **Codex**: its rollouts record the model it requested, never the one that answered. Codex logs
   the model the server reported, and a mismatch, to its own log database, and which-model lists
   a Codex reroute only where that log shows one. Read back the output's Codex section as it is:
   if it shows a reroute, give the models, the date and that Codex itself logged it; if it shows
   none, or the log could not be read, say that no reroute can be shown, not that none happened.

which-model never names a cause and neither should you: it sees the user's machine, not the
vendor's servers. Its output holds model ids, versions, dates, counts and session ids only, so
the user can attach it to a report to the vendor. Do not file anything on the user's behalf.
