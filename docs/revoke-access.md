# How to turn off and revoke everything Shelly can expose

[日本語版](./revoke-access.ja.md)

Shelly can let other things act on your phone: the ChatGPT app, ClosePaw, MCP clients and scheduled agents. This page lists each one, how to stop it, how to revoke its credentials, and how to check it is really off.

Every command and menu name below was checked against the code. Where there is no way to do something, this page says so.

All `shelly ...` commands are run in a Shelly terminal tab.

## 1. ChatGPT remote control (`shelly codex pair`)

What it is: Shelly runs the official `codex remote-control --no-daemon` on the phone. The ChatGPT app's Codex can then run commands here. It needs a ChatGPT sign-in.

### Stop it

- Started in a tab with `shelly codex pair`: press Ctrl-C in that tab, or close the tab.
- Started with `shelly codex pair --background`: run `shelly codex stop`.
- "Keep ChatGPT connected" is on: run `shelly codex autostart off`, or open Settings > Codex Login and turn **Keep ChatGPT connected** off. The command also stops a running background host. While this is on, Shelly shows a notification, and you can tap Disconnect there.

"Keep ChatGPT connected" can only be turned **on** in Settings, after a confirmation. A terminal can only turn it off. This is deliberate, so that ChatGPT cannot turn it on for itself.

### Check it is off

- `shelly codex status` should say no background host is running.
- `shelly codex autostart status` should say `off`. It reads a status file that Shelly writes, so treat it as a hint. Settings > Codex Login shows the real switch.
- Close and reopen Shelly. The host should not come back.

### Revoke

1. **Remove the phone on the ChatGPT side.** Stopping the host on the phone does not remove the device entry in ChatGPT. Shelly's own messages say: "To fully revoke access, also remove this device in the ChatGPT app." I did not verify the exact menu names in the ChatGPT app, because they belong to OpenAI and may change.
2. **Remove trusted projects.** `shelly codex trust <dir>` writes a `[projects."<path>"]` table with `trust_level = "trusted"` into `~/.codex/config.toml` (or `$CODEX_HOME/config.toml` if you set `CODEX_HOME`). There is no `shelly codex untrust` command. To remove trust, edit that file and delete the table. `shelly codex status` lists the trusted projects, so you can check the result.
3. **Sign out of Codex.** Codex keeps its ChatGPT login in `~/.codex/auth.json` (mode 0600). Delete that file (`rm ~/.codex/auth.json`). Remote control cannot start without a ChatGPT sign-in. `shelly-doctor` reports whether the file exists. Shelly has no "sign out" button for Codex. To end the login on OpenAI's side too, use your ChatGPT account's own security settings.

## 2. ClosePaw hand-off (`shelly closepaw`)

What it is: a task from the terminal (for example from ChatGPT) is handed to the ClosePaw app, which operates other apps on the phone.

### Deny or cancel a request

- With the Shelly-trusted ClosePaw build, a request needs your approval on the phone. You approve by tapping **Approve** on the notification (the device must be unlocked) or by replying `approve <hash>` in Shelly's chat. A plain "OK" does not approve it.
- To deny: reply `reject <hash>` in the chat, use the notification, or run `shelly closepaw reject <requestId>`. ChatGPT can reject a request, but it can never approve one.
- If you do nothing, the request expires. The chat message says it expires in 10 minutes.

### Turn it off

- Uninstall the ClosePaw app (Android Settings > Apps). Agent hand-offs are then declined with "ClosePaw is not installed".
- To drop only the trusted shortcut, replace the Shelly-trusted build with the official ClosePaw. The official build shows its own confirmation every time and never gets Shelly's token.
- Agents with a ClosePaw step: approving such an agent also approves that step for its future runs until you edit the agent. To remove that, edit or delete the agent (section 4).
- Shizuku is a separate app that ClosePaw uses for its virtual display. Stop or uninstall it from the Shizuku app or Android Settings. ClosePaw's background run then fails and Shelly reports "Start Shizuku".
- ClosePaw's accessibility service: Android Settings > Accessibility > ClosePaw. Turn it off there.
- ClosePaw's own AI credentials are stored inside ClosePaw. Remove them in that app.

### Check it is off

Look in Android Settings > Apps for ClosePaw (should be gone), and in Accessibility (the ClosePaw service should be off). I do not suggest running `shelly closepaw "<goal>"` as a test: it creates a real request that you then have to reject.

## 3. MCP server

What it is: an HTTP server on the phone, port 8767. MCP clients such as Claude Code on the same Wi-Fi or VPN can call its tools. It listens on all network interfaces (`0.0.0.0`) and checks a bearer token on every request.

### Stop it

- Settings > Agents > **MCP Server**: turn it off. The server is stopped when this is off. It is off by default.
- Settings > Agents > **MCP: Allow exec/write (dangerous)**: turn it off. It is off by default. It adds the `run_command` and `write_file` tools. Each call still needs an approval popup on the phone, and CRITICAL-risk commands are refused.

### Token

- The bearer token is generated the first time it is needed and stored in SecureStore. **Copy MCP Token** in the same Settings section copies it.
- **There is no regenerate or reset button for this token.** I found no code that replaces or deletes it once it exists. If a client has the token, turning the server off is the only revocation inside the app. A new token would only be created if the stored one is gone (for example after clearing Shelly's app data or reinstalling). I did not test that.

### Check it is off

With the toggle off, a connection to port 8767 from another device on the same network should be refused.

## 4. Scheduled and autonomous agents, and stored keys

### Agents

- Pause one agent: in the sidebar, open the agent and tap **Pause**. This stops its schedule. **Resume** undoes it.
- Stop all: the **STOP ALL** button in the sidebar is the global kill switch. **RESUME** undoes it. While STOP-ALL is active, "Keep ChatGPT connected" cannot be turned on.
- Delete: delete the agent in the sidebar and confirm. This removes its plan and schedule.
- Settings > Agents > **Approve Agents from ChatGPT**: turn it off if you do not want ChatGPT to confirm agents with `shelly agent confirm`. You can still approve in Shelly itself.

### Keys and connector secrets

- AI provider keys: Settings > API Keys. Each row has a **Clear** button.
- Social connector credentials (Bluesky, Discord and so on): Settings > Social Connectors. Remove the connector. This deletes its secrets from SecureStore and its entries from the agents' environment file.
- Codex login: see section 1.
- Clearing a key removes Shelly's copy only. If you think a key leaked, also revoke it with the provider.

## 5. What stopping does not undo

- Anything already sent to ChatGPT, OpenAI or another AI provider (prompts, command output, files Codex read) stays with them. Delete it in your account there, under their rules.
- A phone task that ClosePaw already ran is not rolled back. Messages sent and lists changed stay changed.
- Files that a command already wrote or changed on the phone stay changed.
- An MCP client that already copied the token still knows it (section 3).
- Shelly has no telemetry, so there is nothing on a Shelly server to delete. See the Privacy section of the README.

If something here is wrong or missing, please open an issue: https://github.com/RYOITABASHI/Shelly/issues
