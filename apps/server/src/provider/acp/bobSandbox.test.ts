// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  bobProcessSandboxSpawn,
  bobSandboxAvailable,
  bobSandboxFolderSuggestion,
  commandSandboxSpawn,
  makeBobSandbox,
  NO_BOB_SANDBOX_RULES,
  type BobSandboxMode,
} from "./bobSandbox.ts";

const available = bobSandboxAvailable(HostProcess.Platform.defaultValue());
/**
 * Bubblewrap's sandbox, which refuses what is there rather than names: a file it hides reads as
 * `EACCES` and one it keeps read-only writes as `EROFS`, where Seatbelt says `EPERM` to both.
 */
const linux = HostProcess.Platform.defaultValue() === "linux";
const unreadable = linux ? "EACCES" : "EPERM";
const unwritable = linux ? "EROFS" : "EPERM";
/** macOS's python3 can call the system's file functions, which the folder-clone test needs. */
const pythonAvailable =
  NodeChildProcess.spawnSync("/usr/bin/python3", [
    "-c",
    "import ctypes; ctypes.CDLL(None).clonefile",
  ]).status === 0;
// Linux's `/tmp` is a temporary folder every sandbox writes, so there the tests work beside them.
const root = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(linux ? process.cwd() : NodeOS.tmpdir(), ".vitest-bob-sb-")),
);
// Probe scripts there are CommonJS, whatever the package beside them says.
NodeFS.writeFileSync(NodePath.join(root, "package.json"), "{}");
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

/**
 * `t3Home`, under the test's folder, puts T3's state and caches outside the home folder; with
 * `t3HomeVia`, T3 is given them through a symlink of that name. `workspace` is the project's
 * folder under the test's folder, `workspace` unless given.
 */
function setUp(
  mode: BobSandboxMode,
  options: {
    readonly t3Home?: string;
    readonly t3HomeVia?: string;
    readonly workspace?: string;
  } = {},
) {
  const base = NodeFS.mkdtempSync(NodePath.join(root, `${mode}-`));
  const home = NodePath.join(base, "home");
  const workspace = NodePath.join(base, options.workspace ?? "workspace");
  let t3Home = NodePath.join(base, options.t3Home ?? "");
  if (options.t3HomeVia !== undefined) {
    NodeFS.mkdirSync(t3Home, { recursive: true });
    NodeFS.symlinkSync(t3Home, NodePath.join(base, options.t3HomeVia));
    t3Home = NodePath.join(base, options.t3HomeVia);
  }
  const stateDir = NodePath.join(t3Home, "state");
  const attachmentsDir = NodePath.join(stateDir, "attachments");
  for (const folder of [
    NodePath.join(home, ".ssh"),
    NodePath.join(workspace, ".git"),
    stateDir,
    attachmentsDir,
  ]) {
    NodeFS.mkdirSync(folder, { recursive: true });
  }
  // A file the user attached in a thread, beside T3's own private state.
  NodeFS.writeFileSync(NodePath.join(attachmentsDir, "notes.txt"), "attached notes");
  NodeFS.writeFileSync(NodePath.join(stateDir, "statev2.sqlite"), "private state");
  NodeFS.writeFileSync(NodePath.join(home, ".ssh", "id_ed25519"), "secret");
  NodeFS.writeFileSync(NodePath.join(home, ".npmrc"), "//registry/:_authToken=secret");
  NodeFS.writeFileSync(NodePath.join(home, ".zsh_history"), "export TOKEN=secret");
  // A tool's credentials in a hidden folder no list names, and a toolchain's own folders.
  NodeFS.mkdirSync(NodePath.join(home, ".vercel"));
  NodeFS.writeFileSync(NodePath.join(home, ".vercel", "auth.json"), '{"token":"secret"}');
  NodeFS.mkdirSync(NodePath.join(home, ".config", "gh"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".config", "gh", "hosts.yml"), "oauth_token: secret");
  NodeFS.writeFileSync(NodePath.join(home, ".gitconfig"), "[user]\n\tname = Bob\n");
  // Credentials and history beside the settings toolchains read.
  NodeFS.mkdirSync(NodePath.join(home, ".config", "git"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".config", "git", "ignore"), "*.log\n");
  NodeFS.writeFileSync(NodePath.join(home, ".config", "git", "credentials"), "https://u:secret@h");
  NodeFS.mkdirSync(NodePath.join(home, ".local", "share", "fish"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".local", "share", "fish", "fish_history"), "secret");
  NodeFS.mkdirSync(NodePath.join(home, ".m2"));
  NodeFS.writeFileSync(NodePath.join(home, ".m2", "settings.xml"), "<password>secret</password>");
  NodeFS.mkdirSync(NodePath.join(home, ".local", "bin"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".local", "bin", "tool"), "#!/bin/sh\necho tool ran\n", {
    mode: 0o755,
  });
  // Tools on PATH, through a symlink, whose hidden folder also holds their credentials.
  NodeFS.mkdirSync(NodePath.join(home, ".pulumi", "v1", "bin"), { recursive: true });
  NodeFS.symlinkSync("v1", NodePath.join(home, ".pulumi", "current"));
  NodeFS.writeFileSync(NodePath.join(home, ".pulumi", "credentials.json"), '{"token":"secret"}');
  NodeFS.writeFileSync(
    NodePath.join(home, ".pulumi", "v1", "bin", "pulumi"),
    "#!/bin/sh\necho pulumi ran\n",
    { mode: 0o755 },
  );
  NodeFS.mkdirSync(NodePath.join(home, ".turso"));
  NodeFS.writeFileSync(NodePath.join(home, ".turso", "settings.json"), '{"token":"secret"}');
  const searchPath = [
    NodePath.join(home, ".turso"),
    NodePath.join(home, ".pulumi", "current", "bin"),
    "/usr/bin",
    "/bin",
  ].join(":");
  const opening = {
    mode,
    workspace,
    home,
    platform: HostProcess.Platform.defaultValue(),
    shell: "/bin/zsh",
    cacheDir: NodePath.join(t3Home, "caches"),
    stateDir,
    attachmentsDir,
    key: workspace,
    temporaryFolders: [NodePath.join(base, "tmp")],
    searchPath,
  };
  const sandbox = makeBobSandbox(opening)!;
  /** Opens the sandbox again, as a T3 that restarted does, in `workspace` if given. */
  const reopen = (folder = workspace) => makeBobSandbox({ ...opening, workspace: folder });
  NodeFS.mkdirSync(NodePath.join(base, "tmp"));
  /** Runs a command as Bob does, `$SHELL -c <command>`; its exit code. */
  const run = (command: string) =>
    NodeChildProcess.spawnSync(sandbox.environment.SHELL!, ["-c", command], {
      cwd: workspace,
      env: {
        ...process.env,
        ...sandbox.environment,
        PATH: searchPath,
        T3_ACP_MCP_AUTHORIZATION: "Bearer t",
      },
      encoding: "utf8",
    });
  return { base, home, workspace, stateDir, attachmentsDir, sandbox, run, reopen };
}

