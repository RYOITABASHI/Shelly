/**
 * Automatic ClosePaw routing of a UI-operation step
 * (lib/agent-closepaw-routing.ts) and the one-approval ClosePaw pre-approval
 * seal (lib/agent-closepaw-preapproval.ts), 2026-10-14.
 */
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  tFor: (locale: string, key: string, params?: Record<string, string | number>) =>
    params ? `${locale}:${key}|${JSON.stringify(params)}` : `${locale}:${key}`,
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { applyClosePawAutoRouting, detectUiOperationClause } from '@/lib/agent-closepaw-routing';
import {
  __setClosePawSealStorageForTests,
  goalMatchesTemplate,
  isClosePawPreapproved,
  revokeClosePawPreapproval,
  sealClosePawPreapproval,
} from '@/lib/agent-closepaw-preapproval';
import { __setAgentAddCryptoForTests } from '@/lib/agent-add-approval';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function draft(over: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'x',
    prompt: 'x',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: '毎日 08:00',
    action: { type: 'draft' },
    tool: 'auto',
    toolLabel: 'Auto',
    ...over,
  } as ParsedAgentDraft;
}

describe('detectUiOperationClause — positives', () => {
  const cases: Array<[string, string, string]> = [
    ['毎朝8時にAIニュースを調べてLINEを開いて自分に送って', 'LINE', 'LINEを開いて自分に送って'],
    ['毎朝AIニュースを調べてまとめて、LINEで自分に送って', 'LINE', 'LINEで自分に送って'],
    ['Chromeで天気予報を表示して', 'Chrome', 'Chromeで天気予報を表示して'],
    ['毎晩10時にYouTubeで作業用BGMを再生して', 'YouTube', 'YouTubeで作業用BGMを再生して'],
    ['毎朝7時にSpotifyを起動して', 'Spotify', 'Spotifyを起動して'],
    ['インスタを開いて最新の投稿を見せて', 'Instagram', 'インスタを開いて最新の投稿を見せて'],
    ['毎週金曜にLINEで家族にメッセージを送って', 'LINE', 'LINEで家族にメッセージを送って'],
    ['Googleマップを開いて自宅までの経路を表示して', 'Google Maps', 'Googleマップを開いて自宅までの経路を表示して'],
    ['every morning at 7 open Spotify and play my focus playlist', 'Spotify', 'open Spotify and play my focus playlist'],
    ['Summarize the AI news and send it to me on LINE', 'LINE', 'send it to me on LINE'],
    ['every evening, in Chrome, show the weather forecast for Tokyo', 'Chrome', 'in Chrome, show the weather forecast for Tokyo'],
    ['Daily at 9am open YouTube and play lofi music', 'YouTube', 'open YouTube and play lofi music'],
  ];
  it.each(cases)('%s', (text, app, clause) => {
    expect(detectUiOperationClause(text)).toMatchObject({ app, clause });
  });
});

describe('detectUiOperationClause — negatives (conservative)', () => {
  const cases = [
    'AIニュースを調べてまとめて',
    '毎朝AIニュースを調べてブリーフィングにまとめて',
    'LINEの通知が来たら要約して',
    'Gmailのメールを要約して通知して',
    'YouTubeの動画について調べて',
    'Chromeで最新ニュースを検索して',
    'Xに投稿して',
    'Blueskyに毎朝投稿して',
    'research the latest Chrome release notes',
    'summarize my Slack messages every evening',
    'remind me to open LINE at 9',
    '毎朝LINEを開くようにリマインドして',
    'send the summary in line with the template',
    'open the pod bay doors',
    'Spotifyの新曲を調べて通知して',
  ];
  it.each(cases)('%s', (text) => {
    expect(detectUiOperationClause(text)).toBeNull();
  });
});

