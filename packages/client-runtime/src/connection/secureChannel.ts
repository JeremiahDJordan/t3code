/**
 * End-to-end encrypted routes. Such a route is reached only through the server's secure channel
 * gateway: each platform runs a loopback forwarder per route, and the client uses its local origin
 * in place of the route's, so fetch, the RPC WebSocket and every native loader work unchanged
 * while Cloudflare carries only ciphertext. The route's own host gets no plain request but one: a
 * GET at the channel's path that tells a Cloudflare Access refusal from a channel that's down.
 *
 * @module connection/secureChannel
 */
import {
  ChannelConnector,
  ChannelConnectError,
  type OuterSocketFactory,
} from "@t3tools/shared/secureChannel/connector";
import {
  channelPath,
  decodeChannelKey,
  encodeChannelKey,
} from "@t3tools/shared/secureChannel/handshake";
import { keyPairFromSecretKey, type NoisePrimitives } from "@t3tools/shared/secureChannel/noise";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "./model.ts";
import {
  cloudflareAccessHeaders,
  type CloudflareAccessServiceToken,
  deniedByCloudflareAccess,
} from "./transportHeaders.ts";

export interface SecureChannelRouteRequest {
  /** The route's own origin, such as `https://quiet.example.com`. */
  readonly httpBaseUrl: string;
  /** The server key the pairing link pinned, base64url. */
  readonly serverKey: string;
  /**
   * This device's key for the route as its platform keeps it: the key itself, base64url, or on
   * desktop an id the main process turns into the key, so the renderer never holds it.
   */
  readonly clientKey: string;
  /** For a client that isn't paired yet. */
  readonly pairingCode?: string;
  /** Sent on the outer socket when the hostname sits behind Cloudflare Access. */
  readonly cloudflareAccess?: CloudflareAccessServiceToken;
}

/** Which encrypted route a forwarder serves. */
export interface SecureChannelRoute {
  readonly httpBaseUrl: string;
  readonly serverKey: string;
}

/** The forwarder's origins, which stand in for the route's. */
export interface SecureChannelLocalOrigins {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/** Why a route's channel couldn't open, as the platform reports it. */
export interface SecureChannelForwardFailure {
  /** `unanswered`: unreachable for a minute running, which a changed key or URL also looks like. */
  readonly kind:
    | "unreachable"
    | "unanswered"
    | "handshake"
    | "timeout"
    | "access-denied"
    | "unsupported";
  readonly message: string;
}

/** The platform's loopback forwarders for end-to-end encrypted routes. */
export class SecureChannelForwarder extends Context.Service<
  SecureChannelForwarder,
  {
    /** A new key for this device to use on a route, as its platform keeps it. */
    readonly createClientKey: Effect.Effect<string, ConnectionAttemptError>;
    /** Starts or reuses the route's forwarder and opens its channel. */
    readonly forward: (
      request: SecureChannelRouteRequest,
    ) => Effect.Effect<SecureChannelLocalOrigins, ConnectionAttemptError>;
    /** Stops the forwarder of a request that's done, such as a pairing. */
    readonly release: (request: SecureChannelRouteRequest) => Effect.Effect<void>;
    /**
     * Stops every forwarder except those of `routes`, the encrypted routes still saved and
     * enabled, as when one is removed, switched off or paired again. A pairing's own forwarder is
     * left to its pairing.
     */
    readonly retain: (routes: ReadonlyArray<SecureChannelRoute>) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/secureChannel/SecureChannelForwarder") {}

/** How the client runtime reports a channel that couldn't open. */
export function forwardFailureError(
  httpBaseUrl: string,
  failure: SecureChannelForwardFailure,
): ConnectionAttemptError {
  const host = new URL(httpBaseUrl).host;
  switch (failure.kind) {
    case "access-denied":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail:
          "Cloudflare Access rejected the service token. Enter a new one in the environment's settings.",
      });
    case "handshake":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: `${host} didn't answer as the server this environment was paired with. If the server's key or public URL changed, remove the environment, then pair it again.`,
      });
    case "unanswered":
      return new ConnectionTransientError({
        reason: "network",
        detail: `The encrypted channel to ${host} still isn't answering. If the server is up, its key or public URL may have changed: remove the environment, then pair it again.`,
      });
    case "unsupported":
      return new ConnectionBlockedError({ reason: "configuration", detail: failure.message });
    case "unreachable":
    case "timeout":
      return new ConnectionTransientError({
        reason: "network",
        detail: `The encrypted channel to ${host} isn't answering.`,
      });
  }
}

