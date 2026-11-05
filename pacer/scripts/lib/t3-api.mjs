// The one adapter between our scripts and T3 Code (0.1.0, orchestration v2). Reads come from
// T3's state DB (statev2.sqlite, read-only); writes go through its internal Effect-RPC
// WebSocket API (orchestration.dispatchCommand). A `t3 update` can change either, so every
// T3 detail lives here: after an update, fix this file and check it with `node t3-api.mjs --check`.
// Errors that mean T3 changed (auth refused, protocol refused, a schema the server rejects,
// a missing table) say "T3 API changed (server <version>)". Nothing here skips quietly.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { local } from "./settings.mjs";

const userdata = () => local().userdata;
const PROTOCOL = 2; // `/ws?orchestrationProtocol=`; the server answers 426 to anything else
// systemd user timers get a bare PATH without ~/.local/bin, where the t3 CLI lives.
process.env.PATH = `${process.env.PATH ?? ""}:${path.join(os.homedir(), ".local/bin")}`;

// Read-only query against T3's state DB; rows come back as plain objects.
export function t3Query(sql, params = []) {
  const code = `import json,sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nc.row_factory=sqlite3.Row\nprint(json.dumps([dict(x) for x in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))`;
  return JSON.parse(execFileSync("python3", ["-c", code, path.join(userdata(), "statev2.sqlite"), sql, JSON.stringify(params)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
}

// The tables and columns this file reads; checkT3 checks they are all there. The projects
// table kept its pre-0.1.0 name; the compaction activities and session runtime rows stopped at
// the 0.1.0 cutover (compactions since are v2 turn items, sessions v2 provider threads).
export const t3Tables = {
  orchestration_v2_projection_threads: ["thread_id", "project_id", "title", "created_at", "updated_at", "archived_at", "deleted_at", "payload_json", "provider_instance_id"],
  orchestration_v2_projection_runs: ["run_id", "thread_id", "ordinal", "status", "requested_at", "completed_at", "payload_json"],
  orchestration_v2_projection_messages: ["message_id", "thread_id", "run_id", "role", "created_at", "payload_json"],
  orchestration_v2_projection_turn_items: ["thread_id", "run_id", "node_id", "ordinal", "type", "status", "updated_at", "payload_json"],
  orchestration_v2_projection_provider_threads: ["thread_id", "driver", "payload_json"],
  orchestration_v2_projection_provider_sessions: ["provider_session_id", "thread_id", "status", "driver", "provider_instance_id", "updated_at", "payload_json"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  // projection_thread_activities is legacy (gone in 0.1.3); compactionCount reads it only when present.
  provider_session_runtime: ["thread_id", "provider_name", "resume_cursor_json"],
};

// The T3 version, for error messages: the CLI runs the runtime the desktop app selected.
let knownVersion = null;
function t3Version() {
  if (knownVersion) return knownVersion;
  try { return execFileSync("t3", ["--version"], { encoding: "utf8", timeout: 10000 }).trim().replace(/^t3\s+v?/, ""); } catch { return "unknown"; }
}
const apiChanged = (detail) => new Error(`T3 API changed (server ${t3Version()}): ${detail}`);

// One WebSocket session on the local server. `request` resolves with a method's value, or
// with the first chunk of a stream (`stream: true`, e.g. subscribeThread's snapshot).
// A server that isn't up throws an error with `notRunning: true` ("T3 not running (…)").
const notRunning = (why) => Object.assign(new Error(`T3 not running (${why})`), { notRunning: true });
export async function t3Connect(label = "agent skill") {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(path.join(userdata(), "server-runtime.json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") throw notRunning("no server-runtime.json"); throw e; }
  const base = `http://127.0.0.1:${runtime.port}`;
  const token = execFileSync("t3", ["auth", "session", "issue", "--token-only", "--ttl", "5m", "--label", label], { encoding: "utf8" }).trim();
  let res;
  try { res = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } }); }
  catch (e) {
    if (e.cause?.code === "ECONNREFUSED") throw notRunning(`connection refused on port ${runtime.port}`);
    throw new Error(`T3 server not reachable on port ${runtime.port}: ${e.cause?.message ?? e.message}`);
  }
  if (res.status === 401 || res.status === 403) throw apiChanged(`websocket ticket: HTTP ${res.status} (the server refused the \`t3 auth session issue\` token)`);
  if (!res.ok) throw new Error(`websocket ticket: HTTP ${res.status}`);
  const { ticket } = await res.json();
  if (!ticket) throw apiChanged("websocket ticket: no ticket in the reply");
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?orchestrationProtocol=${PROTOCOL}&wsTicket=${encodeURIComponent(ticket)}`);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(apiChanged(`websocket refused (orchestrationProtocol=${PROTOCOL}; 426 means T3 wants another protocol)`)); });
  const pending = new Map();
  let next = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.requestId);
    if (!p) return;
    if (m._tag === "Chunk" && p.stream) { p.done(); p.ok(m.values?.[0]); return; }
    if (m._tag !== "Exit") return;
    p.done();
    if (m.exit?._tag === "Success") return p.ok(m.exit.value);
    const detail = `${p.tag}: ${JSON.stringify(m.exit).slice(0, 600)}`;
    // A Die is a defect: the server could not decode the request, so its schema moved.
    p.fail(JSON.stringify(m.exit?.cause ?? "").includes('"Die"') ? apiChanged(detail) : new Error(detail));
  };
  ws.onclose = () => { for (const p of pending.values()) { p.done(); p.fail(new Error(`${p.tag}: connection closed`)); } };
  return {
    request(tag, payload, { stream = false, timeoutMs = 30000 } = {}) {
      const id = String(++next);
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${tag}${payload?.type ? ` ${payload.type}` : ""}: timeout`)); }, timeoutMs);
        pending.set(id, { tag: payload?.type ?? tag, stream, ok, fail, done: () => { clearTimeout(timer); pending.delete(id); } });
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
    },
    close() { ws.onclose = null; ws.close(); },
  };
}

