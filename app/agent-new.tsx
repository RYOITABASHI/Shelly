// Deep-link landing route for shelly://agent-new (Scouter widget ＋NEW, Task A).
// RootLayout's handleDeepLink does the side effect: open the AI pane (the agent
// NL input) and arm voice. This route file only prevents Expo Router's unmatched
// page — there is no dedicated screen, it renders the same ShellLayout as index.
export { default } from './index';
