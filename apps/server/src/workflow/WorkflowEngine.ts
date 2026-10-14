/**
 * The workflow engine: runs a coordinator thread's turn by executing its
 * script. Each `agent()` call is an ordinary delegated task of the coordinator,
 * dispatched in process with `owner_observes`, so the engine watches the
 * child's row instead of being woken. Child ids derive from a hash of the
 * call, its occurrence and its attempt, which is what makes a rerun reuse
 * finished agents and wait on live ones.
 */
import {
  MessageId,
  type NodeId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Subagent,
  PlanId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { delegateTaskCommandId } from "../mcp/OrchestratorMcpService.ts";
import {
  WORKFLOW_DRIVER,
  WorkflowEngineHost,
  type WorkflowTurn,
} from "../orchestration-v2/Adapters/WorkflowAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  checkResultSchema,
  structuredResultFromText,
  structuredTaskPrompt,
} from "../orchestration-v2/StructuredResult.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  parseWorkflowInvocation,
  type WorkflowInvocation,
  type WorkflowRoleBinding,
} from "./WorkflowInvocation.ts";
import { clampWorkflowRoleBinding } from "./WorkflowRoles.ts";
import * as WorkflowExec from "./WorkflowExec.ts";
import * as WorkflowSandbox from "./WorkflowSandbox.ts";
import { claudeModelRole } from "./WorkflowScript.ts";
import * as WorkflowSourceStore from "./WorkflowSourceStore.ts";
import * as WorkflowWorkspaces from "./WorkflowWorkspaces.ts";

const MAX_LOG_CHARS = 4_000;
const MAX_LABEL_CHARS = 200;
/** Distinct phases a run may show; later titles are not added. */
const MAX_PHASES = 50;
/** Refused requests a call steps past before it gives up starting. */
const MAX_REFUSED_ATTEMPTS = 100;
/** `exec()` commands one run runs at once; the rest wait their turn. */
const MAX_CONCURRENT_EXECS = 2;
const MAX_EXEC_ENV = 100;
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const toIndentedJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const isTerminal = (status: OrchestrationV2Subagent["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

const hashKey = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(toJsonText(value)))).slice(0, 16);

const scriptError = (reason: string) =>
  new WorkflowSandbox.WorkflowScriptError({ reason, line: null });

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * A finished script's value as its run's result. A value that is not text reads as a JSON block,
 * which the thread shows as code and an agent still reads as the result. An object's string
 * `summary` leads, as prose, ahead of its other fields, so a result cut to fit an agent's tool
 * output still opens with it.
 */
function workflowResultText(value: unknown): string {
  if (typeof value === "string") return value;
  const block = (data: unknown) => `\`\`\`json\n${toIndentedJsonText(data)}\n\`\`\``;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return block(value);
  const { summary, ...rest } = value as Record<string, unknown>;
  if (typeof summary !== "string" || summary.trim() === "") return block(value);
  return Object.keys(rest).length === 0 ? summary : `${summary}\n\n${block(rest)}`;
}

interface AgentCall {
  readonly prompt: string;
  readonly label: string | undefined;
  readonly phase: string | undefined;
  readonly schema: Record<string, unknown> | undefined;
  readonly role: string | undefined;
  readonly workspace: string | undefined;
  readonly isolated: boolean;
  readonly effort: string | undefined;
}

const T3_OPTIONS = new Set(["as", "label", "phase", "schema", "workspace", "effort"]);
const CLAUDE_OPTIONS = new Set(["label", "phase", "schema", "model", "effort", "isolation"]);

/** Reads an `agent()` call's options, refusing anything the dialect does not have. */
function decodeAgentCall(
  request: unknown,
  dialect: WorkflowInvocation["dialect"],
): Result.Result<AgentCall, string> {
  const { prompt, opts } = (request ?? {}) as {
    readonly prompt?: unknown;
    readonly opts?: unknown;
  };
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return Result.fail("agent(prompt, opts) needs a non-empty prompt string.");
  }
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    return Result.fail("agent() options must be an object.");
  }
  const options = opts as Record<string, unknown>;
  const allowed = dialect === "t3" ? T3_OPTIONS : CLAUDE_OPTIONS;
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      return Result.fail(
        dialect === "t3" && key === "model"
          ? "agent(): name a role with `as` instead of a model; roles keep a workflow portable."
          : `agent(): option "${key}" is not supported.`,
      );
    }
  }
  const text = (key: string) => {
    const value = options[key];
    return value === undefined
      ? Result.succeed(undefined)
      : typeof value === "string" && value.trim() !== ""
        ? Result.succeed(value.trim())
        : Result.fail(`agent(): ${key} must be a non-empty string.`);
  };
  const label = text("label");
  const phase = text("phase");
  const effort = text("effort");
  const role = text(dialect === "t3" ? "as" : "model");
  for (const field of [label, phase, effort, role]) {
    if (Result.isFailure(field)) return Result.fail(field.failure);
  }
  const schema = options.schema;
  if (
    schema !== undefined &&
    (typeof schema !== "object" || schema === null || Array.isArray(schema))
  ) {
    return Result.fail("agent(): schema must be a JSON Schema object.");
  }
  if (schema !== undefined) {
    const usable = checkResultSchema(schema);
    if (Result.isFailure(usable)) return Result.fail(`agent(): ${usable.failure}`);
  }
  const workspace = options.workspace as { readonly name?: unknown } | undefined;
  if (
    workspace !== undefined &&
    (typeof workspace !== "object" || typeof workspace?.name !== "string")
  ) {
    return Result.fail("agent(): workspace must be a value returned by workspace().");
  }
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    return Result.fail('agent(): isolation can only be "worktree".');
  }
  const roleName = Result.getOrUndefined(role);
  return Result.succeed({
    prompt,
    label: Result.getOrUndefined(label),
    phase: Result.getOrUndefined(phase),
    schema: schema as Record<string, unknown> | undefined,
    role: dialect === "claude" && roleName !== undefined ? claudeModelRole(roleName) : roleName,
    workspace: workspace?.name as string | undefined,
    isolated: options.isolation === "worktree",
    effort: Result.getOrUndefined(effort),
  });
}

