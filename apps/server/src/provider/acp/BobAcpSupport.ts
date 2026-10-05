import * as NodeOS from "node:os";

import { type BobAuthMethod, type BobSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

/** Bob signs in with this key instead of its stored IBM SSO login. */
export const BOB_API_KEY_ENV = "BOB_API_KEY";
/** Older name Bob still reads. Bob refuses to start when both are set to different values. */
export const BOB_API_KEY_ALIAS_ENV = "BOBSHELL_API_KEY";

export const BOB_SSO_SIGN_IN_MESSAGE =
  "Bob is not signed in. Run `bob` in a terminal to sign in with IBM SSO.";
export const BOB_API_KEY_REQUIRED_MESSAGE = `Bob is set to sign in with an API key. Add ${BOB_API_KEY_ENV} as a sensitive environment variable on this Bob provider.`;
const BOB_LICENSE_HINT = "Run `bob` once in a terminal to accept it.";
const BOB_UNTRUSTED_WORKSPACE_HINT = "Run `bob` in the project folder and choose a trust level.";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** Deleting a session only tidies Bob's history, so a stuck delete must not hold up the caller. */
const BOB_SESSION_DELETE_TIMEOUT = "5 seconds";
/** Moving a task copies its whole history, so it gets longer than the other requests. */
const BOB_TASK_MOVE_TIMEOUT = "30 seconds";

type BobAcpRuntimeBobSettings = Pick<BobSettings, "binaryPath" | "authMethod">;

interface BobAcpSpawnOptions {
  /**
   * Skips the user's MCP servers and subagents, for one-shot sessions that only return text.
   * `--disable-mcp` and `--disable-subagents` are options of `bob acp` (its `--help` in Bob
   * 2.0.4 and 2.0.5), verified live on both; `BobAdapterCliProbe.test.ts` rechecks them.
   */
  readonly disableMcpAndSubagents?: boolean;
}

interface BobAcpRuntimeInput
  extends
    Omit<
      AcpSessionRuntime.AcpSessionRuntimeOptions,
      "authMethodId" | "authenticateOnAuthRequired" | "cancelBehavior" | "resumeMethod" | "spawn"
    >,
    BobAcpSpawnOptions {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly bobSettings: BobAcpRuntimeBobSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Variables T3 adds for the session, such as its MCP credentials, over `environment`. */
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/** `~/.bob` as Bob resolves it, from the home directory of the environment `bob` runs with. */
export function bobHomeDirectory(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  return path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".bob");
}

/** The API key Bob would use from this environment, preferring its canonical variable. */
export function readBobApiKey(environment: NodeJS.ProcessEnv): string | undefined {
  return (
    environment[BOB_API_KEY_ENV]?.trim() || environment[BOB_API_KEY_ALIAS_ENV]?.trim() || undefined
  );
}

/**
 * The environment `bob` runs with. Bob prefers an API key over its SSO login, so SSO
 * instances drop the key variables to keep a server-wide key from taking over.
 */
export function bobSpawnEnvironment(
  authMethod: BobAuthMethod,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (authMethod !== "sso") return environment;
  const {
    [BOB_API_KEY_ENV]: _apiKey,
    [BOB_API_KEY_ALIAS_ENV]: _aliasApiKey,
    ...rest
  } = environment;
  return rest;
}

export function bobSignInMessage(authMethod: BobAuthMethod): string {
  return authMethod === "apiKey" ? BOB_API_KEY_REQUIRED_MESSAGE : BOB_SSO_SIGN_IN_MESSAGE;
}

/** Whether Bob runs in a mode where it approves its own tools: Full access. */
export function bobApprovesItsOwnTools(runtimeMode?: RuntimeMode): boolean {
  return runtimeMode === "full-access";
}

/**
 * The user opened the project in T3, so Bob trusts it. Only Full access skips
 * Bob's permission prompts; every other mode forwards them through T3.
 */
export function bobAcpSpawnArgs(
  runtimeMode?: RuntimeMode,
  options: BobAcpSpawnOptions = {},
): ReadonlyArray<string> {
  return [
    "acp",
    "--trust",
    ...(bobApprovesItsOwnTools(runtimeMode) ? ["--auto-approve"] : []),
    ...(options.disableMcpAndSubagents ? ["--disable-mcp", "--disable-subagents"] : []),
  ];
}

/** How to start `bob acp` for a session in `cwd`. */
export function buildBobAcpSpawnInput(
  bobSettings: BobAcpRuntimeBobSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  options?: BobAcpSpawnOptions,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: bobSettings?.binaryPath || "bob",
    args: [...bobAcpSpawnArgs(runtimeMode, options)],
    cwd,
    // The full environment, not merged over the server's, so SSO can drop the key variables.
    env: bobSpawnEnvironment(bobSettings?.authMethod ?? "sso", environment ?? process.env),
    extendEnv: false,
  };
}

