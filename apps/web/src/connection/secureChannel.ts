import { SecureChannel } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * End-to-end encrypted routes in the desktop app run through a loopback forwarder in its main
 * process, over the desktop bridge. A browser has no forwarder, so the hosted app reports that
 * such a route needs the desktop or mobile app.
 */
export const layerSecureChannelForwarder = (() => {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const createClientKey = bridge?.secureChannelCreateClientKey;
  const forward = bridge?.secureChannelForward;
  const release = bridge?.secureChannelRelease;
  const retain = bridge?.secureChannelRetain;
  if (
    createClientKey === undefined ||
    forward === undefined ||
    release === undefined ||
    retain === undefined
  ) {
    return SecureChannel.layerUnsupported;
  }
  return Layer.succeed(
    SecureChannel.SecureChannelForwarder,
    SecureChannel.SecureChannelForwarder.of({
      createClientKey: Effect.promise(() => createClientKey()),
      forward: (request) =>
        Effect.promise(() => forward(request)).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed({ httpBaseUrl: result.httpBaseUrl, wsBaseUrl: result.wsBaseUrl })
              : Effect.fail(SecureChannel.forwardFailureError(request.httpBaseUrl, result)),
          ),
        ),
      release: (request) => Effect.promise(() => release(request)),
      retain: (routes) => Effect.promise(() => retain(routes)),
    }),
  );
})();
