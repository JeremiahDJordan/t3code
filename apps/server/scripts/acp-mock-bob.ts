#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * A stand-in for IBM Bob Shell's `bob acp`, for the Bob adapter and text generation tests.
 *
 * Bob 2.0.5 speaks ACP protocol 1, so this answers raw JSON-RPC in that shape rather than going
 * through effect-acp's agent, which speaks protocol 2. It behaves the way Bob does where T3
 * depends on it: sessions carry Bob's modes (Agent, Ask, Plan and a custom mode) and switch with
 * `session/set_mode`, commands arrive after a session opens, tool titles are HTML-escaped,
 * subagents run as a "Running subagent: …" tool call with the report in `<task_result>` tags,
 * and tasks move with `_bob/task/export` and `_bob/task/import`.
 *
 * A prompt's text picks what Bob does: "use a subagent", "run a command", "say nothing" (an
 * empty reply), "work slowly", which runs a tool call until `T3_ACP_BOB_RELEASE_PATH` exists
 * (logged as `_mock/released`) and then keeps the prompt open until `session/cancel`, and
 * "finish later", whose tool call runs until that file exists and which then replies.
 * Environment: `T3_ACP_REQUEST_LOG_PATH` logs every request;
 * `T3_ACP_PROMPT_RESPONSE_TEXT` sets the reply; `T3_ACP_FAIL_PROMPT` fails prompts;
 * `T3_ACP_BOB_SIGNED_OUT` and `T3_ACP_BOB_LICENSE_REQUIRED` refuse sessions as Bob does;
 * `T3_ACP_BOB_RESUME_NOT_FOUND` makes every resume fail as an unknown task;
 * `T3_ACP_BOB_STATE_PATH` keeps the tasks in a file, so every mock Bob shares them as real Bobs
 * share their task database.
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";
const signedOut = process.env.T3_ACP_BOB_SIGNED_OUT === "1";
const licenseRequired = process.env.T3_ACP_BOB_LICENSE_REQUIRED === "1";
const resumeNotFound = process.env.T3_ACP_BOB_RESUME_NOT_FOUND === "1";
const statePath = process.env.T3_ACP_BOB_STATE_PATH;
const releasePath = process.env.T3_ACP_BOB_RELEASE_PATH;

type Json = Record<string, unknown>;
interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}
class Refusal {
  readonly error: RpcError;
  constructor(error: RpcError) {
    this.error = error;
  }
}

const availableModes = [
  { id: "agent", name: "Agent", description: "General-purpose coding" },
  { id: "ask", name: "Ask", description: "Answer questions without changing files" },
  { id: "plan", name: "Plan", description: "Plan before building" },
  { id: "reviewer", name: "Reviewer", description: "A custom mode" },
];
let currentModeId = "agent";
const modes = () => ({ currentModeId, availableModes });

let tasks = new Map<string, { readonly cwd: string; readonly messages: Array<Json> }>();
let nextTaskNumber = 1;
function loadState(): void {
  if (!statePath || !NodeFS.existsSync(statePath)) return;
  const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as {
    readonly nextTaskNumber: number;
    readonly tasks: Record<string, { readonly cwd: string; readonly messages: Array<Json> }>;
  };
  nextTaskNumber = state.nextTaskNumber;
  tasks = new Map(Object.entries(state.tasks));
}
function saveState(): void {
  if (!statePath) return;
  NodeFS.writeFileSync(
    statePath,
    JSON.stringify({ nextTaskNumber, tasks: Object.fromEntries(tasks) }),
    "utf8",
  );
}
function newTask(cwd: string, prefix = "mock-session-"): string {
  const id = `${prefix}${nextTaskNumber++}`;
  tasks.set(id, { cwd, messages: [] });
  return id;
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function notify(sessionId: string, update: Json): void {
  send({ method: "session/update", params: { sessionId, update } });
}
function publishCommands(sessionId: string): void {
  notify(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "init", description: "Set up Bob in this project" },
      { name: "review", description: "Review a change", input: { hint: "what to review" } },
    ],
  });
}

