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
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

const make = Effect.gen(function* () {
  const host = yield* WorkflowEngineHost;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sources = yield* WorkflowSourceStore.WorkflowSourceStore;
  const sandbox = yield* WorkflowSandbox.WorkflowSandbox;
  const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;

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
      const created = new Map<string, { readonly branch: string; readonly worktreePath: string }>();
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

        const watch = yield* makeWatcher(coordinatorThreadId);
        const concurrency = yield* Semaphore.make(run.limits.concurrency);
        // Agents an earlier turn left running keep a slot until they finish or
        // this turn waits on them again, so a rerun that takes another path
        // still runs no more than the limit at once.
        const heldSlots = new Set<NodeId>();
        const releaseHeld = (taskId: NodeId) =>
          Effect.suspend(() => (heldSlots.delete(taskId) ? concurrency.release(1) : Effect.void));
        const leftRunning = (yield* children(coordinatorThreadId))
          .filter((task) => task.workflow?.kind === "agent" && !isTerminal(task.status))
          .slice(0, run.limits.concurrency);
        for (const task of leftRunning) {
          yield* concurrency.take(1);
          heldSlots.add(task.id);
          yield* watch(task.id).pipe(
            Effect.ignore,
            Effect.andThen(releaseHeld(task.id)),
            Effect.forkScoped,
          );
        }
        const writerLocks = new Map<string, Semaphore.Semaphore>();
        const occurrences = new Map<string, number>();
        const workspaceCalls = new Map<
          string,
          Deferred.Deferred<
            { readonly branch: string; readonly worktreePath: string },
            WorkflowSandbox.WorkflowScriptError
          >
        >();
        const phaseStates = new Map<string, OrchestrationV2PlanStep["status"]>(
          run.phases.map((phase) => [phase.title, "pending"] as const),
        );
        let currentPhase: string | null = null;
        let started = 0;
        let reused = 0;
        let nulls = 0;
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
        const writerLock = (key: string) => {
          const existing = writerLocks.get(key);
          if (existing !== undefined) return Effect.succeed(existing);
          return Semaphore.make(1).pipe(
            Effect.tap((lock) => Effect.sync(() => writerLocks.set(key, lock))),
          );
        };

        const ensureWorkspace = (name: string) =>
          Effect.gen(function* () {
            const existing = workspaceCalls.get(name);
            if (existing !== undefined) return yield* Deferred.await(existing);
            const deferred = yield* Deferred.make<
              { readonly branch: string; readonly worktreePath: string },
              WorkflowSandbox.WorkflowScriptError
            >();
            workspaceCalls.set(name, deferred);
            if (cwd === null) {
              yield* Deferred.fail(
                deferred,
                scriptError("workspace(): this thread has no checkout."),
              );
              return yield* Deferred.await(deferred);
            }
            const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, name);
            const ensured = yield* workspaces
              .ensure({
                projectId: input.appThread.projectId,
                ownerThreadId: coordinatorThreadId,
                cwd,
                branch,
              })
              .pipe(
                Effect.map(({ worktreePath }) => ({ branch, worktreePath })),
                Effect.mapError((error) => scriptError(`workspace("${name}"): ${error.message}`)),
                Effect.exit,
              );
            if (Exit.isSuccess(ensured)) created.set(name, ensured.value);
            yield* Deferred.done(deferred, ensured);
            return yield* Deferred.await(deferred);
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
            const binding: WorkflowRoleBinding | undefined =
              call.role === undefined
                ? run.defaultRole
                : ((Object.hasOwn(run.roles, call.role) ? run.roles[call.role] : undefined) ??
                  (run.dialect === "claude" && run.unboundRolesInherit
                    ? run.defaultRole
                    : undefined));
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
                ? yield* Deferred.await(named)
                : call.isolated
                  ? yield* ensureWorkspace(`agent-${callKey.slice(0, 8)}-${occurrence}`)
                  : undefined;

            const callId = `${callKey}:${occurrence}`;
            const commandIdFor = (attempt: number) =>
              delegateTaskCommandId(`workflow:${coordinatorThreadId}`, `${callId}:${attempt}`);
            const taskIdFor = (attempt: number) =>
              ids.derive.delegatedTaskNode({ commandId: commandIdFor(attempt) });
            const attemptOf = (task: OrchestrationV2Subagent) =>
              task.workflow?.kind === "agent" ? task.workflow.attempt : 0;
            // The call's latest attempt. A refused request leaves no row, so
            // attempts are read from the rows rather than counted from 1.
            const prior = (yield* children(coordinatorThreadId))
              .filter((task) => task.workflow?.kind === "agent" && task.workflow.call === callId)
              .reduce<OrchestrationV2Subagent | undefined>(
                (latest, task) =>
                  latest === undefined || attemptOf(task) > attemptOf(latest) ? task : latest,
                undefined,
              );
            if (prior?.status === "completed") {
              reused += 1;
              return yield* resultOf(prior, call, label);
            }
            // A live child from an earlier turn is awaited, not restarted.
            const attached = prior !== undefined && !isTerminal(prior.status) ? prior : undefined;
            const firstAttempt = prior === undefined ? 1 : attemptOf(prior) + 1;
            const checkout = workspace?.branch ?? "";
            const lock = binding.writer ? yield* writerLock(checkout) : undefined;
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
                    call.schema === undefined
                      ? call.prompt
                      : structuredTaskPrompt(call.prompt, call.schema),
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
                  workflow: {
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
            // running by an earlier turn already holds its slot.
            const slotted =
              attached !== undefined && heldSlots.has(attached.id)
                ? execute.pipe(Effect.ensuring(releaseHeld(attached.id)))
                : concurrency.withPermit(execute);
            const finished = yield* lock === undefined ? slotted : lock.withPermit(slotted);
            if (finished === undefined) {
              nulls += 1;
              unfinished += 1;
              yield* log(`${label} could not start. agent() returned null.`);
              return null;
            }
            return yield* resultOf(finished, call, label);
          }).pipe(
            Effect.mapError((error) =>
              WorkflowSandbox.isWorkflowScriptError(error)
                ? error
                : scriptError(`agent() failed: ${error.message}`),
            ),
          );

        const workspace = (request: unknown) =>
          Effect.gen(function* () {
            const name = (request as { readonly name?: unknown } | null)?.name;
            if (typeof name !== "string" || !WorkflowWorkspaces.isWorkflowWorkspaceName(name)) {
              return yield* scriptError(
                "workspace(name): name must be up to 64 letters, digits, dots, dashes or underscores, start with a letter or digit, and not contain `..` or end in `.` or `.lock`.",
              );
            }
            const ensured = yield* ensureWorkspace(name);
            return { name, branch: ensured.branch };
          });

        yield* out.phases(phaseSteps(), false);
        const outcome = yield* sandbox
          .run({
            source: source.value,
            args: run.args,
            host: {
              agent,
              workspace,
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
        yield* log(
          `Ran ${started} agent${started === 1 ? "" : "s"}${reused > 0 ? `, ${reused} reused from an earlier attempt` : ""}${nulls > 0 ? `; ${nulls} returned null` : ""}.`,
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
          const value = exit.value;
          const result =
            value === null || value === undefined
              ? "The workflow finished without a result."
              : typeof value === "string"
                ? value
                : toJsonText(value);
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
          yield* Effect.uninterruptible(
            out
              .message(notes.length === 0 ? result : `${result}\n\nNote: ${notes.join("; ")}.`)
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
        yield* Effect.uninterruptible(
          (created.size === 0
            ? Effect.void
            : out.message(
                `Kept ${created.size} worktree${created.size === 1 ? "" : "s"} for Retry.`,
              )
          ).pipe(
            Effect.andThen(
              finishTurn({
                status: "failed",
                message:
                  failure?._tag === "Fail" ? failure.error.message : "The workflow engine failed.",
              }),
            ),
          ),
        );
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() =>
            terminalSent
              ? Effect.void
              : out
                  .message("The workflow was stopped.")
                  .pipe(Effect.andThen(finishTurn({ status: "interrupted" }))),
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
