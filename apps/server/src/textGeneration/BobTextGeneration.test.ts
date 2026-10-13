// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write the raw JSON files and output Bob produces.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { BOB_REVIEW_GUIDE_MACOS_ONLY, makeBobTextGeneration } from "./BobTextGeneration.ts";
import {
  BOB_API_KEY_REQUIRED_MESSAGE,
  BOB_SSO_SIGN_IN_MESSAGE,
} from "../provider/acp/BobAcpSupport.ts";
import { bobSandboxAvailable } from "../provider/acp/bobSandbox.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-bob.ts");

const modelSelection = createModelSelection(ProviderInstanceId.make("bob"), BOB_DEFAULT_MODEL);

const BobTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-text-generation-test-",
}).pipe(Layer.provideMerge(TestProviderHost.layer()), Layer.provideMerge(NodeServices.layer));

/**
 * Runs `effectFn` against a Bob instance whose `bob` is the mock agent in its Bob profile,
 * logging the requests T3 sends to `requestLogPath` and each launch's arguments to
 * `argvLogPath`. Bob's temporary folder, which holds the logs, is a folder of the test's own, so
 * the rest of the test's folder is outside every folder Bob's sandbox lets it write.
 */
function withFakeAcpBob<A, E, R>(
  input: {
    readonly mockEnv?: Record<string, string>;
    readonly authMethod?: BobAuthMethod;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    requestLogPath: string,
    argvLogPath: string,
    workingFolder: string,
    tempDir: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-bob-text-acp-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const bobTemporaryFolder = NodePath.join(tempDir, "tmp");
    NodeFS.mkdirSync(bobTemporaryFolder);
    const requestLogPath = NodePath.join(bobTemporaryFolder, "requests.ndjson");
    const argvLogPath = NodePath.join(bobTemporaryFolder, "argv.log");
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
    // In T3's provider cache, and not created yet: the first prompt creates it.
    const host = yield* ProviderHost.ProviderHost;
    const workingFolder = NodePath.join(host.paths.providerStatusCacheDir, "bob-text-generation");
    const textGeneration = yield* makeBobTextGeneration(
      decodeBobSettings({ binaryPath, authMethod: input.authMethod ?? "sso" }),
      { ...(input.environment ?? process.env), TMPDIR: bobTemporaryFolder },
    ).pipe(
      Effect.provideService(
        HostProcess.Platform,
        input.platform ?? HostProcess.Platform.defaultValue(),
      ),
    );
    return yield* effectFn(textGeneration, requestLogPath, argvLogPath, workingFolder, tempDir);
  }).pipe(Effect.scoped);
}

/** A git checkout of a change, `notes.txt` added on top of a base commit, in `folder`. */
function checkoutOfChange(folder: string): { readonly baseCommit: string } {
  NodeFS.mkdirSync(folder);
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=T3",
        "-c",
        "user.email=t3@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: folder, encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "readme\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Start");
  const baseCommit = git("rev-parse", "HEAD");
  NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "notes\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Add notes");
  return { baseCommit };
}

/** A review guide request for change #7, checked out in `cwd`. */
function reviewGuideInput(cwd: string, baseCommit: string, title = "Add notes") {
  return {
    cwd,
    number: 7,
    title,
    description: "Adds notes.",
    baseBranch: "main",
    baseCommit,
    settledReview: "",
    modelSelection,
  };
}

