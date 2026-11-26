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
- Settings > Agents > **MCP: Allow typed operations (run agents)**: turn it off. It is off by default. It adds the `run_agent` and `get_run_result` tools. Turning it off refuses both at once, even for agents with an always-allow rule (the rules stay until revoked).
- Settings > Agents > **MCP: Allow typed operations (run agents)** also gates `put_stream_feed` (the launcher stream feed). Turning it off refuses it even with an always-allow rule.

### Token

- The bearer token is generated the first time it is needed and stored in SecureStore. **Copy MCP Token** in the same Settings section copies it.
- **Regenerate MCP Token** in the same Settings section replaces it with a new one, after a confirmation. If the server is running, it restarts at once and the old token is rejected. Requests still waiting under the old token (including an open approval popup) are cancelled. Every MCP client then needs the new token in its MCP config.
- If regeneration cannot finish, Shelly turns **MCP Server** off rather than keep serving, and tells you so.
- Turning the server off also stops every client, but it does not change the token: a client that has it can connect again once the server is back on.

### Always-allow rules

- An "always allow" rule lets one MCP client run one kind of request on one target (for example, running one agent) without the approval popup. Rules can never cover `run_command` or `write_file`. A rule is created only when you tap **Always allow** on the `run_agent` approval popup. It covers that agent as it was defined then: editing the agent's prompt, tool, actions or other run settings brings the popup back. A rule never lets a run start while all agents are stopped, for an agent created or changed over MCP, or against your own deny rules, and legacy rules remain ingress-tainted. New consent also preapproves the declared actions, bound to the verified policy snapshot; policy edits require fresh consent. See [action consent and migration](mcp-agent-action-consent.md).
- Settings > **MCP: always allowed** lists every rule: what it allows, the target, the client (the first 8 characters of its ID), and when it was added. **Revoke** removes one rule; **Revoke all** removes them all. A rule cannot be added from Settings.
- **Regenerating the MCP token removes every rule**, before the new token is saved. If Shelly cannot confirm that, the token is not changed and the server is left off. After the new token is saved, Shelly removes any rule that is not for the new token once more; if that second pass cannot be confirmed, a running server is left off. A stopped server stays off and the new token is kept, because a rule made for the old token never applies to the new one.
- The stream feed rule: tapping **Always allow** on the first `put_stream_feed` approval creates a rule for that client and that operation (target `stream-feed`). It is listed in **MCP: always allowed** like the others; revoke it there. **Skip all approvals** never covers `put_stream_feed`, so without this rule each update needs a tap. The stored feed itself stays until the next one replaces it.
- Turning the MCP server off does not remove rules.
- Regenerating the token also marks every run that MCP started and that is still queued or running as `cancelled`; a queued one never starts. A run that already started keeps running to its end.

### Check it is off

With the toggle off, a connection to port 8767 from another device on the same network should be refused.

## 3b. Launcher ingress

What it is: an optional ContentProvider that one launcher app, which you registered by package name and certificate pin, can call to submit instructions and read the stream feed. It is off until you register a launcher.

- Settings > **Launcher ingress**: turn **Enabled** off to refuse all calls at once, or **Remove** to delete the registered package and pins (its exemption and always-allow rules then stop applying).
- **Count launcher text as written by me**: turn it off to treat launcher instructions as untrusted input again. Changing the package or any pin also turns it off.
- Always-allow rules for the launcher's `submit_instruction` and for `put_stream_feed` are removed in Settings > **MCP: always allowed** (**Revoke** / **Revoke all**).
- `hayato://chat/<slug>` links only queue requests for an agent to read; remove the slugs from the chat-link slug table in Settings (empty by default) to stop queuing them.

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
- An MCP client that already copied the token still knows it until you regenerate the token (section 3).
- Shelly has no telemetry, so there is nothing on a Shelly server to delete. See the Privacy section of the README.

If something here is wrong or missing, please open an issue: https://github.com/RYOITABASHI/Shelly/issues
