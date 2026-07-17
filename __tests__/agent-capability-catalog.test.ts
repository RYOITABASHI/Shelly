/**
 * __tests__/agent-capability-catalog.test.ts
 *
 * The example utterances in lib/agent-capability-catalog.ts are user-facing
 * copy-pasteable text (shown in components/layout/AgentCapabilitiesModal.tsx
 * and the README-style discovery surface). Per project convention, any such
 * example must be proven against the REAL parser, not merely eyeballed — see
 * this module's own doc comment. This file is that proof: it strips the
 * leading "@agent " mention exactly like hooks/use-ai-pane-dispatch.ts does
 * before handing the rest to parseAgentNL, then asserts each example
 * produces a confident (non-null) whitelisted schedule and the action/
 * autonomous behavior the catalog's `explain` text claims.
 */
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { AGENT_EXAMPLE_UTTERANCES, AGENT_CAPABILITIES } from '@/lib/agent-capability-catalog';
import { FEATURE_CATALOG } from '@/lib/feature-catalog';

// Same whitelist the scheduler enforces (lib/agent-scheduler.ts) — mirrors
// __tests__/agent-nl-parser.test.ts's WHITELIST_CRON so a catalog example can
// never silently regress into an unfireable schedule.
const WHITELIST_CRON = /^(\*\/\d+ \* \* \* \*|0 \*\/\d+ \* \* \*|\d+ \d+ \* \* \*|\d+ \d+ \* \* [0-6](,[0-6])*)$/;

function stripAgentMention(utterance: string): string {
  return utterance.replace(/^\s*[@＠]agent\s*/i, '');
}

describe('AGENT_EXAMPLE_UTTERANCES — every example is a real @agent mention', () => {
  it('each utterance starts with an @agent mention', () => {
    for (const ex of AGENT_EXAMPLE_UTTERANCES) {
      expect(ex.utterance).toMatch(/^@agent\s/i);
    }
  });

  it('ids are unique', () => {
    const ids = AGENT_EXAMPLE_UTTERANCES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('AGENT_EXAMPLE_UTTERANCES — parse against the real deterministic parser', () => {
  it('daily-draft → confident daily 08:00, draft action, not autonomous', () => {
    const ex = AGENT_EXAMPLE_UTTERANCES.find((e) => e.id === 'daily-draft')!;
    const d = parseAgentNL(stripAgentMention(ex.utterance));
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
    expect(d.action.type).toBe('draft');
    expect(d.actionCaveat).toBeUndefined();
    expect(d.autonomous).toBeFalsy();
  });

  it('daily-notify → confident daily 09:00, notify action', () => {
    const ex = AGENT_EXAMPLE_UTTERANCES.find((e) => e.id === 'daily-notify')!;
    const d = parseAgentNL(stripAgentMention(ex.utterance));
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 9 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
    expect(d.action.type).toBe('notify');
  });

  it('hourly-interval → confident every-3-hours schedule', () => {
    const ex = AGENT_EXAMPLE_UTTERANCES.find((e) => e.id === 'hourly-interval')!;
    const d = parseAgentNL(stripAgentMention(ex.utterance));
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 */3 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
  });

  it('weekly-multi-day → confident Mon+Thu 07:00 schedule', () => {
    const ex = AGENT_EXAMPLE_UTTERANCES.find((e) => e.id === 'weekly-multi-day')!;
    const d = parseAgentNL(stripAgentMention(ex.utterance));
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 7 * * 1,4');
    expect(d.schedule).toMatch(WHITELIST_CRON);
  });

  it('autonomous → confident daily 08:00 AND the autonomous intent is detected', () => {
    const ex = AGENT_EXAMPLE_UTTERANCES.find((e) => e.id === 'autonomous')!;
    const d = parseAgentNL(stripAgentMention(ex.utterance));
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
    expect(d.autonomous).toBe(true);
  });

  it('every example produces a confident, whitelisted schedule (blanket sweep)', () => {
    for (const ex of AGENT_EXAMPLE_UTTERANCES) {
      const d = parseAgentNL(stripAgentMention(ex.utterance));
      expect(d.scheduleConfident).toBe(true);
      expect(d.schedule).not.toBeNull();
      expect(d.schedule as string).toMatch(WHITELIST_CRON);
    }
  });
});

describe('AGENT_CAPABILITIES — sourced from FEATURE_CATALOG, covers all 8 action types', () => {
  it('is exactly the agent-category slice of FEATURE_CATALOG', () => {
    const expected = FEATURE_CATALOG.filter((f) => f.category === 'agent');
    expect(AGENT_CAPABILITIES).toEqual(expected);
    expect(AGENT_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it('describes all 8 AgentActionType values', () => {
    const actionTypes = ['draft', 'notify', 'webhook', 'cli', 'intent', 'dm-reply', 'app-act', 'api-call'];
    for (const type of actionTypes) {
      const found = AGENT_CAPABILITIES.some((f) => f.id === `agent-action-${type}`);
      expect(found).toBe(true);
    }
  });
});
