---
name: pacer
description: Pace every main Claude thread in T3 Code across the day and night against the 5 h usage window. Queued threads are snoozed; every 5 min the pacer wakes the next one (working Claude Opus threads, workers included, against a cap of 6) or asks an active thread to pause, keeping the session window near a pace line (day 100% 10 min before the reset, night 30 min before). Queue ranked by W × (1 + days/7), paused work first, plan dependencies respected. Optional sleep file, triage and emergency hooks, morning report. Use to enqueue, ready, pause or hand off a plan, or to check status.
---

# Pacer

A 5 h Claude window fills in 2–3 h when several long-running threads work at
once, then everything stalls until the reset. The pacer spends the window
evenly and lets the overflow run at night. It calls no model; a `pacer.timer`
tick every 5 min reads the Claude usage window and T3's state and sends T3
commands. How it decides (pace lines, band, wake and ask rules, hand-backs,
hooks, state files) is in [DESIGN.md](DESIGN.md).

A **lead** here is a long-running main thread that works from a plan file
(a markdown file with a `## Resume` section it keeps current) and starts
worker threads for the build.

## Commands

```bash
P=~/.agents/skills/pacer/scripts/pacer.mjs
node $P enqueue --plan <plan.md> [--priority low|med|high|highest] [--size s|m|l] [--note "..."] [--thread <id>]
node $P ready --plan <plan.md> [--thread <id>]   # plan fleshed out: may now be asked to pause
node $P built --plan <plan.md> [--thread <id>]   # all stages committed, only a live check left: dependents unblock
node $P pause [--plan <path>]   # on a pacer ask, after the step is done and Resume is updated
node $P pause --plan <path> --until <HH:MM|+90m|ISO>   # blocked until a known time: not woken before it
node $P status           # mode, usage vs pace, Working N/cap, active threads, limit resumes, scored queue, last decisions
node $P list [--json]    # scored queue (wake order) + threads the pacer woke
node $P wake --thread <id> | --next [--among <id,id>]   # wake now; --next = what the tick would wake
node $P remove --thread <id>   # take it out of the queue; unsnoozes it
node $P priority --thread <id> --level low|med|high|highest
node $P cap --add N | --off   # this window only: spend about N more points, evenly to the finish
node $P hold [--note "..."]   # the user's switch only
node $P go                     # the user's switch only: end the hold
node $P handoff [--plan <path>] [--thread <id>]   # a lead at 3+ compactions: fresh thread takes over from Resume
node $P tick --dry-run         # what the next tick would do; sends nothing
node $P triage --now           # start a triage thread now (needs the triage hook)
node $P sleep                  # asleep | night | awake, plus bedtime, night end and wake time
node $P report [--since 10h] [--post]
```

- `enqueue`, `pause` and `ready` act on the thread you run in unless
  `--thread` is given. `enqueue`/`pause` snooze it (7 days) and imply `ready`.
  Both refuse while the thread has a question for the user open: end the turn
  instead. A thread the user started has no queue entry, so its first `pause`
  needs `--plan`.
- **Priority** = the highest among the plan's items (untagged: `med`, or your
  judgement with a one-line reason in the plan). **Size** from stage count:
  1–2 `s`, 3–5 `m`, 6+ `l`; size `s` ranks as `highest` unless the priority is
  `low`. Both are kept on re-enqueue and pause unless given again.
- **Dependencies.** A `Wait for: plan N` line in a plan (plan files live in
  `<dir>/<N>-<slug>/plan.md`) keeps it from waking before plan N is built.
- **Hold.** While `status` shows "ON HOLD", nothing queued is woken and no
  triage starts. Always `enqueue` then; `ready` prints "QUEUE ON HOLD … don't
  start building". Only the user runs `go`; their answers or "do it" approve a
  plan but don't lift the hold.
- **A question takes you out of the queue.** A queued thread that asks the
  user is handed back (unqueued) on the next tick. After their answers run
  `enqueue` again; `ready` alone never queues (it prints `NOT QUEUED` with the
  command).

## Day protocol (leads)

1. **Plan first**: explore, write the plan, ask the user what only they can
   decide.
2. Once they answer, fill the plan's **Resume** (stage table status, decisions,
   next step, open risks) and `enqueue`, unless `status` shows room (working <
   cap and under pace): then `ready --plan <plan>` and start. Until `ready` (or
   `enqueue`) the thread counts as not ready and is never asked to pause.
   **Enqueue last:** wait for (or stop) every helper you started first; one
   that finishes after the snooze starts a new turn. After `enqueue`, end your
   turn. The pacer compacts the thread before snoozing it, so the plan must
   hold everything the build needs.
3. When woken ("Pacer: your turn"), read the plan's Resume and go. Before
   each Claude Opus worker, check `status`: at or over the cap, start one at
   most. Before ending a turn on a question, run `pacer.mjs sleep` (its fresh
   output counts, not the wake message): if `asleep`, write the question into
   the plan's Questions section, carry on with stages it doesn't block, and
   end on it only when nothing else can move. With a sleep file and a
   `reportCommand`, the pacer posts every thread's open questions in one list
   when the user wakes.
4. On **"Pacer: over pace"**, finish the step you're in: let a running Claude
   worker finish, start no new one. Make Resume complete (note anything still
   running), run `pause` and end the turn.
5. On **"Pacer: hand off now"**, finish or write down the step, make Resume
   current, run the `handoff` command it names and stop once it prints the new
   thread. Never hand off by hand.
6. Done: settle the thread in T3.

**How to wait:**
- **Worker running:** end the turn; its report wakes you. The pacer counts
  you as working while a child of yours runs. No polling.
- **Blocked until a known time** (another tool's quota reset, a dated live
  check, another plan): update Resume, run `pacer.mjs pause --plan <plan>
  --until <time>` and stop. Never just idle.
- **All stages committed, only a live check left:** `pacer.mjs built --plan
  <plan>`, then `pause --until` the check time.
- **Only the user can unblock it** (a decision): ask them, in the thread or
  through your notifier (see the questions hook in DESIGN.md).

## Where things live

State in `~/.local/state/pacer/` or `$PACER_STATE_DIR` (`queue.json`,
`emergency.json`, `log.jsonl`: `tail -f` it to watch, `config.json`; every key
in [config.example.json](config.example.json)). Tests:
`node --test ~/.agents/skills/pacer/scripts/*.test.mjs`. Details in
[DESIGN.md](DESIGN.md#where-things-live).
