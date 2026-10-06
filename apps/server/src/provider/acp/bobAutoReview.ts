// @effect-diagnostics nodeBuiltinImport:off
/**
 * The rules T3's Auto mode reviews a Bob tool call by, before Bob runs it.
 *
 * Bob asks about every tool call but its reads, and T3 answers. In Auto, a call these rules find
 * routine runs without the user: a command that only reads, an edit inside the workspace away
 * from settings and secrets, a todo list update, or a subagent, whose own tool calls come here in
 * turn. A call that may be routine for the task, such as running the project's tests or a web
 * search, is left to review against what the user asked for. Everything else asks the user, and
 * so does anything the rules cannot read with certainty: a false ask costs a click, a false allow
 * can cost the machine.
 *
 * @module provider/acp/bobAutoReview
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as EffectAcpSchema from "effect-acp/compat";

/** `allow` runs the call, `review` leaves it to review against the user's request, `ask` asks. */
export type BobAutoVerdict = "allow" | "review" | "ask";

export interface BobAutoReview {
  readonly verdict: BobAutoVerdict;
  /** Why, in a few words, for logs and for a reviewer. */
  readonly reason: string;
}

const allow = (reason: string): BobAutoReview => ({ verdict: "allow", reason });
const review = (reason: string): BobAutoReview => ({ verdict: "review", reason });
const ask = (reason: string): BobAutoReview => ({ verdict: "ask", reason });

/** The strictest of several reviews: any ask asks, then any review reviews. */
function strictest(reviews: ReadonlyArray<BobAutoReview>): BobAutoReview {
  return (
    reviews.find((entry) => entry.verdict === "ask") ??
    reviews.find((entry) => entry.verdict === "review") ??
    allow([...new Set(reviews.map((entry) => entry.reason))].join(", "))
  );
}

/** A rule's allow as a review: the call writes or runs code, which the request must call for. */
function demote(result: BobAutoReview, reason: string): BobAutoReview {
  return result.verdict === "allow" ? review(reason) : result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether a tool's input holds only these keys, as Bob's own tool of that name sends. */
function onlyKeys(input: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return Object.keys(input).every((key) => keys.includes(key));
}

// Where credentials and Bob's and T3's settings live. Reading one sends it to the model; writing
// one can grant an agent more than the user did.
const SECRET_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".bob",
  ".t3",
  ".password-store",
  ".terraform.d",
  "keychains",
]);
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^\.vault-token$/i,
  /^\.pgpass$/i,
  /^\.my\.cnf$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^credentials(\.[a-z]+)?$/i,
  /secrets?(\.[a-z]+)?$/i,
  // Shell history, and the profiles that often export tokens.
  /^\.[a-z_]*history$/i,
  /^\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile)$/i,
];
// Config that runs code or changes what an agent may do, which an edit must ask about.
const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".husky",
  ".githooks",
  ".claude",
  ".codex",
  ".cursor",
  ".gemini",
  ".vscode",
  ".idea",
]);
const PROTECTED_NAMES = [/^\.mcp\.json$/i, /^\.gitmodules$/i, /^\.gitattributes$/i];

function segmentsOf(path: string): ReadonlyArray<string> {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function namesSecret(path: string): boolean {
  const segments = segmentsOf(path).map((segment) => segment.toLowerCase());
  return segments.some(
    (segment, index) =>
      // T3's worktrees, other threads' workspaces, live in T3's home beside its settings.
      (SECRET_SEGMENTS.has(segment) &&
        !(segment === ".t3" && segments[index + 1] === "worktrees")) ||
      SECRET_NAMES.some((name) => name.test(segment)) ||
      // ~/.config/gh, ~/.config/gcloud and the like hold tokens.
      (segment === ".config" && ["gh", "gcloud", "op", "hub"].includes(segments[index + 1] ?? "")),
  );
}

function namesProtected(path: string): boolean {
  return segmentsOf(path).some(
    (segment) =>
      PROTECTED_SEGMENTS.has(segment.toLowerCase()) ||
      PROTECTED_NAMES.some((name) => name.test(segment)),
  );
}

/**
 * A path as the kernel resolves it, for a containment check: the deepest existing ancestor's real
 * path and the rest, so a new file can be checked and a symlink cannot lead out. A path that
 * exists but cannot be resolved, such as a broken symlink, has none.
 */
function canonicalPath(path: string): string | undefined {
  let candidate = path;
  const missing: Array<string> = [];
  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missing);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
    }
    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
    }
    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missing.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

/** The workspace a call is reviewed against, and the user's home for `~`. */
export interface BobAutoReviewContext {
  readonly workspace: string | null;
  readonly home?: string;
}

