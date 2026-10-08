/**
 * Structured results for delegated tasks with a `resultSchema`: validating a
 * value a child returned with `t3_task_return`, and recovering one from the
 * child's final message when it could not call the tool.
 */
import * as JsonPointer from "effect/JsonPointer";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { compileResultPattern, type PatternBudget, type ResultPattern } from "./ResultPattern.ts";

/**
 * Validates `value`, charging its pattern checks to `budget`, or to a fresh one. A field a
 * closed object does not allow fails it, unless `strip` drops it instead.
 */
type Decoder = (
  value: unknown,
  budget?: PatternBudget,
  strip?: boolean,
) => Result.Result<unknown, string>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Values decoded once at compile, so a schema that throws (a cyclic `$ref`) is refused up front. */
const PROBES: ReadonlyArray<unknown> = [null, {}, []];

const MAX_CACHED_SCHEMAS = 64;
const decoders = new Map<string, Result.Result<Decoder, string>>();

/** Keywords whose values are data, not schemas, so a `pattern` key inside them is not a constraint. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);
/** Keywords whose values map arbitrary names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface PatternVisitor {
  /** The pattern to use in place of `pattern`, found at `at`. */
  readonly pattern: (pattern: string, at: string) => string;
  /** A string the importer may test a pattern against while it compiles. */
  readonly literal: (value: string) => void;
}

/**
 * `schema` with each pattern constraint, a `pattern` value or a
 * `patternProperties` key, replaced by `visit.pattern`. The importer tests
 * patterns against property names (`properties` keys and `required`
 * entries) and string `const` and `enum` values, so those go to
 * `visit.literal`. A `type` list loses its repeats, which the importer
 * would translate the whole node again for, and their children in turn.
 */
function mapPatterns(
  schema: unknown,
  path: string,
  keyed: boolean,
  visit: PatternVisitor,
): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item, index) => mapPatterns(item, `${path}/${index}`, keyed, visit));
  }
  const strings = (value: unknown) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") visit.literal(item);
    }
  };
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]): [string, unknown] => {
      const at = `${path}/${key}`;
      if (!keyed) return [key, mapPatterns(value, at, true, visit)];
      if (key === "const" || key === "enum" || key === "required") strings(value);
      if (key === "properties" && isRecord(value)) strings(Object.keys(value));
      if (DATA_KEYWORDS.has(key)) return [key, value];
      if (key === "type" && Array.isArray(value)) return [key, [...new Set(value)]];
      if (key === "pattern" && typeof value === "string") return [key, visit.pattern(value, at)];
      if (key === "patternProperties" && isRecord(value)) {
        const entries = Object.entries(value).map(([pattern, item]): [string, unknown] => [
          visit.pattern(pattern, at),
          mapPatterns(item, `${at}/${pattern}`, true, visit),
        ]);
        return [key, Object.fromEntries(entries)];
      }
      return [key, mapPatterns(value, at, !SCHEMA_MAP_KEYWORDS.has(key), visit)];
    }),
  );
}

