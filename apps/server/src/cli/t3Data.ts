import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type T3DataPaths,
  moveToTrash,
  readT3DataState,
  removeT3Data,
} from "@t3tools/shared/t3DataCleanup";
import {
  T3_DESKTOP_USER_DATA_DIRNAME,
  Z6_DESKTOP_USER_DATA_DIRNAME,
  defaultAppDataDirectory,
} from "@t3tools/shared/t3DataMigration";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/cli";

import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

export class CliT3DataError extends Schema.TaggedError<CliT3DataError>()("CliT3DataError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Z6's home, and the desktop folders a Z6 Code app on this machine would use. */
const resolvePaths = Effect.fn("cli.t3Data.paths")(function* (explicit: Option.Option<string>) {
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const z6Home = yield* resolveBaseDir(Option.getOrUndefined(explicit) ?? env.T3CODE_HOME);
  const appData = defaultAppDataDirectory({
    platform: yield* HostProcess.Platform,
    homeDirectory,
    env,
  });
  const paths: T3DataPaths = {
    z6Home,
    z6UserData: path.join(appData, Z6_DESKTOP_USER_DATA_DIRNAME),
  };
  return { paths, homeDirectory, t3UserData: path.join(appData, T3_DESKTOP_USER_DATA_DIRNAME) };
});

const statusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Show which T3 Code folders Z6 Code was copied from, and whether they remain.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { paths } = yield* resolvePaths(flags.baseDir);
      const state = readT3DataState(paths);
      if (state.locations.length === 0) {
        yield* Console.log(
          state.lastCleanup === undefined
            ? "No T3 Code data to remove: this home was not copied from T3 Code, or its folders are gone."
            : `T3 Code's old data was removed on ${state.lastCleanup.at}.`,
        );
        return;
      }
      yield* Console.log("Z6 Code was copied from, and no longer uses:");
      for (const location of state.locations) {
        yield* Console.log(`  ${location.path} (copied ${location.copiedAt})`);
      }
      yield* Console.log("Run `t3 t3-data remove` to move them to the Trash.");
    }),
  ),
);

const removeCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Move the T3 Code folders Z6 Code was copied from to the Trash. Anything Z6 Code still uses, and work in T3's worktrees, scratch and projects folders that is not a clean git checkout, is kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { paths, homeDirectory, t3UserData } = yield* resolvePaths(flags.baseDir);
      const platform = yield* HostProcess.Platform;
      const state = readT3DataState(paths);
      if (state.locations.length === 0) {
        yield* Console.log("No T3 Code data to remove.");
        return;
      }
      yield* Console.log("This moves to the Trash:");
      for (const location of state.locations) yield* Console.log(`  ${location.path}`);
      yield* Console.log(
        "T3 Code starts empty afterwards. Anything Z6 Code still uses is kept, and so is work in T3's worktrees, scratch and projects folders that is not a clean git checkout.",
      );
      if (!flags.yes) {
        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
          return yield* new CliT3DataError({
            reason:
              "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
          });
        }
        const confirmed = yield* Prompt.run(
          Prompt.Confirm({ message: "Move T3 Code's old data to the Trash?", initial: false }),
        ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
        if (!confirmed) {
          yield* Console.log("Left as is.");
          return;
        }
      }
      const result = yield* Effect.tryPromise({
        try: () =>
          removeT3Data({
            ...paths,
            homeDirectory,
            t3UserData,
            trash: (target) => moveToTrash(target, platform),
          }),
        catch: (cause) =>
          new CliT3DataError({
            reason: `The cleanup stopped: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
      if (result.status === "nothing") return yield* Console.log("No T3 Code data to remove.");
      if (result.status === "refused") return yield* new CliT3DataError({ reason: result.reason });
      for (const removed of result.removed) yield* Console.log(`Moved to the Trash: ${removed}`);
      for (const kept of result.kept) yield* Console.log(`Kept ${kept.path}: ${kept.reason}`);
      if ((result.trashedCheckouts ?? []).length > 0) {
        yield* Console.log(
          "Git still lists the trashed checkouts as worktrees; `git worktree prune` in their repository forgets them once the Trash is emptied.",
        );
      }
    }),
  ),
);

export const t3DataCommand = Command.make("t3-data").pipe(
  Command.withDescription("Show or remove the T3 Code data this Z6 Code home was copied from."),
  Command.withSubcommands([statusCommand, removeCommand]),
);
