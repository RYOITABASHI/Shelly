# overlay-guard (shelly-hayato-bridge #6, item 1)

Writing the phone's `Settings.Global overlay_display_devices` puts an overlay
display on the owner's screen (display 0). It happened on 2026-11-26 and
2026-11-28 from PC jobs using adb. Android has no per-key write ACL for the
shell uid, so the guard is two PC-side layers plus a device-side reverter.

## PC (copies of the live files; the live ones are outside this repo)
| file | installed at | role |
|---|---|---|
| `pc/overlay-guard.js` | `~/.claude/hooks/overlay-guard.js`, `PreToolUse` hook in `~/.claude/settings.json` (matcher `Bash\|PowerShell\|mcp__.*`) | refuses a tool call that writes the key (put/delete/reset, `content` writes, a key in a variable). Reads and prose pass. |
| `pc/adb-shim.cs` | compiled to `~/.shelly-guard/bin/adb.exe`, first on the user PATH (and `~/.bashrc`) | refuses the same writes for any process that runs `adb` (scripts, Codex jobs); otherwise passes the raw command line to the real adb. Logs to `~/.claude/overlay-guard.log`. |
| `pc/shelly-vd` | `~/.shelly-guard/bin/shelly-vd` | the sanctioned background VD (`scrcpy --new-display`), `open` / `close` (only its own scrcpy) / `status`. |
| `pc/overlay-sentinel-ensure` | `~/.shelly-guard/bin/` | starts the sentinel unless it runs. The adb watcher (`~/.claude/adb-autoconnect/autoconnect.js`) does the same every 60 s while the phone is up. |
| `pc/test-shim.sh`, `pc/selftest-sentinel.sh` | | self-tests (the shim's block cases point the real adb at `where.exe`; the sentinel self-test uses the harmless key `shelly_sentinel_selftest`). |

## Phone: `sentinel/` (built by `.github/workflows/build-overlay-sentinel.yml`)
`OverlaySentinel` runs as the shell uid via `app_process` from
`/data/local/tmp/overlay-sentinel.dex`, log `/data/local/tmp/overlay-sentinel.log`.
Android 17 refuses content observers from an app_process ("Failed to find
PID"), so it polls once a second through an in-process `shellCommand` on the
`settings` binder (no fork; ~0.2% of a core measured) and deletes any value
other than null / "" / none (revert 5–6 ms after detection on device).
Shelly never gets WRITE_SECURE_SETTINGS (its agent workers share its uid).
