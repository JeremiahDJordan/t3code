/**
 * The client's end of a secure channel route: opens the outer WebSocket to the gateway with message
 * 1 in its subprotocols, finishes the handshake on the first message, and carries each local
 * connection the forwarder accepts as one stream. It connects on demand and again after the channel
 * drops, failing closed: nothing reaches the route except through a channel to the pinned key.
 *
 * @module secureChannel/connector
 */
import type { ChannelLimits, SecureChannel } from "./channel.ts";
import { initiateChannel } from "./handshake.ts";
import { ChannelLink, defaultLinkTimers, type LinkEndpoint, type LinkTimers } from "./link.ts";
import type { KeyPair, NoisePrimitives } from "./noise.ts";

/** The outer WebSocket as the connector uses it: the standard browser shape. */
export interface OuterSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

/** Opens the outer socket; each platform passes its own WebSocket, with Access headers if any. */
export type OuterSocketFactory = (
  url: string,
  protocols: ReadonlyArray<string>,
  headers: Readonly<Record<string, string>> | undefined,
) => OuterSocket;

export interface ChannelRoute {
  /** The route's origin, such as `https://quiet.example.com`, which the handshake binds. */
  readonly origin: string;
  readonly serverKey: Uint8Array;
  readonly clientKey: KeyPair;
  /** Sent in message 1 by a client that isn't paired yet. */
  readonly pairingCode?: string;
  /** Headers the outer socket carries, such as a Cloudflare Access service token. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly primitives?: NoisePrimitives;
}

/** Why a channel couldn't open. */
export class ChannelConnectError extends Error {
  readonly _tag = "ChannelConnectError";
  /** `handshake`: the gateway answered, but not as the pinned server. */
  readonly kind: "unreachable" | "handshake" | "timeout";

