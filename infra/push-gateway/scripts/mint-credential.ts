// @effect-diagnostics globalConsole:off -- a one-shot CLI that prints its result.
/**
 * Mints a server credential for the push gateway: `node scripts/mint-credential.ts <id>`.
 * Prints the secret once, for the server's T3CODE_PUSH_GATEWAY_CREDENTIAL, and the entry to add
 * to the gateway's PUSH_GATEWAY_CREDENTIALS list. The gateway keeps only the hash.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a one-shot CLI with no Effect runtime.
import * as NodeCrypto from "node:crypto";

const id = process.argv[2]?.trim();
if (!id || !/^[\w.-]{1,64}$/.test(id)) {
  console.error("Usage: node scripts/mint-credential.ts <id>   (letters, digits, . _ -)");
  process.exit(1);
}

const secret = `z6pg_${NodeCrypto.randomBytes(32).toString("base64url")}`;
const sha256 = NodeCrypto.createHash("sha256").update(secret).digest("hex");

console.log(
  `Server credential (set T3CODE_PUSH_GATEWAY_CREDENTIAL; shown only now):\n\n  ${secret}\n`,
);
console.log("Add this entry to the gateway's PUSH_GATEWAY_CREDENTIALS JSON array:\n");
console.log(`  ${JSON.stringify({ id, sha256 })}\n`);
