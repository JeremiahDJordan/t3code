import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveBaseDir } from "./os-jank.ts";

/** A home holding a T3 Code `~/.t3` with one setting, for `resolveBaseDir` to find. */
const withT3Home = <A, E>(
  body: (home: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-base-dir-" });
    yield* fs.makeDirectory(path.join(home, ".t3", "userdata"), { recursive: true });
    yield* fs.writeFileString(path.join(home, ".t3", "userdata", "settings.json"), "{}");
    return yield* body(home).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("defaults to Z6 Code's home, copied once from T3 Code's", () =>
  withT3Home((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const z6Home = path.join(home, ".z6");

      assert.equal(yield* resolveBaseDir(undefined), z6Home);
      assert.isTrue(yield* fs.exists(path.join(z6Home, "userdata", "settings.json")));
      assert.isTrue(yield* fs.exists(path.join(z6Home, "migrated-from-t3.json")));
    }),
  ),
);

it.effect("uses an explicit home as is, copying nothing", () =>
  withT3Home((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const explicit = path.join(home, "elsewhere");

      assert.equal(yield* resolveBaseDir(explicit), explicit);
      assert.equal(yield* resolveBaseDir("   "), path.join(home, ".z6"));
      assert.isFalse(yield* fs.exists(explicit));
    }),
  ),
);

it.effect("leaves a missing home missing when asked not to copy", () =>
  withT3Home((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      assert.equal(
        yield* resolveBaseDir(undefined, { migrateFromT3: false }),
        path.join(home, ".z6"),
      );
      assert.isFalse(yield* fs.exists(path.join(home, ".z6")));
    }),
  ),
);
