import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Background commands: long commands an agent starts with `start_background_command`. Each runs
 * in T3's own tmux server, so it outlives the agent's turn and a restart of T3, with its stdout
 * and stderr in files. T3 tells the agent when it ends, and optionally how it is doing on a
 * schedule while it runs.
 */
export const BackgroundCommandId = TrimmedNonEmptyString.pipe(Schema.brand("BackgroundCommandId"));
export type BackgroundCommandId = typeof BackgroundCommandId.Type;

export const BACKGROUND_COMMAND_MAX_CHARS = 4_000;
export const BACKGROUND_COMMANDS_PER_THREAD_MAX = 3;
export const BACKGROUND_COMMAND_TAIL_MAX_LINES = 200;
export const BACKGROUND_COMMAND_NOTIFY_ON_MAX_CHARS = 500;
/** How often, at most, T3 tells the agent about new output lines matching `notifyOn`. */
export const BACKGROUND_COMMAND_MATCH_NOTICE_MINUTES = 5;

/**
 * `running`, `exited` on its own, `stopped` by the user or agent, or `lost` when T3 found neither
 * the command nor how it ended.
 */
export const BackgroundCommandStatus = Schema.Literals(["running", "exited", "stopped", "lost"]);
export type BackgroundCommandStatus = typeof BackgroundCommandStatus.Type;

export const BackgroundCommandStopper = Schema.Literals(["user", "agent"]);
export type BackgroundCommandStopper = typeof BackgroundCommandStopper.Type;

export const ThreadBackgroundCommand = Schema.Struct({
  id: BackgroundCommandId,
  threadId: ThreadId,
  command: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  stdoutPath: TrimmedNonEmptyString,
  stderrPath: TrimmedNonEmptyString,
  status: BackgroundCommandStatus,
  /** `exit 0`, `exit 1` or `signal SIGTERM` once it has ended; null while running or unknown. */
  exitStatus: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  /** Minutes between status updates while it runs; null for none. */
  statusEveryMinutes: Schema.NullOr(PositiveInt),
  nextStatusAt: Schema.NullOr(IsoDateTime),
  /** The agent's note, repeated in every message about the command. */
  note: Schema.String,
  /** How many of each file's last lines the messages quote; 0 quotes none. */
  tailLines: NonNegativeInt,
  /**
   * A regular expression for output lines to hear about while it runs, such as test failures;
   * absent for commands started before T3 Code had it.
   */
  notifyOn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stopRequestedBy: Schema.NullOr(BackgroundCommandStopper),
});
export type ThreadBackgroundCommand = typeof ThreadBackgroundCommand.Type;

export const ThreadBackgroundCommandsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadBackgroundCommandsInput = typeof ThreadBackgroundCommandsInput.Type;

export const BackgroundCommandInput = Schema.Struct({ backgroundCommandId: BackgroundCommandId });
export type BackgroundCommandInput = typeof BackgroundCommandInput.Type;

export class BackgroundCommandError extends Schema.TaggedError<BackgroundCommandError>()(
  "BackgroundCommandError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
