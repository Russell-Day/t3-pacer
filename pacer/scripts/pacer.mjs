#!/usr/bin/env node
// The pacer: a queue of Claude threads in T3 Code that spends the Claude 5 h session window
// evenly. It paces every main Claude thread, the user's own included. Queued threads are
// snoozed in T3; every 5 min `tick` compares usage with the pace line (100% at 5 h) and
// wakes the next queued thread, or asks an active thread to pause at its next stopping
// point. At the start of each window it can also start a triage thread (config.json "triage").
// No model calls. Every decision goes to log.jsonl.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asksLine, readQuestions } from "./lib/questions.mjs";
import { configFile, local, readConfigFile, stateDir } from "./lib/settings.mjs";
import { compactionCount, createMainThread, createThread, currentThread, getThread, isWorker, listThreads, mainModelSelection, pinThread, projectFor, runReplies, sendMessage, settleThread, snoozeThread, t3Command, t3Query, unpinThread, unsnoozeThread } from "./lib/t3-api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const usageScript = path.join(here, "lib/usage.mjs");
const queueFile = path.join(stateDir, "queue.json");
const queueLock = path.join(stateDir, "queue.lock");
const logFile = path.join(stateDir, "log.jsonl");
const emergencyFile = path.join(stateDir, "emergency.json");
const reportFile = path.join(stateDir, "report.json");
const MIN = 60000;
const WINDOW_MS = 5 * 60 * MIN;
const SNOOZE_MS = 7 * 24 * 60 * MIN;
// "Active": a turn running or finished in the last 20 min, or woken by the pacer in the last 10.
const RECENT_TURN_MS = 20 * MIN;
const WAKE_GRACE_MS = 10 * MIN;
// By day, at this much used the window is nearly spent: at most one wake per window, and only
// with nothing working, so one start may hit the limit but no burst does.
// Night windows have no such cap: they are meant to be spent in full.
const SPENT = 95;
// A thread the user wrote in this recently is never asked to pause.
const USER_RECENT_MS = 10 * MIN;
const LOCK_STALE_MS = 2 * MIN;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// The user's time zone
// ---------------------------------------------------------------------------

// config.json "timeZone" (an IANA name), else the system's. Every wall-clock rule meaning the
// user's day (night window, the noon cap, labels, the report time) follows it; usage resets stay
// instants. A bad zone = the system zone plus one log line per process.
export const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
let zoneWarned = false;
export function userZone({ zone = rawConfig().timeZone, warn = (msg) => log("zone-error", { error: msg }) } = {}) {
  if (zone == null) return SYSTEM_ZONE;
  try {
    if (typeof zone !== "string" || !zone) throw new Error("not a zone name");
    new Intl.DateTimeFormat("en-US", { timeZone: zone }); // throws on an unknown zone
    return zone;
  } catch (e) {
    if (!zoneWarned) { zoneWarned = true; try { warn(`bad timeZone ${JSON.stringify(zone)} in config.json: ${e.message}; using ${SYSTEM_ZONE}`); } catch {} }
    return SYSTEM_ZONE;
  }
}
// config.json as written, {} when missing or unreadable (readConfig reports a broken file).
function rawConfig() {
  try { return readConfigFile(); } catch { return {}; }
}

// Wall clock in `zone` at instant `ms`: { day: "YYYY-MM-DD", h, m }.
export function wallClock(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24, m: Number(p.minute) };
}
// The instant of wall time `h:m` on `day` (YYYY-MM-DD) in `zone`.
export function zonedTime(day, h, m, zone) {
  const want = Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * MIN;
  let t = want;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(t, zone);
    t += want - (Date.parse(`${w.day}T00:00:00Z`) + (w.h * 60 + w.m) * MIN);
  }
  return t;
}
// `--until`: an ISO time, `+90m` / `+2h`, or `HH:MM` the user's time (the next one, today or tomorrow).
export function untilTime(text, now = Date.now(), zone = userZone()) {
  const v = String(text ?? "").trim();
  let m = /^\+(\d+(?:\.\d+)?)\s*([mh])$/i.exec(v);
  if (m) return new Date(now + Number(m[1]) * (m[2].toLowerCase() === "h" ? 60 : 1) * MIN).toISOString();
  m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) {
    const today = wallClock(now, zone).day;
    let t = zonedTime(today, Number(m[1]), Number(m[2]), zone);
    if (t <= now) t = zonedTime(wallClock(t + 24 * 60 * MIN, zone).day, Number(m[1]), Number(m[2]), zone);
    return new Date(t).toISOString();
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--until is an ISO time, +90m / +2h, or HH:MM (got "${v}")`);
  return new Date(t).toISOString();
}
// A queue entry paused with --until isn't woken before that time.
export const waitingUntil = (e, now = Date.now()) => Date.parse(e?.notBefore ?? "") > now;

// A time label in the user's zone (Intl options as for toLocaleString).
export const zoneLabel = (iso, opts, zone = userZone()) => new Date(iso).toLocaleString("en-US", { ...opts, timeZone: zone });

// ---------------------------------------------------------------------------
// Pure rules (unit-tested in pacer.test.mjs)
// ---------------------------------------------------------------------------

// config.json keys, with these defaults when absent.
export const DEFAULTS = {
  night: { resetFrom: "00:00", resetTo: "10:00" }, // local reset times that make a night window
  dayFinishMin: 10, // a day window's pace line reaches 100% this long before the reset (legroom)
  nightFinishMin: 30, // a night window's pace line reaches 100% this long before the reset
  priorityWeights: { highest: 8, high: 4, med: 2, low: 1 },
  ageDays: 7, // the age factor (1 + days waiting / ageDays) doubles the score every ageDays
  pausedFactor: 1.5, // started work resumes before fresh work of its level
  nearTie: 0.8, // within this share of the best score, size breaks the tie
  // A lead (a thread with a pacer plan entry) at this many compactions hands off to a fresh thread.
  handoffCompactions: 3,
  // Wake while fewer than this many working-model threads are working and usage is at or under
  // pace; past it only at pace − tol. The cap never pauses anything.
  maxWorking: 6,
  // The models that count toward maxWorking: case-insensitive patterns matched against a Claude
  // thread's model id. Lighter models (e.g. Haiku helpers) burn little and don't count.
  workingModels: ["opus"],
  // When the morning report is due (the user's time zone), for `report --morning`.
  reportAt: "07:00",
};
export function settings(raw = {}) {
  return { ...DEFAULTS, ...raw, night: { ...DEFAULTS.night, ...raw.night }, priorityWeights: { ...DEFAULTS.priorityWeights, ...raw.priorityWeights } };
}

// A night window resets between night.resetFrom and night.resetTo, the user's local time, both
// ends included (the range may wrap midnight). With the defaults that is a window starting
// between about 19:00 and 05:00: the user is offline overnight, so whatever is left at its reset is lost.
export function nightWindow(resetsAt, cfg = DEFAULTS, zone = userZone()) {
  if (!resetsAt) return false;
  const clock = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); };
  const w = wallClock(Date.parse(resetsAt), zone);
  const t = w.h * 60 + w.m;
  const from = clock(cfg.night.resetFrom), to = clock(cfg.night.resetTo);
  return from <= to ? t >= from && t <= to : t >= from || t <= to;
}

// Sleep file (config.json `sleepFile`, written by whatever tells the pacer the user went to bed):
//   {"day", "bedtime_at", "night_until", "wake_at", "updated_at"} (UTC ISO times; bedtime_at
//   and wake_at may be null). parseSleep throws on anything else; the tick then uses the clock.
export function parseSleep(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
  const time = (k, required) => {
    if (raw[k] == null) { if (required) throw new Error(`${k} is missing`); return; }
    if (typeof raw[k] !== "string" || !Number.isFinite(Date.parse(raw[k]))) throw new Error(`${k} is not a time: ${JSON.stringify(raw[k]).slice(0, 40)}`);
  };
  time("bedtime_at", false);
  if (raw.bedtime_at != null) time("night_until", true);
  time("wake_at", false);
  return raw;
}

// Coding night = now in [bedtime_at, night_until): the current window counts as night.
// Asleep = now ≥ bedtime_at, wake_at null, and before 12:00 the user's time on the morning
// night_until falls on (a missed wake never leaves them asleep all day). `note` says why the
// clock rules apply (no sleepFile, missing or garbled file, no bedtime tonight).
export function sleepState(raw, now = Date.now(), note = null, zone = userZone()) {
  const base = { label: "awake", asleep: false, night: false, bedtimeAt: null, nightUntil: null, wakeAt: null, noon: null, day: raw?.day ?? null, note };
  if (!raw) return base;
  if (raw.bedtime_at == null) return { ...base, wakeAt: raw.wake_at ?? null, note: note ?? "no bedtime tonight" };
  const bed = Date.parse(raw.bedtime_at), until = Date.parse(raw.night_until);
  // (never before night_until.)
  const noonDate = new Date(zonedTime(wallClock(until, zone).day, 12, 0, zone));
  if (noonDate.getTime() < until) noonDate.setTime(until);
  const noon = noonDate.getTime();
  const asleep = now >= bed && raw.wake_at == null && now < noon;
  const night = now >= bed && now < until;
  return { ...base, label: asleep ? "asleep" : night ? "night" : "awake", asleep, night,
    bedtimeAt: raw.bedtime_at, nightUntil: raw.night_until, wakeAt: raw.wake_at ?? null, noon: noonDate.toISOString() };
}

// What `sleep` prints and `status` shows: the label first, then the times (the user's zone).
export function sleepLine(s, zone = userZone()) {
  const hm = (iso) => zoneLabel(iso, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, zone);
  if (!s.bedtimeAt) return `awake (${s.note ?? "no bedtime tonight"}: clock rules)`;
  const times = `bedtime ${hm(s.bedtimeAt)}, coding night until ${hm(s.nightUntil)}`;
  if (s.asleep) return `asleep (${times}; asleep until the sleep file records a wake, at the latest ${hm(s.noon)})`;
  const woke = s.wakeAt ? `woke ${hm(s.wakeAt)}` : `not asleep (before bedtime, or past ${hm(s.noon)})`;
  return `${s.label} (${times}; ${woke}${s.night ? "" : "; clock rules"})`;
}

export const ASLEEP_LINE = "The user is asleep: don't end the turn on a question while another stage can move; write the question into the plan's Questions section, carry on, and end with it only when nothing else can move.";

export const digestText = (titles) => [`**Good morning: ${titles.length} thread${titles.length === 1 ? " has" : "s have"} questions for you**`, ...titles.map((t) => `- ${t}`)].join("\n");

// One sleep step per tick. prev = state.sleep ({ key, label, digestDay }). A change of state
// (label, note or bedtime) is logged once. When the file shows a wake for the current night
// (bedtime_at set, bedtime_at ≤ wake_at ≤ now, bedtime under 24 h ago) the tick posts the
// "Waiting on the user" list as the wake digest (only if N > 0; logged either way), once per
// night (digestDay). It doesn't need an earlier tick to have seen them asleep, so a bedtime and a
// wake between two ticks, or a garbled read in between, still post. An asleep that ends at
// noon (no wake_at) posts nothing. deps: waiting() → titles; post(md); log(event, fields).
export const wokeTonight = (sleep, now = Date.now()) => {
  if (!sleep?.bedtimeAt || !sleep.wakeAt) return false;
  const bed = Date.parse(sleep.bedtimeAt), woke = Date.parse(sleep.wakeAt);
  return bed <= woke && woke <= now && now - bed < 24 * 3600_000;
};

export async function sleepTick({ state, sleep, deps, dryRun = false, now = Date.now() }) {
  const prev = state.sleep ?? {};
  const say = [];
  const key = `${sleep.label}|${sleep.note ?? ""}|${sleep.bedtimeAt ?? ""}`;
  let next = { ...prev, key, label: sleep.label };
  if (key !== prev.key) {
    const fields = { state: sleep.label, bedtimeAt: sleep.bedtimeAt, nightUntil: sleep.nightUntil, wakeAt: sleep.wakeAt, note: sleep.note, why: sleepLine(sleep) };
    if (!dryRun) deps.log("sleep", fields);
    say.push(`${dryRun ? "would log " : ""}sleep: ${fields.why}`);
  }
  const night = sleep.day ?? sleep.bedtimeAt;
  if (wokeTonight(sleep, now) && prev.digestDay !== night) {
    const titles = deps.waiting();
    if (dryRun) say.push(titles.length ? `would post the wake digest (${titles.length} waiting on the user)` : "would log wake-digest: nothing waiting on the user, no post");
    else {
      let posted = false, error = null;
      if (titles.length) { try { deps.post(digestText(titles)); posted = true; } catch (e) { error = e.message; } }
      deps.log("wake-digest", { count: titles.length, posted, ...(error ? { error } : {}), why: titles.length ? (posted ? `posted ${titles.length} waiting on the user` : `post failed: ${error}`) : "nothing waiting on the user, no post" });
      say.push(`wake digest: ${titles.length} waiting${posted ? ", posted" : error ? `, post failed: ${error}` : ", no post"}`);
    }
    next = { ...next, digestDay: night };
  }
  return { state: dryRun ? state : { ...state, sleep: next }, say };
}

// pace = where usage should be if the window is spent evenly: 100% dayFinishMin before the reset
// by day, nightFinishMin before it at night (capped at 100). No open window: 0/0, day.
// codingNight (the sleep file's bedtime → night_until) makes any window a night window.
export function paceOf(window, now = Date.now(), cfg = DEFAULTS, { codingNight = false } = {}) {
  if (!window?.resetsAt || Date.parse(window.resetsAt) <= now) return { used: 0, pace: 0, windowId: null, night: codingNight };
  const elapsed = Math.min(WINDOW_MS, Math.max(0, WINDOW_MS - (Date.parse(window.resetsAt) - now)));
  // resetsAt jitters by a second between probes; the id is the reset rounded to 10 min.
  const windowId = new Date(Math.round(Date.parse(window.resetsAt) / (10 * MIN)) * 10 * MIN).toISOString();
  const night = codingNight || nightWindow(window.resetsAt, cfg);
  const span = WINDOW_MS - (night ? cfg.nightFinishMin : cfg.dayFinishMin) * MIN;
  return { used: window.usedPercent, pace: Math.min(100, Math.round(1000 * elapsed / span) / 10), windowId, night };
}

// A one-window cap (`cap --add N`, "give me around 10% this cycle"):
// a second line from the usage when it was set to that + N at the pace line's finish; the pace is
// the lower of the two. It belongs to one window and lapses at the reset.
export function capPace(p, cap, resetsAt, now = Date.now(), cfg = DEFAULTS) {
  if (!cap || !p.windowId || cap.windowId !== p.windowId) return p;
  const end = Date.parse(resetsAt) - (p.night ? cfg.nightFinishMin : cfg.dayFinishMin) * MIN;
  const setAt = Date.parse(cap.setAt);
  const frac = end > setAt ? Math.min(1, Math.max(0, (now - setAt) / (end - setAt))) : 1;
  const line = Math.round(10 * (cap.from + cap.add * frac)) / 10;
  return { ...p, pace: Math.min(p.pace, line), capTo: cap.from + cap.add };
}

// The band around the pace line narrows as the window is used up: ±10 with the window
// untouched, linearly down to ±5 at 10% left (and ±5 below that). Day and night share it (each
// keeps its own pace line). Ask a ready thread to pause at > pace + tol.
export function band(used) {
  const remaining = 100 - used;
  return 5 + 5 * Math.min(1, Math.max(0, (remaining - 10) / 90));
}
const fmt = (x) => String(Math.round(10 * x) / 10);
// Give usage time to show before acting again. After any wake (resumes
// included), the next wake with something working waits 10 min; at night the pause line is
// pace + 1.2 tol and, after an ask or a pause, the next ask waits 10 min to see whether it helped.
export const SETTLE_MS = 10 * 60000;
export const NIGHT_ASK_FACTOR = 1.2;
// The wake rule: with nothing
// working, wake one; else wake when used ≤ pace and fewer than maxWorking are working; past the
// cap only at used ≤ pace − tol.
export const wakeRule = (tol, cap = DEFAULTS.maxWorking) => `0 working: wake; < ${cap} working: ≤ pace; ${cap}+ working: ≤ pace−${fmt(tol)}`;
const bandText = (tol) => `±${fmt(tol)}`;
export const paceLine = (night, cfg = DEFAULTS) => (night ? `night: 100% at ${cfg.nightFinishMin} min before the reset` : `day: 100% at ${cfg.dayFinishMin} min before the reset`);

// What a tick does with a queued thread. One waiting on the user (a pending native request, or
// an idle thread with an open question) is handed back: out of the queue and unsnoozed, so the
// question stays in their list. Otherwise it must stay snoozed; something else may unsnooze it
// (a T3 client can), so it is snoozed again. The user writing in it ("ok can we snooze?") hands
// it back only if the reply leaves something with them (a question, or a pending request); a
// reply that asks nothing keeps it queued and re-snoozed. A running turn, or the user's message
// with no reply yet, waits a tick. A thread that took itself out (`remove`/`wake`) is no longer
// queued, so it never gets here.
export function queuedAction({ snoozed, running, pending, asks, userWrote, answered = true }) {
  if (pending) return { handBack: "waiting on the user", unsnooze: !!snoozed };
  if (running) return snoozed ? null : { wait: "turn running; re-snoozes after it" };
  if (userWrote && !answered) return snoozed ? null : { wait: "the user's message has no reply yet" };
  if (asks) return { handBack: "waiting on the user", unsnooze: !!snoozed };
  if (snoozed) return null;
  return { resnooze: userWrote ? "the user wrote in it while queued and the reply asks nothing; still queued"
    : "queued but not snoozed, and the user hasn't written in it since it was queued" };
}

// What a queue (or woken) entry the pacer drops leaves on the thread's ready entry: its queue
// fields, so a later `enqueue` or `pause` keeps its priority, size and age (not med, age 0 h). `why` says why it left, when not a question.
export function handedBackRecord(entry, at, why = null) {
  return { at, priority: entry.priority ?? null, size: entry.size ?? null, firstQueuedAt: entry.firstQueuedAt ?? entry.enqueuedAt ?? null,
    pauses: entry.pauses ?? 0, note: entry.note ?? null, plan: entry.plan ?? null, ...(why ? { why } : {}) };
}

// `ready` with `handedBack` set for `id` (made from the entry when the thread had no ready entry).
export function withHandedBack(ready, id, entry, at, why = null) {
  const base = ready?.[id] ?? { plan: entry.plan, title: entry.title ?? null, readyAt: at };
  return { ...(ready ?? {}), [id]: { ...base, handedBack: handedBackRecord(entry, at, why) } };
}

// Hand a queued thread back to the user: unsnooze it (when snoozed), then drop its entry. Its
// ready entry keeps `handedBack` (handedBackRecord) so a later `ready` can say it is no longer
// queued and give the `enqueue` that puts it back (a thread that runs only `ready` after the
// answers would otherwise sit unqueued), and that enqueue or a `pause` keeps its place. Any failure keeps the entry, marked `handbackFailed` (status and the report show it),
// and the next tick retries; the waiting filter keeps it from being woken meanwhile.
export async function handBackEntry(state, threadId, { snoozed, unsnooze, now = new Date().toISOString() }) {
  const errors = [];
  if (snoozed) { try { await unsnooze(threadId); } catch (e) { errors.push(`unsnooze: ${e.message}`); } }
  if (!errors.length) {
    const old = state.queue.find((e) => e.threadId === threadId);
    const ready = old ? withHandedBack(state.ready, threadId, old, now) : state.ready;
    return { ok: true, state: { ...state, queue: state.queue.filter((e) => e.threadId !== threadId), ...(ready ? { ready } : {}) } };
  }
  const error = errors.join("; ");
  return { ok: false, error, state: { ...state, queue: state.queue.map((e) => e.threadId === threadId ? { ...e, handbackFailed: { at: now, error } } : e) } };
}

// The deferred snooze (T3 refused it while a turn start was queued) rechecks, inside the lock,
// everything enqueue checked: the entry, the thread, the user writing, and now whether the turn
// that just ended left a question for them (then it is handed back, never snoozed).
// `wrote`: the user wrote in it since `since` (agents' messages don't count, as in userWrote).
export function deferredSnoozeAction({ entry, enqueuedAt, info, pending, asks, wrote = false }) {
  if (!entry || entry.enqueuedAt !== enqueuedAt) return { skip: entry ? "re-queued since; that enqueue snoozes it" : "no longer queued" };
  if (gone(info)) return { skip: `thread ${gone(info)}` };
  if (limitPaused(info)) return { skip: `paused by the usage limit; T3 holds it until ${info.usage_limit_reset_at} and resumes it` };
  if (wrote) return { handoff: "the user wrote in it before the snooze landed; left awake and out of the queue" };
  if (pending || asks) return { handBack: "waiting on the user" };
  return { snooze: true };
}

// One try of the deferred snooze. Returns the new state and whether the helper can stop.
export async function deferredSnoozeStep({ state, id, enqueuedAt, info, pending, asks, wrote, deps, now = new Date().toISOString() }) {
  const entry = state.queue.find((e) => e.threadId === id);
  const act = deferredSnoozeAction({ entry, enqueuedAt, info, pending, asks, wrote });
  const title = (info?.title ?? "").slice(0, 60);
  if (act.skip) { deps.log("snooze-skipped", { threadId: id, why: act.skip }); return { done: true, state }; }
  if (act.handoff) {
    deps.log("handoff", { threadId: id, title, plan: entry.plan, why: act.handoff });
    return { done: true, state: { ...state, queue: state.queue.filter((e) => e.threadId !== id),
      ready: withHandedBack(state.ready, id, entry, now, "the user wrote in it before the snooze landed") } };
  }
  if (act.handBack) {
    const r = await handBackEntry(state, id, { snoozed: snoozeSet(info), unsnooze: deps.unsnooze, now });
    if (r.ok) deps.log("handoff", { threadId: id, title, plan: entry.plan, why: `${act.handBack} (before the deferred snooze)` });
    else deps.log("handback-failed", { threadId: id, title, plan: entry.plan, error: r.error, why: "retries next tick" });
    return { done: true, state: r.state };
  }
  try { await deps.snooze(id); deps.log("snoozed-later", { threadId: id, title }); return { done: true, state }; }
  catch (e) {
    if (/queued turn start/.test(e.message)) return { done: false, state };
    deps.log("snooze-failed", { threadId: id, error: e.message });
    return { done: true, state };
  }
}

// enqueue/pause refuse a thread with a question for the user still open: queued, it would be
// snoozed and the question hidden. `asks`: its open questions from the questions hook
// (lib/questions.mjs); the wording of its messages doesn't matter.
export function enqueueRefusal({ pending, asks = [] }) {
  if (pending) return "a question or approval for the user is pending";
  if (asks.length) return asksLine(asks);
  return null;
}

export function limitHit({ hitAt, completedAt, windowStart }) {
  return !!hitAt && hitAt > windowStart && !(completedAt > hitAt);
}

// Two probes of one window give ids at most a few seconds apart; windows are 5 h apart.
export function sameWindow(a, b) {
  if (a == null) return false;
  if (a === "none" || b == null) return a === (b ?? "none");
  return Math.abs(Date.parse(a) - Date.parse(b)) < 30 * MIN;
}

// A native question (AskUserQuestion) or approval T3 shows the user, not answered yet.
// Its turn stays "running" while it waits.
export const pendingRequest = (t) => (t?.pending_user_input_count ?? 0) + (t?.pending_approval_count ?? 0) > 0;

// Does a main thread count as active? A pending native request, or a turn that ended with a
// question for the user still open (`asked`: from the questions hook), waits on the user: not
// active, never asked. A thread still running with an open ask is working.
export function activity({ running, pending, completedAt, wokenAt, now, asked = false }) {
  if (pending) return { waiting: true };
  if (running) return { why: "turn running" };
  const ended = Date.parse(completedAt ?? "");
  if (wokenAt && !(ended > Date.parse(wokenAt))) return now - Date.parse(wokenAt) < WAKE_GRACE_MS ? { why: "woken < 10 min ago" } : null;
  if (!(now - ended < RECENT_TURN_MS)) return null;
  return asked ? { waiting: true } : { why: "turn ended < 20 min ago" };
}

// One action per tick. `active`: [{threadId, running, pacerWoken, wokenAt, userAt, askedWindow, ready}]
// (main threads, for pause asks); `working`: how many threads on a working model are working now
// (workingThreads, workers included; the wake rule's count); `ready`: what can be woken now, in
// order: limit resumes ({resume: true}) first, then queue entries; `waiting`: everything waiting
// (queue entries plus resumes); `onUser`: queue entries skipped because they wait on the user;
// `handoffWait`: leads due a hand-off that wait for a running delegate_task child; `spentWake`:
// the window of the last day wake at ≥ 95%; `limited`: titles of threads that hit the usage limit
// this window (checked at night only); `held`: the user put the queue on hold (`hold`), so no queue
// entry is woken until `go` (limit resumes still go; asks to pause too). `capped`: a `cap` is on,
// so its line also governs the first wake (no free wake over the line) and a lone ready thread can
// be asked to pause. `triageStarted`: this tick started a triage thread; after a reset triage goes
// first, so a limit resume waits for the next tick.
// The returned wake carries `source`: bootstrap (nothing working), queue (under pace and the
// cap), past-cap (≤ pace − tol) or spent (the day ≥ 95% wake).
export function decide({ used, pace, windowId, night = false, active, working = 0, maxWorking = DEFAULTS.maxWorking, ready, waiting = ready.length, onUser = 0, blocked: onPlans = 0, later = 0, limitQueued = 0, handoffWait = 0, spentWake = null, limited = [], held = null, capped = false,
  triageStarted = false, lastWakeAt = null, lastAskAt = null, lastPauseAt = null, now = Date.now() }) {
  const n = active.length, w = working;
  const tol = band(used);
  const at = `used ${used}% vs ${night ? "night " : ""}pace ${pace}% ${bandText(tol)}, ${n} active, ${w}/${maxWorking} working`;
  const spent = !night && used >= SPENT;
  // At night nothing new starts while a thread sits at the limit: a fresh start would only hit
  // the same limit. The stopped thread's own resume still goes once its reset passes.
  const blocked = night && limited.length > 0;
  const overCap = capped && used > pace;
  // The hold stops new queued work only: a thread the usage limit stopped is still resumed.
  const pool = held ? ready.filter((e) => e.resume) : ready;
  const next = pool[0];
  const resumes = ready.filter((e) => e.resume).length;
  const wakeOf = (source, why) => ({ action: "wake", threadId: next.threadId, source, ...(next.resume ? { resume: true } : {}),
    reason: `${at}: ${why}${next.resume ? `; resumes ${next.title ?? next.threadId.slice(0, 8)}, stopped by the usage limit (reset ${next.resetAt})` : ""}` });
  const triageFirst = (why) => ({ action: "none", reason: `${at}: ${why}, but a triage thread started this tick; the limit resume waits a tick` });
  const waitTriage = triageStarted && next?.resume;
  // By day at 100% a woken thread only hits the limit (the pace line can still be under 100%).
  // At night the limit check below stops new starts once a thread really hits it.
  if (next && !night && used >= 100) return { action: "none", reason: `${at}: window at 100%, a wake would only hit the limit; waiting for reset; ${waiting} queued` };
  if (next && spent && w < 1 && !overCap && !sameWindow(spentWake, windowId)) {
    if (waitTriage) return triageFirst(`nothing working; window ≥ ${SPENT}%, its one wake`);
    return { ...wakeOf("spent", `nothing working; window ≥ ${SPENT}%, its one wake`), spentWake: true };
  }
  if (next && !spent && (!blocked || next.resume)) {
    if (w < 1 && !overCap) {
      const why = `nothing working, ${next.resume ? "a limit resume waits" : "queue has work"}${capped ? " (under the cap line)" : ""}`;
      return waitTriage ? triageFirst(why) : wakeOf("bootstrap", why);
    }
    const room = w >= 1 && used <= pace && w < maxWorking;
    const pastCap = w >= maxWorking && used <= pace - tol;
    if (room || pastCap) {
      const which = room ? `room (${w} working < ${maxWorking}, ≤ pace)` : `room past the cap (${w} working, ≤ pace−${fmt(tol)})`;
      const sinceWake = now - (Date.parse(lastWakeAt ?? "") || 0);
      if (sinceWake < SETTLE_MS) return { action: "none", reason: `${at}: ${which}, but the last wake was ${Math.floor(sinceWake / 60000)} min ago; waiting ${SETTLE_MS / 60000} min for its usage to show` };
      if (waitTriage) return triageFirst(which);
      return wakeOf(room ? "queue" : "past-cap", which);
    }
  }
  const askLine = night ? NIGHT_ASK_FACTOR * tol : tol;
  const need = capped ? 1 : 2;
  if (used > pace + askLine && n >= need) {
    // Only ready threads (plan fleshed out, building) are asked; a thread that isn't ready still
    // works things out with the user, and one the user wrote in < 10 min ago is theirs right now: both count
    // as active but are never asked, and they don't count toward the two askable threads an ask
    // needs (one always runs; with a `cap` one is enough). Wait while an asked thread is still
    // finishing its stage; otherwise prefer a thread with a turn running, then the newest
    // pacer-woken thread, else the one the user wrote in least recently.
    const over = `over pace+${fmt(askLine)}`;
    if (active.some((a) => sameWindow(a.askedWindow, windowId))) return { action: "none", reason: `${at}: ${over}, waiting for the asked thread to pause` };
    const sinceAsk = now - Math.max(Date.parse(lastAskAt ?? "") || 0, Date.parse(lastPauseAt ?? "") || 0);
    if (night && sinceAsk < SETTLE_MS) return { action: "none", reason: `${at}: ${over}, last ask or pause ${Math.floor(sinceAsk / 60000)} min ago; waiting ${SETTLE_MS / 60000} min to see if it helped` };
    const time = (v) => Date.parse(v ?? "") || 0;
    const recent = (a) => now - time(a.userAt) < USER_RECENT_MS;
    const candidates = active.filter((a) => a.ready && !recent(a));
    if (candidates.length >= need) {
      const target = [...candidates].sort((a, b) => (!!b.running - !!a.running) || (!!b.pacerWoken - !!a.pacerWoken)
        || (a.pacerWoken ? time(b.wokenAt) - time(a.wokenAt) : time(a.userAt) - time(b.userAt)))[0];
      const which = target.pacerWoken ? "the newest pacer-woken thread" : "the ready thread the user wrote in least recently";
      const skipped = active.length - candidates.length;
      const note = `${target.running ? " (turn running)" : ""}${skipped ? `; ${skipped} not ready or user-active not asked` : ""}`;
      return { action: "ask-pause", threadId: target.threadId, reason: `${at}: ${over}, asking ${which}${note}` };
    }
    const notReady = active.filter((a) => !a.ready).length, userActive = active.filter((a) => a.ready && recent(a));
    const who = userActive.map((a) => `${a.title ?? a.threadId.slice(0, 8)} ${Math.floor((now - time(a.userAt)) / MIN)} min ago`).join(", ");
    const lone = candidates.length ? "1 ready thread to ask, and one always runs" : "no ready thread to ask";
    return { action: "none", reason: `${at}: ${over}, ${lone}: ${notReady} not ready, ${userActive.length} user-active${who ? ` (${who})` : ""}` };
  }
  if (!waiting) return { action: "none", reason: `${at}: queue empty` };
  if (held && !pool.length) return { action: "none", reason: `${at}: queue on hold since ${held.since}${held.note ? ` (${held.note})` : ""}; ${waiting} queued, nothing woken until \`go\`` };
  const onThem = onUser ? `${onUser === waiting ? "" : `${onUser} `}waiting on the user` : "";
  if (!ready.length) {
    const why = [onThem, onPlans ? `${onPlans} waiting for another plan` : "", later ? `${later} paused until a set time` : "", limitQueued ? `${limitQueued} paused by the usage limit (T3 resumes ${limitQueued === 1 ? "it" : "them"} after the reset)` : "",
      handoffWait ? `${handoffWait} due a hand-off, waiting for a delegate_task child` : ""].filter(Boolean);
    const rest = waiting - onUser - onPlans - later - limitQueued - handoffWait;
    if (rest > 0) why.push(why.length ? "the rest with a turn running" : "all with a turn running");
    return { action: "none", reason: `${at}: ${waiting} queued, ${why.join(", ")}` };
  }
  const also = `${resumes ? `; ${resumes} limit resume${resumes === 1 ? "" : "s"} first` : ""}${onThem ? `; ${onThem}` : ""}`;
  if (blocked) return { action: "none", reason: `${at}: ${limited.join(", ")} hit the usage limit; nothing new until the reset (the stopped thread resumes after it); ${waiting} queued${also}` };
  if (spent) return { action: "none", reason: `${at}: window ≥ ${SPENT}%, ${w ? `${w} working, no wake` : "its one wake is used"}, waiting for reset; ${waiting} queued${also}` };
  return { action: "none", reason: `${at}: ${waiting} queued, no room (${wakeRule(tol, maxWorking)})${also}` };
}

