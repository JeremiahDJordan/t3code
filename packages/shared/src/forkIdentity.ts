/**
 * The fork's own name, app ids and URL schemes, so Z6 Code's desktop and mobile apps can be
 * installed beside T3 Code's without the operating system or a store mistaking one for the other.
 * Private storage and protocol names (`t3code.*` keys, the `t3` CLI, package names) are not
 * identities and stay upstream's.
 */

/** The name every Z6 Code app shows for itself. */
export const APP_PRODUCT_NAME = "Z6 Code";
/** The mark that stands in for upstream's "T3" where the app sets it apart from "Code". */
export const APP_MARK = "Z6";

/**
 * The fork's reverse-DNS app id: the desktop's bundle id and the production mobile app's iOS
 * bundle id and Android package. The other mobile variants, the iOS extensions, App Group and
 * keychain group derive from it.
 */
export const APP_ID = "org.zanson.z6code";

/**
 * On desktop the scheme is both the page's origin (`z6code://app`) and every link into the app
 * (Codex sign-in returns, prompt links); on mobile it is each build variant's registered scheme.
 * Code that cannot import this file keeps a copy and says so: the desktop's dev launcher, the iOS
 * Live Activity widget and the Android notification module.
 */
export const APP_SCHEME = "z6code";
export const APP_DEV_SCHEME = "z6code-dev";
export const APP_PREVIEW_SCHEME = "z6code-preview";

/** Each mobile build variant's name, iOS bundle id (also its Android package) and scheme. */
export const MOBILE_APP_VARIANTS = {
  development: { name: `${APP_PRODUCT_NAME} Dev`, id: `${APP_ID}.dev`, scheme: APP_DEV_SCHEME },
  preview: {
    name: `${APP_PRODUCT_NAME} Preview`,
    id: `${APP_ID}.preview`,
    scheme: APP_PREVIEW_SCHEME,
  },
  production: { name: APP_PRODUCT_NAME, id: APP_ID, scheme: APP_SCHEME },
} as const;

export type MobileAppVariant = keyof typeof MOBILE_APP_VARIANTS;

/**
 * The Xcode workspace, scheme and `.app` name `expo prebuild` generates for a variant, which it
 * takes from the app's name without spaces or punctuation.
 */
export function mobileXcodeProjectName(variant: MobileAppVariant): string {
  return MOBILE_APP_VARIANTS[variant].name.replace(/[^A-Za-z0-9]/g, "");
}

/** The desktop's scheme: the page origin and its links. */
export function desktopScheme(development: boolean): string {
  return development ? APP_DEV_SCHEME : APP_SCHEME;
}
