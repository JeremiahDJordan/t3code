// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The gateway owns raw sockets: a loopback listener that answers nothing it doesn't accept, and TCP connections into the server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import { ChannelLink, type LinkEndpoint } from "@t3tools/shared/secureChannel/link";
import {
  acceptChannel,
  CHANNEL_PROTOCOL,
  messageFromProtocols,
  channelPath,
  encodeChannelKey,
  parseChannelOrigin,
} from "@t3tools/shared/secureChannel/handshake";
import type { KeyPair } from "@t3tools/shared/secureChannel/noise";
import type { SecureChannelSettings } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { WebSocketServer } from "ws";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecureChannelClients from "./SecureChannelClients.ts";
import * as SecureChannelConnections from "./SecureChannelConnections.ts";
import * as SecureChannelKey from "./SecureChannelKey.ts";

/** How a client was admitted, and until when, before the gateway asks again. */
export interface GatewayAdmission {
  /** Epoch milliseconds: the key's last session expiry, or the pairing code's. */
  readonly until: number;
  /** Admitted only on its pairing code, not as a paired key. */
  readonly byCode: boolean;
}

/** Whether a client may hold a channel: a paired key, or one carrying a live pairing code. */
export type GatewayAdmit = (input: {
  readonly clientKey: string;
  readonly pairingCode: string | undefined;
}) => Promise<GatewayAdmission | undefined>;

export interface SecureChannelGatewayOptions {
  readonly port: number;
  readonly serverKey: KeyPair;
  /**
   * The public origin clients connect to, which every handshake binds. Never taken from a
   * request's `Host`, which whoever sends the request chooses.
   */
  readonly origin: string;
  /** Where the server's own listener is. */
  readonly target: { readonly host: string; readonly port: number };
  readonly admit: GatewayAdmit;
  /** Records each upstream connection's local address, so the server can tell it came from here. */
  readonly onUpstreamConnected: (
    local: { readonly address: string; readonly port: number },
    clientKey: string,
  ) => void;
  readonly onUpstreamClosed: (localPort: number) => void;
  readonly now?: () => number;
  readonly limits?: Partial<GatewayLimits>;
}

/**
 * Handshake attempts at the channel's path, which cost the server 0.6 to 2.5 ms each. Every
 * address is limited on its own. An address where a paired device completed a handshake in the
 * last day is known and skips the rest, so a flood from strangers usually doesn't shed the user's
 * devices on addresses they used lately. Each key keeps at most a few known addresses, and loses
 * them when revoked in this process, refused at a handshake or re-check, or at a restart, and
 * each a day after it last connected there. Strangers, new pairings among them, are also limited
 * per network, and together under a cap that keeps a flood across many networks off the server's
 * thread; past it they are turned away until it passes.
 */
export interface GatewayLimits {
  /** Per minute from one address: an IPv4 address or an IPv6 /64. */
  readonly attemptsPerMinute: number;
  /** Per minute from one network of strangers: an IPv4 /24 or an IPv6 /48. */
  readonly networkAttemptsPerMinute: number;
  /** Per minute from all strangers together, about a sixth of a core at 2.5 ms each. */
  readonly strangerAttemptsPerMinute: number;
  /**
   * Addresses and networks counted; the least recently seen is forgotten first. At least twice
   * the stranger cap plus `knownKeys`, the keys a minute can add, or a flood could push a spent
   * key out of the table.
   */
  readonly trackedKeys: number;
  /** Known addresses remembered; the least recently connected is forgotten first. */
  readonly knownKeys: number;
  /**
   * Known addresses one key keeps, its least recently used forgotten first, so a key, a stolen
   * one included, can neither make many addresses known nor push out other keys' devices.
   */
  readonly knownKeysPerClient: number;
}

const DEFAULT_LIMITS: GatewayLimits = {
  attemptsPerMinute: 30,
  networkAttemptsPerMinute: 300,
  strangerAttemptsPerMinute: 4000,
  trackedKeys: 10_000,
  knownKeys: 1000,
  knownKeysPerClient: 16,
};

