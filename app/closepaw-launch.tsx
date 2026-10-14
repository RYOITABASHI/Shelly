// Deep-link landing route for shelly:///closepaw-launch?nonce=... (tap on a
// deferred ClosePaw hand-off notification when the Shelly-trusted ClosePaw
// variant is installed — ClosePawHandoff.launchDeferred re-checks the
// certificate at tap time). RootLayout's handleDeepLink does the side effect;
// this route only keeps Expo Router from rendering its Unmatched Route page.
export { default } from './index';