// `list --json`'s rough start times ("about HH:MM"): decide() replayed on 5-min ticks from now to
// the window's reset, usage rising at `burn` points a minute and each wake adding one active and
// one working thread (none finishes); usage reaching 100% ends it. `rows`: the queue in wake order, {threadId, notBefore, stuck}; a stuck row (a
// dependency, a running turn, a pending request, the usage limit: no known end) gets no time, and
// one paused until a set time joins once that time passes. No burn rate or no window: no times.
// Returns threadId → ms. Nothing the pacer decides reads this.
export function roughStarts({ rows, window, now = Date.now(), cfg = DEFAULTS, cap = null, nightAt = () => false, active = 0, working = active, lastWakeAt = null, spentWake = null, held = null, limited = [], burn = null, step = 5 * 60000 }) {
  const out = new Map();
  if (burn == null || !Number.isFinite(burn) || !window?.resetsAt) return out;
  const end = Date.parse(window.resetsAt);
  const free = rows.filter((r) => !r.stuck);
  const left = new Set(free.map((r) => r.threadId));
  let n = active, w = working, last = lastWakeAt, spent = spentWake;
  for (let t = now; t < end && left.size; t += step) {
    const p = capPace(paceOf(window, t, cfg, { codingNight: nightAt(t) }), cap, window.resetsAt, t, cfg);
    const used = Math.round(10 * (window.usedPercent + burn * (t - now) / 60000)) / 10;
    if (used >= 100) break; // the window runs out first: threads hit the limit, nothing more starts
    const ready = free.filter((r) => left.has(r.threadId) && !waitingUntil(r, t));
    const d = decide({ used, pace: p.pace, windowId: p.windowId, night: p.night, active: Array.from({ length: n }, (_, i) => ({ threadId: `active-${i}`, ready: false })),
      working: w, maxWorking: cfg.maxWorking ?? DEFAULTS.maxWorking, ready, waiting: left.size, held, limited, spentWake: spent, capped: p.capTo != null, lastWakeAt: last, now: t });
    if (d.action !== "wake") continue;
    out.set(d.threadId, t);
    left.delete(d.threadId);
    n++;
    w++;
    last = new Date(t).toISOString();
    if (d.spentWake) spent = p.windowId ?? "none";
  }
  return out;
}

// Usage points a minute for roughStarts: since the oldest tick of this window logged 10-30 min
// ago, else the window's average so far (once 10 min old); null when neither is known.
export function burnRate({ used, windowId, resetsAt, now = Date.now(), ticks = [] }) {
  if (!windowId || !Number.isFinite(used)) return null;
  const age = (l) => now - Date.parse(l.at);
  const then = ticks.find((l) => l.event === "tick" && sameWindow(l.window, windowId) && Number.isFinite(l.used) && age(l) <= 30 * 60000 && age(l) >= 10 * 60000);
  if (then) return Math.max(0, (used - then.used) / (age(then) / 60000));
  const elapsed = (WINDOW_MS - (Date.parse(resetsAt) - now)) / 60000;
  return elapsed >= 10 ? Math.max(0, used / elapsed) : null;
}

// The "Stages:" line of a plan's Resume section (`list --json`'s step for a running thread), or null.
export function planStep(text) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*Resume\b/i.test(l));
  if (start < 0) return null;
  const depth = /^#+/.exec(lines[start])[0].length;
  for (const l of lines.slice(start + 1)) {
    const h = /^(#{1,6})\s/.exec(l);
    if (h && h[1].length <= depth) break;
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?Stages:(?:\*\*)?\s*(.+)$/i.exec(l);
    if (m) return clip(m[1].replace(/\*\*/g, "").trim(), 200) || null;
  }
  return null;
}

// Queue priority. Legacy "now" and "normal" map to highest and med.
export const LEVELS = ["highest", "high", "med", "low"];
export const level = (p) => ({ now: "highest", normal: "med" })[p] ?? (LEVELS.includes(p) ? p : "med");
const firstQueued = (e) => Date.parse(e.firstQueuedAt ?? e.enqueuedAt ?? "") || 0;

// The ranking equation:
// score = W[priority] × (1 + days waiting / ageDays) × (paused ? pausedFactor : 1).
// Days count from the first enqueue. A low item waiting 7 days matches a fresh med one.
const round2 = (x) => Math.round(100 * x) / 100;
// Small plans go first (small scopes rank highest, low ones excepted): an entry of size s ranks as highest unless its own priority is low. The stored priority stays, so
// a later `--size m` drops the lift. `lift` (a dependency's raised level, from ordered()) wins
// when it is higher. Returns { priority, small } (small: the size rule raised it).
const higher = (a, b) => (LEVELS.indexOf(level(a)) <= LEVELS.indexOf(level(b)) ? level(a) : level(b));
export function effectivePriority(entry, lift = null) {
  const own = level(entry.priority);
  const small = entry.size === "s" && own !== "low" && own !== "highest";
  const base = small ? "highest" : own;
  const priority = lift ? higher(base, lift) : base;
  return { priority, small: small && priority === "highest" && !(lift && level(lift) === "highest") ? own : null };
}

export function rank(entry, now = Date.now(), cfg = DEFAULTS) {
  const eff = effectivePriority(entry, entry.lift);
  const priority = eff.priority;
  const hours = Math.max(0, (now - firstQueued(entry)) / 3600000);
  const parts = { priority: cfg.priorityWeights[priority] ?? 1, age: 1 + hours / 24 / cfg.ageDays, paused: entry.pauses > 0 ? cfg.pausedFactor : 1 };
  return { score: round2(parts.priority * parts.age * parts.paused), priority, ...(eff.small ? { smallFrom: eff.small } : {}), hours: Math.round(10 * hours) / 10,
    parts: { ...parts, age: round2(parts.age) } };
}
export const describeRank = (r) => `score ${r.score} = ${r.priority} ${r.parts.priority}${r.smallFrom ? ` (small, was ${r.smallFrom})` : ""} × age ${r.parts.age} (${r.hours} h)${r.parts.paused !== 1 ? ` × paused ${r.parts.paused}` : ""}`;

// Wake order: highest score first; among entries within nearTie of the best score, size l wins at
// night and s by day (long plans run while the user sleeps); then score, then first queued.
// With `deps` (from dependencies()), each entry ranks at its effective priority and never comes
// before a queued plan it waits for (a cycle falls back to plain score order).
export function ordered(queue, { now = Date.now(), cfg = DEFAULTS, night = false, deps = null } = {}) {
  const preferred = (e) => (e.size === (night ? "l" : "s") ? 0 : 1);
  const lift = (e) => (deps?.eff.has(e.threadId) ? { ...e, lift: deps.eff.get(e.threadId) } : e);
  let rest = queue.map((e) => ({ e, score: rank(lift(e), now, cfg).score }));
  const out = [];
  const placed = new Set();
  const free = (x) => (deps?.queuedDeps.get(x.e.threadId) ?? []).every((id) => placed.has(id) || !rest.some((r) => r.e.threadId === id));
  while (rest.length) {
    const pool = rest.filter(free).length ? rest.filter(free) : rest;
    const top = Math.max(...pool.map((x) => x.score));
    const pick = pool.filter((x) => x.score >= top * cfg.nearTie)
      .sort((a, b) => preferred(a.e) - preferred(b.e) || b.score - a.score || firstQueued(a.e) - firstQueued(b.e))[0];
    out.push(pick.e);
    placed.add(pick.e.threadId);
    rest = rest.filter((x) => x !== pick);
  }
  return out;
}

// Plan dependencies. A plan's "Wait for: plan N" lines (also "waits for plan N"; a line that says
// "satisfied" doesn't count) name plans it can't build before. A plan that others wait on takes the highest priority among them (down the chain) and wakes just
// before them; a plan whose dependency is still queued or pacer-woken isn't woken itself.
export const planNumber = (plan) => Number(/(?:^|\/)(\d+)-[^/]*\/[^/]*$/.exec(plan ?? "")?.[1] ?? NaN);
export function waitsFor(text) {
  const out = new Set();
  for (const line of (text ?? "").split("\n")) {
    if (/satisfied/i.test(line)) continue;
    for (const m of line.matchAll(/waits?\s+for:?[\s*]*plan\s+(\d+)/gi)) out.add(Number(m[1]));
  }
  return [...out];
}
// queue: entries; woken: state.woken; readPlan(path) → text; building: {threadId: plan} of other
// open threads that readied a plan (the user may run one, outside the queue).
// Returns eff (threadId → level, only when raised), queuedDeps (threadId → queued threadIds it
// waits for), blockedBy (threadId → [{plan, threadId, state: "queued"|"woken"|"building"}]) and
// liftedBy (threadId → plan numbers waiting on it). `built`: plan numbers marked `built`: only
// a live check is left, so they block nothing even while their lead sits queued.
export function dependencies(queue, woken = {}, readPlan = () => "", building = {}, built = new Set()) {
  const byPlan = new Map(), wokenPlan = new Map(), buildingPlan = new Map();
  for (const e of queue) byPlan.set(planNumber(e.plan), e);
  for (const [id, w] of Object.entries(woken)) wokenPlan.set(planNumber(w.plan), id);
  for (const [id, plan] of Object.entries(building)) if (!byPlan.has(planNumber(plan)) && !wokenPlan.has(planNumber(plan))) buildingPlan.set(planNumber(plan), id);
  const queuedDeps = new Map(), blockedBy = new Map(), liftedBy = new Map();
  for (const e of queue) {
    const own = planNumber(e.plan);
    let wants = [];
    try { wants = waitsFor(readPlan(e.plan)).filter((n) => n !== own && !built.has(n)); } catch { /* unreadable plan: no deps */ }
    const blocks = [];
    for (const n of wants) {
      const d = byPlan.get(n);
      if (d) { blocks.push({ plan: n, threadId: d.threadId, state: "queued" }); queuedDeps.set(e.threadId, [...(queuedDeps.get(e.threadId) ?? []), d.threadId]); }
      else if (wokenPlan.has(n)) blocks.push({ plan: n, threadId: wokenPlan.get(n), state: "woken" });
      else if (buildingPlan.has(n)) blocks.push({ plan: n, threadId: buildingPlan.get(n), state: "building" });
    }
    if (blocks.length) blockedBy.set(e.threadId, blocks);
  }
  const W = (l) => LEVELS.length - LEVELS.indexOf(level(l));
  // Seeded from each entry's own effective level, so a small plan (highest) lifts what it waits on.
  const own = (e) => effectivePriority(e).priority;
  const pri = new Map(queue.map((e) => [e.threadId, own(e)]));
  for (let i = 0; i < queue.length; i++) {
    let changed = false;
    for (const [id, ds] of queuedDeps) for (const d of ds) {
      if (W(pri.get(id)) > W(pri.get(d))) { pri.set(d, pri.get(id)); changed = true; }
    }
    if (!changed) break;
  }
  for (const [id, ds] of queuedDeps) for (const d of ds) {
    const n = planNumber(queue.find((e) => e.threadId === id)?.plan);
    liftedBy.set(d, [...new Set([...(liftedBy.get(d) ?? []), n])]);
  }
  const eff = new Map([...pri].filter(([id, l]) => l !== own(queue.find((e) => e.threadId === id))));
  return { eff, queuedDeps, blockedBy, liftedBy };
}
const readPlanText = (plan) => fs.readFileSync(plan, "utf8");
// Readied plans whose orchestrator thread is still open (not settled, archived or deleted).
// `isOpen` defaults to one thread read per entry; `list --json` passes a set from openThreads().
const isOpenThread = (id) => !gone(threadInfo(id));
const building = (state, isOpen = isOpenThread) => Object.fromEntries(Object.entries(state.ready ?? {}).filter(([id, r]) => r.plan && isOpen(id)).map(([id, r]) => [id, r.plan]));
// Plan numbers a dependency may skip: built, and no other plan of that number (several plan
// dirs can share one) still held unbuilt in the queue, woken or building.
export const builtPlans = (state) => {
  const built = new Set(Object.values(state.built ?? {}).map((b) => planKey(b.plan)));
  const unbuilt = new Set([...(state.queue ?? []), ...Object.values(state.woken ?? {}), ...Object.values(state.ready ?? {})]
    .filter((x) => x?.plan && !built.has(planKey(x.plan))).map((x) => planNumber(x.plan)));
  return new Set(Object.values(state.built ?? {}).map((b) => planNumber(b.plan)).filter((n) => !unbuilt.has(n)));
};
const depsOf = (state, isOpen) => dependencies(state.queue, state.woken, readPlanText, building(state, isOpen), builtPlans(state));
const depNote = (deps, e) => {
  const parts = [];
  const b = deps.blockedBy.get(e.threadId);
  if (b) parts.push(`waits for ${b.map((x) => `plan ${x.plan} (${x.state})`).join(", ")}`);
  const by = deps.liftedBy.get(e.threadId) ?? [];
  const waiters = by.length > 1 ? `plans ${by.join(", ")} wait on it` : `plan ${by[0]} waits on it`;
  if (deps.eff.has(e.threadId)) parts.push(`raised from ${level(e.priority)}: ${waiters}`);
  else if (by.length) parts.push(waiters);
  return parts.length ? `\n     ${parts.join("; ")}` : "";
};

// Re-enqueueing a queued thread updates its entry in place.
export function upsert(queue, entry) {
  return queue.some((e) => e.threadId === entry.threadId) ? queue.map((e) => (e.threadId === entry.threadId ? entry : e)) : [...queue, entry];
}

// A thread on the paced Claude instance (t3.claudeInstance); threads on other providers draw on
// other usage windows and aren't paced.
export function isClaude(modelSelectionJson, instance = local().claudeInstance) {
  try { return JSON.parse(modelSelectionJson ?? "{}").instanceId === instance; } catch { return false; }
}

// Triage hook. config.json `triage: { project, checkCommand, title, message, minItems, everyHours }`:
// once per Claude session window a tick runs checkCommand (your triage command: it prints the
// number of new, untriaged items). N > 0 starts one main thread in that T3 project, titled from
// `title` and sent `message` ({items} becomes "N new items", {count} the number); 0 starts
// nothing. A failing check is logged, shown in status and retried next window.
// A pass is saved as `pending` (window, thread id, message id) before anything is sent to T3;
// the next tick finishes a pending pass with the same ids (a crash or failed step never mints
// a second thread). A pass belongs to the window it started in. One started while no window
// was open (its own first turn opens the next one, within 10 min) also counts for that window
// while it is still open; a pass from the previous window never does.
// state.triage = { window, outcome: "started" | "none" | "wait" | "skip" | "error", count, checkedAt, threadId,
//   checkError, startedAt, startedWindow, manual, pending: { window, threadId, messageId, count, createdAt } | null }.
const items = (n) => `${n} new item${n === 1 ? "" : "s"}`;
export const TRIAGE_DEFAULTS = { title: "Triage: {items}", message: "Triage the {items}." };
const fill = (template, n) => template.replaceAll("{items}", items(n)).replaceAll("{count}", String(n));
export const triageTitle = (n, cfg = {}) => fill(cfg.title ?? TRIAGE_DEFAULTS.title, n);
export const triageText = (n, cfg = {}) => fill(cfg.message ?? TRIAGE_DEFAULTS.message, n);
export function parseCount(out, name = "checkCommand") {
  const m = /^\s*(\d+)\s*$/.exec(out ?? "");
  if (!m) throw new Error(`${name} printed ${JSON.stringify(String(out ?? "").trim().slice(0, 80))}, not a count`);
  return Number(m[1]);
}

// One triage step. `windowStart`: ms when this window opened (now − 5 h with no window open).
// deps: check() → stdout; newId() → uuid; save(state) persists queue.json now; create(pass,
// { resume }) makes/pins/sends the pass's thread, skipping done steps when resuming;
// isOpen(threadId); log(event, fields); `cfg`: config.json "triage" (title and message).
// A pass starts only when no triage thread is open (the user's own included) and either the last
// triage run is ≥ everyHours old or more than minItems are open.
export const TRIAGE_RULE = { minItems: 5, everyHours: 24 };
export async function triageTick({ state, windowId, windowStart, deps, dryRun = false, now = Date.now(), rule = TRIAGE_RULE, cfg = {} }) {
  const last = state.triage ?? null;
  const say = [];
  const at = new Date(now).toISOString();
  const log = (event, fields) => { if (!dryRun) deps.log(event, fields); say.push(`${dryRun ? "would log " : ""}${event}: ${fields.why ?? fields.error ?? ""}`); };
  const run = async (pass, resume) => {
    const title = triageTitle(pass.count, cfg);
    if (dryRun) { say.push(`would ${resume ? "finish" : "start"} a triage thread "${title}"`); return { state, say }; }
    try { await deps.create(pass, { resume }); }
    catch (e) {
      log("triage-error", { count: pass.count, threadId: pass.threadId, title, error: e.message, why: `triage thread ${pass.threadId.slice(0, 8)} not finished: ${e.message}; next tick finishes the same thread` });
      return { state, say };
    }
    deps.log("triage-start", { threadId: pass.threadId, title, count: pass.count, resumed: resume, why: `${items(pass.count)} open` });
    say.push(`${resume ? "finished" : "started"} triage thread ${pass.threadId} "${title}"`);
    const triage = { ...last, window: pass.window, outcome: "started", count: pass.count, manual: !!pass.manual,
      checkedAt: at, threadId: pass.threadId, startedAt: pass.createdAt, startedWindow: pass.window, pending: null, checkError: null };
    return { state: { ...state, triage }, say };
  };
  if (last?.pending) return run(last.pending, true);
  if (sameWindow(last?.window, windowId)) return { state, say };
  const record = (fields) => ({ ...state, triage: { ...last, window: windowId ?? "none", checkedAt: at, checkError: null, ...fields } });
  let count;
  try { count = parseCount(await deps.check()); }
  catch (e) {
    log("triage-error", { error: e.message, why: `check failed: ${e.message}; nothing started this window, retries next window` });
    return { state: record({ outcome: "error", checkError: e.message }), say };
  }
  if (count === 0) { log("triage-none", { count, why: "no open items; nothing started this window" }); return { state: record({ outcome: "none", count }), say }; }
  // Every triage thread, the user's own included, plus the pacer's last pass.
  const runs = [...(deps.runs?.() ?? [])];
  if (last?.threadId && !runs.some((x) => x.threadId === last.threadId)) runs.push({ threadId: last.threadId, title: triageTitle(last.count ?? 0, cfg), createdAt: last.startedAt, open: deps.isOpen(last.threadId) });
  const open = runs.find((x) => x.open);
  if (open) {
    log("triage-wait", { count, threadId: open.threadId, why: `${items(count)} open; triage thread ${open.threadId.slice(0, 8)} "${open.title}" is still open` });
    return { state: record({ outcome: "wait", count, waitOn: open.threadId }), say };
  }
  const lastRun = Math.max(0, ...runs.map((x) => Date.parse(x.createdAt ?? "") || 0));
  const hours = (now - lastRun) / 3600000;
  if (count <= rule.minItems && lastRun && hours < rule.everyHours) {
    log("triage-skip", { count, why: `${items(count)} open (≤ ${rule.minItems}), last triage run ${Math.round(hours * 10) / 10} h ago; next pass once it's ${rule.everyHours} h or more than ${rule.minItems} items` });
    return { state: record({ outcome: "skip", count }), say };
  }
  const pass = { window: windowId ?? "none", count, threadId: deps.newId(), messageId: deps.newId(), createdAt: at };
  if (dryRun) return run(pass, false);
  state = { ...state, triage: { ...last, pending: pass } };
  deps.save(state);
  return run(pass, false);
}

// `triage --now`: starts a pass at once, the same thread triageTick makes, without its window and
// everyHours / minItems rule, and also on hold (the user asked for it). An open triage thread
// (the user's own included) or a pass still being started is answered with that thread, never a
// second one. Doesn't touch the window's own check: `triage.window` stays as it was.
// deps as triageTick's. Returns { state, result: { outcome: "started" | "open" | "none" | "error",
// thread_id, title, count, message } }.
export async function triageNow({ state, deps, now = Date.now(), cfg = {} }) {
  const last = state.triage ?? null;
  const at = new Date(now).toISOString();
  const answer = (outcome, fields) => ({ outcome, thread_id: null, title: null, count: null, ...fields });
  if (last?.pending) {
    const p = last.pending;
    const title = triageTitle(p.count, cfg);
    return { state, result: answer("open", { thread_id: p.threadId, title, count: p.count,
      message: `A triage pass is already starting: ${p.threadId.slice(0, 8)} "${title}"; the next tick finishes it.` }) };
  }
  const runs = [...(deps.runs?.() ?? [])];
  if (last?.threadId && !runs.some((x) => x.threadId === last.threadId)) runs.push({ threadId: last.threadId, title: triageTitle(last.count ?? 0, cfg), createdAt: last.startedAt, open: deps.isOpen(last.threadId) });
  const open = runs.find((x) => x.open);
  if (open) {
    deps.log("triage-now-open", { threadId: open.threadId, why: `Triage now: triage thread ${open.threadId.slice(0, 8)} "${open.title}" is still open; no second thread` });
    return { state, result: answer("open", { thread_id: open.threadId, title: open.title,
      message: `A triage is already running: ${open.threadId.slice(0, 8)} "${open.title}".` }) };
  }
  const count = parseCount(await deps.check());
  if (count === 0) {
    deps.log("triage-now-none", { why: "Triage now: no open items; nothing started" });
    return { state, result: answer("none", { count, message: "No open items to triage." }) };
  }
  const pass = { window: last?.window ?? null, count, manual: true, threadId: deps.newId(), messageId: deps.newId(), createdAt: at };
  const title = triageTitle(count, cfg);
  state = { ...state, triage: { ...last, pending: pass } };
  deps.save(state);
  try { await deps.create(pass, { resume: false }); }
  catch (e) {
    deps.log("triage-error", { count, threadId: pass.threadId, title, error: e.message, why: `Triage now: thread ${pass.threadId.slice(0, 8)} not finished: ${e.message}; next tick finishes the same thread` });
    return { state, result: answer("error", { thread_id: pass.threadId, title, count,
      message: `Started ${pass.threadId.slice(0, 8)} "${title}" but T3 said: ${e.message}. The next tick finishes it.` }) };
  }
  deps.log("triage-start", { threadId: pass.threadId, title, count, manual: true, resumed: false, why: `Triage now: ${items(count)} open` });
  const triage = { ...last, outcome: "started", count, threadId: pass.threadId, checkedAt: at,
    startedAt: at, startedWindow: last?.window ?? null, pending: null, manual: true };
  state = { ...state, triage };
  deps.save(state);
  return { state, result: answer("started", { thread_id: pass.threadId, title, count, message: `Started triage thread ${pass.threadId.slice(0, 8)} "${title}".` }) };
}

