# Autonomous Mode A2 Approval Bridge — Phase 1 Probe Report

Date: 2026-06-17
Branch: `feat/a2-bridge-probe`
Base: `bebce807 feat(autonomous): gate-decide node helper — bundle TS gate for the Kotlin bridge (A2) (#64)`

Scope: investigation/report only. No Kotlin/TS implementation code was changed.

## Environment Access

This probe could inspect the repo and run host/proot `node`/`codex`, but could not reach the installed Shelly app sandbox or Shizuku shell from this environment. That blocks a definitive FGS/bionic-node probe.

Raw outputs:

```text
$ adb devices
List of devices attached
```

```text
$ shizuku sh -c 'id; ps -A -o PID,NI,COMM 2>/dev/null | head -n 3'
Server is not running
```

```text
$ termux-device-info 2>/dev/null || true
{"model":"SM-F956Q","manufacturer":"samsung","brand":"samsung","device":"q6q","sdk":36,"release":"16","board":"pineapple"}
```

```text
$ ls -ld /data/user/0/dev.shelly.terminal /data/data/dev.shelly.terminal 2>&1 || true
ls: cannot access '/data/user/0/dev.shelly.terminal': No such file or directory
ls: cannot access '/data/data/dev.shelly.terminal': No such file or directory
```

## A. Node Helper Deployment And Runtime

### Facts

Spec A2 says `shelly-gate-decide.js` is kept in `modules/terminal-emulator/.../assets/` and extracted like other JS helpers, with stdin JSON in and one-line GateOutcome JSON out (`docs/superpowers/specs/2026-06-17-autonomous-mode-A2-approval-bridge-contract.md:34-41`).

HEAD contains the bundle:

```text
$ ls -l modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js lib/agent-policy.ts
-rw-------. 1 root root  4596 Jun 17 12:45 lib/agent-policy.ts
-rw-------. 1 root root 18927 Jun 17 12:45 modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js
```

But HEAD does not extract `shelly-gate-decide.js` anywhere. `LibExtractor.extractAll()` extracts native libs/tars into `filesDir/termux-libs` (`LibExtractor.kt:175-285`) and does not mention the gate helper. Existing JS helpers are individually copied by `HomeInitializer`:

- `shelly-cs.js` to `$HOME/.shelly-cs/shelly-cs.js` (`HomeInitializer.kt:1115-1124`)
- `shelly-cs-tunnel.js` to `$HOME/.shelly-cs/shelly-cs-tunnel.js` (`HomeInitializer.kt:1135-1141`)
- `shelly-codex-auth.js` to `$HOME/.shelly-codex-auth.js` (`HomeInitializer.kt:1159-1165`)
- `shelly-runtime-update.js` to `$HOME/.shelly-runtime-update.js` (`HomeInitializer.kt:1180-1186`)
- `shelly-doctor.js` to `$HOME/.shelly-doctor.js` (`HomeInitializer.kt:1189-1195`)

`rg -n "shelly-gate-decide" modules/terminal-emulator/android/src/main/java` returns no Kotlin extraction/invocation site.

Host/proot Node smoke of the bundle from repo path:

```text
$ which node; node --version
/usr/local/bin/node
v22.16.0
```

Deny:

```text
$ printf '%s\n' '{"command":"rm -rf /","policy":{"level":"L2","workspaceRoot":"/x"}}' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js
{"answer":"n","verdict":{"decision":"deny","signals":["destructive"],"reason":"ルートディレクトリまたはホームディレクトリを再帰的に削除します。システムが起動不能になる可能性があります。","dangerLevel":"CRITICAL"},"audit":{"command":"rm -rf /","decision":"deny","answer":"n","signals":["destructive"],"reason":"ルートディレクトリまたはホームディレクトリを再帰的に削除します。システムが起動不能になる可能性があります。","level":"L2"}}
```

Allow:

```text
$ printf '%s\n' '{"command":"cat /x/README.md","policy":{"level":"L2","workspaceRoot":"/x"}}' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js
{"answer":"y","verdict":{"decision":"allow","signals":[],"reason":"L2 in-workspace","dangerLevel":"SAFE"},"audit":{"command":"cat /x/README.md","decision":"allow","answer":"y","signals":[],"reason":"L2 in-workspace","level":"L2"}}
```

Escalate:

```text
$ printf '%s\n' '{"command":"cp /x/a.txt /sdcard/a.txt","policy":{"level":"L2","workspaceRoot":"/x"}}' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js
{"answer":"escalate","verdict":{"decision":"gray","signals":["leaves-root","write-or-exec"],"reason":"boundary: leaves-root, write-or-exec","dangerLevel":"SAFE"},"audit":{"command":"cp /x/a.txt /sdcard/a.txt","decision":"gray","answer":"escalate","signals":["leaves-root","write-or-exec"],"reason":"boundary: leaves-root, write-or-exec","level":"L2"}}
```

Invalid input:

```text
$ printf '%s\n' '{not json' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js; printf '\nexit=%s\n' "$?"
{"answer":"escalate","reason":"gate-decide: Expected property name or '}' in JSON at position 1 (line 1 column 2)"}
exit=0
```

Latency on host/proot Node:

```text
$ TIMEFORMAT='elapsed=%3R'; time sh -c "printf '%s\n' '{\"command\":\"cat /x/README.md\",\"policy\":{\"level\":\"L2\",\"workspaceRoot\":\"/x\"}}' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js >/dev/null"
elapsed=0.052
```

### Phase 2 Implications

Phase 2 must first add an extraction/invocation path for `shelly-gate-decide.js`; today there is no `<extracted path>` to pass to bundled node. The least surprising route is to mirror `HomeInitializer`'s existing JS helpers, probably `$HOME/.shelly-gate-decide.js` or `$HOME/.shelly/gate/shelly-gate-decide.js`, then have Kotlin invoke `File(libDir, "node")` against that path.

The bundle behavior is good under host Node, including fail-closed JSON parse errors returning `answer:"escalate"`. The load-bearing bionic-node/FGS direct invocation remains unverified because app filesDir and Shizuku were unreachable.

## B. Codex Invocation And Gateable Approval Prompts

### Facts

Spec A §6 says autonomous mode must drive interactive Codex with `--ask-for-approval`, not `codex exec`, because `codex exec` is a non-interactive black box with no per-op gate (`2026-06-17-autonomous-mode-A-policy-gate.md:67-75`). Spec A2 repeats this at `2026-06-17-autonomous-mode-A2-approval-bridge-contract.md:66-68`.

Host/proot Codex version:

```text
$ codex --version
codex-cli 0.134.0
```

`codex --help` exposes `--ask-for-approval` only on the top-level interactive path:

```text
$ codex --help
Codex CLI

If no subcommand is specified, options will be forwarded to the interactive CLI.

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec            Run Codex non-interactively [aliases: e]
  review          Run a code review non-interactively
  login           Manage login
  logout          Remove stored authentication credentials
  mcp             Manage external MCP servers for Codex
  plugin          Manage Codex plugins
  mcp-server      Start Codex as an MCP server (stdio)
  app-server      [experimental] Run the app server or related tooling
  remote-control  [experimental] Manage the app-server daemon with remote control enabled
  completion      Generate shell completion scripts
  update          Update Codex to the latest version
  doctor          Diagnose local Codex installation, config, auth, and runtime health
  sandbox         Run commands within a Codex-provided sandbox
  debug           Debugging tools
  apply           Apply the latest diff produced by Codex agent as a `git apply` to your local
                  working tree [aliases: a]
  resume          Resume a previous interactive session (picker by default; use --last to continue
                  the most recent)
  fork            Fork a previous interactive session (picker by default; use --last to fork the
                  most recent)
  cloud           [EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally
  exec-server     [EXPERIMENTAL] Run the standalone exec-server service
  features        Inspect feature flags
  help            Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Optional user prompt to start the session

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --remote <ADDR>
          Connect the TUI to a remote app server endpoint.

          Accepted forms: `ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`.

      --remote-auth-token-env <ENV_VAR>
          Name of the environment variable containing the bearer token to send to a remote app
          server websocket

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama). If not specified with --oss,
          will use config default or show selection

  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --add-dir <DIR>
          Additional directories that should be writable alongside the primary workspace

  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - untrusted:  Only run "trusted" commands (e.g. ls, cat, sed) without asking for user
            approval. Will escalate to the user if the model proposes a command that is not in the
            "trusted" set
          - on-failure: DEPRECATED: Run all commands without asking for user approval. Only asks for
            approval if a command fails to execute, in which case it will escalate to the user to
            ask for un-sandboxed execution. Prefer `on-request` for interactive runs or `never` for
            non-interactive runs
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model

      --search
          Enable live web search. When enabled, the native Responses `web_search` tool is available
          to the model (no per‑call approval)

      --no-alt-screen
          Disable alternate screen mode

          Runs the TUI in inline mode, preserving terminal scrollback history.

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```

