import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import { type BobSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  deleteBobSession,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
} from "../provider/acp/BobAcpSupport.ts";
import { type BobAutoReviewContext, reviewBobCommand } from "../provider/acp/bobAutoReview.ts";
import { bobProcessSandboxSpawn, bobSandboxAvailable } from "../provider/acp/bobSandbox.ts";

const BOB_TIMEOUT_MS = 180_000;
/** Bob's mode that runs commands, which reading a checkout needs. */
const BOB_AGENT_MODE_ID = "agent";

export const BOB_REVIEW_GUIDE_NO_HOST_SANDBOX =
  "Bob Shell writes review guides only on macOS and on Linux with Bubblewrap, where T3 can run it read-only. Choose another review guide model, or source control writer model when none is set.";
export const BOB_REVIEW_GUIDE_NO_SANDBOX =
  "T3 could not start Bob read-only in this checkout, so it wrote no review guide. Check the Bob provider's binary path, and on Linux that pasta is installed, or choose another review guide model.";

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * T3's answer to a permission request Bob makes while it reads a checkout, where no one is there
 * to ask: allow once a command T3's rules find only reads, decline everything else, and never
 * answer Always allow, which Bob would keep on its task. Bob's own approval settings run some
 * calls without asking; the sandbox the whole Bob runs in holds those to reading too.
 */
function answerInvestigationPermission(
  request: EffectAcpSchema.RequestPermissionRequest,
  context: BobAutoReviewContext,
): EffectAcpSchema.RequestPermissionResponse {
  const input = request.toolCall.rawInput;
  const raw =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const reads =
    request.toolCall.kind === "execute" &&
    typeof raw.command === "string" &&
    (raw.cwd === undefined || typeof raw.cwd === "string") &&
    (raw.background === undefined || raw.background === false || raw.background === "false") &&
    reviewBobCommand(raw.command, raw.cwd, context).verdict === "allow";
  const option =
    (reads ? request.options.find((candidate) => candidate.kind === "allow_once") : undefined) ??
    request.options.find((candidate) => candidate.kind === "reject_once") ??
    request.options.find((candidate) => candidate.kind === "reject_always");
  return option === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: option.optionId } };
}

/**
 * Bob uses its configured model, so `modelSelection` only routes requests to this instance.
 *
 * Every prompt that carries all Bob needs runs in `bob-text-generation` in T3's provider cache,
 * never the project's folder: T3 starts Bob with `--trust`, and Bob trusts its folder for good and
 * runs that folder's own hooks and MCP servers. Text generation serves threads of every provider,
 * so a project's folder would be trusted and its setup run without the user ever opening a Bob
 * thread there. The folder stays the same, which leaves one entry in Bob's trusted folders.
 *
 * A review guide has Bob read a pull request's disposable checkout instead, in Agent mode so it
 * can run Git, with the whole `bob acp` process in a read-only sandbox (`bobProcessSandboxSpawn`):
 * Bob's own tools, its commands and anything it starts change nothing, and the sandbox hides the
 * checkout's own `.bob` setup. T3 answers Bob's permission requests itself. macOS and Linux only.
 */
export const makeBobTextGeneration = Effect.fn("makeBobTextGeneration")(function* (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const workingFolder = path.join(host.paths.providerStatusCacheDir, "bob-text-generation");

  /**
   * Runs one prompt in a throwaway Bob session and decodes the JSON object Bob answers with. With
   * `investigate`, Bob reads `cwd` read-only, as the request's contract asks.
   */
  const runBobJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    investigate,
  }: {
    operation: TextGenerationOperations.Operation;
    prompt: string;
    outputSchemaJson: S;
    investigate?: { readonly cwd: string; readonly timeoutMs: number } | undefined;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      let cwd = workingFolder;
      let launcher: { readonly command: string; readonly args: ReadonlyArray<string> } | undefined;
      if (investigate === undefined) {
        yield* fileSystem.makeDirectory(workingFolder, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Could not create Bob's working folder.",
                cause,
              }),
          ),
        );
      } else {
        if (!bobSandboxAvailable(platform)) {
          return yield* new TextGenerationError({
            operation,
            detail: BOB_REVIEW_GUIDE_NO_HOST_SANDBOX,
          });
        }
        cwd = investigate.cwd;
        launcher = bobProcessSandboxSpawn({
          platform,
          command: bobSettings.binaryPath || "bob",
          workspace: cwd,
          environment,
          cacheDir: host.paths.providerStatusCacheDir,
          stateDir: host.paths.stateDir,
        });
        if (launcher === undefined) {
          return yield* new TextGenerationError({ operation, detail: BOB_REVIEW_GUIDE_NO_SANDBOX });
        }
      }
      // No runtime mode, so Bob asks before running tools, and only an investigation answers.
      // A one-shot session needs no MCP tools or subagents.
      const runtime = yield* makeBobAcpRuntime({
        bobSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        disableMcpAndSubagents: true,
        ...(launcher === undefined ? {} : { launcher }),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      if (investigate !== undefined) {
        const context = { workspace: cwd, home: environment.HOME || homeDirectory };
        yield* runtime.handleRequestPermission((request) =>
          Effect.succeed(answerInvestigationPermission(request, context)),
        );
      }
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const timeoutMs = investigate?.timeoutMs ?? BOB_TIMEOUT_MS;
      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        // Runs before Bob stops, whatever the outcome, so no task is left in the user's Bob history.
        yield* Effect.addFinalizer(() => deleteBobSession(runtime, started.sessionId));
        if (investigate === undefined) {
          // Bob's read-only Q&A mode; permission prompts are refused here in any mode.
          yield* Effect.ignore(runtime.setMode("ask"));
        } else {
          // Ask mode runs no commands, and a guide needs Git; the sandbox keeps Agent read-only.
          yield* runtime.setMode(BOB_AGENT_MODE_ID).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Bob could not switch to Agent mode to read the checkout.",
                  cause,
                }),
            ),
          );
        }
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail:
                    investigate === undefined
                      ? "Bob ACP request timed out."
                      : `Bob did not finish reading the checkout within ${Math.round(timeoutMs / 60_000)} minutes, so T3 stopped it.`,
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail:
                  describeBobAcpSetupError(cause, bobSettings.authMethod) ??
                  "Bob ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Bob ACP request was cancelled."
              : "Bob returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(
        { operation, outputSchema: outputSchemaJson },
        "Bob",
        trimmed,
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              // Covers an API-key instance with no key, refused before Bob starts.
              detail:
                describeBobAcpSetupError(cause, bobSettings.authMethod) ??
                "Bob ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("BobTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runBobJson({
        operation: "generateCommitMessage",
        prompt,
        outputSchemaJson: outputSchema,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("BobTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runBobJson({
        operation: "generatePrContent",
        prompt,
        outputSchemaJson: outputSchema,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("BobTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runBobJson({
        operation: "generateBranchName",
        prompt,
        outputSchemaJson: outputSchema,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("BobTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runBobJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  // A review guide has Bob read the checkout: upstream's prompt and coverage rules, through Bob.
  const generateReviewGuide = TextGenerationOperations.fromRunner("BobTextGeneration", (request) =>
    runBobJson({
      operation: request.operation,
      prompt: request.prompt,
      outputSchemaJson: request.outputSchema,
      investigate:
        request.investigate === undefined
          ? undefined
          : { cwd: request.cwd, timeoutMs: request.investigate.timeoutMs },
    }),
  ).generateReviewGuide;

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
  } satisfies TextGeneration.TextGeneration["Service"];
});
