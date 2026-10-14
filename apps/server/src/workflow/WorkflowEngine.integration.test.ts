// @effect-diagnostics nodeBuiltinImport:off - commands' tests share files and a pipe with the command.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATOR_MCP_TASK_RESULT_MAX_CHARS,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnItemId,
  WORKFLOW_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as WorkflowMcpService from "../mcp/WorkflowMcpService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as WorkflowAdapterV2 from "../orchestration-v2/Adapters/WorkflowAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowExec from "./WorkflowExec.ts";
import * as WorkflowSandbox from "./WorkflowSandbox.ts";
import * as WorkflowSourceStore from "./WorkflowSourceStore.ts";
import * as WorkflowWorkspaces from "./WorkflowWorkspaces.ts";

const projectId = ProjectId.make("project:workflow");
const parentThreadId = ThreadId.make("thread:workflow-parent");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexSelection = { instanceId: codexId, model: "gpt-6" } satisfies ModelSelection;
const PARENT_PROMPT = "Run the workflow.";

/** The value a finished workflow returned, from the JSON block that opens its result. */
function workflowValue(result: string | null | undefined): unknown {
  const fenced = /^```json\n([\s\S]*?)\n```/.exec(result ?? "");
  if (fenced === null) throw new Error(`not a JSON result: ${result}`);
  return JSON.parse(fenced[1]!);
}

/** What a fake provider turn sees and how it ends. */
interface FakeTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}
type FakeOutcome =
  | {
      readonly text: string;
      /** What the provider reports it used, as Bob reports its task's Bobcoins. */
      readonly usage?: ThreadTokenUsageSnapshot;
    }
  | {
      readonly fail: string;
      /** What the provider says of retrying; false when unset. */
      readonly retryable?: boolean | null;
    };

function providerSnapshot(
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-07T00:00:00.000Z",
    showInteractionModeToggle: true,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

/**
 * A provider whose turns run `behave` in the background, so concurrent turns
 * overlap the way real providers do, and end with its text or failure.
 */
function makeFakeAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly behave: (turn: FakeTurn) => Effect.Effect<FakeOutcome>;
  /** Runs before an interrupted turn reports that it stopped. */
  readonly beforeInterrupted?: (turn: FakeTurn) => Effect.Effect<void>;
  /** Runs before a provider thread resumes, while its run is still starting. */
  readonly beforeResume?: Effect.Effect<void>;
}): ProviderAdapterV2["Service"] {
  const capabilities =
    input.driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2;
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const turns = yield* FiberMap.make<ProviderTurnId>();
        const inputs = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          PubSub.publishAll(events, providerEvents).pipe(Effect.asVoid);
        const providerTurn = (
          turnInput: ProviderAdapterV2TurnInput,
          id: ProviderTurnId,
          status: "running" | "completed" | "failed" | "interrupted",
          at: DateTime.Utc,
        ) => ({
          id,
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: { driver: input.driver, nativeId: id, strength: "strong" as const },
          ordinal: turnInput.providerTurnOrdinal,
          status,
          startedAt: at,
          completedAt: status === "running" ? null : at,
        });
        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(
                  `provider-thread:${input.instanceId}:${threadInput.threadId}`,
                ),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: `${input.instanceId}:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            (input.beforeResume ?? Effect.void).pipe(Effect.as(providerThread)),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const id = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:${turnInput.attemptId}`,
              );
              inputs.set(id, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: providerTurn(turnInput, id, "running", yield* DateTime.now),
                },
              ]);
              yield* FiberMap.run(
                turns,
                id,
                Effect.gen(function* () {
                  const outcome = yield* input.behave({
                    instanceId: input.instanceId,
                    threadId: turnInput.threadId,
                    text: turnInput.message.text,
                  });
                  const at = yield* DateTime.now;
                  if ("fail" in outcome) {
                    yield* publish([
                      {
                        type: "provider_turn.updated",
                        driver: input.driver,
                        providerTurn: providerTurn(turnInput, id, "failed", at),
                      },
                      {
                        type: "turn.terminal",
                        driver: input.driver,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId: id,
                        runOrdinal: turnInput.runOrdinal,
                        failureItemOrdinal: 99,
                        status: "failed",
                        failure: {
                          class: "provider_error",
                          message: outcome.fail,
                          code: null,
                          retryable: outcome.retryable === undefined ? false : outcome.retryable,
                        },
                        threadDisposition: "reusable",
                      },
                    ]);
                    return;
                  }
                  yield* publish([
                    ...(outcome.usage === undefined
                      ? []
                      : [
                          {
                            type: "provider_thread.updated" as const,
                            driver: input.driver,
                            providerThread: {
                              ...turnInput.providerThread,
                              contextUsage: outcome.usage,
                              updatedAt: at,
                            },
                          },
                        ]),
                    {
                      type: "provider_turn.updated",
                      driver: input.driver,
                      providerTurn: providerTurn(turnInput, id, "completed", at),
                    },
                    {
                      type: "turn_item.updated",
                      driver: input.driver,
                      turnItem: {
                        id: TurnItemId.make(`turn-item:${id}:assistant`),
                        threadId: turnInput.threadId,
                        runId: turnInput.runId,
                        nodeId: turnInput.rootNodeId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId: id,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 1,
                        status: "completed",
                        title: null,
                        startedAt: at,
                        completedAt: at,
                        updatedAt: at,
                        type: "assistant_message",
                        messageId: MessageId.make(`message:${id}:assistant`),
                        text: outcome.text,
                        streaming: false,
                      },
                    },
                    {
                      type: "turn.terminal",
                      driver: input.driver,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: id,
                      runOrdinal: turnInput.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    },
                  ]);
                }),
              );
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              yield* FiberMap.remove(turns, providerTurnId);
              const turnInput = inputs.get(providerTurnId);
              if (turnInput === undefined) return;
              yield* (input.beforeInterrupted ?? (() => Effect.void))({
                instanceId: input.instanceId,
                threadId: turnInput.threadId,
                text: turnInput.message.text,
              });
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: providerTurn(
                    turnInput,
                    providerTurnId,
                    "interrupted",
                    yield* DateTime.now,
                  ),
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            Effect.fail(
              new ProviderAdapterProtocolError({ driver: input.driver, detail: "unused" }),
            ),
          rollbackThread: () =>
            Effect.fail(
              new ProviderAdapterProtocolError({ driver: input.driver, detail: "unused" }),
            ),
          forkThread: () =>
            Effect.fail(
              new ProviderAdapterProtocolError({ driver: input.driver, detail: "unused" }),
            ),
        };
      }),
  };
}

/** Tracks how many child turns run at once, overall and per checkout. */
interface Concurrency {
  readonly enter: (key: string) => Effect.Effect<void>;
  readonly leave: (key: string) => Effect.Effect<void>;
  readonly peak: (key?: string) => Effect.Effect<number>;
}
const makeConcurrency = Effect.gen(function* () {
  const state = yield* Ref.make({
    live: new Map<string, number>(),
    peak: new Map<string, number>(),
  });
  const bump = (key: string, delta: number) =>
    Ref.update(state, ({ live, peak }) => {
      const nextLive = new Map(live);
      const nextPeak = new Map(peak);
      for (const name of [key, "*"]) {
        const value = (nextLive.get(name) ?? 0) + delta;
        nextLive.set(name, value);
        nextPeak.set(name, Math.max(nextPeak.get(name) ?? 0, value));
      }
      return { live: nextLive, peak: nextPeak };
    });
  return {
    enter: (key) => bump(key, 1),
    leave: (key) => bump(key, -1),
    peak: (key = "*") => Ref.get(state).pipe(Effect.map(({ peak }) => peak.get(key) ?? 0)),
  } satisfies Concurrency;
});

