// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write the raw JSON files and output Bob produces.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  BOB_DEFAULT_MODEL,
  BobSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { BOB_API_KEY_REQUIRED_MESSAGE } from "../acp/BobAcpSupport.ts";
import { ProviderVersionCache } from "../providerMaintenance.ts";
import {
  BOB_SSO_UNCONFIRMED_MESSAGE,
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  enrichBobSnapshot,
  makeBobCommandCatalog,
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

  it.effect("offers only Bob's configured model, since Bob can't switch to a custom one", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialBobProviderSnapshot(
        decodeBobSettings({ enabled: true, customModels: ["granite-custom"] }),
      );
      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        [BOB_DEFAULT_MODEL, false],
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

/** A signed-in Bob 2.0.4, as the status check reports it. */
const makeReadyBobSnapshot = Effect.map(
  buildInitialBobProviderSnapshot(decodeBobSettings({ enabled: true })),
  (draft): ServerProvider => ({
    ...draft,
    instanceId: ProviderInstanceId.make("bob"),
    driver: ProviderDriverKind.make("bob"),
    installed: true,
    version: "2.0.4",
    status: "ready",
  }),
);

describe("Bob command catalog", () => {
  it.effect("keeps each workspace's commands from Bob's sessions, without /compact", () =>
    Effect.gen(function* () {
      const base = yield* makeReadyBobSnapshot;
      const catalog = yield* makeBobCommandCatalog({
        getSnapshot: Effect.succeed(base),
        refresh: Effect.succeed(base),
        streamChanges: Stream.empty,
        resolveMaintenance: () => Effect.die("Not used"),
        applyUsageLimits: () => Effect.void,
      });

      // Before a session there, a workspace has no commands to offer.
      const unopened = yield* catalog.snapshotForCwd("/unopened");
      expect(unopened.slashCommands).toEqual([]);
      expect(unopened.skills).toEqual([]);

      yield* catalog.onAvailableCommands(
        [
          { name: "create-skill", description: "Create a skill", input: { hint: "name" } },
          { name: "github:review", description: "Review a pull request" },
          { name: "compact", description: "Not a Bob command" },
          { name: "create-skill", description: "Duplicate" },
          { name: "two words", description: "Cannot be sent as a command" },
        ],
        "/one",
      );
      yield* catalog.onAvailableCommands([{ name: "init", description: "" }], "/two");

      const one = yield* catalog.snapshotForCwd("/one");
      expect(one.slashCommands).toEqual([
        { name: "create-skill", description: "Create a skill", input: { hint: "name" } },
        { name: "github:review", description: "Review a pull request" },
      ]);
      // Bob does not expand `$skill` mentions, so its skills are only commands.
      expect(one.skills).toEqual([]);
      expect(one.workspaceSnapshots?.map((entry) => entry.cwd)).toEqual([
        "/unopened",
        "/two",
        "/one",
      ]);
      // Commands belong to their workspace; the machine-wide list stays empty.
      const published = yield* catalog.snapshot.streamChanges.pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      const latest = Array.from(published)[0];
      expect(latest?.slashCommands).toEqual([]);
      expect(
        latest?.workspaceSnapshots?.find((entry) => entry.cwd === "/two")?.slashCommands,
      ).toEqual([{ name: "init" }]);

      // A later report replaces the workspace's list, as after Bob switches modes.
      yield* catalog.onAvailableCommands([], "/one");
      const refreshed = yield* catalog.snapshot.refresh;
      expect(
        refreshed.workspaceSnapshots?.find((entry) => entry.cwd === "/one")?.slashCommands,
      ).toEqual([]);
    }),
  );

  it.effect("keeps the snapshot as it was when Bob repeats a workspace's commands", () =>
    Effect.gen(function* () {
      const base = yield* makeReadyBobSnapshot;
      const catalog = yield* makeBobCommandCatalog({
        getSnapshot: Effect.succeed(base),
        refresh: Effect.succeed(base),
        streamChanges: Stream.empty,
        resolveMaintenance: () => Effect.die("Not used"),
        applyUsageLimits: () => Effect.void,
      });
      const commands = [{ name: "init", description: "Set up the project" }];
      yield* catalog.onAvailableCommands(commands, "/one");
      const reported = yield* catalog.snapshot.getSnapshot;

      // Bob sends the same list again on every plan/agent switch. The registry publishes only
      // a snapshot that differs, so an identical one reaches no client.
      yield* TestClock.adjust("1 minute");
      yield* catalog.onAvailableCommands(commands, "/one");
      expect(yield* catalog.snapshot.getSnapshot).toEqual(reported);

      // A different list is still recorded.
      yield* TestClock.adjust("1 minute");
      yield* catalog.onAvailableCommands([], "/one");
      const changed = yield* catalog.snapshot.getSnapshot;
      expect(changed.workspaceSnapshots?.[0]?.slashCommands).toEqual([]);
      expect(changed.workspaceSnapshots?.[0]?.checkedAt).not.toBe(
        reported.workspaceSnapshots?.[0]?.checkedAt,
      );
    }),
  );

  it.effect("keeps a pinned team's limits for its workspace alongside the commands", () =>
    Effect.gen(function* () {
      const base = yield* makeReadyBobSnapshot;
      const catalog = yield* makeBobCommandCatalog({
        getSnapshot: Effect.succeed(base),
        refresh: Effect.succeed(base),
        streamChanges: Stream.empty,
        resolveMaintenance: () => Effect.die("Not used"),
        applyUsageLimits: () => Effect.void,
      });
      const pinned = {
        checkedAt: "2026-09-24T10:00:00.000Z",
        windows: [{ id: "monthly", kind: "monthly" as const, label: "Monthly", usedPercent: 75 }],
      };
      /** The limits the snapshot keeps for `cwd`. */
      const limitsOf = (cwd: string) =>
        catalog.snapshot.getSnapshot.pipe(
          Effect.map(
            (snapshot) =>
              snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.usageLimits,
          ),
        );

      // A folder without a pin adds nothing.
      yield* catalog.setWorkspaceUsageLimits("/unpinned", undefined);
      expect((yield* catalog.snapshot.getSnapshot).workspaceSnapshots).toBeUndefined();

      yield* catalog.setWorkspaceUsageLimits("/pinned", pinned);
      // New commands for the folder keep its limits.
      yield* catalog.onAvailableCommands([{ name: "init", description: "" }], "/pinned");
      expect(yield* limitsOf("/pinned")).toEqual(pinned);

      // Removing the pin brings back the instance's limits.
      yield* catalog.setWorkspaceUsageLimits("/pinned", undefined);
      expect(yield* limitsOf("/pinned")).toBeUndefined();
    }),
  );

  it.effect("offers Bob's modes, other than Plan, as the model's Mode option", () =>
    Effect.gen(function* () {
      const base = yield* makeReadyBobSnapshot;
      const catalog = yield* makeBobCommandCatalog({
        getSnapshot: Effect.succeed(base),
        refresh: Effect.succeed(base),
        streamChanges: Stream.empty,
        resolveMaintenance: () => Effect.die("Not used"),
        applyUsageLimits: () => Effect.void,
      });
      /** The Mode option's choices on Bob's model, if it has the option. */
      const modeChoices = catalog.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) => {
          const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
            (candidate) => candidate.id === "mode",
          );
          return descriptor?.type === "select"
            ? descriptor.options.map((choice) => choice.id)
            : undefined;
        }),
      );
      const agent = { id: "agent", name: "Agent" };
      const plan = { id: "plan", name: "Plan" };

      // Plan belongs to T3's Plan toggle, so Agent alone is no choice.
      yield* catalog.onAvailableModes([agent, plan], "/one");
      expect(yield* modeChoices).toBeUndefined();

      // Custom modes can belong to one project; the option lists every project's.
      yield* catalog.onAvailableModes(
        [agent, plan, { id: "ask", name: "Ask" }, { id: "reviewer", name: "Reviewer" }],
        "/one",
      );
      yield* catalog.onAvailableModes([agent, plan, { id: "docs-writer", name: "Docs" }], "/two");
      expect(yield* modeChoices).toEqual(["agent", "ask", "reviewer", "docs-writer"]);
      const descriptor = (yield* catalog.snapshot.getSnapshot).models[0]?.capabilities
        ?.optionDescriptors?.[0];
      expect(descriptor?.type === "select" && descriptor.currentValue).toBe("agent");
    }),
  );
});