interface ExecCall {
  readonly command: string;
  readonly workspace: string | undefined;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

const EXEC_OPTIONS = new Set(["workspace", "timeoutMs", "env"]);

/** Reads an `exec()` call's options. */
function decodeExecCall(request: unknown): Result.Result<ExecCall, string> {
  const { command, opts } = (request ?? {}) as {
    readonly command?: unknown;
    readonly opts?: unknown;
  };
  if (typeof command !== "string" || command.trim() === "") {
    return Result.fail("exec(command, opts) needs a non-empty command string.");
  }
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    return Result.fail("exec() options must be an object.");
  }
  const options = opts as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (!EXEC_OPTIONS.has(key)) return Result.fail(`exec(): option "${key}" is not supported.`);
  }
  const workspace = options.workspace as { readonly name?: unknown } | undefined;
  if (
    workspace !== undefined &&
    (typeof workspace !== "object" || typeof workspace?.name !== "string")
  ) {
    return Result.fail("exec(): workspace must be a value returned by workspace().");
  }
  const timeoutMs = options.timeoutMs ?? WorkflowExec.EXEC_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > WorkflowExec.EXEC_MAX_TIMEOUT_MS
  ) {
    return Result.fail(
      `exec(): timeoutMs must be a whole number of milliseconds, at most ${WorkflowExec.EXEC_MAX_TIMEOUT_MS} (60 minutes).`,
    );
  }
  const env = options.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return Result.fail("exec(): env must be an object of strings.");
  }
  const entries = Object.entries(env);
  if (entries.length > MAX_EXEC_ENV) {
    return Result.fail(`exec(): env takes at most ${MAX_EXEC_ENV} variables.`);
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      return Result.fail(
        `exec(): env.${name} must be a string, under a name of letters, digits and underscores.`,
      );
    }
  }
  return Result.succeed({
    command,
    workspace: workspace?.name as string | undefined,
    timeoutMs,
    env: Object.fromEntries(entries) as Record<string, string>,
  });
}

/** How a command ended, for the run's log. */
const execOutcome = (result: WorkflowExec.WorkflowExecResult) =>
  result.timedOut
    ? "timed out and was stopped"
    : result.exitCode === null
      ? "was ended by a signal"
      : `exited ${result.exitCode}`;

interface WorkspaceCall {
  readonly name: string;
  /** A ref or commit SHA, or the name of a workspace whose branch it starts from. */
  readonly from: string | { readonly workspace: string } | undefined;
  readonly readOnly: boolean;
}

/** A workspace this turn has ready. */
interface Workspace {
  readonly branch: string;
  readonly worktreePath: string;
  readonly readOnly: boolean;
}

const WORKSPACE_OPTIONS = new Set(["from", "readOnly"]);

/** What an agent in a read-only workspace is told; the engine checks the workspace afterwards. */
const READ_ONLY_NOTE =
  "Your working directory is a read-only workspace: do not create, edit or delete files in it, and do not commit or switch branches there. If anything in it changes, your result is discarded.";

/** Reads a `workspace()` call's name and options. */
function decodeWorkspaceCall(request: unknown): Result.Result<WorkspaceCall, string> {
  const { name, opts } = (request ?? {}) as {
    readonly name?: unknown;
    readonly opts?: unknown;
  };
  if (typeof name !== "string" || !WorkflowWorkspaces.isWorkflowWorkspaceName(name)) {
    return Result.fail(
      "workspace(name): name must be up to 64 letters, digits, dots, dashes or underscores, start with a letter or digit, and not contain `..` or end in `.` or `.lock`.",
    );
  }
  if (opts !== undefined && (typeof opts !== "object" || opts === null || Array.isArray(opts))) {
    return Result.fail("workspace() options must be an object.");
  }
  const options = (opts ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (!WORKSPACE_OPTIONS.has(key)) {
      return Result.fail(`workspace(): option "${key}" is not supported.`);
    }
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    return Result.fail("workspace(): readOnly must be true or false.");
  }
  const readOnly = options.readOnly === true;
  const from = options.from as unknown;
  if (from === undefined) return Result.succeed({ name, from: undefined, readOnly });
  if (typeof from === "string" && WorkflowWorkspaces.isWorkflowWorkspaceFrom(from)) {
    return Result.succeed({ name, from, readOnly });
  }
  const source = (from as { readonly name?: unknown } | null)?.name;
  if (typeof from === "object" && typeof source === "string") {
    return Result.succeed({ name, from: { workspace: source }, readOnly });
  }
  return Result.fail(
    "workspace(): from must be a branch name, a commit SHA, or a value returned by workspace().",
  );
}

