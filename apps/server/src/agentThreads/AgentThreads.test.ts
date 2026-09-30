import {
  AGENT_MESSAGE_CONTEXT_KIND,
  AGENT_MESSAGES_RECEIVED_PER_HOUR,
  AGENT_MESSAGES_SENT_PER_HOUR,
  AGENT_THREAD_STARTS_PER_HOUR,
  AgentMessageEnvelope,
  type AgentThreadsError,
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadDetailWindow,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import * as CheckInScheduler from "../checkIns/CheckInScheduler.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentThreadsPersistence from "../persistence/AgentThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadBackgroundCommands from "../persistence/ThreadBackgroundCommands.ts";
import * as ThreadCheckIns from "../persistence/ThreadCheckIns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentThreads from "./AgentThreads.ts";
import { agentThreadStartText } from "./agentThreadMessage.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const START = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeEnvelope = Schema.decodeUnknownSync(AgentMessageEnvelope);

function project(id: string, title: string, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: iso(START - 24 * HOUR),
    updatedAt: iso(START - 24 * HOUR),
  };
}

const APP = project("project-app", "T3 Code", "/repo/t3code");
const SITE = project("project-site", "Marketing site", "/repo/site");

/** An idle thread whose last turn finished at `updatedAt`, or one working or waiting on the user. */
function thread(
  id: string,
  options: {
    readonly title: string;
    readonly project: OrchestrationProjectShell;
    readonly updatedAt: number;
    readonly state?: "idle" | "working" | "needs-approval";
    readonly branch?: string;
    readonly archived?: boolean;
  },
): OrchestrationThreadShell {
  const working = options.state === "working";
  return {
    id: ThreadId.make(id),
    projectId: options.project.id,
    title: options.title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: options.branch ?? null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: working ? "running" : "completed",
      requestedAt: iso(options.updatedAt - MINUTE),
      startedAt: iso(options.updatedAt - MINUTE),
      completedAt: working ? null : iso(options.updatedAt),
      assistantMessageId: null,
    },
    createdAt: iso(START - 2 * HOUR),
    updatedAt: iso(options.updatedAt),
    archivedAt: options.archived ? iso(options.updatedAt) : null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: ThreadId.make(id),
      status: working ? "running" : "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: iso(options.updatedAt),
    },
    latestUserMessageAt: iso(options.updatedAt - MINUTE),
    hasPendingApprovals: options.state === "needs-approval",
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const CALLER = thread("thread-caller", {
  title: "Fix the build",
  project: APP,
  updatedAt: START - 10 * MINUTE,
  branch: "feature/build",
});
const TARGET = thread("thread-target", {
  title: "Review the docs",
  project: SITE,
  updatedAt: START - 5 * MINUTE,
});
const HELPER = thread("thread-helper", {
  title: "Update dependencies",
  project: APP,
  updatedAt: START - 20 * MINUTE,
});
const CALLER_REF = { environmentId: ENVIRONMENT_ID, threadId: CALLER.id };
/** A setup script that holds a user's first turn until it finishes. */
const SETUP_SCRIPT = {
  id: "setup",
  name: "Setup",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: true,
  async: false,
} as const;
const HELPER_REF = { environmentId: ENVIRONMENT_ID, threadId: HELPER.id };

function provider(
  instanceId: string,
  driver: string,
  displayName: string,
  models: ReadonlyArray<string>,
  options: { readonly defaultModel?: string; readonly enabled?: boolean } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: options.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(START),
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(slug === options.defaultModel ? { isDefault: true } : {}),
    })),
    slashCommands: [],
    skills: [],
  };
}

const PROVIDERS = [
  provider("codex", "codex", "Codex", ["gpt-5", "gpt-5-mini"]),
  provider("claude-work", "claudeAgent", "Claude Work", ["claude-sonnet", "claude-opus"], {
    defaultModel: "claude-opus",
  }),
  provider("cursor", "cursor", "Cursor", ["auto"], { enabled: false }),
];

