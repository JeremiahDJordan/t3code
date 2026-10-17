// @effect-diagnostics nodeBuiltinImport:off - Shared by the desktop's main process and the CLI, neither of which has a server runtime here.
/**
 * Removes the T3 Code folders a Z6 copy came from (`t3DataMigration.ts`), when the user asks.
 * It moves them to the Trash rather than deleting them, refuses while T3 Code uses them or while
 * Z6's database cannot say what it still uses, and never moves a path Z6's database refers to,
 * any folder above one, or work in T3's work folders that git cannot vouch for.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  T3_WORK_FOLDERS,
  type T3CleanupRecord,
  type T3DataKind,
  type T3MigrationMarker,
  describeT3Service,
  nowIso,
  readT3MigrationMarker,
  t3DesktopInUse,
  t3ServerInUse,
  t3ServiceInstalled,
  writeT3MigrationMarker,
} from "./t3DataMigration.ts";

export interface T3DataLocation {
  readonly kind: T3DataKind;
  /** The T3 folder the copy came from. */
  readonly path: string;
  readonly copiedAt: string;
}

export interface T3DataState {
  /** T3 folders Z6 was copied from that are still there. */
  readonly locations: ReadonlyArray<T3DataLocation>;
  /** A copy was made and the desktop has not yet asked what to do with its source. */
  readonly promptPending: boolean;
  readonly lastCleanup: T3CleanupRecord | undefined;
}

export type T3DataRemoval =
  | { readonly status: "nothing" }
  | { readonly status: "refused"; readonly reason: string }
  | ({ readonly status: "removed" } & T3CleanupRecord);

export interface T3DataPaths {
  /** The Z6 home, holding the home copy's marker and Z6's database. */
  readonly z6Home: string;
  /** Z6's desktop userData folder, holding the desktop copy's marker, if this machine has one. */
  readonly z6UserData: string | undefined;
}

interface MarkedLocation {
  readonly markerDir: string;
  readonly marker: T3MigrationMarker;
}

const exists = (path: string) => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function markedLocations(paths: T3DataPaths): ReadonlyArray<MarkedLocation> {
  return [paths.z6Home, paths.z6UserData].flatMap((markerDir) => {
    if (markerDir === undefined) return [];
    const marker = readT3MigrationMarker(markerDir);
    return marker === undefined ? [] : [{ markerDir, marker }];
  });
}

export function readT3DataState(paths: T3DataPaths): T3DataState {
  const marked = markedLocations(paths);
  const remaining = marked.filter(({ marker }) => exists(marker.source));
  const lastCleanup = marked
    .flatMap(({ marker }) => (marker.cleanup === undefined ? [] : [marker.cleanup]))
    .sort((left, right) => right.at.localeCompare(left.at))[0];
  return {
    locations: remaining.map(({ marker }) => ({
      kind: marker.kind,
      path: marker.source,
      copiedAt: marker.copiedAt,
    })),
    promptPending:
      remaining.length > 0 && marked.every(({ marker }) => marker.promptAnsweredAt === undefined),
    lastCleanup,
  };
}

export function markT3CleanupPromptAnswered(paths: T3DataPaths, now = nowIso()) {
  for (const { markerDir, marker } of markedLocations(paths)) {
    writeT3MigrationMarker(markerDir, { ...marker, promptAnsweredAt: now });
  }
}

/** History tables: what happened, not what Z6 uses now. Their current state is in projections. */
const HISTORY_TABLES = new Set([
  "orchestration_events",
  "orchestration_v2_events",
  "orchestration_command_receipts",
  "orchestration_v2_command_receipts",
  "checkpoint_diff_blobs",
]);
/**
 * Conversation history, which can be large. Only rows naming T3's folder by name are read there;
 * every other table, including ones added later, is read whole, so a path reached through a
 * symlink with another name is still found.
 */
const CONVERSATION_TABLES = new Set([
  "messages",
  "agent_thread_messages",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_context_transfers",
  "mcp_app_model_context",
  "workflow_exec_results",
  "pull_request_review_guides",
  "thread_check_ins",
]);
/** Tables a V2 database always has; without them it is still T3's older format. */
const V2_TABLES = ["orchestration_v2_projection_threads", "projection_projects"];

