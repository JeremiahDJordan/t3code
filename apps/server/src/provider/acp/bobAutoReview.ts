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
   * and as resolved both count, and so does the home folder or any folder above it, which hold
   * `~/.ssh` and the like for a recursive read.
   */
  namesSecret(word: string, base: string): boolean {
    const absolute = this.absolute(word, base);
    if (absolute === undefined) return namesSecret(word);
    const relative = this.inWorkspace(absolute);
    if (relative !== undefined) return namesSecret(relative);
    const resolved = canonicalPath(absolute) ?? absolute;
    const toHome = NodePath.relative(resolved, this.realHome);
    const holdsHome =
      toHome === "" ||
      (toHome !== ".." && !toHome.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(toHome));
    return holdsHome || namesSecret(word) || namesSecret(resolved);
  }
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

/** Package scripts, tests, builds and linters: the project's own code, run as its own. */
const PROJECT_RUNNERS: Record<string, ReadonlySet<string> | "any"> = {
  npm: new Set(["test", "t", "run", "run-script", "start"]),
  pnpm: new Set([
    "test",
    "t",
    "run",
    "build",
    "lint",
    "typecheck",
    "check",
    "format",
    "dev",
    "start",
  ]),
  yarn: new Set(["test", "run", "build", "lint", "typecheck", "check", "format", "dev", "start"]),
  bun: new Set(["test", "run"]),
  vp: new Set(["test", "run", "check", "lint", "fmt", "build", "typecheck", "dev"]),
  go: new Set(["test", "build", "vet", "run", "fmt"]),
  cargo: new Set(["test", "build", "check", "clippy", "run", "fmt", "bench", "doc"]),
  swift: new Set(["build", "test", "run"]),
  dotnet: new Set(["build", "test", "run"]),
  mvn: new Set(["test", "compile", "package", "verify"]),
  gradle: new Set(["test", "build", "check", "assemble"]),
  make: "any",
  cmake: "any",
  xcodebuild: "any",
  pytest: "any",
  mypy: "any",
  ruff: "any",
  black: "any",
  flake8: "any",
  pylint: "any",
  eslint: "any",
  prettier: "any",
  tsc: "any",
  jest: "any",
  vitest: "any",
  biome: "any",
  oxlint: "any",
  rspec: "any",
  rake: "any",
};
/** Words that make a project runner install, publish or fetch and run a package. */
const PACKAGE_INSTALL = /^(--)?(install|i|add|ci|publish|exec|x|dlx|link|update|upgrade)$/;
const PYTHON_MODULES = new Set(["pytest", "unittest", "mypy", "ruff", "black", "py_compile"]);
const SCRIPT_RUNNERS = new Set([
  "node",
  "python",
  "python3",
  "tsx",
  "ts-node",
  "bash",
  "sh",
  "zsh",
]);
const GH_READS = new Set(["view", "list", "status", "checks", "diff"]);
/** A sed script that only prints lines by number or by a pattern, such as `1,40p` or `/re/p`. */
const SED_PRINT = /^(\d+|\$|\/[^/\\]+\/)(,(\d+|\$|\/[^/\\]+\/))?p$/;

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

/** Every word and flag value of a command, any of which may be a path. */
function pathLikeWords(words: ReadonlyArray<Word>): ReadonlyArray<string> {
  return words.map((word) => /^--?[^=]+=(.*)$/.exec(word.text)?.[1] ?? word.text);
}

/**
 * A command that runs the project's code, left to review when it runs in the workspace and every
 * argument that may be a path, such as `make -C ..` or `--prefix`, stays inside it.
 */
function requireWorkspace(
  places: Places,
  base: string,
  args: ReadonlyArray<Word>,
  reason: string,
): BobAutoReview {
  const outside = pathLikeWords(args).some((word) => {
    if (!word.includes("/") && !word.startsWith("~") && word !== "..") return false;
    const absolute = places.absolute(word, base);
    return absolute === undefined || places.inWorkspace(absolute) === undefined;
  });
  return places.inWorkspace(base) === undefined || outside
    ? ask(`${reason} outside the workspace`)
    : review(reason);
}

function reviewSimpleCommand(places: Places, command: SimpleCommand, base: string): BobAutoReview {
  const [name, ...args] = command.words;
  const program = name!.text;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return ask("sets environment variables");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program)) return ask(`runs ${program}`);
  if (pathLikeWords(args).some((word) => places.namesSecret(word, base))) {
    return ask("touches secrets or settings");
  }
  if (args.length === 1 && args[0]!.text === "--version" && VERSION_COMMANDS.has(program)) {
    return allow("prints a version");
  }
  const glob = args.find((word) => word.globbed && !globStaysInWorkspace(places, word.text, base));
  if (glob !== undefined) return ask("expands a glob that may reach hidden files or secrets");
  const readOnly = READ_ONLY_COMMANDS[program];
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
      if (texts.some((text) => /^(-[A-Za-z]*i|--in-place)/.test(text))) {
        return reviewWrites(places, operands(args).slice(1), base, "edits", "edits files with sed");
      }
      // `sed -n 'N,Mp'` prints lines; another script may write (`w`) or run (`e`) something.
      const script = operands(args)[0] ?? "";
      return texts.includes("-n") && SED_PRINT.test(script)
        ? allow("prints lines")
        : review("runs a sed script");
    }
    case "awk":
      return review("runs an awk program");
    case "git":
      return reviewGit(places, args, base);
    case "gh":
      return ["pr", "issue", "run", "repo"].includes(texts[0] ?? "") && GH_READS.has(texts[1] ?? "")
        ? review("reads from GitHub")
        : ask("acts on GitHub");
    case "mkdir":
    case "touch":
    case "cp":
    case "mv":
    case "ln":
      return reviewWrites(places, operands(args), base, "writes", `${program} in the workspace`);
    case "chmod": {
      const [mode, ...paths] = operands(args);
      return /^[ugoa]*\+x$/.test(mode ?? "")
        ? reviewWrites(places, paths, base, "makes executable", "makes a workspace file executable")
        : ask("changes permissions");
    }
    case "python":
    case "python3":
      if (texts[0] === "-m" && PYTHON_MODULES.has(texts[1] ?? "")) {
        return requireWorkspace(places, base, args, `runs python -m ${texts[1]}`);
      }
      break;
  }
  const runner = PROJECT_RUNNERS[program];
  if (runner === "any" || (runner !== undefined && runner.has(texts[0] ?? ""))) {
    if (texts.some((text) => PACKAGE_INSTALL.test(text))) {
      return ask(`installs or runs packages with ${program}`);
    }
    return requireWorkspace(
      places,
      base,
      args,
      `runs the project's ${[program, ...texts.slice(0, 2)].join(" ")}`,
    );
  }
  if (SCRIPT_RUNNERS.has(program)) {
    const script = texts[0];
    if (script === undefined || script.startsWith("-")) return ask(`runs ${program} inline code`);
    const file = reviewWrite(places, script, base, "runs");
    return file.verdict === "allow"
      ? requireWorkspace(places, base, args, `runs ${script} from the workspace`)
      : file;
  }
  return ask(`runs ${program}`);
}