/** `value` as a `u`-flag pattern of escapes, so it holds no syntax. */
const literalPattern = (value: string) =>
  Array.from(value, (char) =>
    /^[A-Za-z0-9_ ]$/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`,
  ).join("");

/**
 * The pattern the importer sees in place of the real one: unique by `id`,
 * and matching exactly `matches`, the strings of the schema itself the real
 * one matches, so what it decides while compiling holds. Its checks are then
 * revived with the real pattern.
 */
const placeholderPattern = (id: number, matches: Iterable<string>) =>
  [`[]${id}`, ...Array.from(matches, (match) => `^${literalPattern(match)}$`)].join("|");

/**
 * Most steps spent matching a schema's patterns against its own strings: by
 * `ResultPattern` here, and by the runtime when the importer tests the
 * placeholders, whose length grows with the strings they list.
 */
const MAX_LITERAL_WORK = 1 << 24;

const PatternPayload = Schema.Struct({ source: Schema.String, flags: Schema.String });

/**
 * Steps every pattern check in one validation may take together, about
 * 100 ms at worst: each check is bounded on its own, but a result can hold
 * many strings, each checked against many patterns.
 */
const MAX_VALIDATION_WORK = 1 << 23;
const TOO_COSTLY =
  "The result's strings take too long to check against the schema's patterns altogether";

/** The budget of the validation running now, set for each call so cached decoders share none. */
interface Checking {
  budget: PatternBudget | undefined;
}

/**
 * The importer's revivers (`jsonSchemaRevivers` in effect's
 * `SchemaRepresentation`), except that patterns run on `ResultPattern`
 * rather than the runtime's backtracking engine. A reviver missing here
 * makes a schema that needs it fail to compile, naming it.
 */
const patternRevivers = (patterns: ReadonlyMap<string, ResultPattern>, checking: Checking) => [
  SchemaRepresentation.JsonReviver,
  SchemaRepresentation.makeReviverFilter(
    "effect/schema/isPattern",
    PatternPayload,
    ({ payload, annotations }) => {
      const pattern = patterns.get(payload.source);
      if (pattern === undefined) throw new Error(`an unexpected pattern ${payload.source}`);
      return Schema.makeFilter(
        (value: string) =>
          pattern.test(value, checking.budget) ??
          (checking.budget !== undefined && checking.budget.remaining < 0
            ? `${TOO_COSTLY}; stopped at the pattern ${pattern.source}`
            : `Too long to check against the pattern ${pattern.source}: at most ${pattern.longest} characters`),
        { ...annotations, expected: `a string matching the pattern ${pattern.source}` },
      );
    },
  ),
  SchemaRepresentation.isFiniteReviver,
  SchemaRepresentation.isGreaterThanReviver,
  SchemaRepresentation.isGreaterThanOrEqualToReviver,
  SchemaRepresentation.isLessThanReviver,
  SchemaRepresentation.isLessThanOrEqualToReviver,
  SchemaRepresentation.isMultipleOfReviver,
  SchemaRepresentation.isIntReviver,
  SchemaRepresentation.isMinLengthReviver,
  SchemaRepresentation.isMaxLengthReviver,
  SchemaRepresentation.isMinCodePointsReviver,
  SchemaRepresentation.isMaxCodePointsReviver,
  SchemaRepresentation.isMinPropertiesReviver,
  SchemaRepresentation.isMaxPropertiesReviver,
  SchemaRepresentation.isPropertyNamesReviver,
  SchemaRepresentation.isUniqueReviver,
];

/**
 * Most work the importer may do on a schema, about 25 ms at worst: in
 * steps of `IMPORT_NODE_STEPS` for each node and literal it translates, and
 * of one for each property name and scope it lowers each time it intersects
 * scopes. An `allOf` of objects is lowered again at each member, over every
 * name and scope gathered so far, and so are the properties those share, so
 * its cost grows with the cube of its length, and faster for shared depth.
 */
const MAX_IMPORT_WORK = 1 << 18;
const IMPORT_NODE_STEPS = 64;

/** Keywords the importer folds into a node's parts rather than its scope. */
const COMPOSITION_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "$ref"]);
/** Keywords that constrain nothing, so a node of only these has no scope of its own. */
const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Refuses a schema whose import would take longer than `MAX_IMPORT_WORK`,
 * before the importer runs: it blocks the server's thread, unlike a value's
 * checks, which share a budget. An upper bound of the importer's own work:
 * each part it intersects (an `allOf` member, a `$ref` with siblings, a
 * branch with its siblings) is a scope, and the properties of `m` scopes are
 * intersected in turn at each of the `m - 1` steps. Its walk is charged as it
 * goes, so stops within the budget too.
 */
function checkImportWork(document: JsonSchema.Document<"draft-2020-12">): void {
  let work = 0;
  const charge = (steps: number) => {
    work += steps;
    if (!(work <= MAX_IMPORT_WORK)) {
      throw new Error(
        "it is too large to compile quickly. Each property, enum value and branch counts, and one combined through allOf, anyOf, oneOf or $ref counts again for each combination. Use fewer of them, or flatten them into one object.",
      );
    }
  };
  const translated = new WeakSet<object>();
  /** The definition a `$ref` names, as effect's `JsonSchema.getReferenceKey` reads it. */
  const definitionOf = (schema: Record<string, unknown>) => {
    const path =
      typeof schema.$ref === "string" && schema.$ref.startsWith("#")
        ? JsonPointer.parseUriFragment(schema.$ref)
        : undefined;
    const name = path?.length === 2 && path[0] === "$defs" ? path[1]! : undefined;
    return name !== undefined && Object.hasOwn(document.definitions, name) ? name : undefined;
  };
  const walks = new WeakMap<object, number>();
  /**
   * The nodes effect's `hasChoices` may walk below `schema` before it finds a choice: every
   * subschema, through every `$ref`, as a tree, since it does not remember a definition it
   * walked, so one reached by two paths is walked twice. It stops at a union of two or more
   * branches, and at a cycle, which count once.
   */
  const walked = (schema: unknown): number => {
    if (!isRecord(schema)) return 1;
    const known = walks.get(schema);
    if (known !== undefined) return known;
    walks.set(schema, 1);
    const name = definitionOf(schema);
    const children = Object.entries(schema).flatMap(([key, value]): ReadonlyArray<unknown> => {
      if (DATA_KEYWORDS.has(key) || key === "$defs" || key === "definitions") return [];
      if ((key === "anyOf" || key === "oneOf") && Array.isArray(value) && value.length > 1) {
        return [];
      }
      if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) return Object.values(value);
      return Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : [];
    });
    if (name !== undefined) children.push(document.definitions[name]);
    let total = 1;
    for (const child of children) total = Math.min(total + walked(child), MAX_IMPORT_WORK + 1);
    walks.set(schema, total);
    return total;
  };
  /** Charges intersecting `parts` with `scopes`, `factor` times, and what their properties share. */
  const intersect = (
    parts: ReadonlyArray<unknown>,
    factor: number,
    scopes: Array<Record<string, unknown>> = [],
  ): void => {
    const unions: Array<ReadonlyArray<unknown>> = [];
    const references: Array<readonly [string, ReadonlySet<string>]> = [];
    const add = (schema: unknown, chain: ReadonlySet<string>) => {
      if (!isRecord(schema)) return charge(factor);
      // The importer translates each node once, then intersects what it made.
      const first = !translated.has(schema);
      translated.add(schema);
      const literals = first && Array.isArray(schema.enum) ? schema.enum.length : 0;
      charge(factor + (first ? IMPORT_NODE_STEPS * (1 + literals) : 0));
      if (
        Object.keys(schema).some(
          (key) => !COMPOSITION_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key),
        )
      ) {
        scopes.push(schema);
      }
      if (Array.isArray(schema.allOf)) for (const member of schema.allOf) add(member, chain);
      for (const members of [schema.anyOf, schema.oneOf]) {
        if (Array.isArray(members)) unions.push(members);
      }
      const name = definitionOf(schema);
      if (name !== undefined && !chain.has(name)) references.push([name, chain]);
    };
    for (const part of parts) add(part, new Set());
    // A definition is read again only where it is intersected with something.
    while (references.length > 0 && scopes.length + references.length + unions.length > 1) {
      const [name, chain] = references.pop()!;
      add(document.definitions[name], new Set(chain).add(name));
    }
    const [union, ...rest] = unions;
    if (union !== undefined) {
      // Before intersecting overlapping branches with the rest, effect checks whether the other
      // side holds a choice, walking the rest, or each branch of another union, whole.
      if (scopes.length > 0 || rest.length > 0) {
        const sides: ReadonlyArray<unknown> = [...scopes, ...rest.flat(), ...union];
        charge(factor * sides.reduce<number>((sum, side) => sum + walked(side), 0));
      }
      // Intersected, a union's branches are each intersected with the rest.
      for (const member of union) {
        intersect([member, ...rest.map((members) => ({ anyOf: members }))], factor, [...scopes]);
      }
      return;
    }
    if (scopes.length === 0) return;
    const children = new Map<string, Array<unknown>>();
    const child = (key: string, value?: unknown) => {
      let list = children.get(key);
      if (list === undefined) children.set(key, (list = []));
      if (value !== undefined) list.push(value);
    };
    let literals = 0;
    for (const scope of scopes) {
      for (const [key, value] of Object.entries(scope)) {
        if (key === "enum" && Array.isArray(value)) literals += value.length;
        if (
          DATA_KEYWORDS.has(key) ||
          COMPOSITION_KEYWORDS.has(key) ||
          ANNOTATION_KEYWORDS.has(key)
        ) {
          continue;
        }
        if (key === "properties" && isRecord(value)) {
          for (const [name, item] of Object.entries(value)) child(`p:${name}`, item);
        } else if (key === "required" && Array.isArray(value)) {
          for (const name of value) if (typeof name === "string") child(`p:${name}`);
        } else if (key === "prefixItems" && Array.isArray(value)) {
          value.forEach((item, index) => child(`i:${index}`, item));
        } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
          for (const [name, item] of Object.entries(value)) child(`${key}:${name}`, item);
        } else if (isRecord(value)) {
          child(key, value);
        }
      }
    }
    const steps = Math.max(1, scopes.length - 1);
    charge(factor * steps * (scopes.length * (children.size + 1) + literals));
    // Merged, the scopes make a new node of every property, as a union's
    // branches each do with the scopes beside it.
    if (scopes.length > 1) charge(IMPORT_NODE_STEPS * children.size);
    // Schemas typing names or elements beyond their own join each one they may type.
    for (const scope of scopes) {
      const patterns = isRecord(scope.patternProperties)
        ? Object.values(scope.patternProperties)
        : [];
      const joins = [
        ...[scope.additionalProperties, ...patterns].map((extra) => ["p:", extra] as const),
        ["i:", scope.items] as const,
      ];
      for (const [prefix, extra] of joins) {
        if (!isRecord(extra)) continue;
        for (const [key, list] of children) if (key.startsWith(prefix)) list.push(extra);
      }
    }
    for (const list of children.values()) if (list.length > 0) intersect(list, factor * steps);
  };
  intersect([document.schema], 1);
  for (const definition of Object.values(document.definitions)) intersect([definition], 1);
}

/**
 * The schema as effect imports it, with every pattern checked by
 * `ResultPattern`: the importer only ever runs placeholders, on the schema's
 * own strings, and the decoder never runs the runtime's engine on a value.
 */
function importSchema(schema: object, checking: Checking): Schema.Top {
  const compiled = new Map<string, ResultPattern>();
  /** Places each pattern appears, where the importer tests it again. */
  const uses = new Map<string, number>();
  const literals = new Set<string>();
  mapPatterns(schema, "", true, {
    pattern: (pattern, at) => {
      uses.set(pattern, (uses.get(pattern) ?? 0) + 1);
      if (compiled.has(pattern)) return pattern;
      const result = compileResultPattern(pattern);
      if ("reason" in result) {
        throw new Error(
          `the pattern ${JSON.stringify(pattern)} at ${at} ${result.reason}. Use enum, or a pattern without backreferences, lookaround or inline flags.`,
        );
      }
      compiled.set(pattern, result);
      return pattern;
    },
    literal: (value) => literals.add(value),
  });
  const placeholders = new Map<string, string>();
  const byPlaceholder = new Map<string, ResultPattern>();
  let work = 0;
  const charge = (steps: number) => {
    work += steps;
    if (work > MAX_LITERAL_WORK) {
      throw new Error("it has too many patterns and names to check against each other");
    }
  };
  for (const [pattern, result] of compiled) {
    const matches = Array.from(literals).filter((literal) => {
      charge((literal.length + 1) * result.size);
      const matched = result.test(literal);
      // Taken as no match, the importer would type that name without the pattern's schema.
      if (matched === undefined) {
        throw new Error(
          `the name or value ${JSON.stringify(literal.slice(0, 32))}… is too long to check against the pattern ${JSON.stringify(pattern)}: at most ${result.longest} characters, not ${literal.length}`,
        );
      }
      return matched;
    });
    const placeholder = placeholderPattern(placeholders.size, matches);
    // The importer runs the placeholder against the schema's names and
    // values wherever the pattern appears, each run costing about its length.
    charge(literals.size * placeholder.length * uses.get(pattern)!);
    placeholders.set(pattern, placeholder);
    byPlaceholder.set(placeholder, result);
  }
  const raw = mapPatterns(schema, "", true, {
    pattern: (pattern) => placeholders.get(pattern)!,
    literal: () => undefined,
  }) as JsonSchema.JsonSchema;
  const dialect = typeof raw.$schema === "string" && raw.$schema.includes("draft-07");
  const document = dialect
    ? JsonSchema.fromSchemaDraft07(raw)
    : JsonSchema.fromSchemaDraft2020_12(raw);
  checkImportWork(document);
  const imported = SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "apply" });
  if (compiled.size === 0) return imported;
  return SchemaRepresentation.fromRepresentation(
    SchemaRepresentation.toRepresentation(imported.ast),
    { revivers: patternRevivers(byPlaceholder, checking) },
  );
}

function compile(schema: unknown): Result.Result<Decoder, string> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return Result.fail("A result schema must be a JSON Schema object.");
  }
  const key = JSON.stringify(schema);
  const cached = decoders.get(key);
  if (cached !== undefined) return cached;
  let compiled: Result.Result<Decoder, string>;
  try {
    const checking: Checking = { budget: undefined };
    const imported = importSchema(schema, checking) as Schema.Codec<unknown, unknown>;
    // A field a closed object does not allow fails it, as in JSON Schema,
    // rather than being dropped: dropped, it could let a `oneOf` branch
    // that does not allow it match too.
    const decodeStrictly = Schema.decodeUnknownResult(imported, { onExcessProperty: "error" });
    const decodeStripping = Schema.decodeUnknownResult(imported);
    // Every pattern check in one call shares one budget: the caller's, or a fresh one.
    const decode = (
      value: unknown,
      shared?: PatternBudget,
      strip = false,
    ): Result.Result<unknown, string> => {
      const budget: PatternBudget = shared ?? { remaining: MAX_VALIDATION_WORK };
      checking.budget = budget;
      let decoded: Result.Result<unknown, string>;
      try {
        decoded = Result.mapError(
          (strip ? decodeStripping : decodeStrictly)(value),
          (error) => error.message,
        );
      } finally {
        checking.budget = undefined;
      }
      if (budget.remaining >= 0) return decoded;
      // A check that ran out may have been taken as a mismatch, by a union
      // or a key pattern, so whatever the decoder concluded, the value fails.
      return Result.isFailure(decoded) && decoded.failure.includes(TOO_COSTLY)
        ? decoded
        : Result.fail(`${TOO_COSTLY}.`);
    };
    for (const probe of PROBES) decode(probe);
    // A probe cannot reach every branch, so a later throw is a failure too.
    compiled = Result.succeed((value, budget, strip) => {
      try {
        return decode(value, budget, strip);
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
    "When you finish, call the t3_task_return tool with your result as `value`. It must match the JSON Schema below; if the tool rejects it, fix the value and call it again. If you cannot call the tool, end your final message with the result as JSON matching the schema, in a ```json fence.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

/** Longest JSON value recovered from a message; a longer one is left, with its pieces. */
const MAX_CANDIDATE_CHARS = 512 * 1024;
const MAX_CANDIDATES = 200;
/** Characters examined across every candidate, so stray brackets cannot make a scan quadratic. */
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

/** The run of backslashes before `index`, which escapes a quote there when odd. */
const backslashesBefore = (text: string, index: number) => {
  let count = 0;
  while (text[index - 1 - count] === "\\") count += 1;
  return count;
};

/**
 * Where the JSON value whose last bracket is at `end - 1` starts, found by
 * matching that bracket backwards. Undefined when nothing balances or a
 * bracket mismatches, and `exhausted` when `limit` characters were examined
 * without reaching it.
 */
function jsonStart(
  text: string,
  end: number,
  limit: number,
): { readonly start: number | undefined; readonly steps: number; readonly exhausted: boolean } {
  const stack: Array<string> = [];
  let inString = false;
  const floor = Math.max(0, end - limit);
  let index = end - 1;
  const done = (start: number | undefined, exhausted = false) => ({
    start,
    steps: end - index,
    exhausted,
  });
  for (; index >= floor; index -= 1) {
    const char = text[index]!;
    if (char === '"') {
      const backslashes = backslashesBefore(text, index);
      if (backslashes % 2 === 0) inString = !inString;
      index -= backslashes;
    } else if (inString) {
      continue;
    } else if (char === "}" || char === "]") {
      stack.push(char === "}" ? "{" : "[");
    } else if (char === "{" || char === "[") {
      if (stack.pop() !== char) return done(undefined);
      if (stack.length === 0) return done(index);
    }
  }
  // Only a scan stopped short of the text's start ran out; a mismatch did not.
  return done(undefined, floor > 0);
}

/**
 * The nearest bracket before `end` left open, for each reading of `end`:
 * outside a string, then inside one. Backwards, a quote cannot tell a
 * string's inside from its outside, so both are scanned at once; every quote
 * flips both, so at each character exactly one is outside a string. A
 * reading's start is undefined when a bracket mismatches first or none is
 * left open, and `exhausted` when `limit` characters were examined with
 * either reading undecided.
 */
function enclosingStarts(
  text: string,
  end: number,
  limit: number,
): {
  readonly starts: ReadonlyArray<number | undefined>;
  readonly steps: number;
  readonly exhausted: boolean;
} {
  const stacks: Array<Array<string>> = [[], []];
  const starts: Array<number | undefined> = [undefined, undefined];
  const decided = [false, false];
  let outside = 0;
  const floor = Math.max(0, end - limit);
  let index = end - 1;
  for (; index >= floor && !(decided[0] && decided[1]); index -= 1) {
    const char = text[index]!;
    if (char === '"') {
      const backslashes = backslashesBefore(text, index);
      if (backslashes % 2 === 0) outside = 1 - outside;
      index -= backslashes;
    } else if (decided[outside]) {
      continue;
    } else if (char === "}" || char === "]") {
      stacks[outside]!.push(char === "}" ? "{" : "[");
    } else if (char === "{" || char === "[") {
      const stack = stacks[outside]!;
      // Nothing to close here: this bracket is the one left open.
      if (stack.length === 0) starts[outside] = index;
      if (stack.length === 0 || stack.pop() !== char) decided[outside] = true;
    }
  }
  // Only a scan stopped short of the text's start ran out; a mismatch did not.
  return {
    starts,
    steps: end - index,
    exhausted: floor > 0 && !(decided[0] && decided[1]),
  };
}

/**
 * What closes the JSON begun at `start` when it is cut at `end`: the
 * brackets left open, and whether a string is. Undefined when they all close
 * or one mismatches first.
 */
function openJson(
  text: string,
  start: number,
  end: number,
): { readonly closers: string; readonly inString: boolean } | undefined {
  const stack: Array<string> = [];
  let inString = false;
  for (let index = start; index < end; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char || stack.length === 0) return undefined;
    }
  }
  return { closers: stack.toReversed().join(""), inString };
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the value from `valueStart` to `end` lies inside JSON that begins
 * at `start` and is still open there: the brackets opened from `start`
 * neither close nor mismatch before `end`, and closing them makes valid
 * JSON. So a truncated `{"ok":false,"details":{"ok":true}` holds its inner
 * value, while a stray bracket in prose begins no JSON and holds nothing.
 * Read from `start`, a value that ends inside a string sits in one, as in
 * `{"ok":false,"note":"oops {"ok":true}`: it is held when the text before
 * it, with that string closed, is valid JSON, but not after a stray bracket
 * and an unpaired quote in prose.
 */
