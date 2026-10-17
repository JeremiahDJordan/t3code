import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

// A one-record Chromium Local Storage LevelDB: a manifest and a write-ahead log holding a batch of
// `_<origin>\0\x01<key>` → `\x01<value>` puts, each block framed with LevelDB's masked CRC32C.
const varint = (value: number) => {
  const bytes: Array<number> = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(low + (value > 0 ? 128 : 0));
  } while (value > 0);
  return Buffer.from(bytes);
};
const lengthPrefixed = (bytes: Buffer) => Buffer.concat([varint(bytes.length), bytes]);
const logRecord = (payload: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from([1]), payload])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(7);
  header.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
};
const localStorageFiles = (origin: string, entries: Record<string, string>) => {
  const batch = Buffer.alloc(12);
  batch.writeBigUInt64LE(1n);
  batch.writeUInt32LE(Object.keys(entries).length, 8);
  const puts = Object.entries(entries).map(([key, value]) =>
    Buffer.concat([
      Buffer.from([1]),
      lengthPrefixed(Buffer.from(`_${origin}\0\x01${key}`)),
      lengthPrefixed(Buffer.from(`\x01${value}`)),
    ]),
  );
  return {
    CURRENT: Buffer.from("MANIFEST-000001\n"),
    "MANIFEST-000001": logRecord(Buffer.from([2, 1, 3, 2, 4, 2])),
    "000001.log": logRecord(Buffer.concat([batch, ...puts])),
  };
};

const importFrom = (profileName: string, origin: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "z6-legacy-storage-" });
    const leveldb = path.join(appData, profileName, "Local Storage", "leveldb");
    yield* fs.makeDirectory(leveldb, { recursive: true });
    for (const [name, bytes] of Object.entries(
      localStorageFiles(origin, { "t3code:theme": "dark" }),
    )) {
      yield* fs.writeFile(path.join(leveldb, name), bytes);
    }
    const userData = path.join(appData, "z6code");
    yield* fs.makeDirectory(userData);
    return yield* Effect.gen(function* () {
      const storage = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
      yield* storage.load(userData);
      return Option.getOrUndefined(yield* storage.take);
    }).pipe(
      Effect.provide(
        DesktopLegacyLocalStorage.layer.pipe(
          Layer.provide(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              isDevelopment: false,
              appDataDirectory: appData,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
        ),
      ),
    );
  });

it.layer(NodeServices.layer)("DesktopLegacyLocalStorage", (it) => {
  it.effect("imports a V1 profile's storage, kept under upstream's origin", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* importFrom("T3 Code (Alpha)", "t3code://app"), {
        "t3code:theme": "dark",
      });
    }).pipe(Effect.scoped),
  );
});
