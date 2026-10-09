import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { channelKeyFingerprint, decodeChannelKey } from "@t3tools/shared/secureChannel/handshake";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";
import * as SecureChannel from "./secureChannel.ts";
import {
  cloudflareAccessHeaders,
  holdSecureChannelHost,
  markSecureChannelHost,
  setConnectionTransportHeaders,
  type CloudflareAccessServiceToken,
} from "./transportHeaders.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  /**
   * Set when adding a route to a saved machine: the pairing must reach this
   * environment, or nothing is saved.
   */
  readonly expectedEnvironmentId?: EnvironmentId;
  /** The service token of an address behind Cloudflare Access, sent with every request to it. */
  readonly cloudflareAccess?: CloudflareAccessServiceToken;
  /** A server key typed in by hand, making the route end-to-end encrypted; a link carries it as `sk`. */
  readonly channelKey?: string;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  /** Set when adding a route to a saved machine; see `PairingConnectionInput`. */
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  /** A new Cloudflare Access service token for a route behind Access; the saved one otherwise. */
  readonly cloudflareAccess?: CloudflareAccessServiceToken;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

/**
 * One bearer route per address, so pairing over Tailscale adds a route next
 * to the LAN one instead of replacing it. Pairing the same address again
 * reuses the id and replaces that route.
 */
function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

/** What pairing needs to know about the environments already saved. */
export interface SavedPins {
  /** The server key an environment's encrypted route pins, if it has one. */
  readonly pinnedServerKeyOf?: (environmentId: EnvironmentId) => string | undefined;
}

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput, saved: SavedPins = {}) {
  const target = yield* resolvePairingTarget(input);
  const access = input.cloudflareAccess;
  if (access !== undefined && !target.httpBaseUrl.startsWith("https://")) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "An address behind Cloudflare Access must use https.",
    });
  }
  if (target.channelKey !== undefined) return yield* pairThroughChannel(target, input, saved);
  if (access !== undefined) {
    // Access turns away every request without the token, the first descriptor fetch included.
    setConnectionTransportHeaders(target.httpBaseUrl, cloudflareAccessHeaders(access));
  }
  return yield* pairWith(target, input, saved).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        if (access !== undefined) setConnectionTransportHeaders(target.httpBaseUrl, undefined);
      }),
    ),
  );
});

/**
 * Pairs a link carrying the server's channel key: this device gets its own key for the route, and
 * pairing runs through the route's forwarder with the code in message 1, so neither the code nor
 * the token crosses the tunnel in plain. The route is saved channel-only.
 */
const pairThroughChannel = Effect.fn("clientRuntime.connection.onboarding.pairThroughChannel")(
  function* (
    target: ReturnType<typeof resolveRemotePairingTarget>,
    input: PairingConnectionInput,
    saved: SavedPins,
  ) {
    const serverKey = target.channelKey;
    if (serverKey === undefined || decodeChannelKey(serverKey) === undefined) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "The pairing link's server key is malformed.",
      });
    }
    const forwarder = yield* Effect.serviceOption(SecureChannel.SecureChannelForwarder);
    if (Option.isNone(forwarder)) return yield* SecureChannel.unsupportedError();
    // Held for the pairing's sake, and marked for good only once it pairs.
    const release = holdSecureChannelHost(target.httpBaseUrl);
    return yield* Effect.gen(function* () {
      const clientKey = yield* forwarder.value.createClientKey;
      const request = {
        httpBaseUrl: target.httpBaseUrl,
        serverKey,
        clientKey,
        pairingCode: target.credential,
        ...(input.cloudflareAccess === undefined
          ? {}
          : { cloudflareAccess: input.cloudflareAccess }),
      } satisfies SecureChannel.SecureChannelRouteRequest;
      return yield* forwarder.value.forward(request).pipe(
        Effect.flatMap((local) =>
          pairWith(target, input, saved, { via: local, channel: { serverKey, clientKey } }),
        ),
        Effect.ensuring(forwarder.value.release(request)),
      );
    }).pipe(
      Effect.tap(() => Effect.sync(() => markSecureChannelHost(target.httpBaseUrl))),
      Effect.ensuring(Effect.sync(release)),
    );
  },
);

