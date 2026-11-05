# Pacer: how it decides

The reference behind [SKILL.md](SKILL.md): pacing rules, hand-backs, hand-offs, the sleep file, the questions, triage and emergency hooks, and state files. Agents normally need only SKILL.md; read this when changing or debugging the pacer.

## The rule (one action per tick)

The pacer manages **every main Claude thread** on the configured Claude
instance (`t3.claudeInstance`), whether it woke it or the user started it. Each
Session window of the Claude account is **day** or **night**: a night window
resets between `night.resetFrom` and `night.resetTo` in `config.json` (local
time in `timeZone`, both ends included; default 00:00–10:00, i.e. windows
starting ~19:00–05:00). The user is offline overnight and what's left at a
reset is lost, so a night window is meant to end near 100%.

- Day pace line: `pace = min(100, 100 · elapsed / (5h − dayFinishMin))`
  (default 10 min; 0 with no window open): it reaches 100% 10 min before the reset.
- Night pace line: `pace = min(100, 100 · elapsed / (5h − nightFinishMin))`
  (default 30 min): it reaches 100% about 30 min before the reset.

**Active** = Claude main threads (not workers, not settled, archived or
snoozed) with a turn running or finished < 20 min ago, plus pacer-woken
threads in their first 10 min. A thread with a pending native question or
approval (T3's `pending_user_input_count` / `pending_approval_count`; its turn
stays "running"), or with a question for the user still open (see the
questions hook), is **waiting**, not active, and is never asked to pause.
Threads on other providers don't count.

**Working** = an open Claude thread on a working model (`workingModels`,
default `["opus"]`, case-insensitive patterns matched against the model id),
any project and **workers included**, whose turn is running, with no pending
native request and no running working-model child of its own (T3 lineage
`parentThreadId`: the child does the work). Lighter models and other providers
never count and never take a parent out. A thread is Claude when its provider
instance is exactly `t3.claudeInstance`. A lead whose turn ended while it waits
on a review in another provider is not working, and can be asked to pause. Active decides who can be asked to
pause; working decides wakes.

**Workers** are known by T3 lineage only: a `thread:delegated-task:…` id, or
`lineage.relationshipToParent === "subagent"`. They are never queued, woken,
asked or handed off, and the commands refuse them.

An active thread is **not ready** until its plan is fleshed out, then
**ready**: it ran `ready`, `enqueue` or `pause`, or the pacer woke it (`ready`
in queue.json). Not-ready threads count as active for every wake rule but are
never asked to pause: the queue only holds complete plans.

**Band.** `tol = 5 + 5 × clamp((remaining − 10) / 90, 0, 1)`, `remaining = 100 − used`:
±10 at used 0, ±7.2 at used 50, ±5 from used 90 on. Day and night share the band;
each keeps its own pace line.

| | day | night |
|---|---|---|
| 0 working | wake the next one (bootstrap, even above pace; hold, the night limit block and a `cap` still stop it) | same |
| 1 … `maxWorking − 1` working (default cap 6) | wake when `used ≤ pace` | same |
| `maxWorking`+ working | wake only when `used ≤ pace − tol` | same |
| ask one **ready** thread to pause (≥ 2 ready to ask; with a `cap`, 1) | `used > pace + tol` | `used > pace + 1.2 tol`, and 10 min after the last ask or pause |
| spacing | one wake a tick; a wake with anything working waits 10 min after the last wake (resumes included) | same |
| `used ≥ 95` | with 0 working at most **one** wake per window (`spentWake` in queue.json) | no cap: keep one thread running while the queue has work |
| `used = 100` | no wake (a woken thread only hits the limit) | (the limit check below) |
| a thread hit the usage limit this window | (not checked) | wake nothing new until the reset |

**The cap never pauses.** At or over `maxWorking` the pacer just stops waking;
the over-pace ask stays the only brake. Workers are never asked. The fan-out
brake is an instruction in the wake text and the day protocol, not a guard:
before starting a working-model worker, read `status`; at or over the cap,
start one at most.

At night "hit the limit" means a Claude thread's latest run failed on T3's usage
limit in this window and no newer run has replaced it; T3
(`autoResumeLimitedThreads`) resumes it after the reset, and a fresh start would
only hit the same limit.

