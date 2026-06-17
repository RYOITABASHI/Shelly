# A2 / B2 Probe: app-server Approval Under danger-full-access

Date: 2026-06-17

Branch: `feat/a2-b2probe-sandbox`

Scope: investigation only. No implementation code was changed.

## Environment

`codex --version`:

```text
codex-cli 0.134.0
```

Server command:

```text
codex app-server --listen stdio://
```

All matrix cells used `thread/start` with:

```text
approvalsReviewer: user
sandbox: danger-full-access
ephemeral: true
```

Each `turn/start` also passed:

```text
sandboxPolicy: {"type":"dangerFullAccess"}
```

Turn prompt pattern:

```text
Protocol probe. Run exactly two separate shell commands in order. First run `cat /etc/hostname`. After that command finishes, run `rm -rf /tmp/probe-*` as a second separate command. Do not combine them. Do not ask questions.
```

## Matrix Result

| sandbox | approvalPolicy | `cat /etc/hostname` | `rm -rf /tmp/probe-*` | result |
| --- | --- | --- | --- | --- |
| `danger-full-access` | `untrusted` | no approval; executed | `item/commandExecution/requestApproval`; declined | target survived |
| `danger-full-access` | `on-request` | no approval; executed | `item/commandExecution/requestApproval`; declined | target survived |
| `danger-full-access` | `never` | no approval; executed | no approval; executed | target deleted |

Summary lines:

```text
dfa-untrusted: approvals=1 commandStarts=2 commandCompletions=2 rmTargetExistsAfter=true elapsedMs=15432 timedOut=false
dfa-on-request: approvals=1 commandStarts=2 commandCompletions=2 rmTargetExistsAfter=true elapsedMs=12013 timedOut=false
dfa-never: approvals=0 commandStarts=2 commandCompletions=2 rmTargetExistsAfter=false elapsedMs=13109 timedOut=false
```

## Cell 1: danger-full-access x untrusted

Raw `thread/start`:

```text
C->S {"id":2,"method":"thread/start","params":{"cwd":"/tmp/codex-b2probe-dfa-untrusted","approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"danger-full-access","ephemeral":true,"threadSource":"user","developerInstructions":"This is a protocol probe. Use shell commands exactly as requested. When asked for two commands, issue two separate shell tool calls in order. Do not combine shell commands."}}
```

Raw trusted read bypass (`cat`) item:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_SYwXHD7uAKc5c2QnPgIyyCdA","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-untrusted","processId":"54718","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3da-e904-74d2-a788-7755802dce0a","turnId":"019ed3da-ed77-7010-a85b-bbf65d125629","startedAtMs":1781670808725}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_SYwXHD7uAKc5c2QnPgIyyCdA","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-untrusted","processId":"54718","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":"anyclaw\n","exitCode":0,"durationMs":0},"threadId":"019ed3da-e904-74d2-a788-7755802dce0a","turnId":"019ed3da-ed77-7010-a85b-bbf65d125629","completedAtMs":1781670808725}}
```

Raw dangerous command approval (`rm -rf`) and decline:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_bkeAKtzBBDfq9NEaSmIL1aAY","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-untrusted'","cwd":"/tmp/codex-b2probe-dfa-untrusted","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-untrusted"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3da-e904-74d2-a788-7755802dce0a","turnId":"019ed3da-ed77-7010-a85b-bbf65d125629","startedAtMs":1781670811264}}
S->C {"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"019ed3da-e904-74d2-a788-7755802dce0a","turnId":"019ed3da-ed77-7010-a85b-bbf65d125629","itemId":"call_bkeAKtzBBDfq9NEaSmIL1aAY","startedAtMs":1781670811263,"command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-untrusted'","cwd":"/tmp/codex-b2probe-dfa-untrusted","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-untrusted"}],"proposedExecpolicyAmendment":["rm","-rf","/tmp/probe-dfa-untrusted"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["rm","-rf","/tmp/probe-dfa-untrusted"]}},"cancel"]}}
C->S {"id":0,"result":{"decision":"decline"}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_bkeAKtzBBDfq9NEaSmIL1aAY","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-untrusted'","cwd":"/tmp/codex-b2probe-dfa-untrusted","processId":null,"source":"agent","status":"declined","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-untrusted"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3da-e904-74d2-a788-7755802dce0a","turnId":"019ed3da-ed77-7010-a85b-bbf65d125629","completedAtMs":1781670811272}}
NOTE finish_reason=turn_completed elapsed_ms=15432 approvals=1 rm_target_exists=true
```

## Cell 2: danger-full-access x on-request

Raw `thread/start`:

```text
C->S {"id":2,"method":"thread/start","params":{"cwd":"/tmp/codex-b2probe-dfa-on-request","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"danger-full-access","ephemeral":true,"threadSource":"user","developerInstructions":"This is a protocol probe. Use shell commands exactly as requested. When asked for two commands, issue two separate shell tool calls in order. Do not combine shell commands."}}
```

