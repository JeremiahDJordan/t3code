import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  RelayAgentAwarenessPlatform,
  RelayAgentAwarenessPreferences,
  RelayApnsEnvironment,
} from "./relay.ts";

/**
 * Fork: a phone registers its push identity with each paired server that advertises the
 * `pushGateway` capability. The server decides what to send and hands finished APNs and FCM
 * deliveries to the owner's push gateway (`infra/push-gateway`), which only signs and forwards.
 * A device belongs to the auth session that registered it, so removing that client stops its
 * pushes.
 */
export const PushDeviceRegistrationInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  /** The APNs topic or the FCM restricted package; each app variant has its own. */
  bundleId: TrimmedNonEmptyString,
  /** iOS only. Development builds receive sandbox tokens. */
  apsEnvironment: Schema.optionalKey(RelayApnsEnvironment),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
  /** The raw APNs token (hex) or FCM registration token; absent while notifications are off. */
  pushToken: Schema.optionalKey(TrimmedNonEmptyString),
  preferences: RelayAgentAwarenessPreferences,
}).check(
  Schema.makeFilter((device) => device.platform === "ios" || device.apsEnvironment === undefined),
);
export type PushDeviceRegistrationInput = typeof PushDeviceRegistrationInput.Type;

/** The update token of the iOS Live Activity the phone started (`activity.getPushToken()`). */
export const PushLiveActivityRegistrationInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  activityPushToken: TrimmedNonEmptyString,
});
export type PushLiveActivityRegistrationInput = typeof PushLiveActivityRegistrationInput.Type;

export const PushDeviceUnregistrationInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type PushDeviceUnregistrationInput = typeof PushDeviceUnregistrationInput.Type;

/**
 * The `user_id` of the server's Android data messages. The phone registers with several servers
 * and has no account, so the native handler matches this fixed value and the device id instead.
 */
export const PUSH_GATEWAY_ANDROID_USER_ID = "push-gateway";

/*
 * Server to push gateway: `POST {gatewayUrl}/v1/deliveries`, `Authorization: Bearer <credential>`.
 * `infra/push-gateway/src/protocol.ts` validates the same shape without Effect.
 */

export const PUSH_GATEWAY_MAX_DELIVERIES = 100;

export const PushGatewayDelivery = Schema.Struct({
  platform: RelayAgentAwarenessPlatform,
  token: TrimmedNonEmptyString,
  /** iOS: an `alert` or `liveactivity` push. Android: an alerting or a silent data message. */
  kind: Schema.Literals(["alert", "liveactivity"]),
  /** The APNs topic's base or the FCM restricted package. */
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: Schema.optionalKey(RelayApnsEnvironment),
  priority: Schema.optionalKey(Schema.Literals([5, 10])),
  collapseId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Epoch seconds after which APNs drops the push. */
  expiration: Schema.optionalKey(Schema.Int),
  /** The APNs JSON body, or the FCM message without `token` and `restricted_package_name`. */
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
export type PushGatewayDelivery = typeof PushGatewayDelivery.Type;

export const PushGatewayRequest = Schema.Struct({
  deliveries: Schema.Array(PushGatewayDelivery),
});
export type PushGatewayRequest = typeof PushGatewayRequest.Type;

export const PushGatewayResult = Schema.Struct({
  ok: Schema.Boolean,
  /** The APNs or FCM HTTP status; 0 when the gateway could not reach them. */
  status: Schema.Int,
  /** APNs `reason`, or the FCM error code (`UNREGISTERED`). */
  reason: Schema.optionalKey(Schema.String),
});
export type PushGatewayResult = typeof PushGatewayResult.Type;

/** One result per delivery, in request order. */
export const PushGatewayResponse = Schema.Struct({
  results: Schema.Array(PushGatewayResult),
});
export type PushGatewayResponse = typeof PushGatewayResponse.Type;

export class PushDeviceError extends Schema.TaggedError<PushDeviceError>()("PushDeviceError", {
  reason: Schema.Literals(["not-configured", "unknown-device", "storage"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
