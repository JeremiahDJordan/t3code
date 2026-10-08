/**
 * Static checks and `meta` decoding for workflow scripts. A script is a
 * compatible superset of Claude Code's Workflow scripts: `meta.t3: 1` marks the
 * T3 dialect, and anything else is read as a Claude script.
 */
import {
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Largest script a run accepts, in UTF-8 bytes. */
export const WORKFLOW_SOURCE_MAX_BYTES = 512 * 1024;

const META_HEADER = /\bexport\s+const\s+meta\s*=/;

/** A problem with a script, with the 1-based line it is on when there is one. */
export interface WorkflowScriptProblem {
  readonly message: string;
  readonly line: number | null;
}

export function workflowSourceHash(source: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(source)));
}

/**
 * The source with comments, and optionally string contents, replaced by
 * spaces. Newlines and length are kept, so offsets and lines still match the
 * original. Regex literals are recognized by the usual previous-token rule.
 */
/** What JavaScript treats as a line break: LF, CR, U+2028 and U+2029. */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

export function blankNonCode(source: string, options?: { readonly keepStrings?: boolean }): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (!LINE_TERMINATORS.has(out[index]!)) out[index] = " ";
    }
  };
  // Each entry is the brace depth at which a template's `${` was opened.
  const templates: Array<number> = [];
  let depth = 0;
  let lastSignificant = "";
  let index = 0;
  const regexMayStart = () =>
    lastSignificant === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant);
  const skipString = (quote: string) => {
    const start = index;
    index += 1;
    // A quoted string cannot hold a raw LF or CR (U+2028 and U+2029 are allowed).
    while (
      index < source.length &&
      source[index] !== quote &&
      source[index] !== "\n" &&
      source[index] !== "\r"
    ) {
      index += source[index] === "\\" ? 2 : 1;
    }
    if (!options?.keepStrings) blank(start + 1, Math.min(index, source.length));
    index += 1;
  };
  // Scans template text from `index`, stopping after the closing backtick or
  // just after a `${`, which pushes a template frame.
  const skipTemplateText = () => {
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        if (!options?.keepStrings) blank(start, index);
        index += 1;
        return;
      }
      if (char === "$" && source[index + 1] === "{") {
        if (!options?.keepStrings) blank(start, index);
        index += 2;
        templates.push(depth);
        depth += 1;
        return;
      }
      index += 1;
    }
    if (!options?.keepStrings) blank(start, index);
  };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      let stop = index;
      while (stop < source.length && !LINE_TERMINATORS.has(source[stop]!)) stop += 1;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      skipString(char);
      lastSignificant = "a";
      continue;
    }
    if (char === "`") {
      index += 1;
      skipTemplateText();
      lastSignificant = "a";
      continue;
    }
    if (char === "/" && regexMayStart()) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== "\n") {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        index += 1;
      }
      if (!options?.keepStrings) blank(start + 1, Math.min(index, source.length));
      index += 1;
      lastSignificant = "a";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (templates.length > 0 && templates.at(-1) === depth) {
        templates.pop();
        index += 1;
        skipTemplateText();
        lastSignificant = "a";
        continue;
      }
    }
    if (!/\s/.test(char)) {
      // `return /re/` starts a regex; any other word ends an operand.
      lastSignificant = /[A-Za-z0-9_$]/.test(char)
        ? source.slice(Math.max(0, index - 5), index + 1).endsWith("return")
          ? "("
          : "a"
        : char;
    }
    index += 1;
  }
  return out.join("");
}

/** Where the `meta` object literal starts and ends in blanked code. */
function metaLiteralSpan(code: string): { readonly start: number; readonly end: number } | null {
  const header = META_HEADER.exec(code);
  if (header === null) return null;
  const start = code.indexOf("{", header.index + header[0].length);
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index };
    }
  }
  return null;
}

