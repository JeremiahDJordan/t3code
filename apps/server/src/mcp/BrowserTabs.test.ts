import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { detectBrowsers } from "./BrowserTabs.ts";

const profile = Effect.fn("test.browserProfile")(function* (
  root: string,
  relative: string,
  port?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, ...relative.split("/"));
  yield* fs.makeDirectory(dir, { recursive: true });
  if (port !== undefined)
    yield* fs.writeFileString(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/x`);
  return dir;
});

it.layer(NodeServices.layer)("detectBrowsers", (it) => {
  it.effect.each([
    {
      platform: "darwin" as const,
      env: (root: string) => ({ HOME: root }),
      chrome: "Library/Application Support/Google/Chrome",
      edge: "Library/Application Support/Microsoft Edge",
    },
    {
      platform: "linux" as const,
      env: (root: string) => ({ HOME: "/nonexistent", XDG_CONFIG_HOME: root }),
      chrome: "google-chrome",
      edge: "microsoft-edge",
    },
    {
      platform: "win32" as const,
      env: (root: string) => ({ LOCALAPPDATA: root }),
      chrome: "Google/Chrome/User Data",
      edge: "Microsoft/Edge/User Data",
    },
  ])("finds $platform profiles, the one with remote debugging on first", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-tabs-" });
      yield* profile(root, testCase.chrome);
      const edgeDir = yield* profile(root, testCase.edge, 9222);

      const browsers = yield* detectBrowsers().pipe(
        Effect.provideService(HostProcess.Platform, testCase.platform),
        Effect.provideService(HostProcess.Environment, testCase.env(root)),
      );

      expect(browsers.map(({ id, remoteDebugging }) => ({ id, remoteDebugging }))).toEqual([
        { id: "edge", remoteDebugging: true },
        { id: "chrome", remoteDebugging: false },
      ]);
      expect(browsers[0]?.userDataDir).toBe(edgeDir);
      expect(browsers[0]?.inspectUrl).toBe("edge://inspect/#remote-debugging");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a port file the server may not read as blocked, not as debugging off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-tabs-" });
      yield* profile(root, "Library/Application Support/Microsoft Edge");
      const chromeDir = yield* profile(root, "Library/Application Support/Google/Chrome", 9222);
      const blockedFile = path.join(chromeDir, "DevToolsActivePort");
      // macOS app data protection fails the read with EPERM, which reaches us as Unknown.
      const guarded: FileSystem.FileSystem = {
        ...fs,
        readFileString: (file, encoding) =>
          file === blockedFile
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "readFile",
                  description: "EPERM: operation not permitted",
                }),
              )
            : fs.readFileString(file, encoding),
      };

      const browsers = yield* detectBrowsers().pipe(
        Effect.provideService(FileSystem.FileSystem, guarded),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { HOME: root }),
      );

      expect(
        browsers.map(({ id, remoteDebugging, accessBlocked }) => ({
          id,
          remoteDebugging,
          accessBlocked,
        })),
      ).toEqual([
        { id: "chrome", remoteDebugging: false, accessBlocked: true },
        { id: "edge", remoteDebugging: false, accessBlocked: false },
      ]);
    }).pipe(Effect.scoped),
  );
});
