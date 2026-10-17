import { afterEach, describe, expect, it, vi } from "vite-plus/test";

async function loadLegalDocumentUrls(siteUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", siteUrl);
  return import("./legal-document-url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legal documents", () => {
  it("has no legal pages without a configured site", async () => {
    const legal = await loadLegalDocumentUrls(undefined);

    expect(legal.LEGAL_URL).toBeNull();
    expect(legal.ALLOWED_LEGAL_DOCUMENT_URLS).toEqual([]);
    expect(legal.isLegalDocumentUrl("https://example.com/legal")).toBe(false);
  });

  it.each(["", "ftp://example.com", "not-a-url"])(
    "ignores a site URL that is not http(s): %j",
    async (value) => {
      expect((await loadLegalDocumentUrls(value)).LEGAL_URL).toBeNull();
    },
  );

  describe("with the owner's site", () => {
    it.each([
      "https://example.com/legal",
      "https://example.com/legal/",
      "https://example.com/privacy-policy?source=app",
      "https://example.com/terms-of-service#updates",
      "https://example.com/security-policy",
    ])("allows a configured legal document: %s", async (url) => {
      const legal = await loadLegalDocumentUrls("https://example.com/?ref=app");

      expect(legal.LEGAL_URL).toBe("https://example.com/legal");
      expect(legal.isLegalDocumentUrl(url)).toBe(true);
    });

    it.each([
      "https://example.com/download",
      "https://other.example.com/legal",
      "javascript:alert(1)",
      "not-a-url",
    ])("rejects a URL outside the legal-document allowlist: %s", async (url) => {
      const legal = await loadLegalDocumentUrls("https://example.com");

      expect(legal.isLegalDocumentUrl(url)).toBe(false);
    });
  });
});
