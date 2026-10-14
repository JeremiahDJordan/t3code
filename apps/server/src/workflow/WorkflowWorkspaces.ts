/**
 * Git worktrees for a workflow's `workspace()` calls, so agents that edit
 * files can work in parallel. Each workspace is a branch `t3/wf/<run>/<name>`;
 * its worktree is created the first time at the commit its `from` names (the
 * coordinator checkout's HEAD by default), found again on a rerun (set up again
 * if its setup failed), and removed when a run finishes unless it has
 * uncommitted changes. Branches stay: merging is the script's business.
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class WorkflowWorkspaceError extends Schema.TaggedError<WorkflowWorkspaceError>()(
  "WorkflowWorkspaceError",
  {
    operation: Schema.Literals(["create", "setup", "remove", "resolve"]),
    branch: Schema.String,
    /** What a `resolve` could not find. */
    from: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "setup":
        return `The setup script failed in the worktree for ${this.branch}.`;
      case "resolve":
        return `from "${this.from}" is not a branch or commit in this repository.`;
      default:
        return `Could not ${this.operation} the worktree for ${this.branch}.`;
    }
  }
}

/** A workspace name a script may use: it becomes part of a branch name, so git's ref rules apply. */
export const isWorkflowWorkspaceName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) &&
  !name.includes("..") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock");

/**
 * A `from` a script may name: a branch, tag or commit SHA, spelled as git's ref rules allow. No
 * revision syntax (`~`, `^`, `@{`, `:`) and no leading `-`, so it names a ref or an object of the
 * coordinator's repository, never an option or a path.
 */