describe('applyClosePawAutoRouting', () => {
  const raw = '毎朝8時にAIニュースを調べてまとめて、LINEで自分に送って';
  const parsed = draft({ prompt: 'AIニュースを調べてまとめて、LINEで自分に送って' });

  it('routes only the UI step to ClosePaw, keeps the native part, and records it', () => {
    const out = applyClosePawAutoRouting(parsed, raw, { closePawInstalled: true });
    expect(out.action).toEqual({ type: 'intent', intentMode: 'closepaw', intentShareText: 'LINEで自分に送って（内容: {{result}}）' });
    expect(out.prompt).toBe('AIニュースを調べてまとめて');
    expect(out.closePawRouting).toEqual({ clause: 'LINEで自分に送って', app: 'LINE', routed: true });
  });

  it('uses the clause alone as the goal when there is no native part', () => {
    const out = applyClosePawAutoRouting(draft({ prompt: 'Chromeで天気予報を表示して' }), 'Chromeで天気予報を表示して', { closePawInstalled: true });
    expect(out.action).toEqual({ type: 'intent', intentMode: 'closepaw', intentShareText: 'Chromeで天気予報を表示して' });
    expect(out.prompt).toBe('Chromeで天気予報を表示して');
  });

  it('does not route without ClosePaw installed; says the step cannot be automated', () => {
    const out = applyClosePawAutoRouting(parsed, raw, { closePawInstalled: false });
    expect(out.action).toEqual({ type: 'draft' });
    expect(out.closePawRouting).toEqual({ clause: 'LINEで自分に送って', app: 'LINE', routed: false });
    expect(out.actionCaveat).toContain('ClosePaw');
    expect(out.actionCaveat).toContain('自動化できません');
  });

  it('never replaces a native delivery Shelly already resolved, nor an explicit ClosePaw action', () => {
    for (const action of [
      { type: 'social-post' as const },
      { type: 'browser-pane' as const },
      { type: 'webhook' as const, webhookUrl: 'https://x' },
      { type: 'cli' as const, command: 'echo' },
      { type: 'intent' as const, intentMode: 'closepaw' as const, intentShareText: 'explicit goal' },
    ]) {
      const d = draft({ action: action as never });
      expect(applyClosePawAutoRouting(d, raw, { closePawInstalled: true })).toBe(d);
    }
  });

  it('leaves drafts without a UI step unchanged', () => {
    const d = draft({ prompt: 'AIニュースを調べて' });
    expect(applyClosePawAutoRouting(d, '毎朝AIニュースを調べて', { closePawInstalled: true })).toBe(d);
  });

  it('drops the UI step from orchestration steps', () => {
    const d = draft({
      prompt: 'p',
      orchestrationSteps: ['AIニュースを集めて', '要約して', 'LINEで自分に送って'],
    });
    const out = applyClosePawAutoRouting(d, 'AIニュースを集めて、要約して、LINEで自分に送って', { closePawInstalled: true });
    expect(out.orchestrationSteps).toEqual(['AIニュースを集めて', '要約して']);
  });

  it('the explicit "ClosePawで…" path is untouched and checked first in the parser', () => {
    const parser = read('lib/agent-nl-parser.ts');
    expect(parser).toContain('export function detectClosePawAction(text: string): AgentAction | null');
    const dispatch = read('hooks/use-ai-pane-dispatch.ts');
    expect(dispatch).toContain('applyClosePawAutoRouting(draft, promptText, { closePawInstalled: closePawInstalled === true })');
  });

  it('confirmation surfaces name the ClosePaw step', () => {
    const summary = read('lib/agent-plan-summary.ts');
    expect(summary).toContain("tl('agentplan.closepaw_auto_routed_line', { step: draft.closePawRouting.clause })");
    expect(summary).toContain('if (draft.closePawRouting?.routed) return true;');
    expect(read('lib/i18n/locales/ja.ts')).toContain("'agentplan.closepaw_auto_routed_line': 'この部分は ClosePaw がスマホを操作して実行します: {{step}}'");
  });
});

// ── One-approval pre-approval seal ─────────────────────────────────────────

