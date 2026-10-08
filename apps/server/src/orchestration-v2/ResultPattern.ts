/**
 * JSON Schema `pattern`s for result schemas, checked without backtracking.
 *
 * A result schema's pattern is written by a workflow and run against a value
 * a child agent chose, synchronously in the server. The runtime's regular
 * expression engine backtracks, and no syntactic rule bounds its time: even
 * `^(a|aa)(a|aa)…$` without a quantifier is exponential. So a pattern is
 * parsed and run here as a Thompson NFA, tracking the set of states every
 * match could be in, one code point at a time: time is at most the value's
 * length times the pattern's state count, whatever the pattern.
 *
 * The subset is ECMAScript's `u`-flag syntax without the parts an NFA cannot
 * match: backreferences, lookaround and inline modifiers are refused. Each
 * single-character item (a literal, `.`, a class, `\d`, `\p{…}`) is tested by
 * the runtime against one code point at a time, which cannot backtrack, so
 * its meaning is exactly the runtime's.
 */
import regjsparser from "regjsparser";

/** Longest pattern accepted. */
export const MAX_PATTERN_CHARS = 256;
/** Most states a pattern compiles to, after repeats such as `{1,3}` are expanded. */
const MAX_STATES = 1024;
/** Most (value length + 1) × states one check may take: about 100 ms at worst. */
const MAX_WORK = 1 << 22;
/**
 * Steps charged for testing a code point outside ASCII against an atom: the
 * runtime's engine runs anew for it at every position, costing several state
 * steps, while ASCII answers are remembered.
 */
const ATOM_TEST_STEPS = 4;
/** Highest position number a check may use before the marks are cleared. */
const EPOCH_LIMIT = 0x3fffffff;

// Everything the parser knows, so what is refused is refused by name.
const FEATURES = {
  unicodePropertyEscape: true,
  namedGroups: true,
  lookbehind: true,
  modifiers: true,
} as const;
type Node = ReturnType<typeof regjsparser.parse<typeof FEATURES>>;

const KIND = {
  match: 0,
  atom: 1,
  split: 2,
  start: 3,
  end: 4,
  boundary: 5,
  "not-boundary": 6,
} as const;

/**
 * Steps left for a run of checks, such as every pattern check in one
 * validation, so checks that each fit cannot add up without end.
 */
export interface PatternBudget {
  remaining: number;
}

export interface ResultPattern {
  readonly source: string;
  /** Longest string, in UTF-16 code units, `test` checks. */
  readonly longest: number;
  /** States the pattern compiled to: a check costs up to (length + 1) × size steps. */
  readonly size: number;
  /**
   * Whether `value` holds a match, as `new RegExp(source, "u").test(value)`.
   * Undefined past `longest`, or when the check outruns `budget`, which is
   * then left negative; otherwise the steps it took come off `budget`.
   */
  readonly test: (value: string, budget?: PatternBudget) => boolean | undefined;
}

class Refused extends Error {}

const TOO_BIG = `expands to more than ${MAX_STATES} steps; use smaller repeat counts`;

/** `[A-Za-z0-9_]`: `\w` and `\b`'s word characters under the `u` flag without `i`. */
const isWordChar = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 48 && codePoint <= 57) ||
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122) ||
    codePoint === 95);

/** A one-code-point item, tested by the runtime; ASCII answers are remembered. */
function makeAtom(raw: string): (codePoint: number) => boolean {
  const regExp = new RegExp(`^(?:${raw})$`, "u");
  const ascii = new Int8Array(128);
  return (codePoint) => {
    if (codePoint < 128 && ascii[codePoint] !== 0) return ascii[codePoint] === 1;
    const matches = regExp.test(String.fromCodePoint(codePoint));
    if (codePoint < 128) ascii[codePoint] = matches ? 1 : -1;
    return matches;
  };
}