Raw trusted read bypass (`cat`) item:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_4GVTH7VG1ZerDuFPHLUPriLy","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-on-request","processId":"89363","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3db-2658-7992-9461-f6c12f7fae39","turnId":"019ed3db-2a59-73d0-ba78-4da78627897f","startedAtMs":1781670821981}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_4GVTH7VG1ZerDuFPHLUPriLy","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-on-request","processId":"89363","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":"anyclaw\n","exitCode":0,"durationMs":0},"threadId":"019ed3db-2658-7992-9461-f6c12f7fae39","turnId":"019ed3db-2a59-73d0-ba78-4da78627897f","completedAtMs":1781670821981}}
```

Raw dangerous command approval (`rm -rf`) and decline:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_XT0T0I0w6ZYPRfo2lrKi5nMR","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request'","cwd":"/tmp/codex-b2probe-dfa-on-request","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-on-request"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3db-2658-7992-9461-f6c12f7fae39","turnId":"019ed3db-2a59-73d0-ba78-4da78627897f","startedAtMs":1781670824625}}
S->C {"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"019ed3db-2658-7992-9461-f6c12f7fae39","turnId":"019ed3db-2a59-73d0-ba78-4da78627897f","itemId":"call_XT0T0I0w6ZYPRfo2lrKi5nMR","startedAtMs":1781670824625,"command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request'","cwd":"/tmp/codex-b2probe-dfa-on-request","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-on-request"}],"proposedExecpolicyAmendment":["rm","-rf","/tmp/probe-dfa-on-request"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["rm","-rf","/tmp/probe-dfa-on-request"]}},"cancel"]}}
C->S {"id":0,"result":{"decision":"decline"}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_XT0T0I0w6ZYPRfo2lrKi5nMR","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request'","cwd":"/tmp/codex-b2probe-dfa-on-request","processId":null,"source":"agent","status":"declined","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-on-request"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3db-2658-7992-9461-f6c12f7fae39","turnId":"019ed3db-2a59-73d0-ba78-4da78627897f","completedAtMs":1781670824632}}
NOTE finish_reason=turn_completed elapsed_ms=12013 approvals=1 rm_target_exists=true
```

## Cell 3: danger-full-access x never

Raw `thread/start`:

```text
C->S {"id":2,"method":"thread/start","params":{"cwd":"/tmp/codex-b2probe-dfa-never","approvalPolicy":"never","approvalsReviewer":"user","sandbox":"danger-full-access","ephemeral":true,"threadSource":"user","developerInstructions":"This is a protocol probe. Use shell commands exactly as requested. When asked for two commands, issue two separate shell tool calls in order. Do not combine shell commands."}}
```

Raw `cat` item, no approval:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_KO447dBr7Zg9iVP4Ov2aOmvr","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-never","processId":"31801","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3db-568a-7310-915b-9c080265ab5b","turnId":"019ed3db-5989-7af0-9a43-ff833757ea5a","startedAtMs":1781670836020}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_KO447dBr7Zg9iVP4Ov2aOmvr","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-dfa-never","processId":"31801","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":"anyclaw\n","exitCode":0,"durationMs":0},"threadId":"019ed3db-568a-7310-915b-9c080265ab5b","turnId":"019ed3db-5989-7af0-9a43-ff833757ea5a","completedAtMs":1781670836020}}
```

Raw `rm -rf` item, no approval:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_XJ7rogfPtSaEDzLavBiCCdot","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-never'","cwd":"/tmp/codex-b2probe-dfa-never","processId":"96469","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-never"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3db-568a-7310-915b-9c080265ab5b","turnId":"019ed3db-5989-7af0-9a43-ff833757ea5a","startedAtMs":1781670838548}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_XJ7rogfPtSaEDzLavBiCCdot","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-never'","cwd":"/tmp/codex-b2probe-dfa-never","processId":"96469","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-never"}],"aggregatedOutput":null,"exitCode":0,"durationMs":0},"threadId":"019ed3db-568a-7310-915b-9c080265ab5b","turnId":"019ed3db-5989-7af0-9a43-ff833757ea5a","completedAtMs":1781670838548}}
NOTE finish_reason=turn_completed elapsed_ms=13109 approvals=0 rm_target_exists=false
```

## Supplemental Trusted-read Probe

Because the matrix only directly covered `cat`, one additional `danger-full-access` x `on-request` turn checked common read/list commands before the same dangerous delete.

Observed no approval for these commands:

```text
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_y8opcXqFGwZ8aeV9p2v5rM1Y","command":"/bin/bash -lc 'ls -la /tmp/codex-b2probe-trusted-extra'","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"32324","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"listFiles","command":"ls -la /tmp/codex-b2probe-trusted-extra","path":"codex-b2probe-trusted-extra"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","startedAtMs":1781670915840}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_y8opcXqFGwZ8aeV9p2v5rM1Y","command":"/bin/bash -lc 'ls -la /tmp/codex-b2probe-trusted-extra'","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"32324","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"listFiles","command":"ls -la /tmp/codex-b2probe-trusted-extra","path":"codex-b2probe-trusted-extra"}],"aggregatedOutput":"total 76\ndrwx------.  2 root root   3452 Jun 17 13:35 .\ndrwxrwxrwx. 69 root root 118784 Jun 17 13:35 ..\n-rw-------.  1 root root     11 Jun 17 13:35 sample.txt\n","exitCode":0,"durationMs":0},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","completedAtMs":1781670915840}}
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_fE3STPdnkroT0OLiPNqUTkO7","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"9805","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","startedAtMs":1781670919655}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_fE3STPdnkroT0OLiPNqUTkO7","command":"/bin/bash -lc 'cat /etc/hostname'","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"9805","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"read","command":"cat /etc/hostname","name":"hostname","path":"/etc/hostname"}],"aggregatedOutput":"anyclaw\n","exitCode":0,"durationMs":0},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","completedAtMs":1781670919655}}
S->C {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_htiM7gZrWpgmfmfEDDUWsE4K","command":"/bin/bash -lc \"sed -n '1p' /tmp/codex-b2probe-trusted-extra/sample.txt\"","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"35092","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"sed -n 1p /tmp/codex-b2probe-trusted-extra/sample.txt","name":"sample.txt","path":"/tmp/codex-b2probe-trusted-extra/sample.txt"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","startedAtMs":1781670924991}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_htiM7gZrWpgmfmfEDDUWsE4K","command":"/bin/bash -lc \"sed -n '1p' /tmp/codex-b2probe-trusted-extra/sample.txt\"","cwd":"/tmp/codex-b2probe-trusted-extra","processId":"35092","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"read","command":"sed -n 1p /tmp/codex-b2probe-trusted-extra/sample.txt","name":"sample.txt","path":"/tmp/codex-b2probe-trusted-extra/sample.txt"}],"aggregatedOutput":"alpha\n","exitCode":0,"durationMs":0},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","completedAtMs":1781670924992}}
```

The same supplemental turn still surfaced `rm -rf`:

```text
S->C {"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","itemId":"call_M5HLpNwAV8aPFdAKXkR1V5g2","startedAtMs":1781670929475,"command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request-extra'","cwd":"/tmp/codex-b2probe-trusted-extra","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-on-request-extra"}],"proposedExecpolicyAmendment":["rm","-rf","/tmp/probe-dfa-on-request-extra"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["rm","-rf","/tmp/probe-dfa-on-request-extra"]}},"cancel"]}}
C->S {"id":0,"result":{"decision":"decline"}}
S->C {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_M5HLpNwAV8aPFdAKXkR1V5g2","command":"/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request-extra'","cwd":"/tmp/codex-b2probe-trusted-extra","processId":null,"source":"agent","status":"declined","commandActions":[{"type":"unknown","command":"rm -rf /tmp/probe-dfa-on-request-extra"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019ed3dc-8e1d-7153-be60-5f5f655ae0a5","turnId":"019ed3dc-922b-7492-885e-841c92f02550","completedAtMs":1781670929485}}
NOTE finish_reason=turn_completed rm_target_exists=true
```

## Conclusions

danger-full-access でも危険な書込/実行コマンドが client gate に surface するか: YES, when `approvalPolicy` is `untrusted` or `on-request`.

Observed client-gated dangerous command:

```text
/bin/bash -lc 'rm -rf /tmp/probe-dfa-untrusted'
/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request'
/bin/bash -lc 'rm -rf /tmp/probe-dfa-on-request-extra'
```

Observed trusted bypass commands under `danger-full-access`:

```text
cat /etc/hostname
ls -la /tmp/codex-b2probe-trusted-extra
sed -n '1p' /tmp/codex-b2probe-trusted-extra/sample.txt
```

No dangerous bypass was observed under `approvalPolicy=untrusted` or `approvalPolicy=on-request`. The control cell confirmed `approvalPolicy=never` bypasses the client gate and executes `rm -rf`, so it is not usable for B2.

Recommended B2 config:

```json
{
  "sandbox": "danger-full-access",
  "approvalPolicy": "on-request",
  "approvalsReviewer": "user"
}
```

For `turn/start`, also send:

```json
{
  "sandboxPolicy": { "type": "dangerFullAccess" },
  "approvalPolicy": "on-request",
  "approvalsReviewer": "user"
}
```

`untrusted` is also viable based on this probe, but `on-request` is the better default for B2 because it preserved the client gate for `rm -rf` while allowing observed read/list commands to proceed without extra prompts.

## Stability Notes

- Host only; bionic / Shelly FGS execution remains outside this task.
- `codex app-server` emitted the same bubblewrap warning as Phase 1.5 and continued.
- No app-server crash was observed across the matrix or supplemental probe.
