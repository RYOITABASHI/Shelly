# A2 Phase 1.5 Codex app-server Approval Protocol Probe

Date: 2026-06-17

Branch: `feat/a2-appserver-probe`

Scope: investigation only. No implementation code was changed.

## Environment

`codex --version`:

```text
codex-cli 0.134.0
```

`codex app-server --help` confirmed the stdio transport:

```text
Usage: codex app-server [OPTIONS] [COMMAND]

Options:
      --listen <URL>
          Transport listen URL. Supported schemes: stdio:// (default), unix://, unix://PATH, ws://IP:PORT, off. `unix://` binds a private path under $CODEX_HOME; `unix://PATH` binds the provided socket path
```

Probe server command:

```text
codex app-server --listen stdio://
```

Probe client cwd:

```text
/tmp/codex-appserver-probe
```

Thread setup:

```text
approvalPolicy: untrusted
approvalsReviewer: user
sandbox: workspace-write
ephemeral: true
```

Prompt sent through `turn/start`:

```text
Protocol probe: run exactly two separate shell commands in order. First run `ls -la /tmp/codex-appserver-probe`. After that command finishes, run `rm -rf /tmp/foo` as a second separate command. Do not combine them. Do not ask questions.
```

## Initialize Handshake

Raw client request:

```text
C->S {"id":1,"method":"initialize","params":{"clientInfo":{"name":"a2-appserver-probe","version":"0.0.0"},"capabilities":{}}}
```

Raw server response:

```text
S->C {"id":1,"result":{"userAgent":"a2-appserver-probe/0.134.0 (Ubuntu 24.4.0; aarch64) dumb (a2-appserver-probe; 0.0.0)","codexHome":"/root/.codex","platformFamily":"unix","platformOs":"linux"}}
```

Raw initialized notification:

```text
C->S {"method":"initialized"}
```

## Thread And Turn Start

Raw `thread/start` request:

```text
C->S {"id":2,"method":"thread/start","params":{"cwd":"/tmp/codex-appserver-probe","approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"workspace-write","ephemeral":true,"threadSource":"user","developerInstructions":"This is a protocol probe. When asked to run shell commands, use the shell tool. Keep commands separate when the user asks for separate commands."}}
```

Raw `thread/start` response:

```text
S->C {"id":2,"result":{"thread":{"id":"019ed3cf-ee7b-7691-8e77-93a9019c9083","sessionId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","forkedFromId":null,"preview":"","ephemeral":true,"modelProvider":"openai","createdAt":1781670080,"updatedAt":1781670080,"status":{"type":"idle"},"path":null,"cwd":"/tmp/codex-appserver-probe","cliVersion":"0.134.0","source":"vscode","threadSource":"user","agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"gpt-5.4-mini","modelProvider":"openai","serviceTier":null,"cwd":"/tmp/codex-appserver-probe","runtimeWorkspaceRoots":["/tmp/codex-appserver-probe"],"instructionSources":["/root/.codex/AGENTS.md"],"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":["/root/.codex/memories"],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null,"reasoningEffort":null}}
```

Raw `turn/start` request:

```text
C->S {"id":3,"method":"turn/start","params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","approvalPolicy":"untrusted","approvalsReviewer":"user","input":[{"type":"text","text":"Protocol probe: run exactly two separate shell commands in order. First run `ls -la /tmp/codex-appserver-probe`. After that command finishes, run `rm -rf /tmp/foo` as a second separate command. Do not combine them. Do not ask questions.","text_elements":[]}]}}
```

Raw `turn/start` response:

```text
S->C {"id":3,"result":{"turn":{"id":"019ed3cf-f38e-7171-89ee-2de6e6821c95","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
```

## Approval Request 1: accept `ls`

Raw command item before approval:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_keFOY2KqDMZJaIqMhORdM0Vr","command":"/bin/bash -lc 'ls -la /tmp/codex-appserver-probe'","cwd":"/tmp/codex-appserver-probe","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"listFiles","command":"ls -la /tmp/codex-appserver-probe","path":"codex-appserver-probe"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","startedAtMs":1781670089609}}
```

Raw server approval request:

```text
S->C {"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","itemId":"call_keFOY2KqDMZJaIqMhORdM0Vr","startedAtMs":1781670089608,"reason":"command failed; retry without sandbox?","command":"/bin/bash -lc 'ls -la /tmp/codex-appserver-probe'","cwd":"/tmp/codex-appserver-probe","commandActions":[{"type":"listFiles","command":"ls -la /tmp/codex-appserver-probe","path":"codex-appserver-probe"}],"proposedExecpolicyAmendment":["ls","-la","/tmp/codex-appserver-probe"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls","-la","/tmp/codex-appserver-probe"]}},"cancel"]}}
```

Raw client approval response:

```text
C->S {"id":0,"result":{"decision":"accept"}}
```

Raw server resolution and command completion:

```text
S->C {"method":"serverRequest/resolved","params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","requestId":0}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_keFOY2KqDMZJaIqMhORdM0Vr","command":"/bin/bash -lc 'ls -la /tmp/codex-appserver-probe'","cwd":"/tmp/codex-appserver-probe","processId":"73190","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"listFiles","command":"ls -la /tmp/codex-appserver-probe","path":"codex-appserver-probe"}],"aggregatedOutput":"total 72\ndrwx------.  2 root root   3452 Jun 17 13:21 .\ndrwxrwxrwx. 62 root root 118784 Jun 17 13:21 ..\n","exitCode":0,"durationMs":0},"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","completedAtMs":1781670089692}}
```

## Approval Request 2: decline `rm -rf`

Raw command item before approval:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_YrTf81Vilg9MIv0BWEtk5ZE0","command":"/bin/bash -lc 'rm -rf /tmp/foo'","cwd":"/tmp/codex-appserver-probe","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"rm -rf /tmp/foo"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","startedAtMs":1781670095511}}
```

Raw server approval request:

```text
S->C {"method":"item/commandExecution/requestApproval","id":1,"params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","itemId":"call_YrTf81Vilg9MIv0BWEtk5ZE0","startedAtMs":1781670095511,"command":"/bin/bash -lc 'rm -rf /tmp/foo'","cwd":"/tmp/codex-appserver-probe","commandActions":[{"type":"unknown","command":"rm -rf /tmp/foo"}],"proposedExecpolicyAmendment":["rm","-rf","/tmp/foo"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["rm","-rf","/tmp/foo"]}},"cancel"]}}
```

Raw client decline response:

```text
C->S {"id":1,"result":{"decision":"decline"}}
```

Raw server resolution and command completion:

```text
S->C {"method":"serverRequest/resolved","params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","requestId":1}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_YrTf81Vilg9MIv0BWEtk5ZE0","command":"/bin/bash -lc 'rm -rf /tmp/foo'","cwd":"/tmp/codex-appserver-probe","processId":null,"source":"agent","status":"declined","commandActions":[{"type":"unknown","command":"rm -rf /tmp/foo"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95","completedAtMs":1781670095518}}
```

Raw stderr after decline:

```text
STDERR 2026-06-17T04:21:35.527321Z ERROR codex_core::tools::router: error=exec_command failed for `/bin/bash -lc 'rm -rf /tmp/foo'`: CreateProcess { message: "Rejected(\"rejected by user\")" }
```

Raw turn completion:

```text
S->C {"method":"turn/completed","params":{"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083","turn":{"id":"019ed3cf-f38e-7171-89ee-2de6e6821c95","items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1781670081,"completedAt":1781670097,"durationMs":16429}}}
NOTE tmpfoo_exists=true
```

## Structured Command And Cwd

YES.

The live server request method was:

```text
item/commandExecution/requestApproval
```

The raw approval params included:

```text
"command":"/bin/bash -lc 'rm -rf /tmp/foo'"
"cwd":"/tmp/codex-appserver-probe"
"threadId":"019ed3cf-ee7b-7691-8e77-93a9019c9083"
"turnId":"019ed3cf-f38e-7171-89ee-2de6e6821c95"
"itemId":"call_YrTf81Vilg9MIv0BWEtk5ZE0"
```

The same fields were present for the accepted `ls` command. The request also carried `commandActions`, `proposedExecpolicyAmendment`, and `availableDecisions`.

## Bionic / Stability Note

This phase used host Codex 0.134.0 only. The app-server protocol shape is confirmed on host. Per the task scope, actual Shelly FGS / bionic execution remains a later device probe.

Observed experimental/runtime notes:

- `codex app-server` is marked experimental by the CLI help.
- Startup emitted a bubblewrap warning, then continued using bundled bubblewrap.
- A missing local plugin skill path warning was emitted during the turn.
- The server did not crash; initialize, thread start, turn start, accept, decline, and turn completion all succeeded over stdio NDJSON.

## PTY Injection Vs App-server For B2

Recommendation: build B2 on the app-server approval path if bionic execution is viable.

Reasons:

- The approval request is structured and machine-readable.
- It includes the exact command string after Codex wrapping, e.g. `/bin/bash -lc 'rm -rf /tmp/foo'`.
- It includes the effective cwd.
- It includes stable routing IDs: `threadId`, `turnId`, `itemId`, and JSON-RPC request `id`.
- Accept/decline is a normal JSON response, and decline produced `status:"declined"` without executing the command.

PTY injection remains a fallback only if the app-server binary/protocol cannot run inside Shelly's bionic environment or if the experimental API changes incompatibly. PTY injection has a weaker contract because it depends on terminal text scraping and prompt injection timing, while app-server gives the policy gate the command and cwd before execution.
