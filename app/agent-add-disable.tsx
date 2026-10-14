// Deep-link landing route for shelly:///agent-add-disable?agentId=...&nonce=...
// (the audit notification's Disable action after an agent was approved from
// ChatGPT, AgentAddHandoff.postAuditNotification). RootLayout's handleDeepLink
// does the side effect (lib/agent-add-flow.ts handleAgentAddDisableDeepLink);
// this route only keeps Expo Router from rendering its Unmatched Route page.
export { default } from './index';