// Emergency dispatch (config.json "emergency"): when something trips, start one thread to fix it
// and tell the user once. Each tick gathers causes:
// checkCommand's JSON ({"causes": [{key, count, threshold, window_min, summary, top}]}) plus the
// pacer's own: pacer-failing (3 failed ticks in a row), pacer-blind (6 ticks in a row with no
// Claude usage window, an error or null) and pacer-stuck (3 ticks chose to wake the same thread
// and it never started). One emergency thread is open at a time; after it settles
// the same cause starts another only 6 h later, or sooner at ≥ 2× the count that started the last.
// It skips the queue and any hold. Its state lives in emergency.json, not queue.json, so a garbled
// queue.json (a failing tick) can't stop it.
// state = { threadId, title, causes, startedAt, closedAt, notified, pending, pendingNotified, last: { <key>: { at, count, threadId, settledAt } } }.
export const FAILING_TICKS = 3;
export const BLIND_TICKS = 6;
export const EMERGENCY_COOLDOWN_HOURS = 6;
const isTickLine = (l) => l.event === "tick" || (l.event === "error" && l.command === "tick");
// Ticks in a row (newest first) that had no usage window: tick and tick-error lines carry `blind`.
// A tick that failed during a T3 upgrade (`t3Upgrade`, below) neither counts nor ends the streak.
export const blindStreak = (lines) => {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isTickLine(lines[i]) || lines[i].t3Upgrade) continue;
    if (lines[i].blind !== true) break;
    n++;
  }
  return n;
};
// T3 on WSL upgrades itself into a new ~/.t3/wsl-runtime/sha256-* dir, and for ~15 min its
// database is locked and then its port refuses; without a grace those ticks would raise an
// emergency for an outage that heals itself. A tick that fails with a T3-unreachable error while the newest entry
// in that dir (the sha256-* dirs and their install locks) is under 15 min old is logged with
// `t3Upgrade` and skipped by both streaks. A T3 still down after the window counts from then on.
export const T3_UPGRADE_GRACE_MIN = 15;
export const T3_UNREACHABLE = /database is locked|SQLITE_BUSY|connection refused|connection closed|websocket refused|websocket ticket|T3 not running|not reachable on port|other side closed/i;
// The newest runtime entry while it is under the grace age: { name, ageMin, until }, else null.
export function t3Upgrade({ dir = process.env.PACER_T3_RUNTIME_DIR ?? path.join(os.homedir(), ".t3/wsl-runtime"), now = Date.now() } = {}) {
  let newest = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { name, mtime };
    }
  } catch { return null; }
  if (!newest || now - newest.mtime >= T3_UPGRADE_GRACE_MIN * 60_000) return null;
  return { name: newest.name, ageMin: Math.max(0, Math.round((now - newest.mtime) / 60_000)), until: new Date(newest.mtime + T3_UPGRADE_GRACE_MIN * 60_000).toISOString() };
}
export const upgradeGrace = (error, opts) => (T3_UNREACHABLE.test(String(error ?? "")) ? t3Upgrade(opts) : null);
// Ticks that chose to wake the same thread and left it queued: the tick line carries `wakeStuck`
// when the thread is still in the queue after its wake (a wake that worked takes it out). Counts
// such wakes of one thread in a row, newest within the last STUCK_WINDOW_MIN; a wake that worked or
// another thread's wake ends the streak, ticks with another action are skipped (wakes are 10 min
// apart).
export const STUCK_TICKS = 3;
export const STUCK_WINDOW_MIN = 60;
export function stuckWake(lines, now = Date.now()) {
  let count = 0, threadId = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.event !== "tick" || l.action !== "wake" || !l.threadId) continue;
    if (now - Date.parse(l.at) > STUCK_WINDOW_MIN * 60_000) break;
    if (!l.wakeStuck || (threadId && l.threadId !== threadId)) break;
    threadId = l.threadId; count++;
  }
  return { count, threadId };
}
// A stuck streak counts only while its thread is still queued: once it is woken or handed off
// (by a fix or by hand), the old lines don't open an emergency. A garbled queue.json counts it.
function stillQueued(stuck) {
  if (!stuck.threadId) return stuck;
  try { return readState().queue.some((e) => e.threadId === stuck.threadId) ? stuck : null; } catch { return stuck; }
}
export const tickBlind = (streak, upgrading) => (upgrading ? streak : 1 + streak);
export function upgradeStatus(up, lines) {
  if (!up) return null;
  const skipped = lines.filter((l) => l.t3Upgrade && l.graceUntil === up.until).length;
  return `T3 upgrading (runtime ${up.name.slice(0, 24)} ${up.ageMin} min old): ${skipped} failed tick${skipped === 1 ? "" : "s"} not counted toward the emergency until ${zoneLabel(up.until, { hour: "numeric", minute: "2-digit" })}`;
}
export function pacerCauses({ failing = 0, blind = 0, error = null, stuck = null }) {
  const causes = [];
  if (stuck?.count >= STUCK_TICKS) causes.push({ key: "pacer-stuck", count: stuck.count, threshold: STUCK_TICKS,
    summary: `pacer chose to wake ${stuck.threadId.slice(0, 8)} ${stuck.count} ticks in a row and it never started`, threadId: stuck.threadId });
  if (failing >= FAILING_TICKS) causes.push({ key: "pacer-failing", count: failing, threshold: FAILING_TICKS,
    summary: `pacer failed ${failing} ticks in a row`, ...(error ? { top: [{ source: "pacer tick", message: String(error).slice(0, 200), n: 1 }] } : {}) });
  if (blind >= BLIND_TICKS) causes.push({ key: "pacer-blind", count: blind, threshold: BLIND_TICKS,
    summary: `no Claude usage window for ${blind * 5} min`, window_min: blind * 5 });
  return causes;
}
// checkCommand's stdout → causes. Throws on anything that isn't the S1 shape.
export function parseCauses(out) {
  let raw;
  try { raw = JSON.parse(out); } catch { throw new Error(`checkCommand printed ${JSON.stringify(String(out ?? "").trim().slice(0, 80))}, not JSON`); }
  if (!Array.isArray(raw?.causes)) throw new Error("checkCommand JSON has no \"causes\" list");
  for (const c of raw.causes) {
    if (typeof c?.key !== "string" || !Number.isFinite(c.count) || typeof c.summary !== "string") throw new Error(`checkCommand cause ${JSON.stringify(c).slice(0, 80)} lacks key, count or summary`);
  }
  return raw.causes;
}
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
export const emergencyTitle = (cause) => clip(`Emergency: ${cause.summary}`, 60);
// Who runs an emergency, in order: config.json emergency.chain, a list of T3 model selections
// ({ instance, model, options }). When a step's thread fails, the next tick hands the same brief
// to the next step; the last one's failure is left alone. Default: Claude Opus (high) only.
export const defaultChain = () => [{ instance: local().mainInstance, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] }];
export const emergencyChain = (cfg = {}) => (Array.isArray(cfg.chain) && cfg.chain.length ? cfg.chain : defaultChain());
const stepName = (cfg, step) => emergencyChain(cfg)[step]?.model ?? `step ${step + 1}`;
export const fallbackTitle = (cause, step, cfg = {}) => clip(`Emergency (${stepName(cfg, step)}): ${cause.summary}`, 60);
// failed: the earlier steps' [{ threadId, model, error }].
export const emergencyLine = (causes, title, step = 0, failed = [], cfg = {}) => `Pacer emergency: ${causes.map((c) => c.summary).join("; ")}.${step ? ` ${failed.map((f) => `The ${f.model} thread failed (${clip(f.error, 120)})`).join("; ")}, so the` : ""} ${stepName(cfg, step)} thread '${title}' is on it.`;
// Sent once per pending start when T3 can't make the thread (a broken T3 would otherwise retry
// every tick in silence).
export const emergencyOpenFailedLine = (causes, title, error, step = 0, cfg = {}) => `Pacer emergency: ${causes.map((c) => c.summary).join("; ")}. Couldn't open the ${stepName(cfg, step)} thread '${title}': ${error}. The pacer retries every tick.`;
const causeCounts = (causes) => causes.map((c) => `${c.key} ${c.count}`).join(", ");

// The emergency thread's first message. cfg: the "emergency" config (project, checkCommand, postCommand).
export function emergencyBrief(causes, cfg, at) {
  const pacer = causes.find((c) => c.key.startsWith("pacer-"));
  const out = [`Emergency dispatch (${at}): the pacer started this thread because something tripped. Find the cause fast and get things back to normal; don't wait for the user, who got one notice about it. Never run pacer \`ready\`, \`enqueue\` or \`pause\` in this thread: the pacer keeps it out of its queue and holds on purpose.`, "", "What tripped:"];
  for (const c of causes) {
    out.push(`- ${c.key}: ${c.summary} (count ${c.count}, threshold ${c.threshold ?? "?"}${c.window_min ? `, last ${c.window_min} min` : ""})`);
    for (const t of c.top ?? []) out.push(`  - ${t.n ?? 1}× ${t.source}: ${t.message}`);
  }
  out.push("", "How to work:",
    "1. Read the project's agent instructions (AGENTS.md, CLAUDE.md or similar) for where its logs and data live.",
    `2. Explore before any fix.${cfg.checkCommand ? ` Recheck the numbers with \`${cfg.checkCommand}\`.` : ""}`,
    "3. Keep the fix small, test it, and commit it locally. Don't push.",
    "4. If the cause is outside the project (a provider down, an expired login), say so and what the user has to do.",
    `5. After mitigation, post a 3–5 line report${cfg.postCommand ? ` with \`${cfg.postCommand}\` (markdown on stdin)` : ""}, then end the thread.`);
  if (pacer) out.push("", `The pacer (~/.agents/skills/pacer) ${pacer.key === "pacer-failing" ? `has failed ${pacer.count} ticks in a row, so nothing is being woken or paused.${pacer.top?.[0] ? ` Last error: ${pacer.top[0].message}` : ""}` : pacer.key === "pacer-stuck" ? `chose to wake thread ${pacer.threadId} on ${pacer.count} ticks in a row, but the thread never started and stays at the head of the queue, so nothing else is woken. Compare its queue entry with its records in the pacer's queue.json (handoffs, woken, ready) and the \`wake\` lines in the log.` : `has had no Claude usage window for ${pacer.count} ticks, so it paces blind. Check \`node ~/.agents/skills/pacer/scripts/lib/usage.mjs --json\` (the Claude instance's session window).`}`,
    "For the pacer:",
    `1. Read ~/.agents/skills/pacer/SKILL.md and DESIGN.md, then the recent lines of ${logFile}, and reproduce with \`node ~/.agents/skills/pacer/scripts/pacer.mjs tick --dry-run\`.`,
    "2. Fix the cause in the pacer's source repo (~/.agents/skills/pacer links to it). Keep the fix small; don't change pacing rules.",
    "3. Run `node --test` on its scripts/*.test.mjs, then one real `pacer.mjs tick`, and check the log shows a normal tick.",
    "4. Commit in the repo you fixed (local only, don't push).");
  return out.join("\n");
}

// A fallback step's brief: the same brief, plus which threads failed before it and how.
export function fallbackBrief(causes, cfg, at, failed) {
  return `${emergencyBrief(causes, cfg, at)}

You are a fallback (${stepName(cfg, failed.length)}): the earlier threads for this emergency failed:
${failed.map((f) => `- ${f.model} thread ${f.threadId}: ${f.error}`).join("\n")}
Read them first in case one got partway; they are settled now so T3 won't resume them. Their provider may be down, so do the fix on a model that works. If a provider needs the user (an expired login, a usage limit), say exactly what they have to run.`;
}

// One emergency step. state: emergency.json (or {}); causes: tripped causes this tick.
// deps: isOpen(threadId); failed(threadId) → the error of a failed run, or null; newId() → uuid;
// create({ threadId, messageId, title, text, resume, step, settle }) makes, pins and sends the
// thread on chain[step] (resume skips the steps T3 already has) and settles `settle`, the failed
// thread it replaces. When a step's run fails (an expired login can kill one in seconds), the
// next step takes over with the same brief; the last one's failure is left alone. save(state)
// persists emergency.json at once; text(line, key); post(line); log(event, fields).
// Crash safety, like triage: the start is saved as `pending` (ids, title, brief, causes) before any
// T3 command, and the next tick finishes that same thread instead of starting another. The thread
// is recorded with notified: false before the text and post, and notified: true once they were
// tried (sent or failed: no retry); a tick that finds notified: false sends them, same key.
// When create fails, the user gets the run's one text and one post (pendingNotified: true once
// tried). Recovery and chain fallbacks reuse that notice.
export async function emergencyTick({ state, causes, cfg, deps, dryRun = false, now = Date.now() }) {
  const say = [];
  const at = new Date(now).toISOString();
  const chain = emergencyChain(cfg);
  const log = (event, fields) => { if (!dryRun) deps.log(event, fields); say.push(`${dryRun ? "would log " : ""}${event}: ${fields.why ?? fields.error ?? ""}`); };
  let next = state ?? {};
  const send = async (line, threadId, flag) => {
    try { await deps.text(line, `emergency-${next.runId ?? threadId}`); }
    catch (e) { log("emergency-text-failed", { threadId, via: "text", error: e.message, why: `text failed: ${e.message}` }); }
    try { await deps.post(line); }
    catch (e) { log("emergency-text-failed", { threadId, via: "post", error: e.message, why: `post failed: ${e.message}` }); }
    next = { ...next, [flag]: true };
    deps.save(next);
  };
  const notify = () => send(emergencyLine(next.causes, next.title, next.step ?? 0, next.failed ?? [], cfg), next.threadId, "notified");
  const notifyOpenFailed = (pending, error) => send(emergencyOpenFailedLine(pending.causes, pending.title, error, pending.step ?? 0, cfg), pending.threadId, "pendingNotified");
  const start = async (pending, resume) => {
    if (dryRun) {
      say.push(`would ${resume ? "finish" : "start"} emergency thread "${pending.title}" (${causeCounts(pending.causes)})`);
      if (!resume || !next.pendingNotified) say.push("would notify the user if the thread can't be opened");
      return { state: next, say };
    }
    try { await deps.create({ threadId: pending.threadId, messageId: pending.messageId, title: pending.title, text: pending.text, resume, step: pending.step ?? 0, settle: pending.failed?.at(-1)?.threadId ?? null }); }
    catch (e) {
      log("emergency-failed", { threadId: pending.threadId, title: pending.title, error: e.message, why: `emergency thread ${pending.threadId.slice(0, 8)} not finished: ${e.message}; the next tick finishes the same thread` });
      if (!next.pendingNotified && !next.notified) await notifyOpenFailed(pending, e.message);
      return { state: next, say };
    }
    const alreadyNotified = next.notified === true || next.pendingNotified === true;
    const { threadId, title, causes: fire, at: startedAt } = pending;
    next = { ...next, pending: null, pendingNotified: false, threadId, title, causes: fire, startedAt, closedAt: null, notified: alreadyNotified,
      step: pending.step ?? 0, failed: pending.failed ?? [],
      last: { ...next.last, ...Object.fromEntries(fire.map((c) => [c.key, { at: startedAt, count: c.count, threadId }])) } };
    deps.save(next);
    deps.log("emergency-start", { threadId, title, causes: fire.map(({ key, count, threshold, summary }) => ({ key, count, threshold, summary })), resumed: resume,
      ...(pending.step ? { step: pending.step, model: stepName(cfg, pending.step) } : {}),
      why: `${causeCounts(fire)}${pending.step ? `; ${stepName(cfg, pending.step)} takes over from ${pending.failed.at(-1).threadId.slice(0, 8)}: ${pending.failed.at(-1).error}` : ""}` });
    say.push(`${resume ? "finished" : "started"} emergency thread ${threadId} "${title}"`);
    if (!alreadyNotified) await notify();
    return { state: next, say };
  };
  if (next.pending) return start(next.pending, true);
  if (next.threadId && next.notified === false) {
    if (dryRun) say.push(`would send the start notice for ${next.threadId.slice(0, 8)} "${next.title}"`);
    else await notify();
  }
  const step = next.step ?? 0;
  if (next.threadId && !next.closedAt && step < chain.length - 1) {
    const error = deps.failed(next.threadId);
    if (error) {
      const failed = [...(next.failed ?? []), { threadId: next.threadId, model: stepName(cfg, step), error }];
      const title = fallbackTitle(next.causes[0], step + 1, cfg);
      if (dryRun) return start({ title, causes: next.causes, step: step + 1, failed }, false);
      const pending = { threadId: deps.newId(), messageId: deps.newId(), title, text: fallbackBrief(next.causes, cfg, at, failed),
        causes: next.causes, at, step: step + 1, failed };
      next = { ...next, pending, pendingNotified: false };
      deps.save(next);
      return start(pending, false);
    }
  }
  if (next.threadId && !next.closedAt) {
    if (deps.isOpen(next.threadId)) {
      if (causes.length) log("emergency-held", { threadId: next.threadId, title: next.title, causes: causes.map(({ key, count }) => ({ key, count })),
        why: `${causeCounts(causes)}; emergency thread ${next.threadId.slice(0, 8)} "${next.title}" is still open` });
      return { state: next, say };
    }
    // Settled (or archived/deleted): the cooldown of the causes it handled runs from now.
    const last = Object.fromEntries(Object.entries(next.last ?? {}).map(([k, v]) => [k, v.threadId === next.threadId && !v.settledAt ? { ...v, settledAt: at } : v]));
    next = { ...next, closedAt: at, last };
    log("emergency-closed", { threadId: next.threadId, title: next.title, why: `emergency thread ${next.threadId.slice(0, 8)} "${next.title}" is closed` });
  }
  if (!causes.length) return { state: next, say };
  const coolMs = (cfg.cooldownHours ?? EMERGENCY_COOLDOWN_HOURS) * 3600000;
  const fire = [];
  for (const c of causes) {
    const l = next.last?.[c.key];
    const since = l ? Date.parse(l.settledAt ?? l.at) : NaN;
    if (l && now - since < coolMs && c.count < 2 * l.count) {
      log("emergency-cooldown", { key: c.key, count: c.count, last: l,
        why: `${c.key} ${c.count}: the last one (${l.count}) ${l.settledAt ? "settled" : "started"} ${l.settledAt ?? l.at}; starts again at ${2 * l.count} or after ${new Date(since + coolMs).toISOString()}` });
    } else fire.push(c);
  }
  if (!fire.length) return { state: next, say };
  const title = emergencyTitle(fire[0]);
  if (dryRun) return start({ title, causes: fire }, false);
  const pending = { threadId: deps.newId(), messageId: deps.newId(), title, text: emergencyBrief(fire, cfg, at), causes: fire, at };
  next = { ...next, pending, pendingNotified: false, notified: false, runId: pending.threadId };
  deps.save(next);
  return start(pending, false);
}

// Claude's login: an expired login stops every Claude thread at once, and nothing else says so.
// failure: the newest run that failed with T3's "Claude could not authenticate" in the last 30 min
// ({ at, error }) or null; creds: { mtimeMs, refreshTokenExpiresAt } of the credentials file or
// null. One text per broken login (keyed by the credentials file's mtime, which a new login
// changes) and one warning 48 h before the refresh token's own expiry. state.login = { failedFor,
// warnedFor }. deps: text(line, key), log.
export const LOGIN_WARN_HOURS = 48;
export async function claudeLoginTick({ state, failure, creds, configDir, deps, dryRun = false, now = Date.now() }) {
  const say = [];
  let next = state ?? {};
  const login = { ...(next.login ?? {}) };
  const command = `CLAUDE_CONFIG_DIR=${configDir} claude auth login`;
  const when = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: userZone(), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const send = async (line, key, why) => {
    if (dryRun) { say.push(`would text: ${line}`); return; }
    try { await deps.text(line, key); deps.log("claude-login-text", { key, why }); }
    catch (e) { deps.log("emergency-text-failed", { via: "text", error: e.message, why: `Claude login text failed: ${e.message}` }); }
    say.push(`texted: ${line}`);
  };
  const mark = creds?.mtimeMs ?? "none";
  if (failure && login.failedFor !== mark) {
    await send(`Claude's login expired (${when(Date.parse(failure.at))}): every Claude thread has stopped. Log in again: ${command}`, `claude-login-${mark}`, failure.error);
    login.failedFor = mark;
  }
  const exp = creds?.refreshTokenExpiresAt;
  if (exp && exp > now && exp - now < LOGIN_WARN_HOURS * 3600000 && login.warnedFor !== exp) {
    await send(`Claude's login runs out ${when(exp)}. Log in again before then so no thread stops: ${command}`, `claude-login-expiry-${exp}`, `refresh token expires ${new Date(exp).toISOString()}`);
    login.warnedFor = exp;
  }
  if (JSON.stringify(login) !== JSON.stringify(next.login ?? {})) next = { ...next, login };
  return { state: next, say };
}

export function emergencyStatus({ cfg, state, open }) {
  if (!cfg) return "Emergency: off (no \"emergency\" in config.json)";
  if (state?.pending) return `Emergency: thread ${state.pending.threadId.slice(0, 8)} "${state.pending.title}" not finished; the next tick finishes it`;
  if (!state?.threadId) return "Emergency: none started yet";
  const t = `${state.threadId.slice(0, 8)} "${state.title}"`;
  if (!state.closedAt && open) return `Emergency: thread ${t} open since ${state.startedAt} (${causeCounts(state.causes ?? [])}); nothing new starts until it settles`;
  return `Emergency: none open; last ${t} started ${state.startedAt}${state.closedAt ? `, closed ${state.closedAt}` : ", closed (next tick records it)"}`;
}

// What `status` says about the triage hook.
// A thread is ready (its plan fleshed out, past triage) once it ran `ready`, `enqueue` or
// `pause`, or the pacer woke it. Until then it is not ready: it counts as active but is never
// asked to pause.
// Queued and pacer-woken threads are ready; their own ready entry (seeded here for state written
// before `ready` existed, and for every wake) outlives a handoff to the user.
export function seedReady(state) {
  const ready = { ...state.ready };
  for (const e of state.queue ?? []) ready[e.threadId] ??= { plan: e.plan, title: e.title, readyAt: e.enqueuedAt ?? null };
  for (const [id, w] of Object.entries(state.woken ?? {})) ready[id] ??= { plan: w.plan, title: w.title, readyAt: w.wokenAt ?? null };
  return { ...state, ready };
}
export const isReady = (state, id) => !!(state.ready?.[id] || state.woken?.[id] || state.queue?.some((e) => e.threadId === id));
// The pacer pins nothing: a working thread shows in T3's Working section. A lead the user pinned
// keeps its pin through a hand-off (handOffLead).

// A lead handed off to a fresh thread: the thread that now carries it (following a chain of
// hand-offs). A record that isn't done yet counts too, so a message sent in between lands on the
// new thread.
export function handoffTarget(state, id) {
  const seen = new Set([id]);
  for (let rec = state.handoffs?.[id]; rec?.to && !seen.has(rec.to); rec = state.handoffs?.[rec.to]) { id = rec.to; seen.add(id); }
  return id;
}
// The same, read from the queue file: a tool that messages a lead can ask it first.
export function triageStatus({ triage, last, windowId }) {
  if (!triage) return "Triage: off (no \"triage\" in config.json)";
  if (last?.pending) return `Triage: pass ${last.pending.threadId.slice(0, 8)} "${triageTitle(last.pending.count, triage)}" not finished; the next tick finishes it`;
  const started = last?.threadId ? `; last thread ${last.threadId.slice(0, 8)} started ${last.startedAt}` : "";
  if (!sameWindow(last?.window, windowId)) return `Triage: not checked this window yet (next tick)${started}`;
  const rule = { minItems: triage.minItems ?? TRIAGE_RULE.minItems, everyHours: triage.everyHours ?? TRIAGE_RULE.everyHours };
  const what = { none: "no open items, nothing started", started: `started ${last.threadId?.slice(0, 8)} "${triageTitle(last.count, triage)}"${last.manual ? " (Triage now)" : ""}`,
    wait: `${items(last.count)} open, triage thread ${(last.waitOn ?? last.threadId)?.slice(0, 8)} still open`,
    error: `check failed (${last.checkError}), nothing started; next window tries again`,
    skip: `${items(last.count)} open, waiting for ${rule.everyHours} h since the last run or more than ${rule.minItems} items` }[last.outcome];
  return `Triage: checked this window at ${last.checkedAt}: ${what}${last.outcome === "started" ? "" : started}`;
}

// ---------------------------------------------------------------------------
// State, log, T3
// ---------------------------------------------------------------------------

