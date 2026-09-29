// @effect-diagnostics nodeBuiltinImport:off - the tests arrange relay sockets and their folders on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import type { TmuxServer } from "../../tmux/TmuxServer.ts";
import { makeBobRelayHost } from "./BobRelay.ts";

/** No test here starts a relay, so none reaches tmux. */
const noTmux: TmuxServer["Service"] = {
  attachCommand: () => Effect.die("No relay starts in these tests."),
  available: Effect.succeed(false),
  run: () => Effect.die("No relay starts in these tests."),
  listSessions: Effect.succeed(new Set()),
  newSession: () => Effect.die("No relay starts in these tests."),
  killSession: () => Effect.void,
};

/** A fresh folder (mode 0700) removed when the test ends. */
const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

/** Sets an environment variable until the test ends. */
const withEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      process.env[name] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

/** Listens at `socketPath` until the test ends. */
const listen = (socketPath: string, onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer(onConnection);
      server.listen(socketPath, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("makeBobRelayHost", () => {
  it.live("keeps relay sockets outside the state directory only in a private folder", () =>
    Effect.gen(function* () {
      const runtimeDir = yield* tempDir("bob-relay-runtime-");
      yield* withEnv("XDG_RUNTIME_DIR", runtimeDir);
      // Too long for its relays' socket paths, which then go to the runtime directory.
      const stateDir = NodePath.join(yield* tempDir("bob-relay-state-"), "s".repeat(100));
      yield* makeBobRelayHost({ tmux: noTmux, stateDir });
      const names = yield* Effect.promise(() => NodeFSP.readdir(runtimeDir));
      expect(names).toEqual([expect.stringMatching(/^t3-bob-/)]);
      const socketDir = NodePath.join(runtimeDir, names[0] ?? "");
      const refusal = `Bob relay socket folder ${socketDir} is not a private folder owned by you.`;

      // Others can reach it.
      yield* Effect.promise(() => NodeFSP.chmod(socketDir, 0o777));
      const open = yield* Effect.flip(makeBobRelayHost({ tmux: noTmux, stateDir }));
      expect(open.message).toContain(refusal);

      // A link can be pointed elsewhere later, even when it now leads to a private folder.
      const privateDir = yield* tempDir("bob-relay-private-");
      yield* Effect.promise(async () => {
        await NodeFSP.rm(socketDir, { recursive: true });
        await NodeFSP.symlink(privateDir, socketDir);
      });
      const linked = yield* Effect.flip(makeBobRelayHost({ tmux: noTmux, stateDir }));
      expect(linked.message).toContain(refusal);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("removes a socket nothing listens at, and keeps one whose relay does not answer", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempDir("bob-relay-");
      const relay = yield* makeBobRelayHost({ tmux: noTmux, stateDir });
      const socketDir = NodePath.join(stateDir, "bob-tmux");
      // A relay killed outright leaves its socket behind.
      const stale = NodePath.join(socketDir, "stale.sock");
      NodeChildProcess.spawnSync(process.execPath, [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
        stale,
      ]);
      expect(NodeFS.existsSync(stale)).toBe(true);
      // Something listens but sends no state, as a relay too busy to answer.
      const silent = NodePath.join(socketDir, "silent.sock");
      yield* listen(silent, (socket) => socket.destroy());

      expect(yield* relay.scan).toEqual([]);
      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(NodeFS.existsSync(silent)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
