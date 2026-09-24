// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  BOB_DEFAULT_MODEL,
  type BobAuthMethod,
  BobSettings,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { BOB_API_KEY_REQUIRED_MESSAGE } from "../acp/BobAcpSupport.ts";
import { makeBobAdapter } from "./BobAdapter.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockBob(requestLogPath: string, extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-bob",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

/** Sets the running totals Bob records for a task, as Bob does on each spend. */
function writeBobTaskCosts(databasePath: string, taskId: string, costs: Record<string, number>) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, costs TEXT)");
  database
    .prepare("INSERT INTO tasks (id, costs) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET costs = ?")
    .run(taskId, JSON.stringify(costs), JSON.stringify(costs));
  database.close();
}

async function readRequestLog(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const withMockBob = <A, E, R>(
  extraEnv: Record<string, string> | undefined,
  body: (input: {
    readonly adapter: Effect.Success<ReturnType<typeof makeBobAdapter>>;
    readonly requestLogPath: string;
    readonly taskDatabasePath: string;
  }) => Effect.Effect<A, E, R>,
  instance?: { readonly authMethod: BobAuthMethod; readonly environment: NodeJS.ProcessEnv },
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-log-")),
    );
    const requestLogPath = NodePath.join(dir, "requests.ndjson");
    // Absent until a test writes it, so no test reads the real `~/.bob`.
    const taskDatabasePath = NodePath.join(dir, "bob.db");
    const binaryPath = yield* Effect.promise(() => makeMockBob(requestLogPath, extraEnv));
    const adapter = yield* makeBobAdapter(
      decodeBobSettings({ binaryPath, ...(instance ? { authMethod: instance.authMethod } : {}) }),
      {
        taskDatabasePath,
        ...(instance ? { environment: instance.environment } : {}),
      },
    );
    return yield* body({ adapter, requestLogPath, taskDatabasePath });
  });

const bobAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(bobAdapterTestLayer)("BobAdapterLive", (it) => {
  it.effect("switches between Bob's plan and agent modes without unsupported requests", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-mock-turn");
        const completedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        assert.equal(session.model, BOB_DEFAULT_MODEL);
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        });

        yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
        yield* adapter.sendTurn({ threadId, input: "build it", interactionMode: "default" });
        const completed = Array.from(yield* Fiber.join(completedFiber));
        assert.deepStrictEqual(
          completed.map((event) => event.type === "turn.completed" && event.payload.state),
          ["completed", "completed"],
        );

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(
          requests
            .filter((entry) => entry.method === "session/set_mode")
            .map((entry) => (entry.params as { readonly modeId: string }).modeId),
          ["plan", "agent"],
        );
        // Bob opens a browser for `authenticate` and implements neither config options nor models.
        for (const method of ["authenticate", "session/set_config_option", "session/set_model"]) {
          assert.notInclude(
            requests.map((entry) => entry.method),
            method,
          );
        }

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("answers permission prompts with Bob's own option ids", () =>
    withMockBob(
      { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_ALLOW_ONCE_OPTION_ID: "proceed_once" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-permission-option-id");
          const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            event.type === "request.opened"
              ? adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "accept",
                )
              : Effect.void,
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "run a tool", attachments: [] });

          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.isTrue(
            requests.some(
              (entry) =>
                !("method" in entry) &&
                JSON.stringify(entry.result).includes('"optionId":"proceed_once"'),
            ),
          );

          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("refuses an API-key instance without BOB_API_KEY before starting Bob", () =>
    withMockBob(
      undefined,
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const error = yield* adapter
            .startSession({
              threadId: ThreadId.make("bob-api-key-missing"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
            })
            .pipe(Effect.flip);
          assert.equal(
            error._tag === "ProviderAdapterProcessError" && error.detail,
            BOB_API_KEY_REQUIRED_MESSAGE,
          );
          const bobStarted = yield* Effect.promise(() =>
            NodeFSP.access(requestLogPath).then(
              () => true,
              () => false,
            ),
          );
          assert.isFalse(bobStarted);
        }),
      {
        authMethod: "apiKey",
        environment: { ...process.env, BOB_API_KEY: "", BOBSHELL_API_KEY: "" },
      },
    ),
  );

  it.effect("reports Bob's token totals after a turn", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, taskDatabasePath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-usage");
        // A resumed task already has spend; the turn is measured from here.
        writeBobTaskCosts(taskDatabasePath, "mock-session-1", {
          input: 10_000,
          output: 500,
          cacheRead: 8_000,
          cacheWrite: 1_000,
          cost: 0.05,
          contextTokens: 10_500,
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "thread.token-usage.updated" || event.type === "turn.completed",
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        writeBobTaskCosts(taskDatabasePath, "mock-session-1", {
          input: 25_000,
          output: 1_200,
          cacheRead: 20_000,
          cacheWrite: 1_500,
          cost: 0.118,
          contextTokens: 15_700,
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });

        const [usage, completed] = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepStrictEqual(
          usage?.type === "thread.token-usage.updated" && usage.turnId,
          turn.turnId,
        );
        assert.deepStrictEqual(
          usage?.type === "thread.token-usage.updated" && usage.payload.usage,
          {
            usedTokens: 15_700,
            totalProcessedTokens: 26_200,
            inputTokens: 25_000,
            cachedInputTokens: 20_000,
            outputTokens: 1_200,
            lastInputTokens: 15_000,
            lastCachedInputTokens: 12_000,
            lastOutputTokens: 700,
          },
        );
        assert.deepStrictEqual(
          completed?.type === "turn.completed" && completed.payload.tokenUsage,
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 15_000,
            cachedInputTokens: 12_000,
            cacheCreationTokens: 500,
            outputTokens: 700,
            hasSubagents: false,
          },
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );
});