// One request on its own connection (e.g. server.getConfig, server.refreshProviders).
export async function t3Request(tag, payload = {}, label = "agent skill") {
  const conn = await t3Connect(label);
  try { return await conn.request(tag, payload); } finally { conn.close(); }
}

// Send one orchestration command (e.g. { type: "thread.settle", commandId, threadId }).
export async function t3Command(command, label = "agent skill") {
  return t3Request("orchestration.dispatchCommand", command, label);
}

// --- Threads -------------------------------------------------------------------------------

// A thread as T3's sidebar shows it, computed the way the server builds its thread shell:
// the latest run not held in a queue gives `status` ("idle" with no run); a failed run's root
// error item gives `lastError`/`lastErrorClass` ("usage_limit" on a usage limit), unless the
// provider session reports a different error. One exception, as in T3: when the latest run
// that actually ran failed on a usage limit and newer runs were queued or cancelled before
// starting, that limited run stands for the thread (else the newer run would hide the limit).
const LIVE = ["preparing", "queued", "starting", "running", "waiting"];
const errorSql = (run) => `(select e.payload_json from orchestration_v2_projection_turn_items e
       where e.thread_id = t.thread_id and e.run_id = ${run}.run_id and e.type = 'error' and e.status = 'failed'
         and e.node_id is json_extract(${run}.payload_json, '$.rootNodeId')
       order by e.updated_at desc, e.ordinal desc limit 1)`;
