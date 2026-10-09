/**
 * Opening a secure channel over one WebSocket. The client derives the channel's path from the
 * server key it got at pairing, and offers message 1 as a second `Sec-WebSocket-Protocol` value
 * beside `t3c.2`, since browsers, React Native and Node can all set subprotocols but not other
 * headers. The server answers the upgrade only if message 1 checks out, and sends message 2 as
 * the first WebSocket message. Message 1's encrypted payload, the client hello, carries when it
 * was written and, for a client that isn't paired yet, its pairing code.
 *
 * @module secureChannel/handshake
 */
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes } from "@noble/hashes/utils";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { type ChannelLimits, SecureChannel } from "./channel.ts";
import { decodeUtf8, encodeUtf8 } from "./frames.ts";
import { acceptHandshake, initiateHandshake, type KeyPair, type NoisePrimitives } from "./noise.ts";

/**
 * The subprotocol the server selects; the other value the client offers is message 1. It names
 * the wire format, so a change to the frames bumps it: `t3c.1` data frames carried a flags byte.
 */
export const CHANNEL_PROTOCOL = "t3c.2";
/** How far a client hello's clock may stray from the server's. */
export const CLIENT_HELLO_MAX_SKEW_MS = 5 * 60_000;

const PROLOGUE_PREFIX = "t3-channel/1";
const PATH_LABEL = "t3-channel-path";
const PATH_LENGTH = 22;
const KEY_BYTES = 32;

/** A channel key as it appears in a pairing link: 32 bytes, base64url without padding. */
export function encodeChannelKey(key: Uint8Array): string {
  return Base64Url.encode(key);
}

export function decodeChannelKey(value: string): Uint8Array | undefined {
  const decoded = Base64Url.decode(value);
  return Result.isSuccess(decoded) && decoded.success.length === KEY_BYTES
    ? decoded.success
    : undefined;
}

/**
 * How people compare a channel key, the root of trust a pairing pins: the first 128 bits of its
 * SHA-256 in eight groups, `1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d`.
 */
