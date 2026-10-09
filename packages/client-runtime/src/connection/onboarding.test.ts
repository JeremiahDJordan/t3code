import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { BearerConnectionTarget, type NetworkStatus } from "./model.ts";
import { encodeChannelKey } from "@t3tools/shared/secureChannel/handshake";

import * as SecureChannel from "./secureChannel.ts";
import {
  connectionTransportHeaders,
  isSecureChannelHost,
  setConnectionTransportHeaders,
  withConnectionTransportHeaders,
} from "./transportHeaders.ts";
import { ConnectionTransientError } from "./model.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as EnvironmentRegistry from "./registry.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

/** A valid 32-byte key, as a pairing link carries it. */
const CHANNEL_SERVER_KEY = encodeChannelKey(new Uint8Array(32).fill(7));

/** A forwarder that records what it was asked to open, at a fixed local origin. */
function makeForwarderLog() {
  const requests: Array<SecureChannel.SecureChannelRouteRequest> = [];
  const released: Array<SecureChannel.SecureChannelRouteRequest> = [];
  const layer = Layer.succeed(
    SecureChannel.SecureChannelForwarder,
    SecureChannel.SecureChannelForwarder.of({
      createClientKey: Effect.succeed("client-secret-key"),
      forward: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return { httpBaseUrl: "http://127.0.0.1:52811/", wsBaseUrl: "ws://127.0.0.1:52811/" };
        }),
      release: (request) => Effect.sync(() => void released.push(request)),
      retain: () => Effect.void,
    }),
  );
  return { requests, released, layer };
}

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: sessionScopes.join(" "),
        }),
      );
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(withConnectionTransportHeaders(fetchFn));
}

