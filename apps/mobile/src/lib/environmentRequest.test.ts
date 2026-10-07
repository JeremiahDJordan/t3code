import {
  cloudflareAccessHeaders,
  setConnectionTransportHeaders,
} from "@t3tools/client-runtime/connection";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  environmentRequestHeaders,
  webViewRequestsLackRouteHeaders,
  withEnvironmentRequestHeaders,
} from "./environmentRequest";

const ACCESS_ROUTE = "https://t3.access.example/";
const ACCESS = cloudflareAccessHeaders({ clientId: "id.access", clientSecret: "secret" });

afterEach(() => {
  setConnectionTransportHeaders(ACCESS_ROUTE, undefined);
});

describe("environment request headers for native loaders", () => {
  it("give a signed asset URL on an Access route the route's service token", () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    const signed = "https://t3.access.example/api/assets/signed-token/photo.png";

    expect(environmentRequestHeaders(signed)).toEqual(ACCESS);
    expect(withEnvironmentRequestHeaders({ uri: signed })).toEqual({
      uri: signed,
      headers: ACCESS,
    });
    expect(withEnvironmentRequestHeaders({ uri: signed, contentType: "progressive" })).toEqual({
      uri: signed,
      contentType: "progressive",
      headers: ACCESS,
    });
  });

  it("send nothing to a loopback forwarder, another host or a local file", () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    for (const uri of [
      "http://127.0.0.1:52801/api/assets/signed-token/photo.png",
      "https://desk.tailnet.ts.net/api/assets/signed-token/photo.png",
      "http://t3.access.example/api/assets/signed-token/photo.png",
      "file:///cache/t3-attachment-downloads/photo.png",
    ]) {
      expect(environmentRequestHeaders(uri)).toBeUndefined();
      const source = { uri };
      expect(withEnvironmentRequestHeaders(source)).toBe(source);
    }
  });

  it("hand a loader its own copy, so a native API cannot change the route's headers", () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    const uri = "https://t3.access.example/api/assets/signed-token/clip.mp4";
    const headers = environmentRequestHeaders(uri)!;
    headers["CF-Access-Client-Secret"] = "changed";
    expect(environmentRequestHeaders(uri)).toEqual(ACCESS);
  });
});

describe("WebView pages on a plain Access route", () => {
  const page = "https://t3.access.example/api/assets/signed-token/report.html";

  it("are restricted while the route's host needs its service token", () => {
    expect(webViewRequestsLackRouteHeaders(page)).toBe(false);

    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    expect(webViewRequestsLackRouteHeaders(page)).toBe(true);
    expect(webViewRequestsLackRouteHeaders("https://t3.access.example/other/page.html")).toBe(true);

    setConnectionTransportHeaders(ACCESS_ROUTE, undefined);
    expect(webViewRequestsLackRouteHeaders(page)).toBe(false);
  });

  it("are left alone on an encrypted route's forwarder and every other host", () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    for (const uri of [
      "http://127.0.0.1:52801/api/assets/signed-token/report.html",
      "https://desk.tailnet.ts.net/api/assets/signed-token/report.html",
      "https://t3.access.example:8443/api/assets/signed-token/report.html",
      "http://t3.access.example/api/assets/signed-token/report.html",
      "file:///cache/report.html",
      "not a url",
    ]) {
      expect(webViewRequestsLackRouteHeaders(uri)).toBe(false);
    }
  });
});
