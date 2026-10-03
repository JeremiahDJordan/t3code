# Bob Shell fork of T3 Code

This branch (`bob-shell` on `JeremiahDJordan/t3code`) is upstream T3 Code
(`pingdotgg/t3code`) plus IBM Bob Shell as a provider, driven over ACP with
`bob acp`, and check-ins and background commands for every provider. It is kept as a
fork and rebased onto upstream `main`; the user guide is
[docs/user/providers-bob.md](docs/user/providers-bob.md).

This file records the decisions behind the fork's shape, including review
recommendations it deliberately does not follow, so later reviews and rebases
don't reopen them without new information. Add to it when a decision changes.

The fork moved to upstream's orchestration V2 (pingdotgg/t3code#2829) on 2026-10-02 by
rebuilding its features on the new base rather than porting them. Tag
`bob-shell-pre-orchestration-v2` keeps the branch as it was on V1.

## How the fork meets upstream

- **Bob-only files** hold nearly all behavior:
  `apps/server/src/orchestration-v2/Adapters/BobAdapterV2.ts`,
  `apps/server/src/provider/**/Bob*` and `bob*.ts`, `provider/taskTranscript.ts`,
  `orchestration-v2/legacy/bobThreadRelink.ts`, `apps/server/scripts/acp-mock-bob.ts`,
  `usage/bobUsageReader.ts`, `project/bobTasksInThreads.ts`,
  `textGeneration/BobTextGeneration.ts`, `upstreamClientCompatibility.ts`, and
  `docs/user/providers-bob.md`.
- **Upstream files** carry registration lines (driver, icons, labels, settings,
  provider lists), a few generic features Bob needed (Bobcoin `credits` on usage
  buckets, Bobcoin `amount` on limit windows, per-folder `usageLimits`, the meter's
  count when the limit is unknown, Retry for a retryable failure, a provider's setup
  error shown when its session cannot open), Bob branches in onboarding import and the
  usage scan, one call from the V1 thread importer to the re-link step, and a way back
  into onboarding import after setup
  (`/welcome?step=import`, from the command palette and Settings → General), since Bob
  is usually enabled later. Upstream's `AcpAdapterV2.ts` has no fork lines.
