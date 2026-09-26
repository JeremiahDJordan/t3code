# Bob Shell fork of T3 Code

This branch (`bob-shell` on `JeremiahDJordan/t3code`) is upstream T3 Code
(`pingdotgg/t3code`) plus IBM Bob Shell as a provider, driven over ACP with
`bob acp`. It is kept as a fork and rebased onto upstream `main`; the user guide is
[docs/user/providers-bob.md](docs/user/providers-bob.md).

This file records the decisions behind the fork's shape, including review
recommendations it deliberately does not follow, so later reviews and rebases
don't reopen them without new information. Add to it when a decision changes.

## How the fork meets upstream

- **Bob-only files** hold nearly all behavior: `apps/server/src/provider/**/Bob*`,
  `bob*.ts`, `apps/server/src/usage/bobUsageReader.ts`,
  `apps/server/src/textGeneration/BobTextGeneration.ts`,
  `apps/server/src/upstreamClientCompatibility.ts`, and `docs/user/providers-bob.md`.
- **Upstream files** carry registration lines (driver, icons, labels, settings,
  provider lists), a few generic features Bob needed (Bobcoin `credits` on usage
  buckets, per-folder `usageLimits`, the meter's count when the limit is unknown),
  and Bob branches in onboarding import and the usage scan.
- **Upstream clients** (the App Store app, app.t3.codes) cannot decode `bob` in the
  usage and onboarding-scan responses. This fork's clients add `clientBobSupport=1`
  to their connection; for any other client the server leaves `bob` out of the scan
  and adapts usage per the `bobUsageInUpstreamClients` setting (hidden by default).
  That is also why the usage contract keeps upstream's version number instead of
  bumping it: `bob` and `credits` only reach clients that asked for them.
- **Driving Bob needs a fork client.** Upstream clients list only the providers they
  were built with, so they show Bob's threads, diffs and (per the setting) usage, but
  cannot start or continue a Bob turn: the composer asks to enable a provider. Over T3
  Connect, the source-built desktop app drives Bob; app.t3.codes and the App Store app
  only view. On a phone, use the web client a fork server hosts, over the network or
  Tailscale.

## Install from source

The fork publishes no builds, so everyone builds this branch. You need git, Node 24,
[Vite+](README.md#install-vp), and Bob Shell 2.0.5 or later on the machine that runs
the server. The desktop app also needs stable Rust (`rustup`, or `mise install
rust@stable` and prefix the build with `mise exec rust@stable --`).

```bash
git clone -b bob-shell https://github.com/JeremiahDJordan/t3code.git
cd t3code
cp .env.example .env  # T3 Connect's public configuration; skip it to leave T3 Connect off
vp i
```

**Desktop app (macOS, Apple silicon).** `vp run dist:desktop:dmg:arm64` builds
`release/T3-Code-<version>-arm64.dmg` in a few minutes. Open it and drag T3 Code
(Alpha) to Applications. The app is ad-hoc signed; on the Mac that built it, macOS
opens it without a prompt. A copy downloaded or sent to another Mac is quarantined and
needs **Open Anyway** in System Settings → Privacy & Security the first time.

**Server only (Linux, or a Mac without the desktop app).** `vp run --filter t3 build`,
then start `node apps/server/dist/bin.mjs serve` in a project folder; it prints a
pairing link. Add `--host 0.0.0.0 --port 3773` to reach it from other machines. For T3
Connect, run `node apps/server/dist/bin.mjs connect link --headless` once in a terminal
(it offers to download Cloudflare's relay client first), approve its code at
accounts.t3.codes, and restart `serve`.

On a machine where Bob has never run, the first turn reports Bob's license. Run `bob`
once in a terminal, or `bob --accept-license -p "hi"` on a headless machine.

**Updating.** `git pull --rebase` (the branch is force-pushed after each upstream
rebase), `vp i`, and rebuild. Don't use upstream's updaters: `t3 update`, the
background service that `t3 connect` and `t3 service install` offer, and a server
update started from a client all download upstream's release, which has no Bob. Run
`serve` yourself, for example from your own systemd unit or launchd agent. A
source-built desktop app has no update feed, so it never replaces itself.

## Decisions

Owner decisions, with the review that prompted them. Reviews 1, 2 and 3 are the
adversarial reviews of 2026-09-24, and of the morning and afternoon of 2026-09-25.

### Keep Bob out of the marketing site (`apps/marketing`)

The fork's site is never deployed; the site describes upstream's product.
Revisit when Bob support goes upstream.

### Don't restructure upstream code for the fork (reviews 1 and 2)

Declined: a Bob-only mock agent; a seam or reader interface in onboarding import
or the usage scan; a per-connection service in `ws.ts`; moving Bob cases out of
shared test files into `*.bob.test.ts`; collapsing the opt-in provider lists in
`serverSettings.ts` and `providerStatusCache.ts`.

Bob follows the shapes the other providers already use (one shared mock agent,
provider cases in shared tests, inline provider branches), so each hunk reads like
upstream's own code and could go upstream as is. Restructuring would rewrite more
upstream code now for a saving that only shows up if conflicts get frequent. Rerere
and the checklist below carry the rebase cost. Revisit when rebases conflict
repeatedly in the same place, and then add a seam there only.

### Shrink the diff where it costs nothing (review 2, taken)

Changes that remove fork lines without adding structure are always worth making:
`ChatView.tsx` computes the usage-limits folder in place instead of moving
upstream's `gitCwd` block; the upstream-client provider list and its settings
choices derive from `UsageProviderKind`; the settings row is no longer gated; one
`bobDatabase.ts` helper serves the three SQLite readers.

### Keep editing shared docs and the provider lists (reviews 1 and 2)

Bob is a provider like the others, so the pages that list providers name it too:
`AGENTS.md`, `README.md`, `usage.md`, `welcome-wizard.md`, `permission-modes.md`,
`install.md`, `remote-access.md`. Moving those sentences into the Bob page would
leave the shared lists wrong.

### Keep full history, no squash (reviews 1 and 2)

Each commit is one logical change with its reasoning in the message, and
`rerere.enabled` and `rerere.autoupdate` are on so conflict resolutions replay
across rebases. Revisit when opening an upstream PR, which would be split per
concern anyway.

### Don't open upstream PRs for the generic pieces yet (review 2)

Candidates, kept in the fork for now: the meter's count when the limit is unknown,
`UsageBucket.credits` as provider billing units, per-folder `usageLimits`, the
optional ACP `authMethodId`, and `supportsCustomModels`. Already open:
pingdotgg/t3code#13451 (effect-acp bare JSON-RPC errors). Revisit when the owner
decides to upstream.

### Ship from source only

Upstream's release workflow signs and notarizes with upstream's Apple certificate and
publishes `t3` to npm under upstream's name, so the fork cannot reuse it, and a
pipeline of its own costs a certificate and a package name for a few users. Everyone
builds from this branch, as [Install from source](#install-from-source) describes.
Revisit when people outside the owner's team use the fork.

### Keep the usage contract at upstream's version (not v7, not "6.0.1")

Clients accept a server only when `4 <= version <= their own`, and
`contractVersion` is a number. The real blocker for upstream clients is the `bob`
literal, which the per-connection adaptation handles. When upstream bumps
`USAGE_CONTRACT_VERSION`, match it and re-check `credits`.

### No "estimated" marker on Bob's context meter (review 2)

It would need a contract flag or generic meter text for one provider. The docs say
the limit is assumed, and a context that outgrows the assumed window drops the
limit, so the meter never shows a false red ring. Revisit when ACP reports the
window, which removes the guess.

### Don't read a folder's `.bob/settings.json` model (review 2)

Bob 2.0.5 reads `session.model` only from the user's settings (bundle `bN` and
`a0e`), so honoring a folder model would disagree with Bob. The window is looked
up per turn because Bob re-reads the setting every turn.

### Accept two upstream-client edges (review 2)

A Bob-only project in the onboarding scan keeps an empty source list with Bob's
thread count, and importing it brings Bob threads the upstream app shows with a
fallback icon. The relabel modes count each Bobcoin as $1 in the chosen provider's
dollar totals. Both are opt-in or cosmetic; the setting defaults to hidden and
says so.

### Show the Bob usage setting row everywhere

The row also shows when this fork's client views an upstream server. Upstream
servers ignore the unknown settings key, so the row does nothing there; gating it
would need a server capability check for one row.

### Keep workspace keys as the server gives them (review 3)

Bob's catalog keys a workspace by the exact folder string, while clients compare
folders normalized. Normalizing the catalog's keys would break the registry's
exact-match check for a folder it already refreshed, so it would refresh that
folder, and read the gateway for a pinned team, on every turn start. Server-side
folders are already resolved, so the duplicate-slot case does not occur today.
Revisit if the registry starts passing unnormalized folders.

### Accept one turn at the router's window after an unreadable settings file (review 3)

If Bob's settings file cannot be read when a turn's usage is reported, that turn's
meter uses the router default's window. It corrects itself on the next turn, and
the outgrown-window guard prevents a false red ring.

### Leave the remaining nits

A project-only custom mode appears in every project's Mode list (it warns and runs
Agent elsewhere), which is intended because a model's options are the same in
every project. `snapshotForCwd` stamps a fresh `checkedAt`, harmless because the
registry calls it once per folder. The review 1 nits on the hide-only model, the
unused `customModels`, and a watchdog stay open: low value for their cost.

## Rebase checklist

Before: `git fetch origin && git merge-tree --write-tree --name-only HEAD origin/main`
lists the files that will conflict. After a rebase, if `pnpm-lock.yaml` changed,
run `vp i` before testing (upstream adds dependencies the dev server needs).

**Silent-drop sites.** A merge can lose these and still typecheck:

- `packages/contracts/src/usage.ts`: `"bob"` in `UsageProviderKind`, `credits` on
  `UsageBucket`.
- `packages/contracts/src/agentSessions.ts`: `"bob"` in `AgentSessionSource`.
- `packages/client-runtime/src/authorization/remote.ts`: `clientBobSupport=1`.
  Losing it makes every fork client look upstream, and Bob's usage and onboarding
  import vanish without an error. The expected URLs in `remote.test.ts` and
  `resolver.test.ts` include it.
- `apps/server/src/ws.ts`: `readClientSupportsBob` and the two adapted handlers
  (`serverGetUsageSummary`, `agentSessionsScan`).
- `apps/server/src/usage/UsageService.ts`: the Bob database block in `collectDirs`.
- `apps/server/src/usage/usageAggregation.ts`: records carrying `credits` skip
  public pricing. Losing it prices Bobcoins at public rates.
- `apps/server/src/project/AgentSessionScanner.ts` and `AgentSessionImporter.ts`:
  the Bob candidate and thread branches, and `bobTasksInThreads`.
- Registration: `builtInDrivers.ts`, `providerStatusCache.ts`, `serverSettings.ts`,
  `model-manifest.json`, and in contracts `settings.ts` (`BobSettings`,
  `bobUsageInUpstreamClients`, and `UPSTREAM_USAGE_PROVIDERS`, which the settings
  choices and the compatibility test derive from) and `model.ts`.
- `apps/server/src/provider/Layers/bobDatabase.ts`: the one read-only helper all three
  Bob readers share. Dropping its busy timeout degrades usage, import and the Usage
  page at once.
- Clients: web `providerDriverMeta.ts`, `Icons.tsx`, `providerIconUtils.ts`,
  `usageProviders.ts`, `WelcomeWizard.tsx` (the Bob icon column); mobile
  `ProviderIcon.tsx`, `usageProviders.ts`, `UsageLimitsPooled.tsx` (`DRIVER_LABEL`).

**Conflict hazards:** `ws.ts` around `makeWsRpcLayer`'s parameters; the scanner's
already-imported/duplicate helpers, which both the transcript and Bob paths use (port
an upstream change there into both); `ContextWindowMeter.tsx`; the `UsagePage.tsx` day
table; `UsageProviderSettings.tsx`, whose Bob row always renders among upstream's rows.

**After each rebase:** run `vp check` (seconds; upstream adds lint rules, and one
flagged Bob's icon after a rebase), then the Bob tests:

```bash
cd apps/server && vp test run src/provider/Layers/Bob src/provider/Layers/bob \
  src/provider/acp/Bob src/textGeneration/BobTextGeneration src/usage \
  src/upstreamClientCompatibility src/project
```

- `upstreamClientCompatibility.test.ts` decodes the adapted summary with
  upstream's provider list; if it fails, upstream's closed lists changed.
- If upstream changed `appendClientConnectionParams`, re-add `clientBobSupport=1`.
- If upstream bumped `USAGE_CONTRACT_VERSION`, keep ours equal to it and re-check
  `credits`.
- Live checks against a real Bob, which spend a few Bobcoins:
  `T3_BOB_ACP_PROBE=1 vp test run BobAdapterCliProbe BobAcpCliProbe`.

**Known environmental failures on macOS.** The macOS temp folder is a symlink (`/var`
→ `/private/var`), and some upstream tests compare a temp path with its resolved
form. In the full server suite that is 48 tests in 8 files (`ThreadSettlementReactor`,
`AgentSessionScanner`, `CursorProvider`, `AntigravityAdapter`,
`AntigravityInstallation`, `providerMaintenance`, `CodexDriver`, `entrypoint`), none of
them Bob code. They pass with a resolved temp folder, and CI runs on Linux:

```bash
TMPDIR=$(cd "$TMPDIR" && pwd -P) vp test run <files>
```

`apps/desktop/scripts/verify-preload-bundle.mjs` also fails on macOS: the preload's
macOS-only branch touches `window`, which the verifier's sandbox does not provide.