function message(
  role: OrchestrationMessage["role"],
  text: string,
  createdAt: number,
): OrchestrationMessage {
  return {
    id: MessageId.make(`message-${createdAt}`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: iso(createdAt),
    updatedAt: iso(createdAt),
  };
}

/** "ok", or the code the call failed with. */
const outcome = <A>(call: Effect.Effect<A, AgentThreadsError>) =>
  call.pipe(
    Effect.as("ok"),
    Effect.catch((error) => Effect.succeed(error.code)),
  );

/** The text of the one first turn a start dispatched. */
const firstTurnText = (commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) =>
  Ref.get(commands).pipe(
    Effect.map((all) => {
      const turns = all.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.message.text] : [],
      );
      expect(turns).toHaveLength(1);
      return turns[0] ?? "";
    }),
  );

const makeHarness = Effect.fn("makeAgentThreadsHarness")(function* (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  // Makes the engine refuse thread.create, as a database failure would.
  const failCreate = yield* Ref.make(false);
  const shells = yield* Ref.make(
    new Map([CALLER, TARGET, HELPER].map((shell) => [shell.id, shell] as const)),
  );
  const archived = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([]);
  const replies = yield* Ref.make(new Map<ThreadId, ReadonlyArray<OrchestrationMessage>>());
  const detailWindows = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailWindow>>([]);
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const worktrees = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);

  const snapshot = (threads: ReadonlyArray<OrchestrationThreadShell>) => ({
    snapshotSequence: 1,
    projects: [APP, SITE],
    threads,
    updatedAt: iso(START),
  });

  const layer = AgentThreads.layer.pipe(
    Layer.provideMerge(CheckInScheduler.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCheckIns.layer,
        ThreadBackgroundCommands.layer,
        ThreadBackgroundCommands.changesLayer,
        AgentThreadsPersistence.layer,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.create" && (yield* Ref.get(failCreate))) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "The database is unavailable.",
                });
              }
              yield* Ref.update(commands, (all) => [...all, command]);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Ref.get(shells).pipe(Effect.map((all) => Option.fromUndefinedOr(all.get(threadId)))),
          getShellSnapshot: () =>
            Ref.get(shells).pipe(Effect.map((all) => snapshot([...all.values()]))),
          getArchivedShellSnapshot: () => Ref.get(archived).pipe(Effect.map(snapshot)),
          getThreadDetailSnapshot: (threadId, window) =>
            Effect.gen(function* () {
              if (window) yield* Ref.update(detailWindows, (all) => [...all, window]);
              const shell = (yield* Ref.get(shells)).get(threadId);
              if (shell === undefined) return Option.none();
              return Option.some({
                snapshotSequence: 1,
                thread: {
                  ...shell,
                  deletedAt: null,
                  messages: (yield* Ref.get(replies)).get(threadId) ?? [],
                  proposedPlans: [],
                  activities: [],
                  checkpoints: [],
                },
                page: { beforeCursor: "cursor-1", hasMore: true, snapshotSequence: 1 },
              });
            }),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(PROVIDERS) }),
        ServerSettings.layerTest(settings),
        // The descriptor and git status yield, as their file and process work does, so
        // concurrent calls interleave between a limit's count and the row it counts.
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
          getDescriptor: Effect.yieldNow.pipe(
            Effect.as({
              environmentId: ENVIRONMENT_ID,
              label: "Studio Mac",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: false },
            }),
          ),
        }),
        Layer.mock(GitWorkflowService)({
          localStatus: () =>
            Effect.yieldNow.pipe(
              Effect.as({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            ),
          createWorktree: (input) =>
            Ref.update(worktrees, (all) => [...all, input]).pipe(
              Effect.as({
                worktree: {
                  path: "/repo/t3code-worktrees/agent",
                  refName: input.newRefName ?? input.refName,
                },
              }),
            ),
        }),
      ),
    ),
  );
  // Built in the test's scope, so the in-memory database outlives each call.
  const context = yield* Layer.build(layer);
  const service = Context.get(context, AgentThreads.AgentThreads);
  const scheduler = Context.get(context, CheckInScheduler.CheckInScheduler);
  const repository = Context.get(context, AgentThreadsPersistence.AgentThreadRepository);
  const setThread = (shell: OrchestrationThreadShell) =>
    Ref.update(shells, (all) => new Map(all).set(shell.id, shell));
  return {
    service,
    scheduler,
    repository,
    commands,
    worktrees,
    archived,
    replies,
    detailWindows,
    setThread,
    failCreate,
  };
});

