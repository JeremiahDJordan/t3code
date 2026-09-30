import {
  AGENT_MESSAGE_CONTEXT_KIND,
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_MESSAGES_RECEIVED_PER_HOUR,
  AGENT_MESSAGES_SENT_PER_HOUR,
  AGENT_THREAD_START_DEPTH_MAX,
  AGENT_THREAD_STARTS_PER_HOUR,
  type AgentMessageEnvelope,
  AgentThreadsError,
  type AgentThreadsErrorCode,
  CommandId,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  OrchestrationMessageContext,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadCheckIn,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as CheckInScheduler from "../checkIns/CheckInScheduler.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentThreadsPersistence from "../persistence/AgentThreads.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  agentMessageLabel,
  agentThreadStartText,
  WAIT_REPLY_EXCERPT_CHARS,
  type WorktreeSetup,
} from "./agentThreadMessage.ts";

/** The thread whose agent calls a tool, from its MCP credential. */
export interface AgentThreadCaller {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** A thread named in a tool call; the caller's environment when `environmentId` is left out. */
export interface AgentThreadTarget {
  readonly environmentId?: EnvironmentId | undefined;
  readonly threadId: ThreadId;
}

export type AgentThreadState =
  | "idle"
  | "working"
  | "needs-approval"
  | "needs-input"
  | "error"
  | "archived";

export interface StartAgentThreadInput {
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly workspace?: "local" | "worktree" | undefined;
  readonly baseBranch?: string | undefined;
  readonly reportBack?: boolean | undefined;
}

/**
 * What agents do with other threads through T3's agent-threads tools: list and read any thread,
 * start new top-level threads on any enabled provider, message threads, and wait for a thread to
 * finish its turn. Messages and waits are delivered by the check-in scheduler, so they never
 * interrupt a turn. Only this environment's threads are reachable for now; every reference
 * carries its environment so other environments can be added without changing shapes.
 */
export class AgentThreads extends Context.Service<
  AgentThreads,
  {
    readonly list: (input: {
      readonly query?: string | undefined;
      readonly includeArchived?: boolean | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<AgentThreadListing, AgentThreadsError>;
    readonly read: (
      caller: AgentThreadCaller,
      input: AgentThreadTarget & { readonly turns?: number | undefined },
    ) => Effect.Effect<AgentThreadReading, AgentThreadsError>;
    readonly start: (
      caller: AgentThreadCaller,
      input: StartAgentThreadInput,
    ) => Effect.Effect<StartedAgentThread, AgentThreadsError>;
    readonly send: (
      caller: AgentThreadCaller,
      input: AgentThreadTarget & {
        readonly message: string;
        readonly inReplyTo?: string | undefined;
      },
    ) => Effect.Effect<
      { readonly messageId: string; readonly delivery: "soon" | "when-idle" },
      AgentThreadsError
    >;
    readonly watch: (
      caller: AgentThreadCaller,
      input: AgentThreadTarget & { readonly note?: string | undefined },
    ) => Effect.Effect<ThreadCheckIn, AgentThreadsError>;
    readonly cancelWait: (
      caller: AgentThreadCaller,
      waitId: string,
    ) => Effect.Effect<boolean, AgentThreadsError>;
  }
>()("t3/agentThreads/AgentThreads") {}

export interface AgentThreadListing {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly local: boolean;
    readonly providers: ReadonlyArray<{
      readonly provider: string;
      readonly driver: string;
      readonly name: string;
      readonly ready: boolean;
      readonly defaultModel: string | null;
      readonly models: ReadonlyArray<string>;
    }>;
  }>;
  readonly threads: ReadonlyArray<AgentThreadSummary>;
  readonly truncated: boolean;
}

export interface AgentThreadSummary {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly provider: string;
  readonly model: string;
  readonly state: AgentThreadState;
  readonly lastActivityAt: string;
  readonly branch: string | null;
  readonly startedBy: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}

export interface AgentThreadReading extends AgentThreadSummary {
  readonly worktreePath: string | null;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
    readonly truncated: boolean;
  }>;
  readonly olderMessages: boolean;
}

export interface StartedAgentThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly workspace: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** The wait that reports its first turn back; cancel it with cancel_wait. */
  readonly waitId: string | null;
  /** Whether its first message asks its agent to run the project's setup script first. */
  readonly setupScript: "none" | "in-first-message";
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const READ_TURNS_DEFAULT = 3;
const READ_TURNS_MAX = 20;
/** How much of one message read_thread returns: its end, where results usually are. */
const READ_MESSAGE_MAX_CHARS = Math.max(8_000, WAIT_REPLY_EXCERPT_CHARS);
const TITLE_MAX_CHARS = 80;
/** Below the 64k a message-context record's payload may hold. */
const ENVELOPE_JSON_MAX_CHARS = 60_000;
const HOUR_MS = 3_600_000;

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

function isoAt(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function fail(code: AgentThreadsErrorCode, detail: string) {
  return new AgentThreadsError({ code, detail });
}

/** Where a thread is, as another agent needs to know it. */
export function agentThreadState(shell: OrchestrationThreadShell): AgentThreadState {
  if (shell.archivedAt !== null) return "archived";
  if (shell.hasPendingApprovals) return "needs-approval";
  if (shell.hasPendingUserInput) return "needs-input";
  const status = shell.session?.status;
  if (status === "running" || status === "starting" || shell.latestTurn?.state === "running") {
    return "working";
  }
  if (status === "error" || shell.latestTurn?.state === "error") return "error";
  return "idle";
}

/** A title for a thread started from `prompt`: its first line, shortened. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  const title = firstLine || "Task from another thread";
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
}

/** The enabled provider an agent named by instance id, driver or display name. */
export function findProvider(
  providers: ReadonlyArray<ServerProvider>,
  name: string,
): ServerProvider | undefined {
  const wanted = name.trim().toLowerCase();
  const enabled = providers.filter((provider) => provider.enabled);
  return (
    enabled.find((provider) => provider.instanceId.toLowerCase() === wanted) ??
    enabled.find((provider) => provider.displayName?.toLowerCase() === wanted) ??
    enabled.find((provider) => provider.driver.toLowerCase() === wanted)
  );
}

function defaultModel(provider: ServerProvider): string | null {
  return provider.models.find((model) => model.isDefault)?.slug ?? provider.models[0]?.slug ?? null;
}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const registry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment;
  const repository = yield* AgentThreadsPersistence.AgentThreadRepository;
  const scheduler = yield* CheckInScheduler.CheckInScheduler;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  const internal = (detail: string) => (cause: unknown) =>
    Effect.logWarning(detail, { cause }).pipe(Effect.andThen(fail("invalid-request", detail)));

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  /** Which projects agents may reach: those with agent threads on, as the user set them. */
  const allowedProjects = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => (projectId: ProjectId) =>
        resolveProjectSettings(settings, projectId).settings.enableAgentThreads,
    ),
    Effect.catch(internal("Could not read T3 Code's settings.")),
  );
  const projectOff = (detail: string) =>
    fail(
      "permission-denied",
      `${detail} T3 Code's settings turn agent threads off for that project.`,
    );

  /** A thread in this environment whose project allows agent threads, or why it cannot be reached. */
  const localThread = (target: AgentThreadTarget) =>
    Effect.gen(function* () {
      if (target.environmentId !== undefined && target.environmentId !== environmentId) {
        return yield* fail(
          "environment-unknown",
          `Environment ${target.environmentId} is not connected to this T3 Code; only threads in environment ${environmentId} can be reached.`,
        );
      }
      const shell = yield* snapshots
        .getThreadShellById(target.threadId)
        .pipe(Effect.catch(internal("Could not read that thread.")));
      if (Option.isNone(shell)) {
        return yield* fail(
          "thread-not-found",
          `No active thread ${target.threadId}. list_threads shows the threads you can reach.`,
        );
      }
      if (!(yield* allowedProjects)(shell.value.projectId)) {
        return yield* projectOff(`Thread ${target.threadId} cannot be reached.`);
      }
      return shell.value;
    });

  const projectsById = Effect.gen(function* () {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.catch(internal("Could not read the threads.")));
    return new Map(snapshot.projects.map((project) => [project.id, project]));
  });

  const summaryOf = (
    shell: OrchestrationThreadShell,
    project: OrchestrationProjectShell | undefined,
    link: AgentThreadsPersistence.AgentThreadLink | undefined,
  ): AgentThreadSummary => ({
    environmentId,
    threadId: shell.id,
    title: shell.title,
    projectId: shell.projectId,
    projectName: project?.title ?? "",
    provider: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    state: agentThreadState(shell),
    lastActivityAt: shell.updatedAt,
    branch: shell.branch,
    startedBy: link
      ? { environmentId: link.startedByEnvironmentId, threadId: link.startedByThreadId }
      : null,
  });

  const list: AgentThreads["Service"]["list"] = Effect.fn("AgentThreads.list")(function* (input) {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.catch(internal("Could not read the threads.")));
    const archived = input.includeArchived
      ? (yield* snapshots
          .getArchivedShellSnapshot()
          .pipe(Effect.catch(internal("Could not read the archived threads.")))).threads
      : [];
    const links = new Map(
      (yield* repository.listLinks.pipe(Effect.catch(internal("Could not read the threads.")))).map(
        (link) => [link.threadId, link],
      ),
    );
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const query = input.query?.trim().toLowerCase();
    const allowed = yield* allowedProjects;
    const matching = [...snapshot.threads, ...archived]
      .filter((shell) => allowed(shell.projectId))
      .map((shell) => summaryOf(shell, projects.get(shell.projectId), links.get(shell.id)))
      .filter(
        (thread) =>
          !query ||
          thread.title.toLowerCase().includes(query) ||
          thread.projectName.toLowerCase().includes(query),
      )
      .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const limit = Math.min(Math.max(1, input.limit ?? LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX);
    const descriptor = yield* serverEnvironment.getDescriptor;
    const providers = yield* registry.getProviders;
    return {
      environments: [
        {
          environmentId,
          label: descriptor.label,
          local: true,
          providers: providers
            .filter((provider) => provider.enabled)
            .map((provider) => ({
              provider: provider.instanceId,
              driver: provider.driver,
              name: provider.displayName ?? provider.instanceId,
              ready: provider.status === "ready",
              defaultModel: defaultModel(provider),
              models: provider.models.map((model) => model.slug),
            })),
        },
      ],
      threads: matching.slice(0, limit),
      truncated: matching.length > limit,
    };
  });

  const read: AgentThreads["Service"]["read"] = Effect.fn("AgentThreads.read")(
    function* (_caller, input) {
      const shell = yield* localThread(input);
      const turns = Math.min(Math.max(1, input.turns ?? READ_TURNS_DEFAULT), READ_TURNS_MAX);
      const detail = yield* snapshots
        .getThreadDetailSnapshot(shell.id, { turnLimit: turns })
        .pipe(Effect.catch(internal("Could not read that thread.")));
      const projects = yield* projectsById;
      const link = yield* repository
        .getLink({ environmentId, threadId: shell.id })
        .pipe(Effect.catch(internal("Could not read that thread.")));
      const messages = Option.isSome(detail)
        ? detail.value.thread.messages.filter((message) => message.role !== "system")
        : [];
      return {
        ...summaryOf(shell, projects.get(shell.projectId), Option.getOrUndefined(link)),
        worktreePath: shell.worktreePath,
        messages: messages.map((message) => {
          const truncated = message.text.length > READ_MESSAGE_MAX_CHARS;
          return {
            role: message.role,
            text: truncated ? `…${message.text.slice(-READ_MESSAGE_MAX_CHARS)}` : message.text,
            createdAt: message.createdAt,
            truncated,
          };
        }),
        olderMessages: Option.isSome(detail) ? (detail.value.page?.hasMore ?? false) : false,
      };
    },
  );

  /** Who is sending: the caller's thread as its envelope names it. */
  const senderOf = (caller: AgentThreadCaller, shell: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const descriptor = yield* serverEnvironment.getDescriptor;
      return {
        environmentId: caller.environmentId,
        environmentLabel: descriptor.label,
        threadId: caller.threadId,
        threadTitle: shell.title,
        projectId: shell.projectId,
        providerInstanceId: shell.modelSelection.instanceId,
        model: shell.modelSelection.model,
      } satisfies AgentMessageEnvelope["from"];
    });

  /** How many threads were started from agents up to the caller's thread. */
  const depthOf = (caller: AgentThreadCaller) =>
    repository.getLink(caller).pipe(
      Effect.map((link) => (Option.isSome(link) ? link.value.depth : 0)),
      Effect.catch(internal("Could not read the thread's history.")),
    );

  const since = (nowMs: number) => isoAt(nowMs - HOUR_MS);

  /** A context record's payload is capped; a body JSON escapes heavily can outgrow it. */
  const checkEnvelopeSize = (envelope: AgentMessageEnvelope) =>
    JSON.stringify(envelope).length > ENVELOPE_JSON_MAX_CHARS
      ? Effect.fail(
          fail(
            "message-too-large",
            "The message is too large once encoded. Shorten it, or put the details in a file and point to it.",
          ),
        )
      : Effect.void;

  const start: AgentThreads["Service"]["start"] = Effect.fn("AgentThreads.start")(
    function* (caller, input) {
      const callerShell = yield* localThread(caller);
      const nowMs = yield* Clock.currentTimeMillis;
      const depth = (yield* depthOf(caller)) + 1;
      if (depth > AGENT_THREAD_START_DEPTH_MAX) {
        return yield* fail(
          "depth-exceeded",
          `This thread was started by agents ${depth - 1} levels deep, the most that can start more threads. Do the work here, or ask the thread that started this one.`,
        );
      }
      const started = yield* repository
        .countStartedSince(caller, since(nowMs))
        .pipe(Effect.catch(internal("Could not read the thread's history.")));
      if (started >= AGENT_THREAD_STARTS_PER_HOUR) {
        return yield* fail(
          "rate-limited",
          `This thread started ${started} threads in the last hour, the most it may. Try again later.`,
        );
      }
      const prompt = input.prompt.trim();
      if (!prompt) return yield* fail("invalid-request", "The prompt is empty.");
      if (prompt.length > AGENT_MESSAGE_MAX_CHARS) {
        return yield* fail(
          "message-too-large",
          `The prompt is ${prompt.length} characters; the most is ${AGENT_MESSAGE_MAX_CHARS}. Put the details in a file and point to it.`,
        );
      }

      const projects = yield* projectsById;
      const projectId = input.projectId ?? callerShell.projectId;
      const project = projects.get(projectId);
      if (project === undefined) {
        return yield* fail(
          "project-not-found",
          `No project ${projectId}. list_threads shows each thread's projectId.`,
        );
      }
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(internal("Could not read T3 Code's settings.")),
      );
      const resolved = resolveProjectSettings(settings, project.id, project).settings;
      if (!resolved.enableAgentThreads) {
        return yield* projectOff(`Cannot start a thread in project ${project.title}.`);
      }

      // The provider and model: asked for, else the project's default, else the caller's.
      const providers = yield* registry.getProviders;
      const fallback: ModelSelection = resolved.defaultModelSelection ?? callerShell.modelSelection;
      const provider =
        input.provider === undefined
          ? findProvider(providers, fallback.instanceId)
          : findProvider(providers, input.provider);
      if (provider === undefined) {
        const available = providers
          .filter((candidate) => candidate.enabled)
          .map((candidate) => candidate.instanceId)
          .join(", ");
        return yield* fail(
          "provider-unavailable",
          `${input.provider === undefined ? `The default provider ${fallback.instanceId}` : `Provider "${input.provider}"`} is not enabled. Enabled providers: ${available || "none"}.`,
        );
      }
      const model =
        input.model?.trim() ||
        (fallback.instanceId === provider.instanceId ? fallback.model : defaultModel(provider));
      if (!model) {
        return yield* fail(
          "provider-unavailable",
          `Provider ${provider.instanceId} lists no models; name one with model.`,
        );
      }
      const modelSelection: ModelSelection = {
        instanceId: ProviderInstanceId.make(provider.instanceId),
        model,
      };

      const messageId = yield* uuid;
      const threadId = ThreadId.make(yield* uuid);
      const title = input.title?.trim() || titleFromPrompt(prompt);
      const workspace = input.workspace ?? resolved.defaultThreadEnvMode ?? "local";

      // Where it works: the project's checkout, or a new worktree on a temporary branch.
      const localStatus = yield* git
        .localStatus({ cwd: project.workspaceRoot })
        .pipe(Effect.orElseSucceed(() => undefined));
      let branch = localStatus?.isRepo ? localStatus.refName : null;
      let worktreePath: string | null = null;
      let setup: WorktreeSetup | undefined;
      if (workspace === "worktree") {
        if (!localStatus?.isRepo) {
          return yield* fail(
            "invalid-request",
            `Project ${project.title} is not a git repository, so it cannot have worktrees. Use workspace "local".`,
          );
        }
        const base =
          input.baseBranch?.trim() ||
          (callerShell.projectId === project.id ? callerShell.branch : null) ||
          localStatus.refName;
        if (!base) {
          return yield* fail(
            "invalid-request",
            "The project's checkout is not on a branch; name one with baseBranch.",
          );
        }
        const bytes = yield* crypto.randomBytes(4).pipe(Effect.orDie);
        const worktree = yield* git
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              refName: base,
              newRefName: buildTemporaryWorktreeBranchName(() =>
                Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
              ),
              baseRefName: base,
              path: null,
            },
            { submodules: resolved.worktreeSubmodules },
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("agent thread worktree failed", { cause }).pipe(
                Effect.andThen(
                  fail("invalid-request", `Could not create a worktree from ${base}.`),
                ),
              ),
            ),
          );
        branch = worktree.worktree.refName;
        worktreePath = worktree.worktree.path;
        // Like a worktree a user starts, it gets the project's setup script, but its agent runs
        // it under the permission mode it inherits: the script comes from a branch an agent chose.
        const script = setupProjectScript(resolveProjectScripts(settings, project));
        if (script !== null) {
          setup = {
            command: script.command,
            env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
          };
        }
      }

      const envelope: AgentMessageEnvelope = {
        version: 1,
        messageId,
        kind: "start-thread",
        from: yield* senderOf(caller, callerShell),
        to: { environmentId, threadId },
        sentAt: isoAt(nowMs),
        conversationId: messageId,
        depth,
        body: prompt,
      };
      yield* checkEnvelopeSize(envelope);
      // Written before anything is sent, as a message to another environment will be.
      yield* repository
        .insertMessage({
          messageId,
          kind: "start-thread",
          envelope,
          senderEnvironmentId: caller.environmentId,
          senderThreadId: caller.threadId,
          targetEnvironmentId: environmentId,
          targetThreadId: threadId,
          status: "delivered",
          createdAt: isoAt(nowMs),
          deliveredAt: isoAt(nowMs),
        })
        .pipe(Effect.catch(internal("Could not record the new thread.")));

      const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
        engine.dispatch(command).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("agent thread start failed", { cause }).pipe(
              Effect.andThen(
                fail("invalid-request", `Could not start the thread: ${cause.message}`),
              ),
            ),
          ),
        );
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`agent-create:${messageId}`),
        threadId,
        projectId: project.id,
        title,
        modelSelection,
        runtimeMode: callerShell.runtimeMode,
        interactionMode: "default",
        branch,
        worktreePath,
        createdAt: isoAt(nowMs),
      }).pipe(Effect.tapError(() => repository.markFailed(messageId).pipe(Effect.ignore)));
      // Only a thread that exists counts toward the starting thread's limits and depth.
      yield* repository
        .insertLink({
          environmentId,
          threadId,
          startedByEnvironmentId: caller.environmentId,
          startedByThreadId: caller.threadId,
          startedByMessageId: messageId,
          depth,
          createdAt: isoAt(nowMs),
        })
        .pipe(Effect.catch(internal("Could not record the new thread.")));

      const reportBack = input.reportBack ?? true;
      yield* dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`agent-start:${messageId}`),
        threadId,
        message: {
          messageId: MessageId.make(`agent-start-${messageId}`),
          role: "user",
          text: agentThreadStartText(envelope, reportBack, setup),
          attachments: [],
          context: decodeMessageContext({
            version: 1,
            records: [
              {
                version: 1,
                contextId: `agent-message-${messageId}`,
                label: agentMessageLabel(envelope),
                kind: AGENT_MESSAGE_CONTEXT_KIND,
                payload: envelope,
              },
            ],
          }),
        },
        modelSelection,
        ...(input.title?.trim() ? {} : { titleSeed: title }),
        runtimeMode: callerShell.runtimeMode,
        interactionMode: "default",
        createdAt: isoAt(nowMs),
      });

      const wait = reportBack
        ? yield* scheduler
            .scheduleWait({
              threadId: caller.threadId,
              target: { environmentId, threadId },
              title,
              note: "",
            })
            .pipe(
              Effect.map((checkIn) => checkIn.id as string),
              Effect.catch((error) =>
                Effect.logWarning("agent thread report-back wait failed", {
                  detail: error.detail,
                }).pipe(Effect.as(null)),
              ),
            )
        : null;

      return {
        environmentId,
        threadId,
        title,
        provider: provider.instanceId,
        model,
        workspace,
        branch,
        worktreePath,
        waitId: wait,
        setupScript: setup === undefined ? "none" : "in-first-message",
      };
    },
  );

  const send: AgentThreads["Service"]["send"] = Effect.fn("AgentThreads.send")(
    function* (caller, input) {
      const callerShell = yield* localThread(caller);
      const target = yield* localThread(input);
      if (target.id === caller.threadId) {
        return yield* fail("invalid-request", "A thread cannot message itself.");
      }
      const body = input.message.trim();
      if (!body) return yield* fail("invalid-request", "The message is empty.");
      if (body.length > AGENT_MESSAGE_MAX_CHARS) {
        return yield* fail(
          "message-too-large",
          `The message is ${body.length} characters; the most is ${AGENT_MESSAGE_MAX_CHARS}. Put the details in a file and point to it.`,
        );
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const targetRef = { environmentId, threadId: target.id };
      const sent = yield* repository
        .countSentSince(caller, since(nowMs))
        .pipe(Effect.catch(internal("Could not read the thread's history.")));
      if (sent >= AGENT_MESSAGES_SENT_PER_HOUR) {
        return yield* fail(
          "rate-limited",
          `This thread sent ${sent} messages in the last hour, the most it may. Try again later.`,
        );
      }
      const received = yield* repository
        .countReceivedSince(targetRef, since(nowMs))
        .pipe(Effect.catch(internal("Could not read that thread's history.")));
      if (received >= AGENT_MESSAGES_RECEIVED_PER_HOUR) {
        return yield* fail(
          "rate-limited",
          `That thread received ${received} messages from agents in the last hour, the most it takes. Try again later.`,
        );
      }
      const messageId = yield* uuid;
      // A reply joins the conversation of the message it answers, while that message is kept.
      const inReplyTo = input.inReplyTo?.trim() || undefined;
      const answered =
        inReplyTo === undefined
          ? Option.none()
          : yield* repository
              .getMessage(inReplyTo)
              .pipe(Effect.catch(internal("Could not read the thread's history.")));
      const envelope: AgentMessageEnvelope = {
        version: 1,
        messageId,
        kind: "message",
        from: yield* senderOf(caller, callerShell),
        to: targetRef,
        sentAt: isoAt(nowMs),
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
        conversationId: Option.isSome(answered)
          ? answered.value.envelope.conversationId
          : (inReplyTo ?? messageId),
        depth: yield* depthOf(caller),
        body,
      };
      yield* checkEnvelopeSize(envelope);
      yield* repository
        .insertMessage({
          messageId,
          kind: "message",
          envelope,
          senderEnvironmentId: caller.environmentId,
          senderThreadId: caller.threadId,
          targetEnvironmentId: environmentId,
          targetThreadId: target.id,
          status: "queued",
          createdAt: isoAt(nowMs),
          deliveredAt: null,
        })
        .pipe(Effect.catch(internal("Could not save the message.")));
      yield* scheduler.wake;
      return {
        messageId,
        delivery: CheckInScheduler.threadReadyForCheckIn(target, nowMs)
          ? ("soon" as const)
          : ("when-idle" as const),
      };
    },
  );

  const watch: AgentThreads["Service"]["watch"] = Effect.fn("AgentThreads.watch")(
    function* (caller, input) {
      const target = yield* localThread(input);
      if (target.id === caller.threadId) {
        return yield* fail("invalid-request", "A thread cannot wait for itself.");
      }
      return yield* scheduler
        .scheduleWait({
          threadId: caller.threadId,
          target: { environmentId, threadId: target.id },
          title: target.title,
          note: input.note ?? "",
        })
        .pipe(Effect.mapError((error) => fail("invalid-request", error.detail)));
    },
  );

  const cancelWait: AgentThreads["Service"]["cancelWait"] = Effect.fn("AgentThreads.cancelWait")(
    function* (caller, waitId) {
      const waits = yield* scheduler.list(caller.threadId);
      const wait = waits.find((checkIn) => checkIn.id === waitId && checkIn.waitsFor !== undefined);
      if (wait === undefined) return false;
      return yield* scheduler.cancel(wait.id, caller.threadId);
    },
    Effect.mapError((error) => fail("invalid-request", error.detail)),
  );

  // One start and one send at a time: a limit's count and the row it counts must not interleave
  // with another call's, as a parallel batch of tool calls would make them.
  const startLock = yield* Semaphore.make(1);
  const sendLock = yield* Semaphore.make(1);
  return AgentThreads.of({
    list,
    read,
    start: (caller, input) => startLock.withPermits(1)(start(caller, input)),
    send: (caller, input) => sendLock.withPermits(1)(send(caller, input)),
    watch,
    cancelWait,
  });
});

export const layer = Layer.effect(AgentThreads, make);
