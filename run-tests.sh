#!/bin/bash
cd "$(dirname "$0")"
git add -A
git commit -m "$(cat <<'EOF'
feat(agent-browser-pane): wire browser-pane-automation.ts into a real agent action

Adds the 'browser-pane' AgentActionType so an agent can click/fill/extractText
against a LIVE, on-screen Browser Pane page through the existing, unmodified
lib/browser-pane-automation.ts capability (closed operation set, no raw
JS/eval, URL allowlist re-checked before and after navigation).

Wired end-to-end following the exact intent/dm-reply pattern (never app-act's
Tier-B): attended-only, always requires a human Review tap (never auto-accept
even when the global approval-mode default is 'auto'), refused unconditionally
on any unattended/alarm-fired run since no BrowserPane UI surface exists then.

- store/types.ts: new AgentActionType member + browserPaneAction/
  browserPaneUrlAllowlist fields on AgentAction.
- lib/agent-browser-pane-review.ts (new): resolveTargetBrowserPaneId (mirrors
  BrowserPane.tsx's own focused-else-first pane targeting) and
  fireReviewedAgentBrowserPaneAction (the RN "fire-then-reply" step).
- lib/agent-executor.ts: new dispatch_agent_action browser-pane) case, baked
  ACTION_BROWSER_PANE_* fields, added to request_and_wait_approval's
  always-request list; AGENT_SCRIPT_VERSION 50 -> 51.
- lib/agent-plan-spec.ts + scripts/shelly-plan-executor.js (+ byte-identical
  APK asset mirror): matching PlanSpec-executor dispatch, unattended refusal,
  and toPlanAction case.
- Kotlin: AgentActionApprovalBridge.kt/NotificationDispatcher.kt accept the
  new type and its fields; AgentRuntime.kt CURRENT_SCRIPT_VERSION 50 -> 51 and
  PLAN_EXECUTOR_ACTIONS gains "browser-pane".
- app/_layout.tsx: Review-card wiring, resolves the target pane, calls
  executeBrowserPaneAction on accept.
- lib/agent-action-reversibility.ts: explicit irreversible ruling.
- Tests: new agent-executor-browser-pane-action.test.ts and
  plan-executor-browser-pane.test.ts; updated hardcoded script-version
  literals across existing suites; regenerated the version-guard snapshot.

Multi-action fan-out (Agent.actions[]) is NOT wired for this type in this
pass — documented inline where the gap is (bakeActionFields) with a fail-
closed behavior (missing-field validation errors, never silent misdispatch).
NL authoring / AgentConfirmCard are explicitly out of scope; this type is
only constructible today by hand-editing an agent's JSON.
EOF
)"
git log -1 --format='%H %s' > commit-info.txt
echo DONE