/**
 * Actionable text for the setup errors Bob returns when opening a session: sign-in, then
 * license acceptance, then workspace trust. Undefined for any other error.
 */
export function describeBobAcpSetupError(
  error: unknown,
  authMethod: BobAuthMethod,
): string | undefined {
  if (!isAcpRequestError(error)) return undefined;
  if (error.code === -32000) return bobSignInMessage(authMethod);
  if (error.code !== -32600) return undefined;
  // Keep Bob's own text, which names its flags, minus the generic JSON-RPC label. Bob can
  // translate these messages (its `locale` setting, 2.0.5+), but never the flag names, so the
  // flag each message tells the user to pass identifies it.
  const bobMessage = error.errorMessage.replace(/^Invalid request:\s*/, "");
  if (/--accept-license\b/.test(bobMessage)) return `${bobMessage} ${BOB_LICENSE_HINT}`;
  if (/--trust\b/.test(bobMessage)) return `${bobMessage} ${BOB_UNTRUSTED_WORKSPACE_HINT}`;
  return undefined;
}

/**
 * Deletes a session and its task from Bob's history with ACP `session/delete`, for
 * sessions the user never sees. Best effort: a failed or slow delete leaves the task.
 * Bob 2.0.4 and 2.0.5 advertise `sessionCapabilities.delete`, and live on both the request
 * removed the task's row from `~/.bob/db/bob.db`; `BobAdapterCliProbe.test.ts` rechecks it.
 */
export const deleteBobSession = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
): Effect.Effect<void> =>
  runtime
    .request("session/delete", { sessionId })
    .pipe(Effect.timeoutOption(BOB_SESSION_DELETE_TIMEOUT), Effect.ignore);

/**
 * The part of a Bob 2.0.5 `_bob/task/export` result T3 reads. The rest, including the task's
 * messages, goes back to Bob unchanged.
 */