describe("AgentThreads.start", () => {
  it.effect("starts a thread with the task as its first turn, and reports back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, scheduler, repository, commands } = yield* makeHarness();
        const started = yield* service.start(CALLER_REF, {
          prompt: "  Update the changelog for 1.2\nInclude every merged PR.  ",
          provider: "claude-work",
          model: "claude-sonnet",
        });
        expect(started).toMatchObject({
          environmentId: ENVIRONMENT_ID,
          title: "Update the changelog for 1.2",
          provider: "claude-work",
          model: "claude-sonnet",
          workspace: "local",
          branch: "main",
          worktreePath: null,
          setupScript: "none",
        });
        const modelSelection = { instanceId: "claude-work", model: "claude-sonnet" };

        const [create, turn, ...more] = yield* Ref.get(commands);
        expect(more).toEqual([]);
        expect(create).toMatchObject({
          type: "thread.create",
          threadId: started.threadId,
          projectId: APP.id,
          title: "Update the changelog for 1.2",
          modelSelection,
          runtimeMode: CALLER.runtimeMode,
          branch: "main",
          worktreePath: null,
        });
        if (turn?.type !== "thread.turn.start") {
          return expect.fail(`expected the first turn, got ${turn?.type}`);
        }
        expect(turn).toMatchObject({ threadId: started.threadId, modelSelection });
        const [record, ...otherRecords] = turn.message.context?.records ?? [];
        expect(otherRecords).toEqual([]);
        expect(record).toMatchObject({
          kind: AGENT_MESSAGE_CONTEXT_KIND,
          label: 'Started by "Fix the build"',
        });
        const envelope = decodeEnvelope(record && "payload" in record ? record.payload : null);
        expect(envelope).toMatchObject({
          kind: "start-thread",
          from: {
            environmentId: ENVIRONMENT_ID,
            environmentLabel: "Studio Mac",
            threadId: CALLER.id,
            threadTitle: "Fix the build",
            projectId: APP.id,
            providerInstanceId: "codex",
            model: "gpt-5",
          },
          to: { environmentId: ENVIRONMENT_ID, threadId: started.threadId },
          sentAt: iso(START),
          depth: 1,
          body: "Update the changelog for 1.2\nInclude every merged PR.",
        });
        expect(turn.message.text).toBe(agentThreadStartText(envelope, true));

        expect(
          yield* repository.getLink({ environmentId: ENVIRONMENT_ID, threadId: started.threadId }),
        ).toEqual(
          Option.some({
            environmentId: ENVIRONMENT_ID,
            threadId: started.threadId,
            startedByEnvironmentId: ENVIRONMENT_ID,
            startedByThreadId: CALLER.id,
            startedByMessageId: envelope.messageId,
            depth: 1,
            createdAt: iso(START),
          }),
        );
        const waits = yield* scheduler.list(CALLER.id);
        expect(waits).toHaveLength(1);
        expect(waits[0]).toMatchObject({
          id: started.waitId,
          waitsFor: {
            environmentId: ENVIRONMENT_ID,
            threadId: started.threadId,
            title: "Update the changelog for 1.2",
          },
        });
      }),
    ),
  );

  it.effect("finds a provider by instance id, driver or name, and names the enabled ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        const start = (name?: string) =>
          service.start(CALLER_REF, {
            prompt: "Summarize the open issues.",
            reportBack: false,
            ...(name === undefined ? {} : { provider: name }),
          });

        for (const name of ["claude-work", "CLAUDEAGENT", "claude work"]) {
          expect(yield* start(name)).toMatchObject({
            provider: "claude-work",
            model: "claude-opus",
            waitId: null,
          });
        }
        // Left out, it runs on what the caller runs.
        expect(yield* start()).toMatchObject({ provider: "codex", model: "gpt-5" });

        for (const name of ["gemini", "cursor"]) {
          const error = yield* Effect.flip(start(name));
          expect(error.code).toBe("provider-unavailable");
          expect(error.detail).toContain("Enabled providers: codex, claude-work.");
        }
      }),
    ),
  );

  it.effect("lets threads started by agents nest only so deep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository, commands } = yield* makeHarness();
        const link = (threadId: ThreadId, depth: number) =>
          repository.insertLink({
            environmentId: ENVIRONMENT_ID,
            threadId,
            startedByEnvironmentId: ENVIRONMENT_ID,
            startedByThreadId: TARGET.id,
            startedByMessageId: `message-${threadId}`,
            depth,
            createdAt: iso(START - HOUR),
          });
        yield* link(HELPER.id, 2);
        yield* link(CALLER.id, 3);

        const started = yield* service.start(HELPER_REF, { prompt: "Bump Effect." });
        expect(
          yield* repository.getLink({ environmentId: ENVIRONMENT_ID, threadId: started.threadId }),
        ).toMatchObject(Option.some({ depth: 3 }));

        const before = (yield* Ref.get(commands)).length;
        const error = yield* Effect.flip(service.start(CALLER_REF, { prompt: "Bump Vite." }));
        expect(error.code).toBe("depth-exceeded");
        expect(yield* Ref.get(commands)).toHaveLength(before);
      }),
    ),
  );

  it.effect("limits the threads one thread starts in an hour", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, scheduler } = yield* makeHarness();
        const start = service.start(CALLER_REF, { prompt: "Try one idea.", reportBack: false });
        yield* Effect.replicateEffect(start, AGENT_THREAD_STARTS_PER_HOUR);

        yield* TestClock.setTime(START + 59 * MINUTE);
        const error = yield* Effect.flip(start);
        expect(error.code).toBe("rate-limited");

        yield* TestClock.setTime(START + HOUR + 1);
        yield* start;
        expect(yield* scheduler.list(CALLER.id)).toEqual([]);
      }),
    ),
  );

  it.effect("holds a parallel batch of starts to the hourly limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository, commands } = yield* makeHarness();
        const start = service.start(CALLER_REF, { prompt: "Try one idea.", reportBack: false });
        const outcomes = yield* Effect.all(
          Array.from({ length: AGENT_THREAD_STARTS_PER_HOUR + 1 }, () => outcome(start)),
          { concurrency: "unbounded" },
        );
        expect(outcomes.toSorted()).toEqual([
          ...Array.from({ length: AGENT_THREAD_STARTS_PER_HOUR }, () => "ok"),
          "rate-limited",
        ]);
        expect(yield* repository.countStartedSince(CALLER_REF, iso(START - HOUR))).toBe(
          AGENT_THREAD_STARTS_PER_HOUR,
        );
        const created = (yield* Ref.get(commands)).filter(
          (command) => command.type === "thread.create",
        );
        expect(created).toHaveLength(AGENT_THREAD_STARTS_PER_HOUR);
      }),
    ),
  );

  it.effect("starts a worktree and asks its agent to run the setup command first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, commands, worktrees, setThread } = yield* makeHarness({
          defaultProjectScripts: [SETUP_SCRIPT],
        });
        yield* setThread({ ...CALLER, runtimeMode: "approval-required" });

        const started = yield* service.start(CALLER_REF, {
          prompt: "Try the new parser.",
          workspace: "worktree",
        });
        const [worktree] = yield* Ref.get(worktrees);
        expect(worktree).toMatchObject({
          cwd: APP.workspaceRoot,
          refName: "feature/build",
          baseRefName: "feature/build",
          path: null,
        });
        expect(worktree?.newRefName).toMatch(/^t3code\/[0-9a-f]{8}$/);
        expect(started).toMatchObject({
          workspace: "worktree",
          branch: worktree?.newRefName,
          worktreePath: "/repo/t3code-worktrees/agent",
          setupScript: "in-first-message",
        });

        // The task goes out at once, and its agent runs setup under the mode it inherits.
        const [create, turn, ...more] = yield* Ref.get(commands);
        expect(more).toEqual([]);
        expect(create).toMatchObject({
          type: "thread.create",
          threadId: started.threadId,
          runtimeMode: "approval-required",
          branch: worktree?.newRefName,
          worktreePath: "/repo/t3code-worktrees/agent",
        });
        expect(turn).toMatchObject({
          type: "thread.turn.start",
          threadId: started.threadId,
          runtimeMode: "approval-required",
        });
        const text = yield* firstTurnText(commands);
        expect(text).toContain("```\nvp i\n```");
        expect(text).toContain("`T3CODE_PROJECT_ROOT=/repo/t3code`");
        expect(text).toContain("`T3CODE_WORKTREE_PATH=/repo/t3code-worktrees/agent`");
        expect(text.indexOf("vp i")).toBeLessThan(text.indexOf("Try the new parser."));
      }),
    ),
  );

  it.effect("asks for no setup in a worktree without a setup script", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, commands } = yield* makeHarness();
        const started = yield* service.start(CALLER_REF, {
          prompt: "Try the new parser.",
          workspace: "worktree",
        });
        expect(started).toMatchObject({ workspace: "worktree", setupScript: "none" });
        expect(yield* firstTurnText(commands)).not.toContain("setup command");
      }),
    ),
  );

  it.effect("asks for no setup in the project's checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, commands, worktrees } = yield* makeHarness({
          defaultProjectScripts: [SETUP_SCRIPT],
        });
        const started = yield* service.start(CALLER_REF, {
          prompt: "Try the new parser.",
          workspace: "local",
        });
        expect(started).toMatchObject({ workspace: "local", setupScript: "none" });
        expect(yield* Ref.get(worktrees)).toEqual([]);
        expect(yield* firstTurnText(commands)).not.toContain("setup command");
      }),
    ),
  );
});