- **Check-ins and background commands** are the fork's features beyond Bob, for every
  provider, along with `watch_thread` and `cancel_wait`. Their own files:
  `apps/server/src/checkIns/`, `apps/server/src/tmux/`, `persistence/ThreadCheckIns.ts` and
  `ThreadBackgroundCommands.ts`, `mcp/toolkits/checkIns/`, contracts `checkIns.ts` and
  `backgroundCommands.ts`, client-runtime, web and mobile `state/checkIns.ts`, web
  `useCheckInBannerItem.tsx` and `AgentCheckInsSettings.tsx`, mobile `ThreadCheckIns.tsx`
  and `CheckInHoursField.tsx`. Upstream files carry registration lines, `export` on the
  terminal manager's `createTerminalSpawnEnv`, and the optional `ThreadSettlementHolds`
  service in `ThreadSettlementService.ts`, through which a running command keeps its
  thread from settling. Web `Sidebar.tsx` and `LegacySidebar.tsx`, and mobile
  `thread-list-v2-items.tsx`, show a thread with a running command as Waiting. The
  [rebase checklist](#rebase-checklist) lists every such site.
- **Clients.** A V2 server answers HTTP 426 to a client without orchestration protocol 2:
  the App Store app before 2.0.0, older app.t3.codes builds, and every build of this fork
  from before the move. Rebuild the desktop and mobile apps from this branch.
- **Upstream clients** that can connect cannot decode `bob` in the onboarding scan, a
  closed list. This fork's clients add `clientBobSupport=1` to their connection; for any
  other client the server leaves Bob's sources out of the scan and keeps a project's fork
  settings when the client writes that project's row. Usage needs no adaptation: upstream
  clients skip usage entries with unknown providers (pingdotgg/t3code#10076), which is
  also why the usage contract keeps upstream's version number. Not yet retested on V2:
  whether app.t3.codes and the App Store 2.0 app can drive Bob. On V1, the web client read
  Bob as disabled and the mobile app ran Bob turns.

## Install from source

The fork publishes no builds, so everyone builds this branch. You need git, Node 24,
[Vite+](README.md#install-vp), and Bob Shell 2.0.5 or later on the machine that runs
the server. The desktop app also needs stable Rust (`rustup`, or `mise install
rust@stable` and prefix the build with `mise exec rust@stable --`). Background
commands need tmux 3.2 or later.

```bash
git clone -b bob-shell https://github.com/JeremiahDJordan/t3code.git
cd t3code
cp .env.example .env  # T3 Connect's public configuration; skip it to leave T3 Connect off
vp i
```

**Desktop app (macOS, Apple silicon).** `vp run dist:desktop:dmg:arm64` builds
`release/T3-Code-<version>-arm64.dmg` in a few minutes. Open it and drag T3 Code
(Alpha) to Applications, or run `scripts/install-desktop-macos.sh` to replace the
installed app. The app is ad-hoc signed; on the Mac that built it, macOS opens it
without a prompt. A copy downloaded or sent to another Mac is quarantined and needs
**Open Anyway** in System Settings → Privacy & Security the first time.

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

The first start on V2 copies `state.sqlite` to `statev2.sqlite` and imports its threads;
the old file is kept. A migrated Bob thread continues its Bob task.

## Decisions

Owner decisions, with the review that prompted them. Reviews 1, 2 and 3 are the
adversarial reviews of 2026-09-24, and of the morning and afternoon of 2026-09-25.

### Rebuild on V2 rather than port (owner, 2026-10-02)

V2 replaced the provider adapters, ingestion and the client thread model, and does several
things the fork had built itself: subagents are child threads every app opens, provider
switching resumes a native thread, the server queues follow-ups, and `t3_thread_*` tools let
agents list, read, start and message threads. So the fork's features were rebuilt on V2,
and these were dropped: the effect-acp error fix (upstream's `normalizeAcpJsonRpcError`
covers it, so pingdotgg/t3code#13451 is obsolete), the ACP `authenticate` skip, the session
reaper fix, compatible-instance resume, the mobile instance picker, Bob's queue and steer,
the subagent step viewer and **Subagent steps in other apps**, the Monitoring status and
banner hunks, `ThreadLink` and `agentMessageSender`, the `check-ins` and `agent-threads`
MCP capabilities, and the `bobUsageInUpstreamClients` setting.

### Drive Bob through upstream's ACP adapter, with Bob-only wrappers (owner, 2026-10-02)

`BobAdapterV2.ts` is a flavor of upstream's `AcpAdapterV2` (modes, approvals, titles,
subagents, Plan) plus two wrappers around it. `wrapBobRuntime` wraps the ACP runtime: it
fails an empty reply, reports usage as an ACP `usage_update` with Bobcoins as its cost,
captures the plan from Bob's last reply, replays a finished subagent's steps, steers Bob,
and takes over a prompt Bob kept going in tmux. `wrapBobSession` wraps the V2 session: it
rewinds Bob's task on rollback, moves the task when a thread changes folder, implements
`steerTurn`, says when a turn's picked mode is missing, and gives Bob's sign-in and license
refusals their setup text. Flavor hooks in `AcpAdapterV2.ts` would be smaller, but that
file is about 8,000 lines that upstream changes often, and wrappers keep it free of fork
lines. Revisit if upstream takes such hooks.

The wrappers lean on upstream behavior a merge can change without a type error; the
[rebase checklist](#rebase-checklist) names it, and `BobAdapterV2.test.ts` covers each part:

- `session/load` goes to Bob's `session/resume`, because upstream calls `loadSession`
  when an agent advertises it and never reads `preferResumeSession`.
- A subagent's steps reach its child thread as notifications for a stand-in child session
  (`bob-subagent:<toolCallId>`), which upstream projects into the child thread like any
  child session's updates.
- Modes are set through `runtime.setMode`, which falls back to `session/set_mode` when Bob
  reports modes but no mode option. A picked mode Bob lacks is skipped silently; the
  wrapper's notice takes the turn's ids from its `provider_turn.updated` event and the
  ordinal before the adapter's first item (`ordinal * 100`).
- A provider that declares `supportsActiveSteering` gets `steerTurn` calls for Steer
  (`CommandPolicy`'s `steer_active`), and a steer that misses its turn is sent again as a
  follow-up (`EffectWorker`'s `turnCompleted`).
- A continuation offered through `ProviderContinuationRequests` arrives as a message from the
  agent with `creationSource: "provider"`, which the wrapper reads as a wake.

### Test Bob with its own mock agent

Upstream's mock ACP agent speaks only protocol 2 and Bob 2.0.5 speaks protocol 1, so
`apps/server/scripts/acp-mock-bob.ts` mocks Bob alone, with its resume, rewind, export and
import extensions. This reverses review 1 and 2's "one shared mock agent": that choice
assumed one protocol.

### Run Bob in tmux as a Bob instance setting (owner, 2026-09-28; reviews 4 and 5)

**Where Bob runs** on a Bob instance (`BobSettings.sessionHost`) chooses tmux, with a second
instance to compare the two. A setting gives side-by-side testing without a new driver kind,
which would need its own manifest, contracts, icons, usage and import branches. The V2 base
first shipped without it (owner, 2026-10-02); it came back on 2026-10-03.

A small Node relay (`provider/acp/bobRelaySource.ts`) runs in a tmux pane and holds `bob acp`
on plain pipes; T3 talks to it over a 0600 Unix socket (`provider/acp/BobRelay.ts`), which the
ACP runtime sees as an ordinary child process, so effect-acp, `AcpSessionRuntime` and
`AcpAdapterV2` are unchanged. On SIGTERM or SIGINT, T3 lets go of every relay running a
prompt before shutdown can cancel it; the desktop app stops its backend with SIGTERM.

V2 cancels every run it finds at startup and has no way to keep one going, so the turn
finishes in a new run. Each tmux instance looks through its relays once per process:

- relays of instances no longer running Bob in tmux, of other builds, and idle ones stop;
- one still holding a prompt is kept for Bob's task, and once the server is live
  (`ServerActivation`, since recovery would cancel an earlier run) the driver offers a
  continuation for its thread.

That run opens a session on the task, and its runtime attaches to the relay instead of
starting Bob. The relay answers `initialize`, `session/resume` and mode or model changes
itself, binds the run's prompt to Bob's, shows the prompt's earlier tool calls again, and
replays what Bob said meanwhile. Tool call ids get a suffix new for each attach, as their
old ids belong to the cancelled run and a second restart would reuse the first adoption's; a
subagent's steps are still read from Bob's database under the id Bob gave it. A user's
message, or upstream's restart continuation, takes the prompt over the same way, then sends
its own text unless it only asks Bob to go on.

V2 issues a new MCP credential per session and has no way to give back the old one, so Bob's
T3 tools fail until the adopted turn ends. The Bob that ran it then stops, and the next turn
starts a fresh Bob with the new credential.

### Ack Bob relay output on receipt (reviews 6 and 7)

T3 acknowledges what it reads from a Bob relay at once, so the relay drops its copy before
T3 has persisted it. A restart or crash in that moment can leave a fragment of streamed
text, or an event in flight, out of the thread; Bob's requests and the prompt's answer are
still replayed, and Bob's task keeps the whole conversation. Acking after persistence
needs a persisted watermark or replay deduplication.

### Steer Bob natively (owner, 2026-10-03)

V2 steers an ACP provider by interrupting its turn and starting again, which cancelled a
tool call Bob was running. Bob declares active steering instead: a steer waits for Bob's
running tool calls, cancels the prompt and sends the message as Bob's next prompt in the same
turn. Bob records tool results before it asks the model again, so only the reply in progress
is lost. Stop still cancels at once and drops a waiting steer.

### Show a provider's setup error when its session cannot open (2026-10-03)

`ProviderSetupError` is safe setup text by contract, but a failed run showed only "The
provider session could not be opened", or the generic error's own message on the start
path. `ProviderFailure.ts` now finds a `ProviderSetupError` in the cause, and
`ProviderTurnStartService.ts` prefers its text. Bob wraps its sign-in and license refusals in
one. Generic and small, so a candidate for upstream.

### Show a thread with a running background command as Waiting (2026-10-03)

V2's Waiting status reads the shell's `pendingBackgroundTasks`, which belong to providers:
recovery clears them, settlement and the Stop-background-work banner act on them, and the
shell stream resumes by sequence. So T3's commands stay out of it. An environment-wide
`subscribeBackgroundCommandThreads` stream names the threads with a running command, and the
thread lists show such an idle thread as Waiting; the legacy sidebar does it with a stand-in
roster entry.

### Retry resends the message (owner, 2026-10-02)

A run its provider failed as retryable offers **Retry** on its failure row, on web and
mobile, which sends the run's message again as a manual continuation of that run. It is
generic: any provider can mark a failure retryable, and a usage limit never counts, since it
resumes at its reset. Bob marks an empty reply retryable.

### Re-link migrated Bob threads to their tasks (owner, 2026-10-02)

Upstream's migration keeps transcripts but drops provider sessions, so a migrated thread's
next message would start a new Bob task with a summary of the transcript. After each import,
`bobThreadRelink.ts` gives a migrated Bob thread a provider thread on the task its V1
session named. Upstream still sends a migrated thread's first message with its imported
history; the fork's `hasNativeThread` check in `Orchestrator.ts` skips that for a thread
that already has a native thread, as upstream's queued path does, so Bob does not read its
history twice.

### Keep check-ins and background commands inside T3 (owner, 2026-09-28)

An outside MCP server cannot start a turn, so it cannot wake an idle agent; only
the server that owns the thread can. Background commands stay in T3 too, for the
terminal view and Stop in the thread.

### Keep the fork's check-ins next to `schedule_task` (owner, 2026-10-02)

Upstream's `schedule_task` repeats on a schedule and steers a running turn, which on Bob
interrupts it. Check-ins are one-time or repeat until an end time, and never interrupt:
every notice is a `message.dispatch` queued after the active turn, with a command id derived
from its notices.

### Keep only `watch_thread` and `cancel_wait` of agent threads (2026-10-02)

V2's `t3_thread_*` tools list, read, start and message threads, so the fork's tools for
those, their rate and depth limits, the `enableAgentThreads` setting and the phase-2
cross-environment design are gone. V2's `t3_thread_wait` holds the turn open until the
other thread finishes; `watch_thread` is a check-in that tells the agent in a new turn
instead, so the agent can end its turn. It reaches threads in the same project, as V2's
tools do.

### Run background commands on T3's own tmux server (owner, 2026-09-28)

tmux keeps a command alive when T3 stops or is killed; a small Node wrapper in the pane
splits stdout and stderr into files and records the exit status in a file, so T3 learns
how a command ended even if it was down. The server's socket is `<stateDir>/tmux/t3.sock`
(the system's temp cleanup would remove one in `/tmp`). Commands need the thread in Full
access: they run outside every provider's sandbox.

Under systemd (which sets `INVOCATION_ID`), T3 starts its tmux server through `systemd-run
--user --scope`, so it lands outside the unit's cgroup and a restart of the unit, which by
default kills the whole cgroup, leaves tmux and every command in it alone. Without a user
systemd instance (a system unit, say) the scope fails, T3 logs a warning and starts tmux
directly; such a unit needs `KillMode=process`. launchd and the desktop app leave tmux alone.

A running command holds its thread from settling automatically, and thread lists show the
thread as Waiting.

### No write backpressure in the background-command wrapper (review 7)

The wrapper writes a command's output to its log files without pausing the command when
the writes fall behind. It also writes to its tmux pane, a synchronous TTY that already
paces it, and measured queues stayed around 8 MiB for 32 MiB to 1 GiB of output. Pausing
would instead risk losing output still in the pipe when the post-exit drain ends, on the
same slow disks it targets.

### Deliver T3's notices at least once (reviews 7 and 8)

T3 records a notice as told only after V2 accepts its message, so a crash or a failed
database write between the two leaves the notice due. A retry of the same notices reuses
the command id and is not sent twice, but if another notice falls due meanwhile the retry
is a new message that repeats the earlier ones. Holding a batch together across retries
needs a pending-batch record, and recording before sending would lose notices instead,
which is worse than an agent reading one twice.

### No desktop-app changes for a quit warning (owner, 2026-09-28)

A warning before quitting mid-turn would be a custom Electron change the fork does
not want to carry. Long work goes through background commands instead.

### Create the fork's tables in their repositories, not as numbered migrations

The migrator runs only ids above the highest one a database has applied. A fork
migration numbered 55 would make that database skip upstream's own 55 whenever it
lands; a high number would skip every later upstream migration. So a fork table is
created with `CREATE TABLE IF NOT EXISTS` when its repository layer starts
(`persistence/ThreadCheckIns.ts`), and a column added later is added there too, when
`PRAGMA table_info` lacks it (`persistence/ThreadBackgroundCommands.ts`). The V2 migration
copies the V1 database, so both tables carry over. If upstream takes the feature, it
becomes a normal migration there.

### Let a thread switch between Bob instances on one task database (owner, 2026-10-01)

A Bob session is a task in Bob's task database, and any instance reading that database
resumes it, whatever it signs in with. So Bob's continuation key is the database path,
not the instance: a thread moves between an SSO instance and an API-key instance, which
is how the owner keeps working when one account runs out of Bobcoins. The turns after a
switch bill the other account. An instance whose environment sets another `HOME` reads
another database and stays separate.

### Pool Bob SSO instances on one environment as one account (review 7)

Instances signed in with IBM SSO on one machine read the same `~/.bob` login, so
Usage > Limits shows their Bobcoins as one budget. An instance whose environment points
`HOME` at a different IBM login would wrongly share it. Keying by Bob's user id instead
would count a team's budget twice, since Bobcoin budgets belong to teams, and the right
key, the team, is not in the provider snapshot.

### No "estimated" marker on Bob's context meter (review 2)

It would need a contract flag or generic meter text for one provider. The docs say
the limit is assumed, and a context that outgrows the assumed window drops the
limit, so the meter never shows a false red ring. Revisit when ACP reports the
window, which removes the guess.

### Don't read a folder's `.bob/settings.json` model (review 2)

Bob 2.0.5 reads `session.model` only from the user's settings, so honoring a folder
model would disagree with Bob. The window is looked up per turn because Bob re-reads
the setting every turn. If Bob's settings file cannot be read then, that turn's meter
uses the router default's window (review 3); the next turn corrects it.

### Keep workspace keys as the server gives them (review 3)

Bob's catalog keys a workspace by the exact folder string, while clients compare
folders normalized. Normalizing the catalog's keys would break the registry's
exact-match check for a folder it already refreshed, so it would refresh that
folder, and read the gateway for a pinned team, on every turn start.

### Accept two upstream-client edges (review 2)

A Bob-only project in the onboarding scan keeps an empty source list with Bob's
thread count, and importing it brings Bob threads the upstream app shows with a
fallback icon.

Upstream apps replace a project's whole settings override when they edit it, from a copy
without the fork's project keys. So when a client without `clientBobSupport` writes or
resets a project's row, the server keeps that row's `enableAgentCheckIns` and
`checkInRepeatLimitHours` (`upstreamClientCompatibility.ts`; review 9). A new fork-only
project setting goes in its `FORK_PROJECT_SETTING_KEYS`.

### Don't restructure upstream code for the fork (reviews 1 and 2)

Declined: a seam or reader interface in onboarding import or the usage scan; a
per-connection service in `ws.ts`; moving Bob cases out of shared test files into
`*.bob.test.ts`; collapsing the opt-in provider lists in `serverSettings.ts` and
`providerStatusCache.ts`. Bob follows the shapes the other providers already use, so
each hunk reads like upstream's own code and could go upstream as is. Revisit when
rebases conflict repeatedly in the same place, and then add a seam there only.

Changes that remove fork lines without adding structure are always worth making
(review 2): `ChatView.tsx` computes the usage-limits folder in place, and one
`bobDatabase.ts` helper serves every Bob SQLite reader.

### Keep editing shared docs and the provider lists (reviews 1 and 2)

Bob is a provider like the others, so the pages that list providers name it too:
`AGENTS.md`, `README.md`, `usage.md`, `welcome-wizard.md`, `permission-modes.md`,
`install.md`, `remote-access.md`. Moving those sentences into the Bob page would
leave the shared lists wrong.

### Keep Bob out of the marketing site (`apps/marketing`)

The fork's site is never deployed; the site describes upstream's product.
Revisit when Bob support goes upstream.

### Keep the history as an upstream-ready patch series

The branch is a series of `feat`, `fix`, `test` and `docs` commits, each one logical
change with its tests, docs and reasoning, as an upstream PR series for Bob support
would be split. Keep it that way: a fix to fork code goes into the commit it corrects
with `git commit --fixup` and `git rebase --autosquash`, not on top. `rerere.enabled`
and `rerere.autoupdate` are on so conflict resolutions replay across rebases.

### Don't open upstream PRs for the generic pieces yet (review 2)

Candidates, kept in the fork for now: the meter's count when the limit is unknown,
`UsageBucket.credits` as provider billing units, `amount` on limit windows,
per-folder `usageLimits`, Retry for retryable failures, `ThreadSettlementHolds`, the
`hasNativeThread` check, and check-ins. Revisit when the owner decides to upstream.

### Ship from source only

Upstream's release workflow signs and notarizes with upstream's Apple certificate and
publishes `t3` to npm under upstream's name, so the fork cannot reuse it, and a
pipeline of its own costs a certificate and a package name for a few users. Everyone
builds from this branch, as [Install from source](#install-from-source) describes.
Revisit when people outside the owner's team use the fork.

### Known gaps

- Running out of Bobcoins fails the turn instead of entering V2's Limited state with a
  resume at the month's reset. Mapping it to `usage_limit` needs the error's exact shape
  from a live run.
- Bob's T3 tools fail during a turn that finishes after a restart in tmux (see above).

## Rebase checklist

Before: `git fetch origin && git merge-tree --write-tree --name-only HEAD origin/main`
lists the files that will conflict. After a rebase, if `pnpm-lock.yaml` changed,
run `vp i` before testing (upstream adds dependencies the dev server needs).

**Silent-drop sites.** A merge can lose these and still typecheck:

- Bob on V2, in upstream's `AcpAdapterV2.ts`: calling `loadSession` when the agent
  advertises it, child-session notifications projected into a subagent's child thread,
  `runtime.setMode` falling back to `session/set_mode`, and `usage_update` reaching the
  provider thread's `contextUsage` with its `cost`. Elsewhere: `steerTurn` for a provider
  with `supportsActiveSteering`, a continuation's `creationSource: "provider"`, and
  `ServerActivation`. `BobAdapterV2.test.ts` fails if one changes, apart from activation,
  which only the live restart check below covers.
- `ProviderFailure.ts`: the `ProviderSetupError` case, and `providerSetupDetail` in
  `ProviderTurnStartService.ts`; losing them turns Bob's sign-in and license messages back
  into "could not be opened".
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`: the
  `relinkMigratedBobThreads` call. `Orchestrator.ts`: `hasNativeThread` in
  `shouldPrepareLegacyImportHandoff`; losing it sends a re-linked thread's history twice.
- Retry: in `Orchestrator.ts`, `isRetryableRunFailure` in the `manualContinuationOfRunId`
  check; without it the server refuses every Retry.
- `packages/contracts/src/usage.ts`: `"bob"` in `UsageProviderKind`, `credits` on
  `UsageBucket`. `packages/contracts/src/agentSessions.ts`: `"bob"` in `AgentSessionSource`.
- `packages/client-runtime/src/authorization/remote.ts`: `clientBobSupport=1`.
  Losing it makes every fork client look upstream, and Bob's onboarding import vanishes
  without an error. The expected URLs in `remote.test.ts` and `resolver.test.ts` include it.
- `apps/server/src/ws.ts`: `readClientSupportsBob`, the adapted `agentSessionsScan`, and
  `serverUpdateSettings`, which adapts the patch before both of its branches; losing it lets
  an upstream app quietly turn a project's check-ins back on.
- `apps/server/src/usage/UsageService.ts`: the Bob database block in `collectDirs`.
  `usage/usageAggregation.ts`: records carrying `credits` skip public pricing. Losing it
  prices Bobcoins at public rates.
- `apps/server/src/project/AgentSessionScanner.ts` and `AgentSessionImporter.ts`:
  the Bob candidate and thread branches, and the importer's `bobTasksInThreads`.
- Registration: `builtInDrivers.ts`, `providerStatusCache.ts`, `serverSettings.ts`,
  `model-manifest.json`, and in contracts `settings.ts` (`BobSettings`) and `model.ts`.
- `apps/server/src/provider/Layers/bobDatabase.ts`: the one read-only helper every
  Bob reader shares. Dropping its busy timeout degrades usage, import, the Usage page
  and subagent steps at once.
- Check-ins and background commands: `server.ts` (`CheckInsLayerLive`, and
  `CheckInsWorkerLive`, without which nothing is ever delivered), the
  `settlementHoldsLayer` on `ThreadSettlementWorkerLive` (the hold is optional, so losing it
  lets a thread settle mid-command), the `useRunsBackgroundCommand` lines in web
  `Sidebar.tsx` and `LegacySidebar.tsx` and mobile `thread-list-v2-items.tsx` (the Waiting
  status), `McpHttpServer.ts` (the toolkit), `ServerEnvironment.ts`
  (`threadCheckIns` and `threadBackgroundCommands`, which clients check before
  subscribing), web `ChatView.tsx` (the banner items) and `IntegrationsSettings.tsx`, mobile
  `ThreadDetailScreen.tsx`, `ThreadFeed.tsx` and `SettingsServerControlsRouteScreen.tsx`.
- Clients: web `providerDriverMeta.ts`, `Icons.tsx`, `ProviderInstanceIcon.tsx`,
  `usageProviders.ts`, `ChatComposer.tsx` (`ComposerBudgetMeter`), `WelcomeWizard.tsx` (the
  Bob icon column, and `initialStep` for `/welcome?step=import`), `welcome.tsx`,
  `CommandPalette.tsx` and `SettingsPanels.tsx` (the import entries), and the Retry wiring in
  `ChatView.tsx` and `MessagesTimeline.tsx`; mobile `ProviderIcon.tsx`, `usageProviders.ts`,
  `UsageLimitsPooled.tsx` (`DRIVER_LABEL`), and Retry in `ThreadRouteScreen.tsx`,
  `thread-work-log.tsx` and `use-thread-composer-state.ts`.

**Conflict hazards:** `ws.ts` around `makeWsRpcLayer`'s parameters; the scanner's
already-imported/duplicate helpers, which both the transcript and Bob paths use (port
an upstream change there into both); `ContextWindowMeter.tsx`; the `UsagePage.tsx` day
table; `Orchestrator.ts` near `manualContinuationOfRunId`.

**After each rebase:** run `vp check` (seconds; upstream adds lint rules), then the
fork's tests:

```bash
cd apps/server && vp test run src/orchestration-v2/Adapters/BobAdapterV2 \
  src/orchestration-v2/legacy/bobThreadRelink src/orchestration-v2/Orchestrator.migration \
  src/orchestration-v2/ThreadSettlementService src/provider/Layers/Bob src/provider/Layers/bob \
  src/provider/acp/Bob src/provider/providerUsageLimits src/textGeneration/BobTextGeneration \
  src/usage src/upstreamClientCompatibility src/project src/checkIns src/tmux \
  src/mcp/toolkits/checkIns src/persistence/ThreadBackgroundCommands \
  src/orchestration-v2/ProviderFailure src/serverSettings
cd ../.. && vp test run packages/client-runtime/src/state/threadExecution \
  packages/client-runtime/src/state/checkIns packages/client-runtime/src/authorization \
  packages/shared/src/usage
```

- `upstreamClientCompatibility.test.ts` decodes the adapted scan with upstream's
  provider list; if it fails, upstream's closed lists changed.
- If upstream changed `appendClientConnectionParams`, re-add `clientBobSupport=1`.
- If upstream bumped `USAGE_CONTRACT_VERSION`, keep ours equal to it and re-check
  `credits`.
- The tmux tests in `BobAdapterV2.test.ts` need tmux and skip without it.
- A live turn against a real Bob spends a few Bobcoins. These cover the parts the mock
  cannot:
  - a migrated thread's first message;
  - a subagent;
  - **Edit from here** in a git project;
  - a steer while Bob runs a command;
  - a dev-server restart while a tmux instance's Bob runs a command (touch a server file,
    and the turn should finish in a new run).

**macOS test runs.** The fork's first two commits make upstream's checks pass on macOS,
where CI does not run: tests use the resolved temp folder
(`packages/shared/src/testing/longTempDir.ts`), as upstream already does on Windows, and
the desktop preload check loads the preload as every platform
(`apps/desktop/scripts/verify-preload-bundle.mjs`). Drop either if upstream takes the same
fix.
