// Deep-link landing route for shelly://agent-chat?compose=1.
// RootLayout handles the side effect: open/focus the Agent Chat pane and
// focus its composer. This route only prevents Expo Router's unmatched page
// from rendering on cold starts from widgets or Android intents.
export { default } from './index';
