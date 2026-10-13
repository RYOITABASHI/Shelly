jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import {
  CLOSEPAW_GOAL_MAX_CHARS,
  closePawReviewLine,
  fireReviewedAgentIntent,
  intentRequiresHumanReview,
  isAgentIntentMode,
  isClosePawNotInstalledError,
  sanitizeClosePawGoal,
} from '@/lib/agent-intent-review';
import { validatePlanIntentAction } from '@/lib/agent-plan-spec';
import { detectAction, detectClosePawGoal, parseAgentNL } from '@/lib/agent-nl-parser';
import { canonicalRequest } from '@/lib/signed-approval/canonical';
import { buildApprovalRequest, signApprovalReply } from '@/lib/signed-approval/sign';
import { verifyApprovalReply } from '@/lib/signed-approval/verify';
import { InMemoryNonceStore } from '@/lib/signed-approval/nonce-store';
import type { ApprovalRequest } from '@/lib/signed-approval';
import { tFor } from '@/lib/i18n';
import { Agent } from '@/store/types';
import { FakeClock } from './support/event-queue-harness';
import { makeFakeCrypto } from './support/signed-approval-crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const planExecutor = require('../scripts/shelly-plan-executor.js');

describe('ClosePaw goal sanitizer', () => {
  it('turns control characters into single spaces and trims', () => {
    expect(sanitizeClosePawGoal('  open\tChrome\r\n\nand\u0000search\u0085 weather \u007f ')).toBe(
      'open Chrome and search weather',
    );
  });

  it('caps at CLOSEPAW_GOAL_MAX_CHARS code points without splitting surrogate pairs', () => {
    const long = '😀'.repeat(CLOSEPAW_GOAL_MAX_CHARS + 50);
    const out = sanitizeClosePawGoal(long);
    expect(Array.from(out)).toHaveLength(CLOSEPAW_GOAL_MAX_CHARS);
    expect(out.endsWith('😀')).toBe(true);
  });

  it('is idempotent and null-safe', () => {
    const once = sanitizeClosePawGoal('a\n\nb   c ');
    expect(sanitizeClosePawGoal(once)).toBe(once);
    expect(sanitizeClosePawGoal(null)).toBe('');
    expect(sanitizeClosePawGoal(undefined)).toBe('');
  });

  it('matches the PlanSpec executor port byte-for-byte', () => {
    const samples = [
      'open Chrome',
      '  x\n\ty\u0000z  ',
      'ChromeでX\u001bを開いて',
      'a'.repeat(2100) + ' b',
      '😀'.repeat(2001),
      ` ${'b'.repeat(1999)}  c`,
    ];
    for (const s of samples) {
      expect(planExecutor.sanitizeClosePawGoal(s)).toBe(sanitizeClosePawGoal(s));
    }
  });
});

describe('ClosePaw intent mode helpers', () => {
  it('recognises closepaw as an intent mode', () => {
    expect(isAgentIntentMode('closepaw')).toBe(true);
    expect(isAgentIntentMode('launch')).toBe(true);
    expect(isAgentIntentMode('share')).toBe(true);
    expect(isAgentIntentMode('closepaw2')).toBe(false);
    expect(isAgentIntentMode(undefined)).toBe(false);
  });

  it('fires closepaw with an empty target and the SANITIZED goal the reviewer saw', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    await fireReviewedAgentIntent(
      { intentMode: 'closepaw', intentTarget: 'ignored', intentShareText: ' open Chrome\nand search ' },
      fire,
    );
    expect(fire).toHaveBeenCalledWith('closepaw', '', 'open Chrome and search');
  });

  it('leaves launch/share firing unchanged', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    await fireReviewedAgentIntent({ intentMode: 'share', intentShareText: 'hi\nthere' }, fire);
    expect(fire).toHaveBeenCalledWith('share', '', 'hi\nthere');
  });

  it('always requires a human review for closepaw only', () => {
    expect(intentRequiresHumanReview({ intentMode: 'closepaw' })).toBe(true);
    expect(intentRequiresHumanReview({ intentMode: 'launch' })).toBe(false);
    expect(intentRequiresHumanReview({ intentMode: 'share' })).toBe(false);
  });

  it('renders the review line "Hand off to ClosePaw: <goal>" in en and ja', () => {
    const req = { intentMode: 'closepaw' as const, intentShareText: 'open Chrome\nand search the weather in Tokyo' };
    expect(closePawReviewLine(req, (k, p) => tFor('en', k, p))).toBe(
      'Hand off to ClosePaw: open Chrome and search the weather in Tokyo (Shelly adds a fixed instruction telling ClosePaw to open apps with its open_app tool)',
    );
    expect(closePawReviewLine(req, (k, p) => tFor('ja', k, p))).toBe(
      'ClosePaw に引き継ぎ: open Chrome and search the weather in Tokyo（アプリは open_app ツールで開くよう固定の指示を Shelly が付加します）',
    );
  });

  it('detects the native not-installed marker', () => {
    expect(isClosePawNotInstalledError(new Error('CLOSEPAW_NOT_INSTALLED'))).toBe(true);
    expect(isClosePawNotInstalledError(new Error('boom'))).toBe(false);
    expect(isClosePawNotInstalledError(null)).toBe(false);
  });
});

