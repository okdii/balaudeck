#!/usr/bin/env bash
# Release gate for BalauDeck. Every check here exists because it has ALREADY
# shipped a broken release at least once — see RELEASE.md for the incident
# behind each one. Run it; don't read it and nod.
#
#   ./scripts/release-check.sh preflight          before building anything
#   ./scripts/release-check.sh artifact mac|ios|android|github   after each build
#   ./scripts/release-check.sh submitted          after submitting to Apple
#
# Exit non-zero = do not release. That is the whole point: a warning that
# scrolls past is how 0.3.1 and 0.3.2 reached users with Drive sync dead.
set -uo pipefail

# NOTE for anyone editing this file: do NOT write `producer | grep -q pattern`.
# grep -q exits on the first match and closes the pipe, the producer dies of
# SIGPIPE, and `pipefail` then makes the whole pipeline non-zero — so a check
# that FOUND what it wanted reports failure. It cost an hour here. Capture the
# output into a variable and `case` on it, or use `grep -c` and compare a count.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

VER="$(node -p "require('$ROOT/package.json').version")"
VC="$(sed -n 's/^tauri.android.versionCode=//p' src-tauri/gen/android/app/tauri.properties)"

# Ids aren't secret; the secret is only ever counted, never printed.
DESKTOP_ID="1026513342801-v57h5l767csi88s5409s63fccbqinqtr"
IOS_ID="1026513342801-cucie52e3460i1qc34bp34gpahd66vbd"
ANDROID_ID="1026513342801-83trko1c7lnkki7v7it8qdm8oaqcc22e"

# ---------------------------------------------------------------- versions
check_versions() {
  head_ "Versions — all 6 sources must agree ($VER)"
  local cargo lock tauri projyml plist andname
  cargo="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
  lock="$(grep -A1 'name = "balaudeck"' src-tauri/Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)"
  tauri="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
  projyml="$(sed -n 's/.*CFBundleShortVersionString: //p' src-tauri/gen/apple/project.yml | head -1)"
  plist="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' src-tauri/gen/apple/balaudeck_iOS/Info.plist 2>/dev/null)"
  andname="$(sed -n 's/^tauri.android.versionName=//p' src-tauri/gen/android/app/tauri.properties)"
  for pair in "Cargo.toml:$cargo" "Cargo.lock:$lock" "tauri.conf.json:$tauri" \
              "project.yml:$projyml" "Info.plist:$plist" "tauri.properties:$andname"; do
    if [ "${pair#*:}" = "$VER" ]; then pass "${pair%%:*} = $VER"
    else fail "${pair%%:*} = ${pair#*:} — expected $VER"; fi
  done

  # MAC_VERSION and submit_now's default both name the version in review; a
  # stale one silently submits the wrong version string.
  local macver iosver
  macver="$(sed -n 's/.*MAC_VERSION = "\(.*\)".*/\1/p' fastlane/Fastfile | head -1)"
  iosver="$(sed -n 's/.*ver = options\[:v\] || "\(.*\)".*/\1/p' fastlane/Fastfile | head -1)"
  [ "$macver" = "$VER" ] && pass "Fastfile MAC_VERSION = $VER" || fail "Fastfile MAC_VERSION = $macver — expected $VER"
  [ "$iosver" = "$VER" ] && pass "Fastfile submit_now ver = $VER" || fail "Fastfile submit_now ver = $iosver — expected $VER"

  # Play rejects a versionCode that doesn't increase, but it rejects it AFTER a
  # full AAB build — cheaper to catch here.
  head_ "Android versionCode ($VC) must beat what's live on Play"
  local live
  live="$(fastlane android tracks 2>/dev/null | sed -n 's/.*production\[0\].*vc=\["\([0-9]*\)"\].*/\1/p' | head -1)"
  if [ -z "$live" ]; then warn "couldn't read the live versionCode (offline?) — verify by hand"
  elif [ "$VC" -gt "$live" ]; then pass "versionCode $VC > live $live"
  else fail "versionCode $VC does NOT beat live $live — Play will reject it"; fi
}