// Legacy priorities ("now", "normal") are mapped on read.
function readState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(queueFile, "utf8")); }
  catch (e) { if (e.code === "ENOENT") s = {}; else throw e; }
  const lift = (e) => ({ ...e, priority: level(e.priority) });
  return seedReady({ queue: (s.queue ?? []).map(lift), woken: Object.fromEntries(Object.entries(s.woken ?? {}).map(([id, w]) => [id, lift(w)])),
    asked: s.asked ?? {}, spentWake: s.spentWake ?? null, triage: s.triage ?? null, ready: s.ready ?? {}, held: s.held ?? null,
    lastWakeAt: s.lastWakeAt ?? null, lastAskAt: s.lastAskAt ?? null, lastPauseAt: s.lastPauseAt ?? null, sleep: s.sleep ?? null, cap: s.cap ?? null,
    // Lead hand-offs: old thread id → { to, messageId, plan, title, text, compactions, cause, at, done, settled }; and
    // the compaction level each lead was last told to hand off at.
    handoffs: s.handoffs ?? {}, handoffAsked: s.handoffAsked ?? {},
    // Missed-resume sends and pacer limit resumes, kept a day past their reset.
    resumed: Object.fromEntries(Object.entries(s.resumed ?? {}).filter(([, at]) => Date.parse(at) > Date.now() - 86400000)),
    // Main threads the pacer took at the usage limit: id → { title, resetAt, snoozedUntil, takenAt }.
    limitResumes: s.limitResumes ?? {},
    // Plans whose stages are all committed, only a live check or a later step left:
    // plan path → { plan, at, threadId, title }. They block no dependent.
    built: s.built ?? {},
    // Plan dir ("12-dark-mode") → { firstQueuedAt, priority, pauses } from its
    // last enqueue, so a re-queue of the same plan keeps its age and raises.
    planAges: backfillPlanAges(s.queue ?? [], s.woken ?? {}, s.planAges ?? {}),
    // delegate_task child → { runId, at }: the report already relayed to a handed-off lead's new thread.
    relayed: Object.fromEntries(Object.entries(s.relayed ?? {}).filter(([, r]) => Date.parse(r.at) > Date.now() - 8 * 86400000)) });
}
function readConfig() {
  try { return settings(JSON.parse(fs.readFileSync(configFile, "utf8"))); }
  catch (e) { if (e.code === "ENOENT") return settings(); throw e; }
}
// The sleep state now. Never throws: no sleepFile, a missing or garbled file = clock rules,
// with the reason in `note` (the tick logs it once per change).
function readSleep(cfg = readConfig(), now = Date.now()) {
  if (!cfg.sleepFile) return sleepState(null, now, "no sleepFile in config.json");
  let text;
  try { text = fs.readFileSync(cfg.sleepFile, "utf8"); }
  catch (e) { return sleepState(null, now, e.code === "ENOENT" ? `no sleep file at ${cfg.sleepFile}` : `can't read ${cfg.sleepFile}: ${e.message}`); }
  try { return sleepState(parseSleep(text), now); }
  catch (e) { return sleepState(null, now, `garbled ${cfg.sleepFile}: ${e.message}`); }
}
function writeState(s) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${queueFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, queueFile);
}
function log(event, fields = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const line = { at: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(logFile, JSON.stringify(line) + "\n");
  return line;
}
function readLog() {
  try { return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
// Every read-modify-write of queue.json (tick, enqueue/pause, wake, remove, snooze-later) holds
// this lock, so a manual command can't be overwritten by a tick's older snapshot. A lock left
// by a crashed process is taken over after 2 min.
async function withLock(fn, lockFile = queueLock) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (;;) {
    try { fs.writeFileSync(lockFile, `${process.pid} ${command}\n`, { flag: "wx" }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { log("lock-stale", { lock: fs.readFileSync(lockFile, "utf8").trim(), ageSec: Math.round(age / 1000) }); fs.rmSync(lockFile, { force: true }); continue; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lockFile, { force: true }); }
}

// A thread as the pacer reads it: t3-api.mjs's getThread/listThreads (T3's own status, settled
// and usage-limit rules), plus what the adapter doesn't return: when the snooze was set, the
// newest user message, pending native requests (T3 shows each as a waiting approval_request,
// user_input_request or secret_request turn item) and the worktree.
const extrasSql = (where) => `select t.thread_id, json_extract(t.payload_json, '$.snoozedAt') as snoozed_at,
    json_extract(t.payload_json, '$.worktreePath') as worktree_path, json_extract(t.payload_json, '$.branch') as branch,
    (select max(m.created_at) from orchestration_v2_projection_messages m where m.thread_id = t.thread_id and m.role = 'user') as latest_user_message_at,
    (select count(*) from orchestration_v2_projection_turn_items i where i.thread_id = t.thread_id and i.status = 'waiting' and i.type = 'approval_request') as pending_approval_count,
    (select count(*) from orchestration_v2_projection_turn_items i where i.thread_id = t.thread_id and i.status = 'waiting' and i.type in ('user_input_request', 'secret_request')) as pending_user_input_count,
    (select json_extract(r.payload_json, '$.modelSelection') from orchestration_v2_projection_runs r where r.thread_id = t.thread_id
      and json_extract(r.payload_json, '$.modelSelection') is not null order by r.ordinal desc limit 1) as run_model_selection,
    (select r.requested_at from orchestration_v2_projection_runs r where r.thread_id = t.thread_id order by r.ordinal desc limit 1) as latest_run_requested_at
  from orchestration_v2_projection_threads t where ${where}`;
// The thread's model: its own selection, else its newest run's, else the adapter's provider
// instance alone (no model). A delegate_task child can lack a thread selection; without this
// isClaude() saw null and the child vanished from the working count.
const runSelection = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };
export function threadView(t, x = {}) {
  const selection = t.modelSelection ?? runSelection(x.run_model_selection);
  const effective = selection ?? (t.providerInstanceId ? { instanceId: t.providerInstanceId } : null);
  return { thread_id: t.id, title: t.title, project_id: t.projectId, worktree_path: x.worktree_path ?? null, branch: x.branch ?? null,
    model_selection_json: effective ? JSON.stringify(effective) : null, model_selection: selection,
    runtime_mode: t.runtimeMode, interaction_mode: t.interactionMode, created_at: t.createdAt,
    latest_user_message_at: x.latest_user_message_at ?? null, pending_user_input_count: x.pending_user_input_count ?? 0, pending_approval_count: x.pending_approval_count ?? 0,
    deleted_at: t.deletedAt, archived_at: t.archivedAt, settled_at: t.settled ? t.settledAt ?? t.updatedAt : null,
    snoozed_until: t.snoozedUntil, snoozed_at: x.snoozed_at ?? null, pinned_at: t.pinnedAt, lineage: t.lineage,
    turn_state: t.status, turn_completed_at: t.latestRunCompletedAt, latest_run_requested_at: x.latest_run_requested_at ?? null, busy: t.busy,
    last_error_class: t.lastErrorClass, usage_limit_reset_at: t.usageLimitResetAt };
}
function threadInfo(id) {
  const t = getThread(id);
  return t ? threadView(t, t3Query(extrasSql("t.thread_id = ?"), [id])[0]) : null;
}
function openThreads() {
  const extras = new Map(t3Query(extrasSql("t.deleted_at is null and json_extract(t.payload_json, '$.archivedAt') is null")).map((x) => [x.thread_id, x]));
  return listThreads().filter((t) => !t.settled).map((t) => threadView(t, extras.get(t.id)));
}
// Message reads (T3 0.1.0 keeps the text and createdBy in payload_json).
const messagesSql = `select created_at, json_extract(payload_json, '$.text') as text, json_extract(payload_json, '$.createdBy') as created_by
  from orchestration_v2_projection_messages`;
// Has the thread replied (an assistant message) since `since`?
function repliedSince(id, since) {
  return !!t3Query("select 1 from orchestration_v2_projection_messages where thread_id=? and role='assistant' and created_at > ? limit 1", [id, since ?? ""])[0];
}
// A queued thread waiting on the user: a pending native request, or idle with a question for
// them still open (`asked`, from the questions hook). The tick never wakes it (it hands it back).
const waitsOnUser = (info, asked) => pendingRequest(info) || (!running(info) && asked);
// Open questions per thread from the questions hook (lib/questions.mjs), read once per process.
// An unreadable hook throws: a broken record never reads as "no questions".
let asksMap = null;
const openAsks = () => (asksMap ??= readQuestions(readConfig()));
const askedOf = (id) => openAsks().get(id) ?? [];
// The user's own messages: T3 marks agent-sent ones createdBy "agent", and the pacer's carry
// its "Pacer:" prefix. T3's usage-limit auto-resume sends "Continue where you left off." as
// "user"; it isn't the user either, nor is a /compact.
export const COMPACT = "/compact";
export const automated = (text) => /^(Pacer:|Continue where you left off\.$)/.test((text ?? "").trim()) || (text ?? "").trim() === COMPACT;
export const fromUser = (m) => m.created_by !== "agent" && !automated(m.text);
// When the user last wrote in a thread (null if never).
function lastUserAt(id) {
  return t3Query(`${messagesSql} where thread_id=? and role='user' order by created_at desc limit 40`, [id]).find(fromUser)?.created_at ?? null;
}
function userWrote(id, since) {
  return t3Query(`${messagesSql} where thread_id=? and role='user' and created_at > ? order by created_at`, [id, since ?? ""]).find(fromUser) ?? null;
}
// Claude threads whose latest run failed on the usage limit in this window (T3 classifies the
// error; a later completed run clears it).
function limitedThreads(windowStart, threads = openThreads()) {
  return threads.filter((t) => isClaude(t.model_selection_json) && !knownWorker(t) && t.last_error_class === "usage_limit"
    && limitHit({ hitAt: t.turn_completed_at, completedAt: null, windowStart }))
    .map((t) => ({ ...t, hit_at: t.turn_completed_at }));
}
const LIVE = ["preparing", "queued", "starting", "running", "waiting"];
const running = (t) => t.busy ?? LIVE.includes(t.turn_state);
// Paused by the usage limit: T3 snoozed it until the reset and resumes it then (its limit
// recovery sends "Continue where you left off." once the reset passes and no snooze holds it).
// The pacer never wakes, unsnoozes, re-snoozes, compacts or hands back such a thread before the reset.
// Held by T3's usage-limit recovery until a newer run supersedes the limited one: T3's resume
// lands some time after the reset, and it skips a thread snoozed past now, so the reset time
// alone isn't the end of the hold.
export const limitPaused = (t) => t?.last_error_class === "usage_limit";
// T3's limit recovery can miss a thread: a second limited run 2 s after the first can
// leave the recovery pointing at the older run, and T3 never resumes it. Past the reset plus
// RESUME_GRACE_MS, the pacer sends T3's own resume text, once per thread and reset. A thread
// held by a snooze (the user's or the pacer's) is left alone, as T3 would, and so is one the pacer took
// for its own resume (`pending`, state.limitResumes): that one goes through the wake rule.
const RESUME_GRACE_MS = 10 * 60 * 1000;
export const missedResumes = (threads, resumed = {}, now = Date.now(), pending = {}) => threads.filter((t) => isClaude(t.model_selection_json) && !knownWorker(t)
  && limitPaused(t) && !running(t) && Date.parse(t.usage_limit_reset_at ?? "") + RESUME_GRACE_MS < now
  && !snoozeSet(t, now) && resumed[t.thread_id] !== t.usage_limit_reset_at && !pending[t.thread_id]);

// At a reset T3 resumes every limited thread at once, which can burn a third of the new window
// within the hour. So the first tick that sees a main (non-worker) Claude thread
// stopped by the limit, before its reset, snoozes it to the reset + LIMIT_SNOOZE_MS (T3 skips a
// thread snoozed past now) and records a pending resume in state.limitResumes. After the reset
// the pacer resumes it with T3's own text through the wake rule, ahead of queue entries, one per
// tick. Pacer down: the snooze runs out and T3 resumes it 30 min late; nothing is lost. Workers
// stay T3's, and so do queued threads (the queue wakes them as usual) and threads already held
// by a longer snooze (the user's or the pacer's).
export const LIMIT_SNOOZE_MS = 30 * MIN;
export const RESUME_TEXT = "Continue where you left off.";
export const limitTakes = (threads, { pending = {}, resumed = {}, queued = new Set(), now = Date.now() } = {}) => threads.filter((t) => {
  const reset = Date.parse(t.usage_limit_reset_at ?? "");
  return isClaude(t.model_selection_json) && !knownWorker(t) && limitPaused(t) && !running(t) && now < reset
    && !pending[t.thread_id] && resumed[t.thread_id] !== t.usage_limit_reset_at && !queued.has(t.thread_id)
    && !(Date.parse(t.snoozed_until ?? "") > reset + MIN);
});
// A pending resume is dropped once the thread is gone, runs again (T3 resumed it after the
// snooze ran out, or the user wrote in it), no longer shows the limit error, or shows a newer
// limit (T3 resumed it and it hit the next window's limit while the pacer was away): limitTakes
// then takes it fresh for the new reset. Returns the reason.
export const limitResumeDrop = (info, entry = {}) => {
  const g = gone(info);
  if (g) return g;
  if (running(info)) return "running again";
  if (!limitPaused(info)) return "no longer stopped by the limit";
  if (entry.resetAt && info.usage_limit_reset_at && info.usage_limit_reset_at !== entry.resetAt) return `a newer limit replaced it (reset ${info.usage_limit_reset_at})`;
  return null;
};
// A pending resume whose snooze runs out within HOLD_AHEAD_MS is snoozed again to now +
// LIMIT_SNOOZE_MS, so T3 never resumes the held threads all at once when the pacer is over pace
// (one at a time, especially when over pace). The pacer resumes each through
// the wake rule; pacer down, the last snooze still runs out and T3 resumes them.
export const HOLD_AHEAD_MS = 10 * MIN;
export const resumeHolds = (pending = {}, snoozedUntil = () => null, now = Date.now()) => Object.entries(pending)
  .filter(([id, r]) => Date.parse(r.resetAt ?? "") <= now + HOLD_AHEAD_MS && !(Date.parse(snoozedUntil(id) ?? "") > now + HOLD_AHEAD_MS))
  .map(([threadId]) => ({ threadId, until: new Date(now + LIMIT_SNOOZE_MS).toISOString() }));
// Pending resumes that are due (now past their reset), in reset order, for picture's ready list.
export const dueResumes = (pending = {}, now = Date.now()) => Object.entries(pending)
  .filter(([, r]) => Date.parse(r.resetAt ?? "") <= now)
  .sort(([, a], [, b]) => Date.parse(a.resetAt) - Date.parse(b.resetAt))
  .map(([threadId, r]) => ({ threadId, title: r.title, resetAt: r.resetAt, resume: true }));

// The wake rule counts threads on a working model (config.json workingModels, default Opus) that
// are working right now, workers included (heavy workers spend as much as their leads). A thread
// works when its turn runs, no native request waits on the user, and no working-model child of
// its own is running (the child does the work). A child is known by its T3 lineage
// (parentThreadId, set for delegate_task children). Threads on other models or providers never
// count and never take a parent out.
const modelOf = (t) => t.model_selection?.model ?? (() => { try { return JSON.parse(t.model_selection_json ?? "{}").model ?? ""; } catch { return ""; } })();
export const isWorkingModel = (t, patterns = readConfig().workingModels ?? DEFAULTS.workingModels) =>
  isClaude(t.model_selection_json) && patterns.some((p) => new RegExp(p, "i").test(modelOf(t)));
// A thread id short enough for a log line: a uuid's first 8, a delegate_task child's job tail
// (`thread:delegated-task:…%3Adelegate-task%3A<job>` would all read "thread:d").
export const logId = (id) => String(id).startsWith("thread:delegated-task:") ? decodeURIComponent(String(id)).split(":").pop() : String(id).slice(0, 8);
export function workingThreads(threads, isRunning = running, patterns = undefined) {
  const live = (t) => isWorkingModel(t, patterns) && isRunning(t) && !pendingRequest(t);
  const parents = new Set(threads.filter(live).map((t) => t.lineage?.parentThreadId).filter(Boolean));
  return threads.filter((t) => live(t) && !parents.has(t.thread_id))
    .map((t) => ({ threadId: t.thread_id, title: short(t), why: knownWorker(t) ? "worker turn running" : "turn running" }));
}
// Snoozed as T3 shows it (its server-side isSnoozed, the sidebar's twin): a snooze still in the
// future, with no pending request and no run that failed, or completed, after it was set. The
// server keeps `snoozed_until` meanwhile. enqueue/pause snooze inside the thread's own turn, so
// that turn always ends after the snooze; the tick then snoozes it again.
export const snoozed = (t, now = Date.now()) => {
  if (!(Date.parse(t.snoozed_until ?? "") > now)) return false;
  if (pendingRequest(t)) return false;
  const at = Date.parse(t.snoozed_at ?? "");
  const done = Date.parse(t.turn_completed_at ?? "");
  if (t.turn_state === "failed" && (!Number.isFinite(at) || done > at)) return false;
  return !(t.turn_state === "completed" && Number.isFinite(at) && done > at);
};
// A queued lead due a hand-off whose newest turn started after it paused and has
// ended: its delegate_task child's report ran. The pause's deferred snooze can land after that
// turn and hide it (snoozedAt moves past it), so the tick reads it from the run, not the snooze.
export const reportRan = (entry, t) => !!entry?.handoffDue && !!t && !running(t)
  && Date.parse(t.latest_run_requested_at ?? "") > Date.parse(entry.handoffDue.at) && Number.isFinite(Date.parse(t.turn_completed_at ?? ""));
// The server still holds a snooze (hand-backs clear it even when the sidebar shows it awake).
const snoozeSet = (t, now = Date.now()) => Date.parse(t.snoozed_until ?? "") > now;
const gone = (t) => !t ? "deleted" : t.deleted_at ? "deleted" : t.archived_at ? "archived" : t.settled_at ? "settled" : null;
const short = (t) => (t?.title ?? "").slice(0, 60);

// Delegated workers: isWorker (t3-api.mjs) knows them by their `thread:delegated-task:…` id;
// T3's delegate_task children also carry a "subagent" lineage. Pass a thread view or an id.
const knownWorker = (t) => typeof t === "string" ? isWorker(t) : isWorker(t.thread_id) || t.lineage?.relationshipToParent === "subagent";

// The T3 thread this agent runs in (from its Codex or Claude Code session id), or --thread.
function resolveThread(explicit) {
  if (explicit && isWorker(explicit)) throw new Error("refusing a delegated worker thread");
  if (explicit && !uuid.test(explicit)) throw new Error("--thread requires an exact T3 thread UUID");
  const id = explicit ?? currentThread();
  if (!id) throw new Error("pass --thread <T3 thread ID>; this session isn't a T3 Codex or Claude thread");
  return id;
}

// The Claude instance's 5 h session window; falls back to T3's cached probe if the refresh fails.
// `cached` reads only the cached probe (list and report, which just need day or night).
function claudeWindow(cached = false) {
  let out;
  try { if (cached) throw new Error("cached"); out = execFileSync(process.execPath, [usageScript, "--json"], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { out = execFileSync(process.execPath, [usageScript, "--json", "--cached"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }); }
  const instance = local().claudeInstance;
  const account = JSON.parse(out).find((a) => a.instance === instance);
  if (!account) throw new Error(`no usage data for ${instance}`);
  return account.windows.find((w) => /^Session\b/.test(w.label)) ?? null;
}

const send = (command, label) => t3Command({ commandId: randomUUID(), ...command }, label);
// Pacer messages go in as an agent's (createdBy "agent"), on the thread's own model. "start"
// starts a turn now (wake, /compact); "queue" waits for a running turn (the ask to pause).
async function turn(info, text, mode = "start") {
  const model = info.model_selection ?? JSON.parse(info.model_selection_json ?? "{}");
  if (!model?.instanceId || !model?.model) throw new Error("thread lacks a model selection");
  await sendMessage(info.thread_id, text, { mode, createdBy: "agent", modelSelection: model, label: "pacer" });
}
const snoozeWeek = (id) => snoozeThread(id, new Date(Date.now() + SNOOZE_MS).toISOString());

// Snooze for 7 days. T3 before 0.1.0 refused for the 2 min after a message whose turn hadn't
// started; then a detached process retries until it lands (or the user writes in the thread).
// T3 wakes a snoozed thread when a run completes after the snooze, and enqueue/pause usually
// run inside the thread's own turn: then the helper snoozes it again once that turn ends.
// A thread paused by the usage limit keeps T3's snooze to the reset (a week's would stop T3
// resuming it).
async function snooze(info, enqueuedAt) {
  if (limitPaused(info)) return `not snoozed: paused by the usage limit; T3 resumes it after ${info.usage_limit_reset_at}`;
  const later = (extra = []) => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    spawn(process.execPath, [path.join(here, "pacer.mjs"), "snooze-later", "--thread", info.thread_id, "--since", info.latest_user_message_at ?? "", "--enqueued", enqueuedAt, ...extra],
      { detached: true, stdio: ["ignore", fs.openSync(path.join(stateDir, "snooze-later.log"), "a"), "ignore"] }).unref();
  };
  try { await snoozeWeek(info.thread_id); }
  catch (e) {
    if (!/queued turn start/.test(e.message)) throw e;
    later();
    return "snoozes once T3 accepts it (a turn start is queued)";
  }
  if (!running(info)) return "snoozed";
  later(["--after-turn"]);
  return "snoozed; snoozed again when this turn ends (T3 wakes it otherwise)";
}
async function disableAutoSettle(id) {
  try { await send({ type: "thread.auto-settle.set", threadId: id, enabled: false }, "pacer"); return true; }
  catch (e) { log("auto-settle-failed", { threadId: id, error: e.message }); console.error(`auto-settle off failed (logged): ${e.message}`); return false; }
}

// The triage thread: a main thread (Opus high, on t3.mainInstance) in the configured project.
async function createTriageThread(triage, pass, { resume }) {
  await createMainThread({ threadId: pass.threadId, messageId: pass.messageId, projectId: projectFor([triage.project]), title: triageTitle(pass.count, triage),
    text: triageText(pass.count, triage), modelSelection: mainModelSelection("opus", "high"), resume });
}
// Triage threads from the last week, plus every one still open however old (an open one blocks a
// pass): titled "Triag…", or whose first message starts with triage / /triage or with the
// configured message's fixed start. A first message that is a markdown brief ("# …") and
// workers don't count.
const fixedStart = (template) => template.split("{")[0].trim().toLowerCase();
export const isTriageThread = (title, first, message = TRIAGE_DEFAULTS.message) => /^triag/i.test(title ?? "")
  || (!/^\s*#/.test(first ?? "") && (/^\s*[/$]?triag(e|ing)\b/i.test(first ?? "")
    || (fixedStart(message).length > 3 && (first ?? "").trim().toLowerCase().startsWith(fixedStart(message)))));
export const TRIAGE_RUNS_SQL = `select thread_id, title, created_at, deleted_at, archived_at, settled_at, relationship, first from (
      select t.thread_id, t.title, t.created_at, t.deleted_at, json_extract(t.payload_json, '$.archivedAt') as archived_at,
        json_extract(t.payload_json, '$.lineage.relationshipToParent') as relationship,
        case when json_extract(t.payload_json, '$.settledAt') is not null or json_extract(t.payload_json, '$.settledOverride') = 'settled'
          then coalesce(json_extract(t.payload_json, '$.settledAt'), t.updated_at) end as settled_at,
        (select substr(json_extract(m.payload_json, '$.text'), 1, 300) from orchestration_v2_projection_messages m
          where m.thread_id=t.thread_id and m.role='user' order by m.created_at, m.message_id limit 1) as first
      from orchestration_v2_projection_threads t)
    where created_at > ? or (deleted_at is null and archived_at is null and settled_at is null)`;
// T3 writes "…Z"; a time without an offset is read as UTC.
const utc = (t) => (t && !/(Z|[+-]\d\d:?\d\d)$/i.test(t) ? `${t}Z` : t);
export const triageRunsFrom = (rows, worker = () => false, message = undefined) => rows
  .filter((r) => !worker({ thread_id: r.thread_id, lineage: { relationshipToParent: r.relationship } }) && isTriageThread(r.title, r.first, message))
  .map((r) => ({ threadId: r.thread_id, title: r.title, createdAt: utc(r.created_at), open: !gone(r) }));
function triageRuns() {
  const since = new Date(Date.now() - 7 * 1440 * MIN).toISOString();
  return triageRunsFrom(t3Query(TRIAGE_RUNS_SQL, [since]), knownWorker, readConfig().triage?.message);
}
// A config command's stdout; a failure throws with its exit and stderr tail.
function shell(name, command) {
  const r = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 60000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim().slice(-200)}` : ""}`);
  return r.stdout;
}
async function triage(state, window, dryRun) {
  const cfg = readConfig().triage;
  if (!cfg) return { state, say: [] };
  const { windowId } = paceOf(window);
  const windowStart = windowId ? Date.parse(window.resetsAt) - WINDOW_MS : Date.now() - WINDOW_MS;
  const check = () => shell("checkCommand", cfg.checkCommand);
  const rule = { minItems: cfg.minItems ?? TRIAGE_RULE.minItems, everyHours: cfg.everyHours ?? TRIAGE_RULE.everyHours };
  const r = await triageTick({ state, windowId, windowStart, dryRun, rule, cfg,
    deps: { check, newId: randomUUID, save: writeState, create: (pass, o) => createTriageThread(cfg, pass, o), isOpen: (id) => !gone(threadInfo(id)), runs: triageRuns, log } });
  if (r.state !== state && !dryRun) writeState(r.state);
  return r;
}

// `triage --now [--json]`: triageNow under the queue lock.
async function triageNowCommand() {
  if (!flag("--now")) throw new Error("usage: pacer.mjs triage --now [--json]");
  const cfg = readConfig().triage;
  if (!cfg) throw new Error("no \"triage\" in config.json");
  const check = () => shell("checkCommand", cfg.checkCommand);
  const result = await withLock(async () => {
    const r = await triageNow({ state: readState(), cfg,
      deps: { check, newId: randomUUID, save: writeState, create: (pass, o) => createTriageThread(cfg, pass, o), isOpen: (id) => !gone(threadInfo(id)), runs: triageRuns, log } });
    return r.result;
  });
  console.log(flag("--json") ? JSON.stringify(result) : result.message);
}

// The newest run in the last 30 min that failed on Claude's login, or null.
function claudeAuthFailure(now = Date.now()) {
  const since = new Date(now - 30 * 60000).toISOString();
  const hit = listThreads().filter((t) => t.status === "failed" && (t.latestRunCompletedAt ?? "") > since && /could not authenticate/i.test(t.lastError ?? ""))
    .sort((a, b) => (b.latestRunCompletedAt > a.latestRunCompletedAt ? 1 : -1))[0];
  return hit ? { at: hit.latestRunCompletedAt, error: hit.lastError } : null;
}
function claudeCreds() {
  const file = path.join(local().claudeConfigDir, ".credentials.json");
  try { return { mtimeMs: Math.round(fs.statSync(file).mtimeMs), refreshTokenExpiresAt: JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth?.refreshTokenExpiresAt ?? null }; }
  catch { return null; }
}

// A chain step's T3 model selection.
const emergencySelection = (cfg, step = 0) => {
  const c = emergencyChain(cfg)[step];
  return { instanceId: c.instance ?? local().mainInstance, model: c.model, ...(c.options ? { options: c.options } : {}) };
};

// The "emergency" config; without one, the pacer causes still start a thread in the triage
// project (a pacer self-fixer), with no check, text or post.
function emergencyConfig(cfg = readConfig()) {
  return cfg.emergency ?? (cfg.triage?.project ? { project: cfg.triage.project } : null);
}
function readEmergency() {
  try { return JSON.parse(fs.readFileSync(emergencyFile, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
function writeEmergency(s) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${emergencyFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, emergencyFile);
}
// Runs a config command through sh. `args` are appended as "$@" (never pasted into the shell
// string), `input` goes to stdin.
function runCommand(name, command, { args = [], input, timeout = 30000 } = {}) {
  const r = spawnSync("sh", ["-c", `${command} "$@"`, "sh", ...args], { input, encoding: "utf8", timeout });
  if (r.error) throw new Error(`${name}: ${r.error.code === "ETIMEDOUT" ? `timed out after ${timeout / 1000} s` : r.error.message}`);
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}${r.stderr?.trim() ? `: ${r.stderr.trim().slice(-200)}` : ""}`);
  return r.stdout;
}
// textCommand gets the line and `--key <key>` (one key per event, for a notifier that dedupes).
function textUser(cfg, line, key) {
  if (!cfg.textCommand) throw new Error("no \"textCommand\" in emergency config");
  runCommand("textCommand", cfg.textCommand, { args: [line, "--key", key] });
}
// One emergency step, called with the queue lock held (or dry). failing/blind: the pacer's own
// streaks; check: run checkCommand (once per tick: the catch path skips it if the normal path ran it).
async function emergency({ failing = 0, blind = 0, error = null, check = true, dryRun = false }) {
  const cfg = emergencyConfig();
  if (!cfg?.project) return { say: [] };
  const say = [];
  let causes = [];
  if (check && cfg.checkCommand) {
    try { causes = parseCauses(runCommand("checkCommand", cfg.checkCommand, { timeout: 20000 })); }
    catch (e) { if (!dryRun) log("emergency-check-error", { error: e.message, why: `check failed: ${e.message}; pacer causes still count` }); say.push(`emergency-check-error: ${e.message}`); }
  }
  causes = [...causes, ...pacerCauses({ failing, blind, error, stuck: stillQueued(stuckWake(readLog().slice(-200))) })];
  const state = readEmergency();
  const r = await emergencyTick({ state, causes, cfg, dryRun, deps: {
    isOpen: (id) => !gone(threadInfo(id)), newId: randomUUID, save: writeEmergency, log,
    failed: (id) => { const t = getThread(id); return t && !t.busy && t.status === "failed" ? t.lastError || t.lastErrorClass || "its run failed" : null; },
    create: async ({ threadId, messageId, title, text, resume, step, settle }) => {
      await createMainThread({ threadId, messageId, projectId: projectFor([cfg.project]), title, text, resume, modelSelection: emergencySelection(cfg, step) });
      if (settle && !getThread(settle)?.settled) await settleThread(settle);
    },
    text: (line, key) => textUser(cfg, line, key),
    post: (line) => { if (!cfg.postCommand) throw new Error("no \"postCommand\" in emergency config"); runCommand("postCommand", cfg.postCommand, { input: line }); },
  } });
  if (r.state !== state && !dryRun) writeEmergency(r.state);
  const l = await claudeLoginTick({ state: r.state, failure: claudeAuthFailure(), creds: claudeCreds(), configDir: local().claudeConfigDir, dryRun,
    deps: { log, text: (line, key) => textUser(cfg, line, key) } });
  if (l.state !== r.state && !dryRun) writeEmergency(l.state);
  if (!say.length && !causes.length && !r.say.length && !l.say.length) say.push("normal: nothing tripped");
  return { say: [...say, ...r.say, ...l.say] };
}

// ---------------------------------------------------------------------------
// Live picture: usage, active threads, queue
// ---------------------------------------------------------------------------

// Usage vs the pace line now (a cap's line included), day or night by the window and the sleep file.
const paceNow = (state, window, now, cfg, sleep) => capPace(paceOf(window, now, cfg, { codingNight: sleep.night }), state.cap, window?.resetsAt, now, cfg);

// Main Claude threads as a tick counts them: active (counted; ready ones can be asked to pause),
// waiting on the user (not counted) and paused by the usage limit (`pacer`: the pacer took it and
// resumes it after the reset, else T3 does).
function classify(state, threads, now, asked = openAsks()) {
  const queued = new Set(state.queue.map((e) => e.threadId));
  const entries = new Map(state.queue.map((e) => [e.threadId, e]));
  const active = [];
  const waitingOnUser = [];
  const paused = [];
  for (const t of threads) {
    if (!isClaude(t.model_selection_json) || knownWorker(t)) continue;
    if (limitPaused(t)) { paused.push({ threadId: t.thread_id, title: short(t), resetAt: t.usage_limit_reset_at, queued: queued.has(t.thread_id), pacer: !!state.limitResumes?.[t.thread_id] }); continue; }
    if (snoozed(t, now) && !reportRan(entries.get(t.thread_id), t)) continue;
    const w = state.woken[t.thread_id];
    const a = activity({ running: running(t), pending: pendingRequest(t), completedAt: t.turn_completed_at, wokenAt: w?.wokenAt, now, asked: asked.has(t.thread_id) });
    if (a?.waiting && !queued.has(t.thread_id)) waitingOnUser.push({ threadId: t.thread_id, title: short(t) });
    if (a?.why) active.push({ threadId: t.thread_id, title: short(t), why: a.why, running: running(t), pacerWoken: !!w, wokenAt: w?.wokenAt,
      askedWindow: state.asked?.[t.thread_id], userAt: lastUserAt(t.thread_id), queued: queued.has(t.thread_id), ready: isReady(state, t.thread_id) });
  }
  return { active, waitingOnUser, paused };
}

function picture(state, window, now = Date.now(), sleep = null) {
  const cfg = readConfig();
  sleep ??= readSleep(cfg, now);
  const p = paceNow(state, window, now, cfg, sleep);
  const threads = openThreads();
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  const asked = openAsks();
  const { active, waitingOnUser, paused } = classify(state, threads, now, asked);
  // A queued thread with a question for the user open, or a pending native request, is
  // never woken; the next tick hands it back to the user (reconcileQueue).
  const deps = depsOf(state);
  const queue = queueRows(state, { now, cfg, night: p.night, deps }).map(({ e, rank: r }) => ({ ...e, info: byId.get(e.threadId) ?? null, rank: r, blockedBy: deps.blockedBy.get(e.threadId) ?? null }))
    .map((e) => ({ ...e, onUser: !!e.info && waitsOnUser(e.info, asked.has(e.threadId)) }));
  // A queued thread paused by the usage limit isn't work the pacer can start: T3 resumes it.
  // A main thread the pacer took at the limit (state.limitResumes) is resumed by it once the reset
  // passes: those come first in `ready`, oldest reset first.
  // A lead at handoffCompactions or more is handed off instead of woken; while it has a
  // running delegate_task child it isn't woken at all, so the child's report finds it.
  const wakeable = queue.filter((e) => e.info && !running(e.info) && !e.onUser && !e.blockedBy && !limitPaused(e.info) && !waitingUntil(e, now))
    .map((e) => { const n = compactionCount(e.threadId); return n >= cfg.handoffCompactions ? { ...e, handoff: { compactions: n, children: runningChildren(threads, e.threadId, running) } } : e; });
  const resumes = dueResumes(state.limitResumes, now).filter((r) => byId.get(r.threadId) && !limitResumeDrop(byId.get(r.threadId), r))
    .map((r) => ({ ...r, info: byId.get(r.threadId) }));
  const ready = [...resumes, ...wakeable.filter((e) => !e.handoff?.children.length)];
  const working = workingThreads(threads);
  const handoffWaits = wakeable.filter((e) => e.handoff?.children.length);
  // Awake leads at the threshold: one "hand off now" turn per compaction level once a turn ends.
  // A queued lead counts too when it paused due a hand-off and a turn ran since (its delegate_task
  // child's report woke it).
  const due = new Set(state.queue.filter((e) => e.handoffDue).map((e) => e.threadId));
  const handoffAsks = active.filter((a) => a.ready && (!a.queued || due.has(a.threadId)) && !handedOff(state, a.threadId)).flatMap((a) => {
    const compactions = compactionCount(a.threadId);
    const ask = handoffAsk({ compactions, threshold: cfg.handoffCompactions, asked: state.handoffAsked?.[a.threadId] ?? 0, running: a.running, recentTurn: a.why === "turn ended < 20 min ago",
      children: runningChildren(threads, a.threadId, running), held: state.held, userAt: a.userAt, asks: asked.get(a.threadId)?.length ?? 0, now });
    return ask ? [{ threadId: a.threadId, title: a.title, compactions, plan: leadPlan(state, a.threadId), ...ask }] : [];
  });
  // Only while the window is open: a stale window (past its reset, usage not refreshed yet) would
  // count the threads limited in the last window and block their own resumes.
  const limited = p.night && p.windowId ? limitedThreads(new Date(Date.parse(window.resetsAt) - WINDOW_MS).toISOString(), threads) : [];
  return { window, ...p, cfg, sleep, threads, byId, active, working, resumes, waiting: queue.length + resumes.length, waitingOnUser, paused, queue, ready, handoffWaits, handoffAsks, onUser: queue.filter((e) => e.onUser),
    blocked: queue.filter((e) => e.blockedBy && !e.onUser).length, later: queue.filter((e) => waitingUntil(e, now) && !e.onUser && !e.blockedBy).length, limitQueued: queue.filter((e) => e.info && limitPaused(e.info) && !e.onUser && !e.blockedBy).length, limited };
}

// Queue and woken records whose thread was settled, archived or deleted leave the state. So
// does a thread the user wrote in since the pacer woke it: it is the user's again ("handoff"); it
// stays awake and paced like any active thread. The user writing in a queued thread is decided by
// reconcileQueue (handed back only if the reply asks the user). Asks from an earlier window are forgotten.
function prune(state, windowId, dryRun) {
  const dropped = [];
  for (const e of state.queue) {
    const info = threadInfo(e.threadId);
    if (gone(info)) dropped.push({ event: "drop", threadId: e.threadId, title: e.title, plan: e.plan, why: `thread ${gone(info)}` });
  }
  for (const [id, w] of Object.entries(state.woken)) {
    const info = threadInfo(id);
    if (gone(info)) dropped.push({ event: "finished", threadId: id, title: w.title, plan: w.plan, why: `thread ${gone(info)}` });
    else if (userWrote(id, w.wokenAt)) dropped.push({ event: "handoff", threadId: id, title: w.title, plan: w.plan, why: "the user wrote in it after the pacer woke it; it's theirs again" });
  }
  const asked = Object.fromEntries(Object.entries(state.asked ?? {}).filter(([, win]) => sameWindow(win, windowId)));
  const askedChanged = Object.keys(asked).length !== Object.keys(state.asked ?? {}).length;
  let ready = Object.fromEntries(Object.entries(state.ready ?? {}).filter(([id]) => !gone(threadInfo(id))));
  // A woken lead the user took over keeps its queue fields, so its next `pause` keeps its place.
  const at = new Date().toISOString();
  for (const d of dropped) if (d.event === "handoff") ready = withHandedBack(ready, d.threadId, state.woken[d.threadId], at, "the user wrote in it after the pacer woke it");
  const readyChanged = Object.keys(ready).length !== Object.keys(state.ready ?? {}).length;
  const handoffAsked = Object.fromEntries(Object.entries(state.handoffAsked ?? {}).filter(([id]) => ready[id]));
  const handoffAskedChanged = Object.keys(handoffAsked).length !== Object.keys(state.handoffAsked ?? {}).length;
  // A built plan's line leaves once its lead is settled (the check ran); one without a thread after a week.
  const built = Object.fromEntries(Object.entries(state.built ?? {}).filter(([, b]) => b.threadId ? !gone(threadInfo(b.threadId)) : Date.parse(b.at) > Date.now() - 7 * 86400000));
  const builtChanged = Object.keys(built).length !== Object.keys(state.built ?? {}).length;
  const planAges = tidyPlanAges(state, (id) => !gone(threadInfo(id)));
  const agesChanged = Object.keys(planAges).length !== Object.keys(state.planAges ?? {}).length;
  if (!dropped.length && !askedChanged && !readyChanged && !handoffAskedChanged && !builtChanged && !agesChanged) return state;
  const ids = new Set(dropped.map((d) => d.threadId));
  for (const d of dropped) { if (!dryRun) log(d.event, d); console.log(`${dryRun ? "would " : ""}${d.event} ${d.threadId} ${d.title ?? ""} (${d.why})`); }
  const next = { ...state, asked, ready, handoffAsked, built, planAges, queue: state.queue.filter((e) => !ids.has(e.threadId)), woken: Object.fromEntries(Object.entries(state.woken).filter(([id]) => !ids.has(id))) };
  if (!dryRun) writeState(next);
  return next;
}

// Every tick (inside the lock): hand back queued threads waiting on the user, and snooze again
// the ones that came unsnoozed (same 7 days as enqueue).
async function reconcileQueue(state, dryRun) {
  let next = state;
  for (const e of state.queue) {
    const info = threadInfo(e.threadId);
    if (gone(info)) continue;
    // T3 holds a thread paused by the usage limit until the reset; the pacer leaves it alone.
    if (limitPaused(info)) { if (dryRun) console.log(`leaves ${e.threadId} ${short(info)} alone (paused by the usage limit until ${info.usage_limit_reset_at})`); continue; }
    const wrote = userWrote(e.threadId, e.enqueuedAt);
    const lastWrote = wrote ? lastUserAt(e.threadId) : null;
    const act = queuedAction({ snoozed: snoozed(info), running: running(info), pending: pendingRequest(info),
      asks: !running(info) && askedOf(e.threadId).length > 0, userWrote: !!wrote, answered: !wrote || repliedSince(e.threadId, lastWrote) });
    // A failed hand-back mark is cleared once the thread no longer waits on the user.
    if (!act?.handBack && e.handbackFailed) next = { ...next, queue: next.queue.map((q) => q.threadId === e.threadId ? { ...q, handbackFailed: undefined } : q) };
    if (!act) continue;
    const name = `${e.threadId} ${short(info)}`;
    if (act.wait) { if (dryRun) console.log(`resnooze waits ${name} (${act.wait})`); continue; }
    if (act.handBack) {
      const steps = snoozeSet(info) ? "unsnooze" : "no snooze to lift";
      if (dryRun) { console.log(`would hand back ${name} (${act.handBack}; ${steps})`); next = { ...next, queue: next.queue.filter((q) => q.threadId !== e.threadId) }; continue; }
      const r = await handBackEntry(next, e.threadId, { snoozed: snoozeSet(info), unsnooze: unsnoozeThread });
      next = r.state;
      if (r.ok) {
        log("handoff", { threadId: e.threadId, title: short(info), plan: e.plan, why: `${act.handBack}; ${steps}` });
        console.log(`handed back ${name} (${act.handBack}; ${steps})`);
      } else {
        log("handback-failed", { threadId: e.threadId, title: short(info), plan: e.plan, error: r.error, why: "kept in the queue; retries next tick" });
        console.log(`couldn't hand back ${name}: ${r.error}; retrying next tick`);
      }
      continue;
    }
    // A queued lead due a hand-off whose child's report just ran a turn stays awake for this
    // tick's "hand off now" turn (picture → handoffAsks); after it, it is snoozed as usual.
    if (e.handoffDue && !handedOff(next, e.threadId) && handoffAsk({ compactions: compactionCount(e.threadId), threshold: readConfig().handoffCompactions, asked: next.handoffAsked?.[e.threadId] ?? 0,
      recentTurn: Date.now() - Date.parse(info.turn_completed_at ?? "") < RECENT_TURN_MS, children: runningChildren(openThreads(), e.threadId, running), held: next.held, userAt: lastUserAt(e.threadId), asks: askedOf(e.threadId).length })?.due) {
      console.log(`left ${name} awake: due a hand-off; told to hand off on this tick`);
      continue;
    }
    if (dryRun) { console.log(`would resnooze ${name} (${act.resnooze})`); continue; }
    try {
      await snoozeWeek(e.threadId);
      log("resnooze", { threadId: e.threadId, title: short(info), plan: e.plan, why: act.resnooze });
      console.log(`resnoozed ${name} (${act.resnooze})`);
    } catch (err) { log("resnooze-failed", { threadId: e.threadId, title: short(info), error: err.message, why: "retries next tick" }); }
  }
  if (next !== state && !dryRun) writeState(next);
  return next;
}

