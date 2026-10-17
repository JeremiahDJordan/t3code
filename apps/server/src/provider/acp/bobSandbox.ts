// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The sandbox Bob's commands run in, outside Full access, as Codex runs its own.
 *
 * Bob runs every command as `$SHELL -c <command>`. T3 gives Bob a shell of its own, named like
 * the user's, that runs each command under macOS Seatbelt: it reads anywhere but the home
 * folder's hidden folders and app data, where tools keep their credentials, writes only in the
 * workspace and the temporary folders (only the temporary folders in Supervised) with `.git` and
 * agent settings kept read-only, and reaches no network. The user's rules add folders it may read
 * or write and paths it never touches. A command the user approved on a card, or that Auto's reviewer let out, runs outside
 * it once, by an approval T3 leaves for that exact command where commands in the sandbox cannot
 * write; no command sees where, nor T3's credentials.
 *
 * Work that must change nothing, a review guide, runs the whole `bob acp` process under one
 * read-only profile instead (`bobProcessSandboxSpawn`), Bob's own tools and its commands alike.
 * A workflow script's `exec()` runs its commands under the commands' profile too
 * (`commandSandboxSpawn`), with build tools' caches writable and, in Full access, the network.
 *
 * The base of the Seatbelt profile follows Codex's (openai/codex, Apache-2.0,
 * `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`).
 *
 * On Linux the same rules run under Bubblewrap (`bubblewrapScript`): the profile is a shell script
 * that mounts what a command may not read over with unreadable placeholders and what it may not
 * write read-only, finds the `.env` files on each run, and starts the command in its own
 * namespaces with a seccomp filter that refuses Unix sockets. Work that reaches the network runs
 * in pasta's network namespace, with no route to this machine.
 *
 * @module provider/acp/bobSandbox
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

/** What a sandboxed command may write: nothing but temporary files, or the workspace too. */
export type BobSandboxMode = "read-only" | "workspace-write";

/** The user's rules for the sandbox, as absolute paths. */
export interface BobSandboxRules {
  /** Folders commands may read, beyond the toolchains'. */
  readonly read: ReadonlyArray<string>;
  /** Folders commands may write in, and so read. */
  readonly write: ReadonlyArray<string>;
  /** Paths commands never read or write, whatever else allows them. */
  readonly private: ReadonlyArray<string>;
}

export const NO_BOB_SANDBOX_RULES: BobSandboxRules = { read: [], write: [], private: [] };

export interface BobSandbox {
  /** Bob's environment overrides, which route its commands through the sandbox. */
  readonly environment: Readonly<Record<string, string>>;
  /** Applies the user's rules to the commands Bob runs from now on. */
  readonly update: (rules: BobSandboxRules) => void;
  /**
   * Whether the sandbox's shell and profile are in place as written; without the shell Bob would
   * fall back to `/bin/sh`. One that was changed is restored, and is not ready this time.
   */
  readonly ready: () => boolean;
  /**
   * Lets the next run of this exact command, in this folder, run outside the sandbox; the
   * approval's file.
   */
  readonly approveOutside: (command: string, cwd: string) => string;
  /**
   * Drops every approval but `keep`: a command run outside the sandbox runs as the user and
   * could otherwise leave approvals of its own.
   */
  readonly dropApprovals: (keep: ReadonlySet<string>) => void;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Whether this host can run Bob's commands in a sandbox. */
export function bobSandboxAvailable(platform: NodeJS.Platform): boolean {
  if (platform === "linux") return bubblewrapTools() !== undefined;
  return platform === "darwin" && NodeFS.existsSync(SANDBOX_EXEC);
}

/**
 * The shell Bob runs commands with. Approved commands are matched by their exact text and the
 * folder they run in; anything else, including any other way of calling this shell, runs in the
 * sandbox: under `sandbox-exec` on macOS, and through the profile's own script on Linux.
 */
const sandboxShell = (sandbox: string) => `#!/bin/sh
# T3 Code's shell for Bob: each command runs in the sandbox of the thread's permission mode,
# unless the user approved that exact command in this folder.
real="$T3_BOB_SHELL"
[ -x "$real" ] || real=/bin/sh
export SHELL="$real"
# No command, in the sandbox or out, gets T3's credentials or finds the approvals.
approvals="$T3_BOB_APPROVALS"
unset T3_ACP_MCP_AUTHORIZATION T3_ACP_MCP_ENDPOINT T3_BOB_APPROVALS
# Already inside the sandbox, which every child inherits.
if [ -n "$T3_BOB_IN_SANDBOX" ]; then exec "$real" "$@"; fi
# Nor any variable named like a credential, as Codex leaves them out: Bob's key, the reviewer's,
# and whatever the user's shell exports, which a command would print to Bob's model.
for name in $(/usr/bin/env | /usr/bin/sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' |
  /usr/bin/grep -iE 'KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL'); do
  unset "$name" 2>/dev/null
done
if [ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ -n "$approvals" ] && [ -d "$approvals" ]; then
  here="$(pwd -P)"
  for approval in "$approvals"/*; do
    [ -f "$approval" ] || continue
    if printf '%s\\n%s' "$here" "$2" | cmp -s - "$approval" && rm "$approval" 2>/dev/null; then
      exec "$real" -c "$2"
    fi
  done
fi
export T3_BOB_IN_SANDBOX=1
${sandbox}
`;
export const BOB_SANDBOX_SHELL = sandboxShell(
  `exec ${SANDBOX_EXEC} -f "$T3_BOB_SANDBOX_PROFILE" "$real" "$@"`,
);
export const BOB_BUBBLEWRAP_SHELL = sandboxShell(
  `exec /bin/sh "$T3_BOB_SANDBOX_PROFILE" "$real" "$@"`,
);

function digest(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * A path as Seatbelt matches it: resolved, since `/tmp` is `/private/tmp` and so on. Of a path
 * that does not exist yet, the longest part that does is resolved, in the case the disk holds,
 * and the rest kept as written, so `~/.SSH/x` is `~/.ssh/x` on a Mac's case-blind disk.
 */
function realPath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    const missing: Array<string> = [];
    for (let at = NodePath.resolve(path); at !== NodePath.dirname(at); at = NodePath.dirname(at)) {
      missing.unshift(NodePath.basename(at));
      try {
        return NodePath.join(NodeFS.realpathSync.native(NodePath.dirname(at)), ...missing);
      } catch {
        // Not there either: try its parent.
      }
    }
    return NodePath.resolve(path);
  }
}

/**
 * A path compared as a Mac's disk compares names: by default, ignoring case, Unicode form, and the
 * letters it takes for others, such as `ß` for `ss`, `ſ` for `s` and `ﬁ` for `fi`.
 */