# ------------------------------------------------------------------- notes
check_notes() {
  head_ "Release notes — one per channel, and they must differ"
  # 0.3.2 went live on Play with an EMPTY what's-new because every supply lane
  # passed skip_upload_changelogs and nobody checked the shipped release.
  local ac="fastlane/metadata/android/en-US/changelogs/$VC.txt"
  if [ -s "$ac" ]; then pass "Android changelogs/$VC.txt ($(wc -c <"$ac" | tr -d ' ') bytes)"
  else fail "MISSING $ac — Play would ship an empty \"What's new\""; fi

  local mn="fastlane/metadata-mac/en-US/release_notes.txt"
  if [ -s "$mn" ]; then pass "macOS release_notes.txt ($(wc -l <"$mn" | tr -d ' ') lines)"
  else fail "MISSING/empty $mn"; fi

  if grep -q 'notes = options\[:notes\]' fastlane/Fastfile; then pass "iOS What's New heredoc present in submit_now"
  else fail "iOS submit_now has no notes heredoc"; fi

  # The channels genuinely diverge (a version live on Play may never have
  # shipped on Apple), so identical text across all three is a smell, not a win.
  local prev
  prev="$(git tag --sort=-v:refname | grep '^v' | head -1)"
  if [ -n "$prev" ] && git diff --quiet "$prev" -- "$mn" 2>/dev/null; then
    warn "macOS notes unchanged since $prev — is that deliberate?"
  fi
  if [ -n "$prev" ] && ! git diff --name-only "$prev" -- fastlane/Fastfile 2>/dev/null | grep -q .; then
    warn "Fastfile (iOS notes live here) unchanged since $prev — is that deliberate?"
  fi
}

# --------------------------------------------------------------------- git
check_git() {
  head_ "Git"
  if [ -z "$(git status --porcelain)" ]; then pass "working tree clean"
  else fail "uncommitted changes — a throwaway lane or a half-done edit would ship:
$(git status --porcelain | sed 's/^/          /')"; fi

  for lane in cancelreview macbuilds iosdraft macdraft playdraft; do
    grep -q "lane :$lane" fastlane/Fastfile && fail "throwaway lane ':$lane' still in Fastfile — git checkout fastlane/Fastfile"
  done
  grep -q "lane :cancelreview\|lane :macbuilds" fastlane/Fastfile || pass "no throwaway lanes in Fastfile"

  local author
  author="$(git log -1 --format='%an')"
  [ "$author" = "abukamila" ] && pass "last commit author = abukamila" \
    || fail "last commit author = $author — must be abukamila"
  if [ "$(git log -1 --format='%b' | grep -ci 'co-authored')" -gt 0 ]; then fail "last commit has a Co-Authored-By trailer"
  else pass "no Co-Authored-By trailer"; fi

  git fetch -q origin 2>/dev/null
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}' 2>/dev/null)" ]; then pass "pushed to origin"
  else fail "HEAD is not pushed — CI builds the TAG, so unpushed work silently won't ship"; fi
}

# ------------------------------------------------------------------- oauth
check_oauth() {
  head_ "Google OAuth client — local (for MAS) and CI (for the installers)"
  # gdrive.rs reads these with option_env! at COMPILE time. Unset => the app
  # ships with Drive sync dead and says nothing until a user clicks Connect.
  local f="${BALAUDECK_GDRIVE_CLIENT_JSON:-$HOME/Library/Application Support/com.okdii.balaudeck/gdrive_client.json}"
  if [ -n "${BALAUDECK_GOOGLE_CLIENT_ID:-}" ] || [ -f "$f" ]; then pass "local client available (mas-build.sh will bake it)"
  else fail "no local OAuth client — mas-build.sh will refuse to build"; fi

  if command -v gh >/dev/null 2>&1; then
    local names
    names="$(gh secret list --repo okdii/balaudeck 2>/dev/null | awk '{print $1}')"
    for s in BALAUDECK_GOOGLE_CLIENT_ID BALAUDECK_GOOGLE_CLIENT_SECRET TAURI_SIGNING_PRIVATE_KEY; do
      if [ "$(echo "$names" | grep -cx "$s")" -gt 0 ]; then pass "CI secret $s set"
      else fail "CI secret $s MISSING — tagged builds will fail the guard"; fi
    done
  else warn "gh not available — CI secrets unchecked"; fi
}