interface Harness {
  /** The starting thread's checkout. */
  readonly cwd: string;
  readonly attachmentsDir: string;
  /** The server's T3 home, a temporary folder. */
  readonly t3Home: string;
  readonly startParent: Effect.Effect<void>;
  /** Starts the parent with message attachments. */
  readonly startParentWith: (attachments: ReadonlyArray<ChatAttachment>) => Effect.Effect<void>;
  readonly runWorkflow: (
    input: Parameters<WorkflowMcpService.WorkflowMcpService["Service"]["runWorkflow"]>[1],
  ) => ReturnType<WorkflowMcpService.WorkflowMcpService["Service"]["runWorkflow"]>;
  /** Resolves when the starting thread is offered its next completion wake. */
  readonly parentWoken: Effect.Effect<void>;
  /** Resolves once the coordinator's children satisfy `predicate`, re-checked on each row update. */
  readonly waitForChildren: (
    threadId: ThreadId,
    predicate: (children: ReadonlyArray<OrchestrationV2Subagent>) => boolean,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>>;
  /** Resolves once the thread's runs satisfy `predicate`, re-checked on each run update. */
  readonly waitForRuns: (
    threadId: ThreadId,
    predicate: (runs: ReadonlyArray<OrchestrationV2Run>) => boolean,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>>;
  readonly wakeCount: Effect.Effect<number>;
  readonly coordinatorChildren: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly workflowMcp: WorkflowMcpService.WorkflowMcpService["Service"];
  readonly orchestratorMcp: OrchestratorMcpService.OrchestratorMcpService["Service"];
  readonly workspaceLog: Ref.Ref<ReadonlyArray<string>>;
  /** What a workspace check reports for a branch; a branch not listed has no changes. */
  readonly workspaceChanges: Ref.Ref<ReadonlyMap<string, string>>;
}

const parentScope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:workflow"),
  requestNamespace: "provider-session:workflow-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:workflow-parent",
    providerInstanceId: codexId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** A child thread calling MCP as itself, as its provider session would. */
const childScope = (threadId: ThreadId, instanceId: ProviderInstanceId): McpInvocationScope => ({
  ...parentScope,
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: instanceId,
  },
});

/** The fake adapters, with lookups for the instances in `refused` failing as a removed provider's would. */
const layerRefusingAdapters = (
  adapters: ReadonlyArray<ProviderAdapterV2["Service"]>,
  refused: Ref.Ref<ReadonlySet<ProviderInstanceId>>,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const base = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        ...base,
        get: (instanceId) =>
          Ref.get(refused).pipe(
            Effect.flatMap((instances) =>
              instances.has(instanceId)
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : base.get(instanceId),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(ProviderAdapterRegistry.layerFromAdapters(adapters)));

const withHarness = <A, E>(
  options: {
    readonly name: string;
    readonly behave: (turn: FakeTurn, harness: () => Harness) => Effect.Effect<FakeOutcome>;
    readonly beforeInterrupted?: (turn: FakeTurn) => Effect.Effect<void>;
    readonly beforeResume?: Effect.Effect<void>;
    readonly refused?: Ref.Ref<ReadonlySet<ProviderInstanceId>>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    /** Runs before each thread read the orchestrator MCP service makes. */
    readonly beforeMcpRead?: Effect.Effect<void>;
    /** Stands in for an automatic retry's delay; returns at once when unset. */
    readonly retryWait?: (delay: Duration.Duration) => Effect.Effect<void>;
    /** Stands in for running an exec() command; the journal stays real. */
    readonly execRun?: WorkflowExec.WorkflowExec["Service"]["run"];
  },
  body: (harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(options.name);
      const offers = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
      const wakes = yield* Queue.unbounded<void>();
      const layerContinuationProbe = Layer.succeed(
        ProviderContinuationRequests.ProviderContinuationRequests,
        {
          offer: (request) =>
            Ref.update(offers, (all) => [...all, request.threadId]).pipe(
              Effect.andThen(
                request.threadId === parentThreadId ? Queue.offer(wakes, undefined) : Effect.void,
              ),
            ),
          take: Effect.never,
        },
      );
      let current: Harness | undefined;
      const harness = () => current!;
      const parentStarted = yield* Deferred.make<void>();
      // The parent's own turn reports that it is live and stays live.
      const behave = (turn: FakeTurn) =>
        turn.threadId === parentThreadId && turn.text === PARENT_PROMPT
          ? Deferred.succeed(parentStarted, undefined).pipe(Effect.andThen(Effect.never))
          : options.behave(turn, harness);
      const beforeInterrupted = options.beforeInterrupted;
      const beforeResume = options.beforeResume;
      const adapters = [
        makeFakeAdapter({
          instanceId: codexId,
          driver: ProviderDriverKind.make("codex"),
          behave,
          ...(beforeInterrupted === undefined ? {} : { beforeInterrupted }),
          ...(beforeResume === undefined ? {} : { beforeResume }),
        }),
        makeFakeAdapter({
          instanceId: claudeId,
          driver: ProviderDriverKind.make("claudeAgent"),
          behave,
          ...(beforeInterrupted === undefined ? {} : { beforeInterrupted }),
          ...(beforeResume === undefined ? {} : { beforeResume }),
        }),
      ];
      const workspaceLog = yield* Ref.make<ReadonlyArray<string>>([]);
      const workspaceChanges = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const layerWorkspaces = Layer.succeed(
        WorkflowWorkspaces.WorkflowWorkspaces,
        WorkflowWorkspaces.WorkflowWorkspaces.of({
          ensure: ({ branch, from }) =>
            Ref.update(workspaceLog, (all) => [
              ...all,
              `ensure ${branch}${from === undefined ? "" : ` from ${from}`}`,
            ]).pipe(Effect.as({ worktreePath: `${cwd}-worktrees/${branch.replaceAll("/", "-")}` })),
          changes: ({ branch }) =>
            Ref.get(workspaceChanges).pipe(Effect.map((all) => all.get(branch) ?? null)),
          remove: ({ branch }) => Ref.update(workspaceLog, (all) => [...all, `remove ${branch}`]),
          // Settles as if every branch had commits of its own: only "always" deletes it.
          settle: ({ branch, cleanup }) =>
            Ref.update(workspaceLog, (all) => [...all, `settle ${branch} ${cleanup}`]).pipe(
              Effect.as({ deleted: cleanup === "always" }),
            ),
        }),
      );
      const layerDatabase = SqlitePersistence.layerMemory;
      const layerRegistry = WorkflowAdapterV2.layerRegistryWithWorkflowAdapter(
        options.refused === undefined
          ? ProviderAdapterRegistry.layerFromAdapters(adapters)
          : layerRefusingAdapters(adapters, options.refused),
      ).pipe(Layer.provide(WorkflowAdapterV2.layerEngineHost));
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: options.name, runtimePolicyOverride: { cwd } },
        layerRegistry,
        { databaseLayer: layerDatabase },
      ).pipe(Layer.provide(layerContinuationProbe));
      const layerSettings = ServerSettings.layerTest(options.settings ?? {}).pipe(Layer.orDie);
      const layerThreads = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerOrchestrator,
            CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
            layerSettings,
          ),
        ),
      );
      const beforeMcpRead = options.beforeMcpRead;
      const layerMcpThreads =
        beforeMcpRead === undefined
          ? layerThreads
          : Layer.effect(
              ThreadManagementService.ThreadManagementService,
              Effect.gen(function* () {
                const threads = yield* ThreadManagementService.ThreadManagementService;
                return ThreadManagementService.ThreadManagementService.of({
                  ...threads,
                  getThreadRecords: (threadId, fields, filter) =>
                    beforeMcpRead.pipe(
                      Effect.andThen(threads.getThreadRecords(threadId, fields, filter)),
                    ),
                });
              }),
            ).pipe(Layer.provide(layerThreads));
      const layerSources = WorkflowSourceStore.layer.pipe(Layer.provide(layerDatabase));
      const layerConfig = ServerConfig.layerTest(cwd, { prefix: "t3-workflow-config-" }).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layerEngine = WorkflowEngine.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            WorkflowAdapterV2.layerEngineHost,
            layerThreads,
            IdAllocator.layer,
            layerSources,
            WorkflowSandbox.layerTest,
            layerWorkspaces,
            Layer.effect(
              WorkflowExec.WorkflowExec,
              Effect.map(WorkflowExec.WorkflowExec, (real) =>
                options.execRun === undefined ? real : { ...real, run: options.execRun },
              ),
            ).pipe(
              Layer.provide(
                WorkflowExec.layer.pipe(Layer.provide(Layer.merge(layerDatabase, layerConfig))),
              ),
            ),
            Layer.succeed(WorkflowEngine.AgentRetryWait, options.retryWait ?? (() => Effect.void)),
          ),
        ),
      );
      const layerMcp = WorkflowMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerThreads,
            layerRegistry,
            ProviderRegistryMock.layer([
              providerSnapshot(codexId, "codex", ["gpt-6", "gpt-6.1-sol"]),
              providerSnapshot(claudeId, "claudeAgent", ["claude-opus-5-5"]),
            ]),
            layerSettings,
            layerConfig,
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.none()),
            }),
            WorkflowSandbox.layerTest,
            layerSources,
            NodeServices.layer,
          ),
        ),
      );
      const layerOrchestratorMcp = OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerMcpThreads,
            layerRegistry,
            ProviderRegistryMock.layer([
              providerSnapshot(codexId, "codex", ["gpt-6", "gpt-6.1-sol"]),
              providerSnapshot(claudeId, "claudeAgent", ["claude-opus-5-5"]),
            ]),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            // Workflows pass their own workspace, so delegation never launches a worktree here.
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            layerSettings,
            NodeServices.layer,
          ),
        ),
      );
      const layerAll = Layer.mergeAll(
        layerOrchestratorMcp,
        layerOrchestrator,
        layerThreads,
        layerEngine,
        layerMcp,
        layerConfig,
      );

      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const workflowMcp = yield* WorkflowMcpService.WorkflowMcpService;
        const orchestratorMcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        /** Re-reads after each event of `eventType` on the thread until `predicate` holds. */
        const waitFor = <A, E>(
          threadId: ThreadId,
          eventType: "subagent.updated" | "run.updated",
          read: Effect.Effect<A, E>,
          predicate: (value: A) => boolean,
        ) =>
          Effect.gen(function* () {
            const now = yield* read;
            if (predicate(now)) return now;
            return yield* threads.streamStoredEventsFrom({ threadId, eventType }).pipe(
              Stream.mapEffect(() => read),
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
          }).pipe(Effect.orDie);
        const config = yield* ServerConfig.ServerConfig;
        const startParentWith = (attachments: ReadonlyArray<ChatAttachment>) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "Workflow parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:workflow-parent:start"),
              text: PARENT_PROMPT,
              attachments: [...attachments],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* Deferred.await(parentStarted);
          }).pipe(Effect.orDie);
        current = {
          cwd,
          attachmentsDir: config.attachmentsDir,
          t3Home: config.baseDir,
          startParent: startParentWith([]),
          startParentWith,
          runWorkflow: (input) => workflowMcp.runWorkflow(parentScope, input),
          parentWoken: Queue.take(wakes),
          waitForChildren: (threadId, predicate) =>
            waitFor(
              threadId,
              "subagent.updated",
              threads
                .getThreadRecords(threadId, ["subagents"])
                .pipe(Effect.map((records) => records.subagents)),
              predicate,
            ),
          waitForRuns: (threadId, predicate) =>
            waitFor(
              threadId,
              "run.updated",
              threads
                .getThreadRecords(threadId, ["runs"])
                .pipe(Effect.map((records) => records.runs)),
              predicate,
            ),
          wakeCount: Ref.get(offers).pipe(
            Effect.map((all) => all.filter((threadId) => threadId === parentThreadId).length),
          ),
          coordinatorChildren: (threadId) =>
            threads.getThreadRecords(threadId, ["subagents"]).pipe(
              Effect.map((records) => records.subagents),
              Effect.orDie,
            ),
          threads,
          workflowMcp,
          orchestratorMcp,
          workspaceLog,
          workspaceChanges,
        };
        return yield* body(current);
      }).pipe(Effect.provide(layerAll));
    }),
  );

const agentFacts = (phase: string, role: string) => ({
  kind: "agent",
  phase,
  role,
  call: expect.stringMatching(/^[0-9a-f]{16}:1$/),
  attempt: 1,
});

const REVIEW_SCRIPT = String.raw`export const meta = {
  t3: 1,
  name: "judged-review",
  description: "Review, challenge, judge",
  roles: {
    reviewer: { driver: "codex", model: "gpt-6.1-sol", interactionMode: "plan" },
    judge: { driver: "claudeAgent", model: "claude-opus-5-5", interactionMode: "plan" },
  },
  limits: { concurrency: 4, agents: 10 },
  phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
}
const FINDINGS = { type: "object", required: ["findings"], properties: { findings: { type: "array", items: { type: "string" } } } }
const VERDICT = { type: "object", required: ["refuted"], properties: { refuted: { type: "boolean" } } }
const found = (await parallel(args.areas.map((area) => () =>
  agent("Review " + area, { as: "reviewer", phase: "Review", label: "review: " + area, schema: FINDINGS })))).filter(Boolean).flatMap((r) => r.findings)
const survived = (await parallel(found.map((finding) => () =>
  agent("Refute " + finding, { as: "reviewer", phase: "Challenge", label: "challenge: " + finding, schema: VERDICT })
    .then((verdict) => (verdict && !verdict.refuted ? finding : null))))).filter(Boolean)
const ruling = await agent("Judge " + JSON.stringify(survived), { as: "judge", phase: "Judge", label: "judge" })
return { survived, ruling }`;

