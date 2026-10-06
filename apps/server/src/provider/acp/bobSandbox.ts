// @effect-diagnostics nodeBuiltinImport:off
/**
 * The sandbox Bob's commands run in, outside Full access, as Codex runs its own.
 *
 * Bob runs every command as `$SHELL -c <command>`. T3 gives Bob a shell of its own, named like
 * the user's, that runs each command under macOS Seatbelt: it reads anywhere but the
 * credential folders, writes only in the workspace and the temporary folders (only the
 * temporary folders in Supervised) with `.git` and agent settings kept read-only, and reaches no
 * network. A command the user approved on a card, or that Auto's reviewer let out, runs outside
 * it once, by an approval T3 leaves for that exact command where commands in the sandbox cannot
 * write; no command sees where, nor T3's credentials.
 *
 * The base of the Seatbelt profile follows Codex's (openai/codex, Apache-2.0,
 * `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`).
 *
 * @module provider/acp/bobSandbox
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** What a sandboxed command may write: nothing but temporary files, or the workspace too. */
export type BobSandboxMode = "read-only" | "workspace-write";

export interface BobSandbox {
  /** Bob's environment overrides, which route its commands through the sandbox. */
  readonly environment: Readonly<Record<string, string>>;
  /** Whether the sandbox's shell is still in place; without it Bob would fall back to `/bin/sh`. */
  readonly ready: () => boolean;
  /** Lets the next run of this exact command run outside the sandbox; the approval's file. */
  readonly approveOutside: (command: string) => string;
  /**
   * Drops every approval but `keep`: a command run outside the sandbox runs as the user and
   * could otherwise leave approvals of its own.
   */
  readonly dropApprovals: (keep: ReadonlySet<string>) => void;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Whether this host can run Bob's commands in a sandbox. */
export function bobSandboxAvailable(platform: NodeJS.Platform): boolean {
  return platform === "darwin" && NodeFS.existsSync(SANDBOX_EXEC);
}

/**
 * The shell Bob runs commands with. Approved commands are matched by their exact text; anything
 * else, including any other way of calling this shell, runs in the sandbox.
 */
export const BOB_SANDBOX_SHELL = `#!/bin/sh
# T3 Code's shell for Bob: each command runs in the sandbox of the thread's permission mode,
# unless the user approved that exact command.
real="$T3_BOB_SHELL"
[ -x "$real" ] || real=/bin/sh
export SHELL="$real"
# No command, in the sandbox or out, gets T3's credentials or finds the approvals.
approvals="$T3_BOB_APPROVALS"
unset T3_ACP_MCP_AUTHORIZATION T3_ACP_MCP_ENDPOINT T3_BOB_APPROVALS
# Already inside the sandbox, which every child inherits.
if [ -n "$T3_BOB_IN_SANDBOX" ]; then exec "$real" "$@"; fi
if [ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ -n "$approvals" ] && [ -d "$approvals" ]; then
  for approval in "$approvals"/*; do
    [ -f "$approval" ] || continue
    if printf '%s' "$2" | cmp -s - "$approval" && rm "$approval" 2>/dev/null; then
      exec "$real" -c "$2"
    fi
  done
fi
export T3_BOB_IN_SANDBOX=1
exec ${SANDBOX_EXEC} -f "$T3_BOB_SANDBOX_PROFILE" "$real" "$@"
`;

function digest(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** A path as Seatbelt matches it: resolved, since `/tmp` is `/private/tmp` and so on. */
function realPath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

function quote(path: string): string {
  return JSON.stringify(path);
}

function regexQuote(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\/"]/g, "\\$&");
}

/**
 * Every tool keeps its credentials in a hidden folder or file of the home folder, or in Library,
 * so a sandboxed command reads none of those but the folders toolchains run from and read
 * their settings in.
 */
const HOME_READABLE = [
  ".local",
  ".config",
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
  ".claude",
  ".codex",
  ".gitconfig",
  ".gitignore_global",
  ".editorconfig",
  "Library/Application Support/go",
];
/** App data in Library, which holds browsers' cookies, mail and other apps' tokens. */
const LIBRARY_PRIVATE = [
  "Library/Application Support",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Cookies",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Accounts",
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
  "Library/Keychains",
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

/** The Seatbelt profile for one workspace and mode. */
export function bobSandboxProfile(input: {
  readonly mode: BobSandboxMode;
  readonly workspace: string;
  readonly home: string;
  /** T3's own state, which holds the user's data and secrets. */
  readonly privateFolders: ReadonlyArray<string>;
  readonly temporaryFolders: ReadonlyArray<string>;
  /** The `PATH` commands search, whose folders the shell may look in wherever they are. */
  readonly searchPath?: string | undefined;
}): string {
  const workspace = realPath(input.workspace);
  const home = realPath(input.home);
  const hidden = [
    `(regex #"^${regexQuote(home)}/\\.[^/]+")`,
    `(regex #"^${regexQuote(home)}/Library/Preferences/\\.[^/]+")`,
    ...LIBRARY_PRIVATE.map((folder) => `(subpath ${quote(NodePath.join(home, folder))})`),
  ];
  // A command searching PATH, such as Node's spawn, gives up at the first folder it may not look
  // in, through symlinks too, so it may look along each. It reads in those named `bin`, to run
  // the tools there, but not in others, such as `~/.turso`, which holds its credentials.
  const onPath = (input.searchPath ?? "")
    .split(":")
    .filter((folder) => NodePath.isAbsolute(folder));
  const searchable = new Set(
    onPath.flatMap((folder) => {
      const ancestors = [];
      for (let path = NodePath.dirname(folder); path !== NodePath.dirname(path);) {
        ancestors.push(`(literal ${quote(path)})`);
        path = NodePath.dirname(path);
      }
      return [`(subpath ${quote(folder)})`, `(subpath ${quote(realPath(folder))})`, ...ancestors];
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
  const unreadable = [
    ...HOME_SECRETS.map((folder) => `(subpath ${quote(NodePath.join(home, folder))})`),
    ...HOME_SECRET_FILES.map((file) => `(literal ${quote(NodePath.join(home, file))})`),
    // Shell and REPL history, which holds whatever was typed, tokens included.
    `(regex #"^${regexQuote(home)}/\\.[A-Za-z_]*history$")`,
    ...input.privateFolders.map((folder) => `(subpath ${quote(realPath(folder))})`),
  ];
  const writable =
    input.mode === "workspace-write"
      ? [workspace, ...input.temporaryFolders.map(realPath)]
      : input.temporaryFolders.map(realPath);
  const protectedPaths = WORKSPACE_PROTECTED.map(
    (name) => `(subpath ${quote(NodePath.join(workspace, name))})`,
  );
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
(deny file-read*
  ${unreadable.join("\n  ")})

; Writes only where the mode allows, never to the workspace's git or agent settings.
${
  writable.length > 0
    ? `(allow file-write*\n  ${writable.map((path) => `(subpath ${quote(path)})`).join("\n  ")})`
    : ""
}
(deny file-write*
  ${protectedPaths.join("\n  ")}
  (regex #"^${regexQuote(workspace)}/(.*/)?\\.env[^/]*$")
  (literal ${quote(NodePath.join(workspace, ".mcp.json"))}))

; No network: what reaches out needs the user's approval.
`;
}

/**
 * Sets up the sandbox for a Bob runtime: the shell, written into T3's caches once per version,
 * the profile for its workspace and mode, and the folder approvals go to, under T3's state.
 * None where this host has no sandbox.
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
  /** Names the approvals folder, which a Bob kept running in tmux finds again after a restart. */
  readonly key: string;
  readonly temporaryFolders: ReadonlyArray<string>;
  /** The `PATH` Bob's commands search. */
  readonly searchPath?: string | undefined;
}): BobSandbox | undefined {
  if (!bobSandboxAvailable(input.platform)) return undefined;
  const realShell =
    input.shell && NodePath.isAbsolute(input.shell) && !input.shell.includes("bob-sandbox")
      ? input.shell
      : "/bin/sh";
  const root = NodePath.join(input.cacheDir, "bob-sandbox");
  // Named like the user's shell, since Bob tells its model the shell's name.
  const shell = NodePath.join(root, digest(BOB_SANDBOX_SHELL), NodePath.basename(realShell));
  const profileText = bobSandboxProfile({
    mode: input.mode,
    workspace: input.workspace,
    home: input.home,
    privateFolders: [input.stateDir],
    temporaryFolders: input.temporaryFolders,
    searchPath: input.searchPath,
  });
  const profile = NodePath.join(root, "profiles", `${digest(profileText)}.sb`);
  const approvals = NodePath.join(input.stateDir, "bob-sandbox", "approvals", digest(input.key));
  const ensure = () => {
    writeOnce(shell, BOB_SANDBOX_SHELL, 0o755);
    writeOnce(profile, profileText, 0o644);
    NodeFS.mkdirSync(approvals, { recursive: true, mode: 0o700 });
  };
  ensure();
  return {
    environment: {
      SHELL: shell,
      T3_BOB_SHELL: realShell,
      T3_BOB_SANDBOX_PROFILE: profile,
      T3_BOB_APPROVALS: approvals,
    },
    ready: () => NodeFS.existsSync(shell) && NodeFS.existsSync(profile),
    approveOutside: (command) => {
      ensure();
      const approval = NodePath.join(approvals, NodeCrypto.randomUUID());
      NodeFS.writeFileSync(approval, command, { mode: 0o600 });
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

/** Writes a file unless it already holds `content`, through a rename so no reader sees half. */
function writeOnce(path: string, content: string, mode: number): void {
  try {
    if (NodeFS.readFileSync(path, "utf8") === content) return;
  } catch {
    // Not there yet.
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporary, content, { mode });
  NodeFS.renameSync(temporary, path);
}
