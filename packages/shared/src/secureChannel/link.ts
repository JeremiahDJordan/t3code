// @effect-diagnostics globalTimers:off globalDate:off -- Socket glue shared by Node, Electron and Hermes, outside an Effect runtime; tests pass their own timers.
/**
 * Runs a `SecureChannel` between one outer WebSocket and the local byte streams it carries: TCP
 * connections on the gateway and in the client's loopback forwarder. It pumps outgoing messages
 * while the socket has room, grants credit once a local write has been taken, pauses a local reader
 * while its stream is backed up, and keeps the tunnel alive. Platform-neutral; each side supplies
 * its socket and endpoints.
 *
 * @module secureChannel/link
 */
import type { ChannelEvent, SecureChannel } from "./channel.ts";

/** The outer WebSocket, as the link uses it. */
export interface LinkSocket {
  readonly send: (bytes: Uint8Array) => void;
  /** Bytes the socket has taken but not yet written, as WebSocket's `bufferedAmount`. */
  readonly bufferedAmount: () => number;
  readonly close: () => void;
}

/** One local byte stream, such as a TCP connection. */
export interface LinkEndpoint {
  /** Writes bytes, calling `taken` once the endpoint has room for more. */
  readonly write: (bytes: Uint8Array, taken: () => void) => void;
  /** The peer sends nothing more. */
  readonly end: () => void;
  /** The stream is gone; drop the connection. */
  readonly destroy: (reason: string) => void;
  readonly pause: () => void;
  readonly resume: () => void;
}

export interface LinkTimers {
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export const defaultLinkTimers: LinkTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as Parameters<typeof clearInterval>[0]),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  now: () => Date.now(),
};

/**
 * The outer socket stops taking messages above this many buffered bytes. Anything buffered goes
 * out ahead of a stream's next turn, so a small mark keeps RPC from queuing behind a download.
 */
const SOCKET_HIGH_WATER = 256 * 1024;
/**
 * A local reader pauses once its stream has this much queued, and resumes below half. Small, so
 * 64 streams whose peer stops reading hold about 8 MiB, without one stream's stall pausing
 * another's. That bound relies on endpoints delivering at most 64 KiB per read, as Node sockets
 * and the iOS and Android listeners do.
 */
const STREAM_HIGH_WATER = 64 * 1024;
/** Under Cloudflare's 100-second idle timeout. */
const KEEPALIVE_MS = 25_000;
/** A channel that hears nothing for this long, pings included, is dead. */
const IDLE_MS = 70_000;
/** How soon to retry sending while the outer socket is full; it has no drain event everywhere. */
const BACKLOG_RETRY_MS = 10;

export class ChannelLink {
  readonly #channel: SecureChannel;
  readonly #socket: LinkSocket;
  readonly #timers: LinkTimers;
  readonly #onOpen: ((stream: number) => LinkEndpoint | undefined) | undefined;
  readonly #onClosed: (reason: string) => void;
  readonly #endpoints = new Map<number, LinkEndpoint>();
  readonly #paused = new Set<number>();
  /** Streams with one half ended, and which half. */
  readonly #halfEnded = new Map<number, "local" | "remote">();
  readonly #keepalive: unknown;
  #backlogRetry: unknown;
  #lastHeardAt: number;
  #closed = false;

