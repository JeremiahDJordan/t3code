import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { DESKTOP_DEV_LINK_SCHEME, DESKTOP_LINK_SCHEME } from "@t3tools/shared/forkIdentity";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

// Fork: Z6 Code's desktop page, and T3 Code's so an upstream desktop app can still connect.
export const DESKTOP_RENDERER_ORIGINS = [
  `${DESKTOP_LINK_SCHEME}://app`,
  `${DESKTOP_DEV_LINK_SCHEME}://app`,
  "t3code://app",
  "t3code-dev://app",
] as const;
