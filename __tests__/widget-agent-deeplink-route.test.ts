import * as fs from 'fs';
import * as path from 'path';

// Offline drift gate for the widget ASK → `@agent …` deep-link ROUTE FILE
// (2026-07-30). On-device verification of v7.5.0 (versionCode 2001) found the
// original bug this pins: ScouterWidgetPromptActivity fires the path-style
// URI shelly:///ai?widgetAgentCommand=1, and Expo Router resolves the /ai
// path against the app/ directory — with no app/ai.tsx the widget handoff
// landed on the full-screen "Unmatched Route" page. app/_layout.tsx's
// deep-link handler still consumed the pending command and seeded
// ai-pane-store's pendingExternalPrompt, but ShellLayout (and therefore every
// AI Pane) was hidden behind the unmatched page, so nothing ever claimed the
// prompt and the registration flow never appeared.
//
// The fix follows the established convention for path-style deep links
// (app/agent-chat.tsx, app/scouter.tsx): a landing route that re-exports
// app/index so RootLayout's side effect can run over the normal ShellLayout.
// These checks extract the URI literal from the Kotlin source so the two
// sides cannot silently drift apart again.
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const activity = read(
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterWidgetPromptActivity.kt',
);

describe('widget @agent deep link has a matching Expo Router route file', () => {
  const uriMatch = /AGENT_COMMAND_COMPOSE_URI = "([^"]+)"/.exec(activity);

  it('the Kotlin URI literal exists and is a path-style shelly:/// URI', () => {
    expect(uriMatch?.[1]).toBeTruthy();
    // Path-style (empty host) — expo-router matches the PATH against app/.
    // A host-style shelly://ai would parse with hostname 'ai' and path null,
    // which app/_layout.tsx's normalizeDeepLinkTarget also accepts, but the
    // shipped constant is path-style and that is what needs a route file.
    expect(uriMatch![1].startsWith('shelly:///')).toBe(true);
  });

  it('a route file exists for the URI path (prevents the Unmatched Route page)', () => {
    const uri = uriMatch![1];
    const routePath = new URL(uri).pathname.replace(/^\//, ''); // 'ai'
    expect(routePath.length).toBeGreaterThan(0);
    const routeFile = path.join(root, 'app', `${routePath}.tsx`);
    expect(fs.existsSync(routeFile)).toBe(true);
    // Same shape as app/agent-chat.tsx / app/scouter.tsx: the landing route
    // must render the real app (ShellLayout via app/index), not a stub —
    // otherwise the AI Pane still never mounts to claim the pending command.
    const routeSource = fs.readFileSync(routeFile, 'utf8');
    expect(routeSource).toMatch(/export \{ default \} from '\.\/index';/);
  });

  it("sibling path-style deep-link routes still follow the same convention", () => {
    // Regression guard for the pattern itself: these existed before and the
    // fix copies them. If one is deleted/renamed the widget-era assumption
    // that "path-style deep links get landing routes" no longer holds and
    // this whole gate needs rethinking.
    for (const f of ['agent-chat.tsx', 'scouter.tsx']) {
      expect(fs.existsSync(path.join(root, 'app', f))).toBe(true);
    }
  });
});

describe('ASK dialog title tracks the @agent detection (misleading-title fix)', () => {
  it('a dedicated agent-mode title string exists in both locales', () => {
    const stringsEn = read('modules/terminal-emulator/android/src/main/res/values/scouter_strings.xml');
    const stringsJa = read('modules/terminal-emulator/android/src/main/res/values-ja/scouter_strings.xml');
    expect(stringsEn).toMatch(/name="scouter_widget_prompt_title_agent"/);
    expect(stringsJa).toMatch(/name="scouter_widget_prompt_title_agent"/);
  });

  it('the activity switches the title with the SAME detection the SEND tap uses', () => {
    // The TextWatcher must call isAgentMentionCommand — not a second regex —
    // so the title can never disagree with where SEND will route the text.
    const watcher = /afterTextChanged[\s\S]{0,400}isAgentMentionCommand[\s\S]{0,200}scouter_widget_prompt_title_agent/.exec(activity);
    expect(watcher).toBeTruthy();
  });
});
