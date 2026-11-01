/**
 * "承認なしで実行" on-device findings, build 2743:
 *  1) a pure read using `2>/dev/null`, `2>&1`, `{ …; }` grouping and
 *     `find . -path ./.git -prune` was refused as `protected-path`;
 *  2) the phrase itself leaked into the derived name, prompt and last step.
 */
import {
  analyzeEscalationCommand,
  escalationAutoApprovable,
  stripRunWithoutApprovalPhrases,
} from '@/lib/agent-run-without-approval';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';
import { parseAgentNL } from '@/lib/agent-nl-parser';

const HOME = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_PATHS = [HOME, '/data/data/dev.shelly.terminal/files/home'];
const WS = `${HOME}/projects/app`;
const on = { enabled: true, trustedWorkspaceRoot: '~/projects/app', homePaths: HOME_PATHS };
const gate = (command: string) => {
  const v = classifyProposedCommand(command, { workspaceRoot: WS, level: 'L1' });
  return { command, signals: v.signals, reason: v.reason, workspaceRoot: WS, cwd: WS };
};
/** What the device filed: a boundary gray with both signals. */
const filed = (command: string) => ({
  command, signals: ['leaves-root', 'write-or-exec'], reason: 'boundary: leaves-root, write-or-exec', workspaceRoot: WS, cwd: WS,
});

const DEVICE_CMD = 'cd ~/demo 2>/dev/null && { git log --oneline -n 20 2>&1; echo ---; find . -path ./.git -prune -o -type f -print | head -100; } || echo "~/demo not found"';

