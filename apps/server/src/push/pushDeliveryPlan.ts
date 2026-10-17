/**
 * Fork: what one phone gets when this server's agent activity changes, as finished APNs and FCM
 * deliveries for the push gateway. The rules are T3 Connect's relay's
 * (`@t3tools/shared/agentActivityPush`), applied to this server's threads only.
 *
 * Several servers can paint the same Live Activity or Android card, since the phone registers
 * its tokens with each. A server therefore only ends a card it has painted itself, so an idle
 * server never removes another server's card.
 */
import {
  PUSH_GATEWAY_ANDROID_USER_ID,
  type PushGatewayDelivery,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPhase,
} from "@t3tools/contracts/relay";
import {
  type AgentActivityAlert,
  alertForAttentionTransition,
  alertForNewlyTerminal,
  androidActivityData,
  androidAlertForState,
  apnsAlertBody,
  apnsLiveActivityBody,
  fitFcmData,
  isTerminalPhase,
  makeAggregateState,
  notificationForActivity,
  shouldAlertForActivity,
  shouldUpdateLiveActivity,
  statusForPhase,
} from "@t3tools/shared/agentActivityPush";

import type { PushDevice } from "./PushDevices.ts";

/** What this server last told one phone. Kept in memory: a restart starts from nothing. */
export interface DeviceDeliveryMemory {
  /** The aggregate this server last painted on the device's Live Activity, and when. */
  readonly liveActivity: {
    readonly token: string;
    readonly aggregate: RelayAgentActivityAggregateState;
    readonly deliveredAt: string;
  } | null;
  /** The Android card this server last painted, as JSON; null once cleared or never painted. */
  readonly androidCard: string | null;
  /** Each thread's phase as of the last delivery, so a republished state cannot buzz twice. */
  readonly phases: ReadonlyMap<ThreadId, RelayAgentAwarenessPhase>;
}

export const emptyDeviceDeliveryMemory: DeviceDeliveryMemory = {
  liveActivity: null,
  androidCard: null,
  phases: new Map(),
};

export interface PlannedDelivery {
  readonly delivery: PushGatewayDelivery;
  /** Which of the device's tokens a permanent failure retires. */
  readonly token: "push" | "activity";
}

export interface DevicePlan {
  readonly deliveries: ReadonlyArray<PlannedDelivery>;
  /** The memory to keep once every delivery has been accepted or permanently refused. */
  readonly next: DeviceDeliveryMemory;
}

export interface PlanInput {
  readonly device: PushDevice;
  readonly memory: DeviceDeliveryMemory;
  /** This server's current thread states, including recently finished ones. */
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  /**
   * The thread whose published state changed, or none for a replay after the phone registered:
   * a replay repaints the card and never buzzes.
   */
  readonly change: {
    readonly threadId: ThreadId;
    readonly state: RelayAgentActivityState | null;
  } | null;
  readonly nowMs: number;
  readonly nowIso: string;
}

function nextPhases(input: PlanInput): ReadonlyMap<ThreadId, RelayAgentAwarenessPhase> {
  if (input.change === null) return input.memory.phases;
  const phases = new Map(input.memory.phases);
  if (input.change.state === null) phases.delete(input.change.threadId);
  else phases.set(input.change.threadId, input.change.state.phase);
  return phases;
}

/** The changed thread newly reached a phase the device wants to hear about. */
function changedStateToAlert(input: PlanInput): RelayAgentActivityState | null {
  const state = input.change?.state ?? null;
  if (state === null || input.memory.phases.get(state.threadId) === state.phase) return null;
  return shouldAlertForActivity({
    ...state,
    preferences: input.device.preferences,
    nowMs: input.nowMs,
  })
    ? state
    : null;
}

