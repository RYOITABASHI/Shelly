#!/bin/bash
# Self-test of the adb shim. Block cases point SHELLY_REAL_ADB at where.exe, so
# nothing can reach the phone even if the shim failed to refuse.
S=/c/Users/ryoxr/.shelly-guard/bin/adb.exe
export MSYS_NO_PATHCONV=1
blk() { SHELLY_REAL_ADB='C:\Windows\System32\where.exe' "$S" "$@" >/dev/null 2>&1; echo "BLOCK-case rc=$? (want 13): $*" | cut -c1-110; }
blk -s x shell settings put global overlay_display_devices 1080x1920/420
blk shell "settings delete global overlay_display_devices"
blk shell cmd settings put --user 0 global overlay_display_devices v
blk shell 'settings put global $K v'
blk shell settings reset global
blk shell content insert --uri content://settings/global --bind name:s:overlay_display_devices --bind value:s:1
# Pass-through against the real adb (harmless commands only).
A="$S -s 100.83.52.23:5555"
echo "version: $($S version | head -1)"
echo "get: $($A shell settings get global overlay_display_devices)"
echo "stdin: $(echo piped-ok | $A shell cat)"
$A shell 'exit 3'; echo "exit-code rc=$? (want 3)"
echo "quoted: $($A shell 'echo "a b"  c')"
