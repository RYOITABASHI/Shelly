/**
 * `shelly agent add|show|confirm|reject|list` (2026-10-14): register Shelly
 * agents by asking ChatGPT (Codex remote control in a Shelly tab).
 *
 * Covers: the wire format / validation spec (lib/agent-add-queue.ts), the RN
 * drain, the approval bindings (lib/agent-add-approval.ts: draft-hash
 * binding, text confirm with the definition-hash prefix, the Settings toggle,
 * expiry, attempt cap, rate limit, single use, risk tier, notification
 * nonces), the confirm-requirement override, the generated shim (extracted
 * from HomeInitializer.kt and run against a temp $HOME with a simulated app),
 * and static invariants (no direct agent-json write, no nonce in any
 * shell-readable output, native notification requires unlock + private
 * visibility, audit notification + Disable after a ChatGPT approval).
 */
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  tFor: (locale: string, key: string) => `${locale}:${key}`,
}));
jest.mock('expo-notifications', () => ({ scheduleNotificationAsync: jest.fn() }));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  AGENT_ADD_MAX_AGE_MS,
  AGENT_ADD_MIN_INTERVAL_MS,
  AGENT_ADD_MSG_SENT,
  __resetTerminalAgentRequestMarkerForTests,
  agentAddResultFileName,
  agentAddSummaryFileName,
  agentCtlResultFileName,
  buildAgentAddPrompt,
  createAgentAddDrainState,
  drainAgentAddRequests,
  encodeAgentAddLine,
  isTerminalAgentRequestActive,
  markTerminalAgentRequest,
  parseAgentAddLine,
  parseAgentCtlLine,
  sanitizeAgentAddText,
  type AgentAddDrainDeps,
  type AgentAddResult,
} from '@/lib/agent-add-queue';
import {
  AGENT_ADD_APPROVAL_TTL_MS,
  AGENT_ADD_MAX_CONFIRM_ATTEMPTS,
  __resetAgentAddBindingsForTests,
  __setAgentAddCryptoForTests,
  assessAgentDraftRisk,
  buildAgentAddSummary,
  createAgentAddBinding,
  draftHashPrefix,
  isDraftStillBound,
  verifyAgentAddNotificationDecision,
  verifyAgentAddTextConfirm,
} from '@/lib/agent-add-approval';
import { resolveRegistrationConfirmRequirement } from '@/lib/widget-agent-registration';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const ktPath = path.join(
  root,
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);
const NOW = 1_760_000_000_000;
const REQ = `${NOW}-0123abcd`;

