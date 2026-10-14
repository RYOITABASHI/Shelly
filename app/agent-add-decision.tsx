// Deep-link landing route for shelly:///agent-add-decision?reqId=...&decision=...&nonce=...
// (the `shelly agent add` approval notification's Approve / Reject actions,
// AgentAddHandoff.postParsedNotification). RootLayout's handleDeepLink does
// the side effect (lib/agent-add-flow.ts handleAgentAddDecisionDeepLink); this
// route only keeps Expo Router from rendering its Unmatched Route page — same
// pattern as ./agent-action-confirm.tsx and ./ai.tsx.
export { default } from './index';
