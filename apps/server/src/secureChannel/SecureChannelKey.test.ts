import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SecureChannelKey from "./SecureChannelKey.ts";

const layer = SecureChannelKey.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secure-channel-key-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("secure channel key", (it) => {
  it.effect("keeps the key it loaded until this process rotates it, whatever another writes", () =>
    Effect.gen(function* () {
      const key = yield* SecureChannelKey.SecureChannelKey;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const first = yield* key.keyPair;

      // As `t3 channel rotate` does from another process; it takes effect on restart.
      yield* secrets.set("secure-channel-x25519", new Uint8Array(32).fill(7));
      expect((yield* key.keyPair).publicKey).toEqual(first.publicKey);

      const rotated = yield* key.rotate;
      expect(rotated.publicKey).not.toEqual(first.publicKey);
      expect((yield* key.keyPair).publicKey).toEqual(rotated.publicKey);
    }),
  );
});
