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
  usage scan, one call from the V1 thread importer to the re-link step, an `alias` on the
  MCP credential registry for a Bob kept running in tmux, a steer aimed at a turn being
  stopped starting a turn of its own (`runStopRequested` in `Orchestrator.ts`), the thread
  list's rule that a thread that never ran waits on nothing, and a way back into onboarding
  import after setup (`/welcome?step=import`, from the command palette and Settings →
  General), since Bob is usually enabled later. Upstream's shared ACP adapter
  (`packages/provider-acp/src/server/adapter.ts`) has only the generic lines for an approval
  card's `optionId`, the runtime's `threadId`, and the `_t3/` config filter.
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
- **Workflows**, scripted multi-agent runs on any provider
  ([internals](docs/internals/workflows.md)). Their own files: `apps/server/src/workflow/`,
  `orchestration-v2/Adapters/WorkflowAdapterV2.ts`, `orchestration-v2/StructuredResult.ts`,
  `mcp/WorkflowMcpService.ts`, client-runtime `state/workflowCard.ts`, and web and mobile
  `WorkflowCard.tsx`. Upstream files carry a delegated task's `resultSchema`,
  `structuredResult` and `owner_observes` (contracts `orchestrationV2.ts` and
  `orchestratorMcp.ts`, `Orchestrator.ts`, `OrchestratorMcpService.ts`, `WireProjection.ts`),
  the hidden `t3-workflow` instance (`ProviderInstanceRegistryHydration.ts`, `runtimeLayer.ts`),
  the `__workflow-sandbox` command in `bin.ts`, the orchestrator toolkit's tools, the run caps in
  contracts `settings.ts` and `serverSettings.ts`, agent guidance in provider-core
  `orchestrationInstructions.ts`, and the card in web `MessagesTimeline.tsx` and `ChatView.tsx`
  and the mobile thread screens. The sandbox needs `quickjs-emscripten`.
- **The end-to-end encrypted tunnel**, for every client but the hosted web app (see its
  decision below). Its own files: `packages/shared/src/secureChannel/`,
  `apps/server/src/secureChannel/`, the `t3-secure-channel` Expo module, and desktop's
  `DesktopSecureChannelKeys`. Upstream files carry the channel binding in auth
  (`EnvironmentAuth.ts`, `SessionStore.ts`, `PairingGrantStore.ts`, `McpOAuth.ts`,
  `auth/http.ts`), the gateway's start in `server.ts` and its CLI flags (`cli/config.ts`,
  `cli/pair.ts`, `cli/auth.ts`), client-runtime's connection routes, resolver, supervisor and
  registry, the `secureChannel` setting in contracts, and the connection screens on web, desktop
  and mobile, beside the Cloudflare Access service token.
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

`BobAdapterV2.ts` is a flavor of upstream's shared ACP adapter (`makeAcpAdapterV2` in
`@t3tools/provider-acp/server/adapter`: modes, approvals, titles, subagents, Plan) plus two
wrappers around it. Upstream moved its other providers into `packages/provider-*`; Bob stays in
`apps/server`, takes its paths and settings from provider-core's `ProviderHost` like they do,
and keeps `ServerConfig` only for T3's tmux server and `ServerSettingsService` only to save
permission rules. `wrapBobRuntime` wraps the ACP runtime: it
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

Bob keeps calling T3's tools with the MCP token of the T3 that started it, which a new T3
does not know. A new relay keeps the token's SHA-256 digest, never the token, and the T3 that
takes Bob over aliases it to the credential it issues the session (`alias` in upstream's
`McpSessionRegistry.ts`), so the alias is revoked with that credential. Bob's bridge keeps
the endpoint it was given, so this needs T3 back on the same port, as the desktop app (the
first free port from 3773), `serve --port` and dev servers are. Waiting steers travel in the
relay too, which drops them only when it passes Bob the prompt that carries them. The relay
also reports the tool calls Bob still runs, and the T3 that takes over holds restored steers
for them before the replay, whose order alone would let a replayed ended call release a steer
early. Bob gets what was sent in order: restored steers, the adopting turn's own message, then
steers sent since; after a Stop, nothing more. The Bob that ran the adopted turn still stops
when the turn ends, and the next turn starts a fresh Bob.

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
is lost. Stop still cancels at once and drops a waiting steer. A tmux instance's relay keeps
waiting steers, so one survives a restart of T3; a Bob without tmux stops with T3 anyway.

### Answer Bob's permission requests like Codex, with a sandbox for its commands (owner, 2026-10-05)

Bob 2.0.5 over ACP runs its read tools without asking and ignores its own approval settings;
`--auto-approve` is all or nothing. It derives a request's kind from the tool's permission
group, and for web, MCP and other tools from the name. A name holding "search" becomes a kind
upstream's ACP policy lets through as a read in every mode; one holding "fetch" asks but shows
as a file read. `wrapBobRuntime` turns every kind but an edit into "other" before the adapter
sees the request, so those ask and show as the tool they are. Upstream's ACP Auto approves
everything when no sandbox is set, which for Bob made Auto Full access.

