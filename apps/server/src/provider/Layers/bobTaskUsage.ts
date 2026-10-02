import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { bobHomeDirectory } from "../acp/BobAcpSupport.ts";
import { readBobDatabase } from "./bobDatabase.ts";

/**
 * Bob's running totals for one task, from `tasks.costs`. Token counts and `cost`
 * (Bobcoins, including subagents) are cumulative; `contextTokens` is the current
 * context size. Input includes cache reads and writes.
 */
export interface BobTaskCosts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly contextTokens: number;
  /**
   * Whether Bob kept the token counts. From Bob 2.0.5 its release builds store only `cost`
   * and `contextTokens`, so the counts read as 0 without being real.
   */
  readonly tokensRecorded: boolean;
}

const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Finite));
const decodeTaskCosts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      input: OptionalNumber,
      output: OptionalNumber,
      cacheRead: OptionalNumber,
      cacheWrite: OptionalNumber,
      cost: OptionalNumber,
      contextTokens: OptionalNumber,
    }),
  ),
);

const tokens = (value: number | null | undefined) =>
  value != null && value > 0 ? Math.round(value) : 0;

/** Bob opens its development database when it runs with `NODE_ENV=development`. */
export function resolveBobTaskDatabasePath(environment: NodeJS.ProcessEnv, path: Path.Path) {
  return path.join(
    bobHomeDirectory(environment, path),
    environment.NODE_ENV === "development" ? "dev-db" : "db",
    "bob.db",
  );
}

/**
 * Reads the running totals of a task. An ACP session id is its root task id.
 * Undefined when the database, row, or column is missing, as with older Bob.
 */
export const readBobTaskCosts = Effect.fn("readBobTaskCosts")(function* (
  databasePath: string,
  taskId: string,
) {
  const raw = yield* readBobDatabase(
    databasePath,
    (database) => database.prepare("SELECT costs FROM tasks WHERE id = ?").get(taskId)?.costs,
  );
  if (typeof raw !== "string") return undefined;
  return Option.getOrUndefined(
    Option.map(decodeTaskCosts(raw), (costs): BobTaskCosts => ({
      input: tokens(costs.input),
      output: tokens(costs.output),
      cacheRead: tokens(costs.cacheRead),
      cacheWrite: tokens(costs.cacheWrite),
      cost: Math.max(0, costs.cost ?? 0),
      contextTokens: tokens(costs.contextTokens),
      tokensRecorded: costs.input != null || costs.output != null,
    })),
  );
});

/**
 * Context windows (maximum input tokens) of the models IBM's Bob gateway listed in
 * `/inference/v1/model/info`: a snapshot taken on 2026-09-24 with Bob 2.0.5. ACP reports
 * neither the model Bob runs nor its window, and IBM can change both without notice, so these
 * are assumptions (`bobThreadTokenUsage` drops one the context outgrows).
 *
 * Refresh: re-read `/inference/v1/model/info` whenever Bob updates, along with the router's
 * default below. Delete the table once Bob reports its window over ACP (`usage_update` with a
 * `size`).
 */
const BOB_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "premium-ide": 270_000,
  "premium-shell": 270_000,
  premium: 200_000,
  fast: 200_000,
  explorer: 200_000,
  "wxO-model": 1_000_000,
  background: 131_072,
  security: 131_072,
  "gpt-oss-20b": 131_072,
  "openai/gpt-oss-20b": 131_072,
};

/** The model Bob's router picked for every chat task (tier `premium`) observed on Bob 2.0.5. */
const BOB_ROUTER_DEFAULT_MODEL = "premium-ide";

/**
 * The context window a Bob session most likely has: the model pinned by Bob's `session.model`
 * setting, which bypasses its router, or else the router's usual pick. Undefined for a model T3
 * does not know, so the meter shows a count instead of a wrong share.
 */
export function bobContextWindow(configuredModel: string | undefined): number | undefined {
  return BOB_MODEL_CONTEXT_WINDOWS[configuredModel?.trim() || BOB_ROUTER_DEFAULT_MODEL];
}
