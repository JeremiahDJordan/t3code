// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { bobSandboxAvailable, makeBobSandbox, type BobSandboxMode } from "./bobSandbox.ts";

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
    ]) {
      expect(run(`cat ${NodePath.join(home, secret)}`).stdout, secret).toBe("");
    }
    // Interpreters read through the same profile.
    const readVercel = `${JSON.stringify(process.execPath)} -e "process.stdout.write(require('fs').readFileSync('${NodePath.join(home, ".vercel", "auth.json")}', 'utf8'))"`;
    expect(run(readVercel).stdout).toBe("");
    // Toolchains still run from, and read settings in, the folders they need.
    expect(run(NodePath.join(home, ".local", "bin", "tool")).stdout).toBe("tool ran\n");
    expect(run(`cat ${NodePath.join(home, ".gitconfig")}`).stdout).toContain("Bob");
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

  it("reaches no network, not even this machine", async () => {
    const { run } = setUp("workspace-write");
    const server = NodeNet.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as NodeNet.AddressInfo).port;
    const connect = `${JSON.stringify(process.execPath)} -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"`;
    expect(run(connect).status).toBe(3);
    server.close();
  });

  it("runs the command the user approved outside the sandbox, once", () => {
    const { home, sandbox, run } = setUp("workspace-write");
    const outside = NodePath.join(home, "approved.txt");
    const command = `echo yes > ${outside}`;
    sandbox.approveOutside(command);
    expect(run(command).status).toBe(0);
    expect(NodeFS.existsSync(outside)).toBe(true);
    NodeFS.rmSync(outside);
    expect(run(command).status).not.toBe(0);
    expect(NodeFS.existsSync(outside)).toBe(false);
    // Only that exact command.
    sandbox.approveOutside(command);
    expect(run(`${command} `).status).not.toBe(0);
    // An approved command runs as the user, but without T3's credentials or the approvals.
    const printenv = "printenv T3_ACP_MCP_AUTHORIZATION T3_BOB_APPROVALS";
    sandbox.approveOutside(printenv);
    expect(run(printenv).stdout).toBe("");
    // Approvals left over are dropped, but one waiting for another approved command stays.
    const waiting = sandbox.approveOutside(command);
    sandbox.approveOutside(`${command} again`);
    sandbox.dropApprovals(new Set([waiting]));
    expect(run(`${command} again`).status).not.toBe(0);
    expect(run(command).status).toBe(0);
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
