/**
 * The fork's own desktop link scheme, so Z6 Code and T3 Code can be installed side by side
 * without the operating system handing one app's links to the other. It carries Codex sign-in
 * returns and prompt links into the desktop app. The renderer's internal origin
 * (`t3code://app` in `apps/desktop/src/electron/ElectronProtocol.ts`) never leaves the app and
 * keeps upstream's name, so the desktop's saved browser storage stays where it is.
 */
export const DESKTOP_LINK_SCHEME = "z6code";
export const DESKTOP_DEV_LINK_SCHEME = "z6code-dev";

export function desktopLinkScheme(development: boolean): string {
  return development ? DESKTOP_DEV_LINK_SCHEME : DESKTOP_LINK_SCHEME;
}

const RENDERER_TO_LINK: Readonly<Record<string, string>> = {
  "t3code:": `${DESKTOP_LINK_SCHEME}:`,
  "t3code-dev:": `${DESKTOP_DEV_LINK_SCHEME}:`,
};
const LINK_TO_RENDERER: Readonly<Record<string, string>> = {
  [`${DESKTOP_LINK_SCHEME}:`]: "t3code:",
  [`${DESKTOP_DEV_LINK_SCHEME}:`]: "t3code-dev:",
};

function withProtocol(value: string, table: Readonly<Record<string, string>>): string {
  const url = new URL(value);
  const protocol = table[url.protocol];
  // URL refuses to switch between special and custom schemes, so rebuild the string.
  return protocol === undefined ? value : `${protocol}${value.slice(url.protocol.length)}`;
}

/** A desktop page address as a link the operating system routes back to this app. */
export function desktopPageToLink(value: string): string {
  return withProtocol(value, RENDERER_TO_LINK);
}

/** A link the operating system routed to this app, as the desktop page address it names. */
export function desktopLinkToPage(value: string): string {
  return withProtocol(value, LINK_TO_RENDERER);
}
