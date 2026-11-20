#!/usr/bin/env bash
# Runs on a CI Android emulator. Installs the app with all networking switched off,
# launches the built-in self-test and fails unless it reports PASS.
set -uo pipefail
APK="$1"
PKG=com.ioctls.reasonablechess
adb wait-for-device
adb shell svc wifi disable || true
adb shell svc data disable || true
adb shell cmd connectivity airplane-mode enable || true
adb install -r "$APK" || exit 1
echo "--- permissions granted to the app:"
adb shell dumpsys package $PKG | sed -n '/requested permissions:/,/install permissions:/p'
if adb shell dumpsys package $PKG | grep -q "android.permission.INTERNET"; then echo "FAIL: app has INTERNET permission"; exit 1; fi
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity --ez selftest true
line=""
for i in $(seq 1 90); do
  line=$(adb logcat -d -s ReasonableChess:I | grep -m1 SELFTEST || true)
  [ -n "$line" ] && break
  sleep 2
done
adb exec-out screencap -p > selftest.png || true
echo "--- result: ${line:-no SELFTEST output within 180s}"
if [ -z "$line" ]; then adb logcat -d | grep -iE "chromium|ReasonableChess|AndroidRuntime" | tail -60; fi
echo "$line" | grep -q "SELFTEST PASS"
