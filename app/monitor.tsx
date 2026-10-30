// Deep-link landing route for shelly://monitor (MONITOR home-screen widget).
// RootLayout handles the side effect: open the MONITOR pane on the tapped
// agent / channel (lib/monitor-widget-link.ts). This route only prevents
// Expo Router's unmatched page on cold starts.
export { default } from './index';