/** How long an address that completed a handshake stays known. */
const KNOWN_FOR_MS = 24 * 60 * 60_000;

export interface SecureChannelGateway {
  readonly port: number;
  /** Closes every channel of a client key, as when its last session is revoked. */
  readonly closeClient: (clientKey: string) => void;
  /** Asks again about every channel admitted on a pairing code, as when a code is used up. */
  readonly recheckPairings: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Channels one client key may hold; a new one closes its oldest. */
const CHANNELS_PER_CLIENT = 4;
/** Channels one pairing code may admit at once: the device pairing, and a retry. */
const CHANNELS_PER_CODE = 2;
/** The longest a channel goes before its admission is asked about again. */
const RECHECK_MAX_MS = 60 * 60_000;
/** The soonest, so an admission that has already run out can't make the check spin. */
const RECHECK_MIN_MS = 1000;

/** How long until a channel admitted until `until` is asked about again. */
export function recheckDelay(until: number, now: number): number {
  return Math.min(Math.max(until - now, RECHECK_MIN_MS), RECHECK_MAX_MS);
}
/** How long a seen message 1 stays refused, beyond its 5-minute clock skew window. */
const REPLAY_WINDOW_MS = 11 * 60_000;
/** One Noise message; a WebSocket message is never more. */
const MAX_FRAME_BYTES = 65_535;
const WEBSOCKET_KEY = /^[+/0-9A-Za-z]{22}==$/;

/** Writes nothing and closes, so a refusal looks exactly like an origin that isn't there. */
function drop(socket: NodeStream.Duplex): void {
  socket.destroy();
}

function headerValue(value: string | ReadonlyArray<string> | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The limiter's key for an address: an IPv6 host usually holds a whole /64, so that's one. */
export function limiterKeys(address: string): {
  readonly address: string;
  readonly network: string;
} {
  const plain = (address.startsWith("::ffff:") ? address.slice(7) : address).split("%")[0]!;
  if (!plain.includes(":")) {
    return { address: plain, network: `${plain.split(".").slice(0, 3).join(".")}.0/24` };
  }
  const [head = "", tail = ""] = plain.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = (
    plain.includes("::")
      ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right]
      : left
  ).map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
  return {
    address: `${groups.slice(0, 4).join(":")}::/64`,
    network: `${groups.slice(0, 3).join(":")}::/48`,
  };
}

/** How many of `times` fall in the minute up to `at`, dropping the older ones. */
function recentCount(times: number[] | undefined, at: number): number {
  if (times === undefined) return 0;
  const cutoff = at - 60_000;
  while (times.length > 0 && times[0]! <= cutoff) times.shift();
  return times.length;
}

interface TrackedChannel {
  readonly link: ChannelLink;
  readonly clientKey: string;
  readonly pairingCode: string | undefined;
  byCode: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Starts the gateway on loopback. It answers only a WebSocket upgrade at the channel's path whose
 * message 1 checks out and whose client is admitted; anything else is dropped without a byte, so
 * through a tunnel the hostname looks like nothing is running. Each stream a client opens becomes a
 * TCP connection into the server.
 */
export async function startSecureChannelGateway(
  options: SecureChannelGatewayOptions,
): Promise<SecureChannelGateway> {
  const now = options.now ?? Date.now;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const path = channelPath(options.serverKey.publicKey);
  const attemptsByAddress = new Map<string, number[]>();
  const seenMessages = new Map<string, number>();
  const channelsByClient = new Map<string, TrackedChannel[]>();
  /** Channels admitted on each pairing code, open or still upgrading. */
  const channelsByCode = new Map<string, number>();
  /** Bumped when a key is revoked, so an admission that raced the revocation is dropped. */
  const revocations = new Map<string, number>();
  let closing = false;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: () => CHANNEL_PROTOCOL,
  });
  // Without a listener, `ws` answers a handshake it rejects with a 400 of its own.
  wss.on("wsClientError", (_error: Error, socket: NodeStream.Duplex) => drop(socket));

