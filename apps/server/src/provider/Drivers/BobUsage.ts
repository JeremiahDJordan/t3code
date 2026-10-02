/**
 * BobUsage - Bob's usage history as a usage source.
 *
 * Bob keeps its history in one task database per home rather than in
 * transcripts. Every account counts, disabled ones too, and accounts that
 * share a home read its database once.
 *
 * @module provider/Drivers/BobUsage
 */
import type { BobSettings } from "@t3tools/contracts";
import type { ProviderUsageReader, ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveBobTaskDatabasePath } from "../bobTaskUsage.ts";
import { readBobUsage } from "./bobUsageReader.ts";

export const bobUsageReader: ProviderUsageReader<BobSettings, FileSystem.FileSystem | Path.Path> = {
  kind: "scan",
  provider: "bob",
  scan: ({ instances, windowStartMs }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databases = new Set<string>();
      for (const instance of instances) {
        const databasePath = resolveBobTaskDatabasePath(instance.environment, path);
        databases.add(
          yield* fileSystem.realPath(databasePath).pipe(Effect.orElseSucceed(() => databasePath)),
        );
      }
      return yield* Effect.forEach(
        [...databases],
        (databasePath) =>
          Effect.promise(() => readBobUsage(databasePath, windowStartMs)).pipe(
            Effect.map((result): ProviderUsageScan => ({
              dir: databasePath,
              files: result.missing && !result.error ? null : result.files,
              status: result.error ? "partial" : "ok",
              ...(result.error ? { message: "Some Bob history could not be read." } : {}),
            })),
          ),
        { concurrency: "unbounded" },
      );
    }),
};