const threadSql = (where) => `
  select t.thread_id, t.project_id, t.title, t.created_at, t.updated_at, t.payload_json,
    r.run_id, r.status as run_status, r.completed_at as run_completed_at,
    case when r.status = 'failed' then ${errorSql("r")} end as error_json,
    x.run_id as x_run_id, x.completed_at as x_completed_at,
    case when x.status = 'failed' and exists (select 1 from orchestration_v2_projection_runs n
       where n.thread_id = t.thread_id and n.ordinal > x.ordinal) then ${errorSql("x")} end as x_error_json,
    (select a.run_id from orchestration_v2_projection_runs a where a.thread_id = t.thread_id
       and a.status in ('preparing','starting','running','waiting') order by a.ordinal desc limit 1) as active_run_id,
    (select json_extract(s.payload_json, '$.lastError') from orchestration_v2_projection_provider_sessions s
       where s.thread_id = t.thread_id and s.provider_instance_id is t.provider_instance_id
       order by s.updated_at desc limit 1) as session_error
  from orchestration_v2_projection_threads t
  left join orchestration_v2_projection_runs r on r.run_id = (
    select c.run_id from orchestration_v2_projection_runs c where c.thread_id = t.thread_id
      and not (c.status = 'queued' and json_extract(c.payload_json, '$.queueHeld') is 1)
    order by c.ordinal desc, c.run_id desc limit 1)
  left join orchestration_v2_projection_runs x on x.run_id = (
    select c.run_id from orchestration_v2_projection_runs c where c.thread_id = t.thread_id and c.status <> 'queued'
      and not (c.status = 'cancelled' and json_extract(c.payload_json, '$.startedAt') is null)
    order by c.completed_at is null desc, julianday(c.completed_at) desc, c.ordinal desc limit 1)
  where ${where}`;

// T3's threadErrorSummary: a distinct session error supersedes the run's classification.
function errorSummary(errorJson, sessionError) {
  const failure = errorJson ? JSON.parse(errorJson).failure ?? null : null;
  const own = sessionError === null || sessionError === failure?.message ? failure : null;
  return { lastError: sessionError ?? failure?.message ?? null, lastErrorClass: own?.class ?? null,
    usageLimitResetAt: own?.class === "usage_limit" ? own.resetAt ?? null : null };
}

function threadFromRow(x) {
  const p = JSON.parse(x.payload_json || "{}");
  const sessionError = x.session_error ?? null;
  const limited = x.x_error_json ? errorSummary(x.x_error_json, sessionError) : null;
  const run = limited?.lastErrorClass === "usage_limit"
    ? { id: x.x_run_id, status: "failed", completedAt: x.x_completed_at, error: limited }
    : { id: x.run_id ?? null, status: x.run_status ?? "idle", completedAt: x.run_completed_at ?? null, error: errorSummary(x.error_json, sessionError) };
  return {
    id: x.thread_id, title: x.title, projectId: x.project_id,
    modelSelection: p.modelSelection ?? null, providerInstanceId: p.providerInstanceId ?? null,
    runtimeMode: p.runtimeMode ?? null, interactionMode: p.interactionMode ?? null,
    archivedAt: p.archivedAt ?? null, deletedAt: p.deletedAt ?? null,
    settledAt: p.settledAt ?? null, settledOverride: p.settledOverride ?? null,
    settled: p.settledAt != null || p.settledOverride === "settled",
    snoozedUntil: p.snoozedUntil ?? null, pinnedAt: p.pinnedAt ?? null,
    lineage: p.lineage ?? null, createdBy: p.createdBy ?? null, creationSource: p.creationSource ?? null,
    createdAt: x.created_at, updatedAt: x.updated_at,
    // A message sent mid-turn can leave a newer run cancelled before it started (T3 folds the
    // message into the live turn), so a still-active run counts as busy too.
    status: run.status, busy: LIVE.includes(run.status) || x.active_run_id != null,
    latestRunId: run.id, latestRunCompletedAt: run.completedAt, activeRunId: x.active_run_id ?? null,
    ...run.error,
  };
}

// One thread (deleted ones too, with `deletedAt` set), or null.
export function getThread(threadId, query = t3Query) {
  const [row] = query(threadSql("t.thread_id = ?"), [threadId]);
  return row ? threadFromRow(row) : null;
}