describe("enrichBobSnapshot", () => {
  const BOB_VERSION_URL =
    "https://s3.us-south.cloud-object-storage.appdomain.cloud/bob-shell/bobshell2-version.txt";
  const BOB_INSTALL_COMMAND = "curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash";

  /** Serves IBM's version file from `respond`, counting the requests T3 makes. */
  const withVersionFile = <A, E, R>(
    respond: (request: HttpClientRequest.HttpClientRequest) => Response,
    body: (requests: { count: number }) => Effect.Effect<A, E, R>,
  ) => {
    const requests = { count: 0 };
    return body(requests).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.count += 1;
            return HttpClientResponse.fromWeb(request, respond(request));
          }),
        ),
      ),
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(HostProcessPlatform, "darwin"),
    );
  };

  it.effect("offers IBM's installer when IBM has released a newer Bob", () =>
    withVersionFile(
      (request) => {
        expect([request.method, request.url]).toEqual(["GET", BOB_VERSION_URL]);
        return new Response("2.0.5\n");
      },
      (requests) =>
        Effect.gen(function* () {
          const snapshot = yield* makeReadyBobSnapshot;
          const enriched = yield* enrichBobSnapshot(snapshot, true);
          expect(enriched.versionAdvisory).toMatchObject({
            status: "behind_latest",
            currentVersion: "2.0.4",
            latestVersion: "2.0.5",
            updateCommand: BOB_INSTALL_COMMAND,
            // T3 does not run the installer itself.
            canUpdate: false,
          });
          // The release is read once an hour, not on every status check.
          yield* enrichBobSnapshot(snapshot, true);
          expect(requests.count).toBe(1);
        }),
    ),
  );

  it.effect("reports the installed Bob as current when it is the latest release", () =>
    withVersionFile(
      () => new Response("2.0.4"),
      () =>
        Effect.gen(function* () {
          const enriched = yield* enrichBobSnapshot(yield* makeReadyBobSnapshot, true);
          expect(enriched.versionAdvisory?.status).toBe("current");
        }),
    ),
  );

  it.effect("leaves the latest release unknown when IBM's file can't be read", () =>
    Effect.gen(function* () {
      for (const response of [
        () => new Response("Not found", { status: 404 }),
        () => new Response("<html>maintenance</html>"),
      ]) {
        yield* withVersionFile(response, () =>
          Effect.gen(function* () {
            const enriched = yield* enrichBobSnapshot(yield* makeReadyBobSnapshot, true);
            expect(enriched.versionAdvisory).toMatchObject({
              status: "unknown",
              currentVersion: "2.0.4",
              latestVersion: null,
            });
          }),
        );
      }
    }),
  );

  it.effect("does not ask IBM when update checks are off", () =>
    withVersionFile(
      () => new Response("9.9.9"),
      (requests) =>
        Effect.gen(function* () {
          const enriched = yield* enrichBobSnapshot(yield* makeReadyBobSnapshot, false);
          expect(enriched.versionAdvisory).toMatchObject({
            status: "unknown",
            currentVersion: "2.0.4",
          });
          expect(requests.count).toBe(0);
        }),
    ),
  );
});
