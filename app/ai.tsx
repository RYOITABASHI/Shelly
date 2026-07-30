// Deep-link landing route for shelly:///ai — including
// shelly:///ai?widgetAgentCommand=1, the Scouter widget ASK → `@agent …`
// registration handoff (ScouterWidgetPromptActivity.AGENT_COMMAND_COMPOSE_URI).
// RootLayout handles the side effect: focus/open the AI Pane and seed
// ai-pane-store's pendingExternalPrompt. Like ./agent-chat.tsx and
// ./scouter.tsx, this route exists ONLY to keep Expo Router from rendering
// its "Unmatched Route" page for the path-style (three-slash) URI.
//
// Found on-device 2026-07-30 (versionCode 2001): without this file the widget
// deep link landed on "Unmatched Route", which replaced ShellLayout — the
// deep-link handler still seeded pendingExternalPrompt, but no AI Pane was
// mounted to claim it, so the registration flow never appeared (and the
// pending prompt silently expired after 2 minutes).
// __tests__/widget-agent-deeplink-route.test.ts pins the Kotlin URI ↔ this
// route file so the two cannot drift apart again.
export { default } from './index';