export const isWorkflowWorkspaceFrom = (from: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(from) &&
  !from.includes("..") &&
  !from.includes("//") &&
  !from.includes("/.") &&
  !from.endsWith("/") &&
  !from.endsWith(".") &&
  !from.endsWith(".lock");

/**
 * Where the commit a workspace's branch started at is recorded. It is written before the branch,
 * so a rerun, or one after the branch was deleted by hand, starts the workspace at the same commit
 * however its `from` has moved since.
 */
export const workflowWorkspaceBaseRef = (branch: string) => `refs/t3/workflow-bases/${branch}`;

/** The branch a run's workspace lives on; stable across reruns of the same run. */
export function workflowWorkspaceBranch(coordinatorThreadId: ThreadId, name: string): string {
  const run = bytesToHex(sha256(new TextEncoder().encode(coordinatorThreadId))).slice(0, 10);
  return `t3/wf/${run}/${name}`;
}

export class WorkflowWorkspaces extends Context.Service<
  WorkflowWorkspaces,
  {
    /**
     * The worktree for `branch`: an existing one, else one made at the commit `from` names in
     * `cwd`'s repository (its HEAD by default), with setup run.
     */
    readonly ensure: (input: {
      readonly projectId: ProjectId;
      /** The coordinator thread, whose terminals run the setup script. */
      readonly ownerThreadId: ThreadId;
      readonly cwd: string;
      readonly branch: string;
      /** A ref or commit SHA, read only when the branch is first created. */
      readonly from?: string | undefined;
    }) => Effect.Effect<{ readonly worktreePath: string }, WorkflowWorkspaceError>;
    readonly remove: (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<void, WorkflowWorkspaceError>;
  }
>()("t3/workflow/WorkflowWorkspaces") {}

/**
 * File in a worktree's own git directory, written once its setup ran, so a
 * worktree left by a setup that failed is set up again rather than handed to
 * agents as it is. Git removes the directory with the worktree.
 */
const SETUP_MARKER = "t3-workflow-setup";

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The marker's path: a linked worktree's `.git` is a file pointing at its git directory. */
  const setupMarker = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((pointer) => {
        const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
        return target === undefined || target.length === 0
          ? undefined
          : path.join(path.resolve(worktreePath, target), SETUP_MARKER);
      }),
      Effect.orElseSucceed(() => undefined),
    );

  const isSetUp = (worktreePath: string) =>
    setupMarker(worktreePath).pipe(
      Effect.flatMap((marker) =>
        marker === undefined
          ? Effect.succeed(false)
          : fs.exists(marker).pipe(Effect.orElseSucceed(() => false)),
      ),
    );

  // A marker that cannot be written only makes the next run set the tree up again.
  const markSetUp = (worktreePath: string) =>
    setupMarker(worktreePath).pipe(
      Effect.flatMap((marker) =>
        marker === undefined ? Effect.void : fs.writeFileString(marker, ""),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not record a workflow worktree's setup", { worktreePath, error }),
      ),
    );

  /**
   * Where `branch` is checked out, if anywhere, and the repository's main checkout. Read from git
   * every time: the driver's cached refs miss a branch a user switched by hand.
   */
  const checkouts = (cwd: string, branch: string) =>
    Effect.gen(function* () {
      const result = yield* git.execute({
        operation: "WorkflowWorkspaces.checkouts",
        cwd,
        args: ["worktree", "list", "--porcelain", "-z"],
      });
      // One record per worktree, each ended by an empty field; the main checkout comes first. A
      // `prunable` record's directory is gone, so its branch can be checked out again.
      const records = result.stdout.split("\0\0").map((record) => record.split("\0"));
      const folder = (fields: ReadonlyArray<string> | undefined) => {
        const worktree = fields?.find((field) => field.startsWith("worktree "));
        return worktree === undefined
          ? null
          : path.resolve(cwd, worktree.slice("worktree ".length));
      };
      return {
        worktreePath: folder(
          records.find(
            (fields) =>
              fields.includes(`branch refs/heads/${branch}`) &&
              !fields.some((field) => field.startsWith("prunable")),
          ),
        ),
        mainCheckout: folder(records[0]),
      };
    });

  /**
   * A folder's identity on disk, so two spellings of one folder match: through a symlink, or in
   * another letter case on a case-insensitive volume. A folder that is not there matches nothing.
   */
  const identity = (folder: string) =>
    fs.stat(folder).pipe(
      Effect.flatMap((info) =>
        Option.isSome(info.ino)
          ? Effect.succeed(`${info.dev}:${info.ino.value}`)
          : fs.realPath(folder),
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * The identities of `folder` and of every folder above it, walked from its real path so a
   * symlinked spelling still reaches the checkout that holds it.
   */
  const enclosingIdentities = (folder: string) =>
    Effect.gen(function* () {
      let current = yield* fs
        .realPath(folder)
        .pipe(Effect.orElseSucceed(() => path.resolve(folder)));
      const found = new Set<string>();
      while (true) {
        const id = yield* identity(current);
        if (id !== null) found.add(id);
        const parent = path.dirname(current);
        if (parent === current) return found;
        current = parent;
      }
    });

  /**
   * Which of the project's own folders `worktreePath` is or holds, if any: the coordinator's
   * checkout, the project's root, either of which may sit below the top of a checkout, or the
   * repository's main checkout. Removing such a checkout would remove that folder. A checkout
   * inside the project's folder is a worktree of its own and stays usable. Without the project
   * its root is unknown, so no checkout counts as safe.
   */
  const projectFolder = (
    input: { readonly projectId: ProjectId; readonly cwd: string },
    worktreePath: string,
    mainCheckout: string | null,
  ) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return "a checkout of a project that could not be found";
      const target = yield* identity(worktreePath);
      if (target === null) return null;
      const folders = [
        ["the coordinator's checkout", input.cwd],
        ["the project's root", project.workspaceRoot],
      ] as const;
      for (const [name, folder] of folders) {
        if ((yield* enclosingIdentities(folder)).has(target)) return name;
      }
      if (mainCheckout !== null && (yield* identity(mainCheckout)) === target) {
        return "the repository's main checkout";
      }
      return null;
    });

  /** The commit `revision` names in `cwd`'s repository, or null when it names none. */
  const commitOf = (cwd: string, revision: string) =>
    git
      .execute({
        operation: "WorkflowWorkspaces.commitOf",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  /** The commit a new branch starts at: the recorded one, else `from` resolved now and recorded. */
  const startCommit = (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly from?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const ref = workflowWorkspaceBaseRef(input.branch);
      const recorded = yield* commitOf(input.cwd, ref);
      if (recorded !== null) return recorded;
      const from = input.from ?? "HEAD";
      const commit = yield* commitOf(input.cwd, from);
      if (commit === null) {
        return yield* new WorkflowWorkspaceError({
          operation: "resolve",
          branch: input.branch,
          from,
        });
      }
      yield* git.execute({
        operation: "WorkflowWorkspaces.recordStart",
        cwd: input.cwd,
        args: ["update-ref", ref, commit],
      });
      return commit;
    });

  const runSetup = (input: {
    readonly projectId: ProjectId;
    readonly ownerThreadId: ThreadId;
    readonly worktreePath: string;
    readonly branch: string;
  }) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return;
      const setup = yield* setupScripts.runForThread({
        threadId: input.ownerThreadId,
        projectId: input.projectId,
        projectCwd: project.workspaceRoot,
        worktreePath: input.worktreePath,
        preferredTerminalId: `workflow-setup:${input.branch}`,
        observeCompletion: {},
        project: { id: project.id, workspaceRoot: project.workspaceRoot, scripts: project.scripts },
      });
      // A script marked async lets agents start while it runs, as in a launched thread.
      if (setup.status !== "started" || setup.async || setup.completion === undefined) return;
      const completion = yield* setup.completion;
      if (completion.exitCode !== 0) {
        return yield* new WorkflowWorkspaceError({ operation: "setup", branch: input.branch });
      }
    }).pipe(
      Effect.catchTags({
        ProjectSetupScriptOperationError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
        ProjectSetupScriptProjectNotFoundError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
        ProjectOperationError: (cause) =>
          new WorkflowWorkspaceError({ operation: "setup", branch: input.branch, cause }),
      }),
    );

  const setUp = (input: Parameters<typeof runSetup>[0]) =>
    runSetup(input).pipe(Effect.andThen(markSetUp(input.worktreePath)));

  const ensure: WorkflowWorkspaces["Service"]["ensure"] = (input) =>
    Effect.gen(function* () {
      const { worktreePath: existing, mainCheckout } = yield* checkouts(input.cwd, input.branch);
      if (existing !== null) {
        // The branch checked out in or around a folder of the project's own, as a user inspecting
        // it leaves it, is no worktree to hand agents, and setup never runs there.
        const folder = yield* projectFolder(input, existing, mainCheckout);
        if (folder !== null) {
          return yield* new WorkflowWorkspaceError({
            operation: "create",
            branch: input.branch,
            cause: new Error(
              `${input.branch} is checked out at ${existing}, which is or holds ${folder}`,
            ),
          });
        }
        // A setup that failed left the worktree and its files; it runs again.
        if (!(yield* isSetUp(existing))) yield* setUp({ ...input, worktreePath: existing });
        return { worktreePath: existing };
      }
      const branchExists = (yield* git.listLocalBranchNames(input.cwd)).includes(input.branch);
      // Git keeps a record for a worktree directory deleted by hand and
      // refuses to check its branch out again until the record is pruned.
      if (branchExists) yield* git.pruneWorktrees({ cwd: input.cwd });
      const worktreesDirectory = yield* settings.getSettings.pipe(
        Effect.map((current) => current.worktreesDirectory),
        Effect.orElseSucceed(() => ""),
      );
      const created = yield* git.createWorktree(
        branchExists
          ? { cwd: input.cwd, refName: input.branch, path: null }
          : {
              cwd: input.cwd,
              refName: yield* startCommit(input),
              newRefName: input.branch,
              path: null,
            },
        { worktreesDirectory },
      );
      yield* setUp({ ...input, worktreePath: created.worktree.path });
      return { worktreePath: created.worktree.path };
    }).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          new WorkflowWorkspaceError({ operation: "create", branch: input.branch, cause }),
        ProjectOperationError: (cause) =>
          new WorkflowWorkspaceError({ operation: "create", branch: input.branch, cause }),
      }),
      Effect.withSpan("WorkflowWorkspaces.ensure"),
    );

  // Not forced: git refuses a worktree with changes nobody committed, and
  // that work is worth more than a tidy worktrees directory.
  const remove: WorkflowWorkspaces["Service"]["remove"] = (input) =>
    git.removeWorktree({ cwd: input.cwd, path: input.worktreePath }).pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          new WorkflowWorkspaceError({ operation: "remove", branch: input.branch, cause }),
      }),
      Effect.withSpan("WorkflowWorkspaces.remove"),
    );

  return WorkflowWorkspaces.of({ ensure, remove });
});

export const layer = Layer.effect(WorkflowWorkspaces, make);
