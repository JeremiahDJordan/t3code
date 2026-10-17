import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PushGatewayDelivery,
  type PushGatewayResult,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProjectId, type OrchestrationV2ThreadShell, ProviderInstanceId } from "@t3tools/contracts";

import { agentAwarenessRelayTurnedOff } from "../cloud/t3ConnectTurnedOff.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PushDevices from "./PushDevices.ts";
import * as PushGatewayClient from "./PushGatewayClient.ts";
import * as PushGatewayPublisher from "./PushGatewayPublisher.ts";

const NOW = "2026-10-17T12:00:00.000Z";
const THREAD = ThreadId.make("thread");

const state = (phase: RelayAgentActivityState["phase"]): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("env"),
  threadId: THREAD,
  projectTitle: "Project",
  threadTitle: "Fix the build",
  modelTitle: "gpt",
  headline: "Agent",
  phase,
  updatedAt: NOW,
  deepLink: "/threads/env/thread",
});

const device = (overrides: Partial<PushDevices.PushDevice> = {}): PushDevices.PushDevice => ({
  deviceId: "iphone",
  sessionId: "session",
  platform: "ios",
  label: "iPhone",
  bundleId: "com.example.z6",
  apsEnvironment: "production",
  appVersion: null,
  pushToken: "apns",
  activityPushToken: null,
  activityRegisteredAt: null,
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  updatedAt: NOW,
  ...overrides,
});

/** A gateway that records what it is sent and answers from `answer`. */
function harness(devices: Array<PushDevices.PushDevice>) {
  const sent: Array<ReadonlyArray<PushGatewayDelivery>> = [];
  const cleared: Array<{ kind: string; deviceId: string; token: string }> = [];
  const gateway = {
    answer: (_delivery: PushGatewayDelivery): PushGatewayResult => ({ ok: true, status: 200 }),
  };
  const fakeDevices = PushDevices.PushDevices.of({
    register: () => Effect.void,
    registerLiveActivity: () => Effect.void,
    unregister: () => Effect.void,
    listDeliverable: Effect.sync(() => [...devices]),
    clearPushToken: (deviceId, token) =>
      Effect.sync(() => {
        cleared.push({ kind: "push", deviceId, token });
        const index = devices.findIndex((d) => d.deviceId === deviceId && d.pushToken === token);
        if (index >= 0) devices[index] = { ...devices[index]!, pushToken: null };
      }),
    clearActivityPushToken: (deviceId, token) =>
      Effect.sync(() => void cleared.push({ kind: "activity", deviceId, token })),
    registrations: Stream.empty,
  });
  const fakeGateway = PushGatewayClient.PushGatewayClient.of({
    send: (deliveries) =>
      Effect.sync(() => {
        sent.push(deliveries);
        return deliveries.map((delivery) => gateway.answer(delivery));
      }),
  });
  const deliverer = PushGatewayPublisher.makeDeliverer.pipe(
    Effect.provideService(PushDevices.PushDevices, fakeDevices),
    Effect.provideService(PushGatewayClient.PushGatewayClient, fakeGateway),
  );
  return { deliverer, sent, cleared, gateway };
}

const atNow = TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));

describe("PushGatewayPublisher", () => {
  it.effect("sends one alert per transition and nothing for a repeat", () =>
    Effect.gen(function* () {
      yield* atNow;
      const h = harness([device()]);
      const deliverer = yield* h.deliverer;
      yield* deliverer.publish(THREAD, state("running"));
      yield* deliverer.publish(THREAD, state("waiting_for_input"));
      yield* deliverer.publish(THREAD, state("waiting_for_input"));
      assert.lengthOf(h.sent, 1);
      assert.strictEqual(h.sent[0]?.[0]?.kind, "alert");
    }),
  );

  it.effect("retires a token APNs refuses for good, and keeps delivering to the rest", () =>
    Effect.gen(function* () {
      yield* atNow;
      const h = harness([device(), device({ deviceId: "ipad", pushToken: "ipad-apns" })]);
      h.gateway.answer = (delivery) =>
        delivery.token === "apns"
          ? { ok: false, status: 410, reason: "Unregistered" }
          : { ok: true, status: 200 };
      const deliverer = yield* h.deliverer;
      yield* deliverer.publish(THREAD, state("failed"));
      assert.deepStrictEqual(h.cleared, [{ kind: "push", deviceId: "iphone", token: "apns" }]);
      assert.lengthOf(h.sent[0] ?? [], 2);
    }),
  );

  it.effect("fails a transient refusal so the publish retries the same alert", () =>
    Effect.gen(function* () {
      yield* atNow;
      const h = harness([device()]);
      h.gateway.answer = () => ({ ok: false, status: 503, reason: "ServiceUnavailable" });
      const deliverer = yield* h.deliverer;
      const failure = yield* deliverer.publish(THREAD, state("completed")).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PushDeliveryRetryError");
      h.gateway.answer = () => ({ ok: true, status: 200 });
      yield* deliverer.publish(THREAD, state("completed"));
      assert.lengthOf(h.sent, 2);
      assert.deepStrictEqual(h.sent[1], h.sent[0]);
      assert.deepStrictEqual(h.cleared, []);
    }),
  );

  it.effect("drops a refusal that would repeat instead of retrying it", () =>
    Effect.gen(function* () {
      yield* atNow;
      const h = harness([device()]);
      h.gateway.answer = () => ({ ok: false, status: 403, reason: "TopicNotAllowed" });
      const deliverer = yield* h.deliverer;
      yield* deliverer.publish(THREAD, state("completed"));
      yield* deliverer.publish(THREAD, state("completed"));
      assert.lengthOf(h.sent, 1);
      assert.deepStrictEqual(h.cleared, []);
    }),
  );

  it.effect("repaints a newly registered Live Activity without an alert", () =>
    Effect.gen(function* () {
      yield* atNow;
      const devices = [device()];
      const h = harness(devices);
      const deliverer = yield* h.deliverer;
      yield* deliverer.publish(THREAD, state("waiting_for_approval"));
      devices[0] = { ...devices[0]!, activityPushToken: "la" };
      yield* deliverer.replay("iphone");
      assert.lengthOf(h.sent, 2);
      assert.deepStrictEqual(
        h.sent[1]?.map((delivery) => [delivery.kind, delivery.token, delivery.priority]),
        [["liveactivity", "la", 5]],
      );
    }),
  );

  it.effect("retires an Android token FCM no longer knows", () =>
    Effect.gen(function* () {
      yield* atNow;
      const h = harness([
        device({ deviceId: "pixel", platform: "android", apsEnvironment: null, pushToken: "fcm" }),
      ]);
      h.gateway.answer = () => ({ ok: false, status: 404, reason: "UNREGISTERED" });
      const deliverer = yield* h.deliverer;
      yield* deliverer.publish(THREAD, state("running"));
      assert.deepStrictEqual(h.cleared, [{ kind: "push", deviceId: "pixel", token: "fcm" }]);
    }),
  );
});