  constructor(options: {
    readonly channel: SecureChannel;
    readonly socket: LinkSocket;
    /** The server's half: connects a stream the client opened, or refuses it with none. */
    readonly onOpen?: (stream: number) => LinkEndpoint | undefined;
    readonly onClosed: (reason: string) => void;
    readonly timers?: LinkTimers;
  }) {
    this.#channel = options.channel;
    this.#socket = options.socket;
    this.#timers = options.timers ?? defaultLinkTimers;
    this.#onOpen = options.onOpen;
    this.#onClosed = options.onClosed;
    this.#lastHeardAt = this.#timers.now();
    this.#keepalive = this.#timers.setInterval(() => this.#tick(), KEEPALIVE_MS);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Streams with a live endpoint. */
  get streams(): number {
    return this.#endpoints.size;
  }

  /** The client's half: opens a stream for a new local connection. */
  open(endpoint: LinkEndpoint): number | undefined {
    if (this.#closed) return undefined;
    const stream = this.#channel.open();
    this.#endpoints.set(stream, endpoint);
    this.#pump();
    return stream;
  }

  /** Bytes read from a local endpoint. */
  write(stream: number, bytes: Uint8Array): void {
    // Nothing follows a local end; an endpoint that writes anyway is ignored, not obeyed.
    if (this.#closed || !this.#endpoints.has(stream) || this.#halfEnded.get(stream) === "local") {
      return;
    }
    this.#channel.write(stream, bytes);
    if (this.#channel.queuedBytes(stream) >= STREAM_HIGH_WATER && !this.#paused.has(stream)) {
      this.#paused.add(stream);
      this.#endpoints.get(stream)?.pause();
    }
    this.#pump();
  }

  /** The local endpoint sends nothing more. */
  end(stream: number): void {
    if (this.#closed || !this.#endpoints.has(stream) || this.#halfEnded.get(stream) === "local") {
      return;
    }
    this.#channel.end(stream);
    this.#endHalf(stream, "local");
    this.#pump();
  }

  /** The local endpoint failed or went away. */
  reset(stream: number, reason: string): void {
    if (!this.#forget(stream)) return;
    this.#channel.reset(stream, reason);
    this.#pump();
  }

  /** One message from the outer socket. */
  receive(message: Uint8Array): void {
    if (this.#closed) return;
    this.#lastHeardAt = this.#timers.now();
    for (const event of this.#channel.receive(message)) this.#handle(event);
    this.#pump();
  }

  /** Tears the link down: the outer socket closed, or its owner is done with it. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#timers.clearInterval(this.#keepalive);
    if (this.#backlogRetry !== undefined) this.#timers.clearTimeout(this.#backlogRetry);
    this.#channel.close(reason);
    for (const endpoint of this.#endpoints.values()) endpoint.destroy(reason);
    this.#endpoints.clear();
    this.#socket.close();
    this.#onClosed(reason);
  }

  #handle(event: ChannelEvent): void {
    switch (event.type) {
      case "open": {
        const endpoint = this.#onOpen?.(event.stream);
        if (endpoint === undefined) this.#channel.reset(event.stream, "Refused.");
        else this.#endpoints.set(event.stream, endpoint);
        return;
      }
      case "data": {
        const endpoint = this.#endpoints.get(event.stream);
        if (endpoint === undefined) return;
        endpoint.write(event.bytes, () => {
          this.#channel.grant(event.stream, event.credit);
          this.#pump();
        });
        return;
      }
      case "end":
        this.#endpoints.get(event.stream)?.end();
        this.#endHalf(event.stream, "remote");
        return;
      case "reset": {
        const endpoint = this.#endpoints.get(event.stream);
        this.#forget(event.stream);
        endpoint?.destroy(event.reason);
        return;
      }
      case "pong":
        return;
      case "closed":
        this.close(event.reason);
        return;
    }
  }

  /** Forgets a stream once both halves have ended; the channel forgets it the same way. */
  #endHalf(stream: number, half: "local" | "remote"): void {
    const other = this.#halfEnded.get(stream);
    if (other !== undefined && other !== half) this.#forget(stream);
    else this.#halfEnded.set(stream, half);
  }

  #forget(stream: number): boolean {
    this.#paused.delete(stream);
    this.#halfEnded.delete(stream);
    return this.#endpoints.delete(stream);
  }

  #pump(): void {
    if (this.#closed) return;
    const failed = this.#channel.closedReason;
    if (failed !== undefined) return this.close(failed);
    while (this.#socket.bufferedAmount() < SOCKET_HIGH_WATER) {
      const message = this.#channel.takeOutgoing();
      if (message === undefined) break;
      this.#socket.send(message);
    }
    for (const stream of this.#paused) {
      if (this.#channel.queuedBytes(stream) > STREAM_HIGH_WATER / 2) continue;
      this.#paused.delete(stream);
      this.#endpoints.get(stream)?.resume();
    }
    if (this.#socket.bufferedAmount() >= SOCKET_HIGH_WATER && this.#backlogRetry === undefined) {
      this.#backlogRetry = this.#timers.setTimeout(() => {
        this.#backlogRetry = undefined;
        this.#pump();
      }, BACKLOG_RETRY_MS);
    }
  }

  #tick(): void {
    if (this.#timers.now() - this.#lastHeardAt > IDLE_MS) {
      this.close("The channel went quiet.");
      return;
    }
    this.#channel.ping(new Uint8Array(0));
    this.#pump();
  }
}