/** Waits until Bob has logged a request for `method`, by watching its log's folder. */
function untilLogged(requestLogPath: string, method: string): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const logged = () =>
      NodeFS.existsSync(requestLogPath) &&
      readJsonRpcRequests(requestLogPath).some((request) => request.method === method);
    const watcher = NodeFS.watch(NodePath.dirname(requestLogPath), () => {
      if (logged()) resume(Effect.void);
    });
    if (logged()) resume(Effect.void);
    return Effect.sync(() => watcher.close());
  });
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
  it.effect("starts Bob in T3's own folder, without the user's MCP servers or subagents", () =>
    withFakeAcpBob(
      {
        mockEnv: {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "fix-bob-sign-in" }),
        },
      },
      (textGeneration, requestLogPath, argvLogPath, workingFolder) =>
        Effect.gen(function* () {
          yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "bob says I'm signed out",
            modelSelection,
          });
          // Never the project's folder, which `--trust` would trust and whose setup Bob runs.
          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.find((request) => request.method === "_mock/env")?.params?.CWD).toBe(
            NodeFS.realpathSync(workingFolder),
          );
          expect(requests.find((request) => request.method === "session/new")?.params?.cwd).toBe(
            workingFolder,
          );
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

  const sandboxed = bobSandboxAvailable(HostProcess.Platform.defaultValue());

  it.effect.skipIf(!sandboxed)(
    "writes a review guide from the checkout, running only Git's reads, in a read-only sandbox",
    () =>
      withFakeAcpBob({}, (textGeneration, requestLogPath, argvLogPath, _workingFolder, tempDir) =>
        Effect.gen(function* () {
          const checkout = NodePath.join(tempDir, "checkout");
          const { baseCommit } = checkoutOfChange(checkout);
          const guide = yield* textGeneration.generateReviewGuide(
            reviewGuideInput(checkout, baseCommit),
          );
          const report = JSON.parse(guide.stops[0]!.summary) as {
            readonly ran: Record<string, string>;
            readonly answers: Record<string, string>;
            readonly wrote: string;
          };
          const diffStat = `git diff --stat ${baseCommit}...HEAD`;
          const log = `git log --oneline ${baseCommit}..HEAD`;
          // Git's reads run, through Bob's shell, in the checkout.
          expect(report.ran[diffStat]).toContain("notes.txt");
          expect(report.ran[log]).toContain("Add notes");
          // An edit and a command that deletes are declined, and nothing is allowed for good.
          expect(report.answers).toEqual({
            [diffStat]: "allow",
            [log]: "allow",
            edit: "reject",
            execute: "reject",
          });
          // Bob writing the checkout itself, as its own tools would, is stopped.
          expect(report.wrote).toBe("EPERM");
          expect(NodeFS.existsSync(NodePath.join(checkout, "notes.md"))).toBe(false);

          // In the checkout, left in Agent mode, where Bob starts, without MCP servers or subagents.
          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.find((request) => request.method === "_mock/env")?.params?.CWD).toBe(
            checkout,
          );
          expect(requests.filter((request) => request.method === "session/set_mode")).toEqual([]);
          expect(NodeFS.readFileSync(argvLogPath, "utf8").trim().split("\t")).toEqual([
            "acp",
            "--trust",
            "--disable-mcp",
            "--disable-subagents",
          ]);
          expect(sessionDeleteRequests(requestLogPath)).toEqual([{ sessionId: "mock-session-1" }]);
        }),
      ),
  );

  it.effect.skipIf(!sandboxed)("stops Bob when reading the checkout takes too long", () =>
    withFakeAcpBob({}, (textGeneration, requestLogPath, _argvLogPath, _workingFolder, tempDir) =>
      Effect.gen(function* () {
        const checkout = NodePath.join(tempDir, "checkout");
        const { baseCommit } = checkoutOfChange(checkout);
        // The mock keeps working until it is stopped.
        const child = yield* textGeneration
          .generateReviewGuide(reviewGuideInput(checkout, baseCommit, "work slowly"))
          .pipe(Effect.forkChild);
        yield* untilLogged(requestLogPath, "session/prompt");
        yield* TestClock.adjust("15 minutes");
        const error = yield* Fiber.join(child).pipe(Effect.flip);
        expect(error.detail).toBe(
          "Bob did not finish reading the checkout within 15 minutes, so T3 stopped it.",
        );
        const pid = readJsonRpcRequests(requestLogPath).find(
          (request) => request.method === "_mock/env",
        )?.params?.PID;
        expect(() => process.kill(Number(pid), 0)).toThrow();
      }),
    ),
  );

  it.effect("refuses a review guide without starting Bob where the host has no sandbox", () =>
    withFakeAcpBob({ platform: "linux" }, (textGeneration, requestLogPath) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateReviewGuide(reviewGuideInput(process.cwd(), "HEAD")),
        );
        expect(error.detail).toBe(BOB_REVIEW_GUIDE_MACOS_ONLY);
        expect(NodeFS.existsSync(requestLogPath)).toBe(false);
      }),
    ),
  );
});
