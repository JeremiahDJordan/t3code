import * as Layer from "effect/Layer";

import * as SecureChannelClients from "./SecureChannelClients.ts";
import * as SecureChannelConnections from "./SecureChannelConnections.ts";
import * as SecureChannelGateway from "./SecureChannelGateway.ts";
import * as SecureChannelKey from "./SecureChannelKey.ts";

/** What auth and the gateway share: the server key, its client bindings and connection marks. */
export const layerServices = Layer.mergeAll(
  SecureChannelConnections.layer,
  SecureChannelClients.layer,
  SecureChannelKey.layer,
);

/** The gateway listener, running only when `--secure-channel-port` is set. */
export const layerGateway = SecureChannelGateway.layer;