**Reset: the pacer resumes main threads, triage first.** Left alone, T3 resumes
every limited thread at once at the reset. Instead, the first tick that sees a
main (non-worker), unqueued Claude thread stopped by the limit, before its
reset, snoozes it to reset + 30 min (T3 skips a thread snoozed into the future;
logged `limit-take`) and keeps a pending resume in queue.json (`limitResumes`).
After the reset it is resumed with T3's own text ("Continue where you left
off.") through the wake rule above, ahead of the queue, one a tick with the
10-min settle; the hold doesn't stop it. If a triage pass is due it starts on
the reset tick and the resumes begin next tick. While a resume is pending and
its snooze runs out within 10 min, the pacer snoozes it again to now + 30 min
(logged `limit-hold`), so T3 never resumes the held threads all at once while
the pacer is over pace. A pending resume is dropped (`limit-resume-dropped`)
once the thread runs again (T3 resumed it after the snooze, or the user wrote
in it), is gone, or no longer shows the limit error. Pacer down: the snooze
runs out and T3 resumes it 30 min late; nothing is lost.

**Workers and queued threads stay T3's.** A limited worker is never touched. A
queued thread whose latest run failed on a usage limit is never woken, unsnoozed,
re-snoozed or pinned (pinning clears T3's snooze, and T3 won't resume a thread
snoozed into the future) until a newer run replaces the limited one. `status`
lists both kinds under "Paused by the usage limit" ("the pacer resumes it" or
"T3 resumes it"), and due resumes under "Limit resumes due, ahead of the queue".
The pacer never stops a thread's workers: workers count as working, which only
decides wakes. `status`, every tick log line and the morning report show the
mode, the pace line, the band and the working count (`used 62% vs pace 55%
±6.6, 2 active, 3/6 working`); every tick line also logs `working` (`count`,
`cap`, each counted thread's `id`, `title`, `why`) and on a wake `wakeSource`
(`bootstrap` / `queue` / `past-cap` / `resume` / `spent`); the report gives
each night window's final %, which should be near 100.

An ask needs at least 2 **askable** threads (ready, the user not in it < 10
min): one always runs. With `cap --add N` one is enough. Pause target (asked at
its next stopping point): only a **ready** thread that the user hasn't written
in for 10 min and that isn't waiting on them. Among those, a thread with a turn
running first, then the newest pacer-woken thread, else the one the user wrote
in least recently. A not-ready thread or one the user wrote in < 10 min ago is
never asked; with too few askable threads there is no ask that tick (logged
"over pace+tol, 1 ready thread to ask, and one always runs: N not ready, M
user-active (title K min ago)", or "no ready thread to ask: …"). While an asked
thread is still active, nobody else is asked. One ask per thread per window.
The ask says: finish the step, make sure Resume is complete (stages,
decisions, next step, open risks) with nothing waiting on the user, then
`pause`.

**The user writing** means a user message that the user created and that
isn't automated: messages starting `Pacer:`, T3's own `Continue where you left
off.`, `/compact`, and any message an agent created don't count.

**Blocked until a known time.** A woken thread that can't move until a set
time (another tool's quota, a long job running) runs `pause --until
<HH:MM|+90m|ISO>`: the pacer doesn't wake it before then and wakes other
queued work meanwhile. Without it, a paused thread's bonus puts it back on top
and it gets woken every tick only to pause again. The wake message says so. A
later plain `pause`/`enqueue` clears it.

**Queue order** is a score, highest first:
`score = W[priority] × (1 + days waiting / ageDays) × (paused ? pausedFactor : 1)`,
defaults `W = {highest: 8, high: 4, med: 2, low: 1}`, `ageDays = 7`,
`pausedFactor = 1.5` (all settable in `config.json`: `priorityWeights`,
`ageDays`, `pausedFactor`, `nearTie`). Days count from the first enqueue
(`firstQueuedAt`, kept through pauses and re-enqueues): a week doubles the
score, so a low item waiting 7 days matches a fresh med one and nothing
starves; a paused thread resumes before fresh work of its level. Ties go to
the earliest first-queued. Among entries scoring at least `nearTie` (0.8) of
the best, `--size l` wins at night (long plans run while the user sleeps) and
`--size s` by day. Small plans go first: an entry of `--size s` ranks as
`highest` unless its priority is `low` (stored priority unchanged, so a later
`--size m` drops it; a higher dependency lift still wins; shown as
`highest 8 (small, was med)`). Legacy `now` / `normal` read as `highest` /
`med`. `list` and `status` show each score and its parts.

**Plan dependencies.** Plans are numbered by their directory
(`<dir>/<N>-<slug>/plan.md`). A plan's `Wait for: plan N` lines (also "waits
for plan N"; a line saying "satisfied" doesn't count) name plans it can't
build before. A queued plan that others wait on takes the **highest priority
among the plans waiting on it**, down the chain (a low plan a highest plan
needs ranks as highest), and always wakes **just before** them. A queued plan
whose dependency is still queued, pacer-woken, or readied by a lead thread
that is still open ("building") is **not woken**; `status` shows "waits for
plan N (queued|woken|building)" and "raised from low: plan M waits on it", and
the tick reason counts "N waiting for another plan". It wakes once the
dependency's thread settles, or once the dependency ran `built`. A cycle falls
back to plain score order. The lead still checks its `Wait for` line when
woken.

**Hand-backs.** Queued threads whose turn is running are skipped. A queued
thread **waiting on the user** (a question of its still open, or a native
request pending) is never woken and never kept hidden: the next tick **hands
it back** (out of the queue, unsnoozed; logged `handoff`, "waiting on the
user"), so the question stays in the user's list. If the unsnooze fails, the
entry stays (logged `handback-failed`; `status` and the report say "couldn't
hand back X: <error>, retrying") and the next tick retries. A deferred snooze
(T3 refused it mid-turn) checks the same thing first. Settled, archived or
deleted ones are dropped. When the user writes in a queued thread, the
thread's turn decides: if it asks them something (a new question, or a native
request) it is handed back as above; if it asks nothing ("ok can we snooze?" →
"yes, it's queued") it stays queued and is snoozed again (logged `resnooze`).
While its turn runs, or before it has replied, the tick waits. When the user
writes in a pacer-woken thread it is **handed back** to them: out of the woken
list, awake, still paced like any other thread. Every hand-back keeps the
entry's priority, size, age, pauses and note (`ready[id].handedBack`), so a
later `enqueue` or `pause` puts it back where it was; flags given on the
command still win.

**Snoozing.** Any other queued thread that comes unsnoozed is snoozed again on
the next tick, 7 days, logged `resnooze`; while its turn runs it waits a tick.
"Snoozed" means what T3's sidebar shows: it puts a snoozed thread back in the
active list once a turn completes (or the session errors) after `snoozed_at`,
though the server keeps `snoozed_until`. `enqueue`/`pause` snooze inside the
thread's own turn, so that turn's end always wakes it in the sidebar; a
detached helper (`snooze-later`) snoozes it again once the turn ends.

**Compact on queue:** once that enqueuing turn ends, the snooze helper sends
the thread `/compact` (only if it would be snoozed: still queued, not waiting
on the user), waits for it, then snoozes (logged `compact` / `compact-failed`;
a failure just snoozes it uncompacted). The cache is warm then, so it's cheap,
and the wake rereads a short summary plus the plan instead of the whole
planning conversation. So the plan must hold everything the build needs. To
take a queued thread back, write in it or `remove` it.

**Pinning:** the pacer pins nothing of its own. T3's Working section keeps
running threads in view. The user's own pins are theirs: a hand-off carries
the user's pin to the new thread and unpins the old one.

## Questions hook

A thread waits on the user when it has a native request pending (T3's
`pending_user_input_count` / `pending_approval_count`) or a question open in
the optional questions hook; a message's wording never decides it. The hook
is for questions asked outside T3, through your notifier:

```json
"questions": { "file": "/path/to/questions.json" }
"questions": { "command": "my-notifier open-questions" }
```

The file (or the command's stdout) maps a T3 thread id to its open questions,
oldest first:

```json
{ "<thread id>": [{ "id": "q1", "question": "Ship it?", "at": "<ISO time>" }] }
```

Only `id` is used (in refusals: "1 question for the user still open (q1)");
the rest is for people reading it. A thread with no open question is left out
or has `[]`. Whatever writes it decides when a question is answered. No hook,
a missing file (the writer creates it on its first question) or empty command
output: nothing is open. A file or command output that doesn't
parse, or a failing command, throws: an unreadable record is never "no
questions".

**Lead hand-off.** A lead is a thread with a pacer plan entry (queue, woken
or ready). At `handoffCompactions` (default 3) T3 compactions it moves to a
fresh thread, by itself:
- **At wake:** a queued lead at 3+ is handed off instead of woken.
- **While awake:** a lead whose turn ended (not running, not freshly woken,
  the user quiet 10 min) gets one turn per compaction level, not per tick:
  "Pacer: hand off now (N compactions) — make Resume current, then run
  `pacer.mjs handoff --plan <plan>`". At N+1 it is told again. Logged `handoff-ask`.
- **Not while it asks:** a lead with a question for the user still open isn't
  handed off (wake, ask or `handoff` alike: "not yet: N questions for the user
  still open"); the answers come back to that thread.
- **At pause:** a lead at 3+ that runs `pause`/`enqueue` is handed off right
  there (cause `pause`): the new thread takes its queue entry (priority,
  `--until`), is the one snoozed and is woken with the take-over brief; the old
  thread gets no `/compact`. With a running child it is queued but marked due
  (`lead-handoff-due`, no `/compact`), and the turn the child's report starts
  ends with one "hand off now" ask (even when the pause's deferred snooze lands
  after that turn); a hand-off that can't start is logged
  (`lead-handoff-failed`) and falls back to compact + snooze. The deferred
  `/compact` counts again first, so a lead whose pausing turn reached 3 is
  handed off (or marked due) then instead of compacted.

`handoff` (or the wake path) starts a new main thread with the same title,
project, model/effort and worktree (branch + path), pinned only when the user
had pinned the old one, whose first message is "Pacer: you take over from
thread <old>… Read <plan> § Resume and continue". The lead's queue, woken and
ready entries (and its window ask) move to the new id; a queued one becomes
woken. The old thread is unpinned (if pinned) and settled; if its turn is
still running (the lead ran `handoff` itself) it is settled by the first tick
after the turn ends (`lead-handoff-settled`). Logged `lead-handoff` (from, to,
plan, compactions, cause `wake`|`pause`|`command`).

It waits while the lead has a running child (a thread whose lineage parent is
the lead): not woken, not handed off, not asked; `status` lists it under "Lead
hand-offs" with the child, and the tick reason says "N due a hand-off, waiting
for a child". The command refuses then too. Threads without a plan entry (the
user's own) are never touched; the command refuses them ("not a lead"). On
hold neither automatic path fires (the lead's own `handoff` still runs: it is
an explicit act). Each hand-off is a record in queue.json `handoffs` keyed by
the old id, written under the queue lock before the thread is created with
fixed ids, so a second `handoff`, a racing tick or a crash mid-way finishes the
same one new thread; records go a week after settling.

## Sleep file

Optional `config.json` key `sleepFile`: a JSON file another app writes when
the user goes to bed and wakes:
`{"day", "bedtime_at", "night_until", "wake_at", "updated_at"}`, UTC ISO
times, `bedtime_at` and `wake_at` may be null. The pacer only reads the file.

- **Coding night** = now in [`bedtime_at`, `night_until`). The current window
  counts as night even if its reset is outside `night.resetFrom/resetTo`:
  night pace line, size `l` first, no 95% cap, the night usage-limit rule.
  After `night_until` the clock rule applies again.
- **Asleep** = now ≥ `bedtime_at`, `wake_at` null, and before 12:00 that
  morning (so a missed wake never leaves the user asleep all day). While
  asleep, every wake message ("Pacer: your turn") adds: "The user is asleep:
  don't end the turn on a question while another stage can move; write the
  question into the plan's Questions section, carry on, and end with it only
  when nothing else can move." Threads already waiting on the user stay
  waiting (no extra hand-back).
- **Wake digest**: the first tick that finds a wake for the current night
  (`bedtime_at` set, `bedtime_at` ≤ `wake_at` ≤ now, bedtime under 24 h ago)
  posts the morning report's "Waiting on the user" list through
  `reportCommand`, headed "Good morning: N threads have questions for you"
  (only when N > 0; logged `wake-digest` either way, a failed post with its
  error, which the morning report also lists). No earlier tick has to have
  seen the user asleep: a bedtime and a wake between two ticks still post.
  Once per night (`sleep.digestDay` in queue.json). Asleep ending at 12:00
  without a wake posts no digest; a stale file from an older night never
  posts. The morning report is unchanged and still runs.
- `pacer.mjs sleep` prints the state first (`asleep`, `night` or `awake`) and
  then the times; `status` shows it on its `Sleep:` line. Leads check it
  before ending a turn on a question; its fresh output is authoritative, never
  an older wake message.
- No `sleepFile`, a missing file, or a garbled one: the clock rules. Each
  change of state (label, reason, bedtime) is logged once as `sleep`; it never
  stops a tick (`sleep-error` if something throws).

## Triage hook

With `"triage": { "project": "<repo root>", "checkCommand": "<prints a count>" }`
in `config.json`, the first tick of each Claude session window runs
`checkCommand`, your triage command (no model call): it prints the number of
new, untriaged items. N > 0 starts one **main** thread in that T3 project
(`t3.mainInstance`, Opus high, not pinned), titled from `triage.title`
(default `Triage: {items}`) and sent `triage.message` (default `Triage the
{items}.`); `{items}` becomes "N new items" and `{count}` the number. 0 starts
nothing (`triage-none`). It is a main thread like any other: paced, never a
worker. A pass starts only when **no triage thread is open** (`triage-wait`)
and either the **last triage run is `everyHours` (24) old** or **more than
`minItems` (5) items** are open (otherwise `triage-skip`). Triage threads are
the pacer's own and the user's: titled "Triag…", or a first message that
starts with triage / `/triage`, or with the configured message's fixed start
(the text before its first `{`); from the last 7 days plus any still open
however old. A first message that is a markdown brief (`# …`) doesn't count.

The pass (window, thread id, message id) is saved to queue.json as
`triage.pending` before any T3 command; if the pacer dies or a step fails, the
next tick finishes the same thread (creates it or sends whatever is missing)
instead of starting a second one. A failing or non-numeric check is logged
(`triage-error`), shown on the `status` Triage line, and retried next window.
`triage --now` starts a pass at once (no window or 24 h rule; also on hold);
with a triage thread open it names that one. `hold` stops the automatic pass.
`status` shows the triage line; the window's result is `triage` in queue.json.

## Emergency hook

With

```json
"emergency": { "project": "<repo root>", "checkCommand": "<prints JSON causes>",
  "textCommand": "<your notifier>", "postCommand": "<posts markdown from stdin>", "cooldownHours": 6,
  "chain": [{ "instance": "claudeAgent", "model": "claude-opus-5-5", "options": [{ "id": "effort", "value": "high" }] }] }
```

every tick, first thing and inside its own try/catch (whatever the hold says),
gathers **causes**:

- `checkCommand` (20 s timeout) prints `{"causes": [{"key", "count",
  "threshold", "window_min", "summary", "top": [{"source", "message", "n"}]}]}`;
  `key`, `count` and `summary` are required; empty = normal. A crash, timeout
  or bad output is logged (`emergency-check-error`) and the tick goes on.
- **pacer-failing**: 3 failed ticks in a row (the tick's catch path runs the
  hook too, under the queue lock; the check runs once per tick). The `tick` log
  line is written last, after the wake or ask, so a tick whose wake fails logs
  only its `error` line and counts once. A tick that fails with a
  T3-unreachable error (database locked, connection refused) while the newest
  entry in `~/.t3/wsl-runtime` (`PACER_T3_RUNTIME_DIR`) is under 15 min old
  (T3 upgrading itself; T3 writes that directory under WSL, so elsewhere
  point `PACER_T3_RUNTIME_DIR` at your T3's runtime directory or there is no grace) is logged `t3Upgrade` and counts toward neither this
  nor pacer-blind; `status` shows it. Still down after the 15 min, the next
  failures count as usual.
- **pacer-blind**: 6 ticks in a row (30 min) with no Claude usage window, a
  `usage.mjs` error or a null Session window. Tick and tick-error log lines
  carry `blind`.
- **pacer-stuck**: 3 ticks in a row (within an hour) chose to wake the same
  thread and it was still queued after the wake (tick line `wakeStuck`), so the
  wake started nothing and the queue behind it starves. Counts only while the
  thread is still queued.

Rules: **one emergency thread open at a time** (while it's open, tripped
causes are only logged, `emergency-held`). Once it settles (seen by the next
tick, `emergency-closed`), the same cause starts another only `cooldownHours`
(6) after the settle, or sooner when its count is ≥ 2× the count that started
the last one (`emergency-cooldown` otherwise). No daily cap. Otherwise one
**main thread** (not pinned: Working shows it while it runs) on the first step
of `chain`, in `project`, titled `Emergency: <first cause's summary>` (≤ 60
chars); its brief lists the causes with their numbers and top messages and
says how to work (read the project's agent instructions, explore before any
fix, small tested local commit, post a short report with `postCommand`, end
the thread); for a pacer cause it adds the steps to fix the pacer itself. It
never enters the queue and never runs `ready`, so it counts as not ready and
is never asked to pause.

**Fallback chain.** `chain` is a list of T3 model selections (`instance`,
default `t3.mainInstance`; `model`; optional `options`). The default is one
step: Claude Opus, high effort. When a step's run fails, the next tick opens
the next step as a new thread titled `Emergency (<model>): …`, with the same
brief plus every earlier failed thread and its error, and settles the failed
thread so T3 won't resume it. No second notice is sent. A failed last step
ends the chain; it closes like any settled thread. `emergency.json` keeps
`step` and `failed`.

**Notices.** A run sends one notice: `textCommand` gets the line and `--key
emergency-<run id>` as two literal arguments (no shell expansion of the line),
and `postCommand` gets the line on stdin. The line reads "Pacer emergency:
<summaries>. <model> thread '<title>' is on it." When T3 can't open the thread
the run's one notice says so instead ("Couldn't open the … thread … The pacer
retries every tick."). The run id is the first thread id the run tried, so a
recovery or fallback reuses the same key. A failed text/post logs
`emergency-text-failed` and is not retried.

**Claude login notice**: each tick (both paths) looks for a run that failed
with T3's "Claude could not authenticate" in the last 30 min and sends one
notice through `textCommand` per broken login (keyed by the credentials file's
mtime in `claude.configDir`, so a new login re-arms it) with the exact
`CLAUDE_CONFIG_DIR=… claude auth login` command. It also sends one 48 h before
the credentials' `refreshTokenExpiresAt`. State: `login` in `emergency.json`.

Crash safety works like triage: pending thread/message ids and the brief are
saved before T3 commands, so the next tick completes the same thread. The
notice flag is saved after the text/post attempt.

`status` shows an `Emergency:` line; `tick --dry-run` lists what it would do.
Without an `emergency` block the pacer causes still start a thread in
`triage.project` (no check, text or post).

## Time zone

Everything that means the user's day follows `timeZone` in config.json (an
IANA zone; default the system zone): the night window's
`resetFrom`/`resetTo`, the asleep noon cap, every time label (status, sleep,
report) and the `reportAt` morning report. Usage resets stay instants. A bad
zone falls back to the system zone plus one `zone-error` log line. A zone
change the same day never sends a second report (keyed by the local date).

## Where things live

- State dir `~/.local/state/pacer/` (or `$PACER_STATE_DIR`):
  - `queue.json`: queue, woken threads, ready threads, this window's asks and
    its one day ≥ 95% wake, `limitResumes` (main threads taken at a reset),
    `handoffs`, `triage`, `sleep`; `queue.lock` while a command changes it.
  - `emergency.json`: the emergency hook's state, kept out of queue.json so a
    garbled queue.json can't stop it.
  - `log.jsonl`: one JSON line per tick and per action (`tail -f` it to watch).
  - `report.json`: the day the morning report last went out.
  - `config.json`: every setting; see [config.example.json](config.example.json).
- **When ticks fail:** triage errors never stop pacing (logged
  `triage-error`). On the 3rd failed tick in a row the emergency hook starts a
  "pacer-failing" thread whose brief says how to diagnose, fix, test and
  commit in the pacer's repo. The morning report lists failed ticks, triage
  errors, emergency starts and emergency step errors.
- `pacer.timer` runs `tick` every 5 min; `pacer-report.timer` runs `report
  --since 10h --post --morning` every 15 min, which posts only on the first run
  at or after `reportAt` (07:00) each local day, through `reportCommand`
  (markdown on stdin). Unit copies in [systemd/](systemd/); install them in
  `~/.config/systemd/user/`.
- T3: the pacer reads T3's `statev2.sqlite` in `t3.userdata` (through
  `python3`'s sqlite3) and sends commands over T3's WebSocket
  (`orchestration.dispatchCommand`, port from `server-runtime.json`). Usage
  comes from T3's provider usage probe for `t3.claudeInstance`
  (`scripts/lib/usage.mjs`). T3's RPC is undocumented; a T3 update can break
  it.
- Tests: `node --test ~/.agents/skills/pacer/scripts/*.test.mjs` (a fake T3 in
  `scripts/testdata/`; nothing touches the real state dir or T3).
