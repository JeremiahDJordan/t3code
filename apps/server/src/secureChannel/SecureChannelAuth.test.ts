import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecureChannel from "./SecureChannel.ts";
import * as SecureChannelClients from "./SecureChannelClients.ts";
import * as SecureChannelConnections from "./SecureChannelConnections.ts";

const layer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SecureChannel.layerServices),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secure-channel-auth-" })),
  Layer.provideMerge(NodeServices.layer),
);

type Request = Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0];

/** A request as the server sees it: arriving on a socket from `remotePort`. */
const requestFrom = (
  remotePort: number,
  input: {
    readonly token?: string;
    readonly url?: string;
    readonly cookies?: Readonly<Record<string, string>>;
  },
) =>
  ({
    url: input.url ?? "/api/orchestration/shell",
    cookies: input.cookies ?? {},
    headers: {
      host: "127.0.0.1:3773",
      ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
    },
    source: { socket: { remoteAddress: "127.0.0.1", remotePort } },
  }) as unknown as Request;

const metadata = { deviceType: "mobile" as const, os: "iOS" };

/** Pairs a client through the channel, as the token exchange does with the gateway's mark. */
const pairThroughChannel = (clientKey: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const link = yield* auth.createPairingLink();
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      link.credential,
      undefined,
      metadata,
      {
        channelClientKey: clientKey,
      },
    );
    return token.access_token;
  });

it.layer(layer)("secure channel auth", (it) => {
  it.effect("binds a session paired through the channel, so the gateway admits that key", () =>
    Effect.gen(function* () {
      const clients = yield* SecureChannelClients.SecureChannelClients;
      yield* pairThroughChannel("client-key-a");
      const session = Option.getOrUndefined(yield* clients.pairedUntil("client-key-a"));
      expect(session && DateTime.isGreaterThan(session, yield* DateTime.now)).toBe(true);
      expect(Option.isNone(yield* clients.pairedUntil("someone-else"))).toBe(true);
    }),
  );

  it.effect("accepts a bound token only through its own client's channel", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const connections = yield* SecureChannelConnections.SecureChannelConnections;
      const token = yield* pairThroughChannel("client-key-b");
      connections.register({ address: "127.0.0.1", port: 41_001 }, "client-key-b");
      connections.register({ address: "127.0.0.1", port: 41_002 }, "client-key-other");

      const session = yield* auth.authenticateHttpRequest(requestFrom(41_001, { token }));
      expect(session.channelClientKey).toBe("client-key-b");
      // Another client's channel, or no channel at all (a token copied off the phone).
      for (const port of [41_002, 41_003]) {
        const error = yield* Effect.flip(
          auth.authenticateHttpRequest(requestFrom(port, { token })),
        );
        expect(error._tag).toBe("ServerAuthInvalidCredentialError");
      }
    }),
  );

  it.effect("binds the WebSocket ticket a channel session mints", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const connections = yield* SecureChannelConnections.SecureChannelConnections;
      const token = yield* pairThroughChannel("client-key-c");
      connections.register({ address: "127.0.0.1", port: 41_011 }, "client-key-c");
      const session = yield* auth.authenticateHttpRequest(requestFrom(41_011, { token }));
      const { ticket } = yield* auth.issueWebSocketTicket(session);
      const url = `/ws?wsTicket=${encodeURIComponent(ticket)}`;

      yield* auth.authenticateWebSocketUpgrade(requestFrom(41_011, { url }));
      const error = yield* Effect.flip(
        auth.authenticateWebSocketUpgrade(requestFrom(41_012, { url })),
      );
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("leaves a token paired outside the channel working anywhere", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const link = yield* auth.createPairingLink();
      const { access_token } = yield* auth.exchangeBootstrapCredentialForAccessToken(
        link.credential,
        undefined,
        metadata,
      );
      const session = yield* auth.authenticateHttpRequest(
        requestFrom(41_021, { token: access_token }),
      );
      expect(session.channelClientKey).toBeUndefined();
    }),
  );

  it.effect("unpairs a key once its session is revoked", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const clients = yield* SecureChannelClients.SecureChannelClients;
      const connections = yield* SecureChannelConnections.SecureChannelConnections;
      const token = yield* pairThroughChannel("client-key-d");
      connections.register({ address: "127.0.0.1", port: 41_031 }, "client-key-d");
      const session = yield* auth.authenticateHttpRequest(requestFrom(41_031, { token }));
      expect(Option.getOrUndefined(yield* clients.clientKeyOfSession(session.sessionId))).toBe(
        "client-key-d",
      );
      yield* sessions.revoke(session.sessionId);
      expect(Option.isNone(yield* clients.pairedUntil("client-key-d"))).toBe(true);
    }),
  );

  it.effect("reports until when a pairing code is live without consuming it", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairing = yield* PairingGrantStore.PairingGrantStore;
      const used = yield* auth.createPairingLink();
      const live = (credential: string) =>
        pairing
          .liveUntil(credential)
          .pipe(
            Effect.map(Option.match({ onNone: () => undefined, onSome: DateTime.toEpochMillis })),
          );
      expect(yield* live(used.credential)).toBe(DateTime.toEpochMillis(used.expiresAt));
      expect(yield* live(used.credential)).toBeDefined();
      yield* auth.exchangeBootstrapCredentialForAccessToken(used.credential, undefined, metadata);
      expect(yield* live(used.credential)).toBeUndefined();

      const waiting = yield* auth.createPairingLink();
      yield* TestClock.adjust("1 hour");
      expect(yield* live(waiting.credential)).toBeUndefined();
      expect(yield* live("NOTAREALCODE")).toBeUndefined();
    }),
  );

  it.effect("binds a browser session created through a channel to that channel", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const connections = yield* SecureChannelConnections.SecureChannelConnections;
      const link = yield* auth.createPairingLink();
      const created = yield* auth.createBrowserSession(
        link.credential,
        metadata,
        undefined,
        "client-key-e",
      );
      connections.register({ address: "127.0.0.1", port: 41_041 }, "client-key-e");
      const cookies = { [sessions.cookieName]: created.sessionToken };

      yield* auth.authenticateHttpRequest(requestFrom(41_041, { cookies }));
      const elsewhere = yield* Effect.flip(
        auth.authenticateHttpRequest(requestFrom(52_000, { cookies })),
      );
      expect(elsewhere._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("binds an MCP client session issued through a channel to that channel", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const connections = yield* SecureChannelConnections.SecureChannelConnections;
      const issued = yield* auth.issueMcpClientSession({
        label: "Agent",
        access: "read-only",
        client: metadata,
        channelClientKey: "client-key-f",
      });
      connections.register({ address: "127.0.0.1", port: 41_051 }, "client-key-f");

      yield* auth.authenticateMcpClient(requestFrom(41_051, { token: issued.token }));
      const elsewhere = yield* Effect.flip(
        auth.authenticateMcpClient(requestFrom(52_001, { token: issued.token })),
      );
      expect(elsewhere._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );
});
