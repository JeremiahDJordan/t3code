// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures read and search the mock Bob's protocol log.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BobSettings,
  CheckpointId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2ProviderThread,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import type { TaskTranscript } from "../../provider/taskTranscript.ts";
import { BOB_SSO_SIGN_IN_MESSAGE } from "../../provider/acp/BobAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  bobRelayHasTurn,
  type BobRelays,
  detachBobRelayLinks,
  makeBobRelayHost,
  makeBobRelays,
  readBobRelayMeta,
} from "../../provider/acp/BobRelay.ts";
import * as TmuxServer from "../../tmux/TmuxServer.ts";
import { type ProviderAdapterV2Event, ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  BOB_EMPTY_REPLY_MESSAGE,
  decodeBobTitle,
  makeBobAcpAdapterFlavor,
  makeBobAdapterV2,
} from "./BobAdapterV2.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

/** The server's MCP credential registry, as a running server holds it. */
const mcpRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-bob-test")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
);

const flavor = makeBobAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("bob-test"),
  settings: decodeBobSettings({ enabled: true }),
  environment: {},
  childProcessSpawner: undefined as never,
  crypto: undefined as never,
  selfInvocation: undefined as never,
  fileSystem: undefined as never,
  idAllocator: undefined as never,
  serverConfig: undefined as never,
});

function permissionRequest(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return { sessionId: "session-1", options, toolCall: { toolCallId: "tool-1", title: "Edit" } };
}

describe("BobAdapterV2 flavor", () => {
  it("reads Bob's HTML-escaped tool titles as Bob meant them", () => {
    assert.equal(decodeBobTitle("echo a&#x3D;b &amp;&amp; ls &lt;dir&gt;"), "echo a=b && ls <dir>");
    assert.equal(
      decodeBobTitle("keeps &bogus; and &#0; as they are"),
      "keeps &bogus; and &#0; as they are",
    );
  });

  it("recognizes a subagent by its title ending in its description, and strips its report's tags", () => {
    const running = flavor.extractSubagentUpdate?.({
      toolCallId: "call-1",
      kind: "other",
      status: "inProgress",
      data: {
        title: "Running subagent: Count the files",
        rawInput: { description: "Count the files" },
      },
    });
    assert.deepInclude(running, {
      nativeTaskId: "call-1",
      prompt: "Count the files",
      status: "running",
    });
    assert.isNull(running?.result);
    const finished = flavor.extractSubagentUpdate?.({
      toolCallId: "call-1",
      kind: "other",
      status: "completed",
      data: {
        title: "Running subagent: Count the files",
        rawInput: { description: "Count the files" },
        rawOutput: { result: "<task_result>\nThere are 2 files.\n</task_result>" },
      },
    });
    assert.equal(finished?.result, "There are 2 files.");
    // A tool whose title is just its description, or another kind, is not a subagent.
    assert.isUndefined(
      flavor.extractSubagentUpdate?.({
        toolCallId: "call-2",
        kind: "other",
        data: { title: "Count the files", rawInput: { description: "Count the files" } },
      }),
    );
    assert.isUndefined(
      flavor.extractSubagentUpdate?.({
        toolCallId: "call-3",
        kind: "execute",
        data: { title: "Running subagent: ls", rawInput: { description: "ls" } },
      }),
    );
  });

  it("offers only the approval answers Bob can take", () => {
    assert.deepEqual(
      flavor
        .approvalOptions?.(
          permissionRequest([
            { optionId: "once", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ]),
        )
        .map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
    assert.deepEqual(
      flavor
        .approvalOptions?.(
          permissionRequest([
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "once", name: "Allow", kind: "allow_once" },
          ]),
        )
        .map((option) => option.decision),
      ["cancel", "acceptForSession", "accept"],
    );
  });

  it("lets Bob's edits through in Accept edits, and leaves Auto's to the runtime's review", () => {
    const answer = (runtimeMode: RuntimeMode, kind: EffectAcpSchema.ToolKind) =>
      flavor.permissionDisposition?.(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: "default",
          cwd: "/workspace",
        }),
        {
          ...permissionRequest([{ optionId: "allow", name: "Allow once", kind: "allow_once" }]),
          toolCall: { toolCallId: "tool-1", title: "A tool", kind },
        },
      );
    const kinds = [
      "edit",
      "delete",
      "move",
      "execute",
      "search",
      "fetch",
      "other",
      "read",
    ] as const;
    const answers = (runtimeMode: RuntimeMode) =>
      Object.fromEntries(kinds.map((kind) => [kind, answer(runtimeMode, kind)]));
    const editsThrough = {
      edit: "allow",
      delete: "allow",
      move: "allow",
      execute: "ask",
      search: "ask",
      fetch: "ask",
      other: "ask",
      read: "ask",
    } as const;
    assert.deepEqual(
      answers("approval-required"),
      Object.fromEntries(kinds.map((kind) => [kind, "ask"])),
    );
    assert.deepEqual(answers("auto-accept-edits"), editsThrough);
    // Bob's runtime wrapper answers what Auto's review allows; the rest reaches the adapter.
    assert.deepEqual(answers("auto"), Object.fromEntries(kinds.map((kind) => [kind, "ask"])));
    assert.deepEqual(
      answers("full-access"),
      Object.fromEntries(kinds.map((kind) => [kind, "allow"])),
    );
  });

  it("starts every turn in Agent but leaves Plan turns to the plan mode switch", () => {
    const mode = (interactionMode: "default" | "plan") =>
      flavor.sessionModeForPolicy?.(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode,
          cwd: "/workspace",
        }),
      );
    assert.equal(mode("default"), "agent");
    assert.isUndefined(mode("plan"));
  });

  it("explains Bob's setup refusals and the reason in a failed turn", () => {
    const signIn = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Authentication required",
      }),
    );
    assert.equal(signIn?.message, BOB_SSO_SIGN_IN_MESSAGE);
    const details = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "The model is overloaded." },
      }),
    );
    assert.equal(details?.message, "The model is overloaded.");
  });

  it("stops a turn as a usage limit only when Bob says its Bobcoins are spent", () => {
    // Bob 2.0.5's budget errors, as its ACP library sends them.
    const failure = (name: string, title: string, description: string) =>
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
          data: { details: `${name}: ${JSON.stringify({ title, description })}` },
        }),
      );
    const monthly = failure(
      "BudgetExceededError",
      "Budget Exceeded",
      "Oh no! It looks like you've gone over your budget allowance of 50 Bobcoins.",
    );
    assert.equal(monthly?.class, "usage_limit");
    assert.match(monthly?.resetAt ?? "", /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    const team = failure(
      "BudgetExceededError",
      "Team Budget Exceeded",
      "Your team budget has been exceeded. Please contact your account owner.",
    );
    assert.equal(team?.class, "usage_limit");
    assert.isDefined(team?.resetAt);
    const trial = failure(
      "TrialExpiredError",
      "Your Free trial has expired",
      "You have reached the end of your free trial period. Upgrade your plan to continue.",
    );
    assert.equal(trial?.class, "usage_limit");
    assert.isUndefined(trial?.resetAt);
    // The same error class for a suspended plan, or a profile Bob could not read.
    for (const description of [
      "Your plan has been suspended. You can manage your subscription to update your plan and continue.",
      "Unable to retrieve profile information.",
    ]) {
      const other = failure("BudgetExceededError", "Plan suspended", description);
      assert.equal(other?.class, "provider_error");
      assert.equal(other?.message, description);
    }
  });
});

const sessionLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-bob-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

interface BobRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * Opens the V2 adapter against the mock Bob, which records every request and keeps its tasks in a
 * file every mock Bob shares, as real Bobs share their task database.
 */
const openBob = (input: {
  readonly mockEnv?: Record<string, string>;
  /** Bob's task usage by reading, the first when a session opens. */
  readonly usageReadings?: ReadonlyArray<{ used: number; size: number; bobcoins: number }>;
  /** The steps Bob's task database holds for every subagent run. */
  readonly subagentSteps?: TaskTranscript;
  /** The Bob mode the thread picked in the model picker. */
  readonly mode?: string;
  /** Runs Bob under relays in tmux. */
  readonly relays?: BobRelays;
  /** Collects the tool call ids subagent steps are read for. */
  readonly subagentStepReads?: Array<string>;
  /** The thread's runtime mode, Full access unless given. */
  readonly runtimeMode?: RuntimeMode;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-v2-turn-" });
    const workspace = path.join(tempDir, "workspace");
    yield* fileSystem.makeDirectory(workspace);
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    const mockPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-bob.ts", import.meta.url),
    );
    const binaryPath = writeFakeCli({
      directory: path.join(tempDir, "bin"),
      name: "bob",
      env: {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_BOB_STATE_PATH: path.join(tempDir, "bob-state.json"),
        T3_ACP_BOB_RELEASE_PATH: path.join(tempDir, "release"),
        ...input.mockEnv,
      },
      source: execScriptSource({ scriptPath: mockPath }),
    });
    const commands: Array<{ names: ReadonlyArray<string>; cwd: string }> = [];
    const modes: Array<{ ids: ReadonlyArray<string>; cwd: string }> = [];
    const spentIn: Array<string> = [];
    let usageReading = 0;
    const instanceId = ProviderInstanceId.make("bob-turn-test");
    const adapter = makeBobAdapterV2({
      ...(input.relays ? { relays: input.relays } : {}),
      instanceId,
      settings: decodeBobSettings({ enabled: true, binaryPath }),
      environment: process.env,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      crypto: yield* Crypto.Crypto,
      selfInvocation: yield* resolveSelfInvocation(),
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      onAvailableCommands: (available, cwd) =>
        Effect.sync(() => {
          commands.push({ names: available.map((command) => command.name), cwd });
        }),
      onAvailableModes: (available, cwd) =>
        Effect.sync(() => {
          modes.push({ ids: available.map((mode) => mode.id), cwd });
        }),
      ...(input.usageReadings
        ? {
            readTaskUsage: () => Effect.sync(() => input.usageReadings?.[usageReading++]),
            onBobcoinsSpent: (cwd: string) =>
              Effect.sync(() => {
                spentIn.push(cwd);
              }),
          }
        : {}),
      ...(input.subagentSteps
        ? {
            readSubagentSteps: (_parentSessionId: string, toolCallId: string) =>
              Effect.sync(() => {
                input.subagentStepReads?.push(toolCallId);
                return input.subagentSteps!;
              }),
          }
        : {}),
    });
    const threadId = ThreadId.make("thread-bob-turn");
    const modelSelection = {
      instanceId,
      model: "bob-default",
      ...(input.mode ? { options: [{ id: "_t3/session-mode", value: input.mode }] } : {}),
    };
    const policyFor = (cwd: string, interactionMode: "default" | "plan" = "default") =>
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode,
        cwd,
      });
    let sessions = 0;
    let turns = 0;
    /** Opens a session in `cwd`, as a turn after a server start or a folder change does. */
    const openSession = (cwd: string, options: { readonly bobTaskId?: string } = {}) =>
      adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-bob-${++sessions}`),
        modelSelection,
        runtimePolicy: policyFor(cwd),
        ...(options.bobTaskId === undefined ? {} : { initialNativeThreadId: options.bobTaskId }),
      });
    /** Runs one turn on `session` until it ends, and returns its events. */
    const runTurn = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      providerThread: OrchestrationV2ProviderThread,
      text: string,
      options: {
        readonly cwd?: string;
        readonly interactionMode?: "default" | "plan";
        /**
         * Runs once the turn started, with its events as they arrive. "stop" returns the events so
         * far without waiting for the turn to end, as when T3 stops mid-turn.
         */
        readonly whileRunning?: (turn: {
          readonly runId: RunId;
          readonly nextEvent: Effect.Effect<ProviderAdapterV2Event>;
        }) => Effect.Effect<void | "stop", ProviderAdapter.ProviderAdapterV2Error>;
        /** The message is a wake T3 started for the provider, not a user's. */
        readonly wake?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        const turn = ++turns;
        const cwd = options.cwd ?? workspace;
        const runtimePolicy = policyFor(cwd, options.interactionMode);
        const now = yield* DateTime.now;
        const seen: Array<ProviderAdapterV2Event> = [];
        const arrivals = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const collected = yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runForEach((event) =>
            Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(arrivals, event))),
          ),
          Effect.forkScoped,
        );
        yield* session.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-bob-turn"),
            title: "Bob turn",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: runtimePolicy.runtimeMode,
            interactionMode: options.interactionMode ?? "default",
            branch: null,
            worktreePath: cwd,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make(`run-bob-${turn}`),
          runOrdinal: turn,
          providerTurnOrdinal: turn,
          attemptId: RunAttemptId.make(`attempt-bob-${turn}`),
          rootNodeId: NodeId.make(`node-bob-${turn}`),
          providerThread,
          message: {
            createdBy: options.wake === true ? "agent" : "user",
            creationSource: options.wake === true ? "provider" : "web",
            messageId: MessageId.make(`message-bob-${turn}`),
            text,
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        if (options.whileRunning) {
          const outcome = yield* options.whileRunning({
            runId: RunId.make(`run-bob-${turn}`),
            nextEvent: Queue.take(arrivals),
          });
          if (outcome === "stop") {
            yield* Fiber.interrupt(collected);
            return seen;
          }
        }
        yield* Fiber.join(collected);
        return seen;
      });
    /** When the mock Bobs stamped each prompt they received, in order. */
    const promptTimestamps = (): ReadonlyArray<number> => {
      const state = JSON.parse(
        NodeFS.readFileSync(path.join(tempDir, "bob-state.json"), "utf8"),
      ) as {
        readonly tasks: Record<
          string,
          {
            readonly messages: ReadonlyArray<{
              readonly role: string;
              readonly data: { readonly _meta?: { readonly timestamp?: number } };
            }>;
          }
        >;
      };
      return Object.values(state.tasks)
        .flatMap((task) => task.messages)
        .flatMap((message) =>
          message.role === "user" && message.data._meta?.timestamp !== undefined
            ? [message.data._meta.timestamp]
            : [],
        )
        .toSorted((a, b) => a - b);
    };
    /** The requests T3 sent every mock Bob, in order. */
    const requests = (): ReadonlyArray<BobRequest> =>
      NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => {
          const message = JSON.parse(line) as {
            readonly method?: string;
            readonly params?: Record<string, unknown>;
          };
          return message.method ? [{ method: message.method, params: message.params ?? {} }] : [];
        });
    return {
      threadId,
      modelSelection,
      workspace,
      tempDir,
      commands,
      modes,
      spentIn,
      policyFor,
      openSession,
      runTurn,
      requests,
      promptTimestamps,
      /** Lets the mock Bob's "work slowly" tool call finish. */
      release: () => NodeFS.writeFileSync(path.join(tempDir, "release"), ""),
    };
  });

/** Runs one turn through the V2 adapter against the mock Bob, until the turn ends. */
const runBobTurn = (input: {
  readonly text: string;
  readonly interactionMode?: "default" | "plan";
  readonly mockEnv?: Record<string, string>;
  readonly usageReadings?: ReadonlyArray<{ used: number; size: number; bobcoins: number }>;
  readonly subagentSteps?: TaskTranscript;
  readonly mode?: string;
}) =>
  Effect.gen(function* () {
    const bob = yield* openBob(input);
    const session = yield* bob.openSession(bob.workspace);
    const providerThread = yield* session.ensureThread({
      threadId: bob.threadId,
      modelSelection: bob.modelSelection,
      runtimePolicy: bob.policyFor(bob.workspace, input.interactionMode),
    });
    const events = yield* bob.runTurn(session, providerThread, input.text, {
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    });
    return {
      events,
      methods: bob.requests().map((request) => request.method),
      commands: bob.commands,
      modes: bob.modes,
      workspace: bob.workspace,
      spentIn: bob.spentIn,
    };
  });

const terminalOf = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
  events.find((event) => event.type === "turn.terminal");

describe("BobAdapterV2 turns", () => {
  it.effect(
    "runs a turn without ever asking Bob to authenticate, and learns its commands and modes",
    () =>
      Effect.gen(function* () {
        const result = yield* runBobTurn({ text: "hello" });
        assert.equal(terminalOf(result.events)?.status, "completed");
        assert.notInclude(result.methods, "authenticate");
        assert.include(result.methods, "session/new");
        assert.include(result.methods, "session/prompt");
        assert.isTrue(
          result.events.some(
            (event) =>
              event.type === "message.updated" &&
              JSON.stringify(event.message).includes("Hello from Bob."),
          ),
        );
        assert.deepEqual(result.modes[0], {
          ids: ["agent", "ask", "plan", "reviewer"],
          cwd: result.workspace,
        });
        assert.deepEqual(result.commands.at(-1), {
          names: ["init", "review"],
          cwd: result.workspace,
        });
      }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("says how to sign in, or accept Bob's license, when Bob refuses the session", () =>
    Effect.gen(function* () {
      const signedOut = yield* Effect.flip(
        runBobTurn({ text: "hello", mockEnv: { T3_ACP_BOB_SIGNED_OUT: "1" } }),
      );
      assert.equal(makeProviderFailure({ cause: signedOut }).message, BOB_SSO_SIGN_IN_MESSAGE);
      const unlicensed = yield* Effect.flip(
        runBobTurn({ text: "hello", mockEnv: { T3_ACP_BOB_LICENSE_REQUIRED: "1" } }),
      );
      assert.equal(
        makeProviderFailure({ cause: unlicensed }).message,
        "Run bob with --accept-license to accept the license. Run `bob` once in a terminal to accept it.",
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("says when Bob lacks the mode a turn picked, which then runs in Agent mode", () =>
    Effect.gen(function* () {
      const notices = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem.message]
            : [],
        );
      const missing = yield* runBobTurn({ text: "hello", mode: "architect" });
      assert.equal(terminalOf(missing.events)?.status, "completed");
      assert.deepEqual(notices(missing.events), [
        'Bob has no "architect" mode in this project, so this turn runs in Agent mode.',
      ]);
      const offered = yield* runBobTurn({ text: "hello", mode: "ask" });
      assert.deepEqual(notices(offered.events), []);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("steers Bob once its running tool call finishes, in the same turn", () =>
    Effect.gen(function* () {
      const bob = yield* openBob({});
      const session = yield* bob.openSession(bob.workspace);
      const providerThread = yield* session.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const events = yield* bob.runTurn(session, providerThread, "work slowly", {
        whileRunning: ({ runId, nextEvent }) =>
          Effect.gen(function* () {
            let bound = providerThread;
            let providerTurnId: ProviderTurnId | undefined;
            // Steer while Bob's tool call runs.
            for (;;) {
              const event = yield* nextEvent;
              if (event.type === "provider_thread.updated") bound = event.providerThread;
              if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.nativeItemRef?.nativeId?.includes("slow-1") === true
              ) {
                break;
              }
            }
            yield* session.steerTurn({
              threadId: bob.threadId,
              runId,
              providerThread: bound,
              providerTurnId: providerTurnId!,
              message: {
                messageId: MessageId.make("message-bob-steer"),
                text: "Look at the tests instead.",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
            bob.release();
          }),
      });
      assert.equal(terminalOf(events)?.status, "completed");
      const methods = bob.requests().map((request) => request.method);
      // The cancel waits for the tool call, and the steer follows as the turn's next prompt.
      assert.isBelow(methods.indexOf("_mock/released"), methods.indexOf("session/cancel"));
      assert.isBelow(methods.indexOf("session/cancel"), methods.lastIndexOf("session/prompt"));
      const prompts = bob.requests().filter((request) => request.method === "session/prompt");
      assert.include(JSON.stringify(prompts.at(-1)?.params), "Look at the tests instead.");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "message.updated" &&
            JSON.stringify(event.message).includes("Hello from Bob."),
        ),
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  /** Runs a turn that has the mock Bob ask about `tools`, answering T3's cards with `decisions`. */
  const askAbout = (
    runtimeMode: RuntimeMode,
    tools: string,
    decisions: ReadonlyArray<"accept" | "decline">,
  ) =>
    Effect.gen(function* () {
      const bob = yield* openBob({ runtimeMode });
      const session = yield* bob.openSession(bob.workspace);
      const providerThread = yield* session.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const asked: Array<string> = [];
      const events = yield* bob.runTurn(session, providerThread, `ask about ${tools}`, {
        whileRunning: ({ nextEvent }) =>
          Effect.gen(function* () {
            for (const decision of decisions) {
              let event = yield* nextEvent;
              while (
                event.type !== "runtime_request.updated" ||
                event.runtimeRequest.status !== "pending"
              ) {
                event = yield* nextEvent;
              }
              asked.push(event.runtimeRequest.kind);
              yield* session.respondToRuntimeRequest({
                requestId: event.runtimeRequest.id,
                decision,
              });
            }
          }),
      });
      assert.equal(terminalOf(events)?.status, "completed");
      const answers = bob
        .requests()
        .filter((request) => request.method === "_mock/permission")
        .map((request) => `${String(request.params.tool)}=${String(request.params.outcome)}`);
      return { asked, answers };
    });

  it.effect("in Auto, runs what the review allows and asks about the rest", () =>
    Effect.gen(function* () {
      const { asked, answers } = yield* askAbout(
        "auto",
        "edit ls todo execute search edit-outside test",
        ["accept", "decline", "decline", "accept"],
      );
      // A web search shows as the tool it is, not as a file read.
      assert.deepEqual(asked, ["command", "command", "file-change", "command"]);
      assert.deepEqual(answers, [
        "edit=allow",
        "ls=allow",
        "todo=allow",
        "execute=allow",
        "search=reject",
        "edit-outside=reject",
        "test=allow",
      ]);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("in Accept edits, lets Bob's edits through and asks about its web searches", () =>
    Effect.gen(function* () {
      const { asked, answers } = yield* askAbout("auto-accept-edits", "edit search ls", [
        "decline",
        "accept",
      ]);
      assert.deepEqual(asked, ["command", "command"]);
      assert.deepEqual(answers, ["edit=allow", "search=reject", "ls=allow"]);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("fails a turn Bob ends without replying as retryable", () =>
    Effect.gen(function* () {
      const terminal = terminalOf((yield* runBobTurn({ text: "say nothing" })).events);
      assert.equal(terminal?.status, "failed");
      if (terminal?.status !== "failed") return;
      assert.deepInclude(terminal.failure, {
        message: BOB_EMPTY_REPLY_MESSAGE,
        code: "empty_reply",
        retryable: true,
      });
      assert.equal(terminal.threadDisposition, "reusable");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("stops a turn over the team's Bobcoins as a usage limit that resets monthly", () =>
    Effect.gen(function* () {
      const terminal = terminalOf((yield* runBobTurn({ text: "spend too much" })).events);
      assert.equal(terminal?.status, "failed");
      if (terminal?.status !== "failed") return;
      assert.deepInclude(terminal.failure, {
        class: "usage_limit",
        code: "BudgetExceededError",
        message: "Oh no! It looks like you've gone over your budget allowance of 50 Bobcoins.",
      });
      // Bobcoins reset at 00:00 UTC on the first of the next month.
      assert.match(terminal.failure.resetAt ?? "", /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
      assert.isTrue(Date.parse(terminal.failure.resetAt ?? "") > (yield* Clock.currentTimeMillis));
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("proposes a plan turn's final reply as the plan", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({ text: "plan the change", interactionMode: "plan" });
      assert.equal(terminalOf(result.events)?.status, "completed");
      assert.include(result.methods, "session/set_mode");
      assert.isTrue(
        result.events.some(
          (event) =>
            event.type === "plan.updated" &&
            JSON.stringify(event.plan).includes("1. Read the code."),
        ),
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("reports Bob's context and Bobcoins from its task database after a turn", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({
        text: "hello",
        usageReadings: [
          { used: 0, size: 0, bobcoins: 1 },
          { used: 1_200, size: 200_000, bobcoins: 1.42 },
        ],
      });
      const usage = result.events.findLast(
        (event) => event.type === "provider_thread.updated" && event.providerThread.contextUsage,
      );
      assert.deepEqual(
        usage?.type === "provider_thread.updated" ? usage.providerThread.contextUsage : undefined,
        { usedTokens: 1_200, maxTokens: 200_000, cost: { amount: 1.42, currency: "Bobcoins" } },
      );
      assert.deepEqual(result.spentIn, [result.workspace]);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("rewinds Bob's conversation to before a reverted turn", () =>
    Effect.gen(function* () {
      const bob = yield* openBob({});
      const session = yield* bob.openSession(bob.workspace);
      const providerThread = yield* session.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const providerTurnsOf = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn] : [],
        );
      const first = providerTurnsOf(yield* bob.runTurn(session, providerThread, "first")).at(-1)!;
      const secondEvents = yield* bob.runTurn(session, providerThread, "second");
      // The reverted turn began when Bob stamped its prompt; the test clock cannot say when.
      const second = {
        ...providerTurnsOf(secondEvents).at(-1)!,
        startedAt: DateTime.makeUnsafe(bob.promptTimestamps()[1]!),
      };
      // The thread as orchestration keeps it, bound to Bob's task once a turn ran.
      const boundThread = secondEvents.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.isDefined(boundThread);
      if (boundThread?.type !== "provider_thread.updated") return;
      const original = boundThread.providerThread.nativeThreadRef?.nativeId;
      assert.isDefined(original);
      const rolledBack = yield* session.rollbackThread({
        providerThread: boundThread.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: first,
        },
        providerThreadTurns: [first, second],
      });
      const rewound = rolledBack.providerThread.nativeThreadRef?.nativeId;
      assert.match(rewound ?? "", /^mock-imported-/);
      const exported = bob.requests().find((request) => request.method === "_bob/task/import");
      // Only the first turn's prompt and reply go into the rewound task.
      const kept = JSON.stringify(exported?.params.snapshot);
      assert.include(kept, "first");
      assert.notInclude(kept, "second");
      const deleted = bob
        .requests()
        .filter((request) => request.method === "session/delete")
        .map((request) => request.params.sessionId);
      assert.include(deleted, original);
      // The next turn continues the rewound task.
      yield* bob.runTurn(session, rolledBack.providerThread, "third");
      const resumed = bob
        .requests()
        .filter((request) => request.method === "session/resume")
        .map((request) => request.params.sessionId);
      assert.include(resumed, rewound);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("takes a thread's task along when it moves to another folder", () =>
    Effect.gen(function* () {
      const bob = yield* openBob({});
      const first = yield* bob.openSession(bob.workspace);
      const providerThread = yield* first.ensureThread({
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(bob.workspace),
      });
      const firstEvents = yield* bob.runTurn(first, providerThread, "first");
      const boundThread = firstEvents.findLast((event) => event.type === "provider_thread.updated");
      if (boundThread?.type !== "provider_thread.updated") return assert.fail("no bound thread");
      const original = boundThread.providerThread.nativeThreadRef?.nativeId;
      assert.isDefined(original);
      const fileSystem = yield* FileSystem.FileSystem;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-v2-worktree-" });
      const moved = yield* bob.openSession(worktree);
      const resumed = yield* moved.resumeThread({
        providerThread: boundThread.providerThread,
        threadId: bob.threadId,
        modelSelection: bob.modelSelection,
        runtimePolicy: bob.policyFor(worktree),
      });
      const copy = resumed.nativeThreadRef?.nativeId;
      assert.match(copy ?? "", /^mock-imported-/);
      const imported = bob.requests().find((request) => request.method === "_bob/task/import");
      assert.equal(imported?.params.cwd, worktree);
      assert.include(
        bob
          .requests()
          .filter((request) => request.method === "session/delete")
          .map((request) => request.params.sessionId),
        original,
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("writes a finished subagent's steps from Bob's database into its thread", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({
        text: "use a subagent",
        subagentSteps: {
          entries: [
            { _tag: "prompt", text: "Count the files" },
            { _tag: "message", text: "Listing the folder." },
            {
              _tag: "tool",
              title: "List Files in .",
              input: "ls",
              output: "a.ts\nb.ts",
              failed: false,
            },
          ],
        },
      });
      const subagent = result.events.findLast((event) => event.type === "subagent.updated");
      if (subagent?.type !== "subagent.updated") return assert.fail("no subagent");
      const childThreadId = subagent.subagent.childThreadId;
      const childTool = result.events.find(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.threadId === childThreadId &&
          event.turnItem.type === "dynamic_tool",
      );
      assert.include(JSON.stringify(childTool), "List Files in .");
      assert.include(JSON.stringify(childTool), "a.ts");
      assert.isTrue(
        result.events.some(
          (event) =>
            event.type === "message.updated" &&
            event.message.threadId === childThreadId &&
            JSON.stringify(event.message).includes("Listing the folder."),
        ),
      );
      assert.include(JSON.stringify(subagent), "There are 2 files.");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.effect("shows a subagent Bob runs with its report", () =>
    Effect.gen(function* () {
      const result = yield* runBobTurn({ text: "use a subagent" });
      assert.equal(terminalOf(result.events)?.status, "completed");
      const subagent = result.events.findLast((event) => event.type === "subagent.updated");
      assert.isDefined(subagent);
      assert.include(JSON.stringify(subagent), "There are 2 files.");
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});

const tmuxInstalled = NodeChildProcess.spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!tmuxInstalled)("BobAdapterV2 in tmux", () => {
  it.live(
    "finishes the turn Bob kept going while T3 restarted, in the run that takes it over",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const tmux = yield* TmuxServer.make.pipe(
          Effect.provideServiceEffect(ProcessRunner.ProcessRunner, ProcessRunner.make()),
        );
        yield* Effect.addFinalizer(() => tmux.run(["kill-server"]).pipe(Effect.ignore));
        const host = yield* makeBobRelayHost({ tmux, stateDir: config.stateDir });
        const instanceId = "bob-turn-test";

        // The T3 before: starts a turn, and stops while Bob's tool call runs. Its Bob calls T3's
        // tools with the token it issued the session.
        const before = yield* openBob({
          relays: makeBobRelays({ host, instanceId, adoptable: new Map(), ready: Effect.void }),
        });
        const tokenBefore = "token-the-t3-before-issued";
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("environment-bob-test"),
          threadId: before.threadId,
          providerSessionId: "mcp-before",
          providerInstanceId: ProviderInstanceId.make(instanceId),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: `Bearer ${tokenBefore}`,
          browserToolsAvailable: false,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(before.threadId)),
        );
        const bound = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* before.openSession(before.workspace);
            const providerThread = yield* session.ensureThread({
              threadId: before.threadId,
              modelSelection: before.modelSelection,
              runtimePolicy: before.policyFor(before.workspace),
            });
            let thread = providerThread;
            yield* before.runTurn(session, providerThread, "finish later", {
              whileRunning: ({ nextEvent }) =>
                Effect.gen(function* () {
                  for (;;) {
                    const event = yield* nextEvent;
                    // The thread's own, not a subagent's child thread.
                    if (
                      event.type === "provider_thread.updated" &&
                      event.providerThread.id === providerThread.id
                    ) {
                      thread = event.providerThread;
                    }
                    if (
                      event.type === "turn_item.updated" &&
                      event.turnItem.nativeItemRef?.nativeId?.includes("slow-later") === true
                    ) {
                      break;
                    }
                  }
                  // T3 is told to stop: it lets go of the relay running the turn.
                  detachBobRelayLinks();
                  return "stop" as const;
                }),
            });
            return thread;
          }),
        );
        const taskId = bound.nativeThreadRef?.nativeId ?? undefined;
        assert.isDefined(taskId);

        // The T3 after: finds the relay with Bob's prompt, and a wake run takes it over.
        const relay = (yield* host.scan).find(
          (found) => readBobRelayMeta(found.state)?.sessionId === taskId,
        );
        assert.isDefined(relay);
        if (relay === undefined || taskId === undefined) return;
        assert.isTrue(bobRelayHasTurn(relay.state));
        assert.equal(readBobRelayMeta(relay.state)?.providerThreadId, bound.id);
        // Its Bob runs in Full access, so only a runtime in Full access takes it over.
        assert.isTrue(readBobRelayMeta(relay.state)?.autoApprove);
        assert.equal(
          readBobRelayMeta(relay.state)?.mcpTokenHash,
          NodeCrypto.createHash("sha256").update(tokenBefore).digest("hex"),
        );
        // The T3 after issues the session its own credential.
        const registry = Context.get(
          yield* Layer.build(mcpRegistryLayer),
          McpSessionRegistry.McpSessionRegistry,
        );
        const issued = yield* registry.issue({
          threadId: before.threadId,
          providerInstanceId: ProviderInstanceId.make(instanceId),
        });
        McpProviderSession.setMcpProviderSession(issued.config);
        const subagentStepReads: Array<string> = [];
        const after = yield* openBob({
          relays: makeBobRelays({
            host,
            instanceId,
            adoptable: new Map([[taskId, { relayId: relay.relayId, autoApprove: true }]]),
            ready: Effect.void,
          }),
          subagentSteps: { entries: [{ _tag: "message", text: "Listing the folder." }] },
          subagentStepReads,
        });
        const session = yield* after.openSession(after.workspace, { bobTaskId: taskId });
        const events = yield* after.runTurn(session, bound, "Continue where you left off.", {
          wake: true,
          whileRunning: ({ nextEvent }) =>
            Effect.gen(function* () {
              // The tool calls show again in this run, under new ids: the one still running, and
              // the one that ended before the restart, as ended.
              let quickStatus: string | undefined;
              for (;;) {
                const event = yield* nextEvent;
                if (event.type !== "turn_item.updated") continue;
                const nativeId = event.turnItem.nativeItemRef?.nativeId ?? "";
                if (nativeId.includes("quick-before~adopted-")) quickStatus = event.turnItem.status;
                if (nativeId.includes("slow-later~adopted-")) break;
              }
              assert.equal(quickStatus, "completed");
              before.release();
            }),
        });
        assert.equal(terminalOf(events)?.status, "completed");
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "message.updated" &&
              JSON.stringify(event.message).includes("Finished after the restart."),
          ),
        );
        // Bob's task database knows the subagent by the id Bob gave it.
        assert.deepEqual(subagentStepReads, ["subagent-later"]);
        // Bob's token from the T3 before reaches T3's tools as this session's credential.
        assert.equal((yield* registry.resolve(tokenBefore))?.thread?.threadId, before.threadId);
        // Bob only ever had the one prompt, which the wake took over rather than prompting again.
        const prompts = before.requests().filter((request) => request.method === "session/prompt");
        assert.lengthOf(prompts, 1);
        assert.include(JSON.stringify(prompts[0]?.params), "finish later");

        // The Bob that finished it is gone by the time the run ends, so a message sent right
        // after runs in a fresh Bob.
        const latest = events.findLast(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.id === bound.id,
        );
        const followUp = yield* after.runTurn(
          session,
          latest?.type === "provider_thread.updated" ? latest.providerThread : bound,
          "hello",
        );
        assert.equal(terminalOf(followUp)?.status, "completed");
      }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.live("sends a steer that waited on Bob's tool call when T3 restarted, in order", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const tmux = yield* TmuxServer.make.pipe(
        Effect.provideServiceEffect(ProcessRunner.ProcessRunner, ProcessRunner.make()),
      );
      yield* Effect.addFinalizer(() => tmux.run(["kill-server"]).pipe(Effect.ignore));
      const host = yield* makeBobRelayHost({ tmux, stateDir: config.stateDir });
      const instanceId = "bob-turn-test";
      const steer = "Look at the tests instead.";

      // The T3 before: a steer waits on Bob's running tool call when T3 stops, after one that
      // ended.
      const before = yield* openBob({
        relays: makeBobRelays({ host, instanceId, adoptable: new Map(), ready: Effect.void }),
      });
      const bound = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* before.openSession(before.workspace);
          const providerThread = yield* session.ensureThread({
            threadId: before.threadId,
            modelSelection: before.modelSelection,
            runtimePolicy: before.policyFor(before.workspace),
          });
          let thread = providerThread;
          yield* before.runTurn(session, providerThread, "finish later", {
            whileRunning: ({ runId, nextEvent }) =>
              Effect.gen(function* () {
                let providerTurnId: ProviderTurnId | undefined;
                for (;;) {
                  const event = yield* nextEvent;
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.id === providerThread.id
                  ) {
                    thread = event.providerThread;
                  }
                  if (event.type === "provider_turn.updated") {
                    providerTurnId = event.providerTurn.id;
                  }
                  if (
                    event.type === "turn_item.updated" &&
                    event.turnItem.nativeItemRef?.nativeId?.includes("slow-later") === true
                  ) {
                    break;
                  }
                }
                yield* session.steerTurn({
                  threadId: before.threadId,
                  runId,
                  providerThread: thread,
                  providerTurnId: providerTurnId!,
                  message: {
                    messageId: MessageId.make("message-bob-steer"),
                    text: steer,
                    attachments: [],
                    createdBy: "user",
                    creationSource: "web",
                  },
                });
                detachBobRelayLinks();
                return "stop" as const;
              }),
          });
          return thread;
        }),
      );
      const taskId = bound.nativeThreadRef?.nativeId ?? undefined;
      const relay = (yield* host.scan).find(
        (found) => readBobRelayMeta(found.state)?.sessionId === taskId,
      );
      assert.isDefined(relay);
      if (relay === undefined || taskId === undefined) return;
      assert.deepEqual(readBobRelayMeta(relay.state)?.steers, [steer]);

      // The T3 after: the user's next message takes the prompt over, and another steer follows
      // it while Bob still runs the tool call. The first steer waits for that call, though the
      // relay replays the ended one first; Bob gets the three in the order they were sent.
      const after = yield* openBob({
        relays: makeBobRelays({
          host,
          instanceId,
          adoptable: new Map([[taskId, { relayId: relay.relayId, autoApprove: true }]]),
          ready: Effect.void,
        }),
      });
      const session = yield* after.openSession(after.workspace, { bobTaskId: taskId });
      const laterSteer = "Actually, skip the docs.";
      const events = yield* after.runTurn(session, bound, "Use the docs instead.", {
        whileRunning: ({ runId, nextEvent }) =>
          Effect.gen(function* () {
            let thread = bound;
            let providerTurnId: ProviderTurnId | undefined;
            for (;;) {
              const event = yield* nextEvent;
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.id === bound.id
              ) {
                thread = event.providerThread;
              }
              if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
              if (
                event.type === "turn_item.updated" &&
                (event.turnItem.nativeItemRef?.nativeId ?? "").includes("slow-later~adopted-")
              ) {
                break;
              }
            }
            yield* session.steerTurn({
              threadId: after.threadId,
              runId,
              providerThread: thread,
              providerTurnId: providerTurnId!,
              message: {
                messageId: MessageId.make("message-bob-later-steer"),
                text: laterSteer,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
            before.release();
          }),
      });
      assert.equal(terminalOf(events)?.status, "completed");
      const methods = before.requests().map((request) => request.method);
      // The steer cancels the prompt only once the running tool call ended.
      assert.isAbove(methods.indexOf("session/cancel"), methods.indexOf("_mock/released"));
      const prompts = before.requests().filter((request) => request.method === "session/prompt");
      assert.include(JSON.stringify(prompts.at(-3)?.params), steer);
      assert.include(JSON.stringify(prompts.at(-2)?.params), "Use the docs instead.");
      assert.include(JSON.stringify(prompts.at(-1)?.params), laterSteer);
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );

  it.live("sends Bob nothing more after Stop while a message takes its prompt over", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const tmux = yield* TmuxServer.make.pipe(
        Effect.provideServiceEffect(ProcessRunner.ProcessRunner, ProcessRunner.make()),
      );
      yield* Effect.addFinalizer(() => tmux.run(["kill-server"]).pipe(Effect.ignore));
      const host = yield* makeBobRelayHost({ tmux, stateDir: config.stateDir });
      const instanceId = "bob-turn-test";

      // The T3 before stops while Bob runs a tool call.
      const before = yield* openBob({
        relays: makeBobRelays({ host, instanceId, adoptable: new Map(), ready: Effect.void }),
      });
      const bound = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* before.openSession(before.workspace);
          const providerThread = yield* session.ensureThread({
            threadId: before.threadId,
            modelSelection: before.modelSelection,
            runtimePolicy: before.policyFor(before.workspace),
          });
          let thread = providerThread;
          yield* before.runTurn(session, providerThread, "work slowly", {
            whileRunning: ({ nextEvent }) =>
              Effect.gen(function* () {
                for (;;) {
                  const event = yield* nextEvent;
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.id === providerThread.id
                  ) {
                    thread = event.providerThread;
                  }
                  if (
                    event.type === "turn_item.updated" &&
                    event.turnItem.nativeItemRef?.nativeId?.includes("slow-1") === true
                  ) {
                    break;
                  }
                }
                detachBobRelayLinks();
                return "stop" as const;
              }),
          });
          return thread;
        }),
      );
      const taskId = bound.nativeThreadRef?.nativeId ?? undefined;
      const relay = (yield* host.scan).find(
        (found) => readBobRelayMeta(found.state)?.sessionId === taskId,
      );
      assert.isDefined(relay);
      if (relay === undefined || taskId === undefined) return;

      // The T3 after: the user's message takes the prompt over, then the user presses Stop.
      const after = yield* openBob({
        relays: makeBobRelays({
          host,
          instanceId,
          adoptable: new Map([[taskId, { relayId: relay.relayId, autoApprove: true }]]),
          ready: Effect.void,
        }),
      });
      const session = yield* after.openSession(after.workspace, { bobTaskId: taskId });
      const message = "Use the docs instead.";
      const events = yield* after.runTurn(session, bound, message, {
        whileRunning: ({ nextEvent }) =>
          Effect.gen(function* () {
            let thread = bound;
            let providerTurnId: ProviderTurnId | undefined;
            for (;;) {
              const event = yield* nextEvent;
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.id === bound.id
              ) {
                thread = event.providerThread;
              }
              if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
              if (
                event.type === "turn_item.updated" &&
                (event.turnItem.nativeItemRef?.nativeId ?? "").includes("slow-1~adopted-")
              ) {
                // The mock answers a cancel once its tool call ended.
                if (event.turnItem.status === "completed") break;
                before.release();
              }
            }
            yield* session.interruptTurn({
              providerThread: thread,
              providerTurnId: providerTurnId!,
            });
          }),
      });
      assert.equal(terminalOf(events)?.status, "interrupted");
      const requests = before.requests();
      const cancelAt = requests.findIndex((request) => request.method === "session/cancel");
      assert.isAbove(cancelAt, -1);
      assert.notInclude(
        JSON.stringify(requests.slice(cancelAt + 1).filter((r) => r.method === "session/prompt")),
        message,
      );
    }).pipe(Effect.provide(sessionLayer), Effect.scoped),
  );
});
