// @effect-diagnostics nodeBuiltinImport:off - Scans the checked-in tree with git and the filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The fork talks to no T3 web service (FORK.md, "Talk to no T3 web service"). This guard keeps
 * upstream's hosts, keys and repository out of the code the fork ships, so none can come back with
 * a rebase unnoticed. A hit means: gate the new code path behind configuration of the owner's own
 * service, or, for text that contacts nothing, add it to the allow list below with its reason.
 */
const DENIED = [
  { text: "t3.codes", what: "upstream's hosts (app., relay., clerk., accounts., the site)" },
  { text: "pingdotgg", what: "upstream's GitHub organization (releases, raw files, issues)" },
  { text: "posthog.com", what: "upstream's analytics host" },
  { text: "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m", what: "upstream's PostHog key" },
  { text: "Y2xlcmsudDMuY29kZXMk", what: "upstream's Clerk publishable key" },
  { text: "hzxSgY2cH10sDU2r", what: "upstream's Clerk CLI OAuth client" },
  { text: "registry.npmjs.org/t3", what: "upstream's npm package" },
  { text: "discord.gg/", what: "a Discord invite" },
  { text: "discord.com/invite", what: "a Discord invite" },
  { text: "d763fcb8", what: "upstream's EAS project" },
  { text: "ARK85ZXQ4Z", what: "upstream's Apple team" },
  { text: "6787819824", what: "upstream's App Store app" },
] as const;

/** Paths that are not shipped runtime code: docs, upstream's site and relay, tests, vendored code. */
const ALLOWED_PATHS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /^LICENSE$/, reason: "attribution" },
  { pattern: /\.md$/, reason: "documentation may name upstream (README, docs, FORK.md)" },
  { pattern: /^docs\//, reason: "documentation" },
  { pattern: /^\.github\//, reason: "upstream's CI, issue templates and triage playbook" },
  { pattern: /^\.agents\//, reason: "agent skills for maintainers" },
  { pattern: /^\.repos\//, reason: "vendored read-only references" },
  { pattern: /^apps\/marketing\//, reason: "upstream's marketing site, not a shipped app" },
  { pattern: /^infra\/relay\//, reason: "upstream's relay service, not a shipped app" },
  { pattern: /^packaging\//, reason: "upstream's AUR packages of its own releases" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, reason: "tests and their fixtures" },
  { pattern: /(^|\/)(__tests__|fixtures)\//, reason: "test fixtures" },
  {
    pattern: /^apps\/server\/scripts\/(acp-mock-agent|threadTitleEvaluationCases)\.ts$/,
    reason: "test and evaluation fixtures",
  },
  { pattern: /^scripts\/mobile-showcase-environment\.ts$/, reason: "screenshot fixture data" },
  {
    pattern: /^apps\/server\/src\/cli\/triagePrompt\.ts$/,
    reason:
      "upstream's playbook text; `t3 triage` refuses unless T3CODE_TRIAGE_REPOSITORY is set, then points it there",
  },
  {
    pattern: /^apps\/web\/vercel\.ts$/,
    reason: "upstream's hosted-app router; the fork deploys none",
  },
  { pattern: /^t3\.json$/, reason: "this repository's own project file" },
  {
    pattern: /^packages\/contracts\/src\/t3ProjectFile\.ts$/,
    reason: "the t3.json schema's `$id`, shared with upstream's project files; nothing fetches it",
  },
  {
    pattern: /^apps\/desktop\/resources\/linux\//,
    reason: "Linux AppStream metadata; the fork builds no Linux desktop app",
  },
];

/** Text that names upstream but contacts nothing, allowed in one file each. */
const ALLOWED_TEXT: ReadonlyArray<{
  readonly path: string;
  readonly text: string;
  readonly reason: string;
}> = [
  {
    path: "apps/desktop/gnome-extension/bundle.json",
    text: "snap-shot@t3.codes",
    reason: "the GNOME extension's identity",
  },
  {
    path: "apps/desktop/gnome-extension/metadata.json",
    text: "snap-shot@t3.codes",
    reason: "the GNOME extension's identity",
  },
  {
    path: "packages/source-control-github/src/server/githubStackRebase.ts",
    text: "noreply@t3.codes",
    reason: "the committer identity of a stack rebase",
  },
  {
    path: "scripts/build-desktop-artifact.ts",
    text: "hello@t3.codes",
    reason: "Linux package maintainer field; the fork builds no Linux desktop app",
  },
];

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

function scannedFiles(): ReadonlyArray<string> {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file.length > 0)
    .filter((file) => !ALLOWED_PATHS.some(({ pattern }) => pattern.test(file)));
}

function findHits(): ReadonlyArray<string> {
  const hits: Array<string> = [];
  for (const file of scannedFiles()) {
    let contents: string;
    try {
      contents = NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8");
    } catch {
      continue; // Deleted in the working tree, or a submodule.
    }
    if (contents.includes("\0")) continue; // Binary.
    const lower = contents.toLowerCase();
    if (!DENIED.some(({ text }) => lower.includes(text.toLowerCase()))) continue;
    const allowed = ALLOWED_TEXT.filter((entry) => entry.path === file);
    contents.split("\n").forEach((line, index) => {
      let rest = line;
      for (const entry of allowed) rest = rest.replaceAll(entry.text, "");
      const restLower = rest.toLowerCase();
      for (const denied of DENIED) {
        if (restLower.includes(denied.text.toLowerCase())) {
          hits.push(`${file}:${index + 1}: ${denied.what} (${denied.text})`);
        }
      }
    });
  }
  return hits;
}

describe("no T3 web service in shipped code", () => {
  it("finds none of upstream's hosts, keys or repository outside the allow list", () => {
    expect(findHits()).toEqual([]);
  });

  it("keeps every allowed text in use, so the allow list cannot go stale", () => {
    const unused = ALLOWED_TEXT.filter((entry) => {
      const path = NodePath.join(REPO_ROOT, entry.path);
      return !NodeFS.existsSync(path) || !NodeFS.readFileSync(path, "utf8").includes(entry.text);
    });
    expect(unused).toEqual([]);
  });
});