`codex exec --help` does not list `--ask-for-approval`; passing it errors:

```text
$ codex exec --ask-for-approval never --help; printf 'exit=%s\n' "$?"
error: unexpected argument '--ask-for-approval' found

  tip: to pass '--ask-for-approval' as a value, use '-- --ask-for-approval'

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

For more information, try '--help'.
exit=2
```

Existing approval detection is split:

- JSONL path: `JsonlSessionParser` turns approval payloads into `ScouterStatus.WAITING_PERMISSION` and `ScouterEventType.PERMISSION_REQUEST` (`JsonlSessionParser.kt:234-255`, `298-358`).
- Approval signal detection accepts explicit approval objects or status/type strings like `approval_request`, `permission_request`, `requires_approval`, `pending_approval`, `waiting_permission` (`JsonlSessionParser.kt:468-499`).
- Approval summary extraction tries `payload.command`, `approval.command`, nested `arguments.command`, nested `input.command`, description/reason/prompt/plain args/message/toolName (`JsonlSessionParser.kt:510-543`).
- Notification path calls `notifyApprovalNeeded` only for `snapshot.source == ScouterSource.CODEX`, non-`never` approval policy, nonblank `conversation.lastApproval`, and unresolved approval (`NotificationDispatcher.kt:163-184`).
- Live PTS poll classifies screens with `CodexScreenInspect.classify()` (`ScouterLifecycleService.kt:312-318`) but deliberately does not handle `APPROVAL`, leaving that to JSONL/widget live-render (`ScouterLifecycleService.kt:384-387`).
- `ScouterWidgetProvider` suppresses ALLOW/DENY when `isAutoApprovePolicy(codex.approvalPolicy)` is true and requires `currentStatus == WAITING_PERMISSION` plus `lastApprovalAt > 0` and nonblank `lastApproval` (`ScouterWidgetProvider.kt:735-750`).

Current scripted/scheduled agent execution does not create a live Codex PTY:

- `AgentAlarmReceiver` starts `TerminalSessionService.ACTION_RUN_AGENT` with only `agent_id` (`AgentAlarmReceiver.kt:26-41`).
- `TerminalSessionService.runAgentInBackground()` calls `AgentRuntime.runAgent()` on a daemon thread (`TerminalSessionService.kt:210-238`).
- `AgentRuntime.runAgent()` invokes `. ~/.shelly/agents/run-agent-$agentId.sh` through `ShellyJNI.execSubprocess` (`AgentRuntime.kt:28-71`), not `ShellyTerminalSession`.
- Current agent script still uses `codex exec "$(cat "$PROMPT_FILE")"` for `tool.type === 'cli'` (`lib/agent-executor.ts:872-880` in HEAD; `grep -n 'codex exec'` also shows the `auto` fallback at line 938).

### Phase 2 Implications

The interactive `codex --ask-for-approval <mode>` route is the only route supported by the help surface. `codex exec` cannot be the A2 gate path unless upstream changes; it rejects `--ask-for-approval`.

The existing approval bridge is tied to a live PTY in `TerminalSessionService.sessionRegistry` and to a Scouter widget binding. A scheduled `AgentRuntime` subprocess has neither. Phase 2 must either:

1. create a real `ShellyTerminalSession` for autonomous Codex and register/bind it as a Codex PTY, then drive interactive Codex through that PTY; or
2. build a separate PTY-owning background runner that feeds the same screen/JSONL detection and write path.

Option 1 is lower risk because it reuses `sessionRegistry`, `ScouterWidgetPromptActivity`'s `session.write("y\r"/"n\r")`, and existing widget/notification flows.

## C. Current Integration Points

### Facts

Approval notification:

- `NotificationDispatcher.maybeNotify()` calls `notifyApprovalNeeded` when `snapshot.currentStatus == WAITING_PERMISSION` (`NotificationDispatcher.kt:67-81`).
- `notifyApprovalNeeded` gates on Codex source, non-`never` approval policy, nonblank `conversation.lastApproval`, positive `lastApprovalAt`, unresolved widget approval, and dedup by `lastApprovalAt` (`NotificationDispatcher.kt:163-184`).
- Notification actions are PendingIntents into `ScouterWidgetPromptActivity.ACTION_APPROVAL_ALLOW/DENY`, carrying Codex session id, PTY session id, approval timestamp, and approval text (`NotificationDispatcher.kt:186-214`, `344-374`).

