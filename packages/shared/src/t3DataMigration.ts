// @effect-diagnostics nodeBuiltinImport:off - Runs synchronously at startup, before anything opens the data it copies.
/**
 * Z6 Code, this fork's build, keeps its own data beside upstream T3 Code's, so both can be
 * installed and run at once. The first time a Z6 location is missing, it is copied from T3's
 * once; after that neither app reads the other's folders. T3's folders are only read here:
 * removing them is a separate, confirmed step (`t3DataCleanup.ts`).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";

export const T3_HOME_DIRNAME = ".t3";
export const Z6_HOME_DIRNAME = ".z6";
/** Electron userData folder names, under the platform's application data folder. */
export const T3_DESKTOP_USER_DATA_DIRNAME = "t3code-v2";
export const Z6_DESKTOP_USER_DATA_DIRNAME = "z6code";
export const T3_MIGRATION_MARKER_FILE = "migrated-from-t3.json";

export type T3DataKind = "home" | "desktop-user-data";

export interface T3CleanupRecord {
  readonly at: string;
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** Written into the Z6 location a copy created, and read by cleanup to find what it came from. */
export interface T3MigrationMarker {
  readonly version: 1;
  readonly kind: T3DataKind;
  readonly source: string;
  readonly copiedAt: string;
  /** Paths under the source, relative to it, that were left out and why. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Set once the desktop asked whether to remove the source. */
  readonly promptAnsweredAt?: string;
  readonly cleanup?: T3CleanupRecord;
}

export type T3MigrationResult =
  | { readonly status: "migrated"; readonly marker: T3MigrationMarker }
  | { readonly status: "skipped"; readonly reason: "destination-exists" | "no-source" };

export class T3MigrationError extends Error {
  readonly reason: "in-use" | "copy-failed";

  constructor(
    reason: "in-use" | "copy-failed",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "T3MigrationError";
    this.reason = reason;
  }
}

export const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

export const defaultT3Home = (homeDirectory: string) =>
  NodePath.join(homeDirectory, T3_HOME_DIRNAME);
export const defaultZ6Home = (homeDirectory: string) =>
  NodePath.join(homeDirectory, Z6_HOME_DIRNAME);

/** Electron's `app.getPath("appData")`, for code that runs without Electron (the CLI). */
export function defaultAppDataDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  if (input.platform === "darwin") {
    return NodePath.join(input.homeDirectory, "Library", "Application Support");
  }
  if (input.platform === "win32") {
    return input.env.APPDATA?.trim() || NodePath.join(input.homeDirectory, "AppData", "Roaming");
  }
  return input.env.XDG_CONFIG_HOME?.trim() || NodePath.join(input.homeDirectory, ".config");
}

const exists = (path: string) => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isSqliteBusy = (error: unknown) =>
  error instanceof Error &&
  (("errcode" in error && (error.errcode === 5 || error.errcode === 6)) ||
    /database (table )?is locked/i.test(error.message));

/**
 * Whether a T3 server owns one of `t3Home`'s state folders. A server holds an exclusive SQLite
 * lock on `server-owner.sqlite` for its lifetime (`apps/server/src/serverOwnership.ts`), which
 * blocks even a read-only reader, so probing it changes nothing. Servers from before that lock
 * only publish `server-runtime.json`.
 */
