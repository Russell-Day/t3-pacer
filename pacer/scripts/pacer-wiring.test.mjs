// End to end: the real pacer.mjs CLI against a fake T3 (testdata/fake-t3.mjs).
// Proves the wiring the unit tests can't: ready/enqueue/pause and the triage hook send no
// thread.pin, recorded questions hold threads, and legacy woken records stay ready through a handoff.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PROJECT, ago, fakeHome as baseHome, opus } from "./testdata/fake-home.mjs";
import { triageTitle, wallClock } from "./pacer.mjs";

const pacer = path.join(path.dirname(new URL(import.meta.url).pathname), "pacer.mjs");
// Thread fixtures say how their latest turn went (turn_state, turn_completed_at); T3 0.1.0 keeps
// that as a run, so each such thread gets one in the fake's JSON db.
function fakeHome(opts) {
  const f = baseHome(opts);
  const file = path.join(f.home, "t3.json");
  const db = f.db();
  db.runs = db.threads.filter((t) => t.turn_state).map((t) => ({ run_id: `run:${t.thread_id}:1`, thread_id: t.thread_id, ordinal: 1, status: t.turn_state,
    requested_at: t.turn_completed_at ?? ago(1), completed_at: ["completed", "failed", "interrupted"].includes(t.turn_state) ? t.turn_completed_at ?? ago(1) : null }));
  for (const m of db.messages) if (db.runs.some((r) => r.thread_id === m.thread_id)) m.run_id ??= `run:${m.thread_id}:1`;
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  return f;
}
const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}${r.stdout}`); return r; };
// The questions hook (config.json "questions.file"): one open question per id, q0, q1, ...
const setConfig = (f, more) => {
  const file = path.join(f.stateDir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...more }));
};
function asksFor(f, ...ids) {
  const file = path.join(f.home, "questions.json");
  const qs = {};
  ids.forEach((id, i) => { (qs[id] ??= []).push({ id: `q${i}`, question: "Ship it?", at: ago(120) }); });
  fs.writeFileSync(file, JSON.stringify(qs));
  setConfig(f, { questions: { file } });
}

for (const verb of ["ready", "enqueue", "pause"]) {
  test(`${verb} doesn't pin the thread`, () => {
    const id = randomUUID();
    const f = fakeHome({ threads: [{ thread_id: id, title: "Task 99 work" }] });
    ok(f.run(pacer, [verb, "--thread", id, "--plan", "/tmp/plan.md"]));
    assert.equal(f.sent("thread.pin").length, 0);
    assert.ok(f.state().ready[id], "marked ready");
  });
}

for (const verb of ["enqueue", "pause"]) {
  test(`${verb} refuses a thread with a recorded open ask, whatever its last message says`, () => {
    const id = randomUUID();
    const f = fakeHome({ threads: [{ thread_id: id, title: "Task 99 work" }],
      messages: [{ thread_id: id, role: "assistant", text: "Stage 1 committed.", created_at: ago(1) }] });
    asksFor(f, id);
    const r = f.run(pacer, [verb, "--thread", id, "--plan", "/tmp/plan.md"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /1 question for the user still open \(q0\)/);
    assert.deepEqual(f.sent().map((c) => c.type), [], "no snooze or pin");
  });
}

test("a worker thread is refused and never pinned", () => {
  const id = randomUUID();
  const f = fakeHome({ threads: [{ thread_id: id, title: "Review: stage 1", lineage: { parentThreadId: "lead-1", relationshipToParent: "subagent", rootThreadId: "lead-1" } }] });
  const r = f.run(pacer, ["ready", "--thread", id, "--plan", "/tmp/plan.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worker/);
  assert.equal(f.sent("thread.pin").length, 0);
});

test("tick with N > 0 creates one unpinned triage thread with its first message", () => {
  const f = fakeHome({ config: { triage: { project: PROJECT, checkCommand: "echo 3" } } });
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), ["thread.create", "message.dispatch"]);
  const [created] = f.sent("thread.create");
  assert.equal(created.title, triageTitle(3));
  assert.equal(created.projectId, "proj-1");
  const thread = f.db().threads.find((t) => t.thread_id === created.threadId);
  assert.equal(thread.pinned_at, null, "not pinned");
  const s = f.state().triage;
  assert.equal(s.threadId, created.threadId);
  assert.equal(s.pending, null);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1, "same window: no second thread");
});

test("legacy woken record: the user writes, > 10 min later it is still ready and gets asked", () => {
  const legacy = randomUUID();
  const other = randomUUID();
  const built = randomUUID();
  const firstQueuedAt = ago(600);
  // an ask needs two ready threads (the not-ready one doesn't count); "built" is the
  // second, and the user wrote in it more recently, so the legacy thread is asked.
  const f = fakeHome({
    usedPercent: 85, resetsInMin: 180,
    threads: [
      { thread_id: legacy, title: "Task 98 legacy", turn_state: "running", pinned_at: ago(90) },
      { thread_id: other, title: "Task 97 not ready", turn_state: "running" },
      { thread_id: built, title: "Task 96 building", turn_state: "running" },
    ],
    messages: [{ thread_id: legacy, message_id: randomUUID(), role: "user", text: "looks good, go on", created_at: ago(15) },
      { thread_id: built, message_id: randomUUID(), role: "user", text: "ok", created_at: ago(12) }],
    state: { queue: [], woken: { [legacy]: { plan: "/tmp/legacy.md", title: "Task 98 legacy", priority: "highest", size: "l", firstQueuedAt, wokenAt: ago(60), pauses: 2, note: "S3 next" } }, asked: {},
      ready: { [built]: { plan: "/tmp/built.md", title: "Task 96 building", readyAt: ago(60) } } },
  });
  const dry = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
  assert.match(dry, /would hand/);
  const out = JSON.parse(dry.slice(dry.indexOf("{")));
  assert.equal(out.action, "ask-pause", out.reason);
  assert.equal(out.threadId, legacy);
  ok(f.run(pacer, ["tick"]));
  const s = f.state();
  assert.equal(s.woken[legacy], undefined, "handoff dropped the woken record");
  assert.ok(s.ready[legacy], "still ready after the handoff");
  // the woken record's queue fields are kept, so the next pause keeps its place.
  const hb = s.ready[legacy].handedBack;
  assert.deepEqual({ ...hb, at: undefined }, { at: undefined, priority: "highest", size: "l", firstQueuedAt, pauses: 2, note: "S3 next", plan: "/tmp/legacy.md",
    why: "the user wrote in it after the pacer woke it" });
  assert.equal(s.ready[other], undefined);
  assert.ok(s.ready[built]);
  assert.ok(f.sent("message.dispatch").some((c) => c.threadId === legacy && /^Pacer: over pace/.test(c.text)), "asked to pause");
  ok(f.run(pacer, ["pause", "--thread", legacy]));
  const q = f.state().queue.find((e) => e.threadId === legacy);
  assert.deepEqual([q.priority, q.size, q.firstQueuedAt, q.pauses, q.note, q.plan], ["highest", "l", firstQueuedAt, 3, "S3 next", "/tmp/legacy.md"]);
  assert.equal(f.state().ready[legacy].handedBack, undefined, "re-queued: handedBack cleared");
});