describe("AgentThreads.send", () => {
  it.effect("queues a message from the caller until the other thread is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, scheduler, repository, commands, setThread } = yield* makeHarness();
        yield* setThread(
          thread("thread-target", {
            title: "Review the docs",
            project: SITE,
            updatedAt: START - MINUTE,
            state: "working",
          }),
        );

        const sent = yield* service.send(CALLER_REF, {
          threadId: TARGET.id,
          message: "  Is the release branch green?  ",
          inReplyTo: "message-0",
        });
        expect(sent.delivery).toBe("when-idle");
        yield* scheduler.drain;

        const [queued, ...more] = yield* repository.listQueued(ENVIRONMENT_ID);
        expect(more).toEqual([]);
        expect(queued).toMatchObject({
          messageId: sent.messageId,
          kind: "message",
          status: "queued",
          senderEnvironmentId: ENVIRONMENT_ID,
          senderThreadId: CALLER.id,
          targetEnvironmentId: ENVIRONMENT_ID,
          targetThreadId: TARGET.id,
          createdAt: iso(START),
          envelope: {
            messageId: sent.messageId,
            kind: "message",
            from: {
              environmentId: ENVIRONMENT_ID,
              threadId: CALLER.id,
              threadTitle: "Fix the build",
            },
            to: { environmentId: ENVIRONMENT_ID, threadId: TARGET.id },
            inReplyTo: "message-0",
            conversationId: "message-0",
            depth: 0,
            body: "Is the release branch green?",
          },
        });
        expect(yield* Ref.get(commands)).toEqual([]);

        // An idle thread gets it from the sweep the send wakes.
        const soon = yield* service.send(CALLER_REF, {
          threadId: HELPER.id,
          message: "Which Effect version?",
        });
        expect(soon.delivery).toBe("soon");
        yield* scheduler.drain;
        expect(yield* Ref.get(commands)).toMatchObject([
          { type: "thread.turn.start", threadId: HELPER.id },
        ]);
      }),
    ),
  );

  it.effect("refuses itself, other environments and missing threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository } = yield* makeHarness();
        const code = (input: Parameters<typeof service.send>[1]) =>
          Effect.flip(service.send(CALLER_REF, input)).pipe(Effect.map((error) => error.code));

        expect(yield* code({ threadId: CALLER.id, message: "Hello, me." })).toBe("invalid-request");
        expect(
          yield* code({
            environmentId: EnvironmentId.make("environment-remote"),
            threadId: TARGET.id,
            message: "Hello?",
          }),
        ).toBe("environment-unknown");
        expect(yield* code({ threadId: ThreadId.make("thread-missing"), message: "Hello?" })).toBe(
          "thread-not-found",
        );
        expect(yield* repository.listQueued(ENVIRONMENT_ID)).toEqual([]);
      }),
    ),
  );

  it.effect("limits the messages one thread sends in an hour", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        const send = service.send(CALLER_REF, { threadId: TARGET.id, message: "Status?" });
        yield* Effect.replicateEffect(send, AGENT_MESSAGES_SENT_PER_HOUR);

        const error = yield* Effect.flip(send);
        expect(error.code).toBe("rate-limited");
        expect(error.detail).toContain(`This thread sent ${AGENT_MESSAGES_SENT_PER_HOUR} messages`);

        yield* TestClock.setTime(START + HOUR + 1);
        yield* send;
      }),
    ),
  );

  it.effect("holds a parallel batch of sends to what a thread may send", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository } = yield* makeHarness();
        // Spread over two threads, so neither reaches what it may receive.
        const outcomes = yield* Effect.all(
          Array.from({ length: AGENT_MESSAGES_SENT_PER_HOUR + 1 }, (_, index) =>
            outcome(
              service.send(CALLER_REF, {
                threadId: index % 2 === 0 ? TARGET.id : HELPER.id,
                message: "Status?",
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(outcomes.toSorted()).toEqual([
          ...Array.from({ length: AGENT_MESSAGES_SENT_PER_HOUR }, () => "ok"),
          "rate-limited",
        ]);
        expect(yield* repository.countSentSince(CALLER_REF, iso(START - HOUR))).toBe(
          AGENT_MESSAGES_SENT_PER_HOUR,
        );
      }),
    ),
  );

  it.effect("holds a parallel batch of sends to what a thread may receive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository } = yield* makeHarness();
        // From two threads, so neither reaches what it may send.
        const outcomes = yield* Effect.all(
          Array.from({ length: AGENT_MESSAGES_RECEIVED_PER_HOUR + 1 }, (_, index) =>
            outcome(
              service.send(index % 2 === 0 ? CALLER_REF : HELPER_REF, {
                threadId: TARGET.id,
                message: "Status?",
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(outcomes.toSorted()).toEqual([
          ...Array.from({ length: AGENT_MESSAGES_RECEIVED_PER_HOUR }, () => "ok"),
          "rate-limited",
        ]);
        const target = { environmentId: ENVIRONMENT_ID, threadId: TARGET.id };
        expect(yield* repository.countReceivedSince(target, iso(START - HOUR))).toBe(
          AGENT_MESSAGES_RECEIVED_PER_HOUR,
        );
      }),
    ),
  );

  it.effect("limits the messages one thread receives in an hour, from any sender", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        const send = (from: typeof CALLER_REF, threadId: ThreadId) =>
          service.send(from, { threadId, message: "Status?" });
        const half = AGENT_MESSAGES_RECEIVED_PER_HOUR / 2;
        yield* Effect.replicateEffect(send(CALLER_REF, TARGET.id), half);
        yield* Effect.replicateEffect(send(HELPER_REF, TARGET.id), half);

        const error = yield* Effect.flip(send(CALLER_REF, TARGET.id));
        expect(error.code).toBe("rate-limited");
        expect(error.detail).toContain(
          `That thread received ${AGENT_MESSAGES_RECEIVED_PER_HOUR} messages`,
        );
        // The caller may still message a thread that has room.
        yield* send(CALLER_REF, HELPER.id);
      }),
    ),
  );
});

