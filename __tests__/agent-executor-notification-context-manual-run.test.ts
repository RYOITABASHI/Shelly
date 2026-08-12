/**
 * Regression test for the 2026-08-12 on-device QA finding (docs/superpowers/
 * DEFERRED.md's "run結果の通知内容が指示と無関係" entry): a notification-
 * triggered agent run manually via `@agent run <name>` (lib/agent-manager.ts's
 * runAgentNow, driven by hooks/use-ai-pane-dispatch.ts's runAgentShellCommand)
 * NEVER has SHELLY_NOTIFICATION_TEXT set — that env var is only ever exported
 * by AgentRuntime.kt's native runAgent() on a genuine notification fire, a
 * path the attended chat-driven run never goes through. Before the v57 fix,
 * that meant the model received the agent's still-trigger-worded prompt
 * (e.g. "Gmailの通知が来たら要約して通知して" — lib/agent-nl-parser.ts's
 * derivePrompt only strips SCHEDULE clauses, never notification-trigger
 * clauses) with NOTIFICATION_CONTEXT left completely empty: no notification
 * content, and no acknowledgement that none was available. On-device QA
 * observed a small local model asked to "summarize" nothing produce a short,
 * off-topic hallucinated reply.
 *
 * Fix (lib/agent-executor.ts v57 / AgentRuntime.kt CURRENT_SCRIPT_VERSION 57):
 * generateRunScript() now bakes AGENT_HAS_NOTIFICATION_TRIGGER at generate
 * time, and the NOTIFICATION_CONTEXT assembly gained an `elif` branch that
 * tells the model plainly that no real notification arrived this run instead
 * of leaving the context empty.
 *
 * This test verifies both halves: (1) generateRunScript() bakes the new flag
 * correctly per agent shape, and (2) the REAL emitted NOTIFICATION_CONTEXT
 * bash block (extracted verbatim, same convention as
 * agent-executor-runlog-savedpath-json.test.ts) produces the right context
 * string for all three cases — genuine notification fire, manual run of a
 * notification-triggered agent, and manual run of an ordinary agent (must
 * stay byte-identical to pre-fix behavior: empty).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent } from '@/store/types';

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'notif-context-test',
    name: 'Notification context test',
    description: '',
    prompt: 'Gmailの通知が来たら要約して通知して',
    schedule: null,
    tool: { type: 'local' },
    action: { type: 'notify' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  } as Agent;
}

/** Extract the real "NOTIFICATION_CONTEXT=..." if/elif/fi block, verbatim,
 *  from generateRunScript()'s output — same marker-slicing convention as
 *  agent-executor-runlog-savedpath-json.test.ts's extraction helpers. */
function extractNotificationContextBlock(script: string): string {
  const start = script.indexOf('NOTIFICATION_CONTEXT=""');
  if (start === -1) throw new Error('NOTIFICATION_CONTEXT="" not found in generated script');
  const end = script.indexOf('\nLOCAL_CONTEXT_FILE=', start);
  if (end === -1) throw new Error('LOCAL_CONTEXT_FILE marker (end of NOTIFICATION_CONTEXT block) not found');
  return script.slice(start, end);
}

function runNotificationContextBlock(env: {
  agentHasNotificationTrigger: '0' | '1';
  notificationText?: string;
  notificationPackage?: string;
}): string {
  const script = generateRunScript(baseAgent());
  const block = extractNotificationContextBlock(script);
  const wrapper = `set -e
AGENT_HAS_NOTIFICATION_TRIGGER='${env.agentHasNotificationTrigger}'
${env.notificationText !== undefined ? `SHELLY_NOTIFICATION_TEXT='${env.notificationText.replace(/'/g, "'\\''")}'` : ''}
${env.notificationPackage !== undefined ? `SHELLY_NOTIFICATION_PACKAGE='${env.notificationPackage.replace(/'/g, "'\\''")}'` : ''}
${block}
printf '%s' "$NOTIFICATION_CONTEXT"
`;
  return execFileSync('bash', ['-c', wrapper], { encoding: 'utf8' });
}

describe('generateRunScript() bakes AGENT_HAS_NOTIFICATION_TRIGGER per agent shape', () => {
  it('bakes 1 for an agent with a notificationTrigger', () => {
    const script = generateRunScript(
      baseAgent({ notificationTrigger: { packageNames: ['com.google.android.gm'] } }),
    );
    expect(script).toContain('AGENT_HAS_NOTIFICATION_TRIGGER=1');
  });

  it('bakes 0 for an ordinary agent with no notificationTrigger', () => {
    const script = generateRunScript(baseAgent({ notificationTrigger: null }));
    expect(script).toContain('AGENT_HAS_NOTIFICATION_TRIGGER=0');
  });
});

describe('NOTIFICATION_CONTEXT block (bug: manual run of a notification-triggered agent sent an empty, ungrounded context)', () => {
  it('a genuine notification fire still produces the real triggering-notification context, regardless of the trigger flag', () => {
    const out = runNotificationContextBlock({
      agentHasNotificationTrigger: '1',
      notificationText: 'New email from Boss: 明日の会議は10時からです',
      notificationPackage: 'com.google.android.gm',
    });
    expect(out).toContain('Triggering notification');
    expect(out).toContain('com.google.android.gm');
    expect(out).toContain('明日の会議は10時からです');
    // Must not ALSO fall into the "no real notification" fallback text.
    expect(out).not.toContain('no real notification');
  });

  it('a manual run of a notification-triggered agent (no real SHELLY_NOTIFICATION_TEXT) gets the honest no-notification context, not an empty one', () => {
    const out = runNotificationContextBlock({ agentHasNotificationTrigger: '1' });
    expect(out).toContain('No real notification is available for this run');
    expect(out).toContain('Do NOT invent or fabricate notification content');
    // The bug-report symptom class this guards against: the model must be
    // told the real situation, not left to fabricate something like a
    // random file-path fragment out of an empty context.
    expect(out.length).toBeGreaterThan(0);
  });

  it('a manual run of an ORDINARY (non-notification-triggered) agent stays byte-identical to pre-fix behavior: empty context', () => {
    const out = runNotificationContextBlock({ agentHasNotificationTrigger: '0' });
    expect(out).toBe('');
  });
});
