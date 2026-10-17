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

export class PushDeviceError extends Schema.TaggedError<PushDeviceError>()("PushDeviceError", {
  reason: Schema.Literals(["not-configured", "unknown-device", "storage"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
