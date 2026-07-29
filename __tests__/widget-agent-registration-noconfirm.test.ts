// Widget-ASK no-confirm registration opt-in (2026-07-29,
// AppSettings.widgetAgentRegistrationNoConfirm — see
// lib/widget-agent-registration.ts). Follows the two established shapes:
//
//   - __tests__/agent-executor-optimistic-approval-override.test.ts's
//     "both settings states behave correctly, OFF truly changes nothing"
//     matrix, applied to the pure resolver that is the single decision point;
//   - __tests__/widget-agent-command-parity.test.ts's offline source drift
//     gate, keeping the cross-file wiring (store default → dispatch decision
//     point → AIPane/_layout source tagging → Settings UI consent) coupled
//     until the on-device acceptance pass exercises it end to end.
//
// Context this opt-in must never regress: registration confirm-BY-DEFAULT is
// a deliberate 2026-07-24 product-owner reversal (store/settings-store.ts's
// agentRegistrationRequireConfirm comment). The widget toggle is an
// OFF-by-default, widget-ASK-scoped bypass on top — never a change to that
// default, and never applicable to AI-Pane-typed `@agent`.

// lib/i18n imports expo-localization (ESM-only) which the plain "unit"
// ts-jest project cannot parse — mock it like agent-plan-summary.test.ts,
// surfacing locale + params so copy assertions check what was actually
// composed.
jest.mock('@/lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  tFor: (locale: string, key: string, params?: Record<string, string | number>) =>
    params ? `${locale}:${key}|${JSON.stringify(params)}` : `${locale}:${key}`,
}));

const scheduleNotificationAsync = jest.fn<Promise<string>, unknown[]>(() => Promise.resolve('notif-id'));
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => scheduleNotificationAsync(...args),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  resolveRegistrationConfirmRequirement,
  buildWidgetAgentRegisteredNotification,
  notifyWidgetAgentRegistered,
} from '@/lib/widget-agent-registration';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// ─── The both-states matrix (single decision point) ─────────────────────────

describe('resolveRegistrationConfirmRequirement — both settings states', () => {
  // Shipped defaults: confirm-required ON (2026-07-24 reversal), widget
  // bypass OFF.
  const defaults = {
    agentRegistrationRequireConfirm: true,
    widgetAgentRegistrationNoConfirm: false,
  };

  it('OFF (default): widget-ASK input reaches the confirm flow — no silent registration', () => {
    expect(resolveRegistrationConfirmRequirement(defaults, 'widget-ask')).toBe(true);
  });

  it('OFF (default): AI-Pane input reaches the confirm flow', () => {
    expect(resolveRegistrationConfirmRequirement(defaults, 'ai-pane')).toBe(true);
  });

  it('OFF truly changes nothing: widget and AI-Pane resolve identically for every global-setting value', () => {
    for (const requireConfirm of [true, false]) {
      const s = { agentRegistrationRequireConfirm: requireConfirm, widgetAgentRegistrationNoConfirm: false };
      expect(resolveRegistrationConfirmRequirement(s, 'widget-ask'))
        .toBe(resolveRegistrationConfirmRequirement(s, 'ai-pane'));
    }
  });

  it('absent flag (legacy persisted settings) behaves exactly like OFF', () => {
    const legacy = { agentRegistrationRequireConfirm: true } as Parameters<
      typeof resolveRegistrationConfirmRequirement
    >[0];
    expect(resolveRegistrationConfirmRequirement(legacy, 'widget-ask')).toBe(true);
    expect(resolveRegistrationConfirmRequirement(legacy, 'ai-pane')).toBe(true);
  });

  it('ON: widget-ASK input skips the confirm step (direct-registration path)', () => {
    const s = { ...defaults, widgetAgentRegistrationNoConfirm: true };
    expect(resolveRegistrationConfirmRequirement(s, 'widget-ask')).toBe(false);
  });

  it('ON: AI-Pane input STILL reaches the confirm flow — the bypass is widget-scoped', () => {
    const s = { ...defaults, widgetAgentRegistrationNoConfirm: true };
    expect(resolveRegistrationConfirmRequirement(s, 'ai-pane')).toBe(true);
  });

  it('ON + global no-confirm: both sources skip (global fast path is not re-tightened)', () => {
    const s = { agentRegistrationRequireConfirm: false, widgetAgentRegistrationNoConfirm: true };
    expect(resolveRegistrationConfirmRequirement(s, 'widget-ask')).toBe(false);
    expect(resolveRegistrationConfirmRequirement(s, 'ai-pane')).toBe(false);
  });

  it('fails closed on a corrupted persisted value (truthy non-boolean never bypasses)', () => {
    const s = {
      agentRegistrationRequireConfirm: true,
      widgetAgentRegistrationNoConfirm: 1 as unknown as boolean,
    };
    expect(resolveRegistrationConfirmRequirement(s, 'widget-ask')).toBe(true);
  });
});