function reviewGit(places: Places, args: ReadonlyArray<Word>, base: string): BobAutoReview {
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
  switch (subcommand) {
    case "branch":
      if (only(/^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--merged|--no-merged)$/)) {
        return allow("lists branches");
      }
      return rest.length === 1 && !rest[0]!.startsWith("-")
        ? requireWorkspace(places, base, args, "creates a branch")
        : ask("changes branches");
    case "tag":
      return only(/^(-l|--list|-n\d*)$/) ? allow("lists tags") : ask("changes tags");
    case "remote":
      return only(/^(-v|--verbose)$/) ? allow("lists remotes") : ask("changes remotes");
    case "stash":
      if (rest[0] === "list" || rest[0] === "show") return allow("reads the stash");
      return rest.length === 0 || ["push", "pop", "apply"].includes(rest[0]!)
        ? requireWorkspace(places, base, args, "stashes changes")
        : ask("drops stashed changes");
    case "worktree":
      return rest[0] === "list" ? allow("lists worktrees") : ask("changes worktrees");
    case "reflog":
      return rest.length === 0 || rest[0] === "show"
        ? allow("reads the reflog")
        : ask("changes the reflog");
    case "add":
    case "commit":
      return requireWorkspace(places, base, args, `runs git ${subcommand}`);
    case "switch":
      return rest.some((text) => /^(--discard-changes|-f|--force|-C)$/.test(text))
        ? ask("switches branches, discarding changes")
        : requireWorkspace(places, base, args, "switches branches");
    case "checkout":
      return rest[0] === "-b" && rest.length === 2
        ? requireWorkspace(places, base, args, "creates a branch")
        : ask("checks out, which can discard changes");
    default:
      return ask(`runs git ${subcommand}`);
  }
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
    if (places.namesSecret(target!.text, base)) return ask("changes to a folder of secrets");
    base = next;
  }
  return reviews.length === 0 ? ask("only changes folder") : strictest(reviews);
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

/** Reviews a tool call Bob asks permission for, in Auto. */
export function reviewBobToolCall(
  toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"],
  context: BobAutoReviewContext,
): BobAutoReview {
  const input = record(toolCall.rawInput) ?? {};
  const title = (toolCall.title ?? "").trim();
  switch (toolCall.kind ?? "other") {
    case "execute": {
      const { command, cwd } = input;
      if (typeof command !== "string" || (cwd !== undefined && typeof cwd !== "string")) {
        return ask("a command without a readable command line");
      }
      return reviewBobCommand(command, cwd, context);
    }
    case "edit":
    case "delete":
    case "move": {
      const places = new Places(context);
      if (places.workspace === undefined) return ask("an edit without a workspace");
      const paths = editPaths(toolCall);
      if (paths.length === 0) return ask("an edit the rules cannot place");
      return strictest(paths.map((path) => reviewWrite(places, path, places.workspace!, "edits")));
    }
    case "search":
      return title.startsWith(BOB_WEB_SEARCH_TITLE) && onlyKeys(input, ["query", "max_results"])
        ? review(`searches the web for ${JSON.stringify(input.query)}`)
        : ask("a tool Bob counts as a search");
    case "fetch":
      return title.startsWith(BOB_WEB_FETCH_TITLE) &&
        onlyKeys(input, ["url", "format", "timeout"]) &&
        typeof input.url === "string" &&
        /^https?:\/\//i.test(input.url)
        ? review(`fetches ${input.url}`)
        : ask("a tool Bob counts as a fetch");
    case "other":
      if (title === BOB_TODO_TITLE && onlyKeys(input, ["todos"])) {
        return allow("updates Bob's todo list");
      }
      if (
        title.startsWith(BOB_SUBAGENT_TITLE) &&
        typeof input.description === "string" &&
        onlyKeys(input, ["description", "name", "fork_context"])
      ) {
        return allow("starts a subagent, whose tool calls are reviewed in turn");
      }
      if (title.startsWith(BOB_SKILL_TITLE) && onlyKeys(input, ["skill_name"])) {
        return review(`loads the skill ${JSON.stringify(input.skill_name)}`);
      }
      return ask("a tool the rules do not know");
    default:
      return ask("a tool the rules do not know");
  }
}
