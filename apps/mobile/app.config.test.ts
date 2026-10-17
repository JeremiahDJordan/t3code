import type { ExpoConfig } from "expo/config";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The fork's builds talk to no T3 web service: each service in the Expo config is absent until
// the build's environment names the owner's own account.

// "clerk.example.com$", base64-encoded the way Clerk publishable keys carry their Frontend API host.
const OWNER_CLERK_KEY = `pk_test_${Buffer.from("clerk.example.com$").toString("base64")}`;

async function loadConfig(
  env: Record<string, string>,
  t3ConnectEnabled = false,
): Promise<ExpoConfig> {
  vi.resetModules();
  // Only the given variables: the repository's .env files must not leak into the result.
  vi.doMock("../../scripts/lib/public-config.ts", () => ({ loadRepoEnv: () => ({ ...env }) }));
  vi.doMock("../../packages/shared/src/forkFeatures.ts", () => ({
    T3_CONNECT_ENABLED: t3ConnectEnabled,
  }));
  return (await import("./app.config.ts")).default;
}

function clerkPlugin(config: ExpoConfig) {
  const plugin = config.plugins?.find(
    (entry): entry is [string, { appleSignIn: boolean }] =>
      Array.isArray(entry) && entry[0] === "@clerk/expo",
  );
  return plugin?.[1];
}

const originalEnv = { ...process.env };

afterEach(() => {
  // app.config.ts copies its environment into process.env.
  process.env = { ...originalEnv };
  vi.doUnmock("../../scripts/lib/public-config.ts");
  vi.doUnmock("../../packages/shared/src/forkFeatures.ts");
});

describe("the fork's Expo config", () => {
  it("builds with no update server, EAS project, Apple team, Clerk domain or tracing endpoint", async () => {
    const config = await loadConfig({});

    expect(config.updates).toEqual({ enabled: false });
    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(clerkPlugin(config)?.appleSignIn).toBe(false);
    expect(config.extra?.observability).toEqual({
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    });
  });

  it("checks the owner's EAS project for updates once the build names it", async () => {
    const config = await loadConfig({
      T3CODE_EAS_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
      T3CODE_EAS_OWNER: "owner",
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
    });

    expect(config.updates).toMatchObject({
      enabled: true,
      url: "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
    });
    expect(config.owner).toBe("owner");
    expect(config.extra?.eas).toEqual({ projectId: "11111111-2222-3333-4444-555555555555" });
    expect(config.ios?.appleTeamId).toBe("ABC1234567");
  });

  it("prefers a self-hosted update server, and keeps updates off when told to", async () => {
    expect(
      (await loadConfig({ T3CODE_MOBILE_UPDATES_URL: "https://updates.example.com/manifest" }))
        .updates,
    ).toMatchObject({ enabled: true, url: "https://updates.example.com/manifest" });
    expect(
      (
        await loadConfig({
          T3CODE_MOBILE_UPDATES_URL: "https://updates.example.com/manifest",
          T3CODE_MOBILE_UPDATES_ENABLED: "0",
        })
      ).updates,
    ).toMatchObject({ enabled: false });
  });

  it("leaves Clerk's iOS capabilities out while T3 Connect is off, even with a key", async () => {
    const config = await loadConfig({ EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: OWNER_CLERK_KEY });

    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(clerkPlugin(config)?.appleSignIn).toBe(false);
  });

  it("entitles the owner's Clerk domain once T3 Connect is on with their key", async () => {
    const config = await loadConfig({ EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: OWNER_CLERK_KEY }, true);

    expect(config.ios?.associatedDomains).toEqual([
      "applinks:clerk.example.com",
      "webcredentials:clerk.example.com",
    ]);
    expect(clerkPlugin(config)?.appleSignIn).toBe(true);
  });

  it("keeps the owner's Personal Team build signable without Sign in with Apple", async () => {
    const config = await loadConfig(
      {
        T3CODE_IOS_PERSONAL_TEAM: "1",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "org.zanson.t3code",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: OWNER_CLERK_KEY,
      },
      true,
    );

    expect(config.name).toBe("Z6 Code");
    expect(config.ios?.bundleIdentifier).toBe("org.zanson.t3code");
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(clerkPlugin(config)?.appleSignIn).toBe(false);
  });
});