export function t3ServerInUse(t3Home: string): string | undefined {
  for (const stateDir of ["userdata", "dev"].map((name) => NodePath.join(t3Home, name))) {
    const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
    if (exists(lockPath)) {
      let db: NodeSqlite.DatabaseSync | undefined;
      try {
        db = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
        db.exec("PRAGMA busy_timeout = 0");
        db.prepare("SELECT count(*) FROM sqlite_master").get();
      } catch (error) {
        if (isSqliteBusy(error)) return `a T3 Code server is running on ${stateDir}`;
      } finally {
        db?.close();
      }
    }
    try {
      const runtime = JSON.parse(
        NodeFS.readFileSync(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
      ) as { readonly pid?: unknown; readonly ownerId?: unknown };
      if (
        runtime.ownerId === undefined &&
        typeof runtime.pid === "number" &&
        isProcessAlive(runtime.pid)
      ) {
        return `a T3 Code server (pid ${runtime.pid}) is running on ${stateDir}`;
      }
    } catch {
      // No runtime file, or one this check cannot read: no live legacy server.
    }
  }
  return undefined;
}

/**
 * Whether T3 Code's desktop app is running on `userDataPath`. Chromium keeps `SingletonLock` there,
 * a symlink to `<host>-<pid>`, on macOS and Linux; Windows uses a named mutex this cannot see.
 */
export function t3DesktopInUse(userDataPath: string): string | undefined {
  let target: string;
  try {
    target = NodeFS.readlinkSync(NodePath.join(userDataPath, "SingletonLock"));
  } catch {
    return undefined;
  }
  const separator = target.lastIndexOf("-");
  const host = target.slice(0, separator);
  const pid = Number(target.slice(separator + 1));
  if (separator <= 0 || host !== NodeOS.hostname()) return undefined;
  return isProcessAlive(pid) ? `T3 Code (pid ${pid}) is open` : undefined;
}

type SkipRule = (segments: ReadonlyArray<string>) => string | undefined;

const RUNTIME_FILES = "belongs to the running T3 server";

/** What a T3 home holds that is not the user's, or must not be shared by two servers. */
const homeSkipRule: SkipRule = (segments) => {
  const [top, second, third] = segments;
  if (segments.length === 1) {
    switch (top) {
      case "worktrees":
        return "git worktrees stay where they are; Z6's threads keep using them there";
      case "runtime":
      case "tools":
      case "caches":
      case "source":
        return "downloads and caches, fetched again when needed";
      case "bin":
        return "T3 Code's own command-line launcher";
      case "dev":
        return "development state";
      default:
        return undefined;
    }
  }
  if (top !== "userdata") return undefined;
  if (segments.length === 2) {
    switch (second) {
      case "server-owner.sqlite":
      case "server-runtime.json":
      case "tmux":
      case "bob-tmux":
      case "background-commands":
      case "antigravity-tmp":
        return RUNTIME_FILES;
      case "environment-id":
      case "environment-id.recovery":
      case "anonymous-id":
        return "Z6 Code is a separate environment, with its own id";
      case "logs":
        return "T3 Code's logs";
      case "cli-command-path-entry":
        return "T3 Code's own command-line launcher";
      case "wsl-server-tree":
        return "downloads and caches, fetched again when needed";
      default:
        return second?.startsWith(".environment-id-") ? RUNTIME_FILES : undefined;
    }
  }
  if (segments.length === 3 && second === "device" && third === "agent-device") {
    return "downloads and caches, fetched again when needed";
  }
  // The server's own browser profiles hold Chromium's caches too.
  if (second === "server-browser") return userDataSkipRule(segments.slice(2));
  if (
    segments.length === 3 &&
    second === "secrets" &&
    third !== undefined &&
    (third.startsWith("cloud-") || third.startsWith("secure-channel-x25519"))
  ) {
    return "T3 Connect and tunnel identities belong to T3's server; link Z6 Code again";
  }
  return undefined;
};

/** Chromium's caches and locks, at any depth of a userData folder. */
const CHROMIUM_SKIPPED = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "CacheStorage",
  "ScriptCache",
  "Crashpad",
  "blob_storage",
]);
const userDataSkipRule: SkipRule = (segments) => {
  const name = segments.at(-1) ?? "";
  if (CHROMIUM_SKIPPED.has(name)) return "a cache";
  if (segments.length === 1 && (name === "RunningChromeVersion" || name === "lockfile")) {
    return RUNTIME_FILES;
  }
  return undefined;
};

