import {
  BACKGROUND_COMMAND_MAX_CHARS,
  BACKGROUND_COMMAND_NOTIFY_ON_MAX_CHARS,
  BACKGROUND_COMMANDS_PER_THREAD_MAX,
  BackgroundCommandError,
  BackgroundCommandId,
  type BackgroundCommandStopper,
  type OrchestrationEvent,
  type ThreadBackgroundCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  BackgroundCommandChanges,
  type BackgroundCommandRow,
  ThreadBackgroundCommandRepository,
} from "../persistence/ThreadBackgroundCommands.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createTerminalSpawnEnv, TerminalManager } from "../terminal/Manager.ts";
import { TMUX_MISSING_MESSAGE, TmuxServer } from "../tmux/TmuxServer.ts";
import {
  BACKGROUND_COMMAND_WRAPPER_SOURCE,
  backgroundCommandMatchesPath,
  backgroundCommandShell,
  describeBackgroundCommandExit,
  encodeBackgroundCommandSpec,
  notifyOnPatternProblem,
  parseBackgroundCommandExit,
} from "./backgroundCommandWrapper.ts";
import * as CheckInScheduler from "./CheckInScheduler.ts";

export interface StartBackgroundCommandInput {
  readonly threadId: ThreadId;
  readonly command: string;
  readonly statusEveryMinutes: number | null;
  readonly note: string;
  readonly tailLines: number;
  /** A regular expression for output lines the agent hears about as they appear. */
  readonly notifyOn: string | null;
}

/**
 * Runs agents' background commands on T3's own tmux server and follows them to their end. The
 * check-in scheduler tells the agent about them; this service only starts, watches and stops.
 */
export class BackgroundCommands extends Context.Service<
  BackgroundCommands,
  {
    readonly start: (
      input: StartBackgroundCommandInput,
    ) => Effect.Effect<ThreadBackgroundCommand, BackgroundCommandError>;
    /**
     * Asks a command to stop; whether it was running. With `threadId`, only that thread's
     * commands, which is what an agent may stop.
     */
    readonly stop: (
      id: BackgroundCommandId,
      by: BackgroundCommandStopper,
      threadId?: ThreadId,
    ) => Effect.Effect<boolean, BackgroundCommandError>;
    /**
     * Holds back or resumes a running command's status updates and matching-line messages;
     * whether it was running. With `threadId`, only that thread's commands.
     */
    readonly setMuted: (
      id: BackgroundCommandId,
      muted: boolean,
      threadId?: ThreadId,
    ) => Effect.Effect<boolean, BackgroundCommandError>;
    /** Opens (or reuses) a thread terminal attached to the command's tmux session. */
    readonly openTerminal: (
      id: BackgroundCommandId,
    ) => Effect.Effect<{ readonly terminalId: string }, BackgroundCommandError>;
    /** The thread's commands that run or whose end the agent has not heard yet. */
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadBackgroundCommand>, BackgroundCommandError>;
    readonly stream: (threadId: ThreadId) => Stream.Stream<ReadonlyArray<ThreadBackgroundCommand>>;
    readonly watch: () => Effect.Effect<void, never, Scope.Scope>;
    /** Checks every running command once; the timer does this on its own. */
    readonly pollNow: Effect.Effect<void>;
  }
>()("t3/checkIns/BackgroundCommands") {}

/** The client-facing shape of a stored command. */
export function toThreadBackgroundCommand(row: BackgroundCommandRow): ThreadBackgroundCommand {
  return {
    id: row.id,
    threadId: row.threadId,
    command: row.command,
    cwd: row.cwd,
    stdoutPath: row.stdoutPath,
    stderrPath: row.stderrPath,
    status: row.status,
    exitStatus: row.exitStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    statusEveryMinutes: row.statusEveryMinutes,
    nextStatusAt: row.nextStatusAt,
    note: row.note,
    tailLines: row.tailLines,
    stopRequestedBy: row.stopRequestedBy,
    notifyOn: row.notifyOn,
    muted: row.muted,
  };
}

const POLL_INTERVAL = "2 seconds";
/** Polls between asking tmux for its sessions; exit files are checked on every poll. */
const SESSION_CHECK_EVERY_POLLS = 15;
/** Consecutive session checks that must find a command gone before it counts as lost. */
const MISSING_OBSERVATIONS_FOR_LOST = 2;
const STOP_TERM_AFTER_MS = 10_000;
const STOP_KILL_AFTER_MS = 15_000;
const STOP_SESSION_AFTER_MS = 17_000;

