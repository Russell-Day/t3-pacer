// Test preload: a fake T3 server for running t3-thread.mjs, pacer.mjs and the other T3 scripts
// end to end, offline. `node --import <this file> script.mjs ...` with FAKE_T3=<json file>:
//   { projects: [{ project_id, workspace_root }],
//     threads: [{ thread_id, title, project_id, model_selection_json, pinned_at, settled_at,
//                 settled_override, snoozed_until, snoozed_at, archived_at, deleted_at, lineage, … }],
//     runs: [{ run_id, thread_id, ordinal, status, requested_at, completed_at, started_at }],
//     messages: [{ thread_id, message_id, run_id, role, text, created_at, created_by, creation_source }],
//     items: [{ thread_id, run_id, type, status, updated_at, payload }]  (v2 turn items),
//     activities: [{ thread_id, kind, created_at, payload_json }]  (pre-0.1.0 compactions),
//     providerThreads: [{ thread_id, driver, native_id }], usage: <usage.mjs --json>,
//     providers: [<server.getConfig provider>], commands: [] }
// Queries on T3 0.1.0 tables run for real: the JSON becomes an in-memory SQLite DB built from
// statev2-schema.sql (T3's own DDL). Older queries (pacer, until it moves to t3-api.mjs) are
// answered by substring. Every command is appended to `commands` and applied; message.dispatch
// opens a run that ends at once with "fake reply", or with what `globalThis.fakeT3Outcome(thread,
// command, db)` returns ({ status, reply, error: { class, message } }), which a test preload can
// set. A message.dispatch missing a required key fails the way T3 does (a Die). thread.settle is
// refused as T3 refuses it (a live run or a queued message), and always for the thread ids in
// FAKE_SETTLE_REFUSE (comma-separated, or *).
// HOME should point at a temp dir with .t3/userdata/server-runtime.json so nothing reaches
// the real server.
import child from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const file = process.env.FAKE_T3;
if (!file) throw new Error("FAKE_T3 is not set");
const schema = path.join(path.dirname(new URL(import.meta.url).pathname), "statev2-schema.sql");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (db) => fs.writeFileSync(file, JSON.stringify(db, null, 2));
const open = (t) => !t.deleted_at && !t.archived_at && !t.settled_at;
const real = child.execFileSync;

// The JSON db as rows of T3's v2 tables (column names as in statev2-schema.sql).
function v2Tables(db) {
  const now = new Date().toISOString();
  const sel = (t) => (t.model_selection_json ? JSON.parse(t.model_selection_json) : null);
  const root = (runId) => `${runId}:root`;
  return {
    orchestration_v2_projection_threads: db.threads.map((t) => ({
      thread_id: t.thread_id, project_id: t.project_id ?? "proj-1", title: t.title ?? "", default_provider: "fake",
      runtime_mode: "full-access", interaction_mode: "default", created_at: t.created_at ?? now, updated_at: t.updated_at ?? now,
      archived_at: t.archived_at ?? null, deleted_at: t.deleted_at ?? null, provider_instance_id: sel(t)?.instanceId ?? null,
      payload_json: JSON.stringify({
        id: t.thread_id, title: t.title ?? "", projectId: t.project_id ?? "proj-1", modelSelection: sel(t), providerInstanceId: sel(t)?.instanceId ?? null,
        runtimeMode: "full-access", interactionMode: "default", archivedAt: t.archived_at ?? null, deletedAt: t.deleted_at ?? null,
        settledAt: t.settled_at ?? null, settledOverride: t.settled_override ?? null, snoozedUntil: t.snoozed_until ?? null, snoozedAt: t.snoozed_at ?? null, pinnedAt: t.pinned_at ?? null,
        lineage: t.lineage ?? null, createdBy: t.created_by ?? "user", creationSource: t.creation_source ?? "server",
        branch: t.branch ?? null, worktreePath: t.worktree_path ?? null,
      }),
    })),
    orchestration_v2_projection_runs: (db.runs ?? []).map((r) => ({
      run_id: r.run_id, thread_id: r.thread_id, ordinal: r.ordinal, provider: "fake", status: r.status, requested_at: r.requested_at ?? now,
      completed_at: r.completed_at ?? null, payload_json: JSON.stringify({ id: r.run_id, rootNodeId: root(r.run_id), queueHeld: r.queue_held ?? false, modelSelection: r.model_selection ?? null,
        startedAt: r.started_at !== undefined ? r.started_at : r.status === "queued" ? null : r.requested_at ?? now }),
    })),
    orchestration_v2_projection_messages: (db.messages ?? []).map((m, i) => ({
      message_id: m.message_id ?? `msg-${i}`, thread_id: m.thread_id, run_id: m.run_id ?? null, role: m.role, streaming: 0,
      created_at: m.created_at ?? now, updated_at: m.created_at ?? now, payload_json: JSON.stringify({ text: m.text, role: m.role, createdBy: m.created_by ?? "user", creationSource: m.creation_source ?? null }),
    })),
    orchestration_v2_projection_turn_items: (db.items ?? []).map((it, i) => ({
      turn_item_id: `item-${i}`, thread_id: it.thread_id, run_id: it.run_id ?? null, node_id: it.run_id ? root(it.run_id) : null, ordinal: i,
      type: it.type, status: it.status ?? "completed", updated_at: it.updated_at ?? now, payload_json: JSON.stringify({ type: it.type, ...it.payload }),
    })),
    orchestration_v2_projection_provider_threads: (db.providerThreads ?? []).map((p, i) => ({
      provider_thread_id: `pt-${i}`, thread_id: p.thread_id, provider: p.driver, driver: p.driver, status: "idle", updated_at: now,
      payload_json: JSON.stringify({ nativeThreadRef: { nativeId: p.native_id } }),
    })),
    projection_projects: db.projects.map((p) => ({ project_id: p.project_id, title: "", workspace_root: p.workspace_root, scripts_json: "[]", created_at: now, updated_at: now })),
    projection_thread_activities: (db.activities ?? []).map((a, i) => ({
      activity_id: `act-${i}`, thread_id: a.thread_id, tone: "info", kind: a.kind ?? "context-compaction", summary: "", payload_json: a.payload_json ?? "{}", created_at: a.created_at,
    })),
  };
}

