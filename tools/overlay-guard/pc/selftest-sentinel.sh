#!/bin/bash
# Deploys the sentinel dex from a build-overlay-sentinel run and self-tests it on a harmless key.
set -u; R=$1; D=/c/Users/ryoxr/.shelly-guard/sentinel; export MSYS_NO_PATHCONV=1; A="adb -s 100.83.52.23:5555"
rm -rf $D; mkdir -p $D; gh run download $R -R RYOITABASHI/Shelly -n overlay-sentinel -D C:/Users/ryoxr/.shelly-guard/sentinel || exit 1
echo "dex sha256 (CI): $(cut -c1-64 $D/overlay-sentinel.dex.sha256)"
$A shell 'for p in $(pgrep -f "OverlaySentinel --key shelly_sentinel_selftest"); do kill $p; done; settings delete global shelly_sentinel_selftest >/dev/null' 2>/dev/null
$A push C:/Users/ryoxr/.shelly-guard/sentinel/overlay-sentinel.dex /data/local/tmp/overlay-sentinel.dex >/dev/null
$A shell 'chmod 644 /data/local/tmp/overlay-sentinel.dex; echo "dex sha256 (phone): $(sha256sum /data/local/tmp/overlay-sentinel.dex | cut -c1-64)"; rm -f /data/local/tmp/overlay-sentinel-selftest.*; CLASSPATH=/data/local/tmp/overlay-sentinel.dex setsid nohup app_process / dev.shelly.sentinel.OverlaySentinel --key shelly_sentinel_selftest --log /data/local/tmp/overlay-sentinel-selftest.log >/data/local/tmp/overlay-sentinel-selftest.out 2>&1 &'
sleep 4
for i in 1 2 3; do $A shell "settings put global shelly_sentinel_selftest trial$i; sleep 1; echo trial$i after=\$(settings get global shelly_sentinel_selftest)"; done
$A shell 'cat /data/local/tmp/overlay-sentinel-selftest.log; tail -3 /data/local/tmp/overlay-sentinel-selftest.out; echo observers=$(dumpsys content | grep -c shelly_sentinel_selftest)'