const looksLikePath = (value: string) =>
  !value.includes("\n") &&
  (value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value));

/** Every string inside `value` that looks like an absolute path, parsing JSON text. */
function collectPaths(value: unknown, into: Array<string>) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectPaths(JSON.parse(trimmed), into);
        return;
      } catch {
        // Not JSON after all.
      }
    }
    if (looksLikePath(trimmed)) into.push(trimmed);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectPaths(item, into);
  }
}

const likeNeedle = (text: string) => `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

type Z6References =
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Every path Z6's database and settings store that may point into one of `t3Roots`: thread
 * worktrees (archived threads included), project folders, and any other stored path, found by
 * scanning every current table rather than a list of columns that would go stale. Rows marked
 * deleted are left out. Fails when the database is missing, unreadable or still T3's V1 format.
 */
function z6References(input: {
  readonly z6Home: string;
  readonly homeDirectory: string;
  readonly t3Roots: ReadonlyArray<string>;
}): Z6References {
  const userdata = NodePath.join(input.z6Home, "userdata");
  const dbPath = NodePath.join(userdata, "statev2.sqlite");
  const why = "so it cannot tell which of T3 Code's folders Z6 Code still uses";
  if (!exists(dbPath)) {
    return {
      ok: false,
      reason: exists(NodePath.join(userdata, "state.sqlite"))
        ? `Z6 Code's database at ${userdata} is still in T3 Code's older format (state.sqlite), ${why}. Start Z6 Code once so it upgrades the database, then try again.`
        : `Z6 Code's database ${dbPath} is missing, ${why}. Start Z6 Code once, then try again.`,
    };
  }
  const needles = [
    ...new Set(
      input.t3Roots.flatMap((root) => [NodePath.basename(root), NodePath.basename(realish(root))]),
    ),
  ].map(likeNeedle);
  const found: Array<string> = [];
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    const missing = V2_TABLES.filter((table) => !tables.includes(table));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Z6 Code's database ${dbPath} is not yet at the current format (it has no ${missing.join(" or ")}), ${why}. Start Z6 Code once so it upgrades the database, then try again.`,
      };
    }
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const table of tables) {
      if (HISTORY_TABLES.has(table)) continue;
      const columns = db
        .prepare("SELECT name, type FROM pragma_table_info(?)")
        .all(table)
        .map((row) => ({ name: String(row.name), type: String(row.type).toUpperCase() }));
      const textColumns = columns
        .filter(
          ({ type }) =>
            type === "" || type.includes("TEXT") || type.includes("CHAR") || type.includes("JSON"),
        )
        .map(({ name }) => name);
      if (textColumns.length === 0) continue;
      // Conversation text can be large, so only rows that name T3's folder are read there.
      const searched = CONVERSATION_TABLES.has(table);
      const conditions = [
        ...(columns.some(({ name }) => name === "deleted_at") ? ["deleted_at IS NULL"] : []),
        ...(searched
          ? [
              `(${textColumns
                .flatMap((column) =>
                  needles.map(() => `CAST(${quote(column)} AS TEXT) LIKE ? ESCAPE '\\'`),
                )
                .join(" OR ")})`,
            ]
          : []),
      ];
      const rows = db
        .prepare(
          `SELECT ${textColumns.map(quote).join(", ")} FROM ${quote(table)}${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
        )
        .all(...(searched ? textColumns.flatMap(() => needles) : []));
      for (const row of rows) collectPaths(Object.values(row), found);
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Z6 Code's database ${dbPath} could not be read (${error instanceof Error ? error.message : String(error)}), ${why}. Try again once Z6 Code is running normally.`,
    };
  } finally {
    db?.close();
  }
  // Settings name folders too, such as a worktrees folder set to one of T3's.
  let settingsFiles: Array<string> = [];
  try {
    settingsFiles = NodeFS.readdirSync(userdata).filter((name) => name.endsWith(".json"));
  } catch {
    // No settings beside the database.
  }
  for (const name of settingsFiles) {
    try {
      collectPaths(NodeFS.readFileSync(NodePath.join(userdata, name), "utf8"), found);
    } catch {
      // An unreadable settings file names nothing this can see.
    }
  }
  return {
    ok: true,
    paths: found.map((path) =>
      path.startsWith("~/") ? NodePath.join(input.homeDirectory, path.slice(2)) : path,
    ),
  };
}

