#!/usr/bin/env node
// tool-call-stats.mjs: anonymized, aggregated statistics of the tool calls coding agents made on this machine, to help design
// rules that auto-approve safe calls. Each source is optional and read-only (transcripts are streamed, SQLite opens readOnly):
//   Claude Code  ~/.claude/projects/**/*.jsonl                               --claude-dir PATH
//   Codex        ~/.codex/sessions/**/*.jsonl and ~/.codex/archived_sessions  --codex-dir PATH
//   Bob Shell    ~/.bob/db/bob.db (dev-db when NODE_ENV=development)          --bob-db PATH
//   T3 Code V2   a statev2.sqlite, only when given (it overlaps the others)   --t3-db PATH
// Other flags: --since DAYS, --top N (default 15), --json. Node 22.5+ (node:sqlite) for the SQLite sources; no dependencies.
// Every printed key comes from a fixed vocabulary (well-known programs and subcommands, feature names, path classes); raw
// commands, arguments, paths, prompts, project names and usernames are never output.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const HOME = NodeOS.homedir(),
  TOP = Number(opt("--top") ?? 15);
const SINCE = opt("--since") ? Date.now() - Number(opt("--since")) * 864e5 : 0;
const tilde = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

// ---------------------------------------------------------------- vocabularies
// A token "git:status,log" stands for git:status and git:log.
const S = (s) =>
  new Set(
    s
      .trim()
      .split(/\s+/)
      .flatMap((t) => {
        const i = t.lastIndexOf(":");
        return i < 1
          ? [t]
          : t
              .slice(i + 1)
              .split(",")
              .map((x) => t.slice(0, i + 1) + x);
      }),
  );
const EMPTY = new Set(),
  vocab = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, S(v)]));
const PROGRAMS =
  S(`ls cat head tail less more wc sort uniq cut tr tee echo printf pwd cd pushd popd which whereis type command file stat du df find fd rg grep egrep
  fgrep ag ack sed awk gawk perl ruby python node deno bun tsx ts-node jq yq xargs diff cmp patch comm join paste column nl fold basename dirname realpath readlink
  touch mkdir rmdir rm mv cp ln chmod chown install tar zip unzip gzip gunzip xz curl wget ssh scp rsync sftp nc ping dig nslookup host whois openssl base64 shasum
  sha256sum md5 md5sum cksum date sleep true false test [ [[ env export set unset source . alias exit kill pkill killall pgrep ps top lsof ss netstat ifconfig uname
  whoami id hostname sw_vers sysctl open pbcopy pbpaste osascript defaults launchctl security codesign xcrun xcodebuild xcode-select swift swiftc clang gcc cc make
  cmake ninja bazel gradle mvn java javac rustc rustup cargo go gofmt npm npx pnpm pnpx yarn bunx vp vpr vite vitest jest pytest tox poetry pip uv uvx pipx ruff black
  mypy pyright tsc tsgo eslint prettier oxlint oxfmt biome git gh glab docker docker-compose podman kubectl helm terraform aws gcloud az vercel wrangler brew apt
  apt-get tmux screen code cursor vim vi nano man history clear seq yes time timeout nohup nice watch tree eza bat sqlite3 psql mysql redis-cli claude codex bob t3
  ollama hyperfine sips ffmpeg magick plutil mdfind mdls ditto hdiutil diskutil caffeinate log wait trap read printenv xxd od hexdump strings nm otool lipo dd truncate
  shred sudo doas su chflags xattr tailscale ngrok cloudflared expo eas adb pod watchman turbo nx esbuild playwright stdbuf exec eval builtin local declare iconv split
  bc expr nproc tput bash sh zsh dash fish csrutil spctl dscl pmset scutil networksetup tccutil lsregister`);
const SHELLS = S("bash sh zsh dash fish"),
  INTERP = S("node python ruby perl deno tsx ts-node"),
  PKG = S("npm pnpm yarn bun vp vpr"),
  RUNNERS = S("npx pnpx bunx uvx");
const WRAPPERS = S(
  "sudo doas env time nice nohup timeout command exec builtin stdbuf xargs caffeinate watch",
);
const KEYWORDS = S("if then else elif fi do done while until esac { } ! function"),
  PATTERN_PROGS = S("sed awk gawk perl grep egrep fgrep rg ag ack jq yq");
const SCRIPTS =
  "test build dev start lint typecheck check fmt format clean preview e2e coverage watch";
const WRAP_VALUE = vocab({
  sudo: "-u -g -C -h",
  env: "-u -C -S",
  nice: "-n",
  timeout: "-s -k",
  xargs: "-I -n -P -L -d -s -E -a",
  watch: "-n -d",
  caffeinate: "-t -w",
});
const VALUE_OPTS = vocab({
  git: "-C -c --git-dir --work-tree",
  docker: "--context -H -c -f --file -p --project-name",
  kubectl: "-n --namespace --context --kubeconfig",
  gh: "-R --repo",
  npm: "--prefix -w --workspace",
  pnpm: "-C --dir --filter -F",
  yarn: "--cwd",
  bun: "--cwd",
  vp: "--filter -F -C --dir",
  go: "-C",
  cargo: "--manifest-path -p --package",
  make: "-C -f -j",
  tmux: "-L -S -f",
  npx: "-p --package",
  uvx: "--from --with",
});
const PKG_SUBS = `install i ci add remove rm uninstall update up upgrade run run-script exec dlx x test t build start dev lint typecheck check fmt format publish pack
  link unlink ls list why outdated audit info view create init config version prune dedupe env`;
const SUBS = vocab({
  ...Object.fromEntries([...PKG].map((p) => [p, PKG_SUBS])),
  git: `status log diff show add commit push pull fetch clone checkout switch restore reset rebase merge cherry-pick revert branch tag stash rev-parse rev-list ls-files
  ls-tree ls-remote grep blame config remote worktree submodule init describe shortlog reflog cat-file show-ref symbolic-ref for-each-ref merge-base apply am
  format-patch clean rm mv bisect range-diff diff-tree name-rev check-ignore update-index gc fsck archive lfs notes count-objects sparse-checkout`,
  cargo:
    "build check test run clippy fmt doc add remove update install publish fetch tree new init bench clean metadata search",
  go: "build test run vet fmt mod get install generate env version list tool doc work clean",
  swift: "build test run package",
  docker:
    "ps images run exec build pull push logs compose stop start rm rmi inspect login system volume network cp kill restart tag version info buildx context",
  gh: "pr issue run repo api release workflow auth search gist browse label status cache secret variable project extension",
  kubectl:
    "get describe logs apply delete create edit exec port-forward rollout scale config top patch label cp run explain version",
  brew: "install uninstall upgrade update list info search services cleanup doctor tap outdated bundle reinstall link unlink config",
  pip: "install uninstall list show freeze download wheel check",
  uv: "run pip sync add remove lock venv tool init build publish python tree",
  tmux: `new-session new send-keys capture-pane kill-session kill-server kill-pane kill-window ls list-sessions list-windows list-panes attach attach-session
  has-session display-message split-window new-window select-pane resize-pane`,
  xcrun: "simctl xcodebuild swift devicectl xctrace notarytool stapler",
  make: "all build test lint check clean install dev run format fmt",
  security:
    "find-generic-password find-internet-password add-generic-password delete-generic-password dump-keychain list-keychains find-certificate",
  defaults: "read write delete domains export import",
  launchctl: "list load unload bootstrap bootout kickstart print start stop",
});
const SUB2 = vocab({
  ...Object.fromEntries(
    [...PKG].flatMap((p) => [
      [`${p} run`, SCRIPTS],
      [`${p} run-script`, SCRIPTS],
    ]),
  ),
  "git stash": "list show push pop apply drop clear save",
  "git worktree": "list add remove prune move",
  "git remote": "show add remove set-url get-url rename",
  "gh pr":
    "view list create checkout diff merge comment edit close review status checks ready reopen",
  "gh issue": "view list create comment edit close reopen",
  "gh run": "view list watch rerun cancel download",
  "gh repo": "view clone fork create list",
  "gh release": "view list create download upload",
  "gh workflow": "run list view",
  "gh auth": "status login token",
  "uv pip": "install list show freeze uninstall sync compile",
  "docker compose": "up down ps logs build exec run pull restart stop",
  "xcrun simctl": "list boot shutdown install launch terminate io openurl erase spawn",
});
const PY_MODS = {
  "json.tool": "read-only",
  "http.server": "exec-code",
  venv: "file-write",
  unittest: "build-test",
  py_compile: "build-test",
  compileall: "build-test",
  build: "build-test",
  twine: "network",
};

