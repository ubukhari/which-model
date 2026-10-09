// src/analyze.ts
import {
  CLIENT_LABEL,
  dailySeries,
  dayKey,
  detectSteps
} from "seatledger";
var MIN_SPIKE_TOKENS = 64;
var SPIKE_RATIO = 8;
var SPIKE_MIN_SHARE = 0.01;
var SPIKE_MIN_RESPONSES = 10;
var MIN_DAY_RESPONSES = 20;
var MIN_REASONING_RESPONSES = 20;
var STEP_METRICS = [
  "reasoning_per_response",
  "tokens_per_turn",
  "largest_prompt",
  "compaction_point"
];
var STEP_LABEL = {
  reasoning_per_response: "median reasoning tokens per response",
  tokens_per_turn: "tokens per task (user turn)",
  largest_prompt: "largest prompt of the day",
  compaction_point: "median auto-compaction point"
};
var METHOD = `Models are as each client wrote them: Claude Code records the model that answered each response, Codex records the model it requested. A switch is two consecutive main-thread responses in one Claude Code session answered by different models; it is labelled by what the transcript records just before it (your /model, a fallback notice, a client relaunch, or nothing). Reasoning spikes are counts of at least ${MIN_SPIKE_TOKENS} tokens holding at least 1% of a model's responses and ${SPIKE_RATIO}x the values within 5% either side. Step changes use seatledger's rolling baseline: complete days with enough responses, a median of up to 7 active days before against up to 7 from the day, at least 30% apart, 3/4 of days on their own side, and more than 3x the day-to-day spread. Findings say what moved and what it is consistent with; they cannot see the vendor's side.`;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var shortDate = (day) => {
  const [, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? "?"}`;
};
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}
function mostCommon(xs) {
  const n = /* @__PURE__ */ new Map();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  let best = "";
  let most = -1;
  for (const [k, c] of n) if (c > most) [best, most] = [k, c];
  return best;
}
var inc = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
var counts = (m) => [...m].map(([model, responses]) => ({ model, responses })).sort((a, b) => b.responses - a.responses);
function baseModel(id) {
  return id.toLowerCase().replace(/`/g, "").replace(/\[[0-9a-z]+\]$/, "").replace(/-\d{8}$/, "");
}
function differentModel(served, requested) {
  const a = baseModel(served);
  const b = baseModel(requested);
  if (!a.startsWith("claude-") || !b.startsWith("claude-")) return false;
  return a !== b;
}
var int = (n) => Math.round(n).toLocaleString("en-US");
function movement(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return "changed";
  if (ratio >= 1.9 && ratio < 2.15) return "doubled";
  if (ratio >= 2.15) return `rose ${ratio.toFixed(1)}x`;
  if (ratio > 1) return `rose ${Math.round((ratio - 1) * 100)}%`;
  if (ratio <= 0.55 && ratio > 0.45) return "halved";
  return `fell ${Math.round((1 - ratio) * 100)}%`;
}
function analyze(input) {
  const { requests, signals, now } = input;
  const today = dayKey(now);
  const isMain = (r) => r.client === "codex" || signals.responses.get(r.id)?.main === true;
  const isSub = (r) => r.client === "claude-code" && signals.responses.get(r.id)?.main === false;
  const switches = [...claudeSwitches(requests, signals, isMain), ...codexChanges(requests)];
  switches.sort((a, b) => b.at.localeCompare(a.at));
  const sessions = sessionSummaries(requests, signals, isMain, isSub, switches);
  const servedNotRequested = {
    responses: sessions.reduce((n, s) => n + s.servedNotRequested, 0),
    sessions: sessions.filter((s) => s.servedNotRequested > 0).length
  };
  const complete = requests.filter((r) => dayKey(r.ts) !== today);
  const reasoning = reasoningStats(requests, signals);
  const steps = [
    ...reasoningSteps(complete, signals),
    ...turnSteps(complete),
    ...promptSteps(complete),
    ...compactionSteps(
      complete,
      signals.compactions.filter((c) => dayKey(c.ts) !== today)
    )
  ].sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));
  const notes = [];
  if (requests.some((r) => r.client === "codex"))
    notes.push(
      "Codex records the model it requested for each turn, not the model that answered, so a Codex reroute cannot be seen from its rollouts."
    );
  if (switches.some((s) => s.recorded === "nothing"))
    notes.push(
      "A switch with nothing recorded before it is not proof of a reroute: a model picked in a way the transcript does not record (a picker, or a relaunch with --model on the same version) looks the same."
    );
  return {
    generatedAt: new Date(now).toISOString(),
    since: input.since === void 0 ? null : dayKey(input.since),
    method: METHOD,
    sources: input.sources,
    days: modelDays(requests),
    sessions,
    switches,
    servedNotRequested,
    reasoning,
    steps,
    windows: windowChanges(requests, signals.windows),
    notes
  };
}
function modelDays(requests) {
  const by = /* @__PURE__ */ new Map();
  const totals = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const day = dayKey(r.ts);
    inc(by, `${day}\0${r.client}\0${r.model}`);
    inc(totals, `${day}\0${r.client}`);
  }
  return [...by].map(([k, responses]) => {
    const [day, client, model] = k.split("\0");
    return {
      day,
      client,
      model,
      responses,
      share: responses / (totals.get(`${day}\0${client}`) ?? responses)
    };
  }).sort(
    (a, b) => b.day.localeCompare(a.day) || a.client.localeCompare(b.client) || b.responses - a.responses
  );
}
function bySession(requests) {
  const out = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const k = `${r.client}\0${r.session}`;
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
  return out;
}
function groupEvents(xs) {
  const out = /* @__PURE__ */ new Map();
  for (const x of xs) {
    const list = out.get(x.session) ?? [];
    list.push(x);
    out.set(x.session, list);
  }
  return out;
}
var hours = (ms) => Math.round(ms / 36e5 * 10) / 10;
function requestedAt(ts, choices, fallbacks) {
  let best = null;
  for (const c of choices) if (c.ts <= ts && (!best || c.ts >= best.ts)) best = c;
  for (const f of fallbacks)
    if (f.ts <= ts && (!best || f.ts > best.ts)) best = { ts: f.ts, model: f.from };
  return best?.model ?? null;
}
function claudeSwitches(requests, signals, isMain) {
  const choices = groupEvents(signals.choices);
  const fallbacks = groupEvents(signals.fallbacks.filter((f) => f.main));
  const out = [];
  const main = requests.filter((r) => r.client === "claude-code" && isMain(r));
  for (const list of bySession(main).values()) {
    const session = list[0].session;
    const sc = choices.get(session) ?? [];
    const sf = fallbacks.get(session) ?? [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const r = list[i];
      if (prev.model === r.model) continue;
      const between = (xs) => xs.filter((x) => x.ts > prev.ts && x.ts <= r.ts);
      const picked = between(sc);
      const notices = between(sf);
      const notice = notices.find((n) => n.to === r.model) ?? notices[0] ?? null;
      const recorded = picked.length > 0 ? "your-model-change" : notice ? "fallback-notice" : prev.version !== r.version ? "client-relaunch" : "nothing";
      let j = i;
      while (j + 1 < list.length && list[j + 1].model === r.model) j++;
      const last = list[j];
      const s = {
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
          ended: j + 1 < list.length ? "switch" : "session-end"
        },
        sentence: ""
      };
      s.sentence = switchSentence(s);
      out.push(s);
    }
  }
  return out;
}
function codexChanges(requests) {
  const out = [];
  const codex = requests.filter((r) => r.client === "codex");
  for (const list of bySession(codex).values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const r = list[i];
      if (prev.model === r.model) continue;
      let j = i;
      while (j + 1 < list.length && list[j + 1].model === r.model) j++;
      const last = list[j];
      const s = {
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
          ended: j + 1 < list.length ? "switch" : "session-end"
        },
        sentence: ""
      };
      s.sentence = switchSentence(s);
      out.push(s);
    }
  }
  return out;
}
function switchSentence(s) {
  const run = `${int(s.run.responses)} response${s.run.responses === 1 ? "" : "s"} over ${s.run.hours} h, ${s.run.ended === "switch" ? "until the next switch" : "to the end of the session"}`;
  const head = `${s.from} \u2192 ${s.to}`;
  switch (s.recorded) {
    case "your-model-change":
      return `${head} after your /model; ${run}.`;
    case "fallback-notice":
      return `${head} after a fallback notice the client recorded (${s.notice.from} \u2192 ${s.notice.to}${s.notice.trigger ? `, trigger: ${s.notice.trigger}` : ""}); served ${run}.`;
    case "client-relaunch":
      return `${head} when the session continued on ${CLIENT_LABEL[s.client]} ${s.version || "?"} (previously ${s.previousVersion || "?"}); a model set at launch is not recorded. ${run}.`;
    case "nothing":
      return `${head} with nothing recorded before it (no /model, no fallback notice, same client version); served ${run}.`;
    case "codex-request":
      return `Codex requested ${s.to} instead of ${s.from}; Codex does not record which model answered. ${run}.`;
  }
}
function sessionSummaries(requests, signals, isMain, isSub, switches) {
  const choices = groupEvents(signals.choices);
  const fallbacks = groupEvents(signals.fallbacks.filter((f) => f.main));
  const unexplained = /* @__PURE__ */ new Map();
  for (const s of switches)
    if (s.recorded === "fallback-notice" || s.recorded === "nothing")
      inc(unexplained, `${s.client}\0${s.session}`);
  const out = [];
  for (const [k, list] of bySession(requests)) {
    const first = list[0];
    const main = /* @__PURE__ */ new Map();
    const sub = /* @__PURE__ */ new Map();
    const versions = /* @__PURE__ */ new Set();
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
      last: new Date(list[list.length - 1].ts).toISOString(),
      versions: [...versions].sort(),
      models: counts(main),
      subagentModels: counts(sub),
      unexplainedSwitches: unexplained.get(k) ?? 0,
      servedNotRequested: notRequested
    });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}
