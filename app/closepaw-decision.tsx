// Deep-link landing route for shelly:///closepaw-decision?reqId=...&decision=...&nonce=...
// (Approve / Reject on the `shelly closepaw` approval notification when the
// Shelly-trusted ClosePaw variant is installed — ClosePawShellApprovals.kt).
// RootLayout's handleDeepLink does the side effect
// (lib/closepaw-shell-approval.ts); this route only keeps Expo Router from
// rendering its Unmatched Route page.
export { default } from './index';
