#!/bin/sh
# Installs a local desktop build on macOS: quits the running T3 Code, replaces its app in
# /Applications with the one in a build's zip, and opens it again.
#
#   scripts/install-desktop-macos.sh [--detach] [path/to/T3-Code-<version>-<arch>.zip]
#
# Without a path it installs the newest zip in release/ for this Mac's architecture, as
# `vp run dist:desktop:dmg:arm64` leaves it. The zip and the DMG hold the same app; the zip
# unpacks without mounting anything.
#
# An agent can run this from inside the app it replaces, such as Bob in tmux mode asked from
# a phone to "build the arm desktop app and run scripts/install-desktop-macos.sh". The script
# then checks the build, hands the install to a background process of its own, and returns,
# so the agent's turn can end before the app quits. That process logs to
# $TMPDIR/t3code-install-desktop.log. It detaches by itself when it runs under that app; pass
# --detach to do the same anywhere else. Quitting stops this machine's T3 server, so connected
# phones and browsers reconnect once the app is back.
set -eu

bundle_id="com.t3tools.t3code"
quit_timeout_seconds=60
launch_timeout_seconds=30
# Long enough for the agent that started a detached install to finish its reply.
detached_delay_seconds=10
log="${TMPDIR:-/tmp}/t3code-install-desktop.log"

fail() {
  printf 'install-desktop-macos: %s\n' "$1" >&2
  exit 1
}

# Process ids of the running app, from Launch Services by bundle id.
app_pids() {
  asns="$(lsappinfo find bundleid="$bundle_id")"
  [ -n "$asns" ] || return 0
  # shellcheck disable=SC2086 # One argument per running copy.
  lsappinfo info -only pid $asns | sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p'
}

any_alive() {
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

# Whether this script runs under the app at $1: T3's server, and the relay that keeps Bob in
# tmux, both run as the app's own binary.
runs_under() {
  pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      "$1"/*) return 0 ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this installs the macOS app; run it on a Mac."

detach=false
if [ "${1:-}" = "--detach" ]; then
  detach=true
  shift
fi

zip="${1:-}"
if [ -z "$zip" ]; then
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) fail "unknown architecture $(uname -m); pass the zip to install." ;;
  esac
  zip="$(ls -t "$repo_root"/release/T3-Code-*-"$arch".zip 2>/dev/null | head -n 1 || true)"
  [ -n "$zip" ] || fail "no build in $repo_root/release. Build one with: vp run dist:desktop:dmg:$arch"
fi
[ -f "$zip" ] || fail "$zip does not exist."
zip="$(cd "$(dirname "$zip")" && pwd)/$(basename "$zip")"

app_name="$(zipinfo -1 "$zip" 2>/dev/null | head -n 1 | cut -d/ -f1)"
case "$app_name" in
  *.app) ;;
  *) fail "$zip holds no .app." ;;
esac
target="/Applications/$app_name"

if [ "${T3CODE_INSTALL_DETACHED:-}" != "1" ] && { [ "$detach" = true ] || runs_under "$target"; }; then
  script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  # A session of its own, so nothing that stops the agent's command or the app stops this.
  T3CODE_INSTALL_DETACHED=1 nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' \
    "$script" "$zip" >"$log" 2>&1 </dev/null &
  printf 'Installing %s in the background. T3 Code quits in about %ss and reopens with it.\n' \
    "$(basename "$zip")" "$detached_delay_seconds"
  printf 'Log: %s\n' "$log"
  exit 0
fi
if [ "${T3CODE_INSTALL_DETACHED:-}" = "1" ]; then
  sleep "$detached_delay_seconds"
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
# ditto keeps the bundle's symlinks, permissions and signature intact; unzip does not.
ditto -x -k "$zip" "$staging"
[ -d "$staging/$app_name" ] || fail "$zip holds no $app_name."
# Copied beside the old app first, so the swap below is two renames on one disk.
incoming="$target.installing"
rm -rf "$incoming"
ditto "$staging/$app_name" "$incoming"

pids="$(app_pids)"
if [ -n "$pids" ]; then
  printf 'Quitting T3 Code...\n'
  # Electron treats SIGTERM as a normal quit, so T3 still stops its server cleanly. Unlike
  # AppleScript, it needs no Automation permission, which nobody could grant from a phone.
  # shellcheck disable=SC2086 # One argument per process.
  kill -TERM $pids
  waited=0
  # shellcheck disable=SC2086
  while any_alive $pids; do
    if [ "$waited" -ge "$quit_timeout_seconds" ]; then
      rm -rf "$incoming"
      fail "T3 Code is still running after ${quit_timeout_seconds}s. Quit it, then run this again."
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

printf 'Installing %s from %s...\n' "$app_name" "$(basename "$zip")"
rm -rf "$target.previous"
if [ -e "$target" ]; then
  mv "$target" "$target.previous"
fi
mv "$incoming" "$target"
rm -rf "$target.previous"

# open hands its environment to the app. Run under T3, that environment is T3's server's, whose
# ELECTRON_RUN_AS_NODE starts the app as plain Node, which exits at once. Open it with the bare
# environment Finder would give it instead.
env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/zsh}" \
  TMPDIR="${TMPDIR:-/tmp}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" open "$target"
waited=0
while [ -z "$(app_pids)" ]; do
  [ "$waited" -lt "$launch_timeout_seconds" ] ||
    fail "$app_name was installed but did not start. Open it from /Applications."
  sleep 1
  waited=$((waited + 1))
done
printf 'Started %s.\n' "$target"