describe('pure read with /dev/null, fd dups, brace groups and a find .git prune', () => {
  it('auto-approves the exact on-device command (as filed, via the real gate, and as bash -lc)', () => {
    expect(analyzeEscalationCommand(DEVICE_CMD)).toEqual({ kind: 'read' });
    expect(escalationAutoApprovable(filed(DEVICE_CMD), on)).toEqual({ ok: true, kind: 'read' });
    const real = gate(DEVICE_CMD);
    expect(real.reason).toMatch(/^boundary: /);
    expect(escalationAutoApprovable(real, on)).toEqual({ ok: true, kind: 'read' });
    const wrapped = `bash -lc '${DEVICE_CMD.replace(/'/g, `'\\''`)}'`;
    expect(escalationAutoApprovable(filed(wrapped), on)).toEqual({ ok: true, kind: 'read' });
  });

  it('accepts the other harmless stderr plumbing spellings', () => {
    for (const c of [
      'ls ~/demo >/dev/null 2>&1',
      'cat ~/demo/a 2> /dev/null',
      'git -C ~/demo status &>/dev/null',
      'ls ~/demo 2>>/dev/null',
      'grep -r foo ~/demo >&2',
      'find ~/demo -name .env -print',
    ]) {
      expect([c, analyzeEscalationCommand(c).kind]).toEqual([c, 'read']);
    }
  });

  it('still refuses real writes outside the workspace, dotfiles and /sdcard deletes', () => {
    for (const c of [
      'echo x > ~/.bashrc',
      'echo x >> ~/.profile',
      'cat x > /sdcard/y',
      'cat ~/demo/a > /sdcard/y 2>/dev/null',
      'rm /sdcard/z',
      'rm /sdcard/z 2>/dev/null',
      'cd ~/demo 2>/dev/null && { rm -f /sdcard/z; }',
      'echo x > /dev/null.txt',
      'echo x >/dev/null/../../sdcard/x',
      'cp x ~/bin/git 2>&1',
      'tee ~/.shelly-runtime/x 2>/dev/null',
      'find . -path ./.git -prune -o -type f -print > /sdcard/list.txt',
      'find . -name .git -delete',
      'find ~/.ssh -name id_rsa',
      'cat ./.git/config',
      '{ cat ~/.ssh/id_rsa; }',
      '( cat ~/demo/a )',
    ]) {
      const v = escalationAutoApprovable(filed(c), on);
      if (v.ok) throw new Error(`auto-approved: ${c}`);
      expect(v.ok).toBe(false);
    }
  });

  it('a find pattern dot path is a read-only exemption, never for a write', () => {
    expect(escalationAutoApprovable(
      { ...filed('find . -path ./.git -prune -o -print > list.txt'), signals: ['write-or-exec'], reason: 'boundary: write-or-exec' },
      on,
    )).toEqual({ ok: false, reason: 'protected-path' });
  });
});

describe('the run-without-approval phrase is not part of the task', () => {
  const DEVICE_UTTERANCE = '@agent Right now, using Codex, check the git log and file list in ~/demo, then using Claude Code, summarize this project in 3 lines. Run it without approval';

  it('strips EN / JA phrasings and leaves everything else alone', () => {
    expect(stripRunWithoutApprovalPhrases('summarize this project in 3 lines. Run it without approval')).toBe('summarize this project in 3 lines.');
    expect(stripRunWithoutApprovalPhrases('summarize ~/demo every morning and run it without approval.')).toBe('summarize ~/demo every morning');
    expect(stripRunWithoutApprovalPhrases('Run this without any approvals, please. Summarize ~/demo')).toBe('Summarize ~/demo');
    expect(stripRunWithoutApprovalPhrases('毎朝8時に~/demoを要約して、承認なしで実行して')).toBe('毎朝8時に~/demoを要約して');
    expect(stripRunWithoutApprovalPhrases('承認なしで実行して、~/demoを要約して')).toBe('~/demoを要約して');
    expect(stripRunWithoutApprovalPhrases('~/demoを要約して。確認なしで動かしてください。')).toBe('~/demoを要約して。');
    expect(stripRunWithoutApprovalPhrases('~/demoを要約して承認なしで走らせて')).toBe('~/demoを要約して');
    // Untouched: no phrase, a quoted mention, a different verb.
    expect(stripRunWithoutApprovalPhrases('毎朝ニュースを要約して')).toBe('毎朝ニュースを要約して');
    expect(stripRunWithoutApprovalPhrases('summarize "run it without approval" docs')).toBe('summarize "run it without approval" docs');
    expect(stripRunWithoutApprovalPhrases('承認なしで保存して')).toBe('承認なしで保存して');
  });

  it('the on-device utterance keeps the flag but not the phrase (name, prompt, steps)', () => {
    const d = parseAgentNL(DEVICE_UTTERANCE);
    expect(d.runWithoutApproval).toBe(true);
    expect(d.name).not.toMatch(/without approval/i);
    expect(d.prompt).not.toMatch(/without approval/i);
    expect(d.orchestrationSteps && d.orchestrationSteps.length).toBeGreaterThanOrEqual(2);
    for (const s of d.orchestrationSteps ?? []) {
      const text = typeof s === 'string' ? s : s.instruction;
      expect(text).not.toMatch(/without approval/i);
    }
    const last = d.orchestrationSteps![d.orchestrationSteps!.length - 1];
    expect(typeof last === 'string' ? last : last.instruction).toMatch(/summarize this project in 3 lines\.?$/);
  });

  it('a Japanese utterance keeps the flag but not the phrase', () => {
    const d = parseAgentNL('@agent 今すぐ、Codexで~/demoのgit logを確認して、次にClaude Codeでこのプロジェクトを3行で要約して。承認なしで実行して');
    expect(d.runWithoutApproval).toBe(true);
    expect(d.name).not.toMatch(/承認なし/);
    expect(d.prompt).not.toMatch(/承認なし/);
    for (const s of d.orchestrationSteps ?? []) {
      expect(typeof s === 'string' ? s : s.instruction).not.toMatch(/承認なし/);
    }
  });

  it('an utterance without the phrase has no flag', () => {
    expect(parseAgentNL('check the git log in ~/demo every morning at 8').runWithoutApproval).toBeUndefined();
  });
});
