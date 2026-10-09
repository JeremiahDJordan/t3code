import { DesktopSshEnvironmentTargetSchema, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    /**
     * Set on a route the server reported while this client was connected,
     * rather than one the user paired. Learned routes are replaced when the
     * server reports a different address, for example after a DHCP change.
     */
    learned: Schema.optionalKey(Schema.Literal(true)),
    /**
     * "t3-connect" when the route authenticates with the environment's T3
     * Connect credential instead of a stored bearer token.
     */
    authorization: Schema.optionalKey(Schema.Literal("t3-connect")),
    /**
     * "cloudflare-access" when the address sits behind Cloudflare Access, so every request to it
     * carries the service token kept in the route's credential.
     */
    transport: Schema.optionalKey(Schema.Literal("cloudflare-access")),
    /**
     * Set when the route is reached only through the server's end-to-end encrypted channel, with
     * the server key the pairing link pinned (base64url). Combines freely with `transport`.
     */
    channel: Schema.optionalKey(Schema.Struct({ serverKey: Schema.String })),
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

/** One way to reach an environment: T3 Connect, a direct URL, or SSH. */
export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

/**
 * A saved environment. `target` and `profile` are its preferred route;
 * `alternateRoutes` holds the others in preference order. Read them together
 * with `connectionRoutes`.
 */
export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly alternateRoutes?: ReadonlyArray<ConnectionRoute>;
  /** False when the user switched the environment off: saved, but never connects. */
  readonly enabled: boolean;
  /** Discovery rejection stays visible while the saved connection is switched off. */
  readonly unsupportedReason?: string;
  /** The rejection came from an outdated host, which can still be updated remotely. */
  readonly serverUpdateRequired?: boolean;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
    /** The Cloudflare Access service token of a route behind Access. */
    cloudflareAccess: Schema.optionalKey(
      Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String }),
    ),
    /**
     * This device's static key for an end-to-end encrypted route, as its platform keeps it: the
     * base64url secret key on mobile, an id for it on desktop, whose main process holds the key.
     */
    channelClientKey: Schema.optionalKey(Schema.Struct({ secretKey: Schema.String })),
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * Platform-managed registrations are reconciled from the host (the desktop
 * bootstrap IPC) rather than persisted by the user. They cover the primary
 * local environment plus any additional desktop-local backends running
 * alongside it (e.g. a parallel WSL backend). The primary stays on same-origin
 * cookie auth (`PrimaryConnectionRegistration`); secondary local backends live
 * on a separate loopback origin and authenticate with a bearer token minted
 * from their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}
