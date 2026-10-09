import * as SecureChannel from "@t3tools/client-runtime/connection/secureChannel";
import type {
  ChannelConnector,
  ForwardedConnection,
  OuterSocket,
} from "@t3tools/shared/secureChannel/connector";
import type { NoisePrimitives } from "@t3tools/shared/secureChannel/noise";
import { NativeModule, requireOptionalNativeModule } from "expo";
import * as ExpoCrypto from "expo-crypto";

type SecureChannelEvents = {
  onConnection: (event: { readonly listenerId: string; readonly connectionId: string }) => void;
  onData: (event: { readonly connectionId: string; readonly data: Uint8Array }) => void;
  onEnd: (event: { readonly connectionId: string }) => void;
  onClose: (event: { readonly connectionId: string; readonly error?: string }) => void;
};

declare class T3SecureChannelModule extends NativeModule<SecureChannelEvents> {
  isAvailable(): boolean;
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  startListener(): Promise<{ readonly listenerId: string; readonly port: number }>;
  stopListener(listenerId: string): void;
  write(connectionId: string, data: Uint8Array): Promise<void>;
  end(connectionId: string): void;
  destroy(connectionId: string): void;
  pause(connectionId: string): void;
  resume(connectionId: string): void;
}

const native = requireOptionalNativeModule<T3SecureChannelModule>("T3SecureChannel");

/**
 * The secure channel's primitives on the phone. Hermes runs `@noble`'s ChaCha20-Poly1305 at about
 * 3 MB/s, so frames are sealed natively (CryptoKit on iOS, the platform cipher on Android 9+), and
 * Hermes has no `crypto.getRandomValues`, so randomness comes from expo-crypto.
 */
export const channelPrimitives: NoisePrimitives = {
  randomBytes: (length) => ExpoCrypto.getRandomBytes(length),
  ...(native?.isAvailable()
    ? {
        aead: {
          seal: (key, nonce, ad, plaintext) => native.seal(key, nonce, ad, plaintext),
          open: (key, nonce, ad, ciphertext) => native.open(key, nonce, ad, ciphertext),
        },
      }
    : {}),
};

interface CarriedConnection {
  readonly connection: ForwardedConnection;
  /** A clean close follows both halves ending; anything else abandons the stream. */
  localEnded: boolean;
  remoteEnded: boolean;
}

const connectorsByListener = new Map<string, ChannelConnector>();
const carried = new Map<string, CarriedConnection>();
let listening = false;

/** Routes the native listener's events to each listener's connector; done once per process. */
function listen(module: T3SecureChannelModule): void {
  if (listening) return;
  listening = true;
  module.addListener("onConnection", ({ listenerId, connectionId }) => {
    const connector = connectorsByListener.get(listenerId);
    if (connector === undefined) return module.destroy(connectionId);
    const entry: CarriedConnection = {
      localEnded: false,
      remoteEnded: false,
      connection: connector.attach({
        write: (bytes, taken) => {
          module.write(connectionId, bytes).then(taken, taken);
        },
        end: () => {
          entry.remoteEnded = true;
          module.end(connectionId);
        },
        destroy: () => module.destroy(connectionId),
        pause: () => module.pause(connectionId),
        resume: () => module.resume(connectionId),
      }),
    };
    carried.set(connectionId, entry);
  });
  module.addListener("onData", ({ connectionId, data }) => {
    carried.get(connectionId)?.connection.write(data);
  });
  module.addListener("onEnd", ({ connectionId }) => {
    const entry = carried.get(connectionId);
    if (entry === undefined) return;
    entry.localEnded = true;
    entry.connection.end();
  });
  module.addListener("onClose", ({ connectionId, error }) => {
    const entry = carried.get(connectionId);
    carried.delete(connectionId);
    if (entry !== undefined && (error !== undefined || !entry.localEnded || !entry.remoteEnded)) {
      entry.connection.reset(error ?? "The local connection closed.");
    }
  });
}

async function startLoopbackListener(connector: ChannelConnector) {
  if (native === null) throw new Error("This build has no secure channel listener.");
  listen(native);
  const { listenerId, port } = await native.startListener();
  connectorsByListener.set(listenerId, connector);
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      connectorsByListener.delete(listenerId);
      connector.close();
      native.stopListener(listenerId);
    },
  };
}

/** React Native's WebSocket takes handshake headers as a third argument, which DOM types omit. */
const ReactNativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: Array<string>,
  options: { readonly headers: Readonly<Record<string, string>> },
) => OuterSocket;

/** The phone's forwarders: a native loopback listener per encrypted route, bridged here. */
export const layerSecureChannelForwarder =
  native === null
    ? SecureChannel.layerUnsupported
    : SecureChannel.layerLocal({
        openSocket: (url, protocols, headers) =>
          headers === undefined
            ? (new WebSocket(url, [...protocols]) as unknown as OuterSocket)
            : new ReactNativeWebSocket(url, [...protocols], { headers }),
        startListener: startLoopbackListener,
        randomBytes: (length) => ExpoCrypto.getRandomBytes(length),
        primitives: channelPrimitives,
        fetch: (input, init) => globalThis.fetch(input, init),
      });