/** What a platform without forwarders, such as a browser, reports for an encrypted route. */
export const unsupportedError = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    detail: "End-to-end encrypted routes work in the T3 Code desktop and mobile apps.",
  });

export const layerUnsupported = Layer.succeed(
  SecureChannelForwarder,
  SecureChannelForwarder.of({
    createClientKey: Effect.fail(unsupportedError()),
    forward: () => Effect.fail(unsupportedError()),
    release: () => Effect.void,
    retain: () => Effect.void,
  }),
);

/** What a platform supplies to run forwarders in its own JavaScript. */
export interface SecureChannelPlatform {
  readonly openSocket: OuterSocketFactory;
  /** Starts a loopback listener feeding the connector, such as `startNodeForwarder`. */
  readonly startListener: (
    connector: ChannelConnector,
  ) => Promise<{ readonly origin: string; readonly close: () => Promise<void> }>;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly primitives?: NoisePrimitives;
  /** Plain fetch, for telling a Cloudflare Access refusal from a channel that's down. */
  readonly fetch: typeof globalThis.fetch;
  /** Epoch milliseconds; `Date.now` unless a test passes its own. */
  readonly now?: () => number;
}

/** Thrown by `makeSecureChannelForwarders` with what the client runtime needs to report it. */
export class SecureChannelForwardError extends Error {
  readonly _tag = "SecureChannelForwardError";
  readonly failure: SecureChannelForwardFailure;
  constructor(failure: SecureChannelForwardFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/**
 * How long a route stays unreachable before it reports itself `unanswered`: longer than a network
 * change or a laptop waking takes, so the hint to pair again isn't shown for an ordinary outage.
 */
const UNANSWERED_AFTER_MS = 60_000;
/**
 * A gap between failures longer than the client ever leaves while it keeps trying means it
 * wasn't, as when asleep, so the next failure starts a new run. The client waits up to five
 * minutes between retries, and up to 15 seconds on each other route in between.
 */
const RUN_GAP_MS = 10 * 60_000;

/**
 * The forwarders of one process, one per route and key, started on first use and kept while the
 * route is saved and enabled, so its local origin, and the asset URLs built on it, stay stable.
 */
export function makeSecureChannelForwarders(platform: SecureChannelPlatform) {
  const running = new Map<
    string,
    Promise<{
      readonly connector: ChannelConnector;
      readonly origin: string;
      readonly close: () => Promise<void>;
    }>
  >();
  const requests = new Map<string, SecureChannelRouteRequest>();
  /** Each route's current run of unreachable attempts, until it next connects. */
  const unreachableRuns = new Map<string, { readonly since: number; readonly last: number }>();
  // @effect-diagnostics-next-line globalDate:off -- Promise code that also runs in the desktop main process, outside an Effect runtime.
  const now = platform.now ?? (() => Date.now());
  const keyOf = (request: SecureChannelRouteRequest) =>
    [request.httpBaseUrl, request.serverKey, request.clientKey, request.pairingCode ?? ""].join(
      "|",
    );

  const start = (request: SecureChannelRouteRequest) => {
    const serverKey = decodeChannelKey(request.serverKey);
    const clientKey = decodeChannelKey(request.clientKey);
    if (serverKey === undefined || clientKey === undefined) {
      throw new SecureChannelForwardError({
        kind: "handshake",
        message: "The route's channel keys are malformed.",
      });
    }
    const connector = new ChannelConnector({
      route: {
        origin: new URL(request.httpBaseUrl).origin,
        serverKey,
        clientKey: keyPairFromSecretKey(clientKey),
        ...(request.pairingCode === undefined ? {} : { pairingCode: request.pairingCode }),
        ...(request.cloudflareAccess === undefined
          ? {}
          : { headers: cloudflareAccessHeaders(request.cloudflareAccess) }),
        ...(platform.primitives === undefined ? {} : { primitives: platform.primitives }),
      },
      openSocket: platform.openSocket,
    });
    return platform.startListener(connector).then((listener) => ({ connector, ...listener }));
  };

  /** A channel that won't open behind Access may be Access refusing the token, not the gateway. */
  const diagnose = async (request: SecureChannelRouteRequest, cause: ChannelConnectError) => {
    if (cause.kind !== "unreachable" || request.cloudflareAccess === undefined) return cause.kind;
    const serverKey = decodeChannelKey(request.serverKey);
    if (serverKey === undefined) return cause.kind;
    try {
      // The gateway answers no plain request, so this tells it nothing.
      const response = await platform.fetch(new URL(channelPath(serverKey), request.httpBaseUrl), {
        headers: cloudflareAccessHeaders(request.cloudflareAccess),
      });
      return deniedByCloudflareAccess(response) ? "access-denied" : cause.kind;
    } catch {
      return cause.kind;
    }
  };

  /** Stops and forgets every forwarder whose request matches. */
  const stopWhere = async (
    matches: (key: string, request: SecureChannelRouteRequest) => boolean,
  ): Promise<void> => {
    const stale = [...requests].filter(([key, request]) => matches(key, request));
    await Promise.all(
      stale.map(([key]) => {
        const entry = running.get(key);
        running.delete(key);
        requests.delete(key);
        unreachableRuns.delete(key);
        return entry?.then((started) => started.close()).catch(() => undefined);
      }),
    );
  };

  return {
    createClientKey: () => encodeChannelKey(platform.randomBytes(32)),
    forward: async (request: SecureChannelRouteRequest): Promise<SecureChannelLocalOrigins> => {
      const key = keyOf(request);
      // A route paired again keeps its address and server key under a new client key; the old
      // forwarder serves nothing now.
      if (request.pairingCode === undefined) {
        await stopWhere(
          (otherKey, other) =>
            otherKey !== key &&
            other.pairingCode === undefined &&
            other.httpBaseUrl === request.httpBaseUrl &&
            other.serverKey === request.serverKey,
        );
      }
      let entry = running.get(key);
      if (entry === undefined) {
        entry = start(request);
        running.set(key, entry);
        requests.set(key, request);
        entry.catch(() => {
          running.delete(key);
          requests.delete(key);
        });
      }
      const { connector, origin } = await entry;
      try {
        await connector.connect();
        unreachableRuns.delete(key);
      } catch (cause) {
        if (!(cause instanceof ChannelConnectError)) throw cause;
        const kind = await diagnose(request, cause);
        // The gateway drops a handshake for a key or URL it no longer has without a word, so a
        // route that stays unreachable says that may be why.
        const at = now();
        const previous = unreachableRuns.get(key);
        const run =
          kind !== "unreachable" && kind !== "timeout"
            ? undefined
            : previous === undefined || at - previous.last > RUN_GAP_MS
              ? { since: at, last: at }
              : { since: previous.since, last: at };
        if (run === undefined) unreachableRuns.delete(key);
        else unreachableRuns.set(key, run);
        const unanswered = run !== undefined && at - run.since >= UNANSWERED_AFTER_MS;
        throw new SecureChannelForwardError({
          kind: unanswered ? "unanswered" : kind,
          message: cause.message,
        });
      }
      return { httpBaseUrl: `${origin}/`, wsBaseUrl: `${origin.replace(/^http/, "ws")}/` };
    },
    release: async (request: SecureChannelRouteRequest): Promise<void> => {
      const key = keyOf(request);
      const entry = running.get(key);
      running.delete(key);
      requests.delete(key);
      unreachableRuns.delete(key);
      await entry?.then((started) => started.close()).catch(() => undefined);
    },
    retain: (routes: ReadonlyArray<SecureChannelRoute>): Promise<void> =>
      stopWhere(
        (_key, request) =>
          request.pairingCode === undefined &&
          !routes.some(
            (route) =>
              route.httpBaseUrl === request.httpBaseUrl && route.serverKey === request.serverKey,
          ),
      ),
  };
}

/** The service over forwarders this process runs itself, as the mobile app does. */
export const layerLocal = (platform: SecureChannelPlatform) =>
  Layer.sync(SecureChannelForwarder, () => {
    const forwarders = makeSecureChannelForwarders(platform);
    return SecureChannelForwarder.of({
      createClientKey: Effect.sync(forwarders.createClientKey),
      forward: (request) =>
        Effect.tryPromise({
          try: () => forwarders.forward(request),
          catch: (cause) =>
            forwardFailureError(
              request.httpBaseUrl,
              cause instanceof SecureChannelForwardError
                ? cause.failure
                : {
                    kind: "unreachable",
                    message: cause instanceof Error ? cause.message : String(cause),
                  },
            ),
        }),
      release: (request) => Effect.promise(() => forwarders.release(request)),
      retain: (routes) => Effect.promise(() => forwarders.retain(routes)),
    });
  });
