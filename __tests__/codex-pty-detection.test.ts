import {
  detectCodexActiveTranscript,
  detectCodexApprovalPrompt,
  detectCodexInteractivePrompt,
  detectCodexLaunchFailureText,
  detectCodexPtyLaunchText,
  detectShellReadyText,
} from '@/lib/codex-pty-detection';

describe('codex pty detection', () => {
  it('detects the Codex banner and directory', () => {
    expect(detectCodexPtyLaunchText([
      '>_ OpenAI Codex (v0.135.0)',
      'model:     gpt-5.5   /model to change',
      'directory: /data/data/dev.shelly.terminal/files/home',
    ].join('\n'))).toEqual({
      cwd: '/data/data/dev.shelly.terminal/files/home',
      reason: 'banner',
    });
  });

  it('detects the Codex prompt line cwd', () => {
    expect(detectCodexPtyLaunchText(
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home\n',
    )).toEqual({
      cwd: '/data/data/dev.shelly.terminal/files/home',
      reason: 'prompt',
    });
  });

  it('ignores ordinary terminal output', () => {
    expect(detectCodexPtyLaunchText('~/project $ pnpm check\n')).toBeNull();
  });

  it('ignores a Codex banner when no cwd is present', () => {
    expect(detectCodexPtyLaunchText('>_ OpenAI Codex (v0.135.0)\n')).toBeNull();
  });

  it('detects an active Codex prompt in the visible transcript tail', () => {
    expect(detectCodexActiveTranscript([
      '>_ OpenAI Codex (v0.135.0)',
      'directory: /data/data/dev.shelly.terminal/files/home',
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
    ].join('\n'))).toBe(true);
  });

  it('treats a later shell prompt as no longer inside Codex', () => {
    expect(detectCodexActiveTranscript([
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
      'Use /skills to list available skills',
      '~$',
    ].join('\n'))).toBe(false);
  });

  it('detects a ready shell prompt from the current screen', () => {
    expect(detectShellReadyText([
      'some output',
      '~$',
    ].join('\n'))).toBe(true);
  });

  it('does not treat an output-only screen as ready for command injection', () => {
    expect(detectShellReadyText([
      'Downloading...',
      'still running',
    ].join('\n'))).toBe(false);
  });

  it('detects an active Codex approval prompt', () => {
    expect(detectCodexApprovalPrompt([
      'Codex needs approval to run this command:',
      'pnpm check',
      'Allow? y/n',
    ].join('\n'))).toBe(true);
  });

  it('does not treat ordinary yes/no text as approval', () => {
    expect(detectCodexApprovalPrompt([
      'The answer can be yes or no depending on context.',
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
    ].join('\n'))).toBe(false);
  });

  it('detects Codex terminal choice prompts', () => {
    expect(detectCodexInteractivePrompt([
      'Approaching rate limits',
      'Switch to gpt-5.4-mini for lower credit usage?',
      '> 1. Switch to gpt-5.4-mini',
      '2. Keep current model',
      '3. Keep current model (never show again)',
      'Press enter to confirm or esc to go back',
    ].join('\n'))).toBe(true);
  });

  it('detects Codex edit confirmation choice prompts', () => {
    expect(detectCodexInteractivePrompt([
      'Would you like to make the following edits?',
      '> 1. Yes, proceed (y)',
      "2. Yes, and don't ask again for these files (a)",
      '3. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ].join('\n'))).toBe(true);
  });

  it('strips OSC color replies before detecting terminal state', () => {
    const leakedOsc = '\u001b]10;rgb:ffff/ffff/ffff\u0007R10;rgb:ffff/ffff/ffff;1;2;6;9;15;18;21;22c';
    expect(detectCodexActiveTranscript([
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
      leakedOsc,
      '~$',
    ].join('\n'))).toBe(false);
  });

  it('detects Codex native launch failures after returning to the shell', () => {
    const screen = [
      'Bus error        LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 "$@"',
      '~$',
    ].join('\n');

    expect(detectCodexLaunchFailureText(screen)).toBe(true);
    expect(detectCodexActiveTranscript(screen)).toBe(false);
    expect(detectShellReadyText(screen)).toBe(true);
  });

  it('does not treat a successful bundled fallback as a launch failure', () => {
    const screen = [
      'Bus error        LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 "$@"',
      '[shelly] Codex app-data runtime crashed during startup; retrying bundled runtime.',
      '>_ OpenAI Codex (v0.135.0)',
      'directory: /data/data/dev.shelly.terminal/files/home',
      'gpt-5.5 default · /data/data/dev.shelly.terminal/files/home',
    ].join('\n');

    expect(detectCodexLaunchFailureText(screen)).toBe(false);
    expect(detectCodexActiveTranscript(screen)).toBe(true);
    expect(detectShellReadyText(screen)).toBe(false);
  });
});
