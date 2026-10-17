import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, PUSH_GATEWAY_ANDROID_USER_ID, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import type { PushDevice } from "./PushDevices.ts";
import {
  type DeviceDeliveryMemory,
  emptyDeviceDeliveryMemory,
  type PlanInput,
  planDeviceDeliveries,
} from "./pushDeliveryPlan.ts";

const NOW_MS = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (offsetMs: number) => iso(NOW_MS + offsetMs);

const THREAD = ThreadId.make("thread");
const OTHER = ThreadId.make("other");

const state = (overrides: Partial<RelayAgentActivityState> = {}): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("env"),
  threadId: THREAD,
  projectTitle: "Project",
  threadTitle: "Fix the build",
  modelTitle: "gpt",
  headline: "Agent is working",
  phase: "running",
  updatedAt: at(0),
  deepLink: "/threads/env/thread",
  ...overrides,
});

const preferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

const iphone: PushDevice = {
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
  preferences,
  updatedAt: at(0),
};
const pixel: PushDevice = {
  ...iphone,
  deviceId: "pixel",
  platform: "android",
  bundleId: "com.example.z6.android",
  apsEnvironment: null,
  pushToken: "fcm",
};

/** Publishes each change in order, carrying the device's memory between them. */
function run(
  device: PushDevice,
  changes: ReadonlyArray<RelayAgentActivityState | { readonly removed: ThreadId }>,
  input: { memory?: DeviceDeliveryMemory; nowMs?: number } = {},
) {
  let memory = input.memory ?? emptyDeviceDeliveryMemory;
  const states = new Map<ThreadId, RelayAgentActivityState>();
  const plans = changes.map((change) => {
    const threadId = "removed" in change ? change.removed : change.threadId;
    const next = "removed" in change ? null : change;
    if (next === null) states.delete(threadId);
    else states.set(threadId, next);
    const planInput: PlanInput = {
      device,
      memory,
      states: [...states.values()],
      change: { threadId, state: next },
      nowMs: input.nowMs ?? NOW_MS,
      nowIso: iso(input.nowMs ?? NOW_MS),
    };
    const plan = planDeviceDeliveries(planInput);
    memory = plan.next;
    return plan;
  });
  return { plans, memory };
}

describe("iOS without a Live Activity", () => {
  it("alerts once when a thread needs approval, and not again when it republishes", () => {
    const { plans } = run(iphone, [
      state(),
      state({ phase: "waiting_for_approval" }),
      state({ phase: "waiting_for_approval", threadTitle: "Renamed" }),
    ]);
    expect(plans.map((plan) => plan.deliveries.length)).toEqual([0, 1, 0]);
    expect(plans[1]?.deliveries[0]).toEqual({
      token: "push",
      delivery: {
        platform: "ios",
        token: "apns",
        kind: "alert",
        bundleId: "com.example.z6",
        apsEnvironment: "production",
        priority: 10,
        payload: {
          aps: {
            alert: { title: "Fix the build", body: "Approval: Project" },
            sound: "default",
            "thread-id": "env/thread",
          },
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
        },
      },
    });
  });

  it("alerts a fresh completion but not a stale one", () => {
    expect(run(iphone, [state({ phase: "completed" })]).plans[0]?.deliveries).toHaveLength(1);
    expect(
      run(iphone, [state({ phase: "completed", updatedAt: at(-5 * 60_000) })]).plans[0]?.deliveries,
    ).toHaveLength(0);
  });

  it("honors the phone's preferences", () => {
    const quiet = { ...iphone, preferences: { ...preferences, notifyOnInput: false } };
    expect(run(quiet, [state({ phase: "waiting_for_input" })]).plans[0]?.deliveries).toEqual([]);
    const off = { ...iphone, preferences: { ...preferences, notificationsEnabled: false } };
    expect(run(off, [state({ phase: "failed" })]).plans[0]?.deliveries).toEqual([]);
  });
});

