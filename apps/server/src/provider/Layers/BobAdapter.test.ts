// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  BOB_DEFAULT_MODEL,
  type BobAuthMethod,
  BobSettings,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { BOB_API_KEY_REQUIRED_MESSAGE, BOB_SSO_SIGN_IN_MESSAGE } from "../acp/BobAcpSupport.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { type BobAdapterLiveOptions, bobApprovalOptions, makeBobAdapter } from "./BobAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

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

type BobAdapter = Effect.Success<ReturnType<typeof makeBobAdapter>>;

const decodeStartedRequestLog = Schema.decodeUnknownOption(
  Schema.Struct({
    event: Schema.Struct({
      kind: Schema.Literal("request"),
      payload: Schema.Struct({ method: Schema.String, status: Schema.Literal("started") }),
    }),
  }),
);

/** A native event log that completes `sent` once T3 starts a `method` request to Bob. */
function signalRequestStarted(method: string, sent: Deferred.Deferred<void>): EventNdjsonLogger {
  return {
    filePath: "",
    write: (entry) =>
      Option.exists(decodeStartedRequestLog(entry), (log) => log.event.payload.method === method)
        ? Deferred.succeed(sent, undefined).pipe(Effect.asVoid)
        : Effect.void,
    close: () => Effect.void,
  };
}

/** The params of each request T3 sent Bob with `method`, in order. */
function paramsOf(requests: ReadonlyArray<Record<string, unknown>>, method: string) {
  return requests
    .filter((entry) => entry.method === method)
    .map((entry) => entry.params as Record<string, unknown>);
}

/** T3's answers to Bob's permission requests, in order. */
function permissionOutcomes(requests: ReadonlyArray<Record<string, unknown>>) {
  return requests
    .filter((entry) => !("method" in entry) && "result" in entry)
    .map((entry) => (entry.result as { readonly outcome: unknown }).outcome);
}

/** Listens from now on; the returned effect waits for the first matching event. */
const nextEvent = (adapter: BobAdapter, predicate: (event: ProviderRuntimeEvent) => boolean) =>
  adapter.streamEvents.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkChild({ startImmediately: true }),
    Effect.map(Fiber.join),
  );

/** Listens from now on; the returned effect waits for every event up to the first matching one. */
const eventsUntil = (adapter: BobAdapter, predicate: (event: ProviderRuntimeEvent) => boolean) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.forkChild({ startImmediately: true }),
    Effect.map(Fiber.join),
  );

/** Runs `body` against an adapter whose `bob` is the mock agent, started with `extraEnv`. */
const withMockBob = <A, E, R>(
  extraEnv: Record<string, string> | undefined,
  body: (input: {
    readonly adapter: BobAdapter;
    readonly requestLogPath: string;
    readonly taskDatabasePath: string;
  }) => Effect.Effect<A, E, R>,
  instance?: {
    readonly authMethod?: BobAuthMethod;
    readonly environment?: NodeJS.ProcessEnv;
    readonly onAvailableCommands?: BobAdapterLiveOptions["onAvailableCommands"];
    readonly onAvailableModes?: BobAdapterLiveOptions["onAvailableModes"];
    readonly refreshUsageLimits?: BobAdapterLiveOptions["refreshUsageLimits"];
    readonly nativeEventLogger?: EventNdjsonLogger;
  },
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
      decodeBobSettings({
        binaryPath,
        ...(instance?.authMethod ? { authMethod: instance.authMethod } : {}),
      }),
      {
        taskDatabasePath,
        ...(instance?.environment ? { environment: instance.environment } : {}),
        ...(instance?.onAvailableCommands
          ? { onAvailableCommands: instance.onAvailableCommands }
          : {}),
        ...(instance?.onAvailableModes ? { onAvailableModes: instance.onAvailableModes } : {}),
        ...(instance?.refreshUsageLimits
          ? { refreshUsageLimits: instance.refreshUsageLimits }
          : {}),
        ...(instance?.nativeEventLogger ? { nativeEventLogger: instance.nativeEventLogger } : {}),
      },
    );
    return yield* body({ adapter, requestLogPath, taskDatabasePath });
  });

const bobAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("bobApprovalOptions", () => {
  it("offers to always allow only when Bob can remember the tool", () => {
    const request = (kinds: ReadonlyArray<"allow_once" | "allow_always" | "reject_once">) => ({
      sessionId: "task",
      toolCall: {
        toolCallId: "tool",
        title: "ls",
        kind: "execute" as const,
        status: "pending" as const,
      },
      options: kinds.map((kind) => ({ optionId: kind, name: kind, kind })),
    });
    assert.deepStrictEqual(
      bobApprovalOptions(request(["allow_once", "reject_once"])).map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
    assert.deepStrictEqual(
      bobApprovalOptions(request(["allow_once", "allow_always", "reject_once"])).map(
        (option) => option.decision,
      ),
      ["cancel", "decline", "acceptForSession", "accept"],
    );
  });
});

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

  it.effect("runs turns in the Bob mode picked for the thread, and plan turns in plan", () =>
    Effect.gen(function* () {
      const offered: Array<[ReadonlyArray<string>, string]> = [];
      yield* withMockBob(
        { T3_ACP_BOB: "1" },
        ({ adapter, requestLogPath }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("bob-picked-mode");
            const cwd = process.cwd();
            /** A Build turn with the Mode option set to `modeId`. */
            const turnIn = (modeId: string) =>
              adapter.sendTurn({
                threadId,
                input: `work in ${modeId}`,
                interactionMode: "default",
                modelSelection: createModelSelection(
                  ProviderInstanceId.make("bob"),
                  BOB_DEFAULT_MODEL,
                  [{ id: "mode", value: modeId }],
                ),
              });
            yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
            const warning = yield* nextEvent(adapter, (event) => event.type === "runtime.warning");

            yield* turnIn("ask");
            yield* turnIn("reviewer");
            const warned = yield* warning;
            yield* adapter.sendTurn({
              threadId,
              input: "plan it",
              interactionMode: "plan",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("bob"),
                BOB_DEFAULT_MODEL,
                [{ id: "mode", value: "ask" }],
              ),
            });

            // A mode this project lacks, such as another project's custom mode, runs in agent.
            assert.equal(
              warned.type === "runtime.warning" && warned.payload.message,
              'Bob has no "reviewer" mode in this project, so this turn runs in Agent mode.',
            );
            const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
            assert.deepStrictEqual(
              paramsOf(requests, "session/set_mode").map((params) => params.modeId),
              ["ask", "agent", "plan"],
            );
            assert.deepStrictEqual(offered, [[["agent", "plan", "ask"], cwd]]);

            yield* adapter.stopSession(threadId);
          }),
        {
          onAvailableModes: (modes, cwd) =>
            Effect.sync(() => {
              offered.push([modes.map((mode) => mode.id), cwd]);
            }),
        },
      );
    }),
  );

  it.effect("answers Bob's permission prompts with its own option ids", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_TOOL_CALLS: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-permissions");
        const decisions: Array<ProviderApprovalDecision> = ["accept", "decline", "cancel"];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "request.opened"
            ? adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                decisions.shift() ?? "cancel",
              )
            : Effect.void,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        for (const input of ["list files", "list them again", "and once more"]) {
          yield* adapter.sendTurn({ threadId, input });
        }

        assert.deepStrictEqual(
          Array.from(yield* Fiber.join(completed), (event) =>
            event.type === "turn.completed" ? event.payload.state : undefined,
          ),
          ["completed", "completed", "cancelled"],
        );
        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(permissionOutcomes(requests), [
          { outcome: "selected", optionId: "allow" },
          { outcome: "selected", optionId: "reject" },
          { outcome: "cancelled" },
        ]);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("names the file in Bob's edit approvals with Bob's own title", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_BOB_TOOL_EDITS: "1" },
      ({ adapter }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-edit-approval");
          const opened = yield* nextEvent(adapter, (event) => event.type === "request.opened");
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "update the readme" })
            .pipe(Effect.forkChild);
          const request = yield* opened;
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(String(request.requestId)),
            "decline",
          );
          yield* Fiber.join(turnFiber);

          assert.deepStrictEqual(
            request.type === "request.opened" && [
              request.payload.requestType,
              request.payload.detail,
            ],
            ["file_change_approval", "Edit README.md"],
          );
          // Bob offered to remember the tool, so the card offers it too.
          assert.deepStrictEqual(
            request.type === "request.opened" &&
              request.payload.options?.map((option) => option.decision),
            ["cancel", "decline", "acceptForSession", "accept"],
          );

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("approves Bob's tools itself in full access and maps their progress", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_TOOL_CALLS: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-full-access-tools");
        const events = yield* eventsUntil(adapter, (event) => event.type === "turn.completed");

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({ threadId, input: "list files" });

        const collected = Array.from(yield* events);
        assert.isFalse(collected.some((event) => event.type === "request.opened"));
        const toolEvents = collected.filter(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.itemId === "bob-tool-1",
        );
        // Bob names the command only when the call starts; its output updates keep showing it.
        assert.isNotEmpty(toolEvents);
        for (const event of toolEvents) {
          assert.equal(event.turnId, turn.turnId);
          assert.deepStrictEqual(
            (event.type === "item.updated" || event.type === "item.completed") && [
              event.payload.itemType,
              event.payload.title,
              event.payload.detail,
            ],
            ["command_execution", "Ran command", "ls -la"],
          );
        }
        const finished = toolEvents.at(-1);
        assert.equal(finished?.type === "item.completed" && finished.payload.status, "completed");
        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(permissionOutcomes(requests), [
          { outcome: "selected", optionId: "allow_always" },
        ]);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("streams Bob's thoughts, plan, and reply on the running turn", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-stream");
        const events = yield* eventsUntil(adapter, (event) => event.type === "turn.completed");

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });

        const onTurn = Array.from(yield* events).filter((event) => event.turnId === turn.turnId);
        assert.deepStrictEqual(
          onTurn.flatMap((event) =>
            event.type === "content.delta"
              ? [[event.payload.streamKind, event.payload.delta]]
              : event.type === "turn.plan.updated"
                ? [["plan", event.payload.plan.map((step) => step.status).join(",")]]
                : [],
          ),
          [
            ["reasoning_text", "Checking the workspace."],
            ["plan", "completed,inProgress"],
            ["assistant_text", "hello from mock"],
          ],
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("reports Bob's slash commands with the workspace of the session", () =>
    Effect.gen(function* () {
      const reported = yield* Queue.unbounded<readonly [ReadonlyArray<string>, string]>();
      yield* withMockBob(
        { T3_ACP_BOB: "1" },
        ({ adapter }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("bob-commands");
            const session = yield* adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            const commands: readonly [ReadonlyArray<string>, string] = [
              ["create-skill", "init"],
              process.cwd(),
            ];
            assert.deepStrictEqual(yield* Queue.take(reported), commands);
            // Bob reports the commands its mode allows again after each mode switch and resume.
            yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
            assert.deepStrictEqual(yield* Queue.take(reported), commands);
            yield* adapter.stopSession(threadId);
            yield* adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: session.resumeCursor,
            });
            assert.deepStrictEqual(yield* Queue.take(reported), commands);
            yield* adapter.stopSession(threadId);
          }),
        {
          onAvailableCommands: (available, cwd) =>
            Queue.offer(reported, [available.map((command) => command.name), cwd]).pipe(
              Effect.asVoid,
            ),
        },
      );
    }),
  );

  it.effect("proposes the final reply of a plan turn as its plan", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1" },
      ({ adapter }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-plan-card");
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          /** The proposed plans and completions among `events`, with their turns. */
          const summarize = (events: Iterable<ProviderRuntimeEvent>) =>
            Array.from(events).flatMap((event) =>
              event.type === "turn.proposed.completed"
                ? [[event.type, event.turnId, event.payload.planMarkdown]]
                : event.type === "turn.completed"
                  ? [[event.type, event.turnId]]
                  : [],
            );

          const planEvents = yield* eventsUntil(
            adapter,
            (event) => event.type === "turn.completed",
          );
          const planTurn = yield* adapter.sendTurn({
            threadId,
            input: "plan it",
            interactionMode: "plan",
          });
          // Bob wrote "before tool", ran a command, then replied "after tool".
          assert.deepStrictEqual(summarize(yield* planEvents), [
            ["turn.proposed.completed", planTurn.turnId, "after tool"],
            ["turn.completed", planTurn.turnId],
          ]);

          const buildEvents = yield* eventsUntil(
            adapter,
            (event) => event.type === "turn.completed",
          );
          const buildTurn = yield* adapter.sendTurn({
            threadId,
            input: "build it",
            interactionMode: "default",
          });
          assert.deepStrictEqual(summarize(yield* buildEvents), [
            ["turn.completed", buildTurn.turnId],
          ]);

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("proposes no plan when a plan turn is stopped", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_CONTENT_THEN_HANG: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-plan-stopped");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const events = yield* eventsUntil(adapter, (event) => event.type === "turn.completed");
        const replying = yield* nextEvent(adapter, (event) => event.type === "content.delta");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "plan it", interactionMode: "plan" })
          .pipe(Effect.forkChild);
        yield* replying;
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);

        const collected = Array.from(yield* events);
        const settled = collected.at(-1);
        assert.equal(settled?.type === "turn.completed" && settled.payload.state, "cancelled");
        assert.isFalse(collected.some((event) => event.type === "turn.proposed.completed"));

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("approves Bob's edits itself in auto-accept-edits and still asks before commands", () =>
    Effect.gen(function* () {
      for (const [runtimeMode, toolEdits, asked] of [
        ["auto-accept-edits", true, []],
        ["auto-accept-edits", false, ["exec_command_approval"]],
        ["auto", true, ["file_change_approval"]],
      ] as const) {
        yield* withMockBob(
          {
            T3_ACP_BOB: "1",
            T3_ACP_EMIT_TOOL_CALLS: "1",
            ...(toolEdits ? { T3_ACP_BOB_TOOL_EDITS: "1" } : {}),
          },
          ({ adapter, requestLogPath }) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make(`bob-${runtimeMode}-${toolEdits}`);
              const opened: Array<string> = [];
              yield* Stream.runForEach(adapter.streamEvents, (event) =>
                event.type === "request.opened"
                  ? Effect.sync(() => opened.push(event.payload.requestType)).pipe(
                      Effect.andThen(
                        adapter.respondToRequest(
                          threadId,
                          ApprovalRequestId.make(String(event.requestId)),
                          "accept",
                        ),
                      ),
                    )
                  : Effect.void,
              ).pipe(Effect.forkChild({ startImmediately: true }));

              yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode });
              yield* adapter.sendTurn({ threadId, input: "update the readme" });

              assert.deepStrictEqual(opened, [...asked]);
              // Every answer allows the tool once, never for the rest of Bob's session.
              const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
              assert.deepStrictEqual(permissionOutcomes(requests), [
                { outcome: "selected", optionId: "allow" },
              ]);

              yield* adapter.stopSession(threadId);
            }),
        );
      }
    }),
  );

  it.effect("sends a slash command to Bob without T3's runtime instructions", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-slash-command");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* adapter.sendTurn({ threadId, input: "/create-skill foo" });

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(
          paramsOf(requests, "session/prompt").map((params) => params.prompt),
          [
            [
              { type: "text", text: "hello" },
              { type: "text", text: buildRuntimeInstructions({ harness: "Bob" }) },
            ],
            [{ type: "text", text: "/create-skill foo" }],
          ],
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("sends image attachments to Bob as ACP image blocks", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-image");
        const { attachmentsDir } = yield* ServerConfig;
        const attachment = {
          type: "image" as const,
          id: "bob-image-12345678-1234-1234-1234-123456789abc",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
        NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
        NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "what is this?", attachments: [attachment] });

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(paramsOf(requests, "session/prompt")[0]?.prompt, [
          { type: "text", text: "what is this?" },
          { type: "image", data: "AQIDBA==", mimeType: "image/png" },
          { type: "text", text: buildRuntimeInstructions({ harness: "Bob" }) },
        ]);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("resumes the stored Bob task instead of opening a new one", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-resume");
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "bob-task-7" },
        });
        assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "bob-task-7" });
        yield* adapter.sendTurn({ threadId, input: "carry on" });

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(
          paramsOf(requests, "session/resume").map((params) => params.sessionId),
          ["bob-task-7"],
        );
        assert.deepStrictEqual(paramsOf(requests, "session/new"), []);
        assert.deepStrictEqual(
          paramsOf(requests, "session/prompt").map((params) => params.sessionId),
          ["bob-task-7"],
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("continues in a new Bob task, with a warning, when the stored one is gone", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_BOB_RESUME_NOT_FOUND: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-resume-gone");
          const warning = yield* nextEvent(adapter, (event) => event.type === "runtime.warning");

          const session = yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: { schemaVersion: 1, sessionId: "deleted-task" },
          });
          assert.deepStrictEqual(session.resumeCursor, {
            schemaVersion: 1,
            sessionId: "mock-session-1",
          });
          const warned = yield* warning;
          assert.equal(
            warned.type === "runtime.warning" && warned.payload.detail,
            "Resource not found: deleted-task",
          );
          assert.isTrue(yield* adapter.hasSession(threadId));

          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.deepStrictEqual(
            requests
              .map((entry) => entry.method)
              .filter((method) => method === "session/resume" || method === "session/new"),
            ["session/resume", "session/new"],
          );

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("moves the thread's Bob task along when the thread moves to another folder", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_BOB_TASK_TRANSFER: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-moved-folder");
        const cwd = process.cwd();

        const session = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "task-in-old-folder" },
        });
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "bob-moved-task",
        });

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(paramsOf(requests, "_bob/task/export"), [
          { sessionId: "task-in-old-folder" },
        ]);
        // The copy lands in this folder and its system prompt names this folder too.
        const [imported] = paramsOf(requests, "_bob/task/import");
        const snapshot = imported?.snapshot as {
          readonly tasks: ReadonlyArray<{
            readonly task: { readonly env: { readonly staticEnvInfo: unknown } };
          }>;
        };
        assert.equal(imported?.cwd, cwd);
        assert.deepStrictEqual(snapshot.tasks[0]?.task.env.staticEnvInfo, {
          primaryWorkspace: cwd,
          systemInfo: {},
        });
        // The original goes, so Bob counts the conversation once.
        assert.deepStrictEqual(paramsOf(requests, "session/delete"), [
          { sessionId: "task-in-old-folder" },
        ]);
        assert.deepStrictEqual(
          paramsOf(requests, "session/resume").map((params) => params.sessionId),
          ["task-in-old-folder", "bob-moved-task"],
        );
        assert.lengthOf(paramsOf(requests, "session/new"), 0);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("closes Bob's session with session/close when the session stops", () =>
    withMockBob({ T3_ACP_BOB: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-close");
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.stopSession(threadId);

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(paramsOf(requests, "session/close"), [
          { sessionId: (session.resumeCursor as { readonly sessionId: string }).sessionId },
        ]);
      }),
    ),
  );

  it.effect("continues in a new Bob task when this Bob cannot resume at all", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_BOB_NO_RESUME: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-resume-unsupported");
        const warning = yield* nextEvent(adapter, (event) => event.type === "runtime.warning");

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "bob-task-7" },
        });
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        });
        assert.equal((yield* warning).type, "runtime.warning");

        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(
          requests
            .map((entry) => entry.method)
            .filter((method) => method === "session/resume" || method === "session/new"),
          ["session/new"],
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("fails the start and keeps the stored task when Bob's resume times out", () =>
    Effect.gen(function* () {
      const resumeStarted = yield* Deferred.make<void>();
      yield* withMockBob(
        { T3_ACP_BOB: "1", T3_ACP_WAIT_FOR_RESUME_RELEASE: "1" },
        ({ adapter, requestLogPath }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("bob-resume-slow");
            const starting = yield* adapter
              .startSession({
                threadId,
                cwd: process.cwd(),
                runtimeMode: "full-access",
                resumeCursor: { schemaVersion: 1, sessionId: "bob-task-7" },
              })
              .pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(resumeStarted);
            // Bob never answers, so the runtime gives up on the resume.
            yield* TestClock.adjust("5 minutes");

            const error = yield* Fiber.join(starting);
            assert.deepStrictEqual(
              error._tag === "ProviderAdapterRequestError" && [error.method, error.detail],
              [
                "session/start",
                "ACP transport operation call-rpc failed for method session/resume.",
              ],
            );
            assert.isFalse(yield* adapter.hasSession(threadId));
            const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
            assert.deepStrictEqual(paramsOf(requests, "session/new"), []);
          }),
        { nativeEventLogger: signalRequestStarted("session/resume", resumeStarted) },
      );
    }),
  );

  it.effect("keeps Bob's sign-in error rather than replacing the stored task", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_BOB_SIGNED_OUT: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const error = yield* adapter
          .startSession({
            threadId: ThreadId.make("bob-resume-signed-out"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: { schemaVersion: 1, sessionId: "bob-task-7" },
          })
          .pipe(Effect.flip);
        assert.equal(
          error._tag === "ProviderAdapterRequestError" && error.detail,
          BOB_SSO_SIGN_IN_MESSAGE,
        );
        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        assert.deepStrictEqual(paramsOf(requests, "session/new"), []);
      }),
    ),
  );

  it.effect("cancels Bob's running prompt when the turn is interrupted", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-interrupt");
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");
          const completed = yield* nextEvent(adapter, (event) => event.type === "turn.completed");

          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run the long command" })
            .pipe(Effect.forkChild);
          yield* working;
          yield* adapter.interruptTurn(threadId);

          const turn = yield* Fiber.join(turnFiber);
          const settled = yield* completed;
          assert.deepStrictEqual(
            settled.type === "turn.completed" && [settled.turnId, settled.payload.state],
            [turn.turnId, "cancelled"],
          );
          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.lengthOf(paramsOf(requests, "session/cancel"), 1);

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("ends the tool Bob leaves running when Stop cancels its prompt", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-interrupt-open-tool");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");
        const events = yield* eventsUntil(adapter, (event) => event.type === "turn.completed");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "run the long command" })
          .pipe(Effect.forkChild);
        yield* working;
        yield* adapter.interruptTurn(threadId);
        const turn = yield* Fiber.join(turnFiber);

        // Bob sends nothing more for the tool, so its last event before the turn ends is T3's.
        const toolEvents = Array.from(yield* events).filter(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.itemId === "tool-call-long-running-1",
        );
        const last = toolEvents.at(-1);
        assert.deepStrictEqual(
          last &&
            (last.type === "item.updated" || last.type === "item.completed") && [
              last.type,
              last.turnId,
              last.payload.status,
            ],
          ["item.completed", turn.turnId, "failed"],
        );

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("shows the running turn on Bob's session until the turn ends", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-session-status");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");
        /** Each session's status and running turn. */
        const sessionStates = adapter
          .listSessions()
          .pipe(
            Effect.map((sessions) =>
              sessions.map((session) => [session.status, session.activeTurnId]),
            ),
          );

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "run the long command" })
          .pipe(Effect.forkChild);
        yield* working;
        const running = yield* sessionStates;
        yield* adapter.interruptTurn(threadId);
        const turn = yield* Fiber.join(turnFiber);

        assert.deepStrictEqual(running, [["running", turn.turnId]]);
        assert.deepStrictEqual(yield* sessionStates, [["ready", undefined]]);

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("ignores a late Stop for a turn that already ended", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-late-stop");
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          /** Sends a turn and waits until Bob is running its tool. */
          const startLongTurn = Effect.gen(function* () {
            const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");
            const turnFiber = yield* adapter
              .sendTurn({ threadId, input: "run the long command" })
              .pipe(Effect.forkChild);
            yield* working;
            return turnFiber;
          });

          const first = yield* startLongTurn;
          yield* adapter.interruptTurn(threadId);
          const firstTurn = yield* Fiber.join(first);
          const second = yield* startLongTurn;
          yield* adapter.interruptTurn(threadId, firstTurn.turnId);

          const [session] = yield* adapter.listSessions();
          assert.equal(session?.status, "running");
          yield* adapter.interruptTurn(threadId, session?.activeTurnId);
          const secondTurn = yield* Fiber.join(second);
          assert.equal(session?.activeTurnId, secondTurn.turnId);
          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.lengthOf(paramsOf(requests, "session/cancel"), 2);

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("cancels Bob's running prompt before it closes a stopped session", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-stop-mid-turn");
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          const events = yield* eventsUntil(adapter, (event) => event.type === "session.exited");
          const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");

          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run the long command" })
            .pipe(Effect.forkChild);
          yield* working;
          yield* adapter.stopSession(threadId);
          const turn = yield* Fiber.join(turnFiber);

          assert.deepStrictEqual(
            Array.from(yield* events).flatMap((event): Array<Array<string | undefined>> =>
              event.type === "turn.completed"
                ? [[event.type, event.turnId, event.payload.state]]
                : event.type === "session.exited"
                  ? [[event.type, event.payload.exitKind]]
                  : [],
            ),
            [
              ["turn.completed", turn.turnId, "cancelled"],
              ["session.exited", "graceful"],
            ],
          );
          // Bob logged the cancel, so it arrived while Bob was still running.
          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.lengthOf(paramsOf(requests, "session/cancel"), 1);
        }),
    ),
  );

  it.effect("refuses Bob's permission prompts once its session is stopping", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1", T3_ACP_BOB_ASK_ON_CANCEL: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-stop-refuses-permissions");
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          const opened = yield* nextEvent(adapter, (event) => event.type === "request.opened");
          const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");

          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run the long command" })
            .pipe(Effect.forkChild);
          yield* working;
          // Bob asks about its next tool when the stop's cancel reaches it. A request opened for
          // it would have no one to answer it, and the stop would never finish.
          const stopping = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
          assert.equal(
            yield* Effect.raceFirst(
              Fiber.join(stopping).pipe(Effect.as("stopped")),
              opened.pipe(Effect.as("asked the user")),
            ),
            "stopped",
          );
          yield* Fiber.join(turnFiber);

          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.deepStrictEqual(permissionOutcomes(requests), [{ outcome: "cancelled" }]);
        }),
    ),
  );

  it.effect("refuses Bob's permission prompts once Stop interrupts the turn", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1", T3_ACP_BOB_ASK_ON_CANCEL: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-interrupt-refuses-permissions");
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          const opened = yield* nextEvent(adapter, (event) => event.type === "request.opened");
          const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");

          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run the long command" })
            .pipe(Effect.forkChild);
          yield* working;
          // Bob asks about its next tool before it acts on the cancel. A card for the turn the
          // user just stopped would hold the cancel until the runtime killed Bob.
          yield* adapter.interruptTurn(threadId);
          assert.equal(
            yield* Effect.raceFirst(
              Fiber.join(turnFiber).pipe(Effect.as("stopped")),
              opened.pipe(Effect.as("asked the user")),
            ),
            "stopped",
          );

          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.deepStrictEqual(permissionOutcomes(requests), [{ outcome: "cancelled" }]);
          assert.isTrue(yield* adapter.hasSession(threadId));

          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("drops a follow-up still waiting behind the prompt that Stop cancels", () =>
    withMockBob(
      { T3_ACP_BOB: "1", T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" },
      ({ adapter, requestLogPath }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-interrupt-queued");
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          const events = yield* eventsUntil(adapter, (event) => event.type === "session.exited");
          const working = yield* nextEvent(adapter, (event) => event.type === "item.updated");

          const first = yield* adapter
            .sendTurn({ threadId, input: "run the long command" })
            .pipe(Effect.forkChild);
          yield* working;
          const followUp = yield* adapter
            .sendTurn({ threadId, input: "then run another" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* adapter.interruptTurn(threadId);

          const turn = yield* Fiber.join(first);
          assert.equal((yield* Fiber.join(followUp)).turnId, turn.turnId);
          yield* adapter.stopSession(threadId);

          assert.deepStrictEqual(
            Array.from(yield* events).flatMap((event) =>
              event.type === "turn.completed" ? [[event.turnId, event.payload.state]] : [],
            ),
            [[turn.turnId, "cancelled"]],
          );
          const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
          assert.lengthOf(paramsOf(requests, "session/prompt"), 1);
        }),
    ),
  );

  it.effect("sends a follow-up after Bob's running prompt and continues the same turn", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_EMIT_TOOL_CALLS: "1" }, ({ adapter, requestLogPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-steer");
        const opened = yield* Queue.unbounded<ApprovalRequestId>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "request.opened"
            ? Queue.offer(opened, ApprovalRequestId.make(String(event.requestId)))
            : Effect.void,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const events = yield* eventsUntil(adapter, (event) => event.type === "session.exited");

        // Bob holds the first prompt open until its tool is approved.
        const first = yield* adapter
          .sendTurn({ threadId, input: "list files" })
          .pipe(Effect.forkChild);
        const firstRequest = yield* Queue.take(opened);
        const followUp = yield* adapter
          .sendTurn({ threadId, input: "then summarize them" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* adapter.respondToRequest(threadId, firstRequest, "accept");
        yield* adapter.respondToRequest(threadId, yield* Queue.take(opened), "accept");

        const turn = yield* Fiber.join(first);
        assert.equal((yield* Fiber.join(followUp)).turnId, turn.turnId);
        yield* adapter.stopSession(threadId);

        assert.deepStrictEqual(
          Array.from(yield* events).flatMap((event) =>
            event.type === "turn.started" || event.type === "turn.completed"
              ? [[event.type, event.turnId]]
              : [],
          ),
          [
            ["turn.started", turn.turnId],
            ["turn.completed", turn.turnId],
          ],
        );
        // The follow-up reaches Bob only after the first prompt's tool was answered.
        const requests = yield* Effect.promise(() => readRequestLog(requestLogPath));
        const followUpIndex = requests.findIndex(
          (entry) =>
            entry.method === "session/prompt" &&
            JSON.stringify(entry.params).includes("then summarize them"),
        );
        const firstAnswerIndex = requests.findIndex((entry) => "result" in entry);
        assert.isAbove(followUpIndex, firstAnswerIndex);
      }),
    ),
  );

  it.effect("reports Bob's reason for a failed turn and settles it", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_FAIL_PROMPT: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-prompt-error");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const completed = yield* nextEvent(adapter, (event) => event.type === "turn.completed");

        const error = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
        assert.deepStrictEqual(
          error._tag === "ProviderAdapterRequestError" && [error.method, error.detail],
          ["session/prompt", "Mock prompt failure"],
        );
        const settled = yield* completed;
        assert.equal(settled.type === "turn.completed" && settled.payload.state, "failed");
        assert.isTrue(yield* adapter.hasSession(threadId));

        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("ends the session with an error when Bob exits mid-turn", () =>
    withMockBob({ T3_ACP_BOB: "1", T3_ACP_BOB_EXIT_ON_PROMPT: "1" }, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("bob-exit");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const events = yield* eventsUntil(adapter, (event) => event.type === "session.exited");

        yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);

        const collected = Array.from(yield* events);
        const settled = collected.find((event) => event.type === "turn.completed");
        assert.equal(settled?.type === "turn.completed" && settled.payload.state, "failed");
        const exited = collected.at(-1);
        assert.equal(exited?.type === "session.exited" && exited.payload.exitKind, "error");
        assert.isFalse(yield* adapter.hasSession(threadId));
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

  it.effect("refreshes Bob's budgets when a session starts and after a turn that spends", () =>
    Effect.gen(function* () {
      const refreshes = yield* Queue.unbounded<readonly [string, boolean]>();
      yield* withMockBob(
        { T3_ACP_BOB: "1" },
        ({ adapter, taskDatabasePath }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("bob-usage-refresh");
            const cwd = process.cwd();
            writeBobTaskCosts(taskDatabasePath, "mock-session-1", { cost: 0.05 });
            yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
            // A pinned team's bar is known before the first turn.
            assert.deepStrictEqual(yield* Queue.take(refreshes), [cwd, false]);

            // A turn that spends nothing leaves the bars alone.
            yield* adapter.sendTurn({ threadId, input: "free" });
            writeBobTaskCosts(taskDatabasePath, "mock-session-1", { cost: 0.07 });
            yield* adapter.sendTurn({ threadId, input: "paid" });
            assert.deepStrictEqual(yield* Queue.take(refreshes), [cwd, true]);
            assert.equal(yield* Queue.size(refreshes), 0);

            yield* adapter.stopSession(threadId);
          }),
        {
          refreshUsageLimits: (cwd, spent) =>
            Queue.offer(refreshes, [cwd, spent]).pipe(Effect.asVoid),
        },
      );
    }),
  );

  it.effect("reports Bob's token and Bobcoin totals after a turn", () =>
    withMockBob(
      { T3_ACP_BOB: "1" },
      ({ adapter, taskDatabasePath }) =>
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
              // No model pinned in Bob's settings: the router's usual `premium-ide` window.
              maxTokens: 270_000,
              totalProcessedTokens: 26_200,
              inputTokens: 25_000,
              cachedInputTokens: 20_000,
              outputTokens: 1_200,
              lastInputTokens: 15_000,
              lastCachedInputTokens: 12_000,
              lastOutputTokens: 700,
              cost: { amount: 0.118, unit: "Bobcoins" },
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
      // A home without Bob settings, so the test never reads the developer's `~/.bob`.
      { authMethod: "sso", environment: { ...process.env, HOME: "/nonexistent-t3code-bob-home" } },
    ),
  );
});
