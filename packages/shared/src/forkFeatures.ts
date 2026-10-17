/**
 * The fork's build-time feature flags. The fork ships from source only, so a
 * source constant is the flag: change it and rebuild the server, web, desktop
 * and mobile apps.
 */

/**
 * Upstream's hosted relay and tunnel service (its accounts site, `t3 connect`,
 * Settings → Connections → T3 Connect). Off in this fork: no surface offers it,
 * the server neither links nor starts a stored tunnel, and `t3 connect` refuses.
 * Stored link data is kept, so setting this to `true` and rebuilding brings an
 * existing link back. FORK.md has the decision. Typed `boolean`, not `false`,
 * so both sides of each check still typecheck.
 */
export const T3_CONNECT_ENABLED: boolean = false;

/** The one line a client shows where T3 Connect setup would be. */
export const T3_CONNECT_OFF_NOTE = "T3 Connect is turned off in this build.";

/** What the server and CLI refuse with: the note plus how to turn it on. */
export const T3_CONNECT_DISABLED_MESSAGE =
  "T3 Connect is turned off in this build. Set T3_CONNECT_ENABLED to true in packages/shared/src/forkFeatures.ts and rebuild to use it.";

/**
 * The hosted web app's Latest/Nightly switch. `apps/web/vercel.ts` routes channels only for
 * upstream's own router and channel domains, and the fork hosts no channels, so on any other host
 * the switch would set a cookie and reload the same build. Turning it on needs an owned router
 * and channel origins in `vercel.ts` too.
 */
export const HOSTED_CHANNEL_SWITCHING_ENABLED: boolean = false;