export function channelKeyFingerprint(key: Uint8Array): string {
  const digest = sha256(key);
  return Array.from({ length: 8 }, (_, group) =>
    Array.from(digest.subarray(group * 2, group * 2 + 2), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  ).join(" ");
}

/**
 * The channel's unguessable path, derived from the server key so a pairing link needs no field for
 * it and rotating the key moves it.
 */
export function channelPath(serverKey: Uint8Array): string {
  return `/${Base64Url.encode(sha256(concatBytes(encodeUtf8(PATH_LABEL), serverKey))).slice(0, PATH_LENGTH)}`;
}

/** Binds the handshake to the hostname, so message 1 can't be replayed against another one. */
/**
 * The tunnel's public origin from what someone typed, such as `https://quiet.example.com/x`, or
 * null when it isn't an http(s) URL. Every handshake binds it, so a bad one drops them all.
 */
export function parseChannelOrigin(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function channelPrologue(origin: string): Uint8Array {
  return encodeUtf8(PROLOGUE_PREFIX + new URL(origin).origin);
}

export interface ClientHello {
  /** When the client wrote message 1, in milliseconds; the server keeps only whole seconds. */
  readonly sentAt: number;
  readonly pairingCode?: string;
}

/** `[sent at, in seconds: u32][pairing code length: u8][pairing code]`; later fields append. */
export function encodeClientHello(hello: ClientHello): Uint8Array {
  const code = encodeUtf8(hello.pairingCode ?? "");
  if (code.length > 255) throw new Error("The pairing code is too long.");
  const bytes = new Uint8Array(5 + code.length);
  new DataView(bytes.buffer).setUint32(0, Math.floor(hello.sentAt / 1000));
  bytes[4] = code.length;
  bytes.set(code, 5);
  return bytes;
}

export function decodeClientHello(bytes: Uint8Array): ClientHello | undefined {
  if (bytes.length < 5) return undefined;
  const sentAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) * 1000;
  const codeLength = bytes[4]!;
  if (bytes.length < 5 + codeLength) return undefined;
  let pairingCode: string;
  try {
    pairingCode = decodeUtf8(bytes.subarray(5, 5 + codeLength));
  } catch {
    return undefined;
  }
  return pairingCode === "" ? { sentAt } : { sentAt, pairingCode };
}

/** The subprotocols the client offers: `t3c.2`, then message 1. */
export function channelProtocols(message: Uint8Array): readonly [string, string] {
  return [CHANNEL_PROTOCOL, Base64Url.encode(message)];
}

/**
 * Message 1 in unpadded base64url: at least 32 + 48 + 21 bytes, its keys and a hello without a
 * code, which is 135 characters, and at most 475 with a 255-character code.
 */
const MESSAGE_ONE_TOKEN = /^[A-Za-z0-9_-]{135,475}$/;

/** Message 1 from an upgrade's `Sec-WebSocket-Protocol` header, if it offers exactly that. */

export function messageFromProtocols(header: string | undefined): Uint8Array | undefined {
  if (header === undefined) return undefined;
  const values = header.split(",").map((value) => value.trim());
  if (values.length !== 2 || !values.includes(CHANNEL_PROTOCOL)) return undefined;
  const offered = values.find((value) => value !== CHANNEL_PROTOCOL);
  // Unpadded base64url only, as a WebSocket subprotocol token must be, and no longer than the
  // largest message 1: keys, a 255-character code and their tags.
  if (offered === undefined || !MESSAGE_ONE_TOKEN.test(offered)) return undefined;
  const decoded = Base64Url.decode(offered);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
}

/** The client's side of opening a channel to `origin`. */
export interface ChannelInitiation {
  /** Where to open the WebSocket. */
  readonly path: string;
  readonly protocols: readonly [string, string];
  /** Reads the server's first WebSocket message, throwing a `NoiseError` unless it's the server's. */
  readonly finish: (message: Uint8Array) => SecureChannel;
}

export function initiateChannel(input: {
  readonly origin: string;
  readonly serverKey: Uint8Array;
  readonly clientKey: KeyPair;
  readonly pairingCode?: string;
  readonly primitives?: NoisePrimitives;
  readonly now?: () => number;
  readonly limits?: Partial<ChannelLimits>;
}): ChannelInitiation {
  const now = input.now ?? Date.now;
  const initiation = initiateHandshake({
    prologue: channelPrologue(input.origin),
    staticKey: input.clientKey,
    serverKey: input.serverKey,
    ...(input.primitives === undefined ? {} : { primitives: input.primitives }),
    payload: encodeClientHello(
      input.pairingCode === undefined
        ? { sentAt: now() }
        : { sentAt: now(), pairingCode: input.pairingCode },
    ),
  });
  return {
    path: channelPath(input.serverKey),
    protocols: channelProtocols(initiation.message),
    finish: (message) => {
      const { transport } = initiation.readResponse(message);
      return new SecureChannel({
        role: "client",
        transport,
        now,
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      });
    },
  };
}

/** A valid message 1, which the server answers only once it trusts the client key or the code. */
export interface ChannelAcceptance {
  readonly clientKey: Uint8Array;
  readonly pairingCode: string | undefined;
  /** Writes message 2, to send as the first WebSocket message, and opens the channel. */
  readonly accept: () => { readonly message: Uint8Array; readonly channel: SecureChannel };
}

/**
 * The server's check of an upgrade's subprotocols: none unless they carry a message 1 written to
 * this server for `origin` within the allowed clock skew. Everything else gets the same answer, so
 * the server can drop it without saying why.
 */
export function acceptChannel(input: {
  readonly origin: string;
  readonly serverKey: KeyPair;
  readonly protocols: string | undefined;
  readonly primitives?: NoisePrimitives;
  readonly now?: () => number;
  readonly limits?: Partial<ChannelLimits>;
}): ChannelAcceptance | undefined {
  const message = messageFromProtocols(input.protocols);
  if (message === undefined) return undefined;
  let acceptance: ReturnType<typeof acceptHandshake>;
  try {
    acceptance = acceptHandshake({
      prologue: channelPrologue(input.origin),
      staticKey: input.serverKey,
      message,
      ...(input.primitives === undefined ? {} : { primitives: input.primitives }),
    });
  } catch {
    // A forged or misdirected message 1, or a malformed origin.
    return undefined;
  }
  const now = input.now ?? Date.now;
  const hello = decodeClientHello(acceptance.payload);
  if (hello === undefined || Math.abs(now() - hello.sentAt) > CLIENT_HELLO_MAX_SKEW_MS)
    return undefined;
  return {
    clientKey: acceptance.clientKey,
    pairingCode: hello.pairingCode,
    accept: () => {
      const { message: response, transport } = acceptance.respond(new Uint8Array(0));
      return {
        message: response,
        channel: new SecureChannel({
          role: "server",
          transport,
          now,
          ...(input.limits === undefined ? {} : { limits: input.limits }),
        }),
      };
    },
  };
}
