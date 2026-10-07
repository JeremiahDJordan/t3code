import { webViewRequestsLackRouteHeaders } from "../../lib/environmentRequest";

/**
 * The URL an MCP app row loads, given the one it holds and the asset query's current one. An app
 * that started keeps its URL, since a re-minted one would reload it. One a plain Access route
 * kept from starting follows the current URL, so the row starts the app once the environment
 * moves to a route that can load it.
 */
export function mcpAppDocumentUri(held: string | null, current: string | undefined): string | null {
  if (held !== null && !webViewRequestsLackRouteHeaders(held)) return held;
  return current ?? held;
}
