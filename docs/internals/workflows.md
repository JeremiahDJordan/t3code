# Workflows

A workflow run is a delegated task whose child thread, the coordinator, is driven by a hidden
provider instance, `t3-workflow`. Its "turn" runs the script in QuickJS
([`WorkflowSandbox`](../../apps/server/src/workflow/WorkflowSandbox.ts)), and each `agent()` call
dispatches an ordinary `delegated_task.request` from that turn
([`WorkflowEngine`](../../apps/server/src/workflow/WorkflowEngine.ts)).

## Why the engine is a provider adapter

The orchestrator only accepts a delegation from a live, blocking run that owns its parent node. The
agent that starts a workflow ends its turn long before the workflow does, so the agents need
another live run to hang from. Driving the coordinator thread with an adapter gives them one, and
every delegated-task behavior then applies unchanged: child threads, Stop and its cascade, the
starting thread held as waiting, and the wake. The cost is that a server restart interrupts the
coordinator's turn like any provider turn; a rerun reuses finished agents (see below).

The adapter ([`WorkflowAdapterV2`](../../apps/server/src/orchestration-v2/Adapters/WorkflowAdapterV2.ts))
is served by the V2 adapter registry and left out of `list()`. It is not a provider instance, so
`ProviderRegistry`, `orchestrator_capabilities`, usage and provider status never see it. The
engine needs thread management, which needs the orchestrator, which needs the adapter; the
`WorkflowEngineHost` service breaks that cycle by letting the engine register its turn runner after
it is built. Keep one host layer instance shared by both sides.

## `owner_observes`

Agents are dispatched with `completionWake: "owner_observes"`: finalization records their result
on the coordinator's subagent row but never offers a continuation or a context handoff to the
coordinator's provider. The engine watches its children's rows instead. Stream events are the
client projection, which strips `resultSchema`, `structuredResult` and this wake value (older
clients cannot decode it), so the engine re-reads rows from the projection store.

## Reruns

Any new turn on the coordinator reruns the script from the top; Retry is a message to it. The
coordinator's child rows are the run's journal: a completed child returns its stored result, a live
one is awaited, and a failed, cancelled or interrupted one starts its next attempt. That only works
if each `agent()` call reaches the same child id on every run, so ids derive from the call itself
(see the top of [`WorkflowEngine`](../../apps/server/src/workflow/WorkflowEngine.ts)) and the
sandbox has no clock, randomness or I/O. Anything nondeterministic in a call's id or in what the
script can read starts agents over on every Retry.

Agents an earlier turn left running each hold a concurrency slot until they end or the rerun
reaches them, so a Retry cannot exceed the run's limit. A failed or stopped run keeps its worktrees
for the rerun; the run that finishes removes them without forcing, so git keeps one with
uncommitted work. The run's invocation lives in the
coordinator's first message and its source in `workflow_sources`, keyed by hash.

A coordinator row that ended unfinished is the one delegated task whose later runs publish their
result again (`finalizeAppOwnedSubagent`), so a successful Retry wakes the starting agent with the
real result. A coordinator interrupted while its agents still run stays "waiting for children" and
is not finalized until they and a rerun finish.

## The sandbox process

Each run, and each `meta` read, runs its script in a process of its own: the server starts its own
CLI with the hidden `__workflow-sandbox` command, which `bin.ts` dispatches before the full CLI
loads, and trades JSON lines with it
([`WorkflowSandboxProtocol`](../../apps/server/src/workflow/WorkflowSandboxProtocol.ts)). Script
code never runs on the server's thread. The process is the boundary, because QuickJS's own limits
are not: it checks its interrupt handler only every 10,000 operations and never inside a builtin,
its memory limit does not see the whole WebAssembly heap, and a deep enough recursion overflows the
host stack inside the WebAssembly frames and leaves the module unusable.

The process stops a script at soft limits and reports the line: 250 ms of CPU between host calls
and 10 s per run. Its WebAssembly memory is created with a 256 MB maximum, so the heap cannot grow
past it whatever QuickJS counts. The server enforces the hard time limits. It times each stretch of
script work between the process's `busy` and `idle` messages and kills the process past four times
the soft slice plus a second, or past the total. The process writes those messages synchronously:
script work blocks its event loop, so a buffered `busy` would arrive after the work it should time.
For the same reason a watchdog thread in the process kills it when the server is gone or a stretch
outlasts the server's deadline, so a crashed server leaves nothing spinning. The deadlines are wall
clock, so a machine that sleeps in the middle of script work fails that run when it wakes; Retry
carries on, and a run waiting on its agents is unaffected.

Messages are split on `\n` alone and an unreadable line fails the run: `readline` also splits on
U+2028 and U+2029, which JSON leaves unescaped, and a dropped message would leave the run waiting
forever. Inside the process the host still reads script values only through functions the prelude
captured before the script ran, never with `dump` or `getString` (both run script code), and runs
promise jobs in small batches so a job that queues jobs cannot spin inside one call.

QuickJS records source positions only at some opcodes, so for a loop of pure arithmetic the
reported line is the last recorded position before it, not the loop.
