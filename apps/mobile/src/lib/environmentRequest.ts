import { connectionTransportHeaders } from "@t3tools/client-runtime/connection";

/**
 * Headers a native loader sends with its request to `url`: an image view, a video or audio
 * player, a download, a WebView's first request, or Quick Look. They are the headers the
 * runtime's fetch and WebSocket already carry for the route's own host, such as a Cloudflare
 * Access service token, which Access checks before the request reaches T3 and which a signed
 * asset URL doesn't satisfy. A local file, a loopback forwarder's `http://127.0.0.1` origin and
 * any other host get none.
 */
export function environmentRequestHeaders(url: string): Record<string, string> | undefined {
  const headers = connectionTransportHeaders(url);
  return headers === undefined ? undefined : { ...headers };
}

/** `source` with the headers its `uri` needs, for an `Image`, player, viewer or WebView source. */
export function withEnvironmentRequestHeaders<T extends { readonly uri?: string | undefined }>(
  source: T,
): T & { readonly headers?: Record<string, string> } {
  const headers = source.uri === undefined ? undefined : environmentRequestHeaders(source.uri);
  return headers === undefined ? source : { ...source, headers };
}

/**
 * Whether a WebView page at `url` is on a plain Cloudflare Access route, whose host needs its
 * headers on every request. A WebView sends `source.headers` with its first request only, so the
 * page's own styles, images, scripts and frames reach Access without them, and Access's strict
 * service-token mode issues no cookie to stand in. An encrypted route's pages load from its
 * loopback forwarder, which needs none.
 */
export function webViewRequestsLackRouteHeaders(url: string): boolean {
  return connectionTransportHeaders(url) !== undefined;
}