export const wakeText = (used, pace, plan, asleep = false) => `Pacer: your turn (usage ${used}% vs pace ${pace}%). Resume from ${plan} § Resume. Before starting a Claude Opus worker, read \`node ~/.agents/skills/pacer/scripts/pacer.mjs status\`; if it shows working at or over the cap, start one at most. When you finish or need the user, end your turn. If nothing can move until a known time (a job finishes, another tool's limit resets), run \`node ~/.agents/skills/pacer/scripts/pacer.mjs pause --plan <plan path> --until <HH:MM or +90m>\` and stop, so the pacer wakes other work until then.${asleep ? `\n\n${ASLEEP_LINE}` : ""}`;
export const askText = (used, pace) => `Pacer: over pace (${used}% vs ${pace}%). Finish the step you're in: let a running Claude worker finish, don't start a new one. Once it's done, if your next step runs outside this Claude window (another tool or provider with its own limit), start it before you pause; it runs while you sleep and its result waits for you when you're woken. Make sure your plan's Resume section is complete (stages, decisions, next step, open risks) and nothing in it waits on the user. Then run \`node ~/.agents/skills/pacer/scripts/pacer.mjs pause --plan <plan path>\` and stop. The pacer then compacts this thread (/compact), so anything the next step needs must be in the plan.`;

async function wake(state, entry, info, used, pace, reason, { source = null, ...extra } = {}, asleep = false) {
  if (limitPaused(info)) throw new Error(`paused by the usage limit; T3 resumes it after ${info.usage_limit_reset_at}`);
  try { await unsnoozeThread(info.thread_id); }
  catch (e) { log("unsnooze-failed", { threadId: info.thread_id, error: e.message }); }
  // A thread made by a pause-path hand-off starts on the take-over brief (it has no history).
  await turn(info, entry.takeover ? handoffText({ from: entry.takeover.from, compactions: entry.takeover.compactions, plan: entry.plan, wake: { used, pace }, asleep }) : wakeText(used, pace, entry.plan, asleep));
  const next = { ...state, ...extra, lastWakeAt: new Date().toISOString(), queue: state.queue.filter((e) => e.threadId !== entry.threadId),
    woken: { ...state.woken, [entry.threadId]: { plan: entry.plan, title: short(info), priority: entry.priority, size: entry.size ?? null,
      firstQueuedAt: entry.firstQueuedAt ?? entry.enqueuedAt, wokenAt: new Date().toISOString(), pauses: entry.pauses ?? 0, note: entry.note } } };
  writeState(next);
  log("wake", { threadId: entry.threadId, title: short(info), plan: entry.plan, used, pace, reason, ...(source ? { source } : {}), ...(asleep ? { asleep: true } : {}) });
  console.log(`woke ${entry.threadId} ${short(info)} (${entry.plan})`);
}

// A limit resume: unsnooze the thread the pacer took at the limit and send T3's
// own resume text. It counts as a wake for the settle; it isn't a pacer-woken lead (no woken record).
async function resumeLimited(state, entry, used, pace, d, extra = {}) {
  try { await unsnoozeThread(entry.threadId); }
  catch (e) { log("unsnooze-failed", { threadId: entry.threadId, error: e.message }); }
  await turn(entry.info, RESUME_TEXT);
  const { [entry.threadId]: _, ...rest } = state.limitResumes ?? {};
  const next = { ...state, ...extra, lastWakeAt: new Date().toISOString(), limitResumes: rest, resumed: { ...state.resumed, [entry.threadId]: entry.resetAt } };
  writeState(next);
  log("wake", { threadId: entry.threadId, title: short(entry.info), used, pace, reason: d.reason, source: "resume", resetAt: entry.resetAt });
  console.log(`resumed ${entry.threadId} ${short(entry.info)} (stopped by the usage limit, reset ${entry.resetAt})`);
  return next;
}

// ---------------------------------------------------------------------------
// Lead hand-off
// ---------------------------------------------------------------------------
// A lead is a thread with a pacer plan entry (queued, woken or ready); the user's own threads have
// none and are never handed off. A lead at handoffCompactions (3) or more moves to a fresh main
// thread: same title, project and model selection (effort included), pinned, whose brief is the
// plan + "you take over from <old>". Its queue/ready/woken entries move to the new id, the old
// thread is unpinned and settled (once its turn ends, if it is running), and `lead-handoff` is
// logged. It fires by itself: (a) a lead the tick would wake is handed off instead (the new
// thread is what runs); (b) an awake lead whose turn just ended gets one "hand off now" turn per
// compaction level and runs `pacer.mjs handoff` itself. Both wait while the lead has a running
// delegate_task child (its report goes to the thread that made it); `status` says so. A record
// per old thread (state.handoffs), written before the new thread is made and read under the
// queue lock, makes a second run (or a tick racing the lead's own) a no-op; a crash mid-way is
// finished by the next run with the same ids.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const handoffNowText = (compactions, plan) => `Pacer: hand off now (${compactions} compactions) — make Resume current, then run \`node ~/.agents/skills/pacer/scripts/pacer.mjs handoff --plan ${shellQuote(plan)}\`. It starts a fresh thread that takes over from the plan's Resume and settles this one once this turn ends; stop as soon as it prints the new thread. If a step is half done, finish it or write exactly where it stands into Resume first.`;
export const handoffText = ({ from, compactions, plan, wake = null, asleep = false }) => `Pacer: you take over from thread ${from}, which reached ${compactions} compactions${wake ? ` (your turn: usage ${wake.used}% vs pace ${wake.pace}%)` : ""}. Read ${plan} § Resume and continue from there; the plan is the whole hand-over. The old thread is settled; don't write in it. Your pacer entries already point at this thread. Before starting a Claude Opus worker, read \`node ~/.agents/skills/pacer/scripts/pacer.mjs status\`; if it shows working at or over the cap, start one at most. When you finish or need the user, end your turn. If nothing can move until a known time, run \`node ~/.agents/skills/pacer/scripts/pacer.mjs pause --plan ${plan} --until <HH:MM or +90m>\` and stop.${asleep ? `\n\n${ASLEEP_LINE}` : ""}`;
// Running children of a thread: delegate_task children carry it in their T3 lineage.
export const runningChildren = (threads, id, isRunning = (t) => !!t.busy) =>
  threads.filter((t) => t.lineage?.parentThreadId === id && isRunning(t)).map((t) => t.thread_id);
export const handedOff = (state, id) => !!state.handoffs?.[id];
export const leadPlan = (state, id) => state.woken?.[id]?.plan ?? state.queue?.find((e) => e.threadId === id)?.plan ?? state.ready?.[id]?.plan ?? null;
// A thread a hand-off made, and from which thread.
export const handedOffFrom = (state, id) => Object.entries(state.handoffs ?? {}).find(([, r]) => r.to === id)?.[0] ?? null;

// The lead's entries move to the new id. The new thread runs now, so a woken or queued entry
// becomes a woken one (wokenAt = now); a ready-only lead stays ready-only. Asks carry over.
export function moveLead(state, from, to, { title, at = new Date().toISOString() }) {
  const q = state.queue.find((e) => e.threadId === from);
  const w = state.woken[from] ?? q;
  const woken = Object.fromEntries(Object.entries(state.woken).filter(([k]) => k !== from));
  if (w) woken[to] = { plan: w.plan, title, priority: w.priority, size: w.size ?? null, firstQueuedAt: w.firstQueuedAt ?? w.enqueuedAt ?? null, wokenAt: at, pauses: w.pauses ?? 0, note: w.note ?? null };
  const old = state.ready?.[from];
  const ready = Object.fromEntries(Object.entries(state.ready ?? {}).filter(([k]) => k !== from));
  ready[to] = { plan: old?.plan ?? w?.plan, title, readyAt: old?.readyAt ?? at };
  const asked = Object.fromEntries(Object.entries(state.asked ?? {}).map(([k, v]) => [k === from ? to : k, v]));
  const handoffAsked = Object.fromEntries(Object.entries(state.handoffAsked ?? {}).filter(([k]) => k !== from));
  return { ...state, queue: state.queue.filter((e) => e.threadId !== from), woken, ready, asked, handoffAsked, built: builtTo(state.built, from, to, title) };
}
// A hand-off moves the old lead's `built` lines to the new thread, so they outlive its settle.
export const builtTo = (built, from, to, title) => Object.fromEntries(Object.entries(built ?? {}).map(([k, b]) => [k, b.threadId === from ? { ...b, threadId: to, title: title ?? b.title } : b]));

// The pause path's hand-off: the new thread takes the lead's queue entry
// (priority, pause-until, age) and waits in its place, snoozed; the pacer wakes it with the
// take-over brief (`takeover`). The old thread's queue, woken and ready entries go.
export function queueLead(state, from, to, entry, { title, compactions }) {
  const { handoffDue: _, ...rest } = entry;
  const moved = { ...rest, threadId: to, title, takeover: { from, compactions }, lead: true };
  const woken = Object.fromEntries(Object.entries(state.woken).filter(([k]) => k !== from));
  const old = state.ready?.[from];
  const ready = Object.fromEntries(Object.entries(state.ready ?? {}).filter(([k]) => k !== from));
  ready[to] = { plan: old?.plan ?? entry.plan, title, readyAt: old?.readyAt ?? entry.enqueuedAt };
  const asked = Object.fromEntries(Object.entries(state.asked ?? {}).map(([k, v]) => [k === from ? to : k, v]));
  const handoffAsked = Object.fromEntries(Object.entries(state.handoffAsked ?? {}).filter(([k]) => k !== from));
  return { ...state, queue: upsert(state.queue.filter((e) => e.threadId !== from), moved), woken, ready, asked, handoffAsked, built: builtTo(state.built, from, to, title) };
}
// enqueue/pause on a lead (a thread that had a pacer plan entry before, not handed off yet; pass
// compactions 0 otherwise) at the threshold: { handoff } with no running delegate_task child, else
// { due, children }; below it nothing. `children` is read only at the threshold.
export function pauseHandoff({ compactions, threshold = DEFAULTS.handoffCompactions, children }) {
  if (compactions < threshold) return { compactions };
  const kids = children();
  return kids.length ? { due: true, compactions, children: kids } : { handoff: true, compactions };
}
// A /compact for a queued lead due a hand-off is wasted: the thread it would shrink is handed off.
// Whether a queued entry is a lead for the deferred /compact's recount. enqueue marks it; an
// unmarked entry (written before the marker) counts only with evidence that the thread had a
// plan entry before that enqueue: a hand-off's takeover, or a firstQueuedAt / readyAt older than
// the enqueue (the old enqueue set both to the enqueue time for a thread new to the pacer, such as
// one of the user's own). Without it: not a lead, so today's /compact.
export const leadEntry = (state, e) => e.lead ?? (!!e.takeover || Date.parse(e.firstQueuedAt) < Date.parse(e.enqueuedAt)
  || Date.parse(state.ready?.[e.threadId]?.readyAt) < Date.parse(e.enqueuedAt));
export const compactSkip = (entry) => entry?.handoffDue ? `due a hand-off (${entry.handoffDue.compactions} compactions) once its delegate_task child reports; no /compact` : null;

// Whether an awake lead gets its "hand off now" turn this tick: { due } or { wait: why }; null
// below the threshold. One per compaction level (handoffAsked[id] holds the last level asked).
// `asks`: questions for the user this lead still has open; a hand-off waits for the answers, so
// they reach the thread that asked.
export function handoffAsk({ compactions, threshold = DEFAULTS.handoffCompactions, asked = 0, running = false, recentTurn = true, children = [], held = null, userAt = null, asks = 0, now = Date.now() }) {
  if (compactions < threshold) return null;
  if (asked >= compactions) return { wait: `told to hand off at ${asked} compactions; told again at ${asked + 1}` };
  if (held) return { wait: `queue on hold since ${held.since}` };
  if (asks) return { wait: `waits for the user's answer to ${asks} open question${asks > 1 ? "s" : ""}` };
  if (children.length) return { wait: `waits for ${children.length} running delegate_task child${children.length > 1 ? "ren" : ""} (${children.map((c) => c.slice(-24)).join(", ")})` };
  if (running) return { wait: "told to hand off once its turn ends" };
  if (!recentTurn) return { wait: "just woken; told to hand off once its turn ends" };
  const since = now - (Date.parse(userAt ?? "") || 0);
  if (since < USER_RECENT_MS) return { wait: `the user wrote ${Math.floor(since / MIN)} min ago` };
  return { due: true };
}

// Hands one lead off. deps: { create (createMainThread's arguments), unpin, settle, save, log };
// with `queued` (the queue entry the new thread takes, pause path) also createQueued (the thread,
// no message) and park (snooze it). The new thread is pinned only when the old one was pinned
// (`pin` in the record); callers don't hand off while a question is open. `wake` ({ used, pace, extra }) marks a hand-off that
// replaces a tick's wake. Returns { state, to, already?, settled?, queued?, say }. Throws nothing
// for a done record: it says where the lead went.
export async function handOffLead({ state, from, info, plan, compactions, cause, wake = null, asleep = false, queued = null, deps, at = new Date().toISOString() }) {
  // A done record whose old thread is back in the queue is stale: the user wrote in the old thread
  // after the hand-off and it queued itself again (else every tick would "wake" it through the
  // done record and nothing would run). That thread is the live lead; hand it off anew.
  const done = state.handoffs?.[from];
  const prior = done?.done && state.queue?.some((e) => e.threadId === from) ? null : done;
  if (prior?.done) return { state, to: prior.to, already: true, say: `already handed off: ${from} → ${prior.to} at ${prior.at}; nothing new started` };
  // The record keeps everything create needs (project, model, workspace), so a crash recovery
  // after the old thread is gone still makes the same thread in the same checkout.
  const rec = prior ?? { to: randomUUID(), messageId: randomUUID(), plan, title: info.title, compactions, cause, at, done: false, settled: false,
    projectId: info.project_id, modelSelection: info.model_selection ?? null, branch: info.branch ?? null, worktreePath: info.worktree_path ?? null,
    text: handoffText({ from, compactions, plan, wake, asleep }), pin: !!info?.pinned_at, ...(queued ? { queued } : {}) };
  let next = { ...state, handoffs: { ...state.handoffs, [from]: rec } };
  if (!prior) deps.save(next);
  const where = { threadId: rec.to, projectId: rec.projectId ?? info.project_id, title: rec.title, modelSelection: rec.modelSelection ?? info.model_selection,
    branch: rec.branch ?? info.branch ?? null, worktreePath: rec.worktreePath ?? info.worktree_path ?? null, pin: !!rec.pin };
  if (rec.queued) await deps.createQueued(where);
  else await deps.create({ ...where, messageId: rec.messageId, text: rec.text, resume: true });
  const title = (rec.title ?? "").slice(0, 60);
  next = rec.queued ? queueLead(next, from, rec.to, rec.queued, { title, compactions: rec.compactions }) : moveLead(next, from, rec.to, { title });
  if (wake) next = { ...next, ...wake.extra, lastWakeAt: new Date().toISOString() };
  next = { ...next, handoffs: { ...next.handoffs, [from]: { ...rec, done: true } } };
  deps.save(next);
  const parked = rec.queued ? await deps.park(rec.to) : null;
  const r = await settleOld(next, from, info, deps);
  const how = rec.cause === "wake" ? "handed off instead of woken" : rec.cause === "pause" ? "handed off when it paused; the new thread waits in its place in the queue" : "handed off by `pacer.mjs handoff`";
  deps.log("lead-handoff", { threadId: from, to: rec.to, title, plan: rec.plan, compactions: rec.compactions, cause: rec.cause, settled: r.settled, ...(rec.queued ? { queued: true, park: parked } : {}),
    why: `${rec.compactions} compactions; ${how}${r.settled ? "" : `; old thread settles once its turn ends (${r.error})`}` });
  return { state: r.state, to: rec.to, settled: r.settled, queued: !!rec.queued, say: `handed off ${from} → ${rec.to} (${rec.compactions} compactions, ${rec.title}); ${rec.queued ? `the new thread is queued in its place (${parked}); ` : ""}${r.settled ? "old thread unpinned and settled" : `old thread unpinned; settles once its turn ends (${r.error})`}` };
}
// Unpins and settles a handed-off thread. T3 refuses to settle a running thread; then the record
// keeps settled: false and the next tick tries again.
async function settleOld(state, from, info, deps) {
  const rec = state.handoffs[from];
  const mark = (fields) => { const s = { ...state, handoffs: { ...state.handoffs, [from]: { ...state.handoffs[from], ...fields } } }; deps.save(s); return s; };
  if (!info || info.deleted_at || info.archived_at || info.settled_at) return { state: mark({ settled: true }), settled: true };
  if (!rec.unpinned) {
    try { await deps.unpin(from); state = mark({ unpinned: true }); }
    catch (e) { deps.log("lead-handoff-unpin-failed", { threadId: from, error: e.message, why: "retries next tick" }); }
  }
  try { await deps.settle(from); return { state: mark({ settled: true, settledAt: new Date().toISOString() }), settled: true }; }
  catch (e) { return { state, settled: false, error: e.message }; }
}
// The hand-off picture as `status` and the tick summary show it: queued leads due one at their
// wake (or waiting for a child) and awake leads at the threshold.
export function handoffRows(pic) {
  const wakes = [...(pic.ready ?? []), ...(pic.handoffWaits ?? [])].filter((e) => e.handoff).map((e) => ({ threadId: e.threadId, title: e.title ?? "", compactions: e.handoff.compactions,
    why: e.handoff.children.length ? `queued; due a hand-off, waits for ${e.handoff.children.length} running delegate_task child${e.handoff.children.length > 1 ? "ren" : ""} (${e.handoff.children.map((c) => c.slice(-24)).join(", ")}), not woken meanwhile` : "queued; handed off to a fresh thread instead of woken" }));
  const asks = (pic.handoffAsks ?? []).map((h) => ({ threadId: h.threadId, title: h.title ?? "", compactions: h.compactions, why: h.due ? "awake; told to hand off on this tick" : `awake; ${h.wait}` }));
  return [...wakes, ...asks].map((r) => ({ ...r, why: `${r.compactions} compactions, ${r.why}` }));
}
const handoffDeps = () => ({ create: createMainThread, unpin: unpinThread, settle: settleThread, save: writeState, log,
  createQueued: async ({ threadId, projectId, title, modelSelection, branch, worktreePath, pin }) => {
    const t = getThread(threadId);
    if (!t) await createThread({ threadId, projectId, title, modelSelection, branch, worktreePath });
    if (pin && !t?.pinnedAt) await pinThread(threadId);
  },
  // A failed snooze is logged; the tick snoozes a queued thread that isn't (reconcileQueue).
  park: async (id) => {
    let r = "snoozed";
    try { await snoozeWeek(id); } catch (e) { r = `snooze failed (${e.message}); the next tick snoozes it`; log("snooze-failed", { threadId: id, error: e.message, why: "new queued thread from a hand-off; the next tick snoozes it" }); }
    return (await disableAutoSettle(id)) ? `${r}, auto-settle off` : r;
  } });