// Every thread not deleted, optionally in one project; archived ones only when asked.
export function listThreads({ projectId, includeArchived = false } = {}, query = t3Query) {
  const where = ["t.deleted_at is null"];
  const params = [];
  if (projectId) { where.push("t.project_id = ?"); params.push(projectId); }
  if (!includeArchived) where.push("json_extract(t.payload_json, '$.archivedAt') is null");
  return query(`${threadSql(where.join(" and "))} order by t.updated_at desc`, params).map(threadFromRow);
}

// The assistant messages of one run (default: the thread's latest run), oldest first.
export function runReplies(threadId, runId = getThread(threadId)?.latestRunId, query = t3Query) {
  if (!runId) return [];
  return query("select payload_json from orchestration_v2_projection_messages where thread_id = ? and run_id = ? and role = 'assistant' order by created_at, message_id", [threadId, runId])
    .map((r) => JSON.parse(r.payload_json).text ?? "").filter(Boolean);
}

// How many times the thread's context was compacted. Before 0.1.0 one compaction could log
// two activities (a tokenless one within 10 min of the counted one); since then each is one
// `compaction` turn item.
export function compactionCount(threadId, query = t3Query) {
  const v2 = query("select count(*) as n from orchestration_v2_projection_turn_items where thread_id = ? and type = 'compaction'", [threadId])[0]?.n ?? 0;
  // The pre-0.1.0 activities table is gone from newer state DBs (statev2.sqlite): count v2 items only then.
  const hasLegacy = query("select count(*) as n from sqlite_master where type = 'table' and name = 'projection_thread_activities'", [])[0]?.n > 0;
  const legacy = hasLegacy ? query("select created_at, payload_json from projection_thread_activities where thread_id = ? and kind = 'context-compaction' order by created_at", [threadId]) : [];
  const rows = legacy
    .map((r) => ({ at: Date.parse(r.created_at), tokens: JSON.parse(r.payload_json || "{}").beforeTokens != null }));
  const counted = rows.filter((r) => r.tokens);
  return v2 + counted.length + rows.filter((r) => !r.tokens && !counted.some((c) => Math.abs(c.at - r.at) < 600000)).length;
}

// A delegated worker: a T3 delegate_task child (`thread:delegated-task:…` ids). Threads a lead
// started itself are known by their lineage (see the pacer's knownWorker).
export function isWorker(threadId) {
  return String(threadId).startsWith("thread:delegated-task:");
}

// The T3 thread this agent runs in, from its Codex or Claude Code session id: the provider
// thread whose native ref carries it (sessions from before 0.1.0: the legacy runtime table).
export function sessionThread(provider, id, query = t3Query) {
  if (!id) return null;
  let rows = query("select distinct thread_id from orchestration_v2_projection_provider_threads where driver = ? and thread_id is not null and payload_json like ? limit 2", [provider, `%${id}%`]);
  if (!rows.length) rows = query("select distinct thread_id from provider_session_runtime where provider_name = ? and resume_cursor_json like ? limit 2", [provider, `%${id}%`]);
  return rows.length === 1 ? rows[0].thread_id : null;
}
export function currentThread(env = process.env, query = t3Query) {
  return sessionThread("codex", env.CODEX_SESSION_ID ?? env.CODEX_THREAD_ID, query) ?? sessionThread("claudeAgent", env.CLAUDE_CODE_SESSION_ID, query);
}

// The T3 project whose workspace root is one of `roots` (first match wins).
export function projectFor(roots, query = t3Query) {
  const projects = query("select project_id, workspace_root from projection_projects where deleted_at is null");
  for (const root of roots) {
    const p = projects.find((x) => path.resolve(x.workspace_root) === path.resolve(root));
    if (p) return p.project_id;
  }
  throw new Error(`no T3 project for ${roots[0]}; add it with \`t3 project add\``);
}

// --- Commands ------------------------------------------------------------------------------

const cmd = (send, label, c) => send({ commandId: randomUUID(), ...c }, label);

