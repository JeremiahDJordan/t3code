// @effect-diagnostics nodeBuiltinImport:off
/**
 * Optional end-to-end check of the Bob adapter and Bob text generation against a real,
 * signed-in `bob acp`.
 * Enable with: T3_BOB_ACP_PROBE=1 vp test run BobAdapterCliProbe
 *
 * Uses the machine's Bob login (IBM SSO, or BOB_API_KEY when set) and spends a few
 * Bobcoins. Each turn runs in a throwaway folder that Bob is told to trust. Bob's task
 * database is only read.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import {
  ApprovalRequestId,
  BOB_DEFAULT_MODEL,
  BobSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import { readBobApiKey } from "../acp/BobAcpSupport.ts";
import { makeBobAdapter } from "./BobAdapter.ts";
import { resolveBobTaskDatabasePath } from "./bobTaskUsage.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const decodeBobResumeCursor = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }));
const TURN_TIMEOUT_MS = 180_000;

type BobAdapter = Effect.Success<ReturnType<typeof makeBobAdapter>>;

/** Listens from now on; the returned effect waits for every event up to the first matching one. */
const eventsUntil = (adapter: BobAdapter, predicate: (event: ProviderRuntimeEvent) => boolean) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.forkChild({ startImmediately: true }),
    Effect.map(Fiber.join),
  );

/** `sendTurn` resolves when the turn ends, so turns that need an answer or a stop run in the background. */
const sendInBackground = (adapter: BobAdapter, input: Parameters<BobAdapter["sendTurn"]>[0]) =>
  adapter.sendTurn(input).pipe(Effect.forkChild({ startImmediately: true }));

const isTurnCompleted = (event: ProviderRuntimeEvent) => event.type === "turn.completed";
const turnState = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
  const completed = events.at(-1);
  return completed?.type === "turn.completed" ? completed.payload.state : undefined;
};
/** The last usage reported for the turn that `events` ends with, before its `turn.completed`. */
const completedTurnUsage = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
  const turnId = events.at(-1)?.turnId;
  return events
    .flatMap((event) =>
      event.type === "thread.token-usage.updated" && turnId && event.turnId === turnId
        ? [event.payload.usage]
        : [],
    )
    .at(-1);
};
const replyText = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events
    .map((event) =>
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : "",
    )
    .join("");

/** Ids of the tasks Bob keeps for the folder `taskId` belongs to, read from its task database. */
const bobTaskIdsInFolderOf = (databasePath: string, taskId: string) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT id FROM tasks WHERE project_id = (SELECT project_id FROM tasks WHERE id = ?) ORDER BY id",
        )
        .all(taskId)
        .map((row) => String(row.id));
    } finally {
      database.close();
    }
  });

/** Bob signs in with BOB_API_KEY when this machine sets one, and with its IBM SSO login otherwise. */
const bobSettingsForThisMachine = () =>
  decodeBobSettings({ authMethod: readBobApiKey(process.env) ? "apiKey" : "sso" });

const withRealBob = <A, E, R>(
  body: (input: { readonly adapter: BobAdapter; readonly cwd: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const cwd = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-bob-live-"));
        await NodeFSP.writeFile(NodePath.join(dir, "README.md"), "# Bob live probe\n");
        return dir;
      }),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const adapter = yield* makeBobAdapter(bobSettingsForThisMachine(), {
      environment: process.env,
    });
    return yield* body({ adapter, cwd });
  });

const probeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-live-probe-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Real Bob needs the real clock: `it.live`, with the server layer provided per test.
describe.runIf(process.env.T3_BOB_ACP_PROBE === "1")("Bob adapter against a real Bob", () => {
  it.live(
    "asks before a command, keeps its name, and resumes the conversation in a new process",
    () =>
      withRealBob(({ adapter, cwd }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-live-approval");
          const session = yield* adapter.startSession({
            threadId,
            cwd,
            runtimeMode: "approval-required",
          });

          const approvalTurn = yield* eventsUntil(adapter, isTurnCompleted);
          const opened = adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.opened"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const codewordSend = yield* sendInBackground(adapter, {
            threadId,
            input:
              "Remember the codeword PELICAN. Run the shell command `ls` in this folder, then reply with the single word DONE.",
          });
          const request = yield* Fiber.join(yield* opened);
          assert.isTrue(request._tag === "Some" && request.value.type === "request.opened");
          if (request._tag === "Some" && request.value.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(request.value.requestId)),
              "accept",
            );
          }
          const events = yield* approvalTurn;
          yield* Fiber.join(codewordSend);
          assert.equal(turnState(events), "completed");
          // Bob records a turn's spend before it answers the prompt, so the first turn's usage
          // arrives before its `turn.completed` instead of one turn late. Bob 2.0.5 and later
          // keep only the context size and Bobcoins, so those are what every Bob reports.
          const usage = completedTurnUsage(events);
          assert.isAbove(usage?.usedTokens ?? 0, 0, "the context tokens after the turn");
          assert.isAbove(usage?.cost?.amount ?? 0, 0, "the Bobcoins the turn spent");
          // T3 assumes a known Bob model's context window; ACP does not report one.
          assert.isAbove(usage?.maxTokens ?? 0, 0, "the context window T3 assumes");
          const toolTitles = events.flatMap((event) =>
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            event.payload.itemType === "command_execution"
              ? [`${event.payload.title ?? ""} ${event.payload.detail ?? ""}`]
              : [],
          );
          assert.isTrue(
            toolTitles.some((title) => title.includes("ls")),
            `command kept its name: ${toolTitles.join(" | ")}`,
          );

          yield* adapter.stopSession(threadId);
          assert.isFalse(yield* adapter.hasSession(threadId));

          yield* adapter.startSession({
            threadId,
            cwd,
            runtimeMode: "approval-required",
            resumeCursor: session.resumeCursor,
          });
          const resumedTurn = yield* eventsUntil(adapter, isTurnCompleted);
          const resumedSend = yield* sendInBackground(adapter, {
            threadId,
            input: "What codeword did I ask you to remember? Answer with just the word.",
          });
          const resumed = yield* resumedTurn;
          yield* Fiber.join(resumedSend);
          assert.equal(turnState(resumed), "completed");
          assert.include(replyText(resumed).toUpperCase(), "PELICAN");
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(Effect.scoped, Effect.provide(probeLayer)),
    TURN_TIMEOUT_MS,
  );

  it.live(
    "stops a turn that is waiting on a permission prompt and one that is streaming",
    () =>
      withRealBob(({ adapter, cwd }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("bob-live-stop");
          yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });

          const pendingTurn = yield* eventsUntil(adapter, isTurnCompleted);
          const opened = adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.opened"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const pendingSend = yield* sendInBackground(adapter, {
            threadId,
            input: "Run the shell command `echo hello` in this folder.",
          });
          yield* Fiber.join(yield* opened);
          yield* adapter.interruptTurn(threadId);
          assert.equal(turnState(yield* pendingTurn), "cancelled");
          yield* Fiber.join(pendingSend).pipe(Effect.ignore);

          const streamingTurn = yield* eventsUntil(adapter, isTurnCompleted);
          const firstDelta = adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "content.delta"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const streamingSend = yield* sendInBackground(adapter, {
            threadId,
            input:
              "Without using any tools, count from 1 to 300, one number per line, with a sentence about each number.",
          });
          yield* Fiber.join(yield* firstDelta);
          yield* adapter.interruptTurn(threadId);
          assert.equal(turnState(yield* streamingTurn), "cancelled");
          yield* Fiber.join(streamingSend).pipe(Effect.ignore);

          // Bob still accepts prompts after both stops.
          const planTurn = yield* eventsUntil(adapter, isTurnCompleted);
          const planSend = yield* sendInBackground(adapter, {
            threadId,
            input: "Reply with the single word READY.",
            interactionMode: "plan",
          });
          const planned = yield* planTurn;
          yield* Fiber.join(planSend);
          assert.equal(turnState(planned), "completed");
          assert.include(replyText(planned).toUpperCase(), "READY");
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(Effect.scoped, Effect.provide(probeLayer)),
    TURN_TIMEOUT_MS,
  );

  it.live(
    "generates a thread title in a session that leaves no task in Bob's history",
    () =>
      withRealBob(({ adapter, cwd }) =>
        Effect.gen(function* () {
          const taskDatabasePath = resolveBobTaskDatabasePath(process.env, yield* Path.Path);
          // A chat session keeps its task, which shows the lookup finds this folder's tasks.
          const threadId = ThreadId.make("bob-live-text-generation");
          const session = yield* adapter.startSession({
            threadId,
            cwd,
            runtimeMode: "approval-required",
          });
          yield* adapter.stopSession(threadId);
          const chatTaskId = decodeBobResumeCursor(session.resumeCursor).sessionId;
          assert.deepEqual(yield* bobTaskIdsInFolderOf(taskDatabasePath, chatTaskId), [chatTaskId]);

          // Starts Bob with `--disable-mcp --disable-subagents` and deletes its session after.
          const textGeneration = yield* makeBobTextGeneration(
            bobSettingsForThisMachine(),
            process.env,
          );
          const generated = yield* textGeneration.generateThreadTitle({
            cwd,
            message: "Fix the typo in the README heading",
            modelSelection: createModelSelection(ProviderInstanceId.make("bob"), BOB_DEFAULT_MODEL),
          });
          assert.isAbove(generated.title.trim().length, 0);
          assert.deepEqual(yield* bobTaskIdsInFolderOf(taskDatabasePath, chatTaskId), [chatTaskId]);
        }),
      ).pipe(Effect.scoped, Effect.provide(probeLayer)),
    TURN_TIMEOUT_MS,
  );
});
