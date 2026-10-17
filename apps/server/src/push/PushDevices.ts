/**
 * Fork: the phones that receive this server's pushes. Each phone registers over its own
 * authenticated connection, so a device row belongs to the auth session that wrote it; a device
 * whose session is revoked or expired is never delivered to, and is deleted when the server starts.
 */
import {
  type AuthSessionId,
  PushDeviceError,
  type PushDeviceRegistrationInput,
  type PushLiveActivityRegistrationInput,
} from "@t3tools/contracts";
import {
  RelayAgentAwarenessPlatform,
  RelayAgentAwarenessPreferences,
  RelayApnsEnvironment,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import { readPushGatewayConfig } from "./PushGatewayConfig.ts";

export const PushDevice = Schema.Struct({
  deviceId: Schema.String,
  sessionId: Schema.String,
  platform: RelayAgentAwarenessPlatform,
  label: Schema.String,
  bundleId: Schema.String,
  apsEnvironment: Schema.NullOr(RelayApnsEnvironment),
  appVersion: Schema.NullOr(Schema.String),
  pushToken: Schema.NullOr(Schema.String),
  activityPushToken: Schema.NullOr(Schema.String),
  activityRegisteredAt: Schema.NullOr(Schema.String),
  preferences: Schema.fromJsonString(RelayAgentAwarenessPreferences),
  updatedAt: Schema.String,
});
export type PushDevice = typeof PushDevice.Type;

/** What changed, so the publisher can repaint the device's card at once. */
export type PushDeviceRegistration =
  | { readonly kind: "device"; readonly deviceId: string }
  | { readonly kind: "live-activity"; readonly deviceId: string };

export class PushDevices extends Context.Service<
  PushDevices,
  {
    readonly register: (
      sessionId: AuthSessionId,
      input: PushDeviceRegistrationInput,
    ) => Effect.Effect<void, PushDeviceError>;
    readonly registerLiveActivity: (
      sessionId: AuthSessionId,
      input: PushLiveActivityRegistrationInput,
    ) => Effect.Effect<void, PushDeviceError>;
    readonly unregister: (
      sessionId: AuthSessionId,
      deviceId: string,
    ) => Effect.Effect<void, PushDeviceError>;
    /** Devices whose session is still live. */
    readonly listDeliverable: Effect.Effect<ReadonlyArray<PushDevice>, PushDeviceError>;
    /** Drops a token APNs or FCM rejected for good, unless the phone already sent a newer one. */
    readonly clearPushToken: (
      deviceId: string,
      token: string,
    ) => Effect.Effect<void, PushDeviceError>;
    readonly clearActivityPushToken: (
      deviceId: string,
      token: string,
    ) => Effect.Effect<void, PushDeviceError>;
    readonly registrations: Stream.Stream<PushDeviceRegistration>;
  }
>()("t3/push/PushDevices") {}

const storageError = (cause: unknown) =>
  new PushDeviceError({
    reason: "storage",
    detail: `Push device storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* readPushGatewayConfig;
  const registrations = yield* PubSub.unbounded<PushDeviceRegistration>();

  // Kept out of the numbered migrations, so the fork's schema never collides with upstream's.
  const ensureTable = yield* Effect.cached(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS push_devices (
          device_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          label TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          aps_environment TEXT,
          app_version TEXT,
          push_token TEXT,
          activity_push_token TEXT,
          activity_registered_at TEXT,
          preferences_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_push_devices_session_id ON push_devices(session_id)
      `;
    }).pipe(Effect.mapError(storageError)),
  );

  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    ensureTable.pipe(Effect.andThen(effect.pipe(Effect.mapError(storageError))));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireGateway = Effect.suspend(() =>
    gateway === null
      ? Effect.fail(
          new PushDeviceError({
            reason: "not-configured",
            detail: "This server has no push gateway configured.",
          }),
        )
      : Effect.void,
  );

  const listLive = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.String }),
    Result: PushDevice,
    execute: ({ now }) => sql`
      SELECT
        device.device_id AS "deviceId",
        device.session_id AS "sessionId",
        device.platform AS "platform",
        device.label AS "label",
        device.bundle_id AS "bundleId",
        device.aps_environment AS "apsEnvironment",
        device.app_version AS "appVersion",
        device.push_token AS "pushToken",
        device.activity_push_token AS "activityPushToken",
        device.activity_registered_at AS "activityRegisteredAt",
        device.preferences_json AS "preferences",
        device.updated_at AS "updatedAt"
      FROM push_devices AS device
      JOIN auth_sessions AS session ON session.session_id = device.session_id
      WHERE session.revoked_at IS NULL
        AND session.expires_at > ${now}
      ORDER BY device.device_id
    `,
  });

  const encodePreferences = Schema.encodeEffect(
    Schema.fromJsonString(RelayAgentAwarenessPreferences),
  );

  const publish = (registration: PushDeviceRegistration) =>
    PubSub.publish(registrations, registration).pipe(Effect.asVoid);

  // A device whose session is gone can never be delivered to again; its phone re-registers
  // under the new session when it reconnects.
  const startedAt = yield* nowIso;
  yield* run(
    sql`
      DELETE FROM push_devices
      WHERE session_id NOT IN (
        SELECT session_id FROM auth_sessions
        WHERE revoked_at IS NULL AND expires_at > ${startedAt}
      )
    `,
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("push device cleanup failed", { detail: error.message }),
    ),
  );

  return PushDevices.of({
    register: Effect.fn("PushDevices.register")(function* (sessionId, input) {
      yield* requireGateway;
      const updatedAt = yield* nowIso;
      const preferencesJson = yield* encodePreferences(input.preferences).pipe(
        Effect.mapError(storageError),
      );
      yield* run(sql`
        INSERT INTO push_devices (
          device_id, session_id, platform, label, bundle_id, aps_environment, app_version,
          push_token, activity_push_token, activity_registered_at, preferences_json, updated_at
        ) VALUES (
          ${input.deviceId}, ${sessionId}, ${input.platform}, ${input.label}, ${input.bundleId},
          ${input.apsEnvironment ?? null}, ${input.appVersion ?? null}, ${input.pushToken ?? null},
          NULL, NULL, ${preferencesJson}, ${updatedAt}
        )
        ON CONFLICT (device_id) DO UPDATE SET
          session_id = excluded.session_id,
          platform = excluded.platform,
          label = excluded.label,
          bundle_id = excluded.bundle_id,
          aps_environment = excluded.aps_environment,
          app_version = excluded.app_version,
          push_token = excluded.push_token,
          -- An activity token is tied to the app build that started it.
          activity_push_token = CASE
            WHEN push_devices.bundle_id = excluded.bundle_id THEN push_devices.activity_push_token
            ELSE NULL
          END,
          preferences_json = excluded.preferences_json,
          updated_at = excluded.updated_at
      `);
      yield* publish({ kind: "device", deviceId: input.deviceId });
    }),
    registerLiveActivity: Effect.fn("PushDevices.registerLiveActivity")(
      function* (sessionId, input) {
        yield* requireGateway;
        const updatedAt = yield* nowIso;
        const updated = yield* run(
          sql.withTransaction(
            Effect.gen(function* () {
              // A token moves with its activity; no other device may keep pushing to it.
              yield* sql`
                UPDATE push_devices SET activity_push_token = NULL
                WHERE activity_push_token = ${input.activityPushToken}
                  AND device_id <> ${input.deviceId}
              `;
              const rows = yield* sql<{ readonly deviceId: string }>`
                UPDATE push_devices
                SET activity_push_token = ${input.activityPushToken},
                    activity_registered_at = ${updatedAt},
                    updated_at = ${updatedAt}
                WHERE device_id = ${input.deviceId} AND session_id = ${sessionId}
                RETURNING device_id AS "deviceId"
              `;
              return rows.length > 0;
            }),
          ),
        );
        if (!updated) {
          return yield* new PushDeviceError({
            reason: "unknown-device",
            detail: "Register the device before its Live Activity.",
          });
        }
        yield* publish({ kind: "live-activity", deviceId: input.deviceId });
      },
    ),
    unregister: (sessionId, deviceId) =>
      run(sql`
        DELETE FROM push_devices WHERE device_id = ${deviceId} AND session_id = ${sessionId}
      `).pipe(Effect.asVoid, Effect.withSpan("PushDevices.unregister")),
    listDeliverable: nowIso.pipe(
      Effect.flatMap((now) => run(listLive({ now }))),
      Effect.withSpan("PushDevices.listDeliverable"),
    ),
    clearPushToken: (deviceId, token) =>
      run(sql`
        UPDATE push_devices SET push_token = NULL
        WHERE device_id = ${deviceId} AND push_token = ${token}
      `).pipe(Effect.asVoid),
    clearActivityPushToken: (deviceId, token) =>
      run(sql`
        UPDATE push_devices SET activity_push_token = NULL, activity_registered_at = NULL
        WHERE device_id = ${deviceId} AND activity_push_token = ${token}
      `).pipe(Effect.asVoid),
    registrations: Stream.fromPubSub(registrations),
  });
});

export const layer = Layer.effect(PushDevices, make);
