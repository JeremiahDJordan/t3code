// @effect-diagnostics nodeBuiltinImport:off - builds real T3 data folders on disk.
import "./testing/longTempDir.ts";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  T3MigrationError,
  describeT3Service,
  migrateDesktopUserDataFromT3,
  migrateHomeFromT3,
  readT3MigrationMarker,
} from "./t3DataMigration.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mig-")));
  roots.push(root);
  return root;
};

const write = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
};

/** Every path under `root` with a hash of its content, to prove a folder was left untouched. */
const snapshot = (root: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      const key = NodePath.relative(root, path);
      if (entry.isDirectory()) {
        result[key] = "dir";
        walk(path);
      } else if (entry.isSymbolicLink()) {
        result[key] = `link:${NodeFS.readlinkSync(path)}`;
      } else {
        const stat = NodeFS.statSync(path);
        result[key] =
          `${NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
      }
    }
  };
  walk(root);
  return result;
};

const makeT3Home = (root: string) => {
  const t3Home = NodePath.join(root, ".t3");
  const userdata = NodePath.join(t3Home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('a'), ('b');");
  db.close();
  write(NodePath.join(userdata, "settings.json"), '{"theme":"cinder"}');
  write(NodePath.join(userdata, "themes", "mine.json"), "{}");
  write(NodePath.join(userdata, "attachments", "x.png"), "png");
  write(NodePath.join(userdata, "secrets", "server-signing-key.bin"), "signing");
  write(NodePath.join(userdata, "secrets", "cloud-relay-url.bin"), "relay");
  write(NodePath.join(userdata, "secrets", "secure-channel-x25519.bin"), "key");
  write(NodePath.join(userdata, "environment-id"), "t3-environment");
  write(NodePath.join(userdata, "server-runtime.json"), '{"pid":999999999}');
  write(NodePath.join(userdata, "logs", "server.log"), "log");
  write(NodePath.join(userdata, "logs", "terminals", "thread-1_default.log"), "$ ls\n");
  write(NodePath.join(userdata, "tmux", "default"), "");
  write(NodePath.join(userdata, "connection-catalog.json.tmp"), "partial");
  write(NodePath.join(t3Home, "worktrees", "repo", "feature", "file.txt"), "work");
  write(NodePath.join(t3Home, "runtime", "versions", "1.0.0", "t3"), "binary");
  write(NodePath.join(t3Home, "workflows", "mine.js"), "export default 1");
  NodeFS.symlinkSync("settings.json", NodePath.join(userdata, "settings-link.json"));
  return t3Home;
};

describe("migrateHomeFromT3", () => {
  it("copies the user's data once, leaving T3's home and worktrees untouched", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const z6Home = NodePath.join(root, ".z6");
    const before = snapshot(t3Home);

    const result = migrateHomeFromT3({ t3Home, z6Home, now: "2026-10-16T12:00:00.000Z" });

    expect(result.status).toBe("migrated");
    expect(snapshot(t3Home)).toEqual(before);
    const userdata = NodePath.join(z6Home, "userdata");
    expect(NodeFS.readFileSync(NodePath.join(userdata, "settings.json"), "utf8")).toBe(
      '{"theme":"cinder"}',
    );
    expect(NodeFS.readlinkSync(NodePath.join(userdata, "settings-link.json"))).toBe(
      "settings.json",
    );
    for (const kept of [
      "themes/mine.json",
      "attachments/x.png",
      "secrets/server-signing-key.bin",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(userdata, kept)), kept).toBe(true);
    }
    expect(NodeFS.existsSync(NodePath.join(z6Home, "workflows", "mine.js"))).toBe(true);
    // Terminal history is the user's; the rest of T3's logs stay behind.
    expect(
      NodeFS.readFileSync(
        NodePath.join(userdata, "logs", "terminals", "thread-1_default.log"),
        "utf8",
      ),
    ).toBe("$ ls\n");
    for (const skipped of [
      "userdata/secrets/cloud-relay-url.bin",
      "userdata/secrets/secure-channel-x25519.bin",
      "userdata/environment-id",
      "userdata/server-runtime.json",
      "userdata/logs/server.log",
      "userdata/tmux",
      "userdata/connection-catalog.json.tmp",
      "worktrees",
      "runtime",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(z6Home, skipped)), skipped).toBe(false);
    }
    const db = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
    expect(db.prepare("SELECT count(*) AS n FROM threads").get()?.n).toBe(2);
    db.close();

    const marker = readT3MigrationMarker(z6Home);
    expect(marker?.source).toBe(t3Home);
    expect(marker?.kind).toBe("home");
    expect(marker?.copiedAt).toBe("2026-10-16T12:00:00.000Z");
    expect(marker?.skipped.map((entry) => entry.path)).toContain("worktrees");

    // Once Z6's home exists, T3's is never read again.
    write(NodePath.join(t3Home, "userdata", "settings.json"), '{"theme":"ember"}');
    expect(migrateHomeFromT3({ t3Home, z6Home })).toEqual({
      status: "skipped",
      reason: "destination-exists",
    });
    expect(NodeFS.readFileSync(NodePath.join(userdata, "settings.json"), "utf8")).toBe(
      '{"theme":"cinder"}',
    );
  });

  it("starts empty when there is no T3 home", () => {
    const root = tempRoot();
    const z6Home = NodePath.join(root, ".z6");
    expect(migrateHomeFromT3({ t3Home: NodePath.join(root, ".t3"), z6Home })).toEqual({
      status: "skipped",
      reason: "no-source",
    });
    expect(NodeFS.existsSync(z6Home)).toBe(false);
  });

  it("snapshots a database another connection holds open mid-transaction", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const source = new NodeSqlite.DatabaseSync(NodePath.join(t3Home, "userdata", "statev2.sqlite"));
    try {
      source.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      source.exec("INSERT INTO threads VALUES ('committed-in-wal')");
      source.exec("BEGIN; INSERT INTO threads VALUES ('uncommitted');");
      const z6Home = NodePath.join(root, ".z6");

      expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");

      const copy = new NodeSqlite.DatabaseSync(
        NodePath.join(z6Home, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      expect(
        copy
          .prepare("SELECT id FROM threads ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual(["a", "b", "committed-in-wal"]);
      copy.close();
      expect(NodeFS.existsSync(NodePath.join(z6Home, "userdata", "statev2.sqlite-wal"))).toBe(
        false,
      );
    } finally {
      source.exec("ROLLBACK");
      source.close();
    }
  });

  it("refuses while a T3 server owns the home, changing nothing", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const owner = new NodeSqlite.DatabaseSync(
      NodePath.join(t3Home, "userdata", "server-owner.sqlite"),
    );
    owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    const before = snapshot(NodePath.join(t3Home, "worktrees"));
    const z6Home = NodePath.join(root, ".z6");
    try {
      expect(() => migrateHomeFromT3({ t3Home, z6Home })).toThrow(T3MigrationError);
      expect(NodeFS.existsSync(z6Home)).toBe(false);
      expect(NodeFS.readdirSync(root)).toEqual([".t3"]);
      expect(snapshot(NodePath.join(t3Home, "worktrees"))).toEqual(before);
    } finally {
      owner.close();
    }
    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
  });
});

/** A WAL database whose newest rows are only in its `-wal`, as a crashed T3 server leaves it. */
const writeCrashedWalDatabase = (dir: string, withShm: boolean) => {
  const live = NodePath.join(dir, "live");
  NodeFS.mkdirSync(live, { recursive: true });
  const livePath = NodePath.join(live, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(livePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('in-wal');");
  const userdata = NodePath.join(dir, ".t3", "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.copyFileSync(livePath, NodePath.join(userdata, "statev2.sqlite"));
  NodeFS.copyFileSync(`${livePath}-wal`, NodePath.join(userdata, "statev2.sqlite-wal"));
  if (withShm) {
    NodeFS.copyFileSync(`${livePath}-shm`, NodePath.join(userdata, "statev2.sqlite-shm"));
  }
  // What a server that stopped leaves of its ownership lock, which the in-use check opens.
  NodeFS.writeFileSync(NodePath.join(userdata, "server-owner.sqlite"), "");
  NodeFS.writeFileSync(
    NodePath.join(userdata, "server-owner.sqlite-journal"),
    Buffer.alloc(512, 0xd9),
  );
  db.close();
  NodeFS.rmSync(live, { recursive: true, force: true });
  return NodePath.join(dir, ".t3");
};

describe("migrateHomeFromT3 leaves T3's folders alone", () => {
  it.each([
    { withShm: false, shm: "but no" },
    { withShm: true, shm: "and" },
  ])("never writes into T3's home, for a database with a -wal $shm -shm", ({ withShm }) => {
    const root = tempRoot();
    const t3Home = writeCrashedWalDatabase(root, withShm);
    const before = snapshot(t3Home);
    const z6Home = NodePath.join(root, ".z6");

    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");

    expect(snapshot(t3Home)).toEqual(before);
    const copy = new NodeSqlite.DatabaseSync(NodePath.join(z6Home, "userdata", "statev2.sqlite"), {
      readOnly: true,
    });
    expect(
      copy
        .prepare("SELECT id FROM threads")
        .all()
        .map((row) => row.id),
    ).toEqual(["in-wal"]);
    copy.close();
    expect(NodeFS.readdirSync(NodePath.join(z6Home, "userdata")).toSorted()).toEqual([
      "statev2.sqlite",
    ]);
  });

  it("leaves T3's work folders in place for Z6 to use there, and records them", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    write(NodePath.join(t3Home, "scratch", "demo", "notes.txt"), "scratch work");
    write(NodePath.join(t3Home, "projects", "my-app", "index.ts"), "named project");
    const z6Home = NodePath.join(root, ".z6");

    const result = migrateHomeFromT3({ t3Home, z6Home });

    expect(result.status).toBe("migrated");
    for (const folder of ["worktrees", "scratch", "projects"]) {
      expect(NodeFS.existsSync(NodePath.join(z6Home, folder)), folder).toBe(false);
    }
    const marker = readT3MigrationMarker(z6Home);
    expect(marker?.leftInPlace?.toSorted()).toEqual(
      ["projects", "scratch", "worktrees"].map((name) => NodePath.join(t3Home, name)),
    );
    expect(marker?.skipped.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["worktrees", "scratch", "projects"]),
    );
  });

  it("copies a SQLite file that is not one of T3's databases raw", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    // A SQLite header on a file that is not a database: VACUUM INTO would fail on it.
    const fake = Buffer.alloc(4096, 0x41);
    fake.write("SQLite format 3\0", 0, "latin1");
    write(NodePath.join(t3Home, "workflows", "app.db"), "");
    NodeFS.writeFileSync(NodePath.join(t3Home, "workflows", "app.db"), fake);
    const z6Home = NodePath.join(root, ".z6");

    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
    expect(NodeFS.readFileSync(NodePath.join(z6Home, "workflows", "app.db"))).toEqual(fake);
  });

  it("copies read-only folders, keeping their permissions", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const readOnly = NodePath.join(t3Home, "workflows", "vendored");
    write(NodePath.join(readOnly, "lib.js"), "x");
    NodeFS.chmodSync(readOnly, 0o555);
    const z6Home = NodePath.join(root, ".z6");
    try {
      expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
      const copied = NodePath.join(z6Home, "workflows", "vendored");
      expect(NodeFS.readFileSync(NodePath.join(copied, "lib.js"), "utf8")).toBe("x");
      expect(NodeFS.statSync(copied).mode & 0o777).toBe(0o555);
      NodeFS.chmodSync(copied, 0o755);
    } finally {
      NodeFS.chmodSync(readOnly, 0o755);
    }
  });

  it("leaves out an unreadable file outside userdata and records it", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const unreadable = NodePath.join(t3Home, "workflows", "locked.js");
    write(unreadable, "secret");
    NodeFS.chmodSync(unreadable, 0o000);
    const z6Home = NodePath.join(root, ".z6");
    try {
      expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
      expect(NodeFS.existsSync(NodePath.join(z6Home, "workflows", "mine.js"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(z6Home, "workflows", "locked.js"))).toBe(false);
      expect(readT3MigrationMarker(z6Home)?.skipped).toEqual(
        expect.arrayContaining([
          {
            path: "workflows/locked.js",
            reason: expect.stringMatching(/could not be read.*EACCES/),
          },
        ]),
      );
    } finally {
      NodeFS.chmodSync(unreadable, 0o644);
    }
  });

  it("fails loudly, naming the file, when something in userdata cannot be read", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const unreadable = NodePath.join(t3Home, "userdata", "secrets", "provider-token.bin");
    write(unreadable, "token");
    NodeFS.chmodSync(unreadable, 0o000);
    const z6Home = NodePath.join(root, ".z6");
    try {
      let failure: unknown;
      try {
        migrateHomeFromT3({ t3Home, z6Home });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(T3MigrationError);
      const message = (failure as Error).message;
      expect(message).toContain(unreadable);
      expect(message).toContain("chmod u+r");
      expect(message).not.toContain("not a database");
      expect(NodeFS.existsSync(z6Home)).toBe(false);
      expect(NodeFS.readdirSync(root)).toEqual([".t3"]);
    } finally {
      NodeFS.chmodSync(unreadable, 0o600);
    }
    // Fixed, the next start copies.
    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
  });

  it("names a database it cannot read, rather than failing on SQLite's words", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const broken = NodePath.join(t3Home, "userdata", "state.sqlite");
    const garbage = Buffer.alloc(4096, 0x42);
    garbage.write("SQLite format 3\0", 0, "latin1");
    NodeFS.writeFileSync(broken, garbage);
    const z6Home = NodePath.join(root, ".z6");

    expect(() => migrateHomeFromT3({ t3Home, z6Home })).toThrow(
      new RegExp(
        `could not read T3 Code's database ${broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    expect(NodeFS.existsSync(z6Home)).toBe(false);
  });

  it("discards the copy when T3 Code starts while it runs", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const before = snapshot(t3Home);
    const z6Home = NodePath.join(root, ".z6");
    const checks: Array<string | undefined> = [undefined, "a T3 Code server is running"];

    expect(() => migrateHomeFromT3({ t3Home, z6Home, inUse: () => checks.shift() })).toThrow(
      /started while Z6 Code was copying, so the copy was discarded/,
    );
    expect(checks).toEqual([]);
    expect(NodeFS.readdirSync(root)).toEqual([".t3"]);
    expect(snapshot(t3Home)).toEqual(before);
  });

  it("records copied symlinks that still point into T3's home", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    NodeFS.symlinkSync(
      NodePath.join(t3Home, "userdata", "settings.json"),
      NodePath.join(t3Home, "workflows", "settings-abs.json"),
    );
    const z6Home = NodePath.join(root, ".z6");

    expect(migrateHomeFromT3({ t3Home, z6Home }).status).toBe("migrated");
    expect(readT3MigrationMarker(z6Home)?.linksIntoSource).toEqual([
      {
        path: "workflows/settings-abs.json",
        target: NodePath.join(t3Home, "userdata", "settings.json"),
      },
    ]);
  });

  it("says how to remove T3's background service when it keeps a server running", () => {
    const root = tempRoot();
    const t3Home = makeT3Home(root);
    const plist = NodePath.join(
      root,
      "Library",
      "LaunchAgents",
      "com.t3tools.t3code.service.plist",
    );
    write(plist, "<plist/>");
    const owner = new NodeSqlite.DatabaseSync(
      NodePath.join(t3Home, "userdata", "server-owner.sqlite"),
    );
    owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    try {
      expect(() =>
        migrateHomeFromT3({ t3Home, z6Home: NodePath.join(root, ".z6"), homeDirectory: root }),
      ).toThrow(describeT3Service({ kind: "launchd", path: plist }));
    } finally {
      owner.close();
    }
    const message = describeT3Service({ kind: "launchd", path: plist });
    expect(message).toContain("`z6 service uninstall --t3`");
    expect(message).toContain(
      `launchctl bootout gui/$(id -u)/com.t3tools.t3code.service; rm '${plist}'`,
    );
  });
});

