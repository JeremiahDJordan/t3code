# Bob Shell

T3 Code runs IBM Bob Shell on the machine that runs your environment and uses
Bob's own sign-in. [Provider setup](./install.md#providers) covers settings shared
by every provider.

## Set up Bob Shell

On the environment's machine, install Bob Shell 2.0.5 or later with
[IBM's installer](https://bob.ibm.com/download?bob=shell), then run `bob` once in a
terminal. An older Bob still runs, but the provider shows a warning. The first run
asks you to accept IBM's license agreement, which Bob requires before T3 Code can
start it. Then enable **Bob** in **Settings → Providers**.

### Choose a sign-in method

Choose **Sign-in method** in the Bob provider settings:

| Method  | Setup                                                                                    |
| ------- | ---------------------------------------------------------------------------------------- |
| IBM SSO | Run `bob` on the environment's machine and finish the IBM sign-in it opens in a browser. |
| API key | Paste the key into the instance's **Bob API key** field.                                 |

IBM SSO opens its browser on the environment's machine, so you cannot finish it
from a phone or another computer. For a remote or headless environment, use an
API key, preferably one limited to the Inference scope. If T3 Code says Bob is not
signed in, run `bob` on that machine again.

An IBM SSO instance ignores any `BOB_API_KEY` set in the server's own environment.

To use two accounts, such as an SSO login and an API key for when its Bobcoins run
out, add a second Bob instance in **Settings → Providers** with **Add provider**. A
thread can switch between them in the model picker and keeps its conversation, unless
one instance's environment variables give Bob a different `HOME`.

## Projects and approvals

T3 Code tells Bob to trust each project folder you open, and Bob remembers it, so
you do not need to trust the folder in Bob first. After Bob has run in a project,
its skills and MCP prompts appear in the composer's `/` menu. When a thread moves
to another folder, such as picking a branch that lives in another worktree, Bob
moves the conversation with it (Bob 2.0.5 or later). A Bob thread from before T3 Code's
[thread migration](./thread-migration.md) continues its Bob task.

Reverting a thread, or editing and resubmitting an earlier turn, rewinds Bob's
conversation as well, as rolling back a task in Bob's IDE does: Bob continues from
the conversation before that turn.

When Bob runs a subagent, the thread shows it, and opening it shows the subagent's
own thread. Bob does not report a subagent's steps while it works; once it finishes,
its thread lists its notes and tool calls, then its report.

To bring in Bob tasks you ran outside T3 Code, see [Import your
projects](./welcome-wizard.md#import-your-projects).

T3 Code's Plan mode uses Bob's plan mode, and the plan Bob writes becomes the
thread's proposed plan. After Bob has run, the model picker's **Mode** option also
offers Bob's Ask mode and your custom modes (`custom_modes.yaml`); turns use Agent
mode unless you pick another. A custom mode from one project is skipped in projects
that don't define it. Tool approvals follow
[Permission modes](./permission-modes.md): **Full access** approves every Bob tool
call, and **Auto-accept edits** approves file edits. **Supervised** asks before Bob
acts, and so does **Auto**, since Bob has no automatic reviewer.

A message you send while Bob is working follows **Settings → General → Follow-up
behavior**. Queue holds it until Bob finishes its turn. Steer lets Bob finish the
tool calls it is running, then stops it and continues the same turn with your
message: Bob keeps what those tool calls did and drops only the reply it was
writing. **Stop** still stops Bob at once.

If Bob ends a turn without replying, which its backend sometimes does with a long
conversation, the thread says so and offers **Retry**, which sends your message
again.

## Keep Bob running when T3 Code restarts

An instance can run Bob in tmux, so quitting, updating or restarting T3 Code does not stop Bob
or the commands it runs, such as a long test suite. Set **Where Bob runs** to **In tmux** on an
instance in **Settings → Providers**, or add a second Bob instance for it with **Add
provider**. It needs tmux 3.2 or later on the machine running T3 Code.

When T3 Code starts again, the turn that was running shows as cancelled, and the thread starts
a new one that picks Bob up where it is: it shows Bob's tool calls from before again, then the
rest of Bob's work. Bob's T3 Code tools, such as check-ins, keep working, and a message you
sent to steer Bob while it ran a command still reaches it once the command ends, before any
message you send after the restart. The thread's
next message starts a fresh Bob on the same conversation. T3 Code stops an idle
Bob when it stops, and a Bob that no T3 Code comes back to stops after a day. Under a systemd
service, T3 Code starts tmux in its own scope, so restarting the service leaves Bob running;
that needs your user's systemd instance, and a service without one needs `KillMode=process`.

## Usage

**Usage → Limits** and `/usage-limits` in the composer show your Bob team's
monthly Bobcoin allowance: the Bobcoins used and left, and the time until it
resets at the start of the month (00:00 UTC). On web and desktop, the ring with a
coin beside the send button shows the share left; hover it for the amounts, or to
open `/usage-limits`. If you belong to several teams, T3 Code shows the one last
selected in Bob. In a project that pins a team in its `.bob/settings.json`,
`/usage-limits` and the ring show that team's allowance instead. The allowance
updates after each turn that spends Bobcoins.

When your team runs out of Bobcoins, the thread stops as
[Limited](./thread-sidebar.md) until the allowance resets, and can resume then like
any limited thread. An expired trial also stops the thread as Limited, without a
reset time; continue it once your plan changes.

A thread's context meter shows how full Bob's context is and the Bobcoins the
thread has spent. Bob does not report which model it runs, so the meter's limit
assumes the context window of the model Bob is set to, or of its default model.

**Usage → Cost** and **Usage → Tokens** show Bob's daily tokens and Bobcoins with
your other providers. Thread titles, commit messages, pull request text, and branch
names that Bob writes count toward the monthly allowance but are missing from
these totals. T3 Code apps without Bob support, such as app.t3.codes, leave Bob
out of their Usage page. See [Usage and limits](./usage.md#track-subscription-limits).

## Limits

- Bob chooses its own model. The model picker has one Bob entry, and custom models
  are unavailable.
- Compacting a Bob conversation is unavailable. Start a new thread when one gets
  too long.
