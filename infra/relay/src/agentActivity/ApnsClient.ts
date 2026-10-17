import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ApnsEnvironment, type ApnsCredentials } from "../Config.ts";
import type { ApnsLiveActivityAlert, ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import type { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";
import { apnsAlertBody, apnsLiveActivityBody } from "@t3tools/shared/agentActivityPush";

export { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";

// Bound sending and reading separately so neither stage can hold a batch open.
const APNS_HTTP_STAGE_TIMEOUT = "10 seconds";

const ApnsLiveActivityEventSchema = Schema.Literals(["start", "update", "end"]);
export type ApnsLiveActivityEvent = typeof ApnsLiveActivityEventSchema.Type;

const ApnsRequestKindSchema = Schema.Literals(["live-activity", "push-notification"]);

interface ApnsLiveActivityRequest {
  readonly token: string;
  readonly event: ApnsLiveActivityEvent;
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

interface ApnsPushNotificationRequest {
  readonly token: string;
  readonly priority: "10";
  readonly payload: unknown;
}

export interface ApnsDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export class ApnsHttpRequestError extends Schema.TaggedError<ApnsHttpRequestError>()(
  "ApnsHttpRequestError",
  {
    requestKind: ApnsRequestKindSchema,
    event: Schema.NullOr(ApnsLiveActivityEventSchema),
    environment: ApnsEnvironment,
    bundleId: Schema.String,
    tokenSuffix: Schema.String,
    stage: Schema.Literals(["send", "read-response"]),
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.requestKind} request failed during ${this.stage} in ${this.environment}.`;
  }
}

export type ApnsError = ApnsJwtEncodingError | ApnsJwtSigningError | ApnsHttpRequestError;

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);
interface LiveActivityRequestBase {
  readonly token: string;
  readonly nowEpochSeconds: number;
  readonly nowIso: string;
}

type MakeLiveActivityRequestInput =
  | (LiveActivityRequestBase & {
      readonly event: "end";
      readonly state: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (LiveActivityRequestBase & {
      readonly event: "start" | "update";
      readonly state: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

// Fork: the bodies moved to `@t3tools/shared/agentActivityPush`, which the server's push
// gateway publisher shares with the relay.
function makeLiveActivityRequest(input: MakeLiveActivityRequestInput): ApnsLiveActivityRequest {
  const body = apnsLiveActivityBody(input);
  return { token: input.token, event: input.event, ...body };
}

function makePushNotificationRequest(input: {
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
}): ApnsPushNotificationRequest {
  return { token: input.token, priority: "10", payload: apnsAlertBody(input.notification) };
}

function apnsReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeApnsErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.reason ?? body,
  });
}

export class ApnsClient extends Context.Service<
  ApnsClient,
  {
    readonly makeLiveActivityRequest: typeof makeLiveActivityRequest;
    readonly makePushNotificationRequest: typeof makePushNotificationRequest;
    readonly sendLiveActivityRequest: (input: {
      readonly credentials: ApnsCredentials;
      readonly request: ApnsLiveActivityRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsError>;
    readonly sendPushNotificationRequest: (input: {
      readonly credentials: ApnsCredentials;
      readonly request: ApnsPushNotificationRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsError>;
  }
>()("t3code-relay/agentActivity/ApnsClient") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const providerTokens = yield* ApnsProviderTokens.ApnsProviderTokens;

  const sendLiveActivityRequest: ApnsClient["Service"]["sendLiveActivityRequest"] = Effect.fn(
    "relay.apns.send_live_activity_request",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "relay.apns.event": input.request.event });
    const jwt = yield* providerTokens.getJwt({
      ...input.credentials,
      issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    });
    const host =
      input.credentials.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const response = yield* HttpClientRequest.post(`${host}/3/device/${input.request.token}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `bearer ${jwt}`,
        "apns-priority": input.request.priority,
        "apns-push-type": "liveactivity",
        "apns-topic": `${input.credentials.bundleId}.push-type.liveactivity`,
      }),
      HttpClientRequest.bodyJson(input.request.payload),
      Effect.flatMap(httpClient.execute),
      Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new ApnsHttpRequestError({
            requestKind: "live-activity",
            event: input.request.event,
            environment: input.credentials.environment,
            bundleId: input.credentials.bundleId,
            tokenSuffix: input.request.token.slice(-8),
            stage: "send",
            status: null,
            cause,
          }),
      ),
    );
    const responseText = yield* response.text.pipe(
      Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new ApnsHttpRequestError({
            requestKind: "live-activity",
            event: input.request.event,
            environment: input.credentials.environment,
            bundleId: input.credentials.bundleId,
            tokenSuffix: input.request.token.slice(-8),
            stage: "read-response",
            status: response.status,
            cause,
          }),
      ),
    );
    const reason = apnsReasonFromBody(responseText);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
    };
  });

  const sendPushNotificationRequest: ApnsClient["Service"]["sendPushNotificationRequest"] =
    Effect.fn("relay.apns.send_push_notification_request")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.apns.event": "push_notification" });
      const jwt = yield* providerTokens.getJwt({
        ...input.credentials,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
      });
      const host =
        input.credentials.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com";
      const response = yield* HttpClientRequest.post(
        `${host}/3/device/${input.request.token}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `bearer ${jwt}`,
          "apns-priority": input.request.priority,
          "apns-push-type": "alert",
          "apns-topic": input.credentials.bundleId,
        }),
        HttpClientRequest.bodyJson(input.request.payload),
        Effect.flatMap(httpClient.execute),
        Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new ApnsHttpRequestError({
              requestKind: "push-notification",
              event: null,
              environment: input.credentials.environment,
              bundleId: input.credentials.bundleId,
              tokenSuffix: input.request.token.slice(-8),
              stage: "send",
              status: null,
              cause,
            }),
        ),
      );
      const responseText = yield* response.text.pipe(
        Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new ApnsHttpRequestError({
              requestKind: "push-notification",
              event: null,
              environment: input.credentials.environment,
              bundleId: input.credentials.bundleId,
              tokenSuffix: input.request.token.slice(-8),
              stage: "read-response",
              status: response.status,
              cause,
            }),
        ),
      );
      const reason = apnsReasonFromBody(responseText);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        ...(reason === undefined ? {} : { reason }),
        apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
      };
    });

  return ApnsClient.of({
    makeLiveActivityRequest,
    makePushNotificationRequest,
    sendLiveActivityRequest,
    sendPushNotificationRequest,
  });
});

export const layer = Layer.effect(ApnsClient, make);
