# Scouter Phase 1A

Scouter Phase 1A is the local-only Shelly widget MVP from `scouter-spec-v3.1.md`.

## Implemented

- Native Scouter core models:
  - `ScouterEvent`
  - `SessionSnapshot`
  - `ScouterSource`
  - `ScouterStatus`
- Local hook server:
  - binds only to `127.0.0.1`
  - picks a dynamic port on start
  - requires `X-Scouter-Token`
- Hook endpoints:
  - `POST /hook/cc/<event>`
  - `POST /hook/codex/<event>`
  - `POST /hook/<event>`
- JSONL polling fallback:
  - `~/.claude/projects/**/*.jsonl`
  - `~/.codex/sessions/**/*.jsonl`
- Shelly state bridge:
  - minimal adapter over native terminal sessions
- State storage:
  - SharedPreferences JSON snapshots
  - latest session drives the widget
- Medium 4x2 AppWidget:
  - event-driven `AppWidgetManager.updateAppWidget`
  - no short-period `updatePeriodMillis`
- Basic notifications:
  - completed
  - error
  - long-running tool activity after 120 seconds while Shelly remains alive
- Minimal settings/debug controls:
  - gear menu -> `SCOUTER`
  - `shelly config` -> `Scouter` -> `Scouter Widget`
  - native terminal helper: `shelly scouter status|hooks`
  - `Scouter Debug Info`
  - `Scouter Hook Template`

## Not Implemented

- Foreground Scouter service
- approval/deny notification actions
- Wear OS
- Small/Large widgets
- polished UI, animation, or screenshot tooling
- high-precision token/cost accounting
- automatic CC/Codex settings injection
- process-death survival without reopening Shelly

## Manual Verification

1. Build and install Shelly.
2. Open the top-right gear menu.
3. Enable `SCOUTER` -> `Scouter`.
4. Tap `Scouter Debug Info` and verify:
   - `enabled: true`
   - `port` is greater than zero
   - `hookTokenPreview` is present
5. Open a fresh Shelly terminal and verify the native helper:

```sh
cat ~/.bashrc_version
type shelly
shelly scouter status
shelly scouter hooks
```

Expected:

- `~/.bashrc_version` is `141` or newer
- `type shelly` prints a shell function that invokes `$HOME/bin/shelly`
- `shelly scouter status` prints cached state from `~/.scouter-state.json`
- `shelly scouter hooks` prints the full hook token and base URLs

6. Tap `Copy hook templates` to copy the exact runtime token and endpoints, or use `shelly scouter hooks`.
7. Add the `Scouter` widget to the Android home screen.
8. Send a test event from a Shelly terminal:

```sh
PORT=<port from Scouter Debug Info>
TOKEN=<token from Copy hook templates>
curl -sS \
  -H "X-Scouter-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"manual-test","cwd":"/home/shelly/demo","toolName":"Bash","toolInput":{"command":"echo hi"},"source":"claude"}' \
  "http://127.0.0.1:$PORT/hook/cc/pre-tool-use"
```

Expected:

- `{"ok":true}` from curl
- widget updates to show `demo`, `CC`, and `Bash`

8. Send a completion event:

```sh
curl -sS \
  -H "X-Scouter-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"manual-test","cwd":"/home/shelly/demo","source":"claude"}' \
  "http://127.0.0.1:$PORT/hook/cc/stop"
```

Expected:

- widget status color changes to completed/idle and the previous tool label is cleared
- basic completion notification is posted if notification permission is granted

## Hook Template Shape

The native debug action returns the runtime base URL and token. Use that output to generate real Claude Code/Codex hook settings. Phase 1A intentionally leaves automatic settings injection to a later Shelly integration pass.

Example endpoint layout:

```text
http://127.0.0.1:<dynamic-port>/hook/cc/user-prompt
http://127.0.0.1:<dynamic-port>/hook/cc/pre-tool-use
http://127.0.0.1:<dynamic-port>/hook/cc/post-tool-use
http://127.0.0.1:<dynamic-port>/hook/cc/post-tool-use-failure
http://127.0.0.1:<dynamic-port>/hook/cc/notification
http://127.0.0.1:<dynamic-port>/hook/cc/pre-compact
http://127.0.0.1:<dynamic-port>/hook/cc/stop

http://127.0.0.1:<dynamic-port>/hook/codex/user-prompt
http://127.0.0.1:<dynamic-port>/hook/codex/pre-tool-use
http://127.0.0.1:<dynamic-port>/hook/codex/permission-request
http://127.0.0.1:<dynamic-port>/hook/codex/post-tool-use
http://127.0.0.1:<dynamic-port>/hook/codex/stop
```

