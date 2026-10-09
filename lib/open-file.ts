/**
 * lib/open-file.ts — Route a file tap to the right viewer.
 *
 * Markdown goes to MarkdownPane (rendered view).
 * Everything else goes to the Preview pane's Code tab.
 *
 * This is the entry point that FileTree / command palette / AI links
 * should use instead of calling openMarkdownFile directly, so new
 * extension types can be added in one place.
 *
 * The target pane is always made visible first: an existing pane is
 * focused (promoting the preset / un-maximizing as needed), otherwise one
 * is added — or, when the 4-pane grid is full, a non-terminal slot is
 * repurposed. Earlier versions called openMarkdownFile directly, which
 * returned silently when no MarkdownPane was mounted, so "↗ Open <file>.md"
 * links on agent completion notices did nothing for users without a
 * Markdown pane already open. If nothing can be shown we toast instead of
 * silently no-op'ing.
 */

import { ToastAndroid } from 'react-native';
import { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { usePreviewStore } from '@/store/preview-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { ensurePaneByTab } from '@/lib/pane-focus';
import { t } from '@/lib/i18n';
import { logInfo } from '@/lib/debug-logger';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

function getExtension(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return '';
  return lower.slice(dot + 1);
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function toastCannotOpen(path: string): void {
  logInfo('OpenFile', `no pane available for ${path}`);
  try {
    ToastAndroid.show(t('open_file.no_pane', { name: basename(path) }), ToastAndroid.SHORT);
  } catch { /* toast unavailable (web/tests) */ }
}

export async function openFile(path: string): Promise<void> {
  const ext = getExtension(path);

  if (MARKDOWN_EXTS.has(ext)) {
    if (!ensurePaneByTab('markdown')) {
      toastCannotOpen(path);
      return;
    }
    // If the pane was just added it isn't mounted yet — openMarkdownFile
    // queues the path and the pane loads it on mount.
    await openMarkdownFile(path);
    return;
  }

  // Everything else: push into Preview → Code tab.
  const store = usePreviewStore.getState();
  store.notifyFileChange(path);

  const { slots, focusedSlot } = useMultiPaneStore.getState();
  const hasPreviewPane = slots.some((s) => s?.tab === 'preview');
  const focusedIsTerminal = slots[focusedSlot]?.tab === 'terminal';

  if (!hasPreviewPane && focusedIsTerminal) {
    // The focused terminal pane hosts the inline preview (split on wide,
    // overlay on compact) once isOpen flips.
    store.openPreview();
  } else if (!ensurePaneByTab('preview')) {
    toastCannotOpen(path);
    return;
  } else {
    store.clearNewContent();
  }

  // Set the tab AFTER openPreview: openPreview picks 'web' when a URL has
  // been detected, which used to override the 'code' tab set beforehand.
  store.setActiveCodeFile(path);
  store.setActiveTab('code');
}