describe("AgentThreads.watch", () => {
  it.effect("waits for another thread, never itself, and lets only the waiter cancel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, scheduler } = yield* makeHarness();
        const wait = yield* service.watch(CALLER_REF, {
          threadId: TARGET.id,
          note: "Merge its branch.",
        });
        expect(wait).toMatchObject({
          threadId: CALLER.id,
          note: "Merge its branch.",
          waitsFor: {
            environmentId: ENVIRONMENT_ID,
            threadId: TARGET.id,
            title: "Review the docs",
          },
        });
        expect(yield* scheduler.list(CALLER.id)).toEqual([wait]);

        const self = yield* Effect.flip(service.watch(CALLER_REF, { threadId: CALLER.id }));
        expect(self.code).toBe("invalid-request");

        expect(yield* service.cancelWait(HELPER_REF, wait.id)).toBe(false);
        expect(yield* service.cancelWait(CALLER_REF, wait.id)).toBe(true);
        expect(yield* scheduler.list(CALLER.id)).toEqual([]);
      }),
    ),
  );
});

describe("AgentThreads.list", () => {
  it.effect("lists every project's threads, newest first, with state and who started them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository, setThread, archived } = yield* makeHarness();
        const target = thread("thread-target", {
          title: "Review the docs",
          project: SITE,
          updatedAt: START - 5 * MINUTE,
          state: "working",
        });
        const helper = thread("thread-helper", {
          title: "Update dependencies",
          project: APP,
          updatedAt: START - 20 * MINUTE,
          state: "needs-approval",
        });
        yield* setThread(target);
        yield* setThread(helper);
        yield* repository.insertLink({
          environmentId: ENVIRONMENT_ID,
          threadId: HELPER.id,
          startedByEnvironmentId: ENVIRONMENT_ID,
          startedByThreadId: CALLER.id,
          startedByMessageId: "message-1",
          depth: 1,
          createdAt: iso(START - HOUR),
        });
        yield* Ref.set(archived, [
          thread("thread-old", {
            title: "Old experiment",
            project: SITE,
            updatedAt: START - 3 * HOUR,
            archived: true,
          }),
        ]);

        const listing = yield* service.list({});
        const summary = (
          shell: OrchestrationThreadShell,
          projectName: string,
          state: AgentThreads.AgentThreadState,
          startedBy: AgentThreads.AgentThreadSummary["startedBy"] = null,
        ): AgentThreads.AgentThreadSummary => ({
          environmentId: ENVIRONMENT_ID,
          threadId: shell.id,
          title: shell.title,
          projectId: shell.projectId,
          projectName,
          provider: "codex",
          model: "gpt-5",
          state,
          lastActivityAt: shell.updatedAt,
          branch: shell.branch,
          startedBy,
        });
        expect(listing.threads).toEqual([
          summary(target, "Marketing site", "working"),
          summary(CALLER, "T3 Code", "idle"),
          summary(helper, "T3 Code", "needs-approval", {
            environmentId: ENVIRONMENT_ID,
            threadId: CALLER.id,
          }),
        ]);
        expect(listing.truncated).toBe(false);

        const withArchived = yield* service.list({ includeArchived: true });
        expect(withArchived.threads.at(-1)).toMatchObject({
          threadId: "thread-old",
          state: "archived",
        });
        const limited = yield* service.list({ limit: 1 });
        expect(limited.threads.map((listed) => listed.threadId)).toEqual([TARGET.id]);
        expect(limited.truncated).toBe(true);
      }),
    ),
  );

  it.effect("filters by title or project name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        const ids = (query: string) =>
          service
            .list({ query })
            .pipe(Effect.map((listing) => listing.threads.map((listed) => listed.threadId)));
        expect(yield* ids("  MARKETING ")).toEqual([TARGET.id]);
        expect(yield* ids("t3 code")).toEqual([CALLER.id, HELPER.id]);
        expect(yield* ids("fix the")).toEqual([CALLER.id]);
        expect(yield* ids("nothing like this")).toEqual([]);
      }),
    ),
  );

  it.effect("lists the enabled providers a thread can start on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        const listing = yield* service.list({});
        expect(listing.environments).toEqual([
          {
            environmentId: ENVIRONMENT_ID,
            label: "Studio Mac",
            local: true,
            providers: [
              {
                provider: "codex",
                driver: "codex",
                name: "Codex",
                ready: true,
                defaultModel: "gpt-5",
                models: ["gpt-5", "gpt-5-mini"],
              },
              {
                provider: "claude-work",
                driver: "claudeAgent",
                name: "Claude Work",
                ready: true,
                defaultModel: "claude-opus",
                models: ["claude-sonnet", "claude-opus"],
              },
            ],
          },
        ]);
      }),
    ),
  );
});

