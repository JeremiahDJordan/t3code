# Bob Shell

T3 Code runs IBM Bob Shell on the machine that runs your environment and uses
Bob's own sign-in. [Provider setup](./install.md#providers) covers settings shared
by every provider.

## Set up Bob Shell

On the environment's machine, install Bob Shell with
[IBM's installer](https://bob.ibm.com/download?bob=shell), then run `bob` once in a
terminal. The first run asks you to accept IBM's license agreement, which Bob
requires before T3 Code can start it. Then enable Bob Shell in
**Settings > Providers**.

### Choose a sign-in method

Choose **Sign-in method** in the Bob Shell provider settings:

| Method  | Setup                                                                                    |
| ------- | ---------------------------------------------------------------------------------------- |
| IBM SSO | Run `bob` on the environment's machine and finish the IBM sign-in it opens in a browser. |
| API key | Add `BOB_API_KEY` to the instance's **Environment variables** and mark it sensitive.     |

IBM SSO opens its browser on the environment's machine, so you cannot finish it
from a phone or another computer. For a remote or headless environment, use an
API key, preferably one limited to the Inference scope. If T3 Code says your IBM
sign-in expired, run `bob` on that machine again.

An IBM SSO instance ignores any `BOB_API_KEY` set in the server's own environment.

## Projects and approvals

T3 Code tells Bob to trust each project folder you open, and Bob remembers it, so
you do not need to trust the folder in Bob first. After Bob has run in a project,
its skills and MCP prompts appear in the composer's `/` menu. When a thread moves
to another folder, such as picking a branch that lives in another worktree, Bob
Shell 2.0.5 or later moves the conversation with it.

T3 Code's Plan mode uses Bob's plan mode. After Bob has run, the model picker's
**Mode** option also offers Bob's Ask mode and your custom modes
(`custom_modes.yaml`); turns use Agent mode unless you pick another. A custom mode
from one project runs as Agent mode in projects that don't define it. Tool
approvals follow
[Permission modes](./permission-modes.md): **Full access** approves every Bob tool
call, and **Auto-accept edits** approves file edits. **Supervised** asks before Bob
acts, and so does **Auto**, since Bob has no automatic reviewer.

## Usage

**Usage → Limits** and `/usage-limits` in the composer show your Bob team's monthly
Bobcoin allowance, updated after each turn. If you belong to several teams, T3
Code shows the one last selected in Bob. In a project that pins a team in its
`.bob/settings.json`, `/usage-limits` shows that team's allowance instead.
**Usage → Usage** charts Bob's daily tokens and Bobcoins with your other
providers. On web and desktop, a thread's context meter shows the tokens and
Bobcoins that thread has used; turn it on with **Settings > General > Legacy
features > Context window indicator**. Bob does not report which model it runs,
so the meter's limit assumes the context window of Bob's default model. Commit
messages, pull request text, branch names, and thread titles that Bob writes
count toward the monthly allowance but not toward any thread. See
[Usage and limits](./usage.md#track-subscription-limits).

## Limits

- Bob chooses its own model. The model picker has one Bob entry, and custom models
  are unavailable.
- Compacting a Bob conversation is unavailable. Start a new thread when one gets
  too long.
- T3 Code keeps conversation history and file diffs, but Bob cannot rewind its
  conversation. Reverting a thread or editing and resubmitting an earlier turn is
  unavailable.
