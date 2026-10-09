import { channelKeyFingerprint, encodeChannelKey } from "@t3tools/shared/secureChannel/handshake";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, GlobalFlag } from "effect/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SecureChannelKey from "../secureChannel/SecureChannelKey.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** The server's channel key, read from the secrets of the server the flags locate. */
export const layerChannelKey = (config: ServerConfig.ServerConfig["Service"]) =>
  SecureChannelKey.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layer(config)),
  );

/** The public half as pairing links carry it. */
export const readChannelPublicKey = SecureChannelKey.SecureChannelKey.pipe(
  Effect.flatMap((key) => key.keyPair),
  Effect.map((keyPair) => encodeChannelKey(keyPair.publicKey)),
);

const runWithChannelKey = <A, E>(
  flags: CliAuthLocationFlags,
  run: (key: SecureChannelKey.SecureChannelKey["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    return yield* SecureChannelKey.SecureChannelKey.pipe(
      Effect.flatMap(run),
      Effect.provide(layerChannelKey(config)),
    );
  });

const describeKey = (publicKey: Uint8Array) =>
  [
    `Server key: ${encodeChannelKey(publicKey)}`,
    `Fingerprint: ${channelKeyFingerprint(publicKey)}`,
  ].join("\n");

const keyCommand = Command.make("key", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Print the end-to-end encrypted channel's server key and its fingerprint, creating the key if needed.",
  ),
  Command.withHandler((flags) =>
    runWithChannelKey(flags, (key) =>
      key.keyPair.pipe(Effect.flatMap((keyPair) => Console.log(describeKey(keyPair.publicKey)))),
    ),
  ),
);

const rotateCommand = Command.make("rotate", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Replace the channel's server key. Every client paired through the channel must pair again.",
  ),
  Command.withHandler((flags) =>
    runWithChannelKey(flags, (key) =>
      key.rotate.pipe(
        Effect.flatMap((keyPair) =>
          Console.log(
            [
              describeKey(keyPair.publicKey),
              "",
              "Restart the server to use it. Clients paired through the channel now fail closed; remove the environment on each and pair it again.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  ),
);

export const channelCommand = Command.make("channel").pipe(
  Command.withDescription("Manage the end-to-end encrypted channel for Cloudflare Tunnels."),
  Command.withSubcommands([keyCommand, rotateCommand]),
);