Every request must include:

```text
X-Scouter-Token: <hookToken>
```

## Known Runtime Limits

- Phase 1A intentionally does not use a foreground service. The hook server and JSONL watcher run while the Shelly app process is alive. If Android kills or force-stops Shelly, Scouter restarts only after Shelly is opened again.
- The hook server port is dynamic per Scouter process lifetime. After Shelly is restarted, old copied hook URLs can fail with `curl: (7) Failed to connect`; run `shelly scouter hooks` or use the gear debug action again to get the current port.
- The loopback server accepts local device traffic only (`127.0.0.1`), requires `X-Scouter-Token`, caps request bodies at 64 KiB, and uses a small fixed request pool.
- Debug output redacts the token. `Copy hook templates` intentionally copies the full token because CC/Codex hook setup needs it.
- Disabling Scouter clears widget snapshots so the widget falls back to the waiting state.
- The native terminal `shelly` helper reads cached status/hooks from `~/.scouter-state.json`. ON/OFF remains a gear-menu action because starting/stopping the hook server requires the in-process Android service. Gear-menu debug is authoritative for live in-memory service state.
- The helper is exposed as a bash function instead of executing `$HOME/bin/shelly` directly. Some Samsung/Android app-private filesystems returned `/system/bin/sh: bad interpreter: Success` for direct shebang execution.

## Device Verification Log

2026-05-16 dogfood candidate, Galaxy Z Fold6 + One UI Home:

- `SCOUTER` gear controls are visible and can enable Scouter.
- `shelly scouter hooks` works from a fresh Shelly terminal after `~/.bashrc_version` `141`.
- Runtime hooks expose `127.0.0.1:<dynamic-port>/hook/cc` and `/hook/codex` with `X-Scouter-Token`.
- Manual Claude-style `pre-tool-use` request returns `{"ok":true}` and updates the widget to show the test session, `CC`, and `Bash`.
- Manual `stop` request returns `{"ok":true}`; terminal states no longer leave a stale `Bash` tool label on the widget.
- One UI can add the Medium widget after the RemoteViews layout avoids unsupported raw `View` children.
- Reusing an old hook URL after app/process restart correctly fails because Phase 1A does not keep a foreground service alive and the port is regenerated.

## Widget Display

The Medium widget shows the latest session snapshot observed by Scouter, not necessarily the currently focused Shelly tab.

- Title: source and project, for example `Claude Code · demo`, `Codex · hw`, or `Shelly · home`.
- Badge: compact source code, `CC`, `CX`, or `SH`.
- Status line: human-readable state, for example `Running Bash in demo`, `Thinking in hw`, `Waiting in home`, `Completed in demo`, or `Error in demo`.
- Footer: optional cost/tokens/context, followed by `Last event HH:mm:ss`.

Long Android private paths are shortened for readability. For example, the Shelly terminal home path is displayed as `home` instead of the full app-private directory.

Dogfood checklist for the first week:

- Keep the Medium widget on the home screen and watch stale-state behavior after screen off, app switch, and app restart.
- Run `shelly scouter hooks` after opening Shelly before testing hooks, because copied ports are process-local.
- Observe notification volume for completed/error/long-running events.
- Watch JSONL watcher noise from old CC/Codex history and note whether old sessions should be filtered more aggressively.
- Decide before Phase 1B whether the no-foreground-service constraint is still acceptable for real hook reliability.

## PoC 5A Notes

Phase 1A includes the native surface needed for later command injection but does not implement command injection. The current Shelly native PTY layer already exposes `TerminalEmulator.writeToSession(sessionId, text)`, which is the likely path for Shelly-managed sessions.

Open items for the dedicated PoC:

- map Scouter `sessionId` to Shelly native PTY session id
- confirm CC accepts normal prompt text through PTY stdin 20/20 times
- confirm Codex accepts normal prompt text through PTY stdin 20/20 times
- separately test permission prompt allow/deny before adding notification actions
