// @effect-diagnostics nodeBuiltinImport:off -- Whether the gateway is listening is a raw TCP question.
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { encodeChannelKey } from "@t3tools/shared/secureChannel/handshake";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SecureChannel from "./SecureChannel.ts";
import * as SecureChannelGateway from "./SecureChannelGateway.ts";
import * as SecureChannelKey from "./SecureChannelKey.ts";

/** A port nothing listens on yet. */
const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    }),
);

const isListening = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeNet.connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
  );

const PUBLIC_ORIGIN = "https://quiet.example.test";
const withSecureChannel = (secureChannel: Partial<ServerSettings["secureChannel"]>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  secureChannel: {
    ...DEFAULT_SERVER_SETTINGS.secureChannel,
    publicOrigin: PUBLIC_ORIGIN,
    ...secureChannel,
  },
});

/**
 * Settings whose changes the test hands over one at a time. Each pull of the next change is
 * reported, and the gateway pulls only once it has applied the last one.
 */
const scriptedSettings = Effect.gen(function* () {
  const changes = yield* Queue.unbounded<ServerSettings>();
  const pulls = yield* Queue.unbounded<void>();
  const stream = Stream.fromEffectRepeat(
    Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(changes))),
  );
  return {
    pulls,
    /** Hands over a change and waits until the gateway has applied it. */
    change: (settings: ServerSettings) =>
      Queue.offer(changes, settings).pipe(Effect.andThen(Queue.take(pulls))),
    layer: (initial: ServerSettings) =>
      Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.succeed(initial),
        subscribeChanges: Effect.succeed(stream),
      }),
  };
});

const gatewayLayer = (
  settings: Layer.Layer<ServerSettingsService.ServerSettingsService>,
  flag?: { readonly port: number; readonly origin: string | undefined },
) =>
  SecureChannelGateway.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        settings,
        Layer.mock(PairingGrantStore.PairingGrantStore)({}),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3_session",
          legacyCookieName: undefined,
          streamChanges: Stream.empty,
        }),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
      ),
    ),
    Layer.provideMerge(SecureChannel.layerServices),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({
            ...config,
            secureChannelPort: flag?.port,
            secureChannelOrigin: flag?.origin,
          })),
        ),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secure-channel-gw-" })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("the gateway starts, moves and stops as the server setting changes", () =>
  Effect.gen(function* () {
    const first = yield* freePort;
    const second = yield* freePort;
    const settings = yield* scriptedSettings;
    yield* Effect.gen(function* () {
      yield* Queue.take(settings.pulls);
      expect(yield* isListening(first)).toBe(false);

      yield* settings.change(withSecureChannel({ enabled: true, port: first }));
      expect(yield* isListening(first)).toBe(true);

      yield* settings.change(withSecureChannel({ enabled: true, port: second }));
      expect(yield* isListening(first)).toBe(false);
      expect(yield* isListening(second)).toBe(true);

      yield* settings.change(withSecureChannel({ enabled: false, port: second }));
      expect(yield* isListening(second)).toBe(false);

      yield* settings.change(withSecureChannel({ enabled: true, port: second }));
      expect(yield* isListening(second)).toBe(true);
    }).pipe(Effect.provide(gatewayLayer(settings.layer(DEFAULT_SERVER_SETTINGS))));
    expect(yield* isListening(second)).toBe(false);
  }),
);

it.effect("the gateway follows --secure-channel-port, whatever the setting says", () =>
  Effect.gen(function* () {
    const flagPort = yield* freePort;
    const settingPort = yield* freePort;
    const settings = yield* scriptedSettings;
    yield* Effect.gen(function* () {
      expect(yield* isListening(flagPort)).toBe(true);
      expect(yield* isListening(settingPort)).toBe(false);
    }).pipe(
      Effect.provide(
        gatewayLayer(settings.layer(withSecureChannel({ enabled: true, port: settingPort })), {
          port: flagPort,
          origin: PUBLIC_ORIGIN,
        }),
      ),
    );
  }),
);

it.effect("the server config carries the key the gateway answers with", () =>
  Effect.gen(function* () {
    const settings = yield* scriptedSettings;
    yield* Effect.gen(function* () {
      const key = yield* Effect.serviceOption(SecureChannelKey.SecureChannelKey);
      const config = yield* SecureChannelGateway.secureChannelServerKeyForConfig(key);
      const gatewayKey = yield* SecureChannelKey.SecureChannelKey.pipe(
        Effect.flatMap((service) => service.keyPair),
      );
      expect(config).toEqual({ secureChannelServerKey: encodeChannelKey(gatewayKey.publicKey) });
      expect(yield* SecureChannelGateway.secureChannelServerKeyForConfig(Option.none())).toEqual(
        {},
      );
    }).pipe(Effect.provide(gatewayLayer(settings.layer(DEFAULT_SERVER_SETTINGS))));
  }),
);

it.effect(
  "the gateway stays off without the tunnel's public URL, which every handshake binds",
  () =>
    Effect.gen(function* () {
      const settingPort = yield* freePort;
      const settings = yield* scriptedSettings;
      yield* isListening(settingPort).pipe(
        Effect.tap((listening) => Effect.sync(() => expect(listening).toBe(false))),
        Effect.provide(
          gatewayLayer(
            settings.layer(
              withSecureChannel({ enabled: true, port: settingPort, publicOrigin: "" }),
            ),
          ),
        ),
      );
      const listeningWith = (origin: string | undefined, publicOrigin = "") =>
        Effect.gen(function* () {
          const port = yield* freePort;
          const flag = yield* isListening(port).pipe(
            Effect.provide(gatewayLayer(settings.layer(DEFAULT_SERVER_SETTINGS), { port, origin })),
          );
          const setting = yield* isListening(port).pipe(
            Effect.provide(
              gatewayLayer(
                settings.layer(withSecureChannel({ enabled: true, port, publicOrigin })),
              ),
            ),
          );
          return { flag, setting };
        });
      expect(yield* listeningWith(undefined)).toEqual({ flag: false, setting: false });
      // Without a scheme, every handshake would be dropped, so the gateway doesn't start.
      expect(yield* listeningWith("quiet.example.com", "quiet.example.com")).toEqual({
        flag: false,
        setting: false,
      });
      expect(
        yield* listeningWith("https://quiet.example.test/path", "https://quiet.example.test/path"),
      ).toEqual({ flag: true, setting: true });
    }),
);
