import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, type PushDeviceRegistrationInput } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PushDevices from "./PushDevices.ts";

const configured = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    T3CODE_PUSH_GATEWAY_URL: "https://push.example.test",
    T3CODE_PUSH_GATEWAY_CREDENTIAL: "credential",
  }),
);

const PHONE = AuthSessionId.make("phone-session");
const OTHER = AuthSessionId.make("other-session");

const insertSession = (sessionId: string, input: { revoked?: boolean; expiresAt?: string } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (
        session_id, subject, scopes, method, client_label, client_ip_address, client_user_agent,
        client_device_type, client_os, client_browser, issued_at, expires_at, revoked_at
      ) VALUES (
        ${sessionId}, 'subject', '[]', 'bearer-access-token', NULL, NULL, NULL, 'mobile', NULL,
        NULL, '2026-01-01T00:00:00.000Z', ${input.expiresAt ?? "2999-01-01T00:00:00.000Z"},
        ${input.revoked ? "2026-01-02T00:00:00.000Z" : null}
      )
    `;
  });

const iphone: PushDeviceRegistrationInput = {
  deviceId: "iphone",
  label: "iPhone",
  platform: "ios",
  bundleId: "com.example.z6",
  apsEnvironment: "production",
  pushToken: "apns-token",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

const layer = PushDevices.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(configured),
  Layer.provideMerge(NodeServices.layer),
);

describe("PushDevices", () => {
  it.effect("delivers only to devices whose session is live", () =>
    Effect.gen(function* () {
      yield* insertSession(PHONE);
      yield* insertSession(OTHER, { revoked: true });
      // The test clock starts at the epoch.
      yield* insertSession("expired", { expiresAt: "1969-12-31T00:00:00.000Z" });
      const devices = yield* PushDevices.PushDevices;
      yield* devices.register(PHONE, iphone);
      yield* devices.register(OTHER, { ...iphone, deviceId: "revoked-phone" });
      yield* devices.register(AuthSessionId.make("expired"), { ...iphone, deviceId: "old" });
      const deliverable = yield* devices.listDeliverable;
      assert.deepStrictEqual(
        deliverable.map((device) => device.deviceId),
        ["iphone"],
      );
      assert.deepStrictEqual(deliverable[0]?.preferences, iphone.preferences);
      assert.strictEqual(deliverable[0]?.pushToken, "apns-token");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves a device to the session that registered it last", () =>
    Effect.gen(function* () {
      yield* insertSession(PHONE);
      yield* insertSession(OTHER);
      const devices = yield* PushDevices.PushDevices;
      yield* devices.register(PHONE, iphone);
      yield* devices.register(OTHER, iphone);
      // Only the owning session can remove or arm it.
      yield* devices.unregister(PHONE, iphone.deviceId);
      const failure = yield* devices
        .registerLiveActivity(PHONE, { deviceId: iphone.deviceId, activityPushToken: "la" })
        .pipe(Effect.flip);
      assert.strictEqual(failure.reason, "unknown-device");
      assert.strictEqual((yield* devices.listDeliverable)[0]?.sessionId, OTHER);
      yield* devices.unregister(OTHER, iphone.deviceId);
      assert.lengthOf(yield* devices.listDeliverable, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps one owner per activity token and clears only the token it was given", () =>
    Effect.gen(function* () {
      yield* insertSession(PHONE);
      const devices = yield* PushDevices.PushDevices;
      yield* devices.register(PHONE, iphone);
      yield* devices.register(PHONE, { ...iphone, deviceId: "ipad" });
      yield* devices.registerLiveActivity(PHONE, { deviceId: "iphone", activityPushToken: "la" });
      yield* devices.registerLiveActivity(PHONE, { deviceId: "ipad", activityPushToken: "la" });
      const byId = new Map((yield* devices.listDeliverable).map((d) => [d.deviceId, d]));
      assert.strictEqual(byId.get("iphone")?.activityPushToken, null);
      assert.strictEqual(byId.get("ipad")?.activityPushToken, "la");
      assert.isNotNull(byId.get("ipad")?.activityRegisteredAt);

      yield* devices.clearActivityPushToken("ipad", "stale");
      yield* devices.clearPushToken("ipad", "stale");
      let ipad = (yield* devices.listDeliverable).find((d) => d.deviceId === "ipad");
      assert.strictEqual(ipad?.activityPushToken, "la");
      assert.strictEqual(ipad?.pushToken, "apns-token");
      yield* devices.clearActivityPushToken("ipad", "la");
      yield* devices.clearPushToken("ipad", "apns-token");
      ipad = (yield* devices.listDeliverable).find((d) => d.deviceId === "ipad");
      assert.strictEqual(ipad?.activityPushToken, null);
      assert.strictEqual(ipad?.pushToken, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses registration while no gateway is configured", () =>
    Effect.gen(function* () {
      const devices = yield* PushDevices.PushDevices;
      const failure = yield* devices.register(PHONE, iphone).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "not-configured");
    }).pipe(
      Effect.provide(
        PushDevices.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("drops devices of sessions that are gone when it starts", () =>
    Effect.gen(function* () {
      yield* insertSession(PHONE);
      const sql = yield* SqlClient.SqlClient;
      const first = yield* PushDevices.make;
      yield* first.register(PHONE, iphone);
      yield* sql`UPDATE auth_sessions SET revoked_at = '2026-01-02T00:00:00.000Z'`;
      yield* PushDevices.make;
      const rows = yield* sql`SELECT device_id FROM push_devices`;
      assert.lengthOf(rows, 0);
    }).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, configured))),
  );
});