/** `path` with every symlink in its longest existing part resolved; the rest kept as written. */
function realish(path: string): string {
  const resolved = NodePath.resolve(path);
  const rest: Array<string> = [];
  let current = resolved;
  for (;;) {
    try {
      return NodePath.join(NodeFS.realpathSync.native(current), ...rest);
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return resolved;
      rest.unshift(NodePath.basename(current));
      current = parent;
    }
  }
}

const swapCase = (text: string) =>
  [...text]
    .map((character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
    )
    .join("");

/** Whether the filesystem holding `path` ignores case, by looking it up in the other case. */
function caseInsensitiveAt(path: string): boolean {
  for (let current = path; ; current = NodePath.dirname(current)) {
    const name = NodePath.basename(current);
    const swapped = swapCase(name);
    if (swapped !== name) {
      try {
        const actual = NodeFS.statSync(current);
        const other = NodeFS.statSync(NodePath.join(NodePath.dirname(current), swapped));
        return actual.ino === other.ino && actual.dev === other.dev;
      } catch {
        return false;
      }
    }
    // No letters to test: folding only ever protects more.
    if (NodePath.dirname(current) === current) return true;
  }
}

/**
 * Compares paths the way the filesystem holding `root` does: through symlinks (`/tmp` and
 * `/private/tmp` are one place) and, where it ignores case, without case.
 */
function pathMatcher(root: string, referenced: ReadonlyArray<string>) {
  const realRoot = NodeFS.realpathSync.native(root);
  const insensitive = caseInsensitiveAt(realRoot);
  const fold = (path: string) => {
    const normalized = path.normalize("NFC");
    return insensitive ? normalized.toLowerCase() : normalized;
  };
  const foldedRoot = fold(realRoot);
  const roots = [root, realRoot].map((candidate) => fold(NodePath.resolve(candidate)));
  const inside = (child: string, parent: string) =>
    child === parent ||
    child.startsWith(parent.endsWith(NodePath.sep) ? parent : parent + NodePath.sep);
  const protectedPaths = new Set<string>();
  for (const path of referenced) {
    const lexical = fold(NodePath.resolve(path));
    // As written, rebased onto the real root, so a path through a symlink inside T3's folder
    // protects that symlink; and fully resolved, for paths that reach it through another name.
    for (const candidate of roots) {
      if (inside(lexical, candidate))
        protectedPaths.add(foldedRoot + lexical.slice(candidate.length));
    }
    const real = fold(realish(path));
    if (inside(real, foldedRoot)) protectedPaths.add(real);
  }
  const all = [...protectedPaths];
  return {
    realRoot,
    /** `path` must be under `realRoot`, spelled as found while walking it. */
    isProtected: (path: string) => protectedPaths.has(fold(path)),
    holdsProtected: (path: string) => {
      const folded = fold(path);
      return all.some((protectedPath) => protectedPath !== folded && inside(protectedPath, folded));
    },
  };
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const isCheckout = (path: string) => exists(NodePath.join(path, ".git"));

/** Whether any git checkout lies under `root`, not looking inside one. */
function holdsCheckout(root: string, depth = 4): boolean {
  if (depth === 0) return false;
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      (isCheckout(NodePath.join(root, entry.name)) ||
        holdsCheckout(NodePath.join(root, entry.name), depth - 1)),
  );
}

/** Whether `root` holds nothing but empty folders. */
function holdsNoFiles(root: string, depth = 8): boolean {
  if (depth === 0) return false;
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.every(
    (entry) => entry.isDirectory() && holdsNoFiles(NodePath.join(root, entry.name), depth - 1),
  );
}

type Decision =
  | { readonly path: string; readonly action: "trash"; readonly checkouts: ReadonlyArray<string> }
  | { readonly path: string; readonly action: "keep"; readonly reason: string };

async function decideCheckout(path: string): Promise<Decision> {
  let status: string;
  try {
    status = await git(path, ["status", "--porcelain"]);
  } catch {
    return { path, action: "keep", reason: "git could not check it for uncommitted changes" };
  }
  return status.trim().length > 0
    ? { path, action: "keep", reason: "it has uncommitted changes" }
    : { path, action: "trash", checkouts: [path] };
}

/**
 * What to do with everything in a T3 home. A protected path, and every folder above one, stays;
 * a git checkout is never split. In T3's work folders only clean git checkouts and empty folders
 * go; anything else there may be the user's work. Everything else in the home is T3's own.
 */
async function planHome(
  matcher: ReturnType<typeof pathMatcher>,
): Promise<{ readonly decisions: ReadonlyArray<Decision>; readonly allGone: boolean }> {
  const sweep = async (
    dir: string,
    inWork: boolean,
  ): Promise<{ decisions: Array<Decision>; allGone: boolean }> => {
    let names: string[];
    try {
      names = NodeFS.readdirSync(dir);
    } catch {
      return {
        decisions: [{ path: dir, action: "keep", reason: "it could not be read to check it" }],
        allGone: false,
      };
    }
    const decisions: Array<Decision> = [];
    let allGone = true;
    const keep = (path: string, reason: string) => {
      decisions.push({ path, action: "keep", reason });
      allGone = false;
    };
    for (const name of names) {
      const path = NodePath.join(dir, name);
      const work =
        inWork ||
        (dir === matcher.realRoot && (T3_WORK_FOLDERS as ReadonlyArray<string>).includes(name));
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(path);
      } catch {
        continue;
      }
      if (matcher.isProtected(path)) {
        keep(path, "Z6 Code's database refers to it");
        continue;
      }
      if (matcher.holdsProtected(path)) {
        if (stat.isDirectory() && !isCheckout(path)) {
          const inner = await sweep(path, work);
          decisions.push(...inner.decisions);
          allGone = false;
        } else {
          keep(path, "Z6 Code's database refers to a path inside it");
        }
        continue;
      }
      if (!work) {
        decisions.push({ path, action: "trash", checkouts: [] });
        continue;
      }
      if (!stat.isDirectory()) {
        keep(path, "it is not part of a git checkout, so it may be your work");
        continue;
      }
      if (isCheckout(path)) {
        const decision = await decideCheckout(path);
        if (decision.action === "keep") allGone = false;
        decisions.push(decision);
        continue;
      }
      if (!holdsCheckout(path)) {
        if (holdsNoFiles(path)) decisions.push({ path, action: "trash", checkouts: [] });
        else keep(path, "it holds files outside a git checkout, so they may be your work");
        continue;
      }
      const inner = await sweep(path, true);
      if (inner.allGone) {
        decisions.push({
          path,
          action: "trash",
          checkouts: inner.decisions.flatMap((decision) =>
            decision.action === "trash" ? decision.checkouts : [],
          ),
        });
      } else {
        decisions.push(...inner.decisions);
        allGone = false;
      }
    }
    return { decisions, allGone };
  };
  if (matcher.isProtected(matcher.realRoot)) {
    return {
      decisions: [
        { path: matcher.realRoot, action: "keep", reason: "Z6 Code's database refers to it" },
      ],
      allGone: false,
    };
  }
  return sweep(matcher.realRoot, false);
}