function iosDeliveries(input: PlanInput): DevicePlan {
  const { device, memory, nowMs } = input;
  const preferences = device.preferences;
  const changed = input.change?.state ?? null;
  const aggregate = makeAggregateState({
    activeStates: input.states,
    terminalState: changed !== null && isTerminalPhase(changed) ? changed : null,
    nowMs,
  });
  const alertState = device.pushToken === null ? null : changedStateToAlert(input);
  const pushNotification =
    alertState === null
      ? null
      : notificationForActivity({ ...alertState, status: statusForPhase(alertState.phase) });
  const deliveries: PlannedDelivery[] = [];
  let liveActivity = memory.liveActivity;

  const pushAlert = () => {
    if (pushNotification === null || device.pushToken === null) return;
    deliveries.push({
      token: "push",
      delivery: {
        platform: "ios",
        token: device.pushToken,
        kind: "alert",
        bundleId: device.bundleId,
        ...(device.apsEnvironment === null ? {} : { apsEnvironment: device.apsEnvironment }),
        priority: 10,
        payload: apnsAlertBody(pushNotification),
      },
    });
  };
  const liveActivityDelivery = (
    token: string,
    body: ReturnType<typeof apnsLiveActivityBody>,
  ): PlannedDelivery => ({
    token: "activity",
    delivery: {
      platform: "ios",
      token,
      kind: "liveactivity",
      bundleId: device.bundleId,
      ...(device.apsEnvironment === null ? {} : { apsEnvironment: device.apsEnvironment }),
      priority: body.priority === "10" ? 10 : 5,
      payload: body.payload as Record<string, unknown>,
    },
  });

  const token = device.activityPushToken;
  const painted =
    token !== null && memory.liveActivity?.token === token ? memory.liveActivity : null;
  const nowEpochSeconds = Math.floor(nowMs / 1_000);
  if (token === null) {
    pushAlert();
  } else if (!preferences.liveActivitiesEnabled || aggregate === null) {
    // Turning Live Activities off ends the card at once; running out of work ends only a card
    // this server painted.
    if (!preferences.liveActivitiesEnabled || painted !== null) {
      deliveries.push(
        liveActivityDelivery(
          token,
          apnsLiveActivityBody({ event: "end", state: null, nowEpochSeconds }),
        ),
      );
      liveActivity = null;
    }
    pushAlert();
  } else if (
    shouldUpdateLiveActivity({
      previousAggregate: painted?.aggregate ?? null,
      nextAggregate: aggregate,
      lastDeliveryAt: painted?.deliveredAt ?? null,
      nowMs,
    })
  ) {
    const previousAggregate = painted?.aggregate ?? null;
    const transitionAlert: AgentActivityAlert | null =
      input.change === null || !preferences.notificationsEnabled
        ? null
        : (alertForAttentionTransition({
            previousAggregate,
            nextAggregate: aggregate,
            preferences,
          }) ??
          alertForNewlyTerminal({
            previousAggregate,
            nextAggregate: aggregate,
            preferences,
            nowMs,
            includeUnobserved: true,
          }));
    // The first paint has no baseline to compare with, so the changed thread's own alert rides
    // on the update instead.
    const alert =
      transitionAlert ??
      (pushNotification === null
        ? null
        : { title: pushNotification.title, body: pushNotification.body });
    deliveries.push(
      liveActivityDelivery(
        token,
        apnsLiveActivityBody({ event: "update", state: aggregate, alert, nowEpochSeconds }),
      ),
    );
    liveActivity = { token, aggregate, deliveredAt: input.nowIso };
  } else {
    // Unchanged or throttled. The card repaints on a later change; an alert still rings.
    pushAlert();
  }

  return {
    deliveries,
    next: { ...memory, liveActivity, phases: nextPhases(input) },
  };
}

function androidDeliveries(input: PlanInput): DevicePlan {
  const { device, memory, nowMs } = input;
  const preferences = device.preferences;
  const next = { ...memory, phases: nextPhases(input) };
  if (device.pushToken === null) return { deliveries: [], next };
  const displayed =
    preferences.notificationsEnabled && preferences.liveActivitiesEnabled
      ? makeAggregateState({ activeStates: input.states, terminalState: null, nowMs })
      : null;
  const card = displayed === null ? null : JSON.stringify(displayed);
  const alertState = changedStateToAlert(input);
  const alert =
    alertState === null || !preferences.notificationsEnabled
      ? null
      : androidAlertForState(alertState, preferences, nowMs);
  const replay = input.change === null;
  // Clearing a card this server never painted could remove another server's.
  if (
    alert === null &&
    !replay &&
    (card === memory.androidCard || (card === null && memory.androidCard === null))
  ) {
    return { deliveries: [], next };
  }
  const data = fitFcmData({
    t3_kind: "agent_activity",
    device_id: device.deviceId,
    user_id: PUSH_GATEWAY_ANDROID_USER_ID,
    updated_at: String(nowMs),
    ...androidActivityData(displayed),
    ...alert,
  });
  return {
    deliveries: [
      {
        token: "push",
        delivery: {
          platform: "android",
          token: device.pushToken,
          kind: alert === null ? "liveactivity" : "alert",
          bundleId: device.bundleId,
          payload: {
            data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              ...(alert === null ? { collapse_key: "t3-agent-activity" } : {}),
            },
          },
        },
      },
    ],
    next: { ...next, androidCard: card },
  };
}

export function planDeviceDeliveries(input: PlanInput): DevicePlan {
  return input.device.platform === "ios" ? iosDeliveries(input) : androidDeliveries(input);
}