// Send a message into a thread. mode "auto" lets T3 pick for a busy thread (steer the running
// turn if the provider can, else queue); "queue" waits for the running turn; "start" starts a
// turn now. createdBy: "agent" (default: every script send is automation) or "user" (only a
// send that stands for the user, like a nudge they scheduled). Every send here is
// creationSource "server"; the user typing in T3 is "web" or "mobile", which is how a genuine
// reply of theirs is told apart. Resolves with the message id (pass `messageId` to make
// a retry idempotent).
const DISPATCH = { auto: { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }, queue: { dispatchMode: { type: "queue_after_active" } }, start: { dispatchMode: { type: "start_immediately" } } };
export async function sendMessage(threadId, text, { mode = "auto", createdBy = "agent", messageId = randomUUID(), modelSelection, label = "send message" } = {}, send = t3Command) {
  if (!DISPATCH[mode]) throw new Error(`sendMessage mode is ${Object.keys(DISPATCH).join(", ")}`);
  if (!text?.trim()) throw new Error("sendMessage needs text");
  if (!["user", "agent"].includes(createdBy)) throw new Error(`sendMessage createdBy is user or agent, got ${createdBy}`);
  await cmd(send, label, { type: "message.dispatch", createdBy, creationSource: "server", threadId, messageId, text, attachments: [], ...DISPATCH[mode], ...(modelSelection ? { modelSelection } : {}) });
  return messageId;
}

// Pins a thread in T3's sidebar (the same command as the client's pin button). Pinning lifts a
// snooze, so never pin a queued or usage-limited thread. Nothing pins a thread routinely:
// the user's own pins, a hand-off carrying one, and an outside tool's pin while a question of
// the thread waits on the user.
export async function pinThread(threadId, send = t3Command) { await cmd(send, "pin thread", { type: "thread.pin", threadId }); }
export async function unpinThread(threadId, send = t3Command) { await cmd(send, "unpin thread", { type: "thread.unpin", threadId }); }
export async function settleThread(threadId, send = t3Command) { await cmd(send, "settle thread", { type: "thread.settle", threadId }); }
export async function snoozeThread(threadId, untilIso, send = t3Command) {
  if (Number.isNaN(Date.parse(untilIso))) throw new Error(`snooze needs an ISO time, got ${untilIso}`);
  await cmd(send, "snooze thread", { type: "thread.snooze", threadId, snoozedUntil: new Date(untilIso).toISOString() });
}
export async function unsnoozeThread(threadId, send = t3Command) { await cmd(send, "unsnooze thread", { type: "thread.unsnooze", threadId, reason: "user" }); }

// --- Main threads --------------------------------------------------------------------------

