import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type AdoptableBobRelay, type BobRelayLink, makeBobRelays } from "./BobRelay.ts";

/** A link that records its spawn, for a host that records what it was asked to do. */
function recordingLink(name: string, calls: Array<string>): BobRelayLink {
  return {
    spawner: ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        calls.push(name);
        return undefined as never;
      }),
    ),
    setMeta: () => Effect.void,
    turnStarted: Effect.void,
    turnSettled: Effect.void,
    adopt: Effect.succeed(false),
    adopted: Effect.succeed(false),
    kept: Effect.succeed(undefined),
    openTools: Effect.succeed([]),
    retire: Effect.void,
  };
}

describe("makeBobRelays", () => {
  it.effect("takes over a Bob only in the mode it was started for", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const relays = makeBobRelays({
        host: {
          available: Effect.succeed(true),
          link: () => recordingLink("start", calls),
          attach: (relayId) => recordingLink(`attach ${relayId}`, calls),
          scan: Effect.succeed([]),
          kill: (relayId) => Effect.sync(() => void calls.push(`stop ${relayId}`)),
        },
        instanceId: "bob",
        adoptable: new Map<string, AdoptableBobRelay>([
          ["task-1", { relayId: "relay-1", autoApprove: true, mode: "full-access" }],
          ["task-2", { relayId: "relay-2", autoApprove: true, mode: "full-access" }],
          ["task-3", { relayId: "relay-3", autoApprove: false, mode: "auto-accept-edits" }],
          ["task-4", { relayId: "relay-4", autoApprove: false, mode: "auto" }],
          // Started by an older T3, which did not record its mode.
          ["task-5", { relayId: "relay-5", autoApprove: false }],
        ]),
        ready: Effect.void,
      });
      const spawn = (resumeSessionId: string, mode: string) =>
        relays
          .linkFor({
            cwd: "/workspace",
            resumeSessionId,
            autoApprove: mode === "full-access",
            mode,
          })
          .spawner.spawn(ChildProcess.make("bob", ["acp"]))
          .pipe(
            Effect.scoped,
            Effect.map(() => calls.splice(0)),
          );

      // After a switch out of Full access, its Bob stops and one that asks starts instead.
      assert.deepEqual(yield* spawn("task-1", "auto"), ["stop relay-1", "start"]);
      assert.deepEqual(yield* spawn("task-2", "full-access"), ["attach relay-2"]);
      // After any other switch too, since its commands run under the old mode's sandbox profile.
      assert.deepEqual(yield* spawn("task-3", "approval-required"), ["stop relay-3", "start"]);
      assert.deepEqual(yield* spawn("task-4", "auto"), ["attach relay-4"]);
      assert.deepEqual(yield* spawn("task-5", "approval-required"), ["attach relay-5"]);
      // Each relay is taken over once.
      assert.deepEqual(yield* spawn("task-2", "full-access"), ["start"]);
    }),
  );
});