// Heuristic safety classes, mildest first. A shell call takes the most severe class of its simple commands.
// Writes split into git-write (git subcommands that change the repository) and file-write (file operations, redirects).
const SEV = [
  "read-only",
  "network-read",
  "build-test",
  "git-write",
  "file-write",
  "exec-code",
  "unknown",
  "network",
  "destructive",
  "privileged",
];
const pkgKeys = (subs, prefix = "") =>
  [...PKG].map((p) => `${p}:${prefix}${subs.replaceAll(" ", ",")}`).join(" ");
const CLASS_SETS = [
  // matched most-specific key first (prog:sub:sub2, then prog:sub, then prog)
  [
    "privileged",
    S(
      `sudo doas su security launchctl defaults:write,delete,import csrutil spctl chflags xattr diskutil dscl pmset scutil networksetup tccutil xcode-select`,
    ),
  ],
  [
    "destructive",
    S(`rm rmdir shred truncate dd kill pkill killall git:clean,rm git:stash:drop,clear git:worktree:remove,prune docker:rm,rmi,kill,system,volume
  kubectl:delete tmux:kill-session,kill-server,kill-pane,kill-window xcrun:simctl:erase launchctl:bootout,unload`),
  ],
  [
    "network",
    S(`wget ssh scp sftp rsync nc aws gcloud az vercel wrangler tailscale ngrok cloudflared ollama gh glab helm terraform kubectl npx pnpx bunx uvx expo eas pod
  git:clone,fetch,pull,push,submodule pip:install,download uv:pip,add,sync,lock,tool brew:install,update,upgrade,reinstall,tap,bundle go:get,install,mod
  cargo:install,add,update,fetch,publish,search docker:pull,push,login,build docker:compose:pull ${pkgKeys("install i ci add update up upgrade publish dlx create x exec init")}`),
  ],
  [
    "file-write",
    S(`touch mkdir cp mv ln chmod chown tee install tar zip unzip gzip gunzip xz patch split ditto pbcopy oxfmt black
  git:add,commit,checkout,switch,restore,merge,rebase,cherry-pick,revert,apply,am,stash,worktree,mv,init,reset,notes,update-index,gc,bisect,format-patch,archive,sparse-checkout
  git:stash:push,pop,apply,save git:worktree:add,move git:remote:add,remove,set-url,rename docker:compose:down docker:stop,start,restart,tag,cp pip:uninstall uv:remove,venv
  brew:uninstall,cleanup,link,unlink,services cargo:remove,new,init,clean,fmt go:fmt,clean make:install,clean,format,fmt xcrun:simctl:boot,shutdown,install,io
  tmux:new-session,new,split-window,new-window,select-pane,resize-pane ${pkgKeys("remove rm uninstall prune dedupe link unlink pack version fmt format")} ${pkgKeys("fmt format", "run:")}`),
  ],
  [
    "exec-code",
    S(`node python ruby perl deno bun tsx ts-node bash sh zsh fish dash source . eval exec osascript make cmake ninja sqlite3 psql mysql redis-cli swift java
  open code cursor claude codex bob t3 watchman adb npm pnpm yarn vp vpr go:run,generate cargo:run uv:run docker:run,exec docker:compose:up,run,exec kubectl:exec
  tmux:send-keys xcrun:simctl:launch,spawn,openurl,terminate ${pkgKeys("run run-script dev start")}`),
  ],
  [
    "build-test",
    S(`tsc tsgo eslint oxlint biome prettier vitest jest pytest tox ruff mypy pyright hyperfine playwright xcodebuild swiftc clang gcc cc javac rustc gradle mvn
  bazel turbo nx esbuild vite gofmt make:test,check,lint,build,all cargo:build,check,test,clippy,bench,doc go:build,test,vet swift:build,test xcrun:xcodebuild
  ${pkgKeys("test t build lint typecheck check")} ${pkgKeys("test build lint typecheck check e2e coverage", "run:")}`),
  ],
  [
    "network-read",
    S(`curl dig nslookup host ping whois git:ls-remote gh:pr:view,list,diff,checks,status gh:issue:view,list gh:run:view,list,watch gh:repo:view
  gh:release:view,list gh:workflow:list,view gh:auth:status gh:search,status,api kubectl:get,describe,logs,top,explain,version brew:search ${pkgKeys("view info outdated audit")}`),
  ],
  [
    "read-only",
    S(`ls cat head tail less more wc sort uniq cut tr echo printf pwd cd pushd popd which whereis type file stat du df fd rg grep egrep fgrep ag ack jq yq
  diff cmp comm join paste column nl fold basename dirname realpath readlink date sleep true false test [ [[ uname whoami id hostname sw_vers ps pgrep lsof tree bat eza
  man seq printenv xxd od hexdump strings nm otool lipo shasum sha256sum md5 md5sum cksum base64 wait read nproc mdls mdfind exit set export unset local declare alias
  history iconv bc expr tput sed awk gawk find env command sysctl ifconfig netstat ss top log clear plutil git:status,log,diff,show,rev-parse,rev-list,ls-files,ls-tree
  git:grep,blame,describe,shortlog,reflog,cat-file,show-ref,symbolic-ref,for-each-ref,merge-base,name-rev,check-ignore,range-diff,diff-tree,count-objects,branch,tag
  git:config,remote,fsck git:remote:show,get-url git:stash:list,show git:worktree:list docker:ps,images,logs,inspect,version,info docker:compose:ps,logs
  brew:list,info,outdated,doctor,config go:env,version,list,doc pip:list,show,freeze,check cargo:metadata,tree uv:tree uv:pip:list,show,freeze xcrun:simctl:list
  tmux:ls,list-sessions,list-windows,list-panes,capture-pane,has-session,display-message defaults:read,domains launchctl:list,print ${pkgKeys("ls list why config env")}`),
  ],
];
const NET = new Set([...CLASS_SETS[2][1], ...CLASS_SETS[6][1]]);
const FLAG_CLASS = {
  // flag shapes that raise a command above its base class
  "git push --force": "destructive",
  "git reset --hard": "destructive",
  "git discard (checkout --/restore)": "destructive",
  "git branch -d/-D": "destructive",
  "find -delete": "destructive",
  "sed -i": "file-write",
  "perl -i": "file-write",
  "git branch (create/rename)": "git-write",
  "find -fprint": "file-write",
  "git tag (create/delete)": "git-write",
  "git config (set)": "git-write",
  "auto-fix (--fix/--write)": "file-write",
  "curl download": "network",
  "curl send/upload": "network",
  "gh api (write)": "network",
  "global install (-g)": "network",
  "awk system()/pipe/redirect": "exec-code",
};

// ---------------------------------------------------------------- path classes
const SENSITIVE = new RegExp(
  String.raw`^~/(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.password-store|\.config/(gh|gcloud|op)|Library/Keychains|\.git-credentials|\.npmrc|` +
    String.raw`\.pypirc|\.netrc)(/|$)|^~/\.codex/auth\.json$|^~/\.claude/\.credentials\.json$|^~/\.bob/settings/auth-secrets\.json$|^~/\.t3/[^/]+/secrets(/|$)|` +
    String.raw`^/etc/(shadow|sudoers|master\.passwd)|\.(pem|key|p12|pfx|keychain(-db)?)$|/id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`,
);
const AGENT_DIRS = S(".claude .codex .bob .t3 .cursor .gemini .agents"),
  norm = (p) => p.replace(/^\/private(?=\/(tmp|var)\/)/, "");
