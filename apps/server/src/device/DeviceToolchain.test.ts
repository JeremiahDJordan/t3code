import * as PlatformError from "effect/PlatformError";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { BUNDLED_YARN_ENV } from "@t3tools/shared/nodeRuntime";

import * as ProcessRunner from "../processRunner.ts";
import {
  deviceToolVersions,
  DEVICE_HUB_VERSION,
  ensureDeviceHub,
  isDeviceHubInstalled,
} from "./DeviceToolchain.ts";

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("without npm, the desktop's bundled yarn installs under the app's own Node", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const calls: Array<ProcessRunner.ProcessRunInput> = [];
    const run = (input: ProcessRunner.ProcessRunInput) => {
      calls.push(input);
      if (input.command === "npm") {
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "npm",
            argumentCount: input.args.length,
            cause: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          }),
        );
      }
      return Effect.gen(function* () {
        const shim = path.join(input.env!.PATH!.split(":")[0]!, "node");
        expect(yield* fs.readFileString(shim)).toContain("exec '/Applications/T3 Code' \"$@\"");
        const stagingDir = input.args[input.args.indexOf("--cwd") + 1]!;
        const entry = path.join(stagingDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        return {
          code: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }).pipe(Effect.orDie);
    };

    const paths = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.ExecutablePath, "/Applications/T3 Code"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "/usr/bin",
        [BUNDLED_YARN_ENV]: "/Applications/yarn/bin/yarn.js",
      }),
    );

    const yarn = calls[1]!;
    expect(yarn.command).toBe("/Applications/T3 Code");
    expect(yarn.args.slice(0, 2)).toEqual(["/Applications/yarn/bin/yarn.js", "add"]);
    expect(yarn.args.at(-1)).toBe(`expo-device-hub@${DEVICE_HUB_VERSION}`);
    expect(yarn.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(true);
    expect(yield* fs.exists(path.join(paths.installDir, ".node-shim"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inventory reports only completed versions without installing the required version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    for (const [version, sentinel] of [
      ["0.9.0", "0.9.0"],
      [DEVICE_HUB_VERSION, "wrong"],
      [".staging-123", ".staging-123"],
    ]) {
      const dir = path.join(base, "tools", "expo-device-hub", version!);
      yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"),
        "",
      );
      yield* fs.writeFileString(path.join(dir, ".install-complete"), sentinel!);
    }
    const tools = yield* deviceToolVersions(base);
    expect(tools?.hub).toEqual({
      requiredVersion: DEVICE_HUB_VERSION,
      installedVersions: ["0.9.0"],
      runningVersion: null,
    });
    expect(tools?.agent.installedVersions).toEqual([]);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unreadable inventory stays unknown instead of reporting no installs", () =>
  Effect.gen(function* () {
    const tools = yield* deviceToolVersions("/unreadable");
    expect(tools).toBeUndefined();
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "denied",
            }),
          ),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