/** Maps offsets in `source` to 1-based lines, indexing the newlines once. */
function lineLocator(source: string): (offset: number) => number {
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

// Module syntax after `meta`, at the start of a statement: after a line break
// (any of JavaScript's four) or `;`. The whitespace class stops at line breaks
// and each break is its own start, so the scan stays linear in the source length.
const OTHER_MODULE_SYNTAX = /(?:^|[\n\r\u2028\u2029;])[^\S\n\r\u2028\u2029]*(import|export)\b/;

/** Problems reported per Claude check; a script past this has bigger issues. */
const MAX_CLAUDE_PROBLEMS = 20;

/**
 * The script with its `export const meta =` header turned into an assignment
 * the sandbox can read, wrapped as an async body so top-level `await` and
 * `return` work. The wrapper sits on line 1, so line numbers still match.
 */
export function prepareWorkflowSource(
  source: string,
): Result.Result<{ readonly body: string }, WorkflowScriptProblem> {
  if (new TextEncoder().encode(source).byteLength > WORKFLOW_SOURCE_MAX_BYTES) {
    return Result.fail({
      message: `A workflow script can be at most ${WORKFLOW_SOURCE_MAX_BYTES / 1024} KB.`,
      line: null,
    });
  }
  const code = blankNonCode(source);
  const header = META_HEADER.exec(code);
  if (header === null) {
    return Result.fail({
      message: "A workflow script must begin with `export const meta = { ... }`.",
      line: null,
    });
  }
  const before = code.slice(0, header.index);
  if (before.trim().length > 0) {
    return Result.fail({
      message: "`export const meta = { ... }` must be the script's first statement.",
      line: lineLocator(source)(header.index),
    });
  }
  const rest = code.slice(header.index + header[0].length);
  const otherModuleSyntax = OTHER_MODULE_SYNTAX.exec(rest);
  if (otherModuleSyntax !== null) {
    // The match starts at the separator before the keyword, or at the keyword's own line.
    return Result.fail({
      message: `A workflow script cannot use \`${otherModuleSyntax[1]}\`; only \`meta\` is exported.`,
      line: lineLocator(source)(header.index + header[0].length + otherModuleSyntax.index + 1),
    });
  }
  const assigned =
    source.slice(0, header.index) +
    "const meta = globalThis.__t3meta =" +
    source.slice(header.index + header[0].length);
  return Result.succeed({ body: `(async () => {${assigned}\n})()` });
}

/**
 * Claude features T3 cannot honor, each rejected before a run starts with the
 * line it is on, and the model names its `agent()` calls ask for.
 */
export function scanClaudeScript(source: string): {
  readonly problems: ReadonlyArray<WorkflowScriptProblem>;
  readonly models: ReadonlyArray<string>;
} {
  const code = blankNonCode(source);
  const problems: Array<WorkflowScriptProblem> = [];
  const checks: ReadonlyArray<{ readonly pattern: RegExp; readonly message: string }> = [
    {
      pattern: /\bagentType\s*:/g,
      message: "agentType is not supported in T3 workflows; describe the agent in its prompt.",
    },
    {
      pattern: /\bbudget\s*(\.\s*(total|spent|remaining)\b|:)/g,
      message: "budget is not supported in T3 workflows; the environment caps agents instead.",
    },
    {
      pattern: /(?<![\w$.])workflow\s*\(/g,
      message: "Nested workflow() calls are not supported in T3 workflows.",
    },
  ];
  const lineAt = lineLocator(source);
  for (const check of checks) {
    let found = 0;
    for (const match of code.matchAll(check.pattern)) {
      problems.push({ message: check.message, line: lineAt(match.index) });
      found += 1;
      if (found === MAX_CLAUDE_PROBLEMS) break;
    }
  }
  const withStrings = blankNonCode(source, { keepStrings: true });
  const meta = metaLiteralSpan(code);
  const models = new Set<string>();
  for (const match of withStrings.matchAll(/\bmodel\s*:\s*(["'`])([A-Za-z0-9._:/-]+)\1/g)) {
    // A key inside a string is prose, and `meta.phases[].model` only labels a phase.
    const inMeta = meta !== null && match.index > meta.start && match.index < meta.end;
    if (code[match.index] === "m" && !inMeta) models.add(match[2]!);
  }
  problems.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  return { problems: problems.slice(0, MAX_CLAUDE_PROBLEMS), models: [...models] };
}

const RoleModes = {
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
};

export const WorkflowRoleRequest = Schema.Union([
  Schema.Struct({ inherit: Schema.Literal(true), ...RoleModes }),
  Schema.Struct({
    driver: ProviderDriverKind,
    model: Schema.optional(TrimmedNonEmptyString),
    options: Schema.optional(
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
    ),
    ...RoleModes,
  }),
]);
export type WorkflowRoleRequest = typeof WorkflowRoleRequest.Type;

const MetaPhase = Schema.Struct({
  title: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

const PositiveCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const T3Meta = Schema.Struct({
  t3: Schema.Literal(1),
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  roles: Schema.optional(Schema.Record(Schema.String, WorkflowRoleRequest)),
  limits: Schema.optional(
    Schema.Struct({
      concurrency: Schema.optional(PositiveCount),
      agents: Schema.optional(PositiveCount),
    }),
  ),
  phases: Schema.optional(Schema.Array(MetaPhase)),
});

const ClaudeMeta = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  whenToUse: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  phases: Schema.optional(Schema.Array(MetaPhase)),
});

/** A script's `meta`, in the shape the rest of T3 reads, whichever dialect wrote it. */
export interface WorkflowMeta {
  readonly dialect: "t3" | "claude";
  readonly name: string;
  readonly description: string;
  readonly argsSchema: Record<string, unknown> | null;
  readonly roles: Readonly<Record<string, WorkflowRoleRequest>>;
  readonly limits: {
    readonly concurrency?: number | undefined;
    readonly agents?: number | undefined;
  };
  readonly phases: ReadonlyArray<{ readonly title: string; readonly detail?: string | undefined }>;
}

const decodeT3Meta = Schema.decodeUnknownResult(T3Meta);
const decodeClaudeMeta = Schema.decodeUnknownResult(ClaudeMeta);

/** Decodes the plain-data `meta` the sandbox read from a script. */
export function decodeWorkflowMeta(
  raw: unknown,
): Result.Result<WorkflowMeta, WorkflowScriptProblem> {
  const isT3 =
    typeof raw === "object" && raw !== null && (raw as { readonly t3?: unknown }).t3 !== undefined;
  const phases = (input: ReadonlyArray<typeof MetaPhase.Type> | undefined) =>
    (input ?? []).map((phase) => ({
      title: phase.title,
      ...(phase.detail === undefined ? {} : { detail: phase.detail }),
    }));
  if (isT3) {
    return Result.match(decodeT3Meta(raw), {
      onFailure: (error) => Result.fail({ message: `meta: ${error.message}`, line: null }),
      onSuccess: (meta) =>
        Result.succeed({
          dialect: "t3" as const,
          name: meta.name,
          description: meta.description ?? "",
          argsSchema: meta.args ?? null,
          roles: meta.roles ?? {},
          limits: meta.limits ?? {},
          phases: phases(meta.phases),
        }),
    });
  }
  return Result.match(decodeClaudeMeta(raw), {
    onFailure: (error) => Result.fail({ message: `meta: ${error.message}`, line: null }),
    onSuccess: (meta) =>
      Result.succeed({
        dialect: "claude" as const,
        name: meta.name,
        description: meta.description ?? "",
        argsSchema: meta.args ?? null,
        roles: {},
        limits: {},
        phases: phases(meta.phases),
      }),
  });
}

/** The role a Claude script's `model` option becomes. */
export function claudeModelRole(model: string): string {
  return `model:${model}`;
}
