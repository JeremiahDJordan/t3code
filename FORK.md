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

## Decisions

Owner decisions, with the review that prompted them. "Review 1" and "review 2" are
the adversarial reviews of 2026-09-24 and 2026-09-25.

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
  `bobUsageInUpstreamClients`) and `model.ts`.
- Clients: web `providerDriverMeta.ts`, `Icons.tsx`, `providerIconUtils.ts`,
  `usageProviders.ts`, `WelcomeWizard.tsx` (the Bob icon column); mobile
  `ProviderIcon.tsx`, `usageProviders.ts`, `UsageLimitsPooled.tsx` (`DRIVER_LABEL`).

**Conflict hazards:** `ws.ts` around `makeWsRpcLayer`'s parameters; the scanner's
already-imported/duplicate helpers, which both the transcript and Bob paths use (port
an upstream change there into both); `ContextWindowMeter.tsx`; the `UsagePage.tsx` day
table.

**After each rebase:**

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

**Known environmental failure:** `AgentSessionScanner.test.ts` "excludes sandboxes
reached through a symlink into the worktrees dir" fails on macOS on upstream `main`
too (`/var` resolves to `/private/var`); it is not a Bob regression.
