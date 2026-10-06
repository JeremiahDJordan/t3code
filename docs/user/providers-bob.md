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
that don't define it.

Tool approvals follow [Permission modes](./permission-modes.md). On macOS, outside **Full
access**, Bob's commands run in a sandbox, as Codex's do: they read anywhere but the hidden
files and folders in your home folder and app data in `~/Library`, where tools keep
credentials, apart from toolchain folders such as `~/.cargo` or `~/.config/git` and the `bin`
folders on your `PATH`; they write only in the project and temporary folders, with `.git` and
agent settings kept read-only, and reach no network, not even servers on your Mac. They cannot
read the project's `.env` files, apart from samples such as `.env.example` (one that is a symlink
to a file named otherwise stays readable), nor see environment
variables named like credentials, such as `GH_TOKEN` or `OPENAI_API_KEY`, whose names hold
`KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL`, approved commands included. A command you
approve runs outside the sandbox, once, in the folder it asked for; the card's **Approve** says
so.

- **Supervised** runs commands that only read, such as `ls`, `git status` or `rg`, in a
  sandbox that writes only temporary files, and asks before Bob's other commands and its
  edits.
- **Auto-accept edits** runs Bob's commands in the sandbox, tests, builds and scripts
  included, and its edits inside the project, except to `.git`, `.env` files, editor and agent
  settings, and other secrets. It asks before `rm` and other delete commands, git commits and
  pushes, installing packages, network tools such as `curl`, commands that run in the
  background, and commands T3 Code cannot read with certainty, such as one using `$VARIABLES`.
- **Auto** works as Auto-accept edits, and a reviewer model checks web searches and fetches of
  public pages, skills and GitHub reads with `gh` against the last six messages you wrote. It
  also keeps each sentence you type that limits what Bob may do, such as "don't search the web
  for this", or allows it something, such as "you can search the web again", so it holds after
  its message is older than six, until T3 Code restarts; when there are many, the oldest go
  first. A permission stops counting once a later message sets any limit, and attachments are
  never read for either. A long message is read for those sentences before the reviewer sees
  it shortened. What the reviewer takes from each message, each call Auto answers or asks
  about, and your answer, are kept in T3 Code's trace file,
  `~/.t3/userdata/logs/server.trace.ndjson`. When it finds the call requested and not risky,
  the call runs; otherwise, when you have written nothing it can judge against, or when it
  does not answer within a few seconds, you are asked. To have Auto ask before every web
  search, fetch, GitHub read and skill in one thread, pick **Always ask** in the **Auto
  network** option beside the model.
- **Full access** lets Bob approve every tool call itself, without a sandbox.

A command that needs the network or writes outside the project fails in the sandbox: a test
that starts a server, a tool that keeps a cache outside the project, such as Go's, or one that
reads its settings in a hidden folder of your home folder. When the sandbox stops a command,
the next time Bob runs it you are asked, so you can let it run outside; ask Bob to try again.
Bob's own todo list and subagents run in every mode; a subagent's tool calls are checked the
same way. For commands and edits a card offers a rule instead of **Always allow this session**,
which Bob would apply to every later call of that tool; for Bob's other tools it stops Bob
asking about that tool. In every mode Bob reads and searches files with its own tools without
asking, which no setting in T3 Code stops.

Without a sandbox, for now on Linux, every mode but **Full access** asks before every command,
apart from those your rules let run without asking.

Choose the reviewer in the Bob instance's **Auto mode reviewer** setting under
**Settings → Providers**. **Apple's on-device model** is the default; it needs Apple
Intelligence on macOS 26 or later and the Xcode command line tools, and T3 Code builds a
small helper for it the first time Auto runs. **OpenAI-compatible endpoint** asks a model
you run, such as one in Ollama at `http://localhost:11434/v1`; set **Reviewer endpoint**
and **Reviewer model**, and put a key, if the endpoint needs one, in the instance's
`BOB_AUTO_REVIEW_API_KEY` environment variable. Only Auto sends your messages to the reviewer.
**Rules only** asks you about every call the rules leave to review.

A message you send while Bob is working follows **Settings → General → Follow-up
behavior**. Queue holds it until Bob finishes its turn. Steer lets Bob finish the
tool calls it is running, then stops it and continues the same turn with your
message: Bob keeps what those tool calls did and drops only the reply it was
writing. **Stop** still stops Bob at once.

If Bob ends a turn without replying, which its backend sometimes does with a long
conversation, the thread says so and offers **Retry**, which sends your message
again.

### Permission rules

Rules change what Bob may do without asking, outside **Full access**:

- **Run without asking**: commands starting with these words, such as `git commit`, run
  outside the sandbox without asking.
- **Always ask**: commands starting with these words always ask, even in the sandbox.
- **Commands may read** and **Commands may write in**: folders the sandbox opens, such as a
  tool's settings in `~/.vercel` or a cache in `~/Library/Caches/go-build`.
- **Keep private**: paths commands never read or write, and Bob's own edits of them ask. Bob's
  own reads still go through, since Bob does not ask before them.

An approval card can add a rule: when a command asks, the card offers to run commands
starting the same way without asking, and when the sandbox stopped a command at a folder, to
open that folder. Pick where the rule applies, this thread, this project or every project,
from the button's menu; the card offers the place you picked last first. The card offers no
rule for commands that can run anything, such as `bash`, `node`, `npx` or `curl`, nor folders
beyond a tool's own, such as all of `~/Library`, app data or an agent's folder, and warns that a rule for the project's own scripts, such as
`npm run build`, lets Bob's changes to them run outside the sandbox.

See and remove rules, a thread's included, and add rules for a project or every project, in
the Bob instance's **Permission rules** under **Settings → Providers**. They apply to every Bob
instance on that environment. A path starting with `./` is in the project's folder, so a
project's rule follows each thread into its worktree. A rule that opens a folder never opens
a credential store or app data in it, such as `~/.cargo/credentials.toml`, nor a `.env` file;
name the file itself to open it. A rule to run commands without asking applies only to
commands that run in the project's folder, on paths in it, with no variables set before them,
and not in the background.

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

On web and desktop, T3 Code warns once when your team has used 80% of the month's
Bobcoins, and again at 95%, and the ring turns amber and then red. Your **Thread
notifications** setting applies to the warning too: its sound plays, and a system
notification appears while T3 Code is in the background.

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