describe("workflow engine", () => {
  it.live(
    "runs a three-phase review, wakes the starting agent once, and records the card's data",
    () =>
      withHarness(
        {
          name: "workflow-review",
          behave: (turn, harness) =>
            Effect.gen(function* () {
              if (turn.text.startsWith("Review api")) {
                // The child returns its structured result through t3_task_return.
                for (const [value, reason] of [
                  [{ findings: "not an array" }, "does not match"],
                  [{ findings: ["x".repeat(1024 * 1024)] }, "larger than 1 MiB"],
                ] as const) {
                  yield* harness()
                    .orchestratorMcp.returnTaskResult(childScope(turn.threadId, turn.instanceId), {
                      value,
                    })
                    .pipe(
                      Effect.flip,
                      Effect.tap((refused) =>
                        Effect.sync(() => {
                          expect(refused.code).toBe("invalid_request");
                          expect(refused.message).toContain(reason);
                        }),
                      ),
                      Effect.orDie,
                    );
                }
                yield* harness()
                  .orchestratorMcp.returnTaskResult(childScope(turn.threadId, turn.instanceId), {
                    value: { findings: ["leak", "race"] },
                  })
                  .pipe(Effect.orDie);
                return { text: "Done reviewing." };
              }
              // Without the tool, the JSON at the end of the final message counts.
              if (turn.text.startsWith("Review ui")) return { text: 'Found: {"findings": []}' };
              if (turn.text.startsWith("Refute leak")) return { text: '{"refuted": false}' };
              if (turn.text.startsWith("Refute race")) return { text: '{"refuted": true}' };
              if (turn.text.startsWith("Judge")) return { text: "Accept the leak." };
              if (turn.text.startsWith("Delegated task")) return { text: "noted" };
              return { fail: `unexpected prompt: ${turn.text.slice(0, 40)}` };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const dry = yield* harness.runWorkflow({
              source: REVIEW_SCRIPT,
              args: { areas: ["api", "ui"] },
              dryRun: true,
            });
            expect(dry).toMatchObject({
              status: "dry_run",
              name: "judged-review",
              dialect: "t3",
              phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
              limits: { concurrency: 4, agents: 10, notes: [] },
            });
            const started = yield* harness.runWorkflow({
              source: REVIEW_SCRIPT,
              args: { areas: ["api", "ui"] },
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(coordinator.t3Workflow).toEqual({
              kind: "run",
              name: "judged-review",
              phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
            });
            expect(coordinator.status).toBe("completed");
            expect(workflowValue(coordinator.result)).toEqual({
              survived: ["leak"],
              ruling: "Accept the leak.",
            });
            expect(yield* harness.wakeCount).toBe(1);

            const agents = yield* harness.coordinatorChildren(started.childThreadId);
            expect(
              agents
                .map((task) => [task.title, task.t3Workflow, task.providerInstanceId] as const)
                .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
            ).toEqual([
              ["challenge: leak", agentFacts("Challenge", "reviewer"), codexId],
              ["challenge: race", agentFacts("Challenge", "reviewer"), codexId],
              ["judge", agentFacts("Judge", "judge"), claudeId],
              ["review: api", agentFacts("Review", "reviewer"), codexId],
              ["review: ui", agentFacts("Review", "reviewer"), codexId],
            ]);
            expect(agents.find((task) => task.title === "review: api")?.structuredResult).toEqual({
              findings: ["leak", "race"],
            });
            // Children never woke the coordinator's provider.
            expect(agents.every((task) => task.completionDelivery === undefined)).toBe(true);

            const coordinatorItems = yield* harness.threads.getThreadRecords(
              started.childThreadId,
              ["turnItems"],
              { turnItemTypes: ["todo_list", "assistant_message"] },
            );
            const phases = coordinatorItems.turnItems.find((item) => item.type === "todo_list");
            expect(
              phases?.type === "todo_list" && phases.steps.map((step) => [step.text, step.status]),
            ).toEqual([
              ["Review", "completed"],
              ["Challenge", "completed"],
              ["Judge", "completed"],
            ]);
            expect(
              coordinatorItems.turnItems.some(
                (item) => item.type === "assistant_message" && item.text === "**Challenge**",
              ),
            ).toBe(true);
          }),
      ),
  );

  it.live(
    "queues past the concurrency limit, lets writers take turns, caps agents and nulls failures",
    () =>
      Effect.gen(function* () {
        const concurrency = yield* makeConcurrency;
        const readersBoth = yield* Deferred.make<void>();
        const liveReaders = yield* Ref.make(0);
        return yield* withHarness(
          {
            name: "workflow-limits",
            behave: (turn) =>
              Effect.gen(function* () {
                if (turn.text.startsWith("read")) {
                  yield* concurrency.enter("reader");
                  // Two readers must overlap: with one slot this would never resolve.
                  const live = yield* Ref.updateAndGet(liveReaders, (count) => count + 1);
                  if (live === 2) yield* Deferred.succeed(readersBoth, undefined);
                  yield* Deferred.await(readersBoth);
                  yield* Ref.update(liveReaders, (count) => count - 1);
                  yield* concurrency.leave("reader");
                  return { text: turn.text.toUpperCase() };
                }
                if (turn.text.startsWith("write")) {
                  yield* concurrency.enter("writer");
                  yield* Effect.yieldNow;
                  yield* concurrency.leave("writer");
                  return { text: turn.text.toUpperCase() };
                }
                if (turn.text === "fail please") return { fail: "the provider gave up" };
                return { text: "noted" };
              }),
          },
          (harness) =>
            Effect.gen(function* () {
              yield* harness.startParent;
              const started = yield* harness.runWorkflow({
                source: String.raw`export const meta = {
  t3: 1,
  name: "limits",
  roles: { reader: { inherit: true, interactionMode: "plan" }, writer: { inherit: true } },
  limits: { concurrency: 2, agents: 6 },
}
const reads = await parallel([1, 2, 3].map((n) => () => agent("read " + n, { as: "reader" })))
const writes = await parallel([1, 2].map((n) => () => agent("write " + n, { as: "writer" })))
const failed = await agent("fail please", { as: "reader" })
const capped = await agent("one too many", { as: "reader", detailed: true })
return { reads, writes, failed, capped }`,
              });
              if (started.status !== "started") return yield* Effect.die("not started");
              yield* harness.parentWoken;
              const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
              const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
              // The script carried on past the cap, so its result says what the cap cut.
              const [result, note] = coordinator.result!.split("\n\n");
              expect(workflowValue(result)).toEqual({
                reads: ["READ 1", "READ 2", "READ 3"],
                writes: ["WRITE 1", "WRITE 2"],
                failed: null,
                // Asked for its outcome, the call says why it delivered nothing.
                capped: {
                  ok: false,
                  reason: "limit",
                  message: "This run reached its limit of 6 agents.",
                },
              });
              expect(note).toBe(
                [
                  "Note: agent() returned null for 2 calls:",
                  "- fail please: failed (the provider gave up)",
                  "- one too many: limit (This run reached its limit of 6 agents.)",
                ].join("\n"),
              );
              expect(yield* concurrency.peak("reader")).toBe(2);
              expect(yield* concurrency.peak("writer")).toBe(1);
              // The second writer was only started once the first had finished.
              const agents = yield* harness.coordinatorChildren(started.childThreadId);
              const writers = agents
                .filter((task) => task.prompt.startsWith("write"))
                .toSorted(
                  (left, right) =>
                    DateTime.toEpochMillis(left.startedAt!) -
                    DateTime.toEpochMillis(right.startedAt!),
                );
              expect(writers).toHaveLength(2);
              expect(DateTime.toEpochMillis(writers[1]!.startedAt!)).toBeGreaterThanOrEqual(
                DateTime.toEpochMillis(writers[0]!.completedAt!),
              );
              expect(agents.some((task) => task.prompt === "one too many")).toBe(false);
              const log = yield* harness.threads.getThreadRecords(
                started.childThreadId,
                ["turnItems"],
                {
                  turnItemTypes: ["assistant_message"],
                },
              );
              const lines = log.turnItems.flatMap((item) =>
                item.type === "assistant_message" ? [item.text] : [],
              );
              expect(lines.some((line) => line.includes("fail please failed"))).toBe(true);
              expect(lines.some((line) => line.includes("limit of 6 agents"))).toBe(true);
            }),
        );
      }),
  );

  it.live("starts an agent again when its provider was only unavailable, then gives up", () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      const delays = yield* Ref.make<ReadonlyArray<number>>([]);
      return yield* withHarness(
        {
          name: "workflow-provider-retry",
          retryWait: (delay) => Ref.update(delays, (all) => [...all, Duration.toMillis(delay)]),
          behave: (turn) =>
            Ref.modify(turns, (all) => {
              const count = (all.get(turn.text) ?? 0) + 1;
              return [count, new Map(all).set(turn.text, count)] as const;
            }).pipe(
              Effect.map((count): FakeOutcome => {
                // A provider that marks nothing retryable, saying its model is busy.
                if (turn.text === "busy") {
                  return count <= 2
                    ? { fail: "Selected model is at capacity.", retryable: null }
                    : { text: "done at last" };
                }
                if (turn.text === "always busy") {
                  return { fail: "Claude API is overloaded (529).", retryable: true };
                }
                if (turn.text === "broken") return { fail: "bad request", retryable: null };
                return { text: "noted" };
              }),
            ),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              // Three calls under a limit of three agents: retries are not new agents.
              source: String.raw`export const meta = { t3: 1, name: "provider-retry", limits: { agents: 3 } }
const busy = await agent("busy", { detailed: true })
const always = await agent("always busy", { detailed: true })
const broken = await agent("broken")
return { busy, always, broken }`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(coordinator.status).toBe("completed");
            expect(workflowValue(coordinator.result)).toEqual({
              busy: { ok: true, value: "done at last" },
              always: {
                ok: false,
                reason: "provider-unavailable",
                message: "Claude API is overloaded (529).",
              },
              broken: null,
            });
            // Two retries for "busy", all three for "always busy", none for a request the
            // provider refused for itself.
            expect(Object.fromEntries(yield* Ref.get(turns))).toMatchObject({
              busy: 3,
              "always busy": 4,
              broken: 1,
            });
            expect(yield* Ref.get(delays)).toEqual([30_000, 120_000, 30_000, 120_000, 300_000]);
            // Each retry is the call's next attempt.
            const agents = yield* harness.coordinatorChildren(started.childThreadId);
            expect(
              agents
                .filter((task) => task.prompt === "always busy")
                .map((task) => (task.t3Workflow?.kind === "agent" ? task.t3Workflow.attempt : 0))
                .toSorted(),
            ).toEqual([1, 2, 3, 4]);
            const log = yield* harness.threads.getThreadRecords(
              started.childThreadId,
              ["turnItems"],
              { turnItemTypes: ["assistant_message"] },
            );
            const lines = log.turnItems.flatMap((item) =>
              item.type === "assistant_message" ? [item.text] : [],
            );
            expect(lines).toContain(
              "busy failed because its provider is unavailable (Selected model is at capacity.). Trying again in 30 s, retry 1 of 3.",
            );
            expect(
              lines.some((line) => line.includes("Trying again in 5 min, retry 3 of 3.")),
            ).toBe(true);
          }),
      );
    }),
  );

  it.live("reruns after an interruption, reusing finished agents and waiting on live ones", () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      const bStarted = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-resume",
          behave: (turn) =>
            Effect.gen(function* () {
              const count = yield* Ref.modify(turns, (all) => {
                const next = (all.get(turn.text) ?? 0) + 1;
                return [next, new Map(all).set(turn.text, next)] as const;
              });
              if (turn.text === "step a") return { text: "A" };
              if (turn.text === "step b") {
                yield* Deferred.succeed(bStarted, undefined);
                yield* Deferred.await(releaseB);
                return { text: "B" };
              }
              if (turn.text === "step c") return count === 1 ? { fail: "flaky" } : { text: "C" };
              return { text: "noted" };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              // Plan-mode agents, so b and c run side by side instead of taking turns.
              source: String.raw`export const meta = { t3: 1, name: "resume", roles: { r: { inherit: true, interactionMode: "plan" } } }
const a = await agent("step a", { as: "r" })
const [b, c] = await parallel([() => agent("step b", { as: "r" }), () => agent("step c", { as: "r" })])
return { a, b, c }`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            const coordinatorThreadId = started.childThreadId;
            yield* Deferred.await(bStarted);
            yield* harness.waitForChildren(coordinatorThreadId, (children) =>
              children.some((task) => task.prompt === "step c" && task.status === "failed"),
            );

            // A restart cuts the coordinator's turn, not its children.
            const coordinator = yield* harness.threads.getThreadRecords(coordinatorThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-resume:interrupt"),
              threadId: coordinatorThreadId,
              runId: coordinator.runs[0]!.id,
            });
            yield* harness.waitForRuns(
              coordinatorThreadId,
              (runs) => runs[0]?.status === "interrupted",
            );
            // With b still live, the workflow is waiting on its agents, not finished.
            const unfinished = yield* harness.threads.getThreadRecords(parentThreadId, [
              "subagents",
            ]);
            expect(unfinished.subagents.find((task) => task.id === started.taskId)?.status).toBe(
              "running",
            );

            // Retry: any new turn on the coordinator reruns the script from the top.
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-resume:retry"),
              threadId: coordinatorThreadId,
              messageId: MessageId.make("message:workflow-resume:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.waitForChildren(coordinatorThreadId, (children) =>
              children.some(
                (task) =>
                  task.prompt === "step c" &&
                  task.t3Workflow?.kind === "agent" &&
                  task.t3Workflow.attempt === 2,
              ),
            );
            yield* Deferred.succeed(releaseB, undefined);
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const finished = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(finished.status).toBe("completed");
            expect(workflowValue(finished.result)).toEqual({ a: "A", b: "B", c: "C" });
            expect(Object.fromEntries(yield* Ref.get(turns))).toMatchObject({
              "step a": 1,
              "step b": 1,
              "step c": 2,
            });
            expect(yield* harness.wakeCount).toBe(1);
          }),
      );
    }),
  );

  it.live("reports a running workflow's progress in task_status", () =>
    Effect.gen(function* () {
      const slowStarted = yield* Deferred.make<void>();
      const releaseSlow = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-progress",
          behave: (turn) =>
            turn.text === "slow"
              ? Deferred.succeed(slowStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSlow)),
                  Effect.as({ text: "SLOW" }),
                )
              : Effect.succeed({ text: turn.text.toUpperCase() }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "progress", phases: [{ title: "Review" }, { title: "Judge" }] }
const quick = await agent("quick", { phase: "Review" })
log("Halfway there, quick said " + quick + ".\nThe rest is detail.")
return [quick, await agent("slow", { phase: "Review" })]`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* Deferred.await(slowStarted);
            const running = yield* harness.orchestratorMcp
              .taskStatus(parentScope, started.taskId)
              .pipe(Effect.orDie);
            expect(running.status).toBe("running");
            expect(running.workflowProgress).toEqual({
              runningPhases: ["Review"],
              agentsDone: 1,
              agentsStarted: 2,
              waitingForUser: 0,
              latestLog: "Halfway there, quick said QUICK.",
            });

            yield* Deferred.succeed(releaseSlow, undefined);
            yield* harness.parentWoken;
            const finished = yield* harness.orchestratorMcp
              .taskStatus(parentScope, started.taskId)
              .pipe(Effect.orDie);
            expect(finished.status).toBe("completed");
            // Once the run ends its result says the rest.
            expect(finished.workflowProgress).toBeUndefined();
          }),
      );
    }),
  );

  it.live("says what the run's agents spent, in each provider's unit", () =>
    withHarness(
      {
        name: "workflow-spend",
        behave: () =>
          Effect.succeed({
            text: "done",
            usage: {
              usedTokens: 1_000,
              totalProcessedTokens: 5_000,
              cost: { amount: 1.25, currency: "Bobcoins" },
            },
          }),
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const started = yield* harness.runWorkflow({
            source: String.raw`export const meta = { t3: 1, name: "spend" }
return await parallel([() => agent("one"), () => agent("two")])`,
          });
          if (started.status !== "started") return yield* Effect.die("not started");
          yield* harness.parentWoken;
          const records = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          const row = records.subagents.find((task) => task.id === started.taskId)!;
          expect(row.status).toBe("completed");
          // One attempt: nothing to total across.
          expect(row.result).toContain("Its agents spent 2.5 Bobcoins.");
        }),
    ),
  );

  it.live("adds the spend to a failure and totals it across attempts", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const spend = {
        usedTokens: 1_000,
        totalProcessedTokens: 5_000,
        cost: { amount: 1.25, currency: "Bobcoins" },
      };
      return yield* withHarness(
        {
          name: "workflow-retry-spend",
          behave: (turn) =>
            turn.text === "flaky"
              ? Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.map((count) =>
                    count === 1 ? { fail: "flaky" } : { text: "fine", usage: spend },
                  ),
                )
              : Effect.succeed({ text: "noted", usage: spend }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "retry-spend" }
await agent("steady")
const result = await agent("flaky")
if (result === null) throw new Error("the flaky agent failed")
return result`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            const failed = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            // The spend is its own paragraph after the failure, and one attempt totals nothing.
            expect(failed.subagents.find((task) => task.id === started.taskId)?.result).toMatch(
              /the flaky agent failed\n\nIts agents spent 1\.25 Bobcoins\.$/,
            );

            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-retry-spend:retry"),
              threadId: started.childThreadId,
              messageId: MessageId.make("message:workflow-retry-spend:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.parentWoken;
            const retried = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(retried.subagents.find((task) => task.id === started.taskId)?.result).toMatch(
              /^fine\n\nIts agents spent [\d.]+ Bobcoins in total, across attempts\.$/,
            );
          }),
      );
    }),
  );

  it.live("delivers a retried run's result after a failed one", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      return yield* withHarness(
        {
          name: "workflow-retry",
          behave: (turn) =>
            turn.text === "flaky"
              ? Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.map((count) => (count === 1 ? { fail: "flaky" } : { text: "fine" })),
                )
              : Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "retry" }
const result = await agent("flaky")
if (result === null) throw new Error("the flaky agent failed")
return result`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            const failed = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const firstRow = failed.subagents.find((task) => task.id === started.taskId)!;
            expect(firstRow.status).toBe("failed");
            expect(firstRow.result).toContain("Line 3: the flaky agent failed");

            // The coordinator only runs its script: switching it to an agent is refused.
            for (const switchCommand of [
              {
                type: "thread.model-selection.set" as const,
                commandId: CommandId.make("command:workflow-retry:switch"),
                threadId: started.childThreadId,
                modelSelection: codexSelection,
              },
              {
                type: "message.dispatch" as const,
                createdBy: "user" as const,
                creationSource: "web" as const,
                commandId: CommandId.make("command:workflow-retry:switch-message"),
                threadId: started.childThreadId,
                messageId: MessageId.make("message:workflow-retry:switch"),
                text: "Do it yourself",
                attachments: [],
                modelSelection: codexSelection,
                dispatchMode: { type: "start_immediately" as const },
              },
            ]) {
              const refused = yield* harness.threads.dispatch(switchCommand).pipe(Effect.flip);
              expect(String("cause" in refused ? refused.cause : refused)).toContain(
                "cannot switch to another provider",
              );
            }
            // Nor can a client create a thread on the workflow engine, where any
            // message it sent would be read as a run's configuration.
            const created = yield* harness.threads
              .dispatch({
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:workflow-retry:create-engine-thread"),
                threadId: ThreadId.make("thread:workflow-retry:forged"),
                projectId,
                title: "Forged coordinator",
                modelSelection: {
                  instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                  model: WorkflowAdapterV2.WORKFLOW_MODEL,
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              })
              .pipe(Effect.flip);
            expect(String("cause" in created ? created.cause : created)).toContain(
              "Only a workflow's own thread runs on the workflow engine",
            );
            // Nor start a run, or a run's agent, with a delegation of its own.
            const parentRuns = yield* harness.threads.getThreadRecords(parentThreadId, ["runs"]);
            const delegated = yield* harness.threads
              .dispatch({
                type: "delegated_task.request",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:workflow-retry:forged-run"),
                parentThreadId,
                parentRunId: parentRuns.runs[0]!.id,
                parentNodeId: parentRuns.runs[0]!.rootNodeId!,
                task: "Run workflow forged.",
                modelSelection: {
                  instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                  model: WorkflowAdapterV2.WORKFLOW_MODEL,
                },
                runtimeMode: "full-access",
                interactionMode: "default",
              })
              .pipe(Effect.flip);
            expect(String("cause" in delegated ? delegated.cause : delegated)).toContain(
              "Only an agent can start a workflow run",
            );

            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-retry:retry"),
              threadId: started.childThreadId,
              messageId: MessageId.make("message:workflow-retry:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.parentWoken;
            const retried = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            // Retry belongs to the run's own row, not a follow-up task beside it.
            expect(retried.subagents.map((task) => task.id)).toEqual([started.taskId]);
            const row = retried.subagents.find((task) => task.id === started.taskId)!;
            expect(row.status).toBe("completed");
            expect(row.result).toBe("fine");
            expect(yield* Ref.get(attempts)).toBe(2);
            expect(yield* harness.wakeCount).toBe(2);
          }),
      );
    }),
  );

  it.live("runs a command in a read-only workspace as read-only", () =>
    Effect.gen(function* () {
      const asked: Array<{ readonly command: string; readonly writable: boolean }> = [];
      return yield* withHarness(
        {
          name: "workflow-exec-read-only",
          behave: () => Effect.succeed({ text: "noted" }),
          execRun: (input) =>
            Effect.sync(() => {
              asked.push({ command: input.command, writable: input.workspace });
              return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "exec-read-only" }
const look = await workspace("look", { readOnly: true })
const work = await workspace("work")
await exec("in look", { workspace: look })
await exec("in work", { workspace: work })
await exec("in checkout")
return "done"`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            expect(asked).toEqual([
              { command: "in look", writable: false },
              { command: "in work", writable: true },
              { command: "in checkout", writable: false },
            ]);
          }),
      );
    }),
  );

  it.live("replays a finished command on Retry instead of running it again, and logs it", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workflow-exec-"));
      const count = NodePath.join(folder, "count");
      return yield* withHarness(
        {
          name: "workflow-exec-replay",
          behave: (turn) =>
            turn.text === "flaky"
              ? Ref.updateAndGet(attempts, (n) => n + 1).pipe(
                  Effect.map((n) => (n === 1 ? { fail: "flaky" } : { text: "fine" })),
                )
              : Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "exec-replay" }
const counted = await exec("echo run >> " + args.count + "; wc -l < " + args.count)
const result = await agent("flaky")
if (result === null) throw new Error("the flaky agent failed")
return { runs: counted.stdout.trim(), exitCode: counted.exitCode, result }`,
              args: { count },
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-exec-replay:retry"),
              threadId: started.childThreadId,
              messageId: MessageId.make("message:workflow-exec-replay:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const row = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(row.status).toBe("completed");
            expect(workflowValue(row.result)).toEqual({ runs: "1", exitCode: 0, result: "fine" });
            expect(NodeFS.readFileSync(count, "utf8")).toBe("run\n");
            const { turnItems } = yield* harness.threads
              .getThreadRecords(started.childThreadId, ["turnItems"], {
                turnItemTypes: ["assistant_message"],
              })
              .pipe(Effect.orDie);
            const log = turnItems.flatMap((item) =>
              item.type === "assistant_message" ? [item.text] : [],
            );
            expect(log).toContainEqual(
              expect.stringMatching(/^`echo run >> .*count` exited 0 after \d+\.\d s\.$/),
            );
            expect(log).toContainEqual(
              expect.stringMatching(
                /^`echo run >> .*count` exited 0 on an earlier attempt; exec\(\) returned that result again\.$/,
              ),
            );
            expect(log).toContainEqual(
              expect.stringContaining("; 1 command, 1 replayed from an earlier attempt."),
            );
          }),
      ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(folder, { recursive: true }))));
    }),
  );

  it.live("runs a command again on Retry when the run was stopped while it ran", () =>
    Effect.gen(function* () {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workflow-exec-"));
      const count = NodePath.join(folder, "count");
      const fifo = NodePath.join(folder, "pid");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      return yield* withHarness(
        { name: "workflow-exec-stopped", behave: () => Effect.succeed({ text: "noted" }) },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            // The first run reports its shell's pid and waits; a later one finishes.
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "exec-stopped" }
const ran = await exec("n=$(cat " + args.count + " 2>/dev/null | wc -l); echo run >> " + args.count + "; if [ $n -eq 0 ]; then echo $$ > " + args.fifo + "; exec sleep 60; fi; echo done")
return ran.stdout`,
              args: { count, fifo },
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            const pid = Number(
              (yield* Effect.promise(() => NodeFS.promises.readFile(fifo, "utf8"))).trim(),
            );
            const coordinator = yield* harness.threads.getThreadRecords(started.childThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-exec-stopped:interrupt"),
              threadId: started.childThreadId,
              runId: coordinator.runs[0]!.id,
            });
            yield* harness.waitForRuns(
              started.childThreadId,
              (runs) => runs[0]?.status === "interrupted",
            );
            // Stopping the run killed the command.
            expect(() => process.kill(pid, 0)).toThrow();
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-exec-stopped:retry"),
              threadId: started.childThreadId,
              messageId: MessageId.make("message:workflow-exec-stopped:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.waitForRuns(started.childThreadId, (runs) =>
              runs.some((run) => run.status === "completed"),
            );
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const row = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(row.result).toBe("done\n");
            expect(NodeFS.readFileSync(count, "utf8")).toBe("run\nrun\n");
          }),
      ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(folder, { recursive: true }))));
    }),
  );

  it.live("starts an agent again on Retry after its request was refused", () =>
    Effect.gen(function* () {
      const refused = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set([claudeId]));
      return yield* withHarness(
        {
          name: "workflow-refused",
          refused,
          behave: (turn) => Effect.succeed({ text: turn.text === "judge" ? "judged" : "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "refused", roles: { judge: { driver: "claudeAgent", model: "claude-opus-5-5", interactionMode: "plan" } } }
const verdict = await agent("judge", { as: "judge" })
if (verdict === null) throw new Error("the judge did not start")
return verdict`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            const failed = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(failed.subagents.find((task) => task.id === started.taskId)?.result).toContain(
              "the judge did not start",
            );

            // The provider is back. The refused request keeps its refusal, so
            // Retry starts the judge as its next attempt.
            yield* Ref.set(refused, new Set());
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-refused:retry"),
              threadId: started.childThreadId,
              messageId: MessageId.make("message:workflow-refused:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.parentWoken;
            const retried = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const row = retried.subagents.find((task) => task.id === started.taskId)!;
            expect(row.status).toBe("completed");
            expect(row.result).toBe("judged");
            const agents = yield* harness.coordinatorChildren(started.childThreadId);
            expect(
              agents.map((task) => task.t3Workflow?.kind === "agent" && task.t3Workflow.attempt),
            ).toEqual([2]);
          }),
      );
    }),
  );

  it.live("opens a result with its summary, which task_status's cut part keeps", () =>
    withHarness(
      { name: "workflow-summary", behave: () => Effect.succeed({ text: "noted" }) },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const started = yield* harness.runWorkflow({
            source: String.raw`export const meta = { t3: 1, name: "summary" }
return { findings: "z".repeat(30000), summary: "Two findings survived.", count: 2 }`,
          });
          if (started.status !== "started") return yield* Effect.die("not started");
          yield* harness.parentWoken;
          const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          const result = parent.subagents.find((task) => task.id === started.taskId)!.result!;
          // The summary leads as prose; the other fields follow as JSON.
          expect(result.startsWith("Two findings survived.\n\n```json\n")).toBe(true);
          expect(workflowValue(result.slice("Two findings survived.\n\n".length))).toEqual({
            findings: "z".repeat(30000),
            count: 2,
          });
          const read = yield* harness.orchestratorMcp.taskStatus(parentScope, started.taskId);
          expect(read.summary!.startsWith("Two findings survived.")).toBe(true);
          expect(read.summary).toContain(
            `Call task_status with resultOffset: ${ORCHESTRATOR_MCP_TASK_RESULT_MAX_CHARS}`,
          );
        }),
    ),
  );

  it.live("refuses an agent() schema it cannot check before starting the agent", () =>
    withHarness(
      { name: "workflow-bad-schema", behave: () => Effect.succeed({ text: "noted" }) },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const started = yield* harness.runWorkflow({
            source: String.raw`export const meta = { t3: 1, name: "bad-schema" }
try { await agent("x", { schema: { type: "array", contains: { type: "string" } } }) } catch (error) { return error.message }`,
          });
          if (started.status !== "started") return yield* Effect.die("not started");
          yield* harness.parentWoken;
          const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          expect(parent.subagents.find((task) => task.id === started.taskId)?.result).toContain(
            "agent(): The result schema is not supported",
          );
          expect(yield* harness.coordinatorChildren(started.childThreadId)).toEqual([]);
        }),
    ),
  );

  it.live("keeps a stopped run's worktrees for Retry and reports that it stopped", () =>
    Effect.gen(function* () {
      const building = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-stop-keep",
          behave: (turn) =>
            turn.text === "build"
              ? Deferred.succeed(building, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const run = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "keep" }
const ws = await workspace("build")
return await agent("build", { workspace: ws })`,
            });
            if (run.status !== "started") return yield* Effect.die("not started");
            yield* Deferred.await(building);
            const coordinator = yield* harness.threads.getThreadRecords(run.childThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-stop-keep:stop"),
              threadId: run.childThreadId,
              runId: coordinator.runs[0]!.id,
              holdQueue: true,
            });
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const row = parent.subagents.find((task) => task.id === run.taskId)!;
            expect(row.status).toBe("interrupted");
            expect(row.result).toBe("The workflow was stopped.");
            const branch = WorkflowWorkspaces.workflowWorkspaceBranch(run.childThreadId, "build");
            expect(yield* Ref.get(harness.workspaceLog)).toEqual([`ensure ${branch}`]);
          }),
      );
    }),
  );

  it.live("stops every live agent when the workflow is stopped", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-stop",
          behave: (turn) =>
            turn.text.startsWith("long")
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const run = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "stop", roles: { r: { inherit: true, interactionMode: "plan" } } }
return await parallel([1, 2].map((n) => () => agent("long " + n, { as: "r" })))`,
            });
            if (run.status !== "started") return yield* Effect.die("not started");
            yield* Deferred.await(started);
            yield* harness.waitForChildren(run.childThreadId, (children) => children.length === 2);
            const coordinator = yield* harness.threads.getThreadRecords(run.childThreadId, [
              "runs",
            ]);
            // Stop as the clients send it.
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-stop:stop"),
              threadId: run.childThreadId,
              runId: coordinator.runs[0]!.id,
              holdQueue: true,
            });
            const stopped = yield* harness.waitForChildren(
              run.childThreadId,
              (children) =>
                children.length === 2 && children.every((task) => task.status !== "running"),
            );
            expect(stopped.map((task) => task.status)).toEqual(["interrupted", "interrupted"]);
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === run.taskId)?.status).toBe(
              "interrupted",
            );
          }),
      );
    }),
  );

  it.live(
    "gives workspace() agents their own worktrees, in parallel, and removes them at the end",
    () =>
      Effect.gen(function* () {
        const both = yield* Deferred.make<void>();
        const live = yield* Ref.make(0);
        return yield* withHarness(
          {
            name: "workflow-workspaces",
            behave: (turn) =>
              turn.text.startsWith("build")
                ? Effect.gen(function* () {
                    // Writers in different worktrees overlap; if they took turns this would hang.
                    if ((yield* Ref.updateAndGet(live, (count) => count + 1)) === 2) {
                      yield* Deferred.succeed(both, undefined);
                    }
                    yield* Deferred.await(both);
                    return { text: `built ${turn.text.slice(6)}` };
                  })
                : Effect.succeed({ text: "noted" }),
          },
          (harness) =>
            Effect.gen(function* () {
              yield* harness.startParent;
              const started = yield* harness.runWorkflow({
                source: String.raw`export const meta = { t3: 1, name: "waves" }
return await parallel(["one", "two"].map((name) => async () => {
  const ws = await workspace(name)
  await agent("build " + name, { workspace: ws, label: "build " + name })
  return ws.branch
}))`,
              });
              if (started.status !== "started") return yield* Effect.die("not started");
              yield* harness.parentWoken;
              const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
              const branches = workflowValue(
                parent.subagents.find((task) => task.id === started.taskId)!.result,
              ) as ReadonlyArray<string>;
              const expected = ["one", "two"].map((name) =>
                WorkflowWorkspaces.workflowWorkspaceBranch(started.childThreadId, name),
              );
              expect(branches).toEqual(expected);
              expect(yield* Ref.get(harness.workspaceLog)).toEqual([
                ...expected.map((branch) => `ensure ${branch}`),
                ...expected.flatMap((branch) => [`remove ${branch}`, `settle ${branch} unchanged`]),
              ]);
              for (const task of yield* harness.coordinatorChildren(started.childThreadId)) {
                const shell = yield* harness.threads.getThreadShell(task.childThreadId!);
                expect(shell?.branch).toMatch(/^t3\/wf\/[0-9a-f]{10}\/(one|two)$/);
                expect(shell?.worktreePath).toContain(shell!.branch!.replaceAll("/", "-"));
              }
            }),
        );
      }),
  );

  it.live("starts a workspace from a ref or another workspace, and refuses a bad from", () =>
    withHarness(
      {
        name: "workflow-workspace-from",
        behave: () => Effect.succeed({ text: "noted" }),
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const started = yield* harness.runWorkflow({
            source: String.raw`export const meta = { t3: 1, name: "from" }
const impl = await workspace("impl")
const review = await workspace("review", { from: impl })
await workspace("pinned", { from: "feature/base" })
const refused = []
const attempts = [
  ["a", { from: "HEAD~1" }],
  ["b", { from: "--output=/tmp/x" }],
  ["c", { from: 42 }],
  ["d", { from: { name: "nope" } }],
  ["e", { color: "red" }],
  ["impl", { from: "main" }],
]
for (const [name, opts] of attempts) {
  try { await workspace(name, opts) } catch (error) { refused.push(error.message) }
}
return { review: review.branch, refused }`,
          });
          if (started.status !== "started") return yield* Effect.die("not started");
          yield* harness.parentWoken;
          const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          const branchOf = (name: string) =>
            WorkflowWorkspaces.workflowWorkspaceBranch(started.childThreadId, name);
          expect(
            workflowValue(parent.subagents.find((task) => task.id === started.taskId)!.result),
          ).toEqual({
            review: branchOf("review"),
            refused: [
              expect.stringContaining("from must be a branch name, a commit SHA"),
              expect.stringContaining("from must be a branch name, a commit SHA"),
              expect.stringContaining("from must be a branch name, a commit SHA"),
              expect.stringContaining('from workspace "nope" was not created in this run'),
              expect.stringContaining('option "color" is not supported'),
              expect.stringContaining('workspace("impl"): this run already asked for it'),
            ],
          });
          // The review starts from the impl workspace's branch, by its full ref.
          expect(yield* Ref.get(harness.workspaceLog)).toEqual([
            `ensure ${branchOf("impl")}`,
            `ensure ${branchOf("review")} from refs/heads/${branchOf("impl")}`,
            `ensure ${branchOf("pinned")} from feature/base`,
            ...["impl", "review", "pinned"].flatMap((name) => [
              `remove ${branchOf(name)}`,
              `settle ${branchOf(name)} unchanged`,
            ]),
          ]);
        }),
    ),
  );

  it.live(
    "runs writers side by side in a read-only workspace and discards results once it changed",
    () =>
      Effect.gen(function* () {
        const both = yield* Deferred.make<void>();
        const live = yield* Ref.make(0);
        return yield* withHarness(
          {
            name: "workflow-read-only",
            behave: (turn, harness) =>
              Effect.gen(function* () {
                if (turn.text.startsWith("review")) {
                  // Writers in one read-only workspace overlap; if they took turns this would hang.
                  if ((yield* Ref.updateAndGet(live, (count) => count + 1)) === 2) {
                    yield* Deferred.succeed(both, undefined);
                  }
                  yield* Deferred.await(both);
                  return { text: turn.text.includes("read-only workspace") ? "told" : "untold" };
                }
                if (turn.text.startsWith("tamper")) {
                  const shell = yield* harness()
                    .threads.getThreadShell(turn.threadId)
                    .pipe(Effect.orDie);
                  yield* Ref.set(
                    harness().workspaceChanges,
                    new Map([[shell!.branch!, "files changed: draft.txt"]]),
                  );
                  return { text: "tampered" };
                }
                return { text: "noted" };
              }),
          },
          (harness) =>
            Effect.gen(function* () {
              yield* harness.startParent;
              const started = yield* harness.runWorkflow({
                source: String.raw`export const meta = { t3: 1, name: "read-only" }
const snapshot = await workspace("snapshot", { from: "feature/x", readOnly: true })
const reviews = await parallel(["a", "b"].map((n) => () => agent("review " + n, { workspace: snapshot })))
const tampered = await agent("tamper", { workspace: snapshot })
const late = await agent("late look", { workspace: snapshot })
let refused = null
try { await workspace("snapshot", { from: "feature/x" }) } catch (error) { refused = error.message }
return { reviews, tampered, late, refused }`,
              });
              if (started.status !== "started") return yield* Effect.die("not started");
              yield* harness.parentWoken;
              const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
              const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
              const [result, note] = coordinator.result!.split("\n\nNote: ");
              expect(workflowValue(result)).toEqual({
                reviews: ["told", "told"],
                tampered: null,
                late: null,
                refused: expect.stringContaining("already asked for it with other options"),
              });
              expect(note).toContain("agent() returned null for 2 calls:");
              expect(note).toContain('read-only workspace "snapshot" has changes');
              // The late agent never started: the workspace had changed already.
              const agents = yield* harness.coordinatorChildren(started.childThreadId);
              expect(agents.map((task) => task.prompt.split(/\s/)[0]).toSorted()).toEqual([
                "review",
                "review",
                "tamper",
              ]);
              const log = yield* harness.threads.getThreadRecords(
                started.childThreadId,
                ["turnItems"],
                { turnItemTypes: ["assistant_message"] },
              );
              const changed = log.turnItems.flatMap((item) =>
                item.type === "assistant_message" &&
                item.text.includes('read-only workspace "snapshot" has changes') &&
                // The run's result lists them too; these are the log lines.
                !item.text.includes("agent() returned null for")
                  ? [item.text]
                  : [],
              );
              expect(changed).toEqual([
                expect.stringMatching(/^tamper: .*\(files changed: draft\.txt\)/),
                expect.stringMatching(/^late look: /),
              ]);
            }),
        );
      }),
  );

  it.live(
    "settles each workspace's branch as it asks once the run finishes, never on failure",
    () =>
      withHarness(
        {
          name: "workflow-cleanup",
          behave: () => Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const finished = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "cleanup" }
const asked = [["out", {}], ["scratch", { cleanup: "always" }], ["kept", { cleanup: "keep" }], ["look", { readOnly: true }]]
for (const [name, opts] of asked) await workspace(name, opts)
try { await workspace("bad", { cleanup: "never" }) } catch (error) { return error.message }`,
            });
            if (finished.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === finished.taskId)!.result).toBe(
              'workspace(): cleanup must be "unchanged", "keep" or "always".',
            );
            const branchOf = (name: string) =>
              WorkflowWorkspaces.workflowWorkspaceBranch(finished.childThreadId, name);
            const asked = [
              ["out", "unchanged"],
              ["scratch", "always"],
              ["kept", "keep"],
              ["look", "unchanged"],
            ] as const;
            expect(yield* Ref.get(harness.workspaceLog)).toEqual([
              ...asked.map(([name]) => `ensure ${branchOf(name)}`),
              ...asked.flatMap(([name, cleanup]) => [
                `remove ${branchOf(name)}`,
                `settle ${branchOf(name)} ${cleanup}`,
              ]),
            ]);
            // The read-only branch moved, as the stand-in settles it, so the log names it.
            const log = yield* harness.threads.getThreadRecords(
              finished.childThreadId,
              ["turnItems"],
              { turnItemTypes: ["assistant_message"] },
            );
            const kept = log.turnItems.flatMap((item) =>
              item.type === "assistant_message" && item.text.startsWith("Kept branch")
                ? [item.text]
                : [],
            );
            expect(kept).toEqual([
              `Kept branch ${branchOf("look")} of read-only workspace "look": it is no longer where it started.`,
            ]);

            // A run that fails keeps its worktrees and branches for Retry.
            yield* Ref.set(harness.workspaceLog, []);
            const failed = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "fails" }
await workspace("left")
throw new Error("boom")`,
            });
            if (failed.status !== "started") return yield* Effect.die("not started");
            yield* harness.parentWoken;
            expect(yield* Ref.get(harness.workspaceLog)).toEqual([
              `ensure ${WorkflowWorkspaces.workflowWorkspaceBranch(failed.childThreadId, "left")}`,
            ]);
          }),
      ),
  );

  it.live("runs a Claude workflow: model tiers become roles and isolation gets a worktree", () =>
    withHarness(
      {
        name: "workflow-claude",
        behave: (turn) => Effect.succeed({ text: `${turn.instanceId}: ${turn.text}` }),
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const started = yield* harness.runWorkflow({
            source: String.raw`export const meta = { name: "claude-style", description: "From a Claude run" }
const judged = await agent("judge it", { model: "opus" })
const edited = await agent("edit it", { isolation: "worktree" })
return [judged, edited]`,
          });
          if (started.status !== "started") return yield* Effect.die(started);
          expect(started.roles.map((role) => [role.role, role.bound?.model])).toEqual([
            ["model:opus", "claude-opus-5-5"],
          ]);
          yield* harness.parentWoken;
          const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          expect(
            workflowValue(parent.subagents.find((task) => task.id === started.taskId)!.result),
          ).toEqual(["claudeAgent: judge it", "codex: edit it"]);
          const log = yield* Ref.get(harness.workspaceLog);
          expect(log).toHaveLength(3);
          expect(log[0]).toMatch(/^ensure t3\/wf\/[0-9a-f]{10}\/agent-[0-9a-f]{8}-1$/);
          expect(log[1]).toBe(log[0]!.replace("ensure", "remove"));
          // A Claude agent's worktree branch goes when the agent made no commits.
          expect(log[2]).toBe(`${log[0]!.replace("ensure", "settle")} unchanged`);
          // Claude features T3 cannot honor are refused before anything starts.
          const refused = yield* harness
            .runWorkflow({
              source: String.raw`export const meta = { name: "x", description: "y" }
await agent("review", { agentType: "code-reviewer" })`,
            })
            .pipe(Effect.asVoid, Effect.flip);
          expect(refused.message).toContain("Line 2: agentType is not supported");
        }),
    ),
  );

  it.live("reads a workflow from the workspace or an attachment, and refuses other paths", () =>
    withHarness(
      {
        name: "workflow-files",
        behave: () => Effect.succeed({ text: "noted" }),
        settings: { workflowMaxConcurrency: 8, workflowMaxAgents: 100 },
      },
      (harness) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const script = String.raw`export const meta = {
  t3: 1,
  name: "from-a-file",
  args: { type: "object", required: ["range"], properties: { range: { type: "string" } } },
  roles: { judge: { driver: "codex", model: "gpt-9" }, fixer: { inherit: true, runtimeMode: "approval-required" } },
  limits: { concurrency: 20, agents: 500 },
}
return args.range`;
          yield* fs.writeFileString(`${harness.cwd}/review.workflow.js`, script);
          yield* fs.makeDirectory(harness.attachmentsDir, { recursive: true });
          yield* fs.writeFileString(`${harness.attachmentsDir}/plan-attachment.js`, script);
          yield* harness.startParentWith([
            {
              type: "file",
              id: "plan-attachment",
              name: "plan.workflow.js",
              mimeType: "text/javascript",
              sizeBytes: script.length,
            },
          ]);

          const fromWorkspace = yield* harness.runWorkflow({
            file: "review.workflow.js",
            args: { range: "main..HEAD" },
            dryRun: true,
          });
          // Caps clamp what the file asks for, and say so.
          expect(fromWorkspace).toMatchObject({
            status: "dry_run",
            name: "from-a-file",
            limits: {
              concurrency: 8,
              agents: 100,
              notes: [
                "The script asks for 20 concurrent agents; this environment allows 8.",
                "The script asks for 500 agents; this environment allows 100.",
              ],
            },
          });
          if (fromWorkspace.status !== "dry_run") return;
          // A model this machine lacks is unbound, with the driver's models as candidates.
          const judge = fromWorkspace.roles.find((role) => role.role === "judge")!;
          expect(judge.bound).toBeNull();
          expect(judge.candidates.map((candidate) => candidate.model)).toEqual([
            "gpt-6",
            "gpt-6.1-sol",
          ]);
          expect(fromWorkspace.roles.find((role) => role.role === "fixer")?.bound).toMatchObject({
            runtimeMode: "approval-required",
            writer: true,
          });

          const fromAttachment = yield* harness.runWorkflow({
            file: "plan.workflow.js",
            args: { range: "a..b" },
            dryRun: true,
          });
          expect(fromAttachment.status).toBe("dry_run");

          const outside = yield* harness
            .runWorkflow({ file: "../../etc/passwd", dryRun: true })
            .pipe(Effect.asVoid, Effect.flip);
          expect(outside.code).toBe("invalid_request");
          expect(outside.message).toContain("not in this thread's workspace");

          const badArgs = yield* harness
            .runWorkflow({ file: "review.workflow.js", args: { range: 3 }, dryRun: true })
            .pipe(Effect.asVoid, Effect.flip);
          expect(badArgs.message).toContain("args do not match meta.args");

          // Unbound roles start nothing unless told to inherit.
          const unbound = yield* harness.runWorkflow({
            file: "review.workflow.js",
            args: { range: "x" },
          });
          expect(unbound.status).toBe("unbound_roles");
          expect(yield* harness.coordinatorChildren(parentThreadId)).toEqual([]);
          const inheriting = yield* harness.runWorkflow({
            file: "review.workflow.js",
            args: { range: "x" },
            unboundRoles: "inherit",
          });
          expect(inheriting.status).toBe("started");
        }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reads a workflow from the user's workflows folder, and nothing else outside", () =>
    withHarness(
      { name: "workflow-personal", behave: () => Effect.succeed({ text: "noted" }) },
      (harness) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const script = (name: string) => `export const meta = { t3: 1, name: "${name}" }
return 1`;
          const folder = `${harness.t3Home}/workflows`;
          yield* fs.makeDirectory(`${folder}/team`, { recursive: true });
          yield* fs.writeFileString(`${folder}/mine.workflow.js`, script("personal"));
          yield* fs.writeFileString(`${folder}/team/review.js`, script("team-review"));
          yield* fs.writeFileString(`${folder}/shared.workflow.js`, script("personal-shared"));
          yield* fs.writeFileString(`${harness.cwd}/shared.workflow.js`, script("project-shared"));
          // Beside the folder, and a link out of it: neither may be read.
          yield* fs.writeFileString(`${harness.t3Home}/beside.js`, script("beside"));
          yield* fs.symlink(`${harness.t3Home}/beside.js`, `${folder}/link.js`);
          yield* harness.startParent;

          const nameOf = (file: string) =>
            harness.runWorkflow({ file, dryRun: true }).pipe(Effect.map((result) => result.name));
          expect(yield* nameOf("mine.workflow.js")).toBe("personal");
          expect(yield* nameOf("team/review.js")).toBe("team-review");
          expect(yield* nameOf(`${folder}/mine.workflow.js`)).toBe("personal");
          // The project's copy wins over a personal one of the same name.
          expect(yield* nameOf("shared.workflow.js")).toBe("project-shared");

          for (const file of [
            "link.js",
            "../beside.js",
            `${harness.t3Home}/beside.js`,
            `${folder}/../beside.js`,
          ]) {
            const refused = yield* harness
              .runWorkflow({ file, dryRun: true })
              .pipe(Effect.asVoid, Effect.flip);
            expect(refused.code).toBe("invalid_request");
            expect(refused.message).toContain(`the workflows folder ${folder}`);
          }
        }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("refuses a role broader than the starting thread's modes before starting anything", () =>
    withHarness(
      { name: "workflow-modes", behave: () => Effect.succeed({ text: "noted" }) },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          yield* harness.threads.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("command:workflow-modes:plan"),
            threadId: parentThreadId,
            interactionMode: "plan",
          });
          const refused = yield* harness
            .runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "modes", roles: { fixer: { inherit: true, interactionMode: "default" } } }
