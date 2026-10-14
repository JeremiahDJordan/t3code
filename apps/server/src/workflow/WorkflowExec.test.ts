// @effect-diagnostics nodeBuiltinImport:off - sets up checkouts and probes the processes a command left.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { bobSandboxAvailable } from "../provider/acp/bobSandbox.ts";
import * as WorkflowExec from "./WorkflowExec.ts";
import { WORKFLOW_VALUE_MAX_BYTES } from "./WorkflowSandboxProtocol.ts";

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-exec-")));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

/** The service on `platform`, with the server's environment `environment`. */
const layerOn = (platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env) =>
  WorkflowExec.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        ServerConfig.layerTest(root, { prefix: "t3-workflow-exec-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.succeed(HostProcess.Platform, platform),
        Layer.succeed(HostProcess.Environment, environment),
      ),
    ),
  );

const runIn = (
  cwd: string,
  command: string,
  options: Partial<Omit<WorkflowExec.WorkflowExecRun, "command" | "cwd">> = {},
) =>
  WorkflowExec.WorkflowExec.use((exec) =>
    exec.run({
      command,
      cwd,
      workspace: false,
      runtimeMode: "full-access",
      interactionMode: "default",
      timeoutMs: 30_000,
      env: {},
      ...options,
    }),
  );

describe("planWorkflowExec", () => {
  const plan = (
    input: Partial<Parameters<typeof WorkflowExec.planWorkflowExec>[0]>,
  ): WorkflowExec.WorkflowExecPlan =>
    WorkflowExec.planWorkflowExec({
      sandboxAvailable: true,
      runtimeMode: "auto",
      interactionMode: "default",
      workspace: true,
      ...input,
    });

  it("writes only a workspace, and only when the coordinator may edit", () => {
    expect(plan({})).toEqual({ kind: "sandboxed", mode: "workspace-write", network: false });
    expect(plan({ workspace: false })).toEqual({
      kind: "sandboxed",
      mode: "read-only",
      network: false,
    });
    expect(plan({ runtimeMode: "approval-required" })).toMatchObject({ mode: "read-only" });
    expect(plan({ interactionMode: "plan" })).toMatchObject({ mode: "read-only" });
    expect(plan({ runtimeMode: "auto-accept-edits" })).toMatchObject({ mode: "workspace-write" });
  });

  it("reaches the network only in Full access", () => {
    expect(plan({ runtimeMode: "full-access" })).toEqual({
      kind: "sandboxed",
      mode: "workspace-write",
      network: true,
    });
    expect(plan({ runtimeMode: "full-access", workspace: false })).toMatchObject({
      mode: "read-only",
      network: true,
    });
  });

  it("runs without a sandbox only in Full access", () => {
    expect(plan({ sandboxAvailable: false, runtimeMode: "full-access" })).toEqual({
      kind: "unsandboxed",
    });
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(plan({ sandboxAvailable: false, runtimeMode })).toEqual({ kind: "refused" });
    }
  });
});