describe.skipIf(!available)("makeBobSandbox", () => {
  it("gives no sandbox, so every command asks, to a folder Seatbelt cannot name", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-quote-"));
    // A quote, a control character, or a lone surrogate the profile language cannot spell.
    for (const [workspace, stateDir] of [
      [NodePath.join(base, 'say "hi"'), NodePath.join(base, "state")],
      [NodePath.join(base, "workspace"), NodePath.join(base, "st\u0001ate")],
      [NodePath.join(base, "work\ud800space"), NodePath.join(base, "state")],
    ] as const) {
      expect(
        makeBobSandbox({
          mode: "workspace-write",
          workspace,
          home: base,
          platform: HostProcess.Platform.defaultValue(),
          shell: "/bin/zsh",
          cacheDir: NodePath.join(base, "caches"),
          stateDir,
          key: "quoted",
          temporaryFolders: [],
        }),
        workspace,
      ).toBeUndefined();
    }
  });

  it("keeps history, cookies, app settings and T3's sockets away from commands", () => {
    const { base, home, workspace, sandbox, run } = setUp("workspace-write");
    for (const [path, text] of [
      [".cache/zsh/history", "secret"],
      ["Library/HTTPStorages/com.app/httpstorages.sqlite", "cookie"],
    ] as const) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(home, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, path), text);
      expect(run(`cat ${NodePath.join(home, path)}`).stdout, path).toBe("");
    }
    // A project's own file of that name stays readable.
    NodeFS.writeFileSync(NodePath.join(workspace, "history"), "notes\n");
    expect(run("cat history").stdout).toBe("notes\n");
    // A rule opening Library for writing still leaves the settings apps run commands from.
    NodeFS.mkdirSync(NodePath.join(home, "Library", "Preferences"), { recursive: true });
    sandbox.update({ read: [], write: [NodePath.join(home, "Library")], private: [] });
    expect(
      run(`touch ${NodePath.join(home, "Library", "Preferences", "x.plist")}`).status,
    ).not.toBe(0);
    expect(run(`touch ${NodePath.join(home, "Library", "notes.txt")}`).status).toBe(0);
    // The temp folders stay writable, but not the sockets T3's tmux and Bob's relays fall back to.
    const tmp = NodePath.join(base, "tmp");
    if (linux) {
      // Bubblewrap keeps those that are there.
      NodeFS.mkdirSync(NodePath.join(tmp, "tmux-501"));
      NodeFS.writeFileSync(NodePath.join(tmp, "t3-bob-0123"), "");
    }
    expect(run(`touch ${NodePath.join(tmp, "plain.txt")}`).status).toBe(0);
    expect(run(`mkdir -p ${tmp}/tmux-501 && touch ${tmp}/tmux-501/default`).status).not.toBe(0);
    expect(run(`touch ${NodePath.join(tmp, "t3-bob-0123")}`).status).not.toBe(0);
  });

  it("lets commands write only in the workspace, away from git, and read no secrets", () => {
    const { base, home, workspace, sandbox, run } = setUp("workspace-write");
    expect(NodePath.basename(sandbox.environment.SHELL!)).toBe("zsh");
    expect(run("echo hi > made.txt").status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(workspace, "made.txt"), "utf8")).toBe("hi\n");
    expect(run(`echo hi > ${NodePath.join(base, "tmp", "t.txt")}`).status).toBe(0);
    expect(run("echo x > .git/config").status).not.toBe(0);
    // Bubblewrap holds only the `.env` files that are there (FORK.md, Known gaps).
    if (linux) NodeFS.writeFileSync(NodePath.join(workspace, ".env"), "SECRET=1");
    expect(run("echo x > .env").status).not.toBe(0);
    expect(run(`echo x > ${NodePath.join(home, "escaped.txt")}`).status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(home, "escaped.txt"))).toBe(false);
    for (const secret of [
      ".ssh/id_ed25519",
      ".npmrc",
      ".zsh_history",
      ".vercel/auth.json",
      ".config/gh/hosts.yml",
      ".pulumi/credentials.json",
      ".turso/settings.json",
      ".config/git/credentials",
      ".local/share/fish/fish_history",
      ".m2/settings.xml",
    ]) {
      expect(run(`cat ${NodePath.join(home, secret)}`).stdout, secret).toBe("");
    }
    // Interpreters read through the same profile.
    const readVercel = `${JSON.stringify(process.execPath)} -e "process.stdout.write(require('fs').readFileSync('${NodePath.join(home, ".vercel", "auth.json")}', 'utf8'))"`;
    expect(run(readVercel).stdout).toBe("");
    // Toolchains still run from, and read settings in, the folders they need.
    expect(run(NodePath.join(home, ".local", "bin", "tool")).stdout).toBe("tool ran\n");
    expect(run(`cat ${NodePath.join(home, ".gitconfig")}`).stdout).toContain("Bob");
    expect(run(`cat ${NodePath.join(home, ".config", "git", "ignore")}`).stdout).toBe("*.log\n");
    // Commands find tools past hidden folders on PATH, and run those in their `bin`.
    expect(run("pulumi").stdout).toBe("pulumi ran\n");
    const spawnLs = `${JSON.stringify(process.execPath)} -e "process.stdout.write(require('child_process').execFileSync('ls'))"`;
    expect(run(spawnLs).stdout).toContain("made.txt");
    // T3's credentials stay out of the command's environment.
    expect(run("printenv T3_ACP_MCP_AUTHORIZATION").stdout).toBe("");
    // A shell the command starts is the user's, still inside the sandbox.
    expect(run(`$SHELL -c 'echo x > ${NodePath.join(home, "nested.txt")}'`).status).not.toBe(0);
    expect(sandbox.ready()).toBe(true);
  });

  it("keeps .git read-only even through a move into a temporary folder", () => {
    const { base, workspace, run } = setUp("workspace-write");
    const moved = NodePath.join(base, "tmp", "moved");
    expect(run(`mv ${workspace} ${moved}`).status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(workspace, ".git"))).toBe(true);
    // Folders inside the workspace still move and go.
    expect(run("mkdir -p a/b && mv a c && rm -rf c").status).toBe(0);
  });

  it("applies the user's rules to the next command", () => {
    const { home, workspace, sandbox, run } = setUp("workspace-write");
    const vercel = NodePath.join(home, ".vercel", "auth.json");
    const outside = NodePath.join(home, "builds");
    NodeFS.mkdirSync(outside);
    NodeFS.writeFileSync(NodePath.join(workspace, "notes.txt"), "private");
    expect(run(`cat ${vercel}`).stdout).toBe("");
    sandbox.update({
      read: [NodePath.join(home, ".vercel")],
      write: [outside],
      private: [NodePath.join(workspace, "notes.txt")],
    });
    expect(run(`cat ${vercel}`).stdout).toContain("secret");
    expect(run(`echo hi > ${NodePath.join(outside, "out.txt")}`).status).toBe(0);
    expect(run("cat notes.txt").stdout).toBe("");
    expect(run("echo x > notes.txt").status).not.toBe(0);
    // A writable folder stays where it is.
    expect(run(`mv ${outside} ${NodePath.join(home, "elsewhere")}`).status).not.toBe(0);
    sandbox.update({ read: [], write: [], private: [] });
    expect(run(`cat ${vercel}`).stdout).toBe("");
    expect(run("cat notes.txt").stdout).toBe("private");
  });

  it("keeps a private folder closed whatever characters its name holds", () => {
    const { workspace, sandbox, run } = setUp("workspace-write");
    NodeFS.writeFileSync(NodePath.join(workspace, "open.txt"), "open");
    // Seatbelt reads neither JSON's \\u escapes nor \\b or \\f, so these name other paths unless
    // the profile spells them its own way.
    for (const name of ["se\u0001cret", "back\bspace", "form\ffeed", 'say "hi"\\x']) {
      const folder = NodePath.join(workspace, name);
      NodeFS.mkdirSync(folder);
      NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "private");
      expect(run(`cat '${NodePath.join(folder, "notes.txt")}'`).stdout, name).toBe("private");
      sandbox.update({ read: [], write: [], private: [folder] });
      // The raw name in single quotes, as the shell takes it.
      expect(run(`cat '${NodePath.join(folder, "notes.txt")}'`).stdout, name).toBe("");
      // A profile that does not parse denies everything: the rest still reads.
      expect(run("cat open.txt").stdout, name).toBe("open");
    }
  });

  it("keeps T3's folders in place inside a folder a rule lets commands write in", () => {
    // Also when T3 is given its home through a symlink.
    for (const via of [undefined, "t3-link"]) {
      const { base, sandbox, run } = setUp("workspace-write", {
        t3Home: "srv/t3",
        ...(via === undefined ? {} : { t3HomeVia: via }),
      });
      const srv = NodePath.join(base, "srv");
      sandbox.update({ read: [], write: [srv], private: [] });
      // Swapping T3's home for a folder of the command's would hand it the sandbox's own shell.
      run(`mv '${NodePath.join(srv, "t3")}' '${NodePath.join(srv, "t3-moved")}'`);
      expect(NodeFS.existsSync(NodePath.join(srv, "t3", "caches")), via).toBe(true);
      // The rule still lets commands move what is theirs there.
      NodeFS.mkdirSync(NodePath.join(srv, "mine"));
      expect(
        run(`mv '${NodePath.join(srv, "mine")}' '${NodePath.join(srv, "moved")}'`).status,
        via,
      ).toBe(0);
    }
  });

  it("never follows a symlink a command could have made at a rule's folder", () => {
    const { base, home, workspace, sandbox, run } = setUp("read-only");
    const agents = NodePath.join(home, "Library", "LaunchAgents");
    NodeFS.mkdirSync(agents, { recursive: true });
    const dist = NodePath.join(workspace, "dist");
    // A fresh worktree has no `dist` yet: the rule lets commands create it, as a symlink too.
    // Bubblewrap opens only a rule's folder that is there, so there another sandbox makes it.
    const link = (target: string, at: string) => {
      if (!linux) return run(`ln -s '${target}' '${at}'`).status;
      NodeFS.symlinkSync(target, at);
      return 0;
    };
    const rules = { read: [], write: [dist], private: [] };
    sandbox.update(rules);
    expect(link(agents, dist)).toBe(0);
    // The next turn rebuilds the profile.
    sandbox.update(rules);
    run("echo pwned > dist/evil.plist");
    expect(NodeFS.existsSync(NodePath.join(agents, "evil.plist"))).toBe(false);
    // Nor at a rule's folder outside the workspace, which the rule itself lets commands make.
    const out = NodePath.join(base, "out");
    sandbox.update({ read: [], write: [out], private: [] });
    expect(link(agents, out)).toBe(0);
    sandbox.update({ read: [], write: [out], private: [] });
    run(`echo pwned > '${NodePath.join(out, "evil.plist")}'`);
    expect(NodeFS.existsSync(NodePath.join(agents, "evil.plist"))).toBe(false);
    // Nor through a link this sandbox never let commands make, as another thread's could have.
    const shared = NodePath.join(base, "shared");
    NodeFS.mkdirSync(shared);
    NodeFS.symlinkSync(NodePath.join(home, ".local"), NodePath.join(shared, "tools"));
    NodeFS.symlinkSync(NodePath.join(home, ".ssh"), NodePath.join(shared, "keys"));
    sandbox.update({
      read: [NodePath.join(shared, "keys")],
      write: [NodePath.join(shared, "tools", "bin")],
      private: [],
    });
    run(`echo pwned > '${NodePath.join(shared, "tools", "bin", "git")}'`);
    expect(NodeFS.existsSync(NodePath.join(home, ".local", "bin", "git"))).toBe(false);
    expect(run(`cat '${NodePath.join(shared, "keys", "id_ed25519")}'`).stdout).toBe("");
    // A read rule is not pointed at a credential store that way either.
    NodeFS.symlinkSync(NodePath.join(home, ".ssh"), NodePath.join(workspace, "docs"));
    sandbox.update({ ...rules, read: [NodePath.join(workspace, "docs")] });
    expect(run("cat docs/id_ed25519").stdout).toBe("");
    // A real folder there, or one still to come, is the rule's.
    NodeFS.rmSync(dist);
    NodeFS.mkdirSync(dist);
    const build = NodePath.join(workspace, "build", "out");
    sandbox.update({ read: [], write: [dist, build], private: [] });
    expect(run("touch dist/app.js").status).toBe(0);
    NodeFS.mkdirSync(build, { recursive: true });
    expect(run("touch build/out/app.js").status).toBe(0);
  });

  it("keeps a nested project's sandbox where it was when another sandbox swaps its folder", () => {
    const { home, workspace, sandbox, run, reopen } = setUp("workspace-write", {
      workspace: "main/packages/app",
    });
    // Thread B, sandboxed in `main`, moves the folder aside and links `~/.local` in its place.
    NodeFS.renameSync(workspace, `${workspace}.old`);
    NodeFS.symlinkSync(NodePath.join(home, ".local"), workspace);
    // The next turn rebuilds the profile, which still names the folder that was there.
    sandbox.update(NO_BOB_SANDBOX_RULES);
    run(`echo pwned > '${NodePath.join(workspace, "bin", "git")}'`);
    expect(NodeFS.existsSync(NodePath.join(home, ".local", "bin", "git"))).toBe(false);
    // A sandbox opened now, as after a restart, gets none, so commands ask.
    expect(reopen()).toBeUndefined();
  });

  it("follows a link straight in the home folder, as to projects on another disk", () => {
    const { base, home, sandbox, run, reopen } = setUp("workspace-write");
    const disk = NodePath.join(base, "disk");
    NodeFS.mkdirSync(NodePath.join(disk, "project"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(disk, "cache"));
    NodeFS.symlinkSync(disk, NodePath.join(home, "code"));
    // A rule through it applies.
    sandbox.update({ read: [], write: [NodePath.join(home, "code", "cache")], private: [] });
    expect(run(`touch '${NodePath.join(home, "code", "cache", "x")}'`).status).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(disk, "cache", "x"))).toBe(true);
    // And a project there gets a sandbox, also through a link to that link.
    expect(reopen(NodePath.join(home, "code", "project"))).toBeDefined();
    NodeFS.symlinkSync("code", NodePath.join(home, "c2"));
    expect(reopen(NodePath.join(home, "c2", "project"))).toBeDefined();
  });

  it("walks where a link in the home folder leads as strictly, so one swapped in there leads nowhere", () => {
    const { base, home, sandbox, run, reopen } = setUp("workspace-write");
    // `~/app` leads into another project's folder, which a sandbox there can swap.
    const app = NodePath.join(base, "main", "packages", "app");
    NodeFS.mkdirSync(app, { recursive: true });
    NodeFS.symlinkSync(app, NodePath.join(home, "app"));
    expect(reopen(NodePath.join(home, "app"))).toBeDefined();
    NodeFS.renameSync(app, `${app}.old`);
    NodeFS.symlinkSync(NodePath.join(home, ".local"), app);
    expect(reopen(NodePath.join(home, "app"))).toBeUndefined();
    // A rule on `~/cache`, which leads to a shared folder, likewise.
    const shared = NodePath.join(base, "shared", "cache");
    NodeFS.mkdirSync(shared, { recursive: true });
    NodeFS.symlinkSync(shared, NodePath.join(home, "cache"));
    const rules = { read: [], write: [NodePath.join(home, "cache")], private: [] };
    sandbox.update(rules);
    expect(run(`touch '${NodePath.join(home, "cache", "x")}'`).status).toBe(0);
    NodeFS.rmSync(shared, { recursive: true });
    NodeFS.symlinkSync(NodePath.join(home, ".local"), shared);
    sandbox.update(rules);
    run(`echo pwned > '${NodePath.join(home, "cache", "bin", "git")}'`);
    expect(NodeFS.existsSync(NodePath.join(home, ".local", "bin", "git"))).toBe(false);
  });

  it("keeps a private folder closed when a command renames the folder holding it", () => {
    const { workspace, sandbox, run } = setUp("workspace-write");
    const secret = NodePath.join(workspace, "config", "secret");
    NodeFS.mkdirSync(secret, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(secret, "key.json"), "secret");
    sandbox.update({ read: [], write: [], private: [secret] });
    run("mv config cfg2");
    expect(run("cat cfg2/secret/key.json").stdout).toBe("");
    expect(NodeFS.existsSync(NodePath.join(secret, "key.json"))).toBe(true);
  });

  it("keeps a subfolder's .env closed after a command moves it to a temporary folder", () => {
    const { base, workspace, run } = setUp("workspace-write");
    NodeFS.mkdirSync(NodePath.join(workspace, "svc"));
    NodeFS.writeFileSync(NodePath.join(workspace, "svc", ".env"), "SECRET=1");
    const moved = NodePath.join(base, "tmp", "svc");
    // Under Bubblewrap the move fails at the `.env` file, which `mv` cannot copy, and leaves it.
    expect(run(`mv svc '${moved}'`).status === 0).toBe(!linux);
    expect(run(`cat '${NodePath.join(moved, ".env")}'`).stdout).toBe("");
    if (linux) expect(NodeFS.existsSync(NodePath.join(workspace, "svc", ".env"))).toBe(true);
  });

  it("keeps a credential store closed where its link leads", () => {
    const { base, home, sandbox, run } = setUp("workspace-write");
    const dotfiles = NodePath.join(base, "dotfiles", "aws");
    NodeFS.mkdirSync(dotfiles, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dotfiles, "credentials"), "secret");
    NodeFS.symlinkSync(dotfiles, NodePath.join(home, ".aws"));
    sandbox.update(NO_BOB_SANDBOX_RULES);
    expect(run(`cat '${NodePath.join(dotfiles, "credentials")}'`).stdout).toBe("");
  });

  it.skipIf(!pythonAvailable)(
    "clones files but no folder, which would copy what it holds unread",
    () => {
      const { base, home, workspace, run } = setUp("workspace-write");
      // A folder clone copies everything below the folder without a read of each file.
      const clone = (from: string, to: string) =>
        run(
          `/usr/bin/python3 -c 'import ctypes, sys; sys.exit(ctypes.CDLL(None).clonefile(sys.argv[1].encode(), sys.argv[2].encode(), 0))' '${from}' '${to}'`,
        );
      const copied = NodePath.join(base, "tmp", "h");
      expect(clone(home, copied).status).not.toBe(0);
      expect(NodeFS.existsSync(copied)).toBe(false);
      expect(clone(workspace, NodePath.join(base, "tmp", "w")).status).not.toBe(0);
      // A file clone, as `cp -c` makes, still works.
      NodeFS.writeFileSync(NodePath.join(workspace, "notes.md"), "notes");
      const file = NodePath.join(base, "tmp", "notes.md");
      expect(clone(NodePath.join(workspace, "notes.md"), file).status).toBe(0);
      expect(NodeFS.readFileSync(file, "utf8")).toBe("notes");
    },
  );

  it("follows a link in the home folder a few hops at most, so a loop leads nowhere", () => {
    const { base, home, reopen } = setUp("workspace-write");
    NodeFS.symlinkSync("loop", NodePath.join(home, "loop"));
    expect(reopen(NodePath.join(home, "loop", "project"))).toBeUndefined();
    // A chain of nine links leads nowhere either; one of three still leads to the project.
    const disk = NodePath.join(base, "disk", "project");
    NodeFS.mkdirSync(disk, { recursive: true });
    for (const [count, name] of [
      [9, "far"],
      [3, "near"],
    ] as const) {
      NodeFS.symlinkSync(NodePath.dirname(disk), NodePath.join(home, `${name}0`));
      for (let hop = 1; hop <= count; hop += 1) {
        NodeFS.symlinkSync(`${name}${hop - 1}`, NodePath.join(home, `${name}${hop}`));
      }
    }
    expect(reopen(NodePath.join(home, "far9", "project"))).toBeUndefined();
    expect(reopen(NodePath.join(home, "near3", "project"))).toBeDefined();
  });

  it("only reads where a rule lets commands write in the home folder or above", () => {
    const { base, home, workspace, sandbox, run } = setUp("workspace-write");
    // The home folder named through a symlink, as `/var` is `/private/var`, is the home folder.
    const throughVar = home.startsWith("/private/var/") ? [home.slice("/private".length)] : [];
    for (const folder of [home, "/", ...throughVar]) {
      sandbox.update({ read: [], write: [folder], private: [] });
      // Writing there would let commands replace the tools T3 runs outside the sandbox.
      run(`echo pwned > '${NodePath.join(home, ".local", "bin", "git")}'`);
      expect(NodeFS.existsSync(NodePath.join(home, ".local", "bin", "git")), folder).toBe(false);
      // Reading there is the rule's still: a tool's settings no list names open.
      expect(run(`cat '${NodePath.join(home, ".vercel", "auth.json")}'`).stdout, folder).toBe(
        '{"token":"secret"}',
      );
      // And the workspace is still the command's to write.
      expect(run("touch made.txt").status, folder).toBe(0);
    }
    expect(NodeFS.existsSync(NodePath.join(workspace, "made.txt"))).toBe(true);
    // A rule whose own folder is a symlink applies nowhere: a command may have made it.
    const homeLink = NodePath.join(base, "home-link");
    NodeFS.symlinkSync(home, homeLink);
    sandbox.update({ read: [], write: [homeLink], private: [] });
    expect(run(`cat '${NodePath.join(home, ".vercel", "auth.json")}'`).stdout).toBe("");
  });

  it("keeps a writable folder's .env closed when its name holds a quote", () => {
    const { base, sandbox, run } = setUp("workspace-write");
    const folder = NodePath.join(base, 'say "hi"');
    NodeFS.mkdirSync(folder);
    NodeFS.writeFileSync(NodePath.join(folder, ".env"), "SECRET=1");
    NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "notes");
    sandbox.update({ read: [], write: [folder], private: [] });
    // The rule opens the folder, so the profile parses.
    expect(run(`cat '${NodePath.join(folder, "notes.txt")}'`).stdout).toBe("notes");
    expect(run(`cat '${NodePath.join(folder, ".env")}'`).stdout).toBe("");
  });

  it("ignores a rule holding a NUL, which names no path", () => {
    const { home, workspace, sandbox, run } = setUp("workspace-write");
    NodeFS.writeFileSync(NodePath.join(workspace, "open.txt"), "open");
    NodeFS.mkdirSync(NodePath.join(home, ".aws"));
    NodeFS.writeFileSync(NodePath.join(home, ".aws", "credentials"), "secret");
    // Seatbelt would end each at the NUL, leaving a rule for `/`.
    sandbox.update({ read: ["/\0junk"], write: ["/\0junk"], private: [] });
    for (const path of [".vercel/auth.json", ".aws/credentials"]) {
      expect(run(`cat '${NodePath.join(home, path)}'`).stdout, path).toBe("");
    }
    // And the profile still works.
    expect(run("cat open.txt").stdout).toBe("open");
  });

  it("keeps credentials closed inside an opened folder unless the rule names them", () => {
    const { home, base, sandbox, run } = setUp("workspace-write");
    NodeFS.mkdirSync(NodePath.join(home, ".cargo", "registry"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, ".cargo", "credentials.toml"), "token = 'secret'");
    sandbox.update({ read: [], write: [NodePath.join(home, ".cargo")], private: [] });
    expect(run(`echo x > ${NodePath.join(home, ".cargo", "registry", "x")}`).status).toBe(0);
    expect(run(`cat ${NodePath.join(home, ".cargo", "credentials.toml")}`).stdout).toBe("");
    expect(run(`echo x > ${NodePath.join(home, ".cargo", "credentials.toml")}`).status).not.toBe(0);
    sandbox.update({
      read: [NodePath.join(home, ".cargo", "credentials.toml")],
      write: [NodePath.join(home, ".cargo")],
      private: [],
    });
    expect(run(`cat ${NodePath.join(home, ".cargo", "credentials.toml")}`).stdout).toContain(
      "secret",
    );
    // No rule lets a command change the sandbox's own files.
    sandbox.update({ read: [], write: [base], private: [] });
    const profile = sandbox.environment.T3_BOB_SANDBOX_PROFILE!;
    expect(run(`echo "(allow default)" > ${profile}`).status).not.toBe(0);
  });

  it("opens only a rule's own path inside a credential store, whatever rule sits beside it", () => {
    const { home, sandbox, run } = setUp("workspace-write");
    const ssh = NodePath.join(home, ".ssh");
    const gh = NodePath.join(home, ".config", "gh");
    NodeFS.writeFileSync(NodePath.join(ssh, "known_hosts"), "hosts");
    NodeFS.writeFileSync(NodePath.join(gh, "config.yml"), "editor: vim");
    sandbox.update({
      read: [home, NodePath.join(ssh, "known_hosts")],
      write: [NodePath.join(home, ".config"), NodePath.join(gh, "config.yml")],
      private: [],
    });
    expect(run(`cat ${NodePath.join(ssh, "known_hosts")}`).stdout).toBe("hosts");
    expect(run(`cat ${NodePath.join(ssh, "id_ed25519")}`).stdout).toBe("");
    expect(run(`cat ${NodePath.join(gh, "config.yml")}`).stdout).toBe("editor: vim");
    expect(run(`cat ${NodePath.join(gh, "hosts.yml")}`).stdout).toBe("");
    expect(run(`echo x >> ${NodePath.join(gh, "config.yml")}`).status).toBe(0);
    expect(run(`echo x >> ${NodePath.join(gh, "hosts.yml")}`).status).not.toBe(0);
  });

  it("lets commands read the user's attachments, and nothing else of T3's state", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      const { stateDir, attachmentsDir, run } = setUp(mode);
      const attached = run(`cat ${JSON.stringify(NodePath.join(attachmentsDir, "notes.txt"))}`);
      expect(attached.status, mode).toBe(0);
      expect(attached.stdout).toBe("attached notes");
      expect(
        run(`cat ${JSON.stringify(NodePath.join(stateDir, "statev2.sqlite"))}`).status,
      ).not.toBe(0);
      expect(
        run(`echo x > ${JSON.stringify(NodePath.join(attachmentsDir, "new.txt"))}`).status,
      ).not.toBe(0);
    }
  });

  it("reaches no network, not even this machine", async () => {
    const { run } = setUp("workspace-write");
    const server = NodeNet.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as NodeNet.AddressInfo).port;
    const connect = `${JSON.stringify(process.execPath)} -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"`;
    expect(run(connect).status).toBe(3);
    server.close();
  });

  it("runs the command the user approved outside the sandbox, once, in its folder", () => {
    const { home, workspace, sandbox, run } = setUp("workspace-write");
    const outside = NodePath.join(home, "approved.txt");
    const command = `echo yes > ${outside}`;
    // An approval for another folder is not this one's.
    sandbox.approveOutside(command, home);
    expect(run(command).status).not.toBe(0);
    sandbox.dropApprovals(new Set());
    sandbox.approveOutside(command, workspace);
    expect(run(command).status).toBe(0);
    expect(NodeFS.existsSync(outside)).toBe(true);
    NodeFS.rmSync(outside);
    expect(run(command).status).not.toBe(0);
    expect(NodeFS.existsSync(outside)).toBe(false);
    // Only that exact command.
    sandbox.approveOutside(command, workspace);
    expect(run(`${command} `).status).not.toBe(0);
    // An approved command runs as the user, but without T3's credentials or the approvals.
    const printenv =
      "/usr/bin/env | grep -E '^(T3_ACP_MCP_AUTHORIZATION|T3_BOB_APPROVALS|BOB_API_KEY)='";
    sandbox.approveOutside(printenv, workspace);
    expect(run(printenv).stdout).toBe("");
    // Approvals left over are dropped, but one waiting for another approved command stays.
    const waiting = sandbox.approveOutside(command, workspace);
    sandbox.approveOutside(`${command} again`, workspace);
    sandbox.dropApprovals(new Set([waiting]));
    expect(run(`${command} again`).status).not.toBe(0);
    expect(run(command).status).toBe(0);
  });

  it("hides credentials in variables and the workspace's .env files", () => {
    const { workspace, sandbox, run } = setUp("workspace-write");
    NodeFS.writeFileSync(NodePath.join(workspace, ".env"), "TOKEN=secret");
    NodeFS.writeFileSync(NodePath.join(workspace, ".env.example"), "TOKEN=");
    const env = (command: string) =>
      NodeChildProcess.spawnSync(sandbox.environment.SHELL!, ["-c", command], {
        cwd: workspace,
        env: { ...process.env, ...sandbox.environment, BOB_API_KEY: "k", GH_TOKEN: "t", KEEP: "1" },
        encoding: "utf8",
      }).stdout;
    expect(env("/usr/bin/env | grep -E '^(BOB_API_KEY|GH_TOKEN|KEEP)='")).toBe("KEEP=1\n");
    expect(run("cat .env").stdout).toBe("");
    expect(run("cat .e*").stdout).not.toContain("secret");
    expect(run("cat .env.example").stdout).toBe("TOKEN=");
    // Listing still works, beside a `.env/` virtualenv too.
    NodeFS.mkdirSync(NodePath.join(workspace, "py", ".env", "bin"), { recursive: true });
    expect(run("ls -la").status).toBe(0);
    expect(run("ls -l .env .env.example").status).toBe(0);
    expect(run("find . -name '.env*'").status).toBe(0);
    expect(run("ls py/.env/bin").status).toBe(0);
    // A rule naming the file opens it.
    sandbox.update({ read: [NodePath.join(workspace, ".env")], write: [], private: [] });
    expect(run("cat .env").stdout).toBe("TOKEN=secret");
    // A private path stays closed, a sample or a named file included.
    sandbox.update({
      read: [NodePath.join(workspace, ".env")],
      write: [],
      private: [NodePath.join(workspace, ".env"), NodePath.join(workspace, ".env.example")],
    });
    expect(run("cat .env").stdout).toBe("");
    expect(run("cat .env.example").stdout).toBe("");
  });

  it("keeps .git and .env read-only in a folder the user lets commands write", () => {
    const { home, sandbox, run } = setUp("workspace-write");
    const other = NodePath.join(home, "other");
    NodeFS.mkdirSync(NodePath.join(other, ".git", "hooks"), { recursive: true });
    if (linux) NodeFS.writeFileSync(NodePath.join(other, ".env"), "SECRET=1");
    sandbox.update({ read: [], write: [other], private: [] });
    expect(run(`echo x > ${NodePath.join(other, "notes.md")}`).status).toBe(0);
    expect(run(`echo x > ${NodePath.join(other, ".git", "hooks", "pre-commit")}`).status).not.toBe(
      0,
    );
    expect(run(`echo x > ${NodePath.join(other, ".env")}`).status).not.toBe(0);
  });

  it("is not ready once its shell or profile was changed, and puts them back", () => {
    const { sandbox } = setUp("workspace-write");
    const profile = sandbox.environment.T3_BOB_SANDBOX_PROFILE!;
    const shell = sandbox.environment.SHELL!;
    expect(sandbox.ready()).toBe(true);
    NodeFS.writeFileSync(profile, "(version 1)\n(allow default)\n");
    expect(sandbox.ready()).toBe(false);
    expect(sandbox.ready()).toBe(true);
    expect(NodeFS.readFileSync(profile, "utf8")).toContain(linux ? "--args 3" : "(deny default)");
    // A shell Bob cannot run makes Bob fall back to /bin/sh, outside the sandbox.
    NodeFS.chmodSync(shell, 0o400);
    expect(sandbox.ready()).toBe(false);
    expect(sandbox.ready()).toBe(true);
    NodeFS.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh "$@"\n');
    expect(sandbox.ready()).toBe(false);
    expect(sandbox.ready()).toBe(true);
  });

  it("keeps login items closed under a rule that opens all of Library", () => {
    const { home, sandbox, run } = setUp("workspace-write");
    NodeFS.mkdirSync(NodePath.join(home, "Library", "LaunchAgents"), { recursive: true });
    sandbox.update({ read: [], write: [NodePath.join(home, "Library")], private: [] });
    expect(run(`echo x > ${NodePath.join(home, "Library", "notes.txt")}`).status).toBe(0);
    const agent = NodePath.join(home, "Library", "LaunchAgents", "x.plist");
    expect(run(`echo x > ${agent}`).status).not.toBe(0);
  });

  it("lets Supervised's commands write nothing but temporary files", () => {
    const { base, run } = setUp("read-only");
    expect(run("ls").status).toBe(0);
    expect(run("echo hi > made.txt").status).not.toBe(0);
    expect(run(`echo hi > ${NodePath.join(base, "tmp", "t.txt")}`).status).toBe(0);
  });
});

