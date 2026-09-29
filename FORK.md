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
  buckets, Bobcoin `amount` on limit windows, per-folder `usageLimits`, the meter's
  count when the limit is unknown), Bob branches in onboarding import and the
  usage scan, and a way back into onboarding import after setup (`/welcome?step=import`,
  from the command palette and Settings → General), since Bob is usually enabled later.
- **Check-ins and background commands** are the fork's features beyond Bob, for every
  provider. Their own files: `apps/server/src/checkIns/`, `apps/server/src/tmux/`,
  `persistence/ThreadCheckIns.ts` and `ThreadBackgroundCommands.ts`,
  `mcp/toolkits/checkIns/`, contracts `checkIns.ts` and `backgroundCommands.ts`,
  client-runtime `state/checkIns.ts`, web `useCheckInBannerItem.tsx` and
  `AgentCheckInsSettings.tsx`, mobile `ThreadCheckIns.tsx` and `CheckInHoursField.tsx`.
  Upstream files mostly carry registration lines, plus `export` on the terminal manager's
  `createTerminalSpawnEnv`. A few carry behavior: `ThreadBackgroundLiveness.ts` counts a
  running command as its thread's work, web `ChatView.tsx` hides the Monitoring banner
  while a command's row shows, and web `MessagesTimeline.tsx` and mobile `ThreadFeed.tsx`
  label the messages T3 sends. The [rebase checklist](#rebase-checklist) lists every such site.
- **Upstream clients** (the App Store app, app.t3.codes) cannot decode `bob` in the
  usage and onboarding-scan responses. This fork's clients add `clientBobSupport=1`
  to their connection; for any other client the server leaves `bob` out of the scan
  and adapts usage per the `bobUsageInUpstreamClients` setting (hidden by default).
  That is also why the usage contract keeps upstream's version number instead of
  bumping it: `bob` and `credits` only reach clients that asked for them. Since
  upstream pingdotgg/t3code#10076 (2026-09-26), upstream clients skip usage entries
  with unknown providers instead of failing, so clients built after it would
  tolerate `bob` on their own; the adaptation stays for the installed ones and for
  the "show Bob as another provider" setting.
- **Upstream's web client cannot drive Bob; upstream's mobile app can.** The web
  composer takes a built-in provider's on/off state from its copy of the server
  settings (`applyProviderInstanceSettings`), and upstream's settings schema strips
  `providers.bob`, so Bob reads as disabled: app.t3.codes shows Bob's threads and diffs
  but asks to enable a provider (tested over T3 Connect). The mobile app builds its
  model list from the server's provider snapshots, which say Bob is enabled: upstream
  `main`'s iOS app, built from source against this server, lists Bob in the model
  picker with a fallback icon and ran a Bob turn. The source-built desktop app drives
  Bob over T3 Connect (tested).

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

### Keep the history as an upstream-ready patch series

The branch is a series of `feat` and `docs` commits and one `refactor`, each one
logical change with its tests, docs and reasoning, as an upstream PR series for
Bob support would be split. On 2026-09-27 the fixes made during the three reviews were
folded into the commits they corrected (tag `bob-shell-pre-cleanup-2026-09-27`
keeps the history before that), and every commit typechecks on its own. Keep it
that way: a fix to fork code goes into the commit it corrects with `git commit
--fixup` and `git rebase --autosquash`, not on top; a fix to upstream code stays a
separate `fix` commit, as the effect-acp one does. `rerere.enabled` and
`rerere.autoupdate` are on so conflict resolutions replay across rebases.

### Don't open upstream PRs for the generic pieces yet (review 2)

Candidates, kept in the fork for now: the meter's count when the limit is unknown,
`UsageBucket.credits` as provider billing units, `amount` on limit windows,
per-folder `usageLimits`, the optional ACP `authMethodId`, `supportsCustomModels`,
and check-ins. Already open:
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

Also accepted: upstream apps replace a project's whole settings override when they
edit it, from a copy without `enableAgentCheckIns` and `checkInRepeatLimitHours`, so
that project's check-in overrides fall back to the environment's (on, 24 hours).

### Create the fork's tables in their repositories, not as numbered migrations

The migrator runs only ids above the highest one a database has applied. A fork
migration numbered 55 would make that database skip upstream's own 55 whenever it
lands; a high number would skip every later upstream migration. So a fork table is
created with `CREATE TABLE IF NOT EXISTS` when its repository layer starts
(`persistence/ThreadCheckIns.ts`), and a column added later is added there too, when
`PRAGMA table_info` lacks it (`persistence/ThreadBackgroundCommands.ts`). If upstream
takes the feature, it becomes a normal migration there.

### Keep check-ins and background commands inside T3 (owner, 2026-09-28)

An outside MCP server cannot start a turn, so it cannot wake an idle agent; only
the server that owns the thread can. Background commands stay in T3 too, for the
terminal view and Stop in the thread.

### Run background commands on T3's own tmux server (owner, 2026-09-28)

tmux keeps a command alive when T3 stops or is killed; a small Node wrapper in the pane
splits stdout and stderr into files and records the exit status in a file, so T3 learns
how a command ended even if it was down. The server's socket is `<stateDir>/tmux/t3.sock`
(the system's temp cleanup would remove one in `/tmp`). Commands need the thread in Full
access: they run outside every provider's sandbox. Reviewed by two agents before building.

Under systemd (which sets `INVOCATION_ID`), T3 starts its tmux server through `systemd-run
--user --scope`, so it lands outside the unit's cgroup and a restart of the unit, which by
default kills the whole cgroup, leaves tmux and every command in it alone. Without a user
systemd instance (a system unit, say) the scope fails, T3 logs a warning and starts tmux
directly; such a unit needs `KillMode=process`. launchd and the desktop app leave tmux alone.

### No desktop-app changes for a quit warning (owner, 2026-09-28)

A warning before quitting mid-turn would be a custom Electron change the fork does
not want to carry. Long work goes through background commands instead.

### Run Bob in tmux as a Bob instance setting (owner, 2026-09-28; reviews 4 and 5)

The owner asked for a separate `bob-tmux` provider, to test the two side by side. Both design
reviewers recommended a setting instead, and that is what shipped: **Where Bob runs** on a
Bob instance (`BobSettings.sessionHost`), with a second instance for tmux. It gives the same
side-by-side testing without a new driver kind, which would have needed its own manifest,
contracts, icons, usage and import branches, and upstream-client handling. Instances without
the setting behave exactly as before.

A small Node relay (`provider/acp/bobRelaySource.ts`) runs in a tmux pane and holds `bob acp`
on plain pipes; T3 talks to it over a 0600 Unix socket (`provider/acp/BobRelay.ts`), which the
ACP runtime sees as an ordinary child process, so effect-acp and `AcpSessionRuntime` are
unchanged. The relay gives T3's requests its own JSON-RPC ids, answers `initialize` and
`session/resume` itself for a T3 that attaches, keeps what Bob says until T3 acknowledges it,
and hands the answer to the running prompt to the next T3's prompt. On SIGTERM or SIGINT, T3
lets go of every relay running a turn before shutdown can cancel it; the desktop app stops
its backend with SIGTERM. At startup such a thread counts as a live session, so startup does
not mark its turn lost, and T3 attaches after activation, when the turn's events have a
subscriber. Bob still holds the previous server's MCP credential, which the relay keeps too;
the new server takes it back (`McpSessionRegistry.restore`) when it runs in the same
environment at the same address, so Bob keeps its T3 tools and stays. Otherwise T3 closes
that Bob quietly once the adopted turn ends, and the next message resumes the task on a
fresh Bob. Idle relays, and relays of instances since removed, disabled or moved off tmux,
are stopped at startup.

The attach relies on `AcpSessionRuntime.start()` sending only `initialize` and
`session/resume` for Bob. Recheck `bobRelaySource.ts` if upstream adds a handshake request.

### Ack Bob relay output on receipt (reviews 6 and 7)

T3 acknowledges what it reads from a Bob relay at once, so the relay drops its copy before
T3 has persisted it. A restart or crash in that moment can leave a fragment of streamed
text, or an event in flight, out of the thread; Bob's requests and the prompt's answer are
still replayed, and Bob's task keeps the whole conversation. Acking after persistence
needs a persisted watermark or replay deduplication, which changes relay and ingestion
semantics for a tail fragment.

### No write backpressure in the background-command wrapper (review 7)

The wrapper writes a command's output to its log files without pausing the command when
the writes fall behind. It also writes to its tmux pane, a synchronous TTY that already
paces it, and measured queues stayed around 8 MiB for 32 MiB to 1 GiB of output. Pausing
would instead risk losing output still in the pipe when the post-exit drain ends, on the
same slow disks it targets.

### Keep hiding the Monitoring banner while a command's row shows (reviews 6 and 7)

Liveness does not tell a provider's own watch loop from T3's command, so an idle thread
running both loses the banner's thread-wide Stop until the command ends, and for the
seconds between a command's end and the turn its end notice starts, its row has no Stop
either. Telling them apart needs new state on the wire, and showing both brings back two
Stops with different scope in the common case. Sending a message and using the composer's
Stop, or stopping the command, covers the overlap.

### Deliver T3's notices at least once (reviews 7 and 8)

T3 records a notice as told only after its message is in, so a crash or a failed database
write between the two leaves the notice due. A retry of the same notices reuses the
message's id and is dropped, but if another notice falls due meanwhile the retry is a new
message that repeats the earlier ones, in a turn the new notice needed anyway. Holding a
batch together across retries needs a pending-batch record on both notice tables, and
recording before sending would lose notices instead, which is worse than an agent reading
one twice.

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

### Pool Bob SSO instances on one environment as one account (review 7)

Instances signed in with IBM SSO on one machine read the same `~/.bob` login, so
Usage > Limits shows their Bobcoins as one budget. An instance whose environment points
`HOME` at a different IBM login would wrongly share it. Keying by Bob's user id instead
would count a team's budget twice, since Bobcoin budgets belong to teams, and the right
key, the team, is not in the provider snapshot. Separate logins per instance on one
machine are rare enough to keep the shared key.

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
  the Bob candidate and thread branches, and the importer's `bobTasksInThreads`.
- Registration: `builtInDrivers.ts`, `providerStatusCache.ts`, `serverSettings.ts`,
  `model-manifest.json`, and in contracts `settings.ts` (`BobSettings`,
  `bobUsageInUpstreamClients`, and `UPSTREAM_USAGE_PROVIDERS`, which the settings
  choices and the compatibility test derive from) and `model.ts`.
- `apps/server/src/provider/Layers/bobDatabase.ts`: the one read-only helper all three
  Bob readers share. Dropping its busy timeout degrades usage, import and the Usage
  page at once.
- Check-ins: `server.ts` (`CheckInScheduler.layer`), `OrchestrationReactor.ts`
  (starting it; without that nothing is ever delivered), `McpHttpServer.ts` (the
  toolkit), `ProviderService.ts` (the `check-ins` capability), `ServerEnvironment.ts`
  (`threadCheckIns` and `threadBackgroundCommands`, which clients check before
  subscribing), `BackgroundCommands.watch` in `OrchestrationReactor.ts`, web `ChatView.tsx`,
  `MessagesTimeline.tsx` and `IntegrationsSettings.tsx`, mobile
  `ThreadDetailScreen.tsx`, `ThreadFeed.tsx` and `SettingsServerControlsRouteScreen.tsx`.
- Background commands: `ThreadBackgroundLiveness.ts` (`setServerWork`, and its part in
  `getThreadBackgroundLiveness`); without it a thread with a running command looks idle
  and can settle.
- Bob in tmux: `ProviderService.ts` saves the resume cursor on `turn.completed` for `bob`
  as it does for `claudeAgent`; without it a Bob turn finished after a restart leaves the
  cursor behind.
- Clients: web `providerDriverMeta.ts`, `Icons.tsx`, `providerIconUtils.ts`,
  `usageProviders.ts`, `WelcomeWizard.tsx` (the Bob icon column, and `initialStep` for
  `/welcome?step=import`), `welcome.tsx`, `CommandPalette.tsx` and `SettingsPanels.tsx` (the
  import entries); mobile
  `ProviderIcon.tsx`, `usageProviders.ts`, `UsageLimitsPooled.tsx` (`DRIVER_LABEL`).

**Conflict hazards:** `ws.ts` around `makeWsRpcLayer`'s parameters; the scanner's
already-imported/duplicate helpers, which both the transcript and Bob paths use (port
an upstream change there into both); `ContextWindowMeter.tsx`; the `UsagePage.tsx` day
table; `UsageProviderSettings.tsx`, whose Bob row always renders among upstream's rows.

**After each rebase:** run `vp check` (seconds; upstream adds lint rules, and one
flagged Bob's icon after a rebase), then the fork's server tests:

```bash
cd apps/server && vp test run src/provider/Layers/Bob src/provider/Layers/bob \
  src/provider/Drivers/Bob src/provider/acp/Bob src/textGeneration/BobTextGeneration \
  src/usage src/upstreamClientCompatibility src/project src/checkIns src/tmux \
  src/mcp/toolkits/checkIns src/mcp/McpSessionRegistry \
  src/persistence/ThreadBackgroundCommands src/orchestration/ThreadBackgroundLiveness \
  src/orchestration/Layers/OrchestrationReactor src/provider/Layers/ProviderService
```

- `upstreamClientCompatibility.test.ts` decodes the adapted summary with
  upstream's provider list; if it fails, upstream's closed lists changed.
- If upstream changed `appendClientConnectionParams`, re-add `clientBobSupport=1`.
- If upstream bumped `USAGE_CONTRACT_VERSION`, keep ours equal to it and re-check
  `credits`.
- Live checks against a real Bob, which spend a few Bobcoins:
  `T3_BOB_ACP_PROBE=1 vp test run BobAdapterCliProbe BobAcpCliProbe`.

**macOS test runs.** The fork's first two commits make upstream's checks pass on macOS,
where CI does not run: tests use the resolved temp folder
(`packages/shared/src/testing/longTempDir.ts`), as upstream already does on Windows, and
the desktop preload check loads the preload as every platform
(`apps/desktop/scripts/verify-preload-bundle.mjs`). Drop either if upstream takes the same
fix.