return 1`,
            })
            .pipe(Effect.asVoid, Effect.flip);
          expect(refused.code).toBe("interaction_mode_escalation_denied");
          expect(yield* harness.coordinatorChildren(parentThreadId)).toEqual([]);
        }),
    ),
  );

  it.live("gives delegate_task a structured result for any agent", () =>
    withHarness(
      {
        name: "workflow-delegate-schema",
        behave: (turn) =>
          Effect.succeed(
            turn.text.startsWith("Count the files")
              ? { text: 'There are three.\n{"count": 3}' }
              : { text: "noted" },
          ),
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const schema = {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer" } },
          };
          const delegated = yield* harness.orchestratorMcp.delegateTask(parentScope, {
            task: "Count the files.",
            resultSchema: schema,
            mode: "wait",
          });
          expect(delegated.status).toBe("completed");
          // The child had no tool call, so its final message's JSON counts.
          expect(delegated.structuredResult).toEqual({ count: 3 });
          const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
          const task = parent.subagents.find((row) => row.id === delegated.taskId)!;
          expect(task.resultSchema).toEqual(schema);
          expect(task.prompt).toContain("t3_task_return");
          const refused = yield* harness.orchestratorMcp
            .delegateTask(parentScope, {
              task: "Anything",
              resultSchema: {
                type: "object",
                properties: { names: { type: "array", contains: { type: "string" } } },
              },
            })
            .pipe(Effect.asVoid, Effect.flip);
          expect(refused.code).toBe("invalid_request");
        }),
    ),
  );

  it.live("keeps a returned null over JSON in the final message", () =>
    withHarness(
      {
        name: "workflow-delegate-null",
        behave: (turn, harness) =>
          Effect.gen(function* () {
            if (!turn.text.startsWith("Find the file.")) return { text: "noted" };
            yield* harness()
              .orchestratorMcp.returnTaskResult(childScope(turn.threadId, turn.instanceId), {
                value: null,
              })
              .pipe(Effect.orDie);
            return { text: 'Nothing found, unlike before:\n{"path": "a.ts"}' };
          }),
      },
      (harness) =>
        Effect.gen(function* () {
          yield* harness.startParent;
          const delegated = yield* harness.orchestratorMcp.delegateTask(parentScope, {
            task: "Find the file.",
            resultSchema: {
              anyOf: [
                { type: "null" },
                { type: "object", required: ["path"], properties: { path: { type: "string" } } },
              ],
            },
            mode: "wait",
          });
          expect(delegated.status).toBe("completed");
          expect(delegated.structuredResult).toBe(null);
          const status = yield* harness.orchestratorMcp.taskStatus(parentScope, delegated.taskId);
          expect(status.structuredResult).toBe(null);
        }),
    ),
  );

  it.live("gives a follow-up to a structured task its own result", () =>
    Effect.gen(function* () {
      const returns = yield* Ref.make<ReadonlyArray<string>>([]);
      const returnFrom = (turn: FakeTurn, harness: Harness, value: { readonly ok: boolean }) =>
        harness.orchestratorMcp
          .returnTaskResult(childScope(turn.threadId, turn.instanceId), {
            value,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: (result) => result.taskId,
            }),
            Effect.flatMap((outcome) => Ref.update(returns, (all) => [...all, outcome])),
          );
      return yield* withHarness(
        {
          name: "workflow-delegate-followup",
          behave: (turn, harness) =>
            Effect.gen(function* () {
              if (turn.text.startsWith("Check it.")) {
                yield* returnFrom(turn, harness(), { ok: true });
                return { text: "Checked." };
              }
              if (turn.text === "Check again with the tool.") {
                yield* returnFrom(turn, harness(), { ok: false });
                return { text: "Rechecked." };
              }
              // Without the tool, the follow-up's own final JSON counts.
              if (turn.text === "Check once more.") return { text: '{"ok": false}' };
              return { text: "noted" };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const delegated = yield* harness.orchestratorMcp.delegateTask(parentScope, {
              task: "Check it.",
              resultSchema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              },
              mode: "wait",
            });
            expect(delegated.structuredResult).toEqual({ ok: true });
            yield* harness.waitForChildren(parentThreadId, (rows) =>
              rows.some((row) => row.id === delegated.taskId && row.result !== null),
            );

            const followUp = (message: string) =>
              Effect.gen(function* () {
                const sent = yield* harness.orchestratorMcp.sendToThread(parentScope, {
                  threadId: delegated.childThreadId,
                  message,
                });
                const taskId = sent.taskId!;
                expect(taskId).not.toBe(delegated.taskId);
                const rows = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
                // A new task starts without the original's returned value.
                expect(rows.subagents.find((row) => row.id === taskId)?.structuredResult).toBe(
                  undefined,
                );
                yield* harness.waitForChildren(parentThreadId, (all) =>
                  all.some((row) => row.id === taskId && row.result !== null),
                );
                return taskId;
              });

            const returned = yield* followUp("Check again with the tool.");
            // The follow-up's t3_task_return lands on the follow-up, not the finished original.
            expect(yield* Ref.get(returns)).toEqual([delegated.taskId, returned]);
            const returnedStatus = yield* harness.orchestratorMcp.taskStatus(parentScope, returned);
            expect(returnedStatus.structuredResult).toEqual({ ok: false });

            const recovered = yield* followUp("Check once more.");
            const recoveredStatus = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              recovered,
            );
            expect(recoveredStatus.status).toBe("completed");
            expect(recoveredStatus.structuredResult).toEqual({ ok: false });

            const original = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              delegated.taskId,
            );
            expect(original.structuredResult).toEqual({ ok: true });
          }),
      );
    }),
  );

  it.live("refuses a stopped follow-up's late return instead of giving it to the next one", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-delegate-late-return",
          behave: (turn, harness) =>
            Effect.gen(function* () {
              if (turn.text.startsWith("Check it.")) {
                yield* harness()
                  .orchestratorMcp.returnTaskResult(childScope(turn.threadId, turn.instanceId), {
                    value: { ok: true },
                  })
                  .pipe(Effect.orDie);
                return { text: "Checked." };
              }
              if (turn.text === "Hold.") {
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Effect.never;
              }
              return { text: "noted" };
            }),
          // Once the first follow-up is live, the next one stays starting until released.
          beforeResume: Deferred.isDone(firstStarted).pipe(
            Effect.flatMap((held) => (held ? Deferred.await(release) : Effect.void)),
          ),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const delegated = yield* harness.orchestratorMcp.delegateTask(parentScope, {
              task: "Check it.",
              resultSchema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              },
              mode: "wait",
            });
            expect(delegated.structuredResult).toEqual({ ok: true });
            yield* harness.waitForChildren(parentThreadId, (rows) =>
              rows.some((row) => row.id === delegated.taskId && row.result !== null),
            );
            const child = delegated.childThreadId;
            const first = yield* harness.orchestratorMcp.sendToThread(parentScope, {
              threadId: child,
              message: "Hold.",
            });
            yield* Deferred.await(firstStarted);
            const second = yield* harness.orchestratorMcp.sendToThread(parentScope, {
              threadId: child,
              message: "Second.",
              mode: "queue",
            });
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:late-return:interrupt"),
              threadId: child,
              runId: first.runId,
            });
            yield* harness.waitForRuns(
              child,
              (runs) =>
                runs.some((run) => run.id === first.runId && run.status === "interrupted") &&
                runs.some((run) => run.id === second.runId && run.status === "starting"),
            );

            // A t3_task_return the first follow-up sent before it was stopped, handled now.
            yield* harness.orchestratorMcp
              .returnTaskResult(childScope(child, codexId), { value: { ok: false } })
              .pipe(Effect.asVoid, Effect.flip);
            const rows = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(rows.subagents.find((row) => row.id === second.taskId)?.structuredResult).toBe(
              undefined,
            );

            yield* Deferred.succeed(release, undefined);
            yield* harness.waitForChildren(parentThreadId, (all) =>
              all.some((row) => row.id === second.taskId && row.result !== null),
            );
            const secondStatus = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              second.taskId!,
            );
            expect(secondStatus.status).toBe("completed");
            expect(secondStatus.structuredResult).toBe(null);
            const original = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              delegated.taskId,
            );
            expect(original.structuredResult).toEqual({ ok: true });
          }),
      );
    }),
  );

  it.live("refuses a return whose run is stopped while the return is handled", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const finishSecond = yield* Deferred.make<void>();
      const holdNextRead = yield* Ref.make(false);
      const reading = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      const returnOk = (turn: FakeTurn, harness: Harness) =>
        harness.orchestratorMcp
          .returnTaskResult(childScope(turn.threadId, turn.instanceId), { value: { ok: true } })
          .pipe(Effect.orDie);
      return yield* withHarness(
        {
          name: "workflow-delegate-inflight-return",
          // Once armed, the next read stalls as a slow projection read would.
          beforeMcpRead: Ref.getAndSet(holdNextRead, false).pipe(
            Effect.flatMap((hold) =>
              hold
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseRead)),
                  )
                : Effect.void,
            ),
          ),
          behave: (turn, harness) =>
            Effect.gen(function* () {
              if (turn.text.startsWith("Check it.")) {
                yield* returnOk(turn, harness());
                return { text: "Checked." };
              }
              if (turn.text === "Hold.") {
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Effect.never;
              }
              if (turn.text === "Second.") {
                yield* Deferred.succeed(secondStarted, undefined);
                yield* Deferred.await(finishSecond);
                yield* returnOk(turn, harness());
                return { text: "Checked again." };
              }
              return { text: "noted" };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const delegated = yield* harness.orchestratorMcp.delegateTask(parentScope, {
              task: "Check it.",
              resultSchema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              },
              mode: "wait",
            });
            yield* harness.waitForChildren(parentThreadId, (rows) =>
              rows.some((row) => row.id === delegated.taskId && row.result !== null),
            );
            const child = delegated.childThreadId;
            const first = yield* harness.orchestratorMcp.sendToThread(parentScope, {
              threadId: child,
              message: "Hold.",
            });
            yield* Deferred.await(firstStarted);
            const second = yield* harness.orchestratorMcp.sendToThread(parentScope, {
              threadId: child,
              message: "Second.",
              mode: "queue",
            });

            // The first follow-up's t3_task_return arrives and its read stalls.
            yield* Ref.set(holdNextRead, true);
            const late = yield* harness.orchestratorMcp
              .returnTaskResult(childScope(child, codexId), { value: { ok: false } })
              .pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(reading);
            // Meanwhile that run is stopped and the queued follow-up takes over.
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:inflight-return:interrupt"),
              threadId: child,
              runId: first.runId,
            });
            yield* Deferred.await(secondStarted);
            yield* harness.waitForRuns(child, (runs) =>
              runs.some((run) => run.id === second.runId && run.status === "running"),
            );
            yield* Deferred.succeed(releaseRead, undefined);

            const refused = yield* Fiber.join(late);
            expect(refused.code).toBe("invalid_request");
            // Recording checks the sender again, for a run that ends after the read.
            const misdirected = yield* harness.threads
              .dispatch({
                type: "delegated_task.return",
                commandId: CommandId.make("command:inflight-return:misdirected"),
                parentThreadId,
                taskId: second.taskId!,
                childRunId: first.runId,
                value: { ok: false },
              })
              .pipe(Effect.flip);
            expect(misdirected).toMatchObject({
              cause: expect.stringContaining("is no longer working on delegated task"),
            });
            const rows = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(rows.subagents.find((row) => row.id === second.taskId)?.structuredResult).toBe(
              undefined,
            );

            // The follow-up's own return still lands on its own task.
            yield* Deferred.succeed(finishSecond, undefined);
            yield* harness.waitForChildren(parentThreadId, (all) =>
              all.some((row) => row.id === second.taskId && row.result !== null),
            );
            const secondStatus = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              second.taskId!,
            );
            expect(secondStatus.structuredResult).toEqual({ ok: true });
            const original = yield* harness.orchestratorMcp.taskStatus(
              parentScope,
              delegated.taskId,
            );
            expect(original.structuredResult).toEqual({ ok: true });
          }),
      );
    }),
  );

  it.live("runs a Claude workflow run's own script by its path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Claude keeps a run's script under ~/.claude/projects; the read below sees a scratch home.
      // Not through HOME: the home folder is read once per process and kept.
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-home-" });
      const scriptPath = `${home}/.claude/projects/repo/session/workflow-script.js`;
      yield* fs.makeDirectory(`${home}/.claude/projects/repo/session`, { recursive: true });
      yield* fs.writeFileString(
        scriptPath,
        "export const meta = { name: 'from-claude', description: 'A Claude run' }\nreturn 1",
      );
      return yield* withHarness(
        { name: "workflow-claude-file", behave: () => Effect.succeed({ text: "noted" }) },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const dry = yield* harness
              .runWorkflow({ file: scriptPath, dryRun: true })
              .pipe(Effect.provideService(HostProcess.HomeDirectory, home));
            expect(dry).toMatchObject({
              status: "dry_run",
              name: "from-claude",
              dialect: "claude",
            });
          }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops agents the script did not wait for and still finishes", () =>
    Effect.gen(function* () {
      const releaseStop = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-unawaited",
          behave: (turn) =>
            turn.text === "linger" ? Effect.never : Effect.succeed({ text: "noted" }),
          // The lingering agent takes its time to stop, past the coordinator's own run.
          beforeInterrupted: (turn) =>
            turn.text === "linger" ? Deferred.await(releaseStop) : Effect.void,
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "unawaited", roles: { r: { inherit: true, interactionMode: "plan" } } }
agent("linger", { as: "r" })
await agent("quick", { as: "r" })
return "done"`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            yield* harness.waitForRuns(
              started.childThreadId,
              (runs) => runs[0]?.status === "completed",
            );
            const waiting = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(waiting.subagents.find((task) => task.id === started.taskId)?.status).toBe(
              "running",
            );
            // The last agent to stop settles the finished coordinator.
            yield* Deferred.succeed(releaseStop, undefined);
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(coordinator.status).toBe("completed");
            expect(coordinator.result).toBe("done");
            const agents = yield* harness.coordinatorChildren(started.childThreadId);
            expect(Object.fromEntries(agents.map((task) => [task.prompt, task.status]))).toEqual({
              linger: "interrupted",
              quick: "completed",
            });
            expect(yield* harness.wakeCount).toBe(1);
          }),
      );
    }),
  );

  it.live("keeps an agent an earlier turn left running inside the concurrency limit", () =>
    Effect.gen(function* () {
      const concurrency = yield* makeConcurrency;
      const firstTurns = yield* Ref.make(0);
      const fallbackStarted = yield* Deferred.make<void>();
      const releaseFallback = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-orphan-slot",
          behave: (turn) =>
            Effect.gen(function* () {
              if (turn.text === "first") {
                yield* concurrency.enter("agent");
                const count = yield* Ref.updateAndGet(firstTurns, (n) => n + 1);
                yield* concurrency.leave("agent");
                return count === 1 ? { fail: "flaky" } : { text: "ok" };
              }
              if (turn.text === "fallback") {
                yield* concurrency.enter("agent");
                yield* Deferred.succeed(fallbackStarted, undefined);
                yield* Deferred.await(releaseFallback);
                yield* concurrency.leave("agent");
                return { text: "fell back" };
              }
              if (turn.text === "second") {
                yield* concurrency.enter("agent");
                yield* concurrency.leave("agent");
                return { text: "second" };
              }
              return { text: "noted" };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "orphan", roles: { r: { inherit: true, interactionMode: "plan" } }, limits: { concurrency: 1 } }
const first = await agent("first", { as: "r", phase: "First" })
if (first === null) return await agent("fallback", { as: "r" })
return await agent("second", { as: "r" })`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            const coordinatorThreadId = started.childThreadId;
            yield* Deferred.await(fallbackStarted);
            const coordinator = yield* harness.threads.getThreadRecords(coordinatorThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-orphan-slot:interrupt"),
              threadId: coordinatorThreadId,
              runId: coordinator.runs[0]!.id,
            });
            yield* harness.waitForRuns(
              coordinatorThreadId,
              (runs) => runs[0]?.status === "interrupted",
            );

            // The rerun's first succeeds, so it never reaches the fallback still running.
            const beforeRetry = yield* harness.threads.getThreadEventSequence(coordinatorThreadId);
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-orphan-slot:retry"),
              threadId: coordinatorThreadId,
              messageId: MessageId.make("message:workflow-orphan-slot:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            // The rerun enters the First phase just before it asks for a slot,
            // which the fallback holds until it finishes.
            yield* harness.threads
              .streamStoredEventsFrom({
                threadId: coordinatorThreadId,
                afterSequence: beforeRetry,
                eventType: "turn-item.updated",
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "turn-item.updated" &&
                    stored.event.payload.type === "assistant_message" &&
                    stored.event.payload.text === "**First**",
                ),
                Stream.runHead,
                Effect.orDie,
              );
            yield* Deferred.succeed(releaseFallback, undefined);
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === started.taskId)?.result).toBe(
              "second",
            );
            expect(yield* concurrency.peak("agent")).toBe(1);
            const agents = yield* harness.coordinatorChildren(coordinatorThreadId);
            const fallback = agents.find((task) => task.prompt === "fallback")!;
            const retried = agents.find(
              (task) =>
                task.prompt === "first" &&
                task.t3Workflow?.kind === "agent" &&
                task.t3Workflow.attempt === 2,
            )!;
            expect(fallback.status).toBe("completed");
            // The left-over fallback held the only slot until it finished.
            expect(DateTime.toEpochMillis(retried.startedAt!)).toBeGreaterThanOrEqual(
              DateTime.toEpochMillis(fallback.completedAt!),
            );
          }),
      );
    }),
  );

  it.live("keeps a writer an earlier turn left running in sole charge of its checkout", () =>
    Effect.gen(function* () {
      const concurrency = yield* makeConcurrency;
      const firstTurns = yield* Ref.make(0);
      const fallbackStarted = yield* Deferred.make<void>();
      const releaseFallback = yield* Deferred.make<void>();
      const retryWriterStarted = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-orphan-writer",
          behave: (turn) =>
            Effect.gen(function* () {
              if (turn.text === "first") {
                yield* concurrency.enter("agent");
                const count = yield* Ref.updateAndGet(firstTurns, (n) => n + 1);
                if (count === 2) yield* Deferred.succeed(retryWriterStarted, undefined);
                yield* concurrency.leave("agent");
                return count === 1 ? { fail: "flaky" } : { text: "ok" };
              }
              if (turn.text === "fallback") {
                yield* concurrency.enter("agent");
                yield* Deferred.succeed(fallbackStarted, undefined);
                yield* Deferred.await(releaseFallback);
                yield* concurrency.leave("agent");
                return { text: "fell back" };
              }
              return { text: "second" };
            }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            // Writers in the coordinator's checkout, with a slot to spare.
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "orphan-writer", roles: { w: { inherit: true } }, limits: { concurrency: 2 } }
const first = await agent("first", { as: "w", phase: "First" })
if (first === null) return await agent("fallback", { as: "w" })
return await agent("second", { as: "w" })`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            const coordinatorThreadId = started.childThreadId;
            yield* Deferred.await(fallbackStarted);
            const coordinator = yield* harness.threads.getThreadRecords(coordinatorThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-orphan-writer:interrupt"),
              threadId: coordinatorThreadId,
              runId: coordinator.runs[0]!.id,
            });
            yield* harness.waitForRuns(
              coordinatorThreadId,
              (runs) => runs[0]?.status === "interrupted",
            );

            const beforeRetry = yield* harness.threads.getThreadEventSequence(coordinatorThreadId);
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-orphan-writer:retry"),
              threadId: coordinatorThreadId,
              messageId: MessageId.make("message:workflow-orphan-writer:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            // The rerun's first has a slot, but the fallback still owns the
            // checkout, so first waits for it rather than editing beside it.
            const waited = harness.threads
              .streamStoredEventsFrom({
                threadId: coordinatorThreadId,
                afterSequence: beforeRetry,
                eventType: "turn-item.updated",
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "turn-item.updated" &&
                    stored.event.payload.type === "assistant_message" &&
                    stored.event.payload.text === "first waits for its turn in the checkout.",
                ),
                Stream.runHead,
                Effect.orDie,
                Effect.as("waited" as const),
              );
            expect(
              yield* Effect.race(
                waited,
                Deferred.await(retryWriterStarted).pipe(Effect.as("started" as const)),
              ),
            ).toBe("waited");
            yield* Deferred.succeed(releaseFallback, undefined);
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === started.taskId)?.result).toBe(
              "second",
            );
            expect(yield* concurrency.peak("agent")).toBe(1);
            const agents = yield* harness.coordinatorChildren(coordinatorThreadId);
            const fallback = agents.find((task) => task.prompt === "fallback")!;
            const retried = agents.find(
              (task) =>
                task.prompt === "first" &&
                task.t3Workflow?.kind === "agent" &&
                task.t3Workflow.attempt === 2,
            )!;
            expect(fallback.status).toBe("completed");
            expect(DateTime.toEpochMillis(retried.startedAt!)).toBeGreaterThanOrEqual(
              DateTime.toEpochMillis(fallback.completedAt!),
            );
          }),
      );
    }),
  );

  it.live("starts agents no broader than the coordinator's modes when it is narrowed", () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      return yield* withHarness(
        {
          name: "workflow-narrowed",
          behave: (turn) =>
            Ref.modify(turns, (all) => {
              const next = (all.get(turn.text) ?? 0) + 1;
              return [next, new Map(all).set(turn.text, next)] as const;
            }).pipe(
              Effect.map((count) =>
                turn.text === "flaky"
                  ? count === 1
                    ? { fail: "flaky" }
                    : { text: "F" }
                  : turn.text === "steady"
                    ? { text: "S" }
                    : { text: "noted" },
              ),
            ),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const started = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "narrowed" }
const steady = await agent("steady")
const flaky = await agent("flaky")
if (flaky === null) throw new Error("flaky failed")
return steady + flaky`,
            });
            if (started.status !== "started") return yield* Effect.die("not started");
            const coordinatorThreadId = started.childThreadId;
            yield* harness.parentWoken;

            // The user narrows the coordinator, then retries it.
            yield* harness.threads.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("command:workflow-narrowed:narrow"),
              threadId: coordinatorThreadId,
              runtimeMode: "approval-required",
            });
            yield* harness.threads.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:workflow-narrowed:retry"),
              threadId: coordinatorThreadId,
              messageId: MessageId.make("message:workflow-narrowed:retry"),
              text: "Retry",
              attachments: [],
              modelSelection: {
                instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                model: WorkflowAdapterV2.WORKFLOW_MODEL,
              },
              dispatchMode: { type: "start_immediately" },
            });
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === started.taskId)?.result).toBe("SF");
            // The finished agent is reused, not rerun at the narrower mode.
            expect(Object.fromEntries(yield* Ref.get(turns))).toMatchObject({
              steady: 1,
              flaky: 2,
            });
            const agents = yield* harness.coordinatorChildren(coordinatorThreadId);
            const modes = yield* Effect.forEach(agents, (task) =>
              harness.threads
                .getThreadRecords(task.childThreadId!, ["runs"])
                .pipe(
                  Effect.map(
                    ({ thread }) =>
                      `${task.prompt}#${task.t3Workflow?.kind === "agent" ? task.t3Workflow.attempt : 0} ${thread.runtimeMode}`,
                  ),
                ),
            );
            expect(modes.toSorted()).toEqual([
              "flaky#1 full-access",
              "flaky#2 approval-required",
              "steady#1 full-access",
            ]);
          }),
      );
    }),
  );

  it.live("stops a nested workflow and its agents when the outer workflow is stopped", () =>
    Effect.gen(function* () {
      const deepLive = yield* Ref.make(0);
      const deepStarted = yield* Deferred.make<void>();
      return yield* withHarness(
        {
          name: "workflow-nested-stop",
          behave: (turn, harness) =>
            turn.text === "nest"
              ? // An agent of the outer workflow starts its own workflow and keeps working.
                harness()
                  .workflowMcp.runWorkflow(childScope(turn.threadId, turn.instanceId), {
                    source: String.raw`export const meta = { t3: 1, name: "inner", roles: { r: { inherit: true, interactionMode: "plan" } } }
return await parallel([1, 2].map((n) => () => agent("deep " + n, { as: "r" })))`,
                  })
                  .pipe(Effect.orDie, Effect.andThen(Effect.never))
              : turn.text.startsWith("deep")
                ? Ref.updateAndGet(deepLive, (count) => count + 1).pipe(
                    Effect.tap((count) =>
                      count === 2 ? Deferred.succeed(deepStarted, undefined) : Effect.void,
                    ),
                    Effect.andThen(Effect.never),
                  )
                : Effect.succeed({ text: "noted" }),
        },
        (harness) =>
          Effect.gen(function* () {
            yield* harness.startParent;
            const run = yield* harness.runWorkflow({
              source: String.raw`export const meta = { t3: 1, name: "outer" }
return await agent("nest")`,
            });
            if (run.status !== "started") return yield* Effect.die("not started");
            yield* Deferred.await(deepStarted);
            const [nest] = yield* harness.coordinatorChildren(run.childThreadId);
            const [inner] = yield* harness.coordinatorChildren(nest!.childThreadId!);
            const innerCoordinatorThreadId = inner!.childThreadId!;

            // Stop as the card sends it, on the outer coordinator only.
            const coordinator = yield* harness.threads.getThreadRecords(run.childThreadId, [
              "runs",
            ]);
            yield* harness.threads.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:workflow-nested-stop:stop"),
              threadId: run.childThreadId,
              runId: coordinator.runs[0]!.id,
              holdQueue: true,
            });
            const deep = yield* harness.waitForChildren(
              innerCoordinatorThreadId,
              (children) =>
                children.length === 2 && children.every((task) => task.status !== "running"),
            );
            expect(deep.map((task) => task.status)).toEqual(["interrupted", "interrupted"]);
            yield* harness.waitForRuns(innerCoordinatorThreadId, (runs) =>
              runs.every((candidate) => candidate.status !== "running"),
            );
            yield* harness.waitForChildren(nest!.childThreadId!, (children) =>
              children.every((task) => task.status !== "running"),
            );
            yield* harness.parentWoken;
            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            expect(parent.subagents.find((task) => task.id === run.taskId)?.status).toBe(
              "interrupted",
            );
          }),
      );
    }),
  );
});
