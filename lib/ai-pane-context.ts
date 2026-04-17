/**
 * lib/ai-pane-context.ts — Terminal context injection layer for AI Pane
 *
 * Reads terminal state (command blocks + execution log buffer) and exposes
 * helpers for injecting that context into the AI Pane system prompt.
 */

import { useTerminalStore } from '@/store/terminal-store';
import { useExecutionLogStore } from '@/store/execution-log-store';

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Get a plaintext snapshot of recent terminal output from the active session.
 *
 * Strategy:
 *   1. Try execution-log sessionBuffer first (has rich per-session data).
 *   2. Fall back to terminal-store blocks (command + output lines).
 *
 * @param maxLines Maximum number of output lines to include (default 50).
 * @returns Snapshot string, or null if no output is available.
 */
export function getTerminalSnapshot(maxLines = 50): string | null {
  const { sessions, activeSessionId } = useTerminalStore.getState();
  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  // 1. Prefer execution-log sessionBuffer (richest source)
  const logStore = useExecutionLogStore.getState();
  const logOutput = logStore.getRecentOutput(maxLines, 3, session?.nativeSessionId);
  if (logOutput && logOutput.trim().length > 0) {
    return logOutput.trim();
  }

  // 2. Fall back to terminal-store blocks
  if (!session || session.blocks.length === 0) return null;

  const lines: string[] = [];

  // Walk blocks newest-first, collect until we reach maxLines
  const recentBlocks = session.blocks.slice(-20); // cap block scan
  for (const block of recentBlocks) {
    const blockLines: string[] = [];

    // Command header
    blockLines.push(`$ ${block.command}`);

    // Output lines
    for (const line of block.output) {
      blockLines.push(line.text);
    }

    lines.push(...blockLines);
  }

  if (lines.length === 0) return null;

  // Trim to maxLines (keep most recent)
  const trimmed = lines.slice(-maxLines);
  return trimmed.join('\n').trim() || null;
}

// ─── System prompt builder ────────────────────────────────────────────────────

/**
 * Build the system prompt for the AI Pane, optionally injecting terminal context
 * and a staged-for-edit file body. When a file is staged, the prompt steers the
 * model toward unified-diff responses so InlineDiff can parse + apply them.
 *
 * @param terminalContext Output of getTerminalSnapshot(), or null.
 * @param agentName       Agent bound to the current pane (e.g. "claude"), or null.
 * @param stagedFile      File primed for editing (from auto-stage / stageAiEdit).
 * @returns Full system prompt string.
 */
export function buildAIPaneSystemPrompt(
  terminalContext: string | null,
  agentName: string | null,
  stagedFile?: { path: string; content: string } | null,
): string {
  const parts: string[] = [
    'You are Shelly AI, a terminal assistant. You can see the user\'s terminal output.',
  ];

  if (agentName) {
    parts.push(`You are operating as ${agentName}.`);
  }

  if (terminalContext) {
    parts.push(
      '\n[Terminal Output]\n' + terminalContext + '\n[End Terminal Output]',
    );
  }

  if (stagedFile) {
    // Number the lines so the model can target hunks precisely. Unified
    // diff @@ headers need the right line numbers or InlineDiff's
    // strict-apply path will reject the patch.
    const numbered = stagedFile.content
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(4, ' ')}  ${line}`)
      .join('\n');
    parts.push(
      `\n[File: ${stagedFile.path}]\n${numbered}\n[End File]\n\n` +
      'When the user asks you to fix, refactor, or edit the file above, ' +
      'respond with a unified diff ONLY (no surrounding prose, no code-fence ' +
      'variants) in this format:\n\n' +
      '```diff\n' +
      `--- a${stagedFile.path}\n` +
      `+++ b${stagedFile.path}\n` +
      '@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@\n' +
      ' context line (unchanged, leading single space)\n' +
      '-removed line\n' +
      '+added line\n' +
      '```\n\n' +
      'Keep hunks minimal: 2-3 lines of context above and below each change. ' +
      'Never emit the whole file unless every line changes.',
    );
  }

  return parts.join('\n');
}

// ─── Context badge ────────────────────────────────────────────────────────────

/**
 * Returns a short label shown in the AI Pane header when terminal context is
 * being injected, or null when there is no context.
 */
export function formatContextBadge(terminalContext: string | null): string | null {
  return terminalContext ? 'Reading Terminal' : null;
}