The owner chose Codex's model: outside Full access, Bob's commands run in an OS sandbox, and
what stays inside it runs without asking. Bob runs every command as `$SHELL -c`, so
`bobSandbox.ts` gives Bob a shell of T3's, named like the user's since Bob tells its model the
shell, that runs the command under Seatbelt with a profile modelled on Codex's: reads anywhere
but credential stores and T3's state, writes only in the workspace and temporary folders (only
temporary folders in Supervised) with `.git`, `.env` files and agent settings read-only, no
network, not even localhost. A command the user approves on a card, or that Auto's reviewer
lets out, runs outside once: T3 leaves that exact command text, with the folder it runs in, in
an approvals folder under its state, which sandboxed commands cannot write and Bob's own edits
there ask about, so the same text run elsewhere does not take it. The shell removes T3's MCP
credentials, the approvals folder's path and, as Codex does by default, every variable named
like a credential from every command's environment, approved ones too, since a command's output
goes to Bob's model; Bob's own key and the reviewer's are among them, and T3 empties the folder once an approved command ends, since one running
as the user could otherwise leave approvals for later. A shell Bob cannot spawn makes it fall
back to `/bin/sh` unsandboxed, so T3 approves no command by mode once the shell or profile is
missing, changed or no longer executable; `ready()` compares them with what T3 wrote, and
writes them again. The profile also denies reads of the home folder's hidden files and folders and app
data in `~/Library`, where every tool keeps its credentials, since an interpreter one-liner reads
past the rules. It lets back in a list of toolchain folders, such as `~/.cargo` and `~/.sdkman`,
and only toolchains' folders in `~/.config` and `~/.local`, which hold every app's settings and
history, and lets commands look at the entries of every `PATH` folder, since Node's spawn stops searching `PATH` at
the first folder, or symlink, it may not look in, reading only those named `bin`, since a tool
such as Turso keeps its credentials beside its binary; known credential stores, shell rc files
and history stay denied inside them. Seatbelt matches paths, so moving the workspace, or a folder
holding it, into a temporary folder would carry `.git` past its read-only rule; the profile
denies unlinking the workspace's folder and its ancestors, as Codex protects its roots. A
nested `.env` can still leave the workspace with its folder; only the workspace's own `.git`,
`.env` and agent settings are held. `.env` files' contents are unreadable too, unlike Codex,
since the lexer's word checks are all that kept them from the model and globs walk past them;
the rule denies `file-read-data` on regular files only, so listing a folder or a `.env/`
virtualenv still works, and samples such as `.env.example` stay readable. Seatbelt weighs the
specific operation before `file-read*`, so private paths and T3's state are denied as
`file-read-data` too, after those reopenings. Seatbelt matches the resolved path, so a `.env`
symlinked to a file named otherwise stays readable. T3's caches, the sandbox's files and the reviewer's
program among them, are never writable.
When a command T3 let into the sandbox fails with a denial (`EPERM`, a name that does not
resolve and the like), its next run asks, so the user can let it out.
Bubblewrap on Linux waits for a host to test on; without a sandbox every mode asks before every
command but those the user's rules allow, since two reviews showed a command that looks like a
read can still run code, through a git `textconv` driver or `file --compile`.

`wrapBobRuntime` answers Bob itself, allow once, for what `reviewBobPermission` allows in the
thread's mode while a prompt runs and the user has not stopped it; everything else reaches the
adapter, whose Bob disposition asks outside Full access. Supervised runs commands the rules find
read-only, in the read-only sandbox. Accept edits and Auto run any command the sandbox bounds,
tests and builds with any flags included, and ask before what needs more: `rm` and its like,
git writes, installing packages, network and system tools, `eval`, `xargs` and anything the lexer
cannot read; they run edits inside the workspace away from `.git`, secrets and agent settings,
which, unlike upstream's Accept edits, confines edits as Codex does. Commands Bob runs in the
background, servers and watchers, ask, since the sandbox cuts their network. Bob's own tools are
recognized by their English titles and inputs, so in another language they ask. Reads ask when
a word names a secret as written or resolved, the home folder's hidden folders and `Library`
included, or covers the home folder or a folder above the workspace. A read left to review runs
outside the sandbox with its whole line, so a line holding it and anything else asks, as do
variables before it or a wrapper around it, such as `GH_PAGER=…`, and `gh` with `--jq` or
`--template`, whose expressions read the environment. Program names are compared lowercased,
since the Mac's file system ignores case. Shells are followed into `-c` among other short
options, as in `bash -lc`, wrappers' options are known one by one, `--` among them, and any other asks, and zsh's
`=cmd` asks. Bob's own **Always allow this session** is not offered for commands and
edits: Bob would remember it for the tool, past T3's rules; rules take its place. False asks
over false allows was the owner's call.

