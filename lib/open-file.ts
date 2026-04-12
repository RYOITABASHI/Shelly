/**
 * lib/open-file.ts — Route a file tap to the right viewer.
 *
 * Markdown goes to MarkdownPane (rendered view).
 * Everything else goes to the Preview pane's Code tab.
 *
 * This is the entry point that FileTree / command palette / AI links
 * should use instead of calling openMarkdownFile directly, so new
 * extension types can be added in one place.
 */

import { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { usePreviewStore } from '@/store/preview-store';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

function getExtension(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return '';
  return lower.slice(dot + 1);
}

export async function openFile(path: string): Promise<void> {
  const ext = getExtension(path);

  if (MARKDOWN_EXTS.has(ext)) {
    await openMarkdownFile(path);
    return;
  }

  // Everything else: push into Preview → Code tab
  const store = usePreviewStore.getState();
  store.notifyFileChange(path);
  store.setActiveCodeFile(path);
  store.setActiveTab('code');
  store.openPreview();
}