// --- Sleep file, against fixture sleep files; never the real one.
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
const sleepFixture = (f, raw) => { const p = path.join(f.home, "sleep.json"); fs.writeFileSync(p, typeof raw === "string" ? raw : JSON.stringify(raw)); return p; };
const tonight = (more = {}) => ({ day: "2026-10-09", bedtime_at: iso(-60), night_until: iso(600), wake_at: null, updated_at: iso(-60), ...more });
const logOf = (f) => fs.readFileSync(path.join(f.stateDir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// A queued thread the tick can wake: snoozed, idle.
const queuedThread = (id, title) => ({ thread_id: id, title, turn_state: "completed", turn_completed_at: ago(60), snoozed_at: ago(50), snoozed_until: iso(7 * 1440) });
const entry = (id, title, more = {}) => ({ threadId: id, title, plan: `/tmp/${id}.md`, priority: "med", firstQueuedAt: ago(30), enqueuedAt: ago(30), pauses: 0, ...more });

function sleepHome({ raw, threads = [], state, config = {}, ...rest }) {
  const f = fakeHome({ threads, state, config, ...rest });
  const file = sleepFixture(f, raw);
  const base = JSON.parse(fs.readFileSync(path.join(f.stateDir, "config.json"), "utf8")); // the fake's day pin
  fs.writeFileSync(path.join(f.stateDir, "config.json"), JSON.stringify({ ...base, sleepFile: file, reportCommand: `cat > ${path.join(f.home, "posted.md")}`, ...config }));
  return { ...f, file, posted: () => (fs.existsSync(path.join(f.home, "posted.md")) ? fs.readFileSync(path.join(f.home, "posted.md"), "utf8") : null) };
}

test("`sleep` prints asleep|night|awake plus the times; status shows the line", () => {
  const f = sleepHome({ raw: tonight() });
  assert.match(ok(f.run(pacer, ["sleep"])).stdout, /^asleep \(bedtime .+, coding night until .+; asleep until the sleep file records a wake, at the latest .+\)\n$/);
  assert.match(ok(f.run(pacer, ["status"])).stdout, /\nSleep: asleep \(bedtime/);
  sleepFixture(f, tonight({ wake_at: iso(-5) }));
  assert.match(ok(f.run(pacer, ["sleep"])).stdout, /^night \(.*woke /);
  sleepFixture(f, tonight({ bedtime_at: null, night_until: null }));
  assert.equal(ok(f.run(pacer, ["sleep"])).stdout, "awake (no bedtime tonight: clock rules)\n");
});

test("asleep: the wake message carries the asleep line; awake it doesn't", () => {
  for (const [raw, want] of [[tonight(), true], [tonight({ wake_at: iso(-5) }), false]]) {
    const id = randomUUID();
    const f = sleepHome({ raw, threads: [queuedThread(id, "Task 99 work")], state: { queue: [entry(id, "Task 99 work")], woken: {}, asked: {} } });
    ok(f.run(pacer, ["tick"]));
    const [wake] = f.sent("message.dispatch");
    assert.equal(wake?.threadId, id, "woken");
    assert.match(wake.text, /^Pacer: your turn/);
    assert.equal(wake.text.includes("The user is asleep: don't end the turn on a question"), want);
  }
});

test("coding night: a day window counts as night (night pace, size l first); after night_until the clock rules", () => {
  const reset = new Date(Date.now() + 150 * 60000 + 60 * 60000);
  const w = wallClock(reset.getTime(), "UTC"); // the fake config.json sets timeZone UTC
  const hhmm = `${String(w.h).padStart(2, "0")}:${String(w.m).padStart(2, "0")}`;
  const s = randomUUID(), l = randomUUID();
  const setup = (raw) => sleepHome({ raw, config: { night: { resetFrom: hhmm, resetTo: hhmm } },
    threads: [queuedThread(s, "Small plan"), queuedThread(l, "Long plan")],
    state: { queue: [entry(s, "Small plan", { size: "s", priority: "low", firstQueuedAt: ago(40) }), entry(l, "Long plan", { size: "l", priority: "low" })], woken: {}, asked: {} } });
  const dry = (f) => { const out = ok(f.run(pacer, ["tick", "--dry-run"])).stdout; return JSON.parse(out.slice(out.indexOf("{"))); };
  const n = dry(setup(tonight()));
  assert.equal(n.mode, "night");
  assert.equal(n.sleep, "asleep");
  assert.match(n.paceLine, /^night/);
  assert.equal(n.threadId, l, "size l first at night");
  const d = dry(setup(tonight({ bedtime_at: iso(-600), night_until: iso(-1), wake_at: iso(-60) })));
  assert.equal(d.mode, "day");
  assert.equal(d.threadId, s, "size s first by day");
});

// One thread with a recorded question for the user, one not (both last messages read like
// questions or not, it doesn't matter): the "Waiting on the user" list holds only the first.
const digestThreads = (asks, quiet) => ({
  threads: [{ thread_id: asks, title: "Task 80 lead", turn_state: "completed", turn_completed_at: ago(90) },
    { thread_id: quiet, title: "Task 81 lead", turn_state: "completed", turn_completed_at: ago(90) }],
  messages: [{ thread_id: asks, message_id: randomUUID(), role: "assistant", text: "Should I use option A or option B?", created_at: ago(90) },
    { thread_id: quiet, message_id: randomUUID(), role: "assistant", text: "Should I keep going?", created_at: ago(90) }] });

test("wake digest: the first tick that sees the wake posts the questions list once, even if no tick saw the user asleep", () => {
  const asks = randomUUID(), quiet = randomUUID();
  // No earlier tick saw "asleep": bedtime and the wake both fell between two ticks.
  const f = sleepHome({ raw: tonight({ wake_at: iso(-2) }), ...digestThreads(asks, quiet), state: { queue: [], woken: {}, asked: {} } });
  asksFor(f, asks);
  ok(f.run(pacer, ["tick", "--dry-run"]));
  assert.equal(f.posted(), null, "dry run posts nothing");
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.posted(), "**Good morning: 1 thread has questions for you**\n- Task 80 lead");
  fs.rmSync(path.join(f.home, "posted.md"));
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.posted(), null, "once per night");
  assert.deepEqual(logOf(f).filter((l) => l.event === "wake-digest").map((l) => [l.count, l.posted]), [[1, true]]);
  assert.equal(f.state().sleep.digestDay, "2026-10-09");
});

test("wake digest: a failed post shows in the next report's Errors section", () => {
  const asks = randomUUID();
  const f = sleepHome({ raw: tonight({ wake_at: iso(-2) }), ...digestThreads(asks, randomUUID()), state: { queue: [], woken: {}, asked: {} } });
  asksFor(f, asks);
  setConfig(f, { reportCommand: "echo boom >&2; exit 3" });
  ok(f.run(pacer, ["tick"]));
  assert.equal(logOf(f).find((l) => l.event === "wake-digest").error, "reportCommand failed (3): boom");
  const out = ok(f.run(pacer, ["report"])).stdout;
  assert.match(out, /\*\*Errors\*\*[\s\S]*- the wake digest didn't post: reportCommand failed \(3\): boom/);
});

test("wake digest: after a tick that saw the user asleep, the same single post", () => {
  const asks = randomUUID(), quiet = randomUUID();
  const f = sleepHome({ raw: tonight({ wake_at: iso(-2) }),
    threads: [{ thread_id: asks, title: "Task 80 lead", turn_state: "completed", turn_completed_at: ago(90) },
      { thread_id: quiet, title: "Task 81 lead", turn_state: "completed", turn_completed_at: ago(90) }],
    messages: [{ thread_id: asks, message_id: randomUUID(), role: "assistant", text: "Should I use option A or option B?", created_at: ago(90) },
      { thread_id: quiet, message_id: randomUUID(), role: "assistant", text: "Stage 2 committed.", created_at: ago(90) }],
    state: { queue: [], woken: {}, asked: {}, sleep: { key: "asleep||x", label: "asleep" } } });
  asksFor(f, asks);
  ok(f.run(pacer, ["tick", "--dry-run"]));
  assert.equal(f.posted(), null, "dry run posts nothing");
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.posted(), "**Good morning: 1 thread has questions for you**\n- Task 80 lead");
  fs.rmSync(path.join(f.home, "posted.md"));
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.posted(), null, "once per night");
  assert.deepEqual(logOf(f).filter((l) => l.event === "wake-digest").map((l) => [l.count, l.posted]), [[1, true]]);
  assert.equal(f.state().sleep.digestDay, "2026-10-09");
});

test("garbled or missing sleep file: the tick runs on the clock, logged once per change", () => {
  const f = sleepHome({ raw: "{not json" });
  ok(f.run(pacer, ["tick"]));
  ok(f.run(pacer, ["tick"]));
  const sleeps = () => logOf(f).filter((l) => l.event === "sleep");
  assert.equal(sleeps().length, 1);
  assert.match(sleeps()[0].note, /^garbled .*sleep\.json/);
  assert.equal(logOf(f).filter((l) => l.event === "tick").length, 2, "both ticks ran");
  fs.rmSync(f.file);
  ok(f.run(pacer, ["tick"]));
  assert.match(sleeps().at(-1).note, /^no sleep file at /);
  assert.match(ok(f.run(pacer, ["sleep"])).stdout, /^awake \(no sleep file at .*: clock rules\)/);
});

test("cap: a bare `cap` errors and leaves the existing cap alone", () => {
  const cap = { windowId: "x", from: 31, add: 10, setAt: new Date().toISOString() };
  const f = fakeHome({ state: { queue: [], cap } });
  const r = f.run(pacer, ["cap"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cap needs --add/);
  assert.deepEqual(f.state().cap, cap);
});

// Emergency dispatch: the real CLI, fake T3, stub check/text/post commands.
// rec.sh <name> writes its args (one per line) to <name>.args and its stdin to <name>.stdin.
function emergencyHome({ causes = [], config = {}, ...more } = {}) {
  const f = fakeHome(more);
  fs.writeFileSync(path.join(f.home, "check.json"), JSON.stringify({ at: new Date().toISOString(), causes }));
  fs.writeFileSync(path.join(f.home, "rec.sh"), `name=$1; shift; printf '%s\\n' "$@" > "${f.home}/$name.args"; cat > "${f.home}/$name.stdin"\n`);
  const emergency = { project: PROJECT, checkCommand: `echo x >> ${f.home}/checks; cat ${f.home}/check.json`,
    textCommand: `sh ${f.home}/rec.sh text`, postCommand: `sh ${f.home}/rec.sh post`, cooldownHours: 6 };
  setConfig(f, { emergency, ...config });
  const read = (name) => { try { return fs.readFileSync(path.join(f.home, name), "utf8"); } catch { return null; } };
  return { ...f, read, emergency: () => JSON.parse(read("pacer/emergency.json") ?? "{}"), checks: () => (read("checks") ?? "").split("\n").filter(Boolean).length };
}
// A summary with shell metacharacters: it must reach textCommand as one literal argument.
const errorsCause = { key: "errors", count: 217, threshold: 50, window_min: 60, summary: "217 errors in the last hour $(touch PWNED)",
  top: [{ source: "app.sync_worker", message: "HTTP 429", n: 205 }] };

test("emergency: a tripped check starts one unpinned thread, texts (args, key) and posts; the next tick holds", () => {
  const f = emergencyHome({ causes: [errorsCause] });
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), ["thread.create", "message.dispatch"]);
  const [created] = f.sent("thread.create");
  const title = "Emergency: 217 errors in the last hour $(touch PWNED)";
  assert.equal(created.title, title);
  assert.equal(created.projectId, "proj-1");
  assert.equal(created.modelSelection.model, "claude-opus-5-5");
  assert.match(f.sent("message.dispatch")[0].text, /205× app\.sync_worker: HTTP 429/);
  const e = f.emergency();
  assert.equal(e.threadId, created.threadId);
  assert.deepEqual(e.last.errors.count, 217);
  const line = `Pacer emergency: 217 errors in the last hour $(touch PWNED). claude-opus-5-5 thread '${title}' is on it.`;
  assert.equal(f.read("text.args"), `${line}\n--key\nemergency-${created.threadId}\n`);
  assert.equal(f.read("post.stdin"), line);
  assert.equal(fs.existsSync(path.join(f.home, "PWNED")), false, "the message never runs in a shell");
  assert.equal(fs.existsSync(path.join(f.stateDir, "PWNED")), false);
  assert.ok(logOf(f).some((l) => l.event === "emergency-start" && l.threadId === created.threadId));
  assert.equal(logOf(f).find((l) => l.event === "tick").blind, false);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1, "open thread: no second one");
  assert.ok(logOf(f).some((l) => l.event === "emergency-held"));
  assert.equal(f.checks(), 2, "the check runs once per tick");
  assert.match(ok(f.run(pacer, ["status"])).stdout, new RegExp(`Emergency: thread ${created.threadId.slice(0, 8)} "Emergency: 217 errors.*open since .*\\(errors 217\\)`));
});

test("emergency: hold on still starts it; dry run sends nothing and says what it would do", () => {
  const dry = emergencyHome({ causes: [errorsCause], state: { queue: [], held: { since: ago(5) } } });
  const out = ok(dry.run(pacer, ["tick", "--dry-run"])).stdout;
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("{"))).emergency, ["would start emergency thread \"Emergency: 217 errors in the last hour $(touch PWNED)\" (errors 217)",
    "would notify the user if the thread can't be opened"]);
  assert.equal(dry.sent().length, 0);
  assert.equal(dry.read("text.args"), null);
  const f = emergencyHome({ causes: [errorsCause], state: { queue: [], held: { since: ago(5) } } });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1);
  assert.ok(f.state().held, "still on hold");
});

test("emergency: a crashing check doesn't break the tick; a failed text still records the thread", () => {
  const f = emergencyHome({ causes: [errorsCause] });
  const cfg = JSON.parse(fs.readFileSync(path.join(f.stateDir, "config.json"), "utf8"));
  setConfig(f, { emergency: { ...cfg.emergency, checkCommand: "echo Traceback >&2; exit 2" } });
  ok(f.run(pacer, ["tick"]));
  assert.equal(logOf(f).find((l) => l.event === "emergency-check-error").error, "checkCommand exited 2: Traceback");
  assert.deepEqual(logOf(f).find((l) => l.event === "tick").emergency, ["emergency-check-error: checkCommand exited 2: Traceback"]);
  assert.equal(f.sent().length, 0);
  setConfig(f, { emergency: { ...cfg.emergency, textCommand: "echo backend down >&2; exit 1" } });
  ok(f.run(pacer, ["tick"]));
  const [created] = f.sent("thread.create");
  assert.equal(f.emergency().threadId, created.threadId);
  assert.equal(logOf(f).find((l) => l.event === "emergency-text-failed").error, "textCommand exited 1: backend down");
  assert.ok(f.read("post.stdin"), "the post still goes out");
});

test("emergency: 3 failed ticks in a row (garbled queue.json) start the pacer-failing thread; queue.json is left alone", () => {
  const f = emergencyHome();
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), "{garbled");
  for (let i = 1; i <= 3; i++) {
    const r = f.run(pacer, ["tick"]);
    assert.notEqual(r.status, 0);
    assert.equal(f.sent("thread.create").length, i === 3 ? 1 : 0, `tick ${i}`);
  }
  const [created] = f.sent("thread.create");
  assert.equal(created.title, "Emergency: pacer failed 3 ticks in a row");
  assert.match(f.sent("message.dispatch")[0].text, /Last error: .*JSON[\s\S]*Commit in the repo you fixed/);
  assert.equal(f.emergency().last["pacer-failing"].count, 3);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "queue.json"), "utf8"), "{garbled");
  assert.equal(f.checks(), 3, "the check ran once per tick (normal path), not again on the catch path");
  assert.deepEqual(logOf(f).filter((l) => l.event === "error").map((l) => l.blind), [false, false, false]);
  f.run(pacer, ["tick"]);
  assert.equal(f.sent("thread.create").length, 1, "4th failure: thread still open, held");
  assert.equal(logOf(f).filter((l) => l.event === "emergency-held").at(-1).causes[0].count, 4);
});

test("emergency: with only a triage project (no emergency block) the pacer-failing thread still starts there", () => {
  const f = fakeHome({ config: { triage: { project: PROJECT, checkCommand: "echo 0" } } });
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), "{garbled");
  for (let i = 0; i < 3; i++) f.run(pacer, ["tick"]);
  assert.equal(f.sent("thread.create")[0]?.title, "Emergency: pacer failed 3 ticks in a row");
  assert.equal(logOf(f).find((l) => l.event === "emergency-text-failed").error, "no \"textCommand\" in emergency config");
});

test("emergency: 6 ticks with no Session window start the pacer-blind thread", () => {
  const f = emergencyHome();
  const db = f.db();
  db.usage[0].windows = [];
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  for (let i = 1; i <= 6; i++) {
    ok(f.run(pacer, ["tick"]));
    assert.equal(f.sent("thread.create").length, i === 6 ? 1 : 0, `tick ${i}`);
  }
  assert.equal(f.sent("thread.create")[0].title, "Emergency: no Claude usage window for 30 min");
  assert.deepEqual(logOf(f).filter((l) => l.event === "tick").map((l) => l.blind), [true, true, true, true, true, true]);
});

test("emergency: no usage data at all fails the tick: pacer-failing at 3, then pacer-blind at 6 is held while it is open", () => {
  const f = emergencyHome();
  const db = f.db();
  db.usage = [];
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  for (let i = 0; i < 6; i++) f.run(pacer, ["tick"]);
  assert.deepEqual(f.sent("thread.create").map((c) => c.title), ["Emergency: pacer failed 3 ticks in a row"]);
  assert.deepEqual(logOf(f).filter((l) => l.event === "error").map((l) => l.blind), [true, true, true, true, true, true]);
  assert.deepEqual(logOf(f).filter((l) => l.event === "emergency-held").at(-1).causes, [{ key: "pacer-failing", count: 6 }, { key: "pacer-blind", count: 6 }]);
});

// Fault injection: a preload (loaded after the fake T3) that changes how one T3 command behaves.
const fakeT3 = path.resolve(path.dirname(new URL(import.meta.url).pathname), "testdata/fake-t3.mjs");
function faultRun(f, body, args = ["tick"]) {
  const file = path.join(f.home, `fault-${randomUUID()}.mjs`);
  fs.writeFileSync(file, `import ${JSON.stringify(fakeT3)};\nconst send = WebSocket.prototype.send;\nWebSocket.prototype.send = function (raw) { const r = JSON.parse(raw); ${body} };\n`);
  return f.run(pacer, args, { NODE_OPTIONS: `--import ${file}` });
}
// The command applies, then the process dies before the reply.
const crashAfter = (type) => `send.call(this, raw); if (r.payload?.type === ${JSON.stringify(type)}) process.exit(77);`;
// The command applies, then the reply says it failed.
const lostAck = (type) => `if (r.payload?.type === ${JSON.stringify(type)}) { const good = this.onmessage; this.onmessage = (e) => { const m = JSON.parse(e.data); if (m.requestId !== r.id) return good(e); this.onmessage = good; good({ data: JSON.stringify({ requestId: r.id, _tag: "Exit", exit: { _tag: "Failure", cause: "lost acknowledgment after effect" } }) }); }; } send.call(this, raw);`;

test("emergency: the thread is Opus high", () => {
  const f = emergencyHome({ causes: [errorsCause] });
  ok(f.run(pacer, ["tick"]));
  const [created] = f.sent("thread.create");
  assert.deepEqual(created.modelSelection.options.find((o) => o.id === "effort"), { id: "effort", value: "high" });
});

