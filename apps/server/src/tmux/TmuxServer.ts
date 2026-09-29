import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export class TmuxError extends Schema.TaggedError<TmuxError>()("TmuxError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const TMUX_MISSING_MESSAGE =
  "This needs tmux 3.2 or later on the machine running T3 Code, and it was not found. Install it (for example `brew install tmux` or `apt install tmux`) and try again. Native Windows has no tmux.";

/** The oldest tmux whose `new-session` takes `-e` and runs a command's arguments without a shell. */
const MIN_TMUX_VERSION = [3, 2] as const;

/** How long a missing or too old tmux is remembered before T3 looks for it again. */
export const TMUX_RETRY_AFTER = "10 seconds";

export function parseTmuxVersion(output: string): readonly [number, number] | undefined {
  const match = /tmux (?:next-)?(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/**
 * T3's own tmux server, which hosts work meant to outlive the T3 server: background commands and
 * kept-alive Bob sessions. Its socket lives in the state directory, so it is private to this T3
 * home, is not removed by the system's temp cleanup, and never mixes with the user's own tmux.
 * It reads no config file.
 */
export class TmuxServer extends Context.Service<
  TmuxServer,
  {
    /** The absolute tmux binary and the socket arguments, for commands that attach from a shell. */
    readonly attachCommand: (session: string) => Effect.Effect<ReadonlyArray<string>, TmuxError>;
    /** Whether a usable tmux (3.2 or later) is installed. */
    readonly available: Effect.Effect<boolean>;
    /** Runs one tmux command against this server and returns its stdout. */
    readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, TmuxError>;
    /**
     * The server's session names, an empty set when tmux says no server is running, or undefined
     * when tmux could not answer. Only the first two are evidence that a session is gone.
     */
    readonly listSessions: Effect.Effect<ReadonlySet<string> | undefined>;
    /**
     * Starts a detached session running `argv` directly (no shell), with `env` added to the
     * environment tmux gives it.
     */
    readonly newSession: (input: {
      readonly name: string;
      readonly argv: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    }) => Effect.Effect<void, TmuxError>;
    readonly killSession: (name: string) => Effect.Effect<void>;
  }
>()("t3/tmux/TmuxServer") {}

/** tmux refuses some commands from inside another tmux session; T3's server is never nested. */
function tmuxEnvironment(): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return rest;
}

/**
 * The command that runs `tmux <args>` for a command that may start T3's tmux server. Under a
 * systemd service it runs in its own scope, so the server tmux forks lands outside the unit's
 * cgroup and a restart of the unit (which by default kills the whole cgroup) leaves it, and
 * every command running in it, alone.
 */
export function tmuxLaunchCommand(input: {
  readonly tmux: string;
  readonly args: ReadonlyArray<string>;
  /** `systemd-run` when T3 runs as a systemd service and scopes work, else undefined. */
  readonly systemdRun: string | undefined;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return input.systemdRun === undefined
    ? { command: input.tmux, args: input.args }
    : {
        command: input.systemdRun,
        args: ["--user", "--scope", "--quiet", "--collect", "--", input.tmux, ...input.args],
      };
}

// A Unix socket path must fit in `sun_path` (104 bytes on macOS, 108 on Linux).
const MAX_SOCKET_PATH = 100;

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const socketDir = path.join(config.stateDir, "tmux");
  const socketPath = path.join(socketDir, "t3.sock");
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(config.stateDir))
    .pipe(Effect.orDie);
  const socketArgs =
    Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH
      ? ["-S", socketPath]
      : [
          "-L",
          `t3-${[...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        ];

  // tmux on the server's PATH as an absolute path, with a new enough version. A find is kept; a
  // miss is looked for again after a while, so tmux installed later works without a restart.
  const lookups = yield* Cache.makeWith(
    Effect.fnUntraced(function* () {
      const version = yield* runner
        .run({ command: "tmux", args: ["-V"], env: tmuxEnvironment(), timeout: "5 seconds" })
        .pipe(Effect.option);
      const parsed =
        version._tag === "Some" && version.value.code === 0
          ? parseTmuxVersion(version.value.stdout)
          : undefined;
      if (
        parsed === undefined ||
        parsed[0] < MIN_TMUX_VERSION[0] ||
        (parsed[0] === MIN_TMUX_VERSION[0] && parsed[1] < MIN_TMUX_VERSION[1])
      ) {
        return undefined;
      }
      const which = yield* runner
        .run({
          command: "/bin/sh",
          args: ["-c", "command -v tmux"],
          env: tmuxEnvironment(),
          timeout: "5 seconds",
        })
        .pipe(Effect.option);
      const binary =
        which._tag === "Some" && which.value.code === 0 ? which.value.stdout.trim() : "";
      if (!binary.startsWith("/")) return undefined;
      yield* fs.makeDirectory(socketDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
      return binary;
    }),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== undefined ? Duration.infinity : TMUX_RETRY_AFTER,
    },
  );
  const resolved = Cache.get(lookups, undefined);

  // `systemd-run`, when T3 runs as a systemd service (which sets INVOCATION_ID) on Linux.
  const platform = yield* HostProcessPlatform;
  const scopeRunner = yield* Effect.cached(
    platform !== "linux" || !process.env.INVOCATION_ID
      ? Effect.undefined
      : runner
          .run({
            command: "/bin/sh",
            args: ["-c", "command -v systemd-run"],
            env: tmuxEnvironment(),
            timeout: "5 seconds",
          })
          .pipe(
            Effect.map((output) => output.stdout.trim()),
            Effect.map((found) => (found.startsWith("/") ? found : undefined)),
            Effect.orElseSucceed(() => undefined),
          ),
  );
  // Set once a scope could not be made (no user manager, say), so later starts go direct.
  let scopesFailed = false;

  const binary = resolved.pipe(
    Effect.flatMap((found) =>
      found === undefined
        ? Effect.fail(new TmuxError({ detail: TMUX_MISSING_MESSAGE }))
        : Effect.succeed(found),
    ),
  );

  const exec = (args: ReadonlyArray<string>) =>
    binary.pipe(
      Effect.flatMap((command) =>
        runner
          .run({
            command,
            args: [...socketArgs, "-f", "/dev/null", ...args],
            env: tmuxEnvironment(),
            timeout: "15 seconds",
          })
          .pipe(
            Effect.mapError((cause) => new TmuxError({ detail: `tmux failed: ${cause.message}` })),
          ),
      ),
    );

  /**
   * `exec` for a command that may start the server: in its own systemd scope when T3 runs as a
   * systemd service. A scope that cannot be made falls back to running tmux directly, and later
   * starts skip it.
   */
  const execStarting = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const systemdRun = scopesFailed ? undefined : yield* scopeRunner;
      if (systemdRun === undefined) return yield* exec(args);
      const tmux = yield* binary;
      const launch = tmuxLaunchCommand({
        tmux,
        args: [...socketArgs, "-f", "/dev/null", ...args],
        systemdRun,
      });
      const scoped = yield* runner
        .run({
          command: launch.command,
          args: launch.args,
          env: tmuxEnvironment(),
          timeout: "15 seconds",
        })
        .pipe(Effect.option);
      if (scoped._tag === "Some" && scoped.value.code === 0) return scoped.value;
      const direct = yield* exec(args);
      if (direct.code === 0) {
        scopesFailed = true;
        yield* Effect.logWarning(
          "Could not start T3's tmux server in its own systemd scope; restarting the T3 unit will stop it unless the unit sets KillMode=process.",
        );
      }
      return direct;
    });

  const checked = (args: ReadonlyArray<string>) =>
    Effect.flatMap((output: ProcessRunner.ProcessRunOutput) =>
      output.code === 0
        ? Effect.succeed(output.stdout)
        : Effect.fail(
            new TmuxError({
              detail: `tmux ${args[0] ?? ""} failed: ${output.stderr.trim() || `exit ${output.code}`}`,
            }),
          ),
    );

  const runStarting = (args: ReadonlyArray<string>) => execStarting(args).pipe(checked(args));

  const run: TmuxServer["Service"]["run"] = (args) => exec(args).pipe(checked(args));

  const listSessions: TmuxServer["Service"]["listSessions"] = exec([
    "list-sessions",
    "-F",
    "#{session_name}",
  ]).pipe(
    Effect.map((output) => {
      if (output.code === 0) {
        return new Set(output.stdout.split("\n").filter((line) => line.length > 0));
      }
      // tmux's own answers for "there is no server": the socket is missing or nothing listens.
      return /no server running|error connecting to|No such file or directory/i.test(output.stderr)
        ? new Set<string>()
        : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

  return TmuxServer.of({
    attachCommand: (session) =>
      binary.pipe(
        Effect.map((command) => [command, ...socketArgs, "attach-session", "-t", `=${session}`]),
      ),
    available: resolved.pipe(Effect.map((found) => found !== undefined)),
    run,
    listSessions,
    newSession: ({ name, argv, env }) =>
      runStarting([
        // Options first: a pane takes the history limit in force when it is created. They set
        // the look for anyone attaching: no status bar, mouse scrolling, a long history.
        "start-server",
        ";",
        "set-option",
        "-g",
        "history-limit",
        "10000",
        ";",
        "set-option",
        "-g",
        "status",
        "off",
        ";",
        "set-option",
        "-g",
        "mouse",
        "on",
        ";",
        "new-session",
        "-d",
        "-s",
        name,
        "-x",
        "200",
        "-y",
        "50",
        ...Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        // With arguments, tmux runs the command directly instead of through a shell. No
        // argument may end in ";", which tmux would take as a command separator.
        ...argv.map((arg) => (arg.endsWith(";") ? `${arg} ` : arg)),
      ]).pipe(Effect.asVoid),
    killSession: (name) =>
      run(["kill-session", "-t", `=${name}`]).pipe(Effect.asVoid, Effect.ignore),
  });
});

export const layer = Layer.effect(TmuxServer, make);
