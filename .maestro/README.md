# Shelly E2E Tests with Maestro

This directory contains Maestro flows for the current Shelly Android app
package: `dev.shelly.terminal`.

## Core Flows

- `01_setup_wizard_ja.yaml` / `01_setup_wizard.yaml` - setup flow entry smoke test through the native terminal.
- `02_chat_tab_ja.yaml` / `02_chat_tab.yaml` - chat pane smoke test.
- `03_terminal_tab_ja.yaml` / `03_terminal_tab.yaml` - native PTY regression: launch terminal, run `bash -c`, assert output, exit.
- `04_settings_tab_ja.yaml` / `05_settings_tab.yaml` - settings smoke test.
- `05_native_pty_recovery_ja.yaml` / `04_native_pty_recovery.yaml` - native PTY restart smoke test.

## Prerequisites

- Maestro CLI 2.3.0 or newer.
- Android Debug Bridge (`adb`) on `PATH`.
- Shelly installed on the target Android device.
- First-run setup completed for the strict terminal smoke tests.

## Run

```bash
maestro test .maestro/03_terminal_tab_ja.yaml
```

Windows helper:

```bat
.maestro\run-test.bat terminal
.maestro\run-test.bat pty
```

To reset app data before setup-flow testing:

```bash
adb shell pm clear dev.shelly.terminal
```

## Native PTY Smoke Contract

The terminal regression flow verifies:

1. The native terminal view mounts.
2. A command is sent through the PTY.
3. `bash -c 'echo SHELLY_PTY_SMOKE_OK'` produces visible output.
4. The shell accepts `exit`.

The native terminal view exposes `testID: native-terminal-view` so Maestro can
focus the actual PTY surface instead of relying on legacy tab labels.