In Auto, web searches and fetches of public pages, skills and `gh` reads, which need the
network, go to `bobAutoJudge.ts`: Apple's on-device model through a small Swift program T3
compiles with `xcrun swiftc` into its caches and keeps running, or a model behind an
OpenAI-compatible endpoint, by the instance's `autoReviewer` setting. The model answers whether
the user's messages call for this kind of action and whether it is risky; T3 allows only
"requested and not risky", and anything else, a timeout or no model asks; an answer that came
while the user wrote again or a rule changed is not used, and each call asks at its own deadline
while the model is busy with one before it. It sees only the messages the user wrote, which each
turn leaves for the runtime serving its thread, one the generic adapter starts for the turn
included, and keeps with the thread, so a new runtime still has them; check-ins, notices, wakes
and other threads never count. It sees the last six messages, and a cut or a message left out
could drop the sentence that forbids the call, so the model first quotes each message's
sentences that limit the agent, and, as the owner asked (2026-10-06), those that allow it
something or lift a limit, word for word, in parts of 6,000 characters that overlap by 1,000, so
a sentence split between two is whole in one. It quotes only what the user typed, never an
attachment, which may be a pasted file or a screenshot's text. On 126 calls that match no
example in its instructions (an earlier test reusing an example's call passed wrongly), Apple's
model allowed 29 it should have asked about while the list sat between the call and the
messages, searches a restriction forbade among them, and 2 with the list last, where the owner
found models heed such rules. Given a permission and a later restriction of the same action it
still let the permission win, so a permission counts only until a later message sets any
restriction, and only whether a later permission lifts a restriction is left to the model, whose
mistakes there ask; the owner accepts false asks, since Bob is not adversarial and the reviewer
only catches it going too far. Each Auto answer, with who decided and why, each quote and the
user's answers on Auto's cards are spans (`bob.auto.decision`, `bob.auto.quote`,
`bob.auto.answer`) in the trace file, the only log a desktop or `npx t3` launch keeps;
`scripts/bob-auto-audit.mjs` joins them with the user's messages for an agent to audit. A
thread's Auto network option (`_t3/bob-network`, which T3 keeps from Bob as it does every `_t3/`
option) can have every call left to the reviewer ask instead, for the owner's case of a thread
that should not reach the network. T3 keeps only quotes found in the message, stored by message
so they stay in the order the user wrote them however the quoting finishes, and keeps them in
memory with the thread after the message has left the six; a restart forgets them. Only a quoted
message is cut or left out. The owner ruled out asking on every call once the messages outgrow
the prompt (2026-10-06), so past their budget the oldest quotes are dropped instead, as are
older messages past 50,000 characters waiting to be quoted and the history of all but the 100
threads served last; a message keeps at most its first and last five quotes, so one paste cannot
push out the restrictions before it. Only an Auto runtime quotes, since only Auto sends the
user's messages to the reviewer, which may be a remote endpoint; messages from other modes are
quoted once Auto needs them. Quoting runs newest first and stops at the first failure, so a
reviewer that is down gets one request per message or review, and it ends with its runtime. A
review waits up to 30 seconds for quoting in progress; a message still unquoted is judged by
only while it is shown whole, and one that left the six unquoted asks until it is quoted. Before
the sandbox, the model also judged tests and builds, and three rounds of review kept finding
flags and configs that make a runner run Bob's code; the sandbox replaced that, and without one
Auto asks before tests and builds.

A tmux relay records the mode its Bob was started for, and a T3 that restarts takes the Bob over
only in that mode: after a switch it stops that Bob and starts one for the new mode, since a Bob
started with `--auto-approve` asks about nothing and any other runs its commands under the old
mode's sandbox profile.

A command an approval lets out of the sandbox runs under the user's shell startup files,
`~/.zshenv` included, as any command of Bob's does outside T3; the sandbox keeps commands from
writing them, and skipping them would drop the `PATH` many users set there (F11).
T3 checks the sandbox by its effects, a profile in place and a shell that runs, not by a newest
tested Bob version (F26). The reviewer's quotes are not filtered by wording, since a word list
would drop real restrictions without its words, such as "leave the db folder alone", and text
pasted into the user's own message that empties a part's quotes is the user's to read (S2, S3).

### Let the user add Bob's permission rules, from Settings or an approval card (owner, 2026-10-05)

Every list the rules and the sandbox keep is a guess about the user's machine, so the owner
wanted the user able to extend each without a release, and a card to add to them. Rules have
five kinds (`BobRule` in `settings.ts`): commands that run outside the sandbox without asking,
as Codex's prefix rules do, commands that always ask, folders sandboxed commands may read or
write, and private paths. They live in server settings beside, not in, the Bob instance's, since
an instance setting rebuilds the instance and open threads keep the adapter they started with;
`BobDriver.ts` streams them into every Bob runtime, which rewrites its thread's profile in
place. A profile is named by instance, thread and folder rather than by its text, so a T3 that
restarts finds the profile of a Bob kept running in tmux. Rules apply to every project, one
project or one thread (`threadId`), all saved alike, so each shows in Settings and survives a
restart. A folder rule opens a credential store inside it only when the rule names the store,
and never T3's home or the sandbox's own files, which a command could otherwise rewrite. A rule
to write in the home folder or above only reads (`rulesApplied` in `bobSandbox.ts`; Settings
refuses `/` and `~`): writing there lets a command replace tools T3 runs outside the sandbox,
such as those in `~/.local/bin`. T3's state and cache folders and every folder above them are
anchored like the workspace, so no command can move them aside for its own. Paths are
resolved by one strict walk (`resolvedStrictly`): only through the home folder, macOS's `/tmp`,
`/var` and `/etc`, a link straight in the home folder such as `~/code`, followed one hop at a time
with its target walked as strictly, and for a rule the workspace; any other symlink drops the path, and each step must resolve to itself, so a folder
swapped mid-walk is caught. A command could have made the link where a folder did not exist yet,
such as a fresh worktree's `./dist`, or put one in place of a nested project's own folder, and
the next rebuild would follow it to `~/.ssh` or `~/.local/bin`. Which places a command can
write is not this profile's to know, since other threads' sandboxes, other providers' included,
write the same folders, so no link there is trusted; a sandbox whose own project is the home
folder could write a link straight in it, which is the accepted risk of such a project. The
workspace is pinned once, when the sandbox opens (`bobWorkspace`), and never resolved again;
one reached through a refused link gets no sandbox. Bob's reviewer walks the workspace and the
rule folders it grants by the same rule on each review (`Places` in `bobAutoReview.ts`), so after
a swap Bob's own edits ask. Bob's own edits run outside the sandbox, so the reviewer grants them
under a write rule only where the profile lets commands write: the profile's write denials are
data (`writeDenials`), which it renders and `bobRuleWriter` matches, given T3's state, caches and
temporary folders. Only a write rule lifts a write denial; one to read a store opens it for
reading. A credential store that is a link is closed where it leads too, a private path's
folders are anchored like the workspace, and `.env` files are closed in the temporary folders
as well, where a command could move a subfolder, so a `.env` written there cannot be read. No
command may clone a folder (`file-clone` on a directory), which copies everything below it past
every read rule; cloning a file still works. A card offers only a
folder that is there, and compares names as the disk does (`folded`: case, Unicode form, and
letters such as `ß` for `ss` and `ſ` for `s`), so `~/.SSH` and `~/.awſ` are credential stores.
A rule
to run without asking matches the command's words as written, with no variables before them,
since `PATH=` and the like change what runs, not in the background, and only in the workspace,
from a folder and on arguments that stay in it as written and through symlinks, with no glob or
`..`, which the shell and the kernel resolve past a symlink, and no path run on from a short
flag, as in `-o/tmp/out`; a rule to ask also matches past variables and by the program's file
name, or its path when the rule gives one, in any case, since the Mac's file system ignores it;
a card offers nothing for a program spelled in an unusual case. Settings and cards add and
remove rules (`bobRuleChanges`) against those saved, under the settings lock, so two edits never
undo each other. A rule's `./` path starts at the thread's workspace, so a project's rule
follows it into each worktree. The MCP settings tool never exposes them, since an agent that
could add rules could leave the sandbox.

