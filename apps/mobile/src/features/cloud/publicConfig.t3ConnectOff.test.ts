import { T3_CONNECT_ENABLED } from "@t3tools/shared/forkFeatures";
import { describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

// A build from `.env`: every public T3 Connect value is present.
const configuredExtra = vi.hoisted(() => ({
  clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
  relay: { url: "https://relay.example.test" },
  observability: {
    tracesUrl: "https://api.axiom.co/v1/traces",
    tracesDataset: "mobile-traces",
    tracesToken: "public-ingest-token",
  },
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: configuredExtra } } }));

describe("the fork's T3 Connect flag", () => {
  it("reads Clerk and the relay as unconfigured while the flag is off, keeping tracing", () => {
    expect(resolveCloudPublicConfig(configuredExtra, false)).toEqual({
      clerk: { publishableKey: null, jwtTemplate: null },
      relay: { url: null },
      observability: {
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });
  });

  it("passes the configuration through while the flag is on", () => {
    expect(resolveCloudPublicConfig(configuredExtra, true)).toMatchObject({
      clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
      relay: { url: "https://relay.example.test" },
    });
  });

  it("hides every hasCloudPublicConfig surface unless the flag is on", () => {
    expect(hasCloudPublicConfig()).toBe(T3_CONNECT_ENABLED);
  });
});
