/**
 * Follow-up item 6 (2026-10-15, on-device): for an in-app-only (high-risk)
 * `shelly agent add` draft the user tapped Approve on a notification, nothing
 * visible happened and the scheduled time was missed. Approve is never offered
 * for such drafts, the notification says to open Shelly, and every approval
 * that cannot be applied is surfaced (chat note + visible notification).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildAgentAddSummary } from '@/lib/agent-add-approval';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('in-app-only drafts never fail silently', () => {
  const flow = read('lib/agent-add-flow.ts');
  const handler = flow.slice(
    flow.indexOf('export async function handleAgentAddDecisionDeepLink'),
    flow.indexOf('async function surfaceDecisionProblem'),
  );

  it('every early return / failure in the notification decision handler surfaces the problem', () => {
    const returns = handler.split('\n').filter((l) => /^\s+return;\s*$/.test(l)).length;
    // (The malformed-link `if (!reqId || !decision) return;` is not a user decision.)
    const surfaced = (handler.match(/await surfaceDecisionProblem\(/g) ?? []).length;
    expect(returns).toBe(3);
    expect(surfaced).toBe(4);
    expect(handler).toContain("check.reason === 'not-approvable' ? 'review_only' : 'refused'");
    expect(handler).toContain("if (!result.ok) await surfaceDecisionProblem(reqId, decision, 'failed');");
  });

  it('a stale reject gets reject wording, never "not registered yet, confirm in Shelly"', () => {
    const fn = flow.slice(flow.indexOf('async function surfaceDecisionProblem'));
    expect(fn).toContain("decision === 'reject' ? 'agents.terminal_request_decision_reject_failed'");
    expect(fn).toContain("decision === 'reject' ? 'agents.terminal_request_decision_reject_title'");
  });

  it('the problem is posted as a chat note AND a visible notification', () => {
    const fn = flow.slice(flow.indexOf('async function surfaceDecisionProblem'));
    expect(fn).toContain('postNote(b.conversationKey');
    expect(fn).toContain('scheduleNotificationAsync');
  });

  it('a non-approvable draft notification says to open Shelly (native posts no Approve for it)', () => {
    expect(flow).toContain("if (!binding.approvable) body.push(tFor(locale, 'agents.terminal_request_notif_confirm_in_shelly'));");
    const kt = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAddHandoff.kt');
    expect(kt).toContain('val canApprove = approvable && HEX_NONCE_RE.matches(approveNonce)');
    expect(kt).toMatch(/if \(canApprove\) \{\s+val approve = viewIntent/);
  });

  it('en/ja strings exist for every surfaced outcome', () => {
    for (const locale of ['en', 'ja']) {
      const src = read(`lib/i18n/locales/${locale}.ts`);
      for (const key of [
        'agents.terminal_request_notif_confirm_in_shelly',
        'agents.terminal_request_decision_title',
        'agents.terminal_request_decision_review_only',
        'agents.terminal_request_decision_refused',
        'agents.terminal_request_decision_not_ready',
        'agents.terminal_request_decision_failed',
        'agents.terminal_request_decision_reject_title',
        'agents.terminal_request_decision_reject_failed',
      ]) {
        expect(src).toContain(`'${key}':`);
      }
    }
  });

  it('the ChatGPT summary for an in-app-only draft says to confirm in Shelly', () => {
    const base = { reqId: '1760500000000-abcdef12', expiresAt: 0, fireable: true, draftHash: 'c'.repeat(64) };
    const risky = buildAgentAddSummary({ ...base, riskReasons: ['autonomous'], approvable: false }, { name: 'x', action: { type: 'draft' } }, 'daily');
    expect(risky.message).toContain('open Shelly and confirm');
    expect(risky.approvableFromChat).toBe(false);
    const noSchedule = buildAgentAddSummary({ ...base, riskReasons: [], approvable: false, fireable: false }, { name: 'x', action: { type: 'draft' } }, 'not set');
    expect(noSchedule.message).toContain('open Shelly and confirm');
  });
});