function reasoned(requests, signals) {
  const out = [];
  for (const r of requests) {
    const reasoning = signals.responses.get(r.id)?.reasoning;
    if (reasoning === null || reasoning === void 0) continue;
    out.push({
      client: r.client,
      model: r.model,
      day: dayKey(r.ts),
      version: r.version,
      reasoning
    });
  }
  return out;
}
var groupKey = (x) => `${x.client}\0${x.model}`;
function groupBy(xs) {
  const out = /* @__PURE__ */ new Map();
  for (const x of xs) {
    const k = groupKey(x);
    const list = out.get(k) ?? [];
    list.push(x);
    out.set(k, list);
  }
  return out;
}
function reasoningStats(requests, signals) {
  const out = [];
  for (const list of groupBy(reasoned(requests, signals)).values()) {
    if (list.length < MIN_REASONING_RESPONSES) continue;
    const sorted = list.map((x) => x.reasoning).sort((a, b) => a - b);
    const days = list.map((x) => x.day).sort();
    out.push({
      client: list[0].client,
      model: list[0].model,
      responses: list.length,
      zeroShare: sorted.filter((v) => v === 0).length / sorted.length,
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      p99: quantile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      firstDay: days[0],
      lastDay: days[days.length - 1],
      spikes: findSpikes(list)
    });
  }
  return out.sort((a, b) => b.responses - a.responses);
}
function findSpikes(list) {
  const nonZero = list.filter((x) => x.reasoning > 0);
  const n = nonZero.length;
  if (n === 0) return [];
  const at = /* @__PURE__ */ new Map();
  for (const x of nonZero) at.set(x.reasoning, (at.get(x.reasoning) ?? 0) + 1);
  const minCount = Math.max(SPIKE_MIN_RESPONSES, Math.ceil(n * SPIKE_MIN_SHARE));
  const width = (v) => Math.max(8, Math.round(v * 0.05));
  const candidates = [];
  for (const [v, c] of at) {
    if (v < MIN_SPIKE_TOKENS || c < minCount) continue;
    const w = width(v);
    let around = 0;
    for (let u = v - w; u <= v + w; u++) if (u !== v) around += at.get(u) ?? 0;
    const expected = Math.max(around / (2 * w), 1 / (2 * w));
    const ratio = c / expected;
    if (ratio >= SPIKE_RATIO) candidates.push({ tokens: v, responses: c, ratio });
  }
  const kept = candidates.filter(
    (c) => !candidates.some(
      (o) => o !== c && Math.abs(o.tokens - c.tokens) <= width(c.tokens) && (o.responses > c.responses || o.responses === c.responses && o.tokens < c.tokens)
    )
  );
  return kept.sort((a, b) => b.responses - a.responses).slice(0, 5).map((c) => {
    const hits = nonZero.filter((x) => x.reasoning === c.tokens);
    const days = hits.map((x) => x.day).sort();
    return {
      tokens: c.tokens,
      responses: c.responses,
      share: c.responses / n,
      ratio: Math.round(c.ratio),
      firstDay: days[0],
      lastDay: days[days.length - 1],
      versions: [...new Set(hits.map((x) => x.version).filter(Boolean))].sort()
    };
  });
}
function versionsByDay(requests) {
  const per = /* @__PURE__ */ new Map();
  for (const r of requests) {
    const k = groupKey(r);
    let days = per.get(k);
    if (!days) per.set(k, days = /* @__PURE__ */ new Map());
    const day = dayKey(r.ts);
    const list = days.get(day) ?? [];
    list.push(r.version);
    days.set(day, list);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [k, days] of per) {
    const m = /* @__PURE__ */ new Map();
    for (const [day, vs] of days) m.set(day, mostCommon(vs));
    out.set(k, m);
  }
  return out;
}
var point = (d, version) => ({
  day: d.day,
  requests: d.samples,
  turns: 0,
  version,
  values: { tokens_per_request: d.value },
  cacheReadsPerRequest: 0,
  cacheWritesPerRequest: 0
});
function stepsFor(client, model, metric, days, detect) {
  return detectSteps(days, detect).map((c) => {
    const at = days.findIndex((d) => d.day === c.date);
    const day = days[at];
    const prev = days[at - 1];
    const earlier = new Set(days.slice(0, at).map((d) => d.version));
    const versionChanged = !!prev && day.version !== prev.version && !earlier.has(day.version);
    const s = {
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
      sentence: ""
    };
    s.consistentWith = interpret(s);
    s.sentence = describe(s);
    return s;
  });
}
function reasoningSteps(requests, signals) {
  const versions = versionsByDay(requests);
  const out = [];
  for (const [k, list] of groupBy(reasoned(requests, signals))) {
    const byDay = /* @__PURE__ */ new Map();
    for (const x of list) {
      const vs = byDay.get(x.day) ?? [];
      vs.push(x.reasoning);
      byDay.set(x.day, vs);
    }
    const days = [...byDay].filter(([, vs]) => vs.length >= MIN_DAY_RESPONSES).sort(([a], [b]) => a.localeCompare(b)).map(
      ([day, vs]) => point({ day, value: median(vs), samples: vs.length }, versions.get(k)?.get(day) ?? "")
    );
    out.push(
      ...stepsFor(
        list[0].client,
        list[0].model,
        "reasoning_per_response",
        days,
        "tokens_per_request"
      )
    );
  }
  return out;
}
function turnSteps(requests) {
  return dailySeries(requests).filter((s) => s.model !== "all models").flatMap((s) => stepsFor(s.client, s.model, "tokens_per_turn", s.days, "tokens_per_turn"));
}
function promptSteps(requests) {
  const versions = versionsByDay(requests);
  const out = [];
  for (const [k, list] of groupBy(requests)) {
    const byDay = /* @__PURE__ */ new Map();
    for (const r of list) {
      const day = dayKey(r.ts);
      const acc = byDay.get(day) ?? { max: 0, n: 0 };
      acc.max = Math.max(acc.max, r.input + r.cacheRead + r.cacheWrite);
      acc.n += 1;
      byDay.set(day, acc);
    }
    const days = [...byDay].filter(([, a]) => a.n >= MIN_DAY_RESPONSES).sort(([a], [b]) => a.localeCompare(b)).map(
      ([day, a]) => point({ day, value: a.max, samples: a.n }, versions.get(k)?.get(day) ?? "")
    );
    out.push(
      ...stepsFor(list[0].client, list[0].model, "largest_prompt", days, "tokens_per_request")
    );
  }
  return out;
}
function compactionSteps(requests, compactions) {
  const sessions = bySession(requests.filter((r) => r.client === "claude-code"));
  const lastBefore = (session, ts) => {
    const list = sessions.get(`claude-code\0${session}`);
    if (!list) return void 0;
    let found;
    for (const r of list) {
      if (r.ts > ts) break;
      found = r;
    }
    return found;
  };
  const byModel = /* @__PURE__ */ new Map();
  for (const c of compactions) {
    if (!c.main || c.trigger !== "auto") continue;
    const r = lastBefore(c.session, c.ts);
    if (!r) continue;
    let days = byModel.get(r.model);
    if (!days) byModel.set(r.model, days = /* @__PURE__ */ new Map());
    const day = dayKey(c.ts);
    const acc = days.get(day) ?? { values: [], versions: [] };
    acc.values.push(c.preTokens);
    acc.versions.push(c.version || r.version);
    days.set(day, acc);
  }
  const out = [];
  for (const [model, days] of byModel) {
    const points = [...days].sort(([a], [b]) => a.localeCompare(b)).map(
      ([day, a]) => point({ day, value: median(a.values), samples: a.values.length }, mostCommon(a.versions))
    );
    out.push(...stepsFor("claude-code", model, "compaction_point", points, "tokens_per_request"));
  }
  return out;
}
function interpret(s) {
  const up = s.change > 1;
  const parts = {
    reasoning_per_response: up ? "consistent with a larger reasoning budget or effort for this model, or harder work on your side" : "consistent with a smaller reasoning budget or effort for this model, a change in your effort setting, or easier work on your side",
    tokens_per_turn: up ? "consistent with more requests or larger contexts per task: more tool calls or subagents, or bigger tasks" : "consistent with fewer requests or smaller contexts per task: earlier compaction, fewer subagents, or smaller tasks",
    largest_prompt: up ? "consistent with a higher context ceiling, later compaction, or longer sessions in your own work" : "consistent with a lower context ceiling, earlier compaction, or shorter sessions in your own work",
    compaction_point: up ? "consistent with a higher context ceiling or a later auto-compaction threshold" : "consistent with a lower context ceiling or an earlier auto-compaction threshold"
  };
  const label = CLIENT_LABEL[s.client];
  const version = s.versionChanged ? `It starts with ${label} ${s.version}${s.previousVersion ? ` (previously ${s.previousVersion})` : ""}.` : `There was no ${label} version change that day, so a change in your own work is as likely.`;
  return `${parts[s.metric]}. ${version}`;
}
var fmt = (metric, v) => metric === "reasoning_per_response" ? int(v) : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : int(v);
function describe(s) {
  const where = `${CLIENT_LABEL[s.client]} ${s.version || "(version not recorded)"}`;
  const on = s.versionChanged ? `${where}, the first day on it` : where;
  return `From ${shortDate(s.date)} (${on}), the ${s.label} on ${s.model} ${movement(s.change)} (${fmt(s.metric, s.before)} \u2192 ${fmt(s.metric, s.after)}) \u2014 ${s.consistentWith}`;
}
function windowChanges(requests, windows) {
  const sessions = bySession(requests.filter((r) => r.client === "codex"));
  const nearest = (w) => {
    const list = sessions.get(`codex\0${w.session}`);
    if (!list || list.length === 0) return void 0;
    let best = list[0];
    for (const r of list) if (Math.abs(r.ts - w.ts) < Math.abs(best.ts - w.ts)) best = r;
    return best;
  };
  const byModel = /* @__PURE__ */ new Map();
  for (const w of windows) {
    const r = nearest(w);
    if (!r) continue;
    const list = byModel.get(r.model) ?? [];
    list.push({ w, r });
    byModel.set(r.model, list);
  }
  const codexByModel = /* @__PURE__ */ new Map();
  for (const r of requests) {
    if (r.client !== "codex") continue;
    const list = codexByModel.get(r.model) ?? [];
    list.push(r);
    codexByModel.set(r.model, list);
  }
  const out = [];
  for (const [model, list] of byModel) {
    list.sort((a, b) => a.w.ts - b.w.ts);
    let current = null;
    for (const { w, r } of list) {
      if (w.window === current) continue;
      const date = dayKey(w.ts);
      const earlier = (codexByModel.get(model) ?? []).filter((x) => dayKey(x.ts) < date);
      const firstDayOnVersion = earlier.length > 0 && !earlier.some((x) => x.version === r.version);
      const c = {
        client: "codex",
        model,
        date,
        from: current,
        to: w.window,
        version: r.version,
        firstDayOnVersion,
        sentence: current === null ? `Codex reported a context window of ${int(w.window)} tokens for ${model} from ${shortDate(date)} (Codex ${r.version || "?"}), the first reading in this history.` : `From ${shortDate(date)} (Codex ${r.version || "?"}${firstDayOnVersion ? ", the first day on it" : ""}), Codex reported a context window of ${int(w.window)} tokens for ${model}, ${w.window < current ? "down" : "up"} from ${int(current)}.`
      };
      out.push(c);
      current = w.window;
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));
}
function matchSessions(report, prefix) {
  const p = prefix.trim().toLowerCase();
  return report.sessions.filter((s) => s.session.toLowerCase().startsWith(p));
}
function sessionDetail(input, report, summary) {
  const { signals } = input;
  const list = input.requests.filter((r) => r.client === summary.client && r.session === summary.session).sort((a, b) => a.ts - b.ts);
  const main = list.filter(
    (r) => r.client === "codex" || signals.responses.get(r.id)?.main === true
  );
  const switches = report.switches.filter(
    (s) => s.client === summary.client && s.session === summary.session
  );
  const runs = [];
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
      recorded: last ? sw?.recorded ?? null : null,
      sentence: last ? sw?.sentence ?? null : null
    });
  }
  const reasoning = [...groupBy(reasoned(list, signals)).values()].map((xs) => {
    const sorted = xs.map((x) => x.reasoning).sort((a, b) => a - b);
    return {
      model: xs[0].model,
      responses: xs.length,
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      max: sorted[sorted.length - 1]
    };
  });
  return { summary, runs, reasoning: reasoning.sort((a, b) => b.responses - a.responses) };
}

