import * as NodeOS from "node:os";

import { type BobAuthMethod, type BobSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Bob signs in with this key instead of its stored IBM SSO login. */
export const BOB_API_KEY_ENV = "BOB_API_KEY";
/** Older name Bob still reads. Bob refuses to start when both are set to different values. */
export const BOB_API_KEY_ALIAS_ENV = "BOBSHELL_API_KEY";

export const BOB_SSO_SIGN_IN_MESSAGE =
  "Bob is not signed in. Run `bob` in a terminal to sign in with IBM SSO.";
export const BOB_API_KEY_REQUIRED_MESSAGE = `Bob is set to sign in with an API key. Add ${BOB_API_KEY_ENV} as a sensitive environment variable on this Bob provider.`;
const BOB_LICENSE_REQUIRED_MESSAGE =
  "Accept the IBM Bob license by running `bob` once in a terminal.";
const BOB_UNTRUSTED_WORKSPACE_MESSAGE =
  "Bob does not trust this workspace. Run `bob` in the project folder and choose a trust level.";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

type BobAcpRuntimeBobSettings = Pick<BobSettings, "binaryPath" | "authMethod">;

interface BobAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly bobSettings: BobAcpRuntimeBobSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
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

/**
 * The user opened the project in T3, so Bob trusts it. Only Full access skips
 * Bob's permission prompts; every other mode forwards them through T3.
 */
export function bobAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  return runtimeMode === "full-access" ? ["acp", "--trust", "--auto-approve"] : ["acp", "--trust"];
}

export function buildBobAcpSpawnInput(
  bobSettings: BobAcpRuntimeBobSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: bobSettings?.binaryPath || "bob",
    args: [...bobAcpSpawnArgs(runtimeMode)],
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
  if (/license agreement/i.test(error.errorMessage)) return BOB_LICENSE_REQUIRED_MESSAGE;
  if (/not trusted/i.test(error.errorMessage)) return BOB_UNTRUSTED_WORKSPACE_MESSAGE;
  return undefined;
}

/** Bob switches modes with ACP `session/set_mode`; it has no `mode` configuration option. */
export const setBobSessionMode = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  modeId: string,
): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  runtime
    .request("session/set_mode", {
      sessionId,
      modeId,
    } satisfies EffectAcpSchema.SetSessionModeRequest)
    .pipe(Effect.asVoid);

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
          input.environment,
          input.runtimeMode,
        ),
        // No `authMethodId`: Bob's only method opens an IBM SSO browser on the server host
        // and blocks until the login finishes. Bob signs in from its stored login or API key.
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
