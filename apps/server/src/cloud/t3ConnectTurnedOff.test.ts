import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSessionId,
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpApi,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { T3_CONNECT_DISABLED_MESSAGE } from "@t3tools/shared/forkFeatures";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CloudLink from "./CloudLink.ts";
import * as T3ConnectTurnedOff from "./t3ConnectTurnedOff.ts";

class ConnectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.connect) {}

const storedLinkState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "user-1",
  relayUrl: "https://relay.example.test",
  relayIssuer: null,
  publishAgentActivity: false,
};

const reachedCloudLink = () => Effect.die(new Error("a refused route reached CloudLink"));

const handleRequest = async (path: string, method: "GET" | "POST", body?: unknown) => {
  const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
    Layer.provide(T3ConnectTurnedOff.layerConnectHttp),
    Layer.provide(
      Layer.mock(CloudLink.CloudLink)({
        linkState: () => Effect.succeed(storedLinkState),
        linkProof: reachedCloudLink,
        applyRelayConfig: reachedCloudLink,
        unlink: reachedCloudLink,
        updatePreferences: reachedCloudLink,
        answerHealthRequest: reachedCloudLink,
        mintCredential: reachedCloudLink,
      }),
    ),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("session-1"),
            subject: "cli-issued-session",
            method: "bearer-access-token" as const,
            scopes: [AuthRelayReadScope, AuthRelayWriteScope],
          }),
      }),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, { disableLogger: true });
  try {
    const response = await handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer token" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    await dispose();
  }
};

describe("T3 Connect turned off", () => {
  it.each([
    {
      path: "/api/connect/relay-config",
      body: {
        relayUrl: "https://relay.example.test",
        cloudUserId: "user-1",
        environmentCredential: "credential",
        cloudMintPublicKey: "key",
        endpointRuntime: null,
      },
    },
    { path: "/api/connect/unlink", body: undefined },
    { path: "/api/connect/preferences", body: { publishAgentActivity: true } },
    { path: "/api/t3-connect/health", body: { proof: "proof" } },
    { path: "/api/connect/mint-credential", body: { proof: "proof" } },
    { path: "/api/t3-connect/mint-credential", body: { proof: "proof" } },
  ])("refuses $path without reaching CloudLink", async ({ path, body }) => {
    expect(await handleRequest(path, "POST", body)).toEqual({
      status: 403,
      body: { _tag: "EnvironmentHttpForbiddenError", message: T3_CONNECT_DISABLED_MESSAGE },
    });
  });

  it("still reports the stored link state", async () => {
    expect(await handleRequest("/api/connect/link-state", "GET")).toEqual({
      status: 200,
      body: storedLinkState,
    });
  });

  it.effect("refuses to install the relay client", () =>
    Effect.gen(function* () {
      const error = yield* Stream.runDrain(T3ConnectTurnedOff.relayClientInstall()).pipe(
        Effect.flip,
      );
      expect(error.message).toBe(T3_CONNECT_DISABLED_MESSAGE);
    }),
  );

  it.effect("never advertises agent activity publishing", () =>
    Effect.gen(function* () {
      const descriptor = yield* Effect.flatMap(
        ServerEnvironment.ServerEnvironment,
        (environment) => environment.getDescriptor,
      );
      expect(descriptor.capabilities.agentActivityPublishing).toBe(false);
      expect(descriptor.capabilities.threadPullRequestLinking).toBe(true);
    }).pipe(
      Effect.provide(
        T3ConnectTurnedOff.withoutAgentActivityPublishing(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              capabilities: { agentActivityPublishing: true, threadPullRequestLinking: true },
            } as unknown as ExecutionEnvironmentDescriptor),
          }),
        ),
      ),
    ),
  );
});
