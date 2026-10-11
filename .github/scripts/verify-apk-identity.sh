#!/usr/bin/env bash
# Checks that everything keyed on the applicationId came out right in a
# built APK: the package name, the launcher label, the FileProvider
# authority (Capacitor's BridgeWebChromeClient builds it at runtime as
# getPackageName() + ".fileprovider", so the manifest must match), and
# androidx.core's <package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION.
#
# Usage: verify-apk-identity.sh <apk> <expected-package> <expected-label>
set -euo pipefail

APK="$1"
PKG="$2"
LABEL="$3"

SDK_ROOT="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
AAPT2=$(find "$SDK_ROOT/build-tools" -name aapt2 -type f | sort -V | tail -1)
if [ -z "$AAPT2" ]; then
  echo "::error::Could not locate aapt2 under $SDK_ROOT/build-tools"
  exit 1
fi

fail=0
badging=$("$AAPT2" dump badging "$APK")
manifest=$("$AAPT2" dump xmltree --file AndroidManifest.xml "$APK")
permissions=$("$AAPT2" dump permissions "$APK")

echo "=== Identity of $APK ==="
grep -E "^(package|application-label|launchable-activity):" <<<"$badging" || true
grep -F "android:authorities" <<<"$manifest" || true
grep -F "DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" <<<"$permissions" || true

if ! grep -qE "^package: name='${PKG//./\\.}' " <<<"$badging"; then
  echo "::error::Package name is not $PKG"
  fail=1
fi
if ! grep -qxF "application-label:'$LABEL'" <<<"$badging"; then
  echo "::error::Application label is not '$LABEL'"
  fail=1
fi
if ! grep -E "^launchable-activity:" <<<"$badging" | grep -qF "label='$LABEL'"; then
  echo "::error::Launcher activity label is not '$LABEL'"
  fail=1
fi
if ! grep -qF "=\"$PKG.fileprovider\"" <<<"$manifest"; then
  echo "::error::FileProvider authority is not $PKG.fileprovider"
  fail=1
fi
receiver_perm="$PKG.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
if ! grep -qF "$receiver_perm" <<<"$permissions"; then
  echo "::error::$receiver_perm is not declared"
  fail=1
fi
if grep -F "DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" <<<"$permissions" | grep -vqF "$receiver_perm"; then
  echo "::error::A DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION uses a package other than $PKG"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "Confirmed: $APK is $PKG, labelled '$LABEL', with matching FileProvider authority and receiver permission"