describe('ClosePaw approval canonicalization', () => {
  const base = (over: Partial<ApprovalRequest> = {}): Omit<ApprovalRequest, 'requestSha256'> => ({
    runId: 'ag-1-1',
    agentId: 'ag',
    agentName: 'Agent',
    toolLabel: 'local',
    actionType: 'intent',
    preview: 'p',
    destinationHost: '',
    command: '',
    safetyLevel: '',
    safetyReason: '',
    payloadPath: '',
    intentMode: 'closepaw',
    intentTarget: '',
    intentShareText: 'open Chrome and search the weather in Tokyo',
    dmPairingId: '',
    dmPairingLabel: '',
    dmReplyText: '',
    resultPath: '/x/result.txt',
    ts: '2026-10-13T00:00:00.000Z',
    expiresAt: 10_000,
    nonce: 'nonce-1',
    ...over,
  });

  it('binds the exact goal text and mode', () => {
    const c = canonicalRequest(base());
    expect(canonicalRequest(base({ intentShareText: 'open Chrome and search the weather in Osaka' }))).not.toBe(c);
    expect(canonicalRequest(base({ intentShareText: 'open Chrome and search the weather in Tokyo ' }))).not.toBe(c);
    expect(canonicalRequest(base({ intentMode: 'share' }))).not.toBe(c);
    expect(canonicalRequest(base())).toBe(c);
  });

  it('rejects a signed approval once the goal is changed after signing', () => {
    const { signer, verifier, hasher, keySha } = makeFakeCrypto();
    const req = buildApprovalRequest(base(), hasher);
    const reply = signApprovalReply(req, 'accept', { signer, clock: new FakeClock(1000) });
    const deps = {
      verifier,
      clock: new FakeClock(2000),
      hasher,
      expectedKeySha256: keySha,
      allowedSigAlgs: ['FAKE-SHA256'],
    };
    expect(verifyApprovalReply(req, reply, { ...deps, nonceStore: new InMemoryNonceStore() }).ok).toBe(true);
    const tampered = buildApprovalRequest(base({ intentShareText: 'delete all my photos' }), hasher);
    const res = verifyApprovalReply(tampered, reply, { ...deps, nonceStore: new InMemoryNonceStore() });
    expect(res.ok).toBe(false);
  });
});

describe('ClosePaw plan-spec validation', () => {
  it('accepts a closepaw intent with a goal', () => {
    expect(validatePlanIntentAction({ intentMode: 'closepaw', intentShareText: 'open Chrome' })).toBeNull();
    expect(validatePlanIntentAction({ intentMode: 'closepaw', intentShareText: '{{result}}' })).toBeNull();
  });

  it('refuses an empty / whitespace / control-only goal', () => {
    expect(validatePlanIntentAction({ intentMode: 'closepaw', intentShareText: '' })).toMatch(/goal is empty/);
    expect(validatePlanIntentAction({ intentMode: 'closepaw', intentShareText: ' \n\t ' })).toMatch(/goal is empty/);
  });

  it('refuses an unknown mode and tolerates legacy launch/share', () => {
    expect(validatePlanIntentAction({ intentMode: 'nuke' as never })).toMatch(/mode is invalid/);
    expect(validatePlanIntentAction({ intentMode: 'launch', intentTarget: 'com.android.chrome' })).toBeNull();
    expect(validatePlanIntentAction({ intentMode: 'share', intentShareText: 'x' })).toBeNull();
  });
});

