// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  BOB_SSO_REFRESH_MESSAGE,
  bobProfileToUsage,
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

it.layer(NodeServices.layer)("readBobUsageLimits", (it) => {
  const makeBobHome = (secrets: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-home-" });
      yield* fs.makeDirectory(NodePath.join(home, ".bob", "settings"), { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(home, ".bob", "settings", "auth-secrets.json"),
        secrets,
      );
      return home;
    });
  const profileResponse = (
    assertRequest: (url: string, authorization: string | undefined) => void,
  ) =>
    HttpClient.make((request) => {
      assertRequest(request.url, request.headers.authorization);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(profile)));
    });
  const noRequests = HttpClient.make(() => Effect.die("must not call the gateway"));

  it.effect("sends the stored SSO token for the configured gateway as a bearer", () =>
    Effect.gen(function* () {
      const home = yield* makeBobHome(
        bobAuthSecrets({
          "bob.auth.tokens-https://api.us-east.bob.ibm.com": {
            token: "wrong-gateway",
            refreshToken: "refresh",
            userId: "user-1",
            expiresAt: unexpired,
          },
          "bob.auth.tokens-https://gateway.example": {
            token: "session-jwt",
            accessToken: "idp-token",
            refreshToken: "refresh",
            userId: "user-1",
            expiresAt: unexpired,
          },
          "bob.profile.active": "instance-1:team-2",
        }),
      );
      const usage = yield* readBobUsageLimits("sso", {
        HOME: home,
        BOB_GATEWAY_URL: "https://gateway.example//",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          profileResponse((url, authorization) => {
            expect(url).toBe("https://gateway.example/admin/v1/profile");
            expect(authorization).toBe("Bearer session-jwt");
          }),
        ),
      );
      expect(usage.plan).toBe("trial plan");
      expect(usage.usageLimits.windows[0]?.usedPercent).toBe(75);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the API key without reading the stored login", () =>
    readBobUsageLimits("apiKey", { HOME: "/nonexistent", BOBSHELL_API_KEY: "key-1" }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        profileResponse((url, authorization) => {
          expect(url).toBe("https://api.us-east.bob.ibm.com/admin/v1/profile");
          expect(authorization).toBe("apikey key-1");
        }),
      ),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.die("must not read the login") }),
      ),
      Effect.tap((usage) => Effect.sync(() => expect(usage.usageLimits.windows).toHaveLength(1))),
    ),
  );

  it.effect("leaves a missing or expired SSO login to Bob without calling the gateway", () =>
    Effect.gen(function* () {
      for (const secrets of [
        "{}",
        bobAuthSecrets({
          "bob.auth.tokens-https://api.us-east.bob.ibm.com": {
            token: "expired-jwt",
            refreshToken: "refresh",
            userId: "user-1",
            expiresAt: 1,
          },
        }),
      ]) {
        const home = yield* makeBobHome(secrets);
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
