/**
 * Fork: publishes this server's agent activity to its registered phones through the owner's push
 * gateway. It stands in for T3 Connect's relay publisher (`AgentAwarenessRelay`) and reuses its
 * per-thread rules; this module keeps the thread states the relay would keep, plans each phone's
 * deliveries (`pushDeliveryPlan.ts`) and retires tokens APNs or FCM refuse for good.
 */
import type { ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import {
  isExpiredAgentActivityState,
  isPermanentApnsTokenFailure,
  isTerminalPhase,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "@t3tools/shared/agentActivityPush";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { agentAwarenessRelayTurnedOff } from "../cloud/t3ConnectTurnedOff.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import * as PushDevices from "./PushDevices.ts";
import * as PushGatewayClient from "./PushGatewayClient.ts";
import { type PushGatewayConfig, readPushGatewayConfig } from "./PushGatewayConfig.ts";
import {
  type DeviceDeliveryMemory,
  emptyDeviceDeliveryMemory,
  type PlannedDelivery,
  planDeviceDeliveries,
} from "./pushDeliveryPlan.ts";

export class PushDeliveryRetryError extends Schema.TaggedError<PushDeliveryRetryError>()(
  "PushDeliveryRetryError",
  { failed: Schema.Number, reasons: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.failed} push deliveries failed and will be retried: ${this.reasons.join(", ")}`;
  }
}

function isPermanentFailure(
  planned: PlannedDelivery,
  result: { readonly ok: boolean; readonly status: number; readonly reason?: string },
): boolean {
  return planned.delivery.platform === "ios"
    ? isPermanentApnsTokenFailure(result)
    : !result.ok && result.reason === "UNREGISTERED";
}

// A refusal APNs, FCM or the gateway would repeat (a bad payload, a topic the gateway does not
// serve) is dropped; only an unreachable service, a rate limit or a server error is retried.
function isRetryable(result: { readonly status: number }): boolean {
  return result.status === 0 || result.status === 429 || result.status >= 500;
}

function isRetained(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) return !isExpiredAgentActivityState(state, nowMs);
  return nowMs - Date.parse(state.updatedAt) <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

/** The thread states and per-phone memory, and the one place deliveries are planned and sent. */
export const makeDeliverer = Effect.gen(function* () {
  const devices = yield* PushDevices.PushDevices;
  const gateway = yield* PushGatewayClient.PushGatewayClient;
  // Publishes and registration replays read and write the same memory.
  const lock = yield* Semaphore.make(1);
  const states = new Map<ThreadId, RelayAgentActivityState>();
  const memory = new Map<string, DeviceDeliveryMemory>();

  const deliver = (input: {
    readonly change: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    } | null;
    readonly deviceId?: string;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = now.epochMilliseconds;
      const nowIso = DateTime.formatIso(now);
      if (input.change !== null) {
        if (input.change.state === null) states.delete(input.change.threadId);
        else states.set(input.change.threadId, input.change.state);
      }
      for (const [threadId, state] of states) {
        if (!isRetained(state, nowMs)) states.delete(threadId);
      }
      const deliverable = yield* devices.listDeliverable;
      if (input.deviceId === undefined) {
        const live = new Set(deliverable.map((device) => device.deviceId));
        for (const deviceId of memory.keys()) if (!live.has(deviceId)) memory.delete(deviceId);
      }
      const plans = deliverable
        .filter((device) => input.deviceId === undefined || device.deviceId === input.deviceId)
        .map((device) => ({
          device,
          plan: planDeviceDeliveries({
            device,
            memory: memory.get(device.deviceId) ?? emptyDeviceDeliveryMemory,
            states: [...states.values()],
            change: input.change,
            nowMs,
            nowIso,
          }),
        }));
      const planned = plans.flatMap(({ device, plan }) =>
        plan.deliveries.map((delivery) => ({ device, delivery })),
      );
      const results =
        planned.length === 0
          ? []
          : yield* gateway.send(planned.map(({ delivery }) => delivery.delivery));

      const retry = new Set<string>();
      const retiredActivityTokens = new Set<string>();
      const reasons: string[] = [];
      yield* Effect.forEach(
        planned,
        Effect.fnUntraced(function* ({ device, delivery }, index) {
          const result = results[index];
          if (result === undefined || result.ok) return;
          if (!isPermanentFailure(delivery, result)) {
            const reason = `${result.status}:${result.reason ?? "unknown"}`;
            if (!isRetryable(result)) {
              yield* Effect.logWarning("push delivery refused", {
                deviceId: device.deviceId,
                reason,
              });
              return;
            }
            retry.add(device.deviceId);
            reasons.push(reason);
            return;
          }
          yield* Effect.logInfo("push token retired after a permanent refusal", {
            deviceId: device.deviceId,
            token: delivery.token,
            status: result.status,
            reason: result.reason ?? null,
          });
          if (delivery.token === "push") {
            yield* devices.clearPushToken(device.deviceId, delivery.delivery.token);
          } else {
            retiredActivityTokens.add(delivery.delivery.token);
            yield* devices.clearActivityPushToken(device.deviceId, delivery.delivery.token);
          }
        }),
        { discard: true },
      );
      for (const { device, plan } of plans) {
        // A device with a failure keeps its old memory, so the retry plans the same deliveries.
        if (retry.has(device.deviceId)) continue;
        const next = plan.next;
        memory.set(
          device.deviceId,
          next.liveActivity !== null && retiredActivityTokens.has(next.liveActivity.token)
            ? { ...next, liveActivity: null }
            : next,
        );
      }
      if (planned.length > 0) {
        yield* Effect.logDebug("push deliveries sent through the gateway", {
          deliveries: planned.length,
          retrying: retry.size,
        });
      }
      if (retry.size > 0) {
        return yield* new PushDeliveryRetryError({ failed: reasons.length, reasons });
      }
    }).pipe(lock.withPermit, Effect.withSpan("PushGatewayPublisher.deliver"));

  return {
    /** A thread's published state changed. */
    publish: (threadId: ThreadId, state: RelayAgentActivityState | null) =>
      deliver({ change: { threadId, state } }),
    /** Repaints one phone's card after it registered, without buzzing it. */
    replay: (deviceId: string) => deliver({ change: null, deviceId }),
  };
});

export const make = (config: PushGatewayConfig) =>
  Effect.gen(function* () {
    const devices = yield* PushDevices.PushDevices;
    const deliverer = yield* makeDeliverer;
    const target = { _tag: "Ready", target: config } as const;
    const publisher = yield* AgentAwarenessRelay.makeAgentAwarenessPublisher({
      readTarget: Effect.succeed(target),
      readSnapshotTarget: Effect.succeed(target),
      sameTarget: () => true,
      publish: (_config, input) => deliverer.publish(input.threadId, input.state),
      startup: Effect.logInfo("agent activity publishing through the push gateway", {
        url: config.url,
      }).pipe(Effect.as(true)),
      logEnabledAfterCatchUp: Effect.void,
    });
    return AgentAwarenessRelay.AgentAwarenessRelay.of({
      ...publisher,
      start: () =>
        publisher.start().pipe(
          Effect.andThen(
            forkParked(
              Stream.runForEach(devices.registrations, (registration) =>
                deliverer.replay(registration.deviceId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("push replay after registration failed", {
                      deviceId: registration.deviceId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
    });
  });

/** Publishes through the gateway when one is configured, and does nothing otherwise. */
export const layer = Layer.effect(
  AgentAwarenessRelay.AgentAwarenessRelay,
  Effect.gen(function* () {
    const config = yield* readPushGatewayConfig;
    if (config === null) return agentAwarenessRelayTurnedOff;
    return yield* make(config).pipe(Effect.provide(PushGatewayClient.layer(config)));
  }),
);