class Places {
  private readonly home: string;
  private readonly realHome: string;
  readonly workspace: string | undefined;
  constructor(context: BobAutoReviewContext) {
    this.home = context.home ?? NodeOS.homedir();
    this.realHome = canonicalPath(this.home) ?? this.home;
    this.workspace =
      context.workspace && NodePath.isAbsolute(context.workspace)
        ? canonicalPath(context.workspace)
        : undefined;
  }
  /** A path as written, from `base`, with `~` as the home folder; none for `~user`. */
  absolute(path: string, base: string): string | undefined {
    if (path === "~" || path.startsWith("~/")) return NodePath.join(this.home, path.slice(1));
    if (path.startsWith("~")) return undefined;
    return NodePath.resolve(base, path);
  }
  /** Where a path lies in the workspace, through its symlinks; none when it lies outside. */
  inWorkspace(path: string): string | undefined {
    if (this.workspace === undefined) return undefined;
    const canonical = canonicalPath(path);
    if (canonical === undefined) return undefined;
    const relative = NodePath.relative(this.workspace, canonical);
    return relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
      ? undefined
      : relative;
  }
  /**
   * Whether a word may name a secret or a folder holding them. Inside the workspace only the part
   * below it counts, since T3's own worktrees live under `~/.t3`. Outside it, the word as written
   * and as resolved both count, and so do the home folder's hidden folders and `Library`, where
   * every tool keeps its credentials. Unless the read is `shallow`, listing names only, so does
   * any folder holding the home folder or the workspace, which a recursive read descends from
   * into secrets and other projects.
   */
  namesSecret(word: string, base: string, shallow = false): boolean {
    const absolute = this.absolute(word, base);
    if (absolute === undefined) return namesSecret(word);
    const relative = this.inWorkspace(absolute);
    if (relative !== undefined) return namesSecret(relative);
    const resolved = canonicalPath(absolute) ?? absolute;
    if (namesSecret(word) || namesSecret(resolved)) return true;
    const fromHome = within(this.realHome, resolved);
    if (fromHome !== undefined) {
      const first = segmentsOf(fromHome)[0] ?? "";
      const worktrees = segmentsOf(fromHome).slice(0, 2).join("/") === ".t3/worktrees";
      if ((first.startsWith(".") && !worktrees) || first === "Library") return true;
    }
    if (shallow) return false;
    return (
      within(resolved, this.realHome) !== undefined ||
      (this.workspace !== undefined && within(resolved, this.workspace) !== undefined)
    );
  }
}

/** Where `path` lies within `root`, "" for the root itself; none when it lies outside. */
function within(root: string, path: string): string | undefined {
  const relative = NodePath.relative(root, path);
  return relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
    ? undefined
    : relative;
}

/** A path a call writes: in the workspace, and neither a secret nor protected. */
function reviewWrite(places: Places, path: string, base: string, verb: string): BobAutoReview {
  const absolute = places.absolute(path, base);
  if (absolute === undefined) return ask(`${verb} a path the rules cannot resolve`);
  const relative = places.inWorkspace(absolute);
  if (relative === undefined) return ask(`${verb} outside the workspace`);
  if (namesSecret(relative)) return ask(`${verb} secrets or settings`);
  if (namesProtected(relative))
    return ask(`${verb} config that runs code or grants an agent access`);
  return allow(`${verb} the workspace`);
}

function reviewWrites(
  places: Places,
  paths: ReadonlyArray<string>,
  base: string,
  verb: string,
  reason: string,
): BobAutoReview {
  if (paths.length === 0) return ask(`${verb} nothing the rules can place`);
  return demote(strictest(paths.map((path) => reviewWrite(places, path, base, verb))), reason);
}

// --- Commands ---------------------------------------------------------------------------------

interface Word {
  readonly text: string;
  /** An unquoted glob, which the shell may expand to names that read as flags. */
  readonly globbed: boolean;
}
type Token =
  | { readonly type: "word"; readonly word: Word }
  | { readonly type: "op"; readonly op: "&&" | "||" | ";" | "|" };

const WORD_CHARACTER = /[A-Za-z0-9_./:=@%+,~^-]/;
const GLOB_CHARACTER = /[*?[\]]/;
// Output only to /dev/null, and stream merges; any other redirection reads or writes a file.
const REDIRECTION = /^(?:[12]?>>?|&>>?)\s*\/dev\/null(?=[\s;|]|&&|$)|^[12]?>&[12](?=[\s;|]|&&|$)/;

/**
 * Splits a command into words and the operators between them, as a POSIX shell, bash or zsh
 * would, or fails on anything it does not read with certainty: expansions, substitutions,
 * escapes, subshells, braces, zsh glob qualifiers, comments, background jobs, here documents,
 * redirections other than input from a file and output to /dev/null, and more than one line.
 */