describe("iOS Live Activity", () => {
  const armed = { ...iphone, activityPushToken: "la" };

  it("paints the card silently, then carries an approval alert on the update", () => {
    const { plans } = run(armed, [state(), state({ phase: "waiting_for_approval" })]);
    const first = plans[0]?.deliveries[0]?.delivery;
    expect(first).toMatchObject({ kind: "liveactivity", token: "la", priority: 5 });
    expect(first?.payload).toMatchObject({ aps: { event: "update" } });
    expect(plans[1]?.deliveries).toHaveLength(1);
    expect(plans[1]?.deliveries[0]?.delivery).toMatchObject({
      kind: "liveactivity",
      priority: 10,
      payload: { aps: { alert: { title: "Fix the build", body: "Approval: Project" } } },
    });
  });

  it("throttles unchanged-count updates for fifteen seconds", () => {
    const first = run(armed, [state()]);
    const renamed = run(armed, [state({ threadTitle: "Renamed" })], { memory: first.memory });
    expect(renamed.plans[0]?.deliveries).toEqual([]);
    const later = run(armed, [state({ threadTitle: "Renamed" })], {
      memory: first.memory,
      nowMs: NOW_MS + 15_000,
    });
    expect(later.plans[0]?.deliveries).toHaveLength(1);
  });

  it("ends only a card it painted", () => {
    expect(run(armed, [{ removed: THREAD }]).plans[0]?.deliveries).toEqual([]);
    const { plans } = run(armed, [state(), { removed: THREAD }]);
    expect(plans[1]?.deliveries[0]?.delivery.payload).toMatchObject({ aps: { event: "end" } });
    expect(plans[1]?.next.liveActivity).toBeNull();
  });

  it("ends the card when the phone turns Live Activities off", () => {
    const off = { ...armed, preferences: { ...preferences, liveActivitiesEnabled: false } };
    const { plans } = run(off, [state()]);
    expect(plans[0]?.deliveries[0]?.delivery.payload).toMatchObject({ aps: { event: "end" } });
  });

  it("repaints on a replay without buzzing", () => {
    const painted = run(armed, [state({ phase: "waiting_for_approval" })]);
    const replay = planDeviceDeliveries({
      device: { ...armed, activityPushToken: "new-card" },
      memory: painted.memory,
      states: [state({ phase: "waiting_for_approval" })],
      change: null,
      nowMs: NOW_MS,
      nowIso: at(0),
    });
    expect(replay.deliveries).toHaveLength(1);
    expect(replay.deliveries[0]?.delivery).toMatchObject({ token: "new-card", priority: 5 });
  });
});

describe("Android", () => {
  it("sends the card with the gateway identity and an alert for attention", () => {
    const { plans } = run(pixel, [state(), state({ threadId: OTHER, phase: "waiting_for_input" })]);
    const card = plans[0]?.deliveries[0]?.delivery;
    expect(card).toMatchObject({
      platform: "android",
      token: "fcm",
      kind: "liveactivity",
      bundleId: "com.example.z6.android",
      payload: { android: { priority: "HIGH", ttl: "300s", collapse_key: "t3-agent-activity" } },
    });
    expect((card!.payload as { data: Record<string, string> }).data).toMatchObject({
      t3_kind: "agent_activity",
      device_id: "pixel",
      user_id: PUSH_GATEWAY_ANDROID_USER_ID,
      active: "true",
    });
    const alert = plans[1]?.deliveries[0]?.delivery;
    expect(alert?.kind).toBe("alert");
    expect((alert!.payload as { data: Record<string, string> }).data).toMatchObject({
      alert_title: "Fix the build",
      alert_body: "Input: Project",
    });
    expect((alert!.payload as { android: object }).android).not.toHaveProperty("collapse_key");
  });

  it("skips an unchanged card and never clears a card it did not paint", () => {
    const { plans } = run(pixel, [state(), state({ headline: "Still working" })]);
    expect(plans[1]?.deliveries).toEqual([]);
    expect(run(pixel, [{ removed: THREAD }]).plans[0]?.deliveries).toEqual([]);
  });

  it("sends nothing without a push token", () => {
    expect(
      run({ ...pixel, pushToken: null }, [state({ phase: "failed" })]).plans[0]?.deliveries,
    ).toEqual([]);
  });
});