  // Behind cloudflared the header is Cloudflare's own, overwriting anything a client sent. The
  // gateway listens only on loopback, so another local process could set it, but such a process
  // could reach the server directly anyway.
  /** Records an attempt for a key, most recently used last, forgetting the oldest keys. */
  const record = (key: string, at: number): void => {
    const times = attemptsByAddress.get(key) ?? [];
    attemptsByAddress.delete(key);
    times.push(at);
    attemptsByAddress.set(key, times);
    for (const oldest of attemptsByAddress.keys()) {
      if (attemptsByAddress.size <= limits.trackedKeys) break;
      attemptsByAddress.delete(oldest);
    }
  };
  /**
   * Known addresses, least recently connected first, with when each key last connected from
   * each, so one device leaving an address, being revoked or going quiet for a day leaves it
   * known only for the others there.
   */
  const known = new Map<string, Map<string, number>>();
  /** Each key's known addresses, least recently used first. */
  const knownByKey = new Map<string, string[]>();
  const strangerAttempts: number[] = [];
  const unlist = (clientKey: string, address: string): void => {
    const rest = (knownByKey.get(clientKey) ?? []).filter((other) => other !== address);
    if (rest.length === 0) knownByKey.delete(clientKey);
    else knownByKey.set(clientKey, rest);
  };
  /** Drops one key from an address, and the address once no key is left. */
  const dropKey = (address: string, clientKey: string): void => {
    const keys = known.get(address);
    keys?.delete(clientKey);
    if (keys !== undefined && keys.size === 0) known.delete(address);
  };
  const forgetAddress = (address: string): void => {
    const keys = known.get(address);
    known.delete(address);
    for (const clientKey of keys?.keys() ?? []) unlist(clientKey, address);
  };
  /** Whether a key connected from the address within the day; keys past it are let go. */
  const isKnown = (address: string, at: number): boolean => {
    const keys = known.get(address);
    if (keys === undefined) return false;
    for (const [clientKey, since] of keys) {
      if (at - since <= KNOWN_FOR_MS) continue;
      keys.delete(clientKey);
      unlist(clientKey, address);
    }
    if (keys.size > 0) return true;
    known.delete(address);
    return false;
  };
  const rememberKnown = (address: string, clientKey: string): void => {
    const keys = known.get(address) ?? new Map<string, number>();
    known.delete(address);
    keys.set(clientKey, now());
    known.set(address, keys);
    const own = (knownByKey.get(clientKey) ?? []).filter((other) => other !== address);
    own.push(address);
    while (own.length > limits.knownKeysPerClient) dropKey(own.shift()!, clientKey);
    knownByKey.set(clientKey, own);
    for (const oldest of known.keys()) {
      if (known.size <= limits.knownKeys) break;
      forgetAddress(oldest);
    }
  };
  /** Forgets a key on every address it made known, once it's no longer admitted. */
  const forgetKnown = (clientKey: string): void => {
    for (const address of knownByKey.get(clientKey) ?? []) dropKey(address, clientKey);
    knownByKey.delete(clientKey);
  };
  // A refused attempt counts against nothing and adds no key, so neither a spent address can
  // spend its network's budget nor a flood of refused ones push other keys out of the table.
  const limited = (keys: ReturnType<typeof limiterKeys>): boolean => {
    const at = now();
    if (recentCount(attemptsByAddress.get(keys.address), at) >= limits.attemptsPerMinute) {
      return true;
    }
    const stranger = !isKnown(keys.address, at);
    if (
      stranger &&
      (recentCount(attemptsByAddress.get(keys.network), at) >= limits.networkAttemptsPerMinute ||
        recentCount(strangerAttempts, at) >= limits.strangerAttemptsPerMinute)
    ) {
      return true;
    }
    record(keys.address, at);
    if (stranger) {
      record(keys.network, at);
      strangerAttempts.push(at);
    }
    return false;
  };

  const replayed = (messageId: string): boolean => {
    const at = now();
    for (const [id, seenAt] of seenMessages) {
      if (at - seenAt > REPLAY_WINDOW_MS) seenMessages.delete(id);
      else break;
    }
    if (seenMessages.has(messageId)) return true;
    seenMessages.set(messageId, at);
    return false;
  };

