// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write the raw JSON files and output Bob produces.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import {
  BOB_DEFAULT_MODEL,
  type BobAuthMethod,
  BobSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeBobTextGeneration } from "./BobTextGeneration.ts";
import {
  BOB_API_KEY_REQUIRED_MESSAGE,
  BOB_SSO_SIGN_IN_MESSAGE,
} from "../provider/acp/BobAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const modelSelection = createModelSelection(ProviderInstanceId.make("bob"), BOB_DEFAULT_MODEL);

const BobTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Runs `effectFn` against a Bob instance whose `bob` is the mock agent in its Bob profile,
 * logging the requests T3 sends to `requestLogPath` and each launch's arguments to
 * `argvLogPath`.
 */
function withFakeAcpBob<A, E, R>(
  input: {
    readonly mockEnv?: Record<string, string>;
    readonly authMethod?: BobAuthMethod;
    readonly environment?: NodeJS.ProcessEnv;
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    requestLogPath: string,
    argvLogPath: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-bob-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    const argvLogPath = NodePath.join(tempDir, "argv.log");
    const binaryPath = writeFakeCli({
      directory: NodePath.join(tempDir, "bin"),
      name: "bob",
      env: { T3_ACP_BOB: "1", T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...input.mockEnv },
      source: execScriptSource({
        scriptPath: mockAgentPath,
        expectedArgs: ["acp", "--trust"],
        argvLogPath,
      }),
    });
    const textGeneration = yield* makeBobTextGeneration(
      decodeBobSettings({ binaryPath, authMethod: input.authMethod ?? "sso" }),
      input.environment ?? process.env,
    );
    return yield* effectFn(textGeneration, requestLogPath, argvLogPath);
  }).pipe(Effect.scoped);
}

/** The `session/delete` requests T3 sent, by their params. */
function sessionDeleteRequests(requestLogPath: string) {
  return readJsonRpcRequests(requestLogPath)
    .filter((request) => request.method === "session/delete")
    .map((request) => request.params);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(BobTextGenerationTestLayer)("BobTextGeneration", (it) => {
  it.effect("starts Bob without the user's MCP servers or subagents", () =>
    withFakeAcpBob(
      {
        mockEnv: {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "fix-bob-sign-in" }),
        },
      },
      (textGeneration, _requestLogPath, argvLogPath) =>
        Effect.gen(function* () {
          yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "bob says I'm signed out",
            modelSelection,
          });
          expect(NodeFS.readFileSync(argvLogPath, "utf8").trim().split("\t")).toEqual([
            "acp",
            "--trust",
            "--disable-mcp",
            "--disable-subagents",
          ]);
        }),
    ),
  );

  it.effect("generates in Bob's read-only ask mode without signing in or picking a model", () =>
    Effect.gen(function* () {
      for (const instance of [
        { authMethod: "sso", environment: process.env },
        { authMethod: "apiKey", environment: { ...process.env, BOB_API_KEY: "test-key" } },
      ] as const) {
        yield* withFakeAcpBob(
          {
            ...instance,
            mockEnv: {
              T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
                subject: "Add Bob provider",
                body: "Wire up Bob Shell through its ACP agent.",
              }),
            },
          },
          (textGeneration, requestLogPath) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateCommitMessage({
                cwd: process.cwd(),
                branch: "feature/bob",
                stagedSummary: "M apps/server/src/provider/Drivers/BobDriver.ts",
                stagedPatch: "diff --git a/.../BobDriver.ts b/.../BobDriver.ts",
                modelSelection,
              });
              expect(generated).toEqual({
                subject: "Add Bob provider",
                body: "Wire up Bob Shell through its ACP agent.",
              });

              const requests = readJsonRpcRequests(requestLogPath);
              expect(
                requests
                  .filter((request) => request.method === "session/set_mode")
                  .map((request) => request.params),
              ).toEqual([{ sessionId: "mock-session-1", modeId: "ask" }]);
              const setModeIndex = requests.findIndex(
                (request) => request.method === "session/set_mode",
              );
              const promptIndex = requests.findIndex(
                (request) => request.method === "session/prompt",
              );
              expect(setModeIndex).toBeLessThan(promptIndex);
              // The mock rejects `session/delete`; generation still succeeds.
              expect(sessionDeleteRequests(requestLogPath)).toEqual([
                { sessionId: "mock-session-1" },
              ]);
              expect(requests.at(-1)?.method).toBe("session/delete");
              for (const method of [
                "authenticate",
                "session/set_model",
                "session/set_config_option",
              ]) {
                expect(requests.some((request) => request.method === method)).toBe(false);
              }
            }),
        );
      }
    }),
  );

  it.effect("returns the thread title Bob wraps in conversational text", () =>
    withFakeAcpBob(
      {
        mockEnv: {
          T3_ACP_PROMPT_RESPONSE_TEXT: `Here is a title:\n${JSON.stringify({ title: "Fix Bob sign-in" })}`,
        },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "bob says I'm signed out",
            modelSelection,
          });
          expect(generated.title).toBe("Fix Bob sign-in");
        }),
    ),
  );

  it.effect("asks for the API key without starting Bob when the instance has none", () =>
    withFakeAcpBob(
      {
        authMethod: "apiKey",
        environment: { ...process.env, BOB_API_KEY: "", BOBSHELL_API_KEY: "" },
      },
      (textGeneration, requestLogPath) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "anything",
              modelSelection,
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toBe(BOB_API_KEY_REQUIRED_MESSAGE);
          expect(NodeFS.existsSync(requestLogPath)).toBe(false);
        }),
    ),
  );

  it.effect("says how to sign in when Bob refuses the session", () =>
    withFakeAcpBob({ mockEnv: { T3_ACP_BOB_SIGNED_OUT: "1" } }, (textGeneration, requestLogPath) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection,
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toBe(BOB_SSO_SIGN_IN_MESSAGE);
        // No session was created, so there is nothing to delete.
        expect(sessionDeleteRequests(requestLogPath)).toEqual([]);
      }),
    ),
  );

  it.effect("reports other Bob failures without sign-in guidance and deletes the session", () =>
    withFakeAcpBob({ mockEnv: { T3_ACP_FAIL_PROMPT: "1" } }, (textGeneration, requestLogPath) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "anything",
            modelSelection,
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toBe("Bob ACP request failed.");
        expect(sessionDeleteRequests(requestLogPath)).toEqual([{ sessionId: "mock-session-1" }]);
      }),
    ),
  );
});
