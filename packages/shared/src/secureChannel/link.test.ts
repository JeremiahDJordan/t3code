import { assert, describe, it } from "@effect/vitest";

import { acceptChannel, initiateChannel } from "./handshake.ts";
import { ChannelLink, type LinkEndpoint, type LinkTimers } from "./link.ts";
import { generateKeyPair } from "./noise.ts";

const KiB = 1024;

/** Bytes from a xorshift generator. */
function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}
const text = (value: string) => new TextEncoder().encode(value);

/** Timers driven by `advance`, so keepalive and idle checks run without waiting. */
function manualTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; every: number | undefined; run: () => void }>();
  const api: LinkTimers = {
    setInterval: (run, ms) => (timers.set(++nextId, { at: now + ms, every: ms, run }), nextId),
    clearInterval: (handle) => timers.delete(handle as number),
    setTimeout: (run, ms) => (
      timers.set(++nextId, { at: now + ms, every: undefined, run }),
      nextId
    ),
    clearTimeout: (handle) => timers.delete(handle as number),
    now: () => now,
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === undefined) timers.delete(id);
      else timer.at += timer.every;
      timer.run();
    }
    now = until;
  };
  return { api, advance };
}

function joined(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

/** A local endpoint that records what it gets, and takes writes only when told to. */
function endpoint(options?: { readonly holdWrites?: boolean }) {
  const chunks: Uint8Array[] = [];
  const state = {
    chunks,
    get bytes() {
      return joined(chunks);
    },
    ended: false,
    destroyed: undefined as string | undefined,
    paused: false,
    held: [] as Array<() => void>,
  };
  const value: LinkEndpoint = {
    write: (bytes, taken) => {
      chunks.push(bytes.slice());
      if (options?.holdWrites) state.held.push(taken);
      else taken();
    },
    end: () => (state.ended = true),
    destroy: (reason) => (state.destroyed = reason),
    pause: () => (state.paused = true),
    resume: () => (state.paused = false),
  };
  return { state, value, release: () => state.held.splice(0).forEach((taken) => taken()) };
}

/** A client and server link joined by in-memory sockets; `flush` delivers until both are quiet. */
function linkedPair(options?: {
  readonly onOpen?: (stream: number) => LinkEndpoint | undefined;
  readonly serverBuffered?: () => number;
}) {
  const timers = manualTimers();
  const serverKey = generateKeyPair();
  const initiation = initiateChannel({
    origin: "https://quiet.example.com",
    serverKey: serverKey.publicKey,
    clientKey: generateKeyPair(),
  });
  const accepted = acceptChannel({
    origin: "https://quiet.example.com",
    serverKey,
    protocols: initiation.protocols.join(", "),
  })!.accept();
  const toServer: Uint8Array[] = [];
  const toClient: Uint8Array[] = [];
  const closed = {
    client: undefined as string | undefined,
    server: undefined as string | undefined,
    sockets: 0,
  };
  const client = new ChannelLink({
    channel: initiation.finish(accepted.message),
    socket: {
      send: (bytes) => toServer.push(bytes),
      bufferedAmount: () => 0,
      close: () => (closed.sockets += 1),
    },
    onClosed: (reason) => (closed.client = reason),
    timers: timers.api,
  });
  const server = new ChannelLink({
    channel: accepted.channel,
    socket: {
      send: (bytes) => toClient.push(bytes),
      bufferedAmount: options?.serverBuffered ?? (() => 0),
      close: () => (closed.sockets += 1),
    },
    onOpen: options?.onOpen ?? (() => undefined),
    onClosed: (reason) => (closed.server = reason),
    timers: timers.api,
  });
  const flush = () => {
    while (toServer.length > 0 || toClient.length > 0) {
      for (const message of toServer.splice(0)) server.receive(message);
      for (const message of toClient.splice(0)) client.receive(message);
    }
  };
  return { client, server, flush, timers, closed, toClient, toServer };
}

describe("ChannelLink", () => {
  it("pipes a local connection to the server's endpoint and back, then forgets it", () => {
    const upstream = endpoint();
    let opened: number | undefined;
    const pair = linkedPair({ onOpen: (stream) => ((opened = stream), upstream.value) });
    const local = endpoint();
    const stream = pair.client.open(local.value)!;
    pair.client.write(stream, text("GET /api/orchestration/shell HTTP/1.1\r\n\r\n"));
    pair.flush();
    assert.strictEqual(opened, stream);
    assert.strictEqual(
      new TextDecoder().decode(upstream.state.bytes),
      "GET /api/orchestration/shell HTTP/1.1\r\n\r\n",
    );

    const response = text(`HTTP/1.1 200 OK\r\n\r\n${'{"threads":[]}'.repeat(200)}`);
    pair.server.write(stream, response);
    pair.server.end(stream);
    pair.client.end(stream);
    pair.flush();
    assert.deepStrictEqual(local.state.bytes, response);
    assert.isTrue(local.state.ended);
    assert.isTrue(upstream.state.ended);
    assert.strictEqual(pair.client.streams, 0);
    assert.strictEqual(pair.server.streams, 0);
  });

  it("resets the local connection when the server refuses the stream", () => {
    const pair = linkedPair({ onOpen: () => undefined });
    const local = endpoint();
    pair.client.open(local.value);
    pair.flush();
    assert.strictEqual(local.state.destroyed, "Refused.");
    assert.strictEqual(pair.client.streams, 0);
  });

  it("stops at the window while the local reader holds its writes, and pauses the source", () => {
    const upstream = endpoint();
    const pair = linkedPair({ onOpen: () => upstream.value });
    const local = endpoint({ holdWrites: true });
    const stream = pair.client.open(local.value)!;
    pair.flush();
    pair.server.write(stream, patterned(2048 * KiB));
    pair.flush();
    // The phone hasn't taken anything, so exactly one window crossed, and the upstream reader is
    // paused.
    assert.strictEqual(local.state.bytes.length, 256 * KiB);
    assert.isTrue(upstream.state.paused);

    for (let rounds = 0; rounds < 50 && local.state.bytes.length < 2048 * KiB; rounds += 1) {
      local.release();
      pair.flush();
    }
    assert.strictEqual(local.state.bytes.length, 2048 * KiB);
    assert.isFalse(upstream.state.paused);
  });

  it("holds messages while the outer socket is backed up, and retries once it drains", () => {
    let buffered = 2 * 1024 * KiB;
    const upstream = endpoint();
    const pair = linkedPair({ onOpen: () => upstream.value, serverBuffered: () => buffered });
    const local = endpoint();
    const stream = pair.client.open(local.value)!;
    pair.flush();
    pair.server.write(stream, text("waiting"));
    assert.strictEqual(pair.toClient.length, 0);
    buffered = 0;
    pair.timers.advance(10);
    pair.flush();
    assert.strictEqual(new TextDecoder().decode(local.state.bytes), "waiting");
  });

  it("ignores a local endpoint that writes or ends again after it ended", () => {
    const upstream = endpoint();
    const pair = linkedPair({ onOpen: () => upstream.value });
    const stream = pair.client.open(endpoint().value)!;
    pair.client.end(stream);
    pair.client.write(stream, text("late"));
    pair.client.end(stream);
    pair.flush();
    assert.isTrue(upstream.state.ended);
    assert.strictEqual(upstream.state.bytes.length, 0);
    assert.isFalse(pair.client.closed);
  });

  it("closes when a peer that stops reading keeps opening streams it can't have", () => {
    const pair = linkedPair({ serverBuffered: () => 2 * 1024 * KiB });
    for (let opened = 0; opened < 10_000 && pair.closed.server === undefined; opened += 1) {
      pair.client.open(endpoint().value);
      pair.flush();
    }
    assert.strictEqual(pair.closed.server, "The peer stopped reading.");
    assert.isTrue(pair.server.closed);
  });

  it("buffers at most about a quarter MiB in the socket, so new data isn't stuck behind it", () => {
    let pending: ReadonlyArray<Uint8Array> = [];
    const pair = linkedPair({
      onOpen: () => endpoint().value,
      serverBuffered: () => pending.reduce((total, message) => total + message.length, 0),
    });
    const streams = [0, 1, 2, 3].map(() => pair.client.open(endpoint().value)!);
    pair.flush();
    pending = pair.toClient;
    for (const stream of streams) pair.server.write(stream, patterned(512 * KiB));
    const buffered = pair.toClient.reduce((total, message) => total + message.length, 0);
    assert.isAtMost(buffered, 256 * KiB + 64 * KiB);
  });

  it("holds a channel to a few MiB when the peer stops reading, however many streams fill", () => {
    const upstreams = new Map<number, ReturnType<typeof endpoint>>();
    const pair = linkedPair({
      onOpen: (stream) => {
        const upstream = endpoint();
        upstreams.set(stream, upstream);
        return upstream.value;
      },
      serverBuffered: () => 64 * 1024 * KiB,
    });
    for (let index = 0; index < 64; index += 1) pair.client.open(endpoint().value);
    pair.flush();
    const chunk = patterned(64 * KiB);
    let accepted = 0;
    for (let round = 0; round < 1000; round += 1) {
      const reading = [...upstreams].filter(([, upstream]) => !upstream.state.paused);
      if (reading.length === 0) break;
      for (const [stream] of reading) {
        pair.server.write(stream, chunk);
        accepted += chunk.length;
      }
    }
    assert.isTrue([...upstreams.values()].every((upstream) => upstream.state.paused));
    assert.isAtMost(accepted, 64 * 64 * KiB);
  });

  it("keeps other streams flowing while some stall with readers that take nothing", () => {
    const upstreams = new Map<number, ReturnType<typeof endpoint>>();
    const pair = linkedPair({
      onOpen: (stream) => {
        const upstream = endpoint();
        upstreams.set(stream, upstream);
        return upstream.value;
      },
    });
    const stalled = [0, 1, 2, 3, 4].map(() =>
      pair.client.open(endpoint({ holdWrites: true }).value)!,
    );
    const live = endpoint();
    const flowing = pair.client.open(live.value)!;
    pair.flush();
    for (const stream of stalled) {
      for (let round = 0; round < 20 && !upstreams.get(stream)!.state.paused; round += 1) {
        pair.server.write(stream, patterned(64 * KiB));
        pair.flush();
      }
    }
    pair.server.write(flowing, text("still here"));
    pair.flush();
    assert.isFalse(upstreams.get(flowing)!.state.paused);
    assert.strictEqual(new TextDecoder().decode(live.state.bytes), "still here");
  });

  it("pings to keep the tunnel alive, and closes a channel that goes quiet", () => {
    const pair = linkedPair();
    pair.timers.advance(25_000);
    assert.strictEqual(pair.toServer.length, 1);
    assert.strictEqual(pair.toClient.length, 1);
    pair.flush();
    // The pongs count as hearing from the peer.
    pair.timers.advance(50_000);
    pair.flush();
    assert.isFalse(pair.client.closed);

    const local = endpoint();
    pair.client.open(local.value);
    // Nothing more is delivered, so both sides fall silent.
    pair.toServer.length = 0;
    pair.timers.advance(80_000);
    assert.strictEqual(pair.closed.client, "The channel went quiet.");
    assert.strictEqual(local.state.destroyed, "The channel went quiet.");
  });

  it("closes everything when a message fails to authenticate", () => {
    const upstream = endpoint();
    const pair = linkedPair({ onOpen: () => upstream.value });
    const local = endpoint();
    const stream = pair.client.open(local.value)!;
    pair.flush();
    pair.server.write(stream, text("hello"));
    const tampered = pair.toClient.splice(0)[0]!.slice();
    tampered[tampered.length - 1]! ^= 1;
    pair.client.receive(tampered);
    assert.strictEqual(pair.closed.client, "A message failed to authenticate.");
    assert.strictEqual(local.state.destroyed, "A message failed to authenticate.");
    assert.isTrue(pair.client.closed);
    assert.isAtLeast(pair.closed.sockets, 1);
  });
});