/** The turn's timeline: assistant messages, the phase list, and the terminal. */
function makeTurnOutput(turn: WorkflowTurn, startedAt: DateTime.Utc) {
  const { input } = turn;
  const runKey = `${input.runId}:${input.attemptId}`;
  let sequence = 0;
  let todoOrdinal: number | undefined;
  const base = (now: DateTime.Utc, ordinal: number) => ({
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThread.id,
    providerTurnId: turn.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const message = (text: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      sequence += 1;
      yield* turn.emit([
        {
          type: "turn_item.updated",
          driver: WORKFLOW_DRIVER,
          turnItem: {
            ...base(now, sequence),
            id: TurnItemId.make(`turn-item:workflow:${runKey}:${sequence}`),
            type: "assistant_message",
            messageId: MessageId.make(`message:workflow:${runKey}:${sequence}`),
            text,
            streaming: false,
          },
        },
      ]);
    });
  const phases = (steps: ReadonlyArray<OrchestrationV2PlanStep>, done: boolean) =>
    Effect.gen(function* () {
      if (steps.length === 0) return;
      const now = yield* DateTime.now;
      if (todoOrdinal === undefined) {
        sequence += 1;
        todoOrdinal = sequence;
      }
      const planId = PlanId.make(`plan:workflow:${runKey}`);
      yield* turn.emit([
        {
          type: "plan.updated",
          driver: WORKFLOW_DRIVER,
          plan: {
            id: planId,
            threadId: input.threadId,
            runId: input.runId,
            nodeId: input.rootNodeId,
            kind: "todo_list",
            status: done ? "completed" : "active",
            steps: [...steps],
          },
        },
        {
          type: "turn_item.updated",
          driver: WORKFLOW_DRIVER,
          turnItem: {
            ...base(now, todoOrdinal),
            id: TurnItemId.make(`turn-item:workflow:${runKey}:phases`),
            type: "todo_list",
            planId,
            steps: [...steps],
          },
        },
      ]);
    });
  const terminal = (
    outcome:
      | { readonly status: "completed" | "interrupted" }
      | {
          readonly status: "failed";
          readonly message: string;
        },
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      sequence += 1;
      const providerTurn = {
        id: turn.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId: input.rootNodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: { driver: WORKFLOW_DRIVER, nativeId: runKey, strength: "strong" as const },
        ordinal: input.providerTurnOrdinal,
        status: outcome.status,
        startedAt,
        completedAt: now,
      };
      yield* turn.emit([
        { type: "provider_turn.updated", driver: WORKFLOW_DRIVER, providerTurn },
        outcome.status === "failed"
          ? {
              type: "turn.terminal",
              driver: WORKFLOW_DRIVER,
              providerThreadId: input.providerThread.id,
              providerTurnId: turn.providerTurnId,
              runOrdinal: input.runOrdinal,
              failureItemOrdinal: sequence,
              status: "failed",
              failure: {
                class: "validation_error",
                message: truncate(outcome.message, 4_000),
                code: "workflow_script_error",
                retryable: false,
              },
              threadDisposition: "reusable",
            }
          : {
              type: "turn.terminal",
              driver: WORKFLOW_DRIVER,
              providerThreadId: input.providerThread.id,
              providerTurnId: turn.providerTurnId,
              runOrdinal: input.runOrdinal,
              status: outcome.status,
              failure: null,
              threadDisposition: "reusable",
            },
      ]);
    });
  return { message, phases, terminal };
}

/** A spend in a provider's billing unit, to two decimals: 12.4, not 12.40000001. */
const formatSpend = (amount: number) => Number(amount.toFixed(2)).toLocaleString("en-US");

/** "a", "a and b", "a, b and c". */
const joinParts = (parts: ReadonlyArray<string>) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

