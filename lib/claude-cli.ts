/**
 * lib/claude-cli.ts
 *
 * Thin wrapper around the bundled `claude` CLI for AIPane usage.
 *
 * The CLI is invoked via execCommand (JNI fork+exec) so output is collected
 * once at the end. We expose a stream-shaped API anyway so call sites can
 * reuse the same shape as the REST API helpers (groqChatStream, etc.) and
 * upgrade later if/when we wire a true line-buffered streamer.
 */

import { execCommand } from '@/hooks/use-native-exec';
import { buildChatModeClaudeCommand, type AutoApproveLevel } from '@/lib/cli-permission-proxy';
import { logInfo, logError } from '@/lib/debug-logger';

/** Default per-call timeout for `claude --print`. 10 minutes. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type ClaudeCliOptions = {
  /** Permission level. 'all' adds --dangerouslySkipPermissions. */
  autoApprove?: AutoApproveLevel;
  /** Per-call timeout, default 10 min. */
  timeoutMs?: number;
  /** Optional system context prepended to the prompt. claude --print
   *  doesn't accept a real system message via flag, so we inline the
   *  context as a "Context:" preamble before the user's question. */
  systemPrompt?: string;
};

export type ClaudeCliResult = {
  success: boolean;
  content: string;
  error?: string;
  exitCode: number;
};

/**
 * Run a one-shot `claude --print` call and return the full result.
 *
 * Use this when you don't need streaming — simpler than the stream API
 * and avoids the dummy chunk emission.
 */
export async function claudeCliRun(
  prompt: string,
  options: ClaudeCliOptions = {},
): Promise<ClaudeCliResult> {
  // claude --print doesn't take a -s/system flag, so prefix the system
  // context (e.g. terminal snapshot) into the prompt body when present.
  const wholePrompt = options.systemPrompt && options.systemPrompt.length > 0
    ? `${options.systemPrompt}\n\n---\n\n${prompt}`
    : prompt;
  const cmd = buildChatModeClaudeCommand(wholePrompt, options.autoApprove ?? 'safe');
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  logInfo('ClaudeCli', 'run: ' + prompt.slice(0, 60));

  try {
    const result = await execCommand(cmd, timeout);
    const content = (result.stdout ?? '').trim();
    if (result.exitCode !== 0) {
      const stderr = (result.stderr ?? '').trim();
      logError('ClaudeCli', 'exit=' + result.exitCode + ' stderr=' + stderr.slice(0, 200));
      return {
        success: false,
        content,
        exitCode: result.exitCode,
        error: stderr || `claude exited with code ${result.exitCode}`,
      };
    }
    return { success: true, content, exitCode: 0 };
  } catch (e: any) {
    logError('ClaudeCli', 'exec failed', e);
    return {
      success: false,
      content: '',
      exitCode: -1,
      error: e?.message ?? String(e),
    };
  }
}

/**
 * Stream-shaped wrapper. Today this just emits the full output as a single
 * chunk after the CLI exits, so callers can write the same code as for
 * gemini/groq/perplexity streams. When we add a real line-buffered streamer
 * (via TerminalEmulator.writeToSession + transcript polling) only this
 * function changes.
 */
export async function claudeCliStream(
  prompt: string,
  onChunk: (chunk: string, done: boolean) => void,
  options: ClaudeCliOptions = {},
  signal?: AbortSignal,
): Promise<ClaudeCliResult> {
  const result = await claudeCliRun(prompt, options);

  if (signal?.aborted) {
    onChunk('', true);
    return { ...result, success: false, error: 'aborted' };
  }

  if (result.content) {
    onChunk(result.content, false);
  }
  onChunk('', true);
  return result;
}

/**
 * Quick availability check — runs `which claude` and returns true if
 * the CLI is on PATH.
 */
export async function claudeCliAvailable(): Promise<boolean> {
  try {
    const r = await execCommand('which claude 2>/dev/null', 5000);
    return r.exitCode === 0 && (r.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}
