// Claude usage from T3's per-thread provider logs. T3's own probe (getConfig)
// can go stale for hours and read 0%, while every live
// Claude turn logs the account's real windows as a rate_limit_event. T3 0.1.0 logs
// the SDK message itself, timed by the line's prefix:
//   [time] NTIVE: {"provider":"claudeAgent",...,"event":{"payload":{"type":"rate_limit_event",
//     "rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.53,"resetsAt":<unix s>}}}}}}
// and logs from before it carry the older notification shape:
//   [time] NTIVE: {"event":{"method":"claude/rate_limit_event","createdAt":...,"payload":{"rate_limit_info":...}}}
import fs from "node:fs";
import path from "node:path";
import { local } from "./settings.mjs";

export const logDir = () => path.join(local().userdata, "logs/provider");
const TAIL = 2 * 1024 * 1024; // bytes read from the end of each file
const WINDOW_MS = 5 * 3600 * 1000; // a file untouched this long holds only expired five_hour windows

// A log window still in force: a utilization number and a reset not yet past.
const live = (w, now) => typeof w?.utilization === "number" && !(w.resetsAt && w.resetsAt * 1000 <= now);

// The newest rate_limit_event with a live five_hour window:
// { at, windows: { five_hour: { utilization, resetsAt }, ... } }, or null.
// Reads every log touched in the last 5 h: file mtime isn't event order (a busy
// thread's log can hold an older reading than a quiet one's), and newer Codex
// logs mustn't push the Claude reading out of view. A full scan takes ~0.3 s.
export function latestClaudeWindows(dir = logDir(), now = Date.now()) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^events\..*\.log$/.test(f))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(({ m }) => m > now - WINDOW_MS);
  } catch { return null; }
  let best = null;
  for (const { f } of files) {
    const fd = fs.openSync(f, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, TAIL));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      // Cheap filter first; then a real parse, since tool output quoting these logs contains the same text.
      if (!line.includes("rate_limit_event")) continue;
      let entry;
      try { entry = JSON.parse(line.slice(line.indexOf("{"))); } catch { continue; }
      const event = entry?.event;
      let at;
      if (event?.method === "claude/rate_limit_event") at = Date.parse(event.createdAt);
      else if (entry.provider === "claudeAgent" && event?.payload?.type === "rate_limit_event") at = Date.parse(line.slice(1, line.indexOf("]")));
      else continue;
      const windows = event.payload?.rate_limit_info?.unifiedWindows;
      if (!live(windows?.five_hour, now) || !at || (best && best.at >= at)) continue;
      best = { at, windows };
    }
  }
  return best;
}

const LABELS = { five_hour: "Session", seven_day: "Weekly" };

// Put the log windows into the given Claude accounts. The logs don't say which
// Claude instance a thread ran on, so pass only instances on the same Claude
// account (one session window): usage.mjs passes just the configured one.
// The thread logs are the source: every live log window replaces T3's probe
// window of the same label. T3's probe is only the fallback when the logs hold
// no live window (no Claude turn since the reset). The probe kept reading
// stale (0% with no reset time, or 14% vs a real 31%) and
// the pacer acted on it.
export function applyClaudeLogs(accounts, latest, now = Date.now()) {
  if (!latest) return accounts;
  for (const a of accounts) {
    let replaced = false;
    for (const [key, w] of Object.entries(latest.windows)) {
      if (!live(w, now)) continue;
      const label = LABELS[key] ?? key;
      const win = { label, usedPercent: Math.round(w.utilization * 100), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null };
      const i = a.windows.findIndex((x) => x.label === label);
      if (i === -1) a.windows.push(win); else a.windows[i] = win;
      replaced = true;
    }
    if (!replaced) continue;
    a.checkedAt = new Date(latest.at).toISOString();
    a.source = "thread logs";
  }
  return accounts;
}