/** At any depth: locks a running app holds, and files written to be renamed into place. */
const anyDepthSkipRule = (name: string) =>
  name.startsWith("Singleton") || name.endsWith(".tmp") ? "a lock or temporary file" : undefined;

const SQLITE_HEADER = "SQLite format 3\0";
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

function isSqliteFile(path: string, size: number): boolean {
  if (size < 512) return false;
  const fd = NodeFS.openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    NodeFS.readSync(fd, header, 0, header.length, 0);
    return header.toString("latin1") === SQLITE_HEADER;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Copy one SQLite database as a single consistent snapshot, even while another connection writes
 * to it. A checkpointed database opens `immutable`, so SQLite creates no `-wal`/`-shm` beside the
 * source; one with a live journal opens read-only, which reads the journal without changing data.
 */
function snapshotSqlite(source: string, destination: string) {
  const hasJournal = ["-wal", "-journal"].some((suffix) => exists(`${source}${suffix}`));
  const location = hasJournal ? source : `${NodeURL.pathToFileURL(source).href}?immutable=1`;
  const db = new NodeSqlite.DatabaseSync(location, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(destination);
  } finally {
    db.close();
  }
}

interface CopyOptions {
  readonly skip: SkipRule;
  /** For Chromium's own databases a raw copy is acceptable; T3's databases must snapshot. */
  readonly rawSqliteFallback: boolean;
}

function copyTree(
  source: string,
  destination: string,
  options: CopyOptions,
  skipped: Array<{ path: string; reason: string }>,
  segments: ReadonlyArray<string> = [],
) {
  const names = NodeFS.readdirSync(NodePath.join(source, ...segments));
  const nameSet = new Set(names);
  for (const name of names) {
    const entrySegments = [...segments, name];
    const relative = entrySegments.join("/");
    const reason = options.skip(entrySegments) ?? anyDepthSkipRule(name);
    if (reason !== undefined) {
      skipped.push({ path: relative, reason });
      continue;
    }
    const sidecarOf = SQLITE_SIDECARS.find(
      (suffix) => name.endsWith(suffix) && nameSet.has(name.slice(0, -suffix.length)),
    );
    if (sidecarOf !== undefined) continue;
    const from = NodePath.join(source, ...entrySegments);
    const to = NodePath.join(destination, ...entrySegments);
    const stat = NodeFS.lstatSync(from);
    if (stat.isDirectory()) {
      NodeFS.mkdirSync(to, { mode: stat.mode & 0o7777 });
      copyTree(source, destination, options, skipped, entrySegments);
    } else if (stat.isSymbolicLink()) {
      NodeFS.symlinkSync(NodeFS.readlinkSync(from), to);
    } else if (stat.isFile()) {
      const journaled = nameSet.has(`${name}-wal`) || nameSet.has(`${name}-journal`);
      if (journaled || isSqliteFile(from, stat.size)) {
        try {
          snapshotSqlite(from, to);
          NodeFS.chmodSync(to, stat.mode & 0o7777);
        } catch (error) {
          if (!options.rawSqliteFallback) throw error;
          NodeFS.rmSync(to, { force: true });
          for (const suffix of ["", "-wal", "-journal"]) {
            if (exists(`${from}${suffix}`))
              NodeFS.copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
          }
        }
      } else {
        NodeFS.copyFileSync(from, to);
      }
    } else {
      skipped.push({ path: relative, reason: "a socket or device file" });
    }
  }
}

export function readT3MigrationMarker(z6Location: string): T3MigrationMarker | undefined {
  try {
    const marker = JSON.parse(
      NodeFS.readFileSync(NodePath.join(z6Location, T3_MIGRATION_MARKER_FILE), "utf8"),
    ) as T3MigrationMarker;
    return marker.version === 1 && typeof marker.source === "string" ? marker : undefined;
  } catch {
    return undefined;
  }
}

export function writeT3MigrationMarker(z6Location: string, marker: T3MigrationMarker) {
  const path = NodePath.join(z6Location, T3_MIGRATION_MARKER_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, path);
}

const STAGING_INFIX = ".t3-copy-";

/** A copy interrupted by a crash leaves its staging folder; remove those whose process is gone. */
function removeAbandonedStaging(destination: string) {
  const parent = NodePath.dirname(destination);
  const prefix = `${NodePath.basename(destination)}${STAGING_INFIX}`;
  let names: string[];
  try {
    names = NodeFS.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    if (pid !== process.pid && !isProcessAlive(pid)) {
      NodeFS.rmSync(NodePath.join(parent, name), { recursive: true, force: true });
    }
  }
}

function migrate(input: {
  readonly kind: T3DataKind;
  readonly source: string;
  readonly destination: string;
  readonly inUse: string | undefined;
  readonly options: CopyOptions;
  readonly now: string;
}): T3MigrationResult {
  if (exists(input.destination)) return { status: "skipped", reason: "destination-exists" };
  if (!exists(input.source)) return { status: "skipped", reason: "no-source" };
  if (input.inUse !== undefined) {
    throw new T3MigrationError(
      "in-use",
      `Z6 Code copies T3 Code's data from ${input.source} the first time it starts, but ${input.inUse}. Quit T3 Code and stop its server, then start Z6 Code again. Nothing was changed.`,
    );
  }
  removeAbandonedStaging(input.destination);
  const staging = `${input.destination}${STAGING_INFIX}${process.pid}`;
  const skipped: Array<{ path: string; reason: string }> = [];
  try {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    NodeFS.mkdirSync(staging, { recursive: true, mode: 0o700 });
    copyTree(input.source, staging, input.options, skipped);
    const marker: T3MigrationMarker = {
      version: 1,
      kind: input.kind,
      source: input.source,
      copiedAt: input.now,
      skipped,
    };
    writeT3MigrationMarker(staging, marker);
    try {
      NodeFS.renameSync(staging, input.destination);
    } catch (error) {
      // Another Z6 process finished its own copy first; use that one.
      if (exists(input.destination)) {
        NodeFS.rmSync(staging, { recursive: true, force: true });
        return { status: "skipped", reason: "destination-exists" };
      }
      throw error;
    }
    return { status: "migrated", marker };
  } catch (cause) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw new T3MigrationError(
      "copy-failed",
      `Z6 Code could not copy T3 Code's data from ${input.source} to ${input.destination}: ${cause instanceof Error ? cause.message : String(cause)}. Nothing under ${input.source} was changed.`,
      { cause },
    );
  }
}

