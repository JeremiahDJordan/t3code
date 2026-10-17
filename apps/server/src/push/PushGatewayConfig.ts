/**
 * Fork: the owner's push gateway (`infra/push-gateway`). Without both variables the server
 * sends no push, makes no request and does not offer push registration to phones.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const PUSH_GATEWAY_URL_ENV = "T3CODE_PUSH_GATEWAY_URL";
export const PUSH_GATEWAY_CREDENTIAL_ENV = "T3CODE_PUSH_GATEWAY_CREDENTIAL";

export interface PushGatewayConfig {
  /** The gateway origin, without a trailing slash. */
  readonly url: string;
  readonly credential: Redacted.Redacted<string>;
}

const trimmedOption = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) =>
      Option.filter(
        Option.map(value, (text) => text.trim()),
        Boolean,
      ),
    ),
  );

// The credential travels in every request, so only a loopback gateway may use plain HTTP.
export function isAllowedPushGatewayUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

const invalid = (message: string) =>
  Effect.fail(
    new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message }))),
  );

export const pushGatewayConfig: Config.Config<PushGatewayConfig | null> = Config.all({
  url: trimmedOption(PUSH_GATEWAY_URL_ENV),
  credential: trimmedOption(PUSH_GATEWAY_CREDENTIAL_ENV),
}).pipe(
  Config.mapEffect(({ url, credential }) => {
    if (Option.isNone(url) && Option.isNone(credential)) return Effect.succeed(null);
    if (Option.isNone(url) || Option.isNone(credential)) {
      return invalid(
        `${PUSH_GATEWAY_URL_ENV} and ${PUSH_GATEWAY_CREDENTIAL_ENV} must be set together.`,
      );
    }
    if (!isAllowedPushGatewayUrl(url.value)) {
      return invalid(`${PUSH_GATEWAY_URL_ENV} must be an https:// URL.`);
    }
    return Effect.succeed({
      url: url.value.replace(/\/+$/, ""),
      credential: Redacted.make(credential.value),
    });
  }),
);

/** A bad value turns push off with an error in the log, rather than stopping the server. */
export const readPushGatewayConfig: Effect.Effect<PushGatewayConfig | null> =
  pushGatewayConfig.pipe(
    Effect.catch((error) =>
      Effect.logError("push gateway turned off: invalid configuration", {
        detail: error.message,
      }).pipe(Effect.as(null)),
    ),
  );
