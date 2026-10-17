import { buildHostedPairingUrl, configuredHostedAppUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  // No hosted app is configured by default; pairing then uses the server's own address.
  if (url.protocol !== "https:" || configuredHostedAppUrl() === "") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

/** A pairing link for the end-to-end encrypted tunnel, carrying the server key it pins. */
export function resolveSecureChannelPairingUrl(
  publicOrigin: string,
  credential: string,
  serverKey: string,
): string {
  return setPairingTokenOnUrl(new URL("/pair", publicOrigin), credential, serverKey).toString();
}

export { parseChannelOrigin as parseSecureChannelOrigin } from "@t3tools/shared/secureChannel/handshake";
