// Deep-link landing route for shelly:///agent-action-confirm?runId=...&requestSha256=...
// (the notification "Review" button for cli/intent agent-action approvals,
// NotificationDispatcher.agentActionReviewPendingIntent).
// RootLayout's handleDeepLink does the side effect: read the approval request
// and open the review modal (pendingAgentActionApproval overlay). This route
// file only prevents Expo Router's Unmatched Route page — same pattern as
// app/scouter.tsx / app/agent-new.tsx / app/agent-chat.tsx — it renders the
// same ShellLayout as index while the modal overlays it.
export { default } from './index';
