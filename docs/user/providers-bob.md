# Bob Shell

T3 Code runs IBM Bob Shell on the machine that runs your environment and uses
Bob's own sign-in. [Provider setup](./install.md#providers) covers settings shared
by every provider.

## Set up Bob Shell

On the environment's machine, install Bob Shell 2.0.5 or later with
[IBM's installer](https://bob.ibm.com/download?bob=shell), then run `bob` once in a
terminal. An older Bob still runs, but the provider shows a warning. The first run
asks you to accept IBM's license agreement, which Bob requires before T3 Code can
start it. Then enable Bob Shell in **Settings → Providers**.

### Choose a sign-in method

Choose **Sign-in method** in the Bob Shell provider settings:

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
moves the conversation with it (Bob 2.0.5 or later).

Reverting a thread, or editing and resubmitting an earlier turn, rewinds Bob's
conversation as well, as rolling back a task in Bob's IDE does: Bob continues from
the conversation before that turn.

T3 Code's Plan mode uses Bob's plan mode, and the plan Bob writes becomes the
thread's proposed plan. After Bob has run, the model picker's **Mode** option also
offers Bob's Ask mode and your custom modes (`custom_modes.yaml`); turns use Agent
mode unless you pick another. A custom mode from one project is skipped in projects
that don't define it. Tool approvals follow
[Permission modes](./permission-modes.md): **Full access** approves every Bob tool
call, and **Auto-accept edits** approves file edits. **Supervised** asks before Bob
acts, and so does **Auto**, since Bob has no automatic reviewer.

A message you send while Bob is working follows **Settings → General → Follow-up
behavior**. Queue holds it until Bob finishes its turn. Steer stops Bob's turn,
including a tool call it is running, and starts again with your message.

If Bob ends a turn without replying, which its backend sometimes does with a long
conversation, the thread says so and offers **Retry**, which sends your message
again.

## Limits

- Bob chooses its own model. The model picker has one Bob entry, and custom models
  are unavailable.
- Compacting a Bob conversation is unavailable. Start a new thread when one gets
  too long.