# ---------------------------------------------------------------- artifacts
# Grep an artifact for a baked value, with a CONTROL: something that MUST be
# present. If the control reads 0 the METHOD is broken, not the build — that is
# how the .msi (compressed payload) read as a false negative.
grep_bake() {
  local bin="$1" label="$2" want_secret="$3"
  local ctrl id sec
  ctrl=$(strings -a "$bin" 2>/dev/null | grep -cF "$ANDROID_ID")   # in every build via tauri.conf.json deep-links
  id=$(strings -a "$bin" 2>/dev/null | grep -cF "$DESKTOP_ID")
  sec=$(strings -a "$bin" 2>/dev/null | grep -c 'GOCSPX')
  if [ "$ctrl" -lt 1 ]; then
    fail "$label: CONTROL grep found nothing — the method is broken (compressed payload?), NOT proof of a bad build"
    return
  fi
  [ "$id" -ge 1 ] && pass "$label: desktop client id baked" || fail "$label: desktop client id MISSING — Drive sync dead"
  if [ "$want_secret" = "yes" ]; then
    [ "$sec" -ge 1 ] && pass "$label: client secret baked" || fail "$label: client secret MISSING — Drive sync dead"
  fi
}

fresh() {
  local f="$1" label="$2"
  [ -f "$f" ] || { fail "$label: $f does not exist"; return; }
  # IPA_PATH/MAC_PKG/AAB_PATH persist across releases: a failed export leaves the
  # PREVIOUS version sitting there and fastlane will happily upload it.
  if [ "$(stat -f %m "$f")" -gt "$(git log -1 --format=%ct)" ]; then pass "$label: newer than HEAD ($(date -r "$(stat -f %m "$f")" '+%H:%M:%S'))"
  else fail "$label: STALE — older than the last commit; it is a previous build"; fi
}

check_artifact() {
  case "$1" in
    mac)
      head_ "macOS App Store .pkg"
      local app="src-tauri/target/release/bundle/macos/BalauDeck.app"
      local pkg="src-tauri/target/release/bundle/macos/BalauDeck.pkg"
      fresh "$pkg" "pkg"
      local v; v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null)"
      [ "$v" = "$VER" ] && pass "built version = $VER" || fail "built version = $v — expected $VER"
      grep_bake "$app/Contents/MacOS/BalauDeck" "pkg" yes
      local sig ents
      sig="$(codesign -dvv "$app" 2>&1)"
      ents="$(codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -p - 2>/dev/null)"
      case "$sig" in
        *"3rd Party Mac Developer Application"*) pass "signed with the MAS app cert" ;;
        *) fail "wrong signing identity for MAS" ;;
      esac
      case "$ents" in
        *'"com.apple.security.app-sandbox" => true'*) pass "sandbox entitlement present" ;;
        *) fail "app-sandbox entitlement missing — MAS will reject" ;;
      esac
      ;;
    ios)
      head_ "iOS .ipa"
      local ipa="src-tauri/gen/apple/build/arm64/BalauDeck.ipa"
      fresh "$ipa" "ipa"
      local d=/tmp/rc-ipa; rm -rf $d; mkdir -p $d; unzip -q "$ipa" -d $d 2>/dev/null
      local v; v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' $d/Payload/BalauDeck.app/Info.plist 2>/dev/null)"
      [ "$v" = "$VER" ] && pass "ipa version = $VER" || fail "ipa version = $v — expected $VER"
      local sig; sig="$(codesign -dvv $d/Payload/BalauDeck.app 2>&1)"
      case "$sig" in
        *"Apple Distribution"*) pass "signed with Apple Distribution" ;;
        *) fail "not distribution-signed" ;;
      esac
      local n; n=$(strings -a $d/Payload/BalauDeck.app/BalauDeck 2>/dev/null | grep -cF "$IOS_ID")
      [ "$n" -ge 1 ] && pass "iOS OAuth client baked" || fail "iOS OAuth client MISSING"
      rm -rf $d
      ;;
    android)
      head_ "Android .aab"
      local aab="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
      fresh "$aab" "aab"
      local d=/tmp/rc-aab; rm -rf $d; mkdir -p $d; unzip -q "$aab" -d $d 2>/dev/null
      grep -q "$VER" <(strings -a $d/base/manifest/AndroidManifest.xml 2>/dev/null) \
        && pass "aab manifest carries $VER" || fail "aab manifest does not carry $VER"
      local so; so=$(find $d -name "libbalaudeck_lib.so" | grep arm64 | head -1)
      local n; n=$(strings -a "$so" 2>/dev/null | grep -cF "$ANDROID_ID")
      [ "$n" -ge 1 ] && pass "Android OAuth client baked" || fail "Android OAuth client MISSING"
      rm -rf $d
      ;;
    github)
      head_ "Published GitHub installers"
      local d=/tmp/rc-gh; rm -rf $d; mkdir -p $d
      (cd $d && gh release download "v$VER" --repo okdii/balaudeck --pattern "*.dmg" >/dev/null 2>&1)
      if [ -f "$d/BalauDeck_${VER}_aarch64.dmg" ]; then
        hdiutil attach -nobrowse -quiet "$d/BalauDeck_${VER}_aarch64.dmg" -mountpoint /tmp/rc-mnt 2>/dev/null
        grep_bake "/tmp/rc-mnt/BalauDeck.app/Contents/MacOS/BalauDeck" "dmg" yes
        hdiutil detach /tmp/rc-mnt -quiet 2>/dev/null
      else warn "no v$VER .dmg published yet"; fi
      rm -rf $d
      ;;
    *) echo "usage: $0 artifact mac|ios|android|github"; exit 2 ;;
  esac
}

