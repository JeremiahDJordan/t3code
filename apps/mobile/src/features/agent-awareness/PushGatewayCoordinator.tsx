import { useEffect } from "react";

import { environmentTransport } from "./pushGatewayTransport";
import { startAgentAwarenessPushGateway } from "./remoteRegistration";

/** Fork: with T3 Connect off, registers for push with each server's own push gateway. */
export function PushGatewayCoordinator() {
  useEffect(() => startAgentAwarenessPushGateway(environmentTransport), []);
  return null;
}