const BobTaskExport = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.NonEmptyArray(
    Schema.Struct({ task: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
});
const isBobTaskExport = Schema.is(BobTaskExport);
const decodeBobTaskImport = Schema.decodeUnknownOption(
  Schema.Struct({ sessionIds: Schema.NonEmptyArray(Schema.String) }),
);

/** `value` as a plain object, for editing the loosely typed parts of a task export. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The exported task for `cwd`. Bob's import sets the task's workspace but keeps the folder
 * named in its system prompt (`env.staticEnvInfo.primaryWorkspace`), so that moves here.
 */
function exportedTaskInFolder(task: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const env = asRecord(task.env);
  const staticEnvInfo = asRecord(env?.staticEnvInfo);
  if (!env || !staticEnvInfo) return task;
  return { ...task, env: { ...env, staticEnvInfo: { ...staticEnvInfo, primaryWorkspace: cwd } } };
}

/**
 * Copies a Bob task into `cwd` and returns the id Bob gave the copy, or undefined when the task
 * cannot move (gone, or a Bob before 2.0.5). Bob resumes a task only in the folder it started
 * in, so a thread that moved to another folder, such as a worktree, would otherwise lose its
 * conversation. Bob copies the task with `_bob/task/export` and `_bob/task/import`. The caller
 * deletes the original once the copy opens, so Bob's history and Bobcoin totals count the
 * conversation once, and deletes the copy instead when it does not open.
 *
 * Best effort, with an accepted gap: the timeout covers both requests, so one that fires after
 * the import, like T3 stopping before the copy opens, leaves both in Bob's history.
 */
export const moveBobTask = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  cwd: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const exported = yield* runtime.request("_bob/task/export", { sessionId });
    if (!isBobTaskExport(exported)) return undefined;
    const snapshot = {
      ...exported,
      tasks: exported.tasks.map((entry) => ({
        ...entry,
        task: exportedTaskInFolder(entry.task, cwd),
      })),
    };
    const imported = decodeBobTaskImport(
      yield* runtime.request("_bob/task/import", { cwd, snapshot }),
    );
    return imported._tag === "Some" ? imported.value.sessionIds[0] : undefined;
  }).pipe(
    Effect.timeoutOption(BOB_TASK_MOVE_TIMEOUT),
    Effect.map((moved) => (moved._tag === "Some" ? moved.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Where a rollback cuts a Bob task: at the first prompt Bob recorded at or after `atMs`, or, when
 * the turns' start times are unknown, at the `lastTurns`-th prompt from the end.
 */
export type BobRewindCut = { readonly atMs: number } | { readonly lastTurns: number };

export type BobRewindResult =
  /** No prompt falls at or after the cut, so Bob's conversation already ends before it. */
  | { readonly _tag: "Unchanged" }
  /** The cut removes every prompt; the caller starts a new conversation instead. */
  | { readonly _tag: "Emptied" }
  /** Bob holds the kept conversation as a new task, `sessionId`; the original is untouched. */
  | { readonly _tag: "Rewound"; readonly sessionId: string }
  | { readonly _tag: "Failed"; readonly detail: string };

/** A message of an exported task that is a prompt: one the user sent, not one Bob added. */
function isBobPromptMessage(entry: unknown): boolean {
  const record = asRecord(entry);
  const meta = asRecord(asRecord(record?.data)?._meta);
  return record?.role === "user" && meta?.hide !== true && meta?.notAi !== true;
}

function bobMessageTimestamp(entry: unknown): number | undefined {
  const timestamp = asRecord(asRecord(asRecord(entry)?.data)?._meta)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * The index of the exported message that starts the first dropped turn, or undefined when the
 * cut drops nothing. Bob stamps each message when it records it, on the host T3 runs on, so a
 * prompt sent after a turn began is stamped at or after that turn's start time.
 */
export function bobRewindCutIndex(
  messages: ReadonlyArray<unknown>,
  cut: BobRewindCut,
): number | undefined {
  const prompts = messages.flatMap((entry, index) =>
    isBobPromptMessage(entry) ? [{ index, timestamp: bobMessageTimestamp(entry) }] : [],
  );
  if ("lastTurns" in cut) {
    if (cut.lastTurns < 1 || prompts.length === 0) return undefined;
    return prompts[Math.max(0, prompts.length - cut.lastTurns)]!.index;
  }
  return prompts.find((prompt) => prompt.timestamp !== undefined && prompt.timestamp >= cut.atMs)
    ?.index;
}

/**
 * Rewinds a Bob task to before a turn, as Bob's IDE does when it rolls a task back to before a
 * message: the messages from that turn's first prompt on are dropped. Bob has no ACP request for
 * it, so the kept messages go through `_bob/task/export` and `_bob/task/import` into a new task,
 * with their timestamps; the caller resumes it and deletes the original once no session holds it.
 */
export const rewindBobTask = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  cwd: string,
  cut: BobRewindCut,
): Effect.Effect<BobRewindResult> =>
  Effect.gen(function* () {
    const exported = yield* runtime.request("_bob/task/export", { sessionId });
    if (!isBobTaskExport(exported)) {
      return { _tag: "Failed", detail: "Bob's task export has an unexpected shape." } as const;
    }
    const [entry, ...others] = exported.tasks;
    const messages = asRecord(entry)?.messages;
    if (!Array.isArray(messages)) {
      return { _tag: "Failed", detail: "Bob's task export has no messages." } as const;
    }
    const index = bobRewindCutIndex(messages, cut);
    if (index === undefined) return { _tag: "Unchanged" } as const;
    const kept = messages.slice(0, index);
    if (!kept.some(isBobPromptMessage)) return { _tag: "Emptied" } as const;
    const snapshot = { ...exported, tasks: [{ ...entry, messages: kept }, ...others] };
    const imported = decodeBobTaskImport(
      yield* runtime.request("_bob/task/import", { cwd, snapshot }),
    );
    return imported._tag === "Some"
      ? ({ _tag: "Rewound", sessionId: imported.value.sessionIds[0] } as const)
      : ({ _tag: "Failed", detail: "Bob did not return the rewound task." } as const);
  }).pipe(
    Effect.timeoutOption(BOB_TASK_MOVE_TIMEOUT),
    Effect.map((result): BobRewindResult =>
      result._tag === "Some"
        ? result.value
        : { _tag: "Failed", detail: "Bob did not rewind the task in time." },
    ),
    Effect.catch((error) =>
      Effect.succeed<BobRewindResult>({ _tag: "Failed", detail: error.message }),
    ),
  );

/** Starts `bob acp` in the caller's scope and returns its ACP session runtime. */
export const makeBobAcpRuntime = (
  input: BobAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    // Without a key Bob would fall back to its SSO login, which is not what this instance asked for.
    if (
      input.bobSettings?.authMethod === "apiKey" &&
      !readBobApiKey(input.environment ?? process.env)
    ) {
      return yield* EffectAcpErrors.AcpRequestError.authRequired();
    }
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildBobAcpSpawnInput(
          input.bobSettings,
          input.cwd,
          { ...(input.environment ?? process.env), ...input.processEnvironment },
          input.runtimeMode,
          { disableMcpAndSubagents: input.disableMcpAndSubagents === true },
        ),
        // Never `authenticate`: Bob's only method opens an IBM SSO browser on the server host
        // and blocks until the login finishes. Bob signs in from its stored login or API key.
        authenticateOnAuthRequired: false,
        resumeMethod: "resume",
        // Bob rejects a prompt while the previous one is still running, so a cancelled
        // prompt must finish on Bob's side before the next one is sent.
        cancelBehavior: "wait-for-prompt",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