/**
 * The NFA as flat arrays: each state's kind, the state it continues to, and
 * a split's other branch or an atom's index.
 */
function compileStates(root: Node) {
  const kinds: Array<number> = [];
  const nexts: Array<number> = [];
  const others: Array<number> = [];
  const atoms: Array<(codePoint: number) => boolean> = [];
  const atomIndex = new Map<string, number>();
  let calls = 0;
  const add = (kind: number, next: number, other = 0) => {
    if (kinds.length >= MAX_STATES) throw new Refused(TOO_BIG);
    kinds.push(kind);
    nexts.push(next);
    others.push(other);
    return kinds.length - 1;
  };
  const sequence = (nodes: ReadonlyArray<Node>, next: number) => {
    let start = next;
    for (let index = nodes.length - 1; index >= 0; index -= 1) start = emit(nodes[index]!, start);
    return start;
  };
  // Builds back to front: the states matching `node`, then continuing at `next`.
  function emit(node: Node, next: number): number {
    // A repeated empty group adds no state, so the calls are counted too.
    calls += 1;
    if (calls > MAX_STATES * 4) throw new Refused(TOO_BIG);
    switch (node.type) {
      case "alternative":
        return sequence(node.body, next);
      case "disjunction": {
        let start = emit(node.body[node.body.length - 1]!, next);
        for (let index = node.body.length - 2; index >= 0; index -= 1) {
          start = add(KIND.split, emit(node.body[index]!, next), start);
        }
        return start;
      }
      case "group":
        if (node.behavior !== "normal" && node.behavior !== "ignore") {
          throw new Refused("looks ahead or behind");
        }
        if (node.behavior === "ignore" && node.modifierFlags !== undefined) {
          throw new Refused("sets flags inside the pattern");
        }
        return sequence(node.body, next);
      case "quantifier": {
        const body = node.body[0];
        // Greedy and lazy repeats match the same strings, so only the counts matter.
        let start = next;
        if (node.max === undefined) {
          start = add(KIND.split, -1, next);
          nexts[start] = emit(body, start);
        } else {
          for (let count = node.min; count < node.max; count += 1) {
            start = add(KIND.split, emit(body, start), next);
          }
        }
        for (let count = 0; count < node.min; count += 1) start = emit(body, start);
        return start;
      }
      case "anchor":
        return add(KIND[node.kind], next);
      case "reference":
        throw new Refused("refers back to a group");
      case "value":
      case "dot":
      case "characterClass":
      case "characterClassEscape":
      case "unicodePropertyEscape": {
        let index = atomIndex.get(node.raw);
        if (index === undefined) {
          index = atoms.push(makeAtom(node.raw)) - 1;
          atomIndex.set(node.raw, index);
        }
        return add(KIND.atom, next, index);
      }
      default:
        throw new Refused("uses syntax that is not supported");
    }
  }
  const match = add(KIND.match, -1);
  const start = emit(root, match);
  return {
    kinds: Uint8Array.from(kinds),
    nexts: Int32Array.from(nexts),
    others: Int32Array.from(others),
    atoms,
    start,
  };
}

/** Whether the runtime parses `source` as a `u`-flag pattern; parsing runs nothing. */
const isValidPattern = (source: string) => {
  try {
    return new RegExp(source, "u") instanceof RegExp;
  } catch {
    return false;
  }
};

