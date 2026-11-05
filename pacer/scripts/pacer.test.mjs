// node --test pacer/scripts/*.test.mjs
import "./testdata/test-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createMainThread } from "./lib/t3-api.mjs";
import { BLIND_TICKS, FAILING_TICKS, blindStreak, claudeLoginTick, emergencyBrief, emergencyLine, emergencyOpenFailedLine, emergencyStatus, emergencyTick, emergencyTitle, parseCauses, pacerCauses } from "./pacer.mjs";
import { SYSTEM_ZONE, reportDue, userZone, wallClock, zonedTime, zoneLabel } from "./pacer.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASLEEP_LINE, digestText, parseSleep, sleepLine, sleepState, sleepTick, wakeText, wokeTonight } from "./pacer.mjs";
import { activity, askText, automated, band, decide, dependencies, planNumber, waitsFor, isClaude, isReady, level, limitHit, nightWindow, ordered, paceOf, capPace, deferredSnoozeStep, enqueueRefusal, handBackEntry, notQueuedLine, priorEntry, queueEntryFrom, readyAfterEnqueue, withHandedBack, parseCount, pendingRequest, queuedAction, rank, sameWindow, settings, snoozed, isTriageThread, errorStreak, TRIAGE_RUNS_SQL, triageNow, triageRunsFrom, triageStatus, triageText, triageTick, triageTitle, upsert, t3Upgrade, tickBlind, upgradeGrace, upgradeStatus } from "./pacer.mjs";
import { DEFAULTS, describeRank, effectivePriority } from "./pacer.mjs";
import { pickNext } from "./pacer.mjs";

// Night windows are defined in local time; testdata/test-env.mjs pins it (EDT = UTC−4 in October)
// and config.json has no timeZone, so the pacer's zone is that system zone unless a test passes one.
const NOW = Date.parse("2026-10-08T22:00:00Z");

const q = (...ids) => ids.map((threadId) => ({ threadId }));
// Active threads default to ready (ran `ready`); pass { ready: false } for a not-ready one.
const act = (id, woken = null, asked = undefined, more = {}) => ({ threadId: id, pacerWoken: !!woken, wokenAt: woken, askedWindow: asked, ready: true, ...more });
const W = "2026-10-08T23:49:59.768Z";

test("pace line: 0 at window start, 51.7 at 2.5 h (100 at 10 min before the reset); no window = 0/0", () => {
  const now = Date.parse("2026-10-08T21:19:59.768Z"); // 2.5 h before W
  assert.deepEqual(paceOf({ usedPercent: 40, resetsAt: W }, now), { used: 40, pace: 51.7, windowId: "2026-10-08T23:50:00.000Z", night: false });
  // The same window probed twice (resetsAt jitters) keeps one id.
  assert.equal(paceOf({ usedPercent: 40, resetsAt: "2026-10-08T23:50:00.058Z" }, now).windowId, "2026-10-08T23:50:00.000Z");
  assert.equal(paceOf({ usedPercent: 0, resetsAt: W }, Date.parse(W) - 5 * 3600000).pace, 0);
  assert.equal(paceOf({ usedPercent: 99, resetsAt: W }, Date.parse(W) - 1).pace, 100);
  assert.deepEqual(paceOf(null, now), { used: 0, pace: 0, windowId: null, night: false });
  assert.deepEqual(paceOf({ usedPercent: 100, resetsAt: W }, Date.parse(W) + 1000), { used: 0, pace: 0, windowId: null, night: false });
});

