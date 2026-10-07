import {
  cloudflareAccessHeaders,
  setConnectionTransportHeaders,
} from "@t3tools/client-runtime/connection";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mcpAppDocumentUri } from "./mcpAppDocumentUri";

const ACCESS_ROUTE = "https://t3.access.example/";
const ACCESS = cloudflareAccessHeaders({ clientId: "id.access", clientSecret: "secret" });
const PLAIN_ACCESS = "https://t3.access.example/api/assets/plain/app.html";
const ENCRYPTED = "http://127.0.0.1:52801/api/assets/encrypted/app.html";

afterEach(() => {
  setConnectionTransportHeaders(ACCESS_ROUTE, undefined);
});

describe("mcpAppDocumentUri", () => {
  it("takes the first URL the asset query gives", () => {
    expect(mcpAppDocumentUri(null, undefined)).toBeNull();
    expect(mcpAppDocumentUri(null, ENCRYPTED)).toBe(ENCRYPTED);
  });

  it("starts an app a plain Access route blocked once the route moves to an encrypted one", () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    const blocked = mcpAppDocumentUri(null, PLAIN_ACCESS);
    expect(blocked).toBe(PLAIN_ACCESS);

    // Still loading the new route's URL: the row keeps its note.
    expect(mcpAppDocumentUri(blocked, undefined)).toBe(PLAIN_ACCESS);
    expect(mcpAppDocumentUri(blocked, ENCRYPTED)).toBe(ENCRYPTED);
  });

  it("keeps a started app on its URL when the asset URL changes", () => {
    const started = mcpAppDocumentUri(null, ENCRYPTED);
    const reminted = "http://127.0.0.1:52802/api/assets/reminted/app.html";
    expect(mcpAppDocumentUri(started, reminted)).toBe(ENCRYPTED);

    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    expect(mcpAppDocumentUri(started, PLAIN_ACCESS)).toBe(ENCRYPTED);
  });
});
