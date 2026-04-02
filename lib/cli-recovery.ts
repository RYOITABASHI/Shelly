/**
 * lib/cli-recovery.ts — CLI auto-resume after crash/disconnect
 *
 * When pty-helper is newly created (not reconnected), Shelly checks
 * the session's activeCli field and automatically sends the resume
 * command (e.g. 'claude --continue'). Zero user interaction required.
 */

/** CLI resume command map */
export const CLI_RESUME_COMMANDS: Record<string, string | null> = {
  claude: 'claude --continue',
  gemini: 'gemini --resume latest',
  codex: null,
  cody: null,
};

/**
 * Build a command to resume the previous CLI session.
 * Returns null if no recovery is needed.
 */
export function buildCliResumeCommand(
  cwd: string,
  activeCli: string | null,
): string | null {
  if (!activeCli) return null;

  const resumeCmd = CLI_RESUME_COMMANDS[activeCli];
  if (!resumeCmd) return null;

  const escaped = cwd.replace(/'/g, "'\\''");
  return `cd '${escaped}' && ${resumeCmd}`;
}