// Claude models a main thread can run, on the configured main instance (t3.mainInstance).
const mainModels = { opus: "claude-opus-5-5", fable: "claude-fable-5-1", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
export function mainModelSelection(model = "opus", effort = "high") {
  const id = mainModels[model];
  if (!id) throw new Error(`--model is ${Object.keys(mainModels).join(", ")}`);
  return { instanceId: local().mainInstance, model: id, options: [{ id: "effort", value: effort }, ...(model === "opus" ? [{ id: "fastMode", value: false }] : [])] };
}

// A new thread (thread.create; the first message is a separate sendMessage). `branch` and
// `worktreePath` bind it to an existing worktree (both null: the project's main checkout).
export async function createThread({ threadId = randomUUID(), projectId, title, modelSelection, runtimeMode = "full-access", interactionMode = "default", createdBy = "user", branch = null, worktreePath = null }, send = t3Command) {
  await cmd(send, "create thread", { type: "thread.create", createdBy, creationSource: "server", threadId, projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath });
  return threadId;
}

// A main thread: created, then sent its first message. Not pinned: a working
// lead sits in T3's Working section, and an outside tool may pin it while a question of it waits
// on the user. `pin` (a hand-off carrying the user's own pin) pins it too. With `resume` (the same
// ids again after a crash or a failed step) each step that already happened is skipped, so a
// retry finishes the same thread instead of making a second one.
export async function createMainThread({ threadId, messageId, projectId, title, text, modelSelection, branch = null, worktreePath = null, resume = false, pin = false }, { send = t3Command, query = t3Query } = {}) {
  const row = resume ? query("select json_extract(payload_json, '$.pinnedAt') as pinned_at from orchestration_v2_projection_threads where thread_id = ?", [threadId])[0] : null;
  const sentFirst = resume && query("select 1 from orchestration_v2_projection_messages where message_id = ?", [messageId]).length > 0;
  if (!row) await createThread({ threadId, projectId, title, modelSelection, branch, worktreePath }, send);
  if (pin && !row?.pinned_at) await pinThread(threadId, send);
  if (!sentFirst) await sendMessage(threadId, text, { mode: "start", messageId, modelSelection, label: "main thread" }, send);
  return threadId;
}

// --- Health check --------------------------------------------------------------------------

// Does T3 still speak what this file speaks? Reads the tables, then (no side effects) gets a
// ticket, opens the socket, reads the server version, sends a message.dispatch to a thread that
// does not exist (a well-formed command fails with "No orchestration projection exists"; a
// schema change fails differently), and subscribes to the newest thread.
export async function checkT3({ label = "t3 check" } = {}) {
  const problems = [];
  let serverVersion = t3Version();
  try {
    for (const [table, cols] of Object.entries(t3Tables)) {
      const have = new Set(t3Query(`select name from pragma_table_info('${table}')`).map((r) => r.name));
      if (!have.size) problems.push(`statev2.sqlite has no table ${table}`);
      else for (const c of cols.filter((c) => !have.has(c))) problems.push(`${table} has no column ${c}`);
    }
  } catch (e) { problems.push(`statev2.sqlite: ${e.message}`); }
  let conn;
  try { conn = await t3Connect(label); } catch (e) { problems.push(e.message); }
  if (conn) {
    try {
      const config = await conn.request("server.getConfig", {}).catch((e) => { problems.push(`server.getConfig: ${e.message}`); return null; });
      const version = config?.environment?.serverVersion;
      if (config && !version) problems.push("server.getConfig has no environment.serverVersion");
      if (version) serverVersion = knownVersion = version;
      const fake = `t3-check-${randomUUID()}`;
      try {
        await conn.request("orchestration.dispatchCommand", { type: "message.dispatch", commandId: randomUUID(), createdBy: "user", creationSource: "server", threadId: fake, messageId: randomUUID(), text: "t3 check", attachments: [], dispatchMode: { type: "start_immediately" } });
        problems.push(`message.dispatch to the fake thread ${fake} was accepted`);
      } catch (e) { if (!e.message.includes("No orchestration projection exists")) problems.push(`message.dispatch: ${e.message}`); }
      const newest = t3Query("select thread_id from orchestration_v2_projection_threads where deleted_at is null order by updated_at desc limit 1")[0]?.thread_id;
      if (newest) {
        try {
          const chunk = await conn.request("orchestration.subscribeThread", { threadId: newest }, { stream: true });
          if (chunk?.kind !== "snapshot" || chunk.projection?.thread?.id !== newest) problems.push(`subscribeThread: first chunk is not {kind:"snapshot", projection:{thread}}: ${JSON.stringify(chunk).slice(0, 200)}`);
        } catch (e) { problems.push(`subscribeThread: ${e.message}`); }
      }
    } finally { conn.close(); }
  }
  return { ok: problems.length === 0, serverVersion, problems: problems.map((p) => (p.startsWith("T3 API changed") ? p : `T3 API changed (server ${serverVersion}): ${p}`)) };
}

// Run as a script (`node t3-api.mjs --check`, also through the ~/.agents/skills symlink: argv[1] is
// the link, import.meta.url the real file).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--check") {
  const r = await checkT3();
  console.log(r.ok ? `T3 ${r.serverVersion}: ok` : r.problems.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