describe("AgentThreads.read", () => {
  it.effect("reads recent messages and keeps the end of long ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, replies, detailWindows } = yield* makeHarness();
        const long = `${"x".repeat(12_000)}\nRESULT: the docs build.`;
        yield* Ref.set(
          replies,
          new Map([
            [
              TARGET.id,
              [
                message("user", "Review the docs.", START - 8 * MINUTE),
                message("system", "Context compacted.", START - 7 * MINUTE),
                message("assistant", long, START - 6 * MINUTE),
              ],
            ],
          ]),
        );

        const reading = yield* service.read(CALLER_REF, { threadId: TARGET.id });
        expect(reading).toMatchObject({
          threadId: TARGET.id,
          title: "Review the docs",
          projectName: "Marketing site",
          state: "idle",
          worktreePath: null,
          olderMessages: true,
        });
        expect(reading.messages).toHaveLength(2);
        expect(reading.messages[0]).toEqual({
          role: "user",
          text: "Review the docs.",
          createdAt: iso(START - 8 * MINUTE),
          truncated: false,
        });
        expect(reading.messages[1]).toEqual({
          role: "assistant",
          text: `…${long.slice(-8_000)}`,
          createdAt: iso(START - 6 * MINUTE),
          truncated: true,
        });
        expect(yield* Ref.get(detailWindows)).toEqual([{ turnLimit: 3 }]);
      }),
    ),
  );
});