// src/collect.ts
import { homedir } from "os";
import path2 from "path";
import { load } from "seatledger";

// src/signals.ts
import { createHash } from "crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "fs";
import path from "path";
import { createInterface } from "readline";
import { listSourceFiles } from "seatledger";
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var str = (v) => typeof v === "string" ? v : void 0;
var count = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
var time = (v) => {
  if (typeof v !== "string") return void 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : void 0;
};
async function eachLine(file, wanted, onObject) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (raw.length === 0 || !wanted(raw)) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const o = obj(value);
      if (o) onObject(o);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
var ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function pickedModel(text) {
  const clean = text.replace(ANSI, "");
  const at = clean.indexOf("Set model to");
  if (at < 0) return void 0;
  const rest = clean.slice(at + "Set model to".length, at + "Set model to".length + 120);
  const id = /claude-[a-z0-9][a-z0-9.-]*(?:\[[0-9a-z]+\])?/i.exec(rest)?.[0];
  if (id) return id.toLowerCase();
  const word = /^[\s`*"']*([A-Za-z0-9][\w.-]*)/.exec(rest)?.[1];
  return word ? word.toLowerCase() : void 0;
}
function userText(line) {
  const content = obj(line.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => str(obj(b)?.text) ?? "").filter(Boolean).join("\n");
}
async function readClaudeCodeSignals(file) {
  const byKey = /* @__PURE__ */ new Map();
  const choices = [];
  const fallbacks = [];
  const compactions = [];
  await eachLine(
    file,
    (raw) => raw.includes('"usage"') || raw.includes("Set model to") || raw.includes("allback") || raw.includes("compact_boundary"),
    (line) => {
      const main = line.isSidechain !== true && !str(line.agentId);
      const session = str(line.sessionId) ?? "";
      const ts = time(line.timestamp);
      if (line.type === "assistant") {
        const message = obj(line.message);
        const usage = obj(message?.usage);
        const model = str(message?.model);
        if (!message || !usage || !model || model === "<synthetic>") return;
        const messageId = str(message.id) ?? str(line.uuid);
        if (!messageId) return;
        const key = `${messageId}:${str(line.requestId) ?? ""}`;
        const thinking = count(obj(usage.output_tokens_details)?.thinking_tokens);
        const prev = byKey.get(key);
        byKey.set(key, {
          key,
          // one response is several lines; counts only grow, so keep the largest
          reasoning: thinking === void 0 ? prev?.reasoning ?? null : Math.max(thinking, prev?.reasoning ?? 0),
          main: (prev?.main ?? false) || main
        });
        return;
      }
      if (ts === void 0 || !session) return;
      if (line.type === "user") {
        if (!main) return;
        const text = userText(line);
        if (!text.trimStart().startsWith("<local-command-stdout>")) return;
        const model = pickedModel(text);
        if (model) choices.push({ session, ts, model });
        return;
      }
      if (line.type !== "system") return;
      const subtype = str(line.subtype) ?? "";
      const from = str(line.originalModel);
      const to = str(line.fallbackModel);
      if (/fallback/i.test(subtype) && from && to) {
        fallbacks.push({
          session,
          ts,
          from,
          to,
          trigger: str(line.trigger) ?? "",
          main,
          version: str(line.version) ?? ""
        });
        return;
      }
      if (subtype === "compact_boundary") {
        const meta = obj(line.compactMetadata);
        const preTokens = count(meta?.preTokens);
        if (preTokens === void 0 || preTokens === 0) return;
        compactions.push({
          session,
          ts,
          preTokens,
          trigger: str(meta?.trigger) ?? "",
          main,
          version: str(line.version) ?? ""
        });
      }
    }
  );
  return {
    client: "claude-code",
    responses: [...byKey.values()],
    windows: [],
    choices,
    fallbacks,
    compactions
  };
}
async function readCodexSignals(file) {
  const byKey = /* @__PURE__ */ new Map();
  const windows = [];
  let thread = "";
  let lastWindow = -1;
  await eachLine(
    file,
    (raw) => raw.includes('"token_count"') || raw.includes('"token_usage_record"') || raw.includes('"session_meta"'),
    (line) => {
      const payload = obj(line.payload) ?? {};
      const ts = time(line.timestamp);
      if (line.type === "session_meta") {
        thread = str(payload.id) ?? thread;
        return;
      }
      if (line.type === "token_usage_record") {
        const responseId = str(payload.response_id);
        if (!responseId) return;
        const key2 = `codex:${responseId}`;
        byKey.set(key2, {
          key: key2,
          reasoning: count(obj(payload.usage)?.reasoning_output_tokens) ?? null,
          main: true
        });
        return;
      }
      if (line.type !== "event_msg" || payload.type !== "token_count") return;
      const info = obj(payload.info);
      if (!info) return;
      const window = count(info.model_context_window);
      if (window && ts !== void 0 && window !== lastWindow) {
        windows.push({ session: thread, ts, window });
        lastWindow = window;
      }
      const total = count(obj(info.total_token_usage)?.total_tokens) ?? 0;
      const key = `codex-tc:${str(line.timestamp) ?? ""}:${total}`;
      if (byKey.has(key)) return;
      byKey.set(key, {
        key,
        reasoning: count(obj(info.last_token_usage)?.reasoning_output_tokens) ?? null,
        main: true
      });
    }
  );
  for (const w of windows) if (!w.session) w.session = thread;
  return {
    client: "codex",
    responses: [...byKey.values()],
    windows,
    choices: [],
    fallbacks: [],
    compactions: []
  };
}
var READERS = {
  "claude-code": readClaudeCodeSignals,
  codex: readCodexSignals
};
var SIGNALS_DIR = "signals-v1";
var encode = (e) => ({
  v: 1,
  src: e.src,
  size: e.size,
  mtimeMs: e.mtimeMs,
  client: e.client,
  r: e.responses.map((r) => [r.key, r.reasoning ?? -1, r.main ? 1 : 0]),
  w: e.windows.map((w) => [w.session, w.ts, w.window]),
  c: e.choices.map((c) => [c.session, c.ts, c.model]),
  f: e.fallbacks.map((f) => [f.session, f.ts, f.from, f.to, f.trigger, f.main ? 1 : 0, f.version]),
  k: e.compactions.map((k) => [k.session, k.ts, k.preTokens, k.trigger, k.main ? 1 : 0, k.version])
});
var decode = (w) => ({
  src: w.src,
  size: w.size,
  mtimeMs: w.mtimeMs,
  client: w.client,
  responses: w.r.map(([key, r, m]) => ({ key, reasoning: r < 0 ? null : r, main: m === 1 })),
  windows: w.w.map(([session, ts, window]) => ({ session, ts, window })),
  choices: w.c.map(([session, ts, model]) => ({ session, ts, model })),
  fallbacks: w.f.map(([session, ts, from, to, trigger, main, version]) => ({
    session,
    ts,
    from,
    to,
    trigger,
    main: main === 1,
    version
  })),
  compactions: w.k.map(([session, ts, preTokens, trigger, main, version]) => ({
    session,
    ts,
    preTokens,
    trigger,
    main: main === 1,
    version
  }))
});
function readSignalCache(home) {
  const dir = path.join(home, SIGNALS_DIR);
  const out = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (wire.v !== 1 || typeof wire.src !== "string") continue;
      out.set(wire.src, decode(wire));
    } catch {
    }
  }
  return out;
}
function writeSignalCache(home, entry) {
  const dir = path.join(home, SIGNALS_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    const file = path.join(
      dir,
      createHash("sha256").update(entry.src).digest("hex").slice(0, 32) + ".json"
    );
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 384 });
    renameSync(tmp, file);
  } catch {
  }
}
var under = (file, roots) => roots.some((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
async function loadSignals(opts) {
  const clients = opts.clients ?? ["claude-code", "codex"];
  const useCache = opts.cache ?? true;
  const since = opts.since;
  const cache = useCache ? readSignalCache(opts.home) : /* @__PURE__ */ new Map();
  const files = listSourceFiles(opts.dirs).filter((f) => clients.includes(f.client));
  const onDisk = new Set(files.map((f) => f.path));
  const extracts = [];
  const toRead = [];
  for (const f of files) {
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.client === f.client) {
      extracts.push(hit);
    } else if (since !== void 0 && f.mtimeMs < since) {
      if (hit && hit.client === f.client) extracts.push(hit);
    } else {
      toRead.push(f);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < toRead.length) {
      const f = toRead[next++];
      let extract;
      try {
        extract = await READERS[f.client](f.path);
      } catch {
        continue;
      }
      extracts.push(extract);
      if (useCache)
        writeSignalCache(opts.home, { ...extract, src: f.path, size: f.size, mtimeMs: f.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !clients.includes(entry.client)) continue;
    if (!under(src, opts.dirs[entry.client])) continue;
    extracts.push(entry);
  }
  const responses = /* @__PURE__ */ new Map();
  const keyed = (xs) => {
    const m = /* @__PURE__ */ new Map();
    for (const x of xs) if (since === void 0 || x.ts >= since) m.set(`${x.session}@${x.ts}`, x);
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  };
  const all = {
    windows: [],
    choices: [],
    fallbacks: [],
    compactions: []
  };
  for (const e of extracts) {
    for (const r of e.responses) {
      const prev = responses.get(r.key);
      responses.set(
        r.key,
        prev ? {
          key: r.key,
          reasoning: prev.reasoning === null ? r.reasoning : r.reasoning === null ? prev.reasoning : Math.max(prev.reasoning, r.reasoning),
          main: prev.main || r.main
        } : r
      );
    }
    all.windows.push(...e.windows);
    all.choices.push(...e.choices);
    all.fallbacks.push(...e.fallbacks);
    all.compactions.push(...e.compactions);
  }
  return {
    responses,
    windows: keyed(all.windows),
    choices: keyed(all.choices),
    fallbacks: keyed(all.fallbacks),
    compactions: keyed(all.compactions)
  };
}

// src/collect.ts
function whichModelHome(env = process.env) {
  return env.WHICH_MODEL_HOME ? path2.resolve(env.WHICH_MODEL_HOME) : path2.join(homedir(), ".which-model");
}
async function collect(opts) {
  const loaded = await load({
    dirs: opts.dirs,
    home: opts.home,
    cache: opts.cache ?? true,
    ...opts.since !== void 0 ? { since: opts.since } : {},
    ...opts.clients ? { clients: opts.clients } : {},
    ...opts.onRead ? { onRead: opts.onRead } : {}
  });
  const signals = await loadSignals({
    dirs: opts.dirs,
    home: opts.home,
    cache: opts.cache ?? true,
    ...opts.since !== void 0 ? { since: opts.since } : {},
    ...opts.clients ? { clients: opts.clients } : {}
  });
  return {
    requests: loaded.requests.filter((r) => r.ts <= opts.now),
    signals,
    sources: loaded.sources,
    now: opts.now,
    since: opts.since
  };
}

// src/demo.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path4 from "path";
import { textToSvg as seatledgerSvg } from "seatledger";

// src/install.ts
var ON_NPM = false;
var NAME = "which-model";
var REPO = `https://github.com/agentwares/${NAME}`;
var INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;
var RUN = ON_NPM ? `npx -y ${NAME}@latest` : `npx -y --allow-git=root github:agentwares/${NAME}`;

// src/render.ts
import { CLIENT_LABEL as CLIENT_LABEL2 } from "seatledger";
var int2 = (n) => Math.round(n).toLocaleString("en-US");
var pct = (x) => x > 0 && x < 5e-3 ? "<1%" : `${Math.round(x * 100)}%`;
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayLabel(day) {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${shortDate(day)}`;
}
function when(iso2) {
  const t = new Date(iso2);
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return `${shortDate(day)} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
function wrap(text, first, rest = " ".repeat(first.length), width = 100) {
  const out = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const prefix = out.length === 0 ? first : rest;
    if (line.length > prefix.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = rest + word;
    } else {
      line = line.length > prefix.length ? `${line} ${word}` : `${line}${word}`;
    }
  }
  out.push(line);
  return out;
}
var shortSession = (id) => id.slice(0, 8);
function table(rows, right) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map(
    (r) => r.map((c, i) => right.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])).join("  ").trimEnd()
  );
}
function sourcesLine(sources) {
  const part = (s, noun) => `${int2(s?.files ?? 0)} ${noun}${s?.retained ? ` (+${int2(s.retained)} kept from deleted ones)` : ""}`;
  const cc = sources.find((s) => s.client === "claude-code");
  const cx = sources.find((s) => s.client === "codex");
  return `Read ${part(cc, "Claude Code transcripts")} and ${part(cx, "Codex rollouts")} on this machine. Nothing was sent anywhere.`;
}
function renderReport(report, opts = {}) {
  const out = [];
  out.push("which-model \u2014 which model actually answered, from this machine's transcripts");
  out.push(
    report.since ? `Since ${shortDate(report.since)} ${report.since.slice(0, 4)}` : "All history on this machine"
  );
  out.push("");
  const days = [...new Set(report.days.map((d) => d.day))].slice(0, opts.days ?? 7);
  if (days.length === 0) {
    out.push("No Claude Code or Codex responses found in this range.");
  } else {
    out.push(
      `Models that answered, last ${days.length} active day${days.length === 1 ? "" : "s"} (Codex: the model it requested)`
    );
    for (const day of days) {
      const rows = report.days.filter((d) => d.day === day);
      let first = true;
      for (const client of ["claude-code", "codex"]) {
        const cr = rows.filter((r) => r.client === client);
        if (cr.length === 0) continue;
        const mix = cr.map((r) => `${r.model} ${int2(r.responses)} (${pct(r.share)})`).join(" \xB7 ");
        out.push(
          `  ${(first ? dayLabel(day) : "").padEnd(10)}  ${CLIENT_LABEL2[client].padEnd(11)}  ${mix}`
        );
        first = false;
      }
    }
    out.push("  --json lists every day and every session.");
  }
  out.push("");
  const claude = report.switches.filter((s) => s.client === "claude-code");
  const shown = [
    ...claude.filter((s) => s.recorded === "fallback-notice"),
    ...claude.filter((s) => s.recorded === "nothing")
  ];
  const sessions = new Set(shown.map((s) => s.session));
  out.push(
    `Served-model switches nothing you did explains (Claude Code, main thread): ${shown.length === 0 ? "none" : `${int2(shown.length)} in ${int2(sessions.size)} session${sessions.size === 1 ? "" : "s"}`}`
  );
  for (const s of shown.slice(0, 12)) {
    out.push(
      `  ${when(s.at)}  session ${shortSession(s.session)}  Claude Code ${s.version || "?"}`
    );
    out.push(...wrap(s.sentence, "    "));
  }
  if (shown.length > 12) out.push(`  \u2026 and ${int2(shown.length - 12)} more (--json lists them all)`);
  const picked = claude.filter((s) => s.recorded === "your-model-change").length;
  const relaunch = claude.filter((s) => s.recorded === "client-relaunch").length;
  const notListed = [
    picked > 0 ? `${int2(picked)} after your own /model` : "",
    relaunch > 0 ? `${int2(relaunch)} where the session continued on another client version` : ""
  ].filter(Boolean);
  if (notListed.length > 0) out.push(`  Not listed: ${notListed.join(", ")}.`);
  if (report.servedNotRequested.responses > 0)
    out.push(
      `  Answered by a different model than the one last recorded as requested: ${int2(report.servedNotRequested.responses)} responses in ${int2(report.servedNotRequested.sessions)} session${report.servedNotRequested.sessions === 1 ? "" : "s"}.`
    );
  const codex = report.switches.filter((s) => s.client === "codex").length;
  if (codex > 0)
    out.push(
      `  Codex: ${int2(codex)} change${codex === 1 ? "" : "s"} of the requested model within a thread; its rollouts do not record which model answered.`
    );
  out.push("");
  out.push("Reasoning tokens per response, by model");
  if (report.reasoning.length === 0) {
    out.push("  No responses in this range record their reasoning tokens.");
  } else {
    out.push(...reasoningTable(report.reasoning).map((l) => `  ${l}`));
    for (const r of report.reasoning) {
      for (const s of r.spikes) {
        out.push(
          ...wrap(
            `${CLIENT_LABEL2[r.client]} \xB7 ${r.model}: ${int2(s.responses)} responses (${pct(s.share)}) used exactly ${int2(s.tokens)} reasoning tokens, ${s.ratio >= 100 ? "over 100" : int2(s.ratio)}x as many as the counts within 5% either side, ${shortDate(s.firstDay)}\u2013${shortDate(s.lastDay)}${s.versions.length ? ` (${s.versions.slice(0, 3).join(", ")}${s.versions.length > 3 ? ", \u2026" : ""})` : ""} \u2014 consistent with a cap or budget at that value; it cannot show whether the reasoning was cut short.`,
            "  \u2022 "
          )
        );
      }
    }
  }
  out.push("");
  out.push("Step changes (seatledger's rolling baseline)");
  if (report.steps.length === 0) {
    out.push(
      "  None: no step of at least 30% that held for several days in reasoning tokens per response,",
      "  tokens per task, the largest prompt of the day or the auto-compaction point."
    );
  } else {
    for (const s of report.steps.slice(0, 10)) out.push(...wrap(s.sentence, "  \u2022 "));
    if (report.steps.length > 10)
      out.push(`  \u2026 and ${int2(report.steps.length - 10)} more (--json lists them all)`);
  }
  if (report.windows.length > 0) {
    out.push("");
    out.push("Context window, as Codex reported it");
    for (const w of report.windows) out.push(...wrap(w.sentence, "  \u2022 "));
  }
  out.push("");
  for (const n of report.notes) out.push(...wrap(n, ""));
  out.push(...wrap(sourcesLine(report.sources), ""));
  return out.join("\n");
}
function reasoningTable(stats) {
  const rows = [
    ["model", "responses", "zero", "median", "p90", "p99", "max", "spikes"],
    ...stats.map((r) => [
      `${CLIENT_LABEL2[r.client]} \xB7 ${r.model}`,
      int2(r.responses),
      pct(r.zeroShare),
      int2(r.p50),
      int2(r.p90),
      int2(r.p99),
      int2(r.max),
      r.spikes.length === 0 ? "none" : r.spikes.map((s) => `${int2(s.tokens)} (${pct(s.share)})`).join(", ")
    ])
  ];
  return table(rows, /* @__PURE__ */ new Set([1, 2, 3, 4, 5, 6]));
}
function renderSession(d) {
  const s = d.summary;
  const out = [];
  out.push(
    `Session ${s.session} (${CLIENT_LABEL2[s.client]}), ${when(s.first)} \u2013 ${when(s.last)}, ${s.versions.length ? `version${s.versions.length === 1 ? "" : "s"} ${s.versions.join(", ")}` : "version not recorded"}`
  );
  out.push(
    s.client === "codex" ? "Responses in order, by the model Codex requested:" : "Main thread, in order:"
  );
  const rows = d.runs.map((r) => [
    when(r.from),
    r.model,
    `${int2(r.responses)} response${r.responses === 1 ? "" : "s"}`
  ]);
  if (rows.length > 0) out.push(...table(rows, /* @__PURE__ */ new Set([2])).map((l) => `  ${l}`));
  for (const r of d.runs)
    if (r.sentence) out.push(...wrap(`${when(r.from)}: ${r.sentence}`, "  ", "    "));
  if (s.subagentModels.length > 0)
    out.push(
      `Subagents: ${s.subagentModels.map((m) => `${m.model} ${int2(m.responses)}`).join(" \xB7 ")}`
    );
  if (s.servedNotRequested > 0)
    out.push(
      `Answered by a different model than the one last recorded as requested: ${int2(s.servedNotRequested)} responses.`
    );
  if (d.reasoning.length > 0) {
    out.push("Reasoning tokens per response in this session:");
    for (const r of d.reasoning)
      out.push(
        `  ${r.model}: ${int2(r.responses)} responses, median ${int2(r.p50)}, p90 ${int2(r.p90)}, max ${int2(r.max)}`
      );
  }
  return out.join("\n");
}

