import { describe, expect, it } from "@effect/vitest";
import type { OuterSocket } from "@t3tools/shared/secureChannel/connector";
import { encodeChannelKey } from "@t3tools/shared/secureChannel/handshake";

import {
  makeSecureChannelForwarders,
  SecureChannelForwardError,
  type SecureChannelRouteRequest,
} from "./secureChannel.ts";

const key = (fill: number) => encodeChannelKey(new Uint8Array(32).fill(fill));

/** An outer socket whose server never answers, so a forward fails but its listener stays up. */
function unansweredSocket(): OuterSocket {
  const listeners = new Map<string, Array<(event: { readonly data: unknown }) => void>>();
  queueMicrotask(() =>
    listeners.get("close")?.forEach((listener) => listener({ data: undefined })),
  );
  return {
    binaryType: "blob",
    bufferedAmount: 0,
    send: () => undefined,
    close: () => undefined,
    addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  } as OuterSocket;
}

function forwardersWithLog(now?: () => number) {
  const closed: Array<string> = [];
  let port = 52_800;
  const forwarders = makeSecureChannelForwarders({
    openSocket: unansweredSocket,
    startListener: async (connector) => {
      const origin = `http://127.0.0.1:${(port += 1)}`;
      return {
        origin,
        close: async () => {
          connector.close();
          closed.push(origin);
        },
      };
    },
    randomBytes: (length) => new Uint8Array(length).fill(9),
    fetch: () => Promise.reject(new Error("unused")),
    ...(now === undefined ? {} : { now }),
  });
  return { forwarders, closed };
}

describe("makeSecureChannelForwarders", () => {
  it("stops the forwarders of routes no longer kept, but not a pairing's", async () => {
    const { forwarders, closed } = forwardersWithLog();
    const kept: SecureChannelRouteRequest = {
      httpBaseUrl: "https://kept.example.test",
      serverKey: key(1),
      clientKey: key(2),
    };
    const removed: SecureChannelRouteRequest = {
      ...kept,
      httpBaseUrl: "https://gone.example.test",
    };
    const rekeyed: SecureChannelRouteRequest = { ...kept, serverKey: key(3) };
    const pairing: SecureChannelRouteRequest = {
      ...kept,
      httpBaseUrl: "https://pairing.example.test",
      pairingCode: "LIVECODE2345",
    };
    for (const request of [kept, removed, rekeyed, pairing]) {
      await forwarders.forward(request).catch(() => undefined);
    }

    await forwarders.retain([{ httpBaseUrl: kept.httpBaseUrl, serverKey: kept.serverKey }]);
    expect(closed).toEqual(["http://127.0.0.1:52802", "http://127.0.0.1:52803"]);

    await forwarders.retain([]);
    expect(closed).toHaveLength(3);
  });

  it("says a route unreachable for a minute may need pairing again, but not sooner", async () => {
    let clock = 0;
    const { forwarders } = forwardersWithLog(() => clock);
    const request: SecureChannelRouteRequest = {
      httpBaseUrl: "https://quiet.example.test",
      serverKey: key(1),
      clientKey: key(2),
    };
    const kinds: Array<string> = [];
    for (const at of [0, 2_000, 6_000, 30_000, 61_000]) {
      clock = at;
      kinds.push(
        await forwarders.forward(request).then(
          () => "connected",
          (error: unknown) =>
            error instanceof SecureChannelForwardError ? error.failure.kind : "other",
        ),
      );
    }
    expect(kinds).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      "unanswered",
    ]);

    // After a long sleep, the first failure on waking starts a new run instead.
    const rested: SecureChannelRouteRequest = {
      ...request,
      httpBaseUrl: "https://other.example.test",
    };
    const restedKinds: Array<string> = [];
    for (const at of [100_000, 100_000 + 2 * 60 * 60_000, 100_000 + 2 * 60 * 60_000 + 61_000]) {
      clock = at;
      restedKinds.push(
        await forwarders.forward(rested).then(
          () => "connected",
          (error: unknown) =>
            error instanceof SecureChannelForwardError ? error.failure.kind : "other",
        ),
      );
    }
    expect(restedKinds).toEqual(["unreachable", "unreachable", "unanswered"]);

    // Seven minutes between retries, as several routes timing out allow, keeps the run.
    const slow: SecureChannelRouteRequest = {
      ...request,
      httpBaseUrl: "https://slow.example.test",
    };
    const slowKinds: Array<string> = [];
    for (const at of [10_000_000, 10_000_000 + 7 * 60_000]) {
      clock = at;
      slowKinds.push(
        await forwarders.forward(slow).then(
          () => "connected",
          (error: unknown) =>
            error instanceof SecureChannelForwardError ? error.failure.kind : "other",
        ),
      );
    }
    expect(slowKinds).toEqual(["unreachable", "unanswered"]);
  });

  it("stops a route's old forwarder once the route is paired again under a new key", async () => {
    const { forwarders, closed } = forwardersWithLog();
    const before: SecureChannelRouteRequest = {
      httpBaseUrl: "https://quiet.example.test",
      serverKey: key(1),
      clientKey: key(2),
    };
    await forwarders.forward(before).catch(() => undefined);
    await forwarders.forward({ ...before, clientKey: key(4) }).catch(() => undefined);
    expect(closed).toEqual(["http://127.0.0.1:52801"]);
  });
});
