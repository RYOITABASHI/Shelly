# MCP agent action consent

Implemented on `fix/mcp-agent-action-preapproval`, 2026-11-16. Android build and real-device verification are still required.

## Contract

- **Allow once**: the existing ingress-tainted run; reads and model calls only. No action privilege is added.
- **Always allow**: explicit consent to this client's execution of this exact agent definition and its declared actions. New rules carry `actionPolicyPin`, the hash of the verified policy snapshot RN evaluated (or `absent`). This applies to the first run too.
- **Legacy rules**: retain dialog-only behavior. They never acquire `actionPolicyPin` automatically. Revoke the old rule in Settings and call `run_agent` while Shelly is in the foreground to grant the new scope. Settings shows which scope a rule has.
- The definition binding includes prompts, tools, actions and run settings. A definition edit invalidates the match. Editing the safety policy invalidates new action consent, even if the edit is less restrictive; authorize again in the foreground.

## Native background path

After authentication, switches, target validation, STOP-ALL and definition-taint checks, native looks for new action consent. It uses the full RN evaluation attested by a Keystore-authenticated rule, **not** a second implementation of the policy engine. The policy bytes must still match the stored snapshot and its native seal. Without that evidence, use the conservative legacy evaluator / foreground handoff. Unknown never becomes allowed.

Both paths use the same launcher. Binding, policy snapshot, switches, rule ID, deadline and taint are checked at ticket acceptance and start. The service obtains the action scope through the single-use in-process grant, never an Intent extra, request JSON or model argument. The origin remains `event`.

For new consent the service does not add the transport-only `mcp` run taint. The agent's own persisted taint still wins. Notification/external-input taint remains independent. Native exports `SHELLY_MCP_ACTIONS_PREAPPROVED` read-only, explicitly `0` on other runs. It cannot become `1` when either taint applies.

## Execution boundaries

Both executors recognize the explicit action consent after their ordinary action policy gate. It replaces the default proactive action-review requirement and per-action review frequency, not content validation. The policy gate is mandatory for these runs even if its global rollout switch is off. Runtime content-dependent deny / draft-only / ask rules still win; unreadable policy refuses unattended action execution. CRITICAL commands, scoped output roots, secret checks, connector opt-ins and existing unsupported unattended-action restrictions remain in force.

Draft and notify work without RN or an approval dialog. Existing headless-capable webhook / API / CLI / social actions can use the consent subject to their own runtime gates. Screen-dependent intent / DM / browser routes retain their existing restrictions; this change does not add headless implementations for them. ClosePaw draft-destination preapproval is separate.

Raw `run_command` / `write_file` never gain always-allow rules. MCP-created/edited agent definitions, unreadable/overflowed ingress records, and STOP-ALL are not rescued by consent. Article/voice ingress is not globally trusted.

Removing a rule or regenerating the token prevents pending/future launches. As before, rule revocation does not terminate an already-running process; STOP-ALL is the control for active runs.

## Verification before merge

Host checks cover consent migration, initial and repeated launches, policy edits, revocation/STOP-ALL/taint races, native decision/grant validation, real executor notification dispatch without review, generated-content deny/ask enforcement, and ordinary ingress-tainted runs. Native host checks compile the real MCP store / consumer / launcher / grant files with Android platform APIs and stubs for unrelated app services; they do not build an APK or emulate Keystore.

On Z Fold6, use a non-posting draft/notify agent: revoke its legacy rule, call while foreground, inspect the new consent text and choose Always allow; background/close the Activity and call again; verify the actual saved draft/notification and run result. Then edit its definition and safety policy separately, revoke the rule, turn typed ops off, and test STOP-ALL. Each must prevent the corresponding unapproved launch. Check Allow once still refuses actions. Build and real-device checks remain outstanding until recorded.