A card shows one split button, like GitHub's merge button, whose main choice is the scope the
user picked last (`bobRuleScope`); `ProviderApprovalOption.optionId` and the response's
`optionId` tell its choices apart, and `wrapBobRuntime` adds them as its own ACP options and
answers Bob allow once when one is picked. After the sandbox stopped a command at a path its
output names, the card offers to open that folder (`bobSandboxFolderSuggestion`), or a workspace
`.env` file. The output is the agent's, so never a whole `~/Library` or `~/.config`, app data,
an agent's folder, a credential store, history or T3's home, and writing only in caches and
toolchains' folders; otherwise it offers the command's program and
subcommand (`suggestBobCommandRule`), never for shells or interpreters by any version or case,
`npx`, `rm`, `curl`, whole cloud CLIs such as `aws`, and the like, nor subcommands that run
anything or install, such as `gh alias` and `npm install`, and warns on runners, whose scripts
Bob can change. A client that predates `optionId` answers such a
choice as `acceptAlways` alone, which `AcpAdapterV2.ts` takes for approving once, and a named
option counts only when its kind agrees with the decision. The card's **Approve** on a sandboxed
command says it runs outside the sandbox.

Settings' rule form starts at Every project, since Settings has no project of its own; a card
starts at the scope the user picked last (F17).

### A delegated Bob task answers to the user's own words (owner, 2026-10-07)

A Bob subagent's first message is a task another agent wrote, not the user, so Auto's reviewer
had nothing to judge by and every call the rules left to it asked. The task is now the request
the reviewer judges by, but it is never quoted: nothing in a delegating agent's prompt, or in a
workflow script, forbids or allows anything. Restrictions and permissions come only from what the
user wrote in the thread the work started in: the first thread up from the agent's parent that is
not itself a subagent, which skips a workflow's coordinator and stops at a fork the user works in.
"Don't push" there binds every agent under it. `bobUserMessages.ts` reads the lineage and the
messages from the projection's rows directly, rather than loading whole threads for every agent;
the adapter quotes them once per starting thread (`turns.started`) and reads again at each later
turn. When they cannot be read, or the reviewer cannot quote them, the call asks.

### Let Bob's Auto run T3's own read and result tools (review, 2026-10-08)

Outside Supervised, the rules let Bob call T3's MCP tools that only read threads, projects,
queues and schedules, or report a delegated task's status and result (`T3_MCP_ROUTINE_TOOLS` in
`bobAutoReview.ts`), without asking; every other T3 tool asks, such as those that start threads
or workflows, schedule, send or fork. Without it, a workflow agent asked for a structured result
asked at every return. Bob shows only a title, `Running <Tool Name> (<server>)`, so the match is
on the exact server name T3 injects, `t3-code`. A project's own `.bob/mcp.json` could declare a
server of that name; that file runs only because T3 starts Bob with `--trust` (see the next
decision), which already lets the project run commands.

### Trust every project folder T3 opens for Bob (owner, 2026-10-09)

T3 starts Bob with `--trust` (`BobAcpSupport.ts`), so a user never trusts a folder in Bob first.
In a trusted folder Bob runs the folder's `.bob/mcp.json` and `.bob/plugins/*/mcp.json` servers
and its `.bob/settings.json` hooks when a thread opens, in every mode and outside T3's command
sandbox, because Bob starts them itself; `--disable-mcp` only hides their tools afterwards. With
real Bob 2.0.5 a repo's `mcp.json` command ran at `session/new` with the flag and not without
it. Without the flag Bob refuses the whole session in a folder the user has not trusted in Bob,
while its `security.folderTrust.enabled` setting is on, as it is by default; it remembers trust
per `HOME`, for good. The owner kept the flag; the Bob guide tells users
to open only projects they trust.

