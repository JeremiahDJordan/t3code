import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { readChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * The V1 profile is only read, never opened by Chromium, so this works while V1
 * is still running.
 */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLegacyLocalStorage") {}

const MARKER_FILE_NAME = "v1-local-storage-imported";
/**
 * Fork: the page's origin moved from upstream's `t3code://app` to `z6code://app`. A profile copied
 * from T3 Code keeps its storage under the old origin, so it is imported once, like V1's.
 */
const UPSTREAM_ORIGIN = "t3code://app";
const UPSTREAM_ORIGIN_MARKER_FILE_NAME = "upstream-origin-local-storage-imported";
const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const items = yield* Ref.make(Option.none<Readonly<Record<string, string>>>());
  const markerPath = yield* Ref.make(Option.none<string>());

  /** Newest file mtime in a directory; appending to a log leaves the directory's own mtime alone. */
  const newestFileMtime = (directory: string) =>
    Effect.gen(function* () {
      let newest = 0;
      for (const name of yield* fs.readDirectory(directory)) {
        const info = yield* fs.stat(path.join(directory, name)).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const mtime = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        newest = Math.max(newest, mtime);
      }
      return newest;
    }).pipe(Effect.option);

  const findV1LocalStorage = Effect.gen(function* () {
    let newest: { readonly directory: string; readonly mtime: number } | null = null;
    for (const name of V1_PROFILE_NAMES) {
      const directory = path.join(environment.appDataDirectory, name, "Local Storage", "leveldb");
      const mtime = yield* newestFileMtime(directory);
      if (Option.isNone(mtime)) continue;
      if (newest === null || mtime.value > newest.mtime) newest = { directory, mtime: mtime.value };
    }
    return newest?.directory ?? null;
  });

  const writeMarker = Effect.gen(function* () {
    const marker = yield* Ref.get(markerPath);
    if (Option.isNone(marker)) return;
    yield* fs
      .writeFileString(marker.value, "")
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not record the V1 Local Storage import", error),
        ),
      );
  });

  /** The profile's own storage under upstream's origin, read before Chromium opens it. */
  const loadUpstreamOrigin = Effect.fn("desktop.legacyLocalStorage.loadUpstreamOrigin")(function* (
    userDataPath: string,
  ) {
    const marker = path.join(userDataPath, UPSTREAM_ORIGIN_MARKER_FILE_NAME);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return false;
    yield* Ref.set(markerPath, Option.some(marker));
    const directory = path.join(userDataPath, "Local Storage", "leveldb");
    if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) {
      yield* writeMarker;
      return false;
    }
    const read = yield* readChromiumLocalStorage(directory, UPSTREAM_ORIGIN).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError((error) =>
        Effect.logWarning("Could not read T3 Code's Local Storage; will retry next launch", error),
      ),
      Effect.option,
    );
    if (Option.isNone(read)) return true;
    if (read.value.size === 0) {
      yield* writeMarker;
      return false;
    }
    yield* Effect.logInfo("T3 Code's Local Storage ready to import", { keys: read.value.size });
    yield* Ref.set(items, Option.some(Object.fromEntries(read.value)));
    return true;
  });

  const load = Effect.fn("desktop.legacyLocalStorage.load")(function* (userDataPath: string) {
    if (environment.isDevelopment) return;
    // One import per launch; the V1 one runs on a later launch if it is still due.
    if (yield* loadUpstreamOrigin(userDataPath)) return;
    const marker = path.join(userDataPath, MARKER_FILE_NAME);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return;
    yield* Ref.set(markerPath, Option.some(marker));
    const directory = yield* findV1LocalStorage;
    if (directory === null) return yield* writeMarker;
    // V1 profiles predate the fork, so their storage is under upstream's origin.
    const read = yield* readChromiumLocalStorage(directory, UPSTREAM_ORIGIN).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError((error) =>
        Effect.logWarning("Could not read V1 Local Storage; will retry next launch", error),
      ),
      Effect.option,
    );
    if (Option.isNone(read)) return;
    yield* Effect.logInfo("V1 Local Storage ready to import", {
      directory,
      keys: read.value.size,
    });
    yield* Ref.set(items, Option.some(Object.fromEntries(read.value)));
  });

  return DesktopLegacyLocalStorage.of({
    load,
    take: Ref.getAndSet(items, Option.none()),
    complete: writeMarker,
  });
});

export const layer = Layer.effect(DesktopLegacyLocalStorage, make);
