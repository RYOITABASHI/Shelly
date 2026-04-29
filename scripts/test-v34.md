# v34 Device Verification Checklist

**APK**: `shelly-apk` artifact from commit `15ee5843`
[Run page](https://github.com/RYOITABASHI/Shelly/actions/runs/24616285836)

Run through these in Shelly's Terminal Pane on device. Each block is
independent — skip any that don't apply to your current state.

---

## 1. BASHRC_VERSION regeneration

```bash
cat ~/.bashrc_version
# expect: 34
```

If still `32` or older:
```bash
logcat -d -t 20 | grep HomeInitializer
# should show: bashrc version check: current=... target=34 regenerate=true
```

## 2. Paste fix regression check (bug #97)

Copy these two lines together and paste into the terminal (don't press
Enter before checking the state of the buffer):

```
echo one
echo two
```

**Expected**: both lines appear as a single compound command,
displayed as `echo one↵echo two` (the `↵` is a rendered LF marker), and
pressing Enter once prints:

```
one
two
```

**Regression**: if `echo one` executes on its own before you press
Enter (you see `one` immediately and then a fresh prompt with `echo
two` queued), the paste pipeline has regressed and we need to reopen
bug #97.

## 3. claude CLI dispatch (extracted Bun cli.js default)

```bash
claude --version
# expect: [shelly] claude: latest via extracted Bun cli.js (Node)
#         2.1.122 (Claude Code) or newer

claude --print "Say OK"
# expect: OK

claude --print "Use bash to run: echo shelly-ok"
# expect: shelly-ok
```

The tier banner tells you which fallback tier the command is resolving
to. Current builds should use the extracted Node route. Fallback probes:

```bash
SHELLY_DISABLE_EXTRACTED_CLAUDE=1 claude --version
SHELLY_FORCE_LEGACY_CLAUDE=1 claude --version
```

Silence the banner: `SHELLY_SILENT_CLI_TIER=1 claude --version`.

```bash
cat ~/.shelly-cli/install.log 2>&1 | tail -30
# expect: no "cannot create" errors (cp -al fix)
#         "[install] health check OK, promoting staging" if auto-update ran
```

## 4. gemini + codex

```bash
gemini --version
# expect: 0.40.0 or later

codex --version
# expect: codex-cli 0.125.0-termux or later

codex -m gpt-5.5 "Say OK"
# expect: OK; must NOT print "requires a newer version of Codex"
```

## 5. shelly-cs — help + doctor

```bash
shelly-cs
# expect: usage banner with commands listed

shelly-cs doctor
# expect:
#   Client ID:      Ov23liLDXU…hlLG (default)
#   Template repo:  RYOITABASHI/shelly-codespace-template
#   Scope:          codespace repo read:user
#   Token:          ✗ missing (run `shelly-cs auth`)
#   Node:           v20.x.x
```

## 6. shelly-cs auth (OAuth device flow)

```bash
shelly-cs auth
```

**Expected flow**:
1. A boxed code like `XXXX-YYYY` is printed
2. `https://github.com/login/device` opens in the OS browser (Chrome /
   Samsung Internet / Arc)
3. Terminal shows `Waiting for authorization...` with a growing dot
   animation
4. Authorize the Shelly OAuth App in the browser — you'll see the app
   asking for scopes `codespace`, `repo`, `read:user`
5. Come back to Shelly; the terminal should show:
   ```
   ✓ Authenticated as {your-github-login}
   Token saved to /data/.../home/.shelly-cs/token
   ```

**Common failures**:
- *Device code expired* → 15 min elapsed without authorization. Re-run.
- *Device code request failed: 404* → OAuth App misconfigured. Verify
  `Enable Device Flow` is checked in github.com/settings/developers.
- *GitHub API 401 after auth* → token scope issue. Check `shelly-cs
  doctor` output.

```bash
shelly-cs doctor
# expect now:
#   Token:          ✓ present
#   Authenticated:  ✓ {your-login}
```

## 7. shelly-cs list

```bash
shelly-cs list
# expect: "(no codespaces — run `shelly-cs create ...`)"
# OR: existing codespaces if you have any
```

## 8. shelly-cs create (first codespace)

```bash
shelly-cs create
# uses default template: RYOITABASHI/shelly-codespace-template
# takes 1-3 minutes

# Or specify your own repo:
shelly-cs create --repo RYOITABASHI/Shelly
```

**Expected flow**:
1. `Looking up <repo>… ✓`
2. `Creating codespace (basicLinux32gb)…`
3. State transitions displayed: `Queued` → `Starting` → `Available`
4. `✓ Ready: <codespace-name>` (name is auto-generated like
   `animated-happy-walrus-abc123`)
5. Prints the codespace's `web_url`

## 9. shelly-cs open

```bash
shelly-cs open <codespace-name>
# expect: opens https://<name>.github.dev in OS browser
# → web terminal with claude-code pre-installed (thanks to the template's
#   postCreateCommand)
```

In the web terminal:
```bash
claude --version
# expect: 2.1.114 or later (latest — running on Ubuntu, no Android ABI issues)

claude
# expect: interactive REPL starts
```

This is the "mobile claude-code via Codespace" end-to-end success
path.

## 10. shelly-cs stop / delete

```bash
shelly-cs stop <codespace-name>
# pauses billing

shelly-cs delete <codespace-name> --yes
# removes the codespace entirely (will delete without prompting)
```

## 11. Error handling

```bash
shelly-cs list    # before auth
# expect: "Not authenticated. Run: shelly-cs auth"

SHELLY_OAUTH_CLIENT_ID=invalid shelly-cs auth
# expect: "Device code request failed: 401" or similar — env override works

shelly-cs create --repo does/not-exist
# expect: "GitHub API 404: Not Found"

shelly-cs open nonexistent-codespace
# expect: "GitHub API 404: codespace doesn't exist"
```

## 12. Cross-Pane Intelligence hero image prep (optional)

Set up the demo scenario:

```bash
# Terminal Pane:
python3 -c "assert False, 'expected 200 got 404'"
# outputs: AssertionError
```

In AI Pane (wide mode):
```
このエラー直して
```

**Expected**:
- `READING TERMINAL` badge appears on AI Pane header
- AI response references the `AssertionError` from terminal
- Response contains a code block with `[▶ Run]` ActionBlock

Screenshot this for the README/landing page hero image.

---

## Cleanup (if needed)

Reset to a clean state:

```bash
rm -rf ~/.shelly-cs ~/.shelly-cli ~/.shelly-cli.staging ~/.shelly-cli.prev
# force __shelly_bg_cli_update to re-run:
rm ~/.shelly_last_update
# reopen shell
```

---

## Logcat shortcuts

```bash
# Paste pipeline
adb logcat -s ShellyPaste:D ShellyIME:D

# CLI install / shelly-cs diagnostics
adb logcat -s HomeInitializer:* ShellyExec:*

# Full Shelly noise
adb logcat -s ShellyPaste:D ShellyIME:D ShellyExec:D ShellyPTY:D \
              HomeInitializer:D TerminalEmulator:D Sidebar:D Shelly:D
```
