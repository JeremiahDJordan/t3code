import { keyPairFromSecretKey, type KeyPair } from "@t3tools/shared/secureChannel/noise";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** The secret store entry holding the channel's X25519 secret key, at mode 0600. */
const SECRET_NAME = "secure-channel-x25519";

/**
 * The server's static key for the end-to-end encrypted channel. Pairing links carry its public
 * half, which is the root of trust a client pins; it never travels through the tunnel itself.
 */
export class SecureChannelKey extends Context.Service<
  SecureChannelKey,
  {
    /**
     * The key this process uses, read once and kept, so the gateway and the config Settings reads
     * agree. A key `t3 channel rotate` writes from another process takes effect on restart.
     */
    readonly keyPair: Effect.Effect<KeyPair, ServerSecretStore.SecretStoreError>;
    /** Replaces the key. Every paired client fails closed until it pairs again. */
    readonly rotate: Effect.Effect<KeyPair, ServerSecretStore.SecretStoreError>;
  }
>()("t3/secureChannel/SecureChannelKey") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const loaded = yield* Ref.make(Option.none<KeyPair>());
  const remember = (keyPair: KeyPair) => Ref.set(loaded, Option.some(keyPair));
  return SecureChannelKey.of({
    keyPair: Ref.get(loaded).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            secrets
              .getOrCreateRandom(SECRET_NAME, 32)
              .pipe(Effect.map(keyPairFromSecretKey), Effect.tap(remember)),
        }),
      ),
    ),
    rotate: crypto.randomBytes(32).pipe(
      Effect.orDie,
      Effect.tap((secretKey) => secrets.set(SECRET_NAME, secretKey)),
      Effect.map(keyPairFromSecretKey),
      Effect.tap(remember),
    ),
  });
});

export const layer = Layer.effect(SecureChannelKey, make);
