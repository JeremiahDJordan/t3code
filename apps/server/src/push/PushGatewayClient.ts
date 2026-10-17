/**
 * Fork: hands finished deliveries to the owner's push gateway, which signs and forwards them to
 * APNs and FCM and answers with one result per delivery.
 */
import {
  PUSH_GATEWAY_MAX_DELIVERIES,
  type PushGatewayDelivery,
  type PushGatewayResult,
  PushGatewayResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { PushGatewayConfig } from "./PushGatewayConfig.ts";

export class PushGatewayError extends Schema.TaggedError<PushGatewayError>()("PushGatewayError", {
  status: Schema.NullOr(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Push gateway request failed${this.status === null ? "" : ` (${this.status})`}: ${this.detail}`;
  }
}

export class PushGatewayClient extends Context.Service<
  PushGatewayClient,
  {
    readonly send: (
      deliveries: ReadonlyArray<PushGatewayDelivery>,
    ) => Effect.Effect<ReadonlyArray<PushGatewayResult>, PushGatewayError>;
  }
>()("t3/push/PushGatewayClient") {}

const REQUEST_TIMEOUT = "15 seconds";
const decodeResponse = Schema.decodeUnknownEffect(PushGatewayResponse);

export const make = Effect.fnUntraced(function* (config: PushGatewayConfig) {
  const client = yield* HttpClient.HttpClient;
  const endpoint = `${config.url}/v1/deliveries`;

  const sendChunk = Effect.fnUntraced(function* (deliveries: ReadonlyArray<PushGatewayDelivery>) {
    const response = yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(Redacted.value(config.credential)),
      HttpClientRequest.bodyJson({ deliveries }),
      Effect.flatMap(client.execute),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => new PushGatewayError({ status: null, detail: String(cause) })),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new PushGatewayError({
        status: response.status,
        detail: body.slice(0, 200) || "no body",
      });
    }
    const decoded = yield* response.json.pipe(
      Effect.flatMap(decodeResponse),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (cause) => new PushGatewayError({ status: response.status, detail: String(cause) }),
      ),
    );
    if (decoded.results.length !== deliveries.length) {
      return yield* new PushGatewayError({
        status: response.status,
        detail: `expected ${deliveries.length} results, got ${decoded.results.length}`,
      });
    }
    return decoded.results;
  });

  return PushGatewayClient.of({
    send: (deliveries) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(deliveries.length / PUSH_GATEWAY_MAX_DELIVERIES) }, (_, i) =>
          deliveries.slice(i * PUSH_GATEWAY_MAX_DELIVERIES, (i + 1) * PUSH_GATEWAY_MAX_DELIVERIES),
        ),
        sendChunk,
      ).pipe(
        Effect.map((chunks) => chunks.flat()),
        Effect.withSpan("PushGatewayClient.send"),
      ),
  });
});

export const layer = (config: PushGatewayConfig) =>
  Layer.effect(PushGatewayClient, make(config)).pipe(Layer.provide(FetchHttpClient.layer));
