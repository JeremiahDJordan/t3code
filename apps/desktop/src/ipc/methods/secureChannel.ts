// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The main process's random source for channel keys, and the plain fetch that tells a Cloudflare Access refusal from a channel that's down.
import * as NodeCrypto from "node:crypto";

import {
  makeSecureChannelForwarders,
  SecureChannelForwardError,
} from "@t3tools/client-runtime/connection/secureChannel";
import {
  DesktopSecureChannelForwardResult,
  DesktopSecureChannelRequest,
  DesktopSecureChannelRoute,
} from "@t3tools/contracts";
import type { OuterSocket } from "@t3tools/shared/secureChannel/connector";
import { startNodeForwarder } from "@t3tools/shared/secureChannel/nodeForwarder";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSecureChannelKeys from "../../app/DesktopSecureChannelKeys.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Node's WebSocket takes handshake headers in its options, which DOM types omit. */
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  init: { readonly protocols: Array<string>; readonly headers?: Readonly<Record<string, string>> },
) => OuterSocket;

/**
 * The desktop's forwarders for end-to-end encrypted routes, in the main process: a loopback
 * listener per route, whose outer socket can carry Cloudflare Access headers, which the renderer's
 * WebSocket can't. Each is kept while its route is saved and enabled, so its local origin stays
 * stable.
 */
const forwarders = makeSecureChannelForwarders({
  openSocket: (url, protocols, headers) =>
    new NodeWebSocket(url, {
      protocols: [...protocols],
      ...(headers === undefined ? {} : { headers }),
    }),
  startListener: startNodeForwarder,
  randomBytes: (length) => new Uint8Array(NodeCrypto.randomBytes(length)),
  fetch: (input, init) => globalThis.fetch(input, init),
});

/** The request with the route's key in place of the renderer's id for it. */
const withKey = (request: DesktopSecureChannelRequest) =>
  DesktopSecureChannelKeys.DesktopSecureChannelKeys.pipe(
    Effect.flatMap((keys) => keys.keyFor(request.clientKey)),
    Effect.map((clientKey) => ({ ...request, clientKey })),
  );

/** Hands the renderer an id for a new key; the key itself stays in this process. */
export const createSecureChannelClientKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECURE_CHANNEL_CREATE_CLIENT_KEY_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: () =>
    DesktopSecureChannelKeys.DesktopSecureChannelKeys.pipe(
      Effect.flatMap((keys) => keys.createKeyId),
      Effect.withSpan("desktop.ipc.secureChannel.createClientKey"),
    ),
});

export const forwardSecureChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECURE_CHANNEL_FORWARD_CHANNEL,
  payload: DesktopSecureChannelRequest,
  result: DesktopSecureChannelForwardResult,
  handler: Effect.fn("desktop.ipc.secureChannel.forward")(function* (request) {
    const keyed = yield* withKey(request).pipe(Effect.result);
    if (keyed._tag === "Failure") {
      return { ok: false, kind: "unsupported", message: keyed.failure.message } as const;
    }
    return yield* Effect.promise(() =>
      forwarders.forward(keyed.success).then(
        (origins): DesktopSecureChannelForwardResult => ({ ok: true, ...origins }),
        (cause: unknown): DesktopSecureChannelForwardResult =>
          cause instanceof SecureChannelForwardError
            ? { ok: false, ...cause.failure }
            : { ok: false, kind: "unreachable", message: String(cause) },
      ),
    );
  }),
});

export const releaseSecureChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECURE_CHANNEL_RELEASE_CHANNEL,
  payload: DesktopSecureChannelRequest,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.secureChannel.release")(function* (request) {
    const keyed = yield* withKey(request).pipe(Effect.option);
    if (keyed._tag === "Some") yield* Effect.promise(() => forwarders.release(keyed.value));
  }),
});

export const retainSecureChannels = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SECURE_CHANNEL_RETAIN_CHANNEL,
  payload: Schema.Array(DesktopSecureChannelRoute),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.secureChannel.retain")(function* (routes) {
    yield* Effect.promise(() => forwarders.retain(routes));
  }),
});
