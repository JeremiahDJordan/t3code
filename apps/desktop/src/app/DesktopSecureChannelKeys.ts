// @effect-diagnostics nodeBuiltinImport:off -- node:crypto's HMAC and random bytes derive route keys in the main process.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopSecureChannelKeysError extends Schema.TaggedError<DesktopSecureChannelKeysError>()(
  "DesktopSecureChannelKeysError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "secure-storage"
      ? "End-to-end encrypted routes need the system keychain, which T3 Code can't use on this machine."
      : `The desktop's encrypted route keys are unavailable: ${this.operation} failed.`;
  }
}

/**
 * The desktop's keys for end-to-end encrypted routes, which never leave the main process. The
 * renderer keeps an id per route; the route's key is HMAC-SHA256 of that id under a master secret
 * saved here with the OS keychain's protection. A compromised renderer can use a forwarder while
 * it runs, but can't take a key that makes the route's token work from anywhere else.
 */
export class DesktopSecureChannelKeys extends Context.Service<
  DesktopSecureChannelKeys,
  {
    /** A new id for a route's key, which the renderer saves with the route's credential. */
    readonly createKeyId: Effect.Effect<string>;
    /** The route's key for an id, base64url. */
    readonly keyFor: (keyId: string) => Effect.Effect<string, DesktopSecureChannelKeysError>;
  }
>()("@t3tools/desktop/app/DesktopSecureChannelKeys") {}

const MasterDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedSecret: Schema.String,
});
const decodeMasterDocument = Schema.decodeEffect(Schema.fromJsonString(MasterDocument));
const encodeMasterDocument = Schema.encodeEffect(Schema.fromJsonString(MasterDocument));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const masterPath = path.join(environment.stateDir, "secure-channel-keys.json");
  const failed = (operation: string) => (cause: unknown) =>
    new DesktopSecureChannelKeysError({ operation, cause });

  const readMaster = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(masterPath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(failed("read")(error)),
      ),
    );
    if (Option.isNone(raw)) return Option.none<Uint8Array>();
    const document = yield* decodeMasterDocument(raw.value).pipe(Effect.mapError(failed("decode")));
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedSecret)).pipe(
      Effect.mapError(failed("decode")),
    );
    const secret = yield* safeStorage
      .decryptString(encrypted)
      .pipe(Effect.mapError(failed("decrypt")));
    return Option.some(new Uint8Array(Buffer.from(secret, "base64url")));
  });

  const createMaster = Effect.gen(function* () {
    const secret = new Uint8Array(NodeCrypto.randomBytes(32));
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    // A secret that lasted one launch would give every route a new key on each restart, which
    // the gateway can only answer with silence, so routes refuse to start instead.
    if (!available) return yield* failed("secure-storage")("Secure storage is unavailable.");
    const encrypted = yield* safeStorage
      .encryptString(Buffer.from(secret).toString("base64url"))
      .pipe(Effect.mapError(failed("encrypt")));
    const document = yield* encodeMasterDocument({
      version: 1,
      encryptedSecret: Base64.encode(encrypted),
    }).pipe(Effect.mapError(failed("encode")));
    // Written beside and renamed into place, so a crash never leaves half a secret.
    const temporary = `${masterPath}.${process.pid}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(masterPath), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(temporary, document, { mode: 0o600 })),
        Effect.andThen(fileSystem.rename(temporary, masterPath)),
        Effect.mapError(failed("write")),
      );
    return secret;
  });

  // Kept once read, one load at a time; a failure isn't kept, so a keychain that was locked at
  // launch, or a keyring that started late, works on the next try.
  const loaded = yield* Ref.make(Option.none<Uint8Array>());
  const loading = yield* Semaphore.make(1);
  const master = loading.withPermits(1)(
    Ref.get(loaded).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            readMaster.pipe(
              Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => createMaster })),
              Effect.tap((secret) => Ref.set(loaded, Option.some(secret))),
            ),
        }),
      ),
    ),
  );

  return DesktopSecureChannelKeys.of({
    createKeyId: Effect.sync(() => NodeCrypto.randomBytes(32).toString("base64url")),
    keyFor: (keyId) =>
      master.pipe(
        Effect.map((secret) =>
          NodeCrypto.createHmac("sha256", secret)
            .update(`t3-channel-client-key:${keyId}`)
            .digest("base64url"),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopSecureChannelKeys, make);