Text generation is the exception: it serves threads of every provider, so in a project's folder
the flag would trust it, and run its setup, without the user ever opening a Bob thread there.
`BobTextGeneration.ts` runs every prompt in one folder T3 owns,
`<providerStatusCacheDir>/bob-text-generation`, which is all Bob ever trusts for it: each prompt
carries its message or diff, and T3 resolves the commit style itself.

### Show a provider's setup error when its session cannot open (2026-10-03)

`ProviderSetupError` is safe setup text by contract, but a failed run showed only "The
provider session could not be opened", or the generic error's own message on the start
path. `ProviderFailure.ts` now finds a `ProviderSetupError` in the cause, and
`ProviderTurnStartService.ts` prefers its text. Bob wraps its sign-in and license refusals in
one. Generic and small, so a candidate for upstream.

### Stop a Bob team out of Bobcoins as a usage limit (2026-10-05)

Bob 2.0.5 fails such a turn with `data.details` of `BudgetExceededError: <JSON>`, or
`TrialExpiredError` once a trial's Bobcoins are spent; its ACP library sends a thrown error's
message that way. The Bob adapter maps a spent allowance to V2's `usage_limit` with a reset at
00:00 UTC on the next month's first day, and a trial to one without a reset, so upstream's
Limited state, snooze and auto-resume apply. Bob raises the same `BudgetExceededError` for a
suspended plan and for a profile it could not read, so only its wording of a spent allowance
("budget allowance", "team budget has been exceeded") counts. Bob translates that wording; in
another language, or from a Bob that words it differently, the turn is an ordinary failure with
Bob's text.

### Warn at 80% and 95% of a budget on web and desktop (2026-10-05)

`BudgetWarningNotification.tsx` reads every environment's provider limits, which clients
already receive, and warns once per device for a window with an amount, such as Bob's
monthly Bobcoins, at each threshold of each budget period: a toast, and a system notification
under the thread notification setting. Mobile is left out: its pushes go through upstream's
hosted relay, which carries only thread events, so a budget push would need upstream changes.

### Show a thread with a running background command as Waiting (2026-10-03)

V2's Waiting status reads the shell's `pendingBackgroundTasks`, which belong to providers:
recovery clears them, settlement and the Stop-background-work banner act on them, and the
shell stream resumes by sequence. So T3's commands stay out of it. An environment-wide
`subscribeBackgroundCommandThreads` stream names the threads with a running command, and the
thread lists show such an idle thread as Waiting; the legacy sidebar does it with a stand-in
roster entry. Upstream shows Waiting only for work that will wake the agent, and leftover
commands such as a dev server as Running (pingdotgg/t3code#15114); a T3 command wakes the
agent when it ends, so it is Waiting, and the stand-in is a `monitor`, a kind that holds.

### Retry resends the message (owner, 2026-10-02)

A run its provider failed as retryable offers **Retry** on its failure row, on web and
mobile, which sends the run's message again as a manual continuation of that run. It is
generic: any provider can mark a failure retryable, and a usage limit never counts, since it
resumes at its reset. Bob marks an empty reply retryable. A failed workspace preparation
shows only upstream's own Retry, which prepares the workspace again.

### Re-link migrated Bob threads to their tasks (owner, 2026-10-02)

Upstream's migration keeps transcripts but drops provider sessions, so a migrated thread's
next message would start a new Bob task with a summary of the transcript. After each import,
`bobThreadRelink.ts` gives a migrated Bob thread a provider thread on the task its V1
session named. Upstream still sends a migrated thread's first message with its imported
history; the fork's `hasNativeThread` check in `Orchestrator.ts` skips that for a thread
that already has a native thread, as upstream's queued path does, so Bob does not read its
history twice. A re-linked thread has a provider thread but no run, which upstream's
`shellRuntime` presented as Waiting forever, as it does a thread upstream's session import
creates. The fork's `shellRuntime` presents no runtime for a thread that never ran.

### Keep check-ins and background commands inside T3 (owner, 2026-09-28)

An outside MCP server cannot start a turn, so it cannot wake an idle agent; only
the server that owns the thread can. Background commands stay in T3 too, for the
terminal view and Stop in the thread. Every check-in, wait and background-command tool acts
as the calling thread, so since upstream's MCP tools take explicit targets (#15219) an agent
signed in from outside a thread gets `thread_credential_required` from them, as from
upstream's `delegate_task`.

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
which is worse than an agent reading one twice. A message V2 refuses is recorded as told
and logged: its refusals for a server's notice (a pending merge-back from several forks, a
reused message id) outlast a retry, which V2 refuses again under the same command id. That
includes a notice whose provider instance was removed before it was told: the adapter's error
becomes the stored refusal, and the agent never hears how its command ended.

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

### Pool Bob instances by the team they bill (review 7)

Bobcoin budgets belong to teams, so Bob's monthly window carries a
`credentialFingerprint` hashed from the instance and team ids it read. Usage > Limits
shows every Bob billing one team, on any environment and with SSO or an API key, as one
budget. Keying by Bob's user id instead would count a team's budget twice. SSO instances
whose limits are unavailable still pool per environment, since they read the same
`~/.bob` login.

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
`hasNativeThread` check, no runtime for a thread that never ran, the MCP credential
`alias`, a steer after Stop starting its own turn, and check-ins. Revisit when the owner decides to upstream.

### Ship from source only

