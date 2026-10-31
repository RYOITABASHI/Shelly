/**
 * Front agent (窓口): which agent CLI is auto-launched in the FIRST terminal
 * tab when Shelly starts.
 *
 * Mechanism: for the primary session's createSession call (once per app
 * start), TerminalPane passes `frontAgent: 'agy' | 'claude'`. Native
 * (TerminalEmulatorModule.kt -> shelly-pty.c) exports SHELLY_FRONT_AGENT to
 * that one freshly forked bash only. The generated .bashrc (BASHRC_VERSION
 * 284, HomeInitializer.kt) moves it into a non-exported shell variable and
 * unsets the env var at the top, then at the very end runs the interactive
 * `agy` / `claude` function, or prints an install hint and stays in bash.
 * A resumed live session never forks, so it never re-launches anything.
 *
 * ToS (hard constraint, Google Antigravity): third-party agents must not
 * invoke `agy` programmatically. Shelly only ever STARTS THE INTERACTIVE TUI
 * in a terminal the user sees and types into. Never pipe prompts into
 * `agy -p` / `agy --print`, never route AI-pane chat to agy, never call agy
 * from schedules / agents. __tests__/front-agent.test.ts guards this.
 *
 * Pure TS (no React / RN imports) so it can be unit-tested directly.
 */

export type FrontAgentSetting = 'none' | 'antigravity' | 'claude';

export const FRONT_AGENT_OPTIONS: readonly FrontAgentSetting[] = ['none', 'antigravity', 'claude'];

export const DEFAULT_FRONT_AGENT: FrontAgentSetting = 'none';

/** Coerce any persisted value to a valid setting (unknown -> 'none'). */
export function normalizeFrontAgent(value: unknown): FrontAgentSetting {
  return value === 'antigravity' || value === 'claude' ? value : 'none';
}

/** Value sent to native createSession / exported as SHELLY_FRONT_AGENT. */
export function frontAgentEnvValue(setting: unknown): 'agy' | 'claude' | null {
  switch (normalizeFrontAgent(setting)) {
    case 'antigravity': return 'agy';
    case 'claude': return 'claude';
    default: return null;
  }
}

// Once-per-app-start (per JS runtime) slot. A JS reload re-arms it, but a
// reload with the PTY still alive resumes the session natively and never
// re-forks, so the CLI is not launched twice.
let claimedBy: string | null = null;
let consumed = false;

/**
 * Claim the one front-agent launch for this app start. Succeeds only for the
 * primary (first) terminal tab, and only once. Returns the native value to
 * pass to createSession, or null.
 */
export function claimFrontAgentLaunch(params: {
  sessionId: string;
  primarySessionId: string | undefined;
  setting: unknown;
}): 'agy' | 'claude' | null {
  if (consumed || claimedBy !== null) return null;
  if (!params.primarySessionId || params.sessionId !== params.primarySessionId) return null;
  const value = frontAgentEnvValue(params.setting);
  // Even with 'none', the first tab's create uses up the slot: switching the
  // setting later must not launch the CLI in a tab opened afterwards.
  claimedBy = params.sessionId;
  return value;
}

/** createSession resolved: the slot is used up for this app start. */
export function settleFrontAgentLaunch(sessionId: string, ok: boolean): void {
  if (claimedBy !== sessionId) return;
  if (ok) {
    consumed = true;
  } else {
    // Native create failed (nothing was forked); let the retry for the same
    // primary tab claim it again.
    claimedBy = null;
  }
}

/** Test-only. */
export function __resetFrontAgentLaunchForTests(): void {
  claimedBy = null;
  consumed = false;
}