function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  return Effect.sync(() => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const make = Effect.gen(function* () {
  const repository = yield* ThreadBackgroundCommandRepository;
  const tmux = yield* TmuxServer;
  const scheduler = yield* CheckInScheduler.CheckInScheduler;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const terminals = yield* TerminalManager;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* BackgroundCommandChanges;

  const supportDir = path.join(config.stateDir, "background-commands");
  const wrapperPath = path.join(supportDir, "run-command.mjs");
  const hasBash = yield* fs.exists("/bin/bash").pipe(Effect.orElseSucceed(() => false));

  const failure = (detail: string) => (cause: unknown) =>
    Effect.logWarning(detail, { cause }).pipe(
      Effect.andThen(new BackgroundCommandError({ detail })),
    );
  const refuse = (detail: string) => Effect.fail(new BackgroundCommandError({ detail }));
  const publish = (threadId: ThreadId) => PubSub.publish(changes, threadId);

  const list: BackgroundCommands["Service"]["list"] = (threadId) =>
    repository.listByThread(threadId).pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.status === "running" || !row.endNoticeSent)
          .map(toThreadBackgroundCommand),
      ),
      Effect.catch(failure("Could not read this thread's background commands.")),
    );

  /** `<cwd>/.t3/jobs/<id>`, created without following links a repository may ship there. */
  const prepareJobDir = Effect.fn("BackgroundCommands.prepareJobDir")(function* (
    cwd: string,
    id: string,
  ) {
    const dotT3 = path.join(cwd, ".t3");
    const jobsRoot = path.join(dotT3, "jobs");
    const isLink = (target: string) =>
      fs.readLink(target).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if ((yield* isLink(dotT3)) || (yield* isLink(jobsRoot))) {
      return yield* refuse(
        "This folder's .t3 or .t3/jobs is a symbolic link, so T3 Code will not write command output there.",
      );
    }
    const jobDir = path.join(jobsRoot, id);
    yield* fs
      .makeDirectory(jobDir, { recursive: true })
      .pipe(Effect.catch(failure("Could not create the folder for the command's output.")));
    // Git ignores the folder; written only if absent, never through a link.
    yield* fs
      .writeFileString(path.join(jobsRoot, ".gitignore"), "*\n", { flag: "wx" })
      .pipe(Effect.ignore);
    return jobDir;
  });

  const start: BackgroundCommands["Service"]["start"] = Effect.fn("BackgroundCommands.start")(
    function* (input) {
      const command = input.command.trim();
      if (command.length === 0 || command.length > BACKGROUND_COMMAND_MAX_CHARS) {
        return yield* refuse(
          `The command must be 1 to ${BACKGROUND_COMMAND_MAX_CHARS} characters long.`,
        );
      }
      const notifyOn = input.notifyOn?.trim() || null;
      if (notifyOn !== null) {
        if (notifyOn.length > BACKGROUND_COMMAND_NOTIFY_ON_MAX_CHARS) {
          return yield* refuse(
            `notifyOn must be at most ${BACKGROUND_COMMAND_NOTIFY_ON_MAX_CHARS} characters long.`,
          );
        }
        const problem = notifyOnPatternProblem(notifyOn);
        if (problem !== undefined) {
          return yield* refuse(`notifyOn is not a valid JavaScript regular expression: ${problem}`);
        }
      }
      const shell = yield* snapshots
        .getThreadShellById(input.threadId)
        .pipe(Effect.catch(failure("Could not read this thread.")));
      if (Option.isNone(shell)) {
        return yield* refuse("This thread is archived or no longer exists.");
      }
      if (shell.value.runtimeMode !== "full-access") {
        return yield* refuse(
          "Background commands run outside your sandbox, so they need this thread in Full access. Ask the user to switch the thread to Full access, or run the command with your own shell tool.",
        );
      }
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(failure("Could not read T3 Code's settings.")),
      );
      if (!resolveProjectSettings(settings, shell.value.projectId).settings.enableAgentCheckIns) {
        return yield* refuse(
          "Check-ins and background commands are turned off for this project in T3 Code's settings.",
        );
      }
      if (!(yield* tmux.available)) return yield* refuse(TMUX_MISSING_MESSAGE);
      const project = yield* snapshots
        .getProjectShellById(shell.value.projectId)
        .pipe(Effect.catch(failure("Could not read this thread's project.")));
      const cwd = shell.value.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
      if (!cwd) return yield* refuse("This thread has no folder to run the command in.");

      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const id = BackgroundCommandId.make(`bg-${uuid}`);
      const jobDir = yield* prepareJobDir(cwd, id);
      const nowMs = yield* Clock.currentTimeMillis;
      const row: BackgroundCommandRow = {
        id,
        threadId: input.threadId,
        command,
        cwd,
        stdoutPath: path.join(jobDir, "stdout.log"),
        stderrPath: path.join(jobDir, "stderr.log"),
        status: "running",
        exitStatus: null,
        startedAt: isoAt(nowMs),
        endedAt: null,
        statusEveryMinutes: input.statusEveryMinutes,
        nextStatusAt:
          input.statusEveryMinutes === null
            ? null
            : isoAt(nowMs + input.statusEveryMinutes * 60_000),
        note: input.note.trim(),
        tailLines: input.tailLines,
        stopRequestedBy: null,
        jobDir,
        tmuxSession: `t3-${id}`,
        stopRequestedAt: null,
        endNoticeSent: false,
        statusNoticesSent: 0,
        stdoutBytesNoticed: 0,
        stderrBytesNoticed: 0,
        missingObservations: 0,
        notifyOn,
        matchNoticesSent: 0,
        matchBytesNoticed: 0,
        lastMatchNoticeAt: null,
        muted: false,
      };
      const added = yield* repository
        .insertIfUnder(row, BACKGROUND_COMMANDS_PER_THREAD_MAX)
        .pipe(Effect.catch(failure("Could not save the background command.")));
      if (!added) {
        return yield* refuse(
          `This thread already runs ${BACKGROUND_COMMANDS_PER_THREAD_MAX} background commands. Stop one first; list_scheduled shows them.`,
        );
      }

      // The spec holds the environment, so it is private and the wrapper deletes it once read.
      const specPath = path.join(supportDir, `${id}.json`);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(createTerminalSpawnEnv(process.env))) {
        if (value !== undefined) env[key] = value;
      }
      env.PYTHONUNBUFFERED = "1";
      const launched = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(supportDir, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(wrapperPath, BACKGROUND_COMMAND_WRAPPER_SOURCE);
        yield* fs.writeFileString(
          specPath,
          encodeBackgroundCommandSpec({
            cwd,
            shell: backgroundCommandShell(process.env.SHELL, hasBash),
            shellArgs: ["-lc", command],
            env,
            stdoutPath: row.stdoutPath,
            stderrPath: row.stderrPath,
            exitPath: path.join(jobDir, "exit-status"),
            pidPath: path.join(jobDir, "pid"),
            notifyOn,
            matchesPath: backgroundCommandMatchesPath(jobDir),
          }),
          { mode: 0o600 },
        );
        yield* tmux.newSession({
          name: row.tmuxSession,
          argv: [process.execPath, wrapperPath, specPath],
          // The server may be Electron running as Node; the wrapper needs the same, the command not.
          env: { ELECTRON_RUN_AS_NODE: "1" },
        });
      }).pipe(Effect.exit);
      if (launched._tag === "Failure") {
        yield* fs.remove(specPath, { force: true }).pipe(Effect.ignore);
        yield* repository
          .finish(id, {
            status: "lost",
            exitStatus: null,
            endedAt: isoAt(yield* Clock.currentTimeMillis),
            endNoticeSent: true,
          })
          .pipe(Effect.ignore);
        return yield* refuse(`Could not start the command: ${Cause.pretty(launched.cause)}`);
      }
      yield* publish(input.threadId);
      return toThreadBackgroundCommand(row);
    },
  );

  const readExit = (row: BackgroundCommandRow) =>
    fs.readFileString(path.join(row.jobDir, "exit-status")).pipe(
      Effect.map(parseBackgroundCommandExit),
      Effect.orElseSucceed(() => undefined),
    );

  const readPid = (row: BackgroundCommandRow) =>
    fs.readFileString(path.join(row.jobDir, "pid")).pipe(
      Effect.map((text) => Number.parseInt(text.trim(), 10)),
      Effect.map((pid) => (Number.isInteger(pid) && pid > 1 ? pid : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  /** Records how a command ended and wakes the scheduler to tell the agent. */
  const finish = (
    row: BackgroundCommandRow,
    status: "exited" | "stopped" | "lost",
    exitStatus: string | null,
    endedAt: string,
  ) =>
    repository
      .finish(row.id, {
        status,
        exitStatus,
        endedAt,
        // The agent stopped it itself, so there is nothing to tell it.
        endNoticeSent: status === "stopped" && row.stopRequestedBy === "agent",
      })
      .pipe(
        Effect.flatMap((finished) =>
          finished
            ? tmux
                .killSession(row.tmuxSession)
                .pipe(Effect.andThen(publish(row.threadId)), Effect.andThen(scheduler.wake))
            : Effect.void,
        ),
      );

  // Stop escalation already applied, per command, so each signal goes once per server run.
  const stopStage = new Map<string, number>();
  // Matches file sizes seen, so the scheduler is woken once per growth rather than every poll.
  const matchSizes = new Map<string, number>();
  let polls = 0;

  /** Whether a command's wrapper recorded matches since the last poll. */
  const matchesGrew = (row: BackgroundCommandRow) =>
    row.notifyOn === null
      ? Effect.succeed(false)
      : fs.stat(backgroundCommandMatchesPath(row.jobDir)).pipe(
          Effect.map((info) => {
            const size = Number(info.size);
            const grew = size > row.matchBytesNoticed && size !== matchSizes.get(row.id);
            matchSizes.set(row.id, size);
            return grew;
          }),
          Effect.orElseSucceed(() => false),
        );

  const poll = Effect.gen(function* () {
    const running = (yield* repository.listActive).filter((row) => row.status === "running");
    if (running.length === 0) return;
    const checkSessions = polls % SESSION_CHECK_EVERY_POLLS === 0;
    polls += 1;
    const sessions = checkSessions ? yield* tmux.listSessions : undefined;
    const nowMs = yield* Clock.currentTimeMillis;
    let newMatches = false;
    for (const row of running) {
      if (yield* matchesGrew(row)) newMatches = true;
      const exit = yield* readExit(row);
      if (exit !== undefined) {
        // Read again: a stop requested since this poll listed the command ended it.
        const current = (yield* repository.get(row.id)) ?? row;
        yield* finish(
          current,
          current.stopRequestedBy !== null ? "stopped" : "exited",
          describeBackgroundCommandExit(exit),
          exit.endedAt ?? isoAt(nowMs),
        );
        continue;
      }
      if (row.stopRequestedAt !== null) {
        yield* escalateStop(row, nowMs);
      }
      if (sessions === undefined) continue;
      if (sessions.has(row.tmuxSession)) {
        if (row.missingObservations > 0) yield* repository.setMissingObservations(row.id, 0);
        continue;
      }
      // tmux says the session is gone. Look again for an exit status written meanwhile, and
      // for the command itself, before calling it lost; and only after two checks in a row.
      const exitNow = yield* readExit(row);
      if (exitNow !== undefined) continue;
      const pid = yield* readPid(row);
      if (pid !== undefined && pidAlive(pid)) continue;
      const seen = row.missingObservations + 1;
      if (seen < MISSING_OBSERVATIONS_FOR_LOST) {
        yield* repository.setMissingObservations(row.id, seen);
        continue;
      }
      yield* finish(row, row.stopRequestedBy === null ? "lost" : "stopped", null, isoAt(nowMs));
    }
    // Matching lines are what the agent asked to hear about soon; don't wait for the timer.
    if (newMatches) yield* scheduler.wake;
  }).pipe(Effect.catch((error) => Effect.logWarning("background command poll failed", { error })));

  /** Ctrl-C first; then SIGTERM, SIGKILL and the session, if the command does not end. */
  const escalateStop = (row: BackgroundCommandRow, nowMs: number) =>
    Effect.gen(function* () {
      const elapsed = nowMs - Date.parse(row.stopRequestedAt ?? isoAt(nowMs));
      const stage =
        elapsed >= STOP_SESSION_AFTER_MS
          ? 4
          : elapsed >= STOP_KILL_AFTER_MS
            ? 3
            : elapsed >= STOP_TERM_AFTER_MS
              ? 2
              : 1;
      if ((stopStage.get(row.id) ?? 0) >= stage) return;
      stopStage.set(row.id, stage);
      const pid = yield* readPid(row);
      if (stage === 4 || pid === undefined) {
        if (stage === 4 || elapsed >= STOP_TERM_AFTER_MS) yield* tmux.killSession(row.tmuxSession);
        return;
      }
      yield* signalGroup(pid, stage === 1 ? "SIGINT" : stage === 2 ? "SIGTERM" : "SIGKILL");
    });

  const stop: BackgroundCommands["Service"]["stop"] = Effect.fn("BackgroundCommands.stop")(
    function* (id, by, threadId) {
      const row = yield* repository
        .get(id)
        .pipe(Effect.catch(failure("Could not read the background command.")));
      if (row === undefined || (threadId !== undefined && row.threadId !== threadId)) return false;
      const nowMs = yield* Clock.currentTimeMillis;
      const requested = yield* repository
        .requestStop(id, by, isoAt(nowMs))
        .pipe(Effect.catch(failure("Could not stop the background command.")));
      if (!requested) return false;
      const updated =
        (yield* repository.get(id).pipe(Effect.orElseSucceed(() => undefined))) ?? row;
      yield* escalateStop(updated, nowMs);
      yield* publish(row.threadId);
      return true;
    },
  );

  const setMuted: BackgroundCommands["Service"]["setMuted"] = Effect.fn(
    "BackgroundCommands.setMuted",
  )(function* (id, muted, threadId) {
    const row = yield* repository
      .get(id)
      .pipe(Effect.catch(failure("Could not read the background command.")));
    if (row === undefined || (threadId !== undefined && row.threadId !== threadId)) return false;
    const updated = yield* repository
      .setMuted(id, muted)
      .pipe(Effect.catch(failure("Could not mute the background command.")));
    if (updated) {
      yield* publish(row.threadId);
      // Unmuted, what fell due meanwhile goes out now.
      if (!muted) yield* scheduler.wake;
    }
    return updated;
  });

  const openTerminal: BackgroundCommands["Service"]["openTerminal"] = Effect.fn(
    "BackgroundCommands.openTerminal",
  )(function* (id) {
    const row = yield* repository
      .get(id)
      .pipe(Effect.catch(failure("Could not read the background command.")));
    if (row === undefined || row.status !== "running") {
      return yield* refuse("That background command is no longer running.");
    }
    const terminalId = id;
    const snapshot = yield* terminals
      .open({ threadId: row.threadId, terminalId, cwd: row.cwd })
      .pipe(Effect.catch(failure("Could not open a terminal for the command.")));
    // Only a fresh shell gets the attach line; typing it into an attached session would send
    // it to the command's input.
    if (snapshot.history.length === 0) {
      const argv = yield* tmux
        .attachCommand(row.tmuxSession)
        .pipe(Effect.mapError((error) => new BackgroundCommandError({ detail: error.detail })));
      const quoted = argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
      yield* terminals
        .write({ threadId: row.threadId, terminalId, data: `env -u TMUX ${quoted}\r` })
        .pipe(Effect.catch(failure("Could not attach the terminal to the command.")));
    }
    return { terminalId };
  });

  const stream: BackgroundCommands["Service"]["stream"] = (threadId) =>
    Stream.callback<ReadonlyArray<ThreadBackgroundCommand>>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const current = () =>
            list(threadId).pipe(
              Effect.tap((commands) => Effect.sync(() => Queue.offerUnsafe(mailbox, commands))),
              Effect.ignore,
            );
          yield* current();
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.runForEach(current),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  /** Removes a job's output folder, only when it really is one of T3's job folders. */
  const removeJobDir = (row: BackgroundCommandRow) =>
    Effect.gen(function* () {
      const real = yield* fs.realPath(row.jobDir);
      const jobsRoot = yield* fs.realPath(path.join(row.cwd, ".t3", "jobs"));
      if (real.startsWith(`${jobsRoot}/`) && path.basename(real) === row.id) {
        yield* fs.remove(real, { recursive: true });
      }
    }).pipe(Effect.ignore);

  /** Archive stops a thread's commands; delete also removes their records and output. */
  const onThreadGone = (threadId: ThreadId, deleted: boolean) =>
    Effect.gen(function* () {
      const rows = yield* repository.listByThread(threadId);
      for (const row of rows) {
        if (row.status === "running") {
          yield* repository.requestStop(row.id, "agent", isoAt(yield* Clock.currentTimeMillis));
          yield* tmux.killSession(row.tmuxSession);
          yield* repository.finish(row.id, {
            status: "stopped",
            exitStatus: null,
            endedAt: isoAt(yield* Clock.currentTimeMillis),
            endNoticeSent: true,
          });
        }
        if (deleted) yield* removeJobDir(row);
      }
      if (deleted) yield* repository.removeByThread(threadId);
      yield* publish(threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not clean up a thread's background commands", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const watch: BackgroundCommands["Service"]["watch"] = Effect.fn("BackgroundCommands.watch")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      const processEvent = (event: OrchestrationEvent) => {
        switch (event.type) {
          case "thread.archived":
            return onThreadGone(event.payload.threadId, false);
          case "thread.deleted":
            return onThreadGone(event.payload.threadId, true);
        }
        return Effect.void;
      };
      yield* forkParked(poll.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.asVoid));
      yield* forkParked(Stream.runForEach(events, processEvent));
    },
  );

  return BackgroundCommands.of({
    start,
    stop,
    setMuted,
    openTerminal,
    list,
    stream,
    watch,
    pollNow: poll,
  });
});

export const layer = Layer.effect(BackgroundCommands, make);