test("emergency: a crash or lost ack after each create step, then a normal tick: one thread, no pin, one first message, one text", () => {
  for (const type of ["thread.create", "message.dispatch"]) {
    for (const [kind, fault] of [["crash", crashAfter(type)], ["lost ack", lostAck(type)]]) {
      const at = `${kind} after ${type}`;
      const f = emergencyHome({ causes: [errorsCause] });
      setConfig(f, { emergency: { ...JSON.parse(fs.readFileSync(path.join(f.stateDir, "config.json"), "utf8")).emergency, textCommand: `echo x >> ${f.home}/texts; sh ${f.home}/rec.sh text` } });
      const r = faultRun(f, fault);
      if (kind === "crash") { assert.equal(r.status, 77, at); fs.rmSync(path.join(f.stateDir, "queue.lock"), { force: true }); }
      else assert.ok(logOf(f).some((l) => l.event === "emergency-failed"), at);
      const pending = f.emergency().pending;
      assert.ok(pending?.threadId, `${at}: the pending start was saved`);
      // A lost ack is a failed create: the user gets one "couldn't open the thread" text. A crash sends nothing.
      const failText = kind === "lost ack" ? "x\n" : "";
      assert.equal(f.read("texts") ?? "", failText, `${at}: no start text before the thread exists`);
      ok(f.run(pacer, ["tick"]));
      assert.deepEqual(f.sent("thread.create").map((c) => c.threadId), [pending.threadId], at);
      assert.equal(f.sent("thread.pin").length, 0, at);
      assert.deepEqual(f.sent("message.dispatch").map((c) => [c.threadId, c.messageId]), [[pending.threadId, pending.messageId]], at);
      assert.equal(f.db().messages.filter((m) => m.thread_id === pending.threadId && m.role === "user").length, 1, at);
      const e = f.emergency();
      assert.equal(e.threadId, pending.threadId, at);
      assert.equal(e.pending, null, at);
      assert.equal(e.notified, true, at);
      assert.equal(f.read("texts"), "x\n", `${at}: one start text`);
      assert.match(f.read("text.args"), new RegExp(`--key\nemergency-${pending.threadId}\n$`), at);
      ok(f.run(pacer, ["tick"]));
      assert.equal(f.sent("thread.create").length, 1, `${at}: the next tick holds`);
      assert.equal(f.read("texts"), "x\n", at);
    }
  }
});

test("emergency: a crash between the save and the text sends one alert on the next tick; a failed text is not retried", () => {
  const f = emergencyHome({ causes: [errorsCause] });
  const cfg = JSON.parse(fs.readFileSync(path.join(f.stateDir, "config.json"), "utf8")).emergency;
  const setText = (textCommand) => setConfig(f, { emergency: { ...cfg, textCommand } });
  setText("kill -9 $PPID"); // sh's parent is the pacer: it dies inside the text step
  assert.notEqual(f.run(pacer, ["tick"]).status, 0);
  fs.rmSync(path.join(f.stateDir, "queue.lock"), { force: true });
  const [created] = f.sent("thread.create");
  assert.equal(f.emergency().notified, false);
  setText(`echo x >> ${f.home}/texts; sh ${f.home}/rec.sh text`);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.read("texts"), "x\n");
  assert.match(f.read("text.args"), new RegExp(`--key\nemergency-${created.threadId}\n$`));
  assert.equal(f.emergency().notified, true);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.read("texts"), "x\n", "once");
  assert.equal(f.sent("thread.create").length, 1);

  const g = emergencyHome({ causes: [errorsCause] });
  const gcfg = JSON.parse(fs.readFileSync(path.join(g.stateDir, "config.json"), "utf8")).emergency;
  setConfig(g, { emergency: { ...gcfg, textCommand: `echo x >> ${g.home}/texts; exit 1` } });
  ok(g.run(pacer, ["tick"]));
  ok(g.run(pacer, ["tick"]));
  assert.equal(g.sent("thread.create").length, 1);
  assert.equal(g.read("texts"), "x\n", "exactly one text attempt");
});

test("emergency: a wake that fails after the decision counts as a failed tick: pacer-failing starts on the 3rd; null usage counts blind once per tick", () => {
  for (const blind of [false, true]) {
    const id = randomUUID();
    const f = emergencyHome({ threads: [queuedThread(id, "Queued plan")], state: { queue: [entry(id, "Queued plan")], woken: {}, asked: {} } });
    if (blind) { const db = f.db(); db.usage[0].windows = []; fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db)); }
    const refuse = `if (r.payload?.type === "message.dispatch" && r.payload.threadId === ${JSON.stringify(id)}) { setImmediate(() => this.onmessage?.({ data: JSON.stringify({ requestId: r.id, _tag: "Exit", exit: { _tag: "Failure", cause: "wake refused" } }) })); return; } send.call(this, raw);`;
    for (let i = 1; i <= 3; i++) {
      assert.notEqual(faultRun(f, refuse).status, 0, `tick ${i}`);
      const log = logOf(f);
      assert.equal(log.filter((l) => l.event === "error").length, i, `tick ${i}: one error line`);
      assert.equal(log.filter((l) => l.event === "tick").length, 0, `tick ${i}: no tick line for a failed tick`);
      if (blind) assert.deepEqual(log.filter((l) => l.event === "error").map((l) => l.blind), Array(i).fill(true));
      assert.deepEqual(f.sent("thread.create").map((c) => c.title), i === 3 ? ["Emergency: pacer failed 3 ticks in a row"] : [], `tick ${i}`);
    }
    assert.match(f.sent("message.dispatch").find((c) => c.threadId !== id).text, /Last error: .*wake refused/);
    if (blind) {
      // Ticks 4–6 (still failing, blindness +1 each): pacer-blind reaches 6 on the 6th and is held behind the open thread.
      for (let i = 4; i <= 6; i++) faultRun(f, refuse);
      assert.deepEqual(logOf(f).filter((l) => l.event === "emergency-held").at(-1).causes, [{ key: "pacer-failing", count: 6 }, { key: "pacer-blind", count: 6 }]);
    }
  }
});

// --- T3 0.1.0: messages, usage-limit recovery, delegated children, createdBy.

test("a wake is an agent message that starts a turn on the thread's model; an ask to pause queues behind the running turn", () => {
  const id = randomUUID();
  const f = fakeHome({ threads: [queuedThread(id, "Task 99 work")], state: { queue: [entry(id, "Task 99 work")], woken: {}, asked: {} } });
  ok(f.run(pacer, ["tick"]));
  const [wake] = f.sent("message.dispatch");
  assert.deepEqual([wake.threadId, wake.createdBy, wake.dispatchMode.type, wake.modelSelection.model], [id, "agent", "start_immediately", "claude-opus-5-5"]);
  assert.deepEqual(f.sent("thread.unsnooze").map((c) => c.threadId), [id]);
  assert.equal(f.sent("thread.turn.start").length, 0);
});

test("the ask to pause goes in with queue_after_active", () => {
  const a = randomUUID(), b = randomUUID();
  const f = fakeHome({ usedPercent: 85, resetsInMin: 180,
    threads: [{ thread_id: a, title: "Task 1", turn_state: "running" }, { thread_id: b, title: "Task 2", turn_state: "running" }],
    state: { queue: [], woken: { [a]: { plan: "/tmp/a.md", title: "Task 1", priority: "med", wokenAt: ago(60), pauses: 0 } }, asked: {},
      ready: { [a]: { plan: "/tmp/a.md", title: "Task 1", readyAt: ago(60) }, [b]: { plan: "/tmp/b.md", title: "Task 2", readyAt: ago(60) } } } });
  ok(f.run(pacer, ["tick"]));
  const [ask] = f.sent("message.dispatch");
  assert.deepEqual([ask.threadId, ask.createdBy, ask.dispatchMode.type], [a, "agent", "queue_after_active"]);
  assert.match(ask.text, /^Pacer: over pace/);
});

// A queued thread whose last run failed on the usage limit, reset in the future: T3 snoozed it
// to the reset and resumes it itself.
function limitHome(resetAt, more = {}) {
  const id = randomUUID();
  const f = fakeHome({ threads: [{ ...queuedThread(id, "Task 77 limited"), turn_state: "failed", snoozed_until: resetAt }], state: { queue: [entry(id, "Task 77 limited")], woken: {}, asked: {} }, ...more });
  const db = f.db();
  db.items = [{ thread_id: id, run_id: `run:${id}:1`, type: "error", status: "failed", updated_at: ago(30), payload: { failure: { class: "usage_limit", message: "Claude usage limit reached", resetAt } } }];
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  return { ...f, id };
}

test("a queued thread paused by the usage limit is never woken, unsnoozed, re-snoozed or handed back before its reset", () => {
  const f = limitHome(iso(90));
  const dry = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
  const out = JSON.parse(dry.slice(dry.indexOf("{")));
  assert.equal(out.action, "none");
  assert.equal(out.ready, 0);
  assert.match(out.reason, /1 paused by the usage limit \(T3 resumes it after the reset\)/);
  assert.match(out.limitPaused[0], /Task 77 limited \(T3 resumes after .*, queued\)/);
  assert.match(dry, /leaves .* alone \(paused by the usage limit/);
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), [], "no message, snooze, unsnooze or pin");
  assert.ok(f.state().queue.some((e) => e.threadId === f.id), "still queued");
  assert.match(ok(f.run(pacer, ["status"])).stdout, /Paused by the usage limit; not counted \(1\)[^\n]*\n  .* Task 77 limited: T3 resumes it after .* \(queued\)/);
  const wake = f.run(pacer, ["wake", "--thread", f.id]);
  assert.notEqual(wake.status, 0);
  assert.match(wake.stderr, /paused by the usage limit; T3 resumes it after/);
  ok(f.run(pacer, ["remove", "--thread", f.id]));
  assert.equal(f.sent("thread.unsnooze").length, 0, "remove leaves T3's limit snooze");
});

test("enqueue on a thread paused by the usage limit queues it but neither snoozes nor pins it", () => {
  const f = limitHome(iso(90), { state: { queue: [], woken: {}, asked: {} } });
  const out = ok(f.run(pacer, ["enqueue", "--thread", f.id, "--plan", "/tmp/p.md"])).stdout;
  assert.match(out, /not snoozed: paused by the usage limit/);
  assert.deepEqual(f.sent().map((c) => c.type), ["thread.auto-settle.set"]);
});

test("past the reset, until T3's resume supersedes the limited run, the thread stays T3's: no snooze, even with the queue held", () => {
  const f = limitHome(iso(-5));
  ok(f.run(pacer, ["hold"]));
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), [], "no snooze, wake or pin");
  ok(f.run(pacer, ["go"]));
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), [], "not woken either");
});

test("10 min past the reset with no resume from T3, the pacer sends T3's resume text once", () => {
  const f = limitHome(iso(-15));
  const limited = fs.readFileSync(path.join(f.home, "t3.json"), "utf8");
  ok(f.run(pacer, ["tick"]));
  // Still limited on the next tick: the thread state goes back, the sent log stays.
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify({ ...JSON.parse(limited), commands: f.db().commands }));
  const sent = f.sent("message.dispatch");
  assert.deepEqual(sent.map((c) => [c.threadId, c.text, c.createdBy]), [[f.id, "Continue where you left off.", "agent"]]);
  assert.ok(f.state().resumed[f.id], "recorded");
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "Continue where you left off.").length, 1, "not resumed again on the next tick");
});

test("once T3's resume run supersedes the limited run the pacer treats it as a normal queued thread again", () => {
  const f = limitHome(iso(-5));
  const db = f.db();
  db.runs.push({ run_id: `run:${f.id}:2`, thread_id: f.id, ordinal: 2, status: "completed", requested_at: ago(2), completed_at: ago(1) });
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent("message.dispatch").map((c) => c.threadId), [f.id], "woken");
});

