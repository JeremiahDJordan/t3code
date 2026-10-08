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

type Decoder = (value: unknown) => Result.Result<unknown, string>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Values decoded once at compile, so a schema that throws (a cyclic `$ref`) is refused up front. */
const PROBES: ReadonlyArray<unknown> = [null, {}, []];

const MAX_CACHED_SCHEMAS = 64;
const decoders = new Map<string, Result.Result<Decoder, string>>();

/** Longest `pattern` enforced; a longer one is refused rather than guessed about. */
const MAX_PATTERN_CHARS = 256;

/**
 * Longest string a `pattern` is checked against, by the pattern's cost: the
 * number of variable-width quantifiers in it, plus one when it is not anchored
 * at its start, since the engine then retries from every position. Each entry
 * keeps a mismatch to a few milliseconds; a pattern past the table is refused.
 */
const PATTERN_VALUE_LENGTHS: ReadonlyArray<number> = [4096, 4096, 4096, 256, 64];

/**
 * How `pattern` may be enforced: refused with a reason, or applied to strings
 * no longer than `maxLength`. Patterns run on the runtime's backtracking
 * engine against values the child chose. A repeated group or a backreference
 * can take exponential time, so those are refused. Without them a mismatch
 * costs about the value's length raised to the number of variable-width
 * quantifiers (`*`, `+`, `?`, `{n,m}`), so that count picks the length.
 */
function patternBound(
  pattern: string,
): { readonly reason: string } | { readonly cost: number; readonly maxLength: number } {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return { reason: `is longer than ${MAX_PATTERN_CHARS} characters` };
  }
  let inClass = false;
  let depth = 0;
  let quantifiers = 0;
  let topLevelAlternation = false;
  let afterQuantifier = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const previous = pattern[index - 1];
    const wasAfterQuantifier: boolean = afterQuantifier;
    afterQuantifier = false;
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      if (next === "k" || (next >= "1" && next <= "9")) return { reason: "refers back to a group" };
      index += 1;
      // \p{...}, \P{...} and \u{...} hold braces that are not quantifiers.
      if ("pPu".includes(next) && pattern[index + 1] === "{") {
        const close = pattern.indexOf("}", index);
        index = close === -1 ? pattern.length : close;
      }
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (/^[*+?{]/.test(pattern.slice(index + 1, index + 2))) return { reason: "repeats a group" };
    } else if (char === "|") {
      if (depth === 0) topLevelAlternation = true;
    } else if (char === "*" || char === "+") {
      quantifiers += 1;
      afterQuantifier = true;
    } else if (char === "?") {
      // Not the lazy modifier of a quantifier, nor the `?` of a group prefix.
      if (!wasAfterQuantifier && previous !== "(") quantifiers += 1;
      afterQuantifier = !wasAfterQuantifier;
    } else if (char === "{") {
      const range = /^\{\d+(,\d*)?\}/.exec(pattern.slice(index));
      if (range !== null) {
        if (range[1] !== undefined) quantifiers += 1;
        index += range[0].length - 1;
        afterQuantifier = true;
      }
    }
  }
  const anchored = pattern.startsWith("^") && !topLevelAlternation;
  const cost = quantifiers + (anchored ? 0 : 1);
  const maxLength = PATTERN_VALUE_LENGTHS[cost];
  return maxLength === undefined
    ? {
        reason: `has ${quantifiers} variable-width quantifiers${anchored ? "" : " and no ^ anchor"}, more than can be checked`,
      }
    : { cost, maxLength };
}

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

const lengthOf = (value: unknown) => (typeof value === "number" ? value : Infinity);

/**
 * `schema` with every pattern constraint bounded: a `maxLength` beside each
 * `pattern`, so the engine never sees a string longer than the pattern's cost
 * allows. A `patternProperties` key is matched against property names, whose
 * length nothing bounds, so it must be linear. Throws naming the first
 * pattern that cannot be enforced.
 */
function boundPatterns(schema: unknown, path: string, keyed: boolean): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item, index) => boundPatterns(item, `${path}/${index}`, keyed));
  }
  const refuse = (pattern: string, at: string, reason: string): never => {
    throw new Error(
      `the pattern ${JSON.stringify(pattern)} at ${at} ${reason}, so it cannot be checked in bounded time. Use enum, or a pattern without repeated groups or long chains of quantifiers.`,
    );
  };
  const bound = (pattern: string, at: string) => {
    const result = patternBound(pattern);
    return "reason" in result ? refuse(pattern, at, result.reason) : result;
  };
  const copy: Record<string, unknown> = { ...schema };
  let cap = Infinity;
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}/${key}`;
    if (keyed && DATA_KEYWORDS.has(key)) continue;
    if (keyed && key === "pattern" && typeof value === "string") {
      cap = bound(value, at).maxLength;
      continue;
    }
    if (keyed && key === "patternProperties" && typeof value === "object" && value !== null) {
      for (const pattern of Object.keys(value)) {
        if (bound(pattern, at).cost > 1) {
          refuse(pattern, at, "has a quantifier or no ^ anchor, and names have no length limit");
        }
      }
    }
    copy[key] = boundPatterns(value, at, !(keyed && SCHEMA_MAP_KEYWORDS.has(key)));
  }
  // The cap holds whichever order the schema lists `pattern` and its own `maxLength` in.
  if (cap !== Infinity) copy.maxLength = Math.min(cap, lengthOf(copy.maxLength));
  return copy;
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
    const raw = boundPatterns(schema, "", true) as JsonSchema.JsonSchema;
    const dialect = typeof raw.$schema === "string" && raw.$schema.includes("draft-07");
    const document = dialect
      ? JsonSchema.fromSchemaDraft07(raw)
      : JsonSchema.fromSchemaDraft2020_12(raw);
    // Patterns are enforced: the walk above refused any that could backtrack
    // without bound and capped the length of the strings the rest see.
    const decode = Schema.decodeUnknownResult(
      SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "apply" }) as Schema.Codec<
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
 * the wrong bracket, or missing a comma or colon before it.
 */
export function structuredResultFromText(
  schema: unknown,
  text: string,
): Result.Result<unknown, string> {
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) return compiled;
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
    const validated = validateStructuredResult(schema, parsed);
    if (Result.isFailure(validated)) lastProblem ??= validated.failure;
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
