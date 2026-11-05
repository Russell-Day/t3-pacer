#!/usr/bin/env node
// The Claude account's usage windows (5 h session, weekly), as the pacer reads them.
//
//   usage.mjs          table
//   usage.mjs --json   [{ instance, plan, checkedAt, windows: [{ label, usedPercent, resetsAt }] }]
//   usage.mjs --cached skip the refresh and use T3's last probe
//
// The numbers come from T3's internal RPC (server.refreshProviders + server.getConfig) for the
// configured Claude instance (config t3.claudeInstance), with the live windows from T3's thread
// logs (claude-logs.mjs) taking precedence: T3's own probe can go stale.
import { applyClaudeLogs, latestClaudeWindows } from "./claude-logs.mjs";
import { local } from "./settings.mjs";
import { t3Connect } from "./t3-api.mjs";

let conn;
try {
  conn = await t3Connect("pacer usage");
} catch (e) {
  if (!e.notRunning) throw e;
  console.error(e.message);
  process.exit(1);
}
// getConfig serves T3's cached probe; refresh first so the numbers are current.
if (!process.argv.includes("--cached")) {
  await conn.request("server.refreshProviders", {}, { timeoutMs: 60000 }).catch((e) => console.error(`refresh failed, showing cached: ${e.message}`));
}
const config = await conn.request("server.getConfig", {}, { timeoutMs: 15000 });
conn.close();

// The Claude provider stays in even with no probe windows, or no probe at all (the probe can
// fail or be missing): the thread logs below fill it in.
const { claudeInstance, providerLogs } = local();
const accounts = config.providers
  .filter((p) => p.instanceId === claudeInstance)
  .map((p) => ({
    instance: p.instanceId,
    plan: p.auth?.label ?? null,
    checkedAt: p.usageLimits?.checkedAt,
    windows: (p.usageLimits?.windows ?? []).map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt: resetsAt ?? null })),
  }));
if (providerLogs) applyClaudeLogs(accounts, latestClaudeWindows());
for (let i = accounts.length - 1; i >= 0; i--) if (!accounts[i].windows.length) accounts.splice(i, 1);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(accounts, null, 2));
  process.exit(0);
}

if (!accounts.length) { console.error(`no usage data for ${claudeInstance}`); process.exit(1); }
const until = (iso) => {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return mins >= 1440 ? `resets in ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const width = Math.max(...accounts.flatMap((a) => a.windows.map((w) => w.label.length)));
for (const a of accounts) {
  console.log(`${a.instance} (${a.plan ?? "unknown plan"}; checked ${new Date(a.checkedAt).toLocaleTimeString()}${a.source ? ` · from ${a.source}` : ""})`);
  for (const w of a.windows) {
    console.log(`  ${w.label.padEnd(width)} ${String(w.usedPercent).padStart(3)}% used  ${String(100 - w.usedPercent).padStart(3)}% left  ${until(w.resetsAt)}`);
  }
}
