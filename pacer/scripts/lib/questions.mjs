// The optional open-questions hook (config.json "questions"): threads that asked the user
// something outside T3 (through your notifier, say) and still wait for the answer. T3's own
// pending questions and approvals (pending_user_input_count / pending_approval_count) need no
// hook; the pacer reads those itself.
//
//   "questions": { "file": "/path/to/questions.json" }        a JSON file, or
//   "questions": { "command": "my-notifier open-questions" }  a command printing the same JSON
//
// The JSON maps a T3 thread id to its open questions, oldest first:
//   { "<thread id>": [{ "id": "q1", "question": "Ship it?", "at": "<ISO time>" }] }
// Only "id" is used (in refusals); the rest is for people reading it. A thread with no open
// question is left out or has []. Whatever writes it decides when a question is answered.
// No hook: nothing is open. A missing file: nothing is open. A file or command output that
// doesn't parse, or a failing command, throws: an unreadable record is never "no questions".
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function parseQuestions(text, source) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`questions from ${source} don't parse (${e.message})`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`questions from ${source}: not a JSON object of thread id → questions`);
  const out = new Map();
  for (const [threadId, asks] of Object.entries(data)) {
    if (!Array.isArray(asks)) throw new Error(`questions from ${source}: ${threadId} is not a list`);
    if (asks.length) out.set(threadId, asks);
  }
  return out;
}

// Map thread id → [question], from the hook in `cfg.questions`.
export function readQuestions(cfg = {}) {
  const q = cfg.questions;
  if (q?.command) {
    const out = execFileSync("sh", ["-c", q.command], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    return parseQuestions(out.trim() || "{}", "questions.command");
  }
  if (q?.file) {
    let text;
    try { text = fs.readFileSync(q.file, "utf8"); } catch (e) { if (e.code === "ENOENT") return new Map(); throw e; }
    return parseQuestions(text, q.file);
  }
  return new Map();
}

// One line naming a thread's open questions, for refusals.
export const asksLine = (asks) => `${asks.length} question${asks.length > 1 ? "s" : ""} for the user still open (${asks.map((a) => a.id ?? a.key ?? "?").join(", ")})`;
