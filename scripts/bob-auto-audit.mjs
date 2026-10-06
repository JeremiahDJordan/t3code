#!/usr/bin/env node
// bob-auto-audit.mjs: what Bob's Auto mode did on this machine, for an agent or a person to judge.
//
// T3 writes three span kinds to its trace file while a Bob thread runs in Auto:
//   bob.auto.decision  every tool call Auto answered or asked about: the call, who decided (the
//                      rules, a user rule, the sandbox, or the reviewer model) and why
//   bob.auto.answer    the user's answer on a card Auto asked with
//   bob.auto.quote     what the reviewer took from each user message: sentences forbidding or
//                      allowing the agent something
// This script reads them from the trace file and its rotated backups, and, when it can, the user's
// messages from T3's database (opened read-only), and prints each reviewer decision with what the
// reviewer was judging by.
//
// Sources, read-only:
//   trace  $T3CODE_TRACE_FILE, else ~/.t3/userdata/logs/server.trace.ndjson   --trace PATH
//          plus its rotated backups (.1 to .$T3CODE_TRACE_MAX_FILES, default 10)
//   db     ~/.t3/userdata/statev2.sqlite, for the user's messages (Node 22.5+)   --t3-db PATH, --no-db
// Other flags: --since DAYS, --thread ID, --messages N (default 3), --all (every decision, not just
//   the reviewer's), --json (the joined records, one JSON document).
//
// The output holds the user's messages, commands and search queries: keep it on this machine.
//
// Auditing: a reviewer "allow" is wrong when the user's latest messages did not ask for that kind of
// action, or a restriction in force forbade it; a reviewer "ask" was needless when the user then
// allowed it. Rule decisions are deterministic and change only with the code or the user's rules.
// The trace file rotates (10 x 10 MB by default), so run this often enough to keep up.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const flag = (name) => argv.includes(name);
const HOME = NodeOS.homedir();
const USERDATA = NodePath.join(process.env.T3CODE_HOME ?? NodePath.join(HOME, ".t3"), "userdata");
const TRACE =
  opt("--trace") ??
  process.env.T3CODE_TRACE_FILE ??
  NodePath.join(USERDATA, "logs", "server.trace.ndjson");
const MAX_FILES = Number(process.env.T3CODE_TRACE_MAX_FILES ?? 10);
const DB = flag("--no-db")
  ? undefined
  : (opt("--t3-db") ?? NodePath.join(USERDATA, "statev2.sqlite"));
const SINCE = opt("--since") ? Date.now() - Number(opt("--since")) * 864e5 : 0;
const THREAD = opt("--thread");
const MESSAGES = Number(opt("--messages") ?? 3);

/** The trace file's rotated backups, oldest first, then the file itself. */
const traceFiles = [
  ...Array.from({ length: MAX_FILES }, (_, at) => `${TRACE}.${MAX_FILES - at}`),
  TRACE,
].filter((file) => NodeFS.existsSync(file));

const SPANS = new Set(["bob.auto.decision", "bob.auto.answer", "bob.auto.quote"]);

/** Every Auto span, in the order they ended. */
async function readSpans() {
  const spans = [];
  for (const file of traceFiles) {
    const lines = NodeReadline.createInterface({ input: NodeFS.createReadStream(file) });
    for await (const line of lines) {
      if (!line.includes('"bob.auto.')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!SPANS.has(record.name)) continue;
      const at = Number(BigInt(record.endTimeUnixNano ?? "0") / 1_000_000n);
      const a = record.attributes ?? {};
      if (at < SINCE || (THREAD && a["bob.thread"] !== THREAD)) continue;
      spans.push({ kind: record.name.slice("bob.auto.".length), at, a });
    }
  }
  return spans.toSorted((left, right) => left.at - right.at);
}

/** The user's messages by thread, oldest first; none without the database or `node:sqlite`. */
async function readMessages() {
  if (!DB || !NodeFS.existsSync(DB)) return new Map();
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    console.error("note: node:sqlite needs Node 22.5+; the user's messages are left out");
    return new Map();
  }
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  const byThread = new Map();
  try {
    const rows = db
      .prepare(
        "SELECT thread_id, created_at, payload_json FROM orchestration_v2_projection_messages WHERE role = 'user' ORDER BY created_at",
      )
      .all();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      if (payload.createdBy !== "user") continue;
      const list = byThread.get(row.thread_id) ?? [];
      list.push({ at: Date.parse(row.created_at), text: String(payload.text ?? "") });
      byThread.set(row.thread_id, list);
    }
  } finally {
    db.close();
  }
  return byThread;
}

