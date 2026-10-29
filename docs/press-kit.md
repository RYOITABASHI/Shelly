# Shelly — facts for reviewers and writers

This page is written by the author of Shelly. It is a primary source, not an independent review. Check the claims yourself. The test plan below is meant for that.

## Summary

Shelly is an open-source Android terminal app with AI agents built in. It runs a real shell (bash, Node.js, Python, git, curl, ssh and more) on the phone through its own native PTY, with no Termux, no root and no PC. It can also let the ChatGPT app's Codex drive the phone: Codex runs commands in Shelly's terminal, and can hand a task to the ClosePaw phone-use app, but only after the phone's owner approves it on the phone. It also runs scheduled agents on the device, with an optional on-device model for local use. It is pre-release software. Distribution is GitHub Releases only.

## What is verified and what is not

Source: the Status table in the [README](../README.md#status) and [docs/STATUS.md](./STATUS.md). Dates and evidence are in STATUS.md.

Verified on a real Galaxy Z Fold6 (N=1):

- Core terminal, multi-pane layout, AI Edit, file tree and git.
- Unattended scheduled agent firing (AlarmManager), end to end.
- Ask AI, Teach mode, one-shot schedules, sourced multi-step briefings, hand-off narration, IME-aware layout, live theme switching.
- Codex remote control: pairing, and running commands from the ChatGPT app.

Implemented but not yet verified on device (the README says so):

- The additions to remote control: `shelly codex trust`, host name, `--background`.
- Registering agents by asking ChatGPT (`shelly agent add`).
- The ClosePaw hand-off, as listed in the README Status table.
- The MCP server, agent safety rules (POLICY-001), on-device speech-to-text.

Known limits:

- Only one device model has been tested. Other makers' background limits may stop scheduled agents.
- Not on Google Play or F-Droid.
- Remote control is marked Experimental and needs a ChatGPT sign-in (API keys are not supported).
- The security model is a normal Android app sandbox. See [SECURITY.md](../SECURITY.md).

Note on the ClosePaw row: the README demo clip shows a ChatGPT-to-ClosePaw run, while the Status table still lists the hand-off as not yet verified on device. Treat the table as the conservative statement, and the clip as one recorded run.

## How the ChatGPT-to-phone flow works

1. Codex remote control runs on the phone. `shelly codex pair` starts the official `codex remote-control --no-daemon` and prints a short-lived pairing code, which you enter in the ChatGPT app.
2. ChatGPT, through Codex, runs commands in Shelly's terminal on the phone. For a phone-app task it runs `shelly closepaw --wait "<goal>"`.
3. Shelly does not run the task yet. It asks the phone's owner to approve, on the phone, as a notification (device unlock needed) or a reply in Shelly's chat. ChatGPT can reject a request, but it cannot approve one.
4. After approval, Shelly hands the goal to ClosePaw, a separate open-source phone-use app. With the Shelly-trusted ClosePaw build, ClosePaw works on a background virtual display (via Shizuku), so the front of the screen stays yours.
5. ClosePaw reports back to Shelly. Shelly accepts the result only if the sender's signing certificate matches the pinned one, and the request id and a per-request random nonce match a request Shelly started.
6. The result is returned to ChatGPT as data (text output of the command), not as instructions.

## Differences you can check

- No root. Shelly is a normal app; the PTY uses `forkpty` through JNI.
- No Termux and no PC. Shelly is built and was developed on the phone itself.
- No self-hosted relay server. Remote control uses OpenAI's official `codex remote-control`, not a server run by this project.
- The approval is on the phone. ChatGPT cannot approve a phone action. The code path for ChatGPT-side confirmation (`shelly closepaw confirm`) is refused when the Shelly-trusted ClosePaw build is installed; see the README for details.
- No telemetry. Network traffic comes from things you start (AI API calls, Codex sign-in, update checks, the browser pane).
- You can turn every exposed surface off: [docs/revoke-access.md](./revoke-access.md).

## A test plan you can follow

You need an Android phone (a Galaxy Z Fold6 is the tested device), the ChatGPT app with Codex, and a ChatGPT account. Use a spare account or device if you can.

1. **Install.** Download the APK from the [releases page](https://github.com/RYOITABASHI/Shelly/releases) and install it. Grant the permissions it asks for, or read the README Permissions table first.
2. **Sign in.** In a Shelly terminal run `codex`, or open Settings > Codex Login, and sign in with ChatGPT. Run `shelly-doctor` to see that `~/.codex/auth.json` exists.
3. **Pair.** Run `shelly codex pair`. Enter the printed code in the ChatGPT app's Codex. The device appears as `Shelly (<model>)`.
4. **Safe terminal task.** From ChatGPT, ask Codex to run something harmless, such as `uname -a` or `ls ~`. Check that the output appears.
5. **Safe phone-app task.** Install the Shelly-trusted ClosePaw build and start Shizuku (see the README for the current steps). From ChatGPT, ask for a harmless task, such as opening a settings screen. Shelly should show an approval request on the phone. Approve it and watch the result.
6. **Deny one.** Ask for another phone-app task and this time reject it (`reject <hash>` in Shelly's chat, or the notification). Confirm that ClosePaw did nothing on the phone and that the command in ChatGPT does not report a finished task.
7. **Revoke.** Follow [docs/revoke-access.md](./revoke-access.md): stop the host, remove the device in the ChatGPT app, delete `~/.codex/auth.json`. Confirm that `shelly codex status` shows no host and that ChatGPT can no longer reach the phone.

If any step does not behave as described, please open an issue. That is useful to me.

## Links

- Repository: https://github.com/RYOITABASHI/Shelly
- Releases: https://github.com/RYOITABASHI/Shelly/releases
- README: [../README.md](../README.md) ([日本語](../README.ja.md))
- Demo (ChatGPT drives the phone): [docs/images/demo-spotify.gif](./images/demo-spotify.gif)
- Revoke access: [revoke-access.md](./revoke-access.md)
- ClosePaw (Shelly build): https://github.com/RYOITABASHI/closepaw/releases

## License and contact

- License: GPL-3.0 ([LICENSE](../LICENSE)).
- Contact: [GitHub issues](https://github.com/RYOITABASHI/Shelly/issues) or X [@RFzinc](https://x.com/RFzinc).
