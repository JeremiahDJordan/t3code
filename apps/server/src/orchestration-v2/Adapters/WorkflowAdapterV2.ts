/**
 * The built-in workflow engine as a hidden V2 provider. A workflow run is a
 * delegated task whose child thread this adapter "drives": its turn runs the
 * script, so each `agent()` call can hang from a live run like any delegated
 * task. The instance is served by the adapter registry but never listed, so
 * no provider picker, capability list, usage or status ever shows it.
 *
 * The engine needs thread management, which needs the orchestrator, which
 * needs this adapter. `WorkflowEngineHost` breaks that cycle: the engine
 * registers its turn runner once it is built, and turns start through it.
 */
import {
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  WORKFLOW_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProtocolError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";

export const WORKFLOW_DRIVER = ProviderDriverKind.make("workflow");
export const WORKFLOW_MODEL = "script";

/** The smallest capability set: turns run and can be interrupted, nothing else. */
const WorkflowProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

/** One engine turn: the adapter's input, and how to publish its events. */
export interface WorkflowTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  readonly emit: (events: ReadonlyArray<ProviderAdapterV2Event>) => Effect.Effect<void>;
}

/** Runs a turn to its end, emitting its own terminal event, including when interrupted. */
export type WorkflowTurnRunner = (turn: WorkflowTurn) => Effect.Effect<void>;

export class WorkflowEngineHost extends Context.Service<
  WorkflowEngineHost,
  {
    readonly register: (runner: WorkflowTurnRunner) => Effect.Effect<void>;
    readonly runner: Effect.Effect<Option.Option<WorkflowTurnRunner>>;
  }
>()("t3/orchestration-v2/Adapters/WorkflowAdapterV2/WorkflowEngineHost") {}

/** One host shared by the adapter and the engine; layer memoization keeps it single. */
export const layerEngineHost = Layer.effect(
  WorkflowEngineHost,
  Ref.make<Option.Option<WorkflowTurnRunner>>(Option.none()).pipe(
    Effect.map((runner) =>
      WorkflowEngineHost.of({
        register: (next) => Ref.set(runner, Option.some(next)),
        runner: Ref.get(runner),
      }),
    ),
  ),
);

const unsupported = (detail: string) =>
  Effect.fail(new ProviderAdapterProtocolError({ driver: WORKFLOW_DRIVER, detail }));

const makeAdapter = Effect.gen(function* () {
  const host = yield* WorkflowEngineHost;
  return {
    instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
    driver: WORKFLOW_DRIVER,
    getCapabilities: () => Effect.succeed(WorkflowProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const turns = yield* FiberMap.make<ProviderTurnId>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: WORKFLOW_DRIVER,
          providerInstanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? ".",
          model: WORKFLOW_MODEL,
          capabilities: WorkflowProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const emit = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          PubSub.publishAll(events, providerEvents).pipe(Effect.asVoid);
        return {
          instanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
          driver: WORKFLOW_DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              if (threadInput.existingProviderThread !== undefined) {
                return threadInput.existingProviderThread;
              }
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:workflow:${threadInput.threadId}`),
                driver: WORKFLOW_DRIVER,
                providerInstanceId: WORKFLOW_PROVIDER_INSTANCE_ID,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: WORKFLOW_DRIVER,
                  nativeId: threadInput.threadId,
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
          startTurn: (input) =>
            Effect.gen(function* () {
              const runner = yield* host.runner;
              if (Option.isNone(runner)) {
                return yield* new ProviderAdapterTurnStartError({
                  driver: WORKFLOW_DRIVER,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: "The workflow engine is not running.",
                });
              }
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:workflow:${input.runId}:${input.attemptId}`,
              );
              const startedAt = yield* DateTime.now;
              yield* emit([
                {
                  type: "provider_turn.updated",
                  driver: WORKFLOW_DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver: WORKFLOW_DRIVER,
                      nativeId: `${input.runId}:${input.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  },
                },
              ]);
              yield* FiberMap.run(
                turns,
                providerTurnId,
                runner.value({ input, providerTurnId, emit }),
              );
            }),
          steerTurn: (input) =>
            Effect.fail(
              new ProviderAdapterSteerRunUnsupportedError({
                driver: WORKFLOW_DRIVER,
                providerThreadId: input.providerThread.id,
              }),
            ),
          interruptTurn: ({ providerTurnId }) => FiberMap.remove(turns, providerTurnId),
          respondToRuntimeRequest: () => unsupported("A workflow raises no runtime requests."),
          readThreadSnapshot: () => unsupported("A workflow has no thread snapshot."),
          rollbackThread: () => unsupported("A workflow cannot be rolled back."),
          forkThread: () => unsupported("A workflow cannot be forked."),
        };
      }),
  } satisfies ProviderAdapterV2Shape;
});

/**
 * The adapter registry with the workflow adapter added: served by id, left
 * out of `list`, so nothing that enumerates providers ever offers it.
 */
export const layerRegistryWithWorkflowAdapter = <E, R>(
  base: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2, E, R>,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const adapter = yield* makeAdapter;
      return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) =>
          instanceId === WORKFLOW_PROVIDER_INSTANCE_ID
            ? Effect.succeed(adapter)
            : registry.get(instanceId),
        list: registry.list,
        getMetadata: (instanceId) =>
          instanceId === WORKFLOW_PROVIDER_INSTANCE_ID
            ? Effect.succeed({
                driver: WORKFLOW_DRIVER,
                continuationKey: WORKFLOW_PROVIDER_INSTANCE_ID,
                enabled: true,
                capabilities: WorkflowProviderCapabilitiesV2,
              })
            : registry.getMetadata !== undefined
              ? registry.getMetadata(instanceId)
              : Effect.fail(
                  new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                ),
      });
    }),
  ).pipe(Layer.provide(base));
