# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

Z6 Code publishes no releases. The installers and `t3 update` below download only from a release
source you name, as `T3CODE_RELEASE_REPOSITORY` (a GitHub `owner/name`) or
`T3CODE_RELEASE_BASE_URL`; without one they stop and say so. Otherwise build from source and
update by pulling and rebuilding.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

Build the server from a checkout of this fork, with git, Node.js 24 and `vp`
([Install vp](../../README.md#install-vp); [Install from source](../../FORK.md#install-from-source)
has the full requirements):

```bash
git clone -b bob-shell-v2 https://github.com/JeremiahDJordan/t3code.git
cd t3code && vp i && vp run --filter t3 build
node apps/server/dist/bin.mjs
```

On these pages, `t3` stands for `node apps/server/dist/bin.mjs` in that checkout, or for `z6`
where the desktop app installed [its command](#the-z6-command). Upstream's
`curl -fsSL https://t3.codes/install.sh | sh` and `npx t3` install upstream's T3 Code, not this
fork. The checkout's own `scripts/install.sh` and `scripts/install.ps1` install the `t3` binary to
`~/.local/bin`, but only from a release source you name, as above. Set `T3CODE_CHANNEL=nightly` to
install the nightly train, or `T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                                    |
| Start the server without a browser               | `t3 serve`                                                              |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md))               |
| Move to the newest release                       | `t3 update`                                                             |
| Reclaim database space                           | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

`t3 update` and the background service do not apply to a server run from a checkout; update it
with `git pull --rebase`, `vp i` and a rebuild.

## Desktop app

Build the desktop app from the same checkout: on an Apple silicon Mac,
`vp run dist:desktop:dmg:arm64` writes a `.dmg` to `release/`, and
[Install from source](../../FORK.md#install-from-source) covers installing and signing it. The
fork builds no Linux desktop app. The package-manager installs upstream documents (`winget`,
Homebrew, `.deb`, AUR) install upstream's T3 Code.

### The `z6` command

The desktop app includes the `z6` command-line tool. To run it from any
terminal, open **Settings → General → About** and choose **Install** next to
**z6 command**. On macOS and Linux it adds a `z6` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. T3 Code's own `t3`, if you
have it, stays as it is.

### Z6 Code, this fork's build

Z6 Code keeps its own data in `~/.z6` (and its app profile in `z6code`), so it can run beside
T3 Code. The first time it starts, it copies T3 Code's `~/.t3` there, then leaves T3 Code's
folders alone; quit T3 Code first, or Z6 Code asks you to. If T3 Code's background service is
installed, it keeps T3 Code running: remove it with `z6 service uninstall --t3`, or the terminal
commands Z6 Code shows. Threads and projects keep using their folders in `~/.t3/worktrees`,
`~/.t3/scratch` and `~/.t3/projects`. Pair your phone and browsers with Z6 Code again, and run
`connect link` again for T3 Connect. Its command is `z6`. To remove T3 Code's old folders, choose
**Move to Trash** next to **Old T3 Code data** in **Settings → General**, or run
`t3 t3-data remove` on a server. Anything Z6 Code still uses is kept, and so is work in those
three folders that is not a clean git checkout.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Z6 Code has no store apps; build the mobile app from the same checkout (`apps/mobile`). The phone
connects to a server on another machine. Follow [remote access](./remote-access.md) to pair it
with a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Bob Shell   | Install [Bob Shell](https://bob.ibm.com/download?bob=shell), then run `bob` to sign in.                                                                   |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Bob Shell](./providers-bob.md), [Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
