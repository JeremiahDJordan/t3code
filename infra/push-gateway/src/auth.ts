/**
 * Server credentials. The owner mints each one (`scripts/mint-credential.ts`) and stores only
 * its SHA-256 in the `PUSH_GATEWAY_CREDENTIALS` secret, a JSON array of `{ "id", "sha256" }`.
 * Adding or revoking a server is a `wrangler secret put` of the new list; no code changes.
 */

export interface CredentialEntry {
  readonly id: string;
  readonly sha256: string;
}

export function parseCredentialEntries(value: string | undefined): ReadonlyArray<CredentialEntry> {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    "sha256" in entry &&
    typeof entry.id === "string" &&
    typeof entry.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.sha256.toLowerCase())
      ? [{ id: entry.id, sha256: entry.sha256.toLowerCase() }]
      : [],
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The id of the credential the request presents, or null. */
export async function authenticate(
  authorization: string | null,
  entries: ReadonlyArray<CredentialEntry>,
): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match?.[1]) return null;
  const presented = await sha256Hex(match[1]);
  let found: string | null = null;
  // Compare against every entry so the time taken does not reveal which one matched.
  for (const entry of entries) {
    if (equalHex(presented, entry.sha256) && found === null) found = entry.id;
  }
  return found;
}
