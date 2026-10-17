// @effect-diagnostics nodeBuiltinImport:off - builds real git worktrees and data folders on disk.
import "./testing/longTempDir.ts";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { readT3DataState, removeT3Data } from "./t3DataCleanup.ts";
import { migrateHomeFromT3 } from "./t3DataMigration.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-C", cwd, ...args],
    { encoding: "utf8" },
  );

/**
 * A T3 home with three worktrees of one repository (one a Z6 thread uses, one with uncommitted
 * work, one neither), copied to a Z6 home whose database points at the first.
 */
const setup = () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clean-")));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const t3Home = NodePath.join(root, ".t3");
  NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(t3Home, "userdata", "settings.json"), "{}");
  const worktree = (name: string) => {
    const path = NodePath.join(t3Home, "worktrees", "repo", name);
    git(repo, "worktree", "add", "-q", "-b", name, path);
    return path;
  };
  const used = worktree("used");
  const dirty = worktree("dirty");
  const clean = worktree("clean");
  NodeFS.writeFileSync(NodePath.join(dirty, "README.md"), "changed\n");

  const z6Home = NodePath.join(root, ".z6");
  expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(z6Home, "userdata", "statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
  `);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', NULL, ?)").run(
    JSON.stringify({ worktreePath: used }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'gone', ?)").run(
    JSON.stringify({ worktreePath: clean }),
  );
  db.prepare("INSERT INTO projection_projects VALUES ('p1', ?, NULL)").run(repo);
  db.close();

  const trashDir = NodePath.join(root, "Trash");
  NodeFS.mkdirSync(trashDir);
  const trash = async (path: string) => {
    NodeFS.renameSync(
      path,
      NodePath.join(trashDir, NodePath.relative(root, path).replaceAll("/", "_")),
    );
  };
  return { root, repo, t3Home, z6Home, used, dirty, clean, trash, trashDir };
};

describe("removeT3Data", () => {
  it("keeps worktrees Z6 uses or with uncommitted work, and trashes the rest", async () => {
    const env = setup();
    expect(readT3DataState({ z6Home: env.z6Home, z6UserData: undefined })).toMatchObject({
      locations: [{ kind: "home", path: env.t3Home }],
      promptPending: true,
    });

    const result = await removeT3Data({
      z6Home: env.z6Home,
      z6UserData: undefined,
      t3UserData: undefined,
      homeDirectory: env.root,
      trash: env.trash,
    });

    expect(result.status).toBe("removed");
    if (result.status !== "removed") return;
    expect(result.removed.toSorted()).toEqual(
      [NodePath.join(env.t3Home, "userdata"), env.clean].toSorted(),
    );
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { path: env.used, reason: "Z6 Code's threads or projects use it" },
        { path: env.dirty, reason: "it has uncommitted changes" },
      ]),
    );
    expect(result.kept).toHaveLength(2);
    expect(NodeFS.existsSync(env.used)).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(env.dirty, "README.md"), "utf8")).toBe("changed\n");
    expect(NodeFS.existsSync(env.clean)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(env.t3Home, "userdata"))).toBe(false);
    // git forgets the trashed worktree, so its branch can be checked out elsewhere.
    expect(git(env.repo, "worktree", "list")).not.toContain(env.clean);
    expect(
      readT3DataState({ z6Home: env.z6Home, z6UserData: undefined }).lastCleanup,
    ).toMatchObject({ removed: result.removed });
  });

  it("trashes the whole home when no worktree needs keeping", async () => {
    const env = setup();
    NodeFS.writeFileSync(NodePath.join(env.dirty, "README.md"), "hi\n");
    const db = new NodeSqlite.DatabaseSync(NodePath.join(env.z6Home, "userdata", "statev2.sqlite"));
    db.exec("DELETE FROM orchestration_v2_projection_threads");
    db.close();

    const result = await removeT3Data({
      z6Home: env.z6Home,
      z6UserData: undefined,
      t3UserData: undefined,
      homeDirectory: env.root,
      trash: env.trash,
    });

    expect(result).toMatchObject({ status: "removed", removed: [env.t3Home], kept: [] });
    expect(NodeFS.existsSync(env.t3Home)).toBe(false);
    expect(readT3DataState({ z6Home: env.z6Home, z6UserData: undefined }).locations).toEqual([]);
    expect(git(env.repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("refuses while a T3 server is running, removing nothing", async () => {
    const env = setup();
    const owner = new NodeSqlite.DatabaseSync(
      NodePath.join(env.t3Home, "userdata", "server-owner.sqlite"),
    );
    owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    try {
      const result = await removeT3Data({
        z6Home: env.z6Home,
        z6UserData: undefined,
        t3UserData: undefined,
        homeDirectory: env.root,
        trash: env.trash,
      });
      expect(result.status).toBe("refused");
      expect(NodeFS.readdirSync(env.trashDir)).toEqual([]);
      expect(NodeFS.existsSync(env.clean)).toBe(true);
    } finally {
      owner.close();
    }
  });
});
