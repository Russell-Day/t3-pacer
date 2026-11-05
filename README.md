# t3-pacer

A pacer for Claude threads in [T3 Code](https://github.com/pingdotgg/t3code). A 5 h
Claude usage window fills in 2–3 h when several long-running threads work at once, and then
everything stalls until the reset. The pacer spends the window evenly instead and lets the
overflow run at night.

Every 5 min a systemd timer runs one tick. The tick reads the Claude usage window and T3's
state, then takes at most one action. It either wakes the next queued thread, or asks an
active thread to pause at its next stopping point. This keeps usage near a pace line: 100%
10 min before a day reset, and 30 min before a night reset. The tick calls no model.

- **Queue.** Threads queue themselves (`enqueue`) and get snoozed in T3. The queue is
  ranked by priority × age, with paused work first, small plans first, and plan
  dependencies respected.
- **Cap.** Working Claude Opus threads (workers included) count against a cap of 6.
  The cap only stops wakes; it never pauses anything.
- **Usage limits and hand-offs.** At a reset, threads stopped by the usage limit resume
  one at a time. A thread the user writes in, or one that asks the user something, is
  handed back to them.
- **Lead hand-off.** A long-running lead moves to a fresh thread after 3 compactions.
- **Optional hooks:**
  - a sleep file (night mode and a wake digest);
  - an open-questions hook;
  - a once-per-window triage pass;
  - an emergency hook that starts a fix-it thread;
  - a morning report piped to your notifier.

Agents use it as a skill: [pacer/SKILL.md](pacer/SKILL.md) holds the commands and the day
protocol for a long-running thread. [pacer/DESIGN.md](pacer/DESIGN.md) holds every rule.

## Requirements

- Linux with systemd user timers (WSL works).
- Node.js 22 or newer.
- `python3`: the pacer reads T3's sqlite state through its `sqlite3` module.
- T3 Code 0.1.0 or newer, running on the same machine, with a Claude provider. The pacer
  talks to T3's local WebSocket RPC and reads `statev2.sqlite`. That interface is
  undocumented, so a T3 update can break it.
- Claude used through T3 (Claude Code).

## Install

```bash
git clone <this repo> ~/t3-pacer
~/t3-pacer/install.sh
```

`install.sh` links `pacer/` to `~/.agents/skills/pacer`. From there it links the skill
into `~/.claude/skills` and into every `~/.claude_*`, `~/.codex` and `~/.codex_*` home that
exists. Run it again after adding a harness home.

## Configure

The state lives in `~/.local/state/pacer/`, or in `$PACER_STATE_DIR` when that is set.
Settings go in `config.json` there:

```bash
mkdir -p ~/.local/state/pacer
cp ~/t3-pacer/pacer/config.example.json ~/.local/state/pacer/config.json
```

Every key is optional, and `_doc` in the example explains each one. Delete what you don't
use. The hooks in particular stay off until configured, and the example values
(`my-notifier`, `/path/to/...`) are placeholders. The defaults fit a stock T3 install:

| key | meaning | default |
|---|---|---|
| `t3.userdata` | T3's data directory | `~/.t3/userdata` |
| `t3.claudeInstance` | the T3 provider instance to pace | `claudeAgent` |
| `t3.mainInstance` | the instance new threads start on | `t3.claudeInstance` |
| `claude.configDir` | the Claude config dir behind that instance | `~/.claude` |
| `claude.providerLogs` | read live usage from T3's provider logs; set `false` if T3 runs more than one Claude account (the logs don't say which account wrote them) | `true` |
| `timeZone` | the user's IANA time zone | the system zone |

Commands that run your own tools take a shell command string:

| command | used for | what it receives or must print |
|---|---|---|
| `reportCommand` | morning report and wake digest | gets markdown on stdin |
| `triage.checkCommand` | your triage command | prints a count of new items |
| `emergency.textCommand` | your notifier's text | gets `<line> --key <key>` as arguments |
| `emergency.postCommand` | your notifier's post | gets the line on stdin |
| `questions.command` | open questions asked outside T3 | prints JSON |

## Timers

The unit files are in [pacer/systemd/](pacer/systemd/).

```bash
mkdir -p ~/.config/systemd/user
cp ~/t3-pacer/pacer/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pacer.timer pacer-report.timer
```

- `pacer.timer` runs `tick` every 5 min.
- `pacer-report.timer` runs `report --since 10h --post --morning` every 15 min. The report
  posts only once a day, at or after `reportAt`. Without a `reportCommand` it prints
  "report off" and exits cleanly, so enable it once you have somewhere to post.

The units start `node` through `/usr/bin/env`, using systemd's default PATH. If `node`
(nvm, fnm, a custom prefix) or your hook commands live elsewhere, add a drop-in
(`systemctl --user edit pacer.service`) with `Environment=PATH=...`, or put an absolute
node path in `ExecStart`. Enable lingering (`loginctl enable-linger`) if the timers should
run while you're logged out.

To watch it work:

```bash
tail -f ~/.local/state/pacer/log.jsonl
node ~/.agents/skills/pacer/scripts/pacer.mjs status
node ~/.agents/skills/pacer/scripts/pacer.mjs tick --dry-run
```

## Tests

```bash
node --test ~/t3-pacer/pacer/scripts/*.test.mjs
```

The tests run against a fake T3 (`pacer/scripts/testdata/`) in temp directories. They never
touch the real state dir or a running T3, and they make no model calls.

## License

MIT, see [LICENSE](LICENSE).