/** Move `path` to the user's Trash, for callers without Electron's `shell.trashItem`. */
export async function moveToTrash(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") {
    if (exists("/usr/bin/trash")) {
      await new Promise<void>((resolve, reject) =>
        NodeChildProcess.execFile("/usr/bin/trash", ["-s", path], (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      return;
    }
    renameIntoTrash(path, NodePath.join(NodeOS.homedir(), ".Trash"));
    return;
  }
  if (platform === "linux") {
    const dataHome =
      process.env.XDG_DATA_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".local", "share");
    const trash = NodePath.join(dataHome, "Trash");
    const name = renameIntoTrash(path, NodePath.join(trash, "files"));
    NodeFS.mkdirSync(NodePath.join(trash, "info"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(trash, "info", `${name}.trashinfo`),
      `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${nowIso().slice(0, 19)}\n`,
    );
    return;
  }
  throw new Error("this platform has no Trash this command can use");
}

function renameIntoTrash(path: string, trashFiles: string): string {
  NodeFS.mkdirSync(trashFiles, { recursive: true });
  const base = NodePath.basename(path);
  let name = base;
  for (let attempt = 2; exists(NodePath.join(trashFiles, name)); attempt += 1) {
    name = `${base} ${attempt}`;
  }
  NodeFS.renameSync(path, NodePath.join(trashFiles, name));
  return name;
}

/**
 * Move the T3 folders Z6 was copied from to the Trash, except what Z6's database refers to and
 * work in T3's work folders git cannot vouch for. Refuses, removing nothing, while T3 Code, its
 * server or its background service runs, or while Z6's database cannot be read.
 */
export async function removeT3Data(
  paths: T3DataPaths & {
    readonly homeDirectory: string;
    /** T3 Code's desktop userData folder, checked for a running T3 app even if it was not copied. */
    readonly t3UserData: string | undefined;
    /** `moveToTrash`, or Electron's `shell.trashItem`. */
    readonly trash: (path: string) => Promise<void>;
    readonly now?: string;
  },
): Promise<T3DataRemoval> {
  const trash = paths.trash;
  const marked = markedLocations(paths).filter(({ marker }) => exists(marker.source));
  if (marked.length === 0) return { status: "nothing" };

  const homes = marked.filter(({ marker }) => marker.kind === "home").map((m) => m.marker.source);
  const userDataFolders = new Set(
    marked.filter(({ marker }) => marker.kind === "desktop-user-data").map((m) => m.marker.source),
  );
  if (paths.t3UserData !== undefined) userDataFolders.add(paths.t3UserData);
  const service = homes.length > 0 ? t3ServiceInstalled(paths.homeDirectory) : undefined;
  const inUse =
    homes.map(t3ServerInUse).find((reason) => reason !== undefined) ??
    [...userDataFolders].map(t3DesktopInUse).find((reason) => reason !== undefined);
  if (service !== undefined) {
    return {
      status: "refused",
      reason: `Nothing was removed: ${inUse === undefined ? "" : `${inUse}. `}${describeT3Service(service)} Then try again.`,
    };
  }
  if (inUse !== undefined) {
    return {
      status: "refused",
      reason: `Nothing was removed: ${inUse}. Quit T3 Code and stop its server, then try again.`,
    };
  }
  let references: ReadonlyArray<string> = [];
  if (homes.length > 0) {
    const read = z6References({
      z6Home: paths.z6Home,
      homeDirectory: paths.homeDirectory,
      t3Roots: homes,
    });
    if (!read.ok) return { status: "refused", reason: `Nothing was removed: ${read.reason}` };
    references = read.paths;
  }

  const removed: Array<string> = [];
  const kept: Array<{ path: string; reason: string }> = [];
  const trashedCheckouts: Array<string> = [];
  const moveAway = async (path: string) => {
    try {
      await trash(path);
      if (exists(path)) throw new Error("it is still there afterwards");
      removed.push(path);
      return true;
    } catch (error) {
      kept.push({
        path,
        reason: `it could not be moved to the Trash (${error instanceof Error ? error.message : String(error)})`,
      });
      return false;
    }
  };

  for (const { marker } of marked) {
    if (marker.kind !== "home") {
      await moveAway(marker.source);
      continue;
    }
    const matcher = pathMatcher(marker.source, references);
    const plan = await planHome(matcher);
    // Report paths as the marker spells the home, not as its symlinks resolve.
    const shown = (path: string) => marker.source + path.slice(matcher.realRoot.length);
    const checkoutsIn = (decisions: ReadonlyArray<Decision>) =>
      decisions.flatMap((decision) => (decision.action === "trash" ? decision.checkouts : []));
    if (plan.allGone) {
      if (await moveAway(marker.source)) {
        trashedCheckouts.push(...checkoutsIn(plan.decisions).map(shown));
      }
      continue;
    }
    for (const decision of plan.decisions) {
      if (decision.action === "keep") {
        kept.push({ path: shown(decision.path), reason: decision.reason });
      } else if (await moveAway(shown(decision.path))) {
        trashedCheckouts.push(...decision.checkouts.map(shown));
      }
    }
  }

  // Git still lists trashed checkouts; pruning here would also forget unrelated worktrees, such
  // as ones on a drive that is not mounted, so the record names them instead.
  const record: T3CleanupRecord = { at: paths.now ?? nowIso(), removed, kept, trashedCheckouts };
  for (const { markerDir, marker } of markedLocations(paths)) {
    writeT3MigrationMarker(markerDir, { ...marker, cleanup: record });
  }
  return { status: "removed", ...record };
}
