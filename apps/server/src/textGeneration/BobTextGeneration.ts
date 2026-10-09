import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { type BobSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

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
import {
  deleteBobSession,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
} from "../provider/acp/BobAcpSupport.ts";

const BOB_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Bob uses its configured model, so `modelSelection` only routes requests to this instance.
 *
 * Every prompt runs in `bob-text-generation` in T3's provider cache, never the project's folder:
 * T3 starts Bob with `--trust`, and Bob trusts its folder for good and runs that folder's own
 * hooks and MCP servers. Text generation serves threads of every provider, so a project's folder
 * would be trusted and its setup run without the user ever opening a Bob thread there. Each
 * prompt carries all Bob needs, so the folder stays the same, which leaves one entry in Bob's
 * trusted folders.
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
  const workingFolder = path.join(host.paths.providerStatusCacheDir, "bob-text-generation");

  /** Runs one prompt in a throwaway Bob session and decodes the JSON object Bob answers with. */
  const runBobJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    prompt: string;
    outputSchemaJson: S;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
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
      // No runtime mode, so Bob asks before running tools and, with no handler, is refused.
      // A one-shot session needs no MCP tools or subagents.
      const runtime = yield* makeBobAcpRuntime({
        bobSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd: workingFolder,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        disableMcpAndSubagents: true,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

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

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        // Runs before Bob stops, whatever the outcome, so no task is left in the user's Bob history.
        yield* Effect.addFinalizer(() => deleteBobSession(runtime, started.sessionId));
        // Bob's read-only Q&A mode; permission prompts are refused here in any mode.
        yield* Effect.ignore(runtime.setMode("ask"));
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(BOB_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Bob ACP request timed out." }),
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

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Bob returned invalid structured output.",
                cause,
              }),
            ),
        }),
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

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
