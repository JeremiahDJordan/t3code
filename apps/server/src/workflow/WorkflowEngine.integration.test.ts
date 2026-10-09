import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
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
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as WorkflowMcpService from "../mcp/WorkflowMcpService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as WorkflowAdapterV2 from "../orchestration-v2/Adapters/WorkflowAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as WorkflowSandbox from "./WorkflowSandbox.ts";
import * as WorkflowSourceStore from "./WorkflowSourceStore.ts";
import * as WorkflowWorkspaces from "./WorkflowWorkspaces.ts";

const projectId = ProjectId.make("project:workflow");
const parentThreadId = ThreadId.make("thread:workflow-parent");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexSelection = { instanceId: codexId, model: "gpt-6" } satisfies ModelSelection;
const PARENT_PROMPT = "Run the workflow.";

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
  | { readonly fail: string };

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
}): ProviderAdapterV2Shape {
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
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
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
                          retryable: false,
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
  adapters: ReadonlyArray<ProviderAdapterV2Shape>,
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
    readonly refused?: Ref.Ref<ReadonlySet<ProviderInstanceId>>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
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
      const adapters = [
        makeFakeAdapter({
          instanceId: codexId,
          driver: ProviderDriverKind.make("codex"),
          behave,
          ...(beforeInterrupted === undefined ? {} : { beforeInterrupted }),
        }),
        makeFakeAdapter({
          instanceId: claudeId,
          driver: ProviderDriverKind.make("claudeAgent"),
          behave,
          ...(beforeInterrupted === undefined ? {} : { beforeInterrupted }),
        }),
      ];
      const workspaceLog = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerWorkspaces = Layer.succeed(
        WorkflowWorkspaces.WorkflowWorkspaces,
        WorkflowWorkspaces.WorkflowWorkspaces.of({
          ensure: ({ branch }) =>
            Ref.update(workspaceLog, (all) => [...all, `ensure ${branch}`]).pipe(
              Effect.as({ worktreePath: `${cwd}-worktrees/${branch.replaceAll("/", "-")}` }),
            ),
          remove: ({ branch }) => Ref.update(workspaceLog, (all) => [...all, `remove ${branch}`]),
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
      const layerThreads = ThreadManagementService.layer.pipe(Layer.provide(layerOrchestrator));
      const layerSources = WorkflowSourceStore.layer.pipe(Layer.provide(layerDatabase));
      const layerEngine = WorkflowEngine.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            WorkflowAdapterV2.layerEngineHost,
            layerThreads,
            IdAllocator.layer,
            layerSources,
            WorkflowSandbox.layerTest,
            layerWorkspaces,
          ),
        ),
      );
      const layerConfig = ServerConfig.layerTest(cwd, { prefix: "t3-workflow-config-" }).pipe(
        Layer.provide(NodeServices.layer),
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
            ServerSettings.layerTest(options.settings ?? {}).pipe(Layer.orDie),
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
            layerThreads,
            layerRegistry,
            ProviderRegistryMock.layer([
              providerSnapshot(codexId, "codex", ["gpt-6", "gpt-6.1-sol"]),
              providerSnapshot(claudeId, "claudeAgent", ["claude-opus-5-5"]),
            ]),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ProjectService.ProjectService)({}),
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
            expect(coordinator.workflow).toEqual({
              kind: "run",
              name: "judged-review",
              phases: [{ title: "Review" }, { title: "Challenge" }, { title: "Judge" }],
            });
            expect(coordinator.status).toBe("completed");
            expect(JSON.parse(coordinator.result!)).toEqual({
              survived: ["leak"],
              ruling: "Accept the leak.",
            });
            expect(yield* harness.wakeCount).toBe(1);

            const agents = yield* harness.coordinatorChildren(started.childThreadId);
            expect(
              agents
                .map((task) => [task.title, task.workflow, task.providerInstanceId] as const)
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
const capped = await agent("one too many", { as: "reader" })
return { reads, writes, failed, capped }`,
              });
              if (started.status !== "started") return yield* Effect.die("not started");
              yield* harness.parentWoken;
              const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
              const coordinator = parent.subagents.find((task) => task.id === started.taskId)!;
              // The script carried on past the cap, so its result says what the cap cut.
              const [result, note] = coordinator.result!.split("\n\nNote: ");
              expect(JSON.parse(result!)).toEqual({
                reads: ["READ 1", "READ 2", "READ 3"],
                writes: ["WRITE 1", "WRITE 2"],
                failed: null,
                capped: null,
              });
              expect(note).toBe(
                "this run reached its limit of 6 agents, so 1 agent() call returned null without running; 1 agent failed, stopped or returned no valid result, so agent() returned null for it.",
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
                  task.workflow?.kind === "agent" &&
                  task.workflow.attempt === 2,
              ),
            );
            yield* Deferred.succeed(releaseB, undefined);
            yield* harness.parentWoken;

            const parent = yield* harness.threads.getThreadRecords(parentThreadId, ["subagents"]);
            const finished = parent.subagents.find((task) => task.id === started.taskId)!;
            expect(finished.status).toBe("completed");
            expect(JSON.parse(finished.result!)).toEqual({ a: "A", b: "B", c: "C" });
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
            const row = retried.subagents.find((task) => task.id === started.taskId)!;
            expect(row.status).toBe("completed");
            expect(row.result).toBe("fine");
            expect(yield* Ref.get(attempts)).toBe(2);
            expect(yield* harness.wakeCount).toBe(2);
          }),
      );
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
              agents.map((task) => task.workflow?.kind === "agent" && task.workflow.attempt),
            ).toEqual([2]);
          }),
      );
    }),
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
              const branches = JSON.parse(
                parent.subagents.find((task) => task.id === started.taskId)!.result!,
              ) as ReadonlyArray<string>;
              const expected = ["one", "two"].map((name) =>
                WorkflowWorkspaces.workflowWorkspaceBranch(started.childThreadId, name),
              );
              expect(branches).toEqual(expected);
              expect(yield* Ref.get(harness.workspaceLog)).toEqual([
                ...expected.map((branch) => `ensure ${branch}`),
                ...expected.map((branch) => `remove ${branch}`),
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
            JSON.parse(parent.subagents.find((task) => task.id === started.taskId)!.result!),
          ).toEqual(["claudeAgent: judge it", "codex: edit it"]);
          const log = yield* Ref.get(harness.workspaceLog);
          expect(log).toHaveLength(2);
          expect(log[0]).toMatch(/^ensure t3\/wf\/[0-9a-f]{10}\/agent-[0-9a-f]{8}-1$/);
          expect(log[1]).toBe(log[0]!.replace("ensure", "remove"));
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

  it.live("runs a Claude workflow run's own script by its path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-home-" });
      const previousHome = process.env.HOME;
      // Claude keeps a run's script under ~/.claude/projects; point HOME at a scratch one.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.HOME = home;
        }),
        () =>
          Effect.sync(() => {
            process.env.HOME = previousHome;
          }),
      );
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
            const dry = yield* harness.runWorkflow({ file: scriptPath, dryRun: true });
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
                task.workflow?.kind === "agent" &&
                task.workflow.attempt === 2,
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
                      `${task.prompt}#${task.workflow?.kind === "agent" ? task.workflow.attempt : 0} ${thread.runtimeMode}`,
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