Upstream's release workflow signs and notarizes with upstream's Apple certificate and
publishes `t3` to npm under upstream's name, so the fork cannot reuse it, and a
pipeline of its own costs a certificate and a package name for a few users. Everyone
builds from this branch, as [Install from source](#install-from-source) describes.
Revisit when people outside the owner's team use the fork.

### Pair the phone through Cloudflare Access with a service token (owner, 2026-10-07)

A machine behind the owner's own Cloudflare Tunnel sits behind Cloudflare Access, which turns
away every request without its login cookie or a service token, so a bearer route can carry an
Access service token (`transport: "cloudflare-access"` on the profile, the token in the route's
credential, which the phone keeps in its secure storage). The token's headers are kept by host
and added only over HTTPS and WSS, below the HTTP client (`withConnectionTransportHeaders`) and
in the mobile app's WebSocket constructor, so pairing's own requests carry them, traces never
record them, and a LAN or Tailscale route learned through the Access route never sends them.
Pairing sets them before its first request; a connection sets them as it reads the route's
credential. Access refusing a request reads as "Cloudflare Access rejected the service token",
and a new token goes in through the environment's edit form. The web app works when loaded from
the Access hostname, with Access's own cookie; the hosted web app and the desktop app's remote
routes are not covered, and an interactive Access login on the phone is a later step.

### End-to-end encrypted channel inside a Cloudflare Tunnel (owner, 2026-10-07)

Machines reached through a Cloudflare Tunnel carry T3 traffic Cloudflare can't read or change. A
gateway in the server process, on its own loopback port, speaks one hard-coded
`Noise_IK_25519_ChaChaPoly_SHA256` channel over one WebSocket and carries plain TCP byte streams
inside it to the server's own listener. The server's static key travels only in the pairing link's
fragment (`#token=…&sk=…`), so the root of trust never crosses the tunnel.

- **Our own Noise.** Existing Noise packages are tied to libp2p or `sodium-native`, which doesn't
  run under Hermes. One pattern on the `@noble` primitives is about 300 lines and matches
  cacophony's IK vector byte for byte (the vector is a committed fixture; cacophony is public
  domain).
- **The protocol.** Message 1 rides on the upgrade as a second `Sec-WebSocket-Protocol` value
  beside `t3c.2`; its payload holds a timestamp (5-minute skew) and, before pairing, the pairing
  code, so the code never crosses Cloudflare in the clear. The prologue binds the origin; the path
  derives from the server key. Streams are byte streams with a 256 KiB credit window each, sent
  round robin; `rekey` after 2^20 messages or an hour. Any forged, replayed or out-of-protocol
  message closes the channel, and the gateway answers zero bytes to anything but a valid handshake,
  so the hostname looks like nothing runs there. A change to the frames bumps the subprotocol id.
- **A loopback forwarder per route on the client.** About 60 web and mobile sites load
  environment URLs themselves (images, video, WebViews, downloads), so each client listens on
  `127.0.0.1:<random>` per encrypted route and carries each connection as a stream; every loader
  works unchanged. Mobile uses a native listener in the Expo module, desktop the Electron main
  process (so the outer socket can carry Cloudflare Access headers). The hosted web app can't open
  a listener and doesn't support these routes. Other local processes can reach the forwarder, but
  only get what the server serves without credentials.
- **Fail closed.** An encrypted route's host never gets a plain request: the runtime's fetch and
  WebSocket refuse it, and `environmentMcpUrl` skips it. A saved environment pins its server key
  across every address, so a link with another key or none is refused.
- **Server trust.** Auth knows a request came through the channel by its upstream port; a session
  paired through the channel carries the client key (`cck`) and its tokens work only on that
  client's channel (`secure_channel_sessions`, created on first use). Revoking a client's last
  session closes its channels.
- **Crypto placement.** noble seals about 320 MB/s on Node, so the server and desktop use it;
  under Hermes it manages about 3 MB/s, so mobile seals natively (CryptoKit on iOS, the platform
  ChaCha20-Poly1305 on Android 9+).
