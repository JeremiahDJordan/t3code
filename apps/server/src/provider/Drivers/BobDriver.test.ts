import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { tmuxBobInstanceIds } from "./BobDriver.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("tmuxBobInstanceIds", () => {
  it("names the Bob instances that run Bob in tmux, built-in or added", () => {
    const settings = decodeSettings({
      providers: { bob: { sessionHost: "tmux" } },
      providerInstances: {
        bob_tmux: { driver: "bob", config: { sessionHost: "tmux" } },
        bob_plain: { driver: "bob", config: { sessionHost: "server" } },
        codex_tmux: { driver: "codex", config: { sessionHost: "tmux" } },
      },
    });
    expect([...tmuxBobInstanceIds(settings)].toSorted()).toEqual(["bob", "bob_tmux"]);
  });

  it("lets an added entry for the built-in instance replace its legacy settings", () => {
    const settings = decodeSettings({
      providers: { bob: { sessionHost: "tmux" } },
      providerInstances: { bob: { driver: "bob", config: { sessionHost: "server" } } },
    });
    expect([...tmuxBobInstanceIds(settings)]).toEqual([]);
  });
});