  const releaseCode = (code: string) => {
    const count = (channelsByCode.get(code) ?? 1) - 1;
    if (count <= 0) channelsByCode.delete(code);
    else channelsByCode.set(code, count);
  };

  const connectUpstream = (
    link: () => ChannelLink,
    stream: number,
    clientKey: string,
  ): LinkEndpoint => {
    const socket = NodeNet.connect({
      host: options.target.host,
      port: options.target.port,
      allowHalfOpen: true,
    });
    socket.setNoDelay(true);
    let localPort: number | undefined;
    // A clean close follows both halves ending; anything else abandons the stream.
    let serverEnded = false;
    let clientEnded = false;
    const pending: Array<() => void> = [];
    socket.once("connect", () => {
      // Recorded before the first byte is written, so the server never reads an unmarked request.
      localPort = socket.localPort;
      if (socket.localAddress !== undefined && localPort !== undefined) {
        options.onUpstreamConnected({ address: socket.localAddress, port: localPort }, clientKey);
      }
      for (const write of pending.splice(0)) write();
    });
    socket.on("data", (chunk: Buffer) => link().write(stream, new Uint8Array(chunk)));
    socket.on("end", () => {
      serverEnded = true;
      link().end(stream);
    });
    socket.on("error", () => undefined);
    socket.on("close", (hadError: boolean) => {
      if (localPort !== undefined) options.onUpstreamClosed(localPort);
      if (hadError || !serverEnded || !clientEnded) {
        link().reset(stream, "The server closed the connection.");
      }
    });
    const whenConnected = (write: () => void) => {
      if (localPort === undefined) pending.push(write);
      else write();
    };
    return {
      write: (bytes, taken) => whenConnected(() => socket.write(bytes, () => taken())),
      end: () =>
        whenConnected(() => {
          clientEnded = true;
          socket.end();
        }),
      destroy: () => socket.destroy(),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    };
  };

  const untrack = (tracked: TrackedChannel) => {
    if (tracked.timer !== undefined) clearTimeout(tracked.timer);
    if (tracked.byCode && tracked.pairingCode !== undefined) releaseCode(tracked.pairingCode);
    tracked.byCode = false;
    const links =
      channelsByClient.get(tracked.clientKey)?.filter((candidate) => candidate !== tracked) ?? [];
    if (links.length === 0) channelsByClient.delete(tracked.clientKey);
    else channelsByClient.set(tracked.clientKey, links);
  };

  /** Asks whether a channel's client is still admitted, closing it if not and asking again later if so. */
  const recheck = async (tracked: TrackedChannel): Promise<void> => {
    if (tracked.link.closed) return;
    let admission: GatewayAdmission | undefined;
    try {
      admission = await options.admit({
        clientKey: tracked.clientKey,
        pairingCode: tracked.pairingCode,
      });
      // Only a definite refusal forgets the key; a failed lookup just closes, failing closed.
      if (admission === undefined) forgetKnown(tracked.clientKey);
    } catch {
      admission = undefined;
    }
    if (admission === undefined) return tracked.link.close("The client is no longer admitted.");
    if (tracked.byCode && !admission.byCode) {
      if (tracked.pairingCode !== undefined) releaseCode(tracked.pairingCode);
      tracked.byCode = false;
    }
    schedule(tracked, admission.until);
  };

  const schedule = (tracked: TrackedChannel, until: number) => {
    if (tracked.timer !== undefined) clearTimeout(tracked.timer);
    if (tracked.link.closed) return;
    tracked.timer = setTimeout(() => void recheck(tracked), recheckDelay(until, now()));
  };

