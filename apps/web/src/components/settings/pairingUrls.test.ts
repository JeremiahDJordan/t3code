import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getChannelKeyFromUrl, getPairingTokenFromUrl } from "../../pairingUrl";
import {
  parseSecureChannelOrigin,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
  resolveSecureChannelPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it("puts the encrypted tunnel's server key in the link, where clients read it back", () => {
    const url = new URL(
      resolveSecureChannelPairingUrl("https://quiet.example.com", "PAIRCODE", "SERVERKEY"),
    );
    expect(`${url.origin}${url.pathname}${url.search}`).toBe("https://quiet.example.com/pair");
    expect(getPairingTokenFromUrl(url)).toBe("PAIRCODE");
    expect(getChannelKeyFromUrl(url)).toBe("SERVERKEY");
  });

  it("takes the tunnel's public URL as an origin and refuses anything else", () => {
    expect(parseSecureChannelOrigin(" https://quiet.example.com/some/path ")).toBe(
      "https://quiet.example.com",
    );
    expect(parseSecureChannelOrigin("quiet.example.com")).toBeNull();
    expect(parseSecureChannelOrigin("ftp://quiet.example.com")).toBeNull();
  });
});
