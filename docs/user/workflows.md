# Workflows

A workflow is a script that runs several agents through stages: reviewers, then challengers who
try to refute each finding, then a judge, for instance. Each stage can use its own provider and
model. T3 Code runs the script in the background on your environment and shows every agent as a
child thread. When the workflow ends, the agent that started it is woken with the result.

A workflow is a file. You keep it like any other file, in the repo or with your notes, and hand it
to an agent when you want it run.

## Running a workflow

Ask an agent in any thread to run it, for example: "Run `.plans/judged-review.workflow.js` on
`main..HEAD` for the api and ui areas." Attach the file, paste it, or point at it in the repo.

The agent first checks the workflow without starting anything. It sees the workflow's phases, the
limits it will run with, and which provider and model each role gets on this environment. If a
role cannot be matched, nothing starts: the agent asks you, picks one of the offered models, or
runs those roles on its own model if you tell it to.

While the workflow runs, the thread that started it shows a workflow card and waits. The card lists
the workflow's phases in order. Each phase shows how many agents are working, done, failed or
stopped, and opens to list its agents with their role, provider and model. Select an agent to open
its thread. When an agent asks for approval or a question, the card shows **Waiting for you** and
badges that agent's phase. Agents in a workflow do not send notifications, so check the card during
a long run.

- **Stop** on the card stops every agent the workflow started.
- **Retry** appears after a workflow fails or stops. It reruns the script from the top: agents that
  finished are reused, agents still running are waited for, and only the rest start again.
- **Copy script** and **Download** give you the exact script the run used. On mobile, Download opens
  the share sheet.

Restarting the server or the desktop app, which every update does, stops running workflows and
their agents; Retry carries on from where they stopped. With **Settings → General → Continue threads
after restarts** on (on mobile, **Settings → Maintenance → Continue after restart**), a workflow
continues by itself instead. See [Updating T3 Code](updating.md#before-you-update).

The card also heads the workflow's own thread, which keeps the workflow's log as a timeline. That
thread takes no messages; Stop and Retry on its card are how you steer it.

## Moving a workflow to another environment

Give the file to an agent on the other environment, as an attachment or as a file in its checkout,
and ask it to run it. The workflow's roles are matched against that environment's providers, and
that agent owns the run. Workflows name roles, not machines, so the same file runs anywhere.

Give Bob Shell a workflow as an attachment or a file path, not pasted text: Bob's Auto mode treats
text you paste as your own words, so permissions written in the script's prompts would count as
yours. The workflow's agents still answer only to what you wrote in the thread you started it from.

## Roles

A workflow names its agents by role, such as `reviewer` or `judge`. A role either asks for a
provider and model (`{ driver: "codex", model: "gpt-6.1-sol" }`) or inherits the starting agent's
(`{ inherit: true }`). A role can also ask for plan mode, which keeps that agent from editing
files. A role can never get broader permissions than the thread that starts the workflow; a
workflow asking for more is refused before it starts. From a thread in plan mode, a role can't run
on a provider that has no plan mode, since that agent could edit files; such a role is reported
unbound.

Agents that can edit files take turns in a shared checkout. Agents in plan mode, and agents in
their own worktree, run side by side. A workflow can give a group of agents a worktree on its own
branch. When the run finishes, its worktrees are removed and the branches stay for you to merge. A
worktree with changes nobody committed stays, and so do the worktrees of a run that failed or was
stopped, so Retry carries on in them. A kept worktree belongs to its agents' threads, so
[storage cleanup](project-settings.md#storage-cleanup) removes it like any other once it is clean.

## Limits and cost

A workflow sets how many agents may work at once (4 by default) and how many it may start in total
(30 by default). Your environment caps both, at 8 and 100 unless you change them under
**Settings → General → Behavior** (Workflow agents at once, Workflow agents per run), or on mobile
under **Settings → Thread behavior → Workflows**. A workflow asking for more runs with your caps,
and its log says so. Past the total, the workflow's further agents do not start; its log and its
result say so.

These limits count agents, not tokens or cost; a workflow has no spending budget. Every agent is a
full conversation with its provider and is billed like one. A workflow that sends a long plan to
every agent pays for that plan once per agent.

## Writing a workflow

Agents can write workflows for you; describe the stages and ask for a workflow file. A workflow
starts with `export const meta = { t3: 1, name, description, roles, limits, phases }` and calls
`agent(prompt, { as, label, phase, schema })` for each agent. With a `schema`, an agent returns
structured data that the workflow can filter and pass on. An agent that fails, is stopped, or would
pass the run's agent limit gives `null` instead, and the workflow's result notes how many did.
Workflows written for Claude Code's Workflow tool run too, except for `agentType`, `budget` and
nested workflows.

A workflow cannot read the clock or random numbers, so a retry replays the same steps. A workflow
coordinates agents rather than computing: a script that computes for more than a quarter second
without waiting on an agent is stopped.
