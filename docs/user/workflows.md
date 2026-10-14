# Workflows

A workflow is a script that runs several agents through stages: reviewers, then challengers who
try to refute each finding, then a judge, for instance. Each stage can use its own provider and
model. T3 Code runs the script in the background on your environment and shows every agent as a
child thread. When the workflow ends, the agent that started it is woken with the result.

A workflow is a file. You keep it like any other file, in the repo, with your notes, or in your
own [workflows folder](#keeping-your-own-workflows), and hand it to an agent when you want it run.

## Running a workflow

Ask an agent in any thread to run it, for example: "Run `.plans/judged-review.workflow.js` on
`main..HEAD` for the api and ui areas." Attach the file, paste it, or point at it in the repo.

The agent first checks the workflow without starting anything. It sees the workflow's phases, the
limits it will run with, and which provider and model each role gets on this environment. If a
role cannot be matched, nothing starts: the agent asks you, picks one of the offered models, or
runs those roles on its own model if you tell it to.

While the workflow runs, the thread that started it shows a workflow card and waits. On the phone
the card opens from the agents button above the composer, or from the **Waiting on** status there,
rather than sitting in the conversation. The card lists
the workflow's phases in order. Each phase shows how many agents are working, done, failed or
stopped, and opens to list its agents with their role, provider and model. Select an agent to open
its thread. When an agent asks for approval or a question, the card shows **Waiting for you** and
badges that agent's phase. Agents in a workflow do not send notifications, so check the card during
a long run. The agent that started the workflow can tell you how it is going too: asked, it reads
the running phases, how many agents are done, any waiting for you, and the latest log line.

- **Stop** on the card stops every agent the workflow started.
- **Retry** appears after a workflow fails or stops. It reruns the script from the top: agents that
  finished are reused, agents still running are waited for, and only the rest start again.
- **Copy script** and **Download** give you the exact script the run used. On mobile, Download opens
  the share sheet.

When an agent's provider is only unavailable for a moment, because its model is at capacity,
overloaded or rate limited, the workflow starts that agent again by itself after 30 seconds, then 2
minutes, then 5 minutes, and its log says so. Retries do not count toward the run's agent limit.

Restarting the server or the desktop app, which every update does, stops running workflows and
their agents; Retry carries on from where they stopped. With **Settings → General → Continue threads
after restarts** on (on mobile, **Settings → Maintenance → Continue after restart**), a workflow
continues by itself instead. See [Updating T3 Code](updating.md#before-you-update).

A run keeps the script it started with. Editing the file afterwards changes neither a running
workflow nor a Retry or continuation of it: each reruns the copy the run took when it started. To
use your edits, ask the agent to run the file again. That is a new run, and all of its agents start
fresh rather than reusing the earlier run's.

The card also heads the workflow's own thread, which keeps the workflow's log as a timeline. That
thread takes no messages; Stop and Retry on its card are how you steer it.

In the web and desktop apps, the starting thread's **Lineage** section in its details also lists the
run: expand it for its phases and their agents, select an agent to open its thread, or stop the
whole run.

## Keeping your own workflows

Workflows you use in every project can live in one place instead of a copy in each repo: the
`workflows` folder of the T3 home on the machine the environment runs on, `~/.t3/workflows` by
default (`<path>/workflows` for a server started with `--home-dir <path>`). Create the folder,
save the file there, and ask for it by name: "Run `judged-review.workflow.js` on `main..HEAD`." A
file in a subfolder goes by its path inside the folder, such as `team/review.workflow.js`. When the
project has a file at the same path, the project's copy runs.

An agent cannot point T3 Code at any other file on the machine this way: a path or a link that
leads out of the folder or the project is refused.

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
branch with `workspace(name)`. The worktree starts at the starting thread's commit, or at what
`workspace(name, { from })` names: a branch, a commit SHA, or another workspace, whose branch it
starts from. Retry starts it at the same commit even if that branch has moved.

When the run finishes, its worktrees are removed. A branch its agents committed to stays for you to
merge, and a branch with no new commits is deleted. `workspace(name, { cleanup: "keep" })` keeps the
branch either way, and `cleanup: "always"` deletes it even with commits. A worktree with changes
nobody committed stays with its branch. A run that failed or was stopped deletes nothing, so Retry
carries on in its worktrees. A kept worktree belongs to its agents' threads, so
[storage cleanup](project-settings.md#storage-cleanup) removes it like any other once it is clean.

For reviewers, `workspace(name, { from, readOnly: true })` gives a worktree whose agents run side by
side and are told not to change it. Agents keep their own provider's permissions, so T3 Code
checks rather than prevents: before an agent starts there and when its result is read, any changed
file (ignored files aside) or new commit turns that agent's result into `null`, and the workflow's
log says what changed. The change stays for you to inspect, and agents sharing the workspace at the
time get `null` too, since it is unclear which of them made it. A read-only branch that gained
commits is kept when the run finishes, and the log names it.

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

When a run ends, its result says what its agents spent where their providers report it, such as
Bob Shell's Bobcoins. After a Retry the figure covers every attempt.

## Writing a workflow

Agents can write workflows for you; describe the stages and ask for a workflow file. A workflow
starts with `export const meta = { t3: 1, name, description, roles, limits, phases }` and calls
`agent(prompt, { as, label, phase, schema })` for each agent. With a `schema`, an agent returns
structured data that the workflow can filter and pass on. The schema's constraints are checked,
`pattern` included. A pattern that refers back to a group, looks ahead or behind, sets flags
inside itself, is longer than 256 characters, or repeats so much that it expands past 1,024 steps
(such as `a{2000}`) is refused when the workflow calls `agent()` with it; use `enum` for a fixed
set of values. The rest are checked against strings of up to hundreds of thousands of characters,
fewer the larger the pattern; a longer string fails the check, as does a result whose strings
together take too long to check against large patterns. An agent that fails, is stopped, or
would pass the run's agent limit gives `null` instead, and the workflow's result lists those agents
and why. For the reason in the script, pass `detailed: true`: `agent()` then gives
`{ ok: true, value }`, or `{ ok: false, reason, message }` with a `reason` of
`provider-unavailable`, `failed`, `stopped`, `limit` or `no-result` (no result matching the schema).
Workflows written for Claude Code's Workflow tool run too, except for `agentType`, `budget` and
nested workflows.

What the script returns is the workflow's result. Text reads as written, and anything else as a
JSON block. An object with a text `summary` field, such as `return { summary, findings, branch }`,
opens the result with that summary and lists its other fields after it. An agent reads at most
20,000 characters of a result at a time and reads a longer one in parts, so lead a large result
with a summary that says what the agent needs.

A workflow cannot read the clock or random numbers, so a retry replays the same steps. A workflow
coordinates agents rather than computing: a script that computes for more than a quarter second
without waiting on an agent is stopped.

### Example: parallel writers, then a merge

`workspace(name)` gives agents a worktree on a branch of its own, so writers in different
workspaces work at the same time. Combining their branches is the script's job: here each writer
commits on its own branch, then one agent merges them in another workspace and resolves any
conflicts, and a reviewer checks the result, with one round of fixes.

```js
export const meta = {
  t3: 1,
  name: "parallel-build",
  description: "Builds the parts of PLAN.md side by side, then merges and checks them.",
  roles: {
    writer: { inherit: true },
    reviewer: { inherit: true, interactionMode: "plan" },
  },
  phases: [{ title: "Build" }, { title: "Merge" }, { title: "Check" }],
};

const parts = ["api", "ui"];
const branches = await parallel(
  parts.map((part) => async () => {
    const ws = await workspace(part);
    const done = await agent(
      `Implement the ${part} part of PLAN.md. Run its tests, then commit your work on this branch.`,
      { as: "writer", label: `build ${part}`, phase: "Build", workspace: ws },
    );
    return done === null ? null : ws.branch;
  }),
);
const built = branches.filter((branch) => branch !== null);

const merged = await workspace("merged");
await agent(
  `Merge these branches into this branch, one at a time: ${built.join(", ")}. ` +
    "Resolve each conflict so every part keeps working, run all the tests, and commit.",
  { as: "writer", label: "merge", phase: "Merge", workspace: merged },
);

const verdict = {
  type: "object",
  required: ["ok", "problems"],
  properties: {
    ok: { type: "boolean" },
    problems: { type: "array", items: { type: "string" } },
  },
};
const review = () =>
  agent(
    "Review this branch against PLAN.md: is every part there, and did resolving a conflict drop or break anything?",
    { as: "reviewer", label: "review", phase: "Check", workspace: merged, schema: verdict },
  );
let check = await review();
if (check !== null && !check.ok) {
  await agent(
    `Fix these problems on this branch, run all the tests, and commit:\n${check.problems.join("\n")}`,
    { as: "writer", label: "fix", phase: "Check", workspace: merged },
  );
  check = await review();
}

return {
  summary: check?.ok
    ? `Built and merged ${built.join(", ")} on ${merged.branch}.`
    : `Merged ${built.join(", ")} on ${merged.branch}, with problems left.`,
  branch: merged.branch,
  missing: parts.filter((part, index) => branches[index] === null),
  problems: check?.problems ?? ["The review did not finish."],
};
```

When the run finishes, its worktrees are removed and every branch stays: review the branch the
result names and merge it as you would any other. Retry reuses the writers that finished, so a
failed merge does not rebuild the parts.

## Running commands

A workflow can run a shell command without spending an agent on it, such as an install and a
check: `await exec("pnpm install --offline && pnpm run check", { workspace: ws })` returns
`{ exitCode, stdout, stderr, timedOut }`. The command runs in the workspace's worktree, or in the
starting thread's checkout when no `workspace` is given. The workflow's thread logs each command
with its exit code and how long it took.

- On macOS a command runs in the same sandbox as Bob Shell's commands. It writes only in its
  workspace's worktree, where it can also commit, in temporary folders and in build tools' caches,
  never in the starting thread's checkout, and it cannot read your credentials. In a read-only
  workspace, or from a thread in Supervised or plan mode, it writes no worktree either.
- It reaches the network only when the workflow was started from a thread in Full access. Outside
  Full access an install must come from the package store or cache, such as
  `pnpm install --offline`, or it fails.
- On Linux and Windows there is no sandbox for commands yet, so `exec()` runs only in a workflow
  started from a thread in Full access, and then as you.
- A command stops after `timeoutMs`, 10 minutes by default and at most 60, with `timedOut: true`.
  Each output keeps its last 256 KB, with a note saying how much was cut. A run runs two commands
  at once, and a command in a workspace waits for the agents editing it.
- Variables named like credentials (with KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL in the name)
  and T3 Code's own are left out of the command's environment. Pass what it needs in `env`.
- **Retry** does not run a command that finished again, since running it twice may not be safe; it
  returns the earlier result, a failed one included. A command the run was stopped in runs again.
  **Stop** ends running commands.
