import {
  PUSH_GATEWAY_MAX_DELIVERIES,
  type PushGatewayDelivery,
  type PushGatewayResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type Delivery,
  type DeliveryResult,
  MAX_DELIVERIES,
  parseAllowedBundleIds,
  parseDeliveries,
} from "./protocol.ts";

// The server builds its requests from the contract's schema; these fail to compile if the
// Worker's hand-written shape drifts from it.
const fromContract = (delivery: PushGatewayDelivery): Delivery => delivery;
const toContract = (result: DeliveryResult): PushGatewayResult => result;
void fromContract;
void toContract;

const allowed = parseAllowedBundleIds(" com.example.z6 ,com.example.z6.dev,");
const apnsToken = "a".repeat(64);
const delivery = {
  platform: "ios",
  token: apnsToken,
  kind: "alert",
  bundleId: "com.example.z6",
  apsEnvironment: "production",
  priority: 10,
  payload: { aps: { alert: { title: "Thread", body: "Done" } } },
};

describe("parseDeliveries", () => {
  it("accepts a well-formed batch", () => {
    expect(parseDeliveries({ deliveries: [delivery] }, allowed)).toEqual({
      ok: true,
      deliveries: [delivery],
    });
  });

  it("refuses bundle ids the gateway does not serve, item by item", () => {
    const parsed = parseDeliveries(
      { deliveries: [{ ...delivery, bundleId: "com.someone.else" }, delivery] },
      allowed,
    );
    expect(parsed).toEqual({
      ok: true,
      deliveries: [{ ok: false, status: 403, reason: "TopicNotAllowed" }, delivery],
    });
  });

  it("keeps APNs tokens to hex, since they go into the request path", () => {
    for (const token of ["../../3/device/x", "zz".repeat(32), ""]) {
      expect(parseDeliveries({ deliveries: [{ ...delivery, token }] }, allowed)).toMatchObject({
        deliveries: [{ ok: false, reason: "BadDeviceToken" }],
      });
    }
    expect(
      parseDeliveries(
        { deliveries: [{ ...delivery, platform: "android", token: "fcm:token/with-colons" }] },
        allowed,
      ),
    ).toMatchObject({ deliveries: [{ platform: "android" }] });
  });

  it("refuses malformed fields and oversized payloads", () => {
    const reasons = [
      { kind: "background" },
      { priority: 7 },
      { apsEnvironment: "staging" },
      { payload: "text" },
      { payload: { aps: { alert: "x".repeat(5000) } } },
    ].map((override) => {
      const parsed = parseDeliveries({ deliveries: [{ ...delivery, ...override }] }, allowed);
      return parsed.ok ? (parsed.deliveries[0] as DeliveryResult).reason : null;
    });
    expect(reasons).toEqual([
      "InvalidKind",
      "BadPriority",
      "InvalidApsEnvironment",
      "PayloadEmpty",
      "PayloadTooLarge",
    ]);
  });

  it("accepts as many deliveries as the server sends at once", () => {
    expect(MAX_DELIVERIES).toBe(PUSH_GATEWAY_MAX_DELIVERIES);
  });

  it("refuses a request that is not a batch, or too large a batch", () => {
    expect(parseDeliveries([], allowed)).toMatchObject({ ok: false, status: 400 });
    expect(
      parseDeliveries(
        { deliveries: Array.from({ length: MAX_DELIVERIES + 1 }, () => delivery) },
        allowed,
      ),
    ).toMatchObject({ ok: false, status: 413 });
  });
});
