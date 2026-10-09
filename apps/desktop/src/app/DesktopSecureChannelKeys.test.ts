import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSecureChannelKeys from "./DesktopSecureChannelKeys.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function layerFor(baseDir: string, encryptionAvailable: boolean | (() => boolean)) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const safeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.sync(() =>
      typeof encryptionAvailable === "function" ? encryptionAvailable() : encryptionAvailable,
    ),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`sealed:${value}`)),
    decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("sealed:".length)),
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
  return DesktopSecureChannelKeys.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environment, safeStorage, NodeServices.layer)),
  );
}

/** Runs `use` against a fresh service each time, as each app launch gets. */
const launches =
  (baseDir: string, encryptionAvailable = true) =>
  <A, E>(use: Effect.Effect<A, E, DesktopSecureChannelKeys.DesktopSecureChannelKeys>) =>
    use.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));

const withTempDir = <A, E, R>(use: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* use(yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-channel-keys-" }));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const keyFor = (keyId: string) =>
  DesktopSecureChannelKeys.DesktopSecureChannelKeys.pipe(
    Effect.flatMap((keys) => keys.keyFor(keyId)),
  );

describe("DesktopSecureChannelKeys", () => {
  it.effect("gives an id the same key on every launch, and each id its own", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const launch = launches(baseDir);
        const keyId = yield* launch(
          DesktopSecureChannelKeys.DesktopSecureChannelKeys.pipe(
            Effect.flatMap((keys) => keys.createKeyId),
          ),
        );
        const first = yield* launch(keyFor(keyId));
        assert.strictEqual(yield* launch(keyFor(keyId)), first);
        assert.notStrictEqual(yield* launch(keyFor("another-route")), first);
        assert.strictEqual(Buffer.from(first, "base64url").length, 32);
        assert.notInclude(first, keyId);
      }),
    ),
  );

  it.effect("keeps the master secret sealed on disk", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        yield* launches(baseDir)(keyFor("route"));
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = yield* fileSystem.readDirectory(path.join(baseDir, "userdata"), {
          recursive: true,
        });
        const saved = files.find((file) => file.endsWith("secure-channel-keys.json"));
        assert.isDefined(saved);
        const raw = yield* fileSystem.readFileString(path.join(baseDir, "userdata", saved!));
        assert.include(
          Buffer.from(JSON.parse(raw).encryptedSecret, "base64").toString(),
          "sealed:",
        );
      }),
    ),
  );

  it.effect(
    "refuses route keys without secure storage, instead of changing them every launch",
    () =>
      withTempDir((baseDir) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(launches(baseDir, false)(keyFor("route")));
          assert.include(failure.message, "system keychain");
        }),
      ),
  );

  it.effect("tries the keychain again after it was unavailable, within one launch", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        let unlocked = false;
        yield* Effect.gen(function* () {
          yield* Effect.flip(keyFor("route"));
          unlocked = true;
          const key = yield* keyFor("route");
          assert.strictEqual(Buffer.from(key, "base64url").length, 32);
        }).pipe(Effect.provide(layerFor(baseDir, () => unlocked)));
      }),
    ),
  );
});
