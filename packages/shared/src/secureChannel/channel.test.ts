import { assert, describe, it } from "@effect/vitest";

import { type ChannelEvent, type ChannelLimits, SecureChannel } from "./channel.ts";
import { decodeFrame, encodeFrame, type Frame } from "./frames.ts";
import { acceptChannel, initiateChannel } from "./handshake.ts";
import {
  acceptHandshake,
  generateKeyPair,
  initiateHandshake,
  NOISE_MAX_MESSAGE_BYTES,
  type NoiseTransport,
} from "./noise.ts";

const ORIGIN = "https://quiet.example.com";
const KiB = 1024;
const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function connect(options?: {
  readonly limits?: Partial<ChannelLimits>;
  readonly now?: () => number;
}) {
  const serverKey = generateKeyPair();
  const initiation = initiateChannel({
    origin: ORIGIN,
    serverKey: serverKey.publicKey,
    clientKey: generateKeyPair(),
    ...options,
  });
  const acceptance = acceptChannel({
    origin: ORIGIN,
    serverKey,
    protocols: initiation.protocols.join(", "),
    ...options,
  });
  if (acceptance === undefined) throw new Error("The handshake failed.");
  const { message, channel: server } = acceptance.accept();
  return { client: initiation.finish(message), server };
}

/** Takes every message `from` can send now. */
function drain(from: SecureChannel): Uint8Array[] {
  const messages: Uint8Array[] = [];
  for (let message = from.takeOutgoing(); message !== undefined; message = from.takeOutgoing()) {
    messages.push(message);
  }
  return messages;
}

/** Delivers everything `from` can send now, returning what `to` makes of it. */
function deliver(from: SecureChannel, to: SecureChannel): ChannelEvent[] {
  return drain(from).flatMap((message) => to.receive(message));
}

/** Delivers both ways until neither side has anything to send. */
function settle(client: SecureChannel, server: SecureChannel) {
  const events = { client: [] as ChannelEvent[], server: [] as ChannelEvent[] };
  for (;;) {
    const toServer = drain(client);
    const toClient = drain(server);
    if (toServer.length === 0 && toClient.length === 0) return events;
    for (const message of toServer) events.server.push(...server.receive(message));
    for (const message of toClient) events.client.push(...client.receive(message));
  }
}