function tokenize(command: string): ReadonlyArray<Token> | undefined {
  const tokens: Array<Token> = [];
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    const rest = command.slice(index);
    const operator = /^(&&|\|\||;|\|)/.exec(rest)?.[1] as "&&" | "||" | ";" | "|" | undefined;
    if (operator) {
      tokens.push({ type: "op", op: operator });
      index += operator.length;
      continue;
    }
    const redirection = REDIRECTION.exec(rest);
    if (redirection) {
      index += redirection[0].length;
      continue;
    }
    // Input from a file reads it as an argument would, so it is reviewed as one; here documents,
    // fd duplication and process substitution fail below.
    const input = /^<(?![<&>(])[ \t]*/.exec(rest);
    if (input) {
      index += input[0].length;
      if (index >= command.length || /[;|&\s]/.test(command[index]!)) return undefined;
    }
    let text = "";
    let globbed = false;
    let quoted = false;
    while (index < command.length) {
      const next = command[index]!;
      if (next === " " || next === "\t" || next === ";" || next === "|") break;
      if (next === "&") {
        if (command[index + 1] === "&") break;
        return undefined;
      }
      if (next === "'" || next === '"') {
        const end = command.indexOf(next, index + 1);
        if (end < 0) return undefined;
        const inner = command.slice(index + 1, end);
        if (/[\n\r]/.test(inner)) return undefined;
        // Inside double quotes the shell still expands `$`, backquotes and escapes.
        if (next === '"' && /[$`\\!]/.test(inner)) return undefined;
        text += inner;
        quoted = true;
        index = end + 1;
        continue;
      }
      if (GLOB_CHARACTER.test(next)) globbed = true;
      else if (!WORD_CHARACTER.test(next)) return undefined;
      text += next;
      index += 1;
    }
    if (text.length === 0 && !quoted) return undefined;
    tokens.push({ type: "word", word: { text, globbed } });
  }
  return tokens;
}

interface SimpleCommand {
  readonly words: ReadonlyArray<Word>;
  /** Whether a pipe joins it to the command before or after. */
  readonly piped: boolean;
}

function simpleCommands(tokens: ReadonlyArray<Token>): ReadonlyArray<SimpleCommand> | undefined {
  const commands: Array<SimpleCommand> = [];
  let words: Array<Word> = [];
  let pipedIn = false;
  for (const token of tokens) {
    if (token.type === "word") {
      words.push(token.word);
      continue;
    }
    if (words.length === 0) return undefined;
    commands.push({ words, piped: pipedIn || token.op === "|" });
    pipedIn = token.op === "|";
    words = [];
  }
  if (words.length === 0) return undefined;
  commands.push({ words, piped: pipedIn });
  return commands;
}

/**
 * Commands that only read, with the flags that would make one write, run a program or print the
 * environment, short flags clustered too, and whether a glob may expand into their arguments
 * (one cannot name a flag that does harm).
 */
const READ_ONLY_COMMANDS: Record<string, { readonly denied?: RegExp; readonly glob?: true }> = {
  ls: { glob: true },
  pwd: {},
  cat: { glob: true },
  head: { glob: true },
  tail: { glob: true },
  wc: { glob: true },
  file: { glob: true, denied: /^-[A-Za-z]*C/ },
  stat: { glob: true },
  du: { glob: true },
  df: {},
  tree: { denied: /^-[A-Za-z]*[oR]|^--output/ },
  which: {},
  whereis: {},
  type: {},
  echo: {},
  printf: { denied: /^-[A-Za-z]*v/ },
  true: {},
  false: {},
  uname: {},
  whoami: {},
  id: {},
  grep: { glob: true },
  egrep: { glob: true },
  fgrep: { glob: true },
  rg: { denied: /^--(pre|hostname-bin)/ },
  find: { denied: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/ },
  fd: { denied: /^-[A-Za-z]*[xX]|^--exec/ },
  sort: { denied: /^-[A-Za-z]*o|^--(output|compress-program)/ },
  cut: {},
  tr: {},
  nl: { glob: true },
  paste: {},
  column: {},
  fold: {},
  rev: {},
  tac: {},
  expand: {},
  unexpand: {},
  basename: {},
  dirname: {},
  realpath: { glob: true },
  readlink: { glob: true },
  cmp: { glob: true },
  comm: {},
  diff: { glob: true },
  sha1sum: { glob: true },
  sha256sum: { glob: true },
  sha512sum: { glob: true },
  shasum: { glob: true },
  md5: { glob: true },
  md5sum: { glob: true },
  cksum: { glob: true },
  od: { glob: true },
  hexdump: { glob: true },
  strings: { glob: true },
  jq: { denied: /\benv\b|\$ENV/ },
  seq: {},
  ps: { denied: /^-?[A-Za-z]*[eE]/ },
  pgrep: {},
  lsof: {},
};

/** Tools whose `--version` runs without asking. */
const VERSION_COMMANDS = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "ruby",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "git",
  "gcc",
  "clang",
  "make",
  "cmake",
  "swift",
  "tsc",
  "vp",
  "gh",
  "bob",
  "jq",
  "rg",
  "tmux",
  "docker",
]);

/** Git's subcommands that only read. */
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "cat-file",
  "ls-tree",
  "merge-base",
  "grep",
  "rev-list",
  "whatchanged",
]);
/** Git flags that write a file, run a program or open a pager on files. */
const GIT_DENIED_FLAGS = /^(--output|--ext-diff|--open-files-in-pager|--exec|-[A-Za-z]*O)/;

/** Words that make a package manager install, publish, or fetch and run a package. */
const PACKAGE_INSTALL =
  /^(--)?(install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|update|upgrade|up|publish|link|dlx|exec|x|login|logout|adduser|remove|uninstall|get|sync|fetch|restore|require|resolve|lock)$/;

const GH_READS = new Set(["view", "list", "status", "checks", "diff"]);
/** A sed script that only prints lines by number or by a pattern, such as `1,40p` or `/re/p`. */
const SED_PRINT = /^(\d+|\$|\/[^/\\]+\/)(,(\d+|\$|\/[^/\\]+\/))?p$/;
/** A sed script that substitutes once per line, with no flag that writes (`w`) or runs (`e`). */
const SED_SUBSTITUTE = /^s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/[gIip0-9]*$/;

/**
 * What sed is asked to do: one script, whether it edits in place, and the files. None when the
 * script hides in a file, there is more than one, or a flag is not one of the plain ones.
 */
function sedCommand(texts: ReadonlyArray<string>):
  | {
      readonly script: string;
      readonly inPlace: boolean;
      readonly quiet: boolean;
      readonly files: ReadonlyArray<string>;
    }
  | undefined {
  const scripts: Array<string> = [];
  const rest: Array<string> = [];
  let inPlace = false;
  let quiet = false;
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index]!;
    if (text === "-e" || text === "--expression") {
      scripts.push(texts[(index += 1)] ?? "");
    } else if (text.startsWith("--expression=")) {
      scripts.push(text.slice("--expression=".length));
    } else if (text === "-i" || text === "-I") {
      inPlace = true;
      // BSD sed takes the backup extension as the next word, often an empty one.
      const next = texts[index + 1];
      if (next !== undefined && (next === "" || next.startsWith("."))) index += 1;
    } else if (/^-[iI]./.test(text) || text.startsWith("--in-place")) {
      inPlace = true;
    } else if (/^-[nEr]+$/.test(text) || text === "--quiet" || text === "--silent") {
      quiet ||= text.includes("n") || text === "--quiet" || text === "--silent";
    } else if (text.startsWith("-") && text !== "-") {
      return undefined;
    } else {
      rest.push(text);
    }
  }
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!);
  return scripts.length === 1 ? { script: scripts[0]!, inPlace, quiet, files: rest } : undefined;
}

/**
 * Whether a glob can only match visible names in the workspace: the folder before its first
 * glob lies in the workspace, and no globbed part starts with `.` or `[`, which could match a
 * hidden name such as `.env`.
 */
function globStaysInWorkspace(places: Places, word: string, base: string): boolean {
  const value = /^--?[^=]+=(.*)$/.exec(word)?.[1] ?? word;
  const segments = segmentsOf(value);
  const first = segments.findIndex((segment) => GLOB_CHARACTER.test(segment));
  if (first < 0 || segments.slice(first).some((segment) => /^[.[]/.test(segment))) return false;
  const folder = segments.slice(0, first).join("/");
  const absolute = places.absolute(
    value.startsWith("/") ? `/${folder}` : folder === "" ? "." : folder,
    base,
  );
  return absolute !== undefined && places.inWorkspace(absolute) !== undefined;
}

/** The words of a command that are not flags. */
function operands(words: ReadonlyArray<Word>): ReadonlyArray<string> {
  return words.map((word) => word.text).filter((text) => !text.startsWith("-"));
}

/** The words a file command writes to: its operands and the values of its flags. */
function writeTargets(words: ReadonlyArray<Word>): ReadonlyArray<string> {
  return words.flatMap((word) => {
    if (!word.text.startsWith("-")) return [word.text];
    const value = /^--?[^=]+=(.+)$/.exec(word.text)?.[1];
    return value === undefined ? [] : [value];
  });
}

/** Every word and flag value of a command, any of which may be a path. */
function pathLikeWords(words: ReadonlyArray<Word>): ReadonlyArray<string> {
  return words.map((word) => /^--?[^=]+=(.*)$/.exec(word.text)?.[1] ?? word.text);
}

function reviewSimpleCommand(places: Places, command: SimpleCommand, base: string): BobAutoReview {
  const [name, ...args] = command.words;
  const program = name!.text;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return ask("sets environment variables");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program)) return ask(`runs ${program}`);
  // Listing names, without descending, reads no secret held below a folder.
  const shallow =
    program === "ls" && !args.some((word) => /^(-[A-Za-z]*R|--recursive)/.test(word.text));
  if (pathLikeWords(args).some((word) => places.namesSecret(word, base, shallow))) {
    return ask("touches secrets or settings");
  }
  // `git show HEAD:.env` reads a file by its path in the repository, and a pathspec with magic
  // or a glob can match one without naming it.
  if (
    program === "git" &&
    operands(args).some((text) => {
      const path = /^[^:\s]*:(.+)$/.exec(text)?.[1];
      return (
        text.startsWith(":") ||
        GLOB_CHARACTER.test(text) ||
        (path !== undefined && namesSecret(path))
      );
    })
  ) {
    return ask("reads from the repository by a path the rules cannot check");
  }

  if (args.length === 1 && args[0]!.text === "--version" && VERSION_COMMANDS.has(program)) {
    return allow("prints a version");
  }
  const glob = args.find((word) => word.globbed && !globStaysInWorkspace(places, word.text, base));
  if (glob !== undefined) return ask("expands a glob that may reach hidden files or secrets");
  const readOnly = READ_ONLY_COMMANDS[program];
  // A read with no folder named reads the one it runs in, which `cd` may have moved.
  if (readOnly && places.namesSecret(".", base, shallow)) {
    return ask("reads from a folder that holds secrets or the home folder");
  }
  if (readOnly) {
    if (args.some((word) => word.globbed) && !readOnly.glob) {
      return ask(`expands a glob into ${program}'s flags`);
    }
    const denied = readOnly.denied;
    if (denied && args.some((word) => denied.test(word.text))) {
      return ask(`runs ${program} with a flag that writes, runs a program or shows secrets`);
    }
    return allow("only reads");
  }
  if (args.some((word) => word.globbed)) return ask(`expands a glob into ${program}'s arguments`);
  const texts = args.map((word) => word.text);

  switch (program) {
    case "uniq":
      // A second operand is the file uniq writes.
      return operands(args).length <= 1 ? allow("only reads") : ask("uniq writes its output");
    case "hostname":
    case "date":
      return args.length === 0 ? allow("only reads") : ask(`may change the ${program}`);
    case "sed": {
      const sed = sedCommand(texts);
      if (sed === undefined) return ask("runs a sed script it cannot read");
      if (!sed.inPlace) {
        return (sed.quiet && SED_PRINT.test(sed.script)) || SED_SUBSTITUTE.test(sed.script)
          ? allow("prints lines")
          : ask("runs a sed script that may write or run something");
      }
      return SED_SUBSTITUTE.test(sed.script)
        ? reviewWrites(places, sed.files, base, "edits", "edits files with sed")
        : ask("edits files with a sed script that may write or run something");
    }
    case "awk":
      // An awk program can write files and run commands; reading one is not worth the risk.
      return ask("runs an awk program");
    case "git":
      return reviewGit(args);
    case "gh":
      return ["pr", "issue", "run", "repo"].includes(texts[0] ?? "") &&
        GH_READS.has(texts[1] ?? "") &&
        !texts.some((text) => /^(-[A-Za-z]*w[A-Za-z]*|--web(=.*)?)$/.test(text))
        ? review("reads from GitHub")
        : ask("acts on GitHub");
    case "mkdir":
    case "touch":
    case "cp":
    case "mv":
    case "ln":
      // Flags that take a folder or a suffix, such as -t, write where the rules cannot see.
      if (texts.some((text) => text.startsWith("-") && !/^-[pfnrRvisaL]+$/.test(text))) {
        return ask(`runs ${program} with flags the rules cannot place`);
      }
      return reviewWrites(
        places,
        writeTargets(args),
        base,
        "writes",
        `${program} in the workspace`,
      );
    case "chmod": {
      const [mode, ...paths] = writeTargets(args);
      return /^[ugoa]*\+x$/.test(mode ?? "")
        ? reviewWrites(places, paths, base, "makes executable", "makes a workspace file executable")
        : ask("changes permissions");
    }
  }
  return ask(`runs ${program}`);
}

/**
 * Git commands that only read run; every git write asks, since a commit or a branch is history
 * the user owns and Apple's model allowed commits nobody asked for in trials.
 */
function reviewGit(args: ReadonlyArray<Word>): BobAutoReview {
  const texts = args.map((word) => word.text);
  let index = 0;
  while (texts[index] === "--no-pager") index += 1;
  const subcommand = texts[index];
  const rest = texts.slice(index + 1);
  if (subcommand === undefined || subcommand.startsWith("-")) return ask("runs git with options");
  if (rest.some((text) => GIT_DENIED_FLAGS.test(text))) {
    return ask("runs git with a flag that writes or runs a program");
  }
  if (GIT_READS.has(subcommand)) return allow("reads the repository");
  const only = (flags: RegExp) => rest.every((text) => flags.test(text));
  const lists =
    (subcommand === "branch" &&
      only(/^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--merged|--no-merged)$/)) ||
    (subcommand === "tag" && only(/^(-l|--list|-n\d*)$/)) ||
    (subcommand === "remote" && only(/^(-v|--verbose)$/)) ||
    (subcommand === "stash" && ["list", "show"].includes(rest[0] ?? "")) ||
    (subcommand === "worktree" && rest[0] === "list") ||
    (subcommand === "reflog" && (rest.length === 0 || rest[0] === "show"));
  return lists ? allow("reads the repository") : ask(`runs git ${subcommand}`);
}

/** Reviews a command Bob runs from `cwd`, or from the workspace when Bob gives none. */
export function reviewBobCommand(
  command: string,
  cwd: string | undefined,
  context: BobAutoReviewContext,
): BobAutoReview {
  const places = new Places(context);
  if (command.length > 2_000) return ask("a command too long to review");
  const tokens = tokenize(command);
  const commands = tokens ? simpleCommands(tokens) : undefined;
  if (!commands) return ask("a command the rules cannot read with certainty");
  const start = cwd ?? places.workspace;
  if (start === undefined || !NodePath.isAbsolute(start)) return ask("no folder to run in");
  let base = start;
  const reviews: Array<BobAutoReview> = [];
  for (const simple of commands) {
    if (simple.words[0]!.text !== "cd") {
      reviews.push(reviewSimpleCommand(places, simple, base));
      continue;
    }
    const target = simple.words[1];
    const next: string | undefined =
      simple.piped ||
      simple.words.length !== 2 ||
      !target ||
      target.globbed ||
      target.text.startsWith("-")
        ? undefined
        : places.absolute(target.text, base);
    if (next === undefined) return ask("changes folder in a way the rules cannot follow");
    // Reading from another folder is as safe as reading it by its path; what runs or writes
    // there still has to be in the workspace.
    if (places.namesSecret(target!.text, base, true)) return ask("changes to a folder of secrets");
    base = next;
  }
  return reviews.length === 0 ? ask("only changes folder") : strictest(reviews);
}

// --- Commands in the sandbox ------------------------------------------------------------------

/**
 * Programs that need more than the sandbox gives, the network, the machine or the user's other
 * processes, or that delete work, and so ask: the user can let them run outside it.
 */
const OUTSIDE_SANDBOX = new Set([
  "sudo",
  "su",
  "doas",
  "kill",
  "pkill",
  "killall",
  "open",
  "osascript",
  "launchctl",
  "defaults",
  "crontab",
  "systemctl",
  "service",
  "shutdown",
  "reboot",
  "halt",
  "diskutil",
  "mount",
  "umount",
  "security",
  "chown",
  "chflags",
  "xattr",
  "tmux",
  "screen",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "ping",
  "dig",
  "nslookup",
  "host",
  "whois",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "heroku",
  "vercel",
  "netlify",
  "fly",
  "flyctl",
  "npx",
  "bunx",
  "pnpx",
  "brew",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "port",
  "snap",
  "pip",
  "pip3",
  "pipx",
  "gem",
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "trash",
  "eval",
  "xargs",
  "exec",
]);
const PACKAGE_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "vp",
  "uv",
  "poetry",
  "cargo",
  "go",
  "bundle",
  "composer",
  "mix",
  "dotnet",
  "swift",
  "deno",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Commands that only run the one after them, whose own leading words are options or numbers. */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "timeout",
  "command",
  "builtin",
  "caffeinate",
  "arch",
  "stdbuf",
  "setsid",
]);
/** Wrapper flags that take the next word as their value. */
const WRAPPER_VALUE_FLAGS = /^-(u|C|S|s|k|i|o|e|n)$/;
/** Package managers that install the project's dependencies when run with no command. */
const BARE_INSTALLERS = new Set(["yarn", "pnpm", "bun"]);

function reviewSandboxedCommand(
  places: Places,
  words: ReadonlyArray<Word>,
  base: string,
  depth: number,
): BobAutoReview {
  let index = 0;
  // `FOO=1 npm test`: what the variables change, the sandbox bounds.
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.text)) index += 1;
  const name = words[index];
  if (name === undefined) return allow("sets variables");
  const args = words.slice(index + 1);
  const texts = args.map((word) => word.text);
  const program = NodePath.basename(name.text);
  if (pathLikeWords(args).some((word) => places.namesSecret(word, base))) {
    return ask("touches secrets or settings");
  }
  if (WRAPPERS.has(program)) {
    // Whatever the wrapper runs, a command that needs more than the sandbox asks.
    if (args.some((word) => OUTSIDE_SANDBOX.has(NodePath.basename(word.text)))) {
      return ask(`runs ${program} around a command that needs more than the sandbox`);
    }
    let rest = -1;
    for (let index = 0; index < args.length; index += 1) {
      const text = args[index]!.text;
      if (WRAPPER_VALUE_FLAGS.test(text)) {
        index += 1;
        continue;
      }
      if (text.startsWith("-") || /^[\d.]+[smhd]?$/.test(text) || text.includes("=")) continue;
      rest = index;
      break;
    }
    return rest < 0 || depth > 3
      ? ask(`runs ${program} in a way the rules cannot follow`)
      : reviewSandboxedCommand(places, args.slice(rest), base, depth + 1);
  }
  if (OUTSIDE_SANDBOX.has(program))
    return ask(`runs ${program}, which needs more than the sandbox`);
  if (SHELLS.has(program)) {
    const inline = texts.indexOf("-c");
    if (inline < 0) return allow("runs a script in the sandbox");
    const script = texts[inline + 1];
    return script === undefined || depth > 3
      ? ask(`runs ${program} in a way the rules cannot follow`)
      : reviewSandboxedLine(places, script, base, depth + 1);
  }
  if (program === "find" && texts.some((text) => /^-(exec|execdir|ok|okdir|delete)$/.test(text))) {
    return ask("runs find with an action that may delete files");
  }
  if (program === "git") {
    const git = reviewGit(args);
    return git.verdict === "allow" ? allow("reads the repository in the sandbox") : git;
  }
  if (program === "gh") {
    return ["pr", "issue", "run", "repo"].includes(texts[0] ?? "") &&
      GH_READS.has(texts[1] ?? "") &&
      !texts.some((text) => /^(-[A-Za-z]*w[A-Za-z]*|--web(=.*)?)$/.test(text))
      ? review("reads from GitHub, outside the sandbox")
      : ask("acts on GitHub");
  }
  if (
    PACKAGE_MANAGERS.has(program) &&
    (texts.some((text) => PACKAGE_INSTALL.test(text)) ||
      (BARE_INSTALLERS.has(program) && operands(args).length === 0))
  ) {
    return ask(`installs or fetches packages with ${program}`);
  }
  return allow("runs in the sandbox");
}