describe("PushGatewayPublisher wiring", () => {
  const PROJECT = ProjectId.make("project");
  const shell = {
    id: THREAD,
    projectId: PROJECT,
    title: "Fix the build",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
    lineage: { rootThreadId: THREAD, parentThreadId: null, relationshipToParent: null },
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunCompletedAt: null,
    archivedAt: null,
    updatedAt: DateTime.makeUnsafe(NOW),
  } as unknown as OrchestrationV2ThreadShell;

  it.effect("publishes a thread's activity and repaints a phone after it registers", () =>
    Effect.gen(function* () {
      yield* atNow;
      const sent: Array<ReadonlyArray<PushGatewayDelivery>> = [];
      const replayed = yield* Deferred.make<void>();
      const registrations = yield* PubSub.unbounded<PushDevices.PushDeviceRegistration>();
      const devices = [device({ activityPushToken: "la" })];
      const layer = Layer.mergeAll(
        Layer.succeed(
          PushDevices.PushDevices,
          PushDevices.PushDevices.of({
            register: () => Effect.void,
            registerLiveActivity: () => Effect.void,
            unregister: () => Effect.void,
            listDeliverable: Effect.sync(() => [...devices]),
            clearPushToken: () => Effect.void,
            clearActivityPushToken: () => Effect.void,
            registrations: Stream.fromPubSub(registrations),
          }),
        ),
        Layer.succeed(
          PushGatewayClient.PushGatewayClient,
          PushGatewayClient.PushGatewayClient.of({
            send: (deliveries) =>
              Effect.gen(function* () {
                sent.push(deliveries);
                if (sent.length === 2) yield* Deferred.succeed(replayed, undefined);
                return deliveries.map(() => ({ ok: true, status: 200 }));
              }),
          }),
        ),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
          streamDomainEvents: Stream.never,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ id: PROJECT, title: "Project" } as never)),
          snapshot: Effect.succeed({ projects: [] } as never),
        }),
      );
      yield* Effect.gen(function* () {
        const publisher = yield* PushGatewayPublisher.make({
          url: "https://push.example.test",
          credential: Redacted.make("secret"),
        });
        yield* publisher.start();
        yield* publisher.publishThread(THREAD);
        assert.deepStrictEqual(
          sent[0]?.map((delivery) => [delivery.kind, delivery.token]),
          [["liveactivity", "la"]],
        );

        // A new card registers: the publisher repaints it at once, without a publish.
        devices[0] = { ...devices[0]!, activityPushToken: "new-card" };
        yield* PubSub.publish(registrations, {
          kind: "live-activity" as const,
          deviceId: "iphone",
        });
        yield* Deferred.await(replayed);
        assert.deepStrictEqual(
          sent[1]?.map((delivery) => [delivery.kind, delivery.token]),
          [["liveactivity", "new-card"]],
        );
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});

describe("without a push gateway", () => {
  it.effect("publishes nothing and contacts no gateway", () =>
    Effect.gen(function* () {
      const publisher = yield* AgentAwarenessRelay.AgentAwarenessRelay;
      assert.strictEqual(publisher, agentAwarenessRelayTurnedOff);
    }).pipe(
      Effect.provide(
        PushGatewayPublisher.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          // Nothing below is reached without a gateway.
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(PushDevices.PushDevices)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(ProjectService.ProjectService)({}),
            ),
          ),
        ),
      ),
    ),
  );
});
