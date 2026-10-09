/**
 * Byte streams over one Noise transport, each like one TCP connection, with its own credit window
 * and fair turns on the shared outer WebSocket. A pure state machine with no I/O or timers. The
 * owner feeds each incoming message to `receive` and acts on the events it returns, and after
 * every call sends whatever `takeOutgoing` yields until it yields nothing. A side reading from a
 * socket pauses it while `queuedBytes` is high; the round robin across streams then keeps a large
 * transfer from starving the RPC connection. Nothing is compressed: compressing before encrypting
 * would show whoever carries the ciphertext how well each message compressed, and the server
 * already compresses what it serves.
 *
 * @module secureChannel/channel
 */
import { dataFrameOverhead, decodeFrame, encodeFrame, type Frame } from "./frames.ts";
import {
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_MAX_PLAINTEXT_BYTES,
  type NoiseTransport,
} from "./noise.ts";

export interface ChannelLimits {
  /** Bytes a stream may have in flight before its reader grants more. */
  readonly streamWindowBytes: number;
  readonly rekeyAfterMessages: number;
  readonly rekeyAfterMs: number;
  /** Streams the client may hold open at once; the server resets any beyond this. */
  readonly maxStreams: number;
}

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = {
  streamWindowBytes: 256 * 1024,
  rekeyAfterMessages: 2 ** 20,
  rekeyAfterMs: 60 * 60_000,
  maxStreams: 64,
};

/**
 * Control frames waiting while the outer socket is backed up, a pending pong aside. A peer that
 * keeps sending while reading nothing would otherwise grow the queue without end.
 */
const MAX_CONTROL_BYTES = 64 * 1024;

/** What a received message means to the channel's owner. */
export type ChannelEvent =
  /** The client opened a stream; the server connects it onward. */
  | { readonly type: "open"; readonly stream: number }
  /** Stream bytes; once they're consumed, the reader passes `credit` to `grant`. */
  | {
      readonly type: "data";
      readonly stream: number;
      readonly bytes: Uint8Array;
      /** What to pass to `grant` once the bytes are consumed. */
      readonly credit: number;
    }
  /** The peer sends nothing more on the stream. */
  | { readonly type: "end"; readonly stream: number }
  /** The stream is gone, reset by the peer or by the channel. */
  | { readonly type: "reset"; readonly stream: number; readonly reason: string }
  | { readonly type: "pong"; readonly data: Uint8Array }
  /** The channel failed and is unusable; its owner closes the outer socket. */
  | { readonly type: "closed"; readonly reason: string };

type Outgoing =
  | { readonly frame: Frame["type"]; readonly encoded: Uint8Array }
  | { readonly bytes: Uint8Array; offset: number };

interface StreamState {
  readonly id: number;
  readonly queue: Outgoing[];
  queuedBytes: number;
  sendCredit: number;
  receiveCredit: number;
  /** Bytes consumed since the last grant went out. */
  ungranted: number;
  /** This side queued its `end`, so it sends nothing more. */
  localEnding: boolean;
  /** This side's `end` went out. */
  localDone: boolean;
  remoteDone: boolean;
}

/** The largest grant a peer may hold, far above any window, to refuse an overflowing peer. */
const MAX_SEND_CREDIT = 2 ** 32;

export class SecureChannel {
  readonly #role: "client" | "server";
  readonly #transport: NoiseTransport;
  readonly #now: () => number;
  readonly #limits: ChannelLimits;
  readonly #streams = new Map<number, StreamState>();
  readonly #control: Uint8Array[] = [];
  #controlBytes = 0;
  /** The answer to the latest ping; an earlier one waiting is replaced, not queued. */
  #pong: Uint8Array | undefined;
  /** Streams that can send now, in round-robin order. */
  readonly #ready = new Set<number>();
  #nextStreamId = 1;
  #highestRemoteStream = 0;
  #sentSinceRekey = 0;
  #rekeyedAt: number;
  #closedReason: string | undefined;

  constructor(options: {
    readonly role: "client" | "server";
    readonly transport: NoiseTransport;
    readonly now?: () => number;
    readonly limits?: Partial<ChannelLimits>;
  }) {
    this.#role = options.role;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#limits = { ...DEFAULT_CHANNEL_LIMITS, ...options.limits };
    this.#rekeyedAt = this.#now();
  }

  /** Why the channel closed, once it has. */
  get closedReason(): string | undefined {
    return this.#closedReason;
  }

  /** The peer's static key, which the handshake authenticated. */
  get remoteStaticKey(): Uint8Array {
    return this.#transport.remoteStaticKey;
  }