function reviewSandboxedLine(
  places: Places,
  command: string,
  start: string,
  depth: number,
): BobAutoReview {
  if (command.length > 2_000) return ask("a command too long to review");
  const tokens = tokenize(command);
  const commands = tokens ? simpleCommands(tokens) : undefined;
  if (!commands) return ask("a command the rules cannot read with certainty");
  let base = start;
  const reviews: Array<BobAutoReview> = [];
  for (const simple of commands) {
    if (simple.words[0]!.text !== "cd") {
      reviews.push(reviewSandboxedCommand(places, simple.words, base, depth));
      continue;
    }
    const target = simple.words[1];
    const next =
      simple.words.length !== 2 || !target || target.globbed || target.text.startsWith("-")
        ? undefined
        : places.absolute(target.text, base);
    if (next === undefined) return ask("changes folder in a way the rules cannot follow");
    if (places.namesSecret(target!.text, base, true)) return ask("changes to a folder of secrets");
    base = next;
  }
  return strictest(reviews);
}

/**
 * Reviews a command Bob runs in the sandbox, where it writes only in the workspace and reaches no
 * network. What needs more asks, so the user can let it run outside, and so do deleting files and
 * anything the rules cannot read; the rest runs, bounded by the sandbox. A GitHub read is left
 * to review, since it needs the network.
 */