const sqlite = `import json,sqlite3,sys
c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
c.executescript(open(sys.argv[1]).read())
for t,rows in json.load(sys.stdin).items():
  for r in rows: c.execute('insert into %s (%s) values (%s)' % (t, ','.join(r), ','.join('?'*len(r))), list(r.values()))
print(json.dumps([dict(x) for x in c.execute(sys.argv[2], json.loads(sys.argv[3]))]))`;
const v2Query = (sql, params) => JSON.parse(real.call(child, "python3", ["-c", sqlite, schema, sql, JSON.stringify(params)], { input: JSON.stringify(v2Tables(read())), encoding: "utf8" }));

function query(sql, params) {
  if (/orchestration_v2_|pragma_table_info|provider_session_runtime|projection_thread_activities|from projection_projects/.test(sql)) return v2Query(sql, params);
  const db = read();
  const thread = (id) => db.threads.find((t) => t.thread_id === id);
  if (/activities|left join projection_projects/.test(sql)) return [];
  if (sql.includes("projection_thread_messages")) {
    if (sql.includes("message_id=?")) return (db.messages ?? []).filter((m) => m.message_id === params[0]).map(() => ({ 1: 1 }));
    const role = /role='(\w+)'/.exec(sql)?.[1];
    return (db.messages ?? []).filter((m) => m.thread_id === params[0] && (!role || m.role === role) && (params[1] == null || m.created_at > params[1]))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  if (sql.includes("from projection_threads t") && sql.includes("where t.thread_id=?")) return [thread(params[0])].filter(Boolean);
  if (sql.includes("from projection_threads t")) return db.threads.filter(open);
  if (sql.includes("from projection_threads where thread_id=?")) return [thread(params[0])].filter(Boolean);
  throw new Error(`fake T3: unhandled query ${sql.slice(0, 80)}`);
}

// message.dispatch's required keys (T3 0.1.0's schema); a missing one is a decode defect.
const dispatchKeys = ["commandId", "createdBy", "creationSource", "threadId", "messageId", "text", "attachments", "dispatchMode"];

function apply(c) {
  const db = read();
  db.commands = [...(db.commands ?? []), c];
  const t = db.threads.find((x) => x.thread_id === c.threadId);
  const at = new Date().toISOString();
  if (c.type === "thread.create") db.threads.push({ thread_id: c.threadId, title: c.title, project_id: c.projectId, model_selection_json: JSON.stringify(c.modelSelection), pinned_at: null, session_status: "idle", created_by: c.createdBy, branch: c.branch ?? null, worktree_path: c.worktreePath ?? null, created_at: at, updated_at: at });
  else if (c.type === "thread.pin" && t) t.pinned_at = at;
  else if (c.type === "thread.unpin" && t) t.pinned_at = null;
  else if ((c.type === "thread.meta.update" || c.type === "thread.metadata.update") && t) t.title = c.title ?? t.title;
  else if (c.type === "thread.settle" && t) {
    const runs = (db.runs ?? []).filter((r) => r.thread_id === c.threadId);
    const blocker = (process.env.FAKE_SETTLE_REFUSE ?? "").split(",").some((id) => id === c.threadId || id === "*") ? "is waiting on an approval or question. Answer it before settling."
      : runs.some((r) => ["preparing", "starting", "running", "waiting"].includes(r.status)) ? "is still running. Stop it before settling."
      : runs.some((r) => r.status === "queued") ? "has a queued message. Send it or remove it from the queue before settling." : null;
    if (blocker) { write(db); return { error: { _tag: "Fail", error: { _tag: "OrchestratorDispatchError", message: `Thread ${c.threadId} ${blocker}` } } }; }
    t.settled_at = at;
  }
  else if (c.type === "thread.unsettle" && t) { t.settled_at = null; t.settled_override = "active"; }
  else if (c.type === "thread.snooze" && t) { t.snoozed_until = c.snoozedUntil; t.snoozed_at = at; }
  else if (c.type === "thread.unsnooze" && t) t.snoozed_until = null;
  else if (c.type === "thread.archive" && t) t.archived_at = at;
  else if (c.type === "thread.delete" && t) t.deleted_at = at;
  else if (c.type === "thread.turn.start") db.messages = [...(db.messages ?? []), { thread_id: c.threadId, message_id: c.message.messageId, role: "user", text: c.message.text, created_at: at }];
  else if (c.type === "message.dispatch") {
    if (!t) { write(db); return { error: { _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: `No orchestration projection exists for thread ${c.threadId}.` } } }; }
    const runs = (db.runs ??= []);
    const ordinal = runs.filter((r) => r.thread_id === c.threadId).length + 1;
    const run_id = `run:${c.threadId}:${ordinal}`;
    if (c.modelSelection) t.model_selection_json = JSON.stringify(c.modelSelection);
    const o = globalThis.fakeT3Outcome?.(t, c, db) ?? {};
    const status = o.status ?? (o.error ? "failed" : "completed");
    runs.push({ run_id, thread_id: c.threadId, ordinal, status, requested_at: at, completed_at: ["completed", "failed", "interrupted"].includes(status) ? at : null, model_selection: c.modelSelection ?? null });
    db.messages = [...(db.messages ?? []), { thread_id: c.threadId, message_id: c.messageId, run_id, role: "user", text: c.text, created_at: at, created_by: c.createdBy, creation_source: c.creationSource }];
    const reply = o.reply === undefined ? (o.error ? null : "fake reply") : o.reply;
    if (reply) db.messages.push({ thread_id: c.threadId, message_id: `${run_id}:reply`, run_id, role: "assistant", text: reply, created_at: at });
    if (o.error) db.items = [...(db.items ?? []), { thread_id: c.threadId, run_id, type: "error", status: "failed", updated_at: at, payload: { failure: { retryable: false, ...o.error } } }];
    t.updated_at = at;
  } else if (c.type === "queued-run.cancel") {
    const r = (db.runs ?? []).find((x) => x.run_id === c.runId && x.status === "queued");
    if (r) Object.assign(r, { status: "cancelled", completed_at: at, started_at: null });
  } else if (c.type === "run.interrupt") {
    const r = (db.runs ?? []).find((x) => x.run_id === c.runId);
    if (r) { r.status = "interrupted"; r.completed_at = at; }
  }
  write(db);
  return {};
}

