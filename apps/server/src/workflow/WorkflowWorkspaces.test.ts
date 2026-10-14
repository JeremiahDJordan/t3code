// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkflowWorkspaces from "./WorkflowWorkspaces.ts";

const projectId = ProjectId.make("project:workflow-workspaces");
const coordinatorThreadId = ThreadId.make("thread:workflow-coordinator");

/** Runs git by hand, as a user would, outside the driver and its caches. */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args]);

/**
 * WorkflowWorkspaces over a real git driver. `workspaceRoot` is the project's root, or null for a
 * project that cannot be found; every setup run is recorded in `setups`, and fails when `failNext`.
 */
const makeLayer = (
  repo: string,
  refs: {
    readonly setups: Ref.Ref<ReadonlyArray<string>>;
    readonly failNext: Ref.Ref<boolean>;
    readonly workspaceRoot: Ref.Ref<string | null>;
  },
) =>
  WorkflowWorkspaces.layer.pipe(
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(repo, { prefix: "t3-workflow-ws-" })),
        Layer.provide(VcsProcess.layer),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({}).pipe(Layer.orDie),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Ref.get(refs.workspaceRoot).pipe(
              Effect.map((workspaceRoot) =>
                workspaceRoot === null
                  ? Option.none()
                  : Option.some({ id, workspaceRoot, scripts: [] } as never),
              ),
            ),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(refs.setups, (all) => [...all, input.worktreePath]);
              const fails = yield* Ref.getAndSet(refs.failNext, false);
              return {
                status: "started" as const,
                scriptId: "setup",
                scriptName: "setup",
                scriptCommand: "true",
                terminalId: input.preferredTerminalId ?? "setup",
                cwd: input.worktreePath,
                async: false,
                completion: Effect.succeed({ exitCode: fails ? 1 : 0, durationMs: 0 }),
              };
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("WorkflowWorkspaces", () => {
  it.live("creates a worktree from HEAD, retries failed setup, and removes only a clean one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        /** Whether the next setup script run fails. */
        const failNext = yield* Ref.make(false);
        const workspaceRoot = yield* Ref.make<string | null>(repo);
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "noise");
          const input = { projectId, ownerThreadId: coordinatorThreadId, cwd: repo, branch };

          const created = yield* workspaces.ensure(input);
          expect(yield* fs.exists(`${created.worktreePath}/README.md`)).toBe(true);
          expect(yield* driver.listLocalBranchNames(repo)).toContain(branch);
          expect(yield* Ref.get(setups)).toEqual([created.worktreePath]);

          // A rerun finds the same worktree and runs no setup again.
          const found = yield* workspaces.ensure(input);
          expect(yield* fs.realPath(found.worktreePath)).toBe(
            yield* fs.realPath(created.worktreePath),
          );
          expect(yield* Ref.get(setups)).toHaveLength(1);

          yield* workspaces.remove({ cwd: repo, worktreePath: created.worktreePath, branch });
          expect(yield* fs.exists(created.worktreePath)).toBe(false);
          expect(yield* driver.listLocalBranchNames(repo)).toContain(branch);

          // After removal the branch is checked out again rather than recreated. A
          // setup that fails leaves the worktree and its files, and the next run
          // sets it up again rather than handing it to agents as it is.
          yield* Ref.set(failNext, true);
          const failed = yield* workspaces.ensure(input).pipe(Effect.flip);
          expect(failed.operation).toBe("setup");
          const againPath = (yield* Ref.get(setups)).at(-1)!;
          expect(yield* fs.exists(`${againPath}/README.md`)).toBe(true);
          const again = yield* workspaces.ensure(input);
          expect(yield* fs.realPath(again.worktreePath)).toBe(yield* fs.realPath(againPath));
          expect(yield* Ref.get(setups)).toEqual([created.worktreePath, againPath, againPath]);
          // Set up at last, it is found without another setup.
          yield* workspaces.ensure(input);
          expect(yield* Ref.get(setups)).toHaveLength(3);

          // Work nobody committed keeps its worktree.
          yield* fs.writeFileString(`${again.worktreePath}/draft.txt`, "unsaved\n");
          const kept = yield* workspaces
            .remove({ cwd: repo, worktreePath: again.worktreePath, branch })
            .pipe(Effect.flip);
          expect(kept.operation).toBe("remove");
          expect(yield* fs.readFileString(`${again.worktreePath}/draft.txt`)).toBe("unsaved\n");
          yield* driver.removeWorktree({ cwd: repo, path: again.worktreePath, force: true });

          // A worktree directory deleted by hand does not block the next run.
          const deleted = yield* workspaces.ensure(input);
          yield* fs.remove(deleted.worktreePath, { recursive: true });
          const recreated = yield* workspaces.ensure(input);
          expect(yield* fs.exists(`${recreated.worktreePath}/README.md`)).toBe(true);
          yield* workspaces.remove({ cwd: repo, worktreePath: recreated.worktreePath, branch });

          // The branch checked out in the project's own folder, as a user inspecting
          // it leaves it, is no worktree to hand agents, and setup never runs there.
          const before = yield* Ref.get(setups);
          git(repo, "checkout", "-q", branch);
          const taken = yield* workspaces.ensure(input).pipe(Effect.flip);
          expect(taken.operation).toBe("create");
          expect(yield* Ref.get(setups)).toEqual(before);
          // So it is when the coordinator runs in another checkout of the project.
          const coordinator = yield* driver.createWorktree(
            { cwd: repo, refName: "HEAD", newRefName: "workflow-coordinator", path: null },
            { worktreesDirectory: "" },
          );
          const coordinatorPath = coordinator.worktree.path;
          const fromCoordinator = yield* workspaces
            .ensure({ ...input, cwd: coordinatorPath })
            .pipe(Effect.flip);
          expect(fromCoordinator.operation).toBe("create");
          expect(String(fromCoordinator.cause)).toContain("the project's root");
          expect(yield* Ref.get(setups)).toEqual(before);
          // And the branch checked out in the coordinator's own checkout. The user moves
          // it there by hand, so only a fresh look at git finds it there.
          git(repo, "checkout", "-q", "-");
          git(coordinatorPath, "checkout", "-q", branch);
          const inCoordinator = yield* workspaces
            .ensure({ ...input, cwd: coordinatorPath })
            .pipe(Effect.flip);
          expect(inCoordinator.operation).toBe("create");
          expect(String(inCoordinator.cause)).toContain("the coordinator's checkout");
          expect(yield* Ref.get(setups)).toEqual(before);

          // Once the user moves it to a checkout of its own, that one is set up and reused.
          git(coordinatorPath, "checkout", "-q", "workflow-coordinator");
          const elsewhere = `${yield* fs.makeTempDirectoryScoped()}/inspecting`;
          git(repo, "worktree", "add", "-q", elsewhere, branch);
          const moved = yield* workspaces.ensure({ ...input, cwd: coordinatorPath });
          expect(yield* fs.realPath(moved.worktreePath)).toBe(yield* fs.realPath(elsewhere));
          expect(yield* Ref.get(setups)).toEqual([...before, moved.worktreePath]);
          yield* driver.removeWorktree({ cwd: repo, path: elsewhere, force: true });
          yield* driver.removeWorktree({ cwd: repo, path: coordinatorPath, force: true });
        }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
      }),
    ),
  );

  it.live("refuses every checkout of the project's own, however it is named or found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces-folders");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const failNext = yield* Ref.make(false);
        const workspaceRoot = yield* Ref.make<string | null>(repo);
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const fs = yield* FileSystem.FileSystem;
          const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "folders");
          const folders = yield* fs.makeTempDirectoryScoped();
          git(repo, "branch", branch);
          // The project is rooted at a linked worktree, and the coordinator runs in another.
          const projectRoot = `${folders}/project-root`;
          git(repo, "worktree", "add", "-q", "-b", "project-root", projectRoot);
          const coordinator = `${folders}/coordinator`;
          git(repo, "worktree", "add", "-q", "-b", "coordinator", coordinator);
          yield* Ref.set(workspaceRoot, projectRoot);
          const input = { projectId, ownerThreadId: coordinatorThreadId, cwd: coordinator, branch };

          // The branch checked out in the repository's main checkout.
          git(repo, "checkout", "-q", branch);
          const inMain = yield* workspaces.ensure({ ...input, cwd: projectRoot }).pipe(Effect.flip);
          expect(inMain.operation).toBe("create");
          expect(String(inMain.cause)).toContain("the repository's main checkout");
          git(repo, "checkout", "-q", "-");

          // The branch checked out in the project's root, recorded in another letter case.
          const swappedRoot = `${folders}/PROJECT-ROOT`;
          if (yield* fs.exists(swappedRoot)) {
            git(projectRoot, "checkout", "-q", branch);
            yield* Ref.set(workspaceRoot, swappedRoot);
            const inRoot = yield* workspaces.ensure(input).pipe(Effect.flip);
            expect(inRoot.operation).toBe("create");
            expect(String(inRoot.cause)).toContain("the project's root");
            yield* Ref.set(workspaceRoot, projectRoot);
            git(projectRoot, "checkout", "-q", "project-root");
          }

          // Another thread's worktree of the branch is reused, but not for a project that
          // cannot be found, whose root could be that worktree.
          const otherThread = `${folders}/other-thread`;
          git(repo, "worktree", "add", "-q", otherThread, branch);
          yield* Ref.set(workspaceRoot, null);
          const unknown = yield* workspaces.ensure(input).pipe(Effect.flip);
          expect(unknown.operation).toBe("create");
          expect(String(unknown.cause)).toContain("could not be found");
          expect(yield* Ref.get(setups)).toEqual([]);

          yield* Ref.set(workspaceRoot, projectRoot);
          const reused = yield* workspaces.ensure(input);
          expect(yield* fs.realPath(reused.worktreePath)).toBe(yield* fs.realPath(otherThread));
          expect(yield* Ref.get(setups)).toEqual([reused.worktreePath]);
        }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
      }),
    ),
  );

  it.live("refuses a checkout that holds the project or the coordinator below its top", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces-nested", {
          "subdir/keep.txt": "keep\n",
        });
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const failNext = yield* Ref.make(false);
        const workspaceRoot = yield* Ref.make<string | null>(repo);
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const fs = yield* FileSystem.FileSystem;
          const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "nested");
          const folders = yield* fs.makeTempDirectoryScoped();
          const linked = `${folders}/linked`;
          git(repo, "worktree", "add", "-q", "-b", branch, linked);
          const input = { projectId, ownerThreadId: coordinatorThreadId, cwd: repo, branch };

          // The project registered at a folder inside the checkout that holds the branch, also
          // through a symlink: removing that checkout would remove the project.
          const alias = `${folders}/alias`;
          yield* fs.symlink(`${linked}/subdir`, alias);
          for (const root of [`${linked}/subdir`, alias]) {
            yield* Ref.set(workspaceRoot, root);
            const holdsProject = yield* workspaces.ensure(input).pipe(Effect.flip);
            expect(holdsProject.operation).toBe("create");
            expect(String(holdsProject.cause)).toContain("the project's root");
          }
          yield* Ref.set(workspaceRoot, repo);

          // The coordinator running in a folder inside it.
          const holdsCoordinator = yield* workspaces
            .ensure({ ...input, cwd: `${linked}/subdir` })
            .pipe(Effect.flip);
          expect(holdsCoordinator.operation).toBe("create");
          expect(String(holdsCoordinator.cause)).toContain("the coordinator's checkout");
          expect(yield* Ref.get(setups)).toEqual([]);
          expect(yield* fs.exists(`${linked}/subdir/keep.txt`)).toBe(true);

          // A worktree inside the project's folder is one of its own, and is reused, as it is for
          // a project outside any checkout.
          git(linked, "checkout", "-q", "--detach");
          const inner = `${repo}/.worktrees/inner`;
          git(repo, "worktree", "add", "-q", inner, branch);
          const reused = yield* workspaces.ensure(input);
          expect(yield* fs.realPath(reused.worktreePath)).toBe(yield* fs.realPath(inner));
          yield* Ref.set(workspaceRoot, yield* fs.makeTempDirectoryScoped());
          yield* workspaces.ensure(input);
          expect(yield* Ref.get(setups)).toEqual([reused.worktreePath]);
        }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
      }),
    ),
  );

  it.live("starts a worktree at the commit from names, and at the same one on a rerun", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces-from");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const failNext = yield* Ref.make(false);
        const workspaceRoot = yield* Ref.make<string | null>(repo);
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const read = (cwd: string, ...args: ReadonlyArray<string>) =>
            git(cwd, ...args)
              .toString()
              .trim();
          const head = read(repo, "rev-parse", "HEAD");
          // A feature branch one commit ahead, not checked out anywhere.
          git(repo, "switch", "-q", "-c", "feature/base");
          yield* fs.writeFileString(`${repo}/feature.txt`, "feature\n");
          git(repo, "add", "feature.txt");
          git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feature");
          const feature = read(repo, "rev-parse", "HEAD");
          git(repo, "switch", "-q", "-");
          const branchOf = (name: string) =>
            WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, name);
          const input = (name: string, from?: string) => ({
            projectId,
            ownerThreadId: coordinatorThreadId,
            cwd: repo,
            branch: branchOf(name),
            from,
          });

          // From a branch: on the run's own branch, at the branch's commit.
          const review = yield* workspaces.ensure(input("review", "feature/base"));
          expect(read(review.worktreePath, "rev-parse", "HEAD")).toBe(feature);
          expect(read(review.worktreePath, "branch", "--show-current")).toBe(branchOf("review"));
          expect(yield* fs.exists(`${review.worktreePath}/feature.txt`)).toBe(true);
          // From a commit SHA, and from another workspace's branch.
          const pinned = yield* workspaces.ensure(input("pinned", head));
          expect(read(pinned.worktreePath, "rev-parse", "HEAD")).toBe(head);
          const second = yield* workspaces.ensure(
            input("second", `refs/heads/${branchOf("review")}`),
          );
          expect(read(second.worktreePath, "rev-parse", "HEAD")).toBe(feature);

          // Nothing in this repository by that name, or no commit: refused, nothing created.
          const tree = read(repo, "rev-parse", "HEAD^{tree}");
          for (const missing of ["no-such-branch", tree]) {
            const refused = yield* workspaces.ensure(input("missing", missing)).pipe(Effect.flip);
            expect(refused.operation).toBe("resolve");
            expect(refused.message).toBe(
              `from "${missing}" is not a branch or commit in this repository.`,
            );
          }
          expect(yield* driver.listLocalBranchNames(repo)).not.toContain(branchOf("missing"));
          expect(yield* Ref.get(setups)).toHaveLength(3);

          // A rerun starts where the first run did though the branch it named has moved, also
          // once the workspace's branch was deleted by hand.
          git(repo, "branch", "-f", "feature/base", head);
          yield* driver.removeWorktree({ cwd: repo, path: review.worktreePath, force: true });
          git(repo, "branch", "-D", "-q", branchOf("review"));
          const again = yield* workspaces.ensure(input("review", "feature/base"));
          expect(read(again.worktreePath, "rev-parse", "HEAD")).toBe(feature);
        }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
      }),
    ),
  );

  it.live("reports a workspace's files and commits that differ from where it started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* checkpointWorkspace("workflow-workspaces-changes");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const failNext = yield* Ref.make(false);
        const workspaceRoot = yield* Ref.make<string | null>(repo);
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
          const fs = yield* FileSystem.FileSystem;
          const branch = WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "look");
          const { worktreePath } = yield* workspaces.ensure({
            projectId,
            ownerThreadId: coordinatorThreadId,
            cwd: repo,
            branch,
          });
          const check = { cwd: repo, worktreePath, branch };
          expect(yield* workspaces.changes(check)).toBeNull();

          yield* fs.writeFileString(`${worktreePath}/draft.txt`, "draft\n");
          expect(yield* workspaces.changes(check)).toBe("files changed: draft.txt");

          // A commit is a change, also once the checkout is moved back to where it started.
          const start = git(worktreePath, "rev-parse", "HEAD").toString().trim();
          git(worktreePath, "add", "draft.txt");
          git(worktreePath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
          expect(yield* workspaces.changes(check)).toBe(
            `its branch or checkout moved off ${start.slice(0, 12)}, where it started`,
          );
          git(worktreePath, "checkout", "-q", "--detach", start);
          expect(yield* workspaces.changes(check)).toContain("moved off");
        }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
      }),
    ),
  );

  it.live(
    "deletes a finished workspace's branch only when it holds nothing new, or when told",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* checkpointWorkspace("workflow-workspaces-settle");
          const setups = yield* Ref.make<ReadonlyArray<string>>([]);
          const failNext = yield* Ref.make(false);
          const workspaceRoot = yield* Ref.make<string | null>(repo);
          yield* Effect.gen(function* () {
            const workspaces = yield* WorkflowWorkspaces.WorkflowWorkspaces;
            const driver = yield* GitVcsDriver.GitVcsDriver;
            const fs = yield* FileSystem.FileSystem;
            const branchOf = (name: string) =>
              WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, name);
            const refs = () =>
              git(repo, "for-each-ref", "--format=%(refname)", "refs/t3/workflow-bases")
                .toString()
                .trim();
            /** A workspace, with a commit of its own when `commits`, its worktree removed. */
            const finished = (name: string, commits: boolean) =>
              Effect.gen(function* () {
                const branch = branchOf(name);
                const { worktreePath } = yield* workspaces.ensure({
                  projectId,
                  ownerThreadId: coordinatorThreadId,
                  cwd: repo,
                  branch,
                });
                if (commits) {
                  yield* fs.writeFileString(`${worktreePath}/${name}.txt`, `${name}\n`);
                  git(worktreePath, "add", `${name}.txt`);
                  git(
                    worktreePath,
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "commit",
                    "-qm",
                    name,
                  );
                }
                yield* workspaces.remove({ cwd: repo, worktreePath, branch });
                return branch;
              });
            const branches = () => driver.listLocalBranchNames(repo);

            // Nothing new: gone, start record and all.
            const empty = yield* finished("empty", false);
            expect(
              yield* workspaces.settle({ cwd: repo, branch: empty, cleanup: "unchanged" }),
            ).toEqual({ deleted: true });
            expect(yield* branches()).not.toContain(empty);
            // Commits of its own are the run's output and stay, whatever their merge state.
            const output = yield* finished("output", true);
            expect(
              yield* workspaces.settle({ cwd: repo, branch: output, cleanup: "unchanged" }),
            ).toEqual({ deleted: false });
            expect(yield* branches()).toContain(output);
            // Unless the script asked for "always"; "keep" keeps even an empty one.
            const scratch = yield* finished("scratch", true);
            expect(
              yield* workspaces.settle({ cwd: repo, branch: scratch, cleanup: "always" }),
            ).toEqual({ deleted: true });
            expect(yield* branches()).not.toContain(scratch);
            const kept = yield* finished("kept", false);
            expect(yield* workspaces.settle({ cwd: repo, branch: kept, cleanup: "keep" })).toEqual({
              deleted: false,
            });
            expect(yield* branches()).toContain(kept);
            expect(refs()).toBe("");

            // A branch whose start was never recorded may hold anything, so only "always" drops it.
            const unknown = branchOf("unknown");
            git(repo, "branch", unknown);
            expect(
              yield* workspaces.settle({ cwd: repo, branch: unknown, cleanup: "unchanged" }),
            ).toEqual({ deleted: false });
            // Git refuses to delete a branch a user has checked out, even when told.
            const inspected = yield* finished("inspected", true);
            const elsewhere = `${yield* fs.makeTempDirectoryScoped()}/inspecting`;
            git(repo, "worktree", "add", "-q", elsewhere, inspected);
            const refused = yield* workspaces
              .settle({ cwd: repo, branch: inspected, cleanup: "always" })
              .pipe(Effect.flip);
            expect(refused.operation).toBe("settle");
            expect(yield* branches()).toContain(inspected);
            yield* driver.removeWorktree({ cwd: repo, path: elsewhere, force: true });
          }).pipe(Effect.provide(makeLayer(repo, { setups, failNext, workspaceRoot })));
        }),
      ),
  );

  it("keeps a from to a plain branch, tag or commit name", () => {
    for (const from of ["main", "HEAD", "origin/feature-x", "v1.2.0", "a1b2c3d", "_wip"]) {
      expect(WorkflowWorkspaces.isWorkflowWorkspaceFrom(from)).toBe(true);
    }
    // Options, paths and revision syntax are no branch names.
    for (const from of [
      "--output=/tmp/x",
      "-b",
      "/etc/passwd",
      "../outside",
      "HEAD~1",
      "main^",
      "@{u}",
      "main:file",
      "a..b",
      "a//b",
      "a/.hidden",
      "a.lock",
      "a/",
      "",
    ]) {
      expect(WorkflowWorkspaces.isWorkflowWorkspaceFrom(from)).toBe(false);
    }
  });

  it("keeps workspace names to what a branch can hold", () => {
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("task-1.a_b")).toBe(true);
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("../escape")).toBe(false);
    expect(WorkflowWorkspaces.isWorkflowWorkspaceName("has space")).toBe(false);
    // Names git would refuse as a branch.
    for (const name of ["a..b", "a.lock", "a."]) {
      expect(WorkflowWorkspaces.isWorkflowWorkspaceName(name)).toBe(false);
    }
    expect(WorkflowWorkspaces.workflowWorkspaceBranch(coordinatorThreadId, "noise")).toMatch(
      /^t3\/wf\/[0-9a-f]{10}\/noise$/,
    );
  });
});