beforeAll(() => {
  __setAgentAddCryptoForTests({
    sha256Hex: async (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  });
});
beforeEach(() => {
  __resetAgentAddBindingsForTests();
  __resetTerminalAgentRequestMarkerForTests();
});

// ── Wire format ────────────────────────────────────────────────────────────

describe('parseAgentAddLine', () => {
  it('round-trips and sanitizes control / bidi characters', () => {
    const line = encodeAgentAddLine(REQ, NOW, '毎朝8時に\nAIニュースを\u202Eまとめて');
    expect(parseAgentAddLine(line, NOW + 1000)).toEqual({
      ok: true,
      reqId: REQ,
      tsMs: NOW,
      text: '毎朝8時に AIニュースを まとめて',
    });
  });

  it('expires after 10 minutes and rejects far-future timestamps', () => {
    const line = encodeAgentAddLine(REQ, NOW, 'x');
    expect(parseAgentAddLine(line, NOW + AGENT_ADD_MAX_AGE_MS + 1)).toMatchObject({ ok: false, reason: 'stale' });
    expect(parseAgentAddLine(line, NOW - 60_000)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('only accepts NEW-agent requests (no run/stop/delete/edit/@/slash)', () => {
    for (const t of ['run news', 'Stop news', 'delete all', 'edit x', 'list', 'status', 'history x', '@agent run x', '/x']) {
      expect(parseAgentAddLine(encodeAgentAddLine(REQ, NOW, t), NOW)).toMatchObject({ ok: false, reason: 'reserved' });
    }
    expect(parseAgentAddLine(encodeAgentAddLine(REQ, NOW, ' \n '), NOW)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects malformed lines and path-unsafe ids', () => {
    expect(parseAgentAddLine('agentadd:../x:1:a', NOW)).toMatchObject({ ok: false, reqId: null });
    expect(parseAgentAddLine(`agentadd:${REQ}:${NOW}:a:b`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseAgentAddLine(`agentadd:${REQ}:${NOW}:%E0%A4%A`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseAgentAddLine(`agentadd:${REQ}:${NOW}:${'a'.repeat(30_000)}`, NOW)).toMatchObject({ ok: false });
    expect(() => agentAddResultFileName('../evil')).toThrow();
  });

  it('caps by code points', () => {
    expect(Array.from(sanitizeAgentAddText('あ'.repeat(2500))).length).toBe(2000);
  });

  it('builds the same `@agent` input a user would type', () => {
    expect(buildAgentAddPrompt('毎朝8時にニュース')).toBe('@agent 毎朝8時にニュース');
  });

  it('parses control requests strictly (confirm needs the 8-hex definition hash)', () => {
    const ctl = `${NOW}-89abcdef`;
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:confirm:${REQ}:0a1b2c3d`, NOW)).toEqual({ ctlId: ctl, op: 'confirm', reqId: REQ, hashPrefix: '0a1b2c3d' });
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:reject:${REQ}`, NOW)).toEqual({ ctlId: ctl, op: 'reject', reqId: REQ });
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:confirm:${REQ}`, NOW)).toBeNull();
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:confirm:${REQ}:K7QX9M`, NOW)).toBeNull();
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW}:approve:${REQ}:0a1b2c3d`, NOW)).toBeNull();
    expect(parseAgentCtlLine(`agentctl:${ctl}:${NOW - 120_000}:reject:${REQ}`, NOW)).toBeNull();
  });
});

// ── Confirm requirement ────────────────────────────────────────────────────

describe('terminal requests are always confirm-gated', () => {
  it('ignores agentRegistrationRequireConfirm=false and the widget opt-in', () => {
    expect(
      resolveRegistrationConfirmRequirement(
        { agentRegistrationRequireConfirm: false, widgetAgentRegistrationNoConfirm: true },
        'terminal-request',
      ),
    ).toBe(true);
  });

  it('confirm-gates follow-up turns per conversation only (no global window)', () => {
    expect(isTerminalAgentRequestActive('pane-1', NOW)).toBe(false);
    markTerminalAgentRequest('pane-1', NOW);
    expect(isTerminalAgentRequestActive('pane-1', NOW + 60_000)).toBe(true);
    expect(isTerminalAgentRequestActive('pane-2', NOW + 60_000)).toBe(false);
    expect(isTerminalAgentRequestActive('pane-1', NOW + 31 * 60_000)).toBe(false);
  });

  it('binding/summary follow the draft\'s OWN request id, never a global "last request" (hijack fix)', () => {
    const src = read('hooks/use-ai-pane-dispatch.ts');
    // The window only tightens confirm-gating…
    expect(src).toMatch(/terminalRequestId \|\| dispatchOpts\?\.source === 'terminal-request' \|\| isTerminalAgentRequestActive\(paneId\)/);
    // …binding happens only for a draft stamped with its own id…
    expect(src).toMatch(/\} else if \(terminalRequestId\) \{/);
    expect(src).toContain('reqId: terminalRequestId,');
    // …and only a terminal-sourced dispatch stamps the id.
    expect(src).toMatch(/if \(dispatchOpts\?\.source === 'terminal-request' && isAgentAddRequestId\(dispatchOpts\.requestId\)\) \{\s*draft\.terminalRequestId = dispatchOpts\.requestId;/);
    const flow = read('lib/agent-add-flow.ts');
    expect(flow).toContain('params.draft.terminalRequestId !== reqId) return;');
    expect(flow).not.toContain('getActiveTerminalAgentRequestId');
    expect(flow).not.toContain('finalized.delete(');
    expect(read('lib/agent-add-queue.ts')).not.toMatch(/let lastTerminalAgentRequest/);
  });
});

// ── RN drain ───────────────────────────────────────────────────────────────

function makeFs(files: Record<string, string>) {
  const results: Record<string, AgentAddResult> = {};
  const ctlResults: Record<string, AgentAddResult> = {};
  const handOffs: Array<{ prompt: string; reqId: string }> = [];
  let active = true;
  let canAccept = true;
  let now = NOW + 1000;
  const deps: AgentAddDrainDeps = {
    isActive: () => active,
    canAcceptPrompt: () => canAccept,
    listHome: async () => Object.keys(files),
    move: async (from, to) => {
      if (!(from in files)) return false;
      files[to] = files[from];
      delete files[from];
      return true;
    },
    read: async (n) => files[n] ?? null,
    remove: async (n) => {
      delete files[n];
    },
    writeResult: async (reqId, r) => {
      results[reqId] = r;
    },
    handOff: (prompt, reqId) => {
      handOffs.push({ prompt, reqId });
      return true;
    },
    handleCtl: async (ctl) => ({ ok: true, code: 'sent', message: `handled ${ctl.op}` }),
    writeCtlResult: async (id, r) => {
      ctlResults[id] = r;
    },
    now: () => now,
  };
  return {
    deps,
    files,
    results,
    ctlResults,
    handOffs,
    setActive: (v: boolean) => (active = v),
    setCanAccept: (v: boolean) => (canAccept = v),
    advance: (ms: number) => (now += ms),
  };
}

describe('drainAgentAddRequests', () => {
  it('does nothing while Shelly is not active', async () => {
    const env = makeFs({ [`.shelly-agent-req-${REQ}`]: encodeAgentAddLine(REQ, NOW, 'x news') + '\n' });
    env.setActive(false);
    expect(await drainAgentAddRequests(env.deps, createAgentAddDrainState())).toBe(0);
    expect(Object.keys(env.files)).toEqual([`.shelly-agent-req-${REQ}`]);
  });

  it('claims a request, seeds `@agent <text>` and answers the shim with "sent"', async () => {
    const env = makeFs({ [`.shelly-agent-req-${REQ}`]: encodeAgentAddLine(REQ, NOW, '毎朝AIニュース') + '\n' });
    expect(await drainAgentAddRequests(env.deps, createAgentAddDrainState())).toBe(1);
    expect(env.handOffs).toEqual([{ prompt: '@agent 毎朝AIニュース', reqId: REQ }]);
    expect(env.results[REQ]).toEqual({ ok: true, code: 'sent', message: AGENT_ADD_MSG_SENT });
    expect(Object.keys(env.files)).toEqual([]);
  });

  it('picks up native-parked pending requests without answering the shim again', async () => {
    const env = makeFs({ [`.shelly-agent-pending-${REQ}`]: encodeAgentAddLine(REQ, NOW, 'daily brief') + '\n' });
    await drainAgentAddRequests(env.deps, createAgentAddDrainState());
    expect(env.handOffs).toHaveLength(1);
    expect(env.results[REQ]).toBeUndefined();
  });

  it('hands off at most one per interval and waits while the prompt slot is busy', async () => {
    const r2 = `${NOW + 1}-0123abce`;
    const env = makeFs({
      [`.shelly-agent-req-${REQ}`]: encodeAgentAddLine(REQ, NOW, 'a news') + '\n',
      [`.shelly-agent-req-${r2}`]: encodeAgentAddLine(r2, NOW + 1, 'b news') + '\n',
    });
    const state = createAgentAddDrainState();
    await drainAgentAddRequests(env.deps, state);
    await drainAgentAddRequests(env.deps, state);
    expect(env.handOffs).toHaveLength(1);
    env.advance(AGENT_ADD_MIN_INTERVAL_MS);
    env.setCanAccept(false);
    await drainAgentAddRequests(env.deps, state);
    expect(env.handOffs).toHaveLength(1);
    env.setCanAccept(true);
    await drainAgentAddRequests(env.deps, state);
    expect(env.handOffs.map((h) => h.reqId)).toEqual([REQ, r2]);
  });

  it('rejects reserved / malformed requests with a result and never hands them off', async () => {
    const env = makeFs({ [`.shelly-agent-req-${REQ}`]: encodeAgentAddLine(REQ, NOW, 'delete everything') + '\n' });
    await drainAgentAddRequests(env.deps, createAgentAddDrainState());
    expect(env.handOffs).toEqual([]);
    expect(env.results[REQ]).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('drops expired requests', async () => {
    const env = makeFs({ [`.shelly-agent-req-${REQ}`]: encodeAgentAddLine(REQ, NOW, 'x news') + '\n' });
    env.advance(AGENT_ADD_MAX_AGE_MS + 1);
    await drainAgentAddRequests(env.deps, createAgentAddDrainState());
    expect(env.handOffs).toEqual([]);
    expect(env.results[REQ]).toMatchObject({ ok: false, code: 'stale' });
  });

  it('processes control requests and answers them', async () => {
    const ctl = `${NOW}-89abcdef`;
    const env = makeFs({ [`.shelly-agent-ctl-${ctl}`]: `agentctl:${ctl}:${NOW}:reject:${REQ}\n` });
    await drainAgentAddRequests(env.deps, createAgentAddDrainState());
    expect(env.ctlResults[ctl]).toEqual({ ok: true, code: 'sent', message: 'handled reject' });
    expect(Object.keys(env.files)).toEqual([]);
  });
});

// ── Approval bindings ──────────────────────────────────────────────────────

const lowRisk = {
  name: 'AI news brief',
  prompt: 'Research AI news and summarize it into a briefing',
  schedule: '0 8 * * *',
  action: { type: 'draft' },
};
const closePawDraft = {
  ...lowRisk,
  action: { type: 'intent', intentMode: 'closepaw', intentShareText: 'LINEを開いて自分に送って（内容: {{result}}）' },
  closePawRouting: { clause: 'LINEを開いて自分に送って', app: 'LINE', routed: true },
};

async function bind(draft: Record<string, unknown> = lowRisk, fireable = true, now = NOW) {
  const b = await createAgentAddBinding({ reqId: REQ, conversationKey: 'pane-1', messageId: 'm1', draft, fireable, now });
  if (!b) throw new Error('binding refused');
  return b;
}

describe('rebinding / hijack protection', () => {
  it('never rebinds a decided request (no revival of consumed bindings)', async () => {
    const b = await bind();
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + 1000 })).toMatchObject({ ok: true });
    await expect(
      createAgentAddBinding({ reqId: REQ, conversationKey: 'pane-1', messageId: 'm2', draft: { ...lowRisk, name: 'user private' }, fireable: true, now: NOW + 2000 }),
    ).resolves.toBeNull();
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + 9000 })).toMatchObject({ reason: 'used' });
  });

  it('expiry counts from the request timestamp, not from (re)binding', async () => {
    await expect(
      createAgentAddBinding({ reqId: REQ, conversationKey: 'pane-1', messageId: 'm1', draft: lowRisk, fireable: true, now: NOW + AGENT_ADD_APPROVAL_TTL_MS + 1 }),
    ).resolves.toBeNull();
    const b = await bind(lowRisk, true, NOW + 9 * 60_000);
    expect(b.expiresAt).toBe(NOW + AGENT_ADD_APPROVAL_TTL_MS);
  });

  it('refuses a finalized request and keeps the attempt counter on refresh', async () => {
    await expect(
      createAgentAddBinding({ reqId: REQ, conversationKey: 'pane-1', messageId: 'm1', draft: lowRisk, fireable: true, now: NOW, isFinalized: () => true }),
    ).resolves.toBeNull();
    const b = await bind();
    verifyAgentAddTextConfirm(REQ, '00000000' === draftHashPrefix(b) ? '11111111' : '00000000', { allowed: true, now: NOW + 3000 });
    const refreshed = await bind({ ...lowRisk, schedule: '0 9 * * *' }, true, NOW + 4000);
    expect(refreshed.confirmAttempts).toBe(1);
  });
});

describe('cold-start notification approve', () => {
  it('can verify without consuming, then consume once', async () => {
    const b = await bind();
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.approveNonce!, NOW + 1, { consume: false })).toMatchObject({ ok: true });
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.approveNonce!, NOW + 2, { consume: false })).toMatchObject({ ok: true });
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.approveNonce!, NOW + 3)).toMatchObject({ ok: true });
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.approveNonce!, NOW + 4)).toMatchObject({ reason: 'used' });
  });

  it('the deep-link handler waits for the pane + pending draft before consuming', () => {
    const flow = read('lib/agent-add-flow.ts');
    const i = flow.indexOf('export async function handleAgentAddDecisionDeepLink');
    const body = flow.slice(i, flow.indexOf('export async function handleAgentAddDisableDeepLink'));
    const peek = body.indexOf('{ consume: false }');
    const wait = body.indexOf('await waitFor(');
    const consume = body.indexOf('const final = verifyAgentAddNotificationDecision(reqId, decision, nonce);');
    expect(peek).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(peek);
    expect(consume).toBeGreaterThan(wait);
  });
});

describe('risk tier', () => {
  it('draft/notify and ClosePaw hand-offs are remotely approvable; everything else is review-in-Shelly', () => {
    expect(assessAgentDraftRisk(lowRisk)).toEqual([]);
    expect(assessAgentDraftRisk({ ...lowRisk, action: { type: 'notify' } })).toEqual([]);
    expect(assessAgentDraftRisk(closePawDraft)).toEqual([]);
    for (const type of ['social-post', 'webhook', 'cli', 'dm-reply', 'api-call', 'browser-pane', 'something-new']) {
      expect(assessAgentDraftRisk({ ...lowRisk, action: { type } })).toEqual([`action:${type}`]);
    }
    expect(assessAgentDraftRisk({ ...lowRisk, action: { type: 'intent', intentMode: 'launch' } })).toEqual(['action:intent']);
    expect(assessAgentDraftRisk({ ...lowRisk, action: null })).toEqual(['action:unknown']);
    expect(assessAgentDraftRisk({ ...lowRisk, actions: [{ type: 'draft' }, { type: 'social-post' }] })).toEqual(['action:social-post']);
    expect(assessAgentDraftRisk({ ...lowRisk, autonomous: true })).toEqual(['autonomous']);
    expect(assessAgentDraftRisk({ ...lowRisk, notificationTrigger: { packageNames: ['com.x'] } })).toEqual(['notification-trigger']);
    expect(assessAgentDraftRisk({ ...lowRisk, orchestrationSteps: ['a', { instruction: 'b', apiCall: { m: 1 } }] })).toEqual(['api-call-step']);
    expect(assessAgentDraftRisk({ ...lowRisk, tool: { type: 'cli', cli: 'codex' } })).toEqual(['tool:cli']);
    expect(assessAgentDraftRisk({ ...lowRisk, tool: { type: 'ab-article-eval' } })).toEqual(['tool:cli']);
    expect(assessAgentDraftRisk({ ...lowRisk, tool: { type: 'perplexity' } })).toEqual([]);
    expect(assessAgentDraftRisk({ ...lowRisk, orchestrationSteps: ['a', { instruction: 'b', tool: { type: 'local' } }] })).toEqual(['step-tool']);
    expect(assessAgentDraftRisk({ ...lowRisk, outputPath: '/sdcard/x' })).toEqual(['output-path']);
    expect(assessAgentDraftRisk({ ...lowRisk, matchedSkill: { id: 's' } })).toEqual(['skill']);
  });
});

describe('ChatGPT text confirm (`shelly agent confirm <requestId> <hash8>`)', () => {
  it('registers only with the hash prefix of the shown definition; single use', async () => {
    const b = await bind();
    const hash8 = draftHashPrefix(b);
    expect(hash8).toMatch(/^[0-9a-f]{8}$/);
    expect(verifyAgentAddTextConfirm(REQ, hash8.toUpperCase(), { allowed: true, now: NOW + 1000 })).toMatchObject({ ok: true });
    expect(verifyAgentAddTextConfirm(REQ, hash8, { allowed: true, now: NOW + 5000 })).toMatchObject({ ok: false, reason: 'used' });
  });

  it('is refused when the Settings toggle is OFF', async () => {
    const b = await bind();
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: false, now: NOW + 1000 })).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('a different definition hash is refused, rate-limited, and locks after the attempt cap', async () => {
    const b = await bind();
    const wrong = draftHashPrefix(b) === '00000000' ? '11111111' : '00000000';
    let t = NOW + 3000;
    for (let i = 1; i < AGENT_ADD_MAX_CONFIRM_ATTEMPTS; i++) {
      expect(verifyAgentAddTextConfirm(REQ, wrong, { allowed: true, now: t })).toMatchObject({ reason: 'hash-mismatch' });
      expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: t + 500 })).toMatchObject({ reason: 'rate-limited' });
      t += 3000;
    }
    expect(verifyAgentAddTextConfirm(REQ, wrong, { allowed: true, now: t })).toMatchObject({ reason: 'locked' });
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: t + 3000 })).toMatchObject({ reason: 'locked' });
  });

  it('expires after 10 minutes', async () => {
    const b = await bind();
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + AGENT_ADD_APPROVAL_TTL_MS + 1 })).toMatchObject({ reason: 'expired' });
  });

  it('refuses review-only plans and drafts without a fireable schedule; allows ClosePaw plans', async () => {
    let b = await bind({ ...lowRisk, action: { type: 'social-post' } });
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + 3000 })).toMatchObject({ reason: 'high-risk' });
    __resetAgentAddBindingsForTests();
    b = await bind(lowRisk, false);
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + 3000 })).toMatchObject({ reason: 'not-approvable' });
    __resetAgentAddBindingsForTests();
    b = await bind(closePawDraft);
    expect(verifyAgentAddTextConfirm(REQ, draftHashPrefix(b), { allowed: true, now: NOW + 3000 })).toMatchObject({ ok: true });
  });

  it('unknown request ids are refused', () => {
    expect(verifyAgentAddTextConfirm(REQ, '0a1b2c3d', { allowed: true, now: NOW })).toMatchObject({ reason: 'unknown' });
  });

  it('the ChatGPT-approval audit is never skipped (no exact agent id → notification without Disable)', () => {
    const flow = read('lib/agent-add-flow.ts');
    const i = flow.indexOf('async function postChatGptAudit');
    const body = flow.slice(i, flow.indexOf('export async function applyAgentAddDecision'));
    expect(body).toMatch(/if \(!agent\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*await TerminalEmulator\.postAgentAddAuditNotification\?\.\(\s*'',/);
    expect(body).toContain("'agents.terminal_request_audit_body_no_disable'");
    const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAddHandoff.kt');
    expect(kt).toContain('val withDisable = agentId.isNotEmpty() || disableNonce.isNotEmpty()');
    expect(kt).toContain('if (withDisable) "shelly:///ai" else "shelly:///agent-chat"');
    expect(kt).toContain('if (disableAction != null) builder.addAction(disableAction)');
  });

  it('`shelly agent reject` only consumes once the pane + pending draft are ready (cold start retry)', () => {
    const flow = read('lib/agent-add-flow.ts');
    const i = flow.indexOf("if (ctl.op === 'reject') {");
    const body = flow.slice(i, flow.indexOf('const allowed = useSettingsStore'));
    const wait = body.indexOf('await waitFor(');
    const consume = body.indexOf('consumeAgentAddBinding(ctl.reqId);');
    expect(wait).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(wait);
    expect(body).toContain('run the command again in a few seconds');
  });

  it('flow: setting gate, audit notification with Disable, plain chat record', () => {
    const flow = read('lib/agent-add-flow.ts');
    expect(flow).toContain("useSettingsStore.getState().settings.agentApproveFromChatGpt !== false");
    expect(flow).toMatch(/if \(via === 'chatgpt'\) await postChatGptAudit\(/);
    expect(flow).toContain('postAgentAddAuditNotification');
    expect(flow).toContain("'agents.terminal_request_approved_chatgpt'");
    expect(read('store/settings-store.ts')).toContain('agentApproveFromChatGpt: true,');
    expect(read('components/config/ConfigTUI.tsx')).toContain("key: 'agentApproveFromChatGpt'");
  });
});

describe('definition binding', () => {
  it('matches only the exact draft that was shown', async () => {
    const b = await bind();
    await expect(isDraftStillBound(b, { ...lowRisk })).resolves.toBe(true);
    await expect(isDraftStillBound(b, { action: { type: 'draft' }, schedule: '0 8 * * *', prompt: lowRisk.prompt, name: lowRisk.name })).resolves.toBe(true);
    await expect(isDraftStillBound(b, { ...lowRisk, schedule: '0 9 * * *' })).resolves.toBe(false);
    await expect(isDraftStillBound(b, { ...lowRisk, action: { type: 'social-post' } })).resolves.toBe(false);
    await expect(isDraftStillBound(b, null)).resolves.toBe(false);
  });
});

describe('notification decisions', () => {
  it('approve needs the approve nonce of an approvable binding; single use', async () => {
    const b = await bind();
    const approveNonce = b.approveNonce!;
    expect(approveNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.rejectNonce, NOW + 1)).toMatchObject({ ok: false, reason: 'bad-nonce' });
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', approveNonce, NOW + 1)).toMatchObject({ ok: true });
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', approveNonce, NOW + 2)).toMatchObject({ ok: false, reason: 'used' });
  });

  it('review-only bindings have no approve nonce but can be rejected', async () => {
    const b = await bind({ ...lowRisk, autonomous: true });
    expect(b.approveNonce).toBeNull();
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', 'x'.repeat(32), NOW + 1)).toMatchObject({ reason: 'not-approvable' });
    expect(verifyAgentAddNotificationDecision(REQ, 'reject', b.rejectNonce, NOW + 1)).toMatchObject({ ok: true });
  });

  it('expires', async () => {
    const b = await bind();
    expect(verifyAgentAddNotificationDecision(REQ, 'approve', b.approveNonce!, NOW + AGENT_ADD_APPROVAL_TTL_MS + 1)).toMatchObject({ reason: 'expired' });
  });
});

describe('shell-facing summary', () => {
  it('carries the definition hash prefix and the confirm instruction, never a nonce', async () => {
    const b = await bind();
    const summary = buildAgentAddSummary(b, lowRisk, 'Every day 08:00');
    const json = JSON.stringify(summary);
    expect(json).not.toContain(b.approveNonce!);
    expect(json).not.toContain(b.rejectNonce);
    expect(summary).toMatchObject({ requestId: REQ, name: 'AI news brief', approvableFromChat: true, highRisk: [], definitionHash: draftHashPrefix(b), closePaw: null });
    expect(summary.message).toContain(`shelly agent confirm ${REQ} ${draftHashPrefix(b)}`);
    expect(summary.message).toContain('Only if they approve');
  });

  it('ClosePaw step + trusted variant: not approvable from ChatGPT, summary says approve on the phone', async () => {
    const b = await bind(closePawDraft);
    const summary = buildAgentAddSummary(b, closePawDraft, '毎日 08:00', 'parsed', { textConfirmAllowed: false });
    expect(summary.approvableFromChat).toBe(false);
    expect(summary.message).toContain('Approve in the Shelly notification'.replace('Approve in', 'tap Approve in'));
    expect(summary.message).toContain('device unlock required');
    expect(summary.message).not.toContain('shelly agent confirm');
    // Non-ClosePaw drafts keep the ChatGPT text approval.
    const plain = buildAgentAddSummary(b, lowRisk, 'x', 'parsed', { textConfirmAllowed: true });
    expect(plain.approvableFromChat).toBe(true);
    const flow = read('lib/agent-add-flow.ts');
    const ctl = flow.slice(flow.indexOf('export async function handleAgentCtl'), flow.indexOf('export async function handleAgentAddDecisionDeepLink'));
    const refuse = ctl.indexOf('AGENT_CLOSEPAW_DEVICE_APPROVAL_MESSAGE');
    const verify = ctl.indexOf('verifyAgentAddTextConfirm(');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(verify); // refused before any attempt is counted or the request consumed
    expect(ctl).toContain('closePawStepText(pendingDraft as never) && (await closePawNeedsDeviceApproval())');
    // Fail-closed when the variant check is unavailable.
    expect(flow).toContain('if (!TerminalEmulator.isClosePawTrustedVariantInstalled) return true;');
  });

  it('a ChatGPT approval never seals a ClosePaw pre-approval', () => {
    const flow = read('lib/agent-add-flow.ts');
    expect(flow).toContain("if (agent && via !== 'chatgpt' && agentMatchesApprovedDraft(agent, draft)) {");
  });

  it('names the ClosePaw step explicitly', async () => {
    const b = await bind(closePawDraft);
    const summary = buildAgentAddSummary(b, closePawDraft, '毎日 08:00');
    expect(summary.closePaw).toBe('LINEを開いて自分に送って');
    expect(summary.actions).toEqual(['intent:closepaw']);
    expect(summary.approvableFromChat).toBe(true);
  });

  it('flags review-only plans', async () => {
    const b = await bind({ ...lowRisk, action: { type: 'social-post' } });
    const summary = buildAgentAddSummary(b, { ...lowRisk, action: { type: 'social-post' } }, 'x');
    expect(summary.approvableFromChat).toBe(false);
    expect(summary.highRisk).toEqual(['action:social-post']);
    expect(summary.message).toContain('cannot be approved from here');
  });

  it('nonces never reach logs; the deep links are handled before URL logging', () => {
    const flow = read('lib/agent-add-flow.ts');
    expect(flow).not.toMatch(/log(Info|Warn|Error)\([^)]*[Nn]once[^)]*\)/);
    const layout = read('app/_layout.tsx');
    const logAt = layout.indexOf('`received: ${url}');
    for (const target of ["target === 'agent-add-decision'", "target === 'agent-add-disable'"]) {
      expect(layout.indexOf(target)).toBeGreaterThan(0);
      expect(layout.indexOf(target)).toBeLessThan(logAt);
    }
    expect(fs.existsSync(path.join(root, 'app/agent-add-decision.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app/agent-add-disable.tsx'))).toBe(true);
  });
});

describe('native invariants', () => {
  const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAddHandoff.kt');
  it('Approve and Disable require device unlock; Approve only for approvable drafts on API 31+', () => {
    expect(kt.match(/setAuthenticationRequired\(true\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(kt).toMatch(/val canApprove = approvable && HEX_NONCE_RE\.matches\(approveNonce\) && Build\.VERSION\.SDK_INT >= 31/);
    expect(kt).toMatch(/if \(canApprove\) \{/);
    expect(kt).toContain('fun postAuditNotification(');
  });
  it('notifications are private with a title-only public version', () => {
    expect(kt.match(/setVisibility\(Notification\.VISIBILITY_PRIVATE\)/g)?.length).toBe(3);
    expect(kt.match(/setPublicVersion\(publicVersion\)/g)?.length).toBe(3);
  });
  it('never touches the agent definitions', () => {
    const code = kt
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\.shelly\/agents|File\([^)]*agents/);
  });
  it('is started next to the ClosePaw watcher', () => {
    expect(read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt')).toContain('AgentAddHandoff.ensureWatching(applicationContext)');
    expect(read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt')).toContain('AgentAddHandoff.ensureWatching(context)');
  });
});

// ── Generated shim ─────────────────────────────────────────────────────────

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    if (ch === '$' && /[A-Za-z{]/.test(lit[i + 1] ?? '')) throw new Error(`unescaped Kotlin template: ${lit}`);
    out += ch;
  }
  return out;
}

function extractShimJs(): string {
  const lines = fs.readFileSync(ktPath, 'utf8').split(/\r?\n/);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === "const fs = require('fs');") on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === 'SHELLY_HELPER_NODE') break;
    body.push(text);
  }
  return body.join('\n') + '\n';
}

describe('generated shim: shelly agent', () => {
  let tmp: string;
  let shimPath: string;
  let home: string;
  const shim = extractShimJs();
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-agent-'));
    shimPath = path.join(tmp, 'shim.js');
    fs.writeFileSync(shimPath, shim);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmp, 'home-'));
  });

  function run(args: string[], app?: (home: string) => void) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [shimPath, ...args], { env: { ...process.env, HOME: home } });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      const timer = app ? setInterval(() => app(home), 50) : null;
      child.on('close', (code) => {
        if (timer) clearInterval(timer);
        resolve({ code, out, err });
      });
    });
  }

  it('is shim v14+ with BASHRC_VERSION >= 260 and lists `agent` in the usage', () => {
    const kt = fs.readFileSync(ktPath, 'utf8');
    expect(kt).toContain('# SHELLY_HELPER_SHIM v17');
    expect(Number(kt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(260);
    expect(shim).toContain("console.log('  shelly agent <add|show|confirm|reject|list>');");
  });

  it('the agent branch never writes, renames or deletes under ~/.shelly/agents', () => {
    const block = shim.slice(shim.indexOf("if (args[0] === 'agent') {"), shim.indexOf("if (args[0] === 'workflow') {"));
    expect(block.length).toBeGreaterThan(100);
    const listPart = block.slice(block.indexOf("if (agentSub === 'list')"));
    expect(listPart).not.toMatch(/writeFileSync|renameSync|unlinkSync|rmSync|appendFileSync|mkdirSync/);
    expect(block).not.toMatch(/agentsDir[^\n]*(writeFileSync|renameSync|unlinkSync)/);
  });

  it('prints agent usage', async () => {
    const r = await run(['agent']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: shelly agent <add|show|confirm|reject|list>');
  });

  it('add: queues one request file, prints the ack and the parsed summary with the definition hash and ClosePaw step', async () => {
    let seen = '';
    const r = await run(['agent', 'add', '毎朝8時にAIニュースを調べてLINEを開いて自分に送って'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-req-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        seen = fs.readFileSync(path.join(h, n), 'utf8');
        fs.unlinkSync(path.join(h, n));
        const reqId = m[1];
        fs.writeFileSync(path.join(h, agentAddResultFileName(reqId)), JSON.stringify({ ok: true, code: 'sent', message: AGENT_ADD_MSG_SENT }));
        const summary = buildAgentAddSummary(
          { reqId, riskReasons: [], approvable: true, expiresAt: Date.now() + 600_000, fireable: true, draftHash: 'abcdef0123456789' },
          { ...closePawDraft, name: 'AIニュース', prompt: '毎朝AIニュースを調べて' },
          '毎日 08:00',
        );
        fs.writeFileSync(path.join(h, agentAddSummaryFileName(reqId)), JSON.stringify(summary));
      }
    });
    expect(r.code).toBe(0);
    expect(seen).toMatch(/^agentadd:[0-9]+-[0-9a-f]{8}:[0-9]+:[^:\n]+\n$/);
    expect(decodeURIComponent(seen.trim().split(':')[3])).toBe('毎朝8時にAIニュースを調べてLINEを開いて自分に送って');
    expect(r.out).toContain(AGENT_ADD_MSG_SENT);
    expect(r.out).toContain('Name: AIニュース');
    expect(r.out).toContain('Definition: abcdef01');
    expect(r.out).toContain('ClosePaw (operates the phone): LINEを開いて自分に送って');
    expect(r.out).toMatch(/shelly agent confirm [0-9]+-[0-9a-f]{8} abcdef01/);
    expect(fs.existsSync(path.join(home, '.shelly', 'agents'))).toBe(false);
  }, 30_000);

  it('add: background (native "notified") tells the user to open Shelly', async () => {
    const r = await run(['agent', 'add', 'daily summary'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-req-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        fs.renameSync(path.join(h, n), path.join(h, `.shelly-agent-pending-${m[1]}`));
        fs.writeFileSync(path.join(h, agentAddResultFileName(m[1])), JSON.stringify({ ok: true, code: 'notified', message: 'Shelly is in the background — tap the notification to confirm' }));
      }
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('tap the notification to confirm');
    expect(r.out).toMatch(/shelly agent show [0-9]+-[0-9a-f]{8}/);
  }, 30_000);

  it('add: refused requests exit 1 with the message', async () => {
    const r = await run(['agent', 'add', 'delete everything'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-req-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        fs.unlinkSync(path.join(h, n));
        fs.writeFileSync(path.join(h, agentAddResultFileName(m[1])), JSON.stringify({ ok: false, code: 'invalid', message: 'shelly agent add: only new-agent requests are accepted' }));
      }
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('only new-agent requests');
  }, 30_000);

  it('add: refuses when 5 requests are already waiting', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(home, `.shelly-agent-pending-${NOW + i}-0123abcd`), 'x\n');
    const r = await run(['agent', 'add', 'x news']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('too many agent requests');
  });

  it('confirm: relays the definition hash through a control file and prints the app answer', async () => {
    let ctlLine = '';
    const r = await run(['agent', 'confirm', REQ, 'ABCDEF01'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-ctl-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        ctlLine = fs.readFileSync(path.join(h, n), 'utf8');
        fs.unlinkSync(path.join(h, n));
        fs.writeFileSync(path.join(h, agentCtlResultFileName(m[1])), JSON.stringify({ ok: true, code: 'sent', message: 'Registered "AIニュース" in Shelly.' }));
      }
    });
    expect(r.code).toBe(0);
    expect(ctlLine).toMatch(new RegExp(`^agentctl:[0-9]+-[0-9a-f]{8}:[0-9]+:confirm:${REQ}:abcdef01\\n$`));
    expect(r.out).toContain('Registered');
  }, 30_000);

  it('confirm: refusal from the app (toggle off / review-only) exits 1', async () => {
    const r = await run(['agent', 'confirm', REQ, '0a1b2c3d'], (h) => {
      for (const n of fs.readdirSync(h)) {
        const m = /^\.shelly-agent-ctl-([0-9]+-[0-9a-f]{8})$/.exec(n);
        if (!m) continue;
        fs.unlinkSync(path.join(h, n));
        fs.writeFileSync(path.join(h, agentCtlResultFileName(m[1])), JSON.stringify({ ok: false, code: 'invalid', message: 'shelly agent confirm: approving agents from ChatGPT is turned off in Shelly' }));
      }
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('turned off');
  }, 30_000);

  it('confirm/reject validate their arguments', async () => {
    expect((await run(['agent', 'confirm', '../x', '0a1b2c3d'])).code).toBe(1);
    expect((await run(['agent', 'confirm', REQ])).code).toBe(1);
    expect((await run(['agent', 'confirm', REQ, 'K7QX9M'])).code).toBe(1);
    expect((await run(['agent', 'reject', REQ, 'extra'])).code).toBe(1);
  });

  it('list: read-only listing of valid, non-deleted agents (no prompts, no secrets)', async () => {
    const dir = path.join(home, '.shelly', 'agents');
    fs.mkdirSync(path.join(dir, '.deleted'), { recursive: true });
    const agent = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: `name-${id}`,
      prompt: 'SECRET-PROMPT-TEXT',
      description: '',
      schedule: '0 8 * * *',
      enabled: true,
      ...extra,
    });
    fs.writeFileSync(path.join(dir, 'a1.json'), JSON.stringify(agent('a1')));
    fs.writeFileSync(path.join(dir, 'a2.json'), JSON.stringify(agent('a2', { enabled: false, schedule: null, name: 'evil\u001b[31m' })));
    fs.writeFileSync(path.join(dir, 'a3.json'), JSON.stringify(agent('a3')));
    fs.writeFileSync(path.join(dir, '.deleted', 'a3'), '');
    fs.writeFileSync(path.join(dir, 'dm-pairings.json'), JSON.stringify([{ x: 1 }]));
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc');
    const before = fs.readdirSync(dir).sort();
    const r = await run(['agent', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('on   name-a1  [0 8 * * *]');
    expect(r.out).toContain('off  evil [31m  [manual]');
    expect(r.out).not.toContain('a3');
    expect(r.out).not.toContain('SECRET-PROMPT-TEXT');
    expect(r.out).not.toContain('\u001b');
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    const j = await run(['agent', 'list', '--json']);
    expect(JSON.parse(j.out).map((x: { id: string }) => x.id)).toEqual(['a1', 'a2']);
  });
});