test("delegated-task children are workers: refused by enqueue/ready, never counted, queued or woken", () => {
  const child = "thread:delegated-task:command%3Aabc123";
  const sub = randomUUID();
  const f = fakeHome({ threads: [{ thread_id: child, title: "Review stage 2", turn_state: "running", created_by: "agent" },
    { thread_id: sub, title: "Explore the bug", turn_state: "running", lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: "p" } }] });
  for (const verb of ["enqueue", "ready"]) {
    const r = f.run(pacer, [verb, "--thread", child, "--plan", "/tmp/p.md"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing a delegated worker thread/);
  }
  const r = f.run(pacer, ["ready", "--thread", sub, "--plan", "/tmp/p.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing a delegated worker thread/);
  const dry = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
  assert.deepEqual(JSON.parse(dry.slice(dry.indexOf("{"))).active, []);
  assert.equal(f.sent().length, 0);
});

test("an agent's message (createdBy agent) or T3's limit resume isn't the user writing: the woken record stays", () => {
  const id = randomUUID();
  const f = fakeHome({ threads: [{ thread_id: id, title: "Task 98", turn_state: "running" }],
    messages: [{ thread_id: id, message_id: randomUUID(), role: "user", text: "Review done: APPROVE", created_at: ago(20), created_by: "agent" },
      { thread_id: id, message_id: randomUUID(), role: "user", text: "Continue where you left off.", created_at: ago(15), created_by: "user" }],
    state: { queue: [], woken: { [id]: { plan: "/tmp/p.md", title: "Task 98", priority: "med", wokenAt: ago(60), pauses: 0 } }, asked: {} } });
  ok(f.run(pacer, ["tick"]));
  assert.ok(f.state().woken[id], "not handed off");
  const g = fakeHome({ threads: [{ thread_id: id, title: "Task 98", turn_state: "running" }],
    messages: [{ thread_id: id, message_id: randomUUID(), role: "user", text: "looks good", created_at: ago(15), created_by: "user" }],
    state: { queue: [], woken: { [id]: { plan: "/tmp/p.md", title: "Task 98", priority: "med", wokenAt: ago(60), pauses: 0 } }, asked: {} } });
  ok(g.run(pacer, ["tick"]));
  assert.equal(g.state().woken[id], undefined, "the user's own message hands it off");
});

// The timer runs `report --post --morning` every 15 min; it posts once per local day, at/after
// reportAt (07:00) in config.json "timeZone". A zone where it's now 12:xx makes the test independent of the real clock.
test("report --morning: posts once per local day (report.json), keyed by config timeZone", () => {
  const f = sleepHome({ raw: tonight() });
  const noonZone = (hour) => { const off = (hour - new Date().getUTCHours() + 36) % 24 - 12; return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`; };
  const day = (zone) => new Date().toLocaleDateString("en-CA", { timeZone: zone });
  setConfig(f, { timeZone: noonZone(12) });
  ok(f.run(pacer, ["report", "--post", "--morning"]));
  assert.match(f.posted(), /^\*\*Pacer report\*\* since .* \(times in Etc\/GMT/);
  const sent = JSON.parse(fs.readFileSync(path.join(f.stateDir, "report.json"), "utf8"));
  assert.equal(sent.day, day(noonZone(12)));
  fs.rmSync(path.join(f.home, "posted.md"));
  ok(f.run(pacer, ["report", "--post", "--morning"]));
  assert.equal(f.posted(), null, "same day: not again");
  // Before 07:00 local time: nothing (and report.json from another day doesn't matter).
  fs.writeFileSync(path.join(f.stateDir, "report.json"), JSON.stringify({ day: "2000-01-01" }));
  setConfig(f, { timeZone: noonZone(3) });
  ok(f.run(pacer, ["report", "--post", "--morning"]));
  assert.equal(f.posted(), null, "03:xx local time");
});

// The Queue view reads `list --json` and raises with `priority`.
const planFile = (f, n, text = "") => { const p = path.join(f.home, "planning", `${n}-x`, "plan.md"); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

test("list --json: header, woken row with its Resume step, up_next in the exact `list` order with lifts and waits", () => {
  const [a, b, c, w] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const f = fakeHome({ threads: [queuedThread(a, "Task 301 low"), queuedThread(b, "Task 302 high"), queuedThread(c, "Task 303 med"), { thread_id: w, title: "Task 304 woken", turn_state: "running", turn_completed_at: ago(5) }] });
  const plans = { a: planFile(f, 301), b: planFile(f, 302, "Waits for plan 301."), c: planFile(f, 303), w: planFile(f, 304, "# Plan\n## Resume\n**Stages:** S1 done, S2 building\n") };
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ asked: {},
    queue: [entry(a, "Task 301 low", { plan: plans.a, priority: "low" }), entry(b, "Task 302 high", { plan: plans.b, priority: "high", size: "m" }), entry(c, "Task 303 med", { plan: plans.c, size: "s", pauses: 1 })],
    woken: { [w]: { plan: plans.w, title: "Task 304 woken", priority: "med", firstQueuedAt: ago(90), wokenAt: ago(20), pauses: 0 } } }));
  const out = JSON.parse(ok(f.run(pacer, ["list", "--json"])).stdout);
  assert.deepEqual(Object.keys(out.header).filter((k) => ["mode", "used", "pace", "blind", "held", "sleep", "queued", "resets_at"].includes(k)).sort(), ["blind", "held", "mode", "pace", "queued", "resets_at", "sleep", "used"]);
  assert.equal(out.header.used, 50);
  assert.equal(out.header.queued, 3);
  assert.equal(out.header.blind, false);
  assert.ok(["day", "night"].includes(out.header.mode));
  const textOrder = [...ok(f.run(pacer, ["list"])).stdout.matchAll(/^\s+\d+\. \[[^\]]*\] (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(out.up_next.map((r) => r.thread_id), textOrder, "same order as the text list");
  assert.deepEqual(out.up_next.map((r) => r.order), [1, 2, 3]);
  const row = (id) => out.up_next.find((r) => r.thread_id === id);
  assert.equal(row(a).priority, "low");
  assert.equal(row(a).effective_priority, "high", "lifted by plan 302 waiting on it");
  assert.match(row(b).waits_on, /waits for plan 301/);
  assert.equal(row(c).pauses, 1);
  assert.equal(row(c).size, "s");
  for (const r of out.up_next) assert.ok(r.about === null || /^\d\d:\d\d$/.test(r.about), `about is HH:MM or null: ${r.about}`);
  assert.equal(row(b).about, null, "blocked: no rough start");
  const run = out.running.find((r) => r.thread_id === w);
  assert.equal(run.label, "woken");
  assert.equal(run.step, "S1 done, S2 building");
  assert.equal(run.plan, plans.w);
  assert.equal(f.sent().length, 0, "list --json sends nothing");
});

test("priority: changes only the priority, logs it, sends nothing; refuses woken, missing, bad level", () => {
  const [a, w] = [randomUUID(), randomUUID()];
  const f = fakeHome({ threads: [queuedThread(a, "Task 301"), queuedThread(w, "Task 304")] });
  const before = entry(a, "Task 301", { priority: "med", size: "m", note: "keep me", firstQueuedAt: ago(600), enqueuedAt: ago(100), pauses: 2 });
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ asked: {}, queue: [before], woken: { [w]: { plan: "/tmp/w.md", title: "Task 304", priority: "med", wokenAt: ago(5) } } }));
  assert.match(ok(f.run(pacer, ["priority", "--thread", a, "--level", "highest"])).stdout, /med → highest/);
  assert.deepEqual(f.state().queue, [{ ...before, priority: "highest" }], "only the priority changed");
  assert.equal(f.sent().length, 0, "no snooze, pin or message");
  const ev = logOf(f).filter((l) => l.event === "priority");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].threadId, a);
  assert.equal(ev[0].from, "med");
  assert.equal(ev[0].to, "highest");
  const bad = (args, re) => { const r = f.run(pacer, ["priority", ...args]); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, re); };
  bad(["--thread", w, "--level", "high"], /woken, not queued/);
  bad(["--thread", randomUUID(), "--level", "high"], /not in the queue/);
  bad(["--thread", a, "--level", "now"], /--level is highest, high, med, low/);
  bad(["--thread", "abc", "--level", "high"], /T3 thread UUID/);
  assert.equal(f.state().queue[0].priority, "highest", "refusals change nothing");
});

test("list --json: a queued thread with a recorded question for the user keeps its place but gets no rough start", () => {
  const [q, ok2] = [randomUUID(), randomUUID()];
  const f = fakeHome({ usedPercent: 10, resetsInMin: 240, threads: [queuedThread(q, "Task 301 asks"), queuedThread(ok2, "Task 302 clear")],
    messages: [{ thread_id: q, role: "assistant", text: "S1 committed; asked the user about S2.", created_at: ago(55) }, { thread_id: ok2, role: "assistant", text: "Which option do you prefer?", created_at: ago(55) }],
    state: { queue: [entry(q, "Task 301 asks", { priority: "high" }), entry(ok2, "Task 302 clear")], woken: {}, asked: {} } });
  asksFor(f, q);
  const out = JSON.parse(ok(f.run(pacer, ["list", "--json"])).stdout);
  assert.deepEqual(out.up_next.map((r) => r.thread_id), [q, ok2], "order unchanged: it still ranks first");
  assert.equal(out.up_next[0].about, null, "waiting on the user: the tick won't wake it");
  assert.equal(out.up_next[0].about_at, null);
  assert.match(out.up_next[1].about ?? "", /^\d\d:\d\d$/, "the next row takes the first slot");
  const dryOut = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
  const dry = JSON.parse(dryOut.slice(dryOut.indexOf("{")));
  assert.notEqual(dry.next, q, "consistent with the tick");
});

test("list --json: running since = the live run's start, not a newer canceled request that never started", () => {
  const id = randomUUID();
  const start = ago(50), canceled = ago(1);
  const f = baseHome({ threads: [{ thread_id: id, title: "Task 301" }], // baseHome: the wrapper would rebuild runs from turn_state
    runs: [{ run_id: "live", thread_id: id, ordinal: 1, status: "running", requested_at: start, started_at: start },
      { run_id: "steer-folded", thread_id: id, ordinal: 2, status: "cancelled", requested_at: canceled, started_at: null, completed_at: canceled }],
    state: { queue: [], woken: {}, asked: {}, ready: { [id]: { plan: "/tmp/301-x/plan.md", readyAt: start } } } });
  const row = JSON.parse(ok(f.run(pacer, ["list", "--json"])).stdout).running.find((r) => r.thread_id === id);
  assert.equal(row?.label, "your thread");
  assert.equal(row.since, start);
});

// a small plan (ranks highest) lifts the plan it waits on to highest, so the
// prerequisite goes before an unrelated high/l, in `list` and in the tick's wake.
test("small plan waiting on a prerequisite: the prerequisite is lifted to highest and woken first", () => {
  const [small, pre, big] = [randomUUID(), randomUUID(), randomUUID()];
  const f = fakeHome({ threads: [queuedThread(small, "Task 311 small"), queuedThread(pre, "Task 312 prerequisite"), queuedThread(big, "Task 313 large high")] });
  const plans = { small: planFile(f, 311, "Wait for: plan 312"), pre: planFile(f, 312), big: planFile(f, 313) };
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ asked: {}, woken: {},
    queue: [entry(small, "Task 311 small", { plan: plans.small, priority: "med", size: "s" }), entry(pre, "Task 312 prerequisite", { plan: plans.pre, priority: "low", size: "m" }),
      entry(big, "Task 313 large high", { plan: plans.big, priority: "high", size: "l" })] }));
  const out = JSON.parse(ok(f.run(pacer, ["list", "--json"])).stdout);
  assert.deepEqual(out.up_next.map((r) => r.thread_id), [pre, small, big]);
  const row = (id) => out.up_next.find((r) => r.thread_id === id);
  assert.deepEqual([row(pre).priority, row(pre).effective_priority], ["low", "highest"]);
  assert.deepEqual([row(small).priority, row(small).effective_priority], ["med", "highest"]);
  const dry = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
  const sum = JSON.parse(dry.slice(dry.indexOf("{")));
  assert.equal(sum.threadId, pre, "the tick wakes the prerequisite");
  // the tick's picture and the morning report show the lifted rank, as `list` does.
  assert.equal(sum.next, `${pre.slice(0, 8)} ${row(pre).score}`);
  const report = ok(f.run(pacer, ["report"])).stdout;
  assert.match(report, /- \[highest, m\] Task 312 prerequisite: score \S+ = highest /);
  assert.match(report, /- \[highest, s\] Task 311 small: score \S+ = highest \S+ \(small, was med\)/);
  // The enqueue line too: re-queueing the prerequisite prints its lifted rank.
  const again = ok(f.run(pacer, ["enqueue", "--thread", pre, "--plan", plans.pre, "--priority", "low", "--size", "m"])).stdout;
  assert.match(again, /: score \S+ = highest \S+ × age/);
});

// --- Lead hand-off: a lead at 3+ compactions moves to a fresh thread.
const compactions = (id, n) => Array.from({ length: n }, () => ({ thread_id: id, type: "compaction" }));
function leadHome({ items = [], ...opts }) {
  const f = fakeHome(opts);
  const file = path.join(f.home, "t3.json");
  const db = f.db();
  db.items = [...(db.items ?? []), ...items];
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const edit = (fn) => { const d = f.db(); fn(d); fs.writeFileSync(file, JSON.stringify(d, null, 2)); };
  return { ...f, edit, log: () => logOf(f) };
}
const childOf = (parent, status = "running") => ({ thread_id: `thread:delegated-task:command%3Amcp%3A${parent}%3Adelegate-task%3Areview-r1`, title: "Review: stage 2", created_by: "agent",
  turn_state: status, turn_completed_at: status === "running" ? null : ago(1), lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent } });
// An awake lead whose turn ended 5 min ago (pacer-woken an hour ago).
const awakeLead = (id, title) => ({ thread_id: id, title, turn_state: "completed", turn_completed_at: ago(5), pinned_at: ago(600) });
const wokenRec = (id, title) => ({ plan: `/tmp/${id}.md`, title, priority: "high", firstQueuedAt: ago(600), wokenAt: ago(60), pauses: 1 });

test("handoff at wake: a queued lead at 3 compactions gets a fresh pinned thread (same title, model) instead of a wake; entries move, old unpinned + settled", () => {
  const id = randomUUID();
  const title = "Pacer hands long leads to a fresh thread";
  const sonnet = JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] });
  const f = leadHome({ threads: [{ ...queuedThread(id, title), pinned_at: ago(600), model_selection_json: sonnet }], items: compactions(id, 3),
    state: { queue: [entry(id, title, { priority: "high", pauses: 2 })], woken: {}, asked: {} } });
  const out = ok(f.run(pacer, ["tick"])).stdout;
  assert.match(out, /handed off .* instead of waking it/);
  const [created] = f.sent("thread.create");
  assert.ok(created, "one new thread");
  assert.equal(created.title, title);
  assert.deepEqual(created.modelSelection, JSON.parse(sonnet), "same model and effort");
  const to = created.threadId;
  assert.deepEqual(f.sent("thread.pin").map((c) => c.threadId), [to]);
  const dispatched = f.sent("message.dispatch");
  assert.deepEqual(dispatched.map((c) => c.threadId), [to], "the old thread gets no wake");
  assert.match(dispatched[0].text, new RegExp(`^Pacer: you take over from thread ${id}, which reached 3 compactions`));
  assert.ok(dispatched[0].text.includes(`/tmp/${id}.md § Resume`), "brief names the plan's Resume");
  assert.deepEqual(f.sent("thread.unpin").map((c) => c.threadId), [id]);
  assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [id]);
  const s = f.state();
  assert.deepEqual(s.queue, []);
  assert.equal(s.woken[id], undefined);
  assert.equal(s.ready[id], undefined);
  assert.equal(s.woken[to].plan, `/tmp/${id}.md`);
  assert.equal(s.woken[to].priority, "high");
  assert.equal(s.woken[to].pauses, 2);
  assert.equal(s.ready[to].plan, `/tmp/${id}.md`);
  assert.deepEqual([s.handoffs[id].to, s.handoffs[id].done, s.handoffs[id].settled], [to, true, true]);
  const lines = f.log();
  const h = lines.find((l) => l.event === "lead-handoff");
  assert.deepEqual([h.threadId, h.to, h.compactions, h.cause, h.settled], [id, to, 3, "wake", true]);
  assert.equal(lines.find((l) => l.event === "wake").threadId, to);
  // The next tick: the new thread (no compactions) is just woken; nothing else is made.
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1);
});

test("handoff at wake: below 3 compactions it is a plain wake", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [queuedThread(id, "Task 99 work")], items: compactions(id, 2), state: { queue: [entry(id, "Task 99 work")], woken: {}, asked: {} } });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("message.dispatch").map((c) => c.threadId), [id]);
  assert.match(f.sent("message.dispatch")[0].text, /^Pacer: your turn/);
});

test("handoff waits while the lead has a running delegate_task child: not woken, not handed off, status says why; once the child ends it goes", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [queuedThread(id, "Task 99 work"), childOf(id)], items: compactions(id, 4), state: { queue: [entry(id, "Task 99 work")], woken: {}, asked: {} } });
  const out = ok(f.run(pacer, ["tick"])).stdout;
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.match(out, /1 due a hand-off, waiting for a delegate_task child/);
  const st = ok(f.run(pacer, ["status"])).stdout;
  assert.match(st, /Lead hand-offs at 3\+ compactions \(1\):\n.*4 compactions, queued; due a hand-off, waits for 1 running delegate_task child \(.*review-r1\), not woken meanwhile/);
  // A child of another thread doesn't hold it.
  f.edit((d) => { d.runs.find((r) => r.thread_id.startsWith("thread:delegated-task")).status = "completed"; });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1);
});

test("handoff: the user's own thread at 15 compactions (no plan entry) is never touched; the command refuses it", () => {
  const own = randomUUID();
  const f = leadHome({ threads: [awakeLead(own, "My own work")], items: compactions(own, 15), state: { queue: [], woken: {}, asked: {} } });
  ok(f.run(pacer, ["tick"]));
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent().length, 0);
  const r = f.run(pacer, ["handoff", "--thread", own, "--plan", "/tmp/x.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a lead: this thread has no pacer plan entry/);
  assert.equal(f.sent().length, 0);
  assert.doesNotMatch(ok(f.run(pacer, ["status"])).stdout, /My own work: \d+ compactions/);
});

test("handoff command twice (and a tick after it) makes one new thread; the fresh thread can't hand off again", () => {
  const id = randomUUID();
  const title = "Task 99 lead";
  const f = leadHome({ threads: [awakeLead(id, title)], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, title) }, asked: {} } });
  const first = ok(f.run(pacer, ["handoff", "--thread", id, "--plan", `/tmp/${id}.md`])).stdout;
  assert.match(first, /handed off .* old thread unpinned and settled\. The new thread .* runs the plan now; stop here\./);
  const second = ok(f.run(pacer, ["handoff", "--thread", id, "--plan", `/tmp/${id}.md`])).stdout;
  assert.match(second, /already handed off: .* nothing new started/);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length, 1);
  const to = f.sent("thread.create")[0].threadId;
  assert.equal(f.log().filter((l) => l.event === "lead-handoff").length, 1);
  const s = f.state();
  assert.equal(s.woken[to].plan, `/tmp/${id}.md`);
  assert.equal(s.woken[id], undefined);
  const again = f.run(pacer, ["handoff", "--thread", to]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already is the fresh one/);
  assert.equal(f.sent("thread.create").length, 1);
});

// The same as f.run, but async: both children run at once (fake-home.mjs's env, rebuilt here).
const runAsync = (f, args) => new Promise((resolve) => {
  const env = { ...process.env, HOME: f.home, FAKE_T3: path.join(f.home, "t3.json"), PACER_STATE_DIR: f.stateDir };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "PROJECT_ROOT", "TITLE", "JOB", "ATTACH", "CONTINUE"]) delete env[k];
  const p = spawn(process.execPath, ["--import", fakeT3, pacer, ...args], { env, timeout: 60000 });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; });
  p.stderr.on("data", (d) => { stderr += d; });
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("tick and the lead's own handoff at the same moment (two processes, 5 fresh homes): one new thread, entries on it, old settled once", async () => {
  await Promise.all(Array.from({ length: 5 }, async (_, i) => {
    const id = randomUUID();
    const title = `Task 99 lead ${i}`;
    const f = leadHome({ threads: [{ ...queuedThread(id, title), pinned_at: ago(600) }], items: compactions(id, 3),
      state: { queue: [entry(id, title, { priority: "high" })], woken: {}, asked: {} } });
    // Alternate which child starts first so either can win the lock.
    const handoffArgs = ["handoff", "--thread", id, "--plan", `/tmp/${id}.md`];
    let tickP, cmdP;
    if (i % 2) { cmdP = runAsync(f, handoffArgs); tickP = runAsync(f, ["tick"]); }
    else { tickP = runAsync(f, ["tick"]); cmdP = runAsync(f, handoffArgs); }
    const [tick, cmd] = await Promise.all([tickP, cmdP]);
    ok(tick); ok(cmd);
    const creates = f.sent("thread.create");
    assert.equal(creates.length, 1, `home ${i}: one new thread`);
    const to = creates[0].threadId;
    const lines = f.log();
    const h = lines.filter((l) => l.event === "lead-handoff");
    assert.equal(h.length, 1, `home ${i}: one lead-handoff line`);
    assert.deepEqual([h[0].threadId, h[0].to], [id, to]);
    assert.equal(lines.filter((l) => l.event === "lock-stale").length, 0);
    // The loser starts nothing: the command says so, or the tick has no lead left to hand off.
    if (h[0].cause === "wake") assert.match(cmd.stdout, /already handed off: .* nothing new started/);
    else assert.doesNotMatch(tick.stdout, /instead of waking it/);
    assert.deepEqual(f.sent("thread.settle").map((c) => c.threadId), [id], `home ${i}: old settled once`);
    assert.ok(f.db().threads.find((t) => t.thread_id === id).settled_at);
    const s = f.state();
    assert.deepEqual(s.queue, []);
    assert.deepEqual(Object.keys(s.woken), [to]);
    assert.deepEqual(Object.keys(s.ready), [to]);
    assert.equal(s.woken[to].plan, `/tmp/${id}.md`);
    assert.deepEqual([s.handoffs[id].to, s.handoffs[id].done, s.handoffs[id].settled], [to, true, true]);
    assert.ok(f.sent("message.dispatch").every((c) => c.threadId === to), "the old thread gets no wake or ask");
  }));
});

test("handoff command: a ready-only lead stays ready-only on the new id; a queued one becomes woken; with a running child it refuses", () => {
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const f = leadHome({ threads: [awakeLead(a, "Ready lead"), awakeLead(b, "Queued lead"), awakeLead(c, "Busy lead"), childOf(c)], items: [...compactions(a, 3), ...compactions(b, 3)],
    state: { queue: [entry(b, "Queued lead")], woken: {}, asked: {}, ready: { [a]: { plan: "/tmp/a.md", title: "Ready lead", readyAt: ago(100) }, [c]: { plan: "/tmp/c.md", title: "Busy lead", readyAt: ago(100) } } } });
  ok(f.run(pacer, ["handoff", "--thread", a]));
  ok(f.run(pacer, ["handoff", "--thread", b]));
  const [ta, tb] = f.sent("thread.create").map((x) => x.threadId);
  const s = f.state();
  assert.deepEqual([s.ready[ta].plan, s.ready[ta].readyAt, s.woken[ta]], ["/tmp/a.md", s.ready[ta].readyAt, undefined]);
  assert.equal(s.ready[a], undefined);
  assert.deepEqual([s.queue.length, s.woken[tb]?.plan], [0, `/tmp/${b}.md`]);
  const r = f.run(pacer, ["handoff", "--thread", c]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not yet: 1 delegate_task child still running/);
  assert.equal(f.sent("thread.create").length, 2);
});

test("handoff command from inside the lead's running turn: the old thread settles on the first tick after its turn ends", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [{ ...awakeLead(id, "Task 99 lead"), turn_state: "running", turn_completed_at: null }], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  assert.match(ok(f.run(pacer, ["handoff", "--thread", id])).stdout, /old thread unpinned; settles once its turn ends/);
  assert.equal(f.db().threads.find((t) => t.thread_id === id).settled_at ?? null, null);
  assert.match(ok(f.run(pacer, ["status"])).stdout, /the old thread settles once its turn ends/);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.db().threads.find((t) => t.thread_id === id).settled_at ?? null, null, "still running: not yet");
  f.edit((d) => { const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = new Date().toISOString(); });
  ok(f.run(pacer, ["tick"]));
  assert.ok(f.db().threads.find((t) => t.thread_id === id).settled_at, "settled");
  assert.equal(f.state().handoffs[id].settled, true);
  assert.equal(f.log().filter((l) => l.event === "lead-handoff-settled").length, 1);
  assert.equal(f.sent("thread.create").length, 1);
});

test("hand off now: an awake lead at 3 compactions gets one turn per compaction level, not per tick", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [awakeLead(id, "Task 99 lead")], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["tick"]));
  const asks = () => f.sent("message.dispatch").filter((c) => c.threadId === id && c.text.startsWith("Pacer: hand off now"));
  assert.equal(asks().length, 1);
  assert.ok(asks()[0].text.includes(`pacer.mjs handoff --plan '/tmp/${id}.md'`), "plan path quoted");
  assert.equal(asks()[0].createdBy, "agent");
  // The fake's run ends at once; make it "ended 5 min ago" again and tick twice more: no second ask.
  const settleBack = () => f.edit((d) => { for (const r of d.runs.filter((x) => x.thread_id === id)) r.completed_at = ago(5); });
  settleBack(); ok(f.run(pacer, ["tick"]));
  settleBack(); ok(f.run(pacer, ["tick"]));
  assert.equal(asks().length, 1);
  assert.match(ok(f.run(pacer, ["status"])).stdout, /3 compactions, awake; told to hand off at 3 compactions; told again at 4/);
  f.edit((d) => d.items.push({ thread_id: id, type: "compaction" }));
  settleBack(); ok(f.run(pacer, ["tick"]));
  assert.equal(asks().length, 2);
  assert.match(asks()[1].text, /^Pacer: hand off now \(4 compactions\)/);
  assert.equal(f.log().filter((l) => l.event === "handoff-ask").length, 2);
  assert.equal(f.sent("thread.create").length, 0, "the lead runs handoff itself");
});

test("hand off now waits for a running child, a running turn and the user's recent message; status says which", () => {
  const busy = randomUUID(), turnOn = randomUUID(), own = randomUUID();
  const f = leadHome({ threads: [awakeLead(busy, "Busy lead"), childOf(busy), { ...awakeLead(turnOn, "Running lead"), turn_state: "running", turn_completed_at: null }, awakeLead(own, "Own lead")],
    messages: [{ thread_id: own, role: "user", text: "how is it going?", created_at: ago(3), created_by: "user" }],
    items: [...compactions(busy, 3), ...compactions(turnOn, 3), ...compactions(own, 3)],
    state: { queue: [], asked: {}, woken: { [busy]: wokenRec(busy, "Busy lead"), [turnOn]: wokenRec(turnOn, "Running lead") }, ready: { [own]: { plan: "/tmp/own.md", title: "Own lead", readyAt: ago(100) } } } });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("message.dispatch").filter((c) => c.text.startsWith("Pacer: hand off now")).length, 0);
  const st = ok(f.run(pacer, ["status"])).stdout;
  assert.match(st, /Busy lead: 3 compactions, awake; waits for 1 running delegate_task child/);
  assert.match(st, /Running lead: 3 compactions, awake; told to hand off once its turn ends/);
  assert.match(st, /Own lead: 3 compactions, awake; the user wrote 3 min ago/);
});

test("hold: no hand-off at wake and no hand-off-now turn while the queue is on hold", () => {
  const q1 = randomUUID(), awake = randomUUID();
  const f = leadHome({ threads: [queuedThread(q1, "Queued lead"), awakeLead(awake, "Awake lead")], items: [...compactions(q1, 3), ...compactions(awake, 3)],
    state: { queue: [entry(q1, "Queued lead")], woken: { [awake]: wokenRec(awake, "Awake lead") }, asked: {}, held: { since: ago(5) } } });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent().length, 0);
  assert.match(ok(f.run(pacer, ["status"])).stdout, /Awake lead: 3 compactions, awake; queue on hold since/);
  ok(f.run(pacer, ["go"]));
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.create").length + f.sent("message.dispatch").filter((c) => c.text.startsWith("Pacer: hand off now")).length > 0, true, "after go it moves");
});

test("handoff: a crash after the record but before the thread exists is finished by the next tick with the same ids", () => {
  const id = randomUUID();
  const to = randomUUID(), messageId = randomUUID();
  const rec = { to, messageId, plan: `/tmp/${id}.md`, title: "Task 99 lead", text: "Pacer: you take over from thread x", compactions: 3, cause: "command", at: ago(2), done: false, settled: false };
  const f = leadHome({ threads: [awakeLead(id, "Task 99 lead")], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {}, handoffs: { [id]: rec } } });
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent("thread.create").map((c) => c.threadId), [to]);
  assert.deepEqual(f.sent("message.dispatch").filter((c) => c.threadId === to).map((c) => c.messageId), [messageId]);
  assert.equal(f.state().woken[to].plan, `/tmp/${id}.md`);
  assert.equal(f.state().handoffs[id].done, true);
  ok(f.run(pacer, ["handoff", "--thread", id]));
  assert.equal(f.sent("thread.create").length, 1);
});

test("handoff keeps the lead's worktree: the new thread.create carries the old branch and worktreePath (wake, and crash recovery with the old thread gone)", () => {
  const id = randomUUID(), gone = randomUUID();
  const wt = { branch: "t3code/plan-99", worktree_path: "/work/.t3/worktrees/app/t3code-plan99" };
  const sel = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
  const rec = { to: randomUUID(), messageId: randomUUID(), plan: `/tmp/${gone}.md`, title: "Gone lead", text: "Pacer: you take over from thread x", compactions: 3, cause: "wake", at: ago(2),
    done: false, settled: false, projectId: "proj-9", modelSelection: sel, branch: "t3code/gone", worktreePath: "/wt/gone" };
  const f = leadHome({ threads: [{ ...queuedThread(id, "Worktree lead"), ...wt }], items: compactions(id, 3),
    state: { queue: [entry(id, "Worktree lead")], woken: {}, asked: {}, handoffs: { [gone]: rec } } });
  ok(f.run(pacer, ["tick"]));
  const creates = f.sent("thread.create");
  const mine = creates.find((c) => c.title === "Worktree lead");
  assert.deepEqual([mine.branch, mine.worktreePath], [wt.branch, wt.worktree_path]);
  const t = f.db().threads.find((x) => x.thread_id === mine.threadId);
  assert.deepEqual([t.branch, t.worktree_path], [wt.branch, wt.worktree_path], "the fake bound the new thread to the same worktree");
  assert.equal(f.state().handoffs[id].worktreePath, wt.worktree_path, "kept in the record");
  // The old thread of the half-done record no longer exists: project, model and workspace come from the record.
  const rescued = creates.find((c) => c.threadId === rec.to);
  assert.deepEqual([rescued.projectId, rescued.modelSelection, rescued.branch, rescued.worktreePath], ["proj-9", sel, "t3code/gone", "/wt/gone"]);
  assert.equal(creates.length, 2);
});

test("hold: the lead's own `handoff` still runs: one new thread, entries moved, the hold stays", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [awakeLead(id, "Held lead")], items: compactions(id, 3),
    state: { queue: [], woken: { [id]: wokenRec(id, "Held lead") }, asked: {}, held: { since: ago(5), note: "my hold" } } });
  assert.match(ok(f.run(pacer, ["handoff", "--thread", id])).stdout, /handed off .* runs the plan now; stop here\./);
  ok(f.run(pacer, ["handoff", "--thread", id]));
  ok(f.run(pacer, ["tick"]));
  const creates = f.sent("thread.create");
  assert.equal(creates.length, 1);
  const to = creates[0].threadId;
  const s = f.state();
  assert.deepEqual([s.woken[id], s.woken[to]?.plan, s.ready[to]?.plan], [undefined, `/tmp/${id}.md`, `/tmp/${id}.md`]);
  assert.deepEqual(s.held, { since: s.held.since, note: "my hold" }, "hold still set");
  assert.match(ok(f.run(pacer, ["status"])).stdout, /ON HOLD/);
});

// ---- working count, reset take + resume, tick log -------------------------------

// Main (not queued) threads whose last run failed on the usage limit, each with its reset time.
function mainLimitHome(resets, more = {}) {
  const ids = resets.map(() => randomUUID());
  const f = fakeHome({ ...more, threads: [...resets.map((r, i) => ({ thread_id: ids[i], title: `Task ${80 + i} limited`, turn_state: "failed", turn_completed_at: ago(30), snoozed_until: r.snoozed ?? r.at })), ...(more.threads ?? [])] });
  const db = f.db();
  db.items = resets.map((r, i) => ({ thread_id: ids[i], run_id: `run:${ids[i]}:1`, type: "error", status: "failed", updated_at: ago(30), payload: { failure: { class: "usage_limit", message: "Claude usage limit reached", resetAt: r.at } } }));
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  return { ...f, ids };
}
const tickLines = (f) => logOf(f).filter((l) => l.event === "tick");
// Night by the sleep file (bedtime set; coding night for 10 h), whatever the clock says.
// fakeHome pins day otherwise, so each reset test runs both ways (chk_68ecfa008cae4cf9: at night
// a thread still at the limit held its own due resume).
function atNight(f, night) {
  if (!night) return f;
  const p = path.join(f.stateDir, "config.json");
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), sleepFile: sleepFixture(f, tonight()) }));
  return f;
}
const modeIs = (f, night) => {
  const [t] = tickLines(f);
  assert.equal(t.mode, night ? "night" : "day");
  if (night) assert.ok(t.limitHit.length > 0, "a thread at the limit this window (the night block)");
};
const pending = (ids, resets) => Object.fromEntries(ids.map((id, i) => [id, { title: `Task ${80 + i} limited`, resetAt: resets[i].at, snoozedUntil: iso(25), takenAt: ago(60) }]));

test("reset: a main thread stopped by the limit is snoozed once to reset + 30 min, so T3 doesn't resume it at the reset", () => {
  const reset = iso(60);
  const f = mainLimitHome([{ at: reset }]);
  const [id] = f.ids;
  ok(f.run(pacer, ["tick"]));
  const until = new Date(Date.parse(reset) + 30 * 60000).toISOString();
  assert.deepEqual(f.sent("thread.snooze").map((c) => [c.threadId, c.snoozedUntil]), [[id, until]]);
  assert.equal(f.state().limitResumes[id].resetAt, reset);
  assert.ok(logOf(f).some((l) => l.event === "limit-take" && l.threadId === id && l.snoozedUntil === until));
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("thread.snooze").length, 1, "taken once");
  assert.equal(f.sent("message.dispatch").length, 0, "not resumed before the reset");
  assert.match(ok(f.run(pacer, ["status"])).stdout, /Task 80 limited: the pacer resumes it after /);
});

test("reset: a limited worker thread is left to T3", () => {
  const id = randomUUID();
  const f = fakeHome({ threads: [{ thread_id: id, title: "Review: stage 2", lineage: { parentThreadId: "lead-1", relationshipToParent: "subagent", rootThreadId: "lead-1" }, turn_state: "failed", turn_completed_at: ago(30), snoozed_until: iso(60) }] });
  const db = f.db();
  db.items = [{ thread_id: id, run_id: `run:${id}:1`, type: "error", status: "failed", updated_at: ago(30), payload: { failure: { class: "usage_limit", message: "Claude usage limit reached", resetAt: iso(60) } } }];
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent().map((c) => c.type), [], "no snooze or message");
  assert.equal(f.state().limitResumes?.[id], undefined);
});

for (const night of [false, true]) test(`reset: after it the pacer resumes taken threads ahead of the queue, one a tick, and the settle holds the next (${night ? "night" : "day"})`, () => {
  const resets = [{ at: iso(-20), snoozed: iso(10) }, { at: iso(-5), snoozed: iso(25) }];
  const busy = randomUUID(), queued = randomUUID();
  // Past the grace too (reset − 20 min): missedResumes must not send a second resume.
  const f = atNight(mainLimitHome(resets, { threads: [{ thread_id: busy, title: "Task 90 running", turn_state: "running" }, queuedThread(queued, "Task 91 queued")] }), night);
  const s = { queue: [entry(queued, "Task 91 queued")], woken: {}, asked: {} };
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ ...s, limitResumes: pending(f.ids, resets) }));
  ok(f.run(pacer, ["tick"]));
  modeIs(f, night);
  const resumes = () => f.sent("message.dispatch").filter((c) => c.text === "Continue where you left off.");
  assert.deepEqual(resumes().map((c) => c.threadId), [f.ids[0]], "the older reset first, once");
  assert.deepEqual(f.sent("thread.unsnooze").map((c) => c.threadId), [f.ids[0]]);
  const st = f.state();
  assert.equal(st.limitResumes[f.ids[0]], undefined);
  assert.ok(st.limitResumes[f.ids[1]]);
  assert.equal(st.resumed[f.ids[0]], resets[0].at);
  assert.ok(st.lastWakeAt);
  assert.ok(st.queue.some((e) => e.threadId === queued), "the queue waits behind the resume");
  const [t1] = tickLines(f);
  assert.equal(t1.action, "wake");
  assert.equal(t1.wakeSource, "resume");
  assert.ok(logOf(f).some((l) => l.event === "wake" && l.source === "resume" && l.threadId === f.ids[0]));
  ok(f.run(pacer, ["tick"]));
  assert.equal(resumes().length, 1, "the settle holds the second resume");
  assert.match(tickLines(f)[1].reason, /last wake was 0 min ago/);
});

test("reset: a pending resume is dropped once T3 resumed the thread itself", () => {
  const resets = [{ at: iso(-40), snoozed: iso(-10) }];
  const f = mainLimitHome(resets);
  const db = f.db();
  db.runs.push({ run_id: `run:${f.ids[0]}:2`, thread_id: f.ids[0], ordinal: 2, status: "running", requested_at: ago(2) });
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ queue: [], woken: {}, asked: {}, limitResumes: pending(f.ids, resets) }));
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.state().limitResumes, {});
  assert.ok(logOf(f).some((l) => l.event === "limit-resume-dropped" && l.why === "running again"));
  assert.equal(f.sent("message.dispatch").length, 0);
});

for (const night of [false, true]) test(`reset: a triage pass due on the reset tick starts first; the resume goes on the next tick (${night ? "night" : "day"})`, () => {
  const resets = [{ at: iso(-5), snoozed: iso(25) }];
  const f = atNight(mainLimitHome(resets, { config: { triage: { project: PROJECT, checkCommand: "echo 3" } } }), night);
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ queue: [], woken: {}, asked: {}, limitResumes: pending(f.ids, resets) }));
  ok(f.run(pacer, ["tick"]));
  modeIs(f, night);
  assert.equal(f.sent("thread.create").length, 1, "triage started");
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "Continue where you left off.").length, 0);
  assert.match(tickLines(f)[0].reason, /triage thread started this tick; the limit resume waits a tick/);
  ok(f.run(pacer, ["tick"]));
  assert.deepEqual(f.sent("message.dispatch").filter((c) => c.text === "Continue where you left off.").map((c) => c.threadId), [f.ids[0]]);
});

for (const night of [false, true]) test(`hold: a limit resume still goes; queued work doesn't (${night ? "night" : "day"})`, () => {
  const resets = [{ at: iso(-5), snoozed: iso(25) }];
  const queued = randomUUID();
  const f = atNight(mainLimitHome(resets, { threads: [queuedThread(queued, "Task 91 queued")] }), night);
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ queue: [entry(queued, "Task 91 queued")], woken: {}, asked: {}, held: { since: ago(5) }, limitResumes: pending(f.ids, resets) }));
  ok(f.run(pacer, ["tick"]));
  modeIs(f, night);
  assert.deepEqual(f.sent("message.dispatch").map((c) => c.threadId), [f.ids[0]]);
});

