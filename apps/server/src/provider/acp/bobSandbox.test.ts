// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  bobSandboxAvailable,
  bobSandboxFolderSuggestion,
  makeBobSandbox,
  NO_BOB_SANDBOX_RULES,
  type BobSandboxMode,
} from "./bobSandbox.ts";

const available = bobSandboxAvailable(HostProcessPlatform.defaultValue());
const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bob-sb-")));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function setUp(mode: BobSandboxMode) {
  const base = NodeFS.mkdtempSync(NodePath.join(root, `${mode}-`));
  const home = NodePath.join(base, "home");
  const workspace = NodePath.join(base, "workspace");
  const stateDir = NodePath.join(base, "state");
  for (const folder of [NodePath.join(home, ".ssh"), NodePath.join(workspace, ".git"), stateDir]) {
    NodeFS.mkdirSync(folder, { recursive: true });
  }
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
  const sandbox = makeBobSandbox({
    mode,
    workspace,
    home,
    platform: HostProcessPlatform.defaultValue(),
    shell: "/bin/zsh",
    cacheDir: NodePath.join(base, "caches"),
    stateDir,
    key: workspace,
    temporaryFolders: [NodePath.join(base, "tmp")],
    searchPath,
  })!;
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
  return { base, home, workspace, sandbox, run };
}

describe.skipIf(!available)("makeBobSandbox", () => {
  it("gives no sandbox, so every command asks, to a folder Seatbelt cannot name", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-quote-"));
    expect(
      makeBobSandbox({
        mode: "workspace-write",
        workspace: NodePath.join(base, 'say "hi"'),
        home: base,
        platform: HostProcessPlatform.defaultValue(),
        shell: "/bin/zsh",
        cacheDir: NodePath.join(base, "caches"),
        stateDir: NodePath.join(base, "state"),
        key: "quoted",
        temporaryFolders: [],
      }),
    ).toBeUndefined();
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
    expect(NodeFS.readFileSync(profile, "utf8")).toContain("(deny default)");
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

describe("bobSandboxAvailable", () => {
  it("needs macOS's sandbox-exec", () => {
    expect(bobSandboxAvailable("linux")).toBe(false);
  });
});

describe("bobSandboxFolderSuggestion", () => {
  const home = NodePath.join(root, "suggest-home");
  for (const folder of ["Library/Caches/go-build/ab", ".cache/tool", "go/pkg/mod", "Documents"]) {
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
    expect(bobSandboxFolderSuggestion("/opt/homebrew/bin/x", input)).toBeUndefined();
    expect(
      bobSandboxFolderSuggestion(NodePath.join(workspace, "src", "a.ts"), input),
    ).toBeUndefined();
  });
});
