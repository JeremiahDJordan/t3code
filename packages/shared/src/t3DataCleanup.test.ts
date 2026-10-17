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

type Env = ReturnType<typeof setup>;

const openZ6Database = (env: Env) =>
  new NodeSqlite.DatabaseSync(NodePath.join(env.z6Home, "userdata", "statev2.sqlite"));

const remove = (env: Env) =>
  removeT3Data({
    z6Home: env.z6Home,
    z6UserData: undefined,
    t3UserData: undefined,
    homeDirectory: env.root,
    trash: env.trash,
  });

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
        { path: env.used, reason: "Z6 Code's database refers to it" },
        { path: env.dirty, reason: "it has uncommitted changes" },
      ]),
    );
    expect(result.kept).toHaveLength(2);
    expect(NodeFS.existsSync(env.used)).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(env.dirty, "README.md"), "utf8")).toBe("changed\n");
    expect(NodeFS.existsSync(env.clean)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(env.t3Home, "userdata"))).toBe(false);
    // No `git worktree prune`: it would also forget unrelated worktrees. The record names it.
    expect(git(env.repo, "worktree", "list")).toContain(env.clean);
    expect(result.trashedCheckouts).toEqual([env.clean]);
    expect(
      readT3DataState({ z6Home: env.z6Home, z6UserData: undefined }).lastCleanup,
    ).toMatchObject({ removed: result.removed, trashedCheckouts: [env.clean] });
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
    if (result.status === "removed") {
      expect(result.trashedCheckouts?.toSorted()).toEqual(
        [env.used, env.dirty, env.clean].toSorted(),
      );
    }
    expect(NodeFS.existsSync(env.t3Home)).toBe(false);
    expect(readT3DataState({ z6Home: env.z6Home, z6UserData: undefined }).locations).toEqual([]);
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

  it("keeps project folders Z6 uses in scratch and projects, and every folder above them", async () => {
    const env = setup();
    const named = NodePath.join(env.t3Home, "projects", "my-app");
    const scratch = NodePath.join(env.t3Home, "scratch", "2026-10-16-demo");
    const stray = NodePath.join(env.t3Home, "projects", "old-notes");
    const empty = NodePath.join(env.t3Home, "projects", "empty", "nested");
    for (const [path, content] of [
      [NodePath.join(named, "index.ts"), "named"],
      [NodePath.join(scratch, "notes.txt"), "scratch"],
      [NodePath.join(stray, "todo.txt"), "not referenced, not in git"],
    ] as const) {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    }
    NodeFS.mkdirSync(empty, { recursive: true });
    const db = openZ6Database(env);
    db.prepare("INSERT INTO projection_projects VALUES ('p2', ?, NULL)").run(named);
    db.prepare("INSERT INTO projection_projects VALUES ('p3', ?, NULL)").run(scratch);
    db.close();

    const result = await remove(env);

    expect(result.status).toBe("removed");
    if (result.status !== "removed") return;
    expect(NodeFS.readFileSync(NodePath.join(named, "index.ts"), "utf8")).toBe("named");
    expect(NodeFS.readFileSync(NodePath.join(scratch, "notes.txt"), "utf8")).toBe("scratch");
    expect(NodeFS.existsSync(NodePath.join(stray, "todo.txt"))).toBe(true);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { path: named, reason: "Z6 Code's database refers to it" },
        { path: scratch, reason: "Z6 Code's database refers to it" },
        {
          path: stray,
          reason: "it holds files outside a git checkout, so they may be your work",
        },
      ]),
    );
    expect(result.removed).toContain(NodePath.join(env.t3Home, "projects", "empty"));
    expect(result.removed).not.toContain(env.t3Home);
  });

  it("keeps a repository in T3's work folders, whose .git holds its only history", async () => {
    const env = setup();
    // A scratch project with a local-only commit, removed from Z6, so nothing refers to it.
    const scratch = NodePath.join(env.t3Home, "scratch", "2026-10-16-repo");
    NodeFS.mkdirSync(scratch, { recursive: true });
    git(scratch, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(scratch, "app.ts"), "only here\n");
    git(scratch, "add", ".");
    git(scratch, "commit", "-q", "-m", "local only");

    const result = await remove(env);

    expect(result.status).toBe("removed");
    if (result.status !== "removed") return;
    expect(git(scratch, "log", "--oneline")).toContain("local only");
    expect(result.kept).toContainEqual({
      path: scratch,
      reason: "it is a git repository with its own history",
    });
    expect(result.removed).toContain(env.clean);
  });

  it("keeps a referenced folder that is not a git checkout", async () => {
    const env = setup();
    const loose = NodePath.join(env.t3Home, "worktrees", "repo", "lost-git");
    NodeFS.mkdirSync(loose, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(loose, "notes.txt"), "work");
    const db = openZ6Database(env);
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('t3', NULL, ?)").run(
      JSON.stringify({ worktreePath: loose, archivedAt: "2026-10-01T00:00:00.000Z" }),
    );
    db.close();

    const result = await remove(env);

    expect(result).toMatchObject({ status: "removed" });
    expect(NodeFS.readFileSync(NodePath.join(loose, "notes.txt"), "utf8")).toBe("work");
  });

  it("protects any stored path into T3's home, and settings that name one", async () => {
    const env = setup();
    const job = NodePath.join(env.t3Home, "userdata", "jobs", "build-1");
    NodeFS.mkdirSync(job, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(job, "stdout.log"), "built");
    NodeFS.writeFileSync(NodePath.join(env.t3Home, "userdata", "other.json"), "{}");
    const db = openZ6Database(env);
    db.exec("CREATE TABLE thread_background_commands (id TEXT, cwd TEXT, job_dir TEXT)");
    db.prepare("INSERT INTO thread_background_commands VALUES ('b1', ?, ?)").run(env.clean, job);
    db.close();
    NodeFS.writeFileSync(
      NodePath.join(env.z6Home, "userdata", "settings.json"),
      JSON.stringify({ worktreesDirectory: "~/.t3/worktrees-custom" }),
    );
    const custom = NodePath.join(env.t3Home, "worktrees-custom");
    NodeFS.mkdirSync(custom);

    const result = await remove(env);

    expect(result.status).toBe("removed");
    if (result.status !== "removed") return;
    expect(NodeFS.existsSync(env.clean)).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(job, "stdout.log"))).toBe(true);
    expect(NodeFS.existsSync(custom)).toBe(true);
    // Only the parts of userdata that are not above a protected path go.
    expect(NodeFS.existsSync(NodePath.join(env.t3Home, "userdata", "other.json"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(env.t3Home, "userdata", "settings.json"))).toBe(false);
  });

  it("keeps the files Z6's copied links still read, and not ones a link has left", async () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clean-")),
    );
    roots.push(root);
    const t3Home = NodePath.join(root, ".t3");
    const userdata = NodePath.join(t3Home, "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    const settings = NodePath.join(t3Home, "settings-current.json");
    NodeFS.writeFileSync(settings, '{"theme":"cinder"}');
    NodeFS.symlinkSync(settings, NodePath.join(userdata, "settings.json"));
    // Relative, but it climbs out of the copy back into T3's home.
    const themes = NodePath.join(t3Home, "themes-current.json");
    NodeFS.writeFileSync(themes, "{}");
    NodeFS.symlinkSync("../../.t3/themes-current.json", NodePath.join(userdata, "themes.json"));
    const keybindings = NodePath.join(t3Home, "keybindings-current.json");
    NodeFS.writeFileSync(keybindings, "[]");
    NodeFS.symlinkSync(keybindings, NodePath.join(userdata, "keybindings.json"));
    const z6Home = NodePath.join(root, ".z6");
    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
    const db = new NodeSqlite.DatabaseSync(NodePath.join(z6Home, "userdata", "statev2.sqlite"));
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, payload_json TEXT);
      CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
    `);
    db.close();
    // Z6 has since replaced one link with a file of its own.
    NodeFS.rmSync(NodePath.join(z6Home, "userdata", "keybindings.json"));
    NodeFS.writeFileSync(NodePath.join(z6Home, "userdata", "keybindings.json"), "[]");
    const trashDir = NodePath.join(root, "Trash");
    NodeFS.mkdirSync(trashDir);

    const result = await removeT3Data({
      z6Home,
      z6UserData: undefined,
      t3UserData: undefined,
      homeDirectory: root,
      trash: async (path) =>
        NodeFS.renameSync(path, NodePath.join(trashDir, NodePath.basename(path))),
    });

    expect(result.status).toBe("removed");
    expect(NodeFS.readFileSync(NodePath.join(z6Home, "userdata", "settings.json"), "utf8")).toBe(
      '{"theme":"cinder"}',
    );
    expect(NodeFS.readFileSync(NodePath.join(z6Home, "userdata", "themes.json"), "utf8")).toBe(
      "{}",
    );
    expect(NodeFS.existsSync(keybindings)).toBe(false);
  });

  it("matches stored paths through symlinks and, where the disk ignores it, case", async () => {
    const env = setup();
    const alias = NodePath.join(env.root, "alias-home");
    NodeFS.symlinkSync(env.t3Home, alias);
    const insensitive = NodeFS.existsSync(env.t3Home.toUpperCase());
    const db = openZ6Database(env);
    db.exec("DELETE FROM orchestration_v2_projection_threads");
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('a', NULL, ?)").run(
      JSON.stringify({ worktreePath: NodePath.join(alias, "worktrees", "repo", "used") }),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('b', NULL, ?)").run(
      JSON.stringify({ worktreePath: env.clean.replace("/.t3/", "/.T3/").toUpperCase() }),
    );
    db.close();

    const result = await remove(env);

    expect(result.status).toBe("removed");
    expect(NodeFS.existsSync(env.used)).toBe(true);
    expect(NodeFS.existsSync(env.clean)).toBe(insensitive);
  });

  it.each([
    [
      "is missing",
      (env: Env) => NodeFS.rmSync(NodePath.join(env.z6Home, "userdata", "statev2.sqlite")),
      /database .* is missing/,
    ],
    [
      "is only T3's older format",
      (env: Env) => {
        const userdata = NodePath.join(env.z6Home, "userdata");
        NodeFS.renameSync(
          NodePath.join(userdata, "statev2.sqlite"),
          NodePath.join(userdata, "state.sqlite"),
        );
      },
      /older format \(state\.sqlite\)/,
    ],
    [
      "has no V2 tables",
      (env: Env) => {
        const db = openZ6Database(env);
        db.exec("DROP TABLE orchestration_v2_projection_threads");
        db.close();
      },
      /not yet at the current format/,
    ],
    [
      "cannot be read",
      (env: Env) =>
        NodeFS.writeFileSync(
          NodePath.join(env.z6Home, "userdata", "statev2.sqlite"),
          Buffer.alloc(4096, 0x41),
        ),
      /could not be read/,
    ],
  ] as const)(
    "refuses, removing nothing, when Z6's database %s",
    async (_name, prepare, expected) => {
      const env = setup();
      prepare(env);

      const result = await remove(env);

      expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(expected) });
      expect(NodeFS.readdirSync(env.trashDir)).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(env.t3Home, "userdata", "settings.json"))).toBe(true);
    },
  );

  it("refuses while T3's background service is installed, saying how to remove it", async () => {
    const env = setup();
    const unit = NodePath.join(env.root, ".config", "systemd", "user", "t3code.service");
    NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
    NodeFS.writeFileSync(unit, "[Service]\n");

    const result = await remove(env);

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("`z6 service uninstall --t3`");
    expect(result.reason).toContain(
      `systemctl --user disable --now t3code.service; rm '${unit}'; systemctl --user daemon-reload`,
    );
    expect(NodeFS.readdirSync(env.trashDir)).toEqual([]);
  });
});