test("tick log: working count with each counted thread, and the wake source", () => {
  const parent = randomUUID(), haikuKid = randomUUID(), opusParent = randomUUID(), opusKid = randomUUID(), codex = randomUUID(), waiting = randomUUID(), queued = randomUUID();
  const haiku = JSON.stringify({ instanceId: JSON.parse(opus()).instanceId, model: "claude-haiku-5-5" });
  const f = fakeHome({ threads: [
    { thread_id: parent, title: "Task 1 lead", turn_state: "running" },
    { thread_id: haikuKid, title: "Explore", turn_state: "running", model_selection_json: haiku, lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent } },
    { thread_id: opusParent, title: "Task 2 lead", turn_state: "running" },
    { thread_id: opusKid, title: "Build S1", turn_state: "running", lineage: { parentThreadId: opusParent, relationshipToParent: "subagent", rootThreadId: opusParent } },
    { thread_id: codex, title: "Review", turn_state: "running", model_selection_json: JSON.stringify({ instanceId: "codex", model: "other-model" }) },
    { thread_id: waiting, title: "Task 3 asks", turn_state: "running" },
    queuedThread(queued, "Task 4 queued"),
  ], state: { queue: [entry(queued, "Task 4 queued")], woken: {}, asked: {} } });
  const db = f.db();
  db.items = [{ thread_id: waiting, run_id: `run:${waiting}:1`, type: "user_input_request", status: "waiting", updated_at: ago(3), payload: {} }];
  fs.writeFileSync(path.join(f.home, "t3.json"), JSON.stringify(db));
  ok(f.run(pacer, ["tick"]));
  const [t] = tickLines(f);
  assert.equal(t.working.count, 2);
  assert.equal(t.working.cap, 6);
  assert.deepEqual(t.working.threads.map((w) => [w.id, w.why]).sort(), [[opusKid.slice(0, 8), "worker turn running"], [parent.slice(0, 8), "turn running"]].sort());
  assert.equal(t.action, "wake");
  assert.equal(t.wakeSource, "queue");
  assert.ok(logOf(f).some((l) => l.event === "wake" && l.source === "queue"));
  assert.match(ok(f.run(pacer, ["status"])).stdout, /Working 2\/6 .*:\n  .* (Task 1 lead|Build S1): /);
  // Nothing working: the wake is a bootstrap.
  const g = fakeHome({ threads: [queuedThread(queued, "Task 4 queued")], state: { queue: [entry(queued, "Task 4 queued")], woken: {}, asked: {} } });
  ok(g.run(pacer, ["tick"]));
  assert.equal(tickLines(g)[0].wakeSource, "bootstrap");
  assert.deepEqual(tickLines(g)[0].working, { count: 0, cap: 6, threads: [] });
  assert.match(g.sent("message.dispatch")[0].text, /Before starting a Claude Opus worker, read `node ~\/.agents\/skills\/pacer\/scripts\/pacer.mjs status`/);
});

