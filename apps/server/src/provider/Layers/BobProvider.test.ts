// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write the raw JSON files and output Bob produces.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { BOB_DEFAULT_MODEL, BobSettings } from "@t3tools/contracts";

import { BOB_API_KEY_REQUIRED_MESSAGE } from "../acp/BobAcpSupport.ts";
import {
  BOB_SSO_UNCONFIRMED_MESSAGE,
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
} from "./BobProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

/** `auth-secrets.json` as Bob writes it: the login is a JSON string under a gateway key. */
function bobAuthSecrets(
  login: Record<string, unknown>,
  gatewayUrl = "https://api.us-east.bob.ibm.com",
): string {
  return JSON.stringify({ [`bob.auth.tokens-${gatewayUrl}`]: JSON.stringify(login) });
}

describe("buildInitialBobProviderSnapshot", () => {
  it.effect("is disabled by default because Bob is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialBobProviderSnapshot(decodeBobSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("offers Bob's configured model ahead of custom models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialBobProviderSnapshot(
        decodeBobSettings({ enabled: true, customModels: ["granite-custom"] }),
      );
      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        [BOB_DEFAULT_MODEL, false],
        ["granite-custom", true],
      ]);
    }),
  );
});

it.layer(NodeServices.layer)("checkBobProviderStatus", (it) => {
  // A stand-in for `bob --version`, which prints the version and then a commit line.
  const writeFakeBobCli = (source: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-probe-" });
      return writeFakeCli({ directory, name: "bob", source });
    });
  const BOB_VERSION_SOURCE = [
    'if (process.argv[2] !== "--version") process.exit(9);',
    // Bob exits when both key variables disagree; SSO instances must not pass them at all.
    "if (process.env.BOB_API_KEY && process.env.BOBSHELL_API_KEY) process.exit(1);",
    'process.stdout.write("2.0.4\\ncommit: 01dddf684\\n");',
    "",
  ].join("\n");
  /** A home directory holding the files Bob keeps in `~/.bob/settings`, by name. */
  const makeBobHome = (files: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-home-" });
      yield* fs.makeDirectory(NodePath.join(home, ".bob", "settings"), { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        yield* fs.writeFileString(NodePath.join(home, ".bob", "settings", name), contents);
      }
      return home;
    });
  /** 2100-01-01, in the Unix seconds Bob stores. */
  const unexpired = 4_102_444_800;

  it.effect("reports the binary as missing when it does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath: "/definitely/not/installed/bob" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reads the stored SSO login and ignores API keys in the environment", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      for (const login of [
        { token: "jwt", refreshToken: "refresh", userId: "user", expiresAt: unexpired },
        // Bob renews an expired login itself when the next session starts.
        { token: "jwt", refreshToken: "refresh", userId: "user", expiresAt: 1 },
      ]) {
        const home = yield* makeBobHome({ "auth-secrets.json": bobAuthSecrets(login) });
        const snapshot = yield* checkBobProviderStatus(
          decodeBobSettings({ enabled: true, binaryPath: bobPath }),
          { ...process.env, HOME: home, BOB_API_KEY: "one", BOBSHELL_API_KEY: "two" },
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({ status: "authenticated", type: "sso", label: "IBM SSO" });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reads the login stored for the gateway in Bob's settings", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      const home = yield* makeBobHome({
        "settings.json": JSON.stringify({ gatewayUrl: "https://gateway.example" }),
        "auth-secrets.json": bobAuthSecrets(
          { token: "jwt", refreshToken: "refresh", userId: "user", expiresAt: unexpired },
          "https://gateway.example",
        ),
      });
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath: bobPath }),
        { ...process.env, HOME: home },
      );
      expect(snapshot.auth.status).toBe("authenticated");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps Bob selectable when its SSO login can't be confirmed", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      for (const files of [
        {},
        { "auth-secrets.json": "{}" },
        { "auth-secrets.json": "not json" },
        { "auth-secrets.json": JSON.stringify({ "bob.auth.tokens-v2": { token: "jwt" } }) },
        // A login in a shape T3 does not know.
        { "auth-secrets.json": bobAuthSecrets({ accessToken: "jwt", expires: unexpired }) },
        // Bob cannot renew an expired SAML login, but it reports that itself.
        {
          "auth-secrets.json": bobAuthSecrets({
            token: "jwt",
            refreshToken: "",
            userId: "user",
            expiresAt: 1,
          }),
        },
      ]) {
        const home = yield* makeBobHome(files);
        const snapshot = yield* checkBobProviderStatus(
          decodeBobSettings({ enabled: true, binaryPath: bobPath }),
          { ...process.env, HOME: home },
        );
        expect(snapshot.version).toBe("2.0.4");
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.message).toBe(BOB_SSO_UNCONFIRMED_MESSAGE);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("asks for BOB_API_KEY when the instance signs in with an API key", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath: bobPath, authMethod: "apiKey" }),
        { ...process.env, BOB_API_KEY: "", BOBSHELL_API_KEY: "" },
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toBe(BOB_API_KEY_REQUIRED_MESSAGE);
    }).pipe(Effect.scoped),
  );

  it.effect("treats BOB_API_KEY or its BOBSHELL_API_KEY alias as signed in", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      for (const keys of [
        { BOB_API_KEY: "test-key", BOBSHELL_API_KEY: "" },
        { BOB_API_KEY: "", BOBSHELL_API_KEY: "test-key" },
      ]) {
        const snapshot = yield* checkBobProviderStatus(
          decodeBobSettings({ enabled: true, binaryPath: bobPath, authMethod: "apiKey" }),
          { ...process.env, ...keys },
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "api_key",
          label: "Bob API key",
        });
        expect(snapshot.message).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reports conflicting API keys, which stop Bob from starting", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(BOB_VERSION_SOURCE);
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath: bobPath, authMethod: "apiKey" }),
        { ...process.env, BOB_API_KEY: "one", BOBSHELL_API_KEY: "two" },
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Unset BOBSHELL_API_KEY");
    }).pipe(Effect.scoped),
  );

  it.effect("reports an installed but failing CLI as an error", () =>
    Effect.gen(function* () {
      const bobPath = yield* writeFakeBobCli(
        'process.stderr.write("boom\\n");\nprocess.exit(2);\n',
      );
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath: bobPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Bob Shell is installed but failed to run.");
    }).pipe(Effect.scoped),
  );
});