describe('ClosePaw natural-language registration', () => {
  it('extracts an English goal after "have ClosePaw"', () => {
    expect(detectClosePawGoal('every morning at 8, have ClosePaw open Chrome and search the weather in Tokyo.')).toBe(
      'open Chrome and search the weather in Tokyo',
    );
    expect(detectClosePawGoal('then ask ClosePaw to open Chrome')).toBe('open Chrome');
    expect(detectClosePawGoal('hand off to ClosePaw: open Chrome')).toBe('open Chrome');
  });

  it('extracts a Japanese goal after 「ClosePawで」', () => {
    expect(detectClosePawGoal('毎朝8時にClosePawでChromeを開いて東京の天気を検索して。')).toBe(
      'Chromeを開いて東京の天気を検索して',
    );
    expect(detectClosePawGoal('ClosePawに頼んで、設定アプリを開いて')).toBe('設定アプリを開いて');
  });

  it('never infers ClosePaw without the name', () => {
    expect(detectClosePawGoal('毎朝Chromeを開いて東京の天気を検索して')).toBeNull();
    expect(detectAction('毎朝Chromeを開いて天気を調べて通知して').type).toBe('notify');
  });

  it('maps to an intent/closepaw action, falling back to {{result}} when no goal is split off', () => {
    expect(detectAction('ClosePawで東京の天気を検索して')).toEqual({
      type: 'intent',
      intentMode: 'closepaw',
      intentShareText: '東京の天気を検索して',
    });
    expect(detectAction('use closepaw')).toEqual({ type: 'intent', intentMode: 'closepaw', intentShareText: '{{result}}' });
  });

  it('parseAgentNL produces the closepaw action for a full utterance', () => {
    const d = parseAgentNL('今すぐClosePawでChromeを開いて東京の天気を検索して');
    expect(d.action).toEqual({
      type: 'intent',
      intentMode: 'closepaw',
      intentShareText: 'Chromeを開いて東京の天気を検索して',
    });
  });
});

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'closepaw-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

describe('generateRunScript — ClosePaw hand-off', () => {
  const agent: Agent = {
    id: 't',
    name: 'T',
    description: '',
    prompt: 'hi',
    schedule: null,
    tool: { type: 'local' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: { type: 'intent', intentMode: 'closepaw', intentShareText: 'open Chrome and search the weather in Tokyo' },
  };
  const s = generateRunScript(agent);

  it('threads the closepaw mode and goal through', () => {
    expect(s).toContain("ACTION_INTENT_MODE='closepaw'");
    expect(s).toContain("ACTION_INTENT_SHARE_TEXT='open Chrome and search the weather in Tokyo'");
    expect(s).toContain('[ "$ACTION_INTENT_MODE" != "closepaw" ]');
  });

  it('never auto-accepts a closepaw request', () => {
    expect(s).toContain('{ [ "$approval_type" != "intent" ] || [ "$ACTION_INTENT_MODE" != "closepaw" ]; }');
  });

  it('ends a delivered hand-off as handed off (run-log handoff field + no-result preview)', () => {
    expect(s).toContain('ACTION_DISPATCH_HANDOFF="closepaw"');
    expect(s).toContain('Handed off to ClosePaw (no result is returned)');
    expect(s).toContain('HANDOFF_FIELDS=",\\"handoff\\":\\"closepaw\\""');
    expect(s).toContain('$SAVED_PATH_FIELDS$HANDOFF_FIELDS');
  });

  it('still parses as bash', () => {
    bashParses(s);
  });
});