// ---- Limits and resumes, more cases --------------------------------------------------------

test("working: a delegate_task child with no thread model selection counts by its run's model", () => {
  const OPUS_RUN = { instanceId: "claudeAgent", model: "claude-opus-5-5" }, HAIKU_RUN = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
  const home = (parentState, kids) => {
    const lead = randomUUID();
    const ids = kids.map(() => `thread:delegated-task:command%3Amcp%3A${randomUUID()}%3Adelegate-task%3Ajob-${randomUUID().slice(0, 4)}`);
    const f = baseHome({ threads: [{ thread_id: lead, title: "Task 1 lead" }, ...ids.map((id, i) => ({ thread_id: id, title: `Child ${i}`, model_selection_json: null, lineage: { parentThreadId: lead, relationshipToParent: "subagent", rootThreadId: lead } }))],
      runs: [{ run_id: "lead-1", thread_id: lead, ordinal: 1, status: parentState, requested_at: ago(30), completed_at: parentState === "completed" ? ago(10) : null },
        ...ids.map((id, i) => ({ run_id: `kid-${i}`, thread_id: id, ordinal: 1, status: "running", requested_at: ago(5), model_selection: kids[i] }))] });
    const dry = ok(f.run(pacer, ["tick", "--dry-run"])).stdout;
    return { lead, ids, w: JSON.parse(dry.slice(dry.indexOf("{"))).working };
  };
  const idle = home("completed", [OPUS_RUN]);
  assert.equal(idle.w.count, 1, "parent idle, child running: the child counts");
  assert.equal(idle.w.threads[0].why, "worker turn running");
  const both = home("running", [OPUS_RUN]);
  assert.deepEqual(both.w.threads.map((t) => t.title), ["Child 0"], "parent and child running: the child only");
  const haiku = home("running", [HAIKU_RUN]);
  assert.deepEqual(haiku.w.threads.map((t) => t.title), ["Task 1 lead"], "a Haiku child (by its run) neither counts nor takes the parent out");
});

