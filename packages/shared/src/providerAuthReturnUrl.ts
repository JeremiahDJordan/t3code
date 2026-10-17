import { DESKTOP_DEV_LINK_SCHEME, DESKTOP_LINK_SCHEME } from "./forkIdentity.ts";
import { isLoopbackHost } from "./preview.ts";

export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    // The fork's desktop page origin (`forkIdentity.ts`).
    const desktop =
      [`${DESKTOP_LINK_SCHEME}:`, `${DESKTOP_DEV_LINK_SCHEME}:`].includes(url.protocol) &&
      url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || url.origin === "https://app.t3.codes");
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
