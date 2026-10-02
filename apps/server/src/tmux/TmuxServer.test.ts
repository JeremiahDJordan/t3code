import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { make, parseTmuxVersion, TMUX_RETRY_AFTER, tmuxLaunchCommand } from "./TmuxServer.ts";

describe("tmuxLaunchCommand", () => {
  it("starts tmux in its own systemd scope when T3 runs as a systemd service", () => {
    expect(
      tmuxLaunchCommand({
        tmux: "/usr/bin/tmux",
        args: ["-S", "/state/tmux/t3.sock", "new-session", "-d"],
        systemdRun: "/usr/bin/systemd-run",
      }),
    ).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        "/usr/bin/tmux",
        "-S",
        "/state/tmux/t3.sock",
        "new-session",
        "-d",
      ],
    });
  });

  it("runs tmux directly otherwise", () => {
    expect(
      tmuxLaunchCommand({
        tmux: "/opt/homebrew/bin/tmux",
        args: ["new-session"],
        systemdRun: undefined,
      }),
    ).toEqual({ command: "/opt/homebrew/bin/tmux", args: ["new-session"] });
  });
});

describe("parseTmuxVersion", () => {
  it("reads release and next versions", () => {
    expect(parseTmuxVersion("tmux 3.7c")).toEqual([3, 7]);
    expect(parseTmuxVersion("tmux next-3.8")).toEqual([3, 8]);
    expect(parseTmuxVersion("not tmux")).toBeUndefined();
  });
});

describe("TmuxServer.available", () => {
  it.effect("looks for tmux again a while after a miss, and keeps what it finds", () =>
    Effect.gen(function* () {
      let installed = false;
      let versionChecks = 0;
      const result = (stdout: string, code: number) => ({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(code),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
        Effect.sync(() => {
          if (input.args[0] !== "-V") return result("/usr/bin/tmux\n", 0);
          versionChecks += 1;
          return installed ? result("tmux 3.5a\n", 0) : result("", 127);
        });
      const tmux = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProcessRunner.ProcessRunner, { run }),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-tmux-test-" }),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      );

      expect(yield* tmux.available).toBe(false);
      installed = true;
      // A miss is remembered for a while, so status checks don't run tmux each time.
      expect(yield* tmux.available).toBe(false);
      yield* TestClock.adjust(TMUX_RETRY_AFTER);
      expect(yield* tmux.available).toBe(true);
      expect((yield* tmux.attachCommand("t3-bg-1"))[0]).toBe("/usr/bin/tmux");

      installed = false;
      yield* TestClock.adjust("1 hour");
      expect(yield* tmux.available).toBe(true);
      expect(versionChecks).toBe(2);
    }).pipe(Effect.scoped),
  );
});
