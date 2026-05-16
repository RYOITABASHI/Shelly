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
  - `shelly scouter status|on|off|hooks`
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
3. Enable `SCOUTER` -> `Widget`.
4. Tap `Scouter Debug Info` and verify:
   - `enabled: true`
   - `port` is greater than zero
   - `hookTokenPreview` is present
5. Tap `Copy hook templates` to copy the exact runtime token and endpoints.
6. Add the `Scouter` widget to the Android home screen.
7. Send a test event from a Shelly terminal:

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

- widget status color changes to completed
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
- The loopback server accepts local device traffic only (`127.0.0.1`), requires `X-Scouter-Token`, caps request bodies at 64 KiB, and uses a small fixed request pool.
- Debug output redacts the token. `Copy hook templates` intentionally copies the full token because CC/Codex hook setup needs it.
- Disabling Scouter clears widget snapshots so the widget falls back to the waiting state.

## PoC 5A Notes

Phase 1A includes the native surface needed for later command injection but does not implement command injection. The current Shelly native PTY layer already exposes `TerminalEmulator.writeToSession(sessionId, text)`, which is the likely path for Shelly-managed sessions.

Open items for the dedicated PoC:

- map Scouter `sessionId` to Shelly native PTY session id
- confirm CC accepts normal prompt text through PTY stdin 20/20 times
- confirm Codex accepts normal prompt text through PTY stdin 20/20 times
- separately test permission prompt allow/deny before adding notification actions
