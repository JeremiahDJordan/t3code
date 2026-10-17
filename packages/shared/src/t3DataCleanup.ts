// @effect-diagnostics nodeBuiltinImport:off - Shared by the desktop's main process and the CLI, neither of which has a server runtime here.
/**
 * Removes the T3 Code folders a Z6 copy came from (`t3DataMigration.ts`), when the user asks.
 * It moves them to the Trash rather than deleting them, refuses while T3 Code uses them, and
 * keeps every T3 worktree Z6's threads still use or that holds uncommitted work.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  type T3CleanupRecord,
  type T3DataKind,
  type T3MigrationMarker,
  nowIso,
  readT3MigrationMarker,
  t3DesktopInUse,
  t3ServerInUse,
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

/** T3's background service runs from its home, and would start a server there again. */
function t3ServiceInstalled(homeDirectory: string): string | undefined {
  const candidates = [
    NodePath.join(homeDirectory, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
    NodePath.join(homeDirectory, ".config", "systemd", "user", "t3code.service"),
  ];
  const found = candidates.find(exists);
  return found === undefined
    ? undefined
    : `T3 Code's background service is installed (${found}). Remove it with T3 Code's \`t3 uninstall\` first`;
}

/**
 * Paths Z6's database uses: thread worktrees and project folders, archived threads included,
 * since they can be restored. `undefined` when the database exists but cannot be read.
 */
function z6ReferencedPaths(z6Home: string): ReadonlyArray<string> | undefined {
  const dbPath = NodePath.join(z6Home, "userdata", "statev2.sqlite");
  if (!exists(dbPath)) return [];
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = [
      ...db
        .prepare(
          `SELECT json_extract(payload_json, '$.worktreePath') AS path
           FROM orchestration_v2_projection_threads
           WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL`,
        )
        .all(),
      ...db
        .prepare(`SELECT workspace_root AS path FROM projection_projects WHERE deleted_at IS NULL`)
        .all(),
    ];
    return rows.flatMap((row) =>
      typeof row.path === "string" ? [NodePath.resolve(row.path)] : [],
    );
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

const contains = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** Directories under `root` that are git checkouts (they hold a `.git`), not looking inside them. */
function findWorktrees(root: string, depth = 4): ReadonlyArray<string> {
  if (depth === 0) return [];
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.name === ".git")) return [root];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findWorktrees(NodePath.join(root, entry.name), depth - 1));
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

type WorktreeDecision =
  | { readonly keep: true; readonly reason: string }
  | { readonly keep: false; readonly commonDir: string | undefined };

async function decideWorktree(
  worktree: string,
  referenced: ReadonlyArray<string> | undefined,
): Promise<WorktreeDecision> {
  if (referenced === undefined) {
    return { keep: true, reason: "Z6 Code's database could not be read to check its threads" };
  }
  if (referenced.some((path) => contains(worktree, path) || contains(path, worktree))) {
    return { keep: true, reason: "Z6 Code's threads or projects use it" };
  }
  let status: string;
  try {
    status = await git(worktree, ["status", "--porcelain"]);
  } catch {
    return { keep: true, reason: "git could not check it for uncommitted changes" };
  }
  if (status.trim().length > 0) return { keep: true, reason: "it has uncommitted changes" };
  const commonDir = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    .then((output) => output.trim() || undefined)
    .catch(() => undefined);
  return { keep: false, commonDir };
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
 * Move the T3 folders Z6 was copied from to the Trash, except T3 worktrees Z6 still uses or that
 * hold uncommitted changes. Refuses, removing nothing, while T3 Code or its server is running.
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
  const inUse =
    homes.map(t3ServerInUse).find((reason) => reason !== undefined) ??
    [...userDataFolders].map(t3DesktopInUse).find((reason) => reason !== undefined) ??
    (homes.length > 0 ? t3ServiceInstalled(paths.homeDirectory) : undefined);
  if (inUse !== undefined) {
    return {
      status: "refused",
      reason: `Nothing was removed: ${inUse}. Quit T3 Code and stop its server, then try again.`,
    };
  }

  const removed: Array<string> = [];
  const kept: Array<{ path: string; reason: string }> = [];
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
    const worktreesDir = NodePath.join(marker.source, "worktrees");
    const referenced = z6ReferencedPaths(paths.z6Home);
    const decisions = await Promise.all(
      findWorktrees(worktreesDir).map(async (worktree) => ({
        worktree,
        decision: await decideWorktree(worktree, referenced),
      })),
    );
    const keptWorktrees = decisions.flatMap(({ worktree, decision }) =>
      decision.keep ? [{ path: worktree, reason: decision.reason }] : [],
    );
    if (keptWorktrees.length === 0) {
      await moveAway(marker.source);
    } else {
      kept.push(...keptWorktrees);
      for (const name of NodeFS.readdirSync(marker.source)) {
        if (name !== "worktrees") await moveAway(NodePath.join(marker.source, name));
      }
    }
    for (const { worktree, decision } of decisions) {
      if (decision.keep) continue;
      // With the home kept, each worktree goes on its own; either way git forgets it.
      if (keptWorktrees.length > 0 && !(await moveAway(worktree))) continue;
      if (decision.commonDir !== undefined) {
        await git(decision.commonDir, ["worktree", "prune"]).catch(() => undefined);
      }
    }
  }

  const record: T3CleanupRecord = { at: paths.now ?? nowIso(), removed, kept };
  for (const { markerDir, marker } of markedLocations(paths)) {
    writeT3MigrationMarker(markerDir, { ...marker, cleanup: record });
  }
  return { status: "removed", ...record };
}
