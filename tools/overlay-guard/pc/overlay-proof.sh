#!/bin/bash
# One-time field proof (owner-approved 2026-11-28): write overlay_display_devices
# once through the REAL adb (bypassing the hook and the shim on purpose) and
# measure on the phone's clock how long until the sentinel clears it.
REAL_ADB='C:\Users\ryoxr\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v3.3.4\adb.exe'
export MSYS_NO_PATHCONV=1
"$REAL_ADB" -s 100.83.52.23:5555 shell '
K=overlay_display_devices
echo "before=$(settings get global $K)"
t0=$(date +%s%3N); echo "write_at=$(date +%T.%3N)"
settings put global $K 720x480/160
t1=$(date +%s%3N); echo "written ms_to_return=$((t1-t0)) value_now=$(settings get global $K)"
i=0
while [ $i -lt 100 ]; do
  v=$(settings get global $K)
  if [ "$v" = null ] || [ -z "$v" ]; then t2=$(date +%s%3N); echo "cleared_at=$(date +%T.%3N) ms_after_write=$((t2-t0))"; break; fi
  i=$((i+1)); sleep 0.05
done
[ $i -ge 100 ] && echo "NOT CLEARED within ~5s, value=$(settings get global $K)"
echo "after=$(settings get global $K)"
'