function resolvePath(raw, c) {
  // absolute path, or null when it depends on a variable or an unknown cwd
  let p = String(raw ?? "").trim();
  if (!p || p.includes("$SUB")) return null;
  if (p.startsWith("file://"))
    try {
      p = NodeURL.fileURLToPath(p);
    } catch {
      return null;
    }
  p = p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME);
  if (/^\$\{?(TMPDIR|TMP|TEMP)\b/.test(p)) return "/tmp/x";
  if (/^[$~]/.test(p) || (!p.startsWith("/") && !c.cwd)) return null;
  return norm(NodePath.normalize(p.startsWith("/") ? p : NodePath.join(c.cwd, p))).replace(
    /(.)\/+$/,
    "$1",
  );
}
function pathClass(raw, c) {
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(String(raw ?? "").trim())) return "devnull";
  const p = resolvePath(raw, c);
  if (!p) return "unknown";
  if (SENSITIVE.test(tilde(p))) return "sensitive";
  for (const root of (c.roots ?? []).filter(Boolean).map((r) => norm(r).replace(/(.)\/+$/, "$1"))) {
    if (p !== root && !p.startsWith(root + "/")) continue;
    const dot = p
      .slice(root.length + 1)
      .split("/")
      .find((s) => s.startsWith(".") && s !== "." && s !== "..");
    return !dot
      ? "workspace"
      : dot === ".git"
        ? "workspace/.git"
        : dot.startsWith(".env")
          ? "workspace/.env*"
          : dot === ".github"
            ? "workspace/.github"
            : "workspace/other-dot";
  }
  if (/^\/(tmp|var\/folders|var\/tmp)(\/|$)/.test(p)) return "tmp";
  const top = p.startsWith(HOME + "/") ? p.slice(HOME.length + 1).split("/")[0] : null;
  if (top !== null || p === HOME)
    return NodePath.basename(p).startsWith(".env")
      ? "sensitive"
      : AGENT_DIRS.has(top)
        ? "home/agent-dir"
        : top?.startsWith(".")
          ? "home/dot-dir"
          : "home";
  return /^\/(usr|bin|sbin|etc|opt|System|Library|Applications|var|dev|proc|sys|nix|private|cores)?(\/|$)/.test(
    p,
  )
    ? "system"
    : "other-abs";
}
// Order used to pick the widest path a read-only shell call touched.
const SCOPE = [
  "none",
  "workspace",
  "workspace/.github",
  "workspace/other-dot",
  "workspace/.git",
  "tmp",
  "devnull",
  "system",
  "home/agent-dir",
  "home",
  "home/dot-dir",
  "other-abs",
  "unknown",
  "workspace/.env*",
  "sensitive",
];
// Programs whose positional arguments are files, so any "a/b" argument counts as a path; for others it needs a "/" prefix or an extension.
const FILE_ARGS = S(
  "ls cat head tail less more wc rg grep egrep ag ack fd find sed awk stat du tree file cp mv rm mkdir rmdir touch chmod chown ln diff tar cd bat eza realpath readlink",
);
const looksLikePath = (v, fileArgs) =>
  !/[:\s|^\\(){}<>,;]|\$SUB/.test(v) &&
  v.length < 400 &&
  (/^(\/|~|\.\.?(\/|$)|\$\{?HOME\b|\$\{?TMPDIR\b|\.env)/.test(v) ||
    (v.includes("/") && (fileArgs || /(\.[A-Za-z0-9]{1,8}|\/)$/.test(v))));
function urlClass(u) {
  try {
    const { protocol, hostname: h } = new URL(u);
    if (!/^https?:$/.test(protocol)) return protocol === "file:" ? "file" : "other-scheme";
    if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)|\.(localhost|test)$/.test(h)) return "localhost";
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|\.(ts\.net|local|internal|lan)$/.test(
      h,
    )
      ? "private-network"
      : "public";
  } catch {
    return "invalid";
  }
}

