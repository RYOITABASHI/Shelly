# Spotify "magic" demo — handoff (2026-10-16)

Read this first in a new session. Context: promo clip for v8.1.x. Single screen (Fold6 **cover screen**, portrait, English UI): ChatGPT app → Codex (remote: localhost = Shelly) asks for a Spotify playlist → one tap to approve on the phone → ChatGPT says it's done → open Spotify, the playlist is there. ClosePaw runs in the **background virtual display** (user's choice).

## Prompt (send in ChatGPT → Codex, localhost connected)

```
On this phone, open the Spotify app and make a playlist called "Smells Like 1991" with 10 songs from Nirvana, Pearl Jam, Soundgarden and Alice in Chains. Use shelly closepaw --wait. Reply in English.
```

Without "On this phone … Spotify app" Codex looked for a Spotify plugin; without "shelly closepaw" it tried `am start` (blocked by Knox). Durable fix still TODO: tell Codex (e.g. a home AGENTS.md / skill Shelly ships) that phone-app UI tasks go through `shelly closepaw --wait`.

## State of the fixes (all reviewed; on-device verification pending)

1. **Shelly `7cda9fbb2` on main** (SHELLY_HELPER_SHIM v19 / BASHRC_VERSION 267): `shelly closepaw --wait` now prints a model-directed "keep waiting, don't end your turn" line, 10 s progress lines, and only prints the "ask the user to approve" text after the 100 s budget. Root cause: Codex exec yields after ~10 s and GPT-6.1 Sol (low) ended the turn on the approval hint. CI build run `38874773653` (check `gh run list --branch main`). Install via the in-app updater, then open a NEW terminal tab so `.bashrc` v267 regenerates.
2. **ClosePaw fork `RYOITABASHI/closepaw`, branch `fix/vd-text-input`** (local clone `C:/Users/ryoxr/closepaw-work` on the office PC only), commits `296dc4b6` (VD text input via Shizuku `input -d <vdDisplayId> text`, clipboard paste for non-ASCII) and `9bca1199` (foreground-mode runs return to the app that was in front at hand-off, e.g. ChatGPT). Root cause: Spotify's Compose name field rejects ACTION_SET_TEXT and VD mode disables tap-to-focus → no input path. Test APK = CI artifact of run `38868318063`:
   ```bash
   gh run download 38868318063 -R RYOITABASHI/closepaw -n closepaw-shelly-apk
   adb install -r ClosePaw-shelly-10.apk
   ```
   Same signing key (in-place update keeps settings). Not released yet; after on-device success publish with `gh workflow run build-shelly-variant.yml -R RYOITABASHI/closepaw --ref fix/vd-text-input -f release_tag=shelly-v0.1.0-9` and merge the branch.

## Device setup already done

- Device language: English. ClosePaw → App access: **Spotify = Allow** (otherwise a per-app "Always allow / Allow this time" notification appears and the run auto-cancels after ~60 s if unanswered).
- Keep ChatGPT connected (autostart) ON; after a Shelly update ChatGPT shows "connection interrupted" for ~2 min then reconnects by itself.
- Leftovers to delete before the real shoot: any "Smells Like 1991" playlist / half-created playlist in Spotify from rehearsals.

## Rehearsal checklist (no recording)

1. `adb logcat -c`, send the prompt, approve the Shelly notification ("Approve").
2. Watch: `adb logcat | grep -E "ClosePawShellApprovals|AgentSession: (Task started|Shutting)|VDTextInjector|ShizukuShellExec|ShellyResultCallback"`. Expect `input -d <id> text Smells%sLike%s1991`, then `ShellyResultCallback ... status=completed`.
3. ChatGPT must report the result in the SAME turn (no "still unconfirmed"). If it ends early, ask it to run `shelly closepaw wait <reqId>` and report back.
4. Open Spotify: playlist "Smells Like 1991" with 10 tracks. Delete it before the real take.

## Shooting notes

- User records with the device screen recorder; the assistant types/sends the prompt via adb; the user taps Approve on camera ("1 tap approve" caption).
- Show the empty playlist list briefly at the start; end on the playlist screen (album art + track list). Avoid playing audio (X copyright muting); at most a 1 s play tap.
- Caption: "I asked ChatGPT. My phone did it." ≤ 20 s, speed up waits. Editor: ffmpeg in the assistant's scratchpad; earlier clips/captions in `docs/promo/media`.

## Testing tips (adb)

- Shelly's terminal is a canvas (not readable by uiautomator): push a script to `/sdcard/Download/x.sh`, type `bash /sdcard/Download/x.sh` into the terminal, have it write output to `/sdcard/Download/`. Never put `>`, `;`, `&` in `adb shell input text`.
- Screen capture (`screencap`) is not allowed; read UI with `uiautomator dump` (ChatGPT, notification shade and Spotify are readable).
- Notification actions: expand the shade, tap the group, then the notification's "Expand" button, then read the button bounds from the dump before tapping — do not tap guessed coordinates (a guessed tap cancelled a ClosePaw run).
