/**
 * The fork's own desktop scheme, so Z6 Code and T3 Code can be installed side by side without the
 * operating system handing one app's links to the other. It is both the scheme links into the
 * app use (Codex sign-in returns, prompt links) and the desktop page's own origin
 * (`z6code://app`), so an address the page hands out always routes back to Z6.
 */
export const DESKTOP_LINK_SCHEME = "z6code";
export const DESKTOP_DEV_LINK_SCHEME = "z6code-dev";

export function desktopLinkScheme(development: boolean): string {
  return development ? DESKTOP_DEV_LINK_SCHEME : DESKTOP_LINK_SCHEME;
}
