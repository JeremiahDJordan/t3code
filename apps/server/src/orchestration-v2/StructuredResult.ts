/**
 * Structured results for delegated tasks with a `resultSchema`: validating a
 * value a child returned with `t3_task_return`, and recovering one from the
 * child's final message when it could not call the tool.
 */
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

type Decoder = (value: unknown) => Result.Result<unknown, string>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Values decoded once at compile, so a schema that throws (a cyclic `$ref`) is refused up front. */
const PROBES: ReadonlyArray<unknown> = [null, {}, []];

const MAX_CACHED_SCHEMAS = 64;
const decoders = new Map<string, Result.Result<Decoder, string>>();

function compile(schema: unknown): Result.Result<Decoder, string> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return Result.fail("A result schema must be a JSON Schema object.");
  }
  const key = JSON.stringify(schema);
  const cached = decoders.get(key);
  if (cached !== undefined) return cached;
  let compiled: Result.Result<Decoder, string>;
  try {
    const raw = schema as JsonSchema.JsonSchema;
    const dialect = typeof raw.$schema === "string" && raw.$schema.includes("draft-07");
    const document = dialect
      ? JsonSchema.fromSchemaDraft07(raw)
      : JsonSchema.fromSchemaDraft2020_12(raw);
    const decode = Schema.decodeUnknownResult(
      SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "ignore" }) as Schema.Codec<
        unknown,
        unknown
      >,
    );
    for (const probe of PROBES) decode(probe);
    // A probe cannot reach every branch, so a later throw is a failure too.
    compiled = Result.succeed((value) => {
      try {
        return Result.mapError(decode(value), (error) => error.message);
      } catch {
        // The decoder's own error text names its internals, not the schema.
        return Result.fail(
          "The result schema could not check this value; it may refer to itself without end.",
        );
      }
    });
  } catch (error) {
    compiled = Result.fail(`The result schema is not supported: ${errorText(error)}`);
  }
  if (decoders.size >= MAX_CACHED_SCHEMAS) decoders.delete(decoders.keys().next().value!);
  decoders.set(key, compiled);
  return compiled;
}

/** Fails with a message when `schema` cannot be used as a result schema. */
export function checkResultSchema(schema: unknown): Result.Result<void, string> {
  return Result.map(compile(schema), () => undefined);
}

/** The value as the schema decodes it, or why it does not match. */
export function validateStructuredResult(
  schema: unknown,
  value: unknown,
): Result.Result<unknown, string> {
  return Result.flatMap(compile(schema), (decode) => decode(value));
}

/** A task prompt asking the child to return its result for `schema`. */
export function structuredTaskPrompt(task: string, schema: unknown): string {
  return [
    task,
    "",
    "When you finish, call the t3_task_return tool with your result as `value`. It must match the JSON Schema below; if the tool rejects it, fix the value and call it again. If you cannot call the tool, end your final message with the result as JSON matching the schema.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

const MAX_SCANNED_CHARS = 512 * 1024;
const MAX_CANDIDATES = 200;
/** Characters examined across every candidate, so unclosed brackets cannot make a scan quadratic. */
const MAX_SCAN_STEPS = 4 * 1024 * 1024;

/**
 * The JSON text starting at `start` up to its matching close, ignoring
 * brackets in strings, examining at most `limit` characters.
 */
function balancedJson(
  text: string,
  start: number,
  limit: number,
): { readonly json: string | undefined; readonly steps: number } {
  const stack: Array<string> = [];
  let inString = false;
  const end = Math.min(text.length, start + limit);
  let index = start;
  const done = (json: string | undefined) => ({ json, steps: index - start + 1 });
  for (; index < end; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return done(undefined);
      if (stack.length === 0) return done(text.slice(start, index + 1));
    }
  }
  return done(undefined);
}

/**
 * The last JSON object (or array) in `text` that matches `schema`, for a child
 * that ended its turn with the result instead of calling `t3_task_return`.
 */
export function structuredResultFromText(
  schema: unknown,
  text: string,
): Result.Result<unknown, string> {
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) return compiled;
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(-MAX_SCANNED_CHARS) : text;
  let tried = 0;
  let steps = 0;
  let lastProblem: string | undefined;
  for (
    let index = scanned.length - 1;
    index >= 0 && tried < MAX_CANDIDATES && steps < MAX_SCAN_STEPS;
    index -= 1
  ) {
    const char = scanned[index];
    if (char !== "{" && char !== "[") continue;
    const scan = balancedJson(scanned, index, MAX_SCAN_STEPS - steps);
    steps += scan.steps;
    const candidate = scan.json;
    if (candidate === undefined) continue;
    tried += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const validated = validateStructuredResult(schema, parsed);
    if (Result.isSuccess(validated)) return validated;
    lastProblem ??= validated.failure;
  }
  return Result.fail(
    lastProblem === undefined
      ? "The final message has no JSON value."
      : `The final message's JSON does not match the schema: ${lastProblem}`,
  );
}
