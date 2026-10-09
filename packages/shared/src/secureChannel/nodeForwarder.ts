// @effect-diagnostics nodeBuiltinImport:off -- A loopback TCP listener in the desktop's main process, outside an Effect runtime.
/**
 * A loopback listener that carries each accepted connection through a `ChannelConnector`, so a
 * client can use the route at `http://127.0.0.1:<port>` with its ordinary fetch, WebSocket, image
 * and video loaders. It listens on loopback only.
 *
 * @module secureChannel/nodeForwarder
 */
import * as NodeNet from "node:net";

import type { ChannelConnector } from "./connector.ts";

export interface NodeForwarder {
  /** The local origin to use in place of the route's, such as `http://127.0.0.1:52811`. */
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export async function startNodeForwarder(connector: ChannelConnector): Promise<NodeForwarder> {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    // A clean close follows both halves ending; anything else abandons the stream.
    let localEnded = false;
    let remoteEnded = false;
    const connection = connector.attach({
      write: (bytes, taken) => socket.write(bytes, () => taken()),
      end: () => {
        remoteEnded = true;
        socket.end();
      },
      destroy: () => socket.destroy(),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    });
    socket.on("data", (chunk: Buffer) => connection.write(new Uint8Array(chunk)));
    socket.on("end", () => {
      localEnded = true;
      connection.end();
    });
    socket.on("error", () => undefined);
    socket.on("close", (hadError: boolean) => {
      sockets.delete(socket);
      if (hadError || !localEnded || !remoteEnded) connection.reset("The local connection closed.");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        connector.close();
        server.close(() => resolve());
      }),
  };
}
