import { readHostedPairingRequest } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

/** A pairing URL from the form's fields; a server key makes the route end-to-end encrypted. */
export function buildPairingUrl(host: string, code: string, serverKey?: string): string {
  const h = host.trim();
  const c = code.trim();
  const k = serverKey?.trim() ?? "";
  if (!h) return "";
  if (!c) return h;

  const hash = new URLSearchParams([["token", c]]);
  if (k) hash.set("sk", k);
  try {
    const url = new URL(h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`);
    url.hash = hash.toString();
    return url.toString();
  } catch {
    return `${h}#${hash.toString()}`;
  }
}

export function parsePairingUrl(url: string): { host: string; code: string; serverKey: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "", serverKey: "" };

  try {
    const parsed = new URL(trimmed);
    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
        serverKey: "",
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";
    const serverKey = hashParams.get("sk") ?? "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code, serverKey };
  } catch {
    return { host: trimmed, code: "", serverKey: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Treat non-URL payloads as raw pairing-url text so the normal input validation can decide.
  }

  return trimmed;
}