PTY y/n write:

- `ScouterWidgetPromptActivity.handleApprovalAction()` maps allow/deny to `"allow"` / `"deny"` (`ScouterWidgetPromptActivity.kt:348-358`).
- It validates the approval anchor against stored `lastApprovalAt` and normalized text (`ScouterWidgetPromptActivity.kt:360-367`, `553-575`).
- It finds the bound Codex terminal from `TerminalSessionService.sessionRegistry`, requires `WidgetCodexTarget.ApprovalNeeded`, and writes `y\r` or `n\r` (`ScouterWidgetPromptActivity.kt:367-390`).

Proposed command extraction:

- JSONL extraction exists but is not guaranteed full: `commandSummary` is truncated to 160 chars in `JsonlSessionParser.kt:278` and `356`; `lastMessage` is truncated to 240 chars in `JsonlSessionParser.kt:288` and `391`.
- `ScouterStateStore.widgetConversation()` chooses `lastApproval` from `lastMessage`, `commandSummary`, or `toolName` (`ScouterStateStore.kt:571-593`).
- Screen inspection `CodexScreenInspect.approvalSummary()` returns a shortened 48-char keyword line, not full command (`CodexScreenInspect.kt:177-185`).
- Therefore HEAD has no full-command extraction API that satisfies A2's "full proposed command" requirement (`A2 contract:61`).

Autonomous/manual distinction:

- `ScouterEvent` has source/status/model/approvalPolicy, but no autonomous marker (`ScouterModels.kt:77-123`).
- `TerminalSessionService.ACTION_RUN_AGENT` carries only `EXTRA_AGENT_ID` (`TerminalSessionService.kt:33-37`, `AgentAlarmReceiver.kt:33-36`, `TerminalEmulatorModule.kt:729-740`).
- `AgentRuntime.runAgent()` knows only `agentId` and script path; no policy sidecar or immutable autonomy flag exists (`AgentRuntime.kt:28-71`).

### Phase 2 Implications

Phase 2 needs two new data carriers before policy decisions can be safe:

1. a stable autonomous marker for a live PTY/session, so manual Codex remains unchanged;
2. an immutable policy sidecar or service-held metadata keyed by `agentId` and/or PTY session id, readable by Kotlin at approval time and not writable by the agent.

Do not rely on current `conversation.lastApproval` as the command string for policy decisions. It is a display summary and may be truncated. Full command should come from structured JSONL payload before truncation, or from a new parser path that stores raw redacted command separately from UI summary. If full command is unavailable, A2 should fail closed to human escalation.

## D. Latency

### Facts

Host/proot node helper round trip measured about 52 ms for one allow decision:

```text
$ TIMEFORMAT='elapsed=%3R'; time sh -c "printf '%s\n' '{\"command\":\"cat /x/README.md\",\"policy\":{\"level\":\"L2\",\"workspaceRoot\":\"/x\"}}' | node modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js >/dev/null"
elapsed=0.052
```

This is not the bionic node from the Shelly FGS path. The required direct-invoke path could not be measured because `shelly-gate-decide.js` is not extracted in HEAD and app filesDir was inaccessible from this environment.

### Phase 2 Implications

The helper itself is small enough that a subprocess-per-approval design should be acceptable if bionic node startup is in the same rough order as current host/proot node. Codex is blocked at the approval prompt, so even a few hundred ms should be acceptable. Phase 2 should still add a short timeout and fail closed to human escalation, per A2.

## Bottom Line

The A2 high-level fork still looks right: interactive Codex with `--ask-for-approval` is the only gateable route; `codex exec` is not.

However, Phase 2 should not start directly at auto-answering prompts. Required first steps:

1. extract `shelly-gate-decide.js` to a real app-private file path and verify bundled bionic node can execute it from Kotlin/FGS;
2. create/register an autonomous interactive Codex PTY instead of using `AgentRuntime`'s current non-PTY `codex exec` script path;
3. add an autonomous+policy metadata carrier keyed to the PTY/session;
4. add full-command capture before truncation, or fail closed to human escalation.