function insideOpenJson(text: string, start: number, valueStart: number, end: number): boolean {
  const open = openJson(text, start, end);
  if (open === undefined) return false;
  if (!open.inString) return isJson(text.slice(start, end) + open.closers);
  const before = openJson(text, start, valueStart);
  return (
    before !== undefined &&
    isJson(text.slice(start, valueStart) + (before.inString ? '"' : "") + before.closers)
  );
}

const isSpace = (char: string | undefined) =>
  char === " " || char === "\n" || char === "\r" || char === "\t";

/**
 * Whether the bracket at `start`, left open before `valueStart` when read
 * forwards, begins JSON that holds the value at `valueStart` as one of its
 * own, whatever its syntax: `{` before a quoted name with the value after a
 * quoted name and its colon (or a name missing the colon), or `[` before an
 * item with the value after `[`, a comma or an item missing its comma. So
 * `{"ok":false "details":{"ok":true}` holds its inner value, while
 * `{ "note": x, {"ok":true}`, `[1, 2 and {"ok":true}` and
 * `{"items": [ ... ] Result: {"ok":true}` read as prose.
 */
function holdsAsMember(text: string, start: number, valueStart: number): boolean {
  const open = openJson(text, start, valueStart);
  if (open === undefined || open.inString) return false;
  let first = start + 1;
  while (first < valueStart && isSpace(text[first])) first += 1;
  let last = valueStart - 1;
  while (last > start && isSpace(text[last])) last -= 1;
  const before = text[last]!;
  if (text[start] === "{") {
    if (text[first] !== '"' || (before !== ":" && before !== '"')) return false;
    if (before === '"') return true;
    // After a colon, the name before it is quoted: `Result:` is a label in prose.
    let name = last - 1;
    while (name > start && isSpace(text[name])) name -= 1;
    return text[name] === '"';
  }
  const item =
    /["{[\-\d]/.test(text[first]!) ||
    ["true", "false", "null"].some((word) => text.startsWith(word, first));
  return item && /["\]}[,\d]/.test(before);
}

/** Each fenced block's content: from after its opening line to its closing fence, or the end. */
function fencedBlocks(
  text: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  let open: number | undefined;
  for (let at = text.indexOf("```"); at !== -1; at = text.indexOf("```", at + 3)) {
    let lineStart = at;
    while (lineStart > 0 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) {
      lineStart -= 1;
    }
    if (lineStart > 0 && text[lineStart - 1] !== "\n") continue;
    if (open === undefined) {
      const newline = text.indexOf("\n", at);
      if (newline === -1) break;
      open = newline + 1;
      at = newline - 2;
    } else {
      blocks.push({ start: open, end: lineStart });
      open = undefined;
    }
  }
  if (open !== undefined) blocks.push({ start: open, end: text.length });
  return blocks;
}

/**
 * When fenced content from `start` begins with a bracket, the bracket still
 * open at `valueStart` that holds it, counting brackets outside strings
 * whether or not they pair up: fenced content is meant as JSON, so a match
 * nested in a value there is a piece of it however its syntax went wrong.
 */
function fencedValueAround(text: string, start: number, valueStart: number): number | undefined {
  let index = start;
  while (index < valueStart && isSpace(text[index])) index += 1;
  if (index >= valueStart || (text[index] !== "{" && text[index] !== "[")) return undefined;
  let depth = 0;
  let outermost = index;
  let inString = false;
  for (; index < valueStart; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      if (depth === 0) outermost = index;
      depth += 1;
    } else if ((char === "}" || char === "]") && depth > 0) depth -= 1;
  }
  return depth > 0 ? outermost : undefined;
}

/**
 * The last JSON object (or array) in `text` that matches `schema`, for a
 * child that ended its turn with the result instead of calling
 * `t3_task_return`. Values are found from the end by their closing bracket
 * and taken whole, never as a piece nested inside one, so
 * `{"ok":false,"details":{"ok":true}}` is not read as `{"ok":true}` whatever
 * follows it in the message, nor is the same value cut short, closed with
 * the wrong bracket, or missing a comma or colon before it. Every
 * candidate's pattern checks share one validation's budget, and the scan
 * stops when it runs out.
 *
 * Outside a fence, a value with other syntax errors before the match, such
 * as a mismatched bracket, a comment or an unquoted key, is not taken for a
 * value holding it, so the match nested in it is read: no one rule tells
 * those from prose that happens to hold brackets and quotes. A fence whose
 * content begins with a bracket, as the task prompt asks for, is stricter:
 * any bracket there still open holds the match.
 */
export function structuredResultFromText(
  schema: unknown,
  text: string,
): Result.Result<unknown, string> {
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) return compiled;
  const decode = compiled.success;
  // Every candidate's pattern checks share one budget, as one validation's do.
  const budget: PatternBudget = { remaining: MAX_VALIDATION_WORK };
  let tried = 0;
  let steps = 0;
  let lastProblem: string | undefined;
  let unfinished = false;
  let fences: ReturnType<typeof fencedBlocks> | undefined;
  /** The fenced block whose content holds `index`, if any. */
  const fenceAt = (index: number) => {
    fences ??= fencedBlocks(text);
    let low = 0;
    let high = fences.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const block = fences[middle]!;
      if (index < block.start) high = middle - 1;
      else if (index >= block.end) low = middle + 1;
      else return block;
    }
    return undefined;
  };
  const tryCandidate = (candidate: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return undefined;
    }
    const validated = decode(parsed, budget);
    if (Result.isFailure(validated)) {
      // Out of budget, no later candidate is checked: that is the problem to report.
      if (budget.remaining < 0) lastProblem = validated.failure;
      else lastProblem ??= validated.failure;
      // A final message is not a tool call: the value it ends with, meant as the result, may
      // carry a field a closed object leaves out. That value without it is the result, rather
      // than an earlier one the message mentions, which may say the opposite. Only a value
      // that fails as given is stripped, so a `oneOf` branch it matches as given still decides.
      if (budget.remaining >= 0) {
        const stripped = decode(parsed, budget, true);
        if (Result.isSuccess(stripped)) return stripped;
        if (budget.remaining < 0) lastProblem = stripped.failure;
      }
    }
    return validated;
  };
  for (
    let index = text.length - 1;
    index >= 0 && tried < MAX_CANDIDATES && steps < MAX_SCAN_STEPS;
    index -= 1
  ) {
    const char = text[index];
    if (char !== "}" && char !== "]") continue;
    const end = index + 1;
    const back = jsonStart(text, end, Math.min(MAX_CANDIDATE_CHARS, MAX_SCAN_STEPS - steps));
    steps += back.steps;
    // A value too long to match is left whole too: its pieces are not read in its place.
    if (back.exhausted) break;
    if (back.start === undefined) continue;
    // Read forwards from that bracket, the value must close where the
    // backward match began: scanning backwards cannot tell a string's inside
    // from its outside once prose after the value holds an unpaired quote.
    const forward = balancedJson(text, back.start, end - back.start);
    steps += forward.steps;
    if (forward.json === undefined || forward.json.length !== end - back.start) continue;
    tried += 1;
    const validated = tryCandidate(forward.json);
    if (budget.remaining < 0) break;
    if (validated !== undefined && Result.isSuccess(validated)) {
      // A match that is a piece of an unfinished or malformed value is not
      // the result either: the value around it, and its other pieces, are
      // left. That includes a match inside one of the value's strings.
      let around: number | undefined;
      const fence = fenceAt(back.start);
      if (fence !== undefined) {
        steps += back.start - fence.start;
        if (steps > MAX_SCAN_STEPS) break;
        around = fencedValueAround(text, fence.start, back.start);
      }
      const outer =
        around === undefined
          ? enclosingStarts(text, back.start, MAX_SCAN_STEPS - steps)
          : undefined;
      if (outer !== undefined) {
        steps += outer.steps;
        if (outer.exhausted) break;
      }
      for (const start of outer?.starts ?? []) {
        if (start === undefined) continue;
        steps += 3 * (end - start);
        if (
          insideOpenJson(text, start, back.start, end) ||
          holdsAsMember(text, start, back.start)
        ) {
          around = start;
          break;
        }
      }
      if (around === undefined) return validated;
      unfinished = true;
      index = around;
      continue;
    }
    // Whether or not it was JSON, the value's pieces are not candidates.
    index = back.start;
  }
  return Result.fail(
    lastProblem !== undefined
      ? `The final message's JSON does not match the schema: ${lastProblem}`
      : unfinished
        ? "The final message's JSON is unfinished or malformed, so none of it is read."
        : "The final message has no JSON value.",
  );
}