  /** The client's half: opens a stream and returns its id. */
  open(): number {
    if (this.#role !== "client") throw new Error("Only the client opens streams.");
    if (this.#closedReason !== undefined) {
      throw new Error(`The channel closed: ${this.#closedReason}`);
    }
    const stream = this.#newStream(this.#nextStreamId);
    this.#nextStreamId += 2;
    this.#streams.set(stream.id, stream);
    this.#enqueue(stream, {
      frame: "open",
      encoded: encodeFrame({ type: "open", stream: stream.id }),
    });
    return stream.id;
  }

  /** Writes bytes to a stream, sent as the reader's credit allows. */
  write(id: number, bytes: Uint8Array): void {
    const stream = this.#writable(id);
    if (stream === undefined || bytes.length === 0) return;
    this.#enqueue(stream, { bytes, offset: 0 });
  }

  /** Ends this side of a stream once its queued bytes have gone out. */
  end(id: number): void {
    const stream = this.#writable(id);
    if (stream === undefined) return;
    stream.localEnding = true;
    this.#enqueue(stream, { frame: "end", encoded: encodeFrame({ type: "end", stream: id }) });
  }

  /** Abandons a stream at once, dropping whatever it hasn't sent. */
  reset(id: number, reason: string): void {
    if (this.#closedReason !== undefined || !this.#streams.has(id)) return;
    this.#forget(id);
    this.#pushControl(encodeFitting({ type: "reset", stream: id, reason }));
  }

  /** Tells the peer a stream's bytes were consumed by `credit`, so it may send that much more. */
  grant(id: number, credit: number): void {
    const stream = this.#streams.get(id);
    if (this.#closedReason !== undefined || stream === undefined || stream.remoteDone) return;
    const outstanding = this.#limits.streamWindowBytes - stream.receiveCredit - stream.ungranted;
    stream.ungranted += Math.max(0, Math.min(credit, outstanding));
    // Granting in halves of the window keeps the sender busy without a credit frame per message.
    if (stream.ungranted < this.#limits.streamWindowBytes / 2) return;
    stream.receiveCredit += stream.ungranted;
    this.#pushControl(encodeFrame({ type: "credit", stream: id, bytes: stream.ungranted }));
    stream.ungranted = 0;
  }

  /** Bytes written to a stream that haven't gone out yet, for pausing the socket that feeds it. */
  queuedBytes(id: number): number {
    return this.#streams.get(id)?.queuedBytes ?? 0;
  }

  /** Asks the peer for a `pong` carrying the same bytes, to keep the tunnel and its idle timer alive. */
  ping(data: Uint8Array): void {
    if (this.#closedReason === undefined) this.#pushControl(encodeFitting({ type: "ping", data }));
  }

  /** Stops the channel without a word to the peer; its owner closes the outer socket. */
  close(reason: string): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    this.#streams.clear();
    this.#ready.clear();
    this.#control.length = 0;
    this.#controlBytes = 0;
    this.#pong = undefined;
  }

  /** The next message to send, or none when nothing can go out now. */
  takeOutgoing(): Uint8Array | undefined {
    if (this.#closedReason !== undefined) return undefined;
    if (this.#control.length === 0 && this.#pong === undefined && this.#ready.size === 0) {
      return undefined;
    }
    if (
      this.#sentSinceRekey >= this.#limits.rekeyAfterMessages ||
      this.#now() - this.#rekeyedAt >= this.#limits.rekeyAfterMs
    ) {
      // The rekey frame still goes under the old key; the peer switches once it reads it.
      const message = this.#seal(encodeFrame({ type: "rekey" }));
      this.#transport.send.rekey();
      this.#sentSinceRekey = 0;
      this.#rekeyedAt = this.#now();
      return message;
    }
    const pong = this.#pong;
    if (pong !== undefined) {
      this.#pong = undefined;
      return this.#seal(pong);
    }
    const control = this.#control.shift();
    if (control !== undefined) {
      this.#controlBytes -= control.length;
      return this.#seal(control);
    }
    for (const id of this.#ready) {
      const stream = this.#streams.get(id);
      this.#ready.delete(id);
      if (stream === undefined) continue;
      const plaintext = this.#takeFrom(stream);
      if (stream.localDone && stream.remoteDone) this.#forget(id);
      else if (this.#canSend(stream)) this.#ready.add(id);
      return this.#seal(plaintext);
    }
    return undefined;
  }

  /** Reads one message from the peer. Anything forged, replayed or out of protocol closes the channel. */
  receive(message: Uint8Array): ReadonlyArray<ChannelEvent> {
    if (this.#closedReason !== undefined) return [];
    if (message.length > NOISE_MAX_MESSAGE_BYTES) return this.#fail("The message is too large.");
    let frame: Frame;
    try {
      frame = decodeFrame(this.#transport.receive.decrypt(message));
    } catch (cause) {
      return this.#fail(cause instanceof Error ? cause.message : "Unreadable message.");
    }
    try {
      const events = this.#dispatch(frame);
      const reason = this.#closedReason;
      return reason === undefined ? events : [...events, { type: "closed", reason }];
    } catch (cause) {
      return this.#fail(cause instanceof Error ? cause.message : "Protocol violation.");
    }
  }

  #dispatch(frame: Frame): ReadonlyArray<ChannelEvent> {
    if (frame.type === "rekey") {
      this.#transport.receive.rekey();
      return [];
    }
    if (frame.type === "ping") {
      this.#pong = encodeFrame({ type: "pong", data: frame.data });
      return [];
    }
    if (frame.type === "pong") return [frame];
    if (frame.type === "open") {
      if (this.#role !== "server") throw new ProtocolError("Only the client opens streams.");
      if (frame.stream % 2 !== 1 || frame.stream <= this.#highestRemoteStream) {
        throw new ProtocolError("Stream ids must be odd and increasing.");
      }
      this.#highestRemoteStream = frame.stream;
      if (this.#streams.size >= this.#limits.maxStreams) {
        this.#pushControl(
          encodeFrame({ type: "reset", stream: frame.stream, reason: "Too many streams." }),
        );
        return [];
      }
      this.#streams.set(frame.stream, this.#newStream(frame.stream));
      return [frame];
    }

    const stream = this.#streams.get(frame.stream);
    // A frame for a stream this side already forgot raced with its reset; it means nothing now.
    if (stream === undefined) return [];
    switch (frame.type) {
      case "data": {
        if (stream.remoteDone) throw new ProtocolError("Data after the stream ended.");
        if (frame.bytes.length > stream.receiveCredit) {
          throw new ProtocolError("The peer overran its credit.");
        }
        stream.receiveCredit -= frame.bytes.length;
        return [
          { type: "data", stream: stream.id, bytes: frame.bytes, credit: frame.bytes.length },
        ];
      }
      case "end":
        if (stream.remoteDone) throw new ProtocolError("The stream already ended.");
        stream.remoteDone = true;
        if (stream.localDone) this.#forget(stream.id);
        return [frame];
      case "reset":
        this.#forget(stream.id);
        return [frame];
      case "credit":
        stream.sendCredit += frame.bytes;
        if (stream.sendCredit > MAX_SEND_CREDIT) throw new ProtocolError("Credit overflow.");
        if (this.#canSend(stream)) this.#ready.add(stream.id);
        return [];
    }
  }

  #fail(reason: string): ReadonlyArray<ChannelEvent> {
    this.close(reason);
    return [{ type: "closed", reason }];
  }

  #newStream(id: number): StreamState {
    const window = this.#limits.streamWindowBytes;
    return {
      id,
      queue: [],
      queuedBytes: 0,
      sendCredit: window,
      receiveCredit: window,
      ungranted: 0,
      localEnding: false,
      localDone: false,
      remoteDone: false,
    };
  }

  /** A stream this side may still write to; none once it's gone, which only a race can cause. */
  #writable(id: number): StreamState | undefined {
    if (this.#closedReason !== undefined) return undefined;
    const stream = this.#streams.get(id);
    if (stream === undefined) return undefined;
    if (stream.localEnding) throw new Error(`Stream ${id} already ended.`);
    return stream;
  }

  #enqueue(stream: StreamState, item: Outgoing): void {
    stream.queue.push(item);
    if ("bytes" in item) stream.queuedBytes += item.bytes.length;
    if (this.#canSend(stream)) this.#ready.add(stream.id);
  }

  #canSend(stream: StreamState): boolean {
    const head = stream.queue[0];
    if (head === undefined) return false;
    return "frame" in head || stream.sendCredit > 0;
  }

  /** The next plaintext from a stream that can send. */
  #takeFrom(stream: StreamState): Uint8Array {
    const head = stream.queue[0]!;
    if ("frame" in head) {
      stream.queue.shift();
      if (head.frame === "end") stream.localDone = true;
      return head.encoded;
    }
    const room = NOISE_MAX_PLAINTEXT_BYTES - dataFrameOverhead(stream.id);
    const length = Math.min(head.bytes.length - head.offset, stream.sendCredit, room);
    const bytes = head.bytes.subarray(head.offset, head.offset + length);
    head.offset += length;
    stream.sendCredit -= length;
    stream.queuedBytes -= length;
    if (head.offset === head.bytes.length) stream.queue.shift();
    return encodeFrame({ type: "data", stream: stream.id, bytes });
  }

  /**
   * Queues a control frame. A peer that reads nothing while it keeps sending lets them pile up;
   * past the limit the channel closes, which its owner sees in `closedReason`.
   */
  #pushControl(encoded: Uint8Array): void {
    if (this.#controlBytes + encoded.length > MAX_CONTROL_BYTES) {
      this.close("The peer stopped reading.");
      return;
    }
    this.#control.push(encoded);
    this.#controlBytes += encoded.length;
  }

  #forget(id: number): void {
    this.#streams.delete(id);
    this.#ready.delete(id);
  }

  #seal(plaintext: Uint8Array): Uint8Array {
    this.#sentSinceRekey += 1;
    return this.#transport.send.encrypt(plaintext);
  }
}

/** Encodes a frame the caller built, refusing one too large for a single message. */
function encodeFitting(frame: Frame): Uint8Array {
  const encoded = encodeFrame(frame);
  if (encoded.length > NOISE_MAX_PLAINTEXT_BYTES) {
    throw new Error(`The ${frame.type} frame is too large.`);
  }
  return encoded;
}

class ProtocolError extends Error {
  readonly _tag = "ProtocolError";
}
