#!/usr/bin/env bash
# Build, sign, and package BalauDeck for the Mac App Store.
# Produces a signed .pkg ready for `fastlane ios masupload`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="BalauDeck"
APP_CERT="3rd Party Mac Developer Application: OKDII SOLUTIONS (LAKGQXBNH6)"
INST_CERT="3rd Party Mac Developer Installer: OKDII SOLUTIONS (LAKGQXBNH6)"
ENTITLEMENTS="$ROOT/src-tauri/Entitlements.mas.plist"
PROFILE="$HOME/keystores/balaudeck-mas.provisionprofile"
P12PW="balaudeck-mas"
KC="$HOME/Library/Keychains/balaudeck-mas.keychain-db"
KCPW="bd-mas-kc"
OUT="$ROOT/src-tauri/target/release/bundle/macos"

echo "==> [1/5] dedicated signing keychain (no GUI prompts)"
security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
security import "$HOME/keystores/balaudeck-mac-app.p12"       -k "$KC" -P "$P12PW" -T /usr/bin/codesign
security import "$HOME/keystores/balaudeck-mac-installer.p12" -k "$KC" -P "$P12PW" -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null 2>&1

# Bake the desktop Google OAuth client, exactly like .github/workflows/release.yml
# does for the direct-download builds. Without this the MAS build has NO way to
# reach a client and Drive sync just reports "not configured":
#   - runtime env: a Dock-launched app inherits none;
#   - {app_data_dir}/gdrive_client.json: the MAS build is SANDBOXED, so its data
#     dir is inside ~/Library/Containers/… and it can never see the file the dev
#     build uses;
#   - option_env! bake: this, which nothing was setting.
# Read from the same per-machine file (never echoed — the secret must not be
# printed or committed; the repo is public and Google auto-disables leaked ones).
GDRIVE_JSON="${BALAUDECK_GDRIVE_CLIENT_JSON:-$HOME/Library/Application Support/com.okdii.balaudeck/gdrive_client.json}"
if [ -z "${BALAUDECK_GOOGLE_CLIENT_ID:-}" ] && [ -f "$GDRIVE_JSON" ]; then
  export BALAUDECK_GOOGLE_CLIENT_ID="$(/usr/bin/plutil -extract client_id raw -o - "$GDRIVE_JSON" 2>/dev/null || node -p "require('$GDRIVE_JSON').client_id")"
  export BALAUDECK_GOOGLE_CLIENT_SECRET="$(/usr/bin/plutil -extract client_secret raw -o - "$GDRIVE_JSON" 2>/dev/null || node -p "require('$GDRIVE_JSON').client_secret")"
fi
if [ -n "${BALAUDECK_GOOGLE_CLIENT_ID:-}" ] && [ -n "${BALAUDECK_GOOGLE_CLIENT_SECRET:-}" ]; then
  # Show the id's own suffix (not the shared .apps.googleusercontent.com tail) so
  # the line actually identifies which client got baked. Ids aren't secret.
  echo "==> Google Drive: baking desktop OAuth client (${BALAUDECK_GOOGLE_CLIENT_ID%%.apps.googleusercontent.com})"
elif [ "${BALAUDECK_ALLOW_NO_GDRIVE:-}" = "1" ]; then
  echo "!! WARNING: no Google OAuth client — Drive will report 'not configured'."
  echo "!!          Continuing because BALAUDECK_ALLOW_NO_GDRIVE=1."
else
  # HARD FAIL, not a warning. This script builds a Mac App Store submission: a
  # .pkg without the client reaches users with Drive sync dead, and that is
  # exactly how 0.3.1 and 0.3.2 shipped — the old warning scrolled past unread.
  echo "ERROR: no Google OAuth client found — refusing to build a store package"
  echo "       whose Drive sync would be broken for every user."
  echo "  fix: put client_id/client_secret in $GDRIVE_JSON,"
  echo "       or export BALAUDECK_GOOGLE_CLIENT_ID/_SECRET,"
  echo "       or set BALAUDECK_ALLOW_NO_GDRIVE=1 for a deliberate no-Drive build."
  exit 1
fi

echo "==> [2/5] tauri build (.app)"
# arm64-only is accepted by the Mac App Store only when the binary's deployment
# target is >= 12.0 (otherwise Apple demands an x86_64/universal build).
export MACOSX_DEPLOYMENT_TARGET=12.0
# The Mac App Store disallows self-updating binaries: compile the updater UI out
# of the frontend (BALAUDECK_STORE_BUILD) and don't emit updater artifacts.
export BALAUDECK_STORE_BUILD=1
npm run tauri -- build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'

APP="$OUT/$APP_NAME.app"
[ -d "$APP" ] || { echo "ERROR: $APP not found"; exit 1; }

# Prove the bake actually landed in the binary instead of trusting that the env
# vars were set: gdrive.rs reads them with option_env! at COMPILE time, so a
# stale object file silently ships the old (empty) value. build.rs declares
# rerun-if-env-changed to prevent that, but verify the artifact anyway — this is
# the check that would have caught 0.3.1/0.3.2 before they reached the store.
# Grep the FULL client id: the iOS/Android ids share the same project number and
# live in tauri.conf.json, so they're in EVERY binary — matching on the number
# prefix alone is a false positive. Values are counted, never printed.
if [ -n "${BALAUDECK_GOOGLE_CLIENT_ID:-}" ]; then
  echo "==> verify: OAuth client baked into the binary"
  BIN="$APP/Contents/MacOS/$APP_NAME"
  id_hits=$(strings -a "$BIN" | grep -cF -- "$BALAUDECK_GOOGLE_CLIENT_ID" || true)
  sec_hits=$(strings -a "$BIN" | grep -cF -- "$BALAUDECK_GOOGLE_CLIENT_SECRET" || true)
  echo "    client_id: $id_hits match(es) | client_secret: $sec_hits match(es)"
  if [ "$id_hits" -lt 1 ] || [ "$sec_hits" -lt 1 ]; then
    echo "ERROR: the OAuth client is NOT in the built binary — Drive sync would be"
    echo "       dead on arrival. A stale build cache is the usual cause:"
    echo "       run 'cargo clean -p balaudeck' in src-tauri and rebuild."
    exit 1
  fi
fi

echo "==> [3/5] embed provisioning profile"
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"

echo "==> [4/5] codesign (MAS app cert + sandbox entitlements; no hardened runtime)"
codesign --force --timestamp --keychain "$KC" \
  --sign "$APP_CERT" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --strict --verbose=2 "$APP"
echo "--- entitlements embedded in the signed app ---"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - 2>/dev/null \
  | grep -iE "sandbox|network|application-identifier|team-identifier" || true

echo "==> [5/5] productbuild signed .pkg"
PKG="$OUT/$APP_NAME.pkg"
rm -f "$PKG"
productbuild --component "$APP" /Applications --keychain "$KC" --sign "$INST_CERT" "$PKG"
echo "--- pkg signature ---"
pkgutil --check-signature "$PKG" 2>&1 | head -6
ls -la "$PKG"
echo "==> DONE: $PKG"
