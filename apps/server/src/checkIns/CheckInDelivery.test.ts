import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { worktreeRepairDependenciesTestLayer } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

// The check-in scheduler on the real V2 orchestrator: its notices must pass the orchestrator's
// rules for server-made notifications, and a retried notice must be answered from its receipt.

const START = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;
const PROJECT_ID = ProjectId.make("project:check-in-delivery");
const THREAD_ID = ThreadId.make("thread:check-in-delivery");

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no provider sessions run in this test"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-check-in-delivery-",
});

const OrchestratorTestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(PlatformTestLayer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(PlatformTestLayer),
);

const makeHarness = Effect.fn("makeCheckInDeliveryHarness")(function* () {
  // A check-in whose removal fails once, as a crash between the message and its record would.
  const failRemovalOnce = yield* Ref.make(false);
  const checkIns = Layer.effect(
    ThreadCheckIns.ThreadCheckInRepository,
    Effect.gen(function* () {
      const repository = yield* ThreadCheckIns.ThreadCheckInRepository;
      return ThreadCheckIns.ThreadCheckInRepository.of({
        ...repository,
        remove: (checkInId) =>
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(failRemovalOnce, false)) {
              return yield* new PersistenceSqlError({ operation: "removeCheckIn" });
            }
            return yield* repository.remove(checkInId);
          }),
      });
    }),
  ).pipe(Layer.provide(ThreadCheckIns.layer));
  const layer = CheckInScheduler.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        checkIns,
        ThreadBackgroundCommands.layer,
        ThreadBackgroundCommands.changesLayer,
      ),
    ),
    Layer.provideMerge(OrchestratorTestLayer),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  return { layer, failRemovalOnce };
});

const seedThread = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* projects.create({
    commandId: CommandId.make("command:seed-project"),
    projectId: PROJECT_ID,
    title: "Check-in delivery",
    workspaceRoot: "/workspace/check-in-delivery",
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:seed-thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Check-in delivery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

describe("check-in delivery on the V2 orchestrator", () => {
  it.effect("lands as a notification the orchestrator accepts, once even when retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { layer, failRemovalOnce } = yield* makeHarness();
        yield* Effect.gen(function* () {
          yield* seedThread;
          const scheduler = yield* CheckInScheduler.CheckInScheduler;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const checkIn = yield* scheduler.schedule({
            threadId: THREAD_ID,
            note: "Check the desktop build.",
            inMinutes: 1,
            repeatEveryMinutes: null,
          });

          // The message goes in, but recording it fails, so the check-in stays due.
          yield* Ref.set(failRemovalOnce, true);
          yield* TestClock.setTime(START + MINUTE);
          yield* scheduler.runDueNow;
          expect(yield* scheduler.list(THREAD_ID)).toHaveLength(1);

          const projection = yield* orchestrator.getThreadProjection(THREAD_ID);
          const messageId = `check-in:${checkIn.id}:1`;
          const message = projection.messages.find((candidate) => candidate.id === messageId);
          expect(message).toMatchObject({
            role: "user",
            text: "[T3 Code check-in] Check the desktop build.",
            createdBy: "agent",
            creationSource: "server",
            notification: {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Check-in: Check the desktop build.",
            },
          });
          const runs = projection.runs.filter((run) => run.userMessageId === messageId);
          expect(runs).toHaveLength(1);

          // The turn it started ends (no provider runs here), so the thread can take the retry.
          const [run] = runs;
          if (run === undefined) return;
          const finishedAt = DateTime.makeUnsafe(START + 2 * MINUTE);
          yield* TestClock.setTime(START + 2 * MINUTE);
          yield* (yield* EventSink.EventSinkV2).write({
            commandId: CommandId.make("command:finish-notice-run"),
            events: [
              {
                id: EventId.make("event:finish-notice-run"),
                type: "run.updated",
                threadId: THREAD_ID,
                runId: run.id,
                occurredAt: finishedAt,
                payload: { ...run, status: "completed", completedAt: finishedAt },
              },
            ],
          });

          // The retry is the same command, answered from its receipt: no second message or run.
          yield* scheduler.runDueNow;
          expect(yield* scheduler.list(THREAD_ID)).toEqual([]);
          const after = yield* orchestrator.getThreadProjection(THREAD_ID);
          expect(after.messages.filter((candidate) => candidate.id === messageId)).toHaveLength(1);
          expect(after.runs).toHaveLength(projection.runs.length);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});