  const handleUpgrade = async (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ): Promise<void> => {
    socket.on("error", () => undefined);
    if (
      closing ||
      request.method !== "GET" ||
      request.url !== path ||
      headerValue(request.headers.upgrade)?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13" ||
      !WEBSOCKET_KEY.test(headerValue(request.headers["sec-websocket-key"]) ?? "")
    ) {
      return drop(socket);
    }
    // Counted only at the path a pairing link gives, and only for a request that could carry
    // message 1, so neither a scanner nor junk spends anyone's limit.
    const address =
      headerValue(request.headers["cf-connecting-ip"]) ?? request.socket.remoteAddress ?? "";
    const protocols = headerValue(request.headers["sec-websocket-protocol"]);
    const limiter = limiterKeys(address);
    if (messageFromProtocols(protocols) === undefined || limited(limiter)) return drop(socket);
    const acceptance = acceptChannel({
      origin: options.origin,
      serverKey: options.serverKey,
      protocols,
      now,
    });
    if (acceptance === undefined) return drop(socket);
    // The ephemeral key opens message 1, so it names this exact message.
    const messageId = protocols
      ?.split(",")
      .find((value) => value.trim() !== CHANNEL_PROTOCOL)
      ?.trim()
      .slice(0, 43);
    if (messageId === undefined || replayed(messageId)) return drop(socket);
    const clientKey = encodeChannelKey(acceptance.clientKey);
    const revokedBefore = revocations.get(clientKey) ?? 0;
    let admission: GatewayAdmission | undefined;
    try {
      admission = await options.admit({ clientKey, pairingCode: acceptance.pairingCode });
      // A key refused, as one revoked from another process is, loses its addresses; a failed
      // lookup doesn't count as a refusal.
      if (admission === undefined) forgetKnown(clientKey);
    } catch {
      admission = undefined;
    }
    if (
      admission === undefined ||
      closing ||
      socket.destroyed ||
      (revocations.get(clientKey) ?? 0) !== revokedBefore
    ) {
      return drop(socket);
    }
    const pairingCode = acceptance.pairingCode;
    const byCode = admission.byCode && pairingCode !== undefined;
    if (byCode) {
      if ((channelsByCode.get(pairingCode) ?? 0) >= CHANNELS_PER_CODE) return drop(socket);
      channelsByCode.set(pairingCode, (channelsByCode.get(pairingCode) ?? 0) + 1);
    }
    const until = admission.until;
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded && byCode) releaseCode(pairingCode);
    });

    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      // Only a paired device makes its address known; a pairing code, which a handshake doesn't
      // use up, could otherwise make a thousand addresses known to skip the limits.
      if (!byCode) rememberKnown(limiter.address, clientKey);
      const { message, channel } = acceptance.accept();
      ws.send(message);
      const tracked: TrackedChannel = {
        clientKey,
        pairingCode,
        byCode,
        timer: undefined,
        link: new ChannelLink({
          channel,
          socket: {
            send: (bytes) => ws.send(bytes),
            bufferedAmount: () => ws.bufferedAmount,
            close: () => ws.terminate(),
          },
          onOpen: (stream) => connectUpstream(() => tracked.link, stream, clientKey),
          onClosed: () => untrack(tracked),
        }),
      };
      const links = channelsByClient.get(clientKey) ?? [];
      links.push(tracked);
      channelsByClient.set(clientKey, links);
      // A client that reconnects after a network change shouldn't wait for its old channel to time out.
      while (links.length > CHANNELS_PER_CLIENT) {
        links.shift()?.link.close("Replaced by a newer channel.");
      }
      schedule(tracked, until);
      ws.on("message", (data, isBinary) => {
        if (!isBinary || !(data instanceof Buffer)) return tracked.link.close("Unexpected frame.");
        tracked.link.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      ws.on("close", () => tracked.link.close("The socket closed."));
      ws.on("error", () => tracked.link.close("The socket failed."));
    });
  };

  // Node answers a request without `Host` with its own 400 unless told not to.
  const server = NodeHttp.createServer({ requireHostHeader: false });
  server.on("request", (request: NodeHttp.IncomingMessage) => drop(request.socket));
  // Without these listeners Node answers `Expect: 100-continue` on its own.
  server.on("checkContinue", (request: NodeHttp.IncomingMessage) => drop(request.socket));
  server.on("checkExpectation", (request: NodeHttp.IncomingMessage) => drop(request.socket));
  server.on("clientError", (_error: Error, socket: NodeStream.Duplex) => drop(socket));
  server.on(
    "upgrade",
    (request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) => {
      void handleUpgrade(request, socket, head);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;

  return {
    port,
    closeClient: (clientKey) => {
      revocations.set(clientKey, (revocations.get(clientKey) ?? 0) + 1);
      forgetKnown(clientKey);
      for (const tracked of channelsByClient.get(clientKey) ?? []) {
        tracked.link.close("The client was revoked.");
      }
    },
    recheckPairings: async () => {
      const byCode = [...channelsByClient.values()].flat().filter((tracked) => tracked.byCode);
      await Promise.all(byCode.map(recheck));
    },
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        for (const links of channelsByClient.values()) {
          for (const tracked of links) tracked.link.close("The gateway stopped.");
        }
        server.close(() => resolve());
        server.closeAllConnections();
        wss.close();
      }),
  };
}