describe("AgentThreads guards", () => {
  it.effect("keeps replies in the conversation of the message they answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository } = yield* makeHarness();
        const target = { environmentId: ENVIRONMENT_ID, threadId: TARGET.id };
        const first = yield* service.send(CALLER_REF, { ...target, message: "What changed?" });
        const reply = yield* service.send(target, {
          ...CALLER_REF,
          message: "The docs index.",
          inReplyTo: first.messageId,
        });
        const again = yield* service.send(CALLER_REF, {
          ...target,
          message: "Thanks, and the links?",
          inReplyTo: reply.messageId,
        });
        const conversation = (messageId: string) =>
          repository
            .getMessage(messageId)
            .pipe(Effect.map((row) => Option.getOrThrow(row).envelope.conversationId));
        expect(yield* conversation(first.messageId)).toBe(first.messageId);
        expect(yield* conversation(reply.messageId)).toBe(first.messageId);
        expect(yield* conversation(again.messageId)).toBe(first.messageId);
      }),
    ),
  );

  it.effect("leaves out projects with agent threads turned off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness({
          projectSettingsOverrides: { [SITE.id]: { enableAgentThreads: false } },
        });
        const listing = yield* service.list({});
        expect(listing.threads.map((thread) => thread.threadId)).not.toContain(TARGET.id);
        const target = { environmentId: ENVIRONMENT_ID, threadId: TARGET.id };
        for (const refused of [
          service.read(CALLER_REF, target),
          service.send(CALLER_REF, { ...target, message: "Hello" }).pipe(Effect.asVoid),
          service.watch(CALLER_REF, target).pipe(Effect.asVoid),
          service.start(CALLER_REF, { prompt: "Fix the footer", projectId: SITE.id }),
        ] as const) {
          const error = yield* Effect.flip(refused);
          expect(error.code).toBe("permission-denied");
        }
      }),
    ),
  );

  it.effect("counts only threads that were created toward the starting thread's limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service, repository, failCreate } = yield* makeHarness();
        yield* Ref.set(failCreate, true);
        const error = yield* Effect.flip(service.start(CALLER_REF, { prompt: "Write the tests" }));
        expect(error.code).toBe("invalid-request");
        expect(yield* repository.countStartedSince(CALLER_REF, iso(START - HOUR))).toBe(0);
      }),
    ),
  );

  it.effect("refuses a message too large to carry once encoded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const { service } = yield* makeHarness();
        // Each control character encodes as six in JSON.
        const error = yield* Effect.flip(
          service.send(CALLER_REF, {
            environmentId: ENVIRONMENT_ID,
            threadId: TARGET.id,
            message: `x${"\u0001".repeat(15_000)}`,
          }),
        );
        expect(error.code).toBe("message-too-large");
      }),
    ),
  );
});
