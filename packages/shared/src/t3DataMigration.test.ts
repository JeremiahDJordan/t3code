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
    for (const skipped of [
      "userdata/secrets/cloud-relay-url.bin",
      "userdata/secrets/secure-channel-x25519.bin",
      "userdata/environment-id",
      "userdata/server-runtime.json",
      "userdata/logs",
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
