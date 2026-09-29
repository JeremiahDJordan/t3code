// @effect-diagnostics nodeBuiltinImport:off - the test runs the real wrapper and reads what it wrote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BACKGROUND_COMMAND_WRAPPER_SOURCE,
  backgroundCommandMatchesPath,
  encodeBackgroundCommandSpec,
  parseBackgroundCommandExit,
  parseBackgroundCommandMatches,
} from "./backgroundCommandWrapper.ts";

const wrappers: Array<NodeChildProcess.ChildProcess> = [];
const dirs: Array<string> = [];

afterEach(() => {
  // A wrapper stuck matching would otherwise outlive the test.
  for (const wrapper of wrappers.splice(0)) {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** Runs `command` under the wrapper and resolves with what it recorded once the wrapper exits. */
async function runWrapped(command: string, notifyOn: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bg-wrapper-"));
  dirs.push(dir);
  const wrapperPath = NodePath.join(dir, "run-command.mjs");
  const specPath = NodePath.join(dir, "spec.json");
  const paths = {
    stdoutPath: NodePath.join(dir, "stdout.log"),
    stderrPath: NodePath.join(dir, "stderr.log"),
    exitPath: NodePath.join(dir, "exit-status"),
    pidPath: NodePath.join(dir, "pid"),
    matchesPath: backgroundCommandMatchesPath(dir),
  };
  NodeFS.writeFileSync(wrapperPath, BACKGROUND_COMMAND_WRAPPER_SOURCE);
  NodeFS.writeFileSync(
    specPath,
    encodeBackgroundCommandSpec({
      cwd: dir,
      shell: "/bin/sh",
      shellArgs: ["-c", command],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      notifyOn,
      ...paths,
    }),
  );
  const wrapper = NodeChildProcess.spawn(process.execPath, [wrapperPath, specPath], {
    stdio: "ignore",
  });
  wrappers.push(wrapper);
  const code = await new Promise<number | null>((resolve) => wrapper.once("exit", resolve));
  const read = (path: string) => (NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "");
  return {
    code,
    exit: parseBackgroundCommandExit(read(paths.exitPath)),
    stdout: read(paths.stdoutPath),
    matches: parseBackgroundCommandMatches(read(paths.matchesPath)),
  };
}

describe("background command wrapper", () => {
  it(
    "keeps copying output and records the exit when a pattern backtracks without end",
    { timeout: 10_000 },
    async () => {
      const result = await runWrapped(
        `printf '${"a".repeat(40)}!\\n'; echo after; exit 3`,
        "(?i)(a+)+$",
      );

      expect(result.code).toBe(3);
      expect(result.exit?.code).toBe(3);
      expect(result.stdout).toBe(`${"a".repeat(40)}!\nafter\n`);
    },
  );

  it("records every line matching an ignore-case pattern with where it starts", async () => {
    const result = await runWrapped(
      `printf 'hello\\nHELLO\\nskip\\nHello again\\n'; exit 0`,
      "(?i)hello",
    );

    expect(result.code).toBe(0);
    expect(result.matches).toEqual([
      { stream: "stdout", offset: 0, line: "hello" },
      { stream: "stdout", offset: 6, line: "HELLO" },
      { stream: "stdout", offset: 17, line: "Hello again" },
    ]);
  });
});
