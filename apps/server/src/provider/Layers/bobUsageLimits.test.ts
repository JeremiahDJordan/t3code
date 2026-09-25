// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write the raw JSON files and output Bob produces.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  readBobConfiguredModel,
  BOB_SSO_REFRESH_MESSAGE,
  bobPinnedTeamUsage,
  bobProfileToUsage,
  readBobPinnedTeams,
  readBobUsageLimits,
} from "./bobUsageLimits.ts";

const checkedAt = "2026-09-24T10:00:00.000Z";

/** `auth-secrets.json` as Bob writes it: each login is a JSON string under its gateway key. */
function bobAuthSecrets(entries: Record<string, Record<string, unknown> | string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    ),
  );
}

/** 2100-01-01, in the Unix seconds Bob stores. */
const unexpired = 4_102_444_800;

const profile = {
  user_id: "user-1",
  instances: [
    { instance_id: "empty", plan_name: "no teams", teams: [] },
    {
      instance_id: "instance-1",
      subscription_id: "subscription-1",
      plan_id: "ibm_bob_trial",
      plan_name: "trial plan",
      teams: [
        { id: "team-1", name: "Personal", usage: 0.689, budget_limit: 50 },
        { id: "team-2", name: "Other", usage: 30, budget_limit: 40 },
      ],
    },
  ],
};

describe("bobProfileToUsage", () => {
  it("maps the first team's Bobcoins to a monthly window and names the plan", () => {
    expect(bobProfileToUsage(profile, undefined, checkedAt)).toEqual({
      plan: "trial plan",
      usageLimits: {
        checkedAt,
        windows: [
          { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: (0.689 / 50) * 100 },
        ],
      },
    });
  });

  it("follows the team last picked in Bob", () => {
    expect(
      bobProfileToUsage(profile, "instance-1:team-2", checkedAt).usageLimits.windows[0]
        ?.usedPercent,
    ).toBe(75);
  });

  it("reports an unlimited budget as unsupported but keeps the plan", () => {
    const usage = bobProfileToUsage(
      { instances: [{ plan_id: "ibm_bob_enterprise", teams: [{ usage: 3, budget_limit: null }] }] },
      undefined,
      checkedAt,
    );
    expect(usage.plan).toBe("enterprise");
    expect(usage.usageLimits.windows).toEqual([]);
    expect(usage.usageLimits.unavailable?.reason).toBe("unsupported");
  });

  it("reports an account without teams as unsupported", () => {
    expect(bobProfileToUsage({ instances: [] }, undefined, checkedAt)).toEqual({
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    });
  });
});

