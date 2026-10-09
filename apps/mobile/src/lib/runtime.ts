import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import {
  connectionTransportHeaders,
  isSecureChannelHost,
  SecureChannelRequiredError,
  withConnectionTransportHeaders,
} from "@t3tools/client-runtime/connection";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import * as Dpop from "../features/cloud/dpop";
import * as ManagedRelayLayer from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import * as Tracing from "../features/observability/tracing";
import * as Persistence from "../persistence/layer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";
import { layerSecureChannelForwarder } from "./secureChannel";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

// A route behind Cloudflare Access needs its service token on every request and WebSocket.
const layerHttpClient = layerRemoteHttpClient(withConnectionTransportHeaders(fetch));

/** React Native's WebSocket takes handshake headers as a third argument, which DOM types omit. */
const ReactNativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string | Array<string> | undefined,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

const layerWebSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
  // An encrypted route is used through its local forwarder; its own host gets nothing in plain.
  if (isSecureChannelHost(url)) throw new SecureChannelRequiredError(url);
  const protocols = typeof options === "string" || Array.isArray(options) ? options : undefined;
  const headers = {
    ...(typeof options === "object" && !Array.isArray(options) ? options.headers : undefined),
    ...connectionTransportHeaders(url),
  };
  return Object.keys(headers).length === 0
    ? new WebSocket(url, protocols)
    : new ReactNativeWebSocket(url, protocols, { headers });
});

type RuntimeLayerSource =
  | ReturnType<typeof ManagedRelayLayer.layer>
  | typeof layerWebSocketConstructor
  | typeof layerSecureChannelForwarder
  | typeof Dpop.layer
  | typeof layerHttpClient
  | typeof Persistence.layer
  | typeof Tracing.layer;

const layerRuntime = Layer.mergeAll(
  ManagedRelayLayer.layer(configuredRelayUrl()),
  layerWebSocketConstructor,
  layerSecureChannelForwarder,
).pipe(
  Layer.provideMerge(Dpop.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Tracing.layer.pipe(Layer.provide(layerHttpClient))),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
