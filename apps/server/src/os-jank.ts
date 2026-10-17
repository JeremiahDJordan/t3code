import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  setWindowsPath,
} from "@t3tools/shared/shell";
import { T3_HOME_DIRNAME, defaultZ6Home, migrateHomeFromT3 } from "@t3tools/shared/t3DataMigration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellEnvironment: Partial<Record<string, string>> = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      // mise's record of the PATH entries it added. It must travel with the
      // shell's PATH, or `mise x` can rebuild PATH behind a same-named wrapper
      // (`exec mise x claude -- claude`) that then re-runs itself forever.
      shellEnvironment = readEnvironmentFromLoginShell(shell, ["PATH", "__MISE_DIFF"]);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellEnvironment.PATH) break;
  }

  const shellPath = shellEnvironment.PATH;
  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // The desktop already ran both PowerShell probes into the env this child
    // extends. Repeating them here costs seconds of startup on Windows.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  if (options?.shellEnvironmentPrepared === true) return;
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export class T3HomeMigrationError extends Schema.TaggedError<T3HomeMigrationError>()(
  "T3HomeMigrationError",
  { reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The default home is Z6 Code's `~/.z6`, copied once from T3 Code's `~/.t3` when it is missing
 * (`@t3tools/shared/t3DataMigration`). An explicit `--base-dir` or `T3CODE_HOME` is used as is.
 * Pass `migrateFromT3: false` where a missing home must stay missing, such as dev state.
 */
export const resolveBaseDir = Effect.fn(function* (
  raw: string | undefined,
  options?: { readonly migrateFromT3?: boolean },
) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const z6Home = defaultZ6Home(homeDirectory);
    // Tests never copy the developer's real home, whatever environment they hand the code.
    const realHomeUnderTest =
      process.env.VITEST !== undefined && homeDirectory === NodeOS.homedir();
    if (options?.migrateFromT3 !== false && !realHomeUnderTest) {
      const result = yield* Effect.try({
        try: () => migrateHomeFromT3({ t3Home: join(homeDirectory, T3_HOME_DIRNAME), z6Home }),
        catch: (cause) =>
          new T3HomeMigrationError({
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (result.status === "migrated") {
        process.stderr.write(
          `[server] Copied T3 Code's data from ${result.marker.source} to ${z6Home}. T3 Code's folder was left as is; \`t3 t3-data remove\` moves it to the Trash.\n`,
        );
      }
    }
    return z6Home;
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
