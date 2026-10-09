import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  CloudflareAccessDeniedError,
  cloudflareAccessHeaders,
  connectionTransportHeaders,
  holdSecureChannelHost,
  isCloudflareAccessDenied,
  isSecureChannelHost,
  markSecureChannelHost,
  SecureChannelRequiredError,
  setConnectionTransportHeaders,
  withConnectionTransportHeaders,
} from "./transportHeaders.ts";

const ACCESS = cloudflareAccessHeaders({ clientId: "id.access", clientSecret: "secret" });

afterEach(() => {
  setConnectionTransportHeaders("https://t3.example.test/", undefined);
});

/** A response as `fetch` returns it, from `url` after any redirects. */
function response(url: string, status: number, contentType: string): Response {
  const result = new Response(status === 204 ? null : "body", {
    status,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

describe("connection transport headers", () => {
  it("are sent only to the route's own host, and only over HTTPS and WSS", () => {
    setConnectionTransportHeaders("https://t3.example.test/", ACCESS);
    expect(connectionTransportHeaders("https://t3.example.test/api/x")).toEqual(ACCESS);
    expect(connectionTransportHeaders("wss://t3.example.test/ws?wsTicket=t")).toEqual(ACCESS);
    // A route learned on the LAN or Tailscale, and plain HTTP to the same name, get nothing.
    expect(connectionTransportHeaders("http://192.168.1.10:3773/api/x")).toBeUndefined();
    expect(connectionTransportHeaders("https://desk.tailnet.ts.net/api/x")).toBeUndefined();
    expect(connectionTransportHeaders("http://t3.example.test/api/x")).toBeUndefined();
    // Plain HTTP is never registered, so the token cannot travel in the clear.
    setConnectionTransportHeaders("http://plain.example.test/", ACCESS);
    expect(connectionTransportHeaders("http://plain.example.test/")).toBeUndefined();
  });

  it("refuse any plain request to an end-to-end encrypted route's host", async () => {
    markSecureChannelHost("https://quiet.example.test/");
    let sent = 0;
    const fetchWith = withConnectionTransportHeaders(async (input) => {
      sent += 1;
      return response(String(input), 200, "application/json");
    });
    const failure = await fetchWith("https://quiet.example.test/.well-known/t3/environment").catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(SecureChannelRequiredError);
    expect(isSecureChannelHost("wss://quiet.example.test/ws")).toBe(true);
    // Its local forwarder, and every other host, are untouched.
    await fetchWith("http://127.0.0.1:52811/.well-known/t3/environment");
    expect(sent).toBe(1);
  });

  it("hold a host for each pairing to it until that pairing ends, however they overlap", () => {
    const first = holdSecureChannelHost("https://overlap.example.test");
    const second = holdSecureChannelHost("https://overlap.example.test");
    first();
    first();
    expect(isSecureChannelHost("https://overlap.example.test/api")).toBe(true);
    second();
    expect(isSecureChannelHost("https://overlap.example.test/api")).toBe(false);

    const pairing = holdSecureChannelHost("https://kept.example.test");
    markSecureChannelHost("https://kept.example.test");
    pairing();
    expect(isSecureChannelHost("https://kept.example.test/api")).toBe(true);
  });

  it("are added to requests to that host and to no other", async () => {
    setConnectionTransportHeaders("https://t3.example.test/", ACCESS);
    const seen: Array<Headers> = [];
    const fetchWith = withConnectionTransportHeaders(async (input, init) => {
      seen.push(new Headers(init?.headers));
      return response(String(input), 200, "application/json");
    });
    await fetchWith("https://t3.example.test/oauth/token", {
      headers: { authorization: "Bearer x" },
    });
    await fetchWith("https://other.example.test/", {});
    expect(seen[0]?.get("CF-Access-Client-Id")).toBe("id.access");
    expect(seen[0]?.get("CF-Access-Client-Secret")).toBe("secret");
    expect(seen[0]?.get("authorization")).toBe("Bearer x");
    expect(seen[1]?.get("CF-Access-Client-Id")).toBeNull();
  });

  it("fail a request Cloudflare Access refused, and pass T3's own refusals through", async () => {
    setConnectionTransportHeaders("https://t3.example.test/", ACCESS);
    const answering = (answer: Response) => withConnectionTransportHeaders(async () => answer);
    const login = "https://team.cloudflareaccess.com/cdn-cgi/access/login/t3.example.test";
    await expect(
      answering(response(login, 200, "text/html"))("https://t3.example.test/x"),
    ).rejects.toBeInstanceOf(CloudflareAccessDeniedError);
    await expect(
      answering(response("https://t3.example.test/x", 403, "text/html"))(
        "https://t3.example.test/x",
      ),
    ).rejects.toBeInstanceOf(CloudflareAccessDeniedError);
    const t3 = await answering(response("https://t3.example.test/x", 403, "application/json"))(
      "https://t3.example.test/x",
    );
    expect(t3.status).toBe(403);
  });

  it("recognize an Access refusal however deeply the request error wraps it", () => {
    const denied = new CloudflareAccessDeniedError("https://t3.example.test/");
    expect(isCloudflareAccessDenied({ cause: { cause: denied } })).toBe(true);
    expect(isCloudflareAccessDenied(new Error("offline"))).toBe(false);
  });
});
