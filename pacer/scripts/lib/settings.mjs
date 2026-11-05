// Where the pacer keeps its state and how it finds T3 and Claude. The state dir is
// PACER_STATE_DIR or ~/.local/state/pacer; config.json in it holds every setting (see
// config.example.json). The defaults here fit a stock T3 Code install with one Claude provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const stateDir = process.env.PACER_STATE_DIR ?? path.join(os.homedir(), ".local/state/pacer");
export const configFile = path.join(stateDir, "config.json");

// config.json as written ({} when there is none).
export function readConfigFile(file = configFile) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`${file}: ${e.message}`); }
}

const expandHome = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());

// The T3 and Claude settings:
//   t3.userdata       T3's data dir (statev2.sqlite, server-runtime.json, provider logs)
//   t3.claudeInstance the T3 provider instance whose usage the pacer reads and whose threads it paces
//   t3.mainInstance   the instance new threads (triage, hand-offs, emergency) start on
//   claude.configDir  the Claude config dir behind that instance (.credentials.json)
//   claude.providerLogs  read live windows from T3's provider logs (default true). The logs
//                     don't name the account, so turn it off when T3 runs several Claude accounts.
export function localSettings(raw) {
  const claudeInstance = raw.t3?.claudeInstance ?? "claudeAgent";
  return {
    userdata: expandHome(raw.t3?.userdata ?? "~/.t3/userdata"),
    claudeInstance,
    mainInstance: raw.t3?.mainInstance ?? claudeInstance,
    claudeConfigDir: expandHome(raw.claude?.configDir ?? "~/.claude"),
    providerLogs: raw.claude?.providerLogs ?? true,
  };
}

// Read once per process. A broken config.json still lets `--help` and the defaults work; the
// pacer's own readConfig reports the error.
let cached = null;
export function local() {
  if (cached) return cached;
  let raw = {};
  try { raw = readConfigFile(); } catch { /* reported by the pacer's readConfig */ }
  return (cached = localSettings(raw));
}