// ─── Post-hoc notification copy ("act immediately, notify after") ───────────

describe('widget-registration notification', () => {
  beforeEach(() => scheduleNotificationAsync.mockClear());

  it('composes per-utterance-locale copy carrying name + schedule', () => {
    const en = buildWidgetAgentRegisteredNotification({ name: 'Weather brief', scheduleLabel: 'daily 07:00' }, 'en');
    expect(en.title).toBe('en:agents.widget_registered_title');
    expect(en.body).toContain('en:agents.widget_registered_body');
    expect(en.body).toContain('"name":"Weather brief"');
    expect(en.body).toContain('"schedule":"daily 07:00"');
    const ja = buildWidgetAgentRegisteredNotification({ name: '天気まとめ', scheduleLabel: '毎日 07:00' }, 'ja');
    expect(ja.title).toBe('ja:agents.widget_registered_title');
    expect(ja.body).toContain('"name":"天気まとめ"');
  });

  it('posts an IMMEDIATE notification (trigger: null)', async () => {
    await notifyWidgetAgentRegistered({ name: 'Weather brief', scheduleLabel: 'daily 07:00' }, 'en');
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const arg = scheduleNotificationAsync.mock.calls[0][0] as {
      content: { title: string; body: string };
      trigger: null;
    };
    expect(arg.trigger).toBeNull();
    expect(arg.content.title).toBe('en:agents.widget_registered_title');
    expect(arg.content.body).toContain('Weather brief');
  });
});

// ─── Offline wiring drift gate ──────────────────────────────────────────────