const ACCESS_TOKEN = { clientId: "id.access", clientSecret: "access-secret" };

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "administrative", scopes: AuthAdministrativeScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const httpLayer = layerPairingHttp(calls, { grantScopes: scopes });
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, httpLayer)));

      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      }).pipe(Effect.provide(httpLayer));

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("pairs an outdated server so it can be updated from this client", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, {
              protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
              selfUpdate: true,
            }),
          ),
        ),
      );
      expect(registration.target.environmentId).toBe("environment-paired");
      expect(calls.map((call) => call.url)).toContain("https://remote.example.test/oauth/token");
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("pairs an address behind Cloudflare Access, its token on every request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "t3.example.test",
        pairingCode: "pairing-token",
        cloudflareAccess: ACCESS_TOKEN,
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));
      // The descriptor fetch and the token exchange both pass Access.
      expect(
        calls.map((call) => new Headers(call.init.headers).get("CF-Access-Client-Secret")),
      ).toEqual(["access-secret", "access-secret"]);
      expect(registration.profile.transport).toBe("cloudflare-access");
      expect(registration.credential.cloudflareAccess).toEqual(ACCESS_TOKEN);
      setConnectionTransportHeaders("https://t3.example.test/", undefined);
    }),
  );

  it.effect("keeps no service token after a failed pairing, and none over plain http", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const layer = Layer.mergeAll(
        layerClientPresentation,
        layerPairingHttp(calls, { failDescriptor: true }),
      );
      yield* preparePairingRegistration({
        host: "t3.example.test",
        pairingCode: "pairing-token",
        cloudflareAccess: ACCESS_TOKEN,
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(connectionTransportHeaders("https://t3.example.test/")).toBeUndefined();
      const plain = yield* preparePairingRegistration({
        host: "http://t3.example.test",
        pairingCode: "pairing-token",
        cloudflareAccess: ACCESS_TOKEN,
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(plain.message).toContain("https");
    }),
  );

  it.effect(
    "pairs a link carrying the server key through the route's channel, never in plain",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const forwarded = makeForwarderLog();
        const registration = yield* preparePairingRegistration({
          pairingUrl: `https://quiet.example.test/pair#token=pairing-token&sk=${CHANNEL_SERVER_KEY}`,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls), forwarded.layer),
          ),
        );
        // The descriptor and the token exchange went to the local forwarder only.
        expect(calls.map((call) => new URL(call.url).origin)).toEqual([
          "http://127.0.0.1:52811",
          "http://127.0.0.1:52811",
        ]);
        expect(forwarded.requests).toEqual([
          {
            httpBaseUrl: "https://quiet.example.test/",
            serverKey: CHANNEL_SERVER_KEY,
            clientKey: "client-secret-key",
            pairingCode: "pairing-token",
          },
        ]);
        expect(forwarded.released).toEqual(forwarded.requests);
        expect(registration.profile.httpBaseUrl).toBe("https://quiet.example.test/");
        expect(registration.profile.channel).toEqual({ serverKey: CHANNEL_SERVER_KEY });
        expect(registration.credential.channelClientKey).toEqual({
          secretKey: "client-secret-key",
        });
        expect(isSecureChannelHost("https://quiet.example.test/api/x")).toBe(true);
      }),
  );

  it.effect("pairs a host, code and typed-in server key through the channel", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const forwarded = makeForwarderLog();
      const registration = yield* preparePairingRegistration({
        host: "typed.example.test",
        pairingCode: "pairing-token",
        channelKey: CHANNEL_SERVER_KEY,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls), forwarded.layer),
        ),
      );
      expect(forwarded.requests[0]?.serverKey).toBe(CHANNEL_SERVER_KEY);
      expect(registration.profile.channel).toEqual({ serverKey: CHANNEL_SERVER_KEY });
      expect(calls.every((call) => call.url.startsWith("http://127.0.0.1:52811/"))).toBe(true);
    }),
  );

  it.effect("lets a host take plain requests again once its encrypted pairing failed", () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(
        SecureChannel.SecureChannelForwarder,
        SecureChannel.SecureChannelForwarder.of({
          createClientKey: Effect.succeed("client-key"),
          forward: () =>
            Effect.fail(
              new ConnectionTransientError({ reason: "network", detail: "Not answering." }),
            ),
          release: () => Effect.void,
          retain: () => Effect.void,
        }),
      );
      yield* Effect.flip(
        preparePairingRegistration({
          host: "https://failing.example.test",
          pairingCode: "pairing-token",
          channelKey: CHANNEL_SERVER_KEY,
        }).pipe(
          Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp([]), failing)),
        ),
      );
      expect(isSecureChannelHost("https://failing.example.test/api/x")).toBe(false);
    }),
  );

  it.effect("keeps a saved route's pinned key: a link can neither swap nor drop it", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const forwarded = makeForwarderLog();
      const target = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-paired"),
        label: "Paired environment",
        connectionId: "bearer:environment-paired:https://quiet.example.test",
      });
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(
        new Map([
          [
            target.environmentId,
            {
              target,
              enabled: true,
              profile: Option.some(
                new BearerConnectionProfile({
                  connectionId: target.connectionId,
                  environmentId: target.environmentId,
                  label: target.label,
                  httpBaseUrl: "https://quiet.example.test/",
                  wsBaseUrl: "wss://quiet.example.test/",
                  channel: { serverKey: CHANNEL_SERVER_KEY },
                }),
              ),
            },
          ],
        ]),
      );
      const registered: Array<unknown> = [];
      const onboarding = yield* ConnectionOnboarding.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
              entries,
              networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
              register: (registration) => Effect.sync(() => void registered.push(registration)),
            }),
            layerClientPresentation,
            layerPairingHttp(calls),
            Layer.mock(ClientCapabilities.SshEnvironmentGateway)({}),
            Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({}),
          ),
        ),
      );
      const pair = (channelKey?: string) =>
        onboarding
          .registerPairing({
            host: "https://quiet.example.test",
            pairingCode: "pairing-token",
            ...(channelKey === undefined ? {} : { channelKey }),
          })
          .pipe(Effect.provide(forwarded.layer));

      const swapped = yield* Effect.flip(pair(encodeChannelKey(new Uint8Array(32).fill(8))));
      expect(swapped).toMatchObject({ detail: expect.stringContaining("isn't the one saved") });
      const dropped = yield* Effect.flip(pair());
      expect(dropped).toMatchObject({ detail: expect.stringContaining("has no server key") });
      expect(calls).toEqual([]);
      expect(forwarded.requests).toEqual([]);
      expect(registered).toEqual([]);

      // Another address whose descriptor echoes the pinned environment: refused before the code is spent.
      const elsewhere = yield* Effect.flip(
        onboarding.registerPairing({
          host: "http://192.168.1.50:3773",
          pairingCode: "pairing-token",
        }),
      );
      expect(elsewhere).toMatchObject({
        detail: expect.stringContaining("is saved as end-to-end encrypted"),
      });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/.well-known/t3/environment",
      ]);
      expect(registered).toEqual([]);

      // Adding it as a route to that environment, as a deep link can open, is refused the same way.
      const added = yield* Effect.flip(
        onboarding.registerPairing({
          host: "http://192.168.1.50:3773",
          pairingCode: "pairing-token",
          expectedEnvironmentId: target.environmentId,
        }),
      );
      expect(added).toMatchObject({
        detail: expect.stringContaining("is saved as end-to-end encrypted"),
      });
      expect(registered).toEqual([]);

      yield* pair(CHANNEL_SERVER_KEY);
      expect(registered).toHaveLength(1);
    }),
  );

  it.effect("sends an encrypted route's Access token on the channel, not on plain requests", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const forwarded = makeForwarderLog();
      const registration = yield* preparePairingRegistration({
        pairingUrl: `https://hidden.example.test/pair#token=pairing-token&sk=${CHANNEL_SERVER_KEY}`,
        cloudflareAccess: ACCESS_TOKEN,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls), forwarded.layer),
        ),
      );
      expect(forwarded.requests[0]?.cloudflareAccess).toEqual(ACCESS_TOKEN);
      expect(connectionTransportHeaders("https://hidden.example.test/")).toBeUndefined();
      expect(
        calls.every((call) => new Headers(call.init.headers).get("CF-Access-Client-Id") === null),
      ).toBe(true);
      expect(registration.profile.transport).toBe("cloudflare-access");
    }),
  );

  it.effect("refuses an encrypted pairing where the app can't open channels", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        pairingUrl: `https://quiet.example.test/pair#token=pairing-token&sk=${CHANNEL_SERVER_KEY}`,
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );
      expect(error.message).toContain("desktop and mobile apps");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("keeps a route encrypted when edited", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-encrypted");
      const entry = Option.some({
        target: new BearerConnectionTarget({
          environmentId,
          label: "Desk",
          connectionId: "bearer:encrypted",
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "bearer:encrypted",
            environmentId,
            label: "Desk",
            httpBaseUrl: "https://quiet.example.test/",
            wsBaseUrl: "wss://quiet.example.test/",
            channel: { serverKey: CHANNEL_SERVER_KEY },
          }),
        ),
        enabled: true,
      });
      const credential = Option.some(
        new BearerConnectionCredential({
          token: "bearer-token",
          channelClientKey: { secretKey: "client-secret-key" },
        }),
      );
      const updated = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "Renamed",
          httpBaseUrl: "https://quiet.example.test/",
          cloudflareAccess: ACCESS_TOKEN,
        },
        entry,
        credential,
      });
      expect(updated.profile.channel).toEqual({ serverKey: CHANNEL_SERVER_KEY });
      expect(updated.credential).toMatchObject({
        channelClientKey: { secretKey: "client-secret-key" },
      });
    }),
  );

  it.effect("keeps a route behind Cloudflare Access when edited, with a new token if given", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const entry = Option.some({
        target: new BearerConnectionTarget({
          environmentId,
          label: "Desk",
          connectionId: "bearer:environment-paired",
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "bearer:environment-paired",
            environmentId,
            label: "Desk",
            httpBaseUrl: "https://t3.example.test/",
            wsBaseUrl: "wss://t3.example.test/",
            transport: "cloudflare-access",
          }),
        ),
        enabled: true,
      });
      const saved = new BearerConnectionCredential({
        token: "bearer-token",
        cloudflareAccess: ACCESS_TOKEN,
      });
      const credential = Option.some(saved);
      const renamed = yield* prepareBearerConnectionUpdate({
        input: { environmentId, label: "Renamed", httpBaseUrl: "https://t3.example.test/" },
        entry,
        credential,
      });
      expect(renamed.profile.transport).toBe("cloudflare-access");
      expect(renamed.credential).toEqual(saved);
      const rotated = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "Desk",
          httpBaseUrl: "https://t3.example.test/",
          cloudflareAccess: { clientId: "new.access", clientSecret: "new-secret" },
        },
        entry,
        credential,
      });
      expect(rotated.credential).toMatchObject({
        token: "bearer-token",
        cloudflareAccess: { clientId: "new.access", clientSecret: "new-secret" },
      });
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
      });
    }),
  );
});
