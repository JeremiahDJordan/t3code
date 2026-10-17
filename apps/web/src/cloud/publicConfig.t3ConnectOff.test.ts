import { T3_CONNECT_ENABLED } from "@t3tools/shared/forkFeatures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig.ts";

beforeEach(() => {
  // A build from `.env`: every public T3 Connect value is present.
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://traces.example.test/v1/traces");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the fork's T3 Connect flag", () => {
  it("reads a configured build as unconfigured while the flag is off", () => {
    expect(resolveCloudPublicConfig(false)).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
  });

  it("passes the configuration through while the flag is on", () => {
    expect(resolveCloudPublicConfig(true)).toMatchObject({
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: "https://relay.example.test",
    });
  });

  it("hides every hasCloudPublicConfig surface unless the flag is on", () => {
    expect(hasCloudPublicConfig()).toBe(T3_CONNECT_ENABLED);
  });
});