const pairWith = Effect.fn("clientRuntime.connection.onboarding.pairWith")(function* (
  target: ReturnType<typeof resolveRemotePairingTarget>,
  input: PairingConnectionInput,
  saved: SavedPins,
  /** For an encrypted route: where to send its requests, and the keys to save with it. */
  channelRoute?: {
    readonly via: SecureChannel.SecureChannelLocalOrigins;
    readonly channel: { readonly serverKey: string; readonly clientKey: string };
  },
) {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const requestBaseUrl = channelRoute?.via.httpBaseUrl ?? target.httpBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: requestBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  // A pinned environment takes a link only with its key, from any flow, adding a route included.
  // Otherwise a phished link for any address that echoes its id, which isn't secret, would add a
  // plain route to it, and a LAN one would be tried first.
  const pinned = saved.pinnedServerKeyOf?.(descriptor.environmentId);
  if (pinned !== undefined && channelRoute?.channel.serverKey !== pinned) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `${descriptor.label} is saved as end-to-end encrypted, and this link ${channelRoute === undefined ? "has no server key" : "has a different server key"}. It takes only encrypted links with its key; if its key changed, remove the environment, then pair again.`,
    });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: requestBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      ...(input.cloudflareAccess === undefined ? {} : { transport: "cloudflare-access" as const }),
      ...(channelRoute === undefined
        ? {}
        : { channel: { serverKey: channelRoute.channel.serverKey } }),
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
      ...(input.cloudflareAccess === undefined
        ? {}
        : { cloudflareAccess: { ...input.cloudflareAccess } }),
      ...(channelRoute === undefined
        ? {}
        : { channelClientKey: { secretKey: channelRoute.channel.clientKey } }),
    }),
  });
});

/** The server key a saved encrypted route pins, among the routes of `entries` that `matches`. */
function pinnedServerKey(
  entries: Iterable<ConnectionCatalogEntry>,
  matches: (profile: BearerConnectionProfile) => boolean,
): string | undefined {
  for (const entry of entries) {
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (
        profile !== null &&
        isBearerProfile(profile) &&
        profile.channel !== undefined &&
        matches(profile)
      ) {
        return profile.channel.serverKey;
      }
    }
  }
  return undefined;
}

const fingerprint = (key: string) => {
  const decoded = decodeChannelKey(key);
  return decoded === undefined ? "unreadable" : channelKeyFingerprint(decoded);
};

/**
 * Keeps an encrypted route's pinned key: a link for its address must carry the same key, so a
 * second link can neither swap it, as a taken-over hostname would want, nor drop it for plain
 * requests. Checked before any request. A rotated key means removing the environment first.
 */
export function refusePinChange(
  entries: Iterable<ConnectionCatalogEntry>,
  target: { readonly httpBaseUrl: string; readonly channelKey?: string | undefined },
): ConnectionBlockedError | undefined {
  const origin = new URL(target.httpBaseUrl).origin;
  const pinned = pinnedServerKey(
    entries,
    (profile) => new URL(profile.httpBaseUrl).origin === origin,
  );
  if (pinned === undefined || target.channelKey === pinned) return undefined;
  const host = new URL(target.httpBaseUrl).host;
  return new ConnectionBlockedError({
    reason: "configuration",
    detail:
      target.channelKey === undefined
        ? `${host} is saved as end-to-end encrypted, and this link has no server key. Pair with an encrypted link.`
        : `This link's server key (${fingerprint(target.channelKey)}) isn't the one saved for ${host} (${fingerprint(pinned)}). If the server's key changed, remove the environment, then pair again.`,
  });
}

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  const pinChange = refusePinChange(entries.values(), yield* resolvePairingTarget(input));
  if (pinChange !== undefined) return yield* pinChange;
  const registration = yield* preparePairingRegistration(input, {
    pinnedServerKeyOf: (environmentId) => {
      const entry = entries.get(environmentId);
      return entry === undefined ? undefined : pinnedServerKey([entry], () => true);
    },
  });
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  // Editing changes the environment's first direct route; others stay as saved.
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  // A route behind Cloudflare Access stays behind it, with a new service token if one is given.
  const cloudflareAccess =
    options.input.cloudflareAccess ?? credential.value.cloudflareAccess ?? undefined;
  if (cloudflareAccess !== undefined && !httpBaseUrl.startsWith("https://")) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "An address behind Cloudflare Access must use https.",
    });
  }
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      ...(cloudflareAccess === undefined ? {} : { transport: "cloudflare-access" as const }),
      // An encrypted route stays encrypted, with the server key it was paired with.
      ...(entry.profile.value.channel === undefined
        ? {}
        : { channel: entry.profile.value.channel }),
    }),
    credential:
      options.input.cloudflareAccess === undefined
        ? credential.value
        : new BearerConnectionCredential({
            token: credential.value.token,
            cloudflareAccess: { ...options.input.cloudflareAccess },
            ...(credential.value.channelClientKey === undefined
              ? {}
              : { channelClientKey: credential.value.channelClientKey }),
          }),
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  // One id per SSH target, so a second host or alias for the same machine
  // adds a route instead of replacing the first.
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
