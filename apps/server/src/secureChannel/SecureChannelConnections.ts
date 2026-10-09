import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

/**
 * Which loopback connections into the server came through the secure channel gateway, and for
 * which client key. The gateway records a connection's local port before it sends a byte, and
 * forgets it when the connection closes; the server's auth reads the request's remote port. No
 * header can claim it, and another local process connecting directly never matches.
 */
export class SecureChannelConnections extends Context.Service<
  SecureChannelConnections,
  {
    /** Records the gateway's end of a connection, as `socket.localAddress` and `localPort`. */
    readonly register: (
      local: { readonly address: string; readonly port: number },
      clientKey: string,
    ) => void;
    readonly unregister: (localPort: number) => void;
    /** The base64url client key of the channel a request arrived through, if it did. */
    readonly clientKeyOf: (request: HttpServerRequest.HttpServerRequest) => string | undefined;
  }
>()("t3/secureChannel/SecureChannelConnections") {}

/** Node reports an IPv4 peer of a dual-stack listener as `::ffff:a.b.c.d`. */
const normalizeAddress = (address: string) => address.replace(/^::ffff:/, "");

function remoteEndpoint(source: unknown): { address: string; port: number } | undefined {
  if (!source || typeof source !== "object" || !("socket" in source)) return undefined;
  const socket = source.socket;
  if (!socket || typeof socket !== "object") return undefined;
  const address = "remoteAddress" in socket ? socket.remoteAddress : undefined;
  const port = "remotePort" in socket ? socket.remotePort : undefined;
  return typeof address === "string" && typeof port === "number" ? { address, port } : undefined;
}

export const make = () => {
  const connections = new Map<number, { readonly address: string; readonly clientKey: string }>();
  return SecureChannelConnections.of({
    register: (local, clientKey) => {
      connections.set(local.port, { address: normalizeAddress(local.address), clientKey });
    },
    unregister: (localPort) => {
      connections.delete(localPort);
    },
    clientKeyOf: (request) => {
      const remote = remoteEndpoint(request.source);
      if (remote === undefined) return undefined;
      const connection = connections.get(remote.port);
      return connection?.address === normalizeAddress(remote.address)
        ? connection.clientKey
        : undefined;
    },
  });
};

export const layer = Layer.sync(SecureChannelConnections, make);
