// @effect-diagnostics nodeBuiltinImport:off - Runs synchronously at startup, before anything opens the data it copies.
/**
 * Z6 Code, this fork's build, keeps its own data beside upstream T3 Code's, so both can be
 * installed and run at once. The first time a Z6 location is missing, it is copied from T3's
 * once; after that neither app reads the other's folders. Nothing here writes under T3's
 * folders, not even SQLite's `-shm` files: databases are copied raw into the staging folder and
 * snapshot from there. Removing T3's folders is a separate, confirmed step (`t3DataCleanup.ts`).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";

export const T3_HOME_DIRNAME = ".t3";
export const Z6_HOME_DIRNAME = ".z6";
/** Electron userData folder names, under the platform's application data folder. */
export const T3_DESKTOP_USER_DATA_DIRNAME = "t3code-v2";
export const Z6_DESKTOP_USER_DATA_DIRNAME = "z6code";
export const T3_MIGRATION_MARKER_FILE = "migrated-from-t3.json";
/**
 * T3 Code's background service names. The fork's builds before Z6 Code had its own data used
 * them too, so a service under these names may be either; only the user's own command removes it.
 */
export const T3_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const T3_SERVICE_SYSTEMD_UNIT = "t3code.service";
/**
 * Folders T3 Code made for the user's work. They stay where they are and Z6's copied database
 * keeps using them there, so they are never copied.
 */
export const T3_WORK_FOLDERS = ["worktrees", "scratch", "projects"] as const;

export type T3DataKind = "home" | "desktop-user-data";

export interface T3CleanupRecord {
  readonly at: string;
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /**
   * Git checkouts that went to the Trash. Their repositories still list them; `git worktree
   * prune` in each repository forgets them once the Trash is emptied.
   */
  readonly trashedCheckouts?: ReadonlyArray<string>;
}