/** How long after a code is used up its channels are checked, so its own device's key is bound. */
const PAIRING_RECHECK_DELAY = "5 seconds";

class GatewayStartError extends Data.TaggedError("GatewayStartError")<{
  readonly cause: unknown;
}> {}

/** Where to reach the server's own listener from the gateway, beside it on this machine. */
export function upstreamHost(configuredHost: string | undefined): string {
  if (configuredHost === undefined || configuredHost === "0.0.0.0" || configuredHost === "::") {
    return "127.0.0.1";
  }
  return configuredHost.replace(/^\[(.*)\]$/, "$1");
}

/**
 * The channel's public key for the authenticated server config, so Settings can build encrypted
 * pairing links the moment the tunnel is turned on. Reading it creates the key on first use.
 */
export const secureChannelServerKeyForConfig = (
  key: Option.Option<SecureChannelKey.SecureChannelKey["Service"]>,
) =>
  Option.isNone(key)
    ? Effect.succeed({})
    : key.value.keyPair.pipe(
        Effect.map((keyPair) => ({ secureChannelServerKey: encodeChannelKey(keyPair.publicKey) })),
        Effect.orElseSucceed(() => ({})),
      );

/**
 * The gateway's admission from the stores: a paired key until its last session runs out, or a
 * live pairing code until it does. A failed lookup is logged and fails rather than refusing, so
 * the gateway closes the channel without forgetting the device's known addresses. Untraced, since
 * strangers reach it too and the query records its own span.
 */
export const admission = Effect.fnUntraced(
  function* (input: { readonly clientKey: string; readonly pairingCode: string | undefined }) {
    const clients = yield* SecureChannelClients.SecureChannelClients;
    const pairing = yield* PairingGrantStore.PairingGrantStore;
    const paired = yield* clients.pairedUntil(input.clientKey);
    if (Option.isSome(paired))
      return { until: DateTime.toEpochMillis(paired.value), byCode: false };
    if (input.pairingCode === undefined) return undefined;
    const live = yield* pairing.liveUntil(input.pairingCode);
    return Option.isSome(live)
      ? { until: DateTime.toEpochMillis(live.value), byCode: true }
      : undefined;
  },
  Effect.tapError((cause) =>
    Effect.logWarning("Secure channel admission lookup failed", { cause }),
  ),
);