  constructor(kind: ChannelConnectError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A local connection riding a stream. */
export interface ForwardedConnection {
  readonly write: (bytes: Uint8Array) => void;
  readonly end: () => void;
  readonly reset: (reason: string) => void;
}

const CONNECT_TIMEOUT_MS = 15_000;
/**
 * After a failed attempt, local connections fail at once for this long, doubling per failure up
 * to the cap, so loaders retrying during an outage don't each start a handshake.
 */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Bytes a local connection may write before the channel opens; past it, its reader pauses. */
const PREOPEN_HIGH_WATER = 256 * 1024;

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

export class ChannelConnector {
  readonly #route: ChannelRoute;
  readonly #openSocket: OuterSocketFactory;
  readonly #timers: LinkTimers;
  readonly #limits: Partial<ChannelLimits> | undefined;
  #link: ChannelLink | undefined;
  #connecting: Promise<ChannelLink> | undefined;
  #closed = false;
  #failures = 0;
  /** When the next attempt may start on a local connection's behalf. */
  #retryAt = 0;
  #lastFailure: ChannelConnectError | undefined;

  constructor(options: {
    readonly route: ChannelRoute;
    readonly openSocket: OuterSocketFactory;
    readonly timers?: LinkTimers;
    readonly limits?: Partial<ChannelLimits>;
  }) {
    this.#route = options.route;
    this.#openSocket = options.openSocket;
    this.#timers = options.timers ?? defaultLinkTimers;
    this.#limits = options.limits;
  }

  /** Whether a channel is open now. */
  get open(): boolean {
    return this.#link !== undefined && !this.#link.closed;
  }

  /**
   * Opens the channel if it isn't open, failing with a `ChannelConnectError`. An explicit attempt,
   * such as the app connecting the route, doesn't wait out the backoff local connections do; after
   * the server failed the handshake, only this tries again.
   */
  connect(): Promise<void> {
    this.#retryAt = 0;
    return this.#ensureLink().then(() => undefined);
  }

  /** Carries a new local connection; bytes it writes before the channel opens wait for it. */
  attach(endpoint: LinkEndpoint): ForwardedConnection {
    let stream: number | undefined;
    let link: ChannelLink | undefined;
    let gone = false;
    let queuedBytes = 0;
    let paused = false;
    const queued: Array<(link: ChannelLink, stream: number) => void> = [];
    const whenOpen = (run: (link: ChannelLink, stream: number) => void) => {
      if (gone) return;
      if (link !== undefined && stream !== undefined) run(link, stream);
      else queued.push(run);
    };
    this.#ensureLink().then(
      (opened) => {
        if (gone) return;
        const id = opened.open(endpoint);
        if (id === undefined) return endpoint.destroy("The channel closed.");
        link = opened;
        stream = id;
        // Resumed before the queue flushes, so the link's own pause, if it needs one, stands.
        if (paused) {
          paused = false;
          endpoint.resume();
        }
        for (const run of queued.splice(0)) run(opened, id);
      },
      (cause: unknown) => {
        gone = true;
        endpoint.destroy(cause instanceof Error ? cause.message : "The channel failed.");
      },
    );
    return {
      write: (bytes) => {
        if (link === undefined && !gone) {
          queuedBytes += bytes.length;
          if (!paused && queuedBytes > PREOPEN_HIGH_WATER) {
            paused = true;
            endpoint.pause();
          }
        }
        whenOpen((open, id) => open.write(id, bytes));
      },
      end: () => whenOpen((open, id) => open.end(id)),
      reset: (reason) => {
        whenOpen((open, id) => open.reset(id, reason));
        gone = true;
      },
    };
  }

  /** Closes the channel and stops reconnecting. */
  close(): void {
    this.#closed = true;
    this.#link?.close("The route closed.");
  }

  #ensureLink(): Promise<ChannelLink> {
    if (this.#closed)
      return Promise.reject(new ChannelConnectError("unreachable", "The route closed."));
    if (this.#link !== undefined && !this.#link.closed) return Promise.resolve(this.#link);
    const lastFailure = this.#lastFailure;
    if (
      this.#connecting === undefined &&
      lastFailure !== undefined &&
      this.#timers.now() < this.#retryAt
    ) {
      return Promise.reject(lastFailure);
    }
    this.#connecting ??= this.#handshake()
      .then(
        (link) => {
          this.#failures = 0;
          this.#retryAt = 0;
          this.#lastFailure = undefined;
          return link;
        },
        (cause: ChannelConnectError) => {
          this.#failures += 1;
          this.#lastFailure = cause;
          this.#retryAt =
            cause.kind === "handshake"
              ? Number.POSITIVE_INFINITY
              : this.#timers.now() +
                Math.min(RETRY_FIRST_MS * 2 ** (this.#failures - 1), RETRY_MAX_MS);
          throw cause;
        },
      )
      .finally(() => {
        this.#connecting = undefined;
      });
    return this.#connecting;
  }

  #handshake(): Promise<ChannelLink> {
    const route = this.#route;
    const initiation = initiateChannel({
      origin: route.origin,
      serverKey: route.serverKey,
      clientKey: route.clientKey,
      ...(route.pairingCode === undefined ? {} : { pairingCode: route.pairingCode }),
      ...(route.primitives === undefined ? {} : { primitives: route.primitives }),
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
    });
    const url = new URL(initiation.path, route.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise<ChannelLink>((resolve, reject) => {
      let socket: OuterSocket;
      try {
        socket = this.#openSocket(url.href, initiation.protocols, route.headers);
      } catch (cause) {
        reject(
          new ChannelConnectError(
            "unreachable",
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
        return;
      }
      socket.binaryType = "arraybuffer";
      let link: ChannelLink | undefined;
      let settled = false;
      const timers = this.#timers;
      const timeout = timers.setTimeout(() => {
        fail(new ChannelConnectError("timeout", "The secure channel didn't answer in time."));
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      const fail = (error: ChannelConnectError) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timeout);
        reject(error);
      };
      socket.addEventListener("message", (event) => {
        const bytes = toBytes(event.data);
        if (link !== undefined) {
          if (bytes === undefined) link.close("Unexpected frame.");
          else link.receive(bytes);
          return;
        }
        if (bytes === undefined) {
          socket.close();
          return fail(
            new ChannelConnectError("handshake", "The gateway answered in an unexpected way."),
          );
        }
        let channel: SecureChannel;
        try {
          channel = initiation.finish(bytes);
        } catch {
          socket.close();
          return fail(
            new ChannelConnectError(
              "handshake",
              "The server's key doesn't match the one paired with.",
            ),
          );
        }
        settled = true;
        timers.clearTimeout(timeout);
        const opened = new ChannelLink({
          channel,
          socket: {
            send: (data) => socket.send(data),
            // React Native declares `bufferedAmount` but never sets it.
            bufferedAmount: () =>
              typeof socket.bufferedAmount === "number" ? socket.bufferedAmount : 0,
            close: () => socket.close(),
          },
          onClosed: () => {
            if (this.#link === opened) this.#link = undefined;
          },
          timers,
        });
        link = opened;
        this.#link = opened;
        resolve(opened);
      });
      const closed = () => {
        if (link !== undefined) link.close("The secure channel closed.");
        else fail(new ChannelConnectError("unreachable", "The secure channel couldn't connect."));
      };
      socket.addEventListener("close", closed);
      socket.addEventListener("error", closed);
    });
  }
}