/** Bob's setup refusals, which it raises when a session opens. */
function refuseSetup(): void {
  if (signedOut) throw new Refusal({ code: -32000, message: "Authentication required" });
  if (licenseRequired) {
    throw new Refusal({
      code: -32600,
      message: "Invalid request: Run bob with --accept-license to accept the license.",
    });
  }
}

function resume(params: Json): Json {
  refuseSetup();
  const sessionId = String(params.sessionId);
  const cwd = String(params.cwd);
  const task = tasks.get(sessionId);
  // Bob refuses a task it does not have, or one from another folder.
  if (resumeNotFound || (task !== undefined && task.cwd !== cwd)) {
    throw new Refusal({
      code: -32002,
      message: `Resource not found: ${sessionId}`,
      data: { uri: sessionId },
    });
  }
  if (task === undefined) tasks.set(sessionId, { cwd, messages: [] });
  setImmediate(() => publishCommands(sessionId));
  return { modes: modes() };
}

function promptText(prompt: unknown): string {
  return Array.isArray(prompt)
    ? prompt
        .flatMap((part) =>
          typeof part === "object" && part !== null && part.type === "text" ? [part.text] : [],
        )
        .join("\n")
    : "";
}

function runPrompt(params: Json): Json {
  const sessionId = String(params.sessionId);
  const text = promptText(params.prompt);
  const task = tasks.get(sessionId);
  // Bob's prompts are seconds apart; the mock's can share a millisecond, so each stamp follows
  // the task's last one.
  const previous = Math.max(
    0,
    ...(task?.messages ?? []).map((message) => {
      const meta = (message.data as Json | undefined)?._meta as
        | { readonly timestamp?: number }
        | undefined;
      return meta?.timestamp ?? 0;
    }),
  );
  const timestamp = Math.max(Date.now(), previous + 1);
  task?.messages.push({ role: "user", data: { content: text, _meta: { timestamp } } });
  if (failPrompt) {
    throw new Refusal({
      code: -32603,
      message: "Internal error",
      data: { details: "Mock prompt failure" },
    });
  }
  if (text.includes("say nothing")) return { stopReason: "end_turn" };
  if (text.includes("use a subagent")) {
    const description = "Count the files";
    notify(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "subagent-1",
      title: `Running subagent: ${description}`,
      kind: "other",
      status: "in_progress",
      rawInput: { description },
    });
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "subagent-1",
      status: "completed",
      rawOutput: { result: "<task_result>There are 2 files.</task_result>" },
    });
  }
  if (text.includes("run a command")) {
    notify(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "command-1",
      title: "echo a&#x3D;b",
      kind: "execute",
      status: "completed",
    });
  }
  const reply =
    currentModeId === "plan"
      ? "## Plan\n\n1. Read the code.\n2. Change it."
      : (promptResponseText ?? "Hello from Bob.");
  notify(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: reply },
  });
  task?.messages.push({ role: "assistant", data: { content: reply } });
  return { stopReason: "end_turn" };
}

function handle(method: string, params: Json): Json {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentInfo: { name: "bob-mock", version: "2.0.5" },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
        },
        // Bob's only method opens an IBM SSO browser, which T3 must never call.
        authMethods: [{ id: "sso", name: "IBM SSO" }],
      };
    case "authenticate":
      throw new Refusal({ code: -32603, message: "The mock Bob never signs in through ACP." });
    case "session/new": {
      refuseSetup();
      const sessionId = newTask(String(params.cwd));
      setImmediate(() => publishCommands(sessionId));
      return { sessionId, modes: modes() };
    }
    case "session/resume":
    case "session/load":
      return resume(params);
    case "session/set_mode":
      currentModeId = String(params.modeId);
      setImmediate(() =>
        notify(String(params.sessionId), { sessionUpdate: "current_mode_update", currentModeId }),
      );
      return {};
    case "session/prompt":
      return runPrompt(params);
    case "session/close":
      return {};
    case "session/delete":
      tasks.delete(String(params.sessionId));
      return {};
    case "_bob/task/export": {
      const sessionId = String(params.sessionId);
      const task = tasks.get(sessionId);
      if (task === undefined) {
        throw new Refusal({ code: -32002, message: `Resource not found: ${sessionId}` });
      }
      return {
        version: 1,
        tasks: [
          {
            task: { id: sessionId, env: { staticEnvInfo: { primaryWorkspace: task.cwd } } },
            messages: task.messages,
          },
        ],
      };
    }
    case "_bob/task/import": {
      const snapshot = params.snapshot as {
        readonly tasks?: ReadonlyArray<{ readonly messages?: Array<Json> }>;
      };
      const id = newTask(String(params.cwd), "mock-imported-");
      tasks.get(id)?.messages.push(...(snapshot.tasks?.[0]?.messages ?? []));
      return { sessionIds: [id] };
    }
    default:
      throw new Refusal({ code: -32601, message: `Method not found: ${method}` });
  }
}