// ---------------------------------------------------------------- shell parsing
// Splits a command into simple commands [{ words, redirs }], adding command-level features to `feats`. Quotes are removed. Bodies of
// $(...), `...` and <(...) are parsed recursively and their commands added (so `echo $(rm x)` counts rm). Heredoc bodies are data and skipped.
const HEREDOC = /^(-?)[ \t]*(['"]?)([^\s'"<>;|&()]+)\2/; // after "<<": strip-tabs flag, quote, delimiter
const OPFEAT = {
  "|": "pipeline",
  "|&": "pipeline",
  "&": "background &",
  "(": "subshell ( )",
  "&&": "chain &&",
  "||": "chain ||",
  ";": "chain ;",
  "\n": "multi-line",
};
function splitShell(src, feats, depth = 0) {
  const out = [],
    ops = [],
    heredocs = [];
  let words = [],
    redirs = [],
    w = null,
    pendingRedir = null,
    parens = 0; // parens: open subshells; a ")" with none open ends a case pattern
  feats.fns ??= new Set(); // names of shell functions defined in this call
  const flushWord = () => {
    if (w !== null) {
      if (pendingRedir) redirs.push({ op: pendingRedir, target: w });
      else words.push(w);
      w = pendingRedir = null;
    }
  };
  const flushCmd = () => {
    flushWord();
    if (words.length || redirs.length) out.push({ words, redirs });
    words = [];
    redirs = [];
  };
  const sub = (body, feat) => {
    feats.add(feat);
    if (depth < 4) out.push(...splitShell(body, feats, depth + 1));
    w = (w ?? "") + "$SUB";
  };
  const skipBodies = (i, docs) => {
    // index of the newline ending the last heredoc body in `docs`; bodies start after newline i
    for (const m of docs)
      for (let j = i + 1, e = -2; e !== -1; j = e + 1) {
        e = src.indexOf("\n", j);
        if (e < 0 || (m[1] ? src.slice(j, e).replace(/^\t+/, "") : src.slice(j, e)) === m[3]) {
          i = e < 0 ? src.length : e;
          break;
        }
      }
    return i;
  };
  // Index of the ")" closing a "(" opened just before i. Quotes and heredoc bodies (as in `git commit -m "$(cat <<'EOF' ... EOF)"`)
  // are skipped, since their text may hold parens.
  const closeParen = (i) => {
    for (let d = 1, docs = []; i < src.length; i++) {
      const ch = src[i];
      if (ch === "\\") i++;
      else if (ch === "'" || ch === '"') {
        let e = i + 1;
        while (e < src.length && src[e] !== ch) e += ch === '"' && src[e] === "\\" ? 2 : 1;
        i = e;
      } else if (ch === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
        const m = HEREDOC.exec(src.slice(i + 2));
        if (m) {
          docs.push(m);
          i += 1 + m[0].length;
        }
      } else if (ch === "\n" && docs.length) i = skipBodies(i, docs.splice(0));
      else if (ch === "(") d++;
      else if (ch === ")" && --d === 0) return i;
    }
    return src.length;
  };
  const dollarParen = (i) => {
    const e = closeParen(i + 2);
    if (src[i + 2] === "(") w = (w ?? "") + "0";
    else sub(src.slice(i + 2, e), "substitution $( )");
    return e;
  };
  const backtick = (i) => {
    const e = src.indexOf("`", i + 1);
    sub(src.slice(i + 1, e < 0 ? undefined : e), "substitution $( )");
    return e < 0 ? src.length : e;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i],
      nx = src[i + 1];
    if (ch === "\\") {
      if (nx !== "\n") w = (w ?? "") + (nx ?? "");
      i++;
    } else if (ch === "'") {
      const e = src.indexOf("'", i + 1);
      w = (w ?? "") + src.slice(i + 1, e < 0 ? undefined : e);
      i = e < 0 ? src.length : e;
    } else if (ch === '"') {
      for (w ??= "", i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\") w += src[++i] ?? "";
        else if (src[i] === "$" && src[i + 1] === "(") i = dollarParen(i);
        else if (src[i] === "`") i = backtick(i);
        else w += src[i];
      }
    } else if (ch === "$" && nx === "(") i = dollarParen(i);
    else if (ch === "`") i = backtick(i);
    else if ((ch === "<" || ch === ">") && nx === "(") {
      flushWord();
      const e = closeParen(i + 2);
      sub(src.slice(i + 2, e), "process-substitution");
      i = e;
    } else if (ch === "#" && w === null) {
      const e = src.indexOf("\n", i);
      i = (e < 0 ? src.length : e) - 1;
    } else if (ch === " " || ch === "\t" || ch === "\r") flushWord();
    else if (ch === "\n") {
      flushCmd();
      ops.push(["\n", out.length]);
      if (heredocs.length) i = skipBodies(i, heredocs.splice(0));
    } else if (ch === ">" || ch === "<" || (ch === "&" && nx === ">")) {
      if (w !== null && /^\d+$/.test(w)) w = null; // "2>": the digits are a file descriptor
      flushWord();
      if (ch === "<" && src.startsWith("<<<", i)) {
        feats.add("here-string");
        pendingRedir = "<<<";
        i += 2;
        continue;
      }
      if (ch === "<" && nx === "<") {
        const m = HEREDOC.exec(src.slice(i + 2));
        feats.add("heredoc");
        redirs.push({ op: "<<" });
        if (m) heredocs.push(m);
        i += m ? 1 + m[0].length : 1;
        continue;
      }
      let j = i + 2;
      if (nx === "&" && ch !== "&") {
        while (/[\d-]/.test(src[j] ?? "")) j++;
        if (j > i + 2) {
          feats.add("fd-dup (2>&1)");
          i = j - 1;
          continue;
        }
      } // 2>&1, >&-
      j =
        ch === "&"
          ? src[i + 2] === ">"
            ? i + 3
            : i + 2
          : nx === ">" || nx === "|" || nx === "&" || (ch === "<" && nx === ">")
            ? i + 2
            : i + 1;
      pendingRedir = src.slice(i, j);
      i = j - 1;
    } else if (
      ch === "(" &&
      /^\s*\)/.test(src.slice(i + 1)) &&
      (w === null ? words.length === 1 : !words.length)
    ) {
      // f() { ...; }
      feats.add("function definition");
      feats.fns.add(w ?? words[0]);
      w = null;
      words = [];
      i = src.indexOf(")", i);
    } else if (ch === ")" && parens === 0) {
      feats.add("loop/conditional");
      w = null;
      words = [];
      redirs = [];
    } // a case pattern
    else if (ch === "|" || ch === "&" || ch === ";" || ch === "(" || ch === ")") {
      flushCmd();
      parens += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      const op =
        (ch !== "(" && ch !== ")" && nx === ch) || (ch === "|" && nx === "&") ? ch + src[++i] : ch;
      ops.push([op, out.length]);
    } else w = (w ?? "") + ch;
  }
  flushCmd();
  // Chains and newlines count only between commands; pipes, "&" and subshells always.
  for (const [op, at] of ops)
    if (OPFEAT[op] && (/^(\||\(|&$)/.test(op) || (at > 0 && out.length > at)))
      feats.add(OPFEAT[op]);
  return out;
}

const progName = (w) => {
  if (/^[$`]/.test(w) || w.includes("$SUB")) return "<var>";
  const b = NodePath.basename(w)
    .replace(/^python3?(\.\d+)*$/, "python")
    .replace(/^pip3?(\.\d+)*$/, "pip")
    .replace(/^g(sed|grep|awk)$/, "$1");
  return PROGRAMS.has(b)
    ? b
    : !w.includes("/")
      ? "<other>"
      : /^[/~]/.test(w)
        ? "<abs-path>"
        : "<local-path>";
};
const firstPos = (args, valueOpts = EMPTY) => {
  // index of the first positional argument, skipping options (and the values of `valueOpts`)
  for (let j = 0; j < args.length; j += valueOpts.has(args[j]) ? 2 : 1) {
    if (args[j] === "--") return j + 1 < args.length ? j + 1 : -1;
    if (!args[j].startsWith("-")) return j;
  }
  return -1;
};
const keysOf = (prog, sub, sub2) => [`${prog}:${sub}:${sub2}`, `${prog}:${sub}`, prog];
function baseClass(prog, sub, sub2) {
  const cls = keysOf(prog, sub, sub2)
    .map((k) => CLASS_SETS.find(([, set]) => set.has(k))?.[0])
    .find(Boolean);
  return cls === "file-write" && prog === "git"
    ? "git-write"
    : (cls ??
        (/^<(assign|function)>$/.test(prog)
          ? "read-only"
          : /^<(local|abs)-path>$/.test(prog)
            ? "exec-code"
            : "unknown"));
}
const sevOf = (flags) => flags.map((f) => SEV.indexOf(FLAG_CLASS[f] ?? "read-only"));

function flagFeatures(prog, sub, sub2, args, rest) {
  const f = [],
    has = (...xs) => args.some((a) => xs.includes(a)),
    short = args.filter((a) => /^-[A-Za-z]+$/.test(a)).join(""),
    restPos = rest.filter((a) => !a.startsWith("-"));
  const method = (...flag) => {
    const x = args.findIndex((a) => flag.includes(a));
    return x >= 0 ? (args[x + 1] ?? "") : null;
  };
  if (prog === "rm") {
    const r = /[rR]/.test(short) || has("--recursive"),
      fo = /f/.test(short) || has("--force");
    f.push(r && fo ? "rm -rf" : r ? "rm -r" : fo ? "rm -f" : "rm (plain)");
  }
  if (prog === "git") {
    if (
      sub === "push" &&
      (has("-f", "--force") ||
        args.some((a) => a.startsWith("--force-with-lease") || a.startsWith("+")))
    )
      f.push("git push --force");
    if (sub === "reset" && has("--hard")) f.push("git reset --hard");
    if (
      (sub === "checkout" && has("--", ".", "-f", "--force")) ||
      (sub === "restore" && !has("--staged", "-S"))
    )
      f.push("git discard (checkout --/restore)");
    if (sub === "branch" && args.some((a) => /^-[a-zA-Z]*[dD]$/.test(a) || a === "--delete"))
      f.push("git branch -d/-D");
    else if (
      sub === "branch" &&
      (has("-m", "-M", "-c", "-C", "--move", "--copy") ||
        (restPos.length &&
          !has("--list", "-l", "--contains", "--merged", "--no-merged", "--points-at")))
    )
      f.push("git branch (create/rename)");
    if (sub === "tag" && restPos.length && !has("-l", "--list", "--contains", "--points-at"))
      f.push("git tag (create/delete)");
    if (
      sub === "config" &&
      (restPos.length >= 2 ||
        has("--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e"))
    )
      f.push("git config (set)");
    if (sub === "commit" && has("--amend")) f.push("git commit --amend");
    if (has("--no-verify")) f.push("git --no-verify");
  }
  if (
    (prog === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) ||
    (prog === "perl" && args.some((a) => /^-[a-zA-Z]*i/.test(a)))
  )
    f.push(`${prog} -i`);
  if (prog === "find")
    for (const [re, name] of [
      [/^-delete$/, "find -delete"],
      [/^-(exec|execdir|ok|okdir)$/, "find -exec"],
      [/^-f(print0?|printf|ls)$/, "find -fprint"],
    ])
      if (args.some((a) => re.test(a))) f.push(name);
  if (prog === "curl") {
    if (args.some((a) => /^(--output|--remote-name|-[a-zA-Z]*[oO])$/.test(a)))
      f.push("curl download");
    const m = method("-X", "--request");
    if (
      (m !== null && !/^(GET|HEAD)$/i.test(m)) ||
      args.some((a) =>
        /^(-X(POST|PUT|PATCH|DELETE)|-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/i.test(a),
      )
    )
      f.push("curl send/upload");
  }
  if ((prog === "chmod" || prog === "chown") && (/R/.test(short) || has("--recursive")))
    f.push(`${prog} -R`);
  if (/^(kill|pkill|killall)$/.test(prog) && has("-9", "-KILL", "-SIGKILL")) f.push(`${prog} -9`);
  if (prog === "gh" && sub === "api") {
    const m = method("-X", "--method");
    if ((m !== null && !/^GET$/i.test(m)) || has("-f", "-F", "--field", "--raw-field", "--input"))
      f.push("gh api (write)");
  }
  if (
    /^g?awk$/.test(prog) &&
    args.some((a) => /system\s*\(|\|\s*getline|\bprint[^;}]*>\s*"/.test(a))
  )
    f.push("awk system()/pipe/redirect");
  if (PKG.has(prog) && has("-g", "--global")) f.push("global install (-g)");
  if (has("--fix", "--write") || (has("-w") && /^(gofmt|prettier)$/.test(prog)))
    f.push("auto-fix (--fix/--write)");
  if (has("--force") && !/^(rm|git)$/.test(prog)) f.push("--force (other programs)");
  if (has("--yes", "-y")) f.push("--yes/-y");
  if (has("--dry-run")) f.push("--dry-run");
  return f;
}

// Analyzes one simple command into records { prog, key, cls, flags, net, destr } (more than one for sh -c, find -exec, npx and the
// like). `c` carries the call's cwd and workspace roots, and collects its features, path classes and redirect write targets.
function analyze({ words, redirs }, c, depth) {
  const recs = [];
  const mk = (prog, key, cls, flags = []) => {
    const destr =
      flags.find((f) => FLAG_CLASS[f] === "destructive") ??
      (cls === "destructive" ? (flags.find((f) => f.startsWith(`${prog} `)) ?? key) : null);
    recs.push({
      prog,
      key,
      cls,
      flags,
      destr,
      net: /^network/.test(cls) || flags.some((f) => FLAG_CLASS[f] === "network"),
    });
    return recs.at(-1);
  };
  for (const r of redirs.filter((x) => x.target !== undefined && x.op !== "<<<")) {
    const cls = pathClass(r.target, c);
    if (r.op.startsWith("<") && r.op !== "<>") {
      c.feats.add("redirect-from-file");
      c.paths.push(cls);
    } else if (cls === "devnull") c.feats.add("redirect-to-/dev/null");
    else {
      c.feats.add(r.op.includes(">>") ? "redirect-append-to-file" : "redirect-to-file");
      c.writes.push(cls);
    }
  }
  let i = 0,
    sudo = false,
    assigned = false,
    wrapper = null;
  const skipAssign = () => {
    while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) {
      c.feats.add("env-prefix (VAR=x cmd)");
      assigned = true;
      i++;
    }
  };
  skipAssign();
  for (let w = words[i]; w !== undefined; w = words[i]) {
    // keywords and wrappers in front of the program
    if (/^(for|select|case)$/.test(w)) {
      c.feats.add("loop/conditional");
      return recs;
    }
    if (KEYWORDS.has(w)) {
      if (/^(if|while|until)$/.test(w)) c.feats.add("loop/conditional");
      i++;
      skipAssign();
      continue;
    }
    const b = NodePath.basename(w);
    if (!WRAPPERS.has(b) || (b === "command" && /^-[vV]$/.test(words[i + 1] ?? ""))) break;
    wrapper = b;
    if (b === "sudo" || b === "doas") {
      sudo = true;
      c.feats.add("sudo");
    } else c.feats.add(b === "xargs" ? "xargs" : "wrapper (env/time/timeout/nohup...)");
    for (
      i++;
      i < words.length &&
      (words[i].startsWith("-") || (b === "env" && /^[A-Za-z_]\w*=/.test(words[i])));
      i++
    )
      if (WRAP_VALUE[b]?.has(words[i])) i++;
    if (b === "timeout") i++; // its duration
  }
  if (i >= words.length) {
    // nothing left to run: a bare `env`, `sudo -v`, or `FOO=1`
    if (wrapper || assigned)
      mk(
        wrapper ?? "<assign>",
        wrapper ?? "<assign>",
        sudo ? "privileged" : baseClass(wrapper ?? "<assign>", "", ""),
      );
    return recs;
  }
  const raw = words[i],
    prog = c.feats.fns.has(raw) ? "<function>" : progName(raw),
    args = words.slice(i + 1);
  const done = () => {
    if (sudo) for (const r of recs) r.cls = "privileged";
    return recs;
  };
  if (prog === "<other>") c.other.add(NodePath.basename(raw)); // counted, never printed
  if (prog === "<var>") c.feats.add("variable-as-program");
  if (
    args.length === 1 &&
    /^(--version|-v|-V|version|--help|-h|help)$/.test(args[0]) &&
    !prog.startsWith("<")
  )
    return (mk(prog, `${prog} --version/--help`, "read-only"), done());
  const nested = (script, key) => {
    // sh -c "...", eval "...": the inner commands decide
    c.feats.add("nested-shell (sh -c / eval)");
    mk(prog, key, "read-only");
    if (depth < 4)
      for (const s of splitShell(script, c.feats, 1)) recs.push(...analyze(s, c, depth + 1));
    return done();
  };
  const k = SHELLS.has(prog) ? args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
  if (k >= 0 && args[k + 1] !== undefined) return nested(args[k + 1], `${prog} -c`);
  if (SHELLS.has(prog))
    return (
      mk(
        prog,
        `${prog} ${args.some((a) => !a.startsWith("-")) ? "<script>" : "<stdin>"}`,
        "exec-code",
      ),
      done()
    );
  if (prog === "eval") return nested(args.join(" "), "eval");
  let sub = "",
    sub2 = "",
    rest = args;
  const j = SUBS[prog] ? firstPos(args, VALUE_OPTS[prog]) : -1;
  if (j >= 0) {
    sub = SUBS[prog].has(args[j]) ? args[j] : "<sub>";
    rest = args.slice(j + 1);
    const s2 = SUB2[`${prog} ${sub}`],
      k2 = s2 ? firstPos(rest, VALUE_OPTS[prog]) : -1;
    if (k2 >= 0) {
      sub2 = s2.has(rest[k2]) ? rest[k2] : sub.startsWith("run") ? "<script>" : "<sub>";
      rest = rest.slice(k2 + 1);
    }
  }
  // Package runners (npx tsc, pnpm exec vitest, python -m pytest) are classified by what they run.
  const via = RUNNERS.has(prog)
    ? prog
    : PKG.has(prog) && /^(exec|dlx|x)$/.test(sub)
      ? `${prog} ${sub}`
      : prog === "python" && args[0] === "-m"
        ? "python -m"
        : null;
  if (via) {
    const inner =
      via === "python -m"
        ? args.slice(1)
        : RUNNERS.has(prog)
          ? args.slice(Math.max(0, firstPos(args, VALUE_OPTS[prog])))
          : rest;
    if (!inner.length || (via === "python -m" && PY_MODS[inner[0]]))
      return (
        mk(prog, inner.length ? `python -m ${inner[0]}` : via, PY_MODS[inner[0]] ?? "exec-code"),
        done()
      );
    for (const r of analyze({ words: inner, redirs: [] }, c, depth + 1)) {
      r.key = `${via} ${r.key}`;
      if (r.prog === "<other>")
        r.net = (r.cls = via === "python -m" ? "exec-code" : "network") === "network"; // unknown packages may download
      recs.push(r);
    }
    return done();
  }
  if (INTERP.has(prog)) {
    const inline = args.some((a) => /^(-c|-e|--eval|-p|--print|-[a-zA-Z]*[enp]e?)$/.test(a)),
      script = args.some((a) => !a.startsWith("-"));
    if (inline) c.feats.add("inline-code (-c/-e)");
    else if (!script && redirs.some((r) => r.op === "<<")) c.feats.add("heredoc-to-interpreter");
    const flags = flagFeatures(prog, "", "", args, args),
      test = prog === "node" && args[0] === "--test";
    return (
      mk(
        prog,
        test
          ? "node --test"
          : `${prog} ${inline ? "-c/-e <inline>" : script ? "<script>" : "<stdin>"}`,
        test ? "build-test" : SEV[Math.max(SEV.indexOf("exec-code"), ...sevOf(flags))],
        flags,
      ),
      done()
    );
  }
  if (prog === "find") {
    // the command run by -exec is analyzed as its own simple command
    const x = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a)),
      e = args.findIndex((a, y) => y > x && (a === ";" || a === "+"));
    if (x >= 0)
      recs.push(
        ...analyze(
          { words: args.slice(x + 1, e < 0 ? undefined : e).filter((a) => a !== "{}"), redirs: [] },
          c,
          depth + 1,
        ),
      );
  }
  // Arguments that look like paths (the pattern argument of sed/grep/awk/jq is skipped), then `cd`, which moves later commands.
  let skip =
    PATTERN_PROGS.has(prog) && !args.some((a) => /^(-e|-f|--expression|--regexp|--file)$/.test(a));
  for (let v of args) {
    if (v.startsWith("-")) {
      if (!v.includes("=")) continue;
      v = v.slice(v.indexOf("=") + 1);
    } else if (skip && v) {
      skip = false;
      continue;
    }
    if (looksLikePath(v, FILE_ARGS.has(prog))) c.paths.push(pathClass(v, c));
  }
  if (prog === "cd" || prog === "pushd") {
    const t = args.find((a) => !a.startsWith("-")) ?? "~";
    c.feats.add("cd");
    if (!pathClass(t, c).startsWith("workspace")) c.feats.add("cd-outside-workspace");
    c.cwd = resolvePath(t, c);
  }
  const flags = flagFeatures(prog, sub, sub2, args, rest);
  const r = mk(
    prog,
    [prog, sub, sub2].filter(Boolean).join(" "),
    SEV[Math.max(SEV.indexOf(baseClass(prog, sub, sub2)), ...sevOf(flags))],
    flags,
  );
  r.net ||= keysOf(prog, sub, sub2).some((key) => NET.has(key));
  return done();
}

// ---------------------------------------------------------------- aggregation
const STATS = {};
const stats = (src) =>
  (STATS[src] ??= {
    calls: 0,
    shellCalls: 0,
    simple: 0,
    sessions: new Set(),
    first: Infinity,
    last: 0,
    other: new Set(),
    t: {},
  });
const bump = (st, table, key, n = 1) => {
  const m = (st.t[table] ??= new Map());
  m.set(key, (m.get(key) ?? 0) + n);
};
const KNOWN_MCP =
  /^(Claude_Browser|claude-in-chrome|Claude_Code_iOS_Simulator|ccd_[a-z_]+|t3-code|playwright|github|filesystem|context7|xcode|cua_repl|node_repl|codex_apps?|computer-use|scheduled-tasks|mcp-registry|visualize|terminal|ide|sequential-thinking|memory|fetch|puppeteer|chrome-devtools|linear|slack|notion|sentry|figma)$/;
function toolName(raw) {
  // MCP servers outside the well-known list are hidden: their names may be private
  const n = String(raw ?? ""),
    m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (!m) return /^[A-Za-z][\w.:-]{0,40}$/.test(n) ? n : "<other>";
  const known = KNOWN_MCP.test(m[1]);
  return `mcp__${known ? m[1] : /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(m[1]) ? "<connector>" : "<server>"}__${known && /^[\w.-]{1,60}$/.test(m[2]) ? m[2] : "*"}`;
}
const CATS = [
  [
    "shell",
    /^(Bash|BashOutput|KillShell|execute_command|exec_command|shell|local_shell|write_stdin|command_execution|mcp__t3-code__start_background_command)$/,
  ],
  [
    "edit",
    /^(Edit|Write|MultiEdit|NotebookEdit|write_file|write_to_file|apply_diff|insert_content|search_and_replace|apply_patch|edit_file|file_change)$/,
  ],
  [
    "read",
    /^(Read|Grep|Glob|LS|read_file|list_files|glob|search_files|grep|view_image|list_code_definition_names|codebase_search|file_search)$/,
  ],
  ["web", /^(WebFetch|WebSearch|web_search|web_fetch|search_ibm_docs|ext:web\..*)$/],
  [
    "browser",
    /^mcp__(Claude_Browser|claude-in-chrome|cua_repl|playwright|chrome-devtools|puppeteer|computer-use)__/,
  ],
  [
    "subagent",
    /^(Agent|Task|spawn_subagent|SendMessage|SubagentHandback|ListAgents|TaskStop|Workflow|subagent|collaboration\..+)$/,
  ],
  ["mcp", /^mcp__/],
];
const category = (n) => CATS.find(([, re]) => re.test(n))?.[0] ?? "other";
function recordTool(st, rawName, { ts, session, mode, outcome }) {
  // mode false: the caller records it later
  const cat = category(rawName);
  st.calls++;
  bump(st, "tools", toolName(rawName));
  bump(st, "toolCategory", cat);
  if (mode !== false) bump(st, "modes", mode ?? "unknown");
  if (outcome) bump(st, "outcomes", `${cat}: ${outcome}`);
  if (session) st.sessions.add(session);
  if (Number.isFinite(ts)) {
    st.first = Math.min(st.first, ts);
    st.last = Math.max(st.last, ts);
  }
  return cat;
}
function recordShell(st, cmd, ctx) {
  if (typeof cmd !== "string" || !cmd.trim()) return;
  st.shellCalls++;
  const c = {
    cwd: ctx.cwd ? resolvePath(ctx.cwd, {}) : null,
    roots: (ctx.roots ?? []).filter(Boolean),
    feats: new Set(),
    paths: [],
    writes: [],
    other: st.other,
  };
  if (c.cwd && pathClass(c.cwd, c) !== "workspace") c.paths.push(pathClass(c.cwd, c)); // a call starting outside the workspace touches its cwd
  const recs = splitShell(cmd.slice(0, 200000), c.feats).flatMap((s) => analyze(s, c, 0));
  if (
    c.feats.has("pipeline") &&
    recs.some((r) => /^(curl|wget)$/.test(r.prog)) &&
    recs.some((r) => / <stdin>$/.test(r.key))
  )
    c.feats.add("download piped to shell");
  let sev = c.writes.length ? SEV.indexOf("file-write") : 0;
  for (const r of recs) {
    st.simple++;
    bump(st, "programs", r.prog);
    bump(st, "programSub", r.key);
    for (const f of r.flags) bump(st, "flagFeatures", f);
    if (r.net)
      bump(
        st,
        "network",
        [r.key, ...r.flags.filter((f) => FLAG_CLASS[f] === "network")].join(" + "),
      );
    if (r.destr) bump(st, "destructive", r.destr);
    sev = Math.max(sev, SEV.indexOf(r.cls));
  }
  for (const f of c.feats) bump(st, "shellFeatures", f);
  bump(st, "shellClass", SEV[sev]);
  if (sev <= 1)
    bump(
      st,
      "readOnlyScope",
      `${SEV[sev]}: ${c.paths.reduce((a, p) => (SCOPE.indexOf(p) > SCOPE.indexOf(a) ? p : a), "none")}`,
    );
  for (const p of c.paths) bump(st, "shellPaths", p);
  for (const p of c.writes) bump(st, "redirectWrite", p);
}
const lines = (file) =>
  NodeReadline.createInterface({ input: NodeFS.createReadStream(file), crlfDelay: Infinity });
const walk = (dir) =>
  NodeFS.readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => NodePath.join(dir, f));
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((x) => x?.text ?? "").join(" ")
      : "";

// ---------------------------------------------------------------- sources
async function scanClaude(dir) {
  // Subagent transcripts carry no permission mode, so their calls take their session's last known mode.
  const st = stats("claude"),
    seen = new Set(),
    calls = new Map(),
    results = new Map(),
    sessionMode = new Map();
  for (const file of walk(dir)) {
    let mode = null;
    for await (const line of lines(file)) {
      if (
        !line.includes('"tool_use"') &&
        !line.includes('"tool_result"') &&
        !line.includes('"permissionMode"')
      )
        continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof j.permissionMode === "string" && /^\w{1,30}$/.test(j.permissionMode))
        sessionMode.set(j.sessionId, (mode = j.permissionMode));
      const ts = Date.parse(j.timestamp),
        ctx = { cwd: j.cwd, roots: [j.cwd] };
      for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (b?.type === "tool_result" && b.tool_use_id) {
          const t = textOf(b.content).slice(0, 500);
          results.set(
            b.tool_use_id,
            !b.is_error
              ? "ok"
              : /doesn't want to proceed|user (rejected|denied)|rejected by the user/i.test(t)
                ? "rejected by user"
                : /permission .{0,60}denied|denied by/i.test(t)
                  ? "denied by rule/classifier"
                  : /classifier/i.test(t)
                    ? "classifier unavailable"
                    : /tool_use_error.{0,10}Blocked/i.test(t)
                      ? "blocked by harness"
                      : "error",
          );
        }
        if (b?.type !== "tool_use" || seen.has(b.id) || ts < SINCE) continue;
        seen.add(b.id);
        const inp = b.input ?? {},
          cat = recordTool(st, b.name, { ts, session: j.sessionId, mode: false });
        calls.set(b.id, [cat, mode, j.sessionId]);
        if (b.name === "Bash") recordShell(st, inp.command, ctx);
        for (const flag of b.name === "Bash"
          ? ["dangerouslyDisableSandbox", "run_in_background"]
          : [])
          if (inp[flag]) bump(st, "extra", `Bash ${flag}`);
        if (cat === "edit")
          bump(st, "editPaths", pathClass(inp.file_path ?? inp.notebook_path, ctx));
        if (cat === "read")
          bump(st, "readPaths", pathClass(inp.file_path ?? inp.path ?? j.cwd, ctx));
        if (b.name === "WebFetch") bump(st, "urlClass", urlClass(inp.url));
      }
    }
  }
  for (const [id, [cat, mode, session]] of calls) {
    bump(st, "outcomes", `${cat}: ${results.get(id) ?? "no result recorded"}`);
    bump(
      st,
      "modes",
      mode ??
        (sessionMode.has(session)
          ? `${sessionMode.get(session)} (inherited by subagent)`
          : "unknown"),
    );
  }
}

const shellScript = (cmd) =>
  !Array.isArray(cmd)
    ? cmd
    : cmd.length >= 3 && SHELLS.has(NodePath.basename(cmd[0])) && /^-\w*c$/.test(cmd[1])
      ? cmd.at(-1)
      : cmd.join(" ");
const outcome = (s) =>
  s === "completed"
    ? "ok"
    : s === "failed"
      ? "error"
      : /^[a-z_]{1,20}$/.test(s ?? "")
        ? s
        : "unknown";
async function scanCodex(dirs) {
  const st = stats("codex"),
    seen = new Set();
  const ITEM =
    /"item":\{"type":"(CommandExecution|FileChange|McpToolCall|WebSearch|ImageView|Extension|CollabAgentToolCall)"/;
  for (const file of dirs.flatMap(walk)) {
    // Calls the model made, and the items Codex ran. In code mode the model's "exec" call runs JavaScript that calls tools, so those
    // tool calls appear only as items with no matching call; an item that does match a call stands for that call.
    const calls = new Map(),
      items = [];
    let cwd = null,
      roots = [],
      mode = "unknown",
      session = file;
    for await (const line of lines(file)) {
      const head = line.slice(0, 400),
        kind = /"type":"(session_meta|turn_context|response_item|event_msg)"/.exec(head)?.[1];
      if (kind === "session_meta" || kind === "turn_context") {
        const p = JSON.parse(line).payload ?? {};
        if (p.cwd) cwd = p.cwd;
        if (Array.isArray(p.workspace_roots))
          roots = p.workspace_roots
            .map((r) => (typeof r === "string" ? r : r?.path))
            .filter(Boolean);
        if (kind === "session_meta" && p.id) session = p.id;
        if (p.approval_policy)
          mode = `${p.approval_policy}/${p.sandbox_policy?.type ?? "?"}`.replace(/[^\w/-]/g, "");
        continue;
      }
      const ts = Date.parse(/"timestamp":"([^"]+)"/.exec(head)?.[1]),
        meta = { ts, mode, session, cwd, roots: [...roots, cwd] };
      if (!kind || ts < SINCE) continue;
      if (
        kind === "response_item" &&
        /"payload":\{"type":"(function_call|custom_tool_call|web_search_call|local_shell_call)"/.test(
          head,
        )
      ) {
        const p = JSON.parse(line).payload;
        const name =
          p.type === "web_search_call"
            ? "web_search"
            : p.type === "local_shell_call"
              ? "local_shell"
              : (p.namespace ? `${p.namespace}.` : "") + p.name;
        calls.set(p.call_id ?? p.id ?? `${file}:${calls.size}`, {
          name,
          args: p.arguments ?? p.input ?? p.action,
          ...meta,
        });
      } else if (
        kind === "event_msg" &&
        head.includes('"item_completed"') &&
        ITEM.test(line.slice(0, 700))
      ) {
        const it = JSON.parse(line).payload.item; // keep only what is counted; outputs can be large
        items.push({
          ...meta,
          it: {
            type: it.type,
            id: it.id,
            command: it.command,
            cwd: it.cwd,
            status: it.status,
            path: it.path,
            kind: it.kind,
            server: it.server,
            tool: it.tool,
            readOnlyHint: it.readOnlyHint,
            changes: Object.entries(it.changes ?? {}).map(([p, v]) => [p, v?.type]),
          },
        });
      }
    }
    for (const { it, ...m } of items) {
      if (seen.has(it.id)) continue;
      const call = calls.get(it.id),
        ctx = { cwd: it.cwd ?? m.cwd, roots: m.roots },
        done = { ...m, outcome: outcome(it.status) };
      seen.add(it.id);
      calls.delete(it.id);
      if (it.type === "CommandExecution") {
        recordTool(st, "exec_command", done);
        recordShell(st, shellScript(it.command), ctx);
      } else if (it.type === "FileChange") {
        recordTool(st, "apply_patch", done);
        for (const [p, t] of it.changes) {
          bump(st, "editPaths", pathClass(p, ctx));
          bump(st, "extra", `file change: ${/^(add|update|delete)$/.test(t) ? t : "other"}`);
        }
      } else if (it.type === "McpToolCall") {
        recordTool(st, `mcp__${it.server}__${it.tool}`, done);
        bump(st, "extra", `mcp readOnlyHint: ${it.readOnlyHint ?? "unset"}`);
      } else if (it.type === "ImageView") {
        recordTool(st, "view_image", m);
        bump(st, "readPaths", pathClass(it.path, ctx));
      } else if (it.type === "WebSearch") recordTool(st, "web_search", m);
      else if (it.type === "Extension")
        recordTool(st, /^[a-z_.]{1,40}$/.test(it.kind ?? "") ? `ext:${it.kind}` : "ext:other", m);
      else
        recordTool(
          st,
          call?.name ?? `collaboration.${/^\w{1,30}$/.test(it.tool ?? "") ? it.tool : "other"}`,
          done,
        );
    }
    for (const [id, call] of calls) {
      if (seen.has(id)) continue;
      seen.add(id);
      const raw = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
      const escalations = (
        raw.match(/sandbox_permissions\\?["']?\s*:\s*\\?["']require_escalated/g) ?? []
      ).length;
      if (escalations) bump(st, "extra", "sandbox escalation requested", escalations);
      if (call.name === "exec") {
        bump(st, "extra", "code-mode exec wrapper calls");
        continue;
      }
      recordTool(st, call.name.replace(/^mcp__([^.]+)\./, "mcp__$1__"), call);
      let args = {};
      try {
        args = typeof call.args === "string" ? JSON.parse(call.args) : (call.args ?? {});
      } catch {}
      const ctx = { cwd: args.workdir ?? call.cwd, roots: call.roots };
      if (/^(exec_command|shell|local_shell)$/.test(call.name))
        recordShell(st, shellScript(args.cmd ?? args.command), ctx);
      if (call.name === "apply_patch")
        for (const m of raw.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)/g))
          bump(st, "editPaths", pathClass(m[1], ctx));
      if (call.name === "view_image") bump(st, "readPaths", pathClass(args.path, ctx));
    }
  }
}

async function openDb(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}
async function scanBob(file) {
  const st = stats("bob"),
    seen = new Set(),
    db = await openDb(file);
  let rows,
    pending = 0;
  try {
    rows = db
      .prepare(
        "SELECT m.task_id, m.data, m.created_at, t.directory FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.role = 'tool'",
      )
      .all();
    try {
      pending = db.prepare("SELECT count(*) AS c FROM task_pending_approvals").get().c;
    } catch {}
  } finally {
    db.close();
  }
  if (pending) bump(st, "extra", "pending approvals now", pending);
  const visit = (msg, row) => {
    // a spawn_subagent message also carries the subagent's own tool messages
    const u = msg?.toolUsage,
      sig = u?.signature,
      ts = msg?._meta?.timestamp ?? row.created_at;
    if (sig?.name && !seen.has(sig.id ?? msg.id) && !(ts < SINCE)) {
      seen.add(sig.id ?? msg.id);
      const a = sig.arguments ?? {},
        ctx = { cwd: row.directory, roots: [row.directory] };
      const cat = recordTool(st, sig.name, {
        ts,
        session: row.task_id,
        mode: "not recorded",
        outcome: sig.isError ? "error" : "ok",
      });
      if (/^(execute|edit|read|mcp)$/.test(u.permission ?? ""))
        bump(st, "extra", `bob permission group: ${u.permission}`);
      for (const [flag, label] of [
        [u.isOutsideWorkspace, "isOutsideWorkspace"],
        [u.commandUse?.requiresSecurityApproval, "requiresSecurityApproval"],
        [u.commandUse?.unverifiable, "command unverifiable"],
      ])
        if (flag) bump(st, "extra", `bob ${label}`);
      if (cat === "shell")
        recordShell(st, a.command, {
          cwd: a.cwd ? NodePath.resolve(row.directory, a.cwd) : row.directory,
          roots: ctx.roots,
        });
      if (cat === "edit" || cat === "read")
        for (const p of [
          a.path,
          a.file_path,
          ...(Array.isArray(a.files) ? a.files.map((f) => f?.path) : []),
        ])
          if (typeof p === "string") bump(st, `${cat}Paths`, pathClass(p, ctx));
      if (typeof a.url === "string") bump(st, "urlClass", urlClass(a.url));
    }
    if (Array.isArray(msg?.messages))
      for (const m of msg.messages) if (m?.role === "tool") visit(m, row);
  };
  for (const row of rows) {
    try {
      visit(JSON.parse(row.data), row);
    } catch {}
  }
}

// T3 overlaps the provider transcripts above, so it is reported apart and left out of "combined".
async function scanT3(file) {
  const st = stats("t3"),
    db = await openDb(file),
    q = (sql) => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };
  const clean = (v) => (/^[\w-]{1,30}$/.test(v ?? "") ? v : "unknown");
  try {
    for (const r of q(
      "SELECT kind, status, json_extract(payload_json, '$.decision') AS d FROM orchestration_v2_projection_runtime_requests",
    ))
      bump(st, "approvals", `${clean(r.kind)}: ${clean(r.d ?? r.status)}`);
    for (const r of q(`SELECT ti.thread_id, ti.type, ti.status, ti.updated_at, ti.payload_json, r.provider, th.runtime_mode,
        coalesce(json_extract(th.payload_json, '$.worktreePath'), p.workspace_root) AS root FROM orchestration_v2_projection_turn_items ti
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = ti.run_id LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = ti.thread_id
      LEFT JOIN projection_projects p ON p.project_id = th.project_id
      WHERE ti.type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool', 'approval_request', 'subagent')`)) {
      const p = JSON.parse(r.payload_json),
        ts = Date.parse(r.updated_at),
        ctx = { cwd: r.root, roots: [r.root] };
      if (ts < SINCE) continue;
      if (r.type === "approval_request") {
        bump(st, "approvals", `${clean(p.requestKind)}: requested`);
        continue;
      }
      const name =
        r.type === "dynamic_tool"
          ? `dynamic_tool:${toolName(String(p.toolName ?? "").replace(/\s+/g, "_"))}`
          : r.type;
      recordTool(st, name, {
        ts,
        session: r.thread_id,
        mode: clean(r.runtime_mode),
        outcome: clean(r.status),
      });
      bump(st, "byProvider", `${clean(r.provider)}: ${r.type}`);
      if (r.type === "command_execution") recordShell(st, p.input, ctx);
      if (r.type === "file_change") bump(st, "editPaths", pathClass(p.fileName, ctx));
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- output
const TABLES = [
  ["tools", "Tools by name", "calls"],
  ["toolCategory", "Tool categories", "calls"],
  ["modes", "Calls by permission/approval mode", "calls"],
  ["outcomes", "Outcomes by tool category", "calls"],
  ["programs", "Shell programs (per simple command)", "simple"],
  ["programSub", "Program + subcommand", "simple"],
  ["shellClass", "Shell calls by heuristic safety class", "shell"],
  ["readOnlyScope", "Read-only shell calls by widest path touched", "shell"],
  ["shellFeatures", "Shell features (calls having it)", "shell"],
  ["flagFeatures", "Flag shapes (simple commands having it)", "simple"],
  ["network", "Network-ish commands", "simple"],
  ["destructive", "Destructive-ish commands", "simple"],
  ["editPaths", "Edit tool path classes"],
  ["readPaths", "Read tool path classes"],
  ["shellPaths", "Shell path-like argument classes"],
  ["redirectWrite", "Shell redirect write targets"],
  ["urlClass", "Web fetch URL classes"],
  ["extra", "Source-specific signals"],
  ["approvals", "T3 approval requests (kind: decision)"],
  ["byProvider", "T3 tool items by provider"],
];
const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?");
function merge(list) {
  const out = {
    calls: 0,
    shellCalls: 0,
    simple: 0,
    sessions: 0,
    first: Infinity,
    last: 0,
    other: new Set(),
    t: {},
  };
  for (const s of list) {
    for (const k of ["calls", "shellCalls", "simple"]) out[k] += s[k];
    out.sessions += s.sessions.size;
    out.first = Math.min(out.first, s.first);
    out.last = Math.max(out.last, s.last);
    for (const o of s.other) out.other.add(o);
    for (const [t, m] of Object.entries(s.t)) for (const [k, v] of m) bump(out, t, k, v);
  }
  return out;
}
const summary = (st) => ({
  calls: st.calls,
  sessions: st.sessions.size ?? st.sessions,
  from: day(st.first),
  to: day(st.last),
  shellCalls: st.shellCalls,
  simpleCommands: st.simple,
  otherProgramsDistinct: st.other.size,
  tables: Object.fromEntries(
    TABLES.filter(([t]) => st.t[t]).map(([t]) => [t, [...st.t[t]].sort((a, b) => b[1] - a[1])]),
  ),
});
function print(name, st, top) {
  const s = summary(st);
  console.log(
    `\n== ${name} ==  ${s.calls} tool calls, ${s.sessions} sessions, ${s.from} .. ${s.to}; ${s.shellCalls} shell calls with ${s.simpleCommands} simple commands (${s.otherProgramsDistinct} distinct <other> programs)`,
  );
  for (const [t, title, denom] of TABLES) {
    const rows = s.tables[t],
      n = t === "programSub" ? Math.max(top, 40) : top;
    if (!rows?.length) continue;
    const total =
      { calls: s.calls, shell: s.shellCalls, simple: s.simpleCommands }[denom] ??
      rows.reduce((a, [, v]) => a + v, 0);
    console.log(`\n  ${title}${rows.length > n ? ` (top ${n} of ${rows.length})` : ""}`);
    for (const [k, v] of rows.slice(0, n))
      console.log(
        `  ${String(v).padStart(8)} ${((100 * v) / (total || 1)).toFixed(1).padStart(5)}%  ${k}`,
      );
  }
}

const notes = [];
async function tryScan(name, flag, defaults, fn) {
  // notes name the flag or the default location, never a path given on the command line
  const targets = opt(flag) ? [opt(flag)] : defaults,
    present = targets.filter((p) => NodeFS.existsSync(p));
  if (!present.length)
    return notes.push(
      `${name}: skipped, not found (${opt(flag) ? flag : defaults.map(tilde).join(", ")})`,
    );
  const t0 = Date.now();
  try {
    await fn(present);
    notes.push(`${name}: read in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    notes.push(`${name}: failed (${String(e?.code ?? e?.name ?? "error").replace(/[^\w ]/g, "")})`);
  }
}
await tryScan("claude", "--claude-dir", [NodePath.join(HOME, ".claude", "projects")], ([d]) =>
  scanClaude(d),
);
await tryScan(
  "codex",
  "--codex-dir",
  [NodePath.join(HOME, ".codex", "sessions"), NodePath.join(HOME, ".codex", "archived_sessions")],
  scanCodex,
);
await tryScan(
  "bob",
  "--bob-db",
  [NodePath.join(HOME, ".bob", process.env.NODE_ENV === "development" ? "dev-db" : "db", "bob.db")],
  ([f]) => scanBob(f),
);
if (opt("--t3-db")) await tryScan("t3", "--t3-db", [], ([f]) => scanT3(f));
const providers = ["claude", "codex", "bob"].filter((k) => STATS[k]),
  combined = merge(providers.map((k) => STATS[k]));
if (argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sinceDays: opt("--since") ?? null,
        notes,
        sources: Object.fromEntries(Object.entries(STATS).map(([k, v]) => [k, summary(v)])),
        combined: summary(combined),
      },
      null,
      1,
    ),
  );
} else {
  console.log(
    `tool-call-stats ${new Date().toISOString().slice(0, 10)}${SINCE ? `, last ${opt("--since")} days` : ""}\n${notes.map((n) => `  ${n}`).join("\n")}`,
  );
  for (const k of Object.keys(STATS)) print(k, STATS[k], TOP);
  if (providers.length > 1)
    print(`combined (${providers.join(" + ")})`, combined, Math.max(TOP, 25));
}