const rows = [
  // [name, used, pace, active, working, ready, expected action, expected thread, expected source]
  // the wake rule counts working Claude Opus threads (workers included), not active main threads.
  ["nothing working: wake even far over pace (bootstrap)", 90, 20, [], 0, q("a", "b"), "wake", "a", "bootstrap"],
  ["3 active, none working: bootstrap", 54, 54, [act("x"), act("y"), act("z")], 0, q("a"), "wake", "a", "bootstrap"],
  // Band at used 54 is ±7, at used 72 ±6 (tol = 5 + 5 × (remaining − 10) / 90).
  ["1 working, used = pace: wake", 54, 54, [act("x")], 1, q("a"), "wake", "a", "queue"],
  ["1 working, used = pace+0.1: hold", 54.1, 54, [act("x")], 1, q("a"), "none"],
  ["5 working (cap 6), used = pace: wake", 54, 54, [act("x")], 5, q("a"), "wake", "a", "queue"],
  ["6 working (at the cap), used = pace: no wake", 54, 54, [act("x")], 6, q("a"), "none"],
  ["6 working, used = pace−6.9 (band ±7): no wake", 54, 60.9, [act("x")], 6, q("a"), "none"],
  ["6 working, used = pace−7 (band ±7): wake past the cap", 54, 61, [act("x")], 6, q("a"), "wake", "a", "past-cap"],
  ["6 working, used 72 = pace−6 (band ±6): wake past the cap", 72, 78, [act("x"), act("y")], 6, q("a"), "wake", "a", "past-cap"],
  ["empty queue, nothing working", 10, 50, [], 0, [], "none"],
  ["no window open (0/0), 1 working: wakes", 0, 0, [act("x")], 1, q("a"), "wake", "a", "queue"],
  ["no window open (0/0), 6 working: no wake", 0, 0, [act("x"), act("y")], 6, q("a"), "none"],
  ["used = pace+7 (band ±7) with 2 working: no ask yet", 54, 47, [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z")], 2, q("a"), "none"],
  ["over pace+7 (band ±7), 2 ready: ask the newest pacer-woken", 54, 46.9, [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z")], 2, [], "ask-pause", "y"],
  ["over pace, newest woken is the one the user didn't start", 80, 50, [act("mine"), act("old", "2026-10-08T09:00:00Z"), act("new", "2026-10-08T12:00:00Z")], 3, q("a"), "ask-pause", "new"],
  ["over pace, only the user's own threads: ask the one the user wrote in least recently", 80, 50,
    [act("r1", null, undefined, { userAt: "2026-10-08T12:00:00Z" }), act("r2", null, undefined, { userAt: "2026-10-08T09:00:00Z" })], 2, q("a"), "ask-pause", "r2"],
  ["over pace: a thread with a turn running beats an idle pacer-woken one", 80, 50,
    [act("idle", "2026-10-08T12:00:00Z"), act("busy", null, undefined, { running: true, userAt: "2026-10-08T12:30:00Z" })], 1, [], "ask-pause", "busy"],
  ["over pace: among running threads, the newest pacer-woken first", 80, 50,
    [act("mine", null, undefined, { running: true, userAt: "2026-10-08T08:00:00Z" }), act("old", "2026-10-08T09:00:00Z", undefined, { running: true }),
      act("new", "2026-10-08T10:00:00Z", undefined, { running: true })], 3, [], "ask-pause", "new"],
  ["used 95, nothing working, no wake yet this window: wake one", 95, 99, [], 0, q("a", "b"), "wake", "a", "spent"],
  ["used 95, 1 working: no wake", 95, 99, [act("x")], 1, q("a"), "none"],
  ["used 94.9 with nothing working: still wake", 94.9, 99, [], 0, q("a"), "wake", "a", "bootstrap"],
  ["over pace, 1 active: no ask (keep one running)", 99, 10, [act("x", "2026-10-08T10:00:00Z")], 1, [], "none"],
];
for (const [name, used, pace, active, working, ready, action, threadId, source] of rows) {
  test(name, () => {
    const d = decide({ used, pace, windowId: W, active, working, ready, now: NOW });
    assert.equal(d.action, action, d.reason);
    if (threadId) assert.equal(d.threadId, threadId);
    if (source) assert.equal(d.source, source);
  });
}

test("one ask per thread per window: asked newest blocks a repeat, a new window allows it", () => {
  const active = [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z", W)];
  assert.equal(decide({ used: 90, pace: 50, windowId: W, active, ready: [] }).action, "none");
  assert.equal(decide({ used: 90, pace: 50, windowId: "2026-10-09T04:49:59.768Z", active, ready: [] }).threadId, "y");
  // No window open: asks are keyed "none".
  assert.equal(decide({ used: 90, pace: 50, windowId: null, active: [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z", "none")], ready: [] }).action, "none");
});

test("an asked thread still active blocks a 2nd ask, even across window-id jitter", () => {
  const active = [act("r1", null, "2026-10-08T23:50:00.000Z", { userAt: "2026-10-08T09:00:00Z" }), act("r2", null, undefined, { userAt: "2026-10-08T08:00:00Z" })];
  const d = decide({ used: 90, pace: 50, windowId: "2026-10-09T00:00:00.000Z", active, ready: [] });
  assert.equal(d.action, "none");
  assert.match(d.reason, /waiting for the asked thread to pause/);
  // An ask from the previous window doesn't block.
  assert.equal(decide({ used: 90, pace: 50, windowId: "2026-10-09T04:50:00.000Z", active, ready: [] }).threadId, "r2");
});

test("at ≥ 95%: one wake per window, then it waits for the reset", () => {
  const first = decide({ used: 97, pace: 60, windowId: W, active: [], ready: q("a") });
  assert.equal(first.action, "wake");
  assert.equal(first.spentWake, true);
  // That window's one wake is used (recorded across window-id jitter): hold.
  const again = decide({ used: 97, pace: 60, windowId: "2026-10-09T00:00:00.000Z", active: [], ready: q("a"), spentWake: "2026-10-08T23:50:00.000Z" });
  assert.equal(again.action, "none");
  assert.match(again.reason, /one wake is used, waiting for reset/);
  // A new window gets its own.
  assert.equal(decide({ used: 97, pace: 60, windowId: "2026-10-09T04:50:00.000Z", active: [], ready: q("a"), spentWake: W }).action, "wake");
  // Under 95 the record doesn't matter; a normal wake records nothing.
  const normal = decide({ used: 50, pace: 60, windowId: W, active: [], ready: q("a"), spentWake: W });
  assert.equal(normal.action, "wake");
  assert.equal(normal.spentWake, undefined);
  // With something working there is no ≥ 95% wake at all.
  assert.match(decide({ used: 98, pace: 60, windowId: W, active: [act("x")], working: 1, ready: q("a") }).reason, /1 working, no wake, waiting for reset/);
  assert.equal(decide({ used: 97, pace: 60, windowId: W, active: [act("x")], working: 0, ready: q("a") }).action, "wake");
});

test("sameWindow: seconds of jitter or a 10-min rounding flip match; the next window doesn't", () => {
  assert.equal(sameWindow("2026-10-08T23:50:00.000Z", "2026-10-09T00:00:00.000Z"), true);
  assert.equal(sameWindow("2026-10-08T23:50:00.000Z", "2026-10-09T04:50:00.000Z"), false);
  assert.equal(sameWindow("none", null), true);
  assert.equal(sameWindow("none", W), false);
  assert.equal(sameWindow(undefined, W), false);
});

test("activity: waiting on the user is not active; wake grace holds until the woken turn ends", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const ago = (m) => new Date(now - m * 60000).toISOString();
  // `asked`: a question for the user still open (from the questions hook). Running, it's working.
  assert.deepEqual(activity({ running: true, now, asked: true }), { why: "turn running" });
  assert.deepEqual(activity({ completedAt: ago(5), now, asked: false }), { why: "turn ended < 20 min ago" });
  assert.deepEqual(activity({ completedAt: ago(5), now, asked: true }), { waiting: true });
  assert.equal(activity({ completedAt: ago(25), now, asked: true }), null);
  // Woken 3 min ago, its turn not started yet (last turn ended before the wake): active.
  assert.deepEqual(activity({ completedAt: ago(30), wokenAt: ago(3), now }), { why: "woken < 10 min ago" });
  assert.equal(activity({ completedAt: ago(30), wokenAt: ago(12), now }), null);
  // Woken 8 min ago and its turn already ended with a question open: waiting, not active.
  assert.deepEqual(activity({ completedAt: ago(1), wokenAt: ago(8), now, asked: true }), { waiting: true });
  // A pending native question or approval: waiting even though its turn is "running".
  assert.deepEqual(activity({ running: true, pending: true, now }), { waiting: true });
  assert.deepEqual(activity({ wokenAt: ago(2), pending: true, now }), { waiting: true });
});

test("pendingRequest reads T3's pending user-input and approval counts", () => {
  assert.equal(pendingRequest({ pending_user_input_count: 1, pending_approval_count: 0 }), true);
  assert.equal(pendingRequest({ pending_user_input_count: 0, pending_approval_count: 2 }), true);
  assert.equal(pendingRequest({ pending_user_input_count: 0, pending_approval_count: 0 }), false);
  assert.equal(pendingRequest({}), false);
  assert.equal(pendingRequest(null), false);
});

test("queued threads waiting on the user are not woken; the reason says so", () => {
  const all = decide({ used: 0, pace: 50, windowId: W, active: [], ready: [], waiting: 2, onUser: 2 });
  assert.equal(all.action, "none");
  assert.match(all.reason, /2 queued, waiting on the user$/);
  const mixed = decide({ used: 0, pace: 50, windowId: W, active: [], ready: [], waiting: 3, onUser: 1 });
  assert.match(mixed.reason, /3 queued, 1 waiting on the user, the rest with a turn running/);
  // Another queued thread is ready: it is woken past the waiting one.
  assert.equal(decide({ used: 0, pace: 50, windowId: W, active: [], ready: q("b"), waiting: 2, onUser: 1 }).threadId, "b");
  assert.match(decide({ used: 70, pace: 50, windowId: W, active: [act("x")], working: 1, ready: q("b"), waiting: 2, onUser: 1 }).reason, /no room .*; 1 waiting on the user/);
});

test("snoozed matches T3's isSnoozed: a run completed or failed after the snooze, or a pending request, wakes it", () => {
  const now = Date.parse("2026-10-09T00:20:00Z");
  const base = { snoozed_until: "2026-10-16T00:07:37Z", snoozed_at: "2026-10-09T00:07:37Z", turn_state: "completed", turn_completed_at: "2026-10-09T00:07:00Z" };
  assert.equal(snoozed(base, now), true);
  assert.equal(snoozed({ ...base, turn_completed_at: "2026-10-09T00:07:53Z" }, now), false);
  assert.equal(snoozed({ ...base, turn_state: "running", turn_completed_at: null }, now), true);
  assert.equal(snoozed({ ...base, turn_state: "failed", turn_completed_at: "2026-10-09T00:08:00Z" }, now), false);
  assert.equal(snoozed({ ...base, turn_state: "failed" }, now), true); // failed before the snooze
  assert.equal(snoozed({ ...base, turn_state: "failed", snoozed_at: null }, now), false);
  assert.equal(snoozed({ ...base, pending_approval_count: 1 }, now), false);
  assert.equal(snoozed({ ...base, snoozed_at: null, turn_completed_at: "2026-10-09T00:07:53Z" }, now), true);
  assert.equal(snoozed({ ...base, snoozed_until: "2026-10-09T00:10:00Z" }, now), false);
});

test("settle: wakes 10 min apart (nothing working: at once); at night asks wait 10 min after an ask or pause", () => {
  const ago = (m) => new Date(NOW - m * 60000).toISOString();
  const base = { used: 40, pace: 60, windowId: W, ready: q("a"), now: NOW };
  assert.equal(decide({ ...base, active: [act("x")], working: 1, lastWakeAt: ago(5) }).action, "none");
  assert.match(decide({ ...base, active: [act("x")], working: 1, lastWakeAt: ago(5) }).reason, /last wake was 5 min ago/);
  assert.equal(decide({ ...base, active: [act("x")], working: 1, lastWakeAt: ago(10) }).action, "wake");
  // Past the cap the settle holds too.
  assert.match(decide({ ...base, active: [act("x")], working: 7, lastWakeAt: ago(5) }).reason, /room past the cap .* last wake was 5 min ago/);
  // Nothing working: the bootstrap wake doesn't wait (an active thread with no turn running doesn't count).
  assert.equal(decide({ ...base, active: [], lastWakeAt: ago(1) }).action, "wake");
  assert.equal(decide({ ...base, active: [act("x")], working: 0, lastWakeAt: ago(1) }).action, "wake");
  const two = [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z")];
  const over = { used: 72, pace: 60, windowId: W, active: two, working: 2, ready: [], now: NOW };
  assert.match(decide({ ...over, night: true, lastPauseAt: ago(4) }).reason, /waiting 10 min to see if it helped/);
  assert.equal(decide({ ...over, night: true, lastAskAt: ago(11), lastPauseAt: ago(10) }).action, "ask-pause");
  assert.equal(decide({ ...over, lastPauseAt: ago(4) }).action, "ask-pause"); // by day, no wait
});

test("errorStreak counts failed ticks since the last good one", () => {
  const e = { event: "error", command: "tick" }, ok = { event: "tick" };
  assert.equal(errorStreak([ok, e, e, e]), 3);
  assert.equal(errorStreak([e, e, ok, e, { event: "wake" }, e]), 2);
  assert.equal(errorStreak([e, e, ok]), 0);
});

test("T3 upgrade grace: failed ticks while a runtime entry is < 15 min old don't count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pacer-t3rt-"));
  const at = (iso) => Date.parse(iso);
  const install = at("2026-10-27T02:02:04Z");
  fs.mkdirSync(path.join(dir, "sha256-old"));
  fs.utimesSync(path.join(dir, "sha256-old"), new Date(install - 86_400_000), new Date(install - 86_400_000));
  fs.mkdirSync(path.join(dir, "sha256-34489f78"));
  fs.utimesSync(path.join(dir, "sha256-34489f78"), new Date(install), new Date(install));
  const locked = "Error: database is locked", refused = "T3 not running (connection refused on port 3774)";
  // Three failures each fall inside the window and are marked.
  const lines = [{ event: "tick", blind: false }];
  for (const [iso, error] of [["2026-10-27T02:05:01Z", locked], ["2026-10-27T02:10:01Z", locked], ["2026-10-27T02:15:06Z", refused]]) {
    const up = upgradeGrace(error, { dir, now: at(iso) });
    assert.equal(up?.name, "sha256-34489f78", iso);
    lines.push({ event: "error", command: "tick", error, blind: true, t3Upgrade: true, graceUntil: up.until });
  }
  assert.equal(errorStreak(lines), 0);
  assert.equal(blindStreak(lines), 0);
  assert.deepEqual(pacerCauses({ failing: errorStreak(lines), blind: blindStreak(lines) }), []);
  assert.match(upgradeStatus(t3Upgrade({ dir, now: at("2026-10-27T02:15:06Z") }), lines), /T3 upgrading \(runtime sha256-34489f78 13 min old\): 3 failed ticks not counted/);
  // Past the window, or another kind of error, or no fresh dir: counted as before.
  assert.equal(upgradeGrace(refused, { dir, now: at("2026-10-27T02:17:05Z") }), null);
  assert.equal(upgradeGrace("queue.json: Unexpected token", { dir, now: at("2026-10-27T02:05:01Z") }), null);
  assert.equal(upgradeGrace(locked, { dir: path.join(dir, "missing"), now: at("2026-10-27T02:05:01Z") }), null);
  assert.equal(upgradeStatus(null, lines), null);
  // t3-api.mjs's own errors when T3 goes away mid-request or isn't listening.
  for (const error of ["message.dispatch: connection closed", "T3 server not reachable on port 3774: fetch failed", "SqliteError: SQLITE_BUSY",
    "T3 API changed (server 0.1.3): websocket refused (orchestrationProtocol=2; 426 means T3 wants another protocol)", "websocket ticket: HTTP 503"]) {
    assert.ok(upgradeGrace(error, { dir, now: at("2026-10-27T02:05:01Z") }), error);
    assert.equal(upgradeGrace(error, { dir, now: at("2026-10-27T02:17:05Z") }), null, `${error} counts after the window`);
  }
  // A T3 still down after the window: the marked ticks are passed over, the later ones trip it.
  const e = { event: "error", command: "tick", blind: true };
  const outage = [...lines, e, e, e];
  assert.equal(errorStreak(outage), 3);
  assert.equal(pacerCauses({ failing: errorStreak(outage) })[0].key, "pacer-failing");
  assert.equal(errorStreak([{ event: "error", command: "tick" }, ...lines.slice(1), e, e]), 3, "marked lines don't end the streak");
  assert.equal(blindStreak([...Array(4).fill(e), ...lines.slice(1), e, e]), 6);
  // The normal tick doesn't add its own blind tick during the window (5 prior blind + this one ≠ 6).
  assert.equal(tickBlind(5, t3Upgrade({ dir, now: at("2026-10-27T02:15:06Z") })), 5);
  assert.equal(tickBlind(5, t3Upgrade({ dir, now: at("2026-10-27T02:20:06Z") })), 6);
  fs.rmSync(dir, { recursive: true });
});

test("status prints the T3 upgrade line even when T3 is down", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pacer-t3rt-")), state = fs.mkdtempSync(path.join(os.tmpdir(), "pacer-state-"));
  fs.mkdirSync(path.join(dir, "sha256-new"));
  const r = spawnSync(process.execPath, [new URL("./pacer.mjs", import.meta.url).pathname, "status"], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PACER_T3_RUNTIME_DIR: dir, PACER_STATE_DIR: state, T3_PORT: "1", T3_URL: "http://127.0.0.1:1", T3_DB: path.join(state, "none.sqlite") } });
  assert.match(r.stdout, /^T3 upgrading \(runtime sha256-new 0 min old\): 0 failed ticks not counted/);
  fs.rmSync(dir, { recursive: true }); fs.rmSync(state, { recursive: true });
});

test("hold: nothing is woken, even with nothing running or a ≥ 95% wake left; asks still go out", () => {
  const held = { since: "2026-10-09T00:11:00Z", note: "sorting the list" };
  const idle = decide({ used: 0, pace: 50, windowId: W, active: [], ready: q("a"), held });
  assert.equal(idle.action, "none");
  assert.match(idle.reason, /queue on hold since .* \(sorting the list\); 1 queued, nothing woken until `go`/);
  assert.equal(decide({ used: 97, pace: 60, windowId: W, active: [], ready: q("a"), held }).action, "none");
  assert.equal(decide({ used: 30, pace: 50, windowId: W, active: [], ready: q("a"), night: true, held }).action, "none");
  assert.equal(decide({ used: 90, pace: 50, windowId: W, active: [act("x"), act("y")], ready: q("a"), held }).action, "ask-pause");
  assert.equal(decide({ used: 0, pace: 50, windowId: W, active: [], ready: q("a"), held: null }).action, "wake");
});

test("automated: the pacer's own texts, /compact and T3's limit resume; a bare \"continue\" is the user", () => {
  assert.equal(automated("Pacer: your turn (usage 10% vs pace 20%)."), true);
  assert.equal(automated("Continue where you left off."), true);
  assert.equal(automated("/compact"), true);
  assert.equal(automated("continue"), false);
  assert.equal(automated("Continue"), false);
  assert.equal(automated("ok go ahead"), false);
  assert.equal(automated("[Agent message from a peer] hi"), false, "other tools' texts count as the user's");
});

test("queued threads with a turn running are not woken; the reason says so", () => {
  const d = decide({ used: 0, pace: 50, windowId: W, active: [], ready: [], waiting: 2 });
  assert.equal(d.action, "none");
  assert.match(d.reason, /2 queued, all with a turn running/);
});

test("only the configured Claude instance counts as Claude", () => {
  assert.equal(isClaude('{"instanceId":"claudeAgent","model":"claude-opus-5-5"}'), true);
  assert.equal(isClaude('{"instanceId":"otherAgent","model":"claude-opus-5-5"}'), false);
  assert.equal(isClaude('{"instanceId":"codex","model":"some-model"}'), false);
  assert.equal(isClaude(null), false);
});

test("band: ±10 with the window untouched, narrowing linearly to ±5 at 10% left, ±5 below", () => {
  assert.equal(band(0), 10);
  assert.equal(band(54), 7);
  assert.equal(band(72), 6);
  assert.equal(Math.round(100 * band(50)) / 100, 7.22);
  assert.equal(band(90), 5);
  assert.equal(band(97), 5);
  assert.equal(band(100), 5);
});

// ---- Night mode ----------------------------------------------------------------------

const local = (hhmm, day = "2026-10-09") => new Date(`${day}T${hhmm}:00-04:00`).toISOString();

test("night window: reset between 00:00 and 10:00 local, both ends included", () => {
  assert.equal(nightWindow(local("00:00")), true);
  assert.equal(nightWindow(local("04:50")), true);
  assert.equal(nightWindow(local("10:00")), true);
  assert.equal(nightWindow(local("10:01")), false);
  assert.equal(nightWindow(local("23:59", "2026-10-08")), false);
  assert.equal(nightWindow(local("19:50", "2026-10-08")), false);
  assert.equal(nightWindow(null), false);
  // A range across midnight.
  const cfg = settings({ night: { resetFrom: "22:00", resetTo: "06:00" } });
  assert.equal(nightWindow(local("23:00", "2026-10-08"), cfg), true);
  assert.equal(nightWindow(local("06:00"), cfg), true);
  assert.equal(nightWindow(local("07:00"), cfg), false);
});

test("settings: config keys override defaults, absent keys keep them", () => {
  const cfg = settings({ nightFinishMin: 30, night: { resetTo: "09:00" }, priorityWeights: { low: 5 } });
  assert.equal(cfg.nightFinishMin, 30);
  assert.deepEqual(cfg.night, { resetFrom: "00:00", resetTo: "09:00" });
  assert.deepEqual(cfg.priorityWeights, { highest: 8, high: 4, med: 2, low: 5 });
  assert.equal(settings().pausedFactor, 1.5);
  assert.equal(settings().ageDays, 7);
});

test("night pace line: 100% at 30 min before the reset, capped at 100", () => {
  const reset = local("04:50");
  const at = (minBefore) => paceOf({ usedPercent: 10, resetsAt: reset }, Date.parse(reset) - minBefore * 60000);
  assert.equal(at(300).pace, 0);
  assert.equal(at(165).pace, 50); // 135 of 270 min
  assert.equal(at(30).pace, 100);
  assert.equal(at(5).pace, 100);
  assert.equal(at(160).night, true);
  // By day the line reaches 100% 10 min before the reset.
  const day = local("15:00");
  const dayAt = (minBefore) => paceOf({ usedPercent: 10, resetsAt: day }, Date.parse(day) - minBefore * 60000).pace;
  assert.equal(dayAt(155), 50); // 145 of 290 min
  assert.equal(dayAt(10), 100);
  assert.equal(dayAt(2), 100);
  assert.equal(paceOf({ usedPercent: 10, resetsAt: reset }, Date.parse(reset) - 160 * 60000, settings({ nightFinishMin: 0 })).pace, 46.7);
});

const nightRows = [
  // [name, used, pace, active, working, expected action]
  // The same band as by day (±6 at used 72), against the night pace line.
  ["night: 1 working, used = pace: wake", 72, 72, [act("x")], 1, "wake"],
  ["night: 1 working, used = pace+0.1: hold", 72.1, 72, [act("x")], 1, "none"],
  ["night: 6 working, used = pace−6: wake past the cap", 72, 78, [act("x"), act("y")], 6, "wake"],
  ["night: 6 working, used = pace−5.9: hold", 72, 77.9, [act("x"), act("y")], 6, "none"],
  ["night: used = pace+7.1 (1.2 × band ±6 = 7.2) with 2 ready: no ask", 72, 64.9, [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z")], 2, "none"],
  ["night: used = pace+7.3 with 2 ready: ask", 72, 64.7, [act("x", "2026-10-08T10:00:00Z"), act("y", "2026-10-08T11:00:00Z")], 2, "ask-pause"],
  ["night: no 95% cap, 1 working at 99%: wake", 99, 100, [act("x")], 1, "wake"],
];
for (const [name, used, pace, active, working, action] of nightRows) {
  test(name, () => assert.equal(decide({ used, pace, windowId: W, night: true, active, working, ready: q("a"), now: NOW }).action, action));
}

test("night: no one-wake limit at ≥ 95%, keeps one thread running until a thread hits the limit", () => {
  // The day rule's one ≥ 95% wake is already used this window; at night it doesn't matter.
  assert.equal(decide({ used: 100, pace: 100, windowId: W, night: true, active: [], ready: q("a"), spentWake: W, now: NOW }).action, "wake");
  assert.equal(decide({ used: 100, pace: 100, windowId: W, night: false, active: [], ready: q("a"), spentWake: W, now: NOW }).action, "none");
  // A thread at the usage limit: nothing new starts, even with nothing active.
  const d = decide({ used: 100, pace: 100, windowId: W, night: true, active: [], ready: q("a"), limited: ["ab12cd34 Lead 60"], now: NOW });
  assert.equal(d.action, "none");
  assert.match(d.reason, /ab12cd34 Lead 60 hit the usage limit; nothing new until the reset/);
  // By day the limit check isn't used (the 95% rule covers it).
  assert.equal(decide({ used: 50, pace: 60, windowId: W, active: [], ready: q("a"), limited: ["x"], now: NOW }).action, "wake");
  assert.match(decide({ used: 70, pace: 50, windowId: W, night: true, active: [act("x")], ready: [], waiting: 0, now: NOW }).reason, /night pace 50%/);
});

test("limitHit: a usage-limit error this window, with no turn completed since", () => {
  const windowStart = "2026-10-09T03:50:00.000Z";
  assert.equal(limitHit({ hitAt: "2026-10-09T07:00:00.000Z", completedAt: "2026-10-09T06:00:00.000Z", windowStart }), true);
  assert.equal(limitHit({ hitAt: "2026-10-09T07:00:00.000Z", completedAt: null, windowStart }), true);
  assert.equal(limitHit({ hitAt: "2026-10-09T07:00:00.000Z", completedAt: "2026-10-09T07:05:00.000Z", windowStart }), false);
  assert.equal(limitHit({ hitAt: "2026-10-09T03:00:00.000Z", completedAt: null, windowStart }), false); // earlier window
  assert.equal(limitHit({ hitAt: null, windowStart }), false);
});

test("reasons print the band: \"used 54% vs pace 50% ±7\"", () => {
  assert.match(decide({ used: 54, pace: 50, windowId: W, active: [act("x")], ready: q("a"), now: NOW }).reason, /^used 54% vs pace 50% ±7, 1 active/);
});

// ---- Queue priority -------------------------------------------------------------------

const H = 3600000;
const entry = (threadId, priority, hoursAgo, more = {}) => ({ threadId, priority, firstQueuedAt: new Date(NOW - hoursAgo * H).toISOString(), ...more });

const D = 24; // hours
test("rank: weight × (1 + days waiting / 7) × paused factor", () => {
  assert.equal(rank(entry("a", "med", 0), NOW).score, 2);
  assert.equal(rank(entry("a", "highest", 7 * D), NOW).score, 16);
  assert.equal(rank(entry("a", "high", 3.5 * D), NOW).score, 6);
  const r = rank(entry("a", "low", 7 * D, { pauses: 1 }), NOW);
  assert.equal(r.score, 3);
  assert.deepEqual(r.parts, { priority: 1, age: 2, paused: 1.5 });
  // Config weights and ageDays apply.
  assert.equal(rank(entry("a", "high", 0), NOW, settings({ priorityWeights: { high: 100 } })).score, 100);
  assert.equal(rank(entry("a", "med", 14 * D), NOW, settings({ ageDays: 14 })).score, 4);
  // firstQueuedAt survives a pause; an entry without it ages from enqueuedAt.
  assert.equal(rank({ threadId: "a", priority: "med", enqueuedAt: new Date(NOW - 7 * D * H).toISOString() }, NOW).score, 4);
});

test("legacy priorities: now → highest, normal → med, missing → med", () => {
  assert.equal(level("now"), "highest");
  assert.equal(level("normal"), "med");
  assert.equal(level(undefined), "med");
  assert.equal(level("high"), "high");
  assert.equal(rank(entry("a", "now", 0), NOW).score, 8);
  assert.equal(rank(entry("a", "normal", 0), NOW).score, 2);
});

const order = (queue, night = false) => ordered(queue, { now: NOW, night }).map((e) => e.threadId);

test("order: highest score first, ties to the earliest first-queued", () => {
  assert.deepEqual(order([entry("m", "med", 1), entry("h", "high", 0), entry("x", "highest", 0)]), ["x", "h", "m"]);
  // Equal scores (no ageing): the one queued first wakes first.
  const flat = settings({ ageDays: Infinity });
  assert.deepEqual(ordered([entry("late", "med", 1), entry("early", "med", 3)], { now: NOW, cfg: flat }).map((e) => e.threadId), ["early", "late"]);
});

test("ageing: a waiting low item overtakes a fresh med one after 7 days", () => {
  assert.deepEqual(order([entry("med", "med", 0), entry("low", "low", 6 * D)]), ["med", "low"]);
  assert.deepEqual(order([entry("med", "med", 0), entry("low", "low", 8 * D)]), ["low", "med"]);
});

test("paused bonus: started work resumes before fresh work of the same level", () => {
  assert.deepEqual(order([entry("fresh", "med", 2 * D), entry("paused", "med", 0, { pauses: 1 })]), ["paused", "fresh"]);
  // ...but not before a higher level far ahead.
  assert.deepEqual(order([entry("paused", "med", 0, { pauses: 1 }), entry("top", "highest", 0)]), ["top", "paused"]);
});

// Low entries: a non-low size s ranks as highest, so the tie-break only matters among
// low s and m/l of one level.
test("size tie-break: within 80% of the best l first at night, s first by day; further apart no effect", () => {
  const q3 = [entry("big", "low", 0, { size: "l" }), entry("mid", "low", 0.5 * D, { size: "m" }), entry("small", "low", 1 * D, { size: "s" })];
  assert.deepEqual(order(q3, true), ["big", "small", "mid"]);
  assert.deepEqual(order(q3, false), ["small", "mid", "big"]);
  // 1 vs 1.43 (70%): score wins.
  assert.deepEqual(order([entry("big", "low", 0, { size: "l" }), entry("small", "low", 3 * D, { size: "s" })], true), ["small", "big"]);
});

// "Prio small scopes to highest", "(Not including low prio)".
test("small plans rank as highest unless low; m, l and unsized keep their own level", () => {
  const W = DEFAULTS.priorityWeights;
  for (const p of ["med", "high", "now", "normal"]) {
    const r = rank(entry("s", p, 0, { size: "s" }), NOW);
    assert.equal(r.priority, "highest", p);
    assert.equal(r.parts.priority, W.highest, p);
  }
  assert.equal(rank(entry("s", "low", 0, { size: "s" }), NOW).priority, "low");
  assert.equal(rank(entry("m", "med", 0, { size: "m" }), NOW).priority, "med");
  assert.equal(rank(entry("l", "high", 0, { size: "l" }), NOW).priority, "high");
  assert.equal(rank(entry("n", "med", 0), NOW).priority, "med");
  const e = entry("s", "med", 0, { size: "s" });
  rank(e, NOW);
  assert.equal(e.priority, "med", "stored priority untouched");
  assert.deepEqual(effectivePriority({ priority: "med", size: "s" }), { priority: "highest", small: "med" });
  assert.deepEqual(effectivePriority({ priority: "highest", size: "s" }), { priority: "highest", small: null });
});

test("ordered: a fresh med s goes before an older high m and l; low s doesn't", () => {
  const q = [entry("oldHighM", "high", 3 * D, { size: "m" }), entry("oldHighL", "high", 3 * D, { size: "l" }), entry("freshMedS", "med", 0, { size: "s" }), entry("lowS", "low", 0, { size: "s" })];
  assert.deepEqual(order(q).slice(0, 1), ["freshMedS"]);
  assert.equal(order(q).at(-1), "lowS");
  assert.equal(order(q, true)[0], "freshMedS", "at night too: a small plan beats l outside the near tie");
});

test("ordered: a dependency lift wins when higher than the small rule; the small rule wins otherwise", () => {
  const plan = (n) => `/p/planning/${n}-x/plan.md`;
  // low s waited on by a highest plan: lifted to highest by the dependency
  const q = [{ ...entry("dep", "low", 0, { size: "s" }), plan: plan(1) }, { ...entry("top", "highest", 0, { size: "m" }), plan: plan(2) }, { ...entry("med", "med", 5 * D, { size: "m" }), plan: plan(3) }];
  const deps = dependencies(q, {}, (p) => ({ 2: "Wait for: plan 1" })[planNumber(p)] ?? "");
  assert.equal(deps.eff.get("dep"), "highest");
  assert.equal(rank({ ...q[0], lift: deps.eff.get("dep") }, NOW).priority, "highest");
  assert.deepEqual(ordered(q, { now: NOW, deps }).map((e) => e.threadId).slice(0, 2), ["dep", "top"]);
  // med s lifted to high by a dependency: the small rule (highest) is higher
  assert.equal(rank({ priority: "med", size: "s", firstQueuedAt: new Date(NOW).toISOString(), lift: "high" }, NOW).priority, "highest");
  // low s lifted to med: med (the small rule ignores low)
  assert.equal(rank({ priority: "low", size: "s", firstQueuedAt: new Date(NOW).toISOString(), lift: "med" }, NOW).priority, "med");
});

// dependencies() seeds from the effective level, so a small plan's highest
// passes to what it waits on (down the chain), ahead of an unrelated high/l.
test("dependencies: a small plan lifts its prerequisite (and the chain below) to highest", () => {
  const plan = (n) => `/p/planning/${n}-x/plan.md`;
  const e = (id, n, priority, size) => ({ ...entry(id, priority, 0, { size }), plan: plan(n) });
  const q = [e("small", 1, "med", "s"), e("pre", 2, "low", "m"), e("largeHigh", 3, "high", "l")];
  const deps = dependencies(q, {}, (p) => (planNumber(p) === 1 ? "Wait for: plan 2" : ""));
  assert.equal(deps.eff.get("pre"), "highest");
  assert.equal(deps.eff.has("small"), false, "its own effective level: not a lift");
  assert.deepEqual(ordered(q, { now: NOW, deps }).map((x) => x.threadId), ["pre", "small", "largeHigh"]);
  assert.match(describeRank(rank(q[0], NOW)), /\(small, was med\)/);
  const chain = [e("small", 1, "med", "s"), e("b", 2, "low", "m"), e("c", 3, "low", "m")];
  const d2 = dependencies(chain, {}, (p) => ({ 1: "Wait for: plan 2", 2: "Wait for: plan 3" })[planNumber(p)] ?? "");
  assert.equal(d2.eff.get("b"), "highest");
  assert.equal(d2.eff.get("c"), "highest");
  assert.deepEqual(ordered(chain, { now: NOW, deps: d2 }).map((x) => x.threadId), ["c", "b", "small"]);
});

// Size preference alone decides: low m (older, 1.14) vs low s and low l (fresh, 1): all near
// ties, so by day the s is picked first and at night the l.
test("size tie-break: by day a younger low s beats an older low m; at night the l goes first", () => {
  const q = [entry("m", "low", 1 * D, { size: "m" }), entry("s", "low", 0, { size: "s" }), entry("l", "low", 0, { size: "l" })];
  assert.equal(rank(q[0], NOW).score, 1.14);
  assert.deepEqual(order(q, false), ["s", "m", "l"]);
  assert.deepEqual(order(q, true), ["l", "m", "s"]);
});

test("describeRank says when the small rule raised it", () => {
  assert.match(describeRank(rank(entry("s", "med", 0, { size: "s" }), NOW)), /^score 8 = highest 8 \(small, was med\) × age 1 /);
  assert.doesNotMatch(describeRank(rank(entry("m", "med", 0, { size: "m" }), NOW)), /small/);
  assert.doesNotMatch(describeRank(rank(entry("h", "highest", 0, { size: "s" }), NOW)), /small/);
  assert.doesNotMatch(describeRank(rank({ ...entry("d", "med", 0, { size: "s" }), lift: "highest" }, NOW)), /small/);
});

test("upsert: re-enqueue updates in place, new entries append", () => {
  let queue = upsert([], { threadId: "a" });
  queue = upsert(queue, { threadId: "b" });
  queue = upsert(queue, { threadId: "a", plan: "new" });
  assert.deepEqual(queue.map((e) => e.threadId), ["a", "b"]);
  assert.equal(queue[0].plan, "new");
});

// ---- Pause target: never the user's recent thread, never a not-ready one ---------------

test("pause ask: a thread the user wrote in < 10 min ago is never asked and doesn't count toward the 2; if every candidate is like that, no ask", () => {
  const recent = new Date(NOW - 2 * 60000).toISOString();
  const old = new Date(NOW - 3 * H).toISOString();
  const lead = act("lead", null, undefined, { running: true, title: "Lead", userAt: recent });
  const other = act("other", null, undefined, { userAt: old });
  const third = act("third", null, undefined, { userAt: new Date(NOW - 2 * H).toISOString() });
  // two askable threads are needed; the lead the user just wrote in isn't one, so "other" runs alone.
  const lone = decide({ used: 80, pace: 50, windowId: W, active: [lead, other], ready: [], now: NOW });
  assert.equal(lone.action, "none");
  assert.match(lone.reason, /1 ready thread to ask, and one always runs: 0 not ready, 1 user-active \(Lead 2 min ago\)/);
  assert.equal(decide({ used: 80, pace: 50, windowId: W, active: [lead, other, third], ready: [], now: NOW }).threadId, "other");
  // 11 min after their message the lead can be asked again, and running goes first.
  assert.equal(decide({ used: 80, pace: 50, windowId: W, active: [lead, other], ready: [], now: NOW + 9 * 60000 }).threadId, "lead");
  // Every candidate written in just now: no ask, and the reason names the thread and minutes.
  const none = decide({ used: 80, pace: 50, windowId: W, active: [lead, act("b", null, undefined, { userAt: recent })], ready: [], now: NOW });
  assert.equal(none.action, "none");
  assert.equal(none.threadId, undefined);
  assert.match(none.reason, /no ready thread to ask: 0 not ready, 2 user-active \(Lead 2 min ago, b 2 min ago\)/);
  // 9 min 59 s is still recent; exactly 10 min is not.
  const at = (ms) => decide({ used: 80, pace: 50, windowId: W, active: [lead, act("b", null, undefined, { userAt: recent })], ready: [], now: Date.parse(recent) + ms }).action;
  assert.equal(at(10 * 60000 - 1000), "none");
  assert.equal(at(10 * 60000), "ask-pause");
});

test("pause ask: a not-ready thread is never asked and doesn't count toward the 2; a lone ready thread is never asked", () => {
  const old = new Date(NOW - 3 * H).toISOString();
  const unready = act("tri", null, undefined, { running: true, ready: false, userAt: old });
  const built = act("built", null, undefined, { userAt: old });
  const built2 = act("built2", null, undefined, { userAt: new Date(NOW - 2 * H).toISOString() });
  // The only ready thread must not be paused while two not-ready threads count.
  const lone = decide({ used: 80, pace: 50, windowId: W, active: [unready, act("tri2", null, undefined, { ready: false }), built], ready: [], now: NOW });
  assert.equal(lone.action, "none");
  assert.match(lone.reason, /1 ready thread to ask, and one always runs: 2 not ready, 0 user-active/);
  // Two ready: the running not-ready thread would win the sort; it is skipped for a ready one.
  const d = decide({ used: 80, pace: 50, windowId: W, active: [unready, built, built2], ready: [], now: NOW });
  assert.equal(d.threadId, "built");
  assert.match(d.reason, /1 not ready or user-active not asked/);
  // Only not-ready threads: no ask.
  const none = decide({ used: 80, pace: 50, windowId: W, active: [unready, act("tri2", null, undefined, { ready: false, userAt: old })], ready: [], now: NOW });
  assert.equal(none.action, "none");
  assert.match(none.reason, /over pace\+5.6, no ready thread to ask: 2 not ready, 0 user-active/);
  // Mixed: one not ready, one user-active.
  const mixed = decide({ used: 80, pace: 50, windowId: W, active: [unready, act("r", null, undefined, { userAt: new Date(NOW - 3 * 60000).toISOString() })], ready: [], now: NOW });
  assert.match(mixed.reason, /1 not ready, 1 user-active/);
  // Not-ready threads count for wakes only through `working` (their turn running).
  assert.equal(decide({ used: 50, pace: 50, windowId: W, active: [unready], working: 6, ready: q("a"), now: NOW }).action, "none");
  assert.equal(decide({ used: 60.1, pace: 50, windowId: W, active: [unready], working: 1, ready: q("a"), now: NOW }).action, "none");
});

test("isReady: ready entry, queued or pacer-woken; else not ready", () => {
  const state = { ready: { r: { plan: "/p" } }, woken: { w: { plan: "/p" } }, queue: [{ threadId: "q" }] };
  for (const id of ["r", "w", "q"]) assert.equal(isReady(state, id), true, id);
  assert.equal(isReady(state, "new"), false);
  assert.equal(isReady({ queue: [], woken: {} }, "r"), false);
});

test("ask text: finish the step, complete Resume, nothing waiting on the user, then pause; no write-a-plan branch", () => {
  const t = askText(80, 50);
  assert.match(t, /let a running Claude worker finish, don't start a new one/);
  assert.match(t, /^Pacer: over pace \(80% vs 50%\)/);
  assert.match(t, /Resume section is complete \(stages, decisions, next step, open risks\)/);
  assert.match(t, /nothing in it waits on the user/);
  assert.match(t, /pacer\.mjs pause --plan/);
  assert.doesNotMatch(t, /write one now|no plan file/);
});

test("queuedAction: hand back a queued thread waiting on the user, else keep it snoozed", () => {
  const base = { snoozed: false, running: false, pending: false, asks: false, userWrote: false };
  assert.equal(queuedAction({ ...base, snoozed: true }), null);
  assert.match(queuedAction(base).resnooze, /not snoozed/);
  assert.match(queuedAction({ ...base, running: true }).wait, /turn running/); // pause mid-turn: next tick
  // Waiting on the user is never re-snoozed: handed back, unsnoozed if snoozed.
  assert.deepEqual(queuedAction({ ...base, asks: true }), { handBack: "waiting on the user", unsnooze: false });
  assert.deepEqual(queuedAction({ ...base, asks: true, snoozed: true }), { handBack: "waiting on the user", unsnooze: true });
  assert.deepEqual(queuedAction({ ...base, pending: true, running: true, snoozed: true }), { handBack: "waiting on the user", unsnooze: true });
  // A running turn's text isn't final: no hand back on `asks` alone while it runs.
  assert.match(queuedAction({ ...base, asks: true, running: true }).wait, /turn running/);
});

test("queuedAction: the user chatting in a queued thread keeps it queued unless the reply asks them", () => {
  const base = { snoozed: false, running: false, pending: false, asks: false, userWrote: true, answered: true };
  // "ok can we snooze?" -> "yes, it's queued": stays queued and is snoozed again.
  assert.match(queuedAction(base).resnooze, /the user wrote in it while queued and the reply asks nothing/);
  assert.equal(queuedAction({ ...base, snoozed: true }), null);
  // The reply asks them something, or a native request is pending: handed back.
  assert.deepEqual(queuedAction({ ...base, asks: true }), { handBack: "waiting on the user", unsnooze: false });
  assert.deepEqual(queuedAction({ ...base, pending: true, running: true }), { handBack: "waiting on the user", unsnooze: false });
  // Turn running, or their message not answered yet: no decision this tick.
  assert.match(queuedAction({ ...base, running: true, asks: true }).wait, /turn running/);
  assert.match(queuedAction({ ...base, answered: false }).wait, /no reply yet/);
  // An older question the user has now answered isn't a hand-back.
  assert.match(queuedAction({ ...base, answered: false, asks: true }).wait, /no reply yet/);
});

test("enqueueRefusal: no enqueue or pause while a recorded question for the user is open", () => {
  assert.equal(enqueueRefusal({ pending: false, asks: [] }), null);
  assert.equal(enqueueRefusal({ pending: false }), null);
  assert.match(enqueueRefusal({ pending: false, asks: [{ id: "a1" }, { id: "a2" }] }), /2 questions for the user still open \(a1, a2\)/);
  assert.match(enqueueRefusal({ pending: true, asks: [] }), /pending/);
});

// Lifecycle (R5): a failed hand-back keeps the entry, marked, and the next tick's retry drops it.
test("handBackEntry: failure keeps the entry for the next tick; success drops it", async () => {
  const state = { queue: [{ threadId: "q1", title: "Q1", enqueuedAt: "t0" }, { threadId: "q2", title: "Q2", enqueuedAt: "t0" }], woken: {} };
  const calls = [];
  const down = { snoozed: true, now: "t1", unsnooze: async (id) => { calls.push(`unsnooze ${id}`); throw new Error("websocket connection failed"); } };
  const r1 = await handBackEntry(state, "q1", down);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "unsnooze: websocket connection failed");
  assert.deepEqual(r1.state.queue.map((e) => e.threadId), ["q1", "q2"]);
  assert.deepEqual(r1.state.queue[0].handbackFailed, { at: "t1", error: "unsnooze: websocket connection failed" });
  assert.deepEqual(calls, ["unsnooze q1"]);
  // not snoozed: nothing to undo, so it always succeeds
  assert.equal((await handBackEntry(state, "q1", { snoozed: false, unsnooze: async () => { throw new Error("not called"); } })).ok, true);
  // next tick, T3 back: dropped
  const r3 = await handBackEntry(r1.state, "q1", { snoozed: true, unsnooze: async () => {} });
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.state.queue.map((e) => e.threadId), ["q2"]);
});

// A queued thread asked the user, was handed back, then ran only `ready`.
// The hand-back leaves a note on its ready entry; `ready` then prints the enqueue that requeues it.
test("handBackEntry records handedBack; notQueuedLine gives the enqueue back", async () => {
  const state = { queue: [{ threadId: "q1", priority: "med", size: "m", enqueuedAt: "t0" }], woken: {}, ready: { q1: { plan: "/p.md", title: "Q1", readyAt: "t0" } } };
  const r = await handBackEntry(state, "q1", { snoozed: false, now: "t1", unsnooze: async () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.queue, []);
  assert.deepEqual(r.state.ready.q1.handedBack, { at: "t1", priority: "med", size: "m", firstQueuedAt: "t0", pauses: 0, note: null, plan: null });
  const line = notQueuedLine("q1", "/p.md", r.state.ready.q1.handedBack);
  assert.match(line, /^NOT QUEUED: the pacer took it out of the queue at t1/);
  assert.match(line, /pacer\.mjs enqueue --thread q1 --plan \/p\.md --priority med --size m/);
  assert.match(notQueuedLine("q2", "/p.md"), /it was never queued.*enqueue --thread q2 --plan \/p\.md`/);
});

// A lead, highest/l and queued for hours, is handed back by the deferred snooze (its turn ended
// on a question); its next `pause` must not rebuild the entry as med, age 0.
test("hand back then pause keeps priority, size, age and pauses", async () => {
  const q = { threadId: "q1", title: "Q1", plan: "/p.md", priority: "highest", size: "l", note: "S3", firstQueuedAt: "2026-10-28T08:00:00.000Z", enqueuedAt: "2026-10-29T01:00:00.000Z", pauses: 2 };
  // no ready entry yet: one is made to hold handedBack
  const r = await handBackEntry({ queue: [q], woken: {}, ready: {} }, "q1", { snoozed: true, now: "2026-10-29T02:00:00.000Z", unsnooze: async () => {} });
  assert.deepEqual(r.state.queue, []);
  assert.deepEqual(r.state.ready.q1, { plan: "/p.md", title: "Q1", readyAt: "2026-10-29T02:00:00.000Z",
    handedBack: { at: "2026-10-29T02:00:00.000Z", priority: "highest", size: "l", firstQueuedAt: "2026-10-28T08:00:00.000Z", pauses: 2, note: "S3", plan: "/p.md" } });
  const old = priorEntry(r.state, "q1");
  assert.equal(old, r.state.ready.q1.handedBack);
  const now = "2026-10-29T09:00:00.000Z";
  const e = queueEntryFrom({ id: "q1", title: "Q1", old, pause: true, now });
  assert.deepEqual(e, { threadId: "q1", title: "Q1", plan: "/p.md", priority: "highest", size: "l", note: "S3", firstQueuedAt: "2026-10-28T08:00:00.000Z", enqueuedAt: now, pauses: 3 });
  // flags on the command still win
  const f = queueEntryFrom({ id: "q1", title: "Q1", old, given: { priority: "low", size: "s", note: "n2", plan: "/other.md" }, pause: true, now });
  assert.equal(f.priority, "low"); assert.equal(f.size, "s"); assert.equal(f.note, "n2"); assert.equal(f.plan, "/other.md");
  assert.equal(f.firstQueuedAt, "2026-10-28T08:00:00.000Z");
  assert.equal(queueEntryFrom({ id: "q1", title: "Q1", old, given: { priority: "now" }, now }).priority, "highest");
  // nothing prior: med, age 0, needs --plan
  assert.deepEqual(queueEntryFrom({ id: "q2", title: "Q2", old: priorEntry({ queue: [], woken: {}, ready: {} }, "q2"), given: { plan: "/p.md" }, pause: true, now }),
    { threadId: "q2", title: "Q2", plan: "/p.md", priority: "med", size: null, note: null, firstQueuedAt: now, enqueuedAt: now, pauses: 1 });
  assert.throws(() => queueEntryFrom({ id: "q2", title: "Q2", old: null, now }), /--plan <path> is required/);
  assert.throws(() => queueEntryFrom({ id: "q2", title: "Q2", old, given: { priority: "urgent" }, now }), /--priority is/);
  // notQueuedLine still gives the enqueue with the kept flags
  assert.match(notQueuedLine("q1", "/p.md", r.state.ready.q1.handedBack), /because it asked the user something.*enqueue --thread q1 --plan \/p\.md --priority highest --size l/);
});

test("pause twice on a queued entry keeps priority and age; the queue entry wins over a stale handedBack", () => {
  const q = { threadId: "q1", title: "Q1", plan: "/p.md", priority: "highest", size: "l", note: null, firstQueuedAt: "t0", enqueuedAt: "t1", pauses: 0 };
  const stale = { at: "tx", priority: "low", size: "s", firstQueuedAt: "tx", pauses: 9, note: null, plan: "/p.md" };
  let state = { queue: [q], woken: {}, ready: { q1: { plan: "/p.md", title: "Q1", readyAt: "t0", handedBack: stale } } };
  const a = queueEntryFrom({ id: "q1", title: "Q1", old: priorEntry(state, "q1"), pause: true, now: "t2" });
  state = { ...state, queue: upsert(state.queue, a) };
  const b = queueEntryFrom({ id: "q1", title: "Q1", old: priorEntry(state, "q1"), pause: true, now: "t3" });
  assert.deepEqual([b.priority, b.size, b.firstQueuedAt, b.pauses], ["highest", "l", "t0", 2]);
  // a woken record also wins over handedBack
  const w = { plan: "/p.md", priority: "high", size: "m", firstQueuedAt: "tw", pauses: 1, note: null };
  assert.equal(priorEntry({ queue: [], woken: { q1: w }, ready: { q1: { handedBack: stale } } }, "q1"), w);
});

test("deferredSnoozeStep handoff (the user wrote) keeps the queue fields in handedBack", async () => {
  const entry = { threadId: "q1", title: "Q1", plan: "/p.md", priority: "highest", size: "l", note: null, firstQueuedAt: "t0", enqueuedAt: "e1", pauses: 1 };
  const info = { thread_id: "q1", title: "Q1", latest_user_message_at: "u2", snoozed_until: null };
  const deps = { log: () => {}, snooze: async () => {}, unsnooze: async () => {} };
  const r = await deferredSnoozeStep({ state: { queue: [entry], woken: {}, ready: {} }, id: "q1", enqueuedAt: "e1", info, pending: false, asks: false, wrote: true, deps, now: "t5" });
  assert.deepEqual(r.state.queue, []);
  const hb = r.state.ready.q1.handedBack;
  assert.deepEqual(hb, { at: "t5", priority: "highest", size: "l", firstQueuedAt: "t0", pauses: 1, note: null, plan: "/p.md", why: "the user wrote in it before the snooze landed" });
  const e = queueEntryFrom({ id: "q1", title: "Q1", old: priorEntry(r.state, "q1"), pause: true, now: "t6" });
  assert.deepEqual([e.priority, e.size, e.firstQueuedAt, e.pauses], ["highest", "l", "t0", 2]);
  assert.match(notQueuedLine("q1", "/p.md", hb), /at t5 because the user wrote in it before the snooze landed;/);
});

test("re-queue clears handedBack", async () => {
  const q = { threadId: "q1", title: "Q1", plan: "/p.md", priority: "highest", size: "l", firstQueuedAt: "t0", enqueuedAt: "t1", pauses: 0 };
  const r = await handBackEntry({ queue: [q], woken: {}, ready: { q1: { plan: "/p.md", title: "Q1", readyAt: "r0" } } }, "q1", { snoozed: false, now: "t2", unsnooze: async () => {} });
  assert.ok(r.state.ready.q1.handedBack);
  const e = queueEntryFrom({ id: "q1", title: "Q1", old: priorEntry(r.state, "q1"), pause: true, now: "t3" });
  const ready = readyAfterEnqueue(r.state.ready, e, "t3");
  assert.deepEqual(ready.q1, { plan: "/p.md", title: "Q1", readyAt: "r0" });
  assert.equal(priorEntry({ queue: [], woken: {}, ready }, "q1"), null);
});

test("withHandedBack keeps an existing ready entry's fields", () => {
  const ready = withHandedBack({ q1: { plan: "/a.md", title: "A", readyAt: "r0" } }, "q1", { plan: "/b.md", priority: "high", enqueuedAt: "e0" }, "t1");
  assert.deepEqual(ready.q1, { plan: "/a.md", title: "A", readyAt: "r0", handedBack: { at: "t1", priority: "high", size: null, firstQueuedAt: "e0", pauses: 0, note: null, plan: "/b.md" } });
});

// Lifecycle (R6): T3 refused the snooze (queued turn start); by the retry the turn has ended on a
// question for the user. The helper hands it back (unsnoozes if snoozed, never snoozes) and stops.
test("deferredSnoozeStep: a final question is handed back, never snoozed", async () => {
  const entry = { threadId: "q1", title: "Q1", plan: "/p.md", enqueuedAt: "e1" };
  const info = { thread_id: "q1", title: "Q1", latest_user_message_at: "u1", snoozed_until: null };
  const mk = (over = {}) => {
    const sent = []; const logged = [];
    return { sent, logged, deps: { log: (ev, d) => logged.push([ev, d]), snooze: async (id) => sent.push(`snooze ${id}`),
      unsnooze: async (id) => sent.push(`unsnooze ${id}`), ...over } };
  };
  const base = { state: { queue: [entry], woken: {} }, id: "q1", enqueuedAt: "e1", since: "u1", info, pending: false };

  const a = mk();
  const r = await deferredSnoozeStep({ ...base, asks: true, deps: a.deps });
  assert.equal(r.done, true);
  assert.deepEqual(a.sent, []); // not snoozed, so nothing to unsnooze
  assert.deepEqual(r.state.queue, []);
  assert.equal(a.logged[0][0], "handoff");

  const p = mk();
  const rp = await deferredSnoozeStep({ ...base, asks: false, pending: true, deps: p.deps });
  assert.deepEqual(p.sent, []);
  assert.deepEqual(rp.state.queue, []);

  // snoozed and the unsnooze fails: entry kept and marked, helper stops, the tick retries
  const f = mk({ unsnooze: async () => { throw new Error("websocket connection failed"); } });
  const rf = await deferredSnoozeStep({ ...base, info: { ...info, snoozed_until: "2099-01-01T00:00:00Z" }, asks: true, deps: f.deps });
  assert.equal(rf.done, true);
  assert.equal(rf.state.queue.length, 1);
  assert.match(rf.state.queue[0].handbackFailed.error, /websocket connection failed/);
  assert.equal(f.logged[0][0], "handback-failed");
  assert.ok(!f.sent.includes("snooze q1"));

  // no question: snoozes; still refused: keeps trying
  const s1 = mk();
  assert.equal((await deferredSnoozeStep({ ...base, asks: false, deps: s1.deps })).done, true);
  assert.deepEqual(s1.sent, ["snooze q1"]);
  const s2 = mk({ snooze: async () => { throw new Error("thread has a queued turn start"); } });
  assert.equal((await deferredSnoozeStep({ ...base, asks: false, deps: s2.deps })).done, false);
  // the user wrote: handoff, no T3 call
  const h = mk();
  const rh = await deferredSnoozeStep({ ...base, info: { ...info, latest_user_message_at: "u2" }, wrote: true, asks: true, deps: h.deps });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(rh.state.queue, []);
  // A newer agent message (a review result) isn't the user writing: still snoozed, still queued
  const g = mk();
  const rg = await deferredSnoozeStep({ ...base, info: { ...info, latest_user_message_at: "u2" }, wrote: false, asks: false, deps: g.deps });
  assert.deepEqual(g.sent, ["snooze q1"]);
  assert.deepEqual(rg.state.queue, [entry]);
  // re-queued since: skip, state untouched
  const k = mk();
  const rk = await deferredSnoozeStep({ ...base, enqueuedAt: "e0", asks: true, deps: k.deps });
  assert.equal(rk.state, base.state);
  assert.equal(k.logged[0][0], "snooze-skipped");
});

// Triage hook: once per Claude session window, checkCommand's count decides whether a triage
// thread starts. `world` fakes the check, the log and T3 (threads, pins, first messages); the
// thread is made by the real createMainThread. `failOnce: "<command type>"` makes that command
// throw once after it took effect (a crash or a lost reply); `refuse` makes T3 refuse it once;
// `saved` is queue.json on disk.
// `newOut` (string or since → string) adds checkNew, the early bugs-only check; `w.sinces` lists
// the `since` each call got.
function world({ out = "3\n", fail = null, failOnce = null, refuse = null, newOut = null } = {}) {
  const w = { logs: [], sent: [], threads: new Map(), messages: new Set(), closed: new Set(), checks: 0, ids: 0, saved: null, sinces: [] };
  const send = async (c) => {
    if (refuse === c.type) { refuse = null; throw new Error(`${c.type}: refused`); }
    w.sent.push(c);
    if (c.type === "thread.create") w.threads.set(c.threadId, { title: c.title, pinned_at: null });
    if (c.type === "thread.pin") w.threads.get(c.threadId).pinned_at = "2026-10-08T20:00:00Z";
    if (c.type === "message.dispatch") w.messages.add(c.messageId);
    if (failOnce === c.type) { failOnce = null; throw new Error(`${c.type}: process died`); }
  };
  const query = (sql, [id]) => sql.includes("projection_messages") ? (w.messages.has(id) ? [{ 1: 1 }] : [])
    : w.threads.has(id) ? [{ pinned_at: w.threads.get(id).pinned_at }] : [];
  w.send = send; w.query = query;
  w.count = (type) => w.sent.filter((c) => c.type === type).length;
  w.created = () => [...w.threads.keys()];
  w.deps = {
    check: () => { w.checks += 1; if (fail) throw new Error(fail); return typeof out === "function" ? out() : out; },
    newId: () => `00000000-0000-4000-8000-${String(++w.ids).padStart(12, "0")}`,
    save: (state) => { w.saved = state; },
    create: (pass, { resume }) => createMainThread({ threadId: pass.threadId, messageId: pass.messageId, projectId: "p", title: triageTitle(pass.count, pass.kind),
      text: triageText(pass.count, pass.kind, pass.since), modelSelection: {}, resume }, { send, query }),
    isOpen: (id) => w.threads.has(id) && !w.closed.has(id),
    log: (event, fields) => w.logs.push({ event, ...fields }),
  };
  if (newOut != null) w.deps.checkNew = (since) => { w.sinces.push(since); return typeof newOut === "function" ? newOut(since) : newOut; };
  return w;
}
const W1 = "2026-10-08T23:50:00.000Z", W1_START = Date.parse(W1) - 5 * 3600000;
const W2 = "2026-10-09T04:50:00.000Z", W2_START = Date.parse(W2) - 5 * 3600000;
const T1 = "00000000-0000-4000-8000-000000000001";

test("triage: N = 0 starts nothing and the window is checked once", async () => {
  const w = world({ out: "0\n" });
  let r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 60000 });
  assert.equal(w.created().length, 0);
  assert.deepEqual(w.logs.map((l) => l.event), ["triage-none"]);
  assert.equal(r.state.triage.outcome, "none");
  r = await triageTick({ state: r.state, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
  assert.equal(w.checks, 1); // not re-checked this window
});

test("triage: N > 0 starts one main thread \"Triage: N new items\" per window, unpinned", async () => {
  const w = world({ out: "3\n" });
  let r = await triageTick({ state: { queue: [] }, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 60000 });
  assert.deepEqual(w.created(), [T1]);
  // Created, then its first message; no pin.
  assert.deepEqual(w.sent.map((c) => c.type), ["thread.create", "message.dispatch"]);
  assert.equal(w.sent[0].title, "Triage: 3 new items");
  assert.equal(w.sent[1].text, triageText(3));
  assert.deepEqual(w.logs.map((l) => [l.event, l.title, l.count]), [["triage-start", "Triage: 3 new items", 3]]);
  assert.equal(r.state.triage.threadId, T1);
  assert.equal(r.state.triage.pending, null);
  assert.equal(w.saved.triage.pending.threadId, T1); // saved before anything was sent
  assert.deepEqual(r.state.queue, []); // the rest of the state is kept
  // Second tick, same window (resetsAt jitter included): nothing.
  r = await triageTick({ state: r.state, windowId: "2026-10-08T23:50:00.000Z", windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(w.checks, 1);
  // Next window, last thread settled, 3 items 5 h after the last run: wait (≤ 5 items, < 24 h).
  w.closed.add(T1);
  r = await triageTick({ state: r.state, windowId: W2, windowStart: W2_START, deps: w.deps, now: W2_START + 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(w.logs.at(-1).event, "triage-skip");
  // A day later: a new pass even with 3 items.
  const W3 = "2026-10-10T04:50:00.000Z", W3_START = Date.parse(W3) - 5 * 3600000;
  r = await triageTick({ state: r.state, windowId: W3, windowStart: W3_START, deps: w.deps, now: W3_START + 60000 });
  assert.equal(w.created().length, 2);
  assert.equal(triageTitle(1), "Triage: 1 new item");
  assert.equal(triageText(3), "Triage the 3 new items.");
  const cfg = { title: "Sort {count}", message: "Sort {items} in the list." };
  assert.equal(triageTitle(2, cfg), "Sort 2");
  assert.equal(triageText(1, cfg), "Sort 1 new item in the list.");
});

for (const died of ["thread.create", "message.dispatch"]) {
  test(`triage: the pacer dies right after ${died}; the restart finishes the same pass: one thread, one first message`, async () => {
    const w = world({ out: "3", failOnce: died });
    await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 60000 });
    // Restart: only what was saved to disk survives.
    const r = await triageTick({ state: w.saved, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
    assert.deepEqual(w.created(), [T1]);
    assert.deepEqual([w.count("thread.create"), w.count("thread.pin"), w.count("message.dispatch")], [1, 0, 1]);
    assert.equal(w.messages.size, 1);
    assert.equal(w.threads.get(T1).pinned_at, null);
    assert.deepEqual([r.state.triage.outcome, r.state.triage.threadId, r.state.triage.pending], ["started", T1, null]);
    assert.equal(w.logs.at(-1).resumed, true);
    // And nothing more this window.
    await triageTick({ state: r.state, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 11 * 60000 });
    assert.equal(w.created().length, 1);
  });
}

test("triage: a step T3 refuses is logged and the next tick finishes the same thread", async () => {
  const w = world({ out: "3", refuse: "message.dispatch" });
  let r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START });
  assert.equal(w.logs[0].event, "triage-error");
  assert.match(w.logs[0].why, /next tick finishes the same thread/);
  assert.equal(r.state.triage.pending.threadId, T1);
  w.deps.check = () => { throw new Error("not re-checked while a pass is pending"); };
  r = await triageTick({ state: r.state, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
  assert.deepEqual(w.created(), [T1]);
  assert.equal(w.count("thread.create"), 1);
  assert.equal(w.count("message.dispatch"), 1);
  assert.equal(r.state.triage.outcome, "started");
});

test("triage: a thread started just before its own window opened isn't doubled", async () => {
  // Tick with no window open starts it; its first turn opens W1 a minute later.
  const w = world({ out: "3" });
  let r = await triageTick({ state: {}, windowId: null, windowStart: W1_START - 5 * 3600000, deps: w.deps, now: W1_START - 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(r.state.triage.startedWindow, "none");
  r = await triageTick({ state: r.state, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 4 * 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(w.logs.at(-1).event, "triage-wait");
  assert.equal(r.state.triage.outcome, "wait");
  assert.match(triageStatus({ triage: {}, last: r.state.triage, windowId: W1 }), /3 new items open, triage thread 00000000 still open/);
  // Still open in the next window: still no second thread.
  r = await triageTick({ state: r.state, windowId: W2, windowStart: W2_START, deps: w.deps, now: W2_START + 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(w.logs.at(-1).event, "triage-wait");
});

test("triage: the user's own triage thread counts: open blocks a pass; a recent one counts as the last run", async () => {
  const mine = { threadId: "7660ab03-0000-4000-8000-000000000000", title: "Triage the list", createdAt: new Date(W1_START - 3 * 3600000).toISOString(), open: true };
  const w = world({ out: "29" });
  w.deps.runs = () => [mine];
  let r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 60000 });
  assert.equal(w.created().length, 0);
  assert.match(w.logs.at(-1).why, /7660ab03 "Triage the list" is still open/);
  assert.match(triageStatus({ triage: {}, last: r.state.triage, windowId: W1 }), /triage thread 7660ab03 still open/);
  // Settled 3 h ago with 4 items: skip; with 6 items: a pass.
  mine.open = false;
  const few = world({ out: "4" }); few.deps.runs = () => [mine];
  r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: few.deps, now: W1_START + 60000 });
  assert.deepEqual([few.created().length, few.logs.at(-1).event, r.state.triage.outcome], [0, "triage-skip", "skip"]);
  const many = world({ out: "6" }); many.deps.runs = () => [mine];
  await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: many.deps, now: W1_START + 60000 });
  assert.equal(many.created().length, 1);
});

test("isTriageThread: triage titles and requests, not markdown briefs or other threads", () => {
  assert.equal(isTriageThread("Triage the list", "triage now"), true);
  assert.equal(isTriageThread("New thread", "/triage"), true);
  assert.equal(isTriageThread("New thread", "Triage the 3 new items."), true);
  assert.equal(isTriageThread("New thread", "Sort 3 new items", "Sort {items}"), true, "configured message");
  assert.equal(isTriageThread("Reply fallback", "# Brief: x\n\ntriage the list"), false);
  assert.equal(isTriageThread("Keep Queued Threads Snoozed", "pause queue, going through triage"), false);
});

test("triage: a failing checkCommand is logged once, shown on the Triage line, and retried next window", async () => {
  const w = world({ fail: "checkCommand exited 2" });
  let r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 60000 });
  assert.deepEqual(w.logs.map((l) => l.event), ["triage-error"]);
  assert.match(w.logs[0].error, /exited 2/);
  assert.deepEqual([r.state.triage.window, r.state.triage.outcome, r.state.triage.checkError], [W1, "error", "checkCommand exited 2"]);
  assert.match(triageStatus({ triage: {}, last: r.state.triage, windowId: W1 }), /checked this window at .*: check failed \(checkCommand exited 2\), nothing started; next window tries again/);
  // Same window: no second check, no second log.
  r = await triageTick({ state: r.state, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
  assert.deepEqual([w.checks, w.logs.length], [1, 1]);
  // Next window it works again.
  w.deps.check = () => "2";
  r = await triageTick({ state: r.state, windowId: W2, windowStart: W2_START, deps: w.deps, now: W2_START + 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(r.state.triage.checkError, null);
  // Output that isn't a count is an error too, not 0.
  const bad = world({ out: "usage: triage-cmd ..." });
  r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: bad.deps, now: W1_START });
  assert.deepEqual([bad.logs[0].event, bad.created().length], ["triage-error", 0]);
  assert.throws(() => parseCount(""), /not a count/);
  assert.equal(parseCount(" 12\n"), 12);
});

test("triage: --dry-run checks and says, but neither creates, logs, saves nor records", async () => {
  const w = world({ out: "3" });
  const r = await triageTick({ state: {}, windowId: W1, windowStart: W1_START, deps: w.deps, dryRun: true, now: W1_START });
  assert.deepEqual([w.created().length, w.logs.length, r.state.triage, w.saved], [0, 0, undefined, null]);
  assert.deepEqual(r.say, ['would start a triage thread "Triage: 3 new items"']);
});

test("triage status line", () => {
  assert.match(triageStatus({ triage: null, last: null, windowId: W1 }), /off/);
  assert.match(triageStatus({ triage: {}, last: null, windowId: W1 }), /not checked this window yet/);
  assert.match(triageStatus({ triage: {}, last: { window: W1, outcome: "none", count: 0, checkedAt: "x" }, windowId: W1 }), /no open items/);
  assert.match(triageStatus({ triage: {}, last: { window: W1, outcome: "started", count: 2, threadId: "abcdef12-x", checkedAt: "x" }, windowId: W1 }), /started abcdef12 "Triage: 2 new items"/);
});

// Plan dependencies: a plan others wait on takes their highest priority and
// wakes just before them; a plan whose dependency is queued, woken or building isn't woken.
test("waitsFor / planNumber read Wait-for lines; 'satisfied' lines don't count", () => {
  assert.equal(planNumber("/x/planning/92-x/plan.md"), 92);
  assert.deepEqual(waitsFor("Wait for: plan 91 (planning/91-x/plan.md) done.\n- **Wait for plan 75: satisfied**\n| S5 | planned — **waits for plan 79 S3** |"), [91, 79]);
  assert.deepEqual(waitsFor("- **Wait for: plan 73 S2 committed**"), [73]);
  assert.deepEqual(waitsFor("no deps here"), []);
});

test("dependencies: a low plan a highest one waits on is raised (down the chain) and ordered first", () => {
  const T = new Date(NOW).toISOString();
  const e = (id, n, priority) => ({ threadId: id, plan: `/p/planning/${n}-x/plan.md`, priority, enqueuedAt: T });
  const queue = [e("top", 10, "highest"), e("mid", 11, "low"), e("base", 12, "low"), e("other", 13, "high")];
  const plans = { 10: "Wait for: plan 11", 11: "Wait for: plan 12", 12: "", 13: "" };
  const deps = dependencies(queue, {}, (p) => plans[planNumber(p)]);
  assert.equal(deps.eff.get("mid"), "highest");
  assert.equal(deps.eff.get("base"), "highest");
  assert.equal(deps.eff.has("other"), false);
  assert.deepEqual(deps.blockedBy.get("top").map((b) => b.state), ["queued"]);
  assert.deepEqual(ordered(queue, { now: NOW, deps }).map((x) => x.threadId), ["base", "mid", "top", "other"]);
  // Without deps the old order stands.
  assert.deepEqual(ordered(queue, { now: NOW }).map((x) => x.threadId), ["top", "other", "mid", "base"]);
});

test("dependencies: woken or building dependency blocks; a cycle still orders everything", () => {
  const e = (id, n) => ({ threadId: id, plan: `/p/planning/${n}-x/plan.md`, priority: "med", enqueuedAt: new Date(NOW).toISOString() });
  const d1 = dependencies([e("a", 1), e("b", 2)], { w: { plan: "/p/planning/3-x/plan.md" } }, (p) => ({ 1: "Wait for: plan 3", 2: "Wait for: plan 4" })[planNumber(p)], { o: "/p/planning/4-x/plan.md" });
  assert.deepEqual(d1.blockedBy.get("a"), [{ plan: 3, threadId: "w", state: "woken" }]);
  assert.deepEqual(d1.blockedBy.get("b"), [{ plan: 4, threadId: "o", state: "building" }]);
  const cyc = [e("a", 1), e("b", 2)];
  const d2 = dependencies(cyc, {}, (p) => ({ 1: "Wait for: plan 2", 2: "Wait for: plan 1" })[planNumber(p)]);
  assert.equal(ordered(cyc, { now: NOW, deps: d2 }).length, 2);
});

test("decide: queue entries waiting for another plan are named in the reason", () => {
  const d = decide({ used: 0, pace: 0, windowId: "w", active: [], ready: [], waiting: 2, blocked: 2 });
  assert.match(d.reason, /2 queued, 2 waiting for another plan$/);
});

// --- Sleep file. Fri 2026-10-09 22:00 EDT bedtime; night until Sat 09:00 EDT.
const BED = "2026-10-10T02:00:00.000Z", UNTIL = "2026-10-10T13:00:00.000Z";
const night = (more = {}) => ({ day: "2026-10-09", bedtime_at: BED, night_until: UNTIL, wake_at: null, updated_at: BED, ...more });
const at = (iso) => Date.parse(iso);

test("sleepState: asleep from bedtime to the first wake (or 12:00); coding night until 09:00 regardless", () => {
  const pick = (s) => [s.label, s.asleep, s.night];
  assert.deepEqual(pick(sleepState(night(), at("2026-10-10T01:59:00Z"))), ["awake", false, false], "before bedtime");
  assert.deepEqual(pick(sleepState(night(), at("2026-10-10T03:00:00Z"))), ["asleep", true, true], "23:00, no wake");
  assert.deepEqual(pick(sleepState(night({ wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-10T11:00:00Z"))), ["night", false, true], "woke 06:40, 07:00: still coding night");
  assert.deepEqual(pick(sleepState(night({ wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-10T13:00:00Z"))), ["awake", false, false], "09:00: clock rules again");
  assert.deepEqual(pick(sleepState(night(), at("2026-10-10T14:30:00Z"))), ["asleep", true, false], "10:30, never opened: asleep, but not coding night");
  assert.deepEqual(pick(sleepState(night(), at("2026-10-10T16:00:00Z"))), ["awake", false, false], "12:00: asleep ends anyway");
  assert.deepEqual(pick(sleepState({ day: "2026-10-09", bedtime_at: null, night_until: null, wake_at: null }, at("2026-10-10T03:00:00Z"))), ["awake", false, false], "bedtime undone");
  assert.equal(sleepState(null, at("2026-10-10T03:00:00Z"), "no sleep file at /x").note, "no sleep file at /x");
});

test("parseSleep: the contract parses; garbled files throw (the tick then uses the clock)", () => {
  assert.equal(parseSleep(JSON.stringify(night())).bedtime_at, BED);
  assert.equal(parseSleep(JSON.stringify({ day: "2026-10-09", bedtime_at: null, night_until: null, wake_at: null })).bedtime_at, null);
  assert.throws(() => parseSleep("{not json"));
  assert.throws(() => parseSleep("[]"), /object/);
  assert.throws(() => parseSleep(JSON.stringify(night({ night_until: null }))), /night_until is missing/);
  assert.throws(() => parseSleep(JSON.stringify(night({ bedtime_at: "soon" }))), /bedtime_at is not a time/);
  assert.throws(() => parseSleep(JSON.stringify(night({ wake_at: 7 }))), /wake_at is not a time/);
});

test("coding night: a day window (reset 15:00) counts as night: night pace line", () => {
  const reset = "2026-10-10T19:00:00.000Z"; // 15:00 EDT: a day window by the clock
  const now = at(reset) - 2.5 * 3600000;
  assert.equal(paceOf({ usedPercent: 40, resetsAt: reset }, now).night, false);
  const p = paceOf({ usedPercent: 40, resetsAt: reset }, now, settings(), { codingNight: true });
  assert.equal(p.night, true);
  assert.equal(p.pace, 55.6, "100% at 30 min before the reset");
  assert.equal(paceOf(null, now, settings(), { codingNight: true }).night, true, "no window open: still night order");
  // Night: size l first among near ties, and no 95% cap.
  const queue = [{ threadId: "s", size: "s", priority: "low", firstQueuedAt: "2026-10-09T00:00:00Z" }, { threadId: "l", size: "l", priority: "low", firstQueuedAt: "2026-10-09T01:00:00Z" }];
  assert.equal(ordered(queue, { now, night: p.night })[0].threadId, "l");
});

test("wake text: the asleep line only while the user is asleep", () => {
  assert.ok(wakeText(40, 50, "/p.md", true).endsWith(ASLEEP_LINE));
  assert.match(ASLEEP_LINE, /write the question into the plan's Questions section, carry on/);
  assert.ok(!wakeText(40, 50, "/p.md", false).includes("asleep"));
});

test("sleepLine: label first, then the times", () => {
  assert.match(sleepLine(sleepState(night(), at("2026-10-10T03:00:00Z"))), /^asleep \(bedtime Fri 22:00, coding night until Sat 09:00; asleep until the sleep file records a wake, at the latest Sat 12:00\)$/);
  assert.match(sleepLine(sleepState(night({ wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-10T11:00:00Z"))), /^night \(.*woke Sat 06:40\)$/);
  assert.match(sleepLine(sleepState(null, 0, "garbled /s.json: x")), /^awake \(garbled \/s.json: x: clock rules\)$/);
});

function sleepDeps(titles = ["Lead 80", "Lead 81"], post = () => {}) {
  const logs = [], posts = [];
  return { logs, posts, deps: { waiting: () => titles, post: (md) => { posts.push(md); post(md); }, log: (event, f) => logs.push({ event, ...f }) } };
}

test("sleepTick: each state change logs once; the wake digest posts once, at the first tick after the user wakes", async () => {
  const { logs, posts, deps } = sleepDeps();
  let state = { queue: [] };
  const step = async (raw, iso) => { state = (await sleepTick({ state, sleep: sleepState(raw, at(iso)), deps, now: at(iso) })).state; };
  await step(night(), "2026-10-10T03:00:00Z");
  await step(night(), "2026-10-10T03:05:00Z");
  assert.deepEqual(logs.map((l) => [l.event, l.state]), [["sleep", "asleep"]], "logged once while asleep");
  assert.equal(posts.length, 0);
  const woke = night({ wake_at: "2026-10-10T10:40:00Z" });
  await step(woke, "2026-10-10T10:41:00Z");
  assert.deepEqual(posts, ["**Good morning: 2 threads have questions for you**\n- Lead 80\n- Lead 81"]);
  assert.deepEqual(logs.map((l) => l.event), ["sleep", "sleep", "wake-digest"]);
  assert.equal(logs.at(-1).posted, true);
  await step(woke, "2026-10-10T10:46:00Z");
  await step(woke, "2026-10-10T13:01:00Z"); // 09:00: night → awake, no second digest
  assert.equal(posts.length, 1, "once per night");
  assert.equal(state.sleep.digestDay, "2026-10-09");
});

test("sleepTick: nothing waiting → no post, logged; a failed post is logged with the error", async () => {
  const asleep = { queue: [], sleep: { key: "x", label: "asleep" } };
  const woke = sleepState(night({ wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-10T10:41:00Z"));
  const none = sleepDeps([]);
  await sleepTick({ state: asleep, sleep: woke, deps: none.deps, now: at("2026-10-10T10:41:00Z") });
  assert.equal(none.posts.length, 0);
  assert.deepEqual(none.logs.find((l) => l.event === "wake-digest"), { event: "wake-digest", count: 0, posted: false, why: "nothing waiting on the user, no post" });
  const bad = sleepDeps(["Lead 80"], () => { throw new Error("reportCommand failed (1): boom"); });
  const r = await sleepTick({ state: asleep, sleep: woke, deps: bad.deps, now: at("2026-10-10T10:41:00Z") });
  assert.equal(bad.logs.find((l) => l.event === "wake-digest").error, "reportCommand failed (1): boom");
  assert.equal(r.state.sleep.digestDay, "2026-10-09");
  assert.equal(digestText(["A"]), "**Good morning: 1 thread has questions for you**\n- A");
});

test("sleepTick: asleep ending at 12:00 without a wake posts no digest; --dry-run posts and logs nothing", async () => {
  const asleep = { queue: [], sleep: { key: "x", label: "asleep" } };
  const noon = sleepDeps();
  await sleepTick({ state: asleep, sleep: sleepState(night(), at("2026-10-10T16:01:00Z")), deps: noon.deps, now: at("2026-10-10T16:01:00Z") });
  assert.equal(noon.posts.length, 0);
  assert.ok(!noon.logs.some((l) => l.event === "wake-digest"));
  const dry = sleepDeps();
  const r = await sleepTick({ state: asleep, sleep: sleepState(night({ wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-10T10:41:00Z")), deps: dry.deps, dryRun: true, now: at("2026-10-10T10:41:00Z") });
  assert.equal(dry.posts.length + dry.logs.length, 0);
  assert.equal(r.state, asleep);
  assert.ok(r.say.some((x) => /would post the wake digest \(2 waiting/.test(x)));
});

test("sleepTick: bedtime and wake both between two ticks still post the digest; a garbled tick in between doesn't lose it", async () => {
  const woke = night({ wake_at: "2026-10-10T10:40:00Z" });
  // No tick ever saw them asleep: the last tick was before bedtime.
  const a = sleepDeps();
  let state = { queue: [], sleep: { key: "awake||", label: "awake" } };
  state = (await sleepTick({ state, sleep: sleepState(woke, at("2026-10-10T10:41:00Z")), deps: a.deps, now: at("2026-10-10T10:41:00Z") })).state;
  assert.equal(a.posts.length, 1);
  assert.equal(state.sleep.digestDay, "2026-10-09");
  // asleep → garbled read → wake: the wake tick posts.
  const b = sleepDeps();
  let s2 = { queue: [] };
  const step = async (raw, iso) => { s2 = (await sleepTick({ state: s2, sleep: raw ? sleepState(raw, at(iso)) : sleepState(null, at(iso), "garbled /s.json: x"), deps: b.deps, now: at(iso) })).state; };
  await step(night(), "2026-10-10T03:00:00Z");
  await step(null, "2026-10-10T10:36:00Z");
  assert.equal(b.posts.length, 0);
  await step(woke, "2026-10-10T10:41:00Z");
  assert.equal(b.posts.length, 1, "posted after the garbled tick");
  await step(woke, "2026-10-10T10:46:00Z");
  assert.equal(b.posts.length, 1, "still once per night");
});

test("sleepTick: a stale sleep file (an older night's wake) never posts", async () => {
  const woke = night({ wake_at: "2026-10-10T10:40:00Z" });
  const d = sleepDeps();
  // Two days later, the file was never rewritten; the pacer state was reset.
  await sleepTick({ state: { queue: [] }, sleep: sleepState(woke, at("2026-10-12T10:41:00Z")), deps: d.deps, now: at("2026-10-12T10:41:00Z") });
  assert.equal(d.posts.length, 0);
  assert.ok(!d.logs.some((l) => l.event === "wake-digest"));
  // wake_at before bedtime (last night's wake, a new bedtime) is not a wake for this night.
  assert.equal(wokeTonight(sleepState(night({ bedtime_at: "2026-10-11T02:00:00Z", night_until: "2026-10-11T13:00:00Z", wake_at: "2026-10-10T10:40:00Z" }), at("2026-10-11T03:00:00Z")), at("2026-10-11T03:00:00Z")), false);
  assert.equal(wokeTonight(sleepState(woke, at("2026-10-10T10:41:00Z")), at("2026-10-10T10:41:00Z")), true);
});

test("capPace: a second line from the usage at set time to +N at the finish, lower one wins", () => {
  const resetsAt = "2026-10-11T17:30:00.000Z";
  const now = Date.parse("2026-10-11T13:15:00.000Z");
  const p = paceOf({ resetsAt, usedPercent: 31 }, now);
  const budget = { windowId: p.windowId, from: 31, add: 10, setAt: "2026-10-11T13:15:00.000Z" };
  assert.equal(capPace(p, budget, resetsAt, now).pace, Math.min(p.pace, 31));
  const end = Date.parse(resetsAt) - 10 * 60000;
  const mid = capPace(paceOf({ resetsAt, usedPercent: 35 }, (now + end) / 2), budget, resetsAt, (now + end) / 2);
  assert.equal(mid.pace, 36);
  assert.equal(mid.capTo, 41);
  assert.equal(capPace(p, { ...budget, windowId: "other" }, resetsAt, now).pace, p.pace);
});

test("decide with a cap: no free first wake over the line, and a lone ready thread is asked", () => {
  const W = "2026-10-11T17:30:00.000Z";
  const one = [{ threadId: "x", ready: true, pacerWoken: true, wokenAt: "2026-10-11T12:00:00Z" }];
  const q1 = [{ threadId: "a" }];
  assert.equal(decide({ used: 60, pace: 31, windowId: W, active: [], ready: q1, capped: true }).action, "none");
  assert.equal(decide({ used: 30, pace: 31, windowId: W, active: [], ready: q1, capped: true }).action, "wake");
  assert.equal(decide({ used: 96, pace: 41, windowId: W, active: [], ready: q1, capped: true }).action, "none");
  assert.equal(decide({ used: 60, pace: 31, windowId: W, active: one, ready: [], capped: true }).action, "ask-pause");
  assert.equal(decide({ used: 60, pace: 31, windowId: W, active: one, ready: [] }).action, "none");
});

// Emergency dispatch.
const E0 = Date.parse("2026-10-15T08:00:00Z");
const HOUR = 3600000;
const errCause = (count = 217) => ({ key: "errors", count, threshold: 50, window_min: 60, summary: `${count} errors in the last hour, mostly app.sync_worker`,
  top: [{ source: "app.sync_worker", message: "HTTP 429 rate limit", n: 205 }] });
const ECFG = { project: "/work/app", checkCommand: "py check.py", textCommand: "py text.py", postCommand: "py post.py", cooldownHours: 6 };
function emDeps({ failCreate = false, failText = false } = {}) {
  const calls = { order: [], create: [], save: [], text: [], post: [], log: [] };
  const open = new Set();
  const failed = new Map();
  let n = 0;
  const deps = {
    isOpen: (id) => open.has(id),
    failed: (id) => failed.get(id) ?? null,
    newId: () => `00000000-0000-4000-8000-00000000000${++n}`,
    create: async (t) => { calls.order.push("create"); if (failCreate) throw new Error("T3 down"); calls.create.push(t); open.add(t.threadId); },
    save: (s) => { calls.order.push("save"); calls.save.push(structuredClone(s)); },
    text: async (line, key) => { calls.order.push("text"); calls.text.push([line, key]); if (failText) throw new Error("textCommand exited 1: backend down"); },
    post: async (line) => { calls.order.push("post"); calls.post.push(line); },
    log: (event, fields) => calls.log.push([event, fields]),
  };
  return { deps, calls, open, failed };
}
const events = (calls) => calls.log.map(([e]) => e);
const ET1 = "00000000-0000-4000-8000-000000000001";
const EM1 = "00000000-0000-4000-8000-000000000002"; // the first start's message id

test("emergency: an errors cause starts one pinned thread, saves it before the text, texts and posts once", async () => {
  const { deps, calls } = emDeps();
  const r = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps, now: E0 });
  const title = "Emergency: 217 errors in the last hour, mostly app.sync_wor…";
  assert.equal(title.length, 60);
  assert.deepEqual(calls.create.map(({ threadId, messageId, title: t, resume }) => [threadId, messageId, t, resume]), [[ET1, EM1, title, false]]);
  const at = "2026-10-15T08:00:00.000Z";
  const pending = { threadId: ET1, messageId: EM1, title, text: calls.create[0].text, causes: [errCause()], at };
  const started = { pending: null, pendingNotified: false, runId: ET1, threadId: ET1, title, causes: [errCause()], startedAt: at, closedAt: null, notified: false, step: 0, failed: [], last: { errors: { at, count: 217, threadId: ET1 } } };
  assert.deepEqual(r.state, { ...started, notified: true });
  assert.deepEqual(calls.save, [{ pending, pendingNotified: false, notified: false, runId: ET1 }, started, { ...started, notified: true }]);
  assert.deepEqual(calls.order, ["save", "create", "save", "text", "post", "save"], "the pending start is saved before T3 hears of it, the thread before the text");
  const line = `Pacer emergency: 217 errors in the last hour, mostly app.sync_worker. claude-opus-5-5 thread '${title}' is on it.`;
  assert.deepEqual(calls.text, [[line, `emergency-${ET1}`]]);
  assert.deepEqual(calls.post, [line]);
  assert.deepEqual(events(calls), ["emergency-start"]);
  const brief = calls.create[0].text;
  assert.match(brief, /- errors: 217 errors in the last hour, mostly app\.sync_worker \(count 217, threshold 50, last 60 min\)/);
  assert.match(brief, /205× app\.sync_worker: HTTP 429 rate limit/);
  assert.match(brief, /Read the project's agent instructions/);
  assert.match(brief, /Recheck the numbers with `py check\.py`/);
  assert.match(brief, /post a 3–5 line report with `py post\.py` \(markdown on stdin\)/);
  assert.doesNotMatch(brief, /For the pacer/);
});

test("emergency: while its thread is open nothing new starts, counts are only logged", async () => {
  const { deps, calls } = emDeps();
  const first = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps, now: E0 });
  calls.log.length = 0;
  const later = [errCause(900), { key: "model_calls", count: 40, threshold: 20, summary: "40 failed model calls in the last hour" }];
  const r = await emergencyTick({ state: first.state, causes: later, cfg: ECFG, deps, now: E0 + 5 * 60000 });
  assert.equal(r.state, first.state);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.text.length, 1);
  assert.deepEqual(calls.log.map(([e, f]) => [e, f.threadId, f.causes]), [["emergency-held", ET1, [{ key: "errors", count: 900 }, { key: "model_calls", count: 40 }]]]);
  // Nothing tripped and still open: no log at all.
  calls.log.length = 0;
  await emergencyTick({ state: first.state, causes: [], cfg: ECFG, deps, now: E0 + 10 * 60000 });
  assert.deepEqual(calls.log, []);
});

test("emergency: after it settles the same cause waits 6 h unless 2×; another cause starts at once", async () => {
  const setup = async () => {
    const w = emDeps();
    const first = await emergencyTick({ state: {}, causes: [errCause(217)], cfg: ECFG, deps: w.deps, now: E0 });
    w.open.clear(); // settled
    return { ...w, state: first.state };
  };
  // Settled 2 h after the start: recorded, cooldown runs from then.
  let w = await setup();
  const settle = E0 + 2 * HOUR;
  let r = await emergencyTick({ state: w.state, causes: [errCause(300)], cfg: ECFG, deps: w.deps, now: settle });
  assert.equal(w.calls.create.length, 1, "300 < 2 × 217 inside 6 h: held");
  assert.equal(r.state.closedAt, new Date(settle).toISOString());
  assert.deepEqual(r.state.last.errors, { at: "2026-10-15T08:00:00.000Z", count: 217, threadId: ET1, settledAt: new Date(settle).toISOString() });
  assert.deepEqual(events(w.calls), ["emergency-start", "emergency-closed", "emergency-cooldown"]);
  assert.match(w.calls.log.at(-1)[1].why, /errors 300: the last one \(217\) settled 2026-10-15T10:00:00.000Z; starts again at 434 or after 2026-10-15T16:00:00.000Z/);
  // 5 h 59 min after the settle (8 h after the start): still held.
  const held = await emergencyTick({ state: r.state, causes: [errCause(300)], cfg: ECFG, deps: w.deps, now: settle + 6 * HOUR - 60000 });
  assert.equal(w.calls.create.length, 1);
  // At 2×: starts.
  const twice = await emergencyTick({ state: held.state, causes: [errCause(434)], cfg: ECFG, deps: w.deps, now: settle + 60000 });
  assert.equal(w.calls.create.length, 2);
  assert.equal(twice.state.last.errors.count, 434);
  assert.equal(twice.state.threadId, "00000000-0000-4000-8000-000000000003");
  // 6 h after the settle, same count: starts.
  w = await setup();
  r = await emergencyTick({ state: w.state, causes: [], cfg: ECFG, deps: w.deps, now: settle });
  r = await emergencyTick({ state: r.state, causes: [errCause(217)], cfg: ECFG, deps: w.deps, now: settle + 6 * HOUR });
  assert.equal(w.calls.create.length, 2);
  // A different cause right after the settle: starts; the cooled one stays out of it.
  w = await setup();
  r = await emergencyTick({ state: w.state, causes: [errCause(250), { key: "model_calls", count: 28, threshold: 20, summary: "28 failed model calls in the last hour" }], cfg: ECFG, deps: w.deps, now: settle });
  assert.equal(w.calls.create.at(-1).title, "Emergency: 28 failed model calls in the last hour");
  assert.deepEqual(r.state.causes.map((c) => c.key), ["model_calls"]);
  assert.equal(r.state.last.errors.count, 217, "the cooled cause keeps its last start");
});

test("emergency: pacer causes trip at 3 failed ticks and 6 blind ticks; the failing brief keeps the fix steps", async () => {
  assert.deepEqual(pacerCauses({ failing: FAILING_TICKS - 1, blind: BLIND_TICKS - 1, error: "x" }), []);
  assert.deepEqual(pacerCauses({ failing: 3, error: "Unexpected token } in JSON" }),
    [{ key: "pacer-failing", count: 3, threshold: 3, summary: "pacer failed 3 ticks in a row", top: [{ source: "pacer tick", message: "Unexpected token } in JSON", n: 1 }] }]);
  assert.deepEqual(pacerCauses({ blind: 6 }), [{ key: "pacer-blind", count: 6, threshold: 6, summary: "no Claude usage window for 30 min", window_min: 30 }]);
  const { deps, calls } = emDeps();
  const r = await emergencyTick({ state: {}, causes: pacerCauses({ failing: 3, error: "Unexpected token } in JSON" }), cfg: ECFG, deps, now: E0 });
  assert.equal(calls.create[0].title, "Emergency: pacer failed 3 ticks in a row");
  assert.equal(r.state.last["pacer-failing"].count, 3);
  const brief = calls.create[0].text;
  assert.match(brief, /has failed 3 ticks in a row, so nothing is being woken or paused\. Last error: Unexpected token \} in JSON/);
  assert.match(brief, /reproduce with `node ~\/\.agents\/skills\/pacer\/scripts\/pacer\.mjs tick --dry-run`/);
  assert.match(brief, /Fix the cause in the pacer's source repo/);
  assert.match(brief, /Run `node --test` on its scripts\/\*\.test\.mjs/);
  assert.match(brief, /Commit in the repo you fixed \(local only, don't push\)/);
  const blind = emergencyBrief(pacerCauses({ blind: 6 }), ECFG, "t");
  assert.match(blind, /no Claude usage window for 6 ticks, so it paces blind\. Check `node ~\/\.agents\/skills\/pacer\/scripts\/lib\/usage\.mjs --json`/);
});

test("emergency: a failed text still records the thread (one text per thread); a failed create records nothing", async () => {
  const t = emDeps({ failText: true });
  const r = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: t.deps, now: E0 });
  assert.equal(r.state.threadId, ET1);
  assert.equal(t.calls.save[1].threadId, ET1);
  assert.deepEqual(t.calls.post.length, 1, "the post still goes out");
  assert.deepEqual(t.calls.log.map(([e, f]) => [e, f.via ?? null, f.error ?? null]),
    [["emergency-start", null, null], ["emergency-text-failed", "text", "textCommand exited 1: backend down"]]);
  assert.equal(r.state.notified, true, "tried: a later tick doesn't text again");
  const again = await emergencyTick({ state: r.state, causes: [errCause()], cfg: ECFG, deps: t.deps, now: E0 + 5 * 60000 });
  assert.equal(t.calls.create.length, 1);
  assert.equal(t.calls.text.length, 1, "exactly one text attempt");
  assert.deepEqual(events(t.calls).slice(-1), ["emergency-held"]);
  assert.equal(again.state.notified, true);
  const c = emDeps({ failCreate: true });
  const r2 = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 });
  assert.deepEqual(Object.keys(r2.state), ["pending", "pendingNotified", "notified", "runId"], "runId: the first thread's id keys every notice of this run");
  assert.equal(r2.state.pending.threadId, ET1);
  assert.equal(r2.state.threadId, undefined, "no thread recorded");
  assert.deepEqual(events(c.calls), ["emergency-failed"]);
});

test("emergency: create fails → one text and one post per pending start, however many ticks fail", async () => {
  const c = emDeps({ failCreate: true });
  let r = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 });
  const title = r.state.pending.title;
  const line = "Pacer emergency: 217 errors in the last hour, mostly app.sync_worker. Couldn't open the claude-opus-5-5 thread "
    + `'${title}': T3 down. The pacer retries every tick.`;
  assert.equal(emergencyOpenFailedLine(r.state.pending.causes, title, "T3 down"), line);
  assert.deepEqual(c.calls.text, [[line, `emergency-${ET1}`]]);
  assert.deepEqual(c.calls.post, [line]);
  assert.deepEqual(c.calls.order, ["save", "create", "text", "post", "save"], "pending saved before create; flag saved after the sends");
  assert.equal(c.calls.save.at(-1).pendingNotified, true);
  for (let i = 1; i <= 3; i++) r = await emergencyTick({ state: r.state, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 + i * 5 * 60000 });
  assert.equal(c.calls.text.length, 1, "later failing ticks send nothing");
  assert.equal(c.calls.post.length, 1);
  assert.deepEqual(events(c.calls), Array(4).fill("emergency-failed"));
  assert.equal(r.state.pending.threadId, ET1, "still the same pending start");
  // T3 back: same IDs; the one pending-start alarm already told the user.
  const { deps, calls } = emDeps();
  const ok = await emergencyTick({ state: r.state, causes: [], cfg: ECFG, deps, now: E0 + 20 * 60000 });
  assert.deepEqual(calls.create.map(({ threadId, resume }) => [threadId, resume]), [[ET1, true]]);
  assert.deepEqual(calls.text, []);
  assert.equal(calls.post.length, 0);
  assert.equal(ok.state.pendingNotified, false);
  assert.equal(ok.state.notified, true);
});

test("emergency: a failing open-failed text or post is logged, doesn't throw the tick, and isn't retried", async () => {
  const c = emDeps({ failCreate: true, failText: true });
  c.deps.post = async () => { c.calls.post.push("x"); throw new Error("postCommand exited 2"); };
  const r = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 });
  assert.deepEqual(c.calls.log.map(([e, f]) => [e, f.via ?? null, f.error]),
    [["emergency-failed", null, "T3 down"], ["emergency-text-failed", "text", "textCommand exited 1: backend down"], ["emergency-text-failed", "post", "postCommand exited 2"]]);
  assert.equal(r.state.pendingNotified, true);
  await emergencyTick({ state: r.state, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 + 5 * 60000 });
  assert.equal(c.calls.text.length, 1);
  assert.equal(c.calls.post.length, 1);
});

test("emergency: a new emergency after the last one closed texts again if its create fails", async () => {
  const w = emDeps();
  const first = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: w.deps, now: E0 });
  w.open.clear();
  const closed = await emergencyTick({ state: first.state, causes: [], cfg: ECFG, deps: w.deps, now: E0 + HOUR });
  // A stale flag from an earlier failed start must not silence the new one.
  const c = emDeps({ failCreate: true });
  const r = await emergencyTick({ state: { ...closed.state, pendingNotified: true }, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 + 7 * HOUR });
  assert.equal(r.state.pending.threadId, ET1);
  assert.deepEqual(c.calls.text.map(([, key]) => key), [`emergency-${ET1}`]);
  assert.equal(r.state.pendingNotified, true);
});

test("emergency: a pending start (crash or lost ack mid-create) is finished with the same ids, even after the causes clear", async () => {
  const c = emDeps({ failCreate: true });
  const failed = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: c.deps, now: E0 });
  const { deps, calls } = emDeps();
  const dry = await emergencyTick({ state: failed.state, causes: [], cfg: ECFG, deps, dryRun: true, now: E0 + 5 * 60000 });
  assert.deepEqual(dry.say, ["would finish emergency thread \"Emergency: 217 errors in the last hour, mostly app.sync_wor…\" (errors 217)"], "already texted: no would-text line");
  assert.deepEqual(calls.order, []);
  const r = await emergencyTick({ state: failed.state, causes: [], cfg: ECFG, deps, now: E0 + 5 * 60000 });
  assert.deepEqual(calls.create.map(({ threadId, messageId, resume }) => [threadId, messageId, resume]), [[ET1, EM1, true]]);
  assert.equal(calls.create[0].text, failed.state.pending.text, "the saved brief, not a new one");
  assert.equal(r.state.pending, null);
  assert.equal(r.state.threadId, ET1);
  assert.equal(r.state.startedAt, "2026-10-15T08:00:00.000Z");
  assert.deepEqual(calls.text, [], "the pending alarm already went out before restart");
  assert.equal(calls.log[0][1].resumed, true);
  // The next tick only holds.
  await emergencyTick({ state: r.state, causes: [errCause()], cfg: ECFG, deps, now: E0 + 10 * 60000 });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.text.length, 0);
});

test("emergency: a crash between the save and the text sends the start text once on the next tick, same key", async () => {
  const { deps, calls } = emDeps();
  const first = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps, now: E0 });
  const crashed = calls.save[1]; // what emergency.json held before the text
  assert.equal(crashed.notified, false);
  calls.text.length = 0; calls.post.length = 0;
  const r = await emergencyTick({ state: crashed, causes: [], cfg: ECFG, deps, now: E0 + 5 * 60000 });
  assert.deepEqual(calls.text, [[emergencyLine(first.state.causes, first.state.title), `emergency-${ET1}`]]);
  assert.equal(calls.post.length, 1);
  assert.equal(r.state.notified, true);
  assert.equal(calls.create.length, 1);
  await emergencyTick({ state: r.state, causes: [], cfg: ECFG, deps, now: E0 + 10 * 60000 });
  assert.equal(calls.text.length, 1, "once");
});

test("emergency: dry run starts, saves, texts and logs nothing", async () => {
  const { deps, calls } = emDeps();
  const r = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps, dryRun: true, now: E0 });
  assert.deepEqual(r.state, {});
  assert.deepEqual(calls.order, []);
  assert.deepEqual(calls.log, []);
  assert.deepEqual(r.say, ["would start emergency thread \"Emergency: 217 errors in the last hour, mostly app.sync_wor…\" (errors 217)",
    "would notify the user if the thread can't be opened"]);
  // A pending start whose open-failed text hasn't gone out yet: dry run says it would text, sends nothing.
  const pending = { pending: { threadId: ET1, messageId: EM1, title: "Emergency: x", text: "brief", causes: [errCause()], at: "t" }, pendingNotified: false };
  const p = await emergencyTick({ state: pending, causes: [], cfg: ECFG, deps, dryRun: true, now: E0 });
  assert.deepEqual(p.say, ["would finish emergency thread \"Emergency: x\" (errors 217)", "would notify the user if the thread can't be opened"]);
  assert.deepEqual(calls.order, []);
});

test("emergency helpers: blindStreak, parseCauses, title, line and status", () => {
  const t = (blind) => ({ event: "tick", blind }), e = (blind) => ({ event: "error", command: "tick", blind });
  assert.equal(blindStreak([t(false), t(true), e(true), { event: "wake" }, t(true)]), 3);
  assert.equal(blindStreak([t(true), { event: "tick" }, t(true)]), 1, "an old line without blind ends the streak");
  assert.equal(blindStreak([t(true), e(false)]), 0, "a tick error after the window was read isn't blind");
  assert.deepEqual(parseCauses('{"at":"x","causes":[]}'), []);
  assert.deepEqual(parseCauses(JSON.stringify({ causes: [errCause()] })), [errCause()]);
  assert.throws(() => parseCauses("Traceback (most recent call last)"), /checkCommand printed "Traceback \(most recent call last\)", not JSON/);
  assert.throws(() => parseCauses("{}"), /no "causes" list/);
  assert.throws(() => parseCauses('{"causes":[{"key":"errors"}]}'), /lacks key, count or summary/);
  assert.equal(emergencyTitle({ summary: "short" }), "Emergency: short");
  assert.equal(emergencyLine([{ summary: "a" }, { summary: "b" }], "Emergency: a"), "Pacer emergency: a; b. claude-opus-5-5 thread 'Emergency: a' is on it.");
  assert.equal(emergencyStatus({ cfg: null, state: {} }), "Emergency: off (no \"emergency\" in config.json)");
  assert.equal(emergencyStatus({ cfg: ECFG, state: {} }), "Emergency: none started yet");
  const s = { threadId: ET1, title: "Emergency: x", causes: [errCause()], startedAt: "2026-10-15T08:00:00.000Z", closedAt: null };
  assert.equal(emergencyStatus({ cfg: ECFG, state: s, open: true }), "Emergency: thread 00000000 \"Emergency: x\" open since 2026-10-15T08:00:00.000Z (errors 217); nothing new starts until it settles");
  assert.equal(emergencyStatus({ cfg: ECFG, state: { ...s, closedAt: "2026-10-15T09:00:00.000Z" }, open: false }), "Emergency: none open; last 00000000 \"Emergency: x\" started 2026-10-15T08:00:00.000Z, closed 2026-10-15T09:00:00.000Z");
});

// ---- Their time zone ------------------------------------------------------

const PT = "America/Los_Angeles";
const ET = "America/Toronto"; // the system zone in these tests (testdata/test-env.mjs)

test("userZone: config timeZone; unset = system zone; unknown or non-string = system zone + one log line", () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  assert.equal(userZone({ zone: undefined, warn }), SYSTEM_ZONE, "unset");
  assert.equal(userZone({ zone: PT, warn }), PT);
  assert.equal(userZone({ zone: "Mars/Olympus", warn }), SYSTEM_ZONE, "unknown zone");
  assert.equal(userZone({ zone: 42, warn }), SYSTEM_ZONE, "not a string");
  assert.equal(warned.length, 1, "one log line per process");
  assert.match(warned[0], /^bad timeZone "Mars\/Olympus" in config\.json: .*; using /);
});

test("wallClock / zonedTime: wall time in a zone, across DST", () => {
  assert.deepEqual(wallClock(Date.parse("2026-10-17T19:00:00Z"), PT), { day: "2026-10-17", h: 12, m: 0 });
  assert.deepEqual(wallClock(Date.parse("2026-10-18T03:30:00Z"), ET), { day: "2026-10-17", h: 23, m: 30 });
  assert.equal(new Date(zonedTime("2026-10-17", 12, 0, PT)).toISOString(), "2026-10-17T19:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-12-01", 12, 0, PT)).toISOString(), "2026-12-01T20:00:00.000Z", "PST");
  assert.equal(new Date(zonedTime("2026-11-01", 12, 0, ET)).toISOString(), "2026-11-01T17:00:00.000Z", "fall-back day");
});

test("nightWindow follows their zone: a 12:30 ET reset is 09:30 PT (night), 07:00 ET is 04:00 PT", () => {
  const r = "2026-10-17T16:30:00Z"; // 12:30 EDT, 09:30 PDT
  assert.equal(nightWindow(r, settings()), false);
  assert.equal(nightWindow(r, settings(), PT), true);
  assert.equal(nightWindow("2026-10-18T03:30:00Z", settings(), ET), false, "23:30 ET: day");
  assert.equal(nightWindow("2026-10-18T03:30:00Z", settings(), PT), false, "20:30 PT: day");
  assert.equal(nightWindow("2026-10-18T07:30:00Z", settings(), PT), true, "00:30 PT: night");
});

test("sleepState: in Pacific the asleep cap is 12:00 PT on the morning night_until falls on", () => {
  // bedtime 22:00 PT Fri; night until 09:00 PT Sat (16:00Z); no wake.
  const raw = { day: "2026-10-16", bedtime_at: "2026-10-17T05:00:00Z", night_until: "2026-10-17T16:00:00Z", wake_at: null, updated_at: "2026-10-17T05:00:00Z" };
  const s = sleepState(raw, Date.parse("2026-10-17T17:00:00Z"), null, PT); // 10:00 PT (13:00 ET)
  assert.equal(s.noon, "2026-10-17T19:00:00.000Z");
  assert.equal(s.asleep, true, "10:00 PT: asleep");
  assert.equal(sleepState(raw, Date.parse("2026-10-17T18:30:00Z"), null, PT).asleep, true, "11:30 PT = 14:30 ET: asleep in PT");
  assert.equal(sleepState(raw, Date.parse("2026-10-17T19:00:00Z"), null, PT).asleep, false, "12:00 PT: awake");
  assert.equal(sleepState(raw, Date.parse("2026-10-17T16:30:00Z"), null, ET).asleep, false, "ET cap would end at 12:00 ET = 16:00Z");
});

test("labels follow their zone", () => {
  const raw = { day: "2026-10-16", bedtime_at: "2026-10-17T05:00:00Z", night_until: "2026-10-17T16:00:00Z", wake_at: null, updated_at: "2026-10-17T05:00:00Z" };
  const s = sleepState(raw, Date.parse("2026-10-17T06:00:00Z"), null, PT);
  assert.equal(sleepLine(s, PT), "asleep (bedtime Fri 22:00, coding night until Sat 09:00; asleep until the sleep file records a wake, at the latest Sat 12:00)");
  assert.match(sleepLine(s, ET), /bedtime Sat 01:00, coding night until Sat 12:00/);
  assert.equal(zoneLabel("2026-10-17T14:00:00Z", { hour: "numeric", minute: "2-digit" }, PT), "7:00 AM");
});

test("reportDue: once per their day at/after 07:00 their time, across an Eastern→Pacific flip", () => {
  const t = (iso) => Date.parse(iso);
  assert.equal(reportDue({ now: t("2026-10-17T10:45:00Z"), zone: ET }).due, false, "06:45 ET");
  const first = reportDue({ now: t("2026-10-17T11:00:00Z"), zone: ET });
  assert.deepEqual([first.due, first.day], [true, "2026-10-17"], "07:00 ET");
  assert.equal(reportDue({ now: t("2026-10-17T11:15:00Z"), zone: ET, last: first.day }).due, false, "07:15 ET: sent");
  // The user flies west the same day: 07:00 PT is still their 2026-10-17, already sent.
  assert.equal(reportDue({ now: t("2026-10-17T14:00:00Z"), zone: PT, last: first.day }).due, false, "07:00 PT same day");
  // Next day in Pacific: not at 07:00 ET (04:00 PT), but at 07:00 PT.
  assert.equal(reportDue({ now: t("2026-10-18T11:00:00Z"), zone: PT, last: first.day }).due, false, "04:00 PT");
  const pt = reportDue({ now: t("2026-10-18T14:00:00Z"), zone: PT, last: first.day });
  assert.deepEqual([pt.due, pt.day], [true, "2026-10-18"], "07:00 PT next day");
  // A late run (machine was off) still sends once.
  assert.equal(reportDue({ now: t("2026-10-19T20:00:00Z"), zone: PT, last: "2026-10-18" }).due, true, "13:00 PT, missed morning");
});

import { missedResumes } from "./pacer.mjs";
test("missedResumes: a limited thread T3 didn't resume 10 min past the reset, once per reset", () => {
  const now = Date.parse("2026-10-17T06:30:00Z");
  const claude = JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  const t = (id, more = {}) => ({ thread_id: id, title: id, model_selection_json: claude, last_error_class: "usage_limit", turn_state: "failed", usage_limit_reset_at: "2026-10-17T06:10:00.000Z", ...more });
  const threads = [t("stuck"), t("early", { usage_limit_reset_at: "2026-10-17T06:25:00.000Z" }), t("running", { turn_state: "running", last_error_class: null }),
    t("snoozed", { snoozed_until: "2026-10-18T00:00:00Z" }), t("thread:delegated-task:job"), t("ok", { last_error_class: null, turn_state: "completed" }),
    t("codex", { model_selection_json: JSON.stringify({ instanceId: "codex", model: "other-model" }) })];
  assert.deepEqual(missedResumes(threads, {}, now).map((x) => x.thread_id), ["stuck"]);
  assert.deepEqual(missedResumes(threads, { stuck: "2026-10-17T06:10:00.000Z" }, now), []);
  assert.deepEqual(missedResumes(threads, { stuck: "2026-10-16T21:10:00.000Z" }, now).map((x) => x.thread_id), ["stuck"]);
});

import { untilTime, waitingUntil } from "./pacer.mjs";
test("pause --until: ISO, +Nm/+Nh, HH:MM the user's time (next one); waitingUntil skips it until then", () => {
  const now = Date.parse("2026-10-17T20:20:00Z"); // 16:20 Eastern
  assert.equal(untilTime("+90m", now, ET), "2026-10-17T21:50:00.000Z");
  assert.equal(untilTime("+2h", now, ET), "2026-10-17T22:20:00.000Z");
  assert.equal(untilTime("16:34", now, ET), "2026-10-17T20:34:00.000Z");
  assert.equal(untilTime("09:00", now, ET), "2026-10-18T13:00:00.000Z", "already past today: tomorrow");
  assert.equal(untilTime("2026-10-17T21:00:00Z", now, ET), "2026-10-17T21:00:00.000Z");
  assert.throws(() => untilTime("soon", now, ET), /--until/);
  assert.equal(waitingUntil({ notBefore: "2026-10-17T20:34:00Z" }, now), true);
  assert.equal(waitingUntil({ notBefore: "2026-10-17T20:34:00Z" }, Date.parse("2026-10-17T20:35:00Z")), false);
  assert.equal(waitingUntil({}, now), false);
});

test("decide: only a thread paused until a set time queued → nothing woken, says why", () => {
  const d = decide({ used: 53, pace: 88, windowId: "w", active: [], ready: [], waiting: 1, later: 1 });
  assert.equal(d.action, "none");
  assert.match(d.reason, /1 paused until a set time/);
  assert.doesNotMatch(d.reason, /turn running/);
});

test("wakeText tells a woken thread about pause --until", () => {
  assert.match(wakeText(50, 60, "/p/plan.md"), /pause --plan <plan path> --until/);
});

// `list --json` helpers.
import { burnRate, planStep, roughStarts } from "./pacer.mjs";

test("roughStarts: replays the wake rule; first wake now, the next after a settle, stuck rows never", () => {
  const window = { label: "Session (5h)", usedPercent: 10, resetsAt: new Date(NOW + 240 * 60000).toISOString() };
  const rows = [{ threadId: "a", priority: "high" }, { threadId: "b", priority: "med" }, { threadId: "c", priority: "med", stuck: true }];
  const at = roughStarts({ rows, window, now: NOW, burn: 0.05 });
  assert.equal(at.get("a"), NOW, "room now: the top row starts at once");
  assert.ok(at.get("b") > NOW, "the second waits for at least one more tick");
  assert.equal(at.has("c"), false, "a stuck row gets no time");
  assert.equal(roughStarts({ rows, window, now: NOW, burn: null }).size, 0, "no burn rate: no estimate");
  assert.deepEqual([...roughStarts({ rows, window: { ...window, usedPercent: 99 }, now: NOW, burn: 1 }).keys()], ["a"], "the window runs out before the second starts");
  const later = roughStarts({ rows: [{ threadId: "a", notBefore: new Date(NOW + 60 * 60000).toISOString() }], window, now: NOW, burn: 0.05 });
  assert.ok(later.get("a") >= NOW + 60 * 60000, "not before its notBefore");
});

test("burnRate: from a 10-30 min old tick of the same window, else the window average, else null", () => {
  const resetsAt = new Date(NOW + 180 * 60000).toISOString(); // 120 min into the window
  const windowId = resetsAt;
  const tick = (min, used, window = windowId) => ({ event: "tick", at: new Date(NOW - min * 60000).toISOString(), used, window });
  assert.equal(burnRate({ used: 40, windowId, resetsAt, now: NOW, ticks: [tick(20, 30)] }), 0.5);
  assert.equal(burnRate({ used: 40, windowId, resetsAt, now: NOW, ticks: [tick(5, 39), tick(45, 10)] }), 40 / 120, "no tick in range: the window average");
  assert.equal(burnRate({ used: 40, windowId, resetsAt, now: NOW, ticks: [tick(20, 30, "2026-10-08T12:00:00Z")] }), 40 / 120, "another window's tick doesn't count");
  assert.equal(burnRate({ used: 2, windowId, resetsAt: new Date(NOW + 295 * 60000).toISOString(), now: NOW }), null, "5 min old window: unknown");
  assert.equal(burnRate({ used: null, windowId, resetsAt, now: NOW }), null);
});

test("planStep: the Stages line of the Resume section only", () => {
  assert.equal(planStep("# Plan\nStages: not this\n## Resume\n- **Stages:** S1 done, S2 building\n## Next\nStages: no"), "S1 done, S2 building");
  assert.equal(planStep("## Resume\nNext: x\n## Other\nStages: outside"), null);
  assert.equal(planStep("no resume here"), null);
  assert.equal(planStep(null), null);
});

// A chain of four model selections; the default chain is the main instance's Opus alone.
const CHAIN_CFG = { ...ECFG, chain: ["model-a", "model-b", "model-c", "model-d"].map((model) => ({ instance: "inst", model })) };

test("emergency: a failed thread hands the brief down the configured chain, then stops", async () => {
  const { deps, calls, open, failed } = emDeps();
  let r = await emergencyTick({ state: {}, causes: [errCause()], cfg: CHAIN_CFG, deps, now: E0 });
  assert.equal(calls.create[0].step, 0);
  const auth = "Claude could not authenticate. For subscription login, run `claude auth login`";
  failed.set(ET1, auth); open.delete(ET1);
  const dry = await emergencyTick({ state: r.state, causes: [], cfg: CHAIN_CFG, deps, dryRun: true, now: E0 + 5 * 60000 });
  assert.match(dry.say.join("\n"), /would start emergency thread "Emergency \(model-b\): 217 errors/);
  assert.equal(calls.create.length, 1, "a dry run makes nothing");
  calls.text.length = 0; calls.log.length = 0;
  r = await emergencyTick({ state: r.state, causes: [], cfg: CHAIN_CFG, deps, now: E0 + 5 * 60000 });
  const b = calls.create[1];
  assert.deepEqual([b.step, b.settle], [1, ET1]);
  assert.match(b.title, /^Emergency \(model-b\): 217 errors/);
  assert.match(b.text, /You are a fallback \(model-b\)[^]*- model-a thread 00000000-0000-4000-8000-000000000001: Claude could not authenticate/);
  assert.equal(r.state.threadId, b.threadId);
  assert.equal(r.state.step, 1);
  assert.equal(r.state.last.errors.threadId, b.threadId);
  assert.deepEqual(calls.text, [], "a fallback sends no second text");
  assert.deepEqual(events(calls), ["emergency-start"]);
  for (const [model, next] of [["model-b", "model-c"], ["model-c", "model-d"]]) {
    failed.set(r.state.threadId, `${model} boom`); open.delete(r.state.threadId);
    r = await emergencyTick({ state: r.state, causes: [], cfg: CHAIN_CFG, deps, now: E0 + 10 * 60000 });
    assert.ok(calls.create.at(-1).title.startsWith(`Emergency (${next})`));
  }
  assert.deepEqual(calls.create.map((c) => c.step), [0, 1, 2, 3]);
  assert.deepEqual(r.state.failed.map((f) => f.model), ["model-a", "model-b", "model-c"]);
  assert.match(calls.create[3].text, /- model-c thread .*: model-c boom/);
  // The last step failing too starts nothing more: it closes like any settled thread.
  failed.set(r.state.threadId, "boom"); open.delete(r.state.threadId);
  const after = await emergencyTick({ state: r.state, causes: [], cfg: CHAIN_CFG, deps, now: E0 + 20 * 60000 });
  assert.equal(calls.create.length, 4);
  assert.ok(after.state.closedAt);
  // The default chain has one step: its failure closes the run.
  const one = emDeps();
  const r1 = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps: one.deps, now: E0 });
  one.failed.set(ET1, auth); one.open.delete(ET1);
  const c1 = await emergencyTick({ state: r1.state, causes: [], cfg: ECFG, deps: one.deps, now: E0 + 5 * 60000 });
  assert.equal(one.calls.create.length, 1);
  assert.ok(c1.state.closedAt);
});

test("emergency: a fresh start clears the last chain", async () => {
  const ECFG = CHAIN_CFG;
  const { deps, calls, failed, open } = emDeps();
  const first = await emergencyTick({ state: {}, causes: [errCause()], cfg: ECFG, deps, now: E0 });
  failed.set(ET1, "auth"); open.delete(ET1);
  const r = await emergencyTick({ state: first.state, causes: [], cfg: ECFG, deps, now: E0 + 60000 });
  open.delete(r.state.threadId);
  const closed = await emergencyTick({ state: r.state, causes: [], cfg: ECFG, deps, now: E0 + 120000 });
  const again = await emergencyTick({ state: closed.state, causes: [errCause(900)], cfg: ECFG, deps, now: E0 + 180000 });
  assert.equal(calls.create.length, 3);
  assert.equal(again.state.step, 0);
  assert.deepEqual(again.state.failed, []);
  assert.equal(calls.create[2].settle, null);
});

test("claude login: one text per broken login, a new login re-arms it, and one warning 48 h before the refresh token runs out", async () => {
  const sent = [], logs = [];
  const deps = { text: async (line, key) => sent.push([line, key]), log: (e, f) => logs.push(e) };
  const base = { configDir: "/cfg/claude", deps };
  const failure = { at: "2026-10-22T19:12:00.582Z", error: "Claude could not authenticate." };
  const creds = { mtimeMs: 111, refreshTokenExpiresAt: E0 + 30 * 24 * HOUR };
  let r = await claudeLoginTick({ ...base, state: {}, failure, creds, now: E0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /^Claude's login expired \(.*\): every Claude thread has stopped\. Log in again: CLAUDE_CONFIG_DIR=\/cfg\/claude claude auth login$/);
  assert.equal(sent[0][1], "claude-login-111");
  r = await claudeLoginTick({ ...base, state: r.state, failure: { ...failure, at: "2026-10-22T19:20:00Z" }, creds, now: E0 + 5 * 60000 });
  assert.equal(sent.length, 1, "more failed threads on the same login send nothing");
  r = await claudeLoginTick({ ...base, state: r.state, failure, creds: { ...creds, mtimeMs: 222 }, now: E0 + 10 * 60000 });
  assert.equal(sent.length, 2, "after a new login a new failure texts again");
  const exp = { mtimeMs: 222, refreshTokenExpiresAt: E0 + 47 * HOUR };
  r = await claudeLoginTick({ ...base, state: r.state, failure: null, creds: exp, now: E0 });
  assert.match(sent[2][0], /^Claude's login runs out .*\. Log in again before then so no thread stops: CLAUDE_CONFIG_DIR=\/cfg\/claude claude auth login$/);
  r = await claudeLoginTick({ ...base, state: r.state, failure: null, creds: exp, now: E0 + HOUR });
  assert.equal(sent.length, 3, "the expiry warning goes out once");
  const quiet = await claudeLoginTick({ ...base, state: {}, failure: null, creds: { mtimeMs: 1, refreshTokenExpiresAt: E0 + 72 * HOUR }, now: E0 });
  assert.deepEqual(quiet.say, []);
  const dry = await claudeLoginTick({ ...base, state: {}, failure, creds, dryRun: true, now: E0 });
  assert.equal(sent.length, 3);
  assert.match(dry.say[0], /^would text: Claude's login expired/);
});

// --- Lead hand-off
import { handOffLead, handoffAsk, handoffNowText, handoffText, leadPlan, handedOffFrom, moveLead, runningChildren } from "./pacer.mjs";

test("handoffAsk: below 3 nothing; then once per compaction level, after hold, children, a running turn, a fresh wake and the user's recent message", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(handoffAsk({ compactions: 2, now }), null);
  assert.deepEqual(handoffAsk({ compactions: 3, now }), { due: true });
  assert.match(handoffAsk({ compactions: 3, asked: 3, now }).wait, /told to hand off at 3 compactions; told again at 4/);
  assert.deepEqual(handoffAsk({ compactions: 4, asked: 3, now }), { due: true });
  assert.match(handoffAsk({ compactions: 3, held: { since: "x" }, now }).wait, /on hold/);
  assert.match(handoffAsk({ compactions: 3, children: ["a", "b"], now }).wait, /waits for 2 running delegate_task children/);
  assert.match(handoffAsk({ compactions: 3, running: true, now }).wait, /once its turn ends/);
  assert.match(handoffAsk({ compactions: 3, recentTurn: false, now }).wait, /just woken/);
  assert.match(handoffAsk({ compactions: 3, userAt: new Date(now - 4 * 60_000).toISOString(), now }).wait, /the user wrote 4 min ago/);
  assert.deepEqual(handoffAsk({ compactions: 3, userAt: new Date(now - 30 * 60_000).toISOString(), now }), { due: true });
  assert.equal(handoffAsk({ compactions: 5, threshold: 6, now }), null, "threshold is configurable");
  // open questions for the user hold the hand-off, so their answers reach the thread that asked.
  assert.match(handoffAsk({ compactions: 3, asks: 2, now }).wait, /waits for the user's answer to 2 open questions/);
});

test("runningChildren: only running threads whose lineage parent is the lead", () => {
  const threads = [{ thread_id: "c1", busy: true, lineage: { parentThreadId: "L" } }, { thread_id: "c2", busy: false, lineage: { parentThreadId: "L" } },
    { thread_id: "c3", busy: true, lineage: { parentThreadId: "other" } }, { thread_id: "L", busy: true }];
  assert.deepEqual(runningChildren(threads, "L"), ["c1"]);
});

test("moveLead: queued → woken on the new id, woken stays woken, ready-only stays ready-only; asks follow; old keys are gone", () => {
  const at = "2026-10-22T12:00:00Z";
  const base = { queue: [{ threadId: "q", plan: "/p/q.md", priority: "high", firstQueuedAt: "t0", pauses: 2 }, { threadId: "z", plan: "/p/z.md" }],
    woken: { w: { plan: "/p/w.md", priority: "medium", wokenAt: "t1", pauses: 1, firstQueuedAt: "t0" } }, ready: { q: { plan: "/p/q.md", readyAt: "r0" }, r: { plan: "/p/r.md", readyAt: "r1" } },
    asked: { q: "W1" }, handoffAsked: { q: 3 } };
  const a = moveLead(base, "q", "Q", { title: "T", at });
  assert.deepEqual(a.queue.map((e) => e.threadId), ["z"]);
  assert.deepEqual([a.woken.Q.plan, a.woken.Q.priority, a.woken.Q.pauses, a.woken.Q.wokenAt, a.woken.Q.title], ["/p/q.md", "high", 2, at, "T"]);
  assert.deepEqual([a.ready.Q, a.ready.q], [{ plan: "/p/q.md", title: "T", readyAt: "r0" }, undefined]);
  assert.deepEqual([a.asked, a.handoffAsked], [{ Q: "W1" }, {}]);
  const b = moveLead(base, "w", "W", { title: "T", at });
  assert.deepEqual([b.woken.w, b.woken.W.plan, b.ready.W.plan], [undefined, "/p/w.md", "/p/w.md"]);
  const c = moveLead(base, "r", "R", { title: "T", at });
  assert.deepEqual([c.woken.R, c.ready.R.plan, c.ready.R.readyAt, c.ready.r], [undefined, "/p/r.md", "r1", undefined]);
  assert.equal(leadPlan(base, "q"), "/p/q.md");
  assert.equal(leadPlan(base, "nobody"), null, "no plan entry: not a lead");
});

test("handOffLead: saves the record before creating, creates once, a second call does nothing; a half-done record reuses its ids; a refused settle stays pending", async () => {
  const calls = [];
  const deps = { create: async (a) => calls.push(["create", a]), unpin: async (id) => calls.push(["unpin", id]), settle: async (id) => calls.push(["settle", id]),
    save: (s) => calls.push(["save", s.handoffs]), log: (e, f) => calls.push(["log", e, f]) };
  const info = { thread_id: "L", title: "Lead 1", project_id: "P", model_selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } };
  const state = { queue: [], woken: { L: { plan: "/p/1.md", wokenAt: "t" } }, ready: {}, asked: {}, handoffs: {} };
  const r = await handOffLead({ state, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "command", deps });
  assert.equal(calls[0][0], "save", "record saved before the thread is created");
  assert.equal(calls[0][1].L.done, false);
  const create = calls.find((c) => c[0] === "create")[1];
  assert.deepEqual([create.threadId, create.title, create.projectId, create.modelSelection, create.resume], [r.to, "Lead 1", "P", info.model_selection, true]);
  assert.deepEqual([create.branch, create.worktreePath], [null, null], "no worktree: main checkout");
  assert.deepEqual([r.state.handoffs.L.projectId, r.state.handoffs.L.modelSelection], ["P", info.model_selection], "the record keeps project and model for a recovery");
  assert.match(create.text, /^Pacer: you take over from thread L, which reached 3 compactions\. Read \/p\/1\.md § Resume/);
  assert.deepEqual(calls.filter((c) => c[0] === "unpin" || c[0] === "settle").map((c) => c.join(":")), ["unpin:L", "settle:L"]);
  assert.equal(calls.find((c) => c[0] === "log")[1], "lead-handoff");
  assert.deepEqual([r.state.woken[r.to].plan, r.state.woken.L, r.state.handoffs.L.settled, handedOffFrom(r.state, r.to)], ["/p/1.md", undefined, true, "L"]);
  calls.length = 0;
  const again = await handOffLead({ state: r.state, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "command", deps });
  assert.deepEqual([again.already, again.to, calls.length], [true, r.to, 0]);
  // Half done: the record exists, the thread may not. The same ids go to create (it is idempotent).
  const half = { ...state, handoffs: { L: { to: "T2", messageId: "M2", plan: "/p/1.md", title: "Lead 1", text: "x", compactions: 3, cause: "wake", done: false, settled: false } } };
  const refuse = { ...deps, settle: async () => { throw new Error("thread L is still running"); } };
  const h = await handOffLead({ state: half, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "wake", deps: refuse });
  const c2 = calls.find((c) => c[0] === "create")[1];
  assert.deepEqual([c2.threadId, c2.messageId, h.to], ["T2", "M2", "T2"]);
  assert.deepEqual([h.settled, h.state.handoffs.L.done, h.state.handoffs.L.settled, h.state.handoffs.L.unpinned], [false, true, false, true]);
  assert.match(h.say, /settles once its turn ends \(thread L is still running\)/);
});

test("handOffLead carries the lead's pin: unpinned stays unpinned, pinned stays pinned", async () => {
  const run = async (info, queued = null) => {
    const calls = [];
    const deps = { create: async (a) => calls.push(["create", a]), createQueued: async (a) => calls.push(["createQueued", a]), park: async () => "snoozed",
      unpin: async (id) => calls.push(["unpin", id]), settle: async () => {}, save: () => {}, log: () => {} };
    const state = { queue: [], woken: { L: { plan: "/p/1.md", wokenAt: "t" } }, ready: {}, asked: {}, handoffs: {} };
    const r = await handOffLead({ state, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "command", deps, ...(queued ? { queued } : {}) });
    return { made: calls.find((c) => c[0] === "create" || c[0] === "createQueued")[1], rec: r.state.handoffs.L };
  };
  const base = { thread_id: "L", title: "Lead 1", project_id: "P" };
  assert.deepEqual([(await run(base)).made.pin, (await run(base)).rec.pin], [false, false], "an unpinned lead's new thread isn't pinned");
  const mine = await run({ ...base, pinned_at: "2026-10-29T10:00:00.000Z" });
  assert.deepEqual([mine.made.pin, mine.rec.pin], [true, true], "the user's pin moves to the new thread");
  const queued = await run({ ...base, pinned_at: "2026-10-29T10:00:00.000Z" }, { threadId: "L", plan: "/p/1.md", enqueuedAt: "e", firstQueuedAt: "f" });
  assert.equal(queued.made.pin, true, "pause path: createQueued gets the carried pin");
});

test("hand-off texts: the brief names the old id and the plan's Resume; the ask names the command and the plan", () => {
  assert.match(handoffText({ from: "abc", compactions: 3, plan: "/p/1.md", wake: { used: 40, pace: 50 } }), /take over from thread abc, which reached 3 compactions \(your turn: usage 40% vs pace 50%\)\. Read \/p\/1\.md § Resume/);
  assert.equal(handoffNowText(3, "/p/it's plan.md").match(/--plan (.*?)`/)[1], `'/p/it'\\''s plan.md'`, "quoted for the shell");
  assert.match(handoffNowText(4, "/p/1.md"), /^Pacer: hand off now \(4 compactions\) — make Resume current, then run `node ~\/\.agents\/skills\/pacer\/scripts\/pacer\.mjs handoff --plan '\/p\/1\.md'`/);
});

test("decide: a lead due a hand-off but waiting for a child is not woken, and the reason says so", () => {
  const d = decide({ used: 10, pace: 50, windowId: W, active: [], ready: [], waiting: 1, handoffWait: 1, now: NOW });
  assert.equal(d.action, "none");
  assert.match(d.reason, /1 due a hand-off, waiting for a delegate_task child/);
});

import { handoffTarget } from "./pacer.mjs";
test("handoffTarget: follows the hand-off chain (pending records too), stops on a loop, leaves other ids alone", () => {
  const state = { handoffs: { A: { to: "B", done: true }, B: { to: "C", done: false } } };
  assert.equal(handoffTarget(state, "A"), "C");
  assert.equal(handoffTarget(state, "B"), "C");
  assert.equal(handoffTarget(state, "Z"), "Z");
  assert.equal(handoffTarget({ handoffs: { A: { to: "B" }, B: { to: "A" } } }, "A"), "B");
  assert.equal(handoffTarget({}, "A"), "A");
});

// Working Opus count, reset takes and resumes.
import { dueResumes, limitResumeDrop, limitTakes, logId, workingThreads, LIMIT_SNOOZE_MS, wakeRule } from "./pacer.mjs";

test("logId: a uuid's first 8, a delegate_task child's job name", () => {
  assert.equal(logId("5dda80b9-670b-4246-bddc-423592a56304"), "5dda80b9");
  assert.equal(logId("thread:delegated-task:command%3Amcp%3Abe04e3e0-d5b4%3Adelegate-task%3Afix-login-r1"), "fix-login-r1");
});

const OPUS = JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
const HAIKU = JSON.stringify({ instanceId: "claudeAgent", model: "claude-haiku-5-5" });
const CODEX = JSON.stringify({ instanceId: "codex", model: "other-model" });
const th = (id, more = {}) => ({ thread_id: id, title: `T ${id}`, model_selection_json: OPUS, busy: true, pending_user_input_count: 0, pending_approval_count: 0, ...more });

test("workingThreads: running Opus threads, workers included; an Opus child takes its parent out, a Haiku child doesn't", () => {
  const ids = (ts) => workingThreads(ts).map((w) => w.threadId).sort();
  assert.deepEqual(ids([th("lead"), th("kid", { model_selection_json: HAIKU, lineage: { parentThreadId: "lead" } })]), ["lead"], "Haiku child: the parent still works");
  assert.deepEqual(ids([th("lead"), th("kid", { lineage: { parentThreadId: "lead", relationshipToParent: "subagent" } })]), ["kid"], "Opus child: the child works, not the parent");
  assert.deepEqual(ids([th("lead"), th("kid", { busy: false, lineage: { parentThreadId: "lead" } })]), ["lead"], "an idle child doesn't take the parent out");
  assert.deepEqual(ids([th("a", { pending_user_input_count: 1 }), th("b", { pending_approval_count: 1 }), th("c", { busy: false })]), [], "waiting on the user or idle: not working");
  assert.deepEqual(ids([th("h", { model_selection_json: HAIKU }), th("x", { model_selection_json: CODEX })]), [], "Haiku and Codex never count");
  assert.deepEqual(ids([th("x", { model_selection_json: CODEX }), th("lead"), th("cx", { model_selection_json: CODEX, lineage: { parentThreadId: "lead" } })]), ["lead"], "a Codex child doesn't take the parent out");
  assert.deepEqual(workingThreads([th("w", { lineage: { relationshipToParent: "subagent" } }), th("m")]).map((w) => w.why), ["worker turn running", "turn running"]);
  assert.deepEqual(ids([th("lead", { busy: undefined, turn_state: "running" })]), ["lead"], "no busy flag: the turn state");
});

test("limitTakes: main Claude threads stopped by the limit before their reset, once, not workers, queued or longer-snoozed threads", () => {
  const reset = new Date(NOW + 60 * 60000).toISOString();
  const lim = (id, more = {}) => th(id, { busy: false, last_error_class: "usage_limit", usage_limit_reset_at: reset, snoozed_until: reset, ...more });
  const ids = (ts, o = {}) => limitTakes(ts, { now: NOW, ...o }).map((t) => t.thread_id);
  assert.deepEqual(ids([lim("a")]), ["a"]);
  assert.deepEqual(ids([lim("thread:delegated-task:w"), lim("s", { lineage: { relationshipToParent: "subagent" } })]), [], "workers stay T3's");
  assert.deepEqual(ids([lim("a")], { queued: new Set(["a"]) }), [], "queued threads stay with the queue");
  assert.deepEqual(ids([lim("a")], { pending: { a: {} } }), [], "taken already");
  assert.deepEqual(ids([lim("a")], { resumed: { a: reset } }), [], "resumed for this reset already");
  assert.deepEqual(ids([lim("a")], { now: Date.parse(reset) + 1 }), [], "past the reset: T3's, missedResumes covers a miss");
  assert.deepEqual(ids([lim("a", { snoozed_until: new Date(Date.parse(reset) + 2 * 3600000).toISOString() })]), [], "the user's longer snooze stands");
  assert.deepEqual(ids([lim("a", { snoozed_until: new Date(Date.parse(reset) + LIMIT_SNOOZE_MS).toISOString() })]), [], "already snoozed past the reset (a take whose state was lost): T3 resumes it then");
  assert.deepEqual(ids([lim("a", { busy: true }), lim("h", { model_selection_json: CODEX }), th("ok", { busy: false })]), [], "running, not Claude, or not limited");
});

test("dueResumes: past their reset, oldest reset first; limitResumeDrop: gone, running again, limit cleared", () => {
  const at = (min) => new Date(NOW + min * 60000).toISOString();
  const pending = { a: { title: "A", resetAt: at(-5) }, b: { title: "B", resetAt: at(-20) }, c: { title: "C", resetAt: at(10) } };
  assert.deepEqual(dueResumes(pending, NOW), [{ threadId: "b", title: "B", resetAt: at(-20), resume: true }, { threadId: "a", title: "A", resetAt: at(-5), resume: true }]);
  assert.deepEqual(dueResumes(undefined, NOW), []);
  assert.equal(limitResumeDrop(undefined), "deleted");
  assert.equal(limitResumeDrop(th("a", { archived_at: at(-1) })), "archived");
  assert.equal(limitResumeDrop(th("a", { last_error_class: "usage_limit" })), "running again");
  assert.equal(limitResumeDrop(th("a", { busy: false, last_error_class: null })), "no longer stopped by the limit");
  assert.equal(limitResumeDrop(th("a", { busy: false, last_error_class: "usage_limit" })), null);
  const r1 = at(-60), r2 = at(60);
  assert.match(limitResumeDrop(th("a", { busy: false, last_error_class: "usage_limit", usage_limit_reset_at: r2 }), { resetAt: r1 }), /a newer limit replaced it/);
  assert.equal(limitResumeDrop(th("a", { busy: false, last_error_class: "usage_limit", usage_limit_reset_at: r1 }), { resetAt: r1 }), null, "same reset: kept");
});

test("missedResumes: a thread the pacer took for its own resume is left to the wake rule", () => {
  const reset = new Date(NOW - 30 * 60000).toISOString();
  const t = th("a", { busy: false, last_error_class: "usage_limit", usage_limit_reset_at: reset });
  assert.deepEqual(missedResumes([t], {}, NOW).map((x) => x.thread_id), ["a"]);
  assert.deepEqual(missedResumes([t], {}, NOW, { a: { resetAt: reset } }), []);
});

test("decide: limit resumes rank first, bypass the hold, keep the settle, and wait a tick for a triage start", () => {
  const resume = { threadId: "r", title: "Lead 312", resetAt: "2026-10-08T21:50:00Z", resume: true };
  const base = { used: 10, pace: 20, windowId: W, active: [act("x")], working: 1, ready: [resume, ...q("n")], now: NOW };
  const d = decide(base);
  assert.equal(d.action, "wake"); assert.equal(d.threadId, "r"); assert.equal(d.resume, true); assert.equal(d.source, "queue");
  assert.match(d.reason, /resumes Lead 312, stopped by the usage limit/);
  const held = decide({ ...base, held: { since: "2026-10-08T20:00:00Z" } });
  assert.equal(held.threadId, "r", "hold stops queued work, not a limit resume");
  assert.equal(decide({ ...base, held: { since: "x" }, ready: q("n") }).action, "none", "hold: queued work waits");
  assert.match(decide({ ...base, lastWakeAt: new Date(NOW - 3 * 60000).toISOString() }).reason, /last wake was 3 min ago/, "resumes keep the 10-min settle");
  const tri = decide({ ...base, triageStarted: true });
  assert.equal(tri.action, "none"); assert.match(tri.reason, /triage thread started this tick; the limit resume waits a tick/);
  assert.equal(decide({ ...base, triageStarted: true, ready: q("n") }).threadId, "n", "a triage start holds back resumes only");
  assert.equal(decide({ ...base, working: 0, active: [] }).source, "bootstrap", "nothing working: the resume bootstraps");
  assert.match(decide({ ...base, ready: q("n") }).reason, /^used 10% vs pace 20% .*1\/6 working/);
});

test("decide bootstrap: nothing working wakes one even above pace, with no window; hold, the night limit block and a cap still stop it", () => {
  const base = { used: 60, pace: 20, windowId: W, active: [], working: 0, ready: q("a"), now: NOW };
  assert.equal(decide(base).source, "bootstrap");
  assert.equal(decide({ ...base, used: 0, pace: 0, windowId: null }).source, "bootstrap", "no window at all");
  assert.equal(decide({ ...base, lastWakeAt: new Date(NOW - 60000).toISOString() }).action, "wake", "no settle for a bootstrap");
  assert.match(decide({ ...base, held: { since: "s" } }).reason, /on hold/);
  assert.match(decide({ ...base, night: true, limited: ["abc Lead 1"] }).reason, /hit the usage limit; nothing new until the reset/);
  assert.equal(decide({ ...base, capped: true }).action, "none", "over the cap line");
  assert.equal(decide({ ...base, capped: true, used: 15 }).source, "bootstrap");
});

test("decide ask-pause with a cap: one ready thread is enough to ask", () => {
  const over = { used: 40, pace: 20, windowId: W, working: 2, ready: [], waiting: 0, now: NOW };
  const lone = [act("lead"), act("t", null, undefined, { ready: false })];
  assert.equal(decide({ ...over, active: lone }).action, "none");
  const capped = decide({ ...over, active: lone, capped: true });
  assert.equal(capped.action, "ask-pause"); assert.equal(capped.threadId, "lead");
});

test("wakeRule: the three bars", () => {
  assert.equal(wakeRule(6), "0 working: wake; < 6 working: ≤ pace; 6+ working: ≤ pace−6");
  assert.equal(wakeRule(5.6, 3), "0 working: wake; < 3 working: ≤ pace; 3+ working: ≤ pace−5.6");
});

test("roughStarts: the working count fills the cap; past it a start needs pace − tol", () => {
  // 60 min into the window: pace ≈ 20.7, tol ≈ 9.4, so used 15 is under pace but over pace − tol.
  const window = { label: "Session (5h)", usedPercent: 15, resetsAt: new Date(NOW + 240 * 60000).toISOString() };
  const rows = [{ threadId: "a" }];
  assert.equal(roughStarts({ rows, window, now: NOW, burn: 0.05, active: 1, working: 1 }).get("a"), NOW, "under the cap, under pace: now");
  const full = roughStarts({ rows, window, now: NOW, burn: 0.05, active: 1, working: 6 });
  assert.ok(!full.has("a") || full.get("a") > NOW, "at the cap: not now");
});

// `triage --now`: one pass at once.
function nowWorld(opts) {
  const w = world(opts);
  w.projects = [];
  const check = w.deps.check;
  w.deps.check = (project) => { w.projects.push(project); return check(); };
  w.deps.create = (pass, { resume }) => createMainThread({ threadId: pass.threadId, messageId: pass.messageId, projectId: "p", title: triageTitle(pass.count, pass.kind, pass.project),
    text: triageText(pass.count, pass.kind, pass.since, pass.project), modelSelection: {}, resume }, { send: w.send, query: w.query });
  return w;
}

test("triage now: starts one pass at once, ignoring the window and the 24 h / 5-item rule; the window's own check is untouched", async () => {
  const w = world({ out: "2" });
  // A pass ran an hour ago this window and settled: the tick's rule would skip 2 items.
  const ranAt = new Date(W1_START + 60000).toISOString();
  const last = { window: W1, outcome: "started", count: 4, kind: "full", threadId: "11111111-0000-4000-8000-000000000000", startedAt: ranAt, pending: null };
  const r = await triageNow({ state: { queue: [], triage: last }, deps: w.deps, now: W1_START + 2 * 3600000 });
  assert.equal(r.result.outcome, "started");
  assert.deepEqual(w.created(), [T1]);
  assert.deepEqual(w.sent.map((c) => c.type), ["thread.create", "message.dispatch"]);
  assert.equal(r.result.thread_id, T1);
  assert.equal(r.result.title, "Triage: 2 new items");
  assert.equal(r.state.triage.threadId, T1);
  assert.equal(r.state.triage.pending, null);
  assert.equal(r.state.triage.window, W1, "the window's check record stays");
  assert.equal(r.state.triage.manual, true);
  assert.equal(w.saved.triage.pending, null, "saved after the start");
  assert.equal(w.logs.at(-1).event, "triage-start");
  assert.equal(w.logs.at(-1).manual, true);
  assert.match(triageStatus({ triage: {}, last: r.state.triage, windowId: W1 }), /started 00000000 "Triage: 2 new items" \(Triage now\)/);
  // The tick that follows sees it open and waits: no second thread.
  const t = await triageTick({ state: r.state, windowId: W2, windowStart: W2_START, deps: w.deps, now: W2_START + 60000 });
  assert.equal(w.created().length, 1);
  assert.equal(w.logs.at(-1).event, "triage-wait");
  assert.equal(t.state.triage.manual, true);
});

test("triage now: a triage thread already open is answered, no second thread, no check", async () => {
  const w = world({ out: "9" });
  const mine = { threadId: "7660ab03-0000-4000-8000-000000000000", title: "Triage the list", createdAt: new Date(W1_START).toISOString(), open: true };
  w.deps.runs = () => [mine];
  let r = await triageNow({ state: { queue: [] }, deps: w.deps, now: W1_START + 60000 });
  assert.equal(r.result.outcome, "open");
  assert.equal(r.result.thread_id, mine.threadId);
  assert.match(r.result.message, /already running: 7660ab03 "Triage the list"/);
  assert.equal(w.checks, 0);
  assert.equal(w.created().length, 0);
  assert.equal(w.saved, null, "nothing saved");
  // The pacer's last pass, still open (not in runs): same answer.
  w.deps.runs = () => [];
  w.threads.set(T1, { title: "Triage: 3 new items", pinned_at: null });
  r = await triageNow({ state: { triage: { threadId: T1, count: 3, kind: "full", startedAt: new Date(W1_START).toISOString() } }, deps: w.deps, now: W1_START + 60000 });
  assert.deepEqual([r.result.outcome, r.result.thread_id, r.result.title], ["open", T1, "Triage: 3 new items"]);
  assert.equal(w.created().length, 1, "only the fixture thread");
});

test("triage now: a pass still being started counts as open", async () => {
  const w = world({ out: "3" });
  const pending = { window: W1, threadId: T1, messageId: "m", count: 3, kind: "full", createdAt: new Date(W1_START).toISOString() };
  const r = await triageNow({ state: { triage: { pending } }, deps: w.deps, now: W1_START + 60000 });
  assert.equal(r.result.outcome, "open");
  assert.equal(r.result.thread_id, T1);
  assert.match(r.result.message, /next tick finishes it/);
  assert.equal(w.checks, 0);
  assert.equal(w.sent.length, 0);
});

test("triage now: no open items starts nothing and says so; a failing check throws", async () => {
  const w = world({ out: "0" });
  const r = await triageNow({ state: {}, deps: w.deps, now: W1_START });
  assert.equal(r.result.outcome, "none");
  assert.equal(r.result.message, "No open items to triage.");
  assert.equal(w.created().length, 0);
  assert.equal(w.saved, null);
  const bad = world({ fail: "checkCommand exited 2" });
  await assert.rejects(triageNow({ state: {}, deps: bad.deps, now: W1_START }), /checkCommand exited 2/);
});

test("triage now: a step T3 refuses leaves the pass pending; the next tick finishes the same thread", async () => {
  const w = nowWorld({ out: "3", refuse: "message.dispatch" });
  const r = await triageNow({ state: { triage: { window: W1, outcome: "none" } }, deps: w.deps, now: W1_START });
  assert.equal(r.result.outcome, "error");
  assert.match(r.result.message, /next tick finishes it/);
  assert.equal(w.saved.triage.pending.threadId, T1);
  const t = await triageTick({ state: w.saved, windowId: W1, windowStart: W1_START, deps: w.deps, now: W1_START + 6 * 60000 });
  assert.deepEqual(w.created(), [T1]);
  assert.equal(w.count("message.dispatch"), 1);
  assert.deepEqual([t.state.triage.outcome, t.state.triage.manual], ["started", true]);
  assert.equal(w.logs.at(-1).title, "Triage: 3 new items");
});

// --- A lead at 3 compactions that pauses is handed off there, not compacted again.
import { compactSkip, pauseHandoff, queueLead, reportRan, leadEntry } from "./pacer.mjs";

test("pauseHandoff: under 3 nothing (children not read); no running child hands off; a running child marks it due", () => {
  let read = 0;
  const kids = (ids) => () => { read++; return ids; };
  assert.deepEqual(pauseHandoff({ compactions: 2, threshold: 3, children: kids(["c"]) }), { compactions: 2 });
  assert.equal(read, 0);
  assert.deepEqual(pauseHandoff({ compactions: 3, threshold: 3, children: kids([]) }), { handoff: true, compactions: 3 });
  assert.deepEqual(pauseHandoff({ compactions: 4, threshold: 3, children: kids(["c1"]) }), { due: true, compactions: 4, children: ["c1"] });
});

test("queueLead: the new thread takes the queue entry (priority, pause-until, age) with a takeover mark; the old id's entries go", () => {
  const e = { threadId: "L", title: "Old", plan: "/p/1.md", priority: "high", size: "m", firstQueuedAt: "a", enqueuedAt: "b", pauses: 3, notBefore: "2026-10-26T12:00:00.000Z", handoffDue: { at: "b", compactions: 3 } };
  const state = { queue: [e, { threadId: "X", plan: "/p/x.md" }], woken: { L: { plan: "/p/1.md" } }, ready: { L: { plan: "/p/1.md", title: "Old", readyAt: "r" } }, asked: { L: "w1" }, handoffAsked: { L: 3 } };
  const s = queueLead(state, "L", "N", e, { title: "Old", compactions: 3 });
  const moved = s.queue.find((q) => q.threadId === "N");
  assert.deepEqual([moved.priority, moved.notBefore, moved.firstQueuedAt, moved.enqueuedAt, moved.pauses, moved.plan], ["high", e.notBefore, "a", "b", 3, "/p/1.md"]);
  assert.deepEqual(moved.takeover, { from: "L", compactions: 3 });
  assert.equal("handoffDue" in moved, false, "the fresh thread isn't due a hand-off");
  assert.deepEqual(s.queue.map((q) => q.threadId).sort(), ["N", "X"]);
  assert.deepEqual([s.woken.L, s.ready.L, s.ready.N.readyAt, s.asked.N, s.asked.L, s.handoffAsked.L], [undefined, undefined, "r", "w1", undefined, undefined]);
});

test("compactSkip: only an entry due a hand-off skips the /compact", () => {
  assert.equal(compactSkip({ threadId: "L" }), null);
  assert.equal(compactSkip(undefined), null);
  assert.match(compactSkip({ handoffDue: { compactions: 4 } }), /due a hand-off \(4 compactions\).*no \/compact/);
});

test("handOffLead queued (pause path): makes the thread without a message, queues it in the lead's place, snoozes it; logs cause pause", async () => {
  const calls = [];
  const deps = { create: async (a) => calls.push(["create", a]), createQueued: async (a) => calls.push(["createQueued", a]), park: async (id) => { calls.push(["park", id]); return "snoozed"; },
    unpin: async (id) => calls.push(["unpin", id]), settle: async () => { throw new Error("thread L is still running"); }, save: () => {}, log: (e, f) => calls.push(["log", e, f]) };
  const info = { thread_id: "L", title: "Lead 1", project_id: "P", model_selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, branch: "b", worktree_path: "/w" };
  const entry = { threadId: "L", title: "Lead 1", plan: "/p/1.md", priority: "high", notBefore: "2026-10-26T12:00:00.000Z", enqueuedAt: "e", firstQueuedAt: "f", pauses: 4 };
  const state = { queue: [], woken: { L: { plan: "/p/1.md", wokenAt: "t" } }, ready: { L: { plan: "/p/1.md", readyAt: "r" } }, asked: {}, handoffs: {} };
  const r = await handOffLead({ state, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "pause", queued: entry, deps });
  assert.equal(calls.some((c) => c[0] === "create"), false, "no first message: the new thread doesn't run now");
  const made = calls.find((c) => c[0] === "createQueued")[1];
  assert.deepEqual([made.threadId, made.title, made.projectId, made.branch, made.worktreePath], [r.to, "Lead 1", "P", "b", "/w"]);
  assert.deepEqual(calls.find((c) => c[0] === "park")[1], r.to);
  assert.deepEqual(r.state.queue.map((q) => [q.threadId, q.priority, q.notBefore, q.pauses, q.takeover.from]), [[r.to, "high", entry.notBefore, 4, "L"]]);
  assert.deepEqual([r.state.woken[r.to], r.state.woken.L, r.state.ready.L, r.state.ready[r.to].plan], [undefined, undefined, undefined, "/p/1.md"]);
  assert.deepEqual([r.queued, r.settled, r.state.handoffs.L.done, r.state.handoffs.L.cause], [true, false, true, "pause"]);
  const log = calls.find((c) => c[0] === "log" && c[1] === "lead-handoff")[2];
  assert.deepEqual([log.cause, log.queued, log.compactions], ["pause", true, 3]);
  assert.match(log.why, /handed off when it paused; the new thread waits in its place in the queue; old thread settles once its turn ends/);
  // Crash recovery after the record: the stored entry is used, still no message.
  calls.length = 0;
  const half = { ...state, handoffs: { L: { ...r.state.handoffs.L, done: false } } };
  const h = await handOffLead({ state: half, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "pause", deps });
  assert.deepEqual([h.to, calls.some((c) => c[0] === "create"), h.state.queue[0].notBefore], [r.to, false, entry.notBefore]);
});

// --- Hand-off on pause: edge cases

test("leadEntry: the marker decides; an unmarked entry needs evidence of a plan entry before its enqueue", () => {
  const at = "2026-10-26T12:00:00.000Z", earlier = "2026-10-26T10:00:00.000Z";
  const first = { threadId: "t", firstQueuedAt: at, enqueuedAt: at };
  const ready = (readyAt) => ({ ready: { t: { readyAt } } });
  assert.equal(leadEntry(ready(at), first), false, "old enqueue's first entry (their own thread): not a lead");
  assert.equal(leadEntry({}, { threadId: "t", enqueuedAt: at }), false, "no dates: not a lead");
  assert.equal(leadEntry(ready(at), { ...first, takeover: { from: "o", compactions: 3 } }), true, "hand-off successor");
  assert.equal(leadEntry(ready(at), { ...first, firstQueuedAt: earlier }), true, "queued or woken before");
  assert.equal(leadEntry(ready(earlier), first), true, "ready before");
  assert.equal(leadEntry(ready(earlier), { ...first, lead: false }), false, "marker wins");
  assert.equal(leadEntry(ready(at), { ...first, lead: true }), true);
});

test("reportRan: a due lead whose newest turn started after the pause and ended", () => {
  const due = { threadId: "L", handoffDue: { at: "2026-10-26T12:00:00.000Z", compactions: 3 } };
  const t = (requested, more = {}) => ({ turn_state: "completed", busy: false, latest_run_requested_at: requested, turn_completed_at: "2026-10-26T12:06:00.000Z", ...more });
  assert.equal(reportRan(due, t("2026-10-26T12:05:00.000Z")), true);
  assert.equal(reportRan(due, t("2026-10-26T11:55:00.000Z")), false, "the pausing turn itself");
  assert.equal(reportRan(due, t("2026-10-26T12:05:00.000Z", { turn_state: "running", busy: true, turn_completed_at: null })), false, "still running");
  assert.equal(reportRan({ threadId: "L" }, t("2026-10-26T12:05:00.000Z")), false, "not due");
  assert.equal(reportRan(undefined, t("2026-10-26T12:05:00.000Z")), false);
});

test("decide at night: a pause counts for the 10-min ask cooldown, like an ask", () => {
  const active = ["a", "b"].map((threadId) => ({ threadId, ready: true, running: true }));
  const opts = { used: 90, pace: 40, windowId: "w", night: true, active, working: 2, ready: [] };
  assert.equal(decide({ ...opts, lastPauseAt: null }).action, "ask-pause");
  const d = decide({ ...opts, lastPauseAt: new Date(Date.now() - 2 * 60000).toISOString() });
  assert.equal(d.action, "none");
  assert.match(d.reason, /last ask or pause 2 min ago/);
});

test("decide at night with a thread at the limit: a due limit resume still goes; queued work waits", () => {
  const opts = { used: 10, pace: 40, windowId: "w", night: true, active: [], working: 0, limited: ["aaaa1111 Lead 80 limited"] };
  const resume = { threadId: "R", resume: true, title: "Lead 80 limited", resetAt: "2026-10-26T05:00:00.000Z" };
  const d = decide({ ...opts, ready: [resume] });
  assert.deepEqual([d.action, d.threadId, d.resume], ["wake", "R", true]);
  assert.equal(decide({ ...opts, ready: [{ threadId: "Q", rank: { score: 4 } }] }).action, "none");
  assert.equal(decide({ ...opts, limited: [], ready: [{ threadId: "Q", rank: { score: 4 } }] }).action, "wake", "no limit hit: queued work goes");
});

import { handoffRelays, relayText } from "./pacer.mjs";
test("handoffRelays: a child report that reached only a settled, handed-off lead goes to the end of its chain, once", () => {
  const NOW = Date.parse("2026-10-28T12:00:00Z");
  const rec = (to) => ({ to, done: true, settled: true, at: "2026-10-28T09:30:00Z", settledAt: "2026-10-28T09:30:05Z" });
  const state = { handoffs: { A: rec("B"), B: rec("C"), R: rec("S") }, relayed: { old: { runId: "run2", at: "2026-10-28T10:00:00Z" } } };
  const lead = (id, edits = {}) => ({ id, settled: true, latestRunCompletedAt: "2026-10-28T09:29:00Z", ...edits });
  const kid = (id, parent, edits = {}) => ({ id, title: id, status: "completed", lineage: { parentThreadId: parent }, activeRunId: null, latestRunId: "run2", latestRunCompletedAt: "2026-10-28T09:47:00Z", ...edits });
  const threads = [lead("A"), lead("B"), lead("R", { settled: false }), lead("C", { settled: false }),
    kid("late", "A"), kid("before", "A", { latestRunCompletedAt: "2026-10-28T09:20:00Z" }), kid("running", "A", { activeRunId: "r" }),
    kid("old", "A"), kid("late2", "A", { latestRunCompletedAt: "2026-10-28T09:31:00Z" }), kid("back", "R"), kid("plain", "C")];
  const out = handoffRelays(state, threads, NOW + 0);
  assert.deepEqual(out.map((r) => [r.child.id, r.to]), [["late", "C"], ["late2", "C"]]);
  // Over 6 h after they ended, the same reports are too old to pass on.
  assert.deepEqual(handoffRelays(state, threads, NOW + 4 * 3600000).map((r) => r.child.id), []);
  assert.match(relayText(threads[4], "A", "done"), /^Delegated task late \(late\) \[completed\], relayed by the pacer.*from A.*\n\ndone$/s);
});

import { resumeHolds, HOLD_AHEAD_MS } from "./pacer.mjs";
test("decide: by day at 100% nothing wakes (a woken thread only hits the limit)", () => {
  const d = decide({ used: 100, pace: 93.2, windowId: "2026-10-08T23:50:00.000Z", active: [], ready: q("a") });
  assert.equal(d.action, "none");
  assert.match(d.reason, /window at 100%/);
  assert.equal(decide({ used: 99, pace: 93.2, windowId: "2026-10-08T23:50:00.000Z", active: [], ready: q("a") }).action, "wake", "the one ≥ 95% wake still goes below 100");
});

test("resumeHolds: a pending resume whose snooze runs out soon is held again; a far snooze or a far reset is left", () => {
  const at = (min) => new Date(NOW + min * 60000).toISOString();
  const pending = { a: { resetAt: at(-15) }, b: { resetAt: at(-15) }, c: { resetAt: at(60) }, d: { resetAt: at(5) } };
  const snoozes = { a: at(5), b: at(40), c: at(30), d: at(35) };
  const holds = resumeHolds(pending, (id) => snoozes[id], NOW);
  assert.deepEqual(holds.map((h) => h.threadId), ["a"]);
  assert.equal(holds[0].until, new Date(NOW + LIMIT_SNOOZE_MS).toISOString());
  assert.deepEqual(resumeHolds({ e: { resetAt: at(-1) } }, () => null, NOW).map((h) => h.threadId), ["e"], "no snooze left: held");
  assert.ok(HOLD_AHEAD_MS < LIMIT_SNOOZE_MS);
});

import { STUCK_TICKS, stuckWake } from "./pacer.mjs";
test("stuckWake + pacer-stuck: 3 wakes in a row that left the same thread queued trip; a wake that worked, another wake or an old one don't", () => {
  const now = Date.parse("2026-10-30T17:00:00Z");
  // Runtime order: the wake's own lines, then the tick line (wakeStuck when the thread stayed queued).
  const tk = (min, action, threadId, wakeStuck = false) => ({ at: new Date(now - min * 60_000).toISOString(), event: "tick", action, ...(threadId ? { threadId } : {}), ...(wakeStuck ? { wakeStuck } : {}) });
  const stuck = [{ event: "wake", threadId: "A2" }, tk(20, "wake", "A", true), { event: "wake", threadId: "A2" }, tk(15, "wake", "A", true), tk(10, "none"), { event: "wake", threadId: "A2" }, tk(5, "wake", "A", true)];
  assert.deepEqual(stuckWake(stuck, now), { count: 3, threadId: "A" });
  assert.equal(pacerCauses({ stuck: stuckWake(stuck, now) })[0].key, "pacer-stuck");
  const cycles = [{ event: "wake", threadId: "A" }, tk(50, "wake", "A"), { event: "pause", threadId: "A" }, { event: "wake", threadId: "A" }, tk(30, "wake", "A"), { event: "pause", threadId: "A" }, { event: "wake", threadId: "A" }, tk(10, "wake", "A")];
  assert.equal(stuckWake(cycles, now).count, 0, "wake → pause → re-queue cycles that worked never count");
  assert.equal(stuckWake([tk(20, "wake", "A", true), tk(15, "wake", "A", true), tk(5, "wake", "A")], now).count, 0, "the newest wake worked: no streak");
  assert.equal(stuckWake([tk(15, "wake", "A", true), tk(10, "wake", "B", true), tk(5, "wake", "A", true)], now).count, 1, "another thread's wake ends the streak");
  assert.equal(stuckWake([tk(90, "wake", "A", true), tk(70, "wake", "A", true), tk(5, "wake", "A", true)], now).count, 1, "wakes over an hour old don't count");
  assert.deepEqual(pacerCauses({ stuck: { count: STUCK_TICKS - 1, threadId: "A" } }), []);
});

test("handOffLead: a done record whose old thread is back in the queue hands off anew", async () => {
  const made = [];
  const deps = { create: async (w) => made.push(w), createQueued: async () => {}, park: async () => "parked", unpin: async () => {}, settle: async () => {}, save: () => {}, log: () => {} };
  const info = { thread_id: "L", title: "Lead", project_id: "p", model_selection: { instanceId: "i", model: "m" } };
  const old = { to: "N1", done: true, settled: true, plan: "/p/1.md", title: "Lead", compactions: 3, cause: "wake", at: "t" };
  const base = { queue: [], woken: {}, ready: {}, asked: {}, handoffAsked: {}, handoffs: { L: old } };
  const left = await handOffLead({ state: base, from: "L", info, plan: "/p/1.md", compactions: 3, cause: "wake", deps });
  assert.equal(left.already, true, "not re-queued: the done record still answers");
  assert.equal(made.length, 0);
  const requeued = { ...base, queue: [{ threadId: "L", plan: "/p/1.md", priority: "highest", enqueuedAt: "t2" }] };
  const r = await handOffLead({ state: requeued, from: "L", info, plan: "/p/1.md", compactions: 4, cause: "wake", deps });
  assert.notEqual(r.to, "N1");
  assert.equal(made.length, 1);
  assert.equal(r.state.queue.some((e) => e.threadId === "L"), false);
  assert.equal(r.state.handoffs.L.to, r.to);
});

test("pickNext: first queue entry of ready, limit resumes skipped, --among narrows", () => {
  const idle = { turn_state: "idle" };
  const a = { threadId: "a", info: idle }, b = { threadId: "b", info: idle };
  const pic = { queue: [a, b], ready: [{ threadId: "r", resume: true, info: idle }, a, b] };
  assert.equal(pickNext(pic).entry.threadId, "a");
  assert.equal(pickNext(pic, new Set(["b"])).entry.threadId, "b");
  const ho = { threadId: "h", info: idle, handoff: { compactions: 3, children: [] } };
  assert.equal(pickNext({ queue: [ho], ready: [ho] }).entry.threadId, "h");
});

test("pickNext: refuses with the reasons when nothing can start", () => {
  const now = Date.parse("2026-10-31T20:00:00Z");
  const idle = { turn_state: "idle" };
  const queue = [
    { threadId: "q1", info: idle, onUser: true },
    { threadId: "q2", info: idle, onUser: true },
    { threadId: "q3", info: idle, blockedBy: [{ plan: 512 }] },
    { threadId: "q4", info: { turn_state: "running" } },
    { threadId: "q5", info: { last_error_class: "usage_limit" } },
    { threadId: "q6", info: idle, notBefore: "2026-10-31T21:00:00Z" },
    { threadId: "q7", info: idle },
  ];
  // As picture() gives it: the hand-off metadata is on handoffWaits' copies, not on queue rows.
  const handoffWaits = [{ threadId: "q7", handoff: { compactions: 3, children: ["c"] } }];
  assert.equal(pickNext({ queue, ready: [{ threadId: "r", resume: true }], handoffWaits }, null, now).refuse,
    "nothing can start: 7 queued, 2 waiting on you, 1 waiting for plan 512, 1 running, 1 paused by the usage limit, 1 not before 2026-10-31T21:00:00Z, 1 waiting for its worker's report");
  assert.equal(pickNext({ queue: [], ready: [] }).refuse, "nothing can start: the queue is empty");
  assert.equal(pickNext({ queue, ready: [] }, new Set(["zz"])).refuse, "nothing can start: none of these threads is queued");
  assert.equal(pickNext({ queue, ready: [] }, new Set(["q3"])).refuse, "nothing can start: 1 queued, 1 waiting for plan 512");
});

// a lead idle on a Codex review stays in Working; `built` releases dependents.
import { builtLines, builtPlans, markBuilt } from "./pacer.mjs";

test("built: the plan leaves woken and ready, and a plan waiting on it unblocks in dependencies()", () => {
  const p569 = "/r/planning/569-live/plan.md", p576 = "/r/planning/576-next/plan.md";
  const state = { queue: [{ threadId: "q576", plan: p576, priority: "med" }], woken: { L: { plan: p569, title: "569 lead", wokenAt: "2026-11-04T01:00:00Z" } },
    ready: { L: { plan: p569 }, other: { plan: "/r/planning/1-x/plan.md" } }, built: {} };
  const read = (p) => (planNumber(p) === 576 ? "Wait for: plan 569" : "");
  assert.deepEqual(dependencies(state.queue, state.woken, read).blockedBy.get("q576"), [{ plan: 569, threadId: "L", state: "woken" }]);
  const r = markBuilt(state, p569, "L", "569 lead", "2026-11-04T09:00:00Z");
  assert.deepEqual(r.from, ["L"]);
  assert.deepEqual(r.state.woken, {});
  assert.deepEqual(Object.keys(r.state.ready), ["other"]);
  assert.deepEqual(r.state.built[p569], { plan: p569, at: "2026-11-04T09:00:00Z", threadId: "L", title: "569 lead" });
  assert.equal(dependencies(r.state.queue, r.state.woken, read, { L: p569 }, new Set([569])).blockedBy.has("q576"), false, "unblocked, even if still building");
  // The lead then queues for its live check (`pause --until`): still no block.
  const queued = [...r.state.queue, { threadId: "L", plan: p569, priority: "med" }];
  assert.equal(dependencies(queued, {}, read, {}, new Set([569])).blockedBy.has("q576"), false, "a queued built plan blocks nothing");
  assert.equal(dependencies(queued, {}, read).blockedBy.get("q576")[0].state, "queued", "without built it would block");
  assert.deepEqual(builtLines(r.state.built), ["\nBuilt, live check left (1):", `  plan 569 ${p569} (L 569 lead): built 2026-11-04T09:00:00Z`]);
  assert.deepEqual(builtLines({}), []);
});

// Only the exact held path is released, and only by its holder.
test("built: refuses a wrong path, a plan nobody holds and another thread's plan; changes nothing", () => {
  const p569 = "/r/planning/569-live/plan.md";
  const state = { queue: [{ threadId: "Q", plan: "/r/planning/570-q/plan.md" }], woken: { L: { plan: p569 } }, ready: { L: { plan: p569 } }, built: {} };
  const typo = markBuilt(state, "/r/planning/569-typo/plan.md", null);
  assert.match(typo.refuse, /no thread holds \/r\/planning\/569-typo\/plan\.md/);
  assert.equal(typo.state, undefined);
  assert.deepEqual(state.woken, { L: { plan: p569 } }, "the real plan stays held");
  assert.match(markBuilt(state, "/r/planning/1-nobody/plan.md").refuse, /no thread holds/);
  assert.match(markBuilt(state, p569, "OTHER").refuse, /held by L, not OTHER/);
  assert.equal(markBuilt(state, p569, "L").state.built[p569].threadId, "L");
  const q = markBuilt(state, "/r/planning/570-q/plan.md");
  assert.equal(q.state.built["/r/planning/570-q/plan.md"].threadId, "Q", "a queued plan's holder may mark it built");
  assert.deepEqual(q.from, []);
});

// one open thread per plan (11-04: 554's old lead bc63f800 and its hand-off
// 616d5c7c each removed the other's queue entry, and the plan's age reset to 0 h).
import { afterRemove, backfillPlanAges, enqueueBase, heldLine, planAgeOf, planHolders, planKey, readyTakeOver, takeOver, tidyPlanAges, withPlanAge } from "./pacer.mjs";

const P554 = "/repo/planning/554-smooth-animations/plan.md";
test("planKey: a plan dir matches across checkouts; a flat path is its own key", () => {
  assert.equal(planKey(P554), "554-smooth-animations");
  assert.equal(planKey("/tmp/wt/planning/554-smooth-animations/plan.md"), planKey(P554));
  assert.notEqual(planKey("/p/1.md"), planKey("/p/2.md"));
});

test("planHolders: another open thread that queued, was woken with or readied the plan holds it; a settled one doesn't", () => {
  const state = { queue: [{ threadId: "new", plan: P554, title: "554" }], woken: {}, ready: { new: { plan: P554 } } };
  const open = () => true;
  assert.deepEqual(planHolders(state, "old", P554, open).map((h) => [h.threadId, h.as]), [["new", "queued"]]);
  assert.deepEqual(planHolders(state, "new", P554, open), [], "its own entry isn't a holder");
  assert.deepEqual(planHolders(state, "old", P554, () => false), [], "a settled holder doesn't count");
  assert.deepEqual(planHolders({ queue: [], woken: { w: { plan: P554 } }, ready: {} }, "old", P554, open).map((h) => h.as), ["woken"]);
  assert.deepEqual(planHolders({ queue: [], woken: {}, ready: { b: { plan: P554 } } }, "old", P554, open).map((h) => h.as), ["building"]);
  assert.deepEqual(planHolders(state, "old", "/repo/planning/555-other/plan.md", open), [], "another plan");
  assert.match(heldLine(P554, planHolders(state, "old", P554, open), "pause"), /^plan 554 is held by new 554 \(queued\); that thread owns it\. .*`pacer\.mjs pause --take-over`/);
});

test("takeOver: the other thread's entries for the plan go, its age and pause count carry; other plans stay", () => {
  const theirs = { threadId: "new", plan: P554, title: "554", priority: "high", firstQueuedAt: "2026-11-02T16:16:44.021Z", enqueuedAt: "2026-11-04T11:08:00Z", pauses: 3 };
  const state = { queue: [theirs, { threadId: "new", plan: "/p/9.md" }, { threadId: "x", plan: "/p/2.md" }], woken: {}, ready: { new: { plan: P554 }, x: { plan: "/p/2.md" } } };
  const r = takeOver(state, P554, planHolders(state, "old", P554, () => true));
  assert.deepEqual(r.state.queue.map((e) => e.plan), ["/p/9.md", "/p/2.md"]);
  assert.deepEqual(Object.keys(r.state.ready), ["x"]);
  const e = queueEntryFrom({ id: "old", title: "554", old: enqueueBase(r.state, "old", P554, r.carried), pause: true, now: "2026-11-04T12:00:00Z" });
  assert.equal(e.firstQueuedAt, "2026-11-02T16:16:44.021Z", "age kept");
  assert.equal(e.pauses, 4, "pause count kept (+1 for this pause)");
  assert.equal(e.priority, "high");
});

test("re-queue of the same plan keeps its first-queued age and priority raise, even after its entry was removed", () => {
  const first = queueEntryFrom({ id: "new", title: "554", old: null, now: "2026-11-02T16:16:44.021Z", given: { plan: P554 } });
  let state = withPlanAge({ queue: [first], woken: {}, ready: {}, planAges: {} }, { ...first, priority: "high" });
  state = { ...state, queue: [] }; // removed (`remove`, a hand-back, a settle)
  const { at, ...age } = planAgeOf(state, P554);
  assert.deepEqual(age, { firstQueuedAt: "2026-11-02T16:16:44.021Z", priority: "high", pauses: 0 });
  assert.ok(at, "stamped, for the 14-day expiry");
  const again = queueEntryFrom({ id: "old", title: "554", old: enqueueBase(state, "old", P554), now: "2026-11-04T11:48:01Z", given: { plan: P554 } });
  assert.equal(again.firstQueuedAt, "2026-11-02T16:16:44.021Z");
  assert.equal(again.priority, "high");
  const own = { threadId: "old", plan: P554, firstQueuedAt: "2026-11-03T00:00:00Z", priority: "low" };
  assert.equal(enqueueBase({ ...state, queue: [own] }, "old", P554), own, "the thread's own entry still wins");
  assert.equal(enqueueBase(state, "fresh", "/repo/planning/600-new/plan.md"), null, "a new plan starts fresh");
});

test("handoff: the new thread holds the plan, so the old one is refused instead of taking it back", () => {
  const state = { queue: [{ threadId: "old", plan: P554, title: "554", firstQueuedAt: "2026-11-02T16:16:44Z", enqueuedAt: "2026-11-04T01:50:00Z", pauses: 2 }], woken: {}, ready: { old: { plan: P554 } }, asked: {}, handoffAsked: {} };
  const moved = queueLead(state, "old", "new", state.queue[0], { title: "554", compactions: 3 });
  assert.deepEqual(planHolders(moved, "old", P554, () => true).map((h) => [h.threadId, h.as]), [["new", "queued"]]);
  const woke = moveLead(state, "old", "new", { title: "554" });
  assert.deepEqual(planHolders(woke, "old", P554, () => true).map((h) => [h.threadId, h.as]), [["new", "woken"]]);
});

test("planAges: a finished or long-unheld plan's age goes; an active re-queue keeps it", () => {
  const now = Date.parse("2026-11-04T12:00:00Z"), open = (id) => id !== "settled";
  const rec = (at) => ({ firstQueuedAt: "2025-01-01T00:00:00Z", priority: "highest", pauses: 7, at });
  const ages = { "554-a": rec("2025-01-02T00:00:00Z"), "555-b": rec("2026-11-04T11:00:00Z"), "556-c": rec("2026-11-04T11:00:00Z"), "557-d": rec("2025-01-02T00:00:00Z") };
  const state = { queue: [{ threadId: "q", plan: "/t/planning/557-d/plan.md" }], woken: {}, ready: { settled: { plan: "/t/planning/556-c/plan.md" } }, built: {}, planAges: ages };
  // 554: no holder, a year old → gone; 555: no holder, an hour old (removed, re-queued soon) → kept;
  // 556: its lead was settled → finished; 557: still queued → kept however old.
  assert.deepEqual(Object.keys(tidyPlanAges(state, open, now)).sort(), ["555-b", "557-d"]);
  // A year after it finished, a re-queue starts fresh instead of reviving highest + 7 pauses.
  const later = { ...state, planAges: tidyPlanAges(state, open, now) };
  assert.equal(enqueueBase(later, "fresh", "/t/planning/554-a/plan.md"), null);
  // `remove` with no open holder left clears it; with the removed thread still building it stays.
  const q = { queue: [{ threadId: "r", plan: "/t/planning/558-e/plan.md" }], woken: {}, ready: {}, planAges: { "558-e": rec("2026-11-04T11:00:00Z") } };
  assert.deepEqual(afterRemove(q, "r", () => true).planAges, {});
  assert.ok(afterRemove({ ...q, ready: { r: { plan: "/t/planning/558-e/plan.md" } } }, "r", () => true).planAges["558-e"]);
});

test("take-over: the taken-over plan's history wins over the new owner's entry for another plan", () => {
  const theirs = { threadId: "new", plan: P554, title: "554", priority: "highest", firstQueuedAt: "2026-11-01T00:00:00Z", pauses: 7 };
  const mine = { threadId: "old", plan: "/repo/planning/600-other/plan.md", priority: "low", firstQueuedAt: "2026-11-04T11:00:00Z", pauses: 0 };
  const state = { queue: [theirs, mine], woken: {}, ready: {}, planAges: {} };
  const r = takeOver(state, P554, planHolders(state, "old", P554, () => true));
  const e = queueEntryFrom({ id: "old", title: "554", old: enqueueBase(r.state, "old", P554, r.carried), pause: true, now: "2026-11-04T12:00:00Z", given: { plan: P554 } });
  assert.deepEqual([e.firstQueuedAt, e.priority, e.pauses], ["2026-11-01T00:00:00Z", "highest", 8]);
  assert.equal(enqueueBase(state, "old", mine.plan), mine, "its own plan still builds on its own entry");
});

test("ready --take-over of plan B by a thread queued for plan A, then pause --plan B: B's history wins", () => {
  const PA = "/repo/planning/700-a/plan.md";
  const mine = { threadId: "me", plan: PA, title: "A", priority: "low", firstQueuedAt: "2026-11-04T11:00:00Z", pauses: 0 };
  const theirs = { threadId: "them", plan: P554, title: "554", priority: "highest", firstQueuedAt: "2025-01-01T00:00:00Z", pauses: 7 };
  const state = { queue: [mine, theirs], woken: {}, ready: {}, planAges: {} };
  const after = readyTakeOver(state, P554, planHolders(state, "me", P554, () => true));
  const e = queueEntryFrom({ id: "me", title: "554", old: enqueueBase(after, "me", P554), pause: true, now: "2026-11-04T12:00:00Z", given: { plan: P554 } });
  assert.deepEqual([e.firstQueuedAt, e.priority, e.pauses], ["2025-01-01T00:00:00Z", "highest", 8]);
});

test("ready --take-over keeps the carried history, and pre-S3 entries are backfilled", () => {
  const theirs = { threadId: "new", plan: P554, title: "554", priority: "highest", firstQueuedAt: "2026-11-01T00:00:00Z", pauses: 7 };
  const state = { queue: [theirs], woken: {}, ready: {}, planAges: {} }; // predates planAges
  const after = readyTakeOver(state, P554, planHolders(state, "old", P554, () => true));
  assert.deepEqual(after.queue, []);
  const e = queueEntryFrom({ id: "old", title: "554", old: enqueueBase(after, "old", P554), now: "2026-11-04T12:00:00Z", given: { plan: P554 } });
  assert.deepEqual([e.firstQueuedAt, e.priority, e.pauses], ["2026-11-01T00:00:00Z", "highest", 7]);
  const filled = backfillPlanAges([theirs, { ...theirs, threadId: "x", firstQueuedAt: "2026-11-03T00:00:00Z", priority: "low" }], { w: { plan: "/p/9.md" } }, { "other": { firstQueuedAt: "z" } }, "2026-11-04T12:00:00Z");
  assert.deepEqual(filled["554-smooth-animations"], { firstQueuedAt: "2026-11-01T00:00:00Z", priority: "highest", pauses: 7, at: "2026-11-04T12:00:00Z" }, "oldest entry wins");
  assert.deepEqual(Object.keys(filled).sort(), ["554-smooth-animations", "other"], "an entry without firstQueuedAt and existing records are left as they are");
});

test("handoff moves the old lead's built line to the new thread", () => {
  const built = { [P554]: { plan: P554, at: "2026-11-04T12:00:00Z", threadId: "old", title: "554" }, "/p/9.md": { plan: "/p/9.md", threadId: "x" } };
  const state = { queue: [{ threadId: "old", plan: P554, title: "554", firstQueuedAt: "2026-11-02T00:00:00Z" }], woken: {}, ready: {}, asked: {}, handoffAsked: {}, built };
  for (const s of [moveLead(state, "old", "new", { title: "554 b" }), queueLead(state, "old", "new", state.queue[0], { title: "554 b", compactions: 3 })]) {
    assert.equal(s.built[P554].threadId, "new");
    assert.equal(s.built["/p/9.md"].threadId, "x");
  }
});

test("built releases plan N only when no other plan N is still held unbuilt", () => {
  const a = "/repo/planning/604-ctrl-k/plan.md", b = "/repo/planning/604-other/plan.md";
  const state = { queue: [{ threadId: "qb", plan: b }], woken: {}, ready: {}, built: { [a]: { plan: a, threadId: "la" } } };
  assert.equal(builtPlans(state).has(604), false, "the other 604 still queued");
  assert.equal(builtPlans({ ...state, queue: [] }).has(604), true);
  assert.equal(builtPlans({ ...state, queue: [{ threadId: "qa", plan: "/tmp/wt/planning/604-ctrl-k/plan.md" }] }).has(604), true, "its own lead queued (worktree path) doesn't block");
});

test("built: its lead still holds the plan, so another thread is refused until it's settled", () => {
  const state = { queue: [], woken: {}, ready: { lead: { plan: P554, title: "554" } }, built: {} };
  const r = markBuilt(state, P554, "lead", "554", "2026-11-04T12:00:00Z");
  assert.deepEqual(planHolders(r.state, "other", P554, () => true).map((h) => [h.threadId, h.as]), [["lead", "built"]]);
  assert.deepEqual(planHolders(r.state, "other", P554, (id) => id !== "lead"), [], "settled lead: free");
});

test("take-over of a built plan moves the built record, so the new owner isn't refused by the old one", () => {
  const state = { queue: [], woken: {}, ready: { lead: { plan: P554, title: "554" } }, built: {} };
  const b = markBuilt(state, P554, "lead", "554", "2026-11-04T12:00:00Z").state;
  const holders = planHolders(b, "new", P554, () => true);
  for (const s of [takeOver(b, P554, holders, "new").state, readyTakeOver(b, P554, holders, "new")]) {
    assert.equal(s.built[path.resolve(P554)].threadId, "new");
    assert.deepEqual(planHolders(s, "new", P554, () => true), [], "the new owner holds it alone");
    assert.deepEqual(planHolders(s, "lead", P554, () => true).map((h) => [h.threadId, h.as]), [["new", "built"]]);
  }
});

test("triageRunsFrom: a lineage-marked worker titled Triage… is not a triage run", () => {
  const rows = [
    { thread_id: "w1", title: "Triage: worker", created_at: "2026-10-08T20:00:00Z", relationship: "subagent", first: "check the logs" },
    { thread_id: "m1", title: "Triaging: 3 new items", created_at: "2026-10-08T20:00:00Z", relationship: null, first: "Triage the 3 new items." },
  ];
  const worker = (t) => t.lineage?.relationshipToParent === "subagent";
  assert.deepEqual(triageRunsFrom(rows, worker).map((r) => r.threadId), ["m1"]);
});
