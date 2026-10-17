/**
 * The privacy policy a build links to, set at build time as `VITE_PRIVACY_POLICY_URL`. The fork
 * links to none of upstream's pages, and sends no usage data unless its owner configures
 * analytics, so without it the app shows no policy link (FORK.md, "Talk to no T3 web service").
 */
export const PRIVACY_POLICY_URL: string | null =
  (import.meta.env.VITE_PRIVACY_POLICY_URL as string | undefined)?.trim() || null;