/** The "work slowly" prompt waiting for `session/cancel`, by session. */
const cancellablePrompts = new Map<string, number | string>();

/** Runs a tool call until the release file exists, then waits for the prompt to be cancelled. */
function workSlowly(id: number | string, sessionId: string): void {
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "slow-1",
    title: "sleep 60",
    kind: "execute",
    status: "in_progress",
  });
  const timer = setInterval(() => {
    if (!releasePath || !NodeFS.existsSync(releasePath)) return;
    clearInterval(timer);
    if (requestLogPath) {
      NodeFS.appendFileSync(requestLogPath, `${JSON.stringify({ method: "_mock/released" })}\n`);
    }
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "slow-1",
      status: "completed",
    });
    cancellablePrompts.set(sessionId, id);
  }, 10);
}

/**
 * Runs a quick tool call to its end, then a subagent and a tool call until the release file
 * exists, then ends both, replies and ends the prompt.
 */
function finishLater(id: number | string, sessionId: string): void {
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "quick-before",
    title: "ls",
    kind: "execute",
    status: "in_progress",
  });
  notify(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "quick-before",
    status: "completed",
  });
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "subagent-later",
    title: "Running subagent: Count the files",
    kind: "other",
    status: "in_progress",
    rawInput: { description: "Count the files" },
  });
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "slow-later",
    title: "sleep 60",
    kind: "execute",
    status: "in_progress",
  });
  const timer = setInterval(() => {
    if (!releasePath || !NodeFS.existsSync(releasePath)) return;
    clearInterval(timer);
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "slow-later",
      status: "completed",
    });
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "subagent-later",
      status: "completed",
      rawOutput: { result: "<task_result>There are 2 files.</task_result>" },
    });
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Finished after the restart." },
    });
    send({ id, result: { stopReason: "end_turn" } });
  }, 10);
}

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (requestLogPath) NodeFS.appendFileSync(requestLogPath, `${line}\n`, "utf8");
  const message = JSON.parse(line) as {
    readonly id?: number | string;
    readonly method?: string;
    readonly params?: Json;
  };
  if (message.method === "session/cancel") {
    const sessionId = String(message.params?.sessionId);
    const pending = cancellablePrompts.get(sessionId);
    if (pending !== undefined) {
      cancellablePrompts.delete(sessionId);
      send({ id: pending, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (
    message.method === "session/prompt" &&
    message.id !== undefined &&
    promptText(message.params?.prompt).includes("work slowly")
  ) {
    workSlowly(message.id, String(message.params?.sessionId));
    return;
  }
  if (
    message.method === "session/prompt" &&
    message.id !== undefined &&
    promptText(message.params?.prompt).includes("finish later")
  ) {
    finishLater(message.id, String(message.params?.sessionId));
    return;
  }
  // Notifications and responses to Bob's own requests need no answer.
  if (message.id === undefined || message.method === undefined) return;
  try {
    loadState();
    const result = handle(message.method, message.params ?? {});
    saveState();
    send({ id: message.id, result });
  } catch (cause) {
    if (!(cause instanceof Refusal)) throw cause;
    send({ id: message.id, error: cause.error });
  }
});