- **No compression (owner's call, after review).** Compressing before encrypting leaks how well
  each message compressed; the server already compresses what it serves.
- **Admission.** Attempts count only at the channel's path; strangers are rate-limited per
  address, per network and in total, while an address where a paired device recently connected
  skips the limits, so a flood doesn't keep the user's devices out. A pairing code admits at most
  two channels.
- **Turning it on.** Settings → Connections → End-to-end encrypted tunnel (public URL, port 3774
  by default), or `--secure-channel-port` with `--secure-channel-origin`;
  `t3 pair --secure-channel` builds links and `t3 channel rotate` replaces the key (restart
  needed).
- **Out of scope.** A web UI loaded through the tunnel (Cloudflare delivers its JavaScript), T3
  Connect's relay, and a compromised device.

### Workflows run as a hidden provider's turn (owner, 2026-10-07)

Agents start workflows through `t3_workflow_run`, and a workflow is a file the user hands to an
agent; there is no library or import step. The engine is a hidden provider adapter driving a
coordinator child thread, because a delegation needs a live parent run, and that gives every
delegated-task behavior (child threads, Stop, the wake) unchanged. Scripts are Claude-compatible
JavaScript plus roles, run in QuickJS in a process of their own; roles bind to local providers at
run time, writers in one checkout take turns, and limits default to 4 at once and 30 per run, capped
at 8 and 100 per environment. Importing is treated like pasting a prompt: no approval step beyond
the permission modes. On Bob, a workflow's agents answer to the user's words where it started (see
the delegated-task decision above), and a run's result reports their Bobcoins. The design and its
traps are in [docs/internals/workflows.md](docs/internals/workflows.md).

### Known gaps

- Stop cannot end a background command whose `<cwd>/.t3/jobs/<id>` folder was deleted,
  by `git clean -fdx` say: T3 kills its tmux session, but the wrapper's detached child
  keeps running. Keeping the process group in the command's row would fix it.
- Reopening a command's terminal after detaching tmux in it (prefix, then d) shows a plain
  shell. Close the terminal and open it again.
- A running background command shows its thread as Waiting in the thread row only. The
  Working sections, web and mobile, and the legacy sidebar's project pills still see the
  thread as ready; they would need the running-command list passed into upstream's list
  logic.
- A command the sandbox stops in a Bob subagent is not recorded, so its next run does not ask
  first as the main agent's does; T3 sees a subagent's tool calls only as replayed steps.
- Why Auto asked is in the trace file (`bob.auto.decision`), not on the card; showing it needs
  a reason on the approval request, a contract change for every client.
- Apple's reviewer judges and quotes on one queue, so a judgement can wait behind a part of a
  message being quoted in each thread quoting; a judge-first queue waits until that shows.
- A delegated Bob task (a subagent or a workflow agent) survives a T3 restart in tmux only with
  **Continue threads after server update** on, which is off by default: upstream's restart
  continuation then holds the task's row open, the continuation adopts Bob's prompt, and a
  workflow's Retry re-attaches to it. Otherwise recovery ends the row, so the driver stops that
  relay instead of adopting it (`bobDelegatedTask.ts`): the agent's work so far is lost and Retry
  starts it again, but no two Bobs do one job.

## Rebase checklist

Before: `git fetch origin && git merge-tree --write-tree --name-only HEAD origin/main`
lists the files that will conflict. After a rebase, if `pnpm-lock.yaml` changed,
run `vp i` before testing (upstream adds dependencies the dev server needs).

**Silent-drop sites.** A merge can lose these and still typecheck:

- Bob on V2, in upstream's shared ACP adapter (`packages/provider-acp/src/server/adapter.ts`):
  calling `loadSession` when the agent
  advertises it, child-session notifications projected into a subagent's child thread,
  `runtime.setMode` falling back to `session/set_mode`, and `usage_update` reaching the
  provider thread's `contextUsage` with its `cost`. Elsewhere: `steerTurn` for a provider
  with `supportsActiveSteering`, a continuation's `creationSource: "provider"`, and
  `ServerActivation`. `BobAdapterV2.test.ts` fails if one changes, apart from activation,
  which only the live restart check below covers.
- `packages/provider-core/src/server/failure.ts`: the `ProviderSetupError` case, and
  `providerSetupDetail` in
  `ProviderTurnStartService.ts`; losing them turns Bob's sign-in and license messages back
  into "could not be opened".
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`: the
  `relinkMigratedBobThreads` call. `Orchestrator.ts`: `hasNativeThread` in
  `shouldPrepareLegacyImportHandoff`; losing it sends a re-linked thread's history twice.
  Client-runtime `models.ts`: `shellRuntime`'s `latestRunId === null` check; losing it shows
  every re-linked thread as Waiting (`entities.test.ts` covers it).
- Retry: in `Orchestrator.ts`, `isRetryableRunFailure` in the `manualContinuationOfRunId`
  check; without it the server refuses every Retry.
- `Orchestrator.ts`: `runStopRequested` in `dispatchMessage`'s two steer paths; losing it lets a
  message steered after Stop join the stopped turn, before its "Run interrupted" divider, with
  its reply hidden. `SteeringCompletion.integration.test.ts` covers it.
- An approval card's `optionId`, which picks the scope of a Bob permission rule: contracts
  `ProviderApprovalOption` and `runtime-request.respond`, `Orchestrator.ts`, `EffectOutbox.ts`,
  `EffectWorker.ts`, `RuntimeRequestService.ts`, provider-core `ProviderAdapter.ts`, and in the
  shared ACP adapter `selectPermissionOptionId` and `AcpApprovalAnswer`, plus `threadId` in
  `AcpAdapterV2RuntimeInput`; client-runtime `commands.ts`; web `ComposerPendingApprovalActions.tsx`,
  `ChatComposer.tsx` and `ChatView.tsx`; mobile `PendingApprovalCard.tsx`,
  `ThreadDetailScreen.tsx` and `use-selected-thread-requests.ts`. Losing a link answers the
  card's rule choice as a plain decision, which the ACP adapter takes for Decline.
  `BobAdapterV2.test.ts` covers the server's part. Settings: `bobRules`, `bobRuleChanges` and
  `bobRuleScope` in contracts `settings.ts`, `applyBobRuleChanges` in shared
  `serverSettings.ts` (losing it drops every rule a card or Settings adds), and
  `BobRulesSection` in web `ProviderInstanceCard.tsx`.
- Who wrote a scheduled task's prompt, which Bob's Auto reviewer trusts as the user's words: in
  `OrchestratorMcpService.ts`, `updateScheduledTask` stamps `agent`/`mcp` when an agent changes
  the prompt or the task's `threadId`, and `ScheduledTaskService.ts`'s `upsert` lets the saver's
  `createdBy` win, makes a prompt the app rewrites the user's, and writes `created_by` on
  conflict; its webhook runs dispatch as `server`. Losing any lets an agent's edit or move, or a
  webhook sender's text, run as the user's own words.
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
- Registration: `builtInDrivers.ts`, `providerStatusCache.ts`, `serverSettings.ts`
  (`"bob"` in `HISTORY_RESTORED_DRIVERS`, and in `TEXT_GENERATION_FALLBACK_DRIVERS`, without
  which a Bob-only user's titles and commit messages go to a disabled provider), `model-manifest.json`, and in contracts
  `settings.ts` (`BobSettings`, and `"bob"` in `DEFAULT_DISABLED_PROVIDER_DRIVERS`: losing it
  treats an unconfigured Bob as on, so onboarding import and the Usage page read the real
  Bob database) and `model.ts`.
- `apps/server/src/provider/bobDatabase.ts`: the one read-only helper every
  Bob reader shares. Dropping its busy timeout degrades usage, import, the Usage page
  and subagent steps at once.
- Check-ins and background commands: `server.ts` (`CheckInsLayerLive`, and
  `CheckInsWorkerLive`, without which nothing is ever delivered), the
  `settlementHoldsLayer` on `ThreadSettlementWorkerLive` (the hold is optional, so losing it
  lets a thread settle mid-command), the `useRunsBackgroundCommand` lines in web
  `Sidebar.tsx` and `LegacySidebar.tsx` and mobile `thread-list-v2-items.tsx` (the Waiting
  status; the legacy sidebar's stand-in must stay a kind `backgroundWorkHoldsCompletion`
  counts), `McpHttpServer.ts` (the toolkit), `ServerEnvironment.ts`
  (`threadCheckIns` and `threadBackgroundCommands`, which clients check before
  subscribing), web `ChatView.tsx` (the banner items) and `IntegrationsSettings.tsx`, mobile
  `ThreadDetailScreen.tsx`, `ThreadFeed.tsx` and `SettingsServerControlsRouteScreen.tsx`.
- Clients: web `__root.tsx` (`BudgetWarningNotification`), `providerDriverMeta.ts` (Bob's
  inline client definition, beside upstream's package ones),
  `Icons.tsx`, `ProviderInstanceIcon.tsx`, `usageProviders.ts`, `ChatComposer.tsx`
  (`ComposerBudgetMeter`), `WelcomeWizard.tsx` (the Bob icon column, and `initialStep` for
  `/welcome?step=import`), `welcome.tsx`, `CommandPalette.tsx` and `SettingsPanels.tsx` (the
  import entries), and the Retry wiring in `ChatView.tsx` and `MessagesTimeline.tsx`; mobile
  `ProviderIcon.tsx`, `usageProviders.ts`,
  `UsageLimitsPooled.tsx` (`DRIVER_LABEL`), and Retry in `ThreadRouteScreen.tsx`,
  `thread-work-log.tsx` and `use-thread-composer-state.ts`.

**Conflict hazards:** `ws.ts` around `makeWsRpcLayer`'s parameters; the scanner's
already-imported/duplicate helpers, which both the transcript and Bob paths use (port
an upstream change there into both); `ContextWindowMeter.tsx`; the `UsagePage.tsx` day
table and mobile `UsageRouteScreen.tsx` model rows (Bobcoins under each metric);
`usageAggregation.ts` bucket creation (the fork's `credits` field); the failure rows in
`MessagesTimeline.tsx` and mobile `thread-work-log.tsx`, where the fork's Retry sits beside
upstream's; `Orchestrator.ts` near `manualContinuationOfRunId`. Upstream keeps moving provider
code into `packages/provider-*`: a fork file that imported a moved module fails to typecheck,
and `git diff -M --name-status <old base> <new base>` lists the new homes; the fork's edits to a
moved file follow it (rename detection), so check them there.

**After each rebase:** run `vp check` (seconds; upstream adds lint rules), then the
fork's tests:

```bash
cd apps/server && vp test run src/orchestration-v2/Adapters/BobAdapterV2 \
  src/orchestration-v2/legacy/bobThreadRelink src/orchestration-v2/Orchestrator.migration \
  src/orchestration-v2/ThreadSettlementService src/provider/Bob src/provider/bob \
  src/provider/acp/Bob src/provider/acp/bob src/provider/providerUsageLimits \
  src/textGeneration/BobTextGeneration src/usage src/upstreamClientCompatibility \
  src/project src/checkIns src/tmux \
  src/mcp/toolkits/checkIns src/persistence/ThreadBackgroundCommands \
  src/serverSettings src/orchestration-v2/SteeringCompletion
cd ../../packages/client-runtime && vp test run src/state/threadExecution \
  src/state/checkIns src/state/entities src/authorization
cd ../shared && vp test run src/usage
cd ../provider-core && vp test run src/server/failure src/server/usageLimits
cd ../provider-acp && vp test run
cd ../../apps/server && vp test run src/workflow src/orchestration-v2/StructuredResult \
  src/orchestration-v2/DelegatedCompletionDelivery src/mcp/OrchestratorMcpService \
  src/secureChannel src/auth src/startupAccess src/cli
cd ../../packages/shared && vp test run src/secureChannel src/remote
cd ../client-runtime && vp test run src/connection src/state/workflowCard
cd ../../apps/web && vp test run src/hostedPairing src/components/settings/pairingUrls
cd ../desktop && vp test run src/app/DesktopSecureChannelKeys
```

Run them from each package: from the root, a path filter also matches agent worktrees
under `.claude/worktrees/`.

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
