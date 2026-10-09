import { assert, describe, it } from "@effect/vitest";

import { ChannelLink, defaultLinkTimers, type LinkEndpoint } from "./link.ts";
import { ChannelConnector, type OuterSocket } from "./connector.ts";
import { acceptChannel } from "./handshake.ts";
import { generateKeyPair } from "./noise.ts";

const ORIGIN = "https://quiet.example.com";
const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * An outer socket backed by an in-process gateway that echoes each stream back in upper case.
 * Like React Native's, it never sets `bufferedAmount`.
 */
function echoGateway() {
  const serverKey = generateKeyPair();
  const sockets: Array<{ sent: number }> = [];
  const openSocket = (url: string, protocols: ReadonlyArray<string>): OuterSocket => {
    const listeners = new Map<string, Array<(event: { readonly data: unknown }) => void>>();
    const emit = (type: string, data?: unknown) =>
      queueMicrotask(() => listeners.get(type)?.forEach((listener) => listener({ data })));
    const record = { sent: 0 };
    sockets.push(record);
    const acceptance = acceptChannel({
      origin: ORIGIN,
      serverKey,
      protocols: protocols.join(", "),
    });
    let gateway: ChannelLink | undefined;
    const socket = {
      binaryType: "blob",
      bufferedAmount: undefined as unknown as number,
      send: (data: Uint8Array) => {
        record.sent += 1;
        queueMicrotask(() => gateway?.receive(data));
      },
      close: () => emit("close"),
      addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    } as OuterSocket;
    if (acceptance === undefined || !url.startsWith("wss://quiet.example.com/")) {
      emit("close");
      return socket;
    }
    const { message, channel } = acceptance.accept();
    gateway = new ChannelLink({
      channel,
      socket: {
        send: (bytes) => emit("message", bytes.slice().buffer),
        bufferedAmount: () => 0,
        close: () => emit("close"),
      },
      onOpen: (stream) => ({
        write: (bytes, taken) => {
          gateway?.write(stream, text(decode(bytes).toUpperCase()));
          taken();
        },
        end: () => gateway?.end(stream),
        destroy: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
      }),
      onClosed: () => undefined,
    });
    emit("message", message.slice().buffer);
    return socket;
  };
  return { serverKey, openSocket, sockets };
}

/** A local connection that collects what comes back until the gateway ends the stream. */
function collector() {
  const received: Array<string> = [];
  let ended: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const endpoint: LinkEndpoint = {
    write: (bytes, taken) => {
      received.push(decode(bytes));
      taken();
    },
    end: () => ended(),
    destroy: () => ended(),
    pause: () => undefined,
    resume: () => undefined,
  };
  return { endpoint, done, received: () => received.join("") };
}

describe("ChannelConnector", () => {
  it("carries local connections over a socket that reports no bufferedAmount", async () => {
    const gateway = echoGateway();
    const connector = new ChannelConnector({
      route: {
        origin: ORIGIN,
        serverKey: gateway.serverKey.publicKey,
        clientKey: generateKeyPair(),
      },
      openSocket: gateway.openSocket,
    });
    // Written before the channel opens, so it waits for the handshake.
    const local = collector();
    const connection = connector.attach(local.endpoint);
    connection.write(text("get /api/orchestration/shell"));
    connection.end();
    await local.done;
    assert.strictEqual(local.received(), "GET /API/ORCHESTRATION/SHELL");
    assert.isTrue(connector.open);
    assert.strictEqual(gateway.sockets.length, 1);
    assert.isAbove(gateway.sockets[0]!.sent, 0);
    connector.close();
  });

  it("fails closed when the server doesn't answer as the pinned key", async () => {
    const gateway = echoGateway();
    const connector = new ChannelConnector({
      route: {
        origin: ORIGIN,
        serverKey: generateKeyPair().publicKey,
        clientKey: generateKeyPair(),
      },
      openSocket: gateway.openSocket,
    });
    const failure = await connector.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.include(String(failure), "couldn't connect");
    const local = collector();
    connector.attach(local.endpoint);
    await local.done;
    assert.strictEqual(local.received(), "");
  });

  it("fails local connections at once while backing off, until the wait is over", async () => {
    let clock = 0;
    let attempts = 0;
    const connector = new ChannelConnector({
      route: {
        origin: ORIGIN,
        serverKey: generateKeyPair().publicKey,
        clientKey: generateKeyPair(),
      },
      openSocket: () => {
        attempts += 1;
        return silentSocket("close");
      },
      timers: { ...defaultLinkTimers, now: () => clock },
    });
    const attach = async () => {
      const local = collector();
      connector.attach(local.endpoint);
      await local.done;
    };
    await attach();
    assert.strictEqual(attempts, 1);
    await attach();
    assert.strictEqual(attempts, 1);
    clock += 1_000;
    await attach();
    assert.strictEqual(attempts, 2);
    // The second failure doubles the wait.
    clock += 1_000;
    await attach();
    assert.strictEqual(attempts, 2);
    clock += 1_000;
    await attach();
    assert.strictEqual(attempts, 3);
  });

  it("stops trying after the server fails the handshake, until the app connects again", async () => {
    let clock = 0;
    let attempts = 0;
    const connector = new ChannelConnector({
      route: {
        origin: ORIGIN,
        serverKey: generateKeyPair().publicKey,
        clientKey: generateKeyPair(),
      },
      openSocket: () => {
        attempts += 1;
        return silentSocket("message");
      },
      timers: { ...defaultLinkTimers, now: () => clock },
    });
    const failure = await connector.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.include(String(failure), "doesn't match");
    clock += 60 * 60_000;
    const local = collector();
    connector.attach(local.endpoint);
    await local.done;
    assert.strictEqual(attempts, 1);
    await connector.connect().catch(() => undefined);
    assert.strictEqual(attempts, 2);
  });

  it("pauses a local connection that writes too much before the channel opens", async () => {
    const gateway = echoGateway();
    const connector = new ChannelConnector({
      route: {
        origin: ORIGIN,
        serverKey: gateway.serverKey.publicKey,
        clientKey: generateKeyPair(),
      },
      openSocket: gateway.openSocket,
    });
    const events: Array<string> = [];
    const local = collector();
    const connection = connector.attach({
      ...local.endpoint,
      pause: () => events.push("pause"),
      resume: () => events.push("resume"),
    });
    connection.write(new Uint8Array(200 * 1024).fill(97));
    assert.deepStrictEqual(events, []);
    connection.write(new Uint8Array(100 * 1024).fill(97));
    assert.deepStrictEqual(events, ["pause"]);
    await connector.connect();
    assert.strictEqual(events[1], "resume");
    connector.close();
  });
});

/** An outer socket that, once listened to, only closes or only sends a stray message. */
function silentSocket(answer: "close" | "message"): OuterSocket {
  const listeners = new Map<string, Array<(event: { readonly data: unknown }) => void>>();
  queueMicrotask(() =>
    listeners
      .get(answer)
      ?.forEach((listener) => listener({ data: new Uint8Array(48).fill(1).buffer })),
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
