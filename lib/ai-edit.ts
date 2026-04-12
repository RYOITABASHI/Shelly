/**
 * lib/ai-edit.ts — "Golden path" for AI-assisted file editing.
 *
 * Flow:
 *   1. CodeTab (or any file viewer) calls `stageAiEdit(path)`.
 *   2. The file is cat'd via execCommand so the caller gets the current
 *      content, and the same content is injected into the first AI
 *      pane's terminalContext so `buildAIPaneSystemPrompt` folds it
 *      into the system message on the next dispatch.
 *   3. The user types "make X do Y" into the AI pane input.
 *   4. The existing use-ai-pane-dispatch sends it to Cerebras/Claude/
 *      Gemini with the file as context and a hint to reply with a
 *      unified diff.
 *   5. The assistant reply containing a unified diff is automatically
 *      picked up by InlineDiff via hasDiffContent() and rendered with
 *      accept / reject buttons.
 *
 * This file deliberately stays UI-free so it can be called from
 * FileTree, CodeTab, or a command-palette action.
 */

import { execCommand } from '@/hooks/use-native-exec';
import { usePaneStore } from '@/store/pane-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';

/**
 * Find the first AI pane in the current multi-pane tree, or null if
 * the user hasn't opened one yet. Prefers the focused pane when it's
 * already an AI pane.
 */
function findAiPaneId(): string | null {
  const panes = usePaneStore.getState().paneAgents;
  const focused = usePaneStore.getState().focusedPaneId;
  const multi = useMultiPaneStore.getState();

  // Focused pane first if it's bound to an agent
  if (focused && panes[focused]) return focused;

  // Otherwise walk the tree looking for a pane of type 'ai'
  // `paneTypes` maps leafId → pane kind ('terminal', 'ai', 'browser', ...)
  const types = (multi as unknown as { paneTypes?: Record<string, string> }).paneTypes ?? {};
  for (const [leafId, type] of Object.entries(types)) {
    if (type === 'ai') return leafId;
  }

  // Fallback: any leaf that has an agent bound
  const firstBound = Object.keys(panes)[0];
  return firstBound ?? null;
}

/**
 * Read a file via the native bridge and return its contents, or throw
 * on failure. Single shell-quoted cat — no more than one round-trip.
 */
async function readFileContent(path: string): Promise<string> {
  const esc = path.replace(/'/g, "'\\''");
  const result = await execCommand(`cat '${esc}'`, 30_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr?.trim() || `cat exited ${result.exitCode}`);
  }
  return result.stdout ?? '';
}

/**
 * Stage a file for AI editing. Loads the file and injects it into the
 * first available AI pane's terminalContext so the next user message
 * goes out with the file content in the system prompt.
 *
 * Returns true if an AI pane was found and primed, false if the user
 * needs to open one first.
 */
export async function stageAiEdit(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFileContent(path);
  } catch (err) {
    throw new Error(
      `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const paneId = findAiPaneId();
  if (!paneId) return false;

  // Inject as terminalContext so buildAIPaneSystemPrompt picks it up.
  // Wrap in a clear marker so the assistant knows it's a file, not
  // terminal output.
  const context =
    `[File: ${path}]\n${content}\n[End File]\n\n` +
    `You are editing the file above. When suggesting changes, respond ` +
    `with a unified diff (--- / +++ / @@ hunks) so the user can accept ` +
    `or reject each hunk inline.`;

  useAIPaneStore.getState().setTerminalContext(paneId, context);

  // Seed a hint message in the conversation so the user sees why the
  // context badge lit up. This is a local 'system' role message — it
  // will not be forwarded to the model (dispatcher filters system
  // messages), it just explains to the user what just happened.
  useAIPaneStore.getState().addMessage(paneId, {
    id: `ai-edit-${Date.now()}`,
    role: 'system',
    content: `Staged ${path} for AI editing. Type what you want changed.`,
    timestamp: Date.now(),
  });

  return true;
}