export function reviewBobCommandInSandbox(
  command: string,
  cwd: string | undefined,
  context: BobAutoReviewContext,
): BobAutoReview {
  const places = new Places(context);
  const start = cwd ?? places.workspace;
  if (start === undefined || !NodePath.isAbsolute(start)) return ask("no folder to run in");
  return reviewSandboxedLine(places, command, start, 0);
}

// --- Tool calls -------------------------------------------------------------------------------

// Bob's own tools by the title it gives them and the input they take. Bob words titles in its
// language, so in another one these ask.
const BOB_TODO_TITLE = "Updating todo list";
const BOB_SUBAGENT_TITLE = "Running subagent: ";
const BOB_WEB_SEARCH_TITLE = "Searching the web";
const BOB_WEB_FETCH_TITLE = "Fetching ";
const BOB_SKILL_TITLE = "Using skill ";

/** The files an edit writes: the diffs Bob previews and the paths in its input. */
function editPaths(toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"]): Array<string> {
  const paths: Array<string> = [];
  for (const content of toolCall.content ?? []) {
    if (content.type === "diff" && "path" in content) paths.push(content.path);
  }
  const input = record(toolCall.rawInput) ?? {};
  for (const key of ["path", "file", "filePath", "uri"]) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (!value.startsWith("file://")) {
      paths.push(value);
      continue;
    }
    try {
      paths.push(decodeURIComponent(new URL(value).pathname));
    } catch {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Whether text is plain enough to show the reviewer and to send out: one line, not too long,
 * and without a run of letters and digits like a key or a token.
 */
function plainText(text: string, limit: number): boolean {
  return (
    text.length <= limit &&
    ![...text].some((character) => character < " " || character === "\u007f") &&
    !(text.match(/[A-Za-z0-9+=_]{20,}/g) ?? []).some(
      (run) => /\d/.test(run) && /[A-Za-z]/.test(run),
    )
  );
}

/**
 * Whether a URL is a public web page: http or https, no credentials, a named public host rather
 * than an IP address or a local, private or cloud metadata name, and nothing token-like in it.
 */
function publicPage(value: string): boolean {
  if (!plainText(value, 300)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // `localhost.` is localhost, and names such as 127.0.0.1.nip.io resolve to the address in them.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".");
  return (
    /^https?:$/.test(url.protocol) &&
    url.username === "" &&
    url.password === "" &&
    labels.length > 1 &&
    !/^[\d.]+$/.test(host) &&
    !host.startsWith("0x") &&
    !host.startsWith("[") &&
    !labels.includes("localhost") &&
    !/(^|[.-])\d{1,3}([.-]\d{1,3}){3}([.-]|$)/.test(host) &&
    !/\.(local|localdomain|internal|lan|home|corp|intranet|arpa)$/.test(host) &&
    !/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|traefik\.me)$/.test(host) &&
    plainText(decodeURIComponentSafe(`${url.pathname}${url.search}${url.hash}`), 300)
  );
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The permission modes T3 answers Bob's requests in; in Full access Bob approves its own. */
export type BobPermissionMode = "approval-required" | "auto-accept-edits" | "auto";

/**
 * Reviews a tool call Bob asks permission for, as the thread's permission mode answers it.
 * With `sandboxed`, Bob's commands run in the sandbox: read-only in Supervised, the workspace in
 * Accept edits and Auto. Supervised runs commands that only read; Accept edits and Auto run any
 * command the sandbox bounds and edits in the workspace; Auto also leaves web searches, fetches,
 * skills and GitHub reads to its reviewer. Everything else asks.
 */
export function reviewBobPermission(
  toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"],
  input: {
    readonly mode: BobPermissionMode;
    readonly sandboxed: boolean;
    readonly context: BobAutoReviewContext;
  },
): BobAutoReview {
  const { mode, sandboxed, context } = input;
  const raw = record(toolCall.rawInput) ?? {};
  const title = (toolCall.title ?? "").trim();
  const reviewed = (result: BobAutoReview) =>
    result.verdict === "review" && mode !== "auto" ? ask(result.reason) : result;
  switch (toolCall.kind ?? "other") {
    case "execute": {
      const { command, cwd } = raw;
      if (typeof command !== "string" || (cwd !== undefined && typeof cwd !== "string")) {
        return ask("a command without a readable command line");
      }
      // A server or a watcher outlives the turn, and the sandbox would cut its network off.
      if (raw.background === true) return ask("runs a command in the background");
      if (!sandboxed)
        return mode === "auto" ? reviewBobCommand(command, cwd, context) : ask("runs a command");
      if (mode === "approval-required") {
        const read = reviewBobCommand(command, cwd, context);
        return read.verdict === "allow"
          ? allow(`${read.reason}, in a read-only sandbox`)
          : ask(read.reason);
      }
      return reviewed(reviewBobCommandInSandbox(command, cwd, context));
    }
    case "edit":
    case "delete":
    case "move": {
      if (mode === "approval-required") return ask("an edit");
      const places = new Places(context);
      if (places.workspace === undefined) return ask("an edit without a workspace");
      const paths = editPaths(toolCall);
      if (paths.length === 0) return ask("an edit the rules cannot place");
      return strictest(paths.map((path) => reviewWrite(places, path, places.workspace!, "edits")));
    }
    case "search":
      if (!title.startsWith(BOB_WEB_SEARCH_TITLE) || !onlyKeys(raw, ["query", "max_results"])) {
        return ask("a tool Bob counts as a search");
      }
      return typeof raw.query === "string" && plainText(raw.query, 200)
        ? reviewed(review(`searches the web for ${JSON.stringify(raw.query)}`))
        : ask("searches the web for text that may carry a secret");
    case "fetch":
      if (!title.startsWith(BOB_WEB_FETCH_TITLE) || !onlyKeys(raw, ["url", "format", "timeout"])) {
        return ask("a tool Bob counts as a fetch");
      }
      return typeof raw.url === "string" && publicPage(raw.url)
        ? reviewed(review(`fetches ${raw.url}`))
        : ask("fetches a local or private address, or a URL that may carry a secret");
    case "other":
      if (title === BOB_TODO_TITLE && onlyKeys(raw, ["todos"])) {
        return allow("updates Bob's todo list");
      }
      if (
        title.startsWith(BOB_SUBAGENT_TITLE) &&
        typeof raw.description === "string" &&
        onlyKeys(raw, ["description", "name", "fork_context"])
      ) {
        return allow("starts a subagent, whose tool calls are reviewed in turn");
      }
      if (
        title.startsWith(BOB_SKILL_TITLE) &&
        onlyKeys(raw, ["skill_name"]) &&
        typeof raw.skill_name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.skill_name)
      ) {
        return reviewed(review(`loads the skill ${JSON.stringify(raw.skill_name)}`));
      }
      return ask("a tool the rules do not know");
    default:
      return ask("a tool the rules do not know");
  }
}

/**
 * What a tool call the rules leave to review does, for the reviewer that judges it, on one line
 * with the call's own text quoted, so it reads as data.
 */
export function describeBobToolCall(
  toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"],
  context: BobAutoReviewContext,
): string {
  const input = record(toolCall.rawInput) ?? {};
  const quoted = (value: unknown) => JSON.stringify(String(value));
  switch (toolCall.kind) {
    case "execute": {
      const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
      const where =
        cwd === undefined || cwd === context.workspace
          ? "in the project folder"
          : `in ${quoted(cwd)}`;
      return `runs a command ${where}: ${quoted(input.command)}`;
    }
    case "search":
      return `searches the web for ${quoted(input.query)}`;
    case "fetch":
      return `fetches ${quoted(input.url)}`;
    default:
      return typeof input.skill_name === "string"
        ? `loads the skill ${quoted(input.skill_name)}`
        : quoted(toolCall.title ?? "a tool call");
  }
}
