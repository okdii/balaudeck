#!/usr/bin/env bash
#
# Build (optional) and install BalauDeck to the Android phone entirely over Wi-Fi.
#
# Android 11+ "Wireless debugging" needs NO USB cable: pair the phone once
# (Developer options > Wireless debugging > "Pair device with code", then on the
# Mac `adb pair <ip>:<pairPort>`), after which this script connects, installs and
# launches over the network. The only catch is that the connect port changes
# whenever the phone reboots or you toggle Wireless debugging — so this script
# first tries the last-known endpoint, then falls back to mDNS discovery to find
# the current port automatically.
#
# Usage:
#   scripts/android-wifi-install.sh           # install the latest built APK over Wi-Fi
#   scripts/android-wifi-install.sh --build   # rebuild the debug APK first, then install
#
# Override the phone address if DHCP moved it:
#   BALAUDECK_ANDROID_IP=192.168.8.140 scripts/android-wifi-install.sh
#
set -euo pipefail

PKG="com.okdii.balaudeck"
DEVICE_IP="${BALAUDECK_ANDROID_IP:-192.168.8.133}"
KNOWN_PORT="${BALAUDECK_ANDROID_PORT:-39525}"
APK="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.0.12077973}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export PATH="$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH"

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--build" ]]; then
  echo "==> Building debug APK…"
  npm run tauri -- android build --apk --debug --target aarch64
fi

# Try to (re)connect to an endpoint; echo it and succeed if adb reports connected.
connect() {
  adb connect "$1" 2>/dev/null | grep -qiE "connected to" && return 0
  return 1
}

echo "==> Connecting to the phone over Wi-Fi…"
ENDPOINT=""
if connect "${DEVICE_IP}:${KNOWN_PORT}"; then
  ENDPOINT="${DEVICE_IP}:${KNOWN_PORT}"
else
  echo "   last-known port stale — discovering current port via mDNS…"
  PORT="$(timeout 6 dns-sd -Z _adb-tls-connect._tcp 2>/dev/null | awk '/SRV/ {print $5; exit}')"
  if [[ -n "${PORT:-}" ]] && connect "${DEVICE_IP}:${PORT}"; then
    ENDPOINT="${DEVICE_IP}:${PORT}"
  fi
fi

if [[ -z "$ENDPOINT" ]]; then
  echo "!! Could not reach the phone over Wi-Fi."
  echo "   On the phone: Developer options > Wireless debugging (ON)."
  echo "   First time only: 'Pair device with code', then on the Mac:"
  echo "       adb pair <phone-ip>:<pairing-port>"
  echo "   Then re-run this script (set BALAUDECK_ANDROID_IP if the IP changed)."
  exit 1
fi
echo "   connected: $ENDPOINT"

if [[ ! -f "$APK" ]]; then
  echo "!! APK not found at $APK"
  echo "   Run again with --build to produce it first."
  exit 1
fi

echo "==> Installing (this is a large debug APK, give it a moment)…"
adb -s "$ENDPOINT" install -r "$APK"

echo "==> Launching…"
adb -s "$ENDPOINT" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

echo "==> Done — $PKG installed and launched on $ENDPOINT over Wi-Fi."
