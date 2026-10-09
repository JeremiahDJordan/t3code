import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RpcHttp from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionTarget } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const route = (httpBaseUrl: string, channel: boolean): ConnectionRoute => {
  const connectionId = `bearer:${httpBaseUrl}`;
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        ...(channel ? { channel: { serverKey: "server-key" } } : {}),
      }),
    ),
  };
};

function layerDriver(requested: Array<string>) {
  return ConnectionDriver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(((input: RequestInfo | URL) => {
          requested.push(String(input));
          return Promise.resolve(Response.json({ environmentId: ENVIRONMENT_ID, label: "Desk" }));
        }) satisfies typeof fetch),
        Layer.mock(ConnectionResolver.ConnectionResolver)({}),
        Layer.mock(RpcSession.RpcSessionFactory)({}),
      ),
    ),
  );
}

describe("ConnectionDriver", () => {
  it.effect(
    "checks a plain route's descriptor, but sends nothing to an encrypted route's host",
    () =>
      Effect.gen(function* () {
        const requested: Array<string> = [];
        const driver = yield* ConnectionDriver.ConnectionDriver.pipe(
          Effect.provide(layerDriver(requested)),
        );
        const entry: ConnectionCatalogEntry = {
          ...route("https://quiet.example.test/", true),
          enabled: true,
        };

        expect(yield* driver.checkRoute(entry, route("https://quiet.example.test/", true))).toBe(
          "unchecked",
        );
        expect(requested).toEqual([]);

        yield* driver.checkRoute(entry, route("http://192.168.1.10:3773/", false));
        expect(requested).toEqual(["http://192.168.1.10:3773/.well-known/t3/environment"]);
      }),
  );
});
