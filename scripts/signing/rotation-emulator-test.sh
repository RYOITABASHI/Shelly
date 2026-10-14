#!/usr/bin/env bash
# Functional check of Shelly's APK Signature Scheme v3 key-rotation lineage on
# a real Android (API 28+) emulator, using a tiny code-less throwaway package
# (dev.shelly.rotationtest) instead of the 800 MB Shelly APK:
#
# The package declares signature-protection permissions like Shelly does.
#
#   1. v1 signed ONLY with the legacy public debug key        -> installs
#   2. v2 signed with rotation (debug -> release, lineage)    -> in-place update succeeds (data kept)
#   3. v3 signed ONLY with the legacy debug key               -> REJECTED (old key has no rollback capability)
#   4. v4 signed ONLY with the release key (no lineage)       -> in-place update succeeds
#
# Required env: APKSIGNER AAPT2 ZIPALIGN ANDROID_JAR DEBUG_KS REL_KS REL_ALIAS
#               REL_PASS REL_KEY_PASS LINEAGE
set -euo pipefail

pkg=dev.shelly.rotationtest
work="$(mktemp -d)"

build_unsigned() {
  local vc="$1"
  cat > "${work}/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}">
  <!-- Mirror Shelly: the package declares signature-protected permissions
       (androidx adds <pkg>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION). Without
       the old signer's PERMISSION capability in the lineage, the rotated
       update fails with INSTALL_FAILED_DUPLICATE_PERMISSION. -->
  <permission android:name="${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" android:protectionLevel="signature" />
  <permission android:name="${pkg}.SIGNATURE_TEST" android:protectionLevel="signature" />
  <uses-permission android:name="${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
  <application android:hasCode="false" android:label="rotationtest" />
</manifest>
EOF
  "${AAPT2}" link --manifest "${work}/AndroidManifest.xml" -I "${ANDROID_JAR}" \
    --version-code "${vc}" --version-name "${vc}" \
    --min-sdk-version 24 --target-sdk-version 34 -o "${work}/u${vc}.apk"
  "${ZIPALIGN}" -f 4 "${work}/u${vc}.apk" "${work}/a${vc}.apk"
}

sign_debug() {
  "${APKSIGNER}" sign --ks "${DEBUG_KS}" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android --out "$2" "$1"
}

sign_release() {
  "${APKSIGNER}" sign --ks "${REL_KS}" --ks-key-alias "${REL_ALIAS}" \
    --ks-pass env:REL_PASS --key-pass env:REL_KEY_PASS --out "$2" "$1"
}

sign_rotation() {
  "${APKSIGNER}" sign --ks "${DEBUG_KS}" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android \
    --next-signer --ks "${REL_KS}" --ks-key-alias "${REL_ALIAS}" \
    --ks-pass env:REL_PASS --key-pass env:REL_KEY_PASS \
    --lineage "${LINEAGE}" --rotation-min-sdk-version 28 --out "$2" "$1"
}

for vc in 1 2 3 4; do build_unsigned "${vc}"; done
sign_debug "${work}/a1.apk" "${work}/v1-debug.apk"
sign_rotation "${work}/a2.apk" "${work}/v2-rotation.apk"
sign_debug "${work}/a3.apk" "${work}/v3-debug.apk"
sign_release "${work}/a4.apk" "${work}/v4-release.apk"

echo "== rotated APK signers =="
"${APKSIGNER}" verify -v --print-certs "${work}/v2-rotation.apk" | grep -E 'Verified using|SHA-256 digest|minSdk|Signer' || true
"${APKSIGNER}" lineage --in "${work}/v2-rotation.apk" --print-certs -v || true

expect_install() {
  local apk="$1" want="$2" out
  out="$(adb install -r "${apk}" 2>&1 || true)"
  echo "install $(basename "${apk}"): ${out}"
  if [ "${want}" = "success" ]; then
    printf '%s\n' "${out}" | grep -q '^Success' || { echo "FATAL: expected success for $(basename "${apk}")" >&2; exit 1; }
  else
    printf '%s\n' "${out}" | grep -q "${want}" || { echo "FATAL: expected ${want} for $(basename "${apk}")" >&2; exit 1; }
  fi
}

adb wait-for-device
echo "device API: $(adb shell getprop ro.build.version.sdk | tr -d '\r')"
adb uninstall "${pkg}" >/dev/null 2>&1 || true

expect_install "${work}/v1-debug.apk" success
expect_install "${work}/v2-rotation.apk" success
adb shell dumpsys package "${pkg}" | grep -iE 'versionCode|signatures|signingDetails|pastSigningCertificates' || true
# Informational (documents the PERMISSION-capability trade-off, never fails):
# does a different app signed only with the public debug key get the
# rotated package's signature permission granted? (run while v2, the
# rotated build with the debug -> release lineage, is installed)
other="${pkg}.other"
cat > "${work}/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${other}">
  <uses-permission android:name="${pkg}.SIGNATURE_TEST" />
  <application android:hasCode="false" android:label="other" />
</manifest>
EOF
"${AAPT2}" link --manifest "${work}/AndroidManifest.xml" -I "${ANDROID_JAR}" \
  --version-code 1 --version-name 1 --min-sdk-version 24 --target-sdk-version 34 -o "${work}/uo.apk"
"${ZIPALIGN}" -f 4 "${work}/uo.apk" "${work}/ao.apk"
sign_debug "${work}/ao.apk" "${work}/other-debug.apk"
adb uninstall "${other}" >/dev/null 2>&1 || true
expect_install "${work}/other-debug.apk" success
echo "TRADE-OFF: debug-signed ${other} -> ${pkg}.SIGNATURE_TEST:"
adb shell dumpsys package "${other}" | grep -F "${pkg}.SIGNATURE_TEST" || echo "  (not listed)"
adb uninstall "${other}" >/dev/null 2>&1 || true

expect_install "${work}/v3-debug.apk" INSTALL_FAILED_UPDATE_INCOMPATIBLE
expect_install "${work}/v4-release.apk" success

adb uninstall "${pkg}" >/dev/null 2>&1 || true
echo "ROTATION CHECK PASSED: debug->rotated update kept in place; debug-only APK rejected over the rotated app; release-only APK accepted."
