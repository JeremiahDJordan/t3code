#!/bin/sh
# Signs a local desktop build with a Developer ID, notarizes it and staples the ticket, so a copy
# downloaded on another Mac opens without Gatekeeper's "Open Anyway":
#
#   scripts/sign-desktop-macos.sh [path/to/T3-Code-<version>-<arch>.zip]
#
# Without a path it takes the newest zip in release/ for this Mac's architecture, as
# `vp run dist:desktop:dmg:arm64` leaves it. It writes release/signed/<name>.zip and .dmg, both
# notarized; scripts/install-desktop-macos.sh installs the zip. The ad-hoc build is left as it is.
#
# It needs a "Developer ID Application" certificate in the login keychain, made in Xcode under
# Settings > Accounts > Manage Certificates, and notarytool credentials stored once with
# `xcrun notarytool store-credentials t3code-notary --apple-id <id> --team-id <team>`.
# T3CODE_MAC_SIGNING_IDENTITY and T3CODE_NOTARY_PROFILE override the certificate and the profile.
#
# The app gets the entitlements upstream's signed releases get, without the passkey ones that
# need upstream's provisioning profile: the in-app browser has no Touch ID passkeys, as in the
# ad-hoc build. Everything else is signed as electron-builder signs it: every Mach-O file in the
# bundle, inside out, with the hardened runtime and a timestamp.
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${T3CODE_NOTARY_PROFILE:-t3code-notary}"
app_name="T3 Code (Alpha).app"

fail() {
  printf 'sign-desktop-macos: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -gt 0 ]; then
  zip="$1"
else
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) fail "unknown architecture $(uname -m)" ;;
  esac
  zip="$(ls -t "$repo_root"/release/T3-Code-*-"$arch".zip 2>/dev/null | head -n 1 || true)"
  [ -n "$zip" ] || fail "no release/T3-Code-*-$arch.zip; build one with vp run dist:desktop:dmg:$arch"
fi
[ -f "$zip" ] || fail "$zip is not a file"
zip="$(cd "$(dirname "$zip")" && pwd)/$(basename "$zip")"
name="$(basename "$zip" .zip)"

identity="${T3CODE_MAC_SIGNING_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Developer ID Application: .*\)"$/\1/p' | head -n 1)"
fi
[ -n "$identity" ] || fail 'no "Developer ID Application" certificate in the keychain'
xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 ||
  fail "no notarytool credentials named $profile; store them with xcrun notarytool store-credentials"

work="$(mktemp -d "${TMPDIR:-/tmp}/t3code-sign.XXXXXX")"
trap 'rm -rf "$work"' EXIT
out="$repo_root/release/signed"
mkdir -p "$out"

printf 'Signing %s as "%s"\n' "$name" "$identity"
# ditto keeps the bundle's symlinks and permissions; unzip does not.
ditto -x -k "$zip" "$work/unpacked"
app="$work/unpacked/$app_name"
[ -d "$app" ] || fail "$zip holds no $app_name"

entitlements="$work/entitlements.plist"
cat > "$entitlements" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
EOF

sign() {
  codesign --force --options runtime --timestamp --sign "$identity" "$@"
}
is_macho() {
  file -b "$1" | grep -q 'Mach-O'
}

# Native modules, bundled tools and libraries under Resources carry no entitlements.
find "$app/Contents/Resources" -type f \( -name '*.node' -o -name '*.dylib' -o -perm +111 \) |
  while IFS= read -r file; do
    if is_macho "$file"; then sign "$file"; fi
  done

# Each framework's own helpers and libraries, then the framework.
frameworks="$app/Contents/Frameworks"
for framework in "$frameworks"/*.framework; do
  find "$framework/Versions/A" \( -path '*/Helpers/*' -o -path '*/Libraries/*' -o -path '*/Resources/*' \) -type f -perm +111 |
    while IFS= read -r file; do
      if is_macho "$file"; then sign "$file"; fi
    done
  sign "$framework/Versions/A"
done

# Electron's helper apps run renderers and plugins, so they need the same entitlements.
for helper in "$frameworks"/*.app; do
  sign --entitlements "$entitlements" "$helper"
done
sign --entitlements "$entitlements" "$app"
codesign --verify --deep --strict --verbose=1 "$app"

notarize() {
  printf 'Notarizing %s...\n' "$(basename "$1")"
  log="$work/notary-$(basename "$1").log"
  if ! xcrun notarytool submit "$1" --keychain-profile "$profile" --wait > "$log" 2>&1; then
    cat "$log" >&2
    fail "notarytool failed"
  fi
  if ! grep -q 'status: Accepted' "$log"; then
    id="$(sed -n 's/^ *id: \(.*\)$/\1/p' "$log" | head -n 1)"
    [ -z "$id" ] || xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || true
    cat "$log" >&2
    fail "notarization was not accepted"
  fi
}

ditto -c -k --keepParent "$app" "$work/notarize.zip"
notarize "$work/notarize.zip"
xcrun stapler staple "$app" >/dev/null
spctl -a -vv -t exec "$app" 2>&1 | grep -q 'source=Notarized Developer ID' ||
  fail "Gatekeeper does not accept the stapled app"

ditto -c -k --keepParent "$app" "$out/$name.zip"

# A plain disk image with an Applications link; upstream's themed one needs electron-builder.
dmg_root="$work/dmg"
mkdir -p "$dmg_root"
ditto "$app" "$dmg_root/$app_name"
ln -s /Applications "$dmg_root/Applications"
hdiutil create -quiet -volname "T3 Code (Alpha)" -srcfolder "$dmg_root" -ov -format UDZO "$out/$name.dmg"
codesign --force --timestamp --sign "$identity" "$out/$name.dmg"
notarize "$out/$name.dmg"
xcrun stapler staple "$out/$name.dmg" >/dev/null

printf 'Signed and notarized:\n  %s\n  %s\n' "$out/$name.zip" "$out/$name.dmg"
