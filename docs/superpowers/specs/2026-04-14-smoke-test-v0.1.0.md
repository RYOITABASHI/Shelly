# v0.1.0 pre-release smoke test

Run this on-device with the APK that includes commit `ee2c9572` or
later. Every box is a hard gate for tagging `v0.1.0`. If any row
fails, file an issue, fix, rebuild, re-run the whole list.

Target device: Samsung Galaxy Z Fold 6 (the primary test target).
Should also pass on other Android 13+ arm64 devices.

---

## 0. Install & first launch

- [ ] APK installs without "parsing error"
- [ ] First launch completes without an ANR or red-screen JS error
- [ ] Permission prompts (storage, notifications) appear and grant cleanly
- [ ] Default layout renders: sidebar left, pane area right, status bars top/bottom

## 1. Theme presets (Task 1)

- [ ] Open Settings → Display → Theme. All four tiles render: Dracula, Nord, Gruvbox, Tokyo
- [ ] Tap **Dracula** → background + accent colors flip immediately
- [ ] Switch to each of the other three — colors swap, no PTY restart
- [ ] Open Command Palette → `theme-dracula` / `theme-nord` / `theme-gruvbox` / `theme-tokyo-night` all work
- [ ] Switching theme mid-session in an open terminal does NOT kill the running PTY

## 2. MCP Servers (Task 2)

- [ ] Settings → Integrations → MCP Servers → opens slide-up modal
- [ ] CLOSE button dismisses the modal
- [ ] McpSection renders — catalog visible, no red-screen
- [ ] Running a non-destructive test command (e.g. `echo hello`) returns exit 0 and output
- [ ] Long-running command (e.g. `sleep 5`) does not freeze the UI
- [ ] Modal can be reopened after closing

## 3. Scheduled agents (Task 3)

- [ ] In terminal pane, run `@agent smoke "echo hello"` (or similar registration)
- [ ] Sidebar Tasks section shows `SMOKE` under SCHEDULED subheader
- [ ] Tap ▶ run-now — command executes, output appears in the active terminal
- [ ] Tap 🗑 — Alert confirms, row disappears
- [ ] Restart app — row stays gone (persisted)

## 4. SSH Profiles (Task 4)

- [ ] Sidebar Profiles section is visible (not empty)
- [ ] Tap **Add Profile** → modal opens
- [ ] Fill: name=test, host=example.com, port=22, user=test, keyFile=~/.ssh/id_ed25519 → Save
- [ ] Row appears immediately
- [ ] Tap row → active terminal receives `ssh -i ~/.ssh/id_ed25519 test@example.com`
- [ ] Long-press → Edit → change name → Save → row updates
- [ ] Long-press → Delete → confirm → row disappears
- [ ] Restart app → deleted row stays gone, edited row survives
- [ ] `Import from ~/.ssh/config` button works (or shows "No new profiles" if ~/.ssh/config is empty)

## 5. Local LLM · llama.cpp (Task 5)

- [ ] Settings → Integrations → Local LLM · llama.cpp → opens slide-up modal
- [ ] Current endpoint URL is visible in the header
- [ ] Model catalog renders with recommended badge
- [ ] Tapping a model expands it
- [ ] **If binary is NOT installed**: tapping **Setup** kicks off the install; no timeout during build
- [ ] **If a model is already installed**: it shows as installed
- [ ] **Start server** eventually shows "running" status (may take 15-60 seconds for warmup)
- [ ] **Stop server** kills the process cleanly (verify with `ps` in terminal)
- [ ] Selecting a model updates the endpoint URL in settings
- [ ] CLOSE dismisses the modal

## 6. Cloud removed (Task 6)

- [ ] Sidebar has NO "CLOUD" section between Device and Ports
- [ ] No layout gap or broken border where the Cloud section used to be
- [ ] No "cloud" toggle in the sidebar section open-state

## 7. Ports monitor (regression)

- [ ] Sidebar **PORTS** section auto-opens or can be toggled
- [ ] Starting a local server (`python3 -m http.server 3000` in terminal) causes `:3000` to appear within 20s
- [ ] Tapping the `:3000` row opens `http://localhost:3000` in the Browser pane
- [ ] Stopping the server removes the row within 20s

## 8. Core pane regressions

- [ ] Terminal pane: type `ls -la`, hit Enter, see output. **Note the Enter-key 2x bug from known issues — log if it happens.**
- [ ] AI pane: open, type a short prompt, see streaming response
- [ ] Browser pane: open an https URL, page renders, back/forward/reload work
- [ ] Markdown pane: open a .md file, it renders as HTML
- [ ] Preview pane: opens a preview of the currently-edited file
- [ ] Multi-pane split: 2-pane, 3-pane, 4-pane layouts all render
- [ ] Drag to resize splitters works
- [ ] FileTree CRUD: create file, rename, delete, copy path

## 9. AI Edit golden path

- [ ] Open a file, ask AI to make a small change
- [ ] Diff shows in staged state
- [ ] Per-hunk Accept on hunk 1 succeeds
- [ ] Per-hunk Accept on hunk 2 (after hunk 1 shifted line numbers) succeeds via fuzzy re-anchor
- [ ] Final disk state matches expected

## 10. tmux keep-alive / immortal sessions

- [ ] Start a long-running process in terminal (`watch -n1 date`)
- [ ] Background the app, leave for 2 minutes
- [ ] Return to the app → the process is still running, output continues

## 11. Voice dialogue (optional — takes longer)

- [ ] Settings → enable voice
- [ ] Tap voice button → microphone permission granted
- [ ] Say a short prompt → STT works, response streams back, TTS plays

---

## Sign-off

All boxes checked?
- [ ] Yes → tag `v0.1.0`, run `git tag -a v0.1.0 -m "..."`, push, upload APK to GitHub Releases
- [ ] No → file issue(s), fix, rebuild, re-run.

**Tester**: ________  **Date**: ________  **Build SHA**: ________