const make = Effect.gen(function* () {
  const host = yield* WorkflowEngineHost;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sources = yield* WorkflowSourceStore.WorkflowSourceStore;
  const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
  const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
  const execs = yield* WorkflowExec.WorkflowExec;

  const children = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["subagents"])
      .pipe(
        Effect.map((records) =>
          records.subagents.filter(
            (task) => task.origin === "app_owned" && task.childThreadId !== null,
          ),
        ),
      );

  /**
   * What a run's agents spent, from their threads' provider usage, in each
   * billing unit a provider reports, such as Bob's Bobcoins. Every attempt's
   * agents count, so after a Retry it is the whole run's total, and says so.
   * Undefined when they reported none, or the threads could not be read.
   */
  const spentBy = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const costs = new Map<string, number>();
      for (const task of yield* children(threadId)) {
        if (task.childThreadId === null) continue;
        const records = yield* threads.getThreadRecords(task.childThreadId, ["providerThreads"]);
        for (const { contextUsage } of records.providerThreads) {
          const cost = contextUsage?.cost;
          if (cost) costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
        }
      }
      const parts = [...costs].map(([currency, amount]) => `${formatSpend(amount)} ${currency}`);
      if (parts.length === 0) return undefined;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      return `Its agents spent ${joinParts(parts)}${runs.length > 1 ? " in total, across attempts" : ""}.`;
    }).pipe(Effect.orElseSucceed(() => undefined));

  /**
   * Resolves each child's row once it is terminal, from one event stream per
   * turn. Stream events are the client projection, so the row is re-read.
   */
  const makeWatcher = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const waiters = new Map<
        NodeId,
        Deferred.Deferred<void, WorkflowSandbox.WorkflowScriptError>
      >();
      // Once the stream stops, no wait could ever finish, so every wait fails.
      let lost: WorkflowSandbox.WorkflowScriptError | undefined;
      const waiter = (taskId: NodeId) => {
        const existing = waiters.get(taskId);
        if (existing !== undefined) return Effect.succeed(existing);
        return Deferred.make<void, WorkflowSandbox.WorkflowScriptError>().pipe(
          Effect.tap((created) =>
            Effect.sync(() => waiters.set(taskId, created)).pipe(
              Effect.andThen(lost === undefined ? Effect.void : Deferred.fail(created, lost)),
            ),
          ),
        );
      };
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "subagent.updated" && isTerminal(stored.event.payload.status)
              ? waiter(stored.event.payload.id).pipe(
                  Effect.flatMap((deferred) => Deferred.succeed(deferred, undefined)),
                )
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Workflow child watcher stopped", { threadId, cause }),
          ),
          Effect.andThen(
            Effect.suspend(() => {
              lost = scriptError(
                "The workflow lost track of its agents. Retry the workflow to pick them up again.",
              );
              const failed = lost;
              return Effect.forEach(
                waiters.values(),
                (deferred) => Deferred.fail(deferred, failed),
                {
                  discard: true,
                },
              );
            }),
          ),
          Effect.forkScoped,
        );
      const terminalRow = (taskId: NodeId) =>
        children(threadId).pipe(
          Effect.map((rows) => rows.find((task) => task.id === taskId && isTerminal(task.status))),
        );
      return (taskId: NodeId) =>
        Effect.gen(function* () {
          const deferred = yield* waiter(taskId);
          // A row that finished before this wait began never sends another event.
          const early = yield* terminalRow(taskId);
          if (early !== undefined) return early;
          yield* Deferred.await(deferred);
          const finished = yield* terminalRow(taskId);
          if (finished === undefined) {
            return yield* scriptError("A workflow agent's row disappeared before it finished.");
          }
          return finished;
        });
    });

  const stopChild = (threadId: ThreadId, task: OrchestrationV2Subagent, reason: string) =>
    Effect.gen(function* () {
      if (task.childThreadId === null) return;
      const commandId = delegateTaskCommandId(`workflow:${threadId}`, `stop:${task.id}`);
      yield* threads.dispatch({
        type: "thread.stop",
        commandId,
        threadId: task.childThreadId,
        reason,
      });
      yield* threads.stopDelegatedTasks({ threadId: task.childThreadId, commandId, reason });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop a workflow agent", { threadId, taskId: task.id, cause }),
      ),
    );

  const runTurn = (turn: WorkflowTurn) =>
    Effect.gen(function* () {
      const { input } = turn;
      const coordinatorThreadId = input.threadId;
      const startedAt = yield* DateTime.now;
      const out = makeTurnOutput(turn, startedAt);
      const cwd = input.runtimePolicy.cwd;
      const created = new Map<string, Workspace>();
      // agent() calls the run's agent limit turned into null. The result says
      // so, or a script that carried on past them would read as a clean run.
      let capped = 0;
      let agentLimit = 0;
      /** agent() calls that returned null because their agent did not finish well. */
      let unfinished = 0;
      let terminalSent = false;
      const finishTurn = (outcome: Parameters<typeof out.terminal>[0]) =>
        Effect.suspend(() => {
          if (terminalSent) return Effect.void;
          terminalSent = true;
          return out.terminal(outcome);
        });

      /**
       * Removes the run's worktrees once it finished. Git keeps a worktree with
       * changes nobody committed, and so does the run, with its branch.
       */
      const removeWorkspaces = Effect.suspend(() =>
        Effect.forEach(
          [...created.values()],
          (workspace) =>
            cwd === null
              ? Effect.void
              : workspaces
                  .remove({ cwd, worktreePath: workspace.worktreePath, branch: workspace.branch })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Kept a workflow worktree", { error }).pipe(
                        Effect.andThen(
                          out.message(
                            `Kept the worktree at ${workspace.worktreePath} (branch ${workspace.branch}): it has changes that are not committed.`,
                          ),
                        ),
                      ),
                    ),
                  ),
          { discard: true },
        ),
      );

      const body = Effect.gen(function* () {
        const records = yield* threads.getThreadRecords(coordinatorThreadId, ["messages"], {
          messageRoles: ["user"],
        });
        const first = records.messages
          .filter((message) => message.role === "user")
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
          )[0];
        const invocation =
          first === undefined ? Option.none() : parseWorkflowInvocation(first.text);
        if (Option.isNone(invocation)) {
          return yield* scriptError("This thread is not a workflow run.");
        }
        const run = invocation.value;
        agentLimit = run.limits.agents;
        const source = yield* sources.get(run.sourceHash);
        if (Option.isNone(source)) {
          return yield* scriptError(
            "The workflow's source is no longer stored on this environment.",
          );
        }

        /** The binding an agent() call with `role` runs under, as the run bound it when it started. */
        const bindingFor = (role: string | undefined): WorkflowRoleBinding | undefined =>
          role === undefined
            ? run.defaultRole
            : ((Object.hasOwn(run.roles, role) ? run.roles[role] : undefined) ??
              (run.dialect === "claude" && run.unboundRolesInherit ? run.defaultRole : undefined));
        /** One lock per checkout, keyed by workspace branch, "" for the coordinator's own. */
        const writerLocks = new Map<string, Semaphore.Semaphore>();
        const writerLock = (checkout: string) => {
          const existing = writerLocks.get(checkout);
          if (existing !== undefined) return Effect.succeed(existing);
          return Semaphore.make(1).pipe(
            Effect.tap((lock) => Effect.sync(() => writerLocks.set(checkout, lock))),
          );
        };
        /** The checkout a child works in, as `writerLocks` keys it. */
        const checkoutOf = (childThreadId: ThreadId) =>
          threads
            .getThreadRecords(childThreadId, [])
            .pipe(
              Effect.map(({ thread }) =>
                thread.worktreePath === input.appThread.worktreePath ? "" : (thread.branch ?? ""),
              ),
            );

        const watch = yield* makeWatcher(coordinatorThreadId);
        const concurrency = yield* Semaphore.make(run.limits.concurrency);
        // Agents an earlier turn left running keep a slot until they finish or
        // this turn waits on them again, so a rerun that takes another path
        // still runs no more than the limit at once.
        const heldSlots = new Set<NodeId>();
        const releaseHeld = (taskId: NodeId) =>
          Effect.suspend(() => (heldSlots.delete(taskId) ? concurrency.release(1) : Effect.void));
        const leftRunning = (yield* children(coordinatorThreadId)).filter(
          (task) => task.t3Workflow?.kind === "agent" && !isTerminal(task.status),
        );
        for (const task of leftRunning.slice(0, run.limits.concurrency)) {
          yield* concurrency.take(1);
          heldSlots.add(task.id);
          yield* watch(task.id).pipe(
            Effect.ignore,
            Effect.andThen(releaseHeld(task.id)),
            Effect.forkScoped,
          );
        }
        // A writer left running still owns its checkout: it may be editing
        // files there, so no other writer starts in it until it finishes or
        // this turn waits on it again.
        const heldCheckouts = new Map<NodeId, string>();
        const checkoutHolders = new Map<string, Set<NodeId>>();
        const releaseHeldCheckout = (taskId: NodeId) =>
          Effect.suspend(() => {
            const checkout = heldCheckouts.get(taskId);
            if (checkout === undefined) return Effect.void;
            heldCheckouts.delete(taskId);
            const holders = checkoutHolders.get(checkout);
            holders?.delete(taskId);
            if (holders === undefined || holders.size > 0) return Effect.void;
            checkoutHolders.delete(checkout);
            return writerLock(checkout).pipe(Effect.flatMap((lock) => lock.release(1)));
          });
        for (const task of leftRunning) {
          const role = task.t3Workflow?.kind === "agent" ? task.t3Workflow.role : null;
          if (bindingFor(role ?? undefined)?.writer !== true || task.childThreadId === null) {
            continue;
          }
          const checkout = yield* checkoutOf(task.childThreadId);
          const holders = checkoutHolders.get(checkout);
          if (holders === undefined) {
            const lock = yield* writerLock(checkout);
            yield* lock.take(1);
            checkoutHolders.set(checkout, new Set([task.id]));
          } else {
            holders.add(task.id);
          }
          heldCheckouts.set(task.id, checkout);
          yield* watch(task.id).pipe(
            Effect.ignore,
            Effect.andThen(releaseHeldCheckout(task.id)),
            Effect.forkScoped,
          );
        }
        const occurrences = new Map<string, number>();
        /** Each workspace this turn asked for, by name, with the options it was first asked with. */
        const workspaceCalls = new Map<
          string,
          {
            readonly options: string;
            readonly ready: Deferred.Deferred<Workspace, WorkflowSandbox.WorkflowScriptError>;
          }
        >();
        const phaseStates = new Map<string, OrchestrationV2PlanStep["status"]>(
          run.phases.map((phase) => [phase.title, "pending"] as const),
        );
        let currentPhase: string | null = null;
        let started = 0;
        let reused = 0;
        let nulls = 0;
        let commandsRun = 0;
        let commandsReplayed = 0;
        let capReported = false;

        const phaseSteps = () =>
          [...phaseStates.entries()].map(([title, status], index) => ({
            id: `phase-${index + 1}`,
            text: title,
            status,
          }));
        const log = (message: string) => out.message(truncate(message, MAX_LOG_CHARS));
        let phasesCapped = false;
        /** Whether a phase can be shown: a known one, or a new one under the cap. */
        const phaseFits = (title: string) =>
          Effect.gen(function* () {
            if (phaseStates.has(title) || phaseStates.size < MAX_PHASES) return true;
            if (!phasesCapped) {
              phasesCapped = true;
              yield* log(`This run shows at most ${MAX_PHASES} phases; later ones are not added.`);
            }
            return false;
          });
        /** Marks a phase running the first time an agent or phase() enters it. */
        const enterPhase = (title: string | null) =>
          Effect.gen(function* () {
            if (title === null || phaseStates.get(title) === "running") return;
            if (!(yield* phaseFits(title))) return;
            phaseStates.set(title, "running");
            yield* out.message(`**${title}**`);
            yield* out.phases(phaseSteps(), false);
          });
        const ensureWorkspace = (call: WorkspaceCall) =>
          Effect.gen(function* () {
            const { name } = call;
            const options = toJsonText({ from: call.from ?? null, readOnly: call.readOnly });
            const existing = workspaceCalls.get(name);
            if (existing !== undefined) {
              if (existing.options !== options) {
                return yield* scriptError(
                  `workspace("${name}"): this run already asked for it with other options.`,
                );
              }
              return yield* Deferred.await(existing.ready);
            }
            const ready = yield* Deferred.make<Workspace, WorkflowSandbox.WorkflowScriptError>();
            workspaceCalls.set(name, { options, ready });
            const ensured = yield* Effect.gen(function* () {
              if (cwd === null) {
                return yield* scriptError("workspace(): this thread has no checkout.");
              }
              // A workspace starts from another one's branch as it is when this one is first made.
              let from: string | undefined;
              if (typeof call.from === "object") {
                const source = workspaceCalls.get(call.from.workspace);
                if (source === undefined || call.from.workspace === name) {
                  return yield* scriptError(
                    `workspace("${name}"): from workspace "${call.from.workspace}" was not created in this run; call workspace() for it first.`,
                  );
                }
                from = `refs/heads/${(yield* Deferred.await(source.ready)).branch}`;
              } else {
                from = call.from;
              }
              const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, name);
              return yield* workspaces
                .ensure({
                  projectId: input.appThread.projectId,
                  ownerThreadId: coordinatorThreadId,
                  cwd,
                  branch,
                  from,
                })
                .pipe(
                  Effect.map(({ worktreePath }) => ({
                    branch,
                    worktreePath,
                    readOnly: call.readOnly,
                  })),
                  Effect.mapError((error) => scriptError(`workspace("${name}"): ${error.message}`)),
                );
            }).pipe(Effect.exit);
            if (Exit.isSuccess(ensured)) created.set(name, ensured.value);
            yield* Deferred.done(ready, ensured);
            return yield* Deferred.await(ready);
          });

        const resultOf = (task: OrchestrationV2Subagent, call: AgentCall, label: string) =>
          Effect.gen(function* () {
            if (task.status !== "completed") {
              nulls += 1;
              unfinished += 1;
              yield* log(
                `${label} ${task.status}${task.result ? `: ${truncate(task.result, 300)}` : ""}. agent() returned null.`,
              );
              return null;
            }
            if (call.schema === undefined) return task.result;
            if (task.structuredResult !== undefined) return task.structuredResult;
            const recovered = structuredResultFromText(call.schema, task.result ?? "");
            if (Result.isSuccess(recovered)) return recovered.success;
            nulls += 1;
            unfinished += 1;
            yield* log(
              `${label} returned no valid result (${recovered.failure}). agent() returned null.`,
            );
            return null;
          });

        const agent = (request: unknown, context: { readonly phase: string | null }) =>
          Effect.gen(function* () {
            const decoded = decodeAgentCall(request, run.dialect);
            if (Result.isFailure(decoded)) return yield* scriptError(decoded.failure);
            const call = decoded.success;
            const binding = bindingFor(call.role);
            if (binding === undefined) {
              return yield* scriptError(
                run.dialect === "t3"
                  ? `agent(): role "${call.role}" is not in meta.roles.`
                  : `agent(): model "${call.role}" was not bound when the run started.`,
              );
            }
            const effortValue =
              call.effort !== undefined && binding.effort?.values.includes(call.effort) === true
                ? call.effort
                : undefined;
            const modelSelection =
              effortValue === undefined || binding.effort === undefined
                ? binding.modelSelection
                : {
                    ...binding.modelSelection,
                    options: [
                      ...(binding.modelSelection.options ?? []).filter(
                        (option) => option.id !== binding.effort!.optionId,
                      ),
                      { id: binding.effort.optionId, value: effortValue },
                    ],
                  };
            const named =
              call.workspace === undefined ? undefined : workspaceCalls.get(call.workspace);
            if (call.workspace !== undefined && named === undefined) {
              return yield* scriptError(
                `agent(): workspace "${call.workspace}" was not created in this run; call workspace() first.`,
              );
            }
            const phase = call.phase ?? context.phase;
            const callKey = hashKey({
              prompt: call.prompt,
              label: call.label ?? null,
              phase,
              schema: call.schema ?? null,
              modelSelection,
              runtimeMode: binding.runtimeMode,
              interactionMode: binding.interactionMode,
              workspace: call.workspace ?? (call.isolated ? "isolated" : null),
            });
            const occurrence = (occurrences.get(callKey) ?? 0) + 1;
            occurrences.set(callKey, occurrence);
            const label = call.label ?? truncate(call.prompt.split("\n")[0]!.trim(), 80);

            if (started >= run.limits.agents) {
              nulls += 1;
              capped += 1;
              if (!capReported) {
                capReported = true;
                yield* log(
                  `Reached this run's limit of ${run.limits.agents} agents; agent() returns null from here on.`,
                );
              }
              return null;
            }
            started += 1;
            yield* enterPhase(phase);

            const workspace =
              named !== undefined
                ? yield* Deferred.await(named.ready)
                : call.isolated
                  ? yield* ensureWorkspace({
                      name: `agent-${callKey.slice(0, 8)}-${occurrence}`,
                      from: undefined,
                      readOnly: false,
                    })
                  : undefined;

            // A read-only workspace is checked before an agent starts in it and whenever an
            // agent's result is read: a change there discards the result and is left in place.
            const readOnlyChanged = Effect.gen(function* () {
              if (workspace?.readOnly !== true || cwd === null) return false;
              const change = yield* workspaces
                .changes({ cwd, worktreePath: workspace.worktreePath, branch: workspace.branch })
                .pipe(Effect.catch((error) => Effect.succeed(error.message)));
              if (change === null) return false;
              nulls += 1;
              unfinished += 1;
              yield* log(
                `${label}: read-only workspace "${call.workspace}" has changes (${change}). agent() returned null.`,
              );
              return true;
            });
            const deliver = (task: OrchestrationV2Subagent) =>
              Effect.gen(function* () {
                if (task.status === "completed" && (yield* readOnlyChanged)) return null;
                return yield* resultOf(task, call, label);
              });

            const callId = `${callKey}:${occurrence}`;
            const commandIdFor = (attempt: number) =>
              delegateTaskCommandId(`workflow:${coordinatorThreadId}`, `${callId}:${attempt}`);
            const taskIdFor = (attempt: number) =>
              ids.derive.delegatedTaskNode({ commandId: commandIdFor(attempt) });
            const attemptOf = (task: OrchestrationV2Subagent) =>
              task.t3Workflow?.kind === "agent" ? task.t3Workflow.attempt : 0;
            // The call's latest attempt. A refused request leaves no row, so
            // attempts are read from the rows rather than counted from 1.
            const prior = (yield* children(coordinatorThreadId))
              .filter(
                (task) => task.t3Workflow?.kind === "agent" && task.t3Workflow.call === callId,
              )
              .reduce<OrchestrationV2Subagent | undefined>(
                (latest, task) =>
                  latest === undefined || attemptOf(task) > attemptOf(latest) ? task : latest,
                undefined,
              );
            if (prior?.status === "completed") {
              reused += 1;
              return yield* deliver(prior);
            }
            // A live child from an earlier turn is awaited, not restarted.
            const attached = prior !== undefined && !isTerminal(prior.status) ? prior : undefined;
            if (attached === undefined && (yield* readOnlyChanged)) return null;
            const firstAttempt = prior === undefined ? 1 : attemptOf(prior) + 1;
            const checkout = workspace?.branch ?? "";
            // Agents in a read-only workspace run side by side whatever their role: none may write.
            const lock =
              binding.writer && workspace?.readOnly !== true
                ? yield* writerLock(checkout)
                : undefined;
            const brief =
              workspace?.readOnly === true ? `${call.prompt}\n\n${READ_ONLY_NOTE}` : call.prompt;
            // The call's identity keeps the binding the run started with, so
            // narrowing the thread never discards finished agents.
            const narrowed = clampWorkflowRoleBinding(binding, input.runtimePolicy);
            const isRefusedBefore = (cause: Cause.Cause<{ readonly _tag: string }>) =>
              cause.reasons.some(
                (reason) =>
                  reason._tag === "Fail" &&
                  reason.error._tag === "OrchestratorCommandPreviouslyRejectedError",
              );
            const dispatchAttempt = (taskAttempt: number) =>
              threads
                .dispatch({
                  type: "delegated_task.request",
                  createdBy: "agent",
                  creationSource: "server",
                  commandId: commandIdFor(taskAttempt),
                  parentThreadId: coordinatorThreadId,
                  parentRunId: input.runId,
                  parentNodeId: input.rootNodeId,
                  task:
                    call.schema === undefined ? brief : structuredTaskPrompt(brief, call.schema),
                  ...(call.label === undefined
                    ? {}
                    : { title: truncate(call.label, MAX_LABEL_CHARS) }),
                  modelSelection,
                  runtimeMode: narrowed.runtimeMode,
                  interactionMode: narrowed.interactionMode,
                  completionWake: "owner_observes",
                  ...(call.schema === undefined
                    ? {}
                    : { resultSchema: call.schema as Schema.Json }),
                  t3Workflow: {
                    kind: "agent",
                    phase,
                    role: call.role ?? null,
                    call: callId,
                    attempt: taskAttempt,
                  },
                  ...(workspace === undefined
                    ? {}
                    : {
                        workspace: {
                          worktreePath: workspace.worktreePath,
                          branch: workspace.branch,
                        },
                      }),
                })
                .pipe(Effect.exit);
            const execute = Effect.gen(function* () {
              if (attached !== undefined) return yield* watch(attached.id);
              // A request refused on an earlier run stays refused under its id,
              // so a rerun steps to the next attempt.
              for (let taskAttempt = firstAttempt; ; taskAttempt += 1) {
                const dispatched = yield* dispatchAttempt(taskAttempt);
                if (Exit.isSuccess(dispatched)) return yield* watch(taskIdFor(taskAttempt));
                if (
                  isRefusedBefore(dispatched.cause) &&
                  taskAttempt < firstAttempt + MAX_REFUSED_ATTEMPTS
                ) {
                  continue;
                }
                yield* Effect.logWarning("Could not start a workflow agent", {
                  coordinatorThreadId,
                  cause: dispatched.cause,
                });
                return undefined;
              }
            });
            // A writer waits for its checkout before taking a slot, so waiting
            // writers never keep plan-mode agents from running. An agent left
            // running by an earlier turn already holds its slot and its checkout.
            const slotted =
              attached !== undefined && heldSlots.has(attached.id)
                ? execute.pipe(Effect.ensuring(releaseHeld(attached.id)))
                : concurrency.withPermit(execute);
            const where =
              call.workspace === undefined ? "the checkout" : `workspace "${call.workspace}"`;
            const finished = yield* lock === undefined
              ? slotted
              : attached !== undefined && heldCheckouts.has(attached.id)
                ? slotted.pipe(Effect.ensuring(releaseHeldCheckout(attached.id)))
                : lock
                    .withPermitsIfAvailable(1)(slotted)
                    .pipe(
                      Effect.flatMap(
                        Option.match({
                          onNone: () =>
                            log(`${label} waits for its turn in ${where}.`).pipe(
                              Effect.andThen(lock.withPermit(slotted)),
                            ),
                          onSome: Effect.succeed,
                        }),
                      ),
                    );
            if (finished === undefined) {
              nulls += 1;
              unfinished += 1;
              yield* log(`${label} could not start. agent() returned null.`);
              return null;
            }
            return yield* deliver(finished);
          }).pipe(
            Effect.mapError((error) =>
              WorkflowSandbox.isWorkflowScriptError(error)
                ? error
                : scriptError(`agent() failed: ${error.message}`),
            ),
          );

        const workspace = (request: unknown) =>
          Effect.gen(function* () {
            const decoded = decodeWorkspaceCall(request);
            if (Result.isFailure(decoded)) return yield* scriptError(decoded.failure);
            const ensured = yield* ensureWorkspace(decoded.success);
            return { name: decoded.success.name, branch: ensured.branch };
          });

        const execSlots = yield* Semaphore.make(MAX_CONCURRENT_EXECS);
        /**
         * Runs a command once per call: the journal holds every command that
         * finished, so a rerun replays its result instead of running it again,
         * and runs one that an earlier turn stopped midway.
         */
        const exec = (request: unknown) =>
          Effect.gen(function* () {
            const decoded = decodeExecCall(request);
            if (Result.isFailure(decoded)) return yield* scriptError(decoded.failure);
            const call = decoded.success;
            const named =
              call.workspace === undefined ? undefined : workspaceCalls.get(call.workspace);
            if (call.workspace !== undefined && named === undefined) {
              return yield* scriptError(
                `exec(): workspace "${call.workspace}" was not created in this run; call workspace() first.`,
              );
            }
            const callKey = hashKey({
              exec: call.command,
              workspace: call.workspace ?? null,
              timeoutMs: call.timeoutMs,
              env: call.env,
            });
            const occurrence = (occurrences.get(callKey) ?? 0) + 1;
            occurrences.set(callKey, occurrence);
            const callId = `exec:${callKey}:${occurrence}`;
            const shown = `\`${truncate(call.command.replace(/\s+/g, " ").trim(), 200)}\`${
              call.workspace === undefined ? "" : ` in workspace "${call.workspace}"`
            }`;
            const replayed = yield* execs.recorded(coordinatorThreadId, callId);
            if (Option.isSome(replayed)) {
              commandsReplayed += 1;
              yield* log(
                `${shown} ${execOutcome(replayed.value)} on an earlier attempt; exec() returned that result again.`,
              );
              return replayed.value;
            }
            const workspace = named === undefined ? undefined : yield* Deferred.await(named.ready);
            const execCwd = workspace?.worktreePath ?? cwd;
            if (execCwd === null) return yield* scriptError("exec(): this thread has no checkout.");
            const runCommand = execSlots.withPermit(
              Effect.gen(function* () {
                const startedAt = yield* Clock.currentTimeMillis;
                const result = yield* execs.run({
                  command: call.command,
                  cwd: execCwd,
                  // A read-only workspace is read-only to commands too, as to its agents.
                  workspace: workspace !== undefined && workspace.readOnly !== true,
                  runtimeMode: input.runtimePolicy.runtimeMode,
                  interactionMode: input.runtimePolicy.interactionMode,
                  timeoutMs: call.timeoutMs,
                  env: call.env,
                });
                return { result, elapsedMs: (yield* Clock.currentTimeMillis) - startedAt };
              }),
            );
            // A command in a workspace takes its turn there with the agents that edit it.
            const { result, elapsedMs } =
              workspace === undefined
                ? yield* runCommand
                : yield* (yield* writerLock(workspace.branch)).withPermit(runCommand);
            yield* execs.record(coordinatorThreadId, callId, result);
            commandsRun += 1;
            yield* log(`${shown} ${execOutcome(result)} after ${(elapsedMs / 1000).toFixed(1)} s.`);
            return result;
          }).pipe(
            Effect.mapError((error) =>
              WorkflowSandbox.isWorkflowScriptError(error)
                ? error
                : scriptError(`exec() failed: ${error.message}`),
            ),
          );

        yield* out.phases(phaseSteps(), false);
        const outcome = yield* sandbox
          .run({
            source: source.value,
            args: run.args,
            host: {
              agent,
              workspace,
              exec,
              phase: (title) =>
                Effect.gen(function* () {
                  const next = title.trim() || null;
                  if (next !== null && !(yield* phaseFits(next))) return;
                  if (currentPhase !== null && currentPhase !== next) {
                    phaseStates.set(currentPhase, "completed");
                  }
                  currentPhase = next;
                  if (next !== null && !phaseStates.has(next)) phaseStates.set(next, "pending");
                  yield* enterPhase(next);
                }),
              log,
            },
          })
          .pipe(Effect.exit);

        // Agents the script started but never waited for do not outlive it.
        const live = (yield* children(coordinatorThreadId)).filter(
          (task) => !isTerminal(task.status),
        );
        if (live.length > 0) {
          yield* Effect.forEach(
            live,
            (task) =>
              stopChild(coordinatorThreadId, task, "The workflow ended without waiting for it."),
            { discard: true },
          );
          yield* log(
            `Stopped ${live.length} agent${live.length === 1 ? "" : "s"} the script did not wait for.`,
          );
          // The run's worktrees are removed next, so agents stop writing first.
          if (created.size > 0) {
            yield* Effect.forEach(live, (task) => watch(task.id).pipe(Effect.ignore), {
              concurrency: "unbounded",
              discard: true,
            });
          }
        }
        for (const [title, status] of phaseStates) {
          if (status === "running") phaseStates.set(title, "completed");
        }
        yield* out.phases(phaseSteps(), true);
        const commands = commandsRun + commandsReplayed;
        yield* log(
          `Ran ${started} agent${started === 1 ? "" : "s"}${reused > 0 ? `, ${reused} reused from an earlier attempt` : ""}${nulls > 0 ? `; ${nulls} returned null` : ""}${
            commands === 0
              ? ""
              : `; ${commands} command${commands === 1 ? "" : "s"}${commandsReplayed > 0 ? `, ${commandsReplayed} replayed from an earlier attempt` : ""}`
          }.`,
        );
        return yield* outcome;
      });

      // A stopped or failed run keeps its worktrees for Retry; the run that
      // finishes removes them. Exactly one terminal ends the turn, whenever a
      // Stop lands.
      yield* Effect.gen(function* () {
        const exit = yield* body.pipe(Effect.scoped, Effect.exit);
        if (Exit.isSuccess(exit)) {
          yield* removeWorkspaces;
          // Only a failed or stopped run is retried, so a finished one's commands are not replayed.
          yield* execs
            .forget(coordinatorThreadId)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not drop a workflow's command results", { error }),
              ),
            );
          const value = exit.value;
          const result =
            value === null || value === undefined
              ? "The workflow finished without a result."
              : workflowResultText(value);
          // A script may carry on past null results; the starting agent should
          // still know some of its agents never delivered.
          const notes = [
            capped === 0
              ? null
              : `this run reached its limit of ${agentLimit} agents, so ${capped} agent() call${capped === 1 ? "" : "s"} returned null without running`,
            unfinished === 0
              ? null
              : `${unfinished} agent${unfinished === 1 ? "" : "s"} failed, stopped or returned no valid result, so agent() returned null for ${unfinished === 1 ? "it" : "them"}`,
          ].filter((note) => note !== null);
          const spent = yield* spentBy(coordinatorThreadId);
          yield* Effect.uninterruptible(
            out
              .message(
                [
                  result,
                  ...(spent === undefined ? [] : [spent]),
                  ...(notes.length === 0 ? [] : [`Note: ${notes.join("; ")}.`]),
                ].join("\n\n"),
              )
              .pipe(Effect.andThen(finishTurn({ status: "completed" }))),
          );
          return;
        }
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
        if (failure === undefined) {
          yield* Effect.logError("Workflow engine turn failed", {
            coordinatorThreadId,
            cause: exit.cause,
          });
        }
        const spent = yield* spentBy(coordinatorThreadId);
        const ending = [
          ...(created.size === 0
            ? []
            : [`Kept ${created.size} worktree${created.size === 1 ? "" : "s"} for Retry.`]),
          ...(spent === undefined ? [] : [spent]),
        ];
        yield* Effect.uninterruptible(
          (ending.length === 0 ? Effect.void : out.message(ending.join(" "))).pipe(
            Effect.andThen(
              finishTurn({
                status: "failed",
                message: [
                  failure?._tag === "Fail" ? failure.error.message : "The workflow engine failed.",
                  ...(spent === undefined ? [] : [spent]),
                ].join("\n\n"),
              }),
            ),
          ),
        );
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() =>
            terminalSent
              ? Effect.void
              : spentBy(coordinatorThreadId).pipe(
                  Effect.flatMap((spent) =>
                    out.message(
                      spent === undefined
                        ? "The workflow was stopped."
                        : `The workflow was stopped. ${spent}`,
                    ),
                  ),
                  Effect.andThen(finishTurn({ status: "interrupted" })),
                ),
          ),
        ),
      );
    });

  yield* host.register((turn) =>
    runTurn(turn).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("Workflow engine turn crashed", { cause }),
      ),
    ),
  );
});

/** Registers the engine with the workflow adapter's host. */
export const layer = Layer.effectDiscard(make);
