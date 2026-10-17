/**
 * The fork's own URL schemes, so Z6 Code's desktop and mobile apps can be installed beside T3 Code's
 * without the operating system handing one app's links to the other. On desktop the scheme is both
 * the page's origin (`z6code://app`) and every link into the app (Codex sign-in returns, prompt
 * links); on mobile it is each build variant's registered scheme. Code that cannot import this
 * file keeps a copy and says so: the desktop's dev launcher, the iOS Live Activity widget and the
 * Android notification module.
 */
export const APP_SCHEME = "z6code";
export const APP_DEV_SCHEME = "z6code-dev";
export const APP_PREVIEW_SCHEME = "z6code-preview";

/** The desktop's scheme: the page origin and its links. */
export function desktopScheme(development: boolean): string {
  return development ? APP_DEV_SCHEME : APP_SCHEME;
}