# -------------------------------------------------------------- store flag
check_storeflag() {
  head_ "Store-build flag — gates the update pill AND the local-terminal tab"
  # Grepping the shipped BINARY is a false negative (Tauri compresses the
  # embedded frontend). Build dist/ both ways and grep that, with a control.
  local js ctrl on off
  BALAUDECK_STORE_BUILD=1 npm run build >/dev/null 2>&1
  js=$(ls -S dist/assets/*.js | head -1)
  ctrl=$(grep -c 'balaudeck.settings' "$js"); on=$(grep -c 'balaudeck.storeCheck' "$js")
  npm run build >/dev/null 2>&1
  js=$(ls -S dist/assets/*.js | head -1)
  off=$(grep -c 'balaudeck.storeCheck' "$js")
  if [ "$ctrl" -lt 1 ]; then fail "CONTROL string absent — the check itself is broken"; return; fi
  [ "$on" -ge 1 ] && pass "STORE_BUILD=1 compiles the store-update pill IN" \
                  || fail "STORE_BUILD=1 does NOT compile the pill in — store users get no update notice"
  [ "$off" -eq 0 ] && pass "no flag compiles it OUT (desktop keeps its self-updater)" \
                   || fail "the pill leaks into the direct-download build"
  for lane in ios android; do
    if grep -q "BALAUDECK_STORE_BUILD=1 npm run tauri -- $lane build" fastlane/Fastfile; then
      pass "fastlane '$lane build' sets STORE_BUILD=1"
    else
      fail "fastlane '$lane build' does NOT set STORE_BUILD=1 — the store-update pill would be compiled out"
    fi
  done
  grep -q "export BALAUDECK_STORE_BUILD=1" scripts/mas-build.sh \
    && pass "mas-build.sh sets STORE_BUILD=1" || fail "mas-build.sh does NOT set STORE_BUILD=1"
}

# --------------------------------------------------------------- submitted
check_submitted() {
  head_ "Submitted to Apple — is the RIGHT BINARY attached?"
  # deliver attaches "the newest VALID build" — which is the PREVIOUS release
  # while the new pkg is still processing. The version reads 0.3.4 and the
  # binary is 0.3.3, and every log line says success.
  local out; out="$(fastlane ios appstatus 2>&1 | grep -E '^\[.*(iOS|macOS):')"
  echo "$out" | sed 's/^/    /'
  if echo "$out" | grep -q "BUILD MISMATCH"; then
    fail "attached build != version — cancel the submission and re-attach"
  else pass "attached build matches the version on both platforms"; fi
  echo "$out" | grep -q "edit=$VER/" && pass "the version in review is $VER" \
    || fail "the version in review is not $VER"
}

case "${1:-}" in
  preflight)  check_versions; check_notes; check_git; check_oauth; check_storeflag ;;
  versions)   check_versions ;;
  notes)      check_notes ;;
  git)        check_git ;;
  oauth)      check_oauth ;;
  storeflag)  check_storeflag ;;
  artifact)   check_artifact "${2:-}" ;;
  submitted)  check_submitted ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

echo
if [ "$FAIL" -eq 0 ]; then printf '\033[32m  ALL CHECKS PASSED — safe to proceed\033[0m\n'; exit 0
else printf '\033[31m  CHECKS FAILED — do NOT release until these are fixed\033[0m\n'; exit 1; fi