// delegate_task children of a handed-off lead whose run ended after the hand-off: T3 reports
// a child's result to the thread that delegated it, and skips that thread once it is settled, so
// a fix round the new lead sent to an old child never woke anyone (the new lead would sit for
// hours waiting on a report that had already arrived). `relayed` maps a child to the
// run already passed on ({ runId, at }); `threads` is listThreads' shape. Only while the old lead
// is still settled and hasn't run since (a lead brought back gets its own reports), and only
// reports from the last 6 h: older ones the lead has long moved past. [{ child, to, runId }].
export function handoffRelays(state, threads, now = Date.now()) {
  const since = new Date(now - 6 * 3600000).toISOString();
  const byId = new Map(threads.map((t) => [t.id, t]));
  const out = [];
  for (const c of threads) {
    const from = c.lineage?.parentThreadId;
    const rec = from && state.handoffs?.[from];
    const old = byId.get(from);
    if (!rec?.done || !rec.settled || !old?.settled || c.activeRunId || !c.latestRunId || !c.latestRunCompletedAt) continue;
    if ((old.latestRunCompletedAt ?? "") > c.latestRunCompletedAt) continue;
    if (c.latestRunCompletedAt <= (rec.settledAt ?? rec.at) || c.latestRunCompletedAt < since || state.relayed?.[c.id]?.runId === c.latestRunId) continue;
    out.push({ child: c, to: handoffTarget(state, from), runId: c.latestRunId });
  }
  return out;
}
export const relayText = (child, from, reply) =>
  `Delegated task ${child.id} (${child.title}) [${child.status}], relayed by the pacer: it reported after your hand-off from ${from}, ` +
  `so T3 sent it to that settled thread. Its last reply:\n\n${reply.length > 6000 ? `${reply.slice(0, 6000)}\n… (cut; read the child thread for the rest)` : reply}`;

// Every tick, inside the lock: finish a hand-off a crash left half done, settle old threads whose
// turn has ended, pass on child reports that went to a settled old lead, forget records a week
// after they settled.
async function finishHandoffs(state, dryRun) {
  let next = state;
  const say = [];
  if (Object.values(state.handoffs ?? {}).some((r) => r.done && r.settled)) {
    for (const { child, to, runId } of handoffRelays(state, listThreads())) {
      const from = child.lineage.parentThreadId;
      if (dryRun) { say.push(`would relay ${child.title.slice(0, 40)} → ${to.slice(0, 8)}`); continue; }
      const target = getThread(to);
      if (target && !target.archivedAt && !target.deletedAt) {
        // A failed send stays unmarked and retries next tick; the relays already sent stay marked.
        try { await sendMessage(to, relayText(child, from, runReplies(child.id, runId).at(-1) ?? "(no reply text)"), { mode: "queue", createdBy: "agent", label: "pacer relay" }); }
        catch (e) { log("handoff-relay-error", { threadId: to, child: child.id, error: e.message }); say.push(`couldn't relay ${child.title.slice(0, 40)} → ${to.slice(0, 8)}: ${e.message}; retrying`); continue; }
        log("handoff-relay", { threadId: to, from, child: child.id, runId, title: child.title?.slice(0, 60) });
        say.push(`relayed ${child.title.slice(0, 40)} → ${to.slice(0, 8)}`);
      } else say.push(`not relaying ${child.title.slice(0, 40)}: ${to.slice(0, 8)} is gone or archived`);
      next = { ...next, relayed: { ...next.relayed, [child.id]: { runId, at: new Date().toISOString() } } };
      writeState(next);
    }
  }
  for (const [from, rec] of Object.entries(state.handoffs ?? {})) {
    const info = threadInfo(from);
    if (!rec.done) {
      if (dryRun) { say.push(`would finish the hand-off ${from.slice(0, 8)} → ${rec.to.slice(0, 8)}`); continue; }
      const r = await handOffLead({ state: next, from, info: info ?? { title: rec.title }, plan: rec.plan, compactions: rec.compactions, cause: rec.cause, deps: handoffDeps() });
      next = r.state; say.push(r.say); continue;
    }
    if (!rec.settled) {
      if (info && running(info) && !gone(info)) continue;
      if (dryRun) { say.push(`would settle handed-off ${from.slice(0, 8)}`); continue; }
      const r = await settleOld(next, from, info, handoffDeps());
      next = r.state;
      if (r.settled) { log("lead-handoff-settled", { threadId: from, to: rec.to, title: rec.title?.slice(0, 60) }); say.push(`settled handed-off ${from.slice(0, 8)} (now ${rec.to.slice(0, 8)})`); }
      else say.push(`couldn't settle handed-off ${from.slice(0, 8)}: ${r.error}; retrying`);
      continue;
    }
    if (Date.now() - Date.parse(rec.settledAt ?? rec.at) > SNOOZE_MS && !dryRun) {
      const { [from]: _, ...rest } = next.handoffs;
      next = { ...next, handoffs: rest };
      writeState(next);
    }
  }
  return { state: next, say };
}

// A lead at handoffCompactions pausing (or re-queuing) moves to a fresh thread: woken natively by
// its children's reports, it would never reach the wake path's hand-off, and each pause adds a
// /compact. With a running delegate_task child (its report comes back to this
// thread) it stays queued but marked due: no /compact, and the turn the report starts ends with a
// "hand off now" ask. A hand-off that can't start is logged and the thread is queued, compacted
// and snoozed as before. Inside the queue lock; `lead` is pauseHandoff's answer. Returns { say }
// (handed off), { entry } (the entry marked due), { failed } or {} (below the threshold).
async function pauseLeadHandoff({ state, id, info, entry, lead, at }) {
  if (lead.handoff) {
    try {
      const r = await handOffLead({ state, from: id, info, plan: entry.plan, compactions: lead.compactions, cause: "pause", queued: entry, deps: handoffDeps() });
      return { say: r.say };
    } catch (e) {
      const s = readState();
      const rec = s.handoffs?.[id];
      // Nothing was made: drop the record so no tick finishes it. A thread that exists keeps
      // it, so the next tick finishes that hand-off with the same ids.
      const made = rec && !rec.done && !!getThread(rec.to);
      if (rec && !rec.done && !made) { const { [id]: _, ...rest } = s.handoffs; writeState({ ...s, handoffs: rest }); }
      log("lead-handoff-failed", { threadId: id, title: entry.title, plan: entry.plan, compactions: lead.compactions, cause: "pause", error: e.message,
        why: `queued, compacted and snoozed as before${made ? "; the next tick finishes the hand-off" : ""}` });
      console.error(`hand-off failed (logged): ${e.message}; queued as before`);
      return { failed: e.message };
    }
  }
  if (!lead.due) return {};
  log("lead-handoff-due", { threadId: id, title: entry.title, plan: entry.plan, compactions: lead.compactions, children: lead.children,
    why: `${lead.compactions} compactions; waits for ${lead.children.length} running delegate_task child${lead.children.length > 1 ? "ren" : ""}; no /compact; told to hand off once the report's turn ends` });
  return { entry: { ...entry, handoffDue: { at, compactions: lead.compactions } } };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);
const option = (name, fallback = null) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const flag = (name) => args.includes(name);

// What an enqueue or pause builds on: the queue entry, else the woken record, else what a
// hand-back left on the ready entry. None: a fresh entry (med, age 0).
export const priorEntry = (state, id) => state.queue.find((e) => e.threadId === id) ?? state.woken?.[id] ?? state.ready?.[id]?.handedBack ?? null;

// The queue entry an enqueue (or pause) writes. Flags given on the command win; otherwise the
// prior entry's priority, size, note and age carry over, and a pause adds one to its pauses.
export function queueEntryFrom({ id, title, old, given = {}, pause = false, now }) {
  const plan = given.plan ?? old?.plan;
  if (!plan) throw new Error("--plan <path> is required");
  if (given.priority && ![...LEVELS, "now", "normal"].includes(given.priority)) throw new Error(`--priority is ${LEVELS.join(", ")} (legacy now = highest, normal = med)`);
  const size = given.size ?? old?.size ?? null;
  if (size && !["s", "m", "l"].includes(size)) throw new Error("--size is s, m or l");
  return { threadId: id, title, plan: path.resolve(plan), priority: level(given.priority ?? old?.priority ?? "med"), size, note: given.note ?? old?.note ?? null,
    firstQueuedAt: old?.firstQueuedAt ?? old?.enqueuedAt ?? now, enqueuedAt: now, pauses: (old?.pauses ?? 0) + (pause ? 1 : 0),
    ...(given.notBefore ? { notBefore: given.notBefore } : {}) };
}

// One open thread per plan: otherwise an old lead (the user wrote in it after its hand-off) and
// the new one can each remove the other's queue entry.
// The plan's key is its dir name for a <dir>/plan.md (a worktree path of the same plan matches),
// else the whole path.
export const planKey = (plan) => { const r = path.resolve(plan ?? ""); return path.basename(r) === "plan.md" ? path.basename(path.dirname(r)) : r; };
// Other threads holding `plan`: queued, woken, or readied ("building") and still open.
export function planHolders(state, id, plan, isOpen = isOpenThread) {
  const k = planKey(plan), mine = (x) => !!x?.plan && planKey(x.plan) === k;
  const out = new Map();
  for (const e of state.queue ?? []) if (e.threadId !== id && mine(e)) out.set(e.threadId, { threadId: e.threadId, title: e.title ?? null, as: "queued", entry: e });
  for (const [t, w] of Object.entries(state.woken ?? {})) if (t !== id && mine(w) && !out.has(t)) out.set(t, { threadId: t, title: w.title ?? null, as: "woken", entry: w });
  for (const [t, r] of Object.entries(state.ready ?? {})) if (t !== id && mine(r) && !out.has(t)) out.set(t, { threadId: t, title: r.title ?? null, as: "building", entry: null });
  // Built, live check left: its lead still owns it until that lead is settled.
  for (const b of Object.values(state.built ?? {})) if (b.threadId && b.threadId !== id && mine(b) && !out.has(b.threadId)) out.set(b.threadId, { threadId: b.threadId, title: b.title ?? null, as: "built", entry: null });
  return [...out.values()].filter((h) => isOpen(h.threadId));
}
export const heldLine = (plan, holders, cmd) => `plan ${planNumber(path.resolve(plan)) || planKey(plan)} is held by ${holders.map((h) => `${h.threadId}${h.title ? ` ${h.title}` : ""} (${h.as})`).join(", ")}; that thread owns it. Don't remove its entry. If this thread really takes the plan over, run \`pacer.mjs ${cmd} --take-over\` (it keeps the plan's age and pause count); otherwise stop here.`;
// --take-over: the other holders' queue, woken and ready entries for this plan go, and a built
// record of theirs for it moves to `to` (so it doesn't keep holding the plan); returns the
// entry whose age and pause count the new one keeps (the oldest queued or woken one). The other
// thread is left as it is (no unsnooze, no message).
export function takeOver(state, plan, holders, to = null) {
  const ids = new Set(holders.map((h) => h.threadId)), k = planKey(plan);
  const drop = (id, x) => ids.has(id) && !!x?.plan && planKey(x.plan) === k;
  const carried = holders.map((h) => h.entry).filter(Boolean).sort((a, b) => (Date.parse(a.firstQueuedAt ?? a.enqueuedAt) || 0) - (Date.parse(b.firstQueuedAt ?? b.enqueuedAt) || 0))[0] ?? null;
  return { carried, state: { ...state, queue: state.queue.filter((e) => !drop(e.threadId, e)),
    woken: Object.fromEntries(Object.entries(state.woken ?? {}).filter(([id, w]) => !drop(id, w))),
    ready: Object.fromEntries(Object.entries(state.ready ?? {}).filter(([id, r]) => !drop(id, r))),
    ...(to && state.built ? { built: Object.fromEntries(Object.entries(state.built).map(([p, b]) => [p, drop(b.threadId, b) ? { ...b, threadId: to } : b])) } : {}) } };
}
// The plan's remembered age, from the last enqueue of it by any thread.
export const planAgeOf = (state, plan) => (plan ? state.planAges?.[planKey(plan)] ?? null : null);
const ageRecord = (e, at) => ({ firstQueuedAt: e.firstQueuedAt, priority: e.priority, pauses: e.pauses ?? 0, at });
export const withPlanAge = (state, e, at = new Date().toISOString()) => ({ ...state, planAges: { ...state.planAges, [planKey(e.plan)]: ageRecord(e, at) } });
// Queue and woken entries from before age records existed get one on first read (oldest entry
// per plan wins), so a take-over or re-queue of them keeps their age, priority and pauses.
export function backfillPlanAges(queue, woken, ages, at = new Date().toISOString()) {
  const out = { ...ages };
  const entries = [...queue, ...Object.values(woken)].filter((e) => e?.plan && e.firstQueuedAt).sort((a, b) => Date.parse(a.firstQueuedAt) - Date.parse(b.firstQueuedAt));
  for (const e of entries) out[planKey(e.plan)] ??= ageRecord(e, at);
  return out;
}
// Age records the tick keeps: any plan an open thread holds (queued, woken, building). One with
// no open holder goes when its plan finished (a lead holding it, or its `built` line's lead, was
// settled or deleted) or 14 days after it was last written.
export const PLAN_AGE_MS = 14 * 86400000;
export function tidyPlanAges(state, isOpen, now = Date.now()) {
  const held = new Set(), finished = new Set();
  const see = (id, x) => { if (!x?.plan) return; (isOpen(id) ? held : finished).add(planKey(x.plan)); };
  for (const e of state.queue ?? []) see(e.threadId, e);
  for (const [id, w] of Object.entries(state.woken ?? {})) see(id, w);
  for (const [id, r] of Object.entries(state.ready ?? {})) see(id, r);
  for (const b of Object.values(state.built ?? {})) if (b.threadId) see(b.threadId, b); else if (b.plan) held.add(planKey(b.plan));
  return Object.fromEntries(Object.entries(state.planAges ?? {}).filter(([k, a]) => held.has(k)
    || (!finished.has(k) && now - Date.parse(a.at ?? a.firstQueuedAt ?? 0) < PLAN_AGE_MS)));
}
// What enqueue builds on: this thread's own entry for the plan, else the taken-over one, else
// its own entry for another plan, else the plan's age. An age record has no size or note; it
// only keeps firstQueuedAt, priority and pauses.
export const enqueueBase = (state, id, plan, carried = null) => {
  const own = priorEntry(state, id);
  if (own && (!plan || !own.plan || planKey(own.plan) === planKey(plan))) return own;
  // A different plan than its own entry's: that plan's history (carried, or saved by a
  // `ready --take-over`) wins over the thread's unrelated entry.
  return carried ?? planAgeOf(state, plan ?? state.ready?.[id]?.plan) ?? own;
};
// `ready --take-over`: the holders' entries go and their history is kept as the plan's age, so
// the next enqueue builds on it.
export function readyTakeOver(state, plan, holders, to = null) {
  const r = takeOver(state, plan, holders, to);
  return r.carried ? withPlanAge(r.state, { ...r.carried, plan }) : r.state;
}

// The ready entry after an enqueue: built fresh, so a hand-back's `handedBack` is gone (queued
// again, `ready` must not say it isn't).
export const readyAfterEnqueue = (ready, entry, at) => ({ ...ready, [entry.threadId]: { plan: entry.plan, title: entry.title, readyAt: ready?.[entry.threadId]?.readyAt ?? at } });

async function enqueue({ pause }) {
  const id = resolveThread(option("--thread"));
  const info = threadInfo(id);
  if (gone(info)) throw new Error(`thread is ${gone(info)}`);
  if (knownWorker(info)) throw new Error("refusing a delegated worker thread");
  const refusal = enqueueRefusal({ pending: pendingRequest(info), asks: askedOf(id) });
  if (refusal) throw new Error(`${refusal}: you have questions for the user, so don't ${pause ? "pause" : "enqueue"}. End your turn instead; the thread stays in the user's list until they answer.`);
  await withLock(async () => {
    let state = readState();
    const enqueuedAt = new Date().toISOString();
    const planArg = option("--plan") ?? priorEntry(state, id)?.plan ?? state.ready?.[id]?.plan ?? null;
    let carried = null;
    if (planArg) {
      const holders = planHolders(state, id, planArg);
      if (holders.length && !flag("--take-over")) throw new Error(heldLine(planArg, holders, pause ? "pause" : "enqueue"));
      if (holders.length) {
        ({ state, carried } = takeOver(state, planArg, holders, id));
        log("take-over", { threadId: id, title: short(info), plan: path.resolve(planArg), from: holders.map((h) => h.threadId), why: `${pause ? "pause" : "enqueue"} --take-over` });
      }
    }
    let entry = queueEntryFrom({ id, title: short(info), old: enqueueBase(state, id, planArg, carried), pause, now: enqueuedAt,
      given: { plan: option("--plan"), priority: option("--priority"), size: option("--size"), note: option("--note"),
        notBefore: option("--until") ? untilTime(option("--until")) : null } });
    const { priority, size } = entry;
    // A lead (it had a pacer plan entry before) at handoffCompactions is handed off here, or
    // queued marked due a hand-off (pauseLeadHandoff). The pause counts as one either way.
    const isLead = isReady(state, id) && !handedOff(state, id);
    const lead = pauseHandoff({ compactions: isLead ? compactionCount(id) : 0, threshold: readConfig().handoffCompactions,
      children: () => runningChildren(openThreads(), id, running) });
    const h = await pauseLeadHandoff({ state, id, info, entry, lead, at: enqueuedAt });
    if (h.say) {
      if (pause) writeState({ ...readState(), lastPauseAt: new Date().toISOString() });
      console.log(`${h.say}. This thread gets no /compact; stop here.`);
      return;
    }
    // `lead` lets the deferred /compact recheck the threshold (the turn can reach it after this).
    entry = { ...(h.entry ?? entry), lead: isLead };
    const base = h.failed ? readState() : state;
    const next = withPlanAge({ ...base, ...(pause ? { lastPauseAt: new Date().toISOString() } : {}), queue: upsert(base.queue, entry), woken: Object.fromEntries(Object.entries(base.woken).filter(([k]) => k !== id)),
      ready: readyAfterEnqueue(base.ready, entry, enqueuedAt) }, entry);
    writeState(next);
    const snoozeResult = await snooze(info, entry.enqueuedAt);
    const autoSettleOff = await disableAutoSettle(id);
    const cfg = readConfig();
    const rows = queueRows(next, { cfg });
    const position = rows.findIndex(({ e }) => e.threadId === id) + 1;
    const r = rows[position - 1]?.rank ?? rank(entry, Date.now(), cfg);
    log(pause ? "pause" : "enqueue", { threadId: id, title: entry.title, plan: entry.plan, priority, size, ...(entry.notBefore ? { notBefore: entry.notBefore } : {}), score: r.score, position, snooze: snoozeResult, autoSettleOff });
    console.log(`${pause ? "paused" : "queued"} ${id} ${entry.title}: ${describeRank(r)}${entry.notBefore ? `; not woken before ${zoneLabel(entry.notBefore, { hour: "numeric", minute: "2-digit" })}` : ""}; position ${position} of ${next.queue.length} (day order); ${snoozeResult}${autoSettleOff ? "; auto-settle off" : ""}`);
  });
}

// `handoff [--thread ID] [--plan PATH]`: the lead (by default the calling thread) moves to a fresh
// thread. Run by the lead after the pacer's "hand off now" turn, or by hand. A second run, or one
// racing the tick, finds the record under the lock and starts nothing.
async function handoff() {
  const id = resolveThread(option("--thread"));
  const sleep = readSleep();
  await withLock(async () => {
    const state = readState();
    const info = threadInfo(id);
    const prior = state.handoffs[id];
    if (!prior) {
      if (gone(info)) throw new Error(`thread is ${gone(info)}`);
      if (knownWorker(info)) throw new Error("refusing a delegated worker thread");
      if (!isReady(state, id)) throw new Error("not a lead: this thread has no pacer plan entry (queue, woken or ready), so the pacer doesn't hand it off; a lead runs `pacer.mjs ready --plan <plan>` first");
      const from = handedOffFrom(state, id), compactions = compactionCount(id);
      if (from && compactions < readConfig().handoffCompactions) throw new Error(`this thread already is the fresh one (it took over from ${from} at ${state.handoffs[from].at}, ${compactions} compactions since): nothing to hand off. Continue from the plan's Resume.`);
      const children = runningChildren(openThreads(), id, running);
      if (children.length) throw new Error(`not yet: ${children.length} delegate_task child${children.length > 1 ? "ren" : ""} still running (${children.join(", ")}); its report comes back to this thread. Run handoff again once it has.`);
      const asks = askedOf(id);
      if (asks.length) throw new Error(`not yet: ${asksLine(asks)}; the answers come back to this thread. Run handoff again once the user has answered.`);
      const plan = option("--plan") ? path.resolve(option("--plan")) : leadPlan(state, id);
      if (!plan) throw new Error("--plan <path> is required");
      // A lead that paused due a hand-off keeps its pause: the new thread waits in
      // its place in the queue (priority, pause-until) and the pacer wakes it.
      const due = state.queue.find((e) => e.threadId === id && e.handoffDue);
      const r = await handOffLead({ state, from: id, info, plan, compactions, cause: "command", asleep: sleep.asleep, ...(due ? { queued: due } : {}), deps: handoffDeps() });
      console.log(`${r.say}. The new thread ${r.to} ${r.queued ? "waits in this one's place in the queue; the pacer wakes it" : "runs the plan now"}; stop here.`);
      return;
    }
    const r = await handOffLead({ state, from: id, info: info ?? { title: prior.title }, plan: prior.plan, compactions: prior.compactions, cause: prior.cause, deps: handoffDeps() });
    console.log(`${r.say}. The new thread ${r.to} runs the plan; stop here.`);
  });
}

// What `ready` prints for a thread that isn't in the queue and wasn't woken by the pacer.
export function notQueuedLine(id, plan, handedBack) {
  const args = [`--plan ${plan}`, handedBack?.priority ? `--priority ${handedBack.priority}` : null, handedBack?.size ? `--size ${handedBack.size}` : null].filter(Boolean).join(" ");
  const why = handedBack ? `the pacer took it out of the queue at ${handedBack.at} because ${handedBack.why ?? "it asked the user something"}` : "it was never queued";
  return `NOT QUEUED: ${why}; \`ready\` doesn't queue. To wait for the pacer, run \`pacer.mjs enqueue --thread ${id} ${args}\` and end your turn; to build now, go ahead.`;
}

// The calling thread's plan is fleshed out (the user answered, workers about to go): from now on
// the pacer may ask it to pause. It stays awake; nothing is queued or snoozed.
async function markReady() {
  const id = resolveThread(option("--thread"));
  const info = threadInfo(id);
  if (gone(info)) throw new Error(`thread is ${gone(info)}`);
  if (knownWorker(info)) throw new Error("refusing a delegated worker thread");
  await withLock(async () => {
    let state = readState();
    const plan = option("--plan") ?? state.ready[id]?.plan ?? state.woken[id]?.plan;
    if (!plan) throw new Error("--plan <path> is required");
    const holders = planHolders(state, id, plan);
    if (holders.length && !flag("--take-over")) throw new Error(heldLine(plan, holders, "ready"));
    if (holders.length) {
      state = readyTakeOver(state, plan, holders, id);
      log("take-over", { threadId: id, title: short(info), plan: path.resolve(plan), from: holders.map((h) => h.threadId), why: "ready --take-over" });
    }
    const handedBack = state.ready[id]?.handedBack;
    const entry = { plan: path.resolve(plan), title: short(info), readyAt: state.ready[id]?.readyAt ?? new Date().toISOString(), ...(handedBack ? { handedBack } : {}) };
    writeState({ ...state, ready: { ...state.ready, [id]: entry } });
    log("ready", { threadId: id, title: entry.title, plan: entry.plan });
    console.log(`ready ${id} ${entry.title}: plan ${entry.plan}; the pacer may now ask it to pause`);
    // `ready` never queues. A thread the tick handed back (it asked the user while queued) is out
    // of the queue until it runs `enqueue` again; say so, with the command, so it isn't left idle.
    const queued = state.queue.some((e) => e.threadId === id);
    if (!queued && !state.woken[id]) console.log(notQueuedLine(id, entry.plan, handedBack));
    // The user's hold covers orchestrators that would start without the queue, too.
    if (state.held && !state.woken[id]) console.log(`QUEUE ON HOLD since ${state.held.since}${state.held.note ? ` (${state.held.note})` : ""}: don't start building. Run \`pacer.mjs enqueue --plan ${entry.plan}\` and stop; the user lifts the hold.`);
  });
}