describe("migrateDesktopUserDataFromT3", () => {
  it("copies the profile without Chromium's caches or locks", () => {
    const root = tempRoot();
    const t3UserData = NodePath.join(root, "t3code-v2");
    write(NodePath.join(t3UserData, "Local Storage", "leveldb", "000003.log"), "storage");
    write(NodePath.join(t3UserData, "Partitions", "preview", "Cache", "data_0"), "cache");
    write(NodePath.join(t3UserData, "Code Cache", "js", "index"), "cache");
    write(NodePath.join(t3UserData, "Preferences"), "{}");
    NodeFS.symlinkSync(
      `${NodeOS.hostname()}-999999999`,
      NodePath.join(t3UserData, "SingletonLock"),
    );
    const z6UserData = NodePath.join(root, "z6code");

    expect(migrateDesktopUserDataFromT3({ t3UserData, z6UserData }).status).toBe("migrated");

    expect(
      NodeFS.readFileSync(
        NodePath.join(z6UserData, "Local Storage", "leveldb", "000003.log"),
        "utf8",
      ),
    ).toBe("storage");
    expect(NodeFS.existsSync(NodePath.join(z6UserData, "Preferences"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(z6UserData, "Partitions", "preview"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(z6UserData, "Partitions", "preview", "Cache"))).toBe(
      false,
    );
    expect(NodeFS.existsSync(NodePath.join(z6UserData, "Code Cache"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(z6UserData, "SingletonLock"))).toBe(false);
  });

  it("refuses while T3 Code is open on the profile", () => {
    const root = tempRoot();
    const t3UserData = NodePath.join(root, "t3code-v2");
    write(NodePath.join(t3UserData, "Preferences"), "{}");
    NodeFS.symlinkSync(
      `${NodeOS.hostname()}-${process.pid}`,
      NodePath.join(t3UserData, "SingletonLock"),
    );
    const z6UserData = NodePath.join(root, "z6code");

    expect(() => migrateDesktopUserDataFromT3({ t3UserData, z6UserData })).toThrow(
      /T3 Code \(pid \d+\) is open/,
    );
    expect(NodeFS.existsSync(z6UserData)).toBe(false);
  });
});