// src/synthetic.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "fs";
import path3 from "path";
var DAY = 864e5;
var MIN = 6e4;
var SYNTHETIC_NOW = Date.parse("2026-10-07T14:00:00Z");
var START = Date.parse("2026-07-01T00:00:00Z");
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var iso = (t) => new Date(t).toISOString();
function writeSyntheticHistory(dir) {
  const rand = rng(20260708);
  const int3 = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));
  const around = (median2, spread = 0.8) => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(median2 * Math.exp(z * spread)));
  };
  const hex = (n) => Array.from({ length: n }, () => int3(0, 15).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  const claudeDir = path3.join(dir, "claude", "projects");
  const codexDir = path3.join(dir, "codex", "sessions");
  const cwd = "/home/dev/demo-app";
  const project = path3.join(claudeDir, "-home-dev-demo-app");
  mkdirSync2(project, { recursive: true });
  const ccVersion = (t) => t < Date.parse("2026-08-01T00:00:00Z") ? "2.1.197" : t < Date.parse("2026-09-15T00:00:00Z") ? "2.1.229" : "2.1.270";
  for (let day = START; day <= SYNTHETIC_NOW; day += DAY) {
    const session = uuid();
    const lines = [];
    const fallbackDay = iso(day).startsWith("2026-07-16");
    const pickDay = iso(day).startsWith("2026-08-25");
    let t = day + (fallbackDay ? 2 * 60 * MIN : 9 * 60 * MIN);
    let model = day < Date.parse("2026-09-01T00:00:00Z") ? "claude-fable-5" : "claude-fable-5-1";
    const total = fallbackDay ? 330 : 32;
    let context = 2e4;
    const base = (ts, extra) => JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId: session,
      version: ccVersion(ts),
      gitBranch: "main",
      uuid: uuid(),
      timestamp: iso(ts),
      ...extra
    });
    for (let i = 0; i < total; i++) {
      if (t > SYNTHETIC_NOW - 60 * MIN) break;
      if (i % 4 === 0)
        lines.push(
          base(t - 2e4, {
            type: "user",
            origin: { kind: "human" },
            message: { role: "user", content: "(synthetic prompt)" }
          })
        );
      if (fallbackDay && i === 10) {
        lines.push(
          base(t - 5e3, {
            type: "system",
            subtype: "model_refusal_fallback",
            level: "warning",
            content: "(synthetic notice)",
            isMeta: false,
            originalModel: "claude-fable-5",
            fallbackModel: "claude-opus-4-8",
            trigger: "refusal",
            direction: "retry",
            requestId: `req_${hex(24)}`
          })
        );
        model = "claude-opus-4-8";
      }
      if (fallbackDay && i === 318) model = "claude-fable-5";
      if (pickDay && i === 16) {
        lines.push(
          base(t - 1e4, {
            type: "user",
            message: {
              role: "user",
              content: "<local-command-stdout>Set model to claude-opus-5</local-command-stdout>"
            }
          })
        );
        model = "claude-opus-5";
      }
      context = i % 12 === 11 ? 3e4 : context + int3(8e3, 3e4);
      const thinking = model === "claude-opus-4-8" ? around(300) : model === "claude-opus-5" ? around(350) : around(450);
      lines.push(
        base(t, {
          type: "assistant",
          requestId: `req_${hex(24)}`,
          message: {
            id: `msg_${hex(24)}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: "tool_use",
            usage: {
              input_tokens: int3(2, 40),
              cache_creation_input_tokens: int3(500, 4e3),
              cache_read_input_tokens: context,
              output_tokens: thinking + int3(50, 900),
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: int3(500, 4e3)
              },
              output_tokens_details: { thinking_tokens: thinking },
              service_tier: "standard",
              speed: "standard"
            }
          }
        })
      );
      if (i === 20 && !fallbackDay && iso(day) < "2026-10-07" && rand() < 0.25)
        lines.push(
          base(t + 1e3, {
            type: "system",
            subtype: "compact_boundary",
            level: "info",
            compactMetadata: {
              trigger: "auto",
              preTokens: int3(985e3, 1002e3),
              postTokens: 4e4
            }
          })
        );
      t += (fallbackDay ? 4.2 : int3(5, 12)) * MIN;
    }
    if (lines.length === 0) continue;
    writeFileSync2(path3.join(project, `${session}.jsonl`), lines.join("\n") + "\n");
    if (rand() < 0.4) {
      const agentId = hex(16);
      const subDir = path3.join(project, session, "subagents");
      mkdirSync2(subDir, { recursive: true });
      const sub = [];
      let st = day + 10 * 60 * MIN;
      for (let i = 0; i < 6 && st < SYNTHETIC_NOW - 60 * MIN; i++, st += 2 * MIN)
        sub.push(
          JSON.stringify({
            isSidechain: true,
            agentId,
            cwd,
            sessionId: session,
            version: ccVersion(st),
            uuid: uuid(),
            timestamp: iso(st),
            type: "assistant",
            requestId: `req_${hex(24)}`,
            message: {
              id: `msg_${hex(24)}`,
              model: "claude-haiku-4-5-20251001",
              role: "assistant",
              content: [],
              usage: {
                input_tokens: int3(5, 50),
                cache_creation_input_tokens: int3(1e3, 6e3),
                cache_read_input_tokens: int3(5e3, 3e4),
                output_tokens: int3(100, 800),
                output_tokens_details: { thinking_tokens: around(120) }
              }
            }
          })
        );
      if (sub.length > 0)
        writeFileSync2(path3.join(subDir, `agent-${agentId}.jsonl`), sub.join("\n") + "\n");
    }
  }
  const cut = Date.parse("2026-07-13T00:00:00Z");
  const rollout = (day, model, startHour, responses) => {
    const thread = uuid();
    const start = day + startHour * 60 * MIN;
    if (start > SYNTHETIC_NOW - 2 * 60 * MIN) return;
    const d = new Date(day);
    const folder = path3.join(
      codexDir,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0")
    );
    mkdirSync2(folder, { recursive: true });
    const cli = model === "gpt-5.6-sol" ? day < cut ? "0.144.2" : "0.144.3" : "0.144.3";
    const window = model === "gpt-5.6-sol" && day < cut ? 353400 : 258400;
    const lines = [
      JSON.stringify({
        timestamp: iso(start),
        type: "session_meta",
        payload: {
          id: thread,
          timestamp: iso(start),
          cwd,
          originator: "codex_cli_rs",
          cli_version: cli,
          model_provider: "openai"
        }
      })
    ];
    let total = 0;
    let t = start;
    for (let i = 0; i < responses; i++) {
      if (i % 4 === 0)
        lines.push(
          JSON.stringify({
            timestamp: iso(t - 1e3),
            type: "turn_context",
            payload: { turn_id: uuid(), cwd, model, effort: "medium" }
          })
        );
      const ceiling = window * 0.97;
      const prompt = Math.min(ceiling, int3(4e4, 8e4) + i % 10 * int3(3e4, 4e4));
      const cached = Math.round(prompt * 0.85);
      const r = rand();
      const reasoning = model === "gpt-5.5" ? r < 0.45 ? 516 : r < 0.53 ? 1034 : around(380, 0.9) : around(260, 0.9);
      const output = reasoning + int3(40, 700);
      total += prompt + output;
      lines.push(
        JSON.stringify({
          timestamp: iso(t),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: total,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: total
              },
              last_token_usage: {
                input_tokens: Math.round(prompt),
                cached_input_tokens: cached,
                cache_write_input_tokens: 0,
                output_tokens: output,
                reasoning_output_tokens: reasoning,
                total_tokens: Math.round(prompt) + output
              },
              model_context_window: window
            },
            rate_limits: null
          }
        })
      );
      t += int3(2, 6) * MIN;
    }
    writeFileSync2(
      path3.join(folder, `rollout-${iso(start).slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`),
      lines.join("\n") + "\n"
    );
  };
  for (let day = START; day <= SYNTHETIC_NOW; day += DAY) {
    rollout(day, "gpt-5.6-sol", 13, 28);
    if (day < Date.parse("2026-09-01T00:00:00Z") && new Date(day).getUTCDay() % 2 === 1)
      rollout(day, "gpt-5.5", 15, 24);
  }
  return { claudeDir, codexDir, now: SYNTHETIC_NOW };
}

// src/demo.ts
async function runDemo() {
  const dir = mkdtempSync(path4.join(tmpdir(), "which-model-demo-"));
  try {
    const synth = writeSyntheticHistory(dir);
    const input = await collect({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      home: path4.join(dir, "home"),
      now: synth.now,
      cache: false
    });
    const report = analyze(input);
    return { input, report, text: renderReport(report), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function screenshotText(demo) {
  return [`$ ${INSTALL}`, demo.text].join("\n").trimEnd();
}
function textToSvg(text) {
  return seatledgerSvg(text).replace(
    'aria-label="seatledger output on synthetic history"',
    'aria-label="which-model output on synthetic history"'
  );
}

// src/hint.ts
import { existsSync, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync3 } from "fs";
import path5 from "path";
import { dayKey as dayKey2 } from "seatledger";
var TEAM_LEDGER_URL = "https://agentwares-agentcheck.vercel.app/seatledger?ref=which-model";
var HINT = `Your whole team's model mix, by model and by day, in one ledger (seatledger, free for up to 3 developers): ${TEAM_LEDGER_URL}`;
export {
  HINT,
  METHOD,
  MIN_SPIKE_TOKENS,
  SPIKE_RATIO,
  STEP_LABEL,
  STEP_METRICS,
  SYNTHETIC_NOW,
  TEAM_LEDGER_URL,
  analyze,
  baseModel,
  collect,
  differentModel,
  findSpikes,
  loadSignals,
  matchSessions,
  pickedModel,
  readClaudeCodeSignals,
  readCodexSignals,
  renderReport,
  renderSession,
  runDemo,
  screenshotText,
  sessionDetail,
  textToSvg,
  whichModelHome,
  writeSyntheticHistory
};
//# sourceMappingURL=index.js.map