/**
 * Runs the gateway while the server runs: on `--secure-channel-port` for the whole run when given,
 * otherwise as the `secureChannel` server setting says, starting, moving or stopping it live.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverKeys = yield* SecureChannelKey.SecureChannelKey;
    const clients = yield* SecureChannelClients.SecureChannelClients;
    const pairing = yield* PairingGrantStore.PairingGrantStore;
    const sessions = yield* SessionStore.SessionStore;
    const connections = yield* SecureChannelConnections.SecureChannelConnections;
    const settings = yield* ServerSettings.ServerSettingsService;
    const address = (yield* HttpServer.HttpServer).address;
    if (!("port" in address)) return;
    const runPromise = Effect.runPromiseWith(
      yield* Effect.context<
        SecureChannelClients.SecureChannelClients | PairingGrantStore.PairingGrantStore
      >(),
    );
    const admit: GatewayAdmit = (input) => runPromise(admission(input));

    let running: { readonly key: string; readonly gateway: SecureChannelGateway } | undefined;
    const stop = Effect.promise(async () => {
      const current = running;
      running = undefined;
      await current?.gateway.close();
    });
    const apply = (wanted: { readonly port: number; readonly origin: string } | undefined) =>
      Effect.gen(function* () {
        const key = wanted === undefined ? "" : `${wanted.port}|${wanted.origin}`;
        if ((running?.key ?? "") === key) return;
        yield* stop;
        if (wanted === undefined) return yield* Effect.logInfo("Secure channel gateway stopped");
        const serverKey = yield* serverKeys.keyPair;
        const gateway = yield* Effect.tryPromise({
          try: () =>
            startSecureChannelGateway({
              port: wanted.port,
              serverKey,
              origin: wanted.origin,
              target: { host: upstreamHost(config.host), port: address.port },
              admit,
              onUpstreamConnected: connections.register,
              onUpstreamClosed: connections.unregister,
            }),
          catch: (cause) => new GatewayStartError({ cause }),
        });
        running = { key, gateway };
        yield* Effect.logInfo("Secure channel gateway listening", { port: gateway.port });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("The secure channel gateway failed to start", {
            port: wanted?.port,
            cause,
          }),
        ),
      );
    yield* Effect.addFinalizer(() => stop);

    if (config.secureChannelPort !== undefined) {
      const origin =
        config.secureChannelOrigin === undefined
          ? null
          : parseChannelOrigin(config.secureChannelOrigin);
      if (origin === null) {
        yield* Effect.logError(
          "The secure channel gateway needs --secure-channel-origin, the tunnel's public http(s) URL such as https://quiet.example.com, beside --secure-channel-port; it isn't running.",
          { origin: config.secureChannelOrigin },
        );
      } else {
        yield* apply({ port: config.secureChannelPort, origin });
      }
    } else {
      // Off until the public URL is set too: every handshake binds it.
      const fromSettings = (secure: SecureChannelSettings) => {
        const origin = parseChannelOrigin(secure.publicOrigin);
        return secure.enabled && origin !== null ? { port: secure.port, origin } : undefined;
      };
      const changes = yield* settings.subscribeChanges;
      yield* settings.getSettings.pipe(
        Effect.flatMap((current) => apply(fromSettings(current.secureChannel))),
        Effect.catch(() => Effect.void),
      );
      yield* changes.pipe(
        Stream.runForEach((current) => apply(fromSettings(current.secureChannel))),
        Effect.forkScoped,
      );
    }

    // Revoking a client's last session closes its channels at once, not at its next request.
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type !== "clientRemoved"
          ? Effect.void
          : clients.clientKeyOfSession(change.sessionId).pipe(
              Effect.flatMap((clientKey) =>
                Option.isNone(clientKey)
                  ? Effect.void
                  : clients
                      .pairedUntil(clientKey.value)
                      .pipe(
                        Effect.flatMap((paired) =>
                          Option.isSome(paired)
                            ? Effect.void
                            : Effect.sync(() => running?.gateway.closeClient(clientKey.value)),
                        ),
                      ),
              ),
              Effect.catch(() => Effect.void),
            ),
      ),
      Effect.forkScoped,
    );

    // A used-up code closes the channels it admitted, except the one whose device it paired. The
    // token exchange binds that device's key just after consuming the code, so the check waits a
    // moment for it.
    yield* pairing.streamChanges.pipe(
      Stream.filter((change) => change.type === "pairingLinkRemoved"),
      Stream.runForEach(() =>
        Effect.sleep(PAIRING_RECHECK_DELAY).pipe(
          Effect.andThen(
            Effect.promise(() => running?.gateway.recheckPairings() ?? Promise.resolve()),
          ),
          Effect.forkScoped,
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
