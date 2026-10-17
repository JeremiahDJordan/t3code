/**
 * Fork: what the server mounts in place of T3 Connect's entry points while
 * `T3_CONNECT_ENABLED` (packages/shared/src/forkFeatures.ts) is off. The
 * upstream implementations stay untouched; `server.ts` and `ws.ts` pick one or
 * the other. Nothing here reads or changes stored link data.
 */
import {
  AuthRelayReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  RelayClientInstallFailedError,
} from "@t3tools/contracts";
import { T3_CONNECT_DISABLED_MESSAGE } from "@t3tools/shared/forkFeatures";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { readPushGatewayConfig } from "../push/PushGatewayConfig.ts";
import * as CloudLink from "./CloudLink.ts";

const refuse = () =>
  Effect.fail(new EnvironmentHttpForbiddenError({ message: T3_CONNECT_DISABLED_MESSAGE }));

/**
 * The `connect` HTTP group with every link, mint and health route refused.
 * `linkState` still answers, read-only, so a client can see what is stored.
 */
export const layerConnectHttp = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const cloudLink = yield* CloudLink.CloudLink;
    return handlers
      .handle("linkProof", refuse)
      .handle("relayConfig", refuse)
      .handle("linkState", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(
          Effect.andThen(cloudLink.linkState()),
          Effect.catchTags({
            CloudLinkInternalError: (error) =>
              Effect.fail(new EnvironmentHttpInternalServerError({ message: error.message })),
          }),
        ),
      )
      .handle("unlink", refuse)
      .handle("preferences", refuse)
      .handle("health", refuse)
      .handle("mintCredential", refuse)
      .handle("t3MintCredential", refuse);
  }),
);

/** `cloudInstallRelayClient`: the relay client is only for T3 Connect's tunnel. */
export const relayClientInstall = () =>
  Stream.fail(
    new RelayClientInstallFailedError({
      reason: "unsupported_platform",
      message: T3_CONNECT_DISABLED_MESSAGE,
    }),
  );

/** Without T3 Connect's relay or a push gateway, agent activity goes nowhere. */
export const agentAwarenessRelayTurnedOff = AgentAwarenessRelay.AgentAwarenessRelay.of({
  publishThread: () => Effect.void,
  drain: Effect.void,
  requestCatchUp: () => Effect.void,
  start: () => Effect.void,
});

/**
 * Wraps the server environment layer so the descriptor never advertises the relay's agent
 * activity publishing, which a stored link and opt-in would otherwise claim. A configured push
 * gateway publishes instead, so phones register with it and arm Live Activities for it.
 */
export const withoutAgentActivityPublishing = <ROut, E, RIn>(
  layer: Layer.Layer<ROut | ServerEnvironment.ServerEnvironment, E, RIn>,
) =>
  Layer.effect(
    ServerEnvironment.ServerEnvironment,
    Effect.gen(function* () {
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const pushGateway = (yield* readPushGatewayConfig) !== null;
      return ServerEnvironment.ServerEnvironment.of({
        ...environment,
        getDescriptor: environment.getDescriptor.pipe(
          Effect.map((descriptor) => ({
            ...descriptor,
            capabilities: {
              ...descriptor.capabilities,
              agentActivityPublishing: pushGateway,
              ...(pushGateway ? { pushGateway: true } : {}),
            },
          })),
        ),
      });
    }),
  ).pipe(Layer.provideMerge(layer));