// `built`: every stage of the plan is committed and only a live check or a later-time step is
// left. The plan leaves woken and ready ("building"), so plans that wait for it unblock; it is
// recorded in state.built (dependencies() skips it even if its lead queues for the check).
// Nothing is unsnoozed or woken; the lead then runs `pause --until` itself.
// Refuses (state unchanged) unless a woken, ready or queued record holds this exact plan path,
// and with `threadId` (--thread) unless that thread holds it: a typo or a plan nobody builds
// would otherwise release or record the wrong plan.
export function markBuilt(state, plan, threadId = null, title = null, at = new Date().toISOString()) {
  const p = path.resolve(plan);
  const same = (x) => !!x?.plan && path.resolve(x.plan) === p;
  const holders = [...new Set([...Object.keys(state.woken ?? {}).filter((id) => same(state.woken[id])), ...Object.keys(state.ready ?? {}).filter((id) => same(state.ready[id])),
    ...(state.queue ?? []).filter(same).map((e) => e.threadId)])];
  if (!holders.length) return { refuse: `no thread holds ${p} (not woken, ready or queued); check the path. Nothing changed.` };
  if (threadId && !holders.includes(threadId)) return { refuse: `${p} is held by ${holders.join(", ")}, not ${threadId}. Nothing changed.` };
  const from = holders.filter((id) => same(state.woken?.[id]) || same(state.ready?.[id]));
  const keep = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, x]) => !same(x)));
  const owner = threadId ?? holders[0];
  return { state: { ...state, woken: keep(state.woken), ready: keep(state.ready), built: { ...state.built, [p]: { plan: p, at, threadId: owner, title } } }, from };
}
async function markBuiltCommand() {
  const plan = option("--plan");
  if (!plan) throw new Error("built needs --plan <path>");
  const id = option("--thread");
  if (id && !uuid.test(id)) throw new Error("--thread requires an exact T3 thread UUID");
  await withLock(async () => {
    const state = readState();
    const r = markBuilt(state, plan, id ?? null);
    if (r.refuse) throw new Error(`built refused: ${r.refuse}`);
    const b = r.state.built[path.resolve(plan)];
    b.title = short(threadInfo(b.threadId)) || null;
    writeState(r.state);
    log("built", { threadId: b.threadId, title: b.title, plan: b.plan, released: r.from, why: "all stages committed; only a live check or a later step left" });
    console.log(`built ${b.plan}: out of woken/ready${r.from.length ? ` (${r.from.map((x) => x.slice(0, 8)).join(", ")})` : ""}; plans waiting on it unblock. Now \`pause --plan ${b.plan} --until <time>\` or nudge for the check.`);
  });
}
// status: one line per built plan.
export const builtLines = (built = {}) => {
  const rows = Object.values(built);
  return rows.length ? [`\nBuilt, live check left (${rows.length}):`, ...rows.map((b) => `  plan ${planNumber(b.plan)} ${b.plan}${b.threadId ? ` (${b.threadId.slice(0, 8)}${b.title ? ` ${b.title}` : ""})` : ""}: built ${b.at}`)] : [];
};

// The usage window this tick got (undefined until claudeWindow returns) and whether its emergency
// step ran: the catch path reads both.
let tickWindow;
let emergencyRan = false;
async function tick() {
  const dryRun = flag("--dry-run");
  const window = claudeWindow();
  tickWindow = window;
  const run = async () => {
    // Emergency first, whatever the hold says; like triage, an error here never stops pacing.
    emergencyRan = true;
    let emergencySay;
    // This tick's own blindness waits while T3 upgrades: if the tick then fails, the catch path marks
    // it t3Upgrade; if it succeeds, its blind line counts from the next tick on.
    try { emergencySay = (await emergency({ blind: window ? 0 : tickBlind(blindStreak(readLog().slice(-200)), t3Upgrade()), dryRun })).say; }
    catch (e) { if (!dryRun) log("emergency-error", { error: e.message, why: `emergency step skipped: ${e.message}; pacing goes on` }); emergencySay = [`emergency-error: ${e.message}`]; }
    const pruned = await reconcileQueue(prune(readState(), paceOf(window).windowId, dryRun), dryRun);
    // Lead hand-offs left half done or with the old thread unsettled. Like triage, an error here
    // never stops pacing.
    let handoffSay = [], reconciled = pruned;
    try { ({ state: reconciled, say: handoffSay } = await finishHandoffs(pruned, dryRun)); }
    catch (e) { if (!dryRun) log("handoff-error", { error: e.message, why: `hand-off step skipped: ${e.message}; pacing goes on` }); handoffSay = [`handoff-error: ${e.message}`]; }
    // On hold no triage thread starts either; the window's check runs on the first tick after `go`.
    // Triage is extra: if it throws, pacing goes on (a crashing triage check must not stop every
    // tick for a whole night window).
    let triaged = { state: reconciled, say: [] };
    if (!reconciled.held) {
      try { triaged = await triage(reconciled, window, dryRun); }
      catch (e) { if (!dryRun) log("triage-error", { error: e.message, why: `triage skipped: ${e.message}; pacing goes on, retries next tick` }); triaged.say.push(`triage-error: ${e.message}`); }
    }
    // Sleep: logged on change; the wake digest once the file shows the user woke tonight. Like triage, an
    // error here never stops pacing.
    const sleep = readSleep();
    let state = triaged.state;
    let sleepSay = [];
    try {
      const r = await sleepTick({ state, sleep, dryRun, now: Date.now(), deps: { waiting: () => waitingThreads(state).map(short), post: postReport, log } });
      if (r.state !== state) { state = r.state; writeState(state); }
      sleepSay = r.say;
    } catch (e) { if (!dryRun) log("sleep-error", { error: e.message, why: `sleep step skipped: ${e.message}; pacing goes on` }); sleepSay = [`sleep-error: ${e.message}`]; }
    // Main threads stopped by the usage limit, before their reset: snooze each to reset + 30 min so
    // T3 doesn't resume them all at once; the pacer resumes them through the wake rule.
    // Pending resumes whose thread runs again, is gone or no longer limited are dropped.
    const resumeSay = [];
    try {
      const open = openThreads();
      const byId = new Map(open.map((t) => [t.thread_id, t]));
      for (const [id, r] of Object.entries(state.limitResumes ?? {})) {
        const why = limitResumeDrop(byId.get(id) ?? threadInfo(id), r);
        if (!why) continue;
        resumeSay.push(`${dryRun ? "would drop" : "dropped"} the limit resume of ${id.slice(0, 8)} ${r.title} (${why})`);
        if (dryRun) continue;
        const { [id]: _, ...rest } = state.limitResumes;
        state = { ...state, limitResumes: rest };
        writeState(state);
        log("limit-resume-dropped", { threadId: id, title: r.title, resetAt: r.resetAt, why });
      }
      for (const h of resumeHolds(state.limitResumes, (id) => (byId.get(id) ?? threadInfo(id))?.snoozed_until)) {
        const r = state.limitResumes[h.threadId];
        if (dryRun) { resumeSay.push(`would hold ${h.threadId.slice(0, 8)} ${r.title} to ${h.until}`); continue; }
        try {
          await snoozeThread(h.threadId, h.until);
          state = { ...state, limitResumes: { ...state.limitResumes, [h.threadId]: { ...r, snoozedUntil: h.until } } };
          writeState(state);
          log("limit-hold", { threadId: h.threadId, title: r.title, snoozedUntil: h.until, why: "resume still pending; T3 would resume it at once when the snooze ran out" });
          resumeSay.push(`held ${h.threadId.slice(0, 8)} ${r.title} to ${h.until}`);
        } catch (e) {
          log("limit-hold-failed", { threadId: h.threadId, title: r.title, error: e.message });
          resumeSay.push(`limit-hold-error ${h.threadId.slice(0, 8)} ${r.title}: ${e.message}`);
        }
      }
      const queued = new Set(state.queue.map((e) => e.threadId));
      for (const t of limitTakes(open, { pending: state.limitResumes, resumed: state.resumed, queued })) {
        const until = new Date(Date.parse(t.usage_limit_reset_at) + LIMIT_SNOOZE_MS).toISOString();
        const line = `${t.thread_id.slice(0, 8)} ${short(t)}: snoozed to ${until}, the pacer resumes it after the reset ${t.usage_limit_reset_at}`;
        if (dryRun) { resumeSay.push(`would take ${line}`); continue; }
        try {
          await snoozeThread(t.thread_id, until);
          state = { ...state, limitResumes: { ...state.limitResumes, [t.thread_id]: { title: short(t), resetAt: t.usage_limit_reset_at, snoozedUntil: until, takenAt: new Date().toISOString() } } };
          writeState(state);
          log("limit-take", { threadId: t.thread_id, title: short(t), resetAt: t.usage_limit_reset_at, snoozedUntil: until, why: "stopped by the usage limit; resumed by the pacer after the reset, not by T3 at once" });
          resumeSay.push(`took ${line}`);
        } catch (e) {
          log("limit-take-failed", { threadId: t.thread_id, title: short(t), error: e.message, why: "T3 resumes it at the reset; retries next tick" });
          resumeSay.push(`limit-take-error ${t.thread_id.slice(0, 8)} ${short(t)}: ${e.message}`);
        }
      }
    } catch (e) { if (!dryRun) log("limit-take-error", { error: e.message, why: `limit take skipped: ${e.message}; pacing goes on` }); resumeSay.push(`limit-take-error: ${e.message}`); }
    // T3 missed its usage-limit resume for these: send it ourselves. An error never stops pacing.
    const resumedNow = new Set();
    for (const t of missedResumes(openThreads(), state.resumed, Date.now(), state.limitResumes)) {
      if (dryRun) { resumeSay.push(`would resume ${t.thread_id.slice(0, 8)} ${short(t)} (T3 missed its resume after ${t.usage_limit_reset_at})`); continue; }
      try {
        await turn(t, "Continue where you left off.");
        state = { ...state, resumed: { ...state.resumed, [t.thread_id]: t.usage_limit_reset_at } };
        writeState(state);
        resumedNow.add(t.thread_id);
        log("resume", { threadId: t.thread_id, title: short(t), why: `T3 missed its usage-limit resume after ${t.usage_limit_reset_at}` });
        resumeSay.push(`resumed ${t.thread_id.slice(0, 8)} ${short(t)} (T3 missed its resume after ${t.usage_limit_reset_at})`);
      } catch (e) { resumeSay.push(`resume-error ${t.thread_id.slice(0, 8)} ${short(t)}: ${e.message}`); }
    }
    const pic = picture(state, window, Date.now(), sleep);
    // A thread resumed above has its turn already; it isn't woken on top of it.
    if (resumedNow.size) pic.ready = pic.ready.filter((e) => !resumedNow.has(e.threadId));
    const triageStarted = triaged.say.some((l) => /^(would )?(start|started|finish|finished) a?.*triage thread/.test(l));
    const d = decide({ used: pic.used, pace: pic.pace, windowId: pic.windowId, night: pic.night, active: pic.active, working: pic.working.length, maxWorking: pic.cfg.maxWorking, triageStarted,
      ready: pic.ready, waiting: pic.waiting,
      onUser: pic.onUser.length, blocked: pic.blocked, later: pic.later, limitQueued: pic.limitQueued, handoffWait: pic.handoffWaits.length, spentWake: state.spentWake, held: state.held, lastWakeAt: state.lastWakeAt, lastAskAt: state.lastAskAt, lastPauseAt: state.lastPauseAt, limited: pic.limited.map((l) => `${l.thread_id.slice(0, 8)} ${short(l)}`), capped: pic.capTo != null });
    const summary = { mode: pic.night ? "night" : "day", blind: !window, sleep: sleep.label, paceLine: paceLine(pic.night, pic.cfg), used: pic.used, pace: pic.pace, window: pic.windowId,
      active: pic.active.map((a) => `${a.threadId.slice(0, 8)} ${a.title} (${a.why}${a.ready ? "" : ", not ready"}${a.pacerWoken ? ", pacer" : ""}${a.askedWindow ? ", asked" : ""})`),
      working: { count: pic.working.length, cap: pic.cfg.maxWorking, threads: pic.working.map((w) => ({ id: logId(w.threadId), title: w.title, why: w.why })) },
      waitingOnUser: [...pic.waitingOnUser.map((w) => `${w.threadId.slice(0, 8)} ${w.title}`), ...pic.onUser.map((e) => `${e.threadId.slice(0, 8)} ${short(e.info)} (queued)`)],
      ...(pic.night ? { limitHit: pic.limited.map((l) => `${l.thread_id.slice(0, 8)} ${short(l)} at ${l.hit_at}`) } : {}),
      ...(pic.paused.length ? { limitPaused: pic.paused.map((t) => `${t.threadId.slice(0, 8)} ${t.title} (${t.pacer ? "the pacer resumes it" : "T3 resumes"} after ${t.resetAt}${t.queued ? ", queued" : ""})`) } : {}),
      ...(pic.resumes.length ? { limitResumes: pic.resumes.map((r) => `${r.threadId.slice(0, 8)} ${r.title} (reset ${r.resetAt})`) } : {}),
      queued: pic.queue.length, ready: pic.ready.length, next: pic.ready[0] ? `${pic.ready[0].threadId.slice(0, 8)} ${pic.ready[0].resume ? "limit resume" : pic.ready[0].rank.score}` : null,
      ...(state.held ? { held: state.held.since } : {}), action: d.action, threadId: d.threadId, ...(d.action === "wake" ? { wakeSource: d.resume ? "resume" : d.source } : {}), reason: d.reason, ...(d.action === "wake" && pic.ready.find((e) => e.threadId === d.threadId)?.handoff ? { handsOff: true } : {}), ...(triaged.say.length ? { triage: triaged.say } : {}), ...(sleepSay.length ? { sleepSteps: sleepSay } : {}), ...(resumeSay.length ? { resumes: resumeSay } : {}), ...(emergencySay.length ? { emergency: emergencySay } : {}),
      ...(handoffSay.length ? { handoffs: handoffSay } : {}), ...(pic.handoffWaits.length || pic.handoffAsks.length ? { handoffWaits: handoffRows(pic).map((r) => `${r.threadId.slice(0, 8)} ${r.title}: ${r.why}`) } : {}) };
    if (dryRun) { console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2)); return; }
    // The tick line goes last: a tick whose wake or ask fails logs only its error line, so the
    // failing and blind streaks see one outcome per tick.
    for (const line of emergencySay) console.log(`emergency: ${line}`);
    for (const line of triaged.say) console.log(`triage: ${line}`);
    for (const line of sleepSay) console.log(line);
    for (const line of resumeSay) console.log(line);
    for (const line of handoffSay) console.log(`handoff: ${line}`);
    console.log(`${d.action}${d.threadId ? ` ${d.threadId}` : ""}: ${d.reason}`);
    if (d.action === "wake") {
      const entry = pic.ready.find((e) => e.threadId === d.threadId);
      const extra = d.spentWake ? { spentWake: pic.windowId ?? "none" } : {};
      if (entry.resume) state = await resumeLimited(state, entry, pic.used, pic.pace, d, extra);
      else if (entry.handoff) {
        const r = await handOffLead({ state, from: entry.threadId, info: entry.info, plan: entry.plan, compactions: entry.handoff.compactions, cause: "wake",
          wake: { used: pic.used, pace: pic.pace, extra }, asleep: sleep.asleep, deps: handoffDeps() });
        state = r.state;
        log("wake", { threadId: r.to, title: short(entry.info), plan: entry.plan, used: pic.used, pace: pic.pace, reason: d.reason, handoffFrom: entry.threadId, ...(sleep.asleep ? { asleep: true } : {}) });
        console.log(`${r.say} instead of waking it`);
      } else await wake(state, entry, entry.info, pic.used, pic.pace, d.reason, { ...extra, source: d.source }, sleep.asleep);
      // Still queued after its wake: the wake started nothing (3 in a row open a pacer-stuck emergency).
      if (readState().queue.some((e) => e.threadId === d.threadId)) summary.wakeStuck = true;
    } else if (d.action === "ask-pause") {
      const info = pic.byId.get(d.threadId);
      await turn(info, askText(pic.used, pic.pace), "queue");
      writeState({ ...state, lastAskAt: new Date().toISOString(), asked: { ...state.asked, [d.threadId]: pic.windowId ?? "none" } });
      log("ask-pause", { threadId: d.threadId, title: short(info), plan: state.woken[d.threadId]?.plan ?? null, pacerWoken: !!state.woken[d.threadId], used: pic.used, pace: pic.pace, reason: d.reason });
      console.log(`asked ${d.threadId} ${short(info)} to pause`);
    }
    // Awake leads at the threshold whose turn just ended: one "hand off now" turn per level.
    // Not the thread this tick asked to pause. An error is logged; pacing goes on.
    for (const h of pic.handoffAsks.filter((x) => x.due && x.threadId !== d.threadId)) {
      try {
        await turn(pic.byId.get(h.threadId), handoffNowText(h.compactions, h.plan));
        state = readState();
        writeState({ ...state, handoffAsked: { ...state.handoffAsked, [h.threadId]: h.compactions } });
        log("handoff-ask", { threadId: h.threadId, title: h.title, plan: h.plan, compactions: h.compactions });
        console.log(`told ${h.threadId} ${h.title} to hand off (${h.compactions} compactions)`);
      } catch (e) { log("handoff-ask-failed", { threadId: h.threadId, title: h.title, error: e.message, why: "retries next tick" }); console.log(`handoff ask ${h.threadId.slice(0, 8)} failed: ${e.message}`); }
    }
    log("tick", summary);
  };
  return dryRun ? run() : withLock(run);
}

