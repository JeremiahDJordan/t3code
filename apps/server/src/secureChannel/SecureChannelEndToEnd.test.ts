// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalDate:off -- Drives the chain as a client does: a real Node HTTP server, raw sockets through the gateway and plain fetch.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ChannelConnector, type ChannelRoute } from "@t3tools/shared/secureChannel/connector";
import { channelPath } from "@t3tools/shared/secureChannel/handshake";
import { startNodeForwarder } from "@t3tools/shared/secureChannel/nodeForwarder";
import { generateKeyPair } from "@t3tools/shared/secureChannel/noise";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecureChannel from "./SecureChannel.ts";
import * as SecureChannelConnections from "./SecureChannelConnections.ts";
import * as SecureChannelKey from "./SecureChannelKey.ts";

const PUBLIC_ORIGIN = "https://quiet.example.test";
const metadata = { deviceType: "mobile" as const, os: "iOS" };

/** A port nothing listens on yet, for the gateway the server starts. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

/** The server's auth, configured as `--secure-channel-port` and `--secure-channel-origin` do. */
const layerAuth = (gatewayPort: number) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SecureChannel.layerServices),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({
            ...config,
            secureChannelPort: gatewayPort,
            secureChannelOrigin: PUBLIC_ORIGIN,
          })),
        ),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secure-channel-e2e-" })),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * Two routes on the real Node server: one exchanges a pairing code as `/oauth/token` does, binding
 * the session to the channel the request arrived through, and one checks a token the way every
 * authenticated route does.
 */
const layerRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const connections = yield* SecureChannelConnections.SecureChannelConnections;
    yield* router.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const code = yield* request.text;
        const channelClientKey = connections.clientKeyOf(request);
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          code,
          undefined,
          metadata,
          channelClientKey === undefined ? {} : { channelClientKey },
        );
        return HttpServerResponse.text(token.access_token);
      }).pipe(Effect.orDie),
    );
    yield* router.add(
      "GET",
      "/whoami",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* auth.authenticateHttpRequest(request).pipe(
          Effect.match({
            onFailure: () => HttpServerResponse.empty({ status: 401 }),
            onSuccess: () => HttpServerResponse.text("ok"),
          }),
        );
      }),
    );
  }),
);

/** The real Node server with those routes, and the production gateway in front of it. */
const layerServer = (gatewayPort: number) =>
  SecureChannel.layerGateway.pipe(
    Layer.provideMerge(
      HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(layerAuth(gatewayPort)),
  );

it.effect(
  "a token paired through the channel works through it on the real server, and nowhere else",
  () =>
    Effect.gen(function* () {
      const gatewayPort = yield* Effect.promise(freePort);
      const context = yield* Layer.build(layerServer(gatewayPort));
      const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
      const serverKey = yield* Context.get(context, SecureChannelKey.SecureChannelKey).keyPair;
      const address = Context.get(context, HttpServer.HttpServer).address;
      const serverPort = "port" in address ? address.port : 0;
      // Admitted on the live pairing code it carries, as an unpaired device is.
      const code = (yield* auth.createPairingLink()).credential;
      const connector = new ChannelConnector({
        route: {
          origin: PUBLIC_ORIGIN,
          serverKey: serverKey.publicKey,
          clientKey: generateKeyPair(),
          pairingCode: code,
        },
        // The stand-in for the tunnel: the public origin reaches the gateway on loopback.
        openSocket: (url, protocols) =>
          new WebSocket(url.replace("wss://quiet.example.test", `ws://127.0.0.1:${gatewayPort}`), [
            ...protocols,
          ]),
      });
      const forwarder = yield* Effect.acquireRelease(
        Effect.promise(() => startNodeForwarder(connector)),
        (started) => Effect.promise(() => started.close()),
      );

      const token = yield* Effect.promise(() =>
        fetch(`${forwarder.origin}/token`, { method: "POST", body: code }).then((response) =>
          response.text(),
        ),
      );
      const ask = (origin: string) =>
        Effect.promise(() =>
          fetch(`${origin}/whoami`, { headers: { authorization: `Bearer ${token}` } }).then(
            (response) => response.status,
          ),
        );
      expect(yield* ask(forwarder.origin)).toBe(200);
      expect(yield* ask(`http://127.0.0.1:${serverPort}`)).toBe(401);
    }).pipe(Effect.scoped),
);

/** A connector through the stand-in tunnel, as from a device at the route's `CF-Connecting-IP`. */
const connectorFor = (gatewayPort: number, route: ChannelRoute) =>
  new ChannelConnector({
    route,
    openSocket: (url, protocols, headers) =>
      new WebSocket(url.replace("wss://quiet.example.test", `ws://127.0.0.1:${gatewayPort}`), {
        protocols: [...protocols],
        ...(headers === undefined ? {} : { headers }),
      }),
  });

/** A message 1 by its shape alone, sent raw as a flood does, which counts against the limits. */
const forged = (gatewayPort: number, path: string, from: string) =>
  new Promise<void>((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port: gatewayPort }, () =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Sec-WebSocket-Protocol: t3c.2, ${"A".repeat(200)}`,
          `CF-Connecting-IP: ${from}`,
          "",
          "",
        ].join("\r\n"),
      ),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
  });

it.effect("keeps a paired device's address known through a database outage", () =>
  Effect.gen(function* () {
    const gatewayPort = yield* Effect.promise(freePort);
    const context = yield* Layer.build(layerServer(gatewayPort));
    const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
    const sql = Context.get(context, SqlClient.SqlClient);
    const serverKey = yield* Context.get(context, SecureChannelKey.SecureChannelKey).keyPair;
    const route = {
      origin: PUBLIC_ORIGIN,
      serverKey: serverKey.publicKey,
      clientKey: generateKeyPair(),
      headers: { "cf-connecting-ip": "203.0.113.9" },
    };
    const connect = () =>
      Effect.acquireRelease(
        Effect.sync(() => connectorFor(gatewayPort, route)),
        (connector) => Effect.sync(() => connector.close()),
      ).pipe(
        Effect.flatMap((connector) =>
          Effect.promise(() =>
            connector.connect().then(
              () => "connected",
              () => "refused",
            ),
          ),
        ),
        Effect.scoped,
      );

    // The device pairs through the channel, then connects as a paired key, which makes home known.
    const code = (yield* auth.createPairingLink()).credential;
    const forwarder = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startNodeForwarder(connectorFor(gatewayPort, { ...route, pairingCode: code })),
      ),
      (started) => Effect.promise(() => started.close()),
    );
    yield* Effect.promise(() => fetch(`${forwarder.origin}/token`, { method: "POST", body: code }));
    expect(yield* connect()).toBe("connected");

    yield* sql`ALTER TABLE auth_sessions RENAME TO auth_sessions_away`;
    expect(yield* connect()).toBe("refused");
    yield* sql`ALTER TABLE auth_sessions_away RENAME TO auth_sessions`;

    // Strangers spend home's network; home itself stays known, so the device still gets in.
    const path = channelPath(serverKey.publicKey);
    yield* Effect.promise(async () => {
      for (let host = 100; host < 120; host += 1) {
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await forged(gatewayPort, path, `203.0.113.${host}`);
        }
      }
    });
    expect(yield* connect()).toBe("connected");
  }).pipe(Effect.scoped),
);
