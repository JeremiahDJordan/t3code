import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type BobRelayLink, makeBobRelays } from "./BobRelay.ts";

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
  it.effect("takes over a Bob that approves its own tools only in Full access", () =>
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
        adoptable: new Map([
          ["task-1", { relayId: "relay-1", autoApprove: true }],
          ["task-2", { relayId: "relay-2", autoApprove: true }],
          ["task-3", { relayId: "relay-3", autoApprove: false }],
        ]),
        ready: Effect.void,
      });
      const spawn = (resumeSessionId: string, autoApprove: boolean) =>
        relays
          .linkFor({ cwd: "/workspace", resumeSessionId, autoApprove })
          .spawner.spawn(ChildProcess.make("bob", ["acp"]))
          .pipe(
            Effect.scoped,
            Effect.map(() => calls.splice(0)),
          );

      // After a switch out of Full access, its Bob stops and one that asks starts instead.
      assert.deepEqual(yield* spawn("task-1", false), ["stop relay-1", "start"]);
      assert.deepEqual(yield* spawn("task-2", true), ["attach relay-2"]);
      // A Bob that asks may be taken over in any mode.
      assert.deepEqual(yield* spawn("task-3", false), ["attach relay-3"]);
      // Each relay is taken over once.
      assert.deepEqual(yield* spawn("task-2", true), ["start"]);
    }),
  );
});