/** The bytes a list of events delivered on one stream, in order. */
function received(events: ReadonlyArray<ChannelEvent>, stream: number): Uint8Array {
  const chunks = events.flatMap((event) =>
    event.type === "data" && event.stream === stream ? [event.bytes] : [],
  );
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** Grants back every data event's credit, as a reader that keeps up does. */
function grantAll(channel: SecureChannel, events: ReadonlyArray<ChannelEvent>): void {
  for (const event of events) if (event.type === "data") channel.grant(event.stream, event.credit);
}

/** A channel in `role` facing a raw peer that writes whatever frames a test hands it. */
function facingRawPeer(role: "client" | "server", limits?: Partial<ChannelLimits>) {
  const clientKey = generateKeyPair();
  const serverKey = generateKeyPair();
  const prologue = text("raw");
  const initiation = initiateHandshake({
    prologue,
    staticKey: clientKey,
    serverKey: serverKey.publicKey,
    payload: new Uint8Array(0),
  });
  const response = acceptHandshake({
    prologue,
    staticKey: serverKey,
    message: initiation.message,
  }).respond(new Uint8Array(0));
  const clientTransport = initiation.readResponse(response.message).transport;
  const [own, peer]: [NoiseTransport, NoiseTransport] =
    role === "client"
      ? [clientTransport, response.transport]
      : [response.transport, clientTransport];
  const channel = new SecureChannel({
    role,
    transport: own,
    ...(limits === undefined ? {} : { limits }),
  });
  return {
    channel,
    peer,
    send: (frame: Frame) => channel.receive(peer.send.encrypt(encodeFrame(frame))),
    read: (message: Uint8Array) => decodeFrame(peer.receive.decrypt(message)),
  };
}

const types = (events: ReadonlyArray<ChannelEvent>) => events.map((event) => event.type);

describe("SecureChannel", () => {
  it("carries bytes both ways on a stream, and each side ends its half", () => {
    const { client, server } = connect();
    const stream = client.open();
    client.write(stream, text("GET / HTTP/1.1\r\n\r\n"));
    client.end(stream);
    assert.deepStrictEqual(types(deliver(client, server)), ["open", "data", "end"]);

    server.write(stream, text("HTTP/1.1 200 OK\r\n\r\nhi"));
    server.end(stream);
    const response = deliver(server, client);
    assert.strictEqual(decode(received(response, stream)), "HTTP/1.1 200 OK\r\n\r\nhi");
    assert.strictEqual(response.at(-1)?.type, "end");

    // Both halves ended, so the stream is gone and a late write is a no-op.
    server.write(stream, text("late"));
    assert.isUndefined(server.takeOutgoing());
  });

  it("splits a large write into frames that each fit one Noise message", () => {
    const { client, server } = connect();
    const stream = client.open();
    const large = Uint8Array.from({ length: 600 * KiB }, (_, index) => index % 251);
    client.write(stream, large);
    const sizes: number[] = [];
    const events: ChannelEvent[] = [];
    for (let rounds = 0; rounds < 100; rounds += 1) {
      const messages = drain(client);
      if (messages.length === 0) break;
      for (const message of messages) {
        sizes.push(message.length);
        const arrived = server.receive(message);
        events.push(...arrived);
        grantAll(server, arrived);
      }
      deliver(server, client);
    }
    assert.isAtMost(Math.max(...sizes), NOISE_MAX_MESSAGE_BYTES);
    assert.isAtLeast(sizes.length, 10);
    assert.deepStrictEqual(received(events, stream), large);
  });

  it("holds a stream at the window until a slow reader grants more, while other streams flow", () => {
    const { client, server } = connect();
    const download = client.open();
    const rpc = client.open();
    deliver(client, server);
    server.write(download, new Uint8Array(1024 * KiB));
    server.end(download);

    // The reader consumes nothing, so the server stops at one window.
    const stalled = settle(client, server).client;
    assert.strictEqual(received(stalled, download).length, 256 * KiB);
    assert.isUndefined(server.takeOutgoing());
    assert.strictEqual(server.queuedBytes(download), 768 * KiB);

    server.write(rpc, text("still here"));
    assert.strictEqual(decode(received(deliver(server, client), rpc)), "still here");

    // Each grant lets that much more through, until the stream is done.
    let total = 256 * KiB;
    let last: ChannelEvent | undefined;
    for (let rounds = 0; rounds < 20 && total < 1024 * KiB; rounds += 1) {
      client.grant(download, 256 * KiB);
      const more = settle(client, server).client;
      total += received(more, download).length;
      last = more.at(-1) ?? last;
    }
    assert.strictEqual(total, 1024 * KiB);
    assert.strictEqual(last?.type, "end");
    assert.strictEqual(server.queuedBytes(download), 0);
  });

  it("interleaves a small write with a large transfer instead of sending it last", () => {
    const { client, server } = connect();
    const download = client.open();
    const rpc = client.open();
    deliver(client, server);
    server.write(download, new Uint8Array(200 * KiB));
    server.write(rpc, text("urgent"));
    const order = drain(server)
      .flatMap((message) => client.receive(message))
      .map((event) => (event.type === "data" ? event.stream : event.type));
    assert.isAtMost(order.indexOf(rpc), 1);
    assert.strictEqual(order.filter((stream) => stream === download).length, 4);
  });

  it("rekeys after its message limit and keeps talking", () => {
    const { client, server } = connect({ limits: { rekeyAfterMessages: 3 } });
    const stream = client.open();
    deliver(client, server);
    for (let index = 0; index < 10; index += 1) server.write(stream, text(`chunk ${index};`));
    const messages = drain(server);
    assert.isAbove(messages.length, 10);
    const events = messages.flatMap((message) => client.receive(message));
    assert.strictEqual(
      decode(received(events, stream)),
      Array.from({ length: 10 }, (_, index) => `chunk ${index};`).join(""),
    );
  });

  it("changes the key at the rekey frame, so only a reader that follows it reads on", () => {
    const raw = facingRawPeer("client", { rekeyAfterMessages: 2 });
    for (const byte of [1, 2, 3]) raw.channel.ping(Uint8Array.of(byte));
    const [first, second, rekey, third] = drain(raw.channel);
    assert.deepStrictEqual(
      [first, second, rekey].map((message) => raw.read(message!).type),
      ["ping", "ping", "rekey"],
    );
    assert.throws(() => raw.read(third!));
    raw.peer.receive.rekey();
    assert.deepStrictEqual(raw.read(third!), { type: "ping", data: Uint8Array.of(3) });
  });

  it("rekeys after an hour by the clock", () => {
    let now = 0;
    const { client, server } = connect({ now: () => now });
    const stream = client.open();
    deliver(client, server);
    now += 61 * 60_000;
    server.write(stream, text("an hour later"));
    const messages = drain(server);
    assert.strictEqual(messages.length, 2);
    const events = messages.flatMap((message) => client.receive(message));
    assert.strictEqual(decode(received(events, stream)), "an hour later");
  });

  it("closes for good on a tampered message", () => {
    const { client, server } = connect();
    server.ping(Uint8Array.of(1));
    const tampered = server.takeOutgoing()!.slice();
    tampered[tampered.length - 1]! ^= 1;
    assert.deepStrictEqual(client.receive(tampered), [
      { type: "closed", reason: "A message failed to authenticate." },
    ]);
    assert.strictEqual(client.closedReason, "A message failed to authenticate.");

    server.ping(Uint8Array.of(2));
    assert.deepStrictEqual(client.receive(server.takeOutgoing()!), []);
    client.ping(Uint8Array.of(3));
    assert.isUndefined(client.takeOutgoing());
    assert.throws(() => client.open());
  });

  it("closes on a replayed message", () => {
    const { client, server } = connect();
    server.ping(Uint8Array.of(1));
    const message = server.takeOutgoing()!;
    client.receive(message);
    assert.deepStrictEqual(types(client.receive(message)), ["closed"]);
  });

  it("answers a ping with a pong", () => {
    const { client, server } = connect();
    client.ping(Uint8Array.of(7, 7));
    assert.deepStrictEqual(settle(client, server).client, [
      { type: "pong", data: Uint8Array.of(7, 7) },
    ]);
  });

  it("resets streams past the server's limit", () => {
    const { client, server } = connect({ limits: { maxStreams: 2 } });
    const streams = [client.open(), client.open(), client.open()];
    const { client: atClient, server: atServer } = settle(client, server);
    assert.deepStrictEqual(
      atServer.map((event) => event.type === "open" && event.stream),
      streams.slice(0, 2),
    );
    assert.deepStrictEqual(atClient, [
      { type: "reset", stream: streams[2]!, reason: "Too many streams." },
    ]);
  });

  it("closes when the peer breaks the protocol", () => {
    const overrun = facingRawPeer("client");
    const stream = overrun.channel.open();
    for (let sent = 0; sent < 256 * KiB; sent += 32 * KiB) {
      const bytes = new Uint8Array(32 * KiB);
      assert.strictEqual(overrun.send({ type: "data", stream, bytes }).length, 1);
    }
    assert.deepStrictEqual(overrun.send({ type: "data", stream, bytes: new Uint8Array(1) }), [
      { type: "closed", reason: "The peer overran its credit." },
    ]);

    const opener = facingRawPeer("client");
    assert.deepStrictEqual(types(opener.send({ type: "open", stream: 1 })), ["closed"]);

    const afterEnd = facingRawPeer("client");
    const ended = afterEnd.channel.open();
    afterEnd.send({ type: "end", stream: ended });
    const late = {
      type: "data",
      stream: ended,
      bytes: Uint8Array.of(1),
    } as const;
    assert.deepStrictEqual(types(afterEnd.send(late)), ["closed"]);
  });

  it("closes when the client reuses a stream id or opens an even one", () => {
    const reused = facingRawPeer("server");
    assert.deepStrictEqual(types(reused.send({ type: "open", stream: 1 })), ["open"]);
    assert.deepStrictEqual(types(reused.send({ type: "open", stream: 3 })), ["open"]);
    assert.deepStrictEqual(types(reused.send({ type: "open", stream: 1 })), ["closed"]);

    const even = facingRawPeer("server");
    assert.deepStrictEqual(types(even.send({ type: "open", stream: 2 })), ["closed"]);
  });

  it("only ever sends what the reader's credit allows", () => {
    const raw = facingRawPeer("client");
    const upload = raw.channel.open();
    raw.channel.write(upload, new Uint8Array(1024 * KiB));
    const sum = (frames: ReadonlyArray<Frame>) =>
      frames.reduce(
        (total, frame) => (frame.type === "data" ? total + frame.bytes.length : total),
        0,
      );
    const sent = drain(raw.channel).map(raw.read);
    assert.strictEqual(sent[0]?.type, "open");
    assert.strictEqual(sum(sent), 256 * KiB);

    raw.send({ type: "credit", stream: upload, bytes: 100 * KiB });
    assert.strictEqual(sum(drain(raw.channel).map(raw.read)), 100 * KiB);
  });

  it("answers only the latest ping, and closes once a peer that reads nothing piles up control frames", () => {
    const pinged = facingRawPeer("server");
    for (let index = 0; index < 1000; index += 1) {
      pinged.send({ type: "ping", data: new Uint8Array(1000) });
    }
    assert.isUndefined(pinged.channel.closedReason);
    assert.deepStrictEqual(
      drain(pinged.channel).map((message) => pinged.read(message).type),
      ["pong"],
    );

    const flooded = facingRawPeer("server", { maxStreams: 1 });
    flooded.send({ type: "open", stream: 1 });
    let last: ReadonlyArray<ChannelEvent> = [];
    for (let id = 3; id < 20_000 && flooded.channel.closedReason === undefined; id += 2) {
      last = flooded.send({ type: "open", stream: id });
    }
    assert.strictEqual(flooded.channel.closedReason, "The peer stopped reading.");
    assert.deepStrictEqual(types(last), ["closed"]);
  });

  it("refuses a message longer than Noise allows", () => {
    const peer = facingRawPeer("client");
    const stream = peer.channel.open();
    const bytes = new Uint8Array(NOISE_MAX_MESSAGE_BYTES);
    assert.deepStrictEqual(types(peer.send({ type: "data", stream, bytes })), ["closed"]);
  });

  it("never throws on forged frames, and stays closed once it closes", () => {
    let state = 0x9e3779b9;
    const random = (below: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % below;
    };
    for (let round = 0; round < 300; round += 1) {
      const server = facingRawPeer("server", { maxStreams: 4 });
      for (const stream of [1, 3, 5]) server.send({ type: "open", stream });
      for (let message = 0; message < 20; message += 1) {
        const stream = [1, 3, 5, 7, 9][random(5)]!;
        const forged: Array<() => Uint8Array> = [
          () => Uint8Array.from({ length: random(24) }, () => random(256)),
          () => encodeFrame({ type: "data", stream, bytes: new Uint8Array(random(512)) }),
          () =>
            encodeFrame({
              type: "credit",
              stream,
              bytes: random(2) === 0 ? random(4096) : 2 ** 33,
            }),
          () => encodeFrame({ type: "reset", stream, reason: "x".repeat(random(64)) }),
          () => encodeFrame({ type: "end", stream }),
          () => encodeFrame({ type: "open", stream }),
          () => encodeFrame({ type: "rekey" }),
          () => encodeFrame({ type: "ping", data: new Uint8Array(random(64)) }),
        ];
        const plaintext = forged[random(forged.length)]!();
        const wasClosed = server.channel.closedReason !== undefined;
        const events = server.channel.receive(server.peer.send.encrypt(plaintext));
        if (wasClosed) assert.deepStrictEqual(events, []);
        drain(server.channel);
      }
    }
  });
});