function status() {
  // First, before anything that needs T3: during an upgrade T3 is what's down.
  const upgrading = upgradeStatus(t3Upgrade(), readLog().slice(-50));
  if (upgrading) console.log(upgrading);
  const state = readState();
  const pic = picture(state, claudeWindow());
  const reset = pic.windowId ? `resets ${zoneLabel(pic.window.resetsAt, { hour: "numeric", minute: "2-digit" })}` : "no window open";
  const tol = band(pic.used);
  console.log(`Claude session: ${pic.used}% used, pace ${pic.pace}% ${bandText(band(pic.used))} (${reset})`);
  console.log(`Sleep: ${sleepLine(pic.sleep)}`);
  console.log(`Mode: ${paceLine(pic.night, pic.cfg)}${pic.sleep.night ? " (sleep file: night)" : ""}; band ${bandText(tol)} (±10 fresh → ±5 at 10% left); ${wakeRule(tol, pic.cfg.maxWorking)}, ask > pace+${fmt(pic.night ? NIGHT_ASK_FACTOR * tol : tol)} (2 ready to ask${pic.capTo != null ? ", 1 with a cap" : ""})${pic.night ? " (10 min after the last ask or pause)" : ""}; wakes 10 min apart${pic.night ? ", no 95% cap" : ", one wake at ≥ 95% (nothing working)"}`);
  if (pic.capTo != null) console.log(`Cap this window: up to ${pic.capTo}% at the finish (set ${state.cap.setAt} at ${state.cap.from}% + ${state.cap.add}); pace is the lower line; \`cap --off\` ends it`);
  if (state.held) console.log(`ON HOLD since ${state.held.since}${state.held.note ? ` (${state.held.note})` : ""}: nothing is woken (limit resumes still go) and no triage thread starts until \`go\``);
  // Orchestrators read this before starting a Claude Opus worker.
  console.log(`Working ${pic.working.length}/${pic.cfg.maxWorking} (${pic.cfg.workingModels.join("/")} threads with a turn running, workers included; at ${pic.cfg.maxWorking}+ start one such worker at most)${pic.working.length ? ":" : ""}`);
  for (const w of pic.working) console.log(`  ${w.threadId} ${w.title}: ${w.why}`);
  console.log(triageStatus({ triage: pic.cfg.triage, last: state.triage, windowId: pic.windowId }));
  try {
    const em = readEmergency();
    console.log(emergencyStatus({ cfg: emergencyConfig(pic.cfg), state: em, open: !!em.threadId && !em.closedAt && !gone(threadInfo(em.threadId)) }));
  } catch (e) { console.log(`Emergency: can't read ${emergencyFile}: ${e.message}`); }
  if (pic.night && pic.limited.length) console.log(`Hit the usage limit (no new wakes until the reset): ${pic.limited.map((l) => `${l.thread_id.slice(0, 8)} ${short(l)}`).join(", ")}`);
  if (pic.paused.length) {
    console.log(`\nPaused by the usage limit; not counted (${pic.paused.length}): main threads the pacer took resume through the wake rule after the reset (first in line, one a tick), the rest T3 resumes:`);
    for (const t of pic.paused) console.log(`  ${t.threadId} ${t.title}: ${t.pacer ? "the pacer resumes it" : "T3 resumes it"} after ${t.resetAt}${t.queued ? " (queued)" : ""}`);
  }
  if (pic.resumes.length) {
    console.log(`\nLimit resumes due, ahead of the queue (${pic.resumes.length}):`);
    for (const r of pic.resumes) console.log(`  ${r.threadId} ${r.title}: reset ${r.resetAt} passed`);
  }
  const line = (a) => `  ${a.threadId} ${a.title}: ${a.why}${a.pacerWoken ? `, woken by pacer ${a.wokenAt}` : ""}${sameWindow(a.askedWindow, pic.windowId) ? ", asked to pause" : ""}`;
  const readyNow = pic.active.filter((a) => a.ready), notReady = pic.active.filter((a) => !a.ready);
  console.log(`\nActive (${pic.active.length}), ready: can be asked to pause (${readyNow.length}):`);
  for (const a of readyNow) console.log(line(a));
  console.log(`Active, not ready: counted, never asked (${notReady.length}):`);
  for (const a of notReady) console.log(line(a));
  console.log(`\nWaiting on the user, not counted (${pic.waitingOnUser.length + pic.onUser.length}):`);
  for (const w of pic.waitingOnUser) console.log(`  ${w.threadId} ${w.title}`);
  for (const e of pic.onUser) console.log(`  ${e.threadId} ${short(e.info)} (queued; ${e.handbackFailed ? `couldn't hand back: ${e.handbackFailed.error}, retrying` : "handed back on the next tick"})`);
  printQueue(state, pic);
  for (const l of builtLines(state.built)) console.log(l);
  const handoffs = handoffRows(pic), unsettled = Object.entries(state.handoffs).filter(([, r]) => !r.done || !r.settled);
  console.log(`\nLead hand-offs at ${pic.cfg.handoffCompactions}+ compactions (${handoffs.length}):`);
  for (const r of handoffs) console.log(`  ${r.threadId} ${r.title}: ${r.why}`);
  for (const [from, r] of unsettled) console.log(`  ${from} → ${r.to} ${(r.title ?? "").slice(0, 60)}: ${r.done ? "handed off; the old thread settles once its turn ends" : "half done; the next tick finishes it"}`);
  console.log(`\nLast decisions:`);
  for (const l of readLog().slice(-10)) {
    console.log(`  ${l.at} ${l.event}${l.action ? ` ${l.action}` : ""}${l.threadId ? ` ${l.threadId.slice(0, 8)} ${l.title ?? ""}` : ""}${l.reason ? `: ${l.reason}` : l.why ? `: ${l.why}` : l.error ? `: ${l.error}` : ""}`);
  }
}
// The queue in wake order, as `list` shows it: each entry at its effective priority (lift) and its rank.
// The tick's picture, the morning report and the enqueue line use it too, so every rank shown is the lifted one.
function queueRows(state, { night = false, cfg = readConfig(), now = Date.now(), deps = depsOf(state) } = {}) {
  const lift = (e) => (deps.eff.has(e.threadId) ? { ...e, lift: deps.eff.get(e.threadId) } : e);
  return ordered(state.queue, { now, cfg, night, deps }).map((e) => ({ e, rank: rank(lift(e), now, cfg) }));
}
function printQueue(state, { night = false, cfg = readConfig() } = {}) {
  const now = Date.now();
  const deps = depsOf(state);
  const q = queueRows(state, { night, cfg, now, deps });
  console.log(`\nQueue (${q.length}, wake order${night ? ", night: size l first among near ties" : ", day: size s first among near ties"}):`);
  q.forEach(({ e, rank: r }, i) => console.log(`  ${i + 1}. [${r.priority}${e.size ? `, ${e.size}` : ""}] ${e.threadId} ${e.title}\n     ${describeRank(r)}\n     plan ${e.plan}; first queued ${e.firstQueuedAt ?? e.enqueuedAt}${e.pauses ? `; paused ${e.pauses}×` : ""}${waitingUntil(e, now) ? `; not woken before ${zoneLabel(e.notBefore, { hour: "numeric", minute: "2-digit" })}` : ""}${e.note ? `; ${e.note}` : ""}${depNote(deps, e)}`));
  const woken = Object.entries(state.woken);
  console.log(`\nWoken by the pacer (${woken.length}):`);
  for (const [id, w] of woken) console.log(`  ${id} ${w.title}: woken ${w.wokenAt} [${w.priority}]; plan ${w.plan}${state.asked?.[id] ? "; asked to pause" : ""}`);
}

// `list` reads the cached usage window (never a live probe): day or night order, and for --json
// the header. No cached probe: null, so the sleep file alone sets day or night.
function listWindow() {
  try { return claudeWindow(true); } catch { return null; }
}

// `list --json` (for a queue view in another app): the header, what runs now, and the queue in the
// order `list` prints. Read-only; one openThreads() read instead of one per thread, so it stays fast.
function listJson() {
  const now = Date.now();
  const cfg = readConfig();
  const sleep = readSleep(cfg, now);
  const state = readState();
  const window = listWindow();
  const p = paceNow(state, window, now, cfg, sleep);
  const threads = openThreads();
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  const { active } = classify(state, threads, now);
  const deps = depsOf(state, (id) => byId.has(id));
  const rows = queueRows(state, { night: p.night, cfg, now, deps });
  const planNo = (plan) => (Number.isFinite(planNumber(plan)) ? planNumber(plan) : null);
  const stepOf = (plan) => { try { return plan ? planStep(readPlanText(plan)) : null; } catch { return null; } };
  const hhmm = (ms) => zoneLabel(new Date(ms).toISOString(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  // Running now: every pacer-woken entry, then the other threads a tick counts as active.
  const others = active.filter((a) => !state.woken[a.threadId]);
  const ids = others.map((a) => a.threadId);
  // Since: the live run's start, else the latest run that started. A request that never started
  // (a steer T3 folded into the live turn leaves one canceled, a held queue entry) doesn't count.
  const started = "json_extract(payload_json, '$.startedAt')";
  const turnStart = new Map(ids.length ? t3Query(`select thread_id, max(case when status in ('preparing', 'starting', 'running', 'waiting') then coalesce(${started}, requested_at) end) as live,
    max(${started}) as started from orchestration_v2_projection_runs where thread_id in (${ids.map(() => "?").join(", ")}) group by thread_id`, ids).map((r) => [r.thread_id, r.live ?? r.started ?? null]) : []);
  const why = new Map(active.map((a) => [a.threadId, a.why]));
  const runningNow = [
    ...Object.entries(state.woken).map(([id, w]) => ({ thread_id: id, title: short(byId.get(id)) || w.title || null, plan: w.plan ?? null, plan_number: planNo(w.plan),
      label: "woken", step: stepOf(w.plan), since: w.wokenAt ?? null, why: why.get(id) ?? null })),
    ...others.map((a) => { const plan = state.ready?.[a.threadId]?.plan ?? null; return { thread_id: a.threadId, title: a.title, plan, plan_number: planNo(plan),
      label: a.ready ? "your thread" : "not ready", step: stepOf(plan), since: turnStart.get(a.threadId) ?? null, why: a.why }; }),
  ];

  // Up next, with rough start times from the pace line at the current burn rate.
  // Rows the tick won't wake get no rough start (they keep their place): the same waiting-on-the-user
  // rule as picture(), from the recorded asks.
  const asked = openAsks();
  const stuck = (e) => { const t = byId.get(e.threadId); return !t || running(t) || waitsOnUser(t, asked.has(e.threadId)) || limitPaused(t) || deps.blockedBy.has(e.threadId); };
  const limited = p.night && p.windowId ? limitedThreads(new Date(Date.parse(window.resetsAt) - WINDOW_MS).toISOString(), threads).map((l) => `${l.thread_id.slice(0, 8)} ${short(l)}`) : [];
  const tail = (() => { try { return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-400).map((l) => JSON.parse(l)); } catch { return []; } })();
  const burn = burnRate({ used: window?.usedPercent, windowId: p.windowId, resetsAt: window?.resetsAt, now, ticks: tail });
  const working = workingThreads(threads);
  const starts = roughStarts({ rows: rows.map(({ e }) => ({ threadId: e.threadId, notBefore: e.notBefore, stuck: stuck(e) })), window: p.windowId ? window : null, now, cfg, cap: state.cap,
    nightAt: (t) => readSleep(cfg, t).night, active: active.length, working: working.length, lastWakeAt: state.lastWakeAt, spentWake: state.spentWake, held: state.held, limited, burn });
  const up_next = rows.map(({ e, rank: r }, i) => ({ thread_id: e.threadId, title: e.title ?? null, plan: e.plan ?? null, plan_number: planNo(e.plan), order: i + 1,
    priority: level(e.priority), effective_priority: r.priority, size: e.size ?? null, score: r.score,
    about: starts.has(e.threadId) ? hhmm(starts.get(e.threadId)) : null, about_at: starts.has(e.threadId) ? new Date(starts.get(e.threadId)).toISOString() : null,
    waits_on: depNote(deps, e).trim() || null, not_before: waitingUntil(e, now) ? e.notBefore : null, pauses: e.pauses ?? 0, queued_at: e.firstQueuedAt ?? e.enqueuedAt ?? null, note: e.note ?? null }));

  return {
    generated_at: new Date(now).toISOString(),
    header: { mode: p.night ? "night" : "day", used: window ? p.used : null, pace: window ? p.pace : null, blind: !window, held: !!state.held, held_since: state.held?.since ?? null,
      held_note: state.held?.note ?? null, sleep: sleep.label ?? null, queued: state.queue.length, resets_at: p.windowId ? window.resetsAt : null, cap_to: p.capTo ?? null,
      burn_per_hour: burn == null ? null : Math.round(600 * burn) / 10, working: working.length, working_cap: cfg.maxWorking ?? DEFAULTS.maxWorking },
    running: runningNow, up_next,
  };
}

// `priority --thread ID --level L`: a queued entry's priority, nothing else (no resnooze, re-pin or
// age reset, unlike enqueue).
async function setPriority() {
  const id = option("--thread");
  if (!id || !uuid.test(id)) throw new Error("priority needs --thread <T3 thread UUID>");
  const to = option("--level");
  if (!LEVELS.includes(to)) throw new Error(`--level is ${LEVELS.join(", ")}`);
  await withLock(async () => {
    const state = readState();
    const entry = state.queue.find((e) => e.threadId === id);
    if (!entry) throw new Error(state.woken[id] ? "thread was woken, not queued; its priority no longer matters" : "thread is not in the queue");
    const raised = state.queue.find((e) => e.threadId === id);
    const next = { ...state, queue: state.queue.map((e) => (e.threadId === id ? { ...e, priority: to } : e)) };
    writeState(raised ? withPlanAge(next, { ...raised, priority: to }) : next);
    log("priority", { threadId: id, title: entry.title, plan: entry.plan, from: entry.priority, to });
    console.log(entry.priority === to ? `${id} ${entry.title ?? ""} is already ${to}` : `priority ${id} ${entry.title ?? ""}: ${entry.priority} → ${to}`);
  });
}

// `wake --next`: the first queue entry the tick would wake (picture().ready, limit resumes left
// out: those go by themselves), within `among` when given. None: a refusal that says why.
export function pickNext({ queue, ready, handoffWaits = [] }, among = null, now = Date.now()) {
  const inScope = (e) => !among || among.has(e.threadId);
  const entry = ready.find((e) => !e.resume && inScope(e));
  if (entry) return { entry };
  const rows = queue.filter(inScope);
  if (!rows.length) return { refuse: among ? "nothing can start: none of these threads is queued" : "nothing can start: the queue is empty" };
  const waitsChild = new Set(handoffWaits.map((e) => e.threadId));
  const why = (e) => !e.info ? "missing in T3" : running(e.info) ? "running" : e.onUser ? "waiting on you"
    : e.blockedBy ? `waiting for plan ${e.blockedBy.map((b) => b.plan).join(", ")}` : limitPaused(e.info) ? "paused by the usage limit"
    : waitingUntil(e, now) ? `not before ${e.notBefore}` : waitsChild.has(e.threadId) ? "waiting for its worker's report" : "not ready";
  const counts = new Map();
  for (const e of rows) counts.set(why(e), (counts.get(why(e)) ?? 0) + 1);
  return { refuse: `nothing can start: ${rows.length} queued, ${[...counts].map(([w, n]) => `${n} ${w}`).join(", ")}` };
}

async function manualWake() {
  if (process.argv.includes("--next")) return wakeNext();
  const id = resolveThread(option("--thread"));
  const sleep = readSleep();
  const { used, pace } = paceOf(claudeWindow(), Date.now(), readConfig(), { codingNight: sleep.night });
  await withLock(async () => {
    const state = readState();
    const entry = state.queue.find((e) => e.threadId === id);
    if (!entry) throw new Error("thread is not in the queue");
    const info = threadInfo(id);
    if (gone(info)) throw new Error(`thread is ${gone(info)}`);
    if (running(info)) throw new Error("its turn is running; wake it when the turn ends");
    if (limitPaused(info)) throw new Error(`paused by the usage limit; T3 resumes it after ${info.usage_limit_reset_at}`);
    await wake(state, entry, info, used, pace, "manual wake", {}, sleep.asleep);
  });
}

// "Start next": wakes the head of the wake order now, hold or not, with no
// pace or cap check (a manual wake). A head lead due a hand-off is handed off as the tick does.
async function wakeNext() {
  if (option("--thread")) throw new Error("wake takes --thread or --next, not both");
  // A given --among, even empty, is a scope: an empty one starts nothing.
  const among = flag("--among") ? new Set((option("--among") ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("--"))) : null;
  const sleep = readSleep();
  const window = claudeWindow();
  await withLock(async () => {
    const state = readState();
    const pic = picture(state, window, Date.now(), sleep);
    const { entry, refuse } = pickNext(pic, among);
    if (!entry) throw new Error(refuse);
    const reason = "manual wake (next)";
    if (entry.handoff) {
      const r = await handOffLead({ state, from: entry.threadId, info: entry.info, plan: entry.plan, compactions: entry.handoff.compactions, cause: "wake",
        wake: { used: pic.used, pace: pic.pace, extra: {} }, asleep: sleep.asleep, deps: handoffDeps() });
      log("wake", { threadId: r.to, title: short(entry.info), plan: entry.plan, used: pic.used, pace: pic.pace, reason, handoffFrom: entry.threadId, ...(sleep.asleep ? { asleep: true } : {}) });
      console.log(`${r.say} instead of waking it`);
    } else await wake(state, entry, entry.info, pic.used, pic.pace, reason, {}, sleep.asleep);
  });
}

// The user's switch: `hold` keeps every queued thread snoozed (no wakes, no triage start) until `go`.
async function setHold(on) {
  await withLock(async () => {
    const state = readState();
    const held = on ? { since: new Date().toISOString(), note: option("--note") ?? null } : null;
    writeState({ ...state, held });
    log(on ? "hold" : "go", { note: held?.note ?? null, queued: state.queue.length, wasHeld: state.held?.since ?? null });
    console.log(on ? `queue on hold (${state.queue.length} queued stay snoozed); \`go\` resumes pacing` : state.held ? `queue resumed (held since ${state.held.since}); the next tick paces as usual` : "queue was not on hold");
  });
}

// `cap --add N`: spend about N more points of this window, evenly to the finish. `--off` ends it.
async function setCap() {
  await withLock(async () => {
    const state = readState();
    if (process.argv.includes("--off")) { writeState({ ...state, cap: null }); log("cap", { off: true }); console.log("cap off; the plain pace line again"); return; }
    const raw = option("--add");
    const add = raw == null || raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(add) || add < 0) throw new Error("cap needs --add N (points of this window) or --off");
    const window = claudeWindow();
    const { used, windowId } = paceOf(window);
    if (!windowId) throw new Error("no Claude window open");
    const cap = { windowId, from: used, add, setAt: new Date().toISOString() };
    writeState({ ...state, cap });
    log("cap", cap);
    console.log(`cap: ${used}% → ${used + add}% by the finish of the window resetting ${zoneLabel(window.resetsAt, { hour: "numeric", minute: "2-digit" })}; lapses at the reset`);
  });
}

// `remove`: the thread leaves the queue and woken list; its plan's age record goes too unless an
// open thread still holds the plan (its own ready entry included).
export function afterRemove(state, id, isOpen = isOpenThread) {
  const entry = state.queue.find((e) => e.threadId === id) ?? state.woken[id];
  const next = { ...state, queue: state.queue.filter((e) => e.threadId !== id), woken: Object.fromEntries(Object.entries(state.woken).filter(([k]) => k !== id)) };
  if (!entry?.plan || planHolders(next, null, entry.plan, isOpen).length) return next;
  const { [planKey(entry.plan)]: _, ...planAges } = next.planAges ?? {};
  return { ...next, planAges };
}
async function remove() {
  const id = option("--thread");
  if (!id) throw new Error("remove needs --thread <id>");
  await withLock(async () => {
    const state = readState();
    const entry = state.queue.find((e) => e.threadId === id) ?? state.woken[id];
    if (!entry) throw new Error("thread is not in the queue or woken list");
    writeState(afterRemove(state, id));
    // Unsnoozed, so it shows in the user's list again instead of sleeping for a week.
    // A thread paused by the usage limit keeps T3's snooze until the reset.
    const info = threadInfo(id);
    if (limitPaused(info)) console.log(`left snoozed: paused by the usage limit; T3 resumes it after ${info.usage_limit_reset_at}`);
    else if (!gone(info)) {
      try { await unsnoozeThread(id); }
      catch (e) { console.error(`unsnooze failed: ${e.message}`); }
    }
    log("remove", { threadId: id, title: entry.title, plan: entry.plan });
    console.log(`removed ${id} ${entry.title ?? ""}`);
  });
}

// Once the enqueuing turn ends, a queued thread that would be snoozed gets a /compact turn, while
// its cache is still warm: woken hours later it rereads a short summary plus the plan, not the
// whole triage (a long-snoozed thread wakes with a cold cache, so a big context costs a full
// reread). Returns the new `since` for the snooze check: our /compact message once T3 has
// recorded it (it moved the thread's latest user message), unless the user wrote since the enqueue,
// then the old one, so the hand-back still happens. A failed or slow compact is logged; the
// snooze goes on.
async function compactQueued(id, enqueuedAt, since) {
  const info = threadInfo(id);
  const entry = readState().queue.find((e) => e.threadId === id);
  if (!info || running(info)) return since;
  const act = deferredSnoozeAction({ entry, enqueuedAt, info, pending: pendingRequest(info), asks: askedOf(id).length > 0, wrote: !!userWrote(id, since) });
  if (!act.snooze) return since;
  const skip = compactSkip(entry);
  if (skip) { log("compact-skipped", { threadId: id, title: short(info), plan: entry.plan, why: skip }); return since; }
  // Under the lock, right before the /compact: a tick may have handed the thread off, re-queued
  // it or marked it due meanwhile (no /compact then), and a lead's turn can reach
  // handoffCompactions after its pause read the count: hand off (or mark it due) as the pause
  // would have. Leads only (leadEntry): the user's own threads and other first enqueues are not.
  const h = await withLock(async () => {
    const state = readState();
    const e = state.queue.find((q) => q.threadId === id);
    if (!e) return { skip: "left the queue before its /compact" };
    if (e.enqueuedAt !== enqueuedAt) return { skip: "re-queued before its /compact" };
    if (handedOff(state, id)) return { skip: "handed off before its /compact" };
    if (compactSkip(e)) return { skip: compactSkip(e) };
    if (!leadEntry(state, e)) return {};
    const lead = pauseHandoff({ compactions: compactionCount(id), threshold: readConfig().handoffCompactions, children: () => runningChildren(openThreads(), id, running) });
    const r = await pauseLeadHandoff({ state, id, info, entry: e, lead, at: new Date().toISOString() });
    if (r.say) return { skip: "handed off before its /compact" };
    if (r.entry) { writeState({ ...state, queue: upsert(state.queue, r.entry) }); return { skip: compactSkip(r.entry) }; }
    return {};
  });
  if (h.skip) { log("compact-skipped", { threadId: id, title: short(info), plan: entry.plan, why: h.skip }); return since; }
  const sentAt = new Date().toISOString();
  const before = compactionCount(id);
  const mine = () => t3Query("select created_at from orchestration_v2_projection_messages where thread_id=? and role='user' and json_extract(payload_json, '$.text')=? and created_at >= ? order by created_at desc limit 1", [id, COMPACT, sentAt])[0]?.created_at ?? null;
  let error = null;
  try { await turn(info, COMPACT); } catch (e) { error = e.message; }
  // Polls up to 10 min (T3's own compaction timeout); after a send error only 30 s, in case it landed.
  for (let i = 0; i < (error ? 10 : 200); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const t = threadInfo(id);
    if (mine() && t && !running(t)) break;
    if (i === 199) error = "still running after 10 min";
  }
  const at = mine();
  const compacted = compactionCount(id) > before;
  log(compacted ? "compact" : "compact-failed", { threadId: id, title: short(info), plan: entry.plan, ...(compacted ? {} : { error: error ?? "no compaction recorded", why: "snoozed uncompacted" }) });
  return at && !userWrote(id, since) ? at : since;
}

// Retries the snooze every 10 s while T3 refuses it. Stops (logged) if the entry left the
// queue or was re-queued, the thread is gone, or the user wrote in it: that thread is
// handed back to the user and leaves the queue.
async function snoozeLater() {
  const id = option("--thread");
  let since = option("--since") ?? "";
  const enqueuedAt = option("--enqueued");
  const afterTurn = flag("--after-turn");
  const started = Date.now();
  let compacted = !afterTurn;
  for (;;) {
    await new Promise((r) => setTimeout(r, afterTurn ? 3000 : 10000));
    // --after-turn: wait for the enqueuing turn to end (the tick covers it past an hour).
    if (afterTurn) { const t = threadInfo(id); if (t && running(t) && Date.now() - started < 3600e3) continue; }
    if (!compacted) { compacted = true; since = await compactQueued(id, enqueuedAt, since); }
    const done = await withLock(async () => {
      const state = readState();
      const info = threadInfo(id);
      const idle = !!info && !running(info);
      const r = await deferredSnoozeStep({ state, id, enqueuedAt, info, pending: pendingRequest(info), asks: idle && askedOf(id).length > 0, wrote: !!info && !!userWrote(id, since),
        deps: { log, unsnooze: unsnoozeThread, snooze: snoozeWeek } });
      if (r.state !== state) writeState(r.state);
      return r.done;
    });
    if (done) return;
  }
}

// The morning report goes out once per day, on the first timer run at or after reportAt
// (default 07:00) in the pacer's zone (pacer-report.timer runs every 15 min). `last` =
// report.json's day. Keyed by the local date, so a zone change the same day never sends a second one.
export function reportDue({ now = Date.now(), zone = userZone(), last = null, at = "07:00" } = {}) {
  const w = wallClock(now, zone);
  const [h, m] = at.split(":").map(Number);
  return { due: w.h * 60 + w.m >= h * 60 + m && last !== w.day, day: w.day, zone };
}
function readReportState() {
  try { return JSON.parse(fs.readFileSync(reportFile, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}

function parseSince(text) {
  const m = /^(\d+)([mhd])$/.exec(text);
  if (m) return new Date(Date.now() - Number(m[1]) * { m: MIN, h: 60 * MIN, d: 1440 * MIN }[m[2]]);
  const t = Date.parse(text);
  if (!Number.isFinite(t)) throw new Error(`bad --since ${text} (e.g. 10h or an ISO time)`);
  return new Date(t);
}

// Unsettled main threads with a pending native request or an idle one with a question for the user
// still open, queued (snoozed) ones included. The morning report and the wake digest list them.
function waitingThreads(state) {
  const queued = new Set(state.queue.map((e) => e.threadId));
  const asked = openAsks();
  return openThreads().filter((t) => !knownWorker(t) && !limitPaused(t) && (!snoozed(t) || queued.has(t.thread_id))
    && (pendingRequest(t) || (!running(t) && asked.has(t.thread_id))));
}
// Pipes markdown to config.json "reportCommand" (the morning report and the wake digest).
function postReport(md) {
  const { reportCommand } = readConfig();
  if (!reportCommand) throw new Error(`no "reportCommand" in ${configFile}`);
  const r = spawnSync("sh", ["-c", reportCommand], { input: md, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`reportCommand failed (${r.status}): ${(r.stderr ?? "").trim()}`);
  return r;
}

function report() {
  const since = parseSince(option("--since", "10h"));
  const lines = readLog().filter((l) => Date.parse(l.at) >= since.getTime());
  const state = readState();
  // Failed ticks and triage errors since the last report: the user reads this in the morning.
  const failed = lines.filter((l) => l.event === "error" && l.command === "tick");
  const triageErrors = lines.filter((l) => l.event === "triage-error");
  const errors = [];
  if (failed.length) errors.push(`- ${failed.length} tick${failed.length === 1 ? "" : "s"} failed (nothing woken or paused then), ${failed[0].at} to ${failed.at(-1).at}: ${failed.at(-1).error}`);
  const digestFails = lines.filter((l) => l.event === "wake-digest" && l.error);
  if (digestFails.length) errors.push(`- the wake digest didn't post: ${digestFails.at(-1).error}`);
  if (triageErrors.length) errors.push(`- ${triageErrors.length} triage error${triageErrors.length === 1 ? "" : "s"} (pacing went on): ${triageErrors.at(-1).error}`);
  for (const l of lines.filter((l) => l.event === "emergency-start")) errors.push(`- emergency thread started ${l.at}: "${l.title}" (${l.why})`);
  const emergencyErrors = lines.filter((l) => ["emergency-check-error", "emergency-error", "emergency-failed", "emergency-text-failed"].includes(l.event));
  if (emergencyErrors.length) errors.push(`- ${emergencyErrors.length} emergency step error${emergencyErrors.length === 1 ? "" : "s"}: ${emergencyErrors.at(-1).error}`);
  const zone = userZone();
  const at = (iso) => zoneLabel(iso, { hour: "numeric", minute: "2-digit" }, zone);
  const out = [`**Pacer report** since ${zoneLabel(since, { weekday: "short", hour: "numeric", minute: "2-digit" }, zone)}${zone === SYSTEM_ZONE ? "" : ` (times in ${zone})`}`,
    "Paces every main Claude thread: queued, pacer-woken and the user's own."];

  const cfg = readConfig();
  const windows = new Map();
  for (const l of lines.filter((l) => l.event === "tick")) {
    const key = [...windows.keys()].find((k) => sameWindow(k, l.window)) ?? l.window ?? "none";
    const w = windows.get(key) ?? { max: 0, last: null };
    w.max = Math.max(w.max, l.used ?? 0); w.last = l; windows.set(key, w);
  }
  // A night window should end near 100% (its line hits 100% nightFinishMin before the reset).
  out.push("", "**Usage per window**");
  if (!windows.size) out.push("- no ticks logged");
  for (const [id, w] of windows) {
    const night = id !== "none" && nightWindow(id, cfg, zone);
    const name = id === "none" ? "no window open" : `${night ? "night" : "day"} window ending ${at(id)}`;
    out.push(night ? `- ${name}: final ${w.last.used}% (aim ~100% by ${cfg.nightFinishMin} min before the reset; last tick vs night pace ${w.last.pace}% ${bandText(band(w.last.used))})`
      : `- ${name}: peak ${w.max}% (last tick ${w.last.used}% vs pace ${w.last.pace}% ${bandText(band(w.last.used))})`);
  }

  const events = lines.filter((l) => ["hold", "go", "wake", "ask-pause", "pause", "finished", "drop", "handoff", "enqueue", "resnooze", "triage-start", "ready"].includes(l.event));
  const verb = { wake: "woken", "ask-pause": "asked to pause", pause: "paused", finished: "finished (settled)", drop: "dropped from queue",
    hold: "queue put on hold", go: "queue resumed", handoff: "handed back to the user", enqueue: "queued", resnooze: "snoozed again (it had come unsnoozed)", "triage-start": "triage thread started", ready: "marked ready (plan fleshed out)" };
  out.push("", "**Threads**");
  if (!events.length) out.push("- nothing woken, paused or finished");
  for (const l of events) out.push(`- ${at(l.at)} ${verb[l.event]}${l.event === "hold" || l.event === "go" ? (l.note ? `: ${l.note}` : "") : `: ${l.title ?? l.threadId}`}${l.plan ? ` (\`${l.plan}\`)` : ""}${l.why && ["drop", "handoff"].includes(l.event) ? `, ${l.why}` : ""}`);

  // Commits in each woken thread's project.
  const roots = new Set();
  for (const id of new Set(lines.filter((l) => l.event === "wake").map((l) => l.threadId))) {
    const t = threadInfo(id);
    const root = t?.worktree_path ?? (t ? t3Query("select workspace_root from projection_projects where project_id=?", [t.project_id])[0]?.workspace_root : null);
    if (root) roots.add(root);
  }
  out.push("", "**Commits**");
  if (!roots.size) out.push("- no woken threads, so no projects to check");
  for (const root of roots) {
    const r = spawnSync("git", ["-C", root, "log", `--since=${since.toISOString()}`, "--format=%h %s"], { encoding: "utf8" });
    const commits = (r.stdout ?? "").trim().split("\n").filter(Boolean);
    out.push(`- \`${root}\`: ${commits.length ? `${commits.length} commit${commits.length > 1 ? "s" : ""}` : r.status ? `git failed: ${(r.stderr ?? "").trim()}` : "none"}`);
    for (const c of commits.slice(0, 15)) out.push(`  - ${c}`);
    if (commits.length > 15) out.push(`  - … ${commits.length - 15} more`);
  }

  let night = false;
  try { night = paceOf(claudeWindow(true), Date.now(), cfg).night; } catch { /* no cached probe: day order */ }
  const deps = depsOf(state);
  const q = queueRows(state, { cfg, night, deps });
  out.push("", `**Still queued (${q.length}, wake order)**`);
  for (const { e, rank: r } of q) out.push(`- [${r.priority}${e.size ? `, ${e.size}` : ""}] ${e.title}: ${describeRank(r)}; \`${e.plan}\``);

  // Unsettled main threads with a pending native request or whose last message asks the user
  // something, queued (snoozed) ones included: they show only here until answered.
  const waiting = waitingThreads(state);
  out.push("", `**Waiting on the user (${waiting.length})**`);
  for (const t of waiting) out.push(`- ${short(t)}`);
  const stuck = state.queue.filter((e) => e.handbackFailed);
  if (stuck.length) out.push("", "**Hand-back failures**", ...stuck.map((e) => `- couldn't hand back ${e.title}: ${e.handbackFailed.error}, retrying`));
  if (errors.length) out.push("", "**Errors**", ...errors);
  return out.join("\n");
}

const usage = `usage: pacer.mjs <command>
  enqueue [--thread ID] --plan PATH [--priority low|med|high|highest] [--size s|m|l] [--note TEXT] [--take-over]   queue + snooze a thread
                                   (refused while another open thread holds the plan; --take-over moves it here)
  pause   [--thread ID] [--plan PATH]   back in the queue after a pacer ask (+ paused bonus, keeps its age)
  ready   [--thread ID] --plan PATH     plan fleshed out: the pacer may ask this thread to pause (enqueue/pause imply it)
  built   --plan PATH [--thread ID]  all stages committed, only a live check left: plans waiting on it unblock
  wake    [--thread ID]            wake a queued thread now
  wake --next [--among ID,ID,…]    wake the next thread the pacer would wake (also on hold; no pace check);
                                   --among: only these threads; refuses with the reason when none can start
  handoff [--thread ID] [--plan PATH]   lead only: move it to a fresh thread (same title/model, pinned) told to
                                   continue from the plan's Resume; entries move, the old one is settled
  remove  --thread ID              take it out of the queue (unsnoozes it)
  cap --add N | --off              this window only: spend about N more points, evenly to the finish
  hold [--note TEXT] | go          stop waking queued threads (and starting triage) until go
  priority --thread ID --level low|med|high|highest   change a queued entry's priority only (no resnooze, keeps its age)
  list [--json] | status           queue / full picture; list --json: header, running and queue as JSON (cached usage)
  sleep                            asleep | night | awake, from config.json "sleepFile", plus the times
  tick [--dry-run]                 one pacing decision + the window's triage check (pacer.timer runs this every 5 min)
  triage --now [--json]            start a triage thread now (no window/24 h rule; also on hold); with an
                                   open triage thread it answers that one
  report [--since 10h] [--post] [--morning]   morning report; --post pipes it to config.json "reportCommand";
                                   --morning: only once a day, at/after config.json "reportAt" (the timer)`;

async function main() {
  if (["--help", "-h", "help"].includes(command)) { console.log(usage); return; }
  if (command === "enqueue") return enqueue({ pause: false });
  if (command === "pause") return enqueue({ pause: true });
  if (command === "ready") return markReady();
  if (command === "built") return markBuiltCommand();
  if (command === "tick") return tick();
  if (command === "triage") return triageNowCommand();
  if (command === "wake") return manualWake();
  if (command === "remove") return remove();
  if (command === "cap") return setCap();
  if (command === "hold") return setHold(true);
  if (command === "go") return setHold(false);
  if (command === "snooze-later") return snoozeLater();
  if (command === "priority") return setPriority();
  if (command === "list" && flag("--json")) { console.log(JSON.stringify(listJson())); return; }
  if (command === "list") return printQueue(readState(), { night: paceOf(listWindow(), Date.now(), readConfig(), { codingNight: readSleep().night }).night });
  if (command === "status") return status();
  if (command === "handoff") return handoff();
  if (command === "sleep") { console.log(sleepLine(readSleep())); return; }
  if (command === "report") {
    // --morning (the timer): only the first run at/after reportAt each local day.
    const morning = flag("--morning") ? reportDue({ last: readReportState().day ?? null, at: readConfig().reportAt }) : null;
    if (morning && !morning.due) return;
    const md = report();
    if (!flag("--post")) { console.log(md); return; }
    const { reportCommand } = readConfig();
    // The timer with no reportCommand: reports are off, not an error every 15 min.
    if (!reportCommand && morning) { console.log(`no "reportCommand" in ${configFile}: report off`); return; }
    if (!reportCommand) throw new Error(`no "reportCommand" in ${configFile}`);
    const r = spawnSync("sh", ["-c", reportCommand], { input: md, encoding: "utf8" });
    log("report", { posted: r.status === 0, output: ((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(0, 300) });
    if (r.status !== 0) throw new Error(`reportCommand failed (${r.status}): ${(r.stderr ?? "").trim()}`);
    if (morning) fs.writeFileSync(reportFile, JSON.stringify({ day: morning.day, zone: morning.zone, sentAt: new Date().toISOString() }) + "\n");
    console.log(r.stdout.trim() || "posted");
    return;
  }
  throw new Error(usage);
}

// A pacer that fails every tick wakes nothing (a whole night window can be lost). The catch
// path logs the failed tick (with `blind` when it got no usage window) and runs the emergency step:
// on the 3rd failed tick in a row that starts the "pacer-failing" thread, whose brief carries the
// fix steps. A failure during a T3 upgrade (t3Upgrade above) is logged but not counted.
export const errorStreak = (lines) => {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].event === "error" && lines[i].command === "tick") { if (!lines[i].t3Upgrade) n++; }
    else if (lines[i].event === "tick") break;
  }
  return n;
};
async function tickFailed(error) {
  const up = upgradeGrace(error);
  if (up) console.error(`T3 upgrading (runtime ${up.name.slice(0, 24)} ${up.ageMin} min old): this failed tick doesn't count toward the emergency`);
  try { log("error", { command, error, blind: !tickWindow, ...(up ? { t3Upgrade: true, t3Runtime: up.name, t3RuntimeAgeMin: up.ageMin, graceUntil: up.until } : {}) }); } catch {}
  try {
    await withLock(async () => {
      const lines = readLog().slice(-200);
      const r = await emergency({ failing: errorStreak(lines), blind: blindStreak(lines), error, check: !emergencyRan });
      for (const line of r.say) console.error(`emergency: ${line}`);
    });
  } catch (e) { try { log("emergency-error", { error: e.message, why: `emergency step after a failed tick: ${e.message}` }); } catch {} }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => {
    if (command === "tick" && !flag("--dry-run")) await tickFailed(e.message);
    console.error(e.message); process.exitCode = 1;
  });
}
