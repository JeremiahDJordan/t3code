/**
 * Optional integration check against a real `bob acp` install.
 * Enable with: T3_BOB_ACP_PROBE=1 vp test run BobAcpCliProbe
 *
 * A signed-in Bob (IBM SSO, or BOB_API_KEY when set) opens a session. Without an
 * account Bob must refuse with the error T3 turns into sign-in guidance,
 * never by opening a browser.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  bobSignInMessage,
  describeBobAcpSetupError,
  makeBobAcpRuntime,
  readBobApiKey,
} from "./BobAcpSupport.ts";

describe.runIf(process.env.T3_BOB_ACP_PROBE === "1")("Bob ACP CLI probe", () => {
  it.effect("opens a session or reports that Bob is not signed in", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-bob-probe-" });
      const authMethod = readBobApiKey(process.env) ? "apiKey" : "sso";
      const runtime = yield* makeBobAcpRuntime({
        bobSettings: { binaryPath: "bob", authMethod },
        environment: process.env,
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        cwd,
        clientInfo: { name: "t3-bob-probe", version: "0.0.0" },
      });
      const started = yield* runtime.start().pipe(Effect.result);
      if (Result.isSuccess(started)) {
        expect(started.success.sessionId.length).toBeGreaterThan(0);
      } else {
        expect(describeBobAcpSetupError(started.failure, authMethod)).toBe(
          bobSignInMessage(authMethod),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