describe("workflowExecEnvironment", () => {
  it("keeps credentials and T3's own variables from commands, but not the script's env", () => {
    expect(
      WorkflowExec.workflowExecEnvironment(
        {
          PATH: "/usr/bin",
          HOME: "/home/u",
          GITHUB_TOKEN: "secret",
          AWS_SECRET_ACCESS_KEY: "secret",
          OPENAI_API_KEY: "secret",
          npm_config_password: "secret",
          GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
          T3CODE_HOME: "/home/u/.t3",
          T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1",
          ELECTRON_RUN_AS_NODE: "1",
        },
        { CI: "1" },
      ),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/u", CI: "1" });
  });
});

describe("fitted", () => {
  it("cuts output that escapes past the script's limit, keeping its end", () => {
    // Control characters take six bytes each as JSON.
    const result = WorkflowExec.fitted({
      exitCode: 0,
      stdout: { text: `${"\u0001".repeat(WorkflowExec.EXEC_OUTPUT_MAX_BYTES)}END`, cut: 1000 },
      stderr: { text: "err", cut: 0 },
      timedOut: false,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(WORKFLOW_VALUE_MAX_BYTES);
    // One note, which counts what the tail had lost already.
    const [note, kept] = result.stdout.split(/\n(.*)/s);
    expect(note).toBe(
      `[exec: the first ${1000 + WorkflowExec.EXEC_OUTPUT_MAX_BYTES + 3 - kept!.length} bytes of output were cut]`,
    );
    expect(kept).not.toContain("[exec:");
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stderr).toBe("err");
  });
});

describe("WorkflowExec without a sandbox", () => {
  const layer = layerOn("linux", { ...process.env, GITHUB_TOKEN: "secret" });

  it.live("runs a command through the shell in its folder, with the script's env", () =>
    Effect.gen(function* () {
      const result = yield* runIn(
        root,
        'pwd; echo "${GITHUB_TOKEN:-none} $FROM_SCRIPT"; echo err >&2; exit 3',
        { env: { FROM_SCRIPT: "given" } },
      );
      expect(result).toEqual({
        exitCode: 3,
        stdout: `${root}\nnone given\n`,
        stderr: "err\n",
        timedOut: false,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.live("refuses a command outside Full access", () =>
    Effect.gen(function* () {
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        const refused = yield* runIn(root, "echo ran", { runtimeMode }).pipe(Effect.flip);
        expect(refused).toBeInstanceOf(WorkflowExec.WorkflowExecRefusedError);
        expect(refused.message).toContain("Full access");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live("stops a command at its timeout", () =>
    Effect.gen(function* () {
      const result = yield* runIn(root, "echo started; exec sleep 30", { timeoutMs: 300 });
      expect(result).toEqual({ exitCode: null, stdout: "started\n", stderr: "", timedOut: true });
    }).pipe(Effect.provide(layer)),
  );

  it.live("keeps the end of long output and says how much was cut", () =>
    Effect.gen(function* () {
      const result = yield* runIn(root, "head -c 400000 /dev/zero | tr '\\0' a; printf END");
      const cut = 400_003 - WorkflowExec.EXEC_OUTPUT_MAX_BYTES;
      expect(result.stdout.startsWith(`[exec: the first ${cut} bytes of output were cut]\n`)).toBe(
        true,
      );
      expect(result.stdout.endsWith("aaaEND")).toBe(true);
      expect(result.stdout.length).toBe(
        WorkflowExec.EXEC_OUTPUT_MAX_BYTES +
          `[exec: the first ${cut} bytes of output were cut]\n`.length,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live("kills the command when the run stops", () =>
    Effect.gen(function* () {
      const fifo = NodePath.join(NodeFS.mkdtempSync(NodePath.join(root, "fifo-")), "pid");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      const fiber = yield* runIn(root, `echo $$ > ${fifo}; exec sleep 30`).pipe(Effect.forkChild);
      const pid = Number(
        (yield* Effect.promise(() => NodeFS.promises.readFile(fifo, "utf8"))).trim(),
      );
      yield* Fiber.interrupt(fiber);
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.provide(layer)),
  );

  it.live("journals a run's results until it forgets them", () =>
    Effect.gen(function* () {
      const exec = yield* WorkflowExec.WorkflowExec;
      const thread = ThreadId.make("thread:wf-exec-journal");
      const result = { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
      expect(yield* exec.recorded(thread, "exec:a:1")).toEqual(Option.none());
      yield* exec.record(thread, "exec:a:1", result);
      expect(yield* exec.recorded(thread, "exec:a:1")).toEqual(Option.some(result));
      expect(yield* exec.recorded(thread, "exec:a:2")).toEqual(Option.none());
      yield* exec.forget(thread);
      expect(yield* exec.recorded(thread, "exec:a:1")).toEqual(Option.none());
    }).pipe(Effect.provide(layer)),
  );
});

const platform = HostProcess.Platform.defaultValue();

describe.skipIf(!bobSandboxAvailable(platform))("WorkflowExec in the sandbox", () => {
  const layer = layerOn(platform);

  it.live("writes a workspace's worktree, never the base checkout", () =>
    Effect.gen(function* () {
      const repository = NodeFS.mkdtempSync(NodePath.join(root, "repo-"));
      const worktree = `${repository}-ws`;
      NodeFS.writeFileSync(NodePath.join(repository, "README.md"), "readme");
      const git = (...args: Array<string>) =>
        NodeChildProcess.execFileSync(
          "git",
          ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
          { cwd: repository },
        );
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("commit", "-qm", "init");
      git("worktree", "add", "-q", "-b", "ws", worktree);

      const write = "echo x > made.txt";
      const inWorkspace = yield* runIn(worktree, write, { workspace: true, runtimeMode: "auto" });
      expect(inWorkspace.exitCode, inWorkspace.stderr).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(worktree, "made.txt"))).toBe(true);
      const supervised = yield* runIn(worktree, "echo x > other.txt", {
        workspace: true,
        runtimeMode: "approval-required",
      });
      expect(supervised.exitCode).not.toBe(0);
      for (const runtimeMode of ["auto", "full-access"] as const) {
        const inBase = yield* runIn(repository, write, { runtimeMode });
        expect(inBase.exitCode).not.toBe(0);
        expect(inBase.stderr).toContain("Operation not permitted");
      }
      expect(NodeFS.existsSync(NodePath.join(repository, "made.txt"))).toBe(false);
      expect((yield* runIn(repository, "cat README.md", { runtimeMode: "auto" })).stdout).toBe(
        "readme",
      );
    }).pipe(Effect.provide(layer)),
  );
});