const clip = (text, length = 400) =>
  text.length <= length ? text : `${text.slice(0, length)}… (${text.length} characters)`;
const when = (at) => new Date(at).toISOString().replace("T", " ").slice(0, 19);

const spans = await readSpans();
const messages = await readMessages();

// Each thread's quotes as of each decision, and each card's answer by tool call.
const answers = new Map(
  spans
    .filter((span) => span.kind === "answer")
    .map((span) => [span.a["bob.tool_call"], span.a["bob.answer"]]),
);
const quotesSoFar = new Map();
const records = [];
const tally = { quotes: 0, unquoted: 0, decisions: {}, answers: {} };
const bump = (table, key) => (table[key] = (table[key] ?? 0) + 1);
for (const span of spans) {
  const thread = span.a["bob.thread"] ?? "";
  if (span.kind === "quote") {
    if (span.a["bob.quoted"] === false) {
      tally.unquoted += 1;
      continue;
    }
    tally.quotes += 1;
    // A message's quotes in the order T3 keeps them: restrictions and permissions as written.
    const list = quotesSoFar.get(thread) ?? [];
    for (const text of span.a["bob.forbids"] ?? [])
      list.push({ kind: "forbids", text, at: span.at });
    for (const text of span.a["bob.allows"] ?? []) list.push({ kind: "allows", text, at: span.at });
    quotesSoFar.set(thread, list);
    continue;
  }
  if (span.kind !== "decision") continue;
  const by = String(span.a["bob.by"] ?? "");
  const decision = span.a["bob.decision"];
  const answer =
    decision === "ask" ? (answers.get(span.a["bob.tool_call"]) ?? "unanswered") : undefined;
  bump(tally.decisions, `${by.startsWith("reviewer") ? "reviewer" : by}: ${decision}`);
  if (answer !== undefined)
    bump(tally.answers, `${by.startsWith("reviewer") ? "reviewer" : by} asked → ${answer}`);
  records.push({
    at: when(span.at),
    thread,
    toolCall: span.a["bob.tool_call"],
    kind: span.a["bob.kind"],
    call: span.a["bob.call"],
    decision,
    by,
    reason: span.a["bob.reason"],
    ...(answer === undefined ? {} : { userAnswer: answer }),
    quotedSoFar: (quotesSoFar.get(thread) ?? []).map(({ kind, text }) => `${kind}: ${text}`),
    userMessages: (messages.get(thread) ?? [])
      .filter((message) => message.at <= span.at)
      .slice(-MESSAGES)
      .map((message) => `${when(message.at)} ${clip(message.text)}`),
  });
}

if (flag("--json")) {
  console.log(JSON.stringify({ traceFiles, tally, records }, null, 2));
  process.exit(0);
}

const tilde = (path) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);
console.log(`Bob Auto audit from ${traceFiles.map(tilde).join(", ") || "(no trace file found)"}`);
if (spans.length === 0) {
  console.log(
    "No Auto records. They are written by a T3 with Bob's Auto audit spans, for Bob threads in Auto.",
  );
  process.exit(0);
}
console.log(`From ${when(spans[0].at)} to ${when(spans.at(-1).at)}\n`);
console.log("Decisions:");
for (const [key, count] of Object.entries(tally.decisions).toSorted((l, r) => r[1] - l[1]))
  console.log(`  ${String(count).padStart(5)}  ${key}`);
console.log("\nThe user's answers when Auto asked:");
for (const [key, count] of Object.entries(tally.answers).toSorted((l, r) => r[1] - l[1]))
  console.log(`  ${String(count).padStart(5)}  ${key}`);
console.log(`\nMessages quoted: ${tally.quotes}, could not quote: ${tally.unquoted}`);

const shown = flag("--all")
  ? records
  : records.filter((record) => record.by.startsWith("reviewer"));
console.log(
  `\n${flag("--all") ? "Every decision" : "The reviewer's decisions"} (${shown.length}):`,
);
for (const record of shown) {
  console.log(
    `\n[${record.at}] ${record.decision.toUpperCase()} by ${record.by} · thread ${record.thread}`,
  );
  console.log(`  call:    ${record.call}`);
  console.log(`  reason:  ${record.reason}`);
  if (record.userAnswer) console.log(`  user:    ${record.userAnswer}`);
  if (record.quotedSoFar.length > 0) {
    console.log("  quoted from the user so far, oldest first:");
    for (const quote of record.quotedSoFar) console.log(`    - ${quote}`);
  }
  if (record.userMessages.length > 0) {
    console.log("  the user's latest messages:");
    for (const message of record.userMessages) console.log(`    ${message}`);
  }
}