/**
 * Copy a T3 home (`~/.t3`) to a missing Z6 home (`~/.z6`). Databases are snapshot with
 * `VACUUM INTO`. Refuses while a T3 server owns the source: its turns would continue in both.
 */
export function migrateHomeFromT3(input: {
  readonly t3Home: string;
  readonly z6Home: string;
  readonly now?: string;
}): T3MigrationResult {
  return migrate({
    kind: "home",
    source: input.t3Home,
    destination: input.z6Home,
    inUse: exists(input.z6Home) ? undefined : t3ServerInUse(input.t3Home),
    options: { skip: homeSkipRule, rawSqliteFallback: false },
    now: input.now ?? nowIso(),
  });
}

/** Copy T3 Code's Electron userData folder to a missing Z6 one, leaving Chromium's caches out. */
export function migrateDesktopUserDataFromT3(input: {
  readonly t3UserData: string;
  readonly z6UserData: string;
  readonly now?: string;
}): T3MigrationResult {
  return migrate({
    kind: "desktop-user-data",
    source: input.t3UserData,
    destination: input.z6UserData,
    inUse: exists(input.z6UserData) ? undefined : t3DesktopInUse(input.t3UserData),
    options: { skip: userDataSkipRule, rawSqliteFallback: true },
    now: input.now ?? nowIso(),
  });
}
