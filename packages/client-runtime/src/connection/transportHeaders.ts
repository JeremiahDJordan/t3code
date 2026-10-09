/**
 * Headers a route's own address needs on every request before T3 sees it, such as a Cloudflare
 * Access service token. They are kept by host and attached over HTTPS and WSS only, below the HTTP
 * client and the WebSocket constructor, so every request reaches them, a route learned on another
 * address never gets them, and traces never record them.
 *
 * @module connection/transportHeaders
 */

const headersByHost = new Map<string, Readonly<Record<string, string>>>();
/** Hosts reached only through the end-to-end encrypted channel, which never get a plain request. */
const secureChannelHosts = new Set<string>();
/** Hosts held for pairings still running, counted, so one pairing's end leaves another's hold. */
const pairingHolds = new Map<string, number>();

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Marks a channel route's host, so a plain request to it fails instead of leaving the channel.
 * The route itself is used through its local forwarder; this guards any path that forgets.
 */
export function markSecureChannelHost(httpBaseUrl: string): void {
  const host = hostOf(httpBaseUrl);
  if (host !== undefined) secureChannelHosts.add(host);
}

/**
 * Treats a host as encrypted-only while a pairing to it runs; the returned release undoes only
 * this hold. A pairing that succeeds marks the host for good with `markSecureChannelHost`.
 */
export function holdSecureChannelHost(httpBaseUrl: string): () => void {
  const host = hostOf(httpBaseUrl);
  if (host === undefined) return () => undefined;
  pairingHolds.set(host, (pairingHolds.get(host) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pairingHolds.get(host) ?? 1) - 1;
    if (remaining > 0) pairingHolds.set(host, remaining);
    else pairingHolds.delete(host);
  };
}

export function isSecureChannelHost(url: string): boolean {
  const host = hostOf(url);
  return host !== undefined && (secureChannelHosts.has(host) || pairingHolds.has(host));
}

/** What a plain request to a channel route's host fails with. */
export class SecureChannelRequiredError extends Error {
  readonly _tag = "SecureChannelRequiredError";
  constructor(url: string) {
    super(`${hostOf(url) ?? url} is reached only through its end-to-end encrypted channel.`);
  }
}

/** The host of a secure URL; none for plain HTTP or WS, which would send the headers in the clear. */
function secureHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "wss:" ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/** Sets the headers requests to the host of `httpBaseUrl` carry, or with none clears them. */
export function setConnectionTransportHeaders(
  httpBaseUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
): void {
  const host = secureHost(httpBaseUrl);
  if (host === undefined) return;
  if (headers === undefined) headersByHost.delete(host);
  else headersByHost.set(host, headers);
}

/** The headers a request to `url` carries, if its route needs any. */
export function connectionTransportHeaders(
  url: string,
): Readonly<Record<string, string>> | undefined {
  const host = secureHost(url);
  return host === undefined ? undefined : headersByHost.get(host);
}

/** A Cloudflare Access service token, which Access checks on every request to its hostname. */
export interface CloudflareAccessServiceToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function cloudflareAccessHeaders(
  token: CloudflareAccessServiceToken,
): Readonly<Record<string, string>> {
  return {
    "CF-Access-Client-Id": token.clientId,
    "CF-Access-Client-Secret": token.clientSecret,
  };
}

/** What a request fails with when Cloudflare Access turns it away. */
export class CloudflareAccessDeniedError extends Error {
  readonly _tag = "CloudflareAccessDeniedError";
  constructor(url: string) {
    super(`Cloudflare Access rejected the service token for ${new URL(url).host}.`);
  }
}

/**
 * Access sends a request it refuses to its login page, which `fetch` follows, or answers it with
 * a page of its own; T3 itself answers 401 and 403 in JSON.
 */
export function deniedByCloudflareAccess(response: Response): boolean {
  if (response.url.includes("/cdn-cgi/access/")) return true;
  return (
    (response.status === 401 || response.status === 403) &&
    !(response.headers.get("content-type") ?? "").includes("json")
  );
}

/** `fetch` with each route's transport headers, failing a request Cloudflare Access refused. */
export function withConnectionTransportHeaders(
  fetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isSecureChannelHost(url)) throw new SecureChannelRequiredError(url);
    const extra = connectionTransportHeaders(url);
    if (extra === undefined) return fetchFn(input, init);
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && "headers" in input ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    const response = await fetchFn(input, { ...init, headers });
    if (deniedByCloudflareAccess(response)) throw new CloudflareAccessDeniedError(url);
    return response;
  };
}

/** Whether a request failed because Cloudflare Access refused it, however deeply wrapped. */
export function isCloudflareAccessDenied(cause: unknown): boolean {
  for (let current = cause, depth = 0; depth < 5; depth += 1) {
    if (current instanceof CloudflareAccessDeniedError) return true;
    if (typeof current !== "object" || current === null || !("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}