child.execFileSync = function (cmd, args = [], opts) {
  const out = (v) => (opts?.encoding ? v : Buffer.from(v));
  if (cmd === "t3") return out(args[0] === "--version" ? "t3 v0.1.0-fake\n" : "fake-token\n");
  if (cmd === "python3" && args[0] === "-c" && args.length >= 5) return out(JSON.stringify(query(args[3], JSON.parse(args[4]))));
  if (cmd === "python3" && args[0] === "-c" && args.length === 2) return out(JSON.stringify(read().projects.map((p) => [p.project_id, p.workspace_root]))); // old t3-thread.mjs project lookup
  if (args.some((a) => String(a).endsWith("/usage.mjs"))) return out(JSON.stringify(read().usage ?? []));
  return real.call(this, cmd, args, opts);
};
syncBuiltinESMExports();

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ticket: "fake-ticket" }) });
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen?.()); }
  close() {}
  send(raw) {
    const r = JSON.parse(raw);
    const reply = (m) => setImmediate(() => this.onmessage?.({ data: JSON.stringify({ requestId: r.id, ...m }) }));
    const fail = (cause) => reply({ _tag: "Exit", exit: { _tag: "Failure", cause: [cause] } });
    if (r.tag === "orchestration.dispatchCommand") {
      const missing = r.payload.type === "message.dispatch" && dispatchKeys.find((k) => r.payload[k] === undefined);
      if (missing) return fail({ _tag: "Die", defect: `Missing key at ["${missing}"]` });
      const { error } = apply(r.payload);
      if (error) return fail(error);
      reply({ _tag: "Exit", exit: { _tag: "Success", value: {} } });
    } else if (r.tag === "orchestration.subscribeThread") {
      const t = read().threads.find((x) => x.thread_id === r.payload.threadId);
      reply({ _tag: "Chunk", values: [{ kind: "snapshot", snapshotSequence: 1, projection: { thread: t ? { id: t.thread_id, title: t.title } : null, runs: [], messages: [] } }] });
    } else if (r.tag === "server.getConfig") reply({ _tag: "Exit", exit: { _tag: "Success", value: { environment: { serverVersion: "0.1.0-fake" }, providers: read().providers ?? [] } } });
    else if (r.tag === "server.refreshProviders") reply({ _tag: "Exit", exit: { _tag: "Success", value: {} } });
    else fail(`fake T3: unhandled ${r.tag}`);
  }
};