/** Written into the Z6 location a copy created, and read by cleanup to find what it came from. */
export interface T3MigrationMarker {
  readonly version: 1;
  readonly kind: T3DataKind;
  readonly source: string;
  readonly copiedAt: string;
  /** Paths under the source, relative to it, that were left out and why. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Absolute paths of T3's work folders that were left in place for Z6 to use there. */
  readonly leftInPlace?: ReadonlyArray<string>;
  /** Copied symlinks, relative to the source, whose absolute target is inside the source. */
  readonly linksIntoSource?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
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
 * blocks even a read-only reader. The file is in rollback-journal mode, so a read-only probe
 * creates and changes nothing. Servers from before that lock only publish `server-runtime.json`.
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

export interface T3ServiceInstall {
  readonly kind: "launchd" | "systemd";
  readonly path: string;
}

/**
 * T3 Code's background service, if installed for this user. It runs a server on `~/.t3` and
 * restarts it whenever it stops, so T3's data stays in use until the service is removed.
 */
export function t3ServiceInstalled(homeDirectory: string): T3ServiceInstall | undefined {
  const launchd = NodePath.join(
    homeDirectory,
    "Library",
    "LaunchAgents",
    `${T3_SERVICE_LAUNCHD_LABEL}.plist`,
  );
  if (exists(launchd)) return { kind: "launchd", path: launchd };
  const systemd = NodePath.join(
    homeDirectory,
    ".config",
    "systemd",
    "user",
    T3_SERVICE_SYSTEMD_UNIT,
  );
  if (exists(systemd)) return { kind: "systemd", path: systemd };
  return undefined;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** What to tell the user about an installed T3 service, including exactly how to remove it. */
export function describeT3Service(service: T3ServiceInstall): string {
  const manual =
    service.kind === "launchd"
      ? `launchctl bootout gui/$(id -u)/${T3_SERVICE_LAUNCHD_LABEL}; rm ${shellQuote(service.path)}`
      : `systemctl --user disable --now ${T3_SERVICE_SYSTEMD_UNIT}; rm ${shellQuote(service.path)}; systemctl --user daemon-reload`;
  return [
    `T3 Code's background service is installed (${service.path}) and keeps a T3 Code server running on ~/.t3; Z6 Code builds before it had its own data installed it under the same name.`,
    `To remove it, run \`z6 service uninstall --t3\` (\`t3 service uninstall --t3\` with this fork's server CLI), or in a terminal: ${manual}`,
    "If T3 Code itself installed it, T3 Code's `t3 service install` sets it up again.",
  ].join(" ");
}

type SkipRule = (segments: ReadonlyArray<string>) => string | undefined;

const RUNTIME_FILES = "belongs to the running T3 server";
const WORK_FOLDER_REASON =
  "a folder T3 Code made for your work; it stays where it is and Z6's projects and threads keep using it there";

/** What a T3 home holds that is not the user's, or must not be shared by two servers. */
const homeSkipRule: SkipRule = (segments) => {
  const [top, second, third] = segments;
  if (segments.length === 1) {
    if ((T3_WORK_FOLDERS as ReadonlyArray<string>).includes(top ?? "")) return WORK_FOLDER_REASON;
    switch (top) {
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
      case "cli-command-path-entry":
        return "T3 Code's own command-line launcher";
      case "wsl-server-tree":
        return "downloads and caches, fetched again when needed";
      default:
        return second?.startsWith(".environment-id-") ? RUNTIME_FILES : undefined;
    }
  }
  // Terminal history (`logs/terminals`) is the user's; the rest of `logs` is T3's own.
  if (segments.length === 3 && second === "logs" && third !== "terminals") return "T3 Code's logs";
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
/** Inside the staging folder, removed before it is renamed into place. */
const SNAPSHOT_DIRNAME = ".t3-sqlite-snapshot";

function hasSqliteHeader(path: string): boolean {
  const fd = NodeFS.openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = NodeFS.readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_HEADER;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Copy one of T3's databases as a clean single file. The database and its journal files are
 * copied raw into the staging folder first and snapshot from there with `VACUUM INTO`, because
 * opening T3's own file, even read-only, writes into its `-shm` (or creates one).
 */
function snapshotSqlite(source: string, destination: string, scratch: string) {
  NodeFS.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const staged = NodePath.join(scratch, "copy.sqlite");
  try {
    NodeFS.copyFileSync(source, staged);
    for (const suffix of SQLITE_SIDECARS) {
      if (exists(`${source}${suffix}`))
        NodeFS.copyFileSync(`${source}${suffix}`, `${staged}${suffix}`);
    }
    // Read-write on the staged copy, so SQLite can replay its WAL or roll back a hot journal.
    const db = new NodeSqlite.DatabaseSync(staged);
    try {
      db.prepare("VACUUM INTO ?").run(destination);
    } finally {
      db.close();
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

interface CopyOptions {
  readonly skip: SkipRule;
  /** T3's own databases, which are snapshot; every other file, SQLite or not, is copied raw. */
  readonly snapshotsSqlite: (segments: ReadonlyArray<string>) => boolean;
  /**
   * Whether failing to copy this entry fails the whole copy. Otherwise it is left out and
   * recorded in the marker.
   */
  readonly required: (segments: ReadonlyArray<string>, isDirectory: boolean) => boolean;
}

interface CopyState {
  readonly source: string;
  readonly realSource: string;
  readonly destination: string;
  readonly options: CopyOptions;
  readonly skipped: Array<{ path: string; reason: string }>;
  readonly linksIntoSource: Array<{ path: string; target: string }>;
  /**
   * Directory modes, deepest first, applied just before the rename so a failed copy can always
   * be removed.
   */
  readonly directoryModes: Array<{ path: string; mode: number }>;
}

/** A problem with this machine rather than one file, so skipping the file would hide it. */
const FATAL_CODES = new Set(["ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE"]);

const describeError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === undefined || message.includes(code) ? message : `${code}: ${message}`;
};

class CopyFailure extends Error {
  constructor(message: string, options: { readonly cause: unknown }) {
    super(message, options);
    this.name = "CopyFailure";
  }
}

function copyEntry(state: CopyState, segments: ReadonlyArray<string>, snapshot: boolean) {
  const from = NodePath.join(state.source, ...segments);
  const to = NodePath.join(state.destination, ...segments);
  const stat = NodeFS.lstatSync(from);
  if (stat.isDirectory()) {
    NodeFS.mkdirSync(to, { mode: 0o700 });
    state.directoryModes.unshift({ path: to, mode: stat.mode & 0o7777 });
    copyTree(state, segments);
  } else if (stat.isSymbolicLink()) {
    const target = NodeFS.readlinkSync(from);
    NodeFS.symlinkSync(target, to);
    if (
      NodePath.isAbsolute(target) &&
      [state.source, state.realSource].some((root) => isInside(NodePath.resolve(target), root))
    ) {
      state.linksIntoSource.push({ path: segments.join("/"), target });
    }
  } else if (stat.isFile()) {
    if (snapshot) {
      snapshotSqlite(from, to, NodePath.join(state.destination, SNAPSHOT_DIRNAME));
      NodeFS.chmodSync(to, stat.mode & 0o7777);
    } else {
      NodeFS.copyFileSync(from, to);
    }
  } else {
    state.skipped.push({ path: segments.join("/"), reason: "a socket or device file" });
  }
}

/** Whether a file is a SQLite database; one that cannot be read is copied, and fails, raw. */
function isSqliteFile(path: string): boolean {
  try {
    return NodeFS.lstatSync(path).isFile() && hasSqliteHeader(path);
  } catch {
    return false;
  }
}

function copyTree(state: CopyState, segments: ReadonlyArray<string> = []) {
  const names = NodeFS.readdirSync(NodePath.join(state.source, ...segments));
  const nameSet = new Set(names);
  const skippedHere = new Set<string>();
  const snapshotted = new Set<string>();
  for (const name of names) {
    const entrySegments = [...segments, name];
    const reason = state.options.skip(entrySegments) ?? anyDepthSkipRule(name);
    if (reason !== undefined) {
      skippedHere.add(name);
      state.skipped.push({ path: entrySegments.join("/"), reason });
    } else if (
      state.options.snapshotsSqlite(entrySegments) &&
      isSqliteFile(NodePath.join(state.source, ...entrySegments))
    ) {
      snapshotted.add(name);
    }
  }
  for (const name of names) {
    if (skippedHere.has(name)) continue;
    const entrySegments = [...segments, name];
    // A snapshot already holds its journal's changes; a skipped database's journal stays out too.
    const sidecarOf = SQLITE_SIDECARS.map((suffix) =>
      name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined,
    ).find((base) => base !== undefined && nameSet.has(base));
    if (sidecarOf !== undefined && (skippedHere.has(sidecarOf) || snapshotted.has(sidecarOf))) {
      continue;
    }
    const from = NodePath.join(state.source, ...entrySegments);
    try {
      copyEntry(state, entrySegments, snapshotted.has(name));
    } catch (error) {
      if (error instanceof CopyFailure) throw error;
      let isDirectory = false;
      try {
        isDirectory = NodeFS.lstatSync(from).isDirectory();
      } catch {
        // Could not even look at it; treat it as a file.
      }
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (
        (code !== undefined && FATAL_CODES.has(code)) ||
        state.options.required(entrySegments, isDirectory)
      ) {
        const isDatabase = snapshotted.has(name);
        throw new CopyFailure(
          isDatabase
            ? `Z6 Code could not read T3 Code's database ${from} (${describeError(error)}). Z6 Code copies nothing until it can: check it with \`sqlite3 ${shellQuote(from)} 'PRAGMA integrity_check'\` and make it readable, then start Z6 Code again.`
            : `Z6 Code could not copy ${from} (${describeError(error)}). Make it readable (for example \`chmod u+r ${shellQuote(from)}\`) or move it out of ${state.source}, then start Z6 Code again.`,
          { cause: error },
        );
      }
      removeTree(NodePath.join(state.destination, ...entrySegments));
      state.skipped.push({
        path: entrySegments.join("/"),
        reason: `it could not be read (${describeError(error)})`,
      });
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

/** `child` is `parent` or inside it, comparing the strings as given. */
export const isInside = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** Remove a staging folder, even one holding folders copied without write permission. */
function removeTree(path: string) {
  try {
    NodeFS.rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    // Fall through: make every folder writable, then try again.
  }
  const makeWritable = (target: string) => {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(target);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;
    try {
      NodeFS.chmodSync(target, 0o700);
      for (const name of NodeFS.readdirSync(target)) makeWritable(NodePath.join(target, name));
    } catch {
      // The retry below reports what still cannot be removed.
    }
  };
  makeWritable(path);
  NodeFS.rmSync(path, { recursive: true, force: true });
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
      removeTree(NodePath.join(parent, name));
    }
  }
}

function migrate(input: {
  readonly kind: T3DataKind;
  readonly source: string;
  readonly destination: string;
  /** Why T3 Code holds the source right now, if it does. Checked before and after the copy. */
  readonly inUse: () => string | undefined;
  readonly options: CopyOptions;
  readonly leftInPlace: ReadonlyArray<string>;
  readonly now: string;
}): T3MigrationResult {
  if (exists(input.destination)) return { status: "skipped", reason: "destination-exists" };
  if (!exists(input.source)) return { status: "skipped", reason: "no-source" };
  const refuse = (inUse: string, changed: string) =>
    new T3MigrationError(
      "in-use",
      `Z6 Code copies T3 Code's data from ${input.source} the first time it starts, but ${inUse}. Quit T3 Code and stop its server, then start Z6 Code again. ${changed}`,
    );
  const before = input.inUse();
  if (before !== undefined) throw refuse(before, "Nothing was changed.");
  removeAbandonedStaging(input.destination);
  const staging = `${input.destination}${STAGING_INFIX}${process.pid}`;
  const state: CopyState = {
    source: input.source,
    realSource: NodeFS.realpathSync(input.source),
    destination: staging,
    options: input.options,
    skipped: [],
    linksIntoSource: [],
    directoryModes: [],
  };
  try {
    removeTree(staging);
    NodeFS.mkdirSync(staging, { recursive: true, mode: 0o700 });
    copyTree(state);
    const marker: T3MigrationMarker = {
      version: 1,
      kind: input.kind,
      source: input.source,
      copiedAt: input.now,
      skipped: state.skipped,
      leftInPlace: input.leftInPlace,
      linksIntoSource: state.linksIntoSource,
    };
    writeT3MigrationMarker(staging, marker);
    // T3 Code may have started while this copied; its changes since would be lost, or its
    // interrupted turns continued in both apps.
    const after = input.inUse();
    if (after !== undefined) {
      removeTree(staging);
      throw refuse(after, "It started while Z6 Code was copying, so the copy was discarded.");
    }
    for (const { path, mode } of state.directoryModes) {
      // Folders under one that could not be read were removed again.
      if (exists(path)) NodeFS.chmodSync(path, mode);
    }
    try {
      NodeFS.renameSync(staging, input.destination);
    } catch (error) {
      // Another Z6 process finished its own copy first; use that one.
      if (exists(input.destination)) {
        removeTree(staging);
        return { status: "skipped", reason: "destination-exists" };
      }
      throw error;
    }
    return { status: "migrated", marker };
  } catch (cause) {
    if (cause instanceof T3MigrationError) throw cause;
    try {
      removeTree(staging);
    } catch {
      // Removed as abandoned on a later start.
    }
    const unchanged = `Nothing under ${input.source} was changed.`;
    throw new T3MigrationError(
      "copy-failed",
      cause instanceof CopyFailure
        ? `${cause.message} ${unchanged}`
        : `Z6 Code could not copy T3 Code's data from ${input.source} to ${input.destination}: ${describeError(cause)}. ${unchanged}`,
      { cause },
    );
  }
}

/**
 * Copy a T3 home (`~/.t3`) to a missing Z6 home (`~/.z6`). T3's databases are snapshot with
 * `VACUUM INTO`. Refuses while a T3 server owns the source: its turns would continue in both.
 */
export function migrateHomeFromT3(input: {
  readonly t3Home: string;
  readonly z6Home: string;
  /** Where T3's background service would be installed. Defaults to the T3 home's parent. */
  readonly homeDirectory?: string;
  /** Replaces the check for a running T3 server, which runs before and after the copy. */
  readonly inUse?: () => string | undefined;
  readonly now?: string;
}): T3MigrationResult {
  const homeDirectory = input.homeDirectory ?? NodePath.dirname(input.t3Home);
  return migrate({
    kind: "home",
    source: input.t3Home,
    destination: input.z6Home,
    inUse: () => {
      if (input.inUse !== undefined) return input.inUse();
      const reason = t3ServerInUse(input.t3Home);
      if (reason === undefined) return undefined;
      const service = t3ServiceInstalled(homeDirectory);
      return service === undefined ? reason : `${reason}. ${describeT3Service(service)}`;
    },
    options: {
      skip: homeSkipRule,
      snapshotsSqlite: (segments) => segments.length === 2 && segments[0] === "userdata",
      // Databases, secrets and settings: losing one silently is worse than not starting.
      required: (segments) => segments[0] === "userdata",
    },
    leftInPlace: T3_WORK_FOLDERS.map((name) => NodePath.join(input.t3Home, name)).filter(exists),
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
    inUse: () => t3DesktopInUse(input.t3UserData),
    options: {
      skip: userDataSkipRule,
      // Chromium's own databases are copied raw, which is safe while T3 Code is closed.
      snapshotsSqlite: () => false,
      // T3's own files at the top (saved connections, window state); Chromium's stores below
      // are skipped and recorded when unreadable.
      required: (segments, isDirectory) => segments.length === 1 && !isDirectory,
    },
    leftInPlace: [],
    now: input.now ?? nowIso(),
  });
}
