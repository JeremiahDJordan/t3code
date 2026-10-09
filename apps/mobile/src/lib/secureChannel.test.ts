import type {
  ChannelConnector,
  ForwardedConnection,
} from "@t3tools/shared/secureChannel/connector";
import type { LinkEndpoint } from "@t3tools/shared/secureChannel/link";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The native module as the modules behaved before their own fix: an explicit `destroy` or
 * `stopListener` drops the native entry without reporting a close, and a close it does report
 * for the id arrives later, if at all. The bridge must not depend on either.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: never) => void>();
  let listeners = 0;
  const native = {
    isAvailable: () => false,
    addListener: (event: string, listener: (event: never) => void) => handlers.set(event, listener),
    startListener: vi.fn(async () => ({
      listenerId: `listener-${(listeners += 1)}`,
      port: 52_801,
    })),
    stopListener: vi.fn(),
    write: vi.fn(async () => undefined),
    end: vi.fn(),
    destroy: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { handlers, native };
});

vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock("expo-crypto", () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }));

import { secureChannelPlatform } from "./secureChannel";

function emit<E extends object>(event: string, payload: E): void {
  mocks.handlers.get(event)!(payload as never);
}

/** A connector that records what it carries and, like the real one, destroys it all on close. */
function fakeConnector() {
  const endpoints: Array<LinkEndpoint> = [];
  const connections: Array<{ [K in keyof ForwardedConnection]: ReturnType<typeof vi.fn> }> = [];
  const connector = {
    attach: (endpoint: LinkEndpoint): ForwardedConnection => {
      endpoints.push(endpoint);
      const connection = { write: vi.fn(), end: vi.fn(), reset: vi.fn() };
      connections.push(connection);
      return connection;
    },
    close: () => {
      for (const endpoint of endpoints.splice(0)) endpoint.destroy("The route closed.");
    },
  } as unknown as ChannelConnector;
  return { connector, endpoints, connections };
}

beforeEach(() => {
  for (const fn of [mocks.native.stopListener, mocks.native.destroy, mocks.native.end]) {
    fn.mockClear();
  }
});

describe("the secure channel's loopback bridge", () => {
  it("releases every connection a closed listener carried, so late native events are no-ops", async () => {
    const { connector, connections } = fakeConnector();
    const listener = await secureChannelPlatform.startListener(connector);
    const listenerId = (await mocks.native.startListener.mock.results.at(-1)!.value).listenerId;
    const ids = ["1", "2", "3", "4", "5"];
    for (const connectionId of ids) emit("onConnection", { listenerId, connectionId });
    expect(connections).toHaveLength(5);

    await listener.close();
    expect(mocks.native.destroy.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(mocks.native.stopListener).toHaveBeenCalledWith(listenerId);

    // Whatever native reports afterwards reaches nothing: the streams are gone.
    for (const connectionId of ids) {
      emit("onClose", { connectionId });
      emit("onData", { connectionId, data: new Uint8Array([1]) });
      emit("onEnd", { connectionId });
    }
    for (const connection of connections) {
      expect(connection.reset).not.toHaveBeenCalled();
      expect(connection.write).not.toHaveBeenCalled();
      expect(connection.end).not.toHaveBeenCalled();
    }
    // A connection accepted after the close is refused rather than carried.
    emit("onConnection", { listenerId, connectionId: "late" });
    expect(connections).toHaveLength(5);
    expect(mocks.native.destroy).toHaveBeenLastCalledWith("late");
  });

  it("releases a connection the route resets, with or without a native close", async () => {
    const { connector, endpoints, connections } = fakeConnector();
    const listener = await secureChannelPlatform.startListener(connector);
    const listenerId = (await mocks.native.startListener.mock.results.at(-1)!.value).listenerId;
    emit("onConnection", { listenerId, connectionId: "a" });

    endpoints[0]!.destroy("The channel failed.");
    expect(mocks.native.destroy).toHaveBeenCalledWith("a");
    emit("onClose", { connectionId: "a", error: "Connection reset by peer" });
    emit("onData", { connectionId: "a", data: new Uint8Array([1]) });
    expect(connections[0]!.reset).not.toHaveBeenCalled();
    expect(connections[0]!.write).not.toHaveBeenCalled();
    await listener.close();
  });

  it("still resets a connection native closes before both halves ended, once", async () => {
    const { connector, endpoints, connections } = fakeConnector();
    const listener = await secureChannelPlatform.startListener(connector);
    const listenerId = (await mocks.native.startListener.mock.results.at(-1)!.value).listenerId;
    emit("onConnection", { listenerId, connectionId: "b" });
    emit("onConnection", { listenerId, connectionId: "c" });

    emit("onData", { connectionId: "b", data: new Uint8Array([7]) });
    expect(connections[0]!.write).toHaveBeenCalledWith(new Uint8Array([7]));
    emit("onClose", { connectionId: "b", error: "Connection reset by peer" });
    emit("onClose", { connectionId: "b", error: "Connection reset by peer" });
    expect(connections[0]!.reset).toHaveBeenCalledTimes(1);
    expect(connections[0]!.reset).toHaveBeenCalledWith("Connection reset by peer");

    // Both halves ended: the native close is the clean end of the stream, not a reset.
    emit("onEnd", { connectionId: "c" });
    expect(connections[1]!.end).toHaveBeenCalledTimes(1);
    endpoints[1]!.end();
    expect(mocks.native.end).toHaveBeenCalledWith("c");
    emit("onClose", { connectionId: "c" });
    expect(connections[1]!.reset).not.toHaveBeenCalled();
    await listener.close();
  });
});