test("reset: a pending resume for an older reset is dropped when a newer limit replaced it, and taken fresh for the new one", () => {
  const r1 = iso(-120), r2 = iso(60);
  const f = mainLimitHome([{ at: r2 }]);
  const [id] = f.ids;
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ queue: [], woken: {}, asked: {}, limitResumes: { [id]: { title: "Task 80 limited", resetAt: r1, snoozedUntil: iso(-90), takenAt: ago(200) } } }));
  ok(f.run(pacer, ["tick"]));
  assert.ok(logOf(f).some((l) => l.event === "limit-resume-dropped" && l.resetAt === r1 && /a newer limit replaced it/.test(l.why)));
  assert.equal(f.state().limitResumes[id].resetAt, r2, "taken for the new reset");
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.snoozedUntil), [new Date(Date.parse(r2) + 30 * 60000).toISOString()]);
  assert.equal(f.sent("message.dispatch").length, 0, "no resume before the new reset");
  assert.notEqual(tickLines(f)[0].wakeSource, "resume");
});

test("list --json: rough starts count working Opus threads, workers included", () => {
  const lead = randomUUID(), queued = randomUUID();
  const workers = [1, 2, 3, 4, 5, 6].map((n) => ({ thread_id: randomUUID(), title: `Stage ${n} build`, turn_state: "running" }));
  // 60 min into the window at 15%: under pace (≈ 20.7) but over pace − tol (≈ 11), so only room under the cap starts it now.
  const opts = (extra) => ({ usedPercent: 15, resetsInMin: 240, threads: [{ thread_id: lead, title: "Task 1 lead", turn_state: "running" }, queuedThread(queued, "Task 2 queued"), ...extra],
    state: { queue: [entry(queued, "Task 2 queued")], woken: {}, asked: {} } });
  const at = (f) => { const out = JSON.parse(ok(f.run(pacer, ["list", "--json"])).stdout); return { out, row: out.up_next.find((r) => r.thread_id === queued) }; };
  const alone = at(fakeHome(opts([])));
  assert.equal(alone.out.header.working, 1);
  assert.ok(Math.abs(Date.parse(alone.row.about_at) - Date.parse(alone.out.generated_at)) < 60000, "1 working: room now");
  const full = at(fakeHome(opts(workers)));
  assert.equal(full.out.header.working, 7);
  assert.equal(full.out.header.working_cap, 6);
  assert.ok(full.row.about_at === null || Date.parse(full.row.about_at) > Date.parse(full.out.generated_at) + 60000, "7 working: not now");
});

// --- Pause-path hand-off: a lead at 3+ compactions that pauses is handed off
// there; it was woken natively by its children's reports and never reached the wake path.
const pausing = (id, title) => ({ ...awakeLead(id, title), turn_state: "running", turn_completed_at: null });
const failCreate = path.join(path.dirname(fakeT3), "..", "..", "..", "pacer", "scripts", ".fail-create-preload.mjs");
// T3 refuses thread.create (the fake with an extra preload); `fn` runs the pacer through it.
function withFailingCreate(fn) {
  fs.writeFileSync(failCreate, `const W = globalThis.WebSocket;
globalThis.WebSocket = class extends W { send(raw) { const r = JSON.parse(raw);
  if (r.payload?.type === "thread.create") return setImmediate(() => this.onmessage?.({ data: JSON.stringify({ requestId: r.id, _tag: "Exit", exit: { _tag: "Failure", cause: ["fake T3: create refused"] } }) }));
  return super.send(raw); } };\n`);
  try {
    return fn((f, args) => {
      const env = { ...process.env, HOME: f.home, FAKE_T3: path.join(f.home, "t3.json"), PACER_STATE_DIR: f.stateDir };
      for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"]) delete env[k];
      return spawnSync(process.execPath, ["--import", fakeT3, "--import", failCreate, pacer, ...args], { env, encoding: "utf8", timeout: 60000 });
    });
  } finally { fs.rmSync(failCreate, { force: true }); }
}
// The delegate_task child finishes and T3 runs its report as a new turn on the lead.
function reportTurn(f, id) {
  f.edit((d) => {
    const at = new Date().toISOString();
    for (const r of d.runs) if (r.status === "running") { r.status = "completed"; r.completed_at = at; }
    const ordinal = d.runs.filter((r) => r.thread_id === id).length + 1;
    d.runs.push({ run_id: `run:${id}:${ordinal}`, thread_id: id, ordinal, status: "completed", requested_at: at, completed_at: at });
  });
}
// What the pause's detached helper does once the pausing turn ends (run here on the fake).
const snoozeLater = (f, id, run = (args) => f.run(pacer, args)) =>
  ok(run(["snooze-later", "--thread", id, "--since", "", "--enqueued", f.state().queue.find((q) => q.threadId === id).enqueuedAt, "--after-turn"]));

test("pause at 3 compactions, no child: handed off there; the new thread takes the queue entry (until, priority) snoozed; the old gets no /compact", () => {
  const id = randomUUID();
  const title = "Task 99 lead";
  const f = leadHome({ threads: [pausing(id, title)], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, title) }, asked: {} } });
  const out = ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m", "--priority", "high"])).stdout;
  assert.match(out, /handed off .* the new thread is queued in its place \(snoozed, auto-settle off\).*This thread gets no \/compact; stop here\./);
  const [created] = f.sent("thread.create");
  assert.ok(created, "one new thread");
  const to = created.threadId;
  assert.equal(created.title, title);
  assert.deepEqual(f.sent("thread.pin").map((c) => c.threadId), [to]);
  assert.equal(f.sent("message.dispatch").length, 0, "no first message: the new thread waits; the old gets no /compact");
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [to], "only the new thread is snoozed");
  assert.equal(fs.existsSync(path.join(f.stateDir, "snooze-later.log")), false, "no snooze-later (it would /compact)");
  const s = f.state();
  assert.deepEqual(s.queue.map((q) => [q.threadId, q.priority, q.pauses, q.takeover.from, q.takeover.compactions, !!q.notBefore]), [[to, "high", 2, id, 3, true]]);
  assert.ok(Date.parse(s.queue[0].notBefore) > Date.now() + 80 * 60000, "same pause-until");
  assert.deepEqual([s.woken[id], s.ready[id], s.ready[to].plan, s.handoffs[id].to, s.handoffs[id].done], [undefined, undefined, `/tmp/${id}.md`, to, true]);
  const h = f.log().find((l) => l.event === "lead-handoff");
  assert.deepEqual([h.threadId, h.to, h.cause, h.compactions, h.queued, h.settled], [id, to, "pause", 3, true, false]);
  assert.equal(f.log().filter((l) => l.event === "pause").length, 0, "no pause line for the old thread");
  assert.ok(Date.now() - Date.parse(s.lastPauseAt) < 60000, "the pause counts for the night cooldown (lastPauseAt)");
  // Before its until the tick leaves the new thread queued; the old settles once its turn ends.
  const settledAt = () => f.db().threads.find((t) => t.thread_id === id).settled_at ?? null;
  assert.equal(settledAt(), null, "still running at the pause: not settled then");
  f.edit((d) => { const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = ago(1); });
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("message.dispatch").length, 0);
  assert.ok(settledAt(), "settled on the first tick after its turn");
  assert.equal(f.state().handoffs[id].settled, true);
  // Past it the pacer wakes the new thread with the take-over brief.
  fs.writeFileSync(path.join(f.stateDir, "queue.json"), JSON.stringify({ ...f.state(), queue: f.state().queue.map((q) => ({ ...q, notBefore: ago(1) })) }));
  ok(f.run(pacer, ["tick"]));
  const woke = f.sent("message.dispatch");
  assert.deepEqual(woke.map((c) => c.threadId), [to]);
  assert.match(woke[0].text, new RegExp(`^Pacer: you take over from thread ${id}, which reached 3 compactions`));
  assert.ok(woke[0].text.includes(`/tmp/${id}.md § Resume`));
  assert.equal(f.sent("thread.create").length, 1);
});

test("pause at 3 compactions with a running delegate_task child: queued as usual, no /compact, due; the report's turn ends with one hand-off-now ask", () => {
  const id = randomUUID();
  const title = "Task 99 lead";
  const f = leadHome({ threads: [awakeLead(id, title), childOf(id)], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, title) }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m", "--priority", "high"]));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [id]);
  const e = f.state().queue.find((q) => q.threadId === id);
  assert.deepEqual([e.priority, e.handoffDue.compactions], ["high", 3]);
  const due = f.log().find((l) => l.event === "lead-handoff-due");
  assert.equal(due.threadId, id);
  assert.match(due.why, /waits for 1 running delegate_task child; no \/compact/);
  // The child reports: T3 runs a turn on the lead after its snooze. T3 keeps snoozedUntil; the
  // completed turn after snoozedAt is what shows it awake.
  reportTurn(f, id);
  assert.ok(f.db().threads.find((t) => t.thread_id === id).snoozed_until, "snoozedUntil kept, as T3 does");
  ok(f.run(pacer, ["tick"]));
  const asks = () => f.sent("message.dispatch").filter((c) => c.threadId === id && c.text.startsWith("Pacer: hand off now"));
  assert.equal(asks().length, 1, "asked once although queued");
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [id], "left awake this tick");
  ok(f.run(pacer, ["tick"]));
  assert.equal(asks().length, 1, "not asked twice");
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [id, id], "then snoozed again");
  // The lead runs handoff: the new thread keeps the pause (queued, snoozed, no message).
  const out = ok(f.run(pacer, ["handoff", "--thread", id])).stdout;
  assert.match(out, /waits in this one's place in the queue; the pacer wakes it/);
  const to = f.sent("thread.create")[0].threadId;
  assert.equal(f.sent("message.dispatch").filter((c) => c.threadId === to).length, 0);
  const q = f.state().queue;
  assert.deepEqual(q.map((x) => [x.threadId, x.priority, x.handoffDue, x.takeover.from]), [[to, "high", undefined, id]]);
  assert.equal(f.sent("thread.snooze").at(-1).threadId, to);
});

test("snooze-later after the pausing turn: an entry due a hand-off gets no /compact (logged compact-skipped) and is snoozed; one not due is compacted", () => {
  for (const due of [true, false]) {
    const id = randomUUID();
    const f = leadHome({ threads: [awakeLead(id, "Task 99 lead"), ...(due ? [childOf(id)] : [])], items: compactions(id, due ? 4 : 2), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
    ok(f.run(pacer, ["enqueue", "--thread", id, "--plan", `/tmp/${id}.md`]));
    const e = f.state().queue.find((q) => q.threadId === id);
    assert.equal(!!e.handoffDue, due);
    // What the detached helper does once the enqueuing turn ends (run here on the fake).
    ok(f.run(pacer, ["snooze-later", "--thread", id, "--since", "", "--enqueued", e.enqueuedAt, "--after-turn"]));
    const compact = f.sent("message.dispatch").filter((c) => c.threadId === id && c.text === "/compact");
    if (due) {
      assert.equal(compact.length, 0, "no /compact for a lead due a hand-off");
      assert.match(f.log().find((l) => l.event === "compact-skipped").why, /due a hand-off \(4 compactions\).*no \/compact/);
    } else assert.equal(compact.length, 1, "today's /compact");
    assert.equal(f.sent("thread.snooze").at(-1).threadId, id, "snoozed either way");
  }
});

test("pause under 3 compactions: today's path (queued, snoozed, no hand-off, no due mark)", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [awakeLead(id, "Task 99 lead")], items: compactions(id, 2), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
  assert.equal(f.sent("thread.create").length, 0);
  assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [id]);
  const e = f.state().queue.find((q) => q.threadId === id);
  assert.deepEqual([!!e, e.handoffDue, e.takeover], [true, undefined, undefined]);
  assert.equal(f.log().filter((l) => /^lead-handoff/.test(l.event)).length, 0);
  assert.equal(f.log().filter((l) => l.event === "pause").length, 1);
});