/** Compiles `source`, or says why it is refused. */
export function compileResultPattern(source: string): ResultPattern | { readonly reason: string } {
  if (source.length > MAX_PATTERN_CHARS) {
    return { reason: `is longer than ${MAX_PATTERN_CHARS} characters` };
  }
  if (!isValidPattern(source)) return { reason: "is not a valid regular expression" };
  let compiled: ReturnType<typeof compileStates>;
  try {
    compiled = compileStates(regjsparser.parse(source, "u", FEATURES));
  } catch (error) {
    if (error instanceof Refused) return { reason: error.message };
    // The runtime accepts it but the parser does not: newer syntax such as `(?i:…)`.
    return { reason: "uses syntax that is not supported" };
  }
  const { kinds, nexts, others, atoms, start } = compiled;
  const count = kinds.length;
  const longest = Math.floor(MAX_WORK / count) - 1;

  // Scratch space for every check of this pattern, allocated once: a check
  // is synchronous and calls nothing that checks again (atoms run the
  // runtime's engine on one code point), so no two checks share it at once.
  // Clearing the marks would cost a step per state per check, uncharged, so
  // each check takes fresh position numbers from `epoch` instead.
  // The position each state was last added at, so it joins a list once per position.
  const seen = new Int32Array(count).fill(-1);
  const stack = new Int32Array(count);
  let current = new Int32Array(count);
  let next = new Int32Array(count);
  // Each atom's answer for the code point at the position it was tested at.
  const tested = new Int32Array(atoms.length).fill(-1);
  const answers = new Uint8Array(atoms.length);
  let epoch = 0;

  const test = (value: string, budget?: PatternBudget): boolean | undefined => {
    if (value.length > longest) return undefined;
    // A check numbers its positions from `epoch` to at most `epoch + value.length`.
    if (epoch > EPOCH_LIMIT - value.length) {
      epoch = 0;
      seen.fill(-1);
      tested.fill(-1);
    }
    let position = epoch;
    epoch += value.length + 1;
    const allowance = budget?.remaining ?? Infinity;
    // States added, and the runtime's tests of atoms.
    let steps = 0;
    const done = (found: boolean) => {
      const matched = steps > allowance ? undefined : found;
      if (budget !== undefined) budget.remaining = matched === undefined ? -1 : allowance - steps;
      return matched;
    };
    let currentLength = 0;
    let nextLength = 0;
    let index = 0;
    let previous: number | undefined;
    const push = (state: number, depth: number) => {
      if (seen[state] === position) return depth;
      seen[state] = position;
      steps += 1;
      stack[depth] = state;
      return depth + 1;
    };
    // Adds `state` and every state reachable from it without reading to
    // `next`, at `index`; true when one of them is the match.
    const close = (state: number): boolean => {
      let depth = push(state, 0);
      while (depth > 0) {
        const id = stack[--depth]!;
        const kind = kinds[id]!;
        if (kind === KIND.match) return true;
        if (kind === KIND.atom) {
          next[nextLength++] = id;
        } else if (kind === KIND.split) {
          depth = push(others[id]!, depth);
          depth = push(nexts[id]!, depth);
        } else if (
          kind === KIND.start
            ? index === 0
            : kind === KIND.end
              ? index === value.length
              : (isWordChar(previous) !== isWordChar(value.codePointAt(index))) ===
                (kind === KIND.boundary)
        ) {
          depth = push(nexts[id]!, depth);
        }
      }
      return false;
    };
    // A match may start anywhere, so the start state joins at every position.
    if (close(start)) return done(true);
    while (index < value.length) {
      // One position takes a few steps per state at most, so this stops soon past the allowance.
      if (steps > allowance) return done(false);
      [current, next] = [next, current];
      currentLength = nextLength;
      nextLength = 0;
      const codePoint = value.codePointAt(index)!;
      previous = codePoint;
      index += codePoint > 0xffff ? 2 : 1;
      position += 1;
      for (let item = 0; item < currentLength; item += 1) {
        const id = current[item]!;
        const atom = others[id]!;
        if (tested[atom] !== position) {
          tested[atom] = position;
          steps += codePoint < 128 ? 1 : ATOM_TEST_STEPS;
          answers[atom] = atoms[atom]!(codePoint) ? 1 : 0;
        }
        if (answers[atom] === 1 && close(nexts[id]!)) return done(true);
      }
      if (close(start)) return done(true);
    }
    return done(false);
  };
  return { source, longest, size: count, test };
}