function folded(path: string): string {
  return path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

/** macOS's own links, under `/private`, which paths below them reach their folders through. */
const SYSTEM_LINKS = ["/tmp", "/var", "/etc"];

/** A folder a path may be resolved through: as written, and resolved. */
type BobRoot = readonly [written: string, resolved: string];

/**
 * `path` resolved for the sandbox and Bob's reviewer, or none when it runs through a symlink a
 * sandboxed command could have made, in this thread or another, another provider's included,
 * where a folder did not exist yet or was moved aside: a fresh worktree's `./dist`, or a nested
 * project's own folder, pointed at `~/.local` or `~/.ssh`. Only `roots` are resolved; below them
 * a link is followed only straight in the home folder, such as `~/code`, where no sandbox writes,
 * one hop at a time with its target walked as strictly, and any other drops the path. Each step must resolve to itself, so a folder swapped for a link
 * mid-walk is caught too. A part that does not exist yet is kept as written.
 */
function resolvedStrictly(
  path: string,
  roots: ReadonlyArray<BobRoot>,
  home: string,
  hops = 0,
): string | undefined {
  const absolute = NodePath.resolve(path);
  // The most specific first, so a workspace under a linked folder of home is resolved whole.
  const root = [...roots]
    .toSorted((a, b) => b[0].length - a[0].length)
    .find(([written]) => within(written, absolute) !== undefined);
  let at = root === undefined ? NodePath.parse(absolute).root : root[1];
  const parts = (root === undefined ? absolute : within(root[0], absolute)!)
    .split(NodePath.sep)
    .filter((part) => part !== "");
  for (const [index, part] of parts.entries()) {
    const next = NodePath.join(at, part);
    let link: boolean;
    try {
      link = NodeFS.lstatSync(next).isSymbolicLink();
    } catch {
      return NodePath.join(at, ...parts.slice(index));
    }
    if (link) {
      // One hop, to where the link says, which is walked as strictly in turn: a link below it
      // may be another sandbox's.
      if (at !== home || hops >= 8) return undefined;
      let target: string;
      try {
        target = NodePath.resolve(at, NodeFS.readlinkSync(next));
      } catch {
        return undefined;
      }
      const followed = resolvedStrictly(target, roots, home, hops + 1);
      if (followed === undefined) return undefined;
      at = followed;
      continue;
    }
    const real = realPath(next);
    if (NodePath.dirname(real) !== at || folded(NodePath.basename(real)) !== folded(part)) {
      return undefined;
    }
    at = real;
  }
  return at;
}

/** The home folder and macOS's own links, as `resolvedStrictly` takes them. */
function homeRoots(home: string): { readonly home: string; readonly roots: Array<BobRoot> } {
  const real = realPath(home);
  return {
    home: real,
    roots: [
      [home, real],
      [real, real],
      ...SYSTEM_LINKS.map((link): BobRoot => [link, realPath(link)]),
    ],
  };
}

/**
 * The workspace as Bob's sandbox and reviewer take it, or none when its path runs through a
 * symlink another sandbox could have made: then commands get no sandbox and Bob's edits ask.
 */
export function bobWorkspace(workspace: string, home: string): string | undefined {
  const places = homeRoots(home);
  return resolvedStrictly(workspace, places.roots, places.home);
}

/**
 * A folder of the user's rules as Bob's sandbox and reviewer apply it, below the home folder,
 * macOS's links and the `workspace` as `bobWorkspace` gave it; none when it runs through a
 * symlink a sandboxed command could have made.
 */
export function bobRuleFolder(
  path: string,
  places: { readonly home: string; readonly workspace?: BobRoot | undefined },
): string | undefined {
  const { home, roots } = homeRoots(places.home);
  return resolvedStrictly(
    path,
    places.workspace === undefined
      ? roots
      : [...roots, places.workspace, [places.workspace[1], places.workspace[1]]],
    home,
  );
}

/**
 * A path as a profile string. Seatbelt's Scheme reads `\"`, `\\` and `\xHH`, but not JSON's
 * `\uHHHH` or `\b`, so control characters are spelled `\xHH`; a lone surrogate, which no file
 * name on macOS holds, becomes U+FFFD.
 */
function quote(path: string): string {
  const escaped = path
    .toWellFormed()
    .replace(/[\\"]/g, "\\$&")
    .replace(
      // eslint-disable-next-line no-control-regex -- control characters are what this escapes.
      /[\u0000-\u001f\u007f]/g,
      (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
  return `"${escaped}"`;
}

/**
 * A path inside a `#"…"` regex. That string cannot hold a `"`, and `\x22` there parses but never
 * matches, so `.` stands for it, which matches it and any other one character.
 */
function regexQuote(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replaceAll('"', ".");
}

/**
 * Every tool keeps its credentials in a hidden folder or file of the home folder, or in Library,
 * so a sandboxed command reads none of those but the folders toolchains run from and read
 * their settings in. `.config` and `.local` hold every other app's settings and history too, so
 * only toolchains' folders in them; the user's rules add more.
 */
const HOME_READABLE = [
  ".local/bin",
  ".local/lib",
  ".local/share/mise",
  ".local/state/mise",
  ".local/share/uv",
  ".local/share/pipx",
  ".local/share/pnpm",
  ".local/share/vite-plus",
  ".config/git",
  ".config/mise",
  ".config/uv",
  ".config/pip",
  ".config/ruff",
  ".config/pnpm",
  ".config/vite-plus",
  ".cache",
  ".npm",
  ".nvm",
  ".nodenv",
  ".fnm",
  ".volta",
  ".proto",
  ".asdf",
  ".mise",
  ".pyenv",
  ".rbenv",
  ".goenv",
  ".sdkman",
  ".jenv",
  ".rustup",
  ".cargo",
  ".yarn",
  ".bun",
  ".deno",
  ".gradle",
  ".m2",
  ".gem",
  ".swiftpm",
  ".cocoapods",
  ".dotnet",
  ".nuget",
  ".android",
  ".gitconfig",
  ".gitignore_global",
  ".editorconfig",
  "Library/Application Support/go",
];
/**
 * App data in Library, which holds browsers' cookies, mail and other apps' tokens, and the
 * folders whose files macOS runs at login.
 */
const LIBRARY_PRIVATE = [
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
  "Library/Application Support",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Cookies",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Accounts",
  "Library/HTTPStorages",
];
/** Credential stores, read by no sandboxed command even inside the folders above. */
const HOME_SECRETS = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".bob",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".config/hub",
  ".terraform.d",
  ".cache/huggingface",
  ".nuget/NuGet",
  "Library/Keychains",
  ".1password",
  ".local/share/keyrings",
];
const HOME_SECRET_FILES = [
  ".netrc",
  ".git-credentials",
  ".vault-token",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".my.cnf",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".config/git/credentials",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".android/adbkey",
  ".claude/.credentials.json",
  ".codex/auth.json",
];
/** Folders and files in the workspace that run code or grant an agent access: read-only. */
const WORKSPACE_PROTECTED = [
  ".git",
  ".husky",
  ".githooks",
  ".bob",
  ".t3",
  ".claude",
  ".codex",
  ".cursor",
  ".gemini",
  ".agents",
  ".vscode",
  ".idea",
];

/**
 * The rules as the profile applies them. No path holds a NUL, and Seatbelt ends a string at one,
 * so a rule holding one would name a shorter path, such as `/`, in its place: it names nothing.
 * A read or write rule is resolved by `bobRuleFolder`. A rule to write in the home folder or above
 * reads there instead: writing there would let commands replace T3's own folders and the tools
 * T3 and the user run outside the sandbox.
 */
function rulesApplied(
  rules: BobSandboxRules,
  places: {
    readonly home: string;
    readonly realHome: string;
    readonly workspace: BobRoot | undefined;
  },
): BobSandboxRules {
  const named = (paths: ReadonlyArray<string>) => paths.filter((path) => !path.includes("\0"));
  const holdsHome = (path: string) => within(path, places.realHome) !== undefined;
  const targets = (paths: ReadonlyArray<string>) =>
    named(paths).flatMap((path) => bobRuleFolder(path, places) ?? []);
  const write = targets(rules.write);
  return {
    read: [...targets(rules.read), ...write.filter(holdsHome)],
    write: write.filter((path) => !holdsHome(path)),
    private: named(rules.private),
  };
}

/**
 * A path or pattern a profile names: a folder and all below it but the folders in `except`, one
 * path, or a regex.
 */
type BobPathMatch =
  | { readonly kind: "subpath"; readonly path: string; readonly except?: ReadonlyArray<string> }
  | { readonly kind: "literal"; readonly path: string }
  | { readonly kind: "regex"; readonly pattern: string };

function rendered(match: BobPathMatch): string {
  if (match.kind === "regex") return `(regex #"${match.pattern}")`;
  const path = `(${match.kind} ${quote(match.path)})`;
  const except = match.kind === "subpath" ? (match.except ?? []) : [];
  if (except.length === 0) return path;
  const kept = except.map((each) => `(require-not (subpath ${quote(each)}))`);
  return `(require-all ${path} ${kept.join(" ")})`;
}

/** Whether `match` covers `path`, compared as the disk compares names. */
function matches(match: BobPathMatch, path: string): boolean {
  if (match.kind === "regex") return new RegExp(match.pattern, "iu").test(path);
  if (match.kind === "literal") return folded(match.path) === folded(path);
  const below = (root: string) => within(folded(root), folded(path)) !== undefined;
  return below(match.path) && !(match.except ?? []).some(below);
}

/**
 * A folder a profile closes, but for the paths of the `opened` rules inside it, each of which
 * opens its own path alone: `~/.ssh/known_hosts` opens no other file in `~/.ssh`.
 */
function closedFolder(path: string, opened: ReadonlyArray<string>): BobPathMatch {
  const except = opened.filter((rule) => within(path, rule) !== undefined);
  return except.length === 0 ? { kind: "subpath", path } : { kind: "subpath", path, except };
}

/**
 * The credential stores a profile closes, unless one of the `opened` rules names one: the home
 * folder's and `Library`'s, each also where its link leads, as `~/.aws` kept in a dotfiles
 * folder, and shell history wherever a tool keeps it in a hidden folder, as XDG's
 * `~/.cache/zsh/history`. A rule holding a store leaves it closed, and one inside it opens only
 * its own path, so a broader rule beside it opens nothing more of the store.
 */
function credentialMatches(home: string, opened: ReadonlyArray<string>): Array<BobPathMatch> {
  const closed = (path: string) =>
    [...new Set([path, realPath(path)])].filter(
      (each) => !opened.some((rule) => within(each, rule) === ""),
    );
  return [
    ...[...HOME_SECRETS, ...LIBRARY_PRIVATE].flatMap((folder) =>
      closed(NodePath.join(home, folder)).map((path) => closedFolder(path, opened)),
    ),
    ...HOME_SECRET_FILES.flatMap((file) =>
      closed(NodePath.join(home, file)).map((path): BobPathMatch => ({ kind: "literal", path })),
    ),
    // Shell and REPL history, which holds whatever was typed, tokens included.
    { kind: "regex", pattern: `^${regexQuote(home)}/(\\.[^/]+/([^/]+/)*)?\\.?[A-Za-z_]*history$` },
  ];
}

/** The `.env` files below `roots`, which hold a project's secrets. */
function envMatches(roots: ReadonlyArray<string>): Array<BobPathMatch> {
  return roots.map((root) => ({
    kind: "regex",
    pattern: `^${regexQuote(root)}/(.*/)?\\.env[^/]*$`,
  }));
}

/**
 * What a profile never lets commands write, whatever a rule opens: `.git`, hooks and agent
 * settings in every folder they may write, the `.env` files there and in the temporary folders,
 * credential stores a write rule does not name, private paths and T3's state, the sandbox's own
 * files and T3's caches, the settings apps run commands from, and the sockets T3's tmux and Bob's
 * relays fall back to. The profile renders it and `bobRuleWriter` matches it, so Bob's reviewer
 * grants Bob's own edits no further than a sandboxed command could write.
 */
function writeDenials(input: {
  readonly home: string;
  readonly workspace: string | undefined;
  readonly rules: BobSandboxRules;
  readonly privateFolders: ReadonlyArray<string>;
  readonly sandboxFolders: ReadonlyArray<string>;
  readonly temporaryFolders: ReadonlyArray<string>;
}): Array<BobPathMatch> {
  const { home, workspace, rules } = input;
  const temporary = [...new Set(input.temporaryFolders.map(realPath))];
  // Only a write rule lifts a write denial: one to read a store opens it for reading.
  const preferences = NodePath.join(home, "Library/Preferences");
  const roots = [...(workspace === undefined ? [] : [workspace]), ...rules.write];
  return [
    ...roots.flatMap((root): Array<BobPathMatch> => [
      ...WORKSPACE_PROTECTED.map((name): BobPathMatch => ({
        kind: "subpath",
        path: NodePath.join(root, name),
      })),
      { kind: "literal", path: NodePath.join(root, ".mcp.json") },
    ]),
    // A subfolder moved into a temporary folder carries its `.env` along.
    ...envMatches([...roots, ...temporary]),
    ...credentialMatches(home, rules.write),
    ...[...new Set([...rules.private, ...input.privateFolders, ...input.sandboxFolders])].map(
      (path): BobPathMatch => ({ kind: "subpath", path: realPath(path) }),
    ),
    ...(rules.write.some((rule) => within(preferences, rule) === "")
      ? []
      : [closedFolder(preferences, rules.write)]),
    ...temporary.map((folder): BobPathMatch => ({
      kind: "regex",
      pattern: `^${regexQuote(folder)}/(tmux-[0-9]+|t3-bob-)`,
    })),
  ];
}

/**
 * Where the user's write rules let the sandbox's commands write `path`, as its profile decides:
 * in a rule's folder as `rulesApplied` applies it, and past every write denial; the path's place
 * in that folder, or none. Bob's reviewer grants Bob's own edits by it, which run outside the
 * sandbox, so they reach no further than a command could. Built once per review.
 */
export function bobRuleWriter(input: {
  readonly home: string;
  /** The workspace as written, or none. */
  readonly workspace: string | undefined;
  readonly rules: BobSandboxRules;
  /** T3's state, and T3's caches with the sandbox's own files. */
  readonly privateFolders: ReadonlyArray<string>;
  readonly sandboxFolders: ReadonlyArray<string>;
  readonly temporaryFolders: ReadonlyArray<string>;
}): (path: string) => string | undefined {
  const home = realPath(input.home);
  const pinned =
    input.workspace === undefined ? undefined : bobWorkspace(input.workspace, input.home);
  const workspace: BobRoot | undefined =
    input.workspace === undefined || pinned === undefined ? undefined : [input.workspace, pinned];
  const rules = rulesApplied(input.rules, { home: input.home, realHome: home, workspace });
  const denials = writeDenials({
    home,
    workspace: pinned,
    rules,
    privateFolders: input.privateFolders,
    sandboxFolders: input.sandboxFolders,
    temporaryFolders: input.temporaryFolders,
  });
  return (path) => {
    const real = realPath(path);
    const root = rules.write.find((rule) => within(folded(rule), folded(real)) !== undefined);
    if (root === undefined || denials.some((denial) => matches(denial, real))) return undefined;
    return within(root, real) ?? within(folded(root), folded(real));
  };
}

/**
 * The credential stores the sandbox keeps closed past the user's read and write rules, which open
 * one only by naming it: a rule to read `~` or `~/.config` leaves `~/.ssh` and `~/.config/gh`
 * closed. Bob's reviewer bounds Bob's own reads by it, which run outside the sandbox: `holds` a
 * path in one, and a folder a read descends from that holds one, `below` it. Shell history, which
 * the profile closes by name in any hidden folder of the home folder, counts below a folder outside
 * the workspace. Built once per review.
 */
export function bobClosedCredentials(input: {
  readonly home: string;
  /** The workspace as written, or none. */
  readonly workspace: string | undefined;
  readonly rules: BobSandboxRules;
}): { readonly holds: (path: string) => boolean; readonly below: (folder: string) => boolean } {
  const home = realPath(input.home);
  const pinned =
    input.workspace === undefined ? undefined : bobWorkspace(input.workspace, input.home);
  const workspace: BobRoot | undefined =
    input.workspace === undefined || pinned === undefined ? undefined : [input.workspace, pinned];
  const rules = rulesApplied(input.rules, { home: input.home, realHome: home, workspace });
  const closed = credentialMatches(home, [...rules.read, ...rules.write]);
  return {
    holds: (path) => {
      const real = realPath(path);
      return closed.some((match) => matches(match, real) || matches(match, path));
    },
    below: (folder) => {
      const real = folded(realPath(folder));
      return closed.some((match) => {
        if (match.kind !== "regex") return within(real, folded(match.path)) !== undefined;
        if (pinned !== undefined && within(folded(pinned), real) !== undefined) return false;
        const fromHome = within(folded(home), real);
        return (
          within(real, folded(home)) !== undefined ||
          (fromHome !== undefined && fromHome.startsWith("."))
        );
      });
    },
  };
}

/** The Seatbelt profile for one workspace and mode. */
export function bobSandboxProfile(input: {
  readonly mode: BobSandboxMode;
  /** The workspace as written, and as `bobWorkspace` pinned it, which is never resolved again. */
  readonly workspace: BobRoot;
  readonly home: string;
  /** T3's own state, which holds the user's data and secrets. */
  readonly privateFolders: ReadonlyArray<string>;
  /** Where chat attachments are stored, inside T3's state: commands may read them. */
  readonly attachmentsFolder?: string | undefined;
  readonly temporaryFolders: ReadonlyArray<string>;
  /** The `PATH` commands search, whose folders the shell may look in wherever they are. */
  readonly searchPath?: string | undefined;
  readonly rules?: BobSandboxRules | undefined;
  /** The sandbox's own shell and profiles, which no command may change. */
  readonly sandboxFolders?: ReadonlyArray<string> | undefined;
}): string {
  const workspace = input.workspace[1];
  const home = realPath(input.home);
  const rules = rulesApplied(input.rules ?? NO_BOB_SANDBOX_RULES, {
    home: input.home,
    realHome: home,
    workspace: input.workspace,
  });
  const hidden = [
    `(regex #"^${regexQuote(home)}/\\.[^/]+")`,
    `(regex #"^${regexQuote(home)}/Library/Preferences/\\.[^/]+")`,
    ...LIBRARY_PRIVATE.map((folder) => `(subpath ${quote(NodePath.join(home, folder))})`),
  ];
  // A command searching PATH, such as Node's spawn, gives up at the first folder it may not look
  // in, through symlinks too, so it may look along each, at the folder's own entries. It reads in
  // those named `bin`, to run the tools there, but not in others, such as `~/.turso`, which holds
  // its credentials.
  const onPath = (input.searchPath ?? "")
    .split(":")
    .filter((folder) => NodePath.isAbsolute(folder));
  const entriesOf = (folder: string) => [
    `(literal ${quote(folder)})`,
    `(regex #"^${regexQuote(folder)}/[^/]+$")`,
  ];
  const searchable = new Set(
    onPath.flatMap((folder) => {
      const ancestors = [];
      for (let path = NodePath.dirname(folder); path !== NodePath.dirname(path);) {
        ancestors.push(`(literal ${quote(path)})`);
        path = NodePath.dirname(path);
      }
      return [...entriesOf(folder), ...entriesOf(realPath(folder)), ...ancestors];
    }),
  );
  const toolFolders = new Set(
    onPath.map(realPath).filter((folder) => NodePath.basename(folder) === "bin"),
  );
  const readable = [
    ...HOME_READABLE.map((path) => `(subpath ${quote(NodePath.join(home, path))})`),
    ...[...toolFolders].map((folder) => `(subpath ${quote(folder)})`),
    // The workspace, even in a hidden folder such as T3's worktrees.
    `(subpath ${quote(workspace)})`,
  ];
  // The user's rules may open a credential store only by naming it, not a folder holding it,
  // and a path inside one alone.
  const opened = [...rules.read, ...rules.write];
  const credentials = credentialMatches(home, opened).map(rendered);
  const subpaths = (paths: ReadonlyArray<string>) =>
    [...new Set(paths.map(realPath))].map((path) => `(subpath ${quote(path)})`);
  // The user's own rules come after the defaults, so they may reopen what those close, but never
  // credentials they do not name, private paths or T3's state.
  // Rule paths are resolved already, by `rulesApplied`: resolving them again would follow a
  // symlink it refused.
  const userReadable = [...new Set(opened)].map((path) => `(subpath ${quote(path)})`);
  const closed = subpaths([...rules.private, ...input.privateFolders]);
  const userWritable = [...new Set(rules.write)];
  const temporary = [...new Set(input.temporaryFolders.map(realPath))];
  const writable =
    input.mode === "workspace-write"
      ? [workspace, ...temporary, ...userWritable]
      : [...temporary, ...userWritable];
  // The `.env` files of the workspace, of a folder the user lets commands write, and of the
  // temporary folders, where a command may move a subfolder, hold secrets: commands neither read
  // nor write them, unless a rule names one. Samples stay readable.
  const envRoots = [workspace, ...userWritable, ...temporary];
  const envFiles = envMatches(envRoots).map(rendered);
  const envSamples = envRoots.map(
    (root) => `(regex #"^${regexQuote(root)}/(.*/)?\\.env[^/]*\\.(example|sample|template|dist)$")`,
  );
  const writeDenied = writeDenials({
    home,
    workspace,
    rules,
    privateFolders: input.privateFolders,
    sandboxFolders: input.sandboxFolders ?? [],
    temporaryFolders: input.temporaryFolders,
  }).map(rendered);
  // Toolchains' folders inside app data, such as Go's, which the credential denials cover.
  const toolchainsInAppData = HOME_READABLE.map((entry) => NodePath.join(home, entry))
    .filter((path) =>
      LIBRARY_PRIVATE.some((folder) => within(NodePath.join(home, folder), path) !== undefined),
    )
    .map((path) => `(subpath ${quote(path)})`);
  const namedEnvFiles = [...new Set(opened)]
    .filter((path) => /^\.env/.test(NodePath.basename(path)))
    .map((path) => `(literal ${quote(path)})`);
  // Moving the workspace, or a folder holding it, into a temporary folder would carry `.git`
  // and the rest past the rules that keep them read-only, as would moving a writable folder.
  // Moving T3's own folders aside, and a folder of the command's in their place, would hand it
  // the sandbox's shell and the folder T3 runs Bob's text generation in.
  const anchored = new Set<string>();
  // Nor may a command move a private path's folder aside, which would carry it out of its rule.
  for (const root of [
    workspace,
    ...userWritable,
    ...rules.private.map(realPath),
    ...input.privateFolders.map(realPath),
    ...(input.sandboxFolders ?? []).map(realPath),
  ]) {
    for (let path = root; path !== NodePath.dirname(path); path = NodePath.dirname(path)) {
      anchored.add(`(literal ${quote(path)})`);
    }
  }
  return `(version 1)
; Bob's commands in T3 Code's ${input.mode} sandbox. The base follows Codex's Seatbelt policy.
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))

; Reads anywhere but the home folder's hidden files and app data, which hold every tool's
; credentials, save what toolchains need, and never credential stores or T3's own state.
; Seatbelt applies the last rule that matches.
(allow file-read*)
(deny file-read*
  ${hidden.join("\n  ")})
${searchable.size > 0 ? `(allow file-read-metadata\n  ${[...searchable].join("\n  ")})` : ""}
(allow file-read*
  ${readable.join("\n  ")})
${userReadable.length > 0 ? `(allow file-read*\n  ${userReadable.join("\n  ")})` : ""}
(deny file-read*
  ${credentials.join("\n  ")})
(allow file-read*
  ${toolchainsInAppData.join("\n  ")})
; A \`.env\` file's contents only: listing a folder or a \`.env/\` virtualenv still works. Seatbelt
; weighs the specific operation first, so samples and named files reopen as \`file-read-data\`.
(deny file-read-data (require-all (vnode-type REGULAR-FILE) (require-any
  ${envFiles.join("\n  ")})))
${
  envSamples.length + namedEnvFiles.length > 0
    ? `(allow file-read-data\n  ${[...envSamples, ...namedEnvFiles].join("\n  ")})`
    : ""
}
; Private paths and T3's state last, for the specific operation too, which the \`.env\` reopenings
; above would otherwise outrank.
(deny file-read* file-read-data
  ${closed.join("\n  ")})
${
  input.attachmentsFolder === undefined
    ? ""
    : `; The user's chat attachments, which turns name by path, stay readable inside T3's state.
(allow file-read* file-read-data (subpath ${quote(realPath(input.attachmentsFolder))}))`
}

; Writes only where the mode allows, never to the workspace's git or agent settings.
${
  writable.length > 0
    ? `(allow file-write*\n  ${writable.map((path) => `(subpath ${quote(path)})`).join("\n  ")})`
    : ""
}
(deny file-write*
  ${writeDenied.join("\n  ")})
(deny file-write-unlink (require-all (vnode-type DIRECTORY) (require-any
  ${[...anchored].join("\n  ")})))
; Cloning a folder copies everything below it without checking each file's read rule, so a
; command could clone a readable folder holding credentials or private paths into a temporary
; folder and read them there. Cloning a file, and copying as \`cp\` does, still work.
(deny file-clone (vnode-type DIRECTORY))

; No network: what reaches out needs the user's approval.
`;
}

/** Where `path` lies within `root`, "" for the root itself; none when it lies outside. */
function within(root: string, path: string): string | undefined {
  const relative = NodePath.relative(root, path);
  return relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
    ? undefined
    : relative;
}

/** Folders where agents keep their transcripts and credentials, which a card never opens. */
const AGENT_FOLDERS = [".claude", ".codex", ".cursor", ".gemini", ".agents", ".bob", ".t3", ".z6"];
/** Folders a card offers to let commands write in: caches, and the toolchains' own. */
const WRITABLE_PARENTS = ["Library/Caches", ".cache", "go", ...HOME_READABLE];

/**
 * The folder a card offers to open after the sandbox stopped a command at `path`: to read, when
 * the sandbox hides it, such as `~/.vercel` or `~/.config/stripe`, or to write in a cache or a
 * toolchain's folder, such as `~/Library/Caches/go-build`; or a workspace `.env` file to read.
 * The path comes from the command's output, which the agent controls, so never a whole
 * `~/Library` or `~/.config`, app data, an agent's folder, a credential store, history or T3's
 * home, and nothing the rules already open.
 */
export function bobSandboxFolderSuggestion(
  path: string,
  input: {
    readonly home: string;
    readonly workspace: string;
    /** T3's home, its state, caches, worktrees and the sandbox's own files. */
    readonly t3Home: string;
    readonly rules: BobSandboxRules;
  },
): { readonly kind: "read" | "write"; readonly folder: string } | undefined {
  // Nothing to offer for a path the user could not have typed as a rule.
  // eslint-disable-next-line no-control-regex -- a path holding a control character is refused.
  if (/[\u0000-\u001f\u007f]/.test(path) || !path.isWellFormed()) return undefined;
  const real = realPath(path);
  const home = realPath(input.home);
  // Compared as the disk compares names, so `~/.SSH` and `~/.awſ` are the stores they spell.
  const under = (root: string, path: string) => within(folded(root), folded(path)) !== undefined;
  const inAny = (roots: ReadonlyArray<string>) => roots.some((root) => under(realPath(root), real));
  if (inAny(input.rules.private)) return undefined;
  const workspace = bobWorkspace(input.workspace, input.home);
  if (workspace !== undefined && under(workspace, real)) {
    const name = NodePath.basename(real);
    return /^\.env/.test(name) && !inAny([...input.rules.read, ...input.rules.write])
      ? { kind: "read", folder: real }
      : undefined;
  }
  const fromHome = within(home, real);
  if (!fromHome || inAny([input.t3Home])) return undefined;
  if (
    inAny(
      [...HOME_SECRETS, ...LIBRARY_PRIVATE, ...AGENT_FOLDERS].map((folder) =>
        NodePath.join(home, folder),
      ),
    ) ||
    HOME_SECRET_FILES.some((file) => folded(NodePath.join(home, file)) === folded(real)) ||
    /^\.[A-Za-z_]*history$/i.test(fromHome) ||
    under(NodePath.join(home, "Library", "Preferences"), real)
  ) {
    return undefined;
  }
  const segments = fromHome.split(NodePath.sep);
  const depth =
    segments[0] === "Library" ||
    (segments[0] === ".local" && ["share", "state", "lib"].includes(segments[1] ?? ""))
      ? 3
      : [".config", ".cache", ".local"].includes(segments[0]!)
        ? 2
        : 1;
  if (segments.length < depth) return undefined;
  const folder = NodePath.join(home, ...segments.slice(0, depth));
  const hidden =
    segments[0]!.startsWith(".") ||
    (segments[0] === "Library" && segments[1] === "Preferences" && segments[2]?.startsWith("."));
  // Seatbelt stops a command only at a path that is there; a folder that is not there gets no
  // offer, which also leaves a name the disk would take for a credential store's unoffered.
  let directory = false;
  try {
    directory = NodeFS.statSync(folder).isDirectory();
  } catch {
    // Not there: nothing to open.
  }
  if (!directory) return undefined;
  const readable = inAny([
    ...HOME_READABLE.map((entry) => NodePath.join(home, entry)),
    ...input.rules.read,
    ...input.rules.write,
  ]);
  if (hidden && !readable) return { kind: "read", folder };
  const writableParent = WRITABLE_PARENTS.some(
    (parent) => within(NodePath.join(home, parent), folder) !== undefined,
  );
  return writableParent && !inAny(input.rules.write) ? { kind: "write", folder } : undefined;
}

/**
 * Sets up the sandbox for a Bob runtime: the shell, written into T3's caches once per version,
 * the profile for its workspace, mode and rules, rewritten in place as the rules change, and the
 * folder approvals go to, under T3's state. None where this host has no sandbox.
 */
export function makeBobSandbox(input: {
  readonly mode: BobSandboxMode;
  readonly workspace: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The user's shell, which commands run in. */
  readonly shell: string | undefined;
  readonly cacheDir: string;
  readonly stateDir: string;
  /** Chat attachments, inside `stateDir`, which commands may read. */
  readonly attachmentsDir?: string | undefined;
  /**
   * Names the profile and the approvals folder, which a Bob kept running in tmux finds again
   * after a restart: one per thread and folder.
   */
  readonly key: string;
  readonly temporaryFolders: ReadonlyArray<string>;
  /** The `PATH` Bob's commands search. */
  readonly searchPath?: string | undefined;
  readonly rules?: BobSandboxRules | undefined;
}): BobSandbox | undefined {
  if (!bobSandboxAvailable(input.platform)) return undefined;
  const linux = input.platform === "linux" ? bubblewrapTools() : undefined;
  // A place holding a `"`, a control character or a lone surrogate gets no sandbox, so its
  // commands ask.
  if (
    !nameable([
      input.workspace,
      input.home,
      input.cacheDir,
      input.stateDir,
      ...(input.attachmentsDir === undefined ? [] : [input.attachmentsDir]),
      ...input.temporaryFolders,
      ...(input.searchPath?.split(":") ?? []),
    ])
  )
    return undefined;
  // Pinned once: a rebuild never resolves the workspace again, so a link another sandbox puts in
  // its place later leads nowhere. One there already leaves commands to ask.
  const workspace = bobWorkspace(input.workspace, input.home);
  if (workspace === undefined) return undefined;
  const realShell =
    input.shell && NodePath.isAbsolute(input.shell) && !input.shell.includes("bob-sandbox")
      ? input.shell
      : "/bin/sh";
  const root = NodePath.join(input.cacheDir, "bob-sandbox");
  // Named like the user's shell, since Bob tells its model the shell's name.
  const shellText = linux === undefined ? BOB_SANDBOX_SHELL : BOB_BUBBLEWRAP_SHELL;
  const shell = NodePath.join(root, digest(shellText), NodePath.basename(realShell));
  const files = linux === undefined ? undefined : bubblewrapFiles(input.cacheDir, linux);
  const profileFor = (rules: BobSandboxRules) => {
    const profileInput = {
      mode: input.mode,
      workspace: [input.workspace, workspace] as const,
      home: input.home,
      privateFolders: [input.stateDir],
      attachmentsFolder: input.attachmentsDir,
      temporaryFolders: input.temporaryFolders,
      searchPath: input.searchPath,
      rules,
      // The sandbox's own files and every cache of T3's, the reviewer's program included.
      sandboxFolders: [input.cacheDir],
    };
    return files === undefined
      ? bobSandboxProfile(profileInput)
      : bubblewrapScript(profileInput, files);
  };
  let profileText = profileFor(input.rules ?? NO_BOB_SANDBOX_RULES);
  const profile = NodePath.join(
    root,
    "profiles",
    `${digest(`${input.key}\0${input.mode}`)}.${files === undefined ? "sb" : "sh"}`,
  );
  const approvals = NodePath.join(input.stateDir, "bob-sandbox", "approvals", digest(input.key));
  const ensure = () => {
    writeOnce(shell, shellText, 0o755);
    writeOnce(profile, profileText, 0o644);
    if (files !== undefined) bubblewrapFilesReady(files, true);
    NodeFS.mkdirSync(approvals, { recursive: true, mode: 0o700 });
  };
  ensure();
  // Approvals a T3 that stopped mid-turn left behind.
  for (const entry of NodeFS.readdirSync(approvals)) {
    NodeFS.rmSync(NodePath.join(approvals, entry), { recursive: true, force: true });
  }
  return {
    update: (rules) => {
      profileText = profileFor(rules);
      writeOnce(profile, profileText, 0o644);
    },
    environment: {
      SHELL: shell,
      T3_BOB_SHELL: realShell,
      T3_BOB_SANDBOX_PROFILE: profile,
      T3_BOB_APPROVALS: approvals,
    },
    // A command run outside could change the shell or profile, so readiness checks what they say.
    ready: () => {
      if (
        holds(shell, shellText) &&
        executable(shell) &&
        holds(profile, profileText) &&
        (files === undefined || bubblewrapFilesReady(files, false))
      ) {
        return true;
      }
      ensure();
      return false;
    },
    approveOutside: (command, cwd) => {
      ensure();
      const approval = NodePath.join(approvals, NodeCrypto.randomUUID());
      NodeFS.writeFileSync(approval, `${realPath(cwd)}\n${command}`, { mode: 0o600 });
      return approval;
    },
    dropApprovals: (keep) => {
      for (const entry of NodeFS.readdirSync(approvals, { withFileTypes: true })) {
        const path = NodePath.join(approvals, entry.name);
        if (!keep.has(path)) NodeFS.rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Whether the profile can name every place: none holds a `"`, a control character or a lone
 * surrogate. `quote` spells each exactly, but no folder T3 or Bob uses holds one, so such a place
 * is refused rather than trusted to it.
 */
function nameable(places: ReadonlyArray<string>): boolean {
  return places.every(
    // eslint-disable-next-line no-control-regex -- a path holding a control character is refused.
    (path) => !path.includes('"') && /^[^\0-\x1f\x7f]*$/u.test(path) && path.isWellFormed(),
  );
}

/**
 * What Bob itself writes in `~/.bob`, as Bob 2.0.6's bundle reads: its task database, its logs,
 * the folders `--trust` trusts, and its sign-in, which a token refresh rewrites. Nothing there
 * that runs code: not its settings, approvals, MCP servers, hooks, plugins or skills.
 */
const BOB_HOME_WRITABLE_FOLDERS = ["db", "logs"];
const BOB_HOME_WRITABLE_FILES = ["trustedFolders.json", "settings/auth-secrets.json"];

/**
 * Services a process that reaches the network looks up, as Codex's network policy lets them
 * (`codex-rs/sandboxing/src/seatbelt_network_policy.sbpl`): name resolution and TLS trust.
 */
const NETWORK_SERVICES = [
  "com.apple.bsd.dirhelper",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.SecurityServer",
  "com.apple.networkd",
  "com.apple.ocspd",
  "com.apple.trustd.agent",
  "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.SystemConfiguration.configd",
];

/**
 * Rules that let a sandboxed process reach other machines. Nothing on this machine but the name
 * resolver, since a port or a socket here, Docker's, tmux's or T3's own, would let a command
 * change what the rest of the profile keeps.
 */
const OTHER_MACHINES = `(allow network-outbound)
(deny network-outbound (remote ip "localhost:*") (remote unix-socket))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow system-socket)
(allow mach-lookup
  ${NETWORK_SERVICES.map((name) => `(global-name ${quote(name)})`).join("\n  ")})
`;

/**
 * The Seatbelt profile for a whole `bob acp` process that must change nothing, such as one reading
 * a pull request's checkout for its review guide. Seatbelt refuses a second, different profile
 * inside a sandbox, so Bob's commands cannot have their own: they, Bob's own tools and every
 * process Bob starts, MCP servers and hooks included, share this one. It is the read-only profile
 * of Bob's commands, writing only in the temporary folders and never in the checkout, even one
 * inside them, with three changes for Bob itself: it
 * reads `~/.bob` and its own install and writes only its state there, it never sees the
 * workspace's own `.bob` folder (the project's settings, MCP servers, hooks and plugins, which Bob
 * runs in a folder `--trust` trusts), and it reaches other machines, for its model, but no port
 * or socket on this one.
 */
function bobProcessSandboxProfile(input: {
  /** The workspace as written, and as `bobWorkspace` pinned it. */
  readonly workspace: BobRoot;
  readonly home: string;
  /** T3's own state, which holds the user's data and secrets. */
  readonly privateFolders: ReadonlyArray<string>;
  /** T3's caches, which hold the sandbox's own files. */
  readonly sandboxFolders: ReadonlyArray<string>;
  readonly temporaryFolders: ReadonlyArray<string>;
  /** The `PATH` Bob and its commands search. */
  readonly searchPath?: string | undefined;
  /** The folder Bob runs from, which may be a hidden one no other rule opens. */
  readonly install?: string | undefined;
}): string {
  const home = realPath(input.home);
  const bobHome = realPath(NodePath.join(input.home, ".bob"));
  // An install that holds the home folder would open every credential store below it.
  const install =
    input.install !== undefined && within(realPath(input.install), home) === undefined
      ? [input.install]
      : [];
  const commands = bobSandboxProfile({
    mode: "read-only",
    workspace: input.workspace,
    home: input.home,
    privateFolders: input.privateFolders,
    temporaryFolders: input.temporaryFolders,
    searchPath: input.searchPath,
    rules: { read: [NodePath.join(input.home, ".bob"), ...install], write: [], private: [] },
    sandboxFolders: input.sandboxFolders,
  });
  const bobWrites = [
    ...BOB_HOME_WRITABLE_FOLDERS.map(
      (folder) => `(subpath ${quote(NodePath.join(bobHome, folder))})`,
    ),
    ...BOB_HOME_WRITABLE_FILES.map((file) => `(literal ${quote(NodePath.join(bobHome, file))})`),
  ];
  const projectBob = quote(NodePath.join(input.workspace[1], ".bob"));
  return `${commands}
; Bob's own process, and so every command and server it starts. Seatbelt applies the last rule
; that matches, so these follow the rules above.
; The checkout, even inside a temporary folder the rules above let commands write, as T3's
; worktrees are when T3's home is there.
(deny file-write* (subpath ${quote(input.workspace[1])}))
(allow file-write*
  ${bobWrites.join("\n  ")})
; The project's own Bob folder: its settings, approvals, hooks, MCP servers and plugins, none of
; which a pull request may give Bob.
(deny file-read* file-read-data file-read-metadata file-write* (subpath ${projectBob}))
; Other machines, for Bob's model: which commands run is T3's to answer, and none that reaches
; the network is let through.
${OTHER_MACHINES}`;
}

/**
 * `bobProcessSandboxProfile` under Bubblewrap: the read-only profile of Bob's commands, with
 * Bob's own reads and writes in `~/.bob`, the checkout read-only and its `.bob` folder hidden, and
 * other machines through pasta. None where pasta is missing.
 */
function bubblewrapProcessScript(
  input: Omit<Parameters<typeof bobProcessSandboxProfile>[0], "install"> & {
    readonly install: string;
  },
  cacheDir: string,
): string | undefined {
  const files = sandboxFiles(cacheDir, true);
  if (files === undefined) return undefined;
  const home = realPath(input.home);
  const bobHome = realPath(NodePath.join(input.home, ".bob"));
  // Bubblewrap opens what is there, and `~/.bob` stays read-only, so Bob's own state is made
  // first: its folders, and an empty list of trusted folders for `--trust` to write.
  try {
    for (const folder of BOB_HOME_WRITABLE_FOLDERS) {
      NodeFS.mkdirSync(NodePath.join(bobHome, folder), { recursive: true, mode: 0o700 });
    }
    NodeFS.writeFileSync(NodePath.join(bobHome, "trustedFolders.json"), "{}", {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // There already, or Bob's home is not writable: Bob reports what it cannot write.
  }
  const install = within(realPath(input.install), home) === undefined ? [input.install] : [];
  const allow = (match: BobPathMatch): BubblewrapRule => ({ allow: true, match });
  const projectBob: BobPathMatch = {
    kind: "subpath",
    path: NodePath.join(input.workspace[1], ".bob"),
  };
  return bubblewrapScript(
    {
      mode: "read-only",
      workspace: input.workspace,
      home: input.home,
      privateFolders: input.privateFolders,
      temporaryFolders: input.temporaryFolders,
      searchPath: input.searchPath,
      rules: { read: [NodePath.join(input.home, ".bob"), ...install], write: [], private: [] },
      sandboxFolders: input.sandboxFolders,
      read: [{ allow: false, match: projectBob }],
      write: [
        { allow: false, match: { kind: "subpath", path: input.workspace[1] } },
        ...BOB_HOME_WRITABLE_FOLDERS.map((folder) =>
          allow({ kind: "subpath", path: NodePath.join(bobHome, folder) }),
        ),
        ...BOB_HOME_WRITABLE_FILES.map((file) =>
          allow({ kind: "literal", path: NodePath.join(bobHome, file) }),
        ),
      ],
    },
    files,
  );
}

/**
 * The temporary folders a sandboxed process writes: its own, and the system's, through macOS's
 * links on a Mac.
 */
function sandboxTemporaryFolders(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Array<string> {
  return [
    environment.TMPDIR || NodeOS.tmpdir(),
    ...(platform === "linux" ? ["/tmp", "/var/tmp"] : ["/private/tmp", "/private/var/tmp"]),
  ];
}

/** Bubblewrap's files under T3's caches, written; with the network, none where pasta is missing. */
function sandboxFiles(cacheDir: string, network: boolean): BubblewrapFiles | undefined {
  const tools = bubblewrapTools();
  if (tools === undefined) return undefined;
  const files = bubblewrapFiles(cacheDir, tools);
  bubblewrapFilesReady(files, true);
  if (!network) return files;
  const reach = bubblewrapNetwork(cacheDir);
  return reach === undefined ? undefined : { ...files, network: reach };
}

/** `command` as `PATH` finds it, or as given when it names a path. None when it is not there. */
function bobExecutable(command: string, searchPath: string | undefined): string | undefined {
  const candidates = command.includes("/")
    ? [NodePath.resolve(command)]
    : (searchPath ?? "")
        .split(":")
        .filter((folder) => NodePath.isAbsolute(folder))
        .map((folder) => NodePath.join(folder, command));
  return candidates.find((candidate) => {
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return NodeFS.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The folder Bob runs from: its npm package when `executable` leads to its `dist/bob.js`, which
 * also holds its native helpers, or else the executable's own folder.
 */
function bobInstallFolder(executable: string): string {
  const script = realPath(executable);
  const folder = NodePath.dirname(script);
  return NodePath.basename(folder) === "dist" ? NodePath.dirname(folder) : folder;
}

/**
 * How to start `bob` for work that must change nothing: under `sandbox-exec` with
 * `bobProcessSandboxProfile`, given as text so no file of it outlives the run. Bob's home, its
 * temporary folder and its `PATH` are those of the environment it runs with. None where the host
 * has no sandbox, `bob` cannot be found, or a place cannot be named in a profile.
 */
export function bobProcessSandboxSpawn(input: {
  readonly platform: NodeJS.Platform;
  /** `bob`, or the path the instance's settings give. */
  readonly command: string;
  readonly workspace: string;
  /** The environment Bob runs with. */
  readonly environment: NodeJS.ProcessEnv;
  /** T3's caches and state. */
  readonly cacheDir: string;
  readonly stateDir: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  if (!bobSandboxAvailable(input.platform)) return undefined;
  const home = input.environment.HOME || NodeOS.homedir();
  const searchPath = input.environment.PATH;
  const temporaryFolders = sandboxTemporaryFolders(input.platform, input.environment);
  const executable = bobExecutable(input.command, searchPath);
  if (executable === undefined) return undefined;
  const install = bobInstallFolder(executable);
  if (
    !nameable([
      input.workspace,
      home,
      input.cacheDir,
      input.stateDir,
      executable,
      install,
      ...temporaryFolders,
      ...(searchPath?.split(":") ?? []),
    ])
  ) {
    return undefined;
  }
  // As Bob's commands pin it: a checkout reached through a link another sandbox could have made
  // gets no sandbox.
  const workspace = bobWorkspace(input.workspace, home);
  if (workspace === undefined) return undefined;
  if (input.platform === "linux") {
    const script = bubblewrapProcessScript(
      {
        workspace: [input.workspace, workspace],
        home,
        privateFolders: [input.stateDir],
        sandboxFolders: [input.cacheDir],
        temporaryFolders,
        searchPath,
        install,
      },
      input.cacheDir,
    );
    return script === undefined
      ? undefined
      : { command: "/bin/sh", args: ["-c", script, "t3-bob-sandbox", executable] };
  }
  const profile = bobProcessSandboxProfile({
    workspace: [input.workspace, workspace],
    home,
    privateFolders: [input.stateDir],
    sandboxFolders: [input.cacheDir],
    temporaryFolders,
    searchPath,
    install,
  });
  return { command: SANDBOX_EXEC, args: ["-p", profile, executable] };
}

/**
 * Caches build tools write as they install and build, which a command run for a workflow's
 * `exec` may write in: compilers' and package managers' caches and stores, never a toolchain's
 * own folders, whose programs run outside the sandbox. A later build outside the sandbox still
 * reads what a command left in them.
 */
const BUILD_CACHES = [
  "Library/Caches",
  ".cache",
  "Library/pnpm/store",
  ".local/share/pnpm/store",
  ".npm/_cacache",
  ".yarn/berry/cache",
  ".bun/install/cache",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
];

/**
 * The git folders a commit in the worktree at `worktree` writes: its own folder in the
 * repository, and the repository's objects, refs and their logs. None when `worktree` is not a
 * linked worktree, whose `.git` would be the whole repository, hooks and configuration included.
 */
function worktreeGitFolders(
  worktree: string,
): { readonly gitDir: string; readonly writable: ReadonlyArray<string> } | undefined {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(
      NodeFS.readFileSync(NodePath.join(worktree, ".git"), "utf8"),
    );
    if (pointer === null) return undefined;
    const gitDir = NodePath.resolve(worktree, pointer[1]!.trim());
    const commonDir = NodePath.resolve(
      gitDir,
      NodeFS.readFileSync(NodePath.join(gitDir, "commondir"), "utf8").trim(),
    );
    return {
      gitDir,
      writable: [
        gitDir,
        ...["objects", "refs", "logs", "packed-refs", "packed-refs.lock"].map((entry) =>
          NodePath.join(commonDir, entry),
        ),
      ],
    };
  } catch {
    return undefined;
  }
}

/**
 * How to run one shell command, `/bin/sh -c`, under the profile of Bob's commands, as a
 * workflow script's `exec` does: in `cwd`, which only workspace-write lets it change, and in a
 * linked worktree the git folders a commit writes, but never the files that say where its
 * repository is. It writes the temporary folders and the build tools' caches too, and reaches
 * other machines only when `network`, never this one. The profile goes as text, so no file of it
 * outlives the command. None where the host has no sandbox, or a place cannot be named in a
 * profile or runs through a symlink another sandbox could have made.
 */
export function commandSandboxSpawn(input: {
  readonly platform: NodeJS.Platform;
  readonly command: string;
  readonly cwd: string;
  readonly mode: BobSandboxMode;
  readonly network: boolean;
  /** The environment the command runs with: its home, `PATH` and temporary folder. */
  readonly environment: NodeJS.ProcessEnv;
  /** T3's caches and state. */
  readonly cacheDir: string;
  readonly stateDir: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  if (!bobSandboxAvailable(input.platform)) return undefined;
  const home = input.environment.HOME || NodeOS.homedir();
  const searchPath = input.environment.PATH;
  const temporaryFolders = sandboxTemporaryFolders(input.platform, input.environment);
  const git = input.mode === "workspace-write" ? worktreeGitFolders(input.cwd) : undefined;
  if (
    !nameable([
      input.cwd,
      home,
      input.cacheDir,
      input.stateDir,
      ...temporaryFolders,
      ...(searchPath?.split(":") ?? []),
      ...(git?.writable ?? []),
    ])
  ) {
    return undefined;
  }
  const workspace = bobWorkspace(input.cwd, home);
  if (workspace === undefined) return undefined;
  const profileInput = {
    mode: input.mode,
    workspace: [input.cwd, workspace] as const,
    home,
    privateFolders: [input.stateDir],
    temporaryFolders,
    searchPath,
    rules: {
      read: [],
      write: [...BUILD_CACHES.map((cache) => NodePath.join(home, cache)), ...(git?.writable ?? [])],
      private: [],
    },
    sandboxFolders: [input.cacheDir],
  };
  if (input.platform === "linux") {
    const files = sandboxFiles(input.cacheDir, input.network);
    if (files === undefined) return undefined;
    const denied = (path: string): BubblewrapRule => ({
      allow: false,
      match: { kind: "subpath", path },
    });
    const script = bubblewrapScript(
      {
        ...profileInput,
        write: [
          ...(input.mode === "read-only" ? [denied(workspace)] : []),
          ...(git === undefined
            ? []
            : ["commondir", "gitdir", "config.worktree"].map((file) =>
                denied(realPath(NodePath.join(git.gitDir, file))),
              )),
        ],
        // Caches and git's folders hold no project's secrets, and are too large to search.
        envFolders: [workspace],
      },
      files,
    );
    return {
      command: "/bin/sh",
      args: ["-c", script, "t3-bob-sandbox", "/bin/sh", "-c", input.command],
    };
  }
  const profile = bobSandboxProfile(profileInput);
  const pointers =
    git === undefined
      ? []
      : ["commondir", "gitdir", "config.worktree"].map(
          (file) => `(literal ${quote(realPath(NodePath.join(git.gitDir, file)))})`,
        );
  const text = `${profile}${
    input.mode === "read-only"
      ? `; The checkout, even inside a temporary folder the rules above let commands write.
(deny file-write* (subpath ${quote(workspace)}))
`
      : ""
  }${
    pointers.length === 0
      ? ""
      : `; The files that say where the worktree's repository is: rewritten, they could point git,
; which also runs outside the sandbox, at a configuration and hooks of a command's own.
(deny file-write*
  ${pointers.join("\n  ")})
`
  }${input.network ? OTHER_MACHINES : ""}`;
  return { command: SANDBOX_EXEC, args: ["-p", text, "/bin/sh", "-c", input.command] };
}

/**
 * The programs Bubblewrap's profile runs, from the system's own folders, never the `PATH` a user's
 * environment sets; none where one is missing or Bubblewrap cannot make namespaces here, as in a
 * container that forbids them. Probed once, and again a while after a probe that found none, so a
 * host where the user installs what is missing gets its sandbox without restarting T3.
 */
interface BubblewrapTools {
  readonly bwrap: string;
  readonly find: string;
  readonly mktemp: string;
  readonly readlink: string;
  readonly rm: string;
  readonly printenv: string;
  readonly arch: keyof typeof SECCOMP_ARCHES;
}
let bubblewrapProbe:
  | { readonly tools: BubblewrapTools; readonly missing?: undefined }
  | { readonly tools?: undefined; readonly missing: string; readonly at: number }
  | undefined;
const BUBBLEWRAP_REPROBE_MS = 30_000;

const SYSTEM_FOLDERS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function systemTool(name: string): string | undefined {
  return SYSTEM_FOLDERS.map((folder) => NodePath.join(folder, name)).find(
    (path) => executable(path) && NodeFS.statSync(path).isFile(),
  );
}

function bubblewrapTools(): BubblewrapTools | undefined {
  if (
    bubblewrapProbe?.tools !== undefined ||
    (bubblewrapProbe !== undefined && Date.now() - bubblewrapProbe.at < BUBBLEWRAP_REPROBE_MS)
  ) {
    return bubblewrapProbe.tools;
  }
  bubblewrapProbe = probeBubblewrap();
  return bubblewrapProbe.tools;
}

const WITHOUT_SANDBOX =
  "Without it, Bob asks before every command your rules don't allow, outside Full access, and writes no review guides.";

function probeBubblewrap(): NonNullable<typeof bubblewrapProbe> {
  const at = Date.now();
  const arch = HostProcess.Architecture.defaultValue();
  if (arch !== "x64" && arch !== "arm64") {
    return {
      at,
      missing: `Bob's sandbox on Linux needs an x86-64 or arm64 machine. ${WITHOUT_SANDBOX}`,
    };
  }
  const bwrap = systemTool("bwrap");
  if (bwrap === undefined) {
    return {
      at,
      missing: `Install Bubblewrap (the bubblewrap package) and pasta (the passt package) for Bob's sandbox. ${WITHOUT_SANDBOX}`,
    };
  }
  const names = ["find", "mktemp", "readlink", "rm", "printenv"] as const;
  const [find, mktemp, readlink, rm, printenv] = names.map(systemTool);
  if (
    find === undefined ||
    mktemp === undefined ||
    readlink === undefined ||
    rm === undefined ||
    printenv === undefined
  ) {
    return {
      at,
      missing: `Bob's sandbox needs ${names.join(", ")} in /usr/bin or /bin. ${WITHOUT_SANDBOX}`,
    };
  }
  const started = NodeChildProcess.spawnSync(
    bwrap,
    ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"],
    { stdio: "ignore", timeout: 10_000 },
  );
  if (started.status !== 0) {
    return {
      at,
      missing: `Bubblewrap could not start a sandbox here, as when unprivileged user namespaces are turned off; on Ubuntu 24.04 and later, AppArmor restricts them. ${WITHOUT_SANDBOX}`,
    };
  }
  return { tools: { bwrap, find, mktemp, readlink, rm, printenv, arch } };
}

/**
 * What this Linux host lacks for Bob's sandbox, or for the one review guides run in, which also
 * needs pasta, for Bob's provider status; none where nothing is missing or the host is not Linux.
 */
export function bobSandboxMissing(platform: NodeJS.Platform): string | undefined {
  if (platform !== "linux") return undefined;
  if (bubblewrapTools() === undefined) return bubblewrapProbe?.missing;
  if (systemTool("pasta") === undefined || systemTool("ip") === undefined) {
    return "Install pasta (the passt package) and ip (iproute2) for Bob to write review guides.";
  }
  return undefined;
}

/**
 * The calls a sandboxed command may not make, per architecture: creating a Unix socket, which
 * reaches Docker, tmux, the session's agents and T3 itself (`socketpair` still works, for pipes
 * between a command's own processes); io_uring, which makes sockets past this filter; and the
 * kernel's keyrings, which hold the session's keys.
 */
const SECCOMP_ARCHES = {
  x64: { audit: 0xc000003e, socket: 41, refused: [425, 426, 427, 248, 249, 250], x32: true },
  arm64: { audit: 0xc00000b7, socket: 198, refused: [425, 426, 427, 217, 218, 219], x32: false },
} as const;

/** The classic BPF program Bubblewrap loads with `--seccomp`: `EPERM` for the calls above. */
function seccompFilter(arch: keyof typeof SECCOMP_ARCHES): Buffer {
  const { audit, socket, refused, x32 } = SECCOMP_ARCHES[arch];
  const LOAD = 0x20; // BPF_LD | BPF_W | BPF_ABS
  const EQUALS = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
  const AT_LEAST = 0x35; // BPF_JMP | BPF_JGE | BPF_K
  const RETURN = 0x06; // BPF_RET | BPF_K
  type Label = "allow" | "refuse" | "unknown";
  const program: Array<{ code: number; k: number; yes?: Label; no?: Label }> = [];
  const labels = new Map<Label, number>();
  // The architecture, and on x86-64 no x32 calls, whose numbers differ.
  program.push({ code: LOAD, k: 4 }, { code: EQUALS, k: audit, no: "unknown" });
  program.push({ code: LOAD, k: 0 });
  if (x32) program.push({ code: AT_LEAST, k: 0x40000000, yes: "unknown" });
  for (const call of refused) program.push({ code: EQUALS, k: call, yes: "refuse" });
  // `socket(AF_UNIX, …)`: the low word of its first argument.
  program.push({ code: EQUALS, k: socket, no: "allow" });
  program.push({ code: LOAD, k: 16 }, { code: EQUALS, k: 1, yes: "refuse" });
  labels.set("allow", program.length);
  program.push({ code: RETURN, k: 0x7fff0000 });
  labels.set("refuse", program.length);
  program.push({ code: RETURN, k: 0x00050000 | 1 }); // EPERM
  labels.set("unknown", program.length);
  program.push({ code: RETURN, k: 0x00050000 | 38 }); // ENOSYS
  const filter = Buffer.alloc(program.length * 8);
  for (const [index, step] of program.entries()) {
    const jump = (label: Label | undefined) =>
      label === undefined ? 0 : labels.get(label)! - index - 1;
    filter.writeUInt16LE(step.code, index * 8);
    filter.writeUInt8(jump(step.yes), index * 8 + 2);
    filter.writeUInt8(jump(step.no), index * 8 + 3);
    filter.writeUInt32LE(step.k >>> 0, index * 8 + 4);
  }
  return filter;
}

/** A rule of a Bubblewrap profile: Seatbelt's, applied the same way, the last that matches. */
interface BubblewrapRule {
  readonly allow: boolean;
  readonly match: BobPathMatch;
}

/** Whether `match` covers `path`, compared as Linux compares names: exactly. */
function tester(match: BobPathMatch): (path: string) => boolean {
  if (match.kind === "regex") {
    const pattern = new RegExp(match.pattern, "u");
    return (path) => pattern.test(path);
  }
  if (match.kind === "literal") return (path) => path === match.path;
  const below = (root: string, path: string) => within(root, path) !== undefined;
  return (path) =>
    below(match.path, path) && !(match.except ?? []).some((root) => below(root, path));
}

function decider(rules: ReadonlyArray<BubblewrapRule>): (path: string) => boolean {
  const tests = rules.map((rule) => [rule.allow, tester(rule.match)] as const);
  return (path) => {
    let allowed = false;
    for (const [allow, test] of tests) if (test(path)) allowed = allow;
    return allowed;
  };
}

/** A string as one shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** A path as a `find -path` pattern that matches it alone. */
function findPattern(path: string): string {
  return shellQuote(path.replace(/[*?[\]\\]/g, "\\$&"));
}

/** The files the profile's script reads, from T3's caches, where no command writes. */
interface BubblewrapFiles {
  readonly tools: BubblewrapTools;
  /** A file no one may read, mounted over each one a command may not. */
  readonly denied: string;
  readonly seccomp: string;
  /** Where each run leaves Bubblewrap its arguments, for the moment it reads them. */
  readonly runs: string;
  /** Other machines, through pasta, for work that reaches the network. */
  readonly network?: BubblewrapNetwork | undefined;
}

interface BubblewrapNetwork {
  readonly pasta: string;
  readonly ip: string;
  /** Addresses of this machine, which no command may reach. */
  readonly routes: ReadonlyArray<string>;
  /** A `resolv.conf` naming pasta's resolver, and the file it covers. */
  readonly resolvConf: string;
  readonly resolvTarget: string | undefined;
}

/**
 * What glibc drops from the environment of a program that gains privileges, as pasta's child
 * does: the profile hands them to the command itself.
 */
const SECURE_EXEC_DROPPED = [
  "TMPDIR",
  "TZDIR",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCPATH",
  "NLSPATH",
  "GCONV_PATH",
  "GETCONF_DIR",
  "HOSTALIASES",
  "LOCALDOMAIN",
  "RES_OPTIONS",
  "RESOLV_HOST_CONF",
  "MALLOC_TRACE",
  "NIS_PATH",
];

/** pasta's address for this machine's resolver, which is all of it a command reaches. */
const PASTA_RESOLVER = "169.254.1.53";

/** Virtual bridges, whose machines are this one's containers. */
const LOCAL_BRIDGES = /^(docker|br-|virbr|podman|cni|lxcbr|lxdbr)/;

/**
 * Where pasta must not route: every address of this machine, which pasta's namespace would
 * otherwise reach as any other, and the containers behind its bridges. pasta's copy of the main
 * address, and its own loopback, stay inside the namespace.
 */
function localRoutes(): Array<string> {
  return Object.entries(NodeOS.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => !address.internal)
      .flatMap((address) => {
        const own = `${address.address.split("%")[0]}/${address.family === "IPv4" ? 32 : 128}`;
        return LOCAL_BRIDGES.test(name) && address.cidr !== null ? [own, address.cidr] : [own];
      }),
  );
}

/** What pasta needs, from the system's own folders; none where either is missing. */
function bubblewrapNetwork(cacheDir: string): BubblewrapNetwork | undefined {
  const pasta = systemTool("pasta");
  const ip = systemTool("ip");
  if (pasta === undefined || ip === undefined) return undefined;
  const resolvConf = NodePath.join(cacheDir, "bob-sandbox", "resolv.conf");
  writeOnce(resolvConf, `nameserver ${PASTA_RESOLVER}\n`, 0o644);
  let resolvTarget: string | undefined;
  try {
    resolvTarget = NodeFS.realpathSync("/etc/resolv.conf");
  } catch {
    // No resolver configured: names do not resolve, as outside.
  }
  return { pasta, ip, routes: localRoutes(), resolvConf, resolvTarget };
}

/** The profile's own files under T3's caches, written as `ensureBubblewrapFiles` checks them. */
function bubblewrapFiles(
  cacheDir: string,
  tools: BubblewrapTools,
): Omit<BubblewrapFiles, "network"> {
  const root = NodePath.join(cacheDir, "bob-sandbox");
  return {
    tools,
    denied: NodePath.join(root, "denied"),
    seccomp: NodePath.join(root, `seccomp-${tools.arch}.bpf`),
    runs: NodePath.join(root, "runs"),
  };
}

/** Whether the profile's own files hold what they should; `fix` writes any that do not. */
function bubblewrapFilesReady(files: Omit<BubblewrapFiles, "network">, fix: boolean): boolean {
  const filter = seccompFilter(files.tools.arch);
  let denied = false;
  try {
    const stat = NodeFS.lstatSync(files.denied);
    denied = stat.isFile() && stat.size === 0 && (stat.mode & 0o7777) === 0;
  } catch {
    // Not there yet.
  }
  let runs = false;
  try {
    runs = NodeFS.lstatSync(files.runs).isDirectory();
  } catch {
    // Not there yet.
  }
  const seccomp = holds(files.seccomp, filter);
  if (fix) {
    if (!seccomp) writeOnce(files.seccomp, filter, 0o644);
    if (!denied) {
      NodeFS.mkdirSync(NodePath.dirname(files.denied), { recursive: true });
      NodeFS.rmSync(files.denied, { recursive: true, force: true });
      NodeFS.writeFileSync(files.denied, "", { mode: 0 });
      NodeFS.chmodSync(files.denied, 0);
    }
    if (!runs) NodeFS.mkdirSync(files.runs, { recursive: true, mode: 0o700 });
  }
  return seccomp && denied && runs;
}

/** What `bubblewrapScript` takes: Seatbelt's profile's input, and the rules that follow it. */
type BubblewrapInput = Parameters<typeof bobSandboxProfile>[0] & {
  /** Rules after the commands' own, which outrank them. */
  readonly read?: ReadonlyArray<BubblewrapRule> | undefined;
  readonly write?: ReadonlyArray<BubblewrapRule> | undefined;
  /** The folders whose `.env` files each run finds; the workspace and the write rules' by default. */
  readonly envFolders?: ReadonlyArray<string> | undefined;
};

/**
 * The Bubblewrap profile for one workspace and mode: a script for `/bin/sh`, given the command
 * as its arguments, that runs it as `bobSandboxProfile`'s rules would.
 *
 * Bubblewrap mounts instead of matching, so the rules are applied to every path they name, and
 * each path whose reading or writing differs from its folder's gets a mount: a placeholder no one
 * reads over what a command may not read (an empty folder, or for a folder holding something it
 * may read, a folder it may pass through but not list, holding only that), and a read-only or
 * writable mount of itself where writing changes. Which of them exist is checked on each run.
 * What the rules match by name, the home folder's hidden entries, `.env` files and shell history,
 * is found on each run too. Every folder a command may not move is a mount, which no one can
 * move or remove, as Seatbelt's profile refuses to unlink them.
 *
 * Bubblewrap cannot refuse a name, so where Seatbelt stops a command creating a `.env` file, a
 * `.git` or an agent's settings folder that is not there yet, this does not (FORK.md, Known gaps).
 */
function bubblewrapScript(input: BubblewrapInput, files: BubblewrapFiles): string {
  const workspace = input.workspace[1];
  const home = realPath(input.home);
  const rules = rulesApplied(input.rules ?? NO_BOB_SANDBOX_RULES, {
    home: input.home,
    realHome: home,
    workspace: input.workspace,
  });
  const allow = (match: BobPathMatch): BubblewrapRule => ({ allow: true, match });
  const deny = (match: BobPathMatch): BubblewrapRule => ({ allow: false, match });
  const subpath = (path: string): BobPathMatch => ({ kind: "subpath", path });
  const opened = [...new Set([...rules.read, ...rules.write])];
  const userWritable = [...new Set(rules.write)];
  const temporary = [...new Set(input.temporaryFolders.map(realPath))];
  const onPath = (input.searchPath ?? "")
    .split(":")
    .filter((folder) => NodePath.isAbsolute(folder));
  const toolFolders = [
    ...new Set(onPath.map(realPath).filter((folder) => NodePath.basename(folder) === "bin")),
  ];
  const envRoots = [workspace, ...userWritable];
  const runtimeFolder = NodePath.join("/run/user", String(NodeOS.userInfo().uid));
  const readRules: Array<BubblewrapRule> = [
    allow(subpath("/")),
    deny({ kind: "regex", pattern: `^${regexQuote(home)}/\\.[^/]+` }),
    // The session's own folder: its agents' sockets, its keyring, Podman's registry logins.
    deny(subpath(runtimeFolder)),
    ...[...HOME_READABLE.map((entry) => NodePath.join(home, entry)), ...toolFolders, workspace].map(
      (path) => allow(subpath(path)),
    ),
    ...opened.map((path) => allow(subpath(path))),
    ...credentialMatches(home, opened).map(deny),
    ...envMatches(envRoots).map(deny),
    ...envRoots.map((root) =>
      allow({
        kind: "regex",
        pattern: `^${regexQuote(root)}/(.*/)?\\.env[^/]*\\.(example|sample|template|dist)$`,
      }),
    ),
    ...opened
      .filter((path) => NodePath.basename(path).startsWith(".env"))
      .map((path) => allow({ kind: "literal", path })),
    ...[...new Set([...rules.private, ...input.privateFolders].map(realPath))].map((path) =>
      deny(subpath(path)),
    ),
    ...(input.attachmentsFolder === undefined
      ? []
      : [allow(subpath(realPath(input.attachmentsFolder)))]),
    ...(input.read ?? []),
  ];
  const read = decider(readRules);
  const writeRules: Array<BubblewrapRule> = [
    deny(subpath("/")),
    ...(input.mode === "workspace-write" ? [workspace] : []).map((path) => allow(subpath(path))),
    ...[...temporary, ...userWritable].map((path) => allow(subpath(path))),
    ...writeDenials({
      home,
      workspace,
      rules,
      privateFolders: input.privateFolders,
      sandboxFolders: input.sandboxFolders ?? [],
      temporaryFolders: input.temporaryFolders,
    }).map(deny),
    ...(input.write ?? []),
  ];
  const write = decider(writeRules);
  // The folders a command may not move or remove, as Seatbelt's profile anchors them.
  const anchors = new Set<string>();
  for (const root of [
    workspace,
    ...userWritable,
    ...rules.private.map(realPath),
    ...input.privateFolders.map(realPath),
    ...(input.sandboxFolders ?? []).map(realPath),
  ]) {
    for (let path = root; path !== NodePath.dirname(path); path = NodePath.dirname(path)) {
      anchors.add(path);
    }
  }
  // Links on the way to a `PATH` folder, such as `~/.pulumi/current`, which a placeholder over
  // their folder keeps, so the tools behind them still run.
  const links = new Set<string>();
  for (const folder of onPath) {
    for (let path = folder; path !== NodePath.dirname(path); path = NodePath.dirname(path)) {
      try {
        if (NodeFS.lstatSync(path).isSymbolicLink()) links.add(path);
      } catch {
        // Not there.
      }
    }
  }
  // Every path a rule names, and the folders above it.
  const named = new Set<string>(["/"]);
  const name = (path: string) => {
    for (let at = path; !named.has(at); at = NodePath.dirname(at)) named.add(at);
  };
  const ruleMatches = [...readRules, ...writeRules].flatMap(({ match }) =>
    match.kind === "regex"
      ? []
      : [match.path, ...(match.kind === "subpath" ? (match.except ?? []) : [])],
  );
  for (const path of [...ruleMatches, ...anchors, ...links]) {
    if (NodePath.isAbsolute(path)) name(NodePath.normalize(path));
  }
  const children = new Map<string, Array<string>>();
  for (const path of [...named].toSorted()) {
    if (path === "/") continue;
    const parent = NodePath.dirname(path);
    children.set(parent, [...(children.get(parent) ?? []), path]);
  }
  const readableBelow = new Map<string, boolean>();
  const anyReadableBelow = (path: string): boolean => {
    const known = readableBelow.get(path);
    if (known !== undefined) return known;
    const found = (children.get(path) ?? []).some(
      (child) => read(child) || anyReadableBelow(child),
    );
    readableBelow.set(path, found);
    return found;
  };
  // How each path appears: writable, read-only, a folder showing only what is mounted in it, or
  // not at all.
  type Seen = "rw" | "ro" | "masked" | "absent";
  const seen = new Map<string, Seen>([["/", "ro"]]);
  const plan = (parent: string, indent: string): Array<string> => {
    const lines: Array<string> = [];
    const above = seen.get(parent)!;
    for (const path of children.get(parent) ?? []) {
      const quoted = shellQuote(path);
      let step: string | undefined;
      let now: Seen;
      if (above === "absent") {
        now = "absent";
      } else if (read(path)) {
        now = write(path) ? "rw" : "ro";
        const mount = now === "rw" ? "bind" : "ro-bind";
        if (above === "masked") step = `show ${mount} ${quoted}`;
        else if (now !== above || (now === "rw" && anchors.has(path))) {
          step = `bind ${mount} ${quoted}`;
        }
      } else if (anyReadableBelow(path) || links.has(path)) {
        now = "masked";
        step = above === "masked" ? `pass ${quoted}` : `mask ${quoted}`;
      } else {
        now = "absent";
        if (above !== "masked") step = `hide ${quoted}`;
      }
      seen.set(path, now);
      const inner = now === "absent" ? [] : plan(path, step === undefined ? indent : `${indent}  `);
      if (step === undefined) lines.push(...inner);
      else if (inner.length === 0) lines.push(`${indent}${step}`);
      else lines.push(`${indent}if ${step}; then`, ...inner, `${indent}fi`);
    }
    return lines;
  };
  const steps = plan("/", "");
  const visible = (path: string) => {
    const state = seen.get(path);
    return state === "rw" || state === "ro";
  };
  // Below the folders searched on each run, what the steps above already hid.
  const covered = (roots: ReadonlyArray<string>) =>
    [...named]
      .filter(
        (path) =>
          !visible(path) && roots.some((root) => path !== root && within(root, path) !== undefined),
      )
      .map((path) => `-path ${findPattern(path)}`);
  const pruned = (prunes: ReadonlyArray<string>) =>
    prunes.length === 0 ? "" : `\\( ${prunes.join(" -o ")} \\) -prune -o `;
  const { tools } = files;
  const runs = (script: string) => `-exec /bin/sh -c ${shellQuote(script)} "$denied" {} +`;
  const hideAll = `for f; do printf '%s\\0' --ro-bind "$0" "$f"; done`;
  const hideHistory = `for f; do n=\${f##*/}; n=\${n#.}; n=\${n%[Hh][Ii][Ss][Tt][Oo][Rr][Yy]}; case $n in *[!A-Za-z_]*) ;; *) printf '%s\\0' --ro-bind "$0" "$f";; esac; done`;
  const dynamic: Array<string> = [];
  // The home folder's hidden entries no rule names, unless a rule opens them all.
  if (visible(home) && !read(NodePath.join(home, ".t3-bob-sandbox\0"))) {
    const known = (children.get(home) ?? []).map(shellQuote);
    dynamic.push(
      `for f in ${shellQuote(home)}/.[!.]* ${shellQuote(home)}/..?*; do`,
      known.length === 0 ? "" : `  case $f in ${known.join("|")}) continue ;; esac`,
      `  hide "$f"`,
      "done",
    );
  }
  // Shell and REPL history at the top of the home folder, and in the hidden folders a command
  // reads, four folders deep.
  if (visible(home)) {
    const history = `${shellQuote(home)}/*[Hh][Ii][Ss][Tt][Oo][Rr][Yy]`;
    dynamic.push(
      `for f in ${history} ${history.replace("/*", "/.*")}; do`,
      `  [ -f "$f" ] && [ ! -L "$f" ] && /bin/sh -c ${shellQuote(hideHistory)} "$denied" "$f"`,
      "done",
    );
  }
  const historyRoots = [...named].filter((path) => {
    const fromHome = within(home, path);
    return (
      fromHome !== undefined &&
      fromHome.startsWith(".") &&
      visible(path) &&
      (NodePath.dirname(path) === home || !visible(NodePath.dirname(path)))
    );
  });
  if (historyRoots.length > 0) {
    dynamic.push(
      `LC_ALL=C ${tools.find} ${historyRoots.map(shellQuote).join(" ")} -maxdepth 4 ${pruned(covered(historyRoots))}-type f -name '*[Hh][Ii][Ss][Tt][Oo][Rr][Yy]' ${runs(hideHistory)} 2>/dev/null`,
    );
  }
  // `.env` files, but samples and those a rule names, wherever a command reads in the folders it
  // may write. Every one, `node_modules` included, since a command may move a folder there.
  const namedEnv = opened.filter((path) => NodePath.basename(path).startsWith(".env"));
  const envFolders = [...new Set(input.envFolders ?? envRoots)].filter(
    (root, _, all) =>
      visible(root) && !all.some((other) => other !== root && within(other, root) !== undefined),
  );
  if (envFolders.length > 0) {
    const prunes = [
      ...envFolders.map((root) => `-path ${findPattern(NodePath.join(root, ".git"))}`),
      ...covered(envFolders),
    ];
    const kept = [
      ...["example", "sample", "template", "dist"].map((kind) => `! -name '.env*.${kind}'`),
      ...namedEnv.map((path) => `! -path ${findPattern(path)}`),
    ];
    dynamic.push(
      `LC_ALL=C ${tools.find} ${envFolders.map(shellQuote).join(" ")} ${pruned(prunes)}-type f -name '.env*' ${kept.join(" ")} ${runs(hideAll)} 2>/dev/null`,
    );
  }
  if (files.network !== undefined) {
    dynamic.push(
      `for v in ${SECURE_EXEC_DROPPED.join(" ")}; do`,
      `  if value=$(${tools.printenv} "$v"); then a --setenv "$v" "$value"; fi`,
      "done",
    );
  }
  // The sockets T3's tmux and Bob's relays fall back to in the temporary folders.
  for (const folder of temporary.filter((path) => seen.get(path) === "rw")) {
    dynamic.push(
      `for f in ${shellQuote(folder)}/tmux-* ${shellQuote(folder)}/t3-bob-*; do bind ro-bind "$f"; done`,
    );
  }
  const network = files.network;
  const uid = NodeOS.userInfo().uid;
  const gid = NodeOS.userInfo().gid;
  const options = [
    "--unshare-all",
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    ...(network === undefined ? [] : ["--share-net", "--uid", String(uid), "--gid", String(gid)]),
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...(network?.resolvTarget === undefined
      ? []
      : ["--ro-bind", network.resolvConf, network.resolvTarget]),
    "--seccomp",
    "4",
  ];
  const start =
    network === undefined
      ? `exec 3<"$args" 4<${shellQuote(files.seccomp)} || exit 126
${tools.rm} -f "$args"
exec ${tools.bwrap} --args 3 -- "$@"`
      : `exec ${network.pasta} --config-net --quiet -t none -u none -T none -U none --no-map-gw --dns-forward ${PASTA_RESOLVER} -- /bin/sh -c ${shellQuote(
          `${[
            ...network.routes.map(
              (route) =>
                `${network.ip} ${route.includes(":") ? "-6 " : ""}route add prohibit ${route}`,
            ),
            "true",
          ].join(" && ")} || exit 126
exec 3<"$1" 4<"$2" || exit 126
${tools.rm} -f "$1"
shift 2
exec ${tools.bwrap} --args 3 -- "$@"`,
        )} t3-bob-network "$args" ${shellQuote(files.seccomp)} "$@"`;
  return `#!/bin/sh
# Bob's commands in T3 Code's ${input.mode} sandbox, under Bubblewrap. Run with the command.
denied=${shellQuote(files.denied)}
ok=1 remounts=
a() { printf '%s\\0' "$@" || ok=; }
# Over what a command may not read: an empty folder no one opens, or a file no one reads.
hide() {
  if [ -L "$1" ] || [ ! -e "$1" ]; then return 1; fi
  if [ -d "$1" ]; then a --perms 0000 --tmpfs "$1" --remount-ro "$1"; else a --ro-bind "$denied" "$1"; fi
}
# Over a folder holding something it may read: one it may pass through but not list.
mask() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    a --perms 0111 --tmpfs "$1"
    remounts="$remounts
$1"
  else
    hide "$1"
    return 1
  fi
}
# Inside such a folder: a folder on the way, a link as it is, and what it may read or write.
pass() {
  if [ -L "$1" ]; then a --symlink "$(${tools.readlink} "$1")" "$1"; return 1; fi
  if [ -d "$1" ]; then a --perms 0111 --dir "$1"; else return 1; fi
}
show() {
  if [ -L "$2" ]; then a --symlink "$(${tools.readlink} "$2")" "$2"; return 1; fi
  if [ -e "$2" ]; then a "--$1" "$2" "$2"; else return 1; fi
}
# Elsewhere, a path that may be written where its folder may not, or the other way round.
bind() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then a "--$1" "$2" "$2"; else return 1; fi
}
here=$(pwd -P) || exit 126
args=$(${tools.mktemp} ${shellQuote(NodePath.join(files.runs, "XXXXXXXXXX"))}) || exit 126
{
a ${options.map(shellQuote).join(" ")} --chdir "$here"
${steps.join("\n")}
${dynamic.filter((line) => line !== "").join("\n")}
set -f
IFS='
'
for f in $remounts; do a --remount-ro "$f"; done
} >"$args"
if [ -z "$ok" ]; then ${tools.rm} -f "$args"; exit 126; fi
${start}
`;
}

/** Whether a file holds exactly `content`. */
function holds(path: string, content: string | Buffer): boolean {
  try {
    return NodeFS.readFileSync(path).equals(Buffer.from(content));
  } catch {
    return false;
  }
}

/** Whether a file can be run; Bob falls back to `/bin/sh`, unsandboxed, when its shell cannot. */
function executable(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a file unless it already holds `content`, through a rename so no reader sees half, and
 * gives it `mode` either way.
 */
function writeOnce(path: string, content: string | Buffer, mode: number): void {
  try {
    if (NodeFS.readFileSync(path).equals(Buffer.from(content))) {
      NodeFS.chmodSync(path, mode);
      return;
    }
  } catch {
    // Not there yet.
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, content, { mode });
  NodeFS.renameSync(temporary, path);
}