describe('no-confirm opt-in wiring stays coupled across files', () => {
  const settingsStore = read('store/settings-store.ts');
  const types = read('store/types.ts');
  const dispatchHook = read('hooks/use-ai-pane-dispatch.ts');
  const aiPane = read('components/panes/AIPane.tsx');
  const layout = read('app/_layout.tsx');
  const aiPaneStore = read('store/ai-pane-store.ts');
  const configTui = read('components/config/ConfigTUI.tsx');
  const settingsDropdown = read('components/layout/SettingsDropdown.tsx');
  const localesEn = read('lib/i18n/locales/en.ts');
  const localesJa = read('lib/i18n/locales/ja.ts');

  it('ships OFF by default and is a documented AppSettings field', () => {
    expect(settingsStore).toContain('widgetAgentRegistrationNoConfirm: false,');
    expect(types).toContain('widgetAgentRegistrationNoConfirm?: boolean;');
  });

  it('dispatch resolves the confirm requirement ONLY through the shared resolver, keyed on the widget source tag', () => {
    expect(dispatchHook).toContain('resolveRegistrationConfirmRequirement(');
    expect(dispatchHook).toContain("dispatchOpts?.source === 'widget-ask'");
    // The setting itself must never be read inline anywhere in the dispatch
    // flow — a second read would create a second, driftable decision point.
    // (Doc comments referencing `AppSettings.widgetAgentRegistrationNoConfirm`
    // are fine; an actual `settings.` property read is not.)
    expect(dispatchHook).not.toContain('settings.widgetAgentRegistrationNoConfirm');
  });

  it('the hard auto-register gates are untouched (same guard call, same order)', () => {
    // Confirm-skip still rides shouldAutoRegisterDraft (fireable-schedule +
    // assumption gates) behind the risk-tier eligibility check — the widget
    // opt-in only changes the requireRegistrationConfirm input, never the
    // guard structure.
    const gate = dispatchHook.indexOf(
      'if (autoRegisterEligible && shouldAutoRegisterDraft(draft, requireRegistrationConfirm))',
    );
    const confirmCall = dispatchHook.indexOf(
      'await confirmAgentDraft(draftMessageId, draftToConfirmedAgentDraft(draft));',
    );
    expect(gate).toBeGreaterThan(-1);
    expect(confirmCall).toBeGreaterThan(gate);
  });

  it('the post-hoc notification fires only for widget-sourced dispatches whose bubble actually flipped to confirmed', () => {
    const notifyIdx = dispatchHook.indexOf('notifyWidgetAgentRegistered(');
    const sourceGuard = dispatchHook.indexOf("if (registrationSource === 'widget-ask')");
    const confirmedGuard = dispatchHook.indexOf("agentCardState === 'confirmed'");
    const confirmCall = dispatchHook.indexOf(
      'await confirmAgentDraft(draftMessageId, draftToConfirmedAgentDraft(draft));',
    );
    expect(notifyIdx).toBeGreaterThan(-1);
    // Ordering: register → widget-source guard → confirmed-state guard → notify.
    expect(sourceGuard).toBeGreaterThan(confirmCall);
    expect(confirmedGuard).toBeGreaterThan(sourceGuard);
    expect(notifyIdx).toBeGreaterThan(confirmedGuard);
  });

  it('the widget source tag flows deep-link → store → AIPane → dispatch', () => {
    expect(layout).toContain("setPendingExternalPrompt(command, 'widget-ask')");
    expect(aiPaneStore).toContain("source?: 'widget-ask';");
    expect(aiPane).toContain('handleSubmit(taken.text, taken.source ? { source: taken.source } : undefined)');
  });

  it('both Settings surfaces expose the toggle with the informed-consent Alert-on-enable pattern', () => {
    // ConfigTUI: setting def + consent gated on turning ON only.
    expect(configTui).toContain("key: 'widgetAgentRegistrationNoConfirm'");
    expect(configTui).toContain("def.key === 'widgetAgentRegistrationNoConfirm' && rawValue === true");
    // SettingsDropdown: same consent shape as Autonomous Cloud / Optimistic
    // Writes (consent only when enabling; plain toggle-off).
    expect(settingsDropdown).toContain('const toggleWidgetNoConfirm = async () => {');
    expect(settingsDropdown).toContain('if (!widgetNoConfirm) {');
    expect(settingsDropdown).toContain("t('agents.widget_noconfirm_consent_title')");
    expect(settingsDropdown).toContain("t('agents.widget_noconfirm_hint')");
  });

  it.each([
    'agents.widget_noconfirm',
    'agents.widget_noconfirm_hint',
    'agents.widget_noconfirm_consent_title',
    'agents.widget_noconfirm_consent_body',
    'agents.widget_noconfirm_consent_enable',
    'agents.widget_registered_title',
    'agents.widget_registered_body',
  ])('EN and JA locales both define %s', (key) => {
    expect(localesEn).toContain(`'${key}'`);
    expect(localesJa).toContain(`'${key}'`);
  });

  it('the copy names the widget-only scope in both locales', () => {
    // The load-bearing informed-consent claim: AI-Pane @agent is unaffected.
    expect(localesEn).toContain('"@agent" typed in the AI Pane is NOT affected');
    expect(localesJa).toContain('AI ペインに直接入力した @agent は対象外');
  });
});