test("pause at 3 compactions when the new thread can't be made: logged, no record left, queued and snoozed as before", () => {
  const id = randomUUID();
  withFailingCreate((run) => {
    const f = leadHome({ threads: [awakeLead(id, "Task 99 lead")], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
    const r = ok(run(f, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
    assert.match(r.stderr, /hand-off failed \(logged\): .*create refused.*; queued as before/);
    const fail = f.log().find((l) => l.event === "lead-handoff-failed");
    assert.deepEqual([fail.threadId, fail.cause, fail.compactions], [id, "pause", 3]);
    assert.match(fail.why, /^queued, compacted and snoozed as before$/);
    const s = f.state();
    assert.equal(s.handoffs?.[id], undefined, "no half record for the tick to finish");
    const e = s.queue.find((q) => q.threadId === id);
    assert.deepEqual([!!e, e.handoffDue, !!e.notBefore], [true, undefined, true]);
    assert.deepEqual(f.sent("thread.snooze").map((c) => c.threadId), [id]);
    assert.equal(f.log().filter((l) => l.event === "pause").length, 1);
  });
});

test("pause path leaves the user's own thread (no plan entry) and refuses a worker", () => {
  const own = randomUUID(), w = randomUUID();
  const f = leadHome({ threads: [awakeLead(own, "My own work"), { ...awakeLead(w, "Review: stage 3"), created_by: "agent", lineage: { parentThreadId: "lead-1", relationshipToParent: "subagent", rootThreadId: "lead-1" } }], items: [...compactions(own, 5), ...compactions(w, 5)], state: { queue: [], woken: {}, asked: {} } });
  ok(f.run(pacer, ["enqueue", "--thread", own, "--plan", "/tmp/own.md"]));
  assert.equal(f.sent("thread.create").length, 0, "first enqueue of own thread: not a lead yet");
  assert.deepEqual(["handoffDue", "lead"].map((k) => f.state().queue.find((q) => q.threadId === own)[k]), [undefined, false], "nor rechecked before its /compact");
  assert.equal(f.log().filter((l) => /^lead-handoff/.test(l.event)).length, 0);
  const r = f.run(pacer, ["pause", "--thread", w, "--plan", "/tmp/w.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worker/);
  assert.equal(f.sent("thread.create").length, 0);
});

// --- Pause-path hand-off, more cases ----------------------------------------------------------------

test("due lead: the deferred snooze lands after the child's report turn; the tick still asks once (no /compact, no hand-off yet)", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [pausing(id, "Task 99 lead"), childOf(id)], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
  assert.ok(f.state().queue[0].handoffDue);
  // The pausing turn ends, the child reports (a turn on the lead), and only then the helper
  // runs: it snoozes the lead again, so snoozedAt is past the report turn and T3 shows it snoozed.
  reportTurn(f, id);
  snoozeLater(f, id);
  const lead = f.db().threads.find((t) => t.thread_id === id);
  assert.ok(Date.parse(lead.snoozed_at) >= Date.parse(f.db().runs.filter((r) => r.thread_id === id).at(-1).completed_at), "snoozed after the report");
  ok(f.run(pacer, ["tick"]));
  const asks = () => f.sent("message.dispatch").filter((c) => c.threadId === id && c.text.startsWith("Pacer: hand off now"));
  assert.equal(asks().length, 1, "the report's turn still gets its hand-off-now ask");
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "/compact").length, 0);
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.state().handoffAsked[id], 3);
  ok(f.run(pacer, ["tick"]));
  assert.equal(asks().length, 1, "not asked twice");
});

test("due lead still snoozed with no turn since its pause: no ask", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [pausing(id, "Task 99 lead"), childOf(id)], items: compactions(id, 3), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
  // The pausing turn ends; the child is still running.
  f.edit((d) => { const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = new Date().toISOString(); });
  snoozeLater(f, id);
  ok(f.run(pacer, ["tick"]));
  assert.equal(f.sent("message.dispatch").length, 0, "the pausing turn is not a report");
});

test("threshold crossed after pause read it (2 → 3 in the pausing turn): the deferred helper hands off instead of /compact", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [pausing(id, "Task 99 lead")], items: compactions(id, 2), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m", "--priority", "high"]));
  assert.deepEqual([f.state().queue[0].lead, f.state().queue[0].handoffDue, f.sent("thread.create").length], [true, undefined, 0], "2 at the pause: queued as usual");
  f.edit((d) => { d.items.push(...compactions(id, 1)); const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = new Date().toISOString(); });
  snoozeLater(f, id);
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "/compact").length, 0, "no /compact");
  const [created] = f.sent("thread.create");
  assert.ok(created, "handed off");
  const s = f.state();
  assert.deepEqual(s.queue.map((q) => [q.threadId, q.priority, q.takeover.from, q.takeover.compactions, !!q.notBefore]), [[created.threadId, "high", id, 3, true]]);
  const h = f.log().find((l) => l.event === "lead-handoff");
  assert.deepEqual([h.threadId, h.cause, h.compactions, h.queued], [id, "pause", 3, true]);
  assert.match(f.log().find((l) => l.event === "compact-skipped").why, /handed off before its \/compact/);
  assert.ok(f.db().threads.find((t) => t.thread_id === id).settled_at, "old thread settled");
});

test("threshold crossed after pause with a running child: marked due, no /compact", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [pausing(id, "Task 99 lead"), childOf(id)], items: compactions(id, 2), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
  f.edit((d) => { d.items.push(...compactions(id, 1)); const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = new Date().toISOString(); });
  snoozeLater(f, id);
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "/compact").length, 0, "no /compact");
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(f.state().queue[0].handoffDue.compactions, 3);
  assert.ok(f.log().some((l) => l.event === "lead-handoff-due" && l.threadId === id));
  assert.equal(f.sent("thread.snooze").at(-1).threadId, id, "snoozed");
});

test("threshold crossed after pause, hand-off can't start: logged, compacted and snoozed as before", () => {
  const id = randomUUID();
  const f = leadHome({ threads: [pausing(id, "Task 99 lead")], items: compactions(id, 2), state: { queue: [], woken: { [id]: wokenRec(id, "Task 99 lead") }, asked: {} } });
  ok(f.run(pacer, ["pause", "--thread", id, "--plan", `/tmp/${id}.md`, "--until", "+90m"]));
  f.edit((d) => { d.items.push(...compactions(id, 1)); const r = d.runs.find((x) => x.thread_id === id); r.status = "completed"; r.completed_at = new Date().toISOString(); });
  withFailingCreate((run) => snoozeLater(f, id, (args) => run(f, args)));
  const fail = f.log().find((l) => l.event === "lead-handoff-failed");
  assert.deepEqual([fail.threadId, fail.cause, fail.compactions], [id, "pause", 3]);
  assert.equal(f.state().handoffs?.[id], undefined, "no half record");
  assert.equal(f.sent("message.dispatch").filter((c) => c.text === "/compact").length, 1, "today's /compact");
  assert.equal(f.sent("thread.snooze").at(-1).threadId, id, "snoozed");
});

// --- Pause-path hand-off, mixed versions ----------------------------------------------------------------

// A queued, snoozed lead at 3 compactions whose pausing turn has ended; the helper is about to
// /compact it. `marker`: the entry's lead field ("none" = written before the marker existed).
// `first`: the entry the old enqueue wrote for a thread new to the pacer (the user's own): its
// firstQueuedAt and readyAt are the enqueue time itself.
function queuedLead({ marker = true, first = false, title = "Task 99 lead", n = 3 } = {}) {
  const id = randomUUID();
  const enqueuedAt = ago(10);
  const before = first ? enqueuedAt : ago(60);
  const e = { threadId: id, title, plan: `/tmp/${id}.md`, priority: "med", firstQueuedAt: before, enqueuedAt, pauses: first ? 0 : 1, ...(marker === "none" ? {} : { lead: marker }) };
  const f = leadHome({ threads: [{ ...awakeLead(id, title), snoozed_until: new Date(Date.now() + 86400000).toISOString(), snoozed_at: ago(2) }],
    items: compactions(id, n), state: { queue: [e], woken: {}, ready: { [id]: { plan: e.plan, title: e.title, readyAt: before } }, asked: {} } });
  return { f, id };
}
// Runs the helper; `body` (preload source, `p` = queue.json path) runs once, just before the
// helper takes the queue lock: another pacer process changed the queue meanwhile.
function snoozeLaterRaced(f, id, body) {
  const file = path.join(f.home, `race-${randomUUID()}.mjs`);
  fs.writeFileSync(file, `import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync; let done = false;
fs.writeFileSync = function (file, ...args) {
  if (!done && String(file).endsWith("/queue.lock")) { done = true; const p = path.join(process.env.PACER_STATE_DIR, "queue.json"); ${body} }
  return write.call(this, file, ...args);
};
syncBuiltinESMExports();\n`);
  const enqueuedAt = f.state().queue.find((q) => q.threadId === id).enqueuedAt;
  return ok(f.run(pacer, ["snooze-later", "--thread", id, "--since", "", "--enqueued", enqueuedAt, "--after-turn"], { NODE_OPTIONS: `--import=${file}` }));
}
const compacts = (f, id) => f.sent("message.dispatch").filter((c) => c.threadId === id && c.text === "/compact").length;

test("a tick hands the lead off while the helper waits for the queue lock: the old thread gets no /compact and stays settled", () => {
  const { f, id } = queuedLead();
  snoozeLaterRaced(f, id, `const env = { ...process.env }; delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", ${JSON.stringify(fakeT3)}, ${JSON.stringify(pacer)}, "tick"], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);`);
  const s = f.state();
  assert.equal(s.handoffs[id].settled, true, "the tick handed it off");
  assert.equal(compacts(f, id), 0, "no /compact reopens the settled thread");
  assert.ok(f.db().threads.find((t) => t.thread_id === id).settled_at, "still settled");
  assert.ok(f.log().some((l) => l.event === "compact-skipped" && l.threadId === id && /left the queue/.test(l.why)));
  assert.deepEqual(f.sent("thread.snooze").filter((c) => c.threadId === id), [], "not snoozed again");
});

for (const [name, body, why] of [
  ["re-queued", `const s = JSON.parse(fs.readFileSync(p, "utf8")); s.queue[0].enqueuedAt = new Date().toISOString(); write.call(this, p, JSON.stringify(s));`, /re-queued/],
  ["marked due", `const s = JSON.parse(fs.readFileSync(p, "utf8")); s.queue[0].handoffDue = { at: new Date().toISOString(), compactions: 3 }; write.call(this, p, JSON.stringify(s));`, /due a hand-off/],
]) {
  test(`the entry is ${name} while the helper waits for the queue lock: no /compact, no hand-off`, () => {
    const { f, id } = queuedLead();
    snoozeLaterRaced(f, id, body);
    assert.equal(compacts(f, id), 0);
    assert.equal(f.sent("thread.create").length, 0);
    assert.match(f.log().find((l) => l.event === "compact-skipped" && l.threadId === id).why, why);
  });
}

test("a queued lead entry from before the lead marker is rechecked: handed off at 3 instead of /compact", () => {
  const { f, id } = queuedLead({ marker: "none" });
  assert.equal("lead" in f.state().queue[0], false);
  snoozeLater(f, id);
  assert.equal(compacts(f, id), 0);
  const [created] = f.sent("thread.create");
  assert.ok(created, "handed off");
  assert.deepEqual(f.state().queue.map((q) => [q.threadId, q.lead]), [[created.threadId, true]], "the new thread's entry is marked a lead");
  assert.equal(f.log().find((l) => l.event === "lead-handoff").cause, "pause");
});

test("mixed versions: the user's own thread's unmarked first-enqueue entry (old enqueue) at 5 compactions gets its /compact, never a hand-off", () => {
  const { f, id } = queuedLead({ marker: "none", first: true, title: "My own work", n: 5 });
  assert.equal("lead" in f.state().queue[0], false);
  snoozeLater(f, id);
  assert.equal(f.sent("thread.create").length, 0, "no successor");
  assert.equal(compacts(f, id), 1, "today's /compact");
  assert.equal(f.db().threads.find((t) => t.thread_id === id).settled_at ?? null, null, "not settled");
  assert.equal(f.log().filter((l) => /^lead-handoff/.test(l.event)).length, 0);
  assert.equal(f.sent("thread.snooze").at(-1).threadId, id, "snoozed");
});

test("an entry marked lead: false (own thread's first enqueue) still gets its /compact at 3", () => {
  const { f, id } = queuedLead({ marker: false });
  snoozeLater(f, id);
  assert.equal(f.sent("thread.create").length, 0);
  assert.equal(compacts(f, id), 1);
});
