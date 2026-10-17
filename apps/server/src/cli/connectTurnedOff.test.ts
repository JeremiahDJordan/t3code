import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { T3_CONNECT_DISABLED_MESSAGE } from "@t3tools/shared/forkFeatures";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { describe, expect } from "vite-plus/test";

import { makeCli } from "../binCli.ts";

// A refused `connect` fails with help whose error carries the reason.
const refusalOf = (args: ReadonlyArray<string>, options: Parameters<typeof makeCli>[0]) =>
  Command.runWith(makeCli(options), { version: "0.0.0" })(["connect", ...args]).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    Effect.flip,
    Effect.map((error) =>
      CliError.isCliError(error) && error._tag === "ShowHelp"
        ? error.errors.map((reason) => reason.message).join("\n")
        : String(error),
    ),
  );

describe("t3 connect with T3 Connect turned off", () => {
  it.effect.each([
    { args: [] },
    { args: ["--headless"] },
    { args: ["link", "--headless"] },
    { args: ["link", "--publish-only"] },
    { args: ["login"] },
    { args: ["status", "--json"] },
    { args: ["publish", "--disable"] },
    { args: ["unlink"] },
    { args: ["logout"] },
  ])("refuses `t3 connect $args` naming the flag", ({ args }) =>
    Effect.gen(function* () {
      const output = yield* refusalOf(args, { cloudEnabled: true, t3ConnectEnabled: false });
      expect(output).toBe(T3_CONNECT_DISABLED_MESSAGE);
    }),
  );

  it.effect("keeps upstream's message for a build without public configuration", () =>
    Effect.gen(function* () {
      const output = yield* refusalOf(["link"], { cloudEnabled: false, t3ConnectEnabled: true });
      expect(output).toContain("missing T3 Connect public configuration");
      expect(output).not.toContain(T3_CONNECT_DISABLED_MESSAGE);
    }),
  );
});
