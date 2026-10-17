import { describe, expect, it } from "vite-plus/test";

import { authenticate, parseCredentialEntries, sha256Hex } from "./auth.ts";

describe("credentials", () => {
  it("accepts a listed credential by its hash and names it", async () => {
    const entries = parseCredentialEntries(
      JSON.stringify([
        { id: "laptop", sha256: await sha256Hex("z6pg_laptop") },
        { id: "desktop", sha256: (await sha256Hex("z6pg_desktop")).toUpperCase() },
      ]),
    );
    expect(await authenticate("Bearer z6pg_laptop", entries)).toBe("laptop");
    expect(await authenticate("bearer z6pg_desktop", entries)).toBe("desktop");
  });

  it("refuses unknown, missing and revoked credentials", async () => {
    const entries = parseCredentialEntries(
      JSON.stringify([{ id: "laptop", sha256: await sha256Hex("z6pg_laptop") }]),
    );
    expect(await authenticate("Bearer z6pg_other", entries)).toBeNull();
    expect(await authenticate(null, entries)).toBeNull();
    expect(await authenticate("Basic z6pg_laptop", entries)).toBeNull();
    // Revoking is removing the entry.
    expect(await authenticate("Bearer z6pg_laptop", parseCredentialEntries("[]"))).toBeNull();
  });

  it("ignores malformed entries and an unreadable list", () => {
    expect(
      parseCredentialEntries(
        JSON.stringify([{ id: "short", sha256: "abc" }, { sha256: "0".repeat(64) }, "x"]),
      ),
    ).toEqual([]);
    expect(parseCredentialEntries("not json")).toEqual([]);
    expect(parseCredentialEntries(undefined)).toEqual([]);
  });
});