describe("bobPinnedTeamUsage", () => {
  it("follows the first pinned team the user belongs to, named by its subscription", () => {
    expect(
      bobPinnedTeamUsage(
        profile,
        ["subscription-9:team-1", "subscription-1:team-2", "subscription-1:team-1"],
        checkedAt,
      )?.usageLimits.windows[0]?.usedPercent,
    ).toBe(75);
    // Pins name the subscription, not the instance id Bob's last pick uses.
    expect(bobPinnedTeamUsage(profile, ["instance-1:team-2"], checkedAt)).toBeUndefined();
    expect(bobPinnedTeamUsage(profile, [], checkedAt)).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("readBobPinnedTeams", (it) => {
  it.effect("reads the teams a folder pins in its Bob settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-pins-" });
      expect(yield* readBobPinnedTeams(folder)).toEqual([]);

      yield* fs.makeDirectory(NodePath.join(folder, ".bob"));
      const settings = NodePath.join(folder, ".bob", "settings.json");
      yield* fs.writeFileString(
        settings,
        JSON.stringify({ session: { pinnedTeams: ["sub-1:team-1", 7, " sub-2:team-2 "] } }),
      );
      expect(yield* readBobPinnedTeams(folder)).toEqual(["sub-1:team-1", "sub-2:team-2"]);

      yield* fs.writeFileString(settings, "not json");
      expect(yield* readBobPinnedTeams(folder)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("readBobUsageLimits", (it) => {
  /** A home directory holding the files Bob keeps in `~/.bob/settings`, by name. */
  const makeBobHome = (files: Record<string, string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-home-" });
      yield* fs.makeDirectory(NodePath.join(home, ".bob", "settings"), { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        yield* fs.writeFileString(NodePath.join(home, ".bob", "settings", name), contents);
      }
      return home;
    });
  const login = (token: string) => ({
    token,
    refreshToken: "refresh",
    userId: "user-1",
    expiresAt: unexpired,
  });
  const profileResponse = (
    assertRequest: (url: string, authorization: string | undefined) => void,
  ) =>
    HttpClient.make((request) => {
      assertRequest(request.url, request.headers.authorization);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(profile)));
    });
  const noRequests = HttpClient.make(() => Effect.die("must not call the gateway"));

  it.effect("sends the stored SSO token for BOB_GATEWAY_URL, normalized, as a bearer", () =>
    Effect.gen(function* () {
      const home = yield* makeBobHome({
        "auth-secrets.json": bobAuthSecrets({
          "bob.auth.tokens-https://api.us-east.bob.ibm.com": login("wrong-gateway"),
          "bob.auth.tokens-https://gateway.example/bob": {
            ...login("session-jwt"),
            accessToken: "idp-token",
          },
          "bob.profile.active": "instance-1:team-2",
        }),
      });
      const usage = yield* readBobUsageLimits("sso", {
        HOME: home,
        BOB_GATEWAY_URL: "https://gateway.example//bob/",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          profileResponse((url, authorization) => {
            expect(url).toBe("https://gateway.example/bob/admin/v1/profile");
            expect(authorization).toBe("Bearer session-jwt");
          }),
        ),
      );
      expect(usage.plan).toBe("trial plan");
      expect(usage.usageLimits.windows[0]?.usedPercent).toBe(75);
    }).pipe(Effect.scoped),
  );

  // Bob applies its `gatewayUrl` setting over the environment when it starts, keying the
  // login by the setting as written and normalizing it only for requests.
  it.effect("reads the model Bob's settings pin, ignoring an unset or malformed one", () =>
    Effect.gen(function* () {
      const pinned = yield* makeBobHome({
        "settings.json": JSON.stringify({ session: { model: " wxO-model " } }),
      });
      expect(yield* readBobConfiguredModel({ HOME: pinned })).toBe("wxO-model");
      for (const settings of [{}, { session: {} }, { session: { model: 7 } }, { session: "x" }]) {
        const home = yield* makeBobHome({ "settings.json": JSON.stringify(settings) });
        expect(yield* readBobConfiguredModel({ HOME: home })).toBeUndefined();
      }
      const broken = yield* makeBobHome({ "settings.json": "not json" });
      expect(yield* readBobConfiguredModel({ HOME: broken })).toBeUndefined();
      expect(yield* readBobConfiguredModel({ HOME: "/nonexistent" })).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("prefers the gateway in Bob's settings over BOB_GATEWAY_URL", () =>
    Effect.gen(function* () {
      const home = yield* makeBobHome({
        "settings.json": JSON.stringify({ gatewayUrl: "https://settings.example/" }),
        "auth-secrets.json": bobAuthSecrets({
          "bob.auth.tokens-https://env.example": login("env-jwt"),
          "bob.auth.tokens-https://settings.example": login("normalized-jwt"),
          "bob.auth.tokens-https://settings.example/": login("settings-jwt"),
        }),
      });
      const usage = yield* readBobUsageLimits("sso", {
        HOME: home,
        BOB_GATEWAY_URL: "https://env.example",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          profileResponse((url, authorization) => {
            expect(url).toBe("https://settings.example/admin/v1/profile");
            expect(authorization).toBe("Bearer settings-jwt");
          }),
        ),
      );
      expect(usage.usageLimits.windows).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to IBM's gateway when Bob's settings name none", () =>
    Effect.gen(function* () {
      for (const settings of [
        undefined,
        "not json",
        "[]",
        JSON.stringify({ gatewayUrl: "" }),
        JSON.stringify({ gatewayUrl: 42 }),
      ]) {
        const home = yield* makeBobHome({
          ...(settings === undefined ? {} : { "settings.json": settings }),
          "auth-secrets.json": bobAuthSecrets({
            "bob.auth.tokens-https://api.us-east.bob.ibm.com": login("default-jwt"),
          }),
        });
        const usage = yield* readBobUsageLimits("sso", { HOME: home }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            profileResponse((url, authorization) => {
              expect(url).toBe("https://api.us-east.bob.ibm.com/admin/v1/profile");
              expect(authorization).toBe("Bearer default-jwt");
            }),
          ),
        );
        expect(usage.usageLimits.windows).toHaveLength(1);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("sends the API key to Bob's gateway without reading the stored login", () =>
    readBobUsageLimits("apiKey", { HOME: "/nonexistent", BOBSHELL_API_KEY: "key-1" }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        profileResponse((url, authorization) => {
          expect(url).toBe("https://settings.example/admin/v1/profile");
          expect(authorization).toBe("apikey key-1");
        }),
      ),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) =>
            path.endsWith("settings.json")
              ? Effect.succeed(JSON.stringify({ gatewayUrl: "https://settings.example//" }))
              : Effect.die("must not read the login"),
        }),
      ),
      Effect.tap((usage) => Effect.sync(() => expect(usage.usageLimits.windows).toHaveLength(1))),
    ),
  );

  it.effect("leaves a missing, unreadable or expired SSO login to Bob without a request", () =>
    Effect.gen(function* () {
      for (const files of [
        {},
        { "auth-secrets.json": "{}" },
        { "auth-secrets.json": "not json" },
        {
          "auth-secrets.json": bobAuthSecrets({
            "bob.auth.tokens-https://api.us-east.bob.ibm.com": { accessToken: "jwt" },
          }),
        },
        {
          "auth-secrets.json": bobAuthSecrets({
            "bob.auth.tokens-https://api.us-east.bob.ibm.com": {
              ...login("expired-jwt"),
              expiresAt: 1,
            },
          }),
        },
      ]) {
        const home = yield* makeBobHome(files);
        const usage = yield* readBobUsageLimits("sso", { HOME: home }).pipe(
          Effect.provideService(HttpClient.HttpClient, noRequests),
        );
        expect(usage.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: BOB_SSO_REFRESH_MESSAGE,
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed profile request as a failed probe", () =>
    readBobUsageLimits("apiKey", { BOB_API_KEY: "key-1" }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("no", { status: 401 }))),
        ),
      ),
      Effect.tap((usage) =>
        Effect.sync(() => expect(usage.usageLimits.unavailable?.reason).toBe("probeFailed")),
      ),
    ),
  );
});