/**
 * What a sandboxed Bob process tries: writes in its own state and elsewhere, the project's own
 * Bob folder, a command, and connections. Prints each outcome, `ok` or the error code, as JSON.
 */
const PROCESS_PROBE = `
const fs = require("fs");
const net = require("net");
const path = require("path");
const bob = path.join(process.env.HOME, ".bob");
const [port, socketPath] = process.argv.slice(2);
const outcomes = {};
const attempt = (name, run) => {
  try {
    run();
    outcomes[name] = "ok";
  } catch (error) {
    outcomes[name] = error.code ?? (error.status === undefined ? String(error) : "exit " + error.status);
  }
};
attempt("database", () => fs.writeFileSync(path.join(bob, "db", "bob.db"), "x"));
attempt("logs", () => fs.mkdirSync(path.join(bob, "logs", "shell"), { recursive: true }));
attempt("settings folder", () => fs.mkdirSync(path.join(bob, "settings"), { recursive: true }));
attempt("sign-in", () => fs.writeFileSync(path.join(bob, "settings", "auth-secrets.json"), "{}"));
attempt("trust", () => fs.writeFileSync(path.join(bob, "trustedFolders.json"), "{}"));
attempt("settings", () => fs.writeFileSync(path.join(bob, "settings", "settings.json"), "{}"));
attempt("mcp servers", () => fs.writeFileSync(path.join(bob, "mcp.json"), "{}"));
attempt("workspace", () => fs.writeFileSync("made.txt", "x"));
attempt("temporary", () => fs.writeFileSync(path.join(process.env.TMPDIR, "t.txt"), "x"));
attempt("read workspace", () => fs.readFileSync("README.md"));
attempt("project bob", () => fs.readFileSync(path.join(".bob", "mcp.json")));
attempt("command", () => require("child_process").execSync("echo x > by-command.txt", { stdio: "ignore" }));
const connections = [
  ["this machine", [Number(port), "127.0.0.1"]],
  ["socket", [socketPath]],
  ["another machine", [9, "192.0.2.1"]],
];
let open = connections.length;
for (const [name, target] of connections) {
  const socket = net.connect(...target);
  const settle = (outcome) => {
    outcomes[name] ??= outcome;
    socket.destroy();
    if (--open === 0) process.stdout.write(JSON.stringify(outcomes));
  };
  socket.setTimeout(300, () => settle("timeout"));
  socket.on("connect", () => settle("ok"));
  socket.on("error", (error) => settle(error.code));
}
`;