describe('ClosePaw pre-approval seal', () => {
  let stored: string | null = null;
  beforeAll(() => {
    __setAgentAddCryptoForTests({
      sha256Hex: async (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
      randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
    });
  });
  beforeEach(() => {
    stored = null;
    __setClosePawSealStorageForTests({
      get: async () => stored,
      set: async (v) => {
        stored = v;
      },
    });
  });

  const agent = {
    id: 'agent-1',
    prompt: 'AIニュースを調べてまとめて',
    action: { type: 'intent', intentMode: 'closepaw', intentShareText: 'LINEで自分に送って（内容: {{result}}）' },
  };
  const request = (shareText: string, over: Record<string, unknown> = {}) => ({
    agentId: 'agent-1',
    actionType: 'intent',
    intentMode: 'closepaw',
    intentShareText: shareText,
    ...over,
  });

  it('matches only after a seal, for the exact agent + resolved goal', async () => {
    const resolved = 'LINEで自分に送って（内容: 今日のAIニュース\n1. ...）';
    await expect(isClosePawPreapproved(request(resolved), agent)).resolves.toBe(false);
    await expect(sealClosePawPreapproval(agent, 'chatgpt')).resolves.toBe(true);
    await expect(isClosePawPreapproved(request(resolved), agent)).resolves.toBe(true);
    // recurring: reusable for the same binding
    await expect(isClosePawPreapproved(request('LINEで自分に送って（内容: 別の日）'), agent)).resolves.toBe(true);
  });

  it('refuses a different goal, agent, mode or action type', async () => {
    await sealClosePawPreapproval(agent, 'chat');
    await expect(isClosePawPreapproved(request('Gmailで上司に送って（内容: x）'), agent)).resolves.toBe(false);
    await expect(isClosePawPreapproved(request('LINEで自分に送って（内容: x）', { agentId: 'agent-2' }), agent)).resolves.toBe(false);
    await expect(isClosePawPreapproved(request('LINEで自分に送って（内容: x）', { intentMode: 'launch' }), agent)).resolves.toBe(false);
    await expect(isClosePawPreapproved(request('LINEで自分に送って（内容: x）', { actionType: 'cli' }), agent)).resolves.toBe(false);
  });

  it('any edit of the goal, prompt or steps invalidates it', async () => {
    await sealClosePawPreapproval(agent, 'notification');
    const r = request('LINEで自分に送って（内容: x）');
    await expect(isClosePawPreapproved(r, { ...agent, prompt: 'ほかのことをして' })).resolves.toBe(false);
    await expect(isClosePawPreapproved(r, { ...agent, orchestration: { steps: ['a', 'b'] } })).resolves.toBe(false);
    await expect(
      isClosePawPreapproved(r, { ...agent, action: { ...agent.action, intentShareText: 'LINEで全員に送って（内容: {{result}}）' } }),
    ).resolves.toBe(false);
  });

  it('a seal is bound to its agent definition hash and can be revoked', async () => {
    await sealClosePawPreapproval(agent, 'chat');
    expect(JSON.parse(stored!)[0]).toMatchObject({ agentId: 'agent-1', stepIndex: -1, mode: 'closepaw', goalTemplate: 'LINEで自分に送って（内容: {{result}}）' });
    await revokeClosePawPreapproval('agent-1');
    await expect(isClosePawPreapproved(request('LINEで自分に送って（内容: x）'), agent)).resolves.toBe(false);
  });

  it('agents without exactly one ClosePaw hand-off are never sealed', async () => {
    await expect(sealClosePawPreapproval({ id: 'a', action: { type: 'draft' } }, 'chat')).resolves.toBe(false);
  });

  it('goalMatchesTemplate: literal parts must match exactly', () => {
    expect(goalMatchesTemplate('Chromeで天気予報を表示して', 'Chromeで天気予報を表示して')).toBe(true);
    expect(goalMatchesTemplate('Chromeで別のページを表示して', 'Chromeで天気予報を表示して')).toBe(false);
    expect(goalMatchesTemplate('送って: abc 末尾', '送って: {{result}} 末尾')).toBe(true);
    expect(goalMatchesTemplate('送って: abc', '送って: {{result}} 末尾')).toBe(false);
    expect(goalMatchesTemplate('', '{{result}}')).toBe(false);
  });

  it('RN choke point honours the seal only via the minted, re-verified request; executor waits instead of refusing', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain('autoResolveActionApproval(parsed, { closePawPreapproved: true })');
    expect(layout).toMatch(/if \(!opts\?\.closePawPreapproved \|\| minted\.agentId !== parsed\.agentId \|\| !\(await closePawPreapprovedFor\(minted\)\)\) return false;/);
    const exec = read('scripts/shelly-plan-executor.js');
    expect(exec).toContain("const closePawHandoff = actionType === 'intent' && plan.action && plan.action.intentMode === 'closepaw';");
    // Still never auto-accepted by the executor itself.
    expect(exec).toContain("autoAccept: intentMode !== 'closepaw' && !requireActionApprovalTap(plan, config),");
    // The seal is stored in SecureStore, never a file under $HOME.
    expect(read('lib/agent-closepaw-preapproval.ts')).toContain("require('expo-secure-store')");
  });
});
