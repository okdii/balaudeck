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
else
  echo "!! WARNING: no Google OAuth client found — Drive will report 'not configured' in this build."
  echo "!!          Put client_id/client_secret in $GDRIVE_JSON, or export BALAUDECK_GOOGLE_CLIENT_ID/_SECRET."
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