describe.skipIf(!available)("bobProcessSandboxSpawn", () => {
  it("runs all of Bob read-only but for its own state, reaching other machines only", async () => {
    const base = NodeFS.mkdtempSync(NodePath.join(root, "process-"));
    const home = NodePath.join(base, "home");
    const workspace = NodePath.join(base, "workspace");
    const temporary = NodePath.join(base, "tmp");
    for (const folder of [
      NodePath.join(home, ".bob", "db"),
      NodePath.join(home, ".bob", "settings"),
      NodePath.join(workspace, ".bob"),
      temporary,
    ]) {
      NodeFS.mkdirSync(folder, { recursive: true });
    }
    NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "readme");
    NodeFS.writeFileSync(NodePath.join(workspace, ".bob", "mcp.json"), "{}");
    // Bubblewrap lets Bob write its sign-in only where it is signed in, with the file there.
    if (linux)
      NodeFS.writeFileSync(NodePath.join(home, ".bob", "settings", "auth-secrets.json"), "{}");
    // A `bob` that is the probe itself, so the sandbox holds the process, not only its commands.
    const bob = NodePath.join(base, "bin", "bob");
    NodeFS.mkdirSync(NodePath.dirname(bob));
    NodeFS.writeFileSync(bob, `#!${process.execPath}\n${PROCESS_PROBE}`, { mode: 0o755 });
    const server = NodeNet.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const socketPath = NodePath.join(temporary, "s.sock");
    const socketServer = NodeNet.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
    const environment = { ...process.env, HOME: home, TMPDIR: temporary };
    const spawn = bobProcessSandboxSpawn({
      platform: HostProcess.Platform.defaultValue(),
      command: bob,
      workspace,
      environment,
      cacheDir: NodePath.join(base, "t3", "caches"),
      stateDir: NodePath.join(base, "t3", "state"),
    })!;
    const probe = NodeChildProcess.spawnSync(
      spawn.command,
      [...spawn.args, String((server.address() as NodeNet.AddressInfo).port), socketPath],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    server.close();
    socketServer.close();
    expect(probe.status, probe.stderr).toBe(0);
    const outcomes = JSON.parse(probe.stdout) as Record<string, string>;
    expect(outcomes).toEqual({
      database: "ok",
      logs: "ok",
      "settings folder": "ok",
      "sign-in": "ok",
      trust: "ok",
      settings: unwritable,
      "mcp servers": unwritable,
      workspace: unwritable,
      temporary: "ok",
      "read workspace": "ok",
      "project bob": unreadable,
      // dash says 2 where it cannot create a file.
      command: linux ? "exit 2" : "exit 1",
      // pasta's namespace has a loopback of its own, with nothing listening.
      "this machine": linux ? "ECONNREFUSED" : "EPERM",
      socket: "EPERM",
      // Allowed, whether the address answers or the host has no network.
      "another machine": expect.not.stringMatching(/^EPERM$/),
    });
    expect(NodeFS.existsSync(NodePath.join(workspace, "made.txt"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(workspace, "by-command.txt"))).toBe(false);
  });

  it("keeps a checkout inside a temporary folder read-only, as T3's worktrees are there", () => {
    // T3's home in the temporary folder puts its worktrees, and so a review guide's checkout,
    // inside a folder Bob may write.
    const temporary = NodeFS.mkdtempSync(NodePath.join(root, "process-tmp-"));
    const home = NodePath.join(temporary, "home");
    const workspace = NodePath.join(temporary, "t3", "worktrees", "checkout");
    NodeFS.mkdirSync(home);
    NodeFS.mkdirSync(workspace, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "readme");
    const bob = NodePath.join(temporary, "bin", "bob");
    NodeFS.mkdirSync(NodePath.dirname(bob));
    NodeFS.writeFileSync(
      bob,
      `#!${process.execPath}
const fs = require("fs");
const outcomes = {};
const attempt = (name, run) => {
  try {
    run();
    outcomes[name] = "ok";
  } catch (error) {
    outcomes[name] = error.code ?? String(error);
  }
};
attempt("edit", () => fs.writeFileSync("README.md", "changed"));
attempt("create", () => fs.writeFileSync("made.txt", "x"));
attempt("temporary", () => fs.writeFileSync(require("path").join(process.env.TMPDIR, "t.txt"), "x"));
process.stdout.write(JSON.stringify(outcomes));
`,
      { mode: 0o755 },
    );
    const environment = { ...process.env, HOME: home, TMPDIR: temporary };
    const spawn = bobProcessSandboxSpawn({
      platform: HostProcess.Platform.defaultValue(),
      command: bob,
      workspace,
      environment,
      cacheDir: NodePath.join(temporary, "t3", "caches"),
      stateDir: NodePath.join(temporary, "t3", "userdata"),
    })!;
    const probe = NodeChildProcess.spawnSync(spawn.command, spawn.args, {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      edit: unwritable,
      create: unwritable,
      temporary: "ok",
    });
    expect(NodeFS.readFileSync(NodePath.join(workspace, "README.md"), "utf8")).toBe("readme");
    expect(NodeFS.existsSync(NodePath.join(workspace, "made.txt"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(temporary, "t.txt"), "utf8")).toBe("x");
  });

  it("starts no Bob where the host has no sandbox or Bob is not there", () => {
    const options = {
      command: "bob",
      workspace: root,
      environment: { HOME: root, PATH: "" },
      cacheDir: root,
      stateDir: root,
    };
    expect(bobProcessSandboxSpawn({ ...options, platform: "win32" })).toBeUndefined();
    expect(
      bobProcessSandboxSpawn({ ...options, platform: HostProcess.Platform.defaultValue() }),
    ).toBeUndefined();
  });
});

describe("bobSandboxAvailable", () => {
  it("needs macOS's sandbox-exec or Linux's Bubblewrap", () => {
    expect(bobSandboxAvailable("win32")).toBe(false);
    expect(bobSandboxAvailable("freebsd")).toBe(false);
  });
});

describe("bobSandboxFolderSuggestion", () => {
  const home = NodePath.join(root, "suggest-home");
  for (const folder of [
    "Library/Caches/go-build/ab",
    ".cache/tool",
    "go/pkg/mod",
    "Documents",
    ".vercel",
    ".config/stripe",
    ".local/share/fish",
    ".ssh",
  ]) {
    NodeFS.mkdirSync(NodePath.join(home, folder), { recursive: true });
  }
  const workspace = NodePath.join(home, ".t3", "worktrees", "repo");
  const input = {
    home,
    workspace,
    t3Home: NodePath.join(home, ".t3"),
    rules: NO_BOB_SANDBOX_RULES,
  };
  const suggest = (path: string, rules = NO_BOB_SANDBOX_RULES) =>
    bobSandboxFolderSuggestion(NodePath.join(home, path), { ...input, rules });
  const at = (path: string) => NodePath.join(home, path);

  it("offers the folder a tool keeps, to read where hidden and to write in caches", () => {
    expect(suggest(".vercel/auth.json")).toEqual({ kind: "read", folder: at(".vercel") });
    expect(suggest(".config/stripe/config.toml")).toEqual({
      kind: "read",
      folder: at(".config/stripe"),
    });
    expect(suggest(".local/share/fish/fish_history")).toEqual({
      kind: "read",
      folder: at(".local/share/fish"),
    });
    expect(suggest("Library/Caches/go-build/ab/cd")).toEqual({
      kind: "write",
      folder: at("Library/Caches/go-build"),
    });
    expect(suggest(".cache/tool/x")).toEqual({ kind: "write", folder: at(".cache/tool") });
    expect(suggest("go/pkg/mod/x")).toEqual({ kind: "write", folder: at("go") });
    // Once the folder is open to read, a denial there was a write, which a card offers only for
    // caches and toolchains.
    expect(suggest(".vercel/auth.json", { ...NO_BOB_SANDBOX_RULES, read: [at(".vercel")] })).toBe(
      undefined,
    );
    // A workspace's .env file, by itself.
    expect(
      bobSandboxFolderSuggestion(NodePath.join(workspace, "sub", ".env.local"), input),
    ).toEqual({ kind: "read", folder: NodePath.join(workspace, "sub", ".env.local") });
  });

  it("offers nothing broad, private, or for credentials, history, agents or T3's home", () => {
    for (const path of [
      "Library",
      "Library/Caches",
      ".config",
      ".local/share",
      "Library/Application Support/Foo/db",
      "Library/Cookies/x",
      "Documents/x",
      ".ssh/id_ed25519",
      ".npmrc",
      ".zsh_history",
      ".config/gh/hosts.yml",
      ".config/git/credentials",
      "Library/Keychains/login.keychain-db",
      ".claude/projects/x.jsonl",
      ".codex/sessions/x.jsonl",
      ".t3/userdata/settings.json",
      ".t3/caches/bob-sandbox/profiles/x.sb",
    ]) {
      expect(suggest(path), path).toBeUndefined();
    }
    // Nor a credential store, an agent's folder or T3's home spelled as a Mac's disk takes for
    // the same folder: in another case, or with `ß` for `ss` or `ſ` for `s`. A folder that is
    // not there gets no offer at all, so neither does one a store could take its place later.
    for (const path of [
      ".SSH/nothere",
      ".ßh/id_ed25519",
      ".Aws/x",
      ".awſ/credentials",
      ".config/GH/hosts.yml",
      ".BOB/x",
      ".T3/x",
      ".nothere/x",
    ]) {
      expect(suggest(path), path).toBeUndefined();
    }
    // A folder that is there is offered as the disk spells it, on a disk blind to case.
    if (NodeFS.existsSync(NodePath.join(home, ".CACHE"))) {
      expect(suggest(".CACHE/tool/x")).toEqual({ kind: "write", folder: at(".cache/tool") });
    }
    // Nor a path no rule could spell, though its folder would otherwise be offered to read.
    expect(suggest(".vercel\bx/auth.json")).toBeUndefined();
    expect(suggest(".vercel\uD800/auth.json")).toBeUndefined();
    expect(bobSandboxFolderSuggestion("/opt/homebrew/bin/x", input)).toBeUndefined();
    expect(
      bobSandboxFolderSuggestion(NodePath.join(workspace, "src", "a.ts"), input),
    ).toBeUndefined();
  });
});

describe.skipIf(!available)("commandSandboxSpawn", () => {
  /** A repository with a linked worktree, as a workflow's workspace is, and a home with secrets. */
  function setUpRepository() {
    const base = NodeFS.mkdtempSync(NodePath.join(root, "command-"));
    const home = NodePath.join(base, "home");
    const repository = NodePath.join(base, "repo");
    const worktree = NodePath.join(base, "t3", "worktrees", "ws");
    const temporary = NodePath.join(base, "tmp");
    for (const folder of [
      NodePath.join(home, ".ssh"),
      NodePath.join(home, "Library", "Caches"),
      repository,
      temporary,
    ]) {
      NodeFS.mkdirSync(folder, { recursive: true });
    }
    NodeFS.writeFileSync(NodePath.join(home, ".ssh", "id_ed25519"), "secret");
    NodeFS.writeFileSync(NodePath.join(repository, "README.md"), "readme");
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
        { cwd: repository, encoding: "utf8" },
      );
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "init");
    git("worktree", "add", "-q", "-b", "ws", worktree);
    const environment = { ...process.env, HOME: home, TMPDIR: temporary };
    const run = (
      cwd: string,
      command: string,
      options: { readonly mode: BobSandboxMode; readonly network?: boolean },
    ) => {
      const spawn = commandSandboxSpawn({
        platform: HostProcess.Platform.defaultValue(),
        command,
        cwd,
        mode: options.mode,
        network: options.network ?? false,
        environment,
        cacheDir: NodePath.join(base, "t3", "caches"),
        stateDir: NodePath.join(base, "t3", "userdata"),
      })!;
      return NodeChildProcess.spawnSync(spawn.command, spawn.args, {
        cwd,
        env: environment,
        encoding: "utf8",
      });
    };
    return { home, repository, worktree, temporary, git, run };
  }

  it("writes only a worktree, the git folders its commits need, temporary folders and caches", () => {
    const { home, repository, worktree, temporary, git, run } = setUpRepository();
    const inWorktree = (command: string) => run(worktree, command, { mode: "workspace-write" });
    expect(inWorktree("echo hi > made.txt").status).toBe(0);
    const commit = inWorktree(
      "git add made.txt && git -c user.name=T3 -c user.email=t3@example.com commit -qm made",
    );
    expect(commit.status, commit.stderr).toBe(0);
    expect(git("log", "--format=%s", "ws")).toBe("made\ninit\n");
    expect(inWorktree(`echo x > ${NodePath.join(temporary, "t.txt")}`).status).toBe(0);
    expect(inWorktree(`mkdir ${NodePath.join(home, "Library", "Caches", "tool")}`).status).toBe(0);
    // Not the base checkout, its git configuration, or where the worktree says its repository is.
    const gitDir = NodePath.join(repository, ".git", "worktrees", "ws");
    // Bubblewrap keeps the one that is there; git reads it only where the repository says to.
    if (linux) NodeFS.writeFileSync(NodePath.join(gitDir, "config.worktree"), "");
    for (const target of [
      NodePath.join(repository, "README.md"),
      NodePath.join(repository, ".git", "config"),
      NodePath.join(repository, ".git", "hooks", "pre-commit"),
      NodePath.join(gitDir, "commondir"),
      NodePath.join(gitDir, "gitdir"),
      NodePath.join(gitDir, "config.worktree"),
      NodePath.join(worktree, ".git"),
      NodePath.join(home, "escaped.txt"),
    ]) {
      expect(inWorktree(`echo x > ${target}`).status, target).not.toBe(0);
    }
    expect(NodeFS.readFileSync(NodePath.join(repository, "README.md"), "utf8")).toBe("readme");
    expect(inWorktree(`cat ${NodePath.join(home, ".ssh", "id_ed25519")}`).stdout).toBe("");
  });

  it("keeps a read-only checkout unchanged, even inside a temporary folder", () => {
    const { worktree, temporary, run } = setUpRepository();
    const checkout = NodePath.join(temporary, "checkout");
    NodeFS.mkdirSync(checkout);
    NodeFS.writeFileSync(NodePath.join(checkout, "README.md"), "readme");
    for (const cwd of [worktree, checkout]) {
      expect(run(cwd, "echo x > made.txt", { mode: "read-only" }).status, cwd).not.toBe(0);
      expect(NodeFS.existsSync(NodePath.join(cwd, "made.txt"))).toBe(false);
      expect(run(cwd, "cat README.md", { mode: "read-only" }).stdout).toBe("readme");
    }
    const elsewhere = `echo x > ${NodePath.join(temporary, "t.txt")}`;
    expect(run(checkout, elsewhere, { mode: "read-only" }).status).toBe(0);
  });

  it("reaches other machines only when asked, and never this one", async () => {
    const { worktree, run } = setUpRepository();
    const server = NodeNet.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as NodeNet.AddressInfo).port;
    const connect = `${JSON.stringify(process.execPath)} -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"`;
    for (const network of [false, true]) {
      expect(run(worktree, connect, { mode: "workspace-write", network }).status).toBe(3);
    }
    server.close();
    const profileOf = (network: boolean) =>
      commandSandboxSpawn({
        platform: HostProcess.Platform.defaultValue(),
        command: "true",
        cwd: worktree,
        mode: "workspace-write",
        network,
        environment: { HOME: root, PATH: "/usr/bin:/bin" },
        cacheDir: NodePath.join(root, "caches"),
        stateDir: NodePath.join(root, "state"),
      })!.args[1]!;
    expect(profileOf(true)).toContain(linux ? "pasta" : "(allow network-outbound)");
    expect(profileOf(false)).not.toContain(linux ? "pasta" : "network-outbound");
  });
});

describe("commandSandboxSpawn without a sandbox", () => {
  it("gives none where the host has no sandbox", () => {
    expect(
      commandSandboxSpawn({
        platform: "win32",
        command: "true",
        cwd: root,
        mode: "read-only",
        network: false,
        environment: { HOME: root, PATH: "/usr/bin:/bin" },
        cacheDir: root,
        stateDir: root,
      }),
    ).toBeUndefined();
  });
});
