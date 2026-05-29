/* eslint-disable @typescript-eslint/no-require-imports -- Pane components are lazy-loaded here to avoid eager pane cycles. */
import type { ComponentType } from 'react';
import type { PaneTab } from '@/hooks/use-multi-pane';

type PaneEntry = {
  title: string;
  icon: string;
  getComponent: () => ComponentType;
};

export const PANE_REGISTRY: Record<PaneTab, PaneEntry> = {
  terminal: {
    title: 'Terminal',
    icon: 'terminal',
    getComponent: () => require('@/components/panes/TerminalPane').default,
  },
  ai: {
    title: 'AI',
    icon: 'auto-awesome',
    getComponent: () => require('@/components/panes/AIPane').default,
  },
  browser: {
    title: 'Browser',
    icon: 'language',
    getComponent: () => require('@/components/panes/BrowserPane').default,
  },
  markdown: {
    title: 'Markdown',
    icon: 'description',
    getComponent: () => require('@/components/panes/MarkdownPane').default,
  },
  preview: {
    title: 'Preview',
    icon: 'preview',
    getComponent: () => require('@/components/panes/PreviewPane').default,
  },
  // ASK Pane — Shelly's self-documenting assistant. Answers "can Shelly
  // do X?" / "how do I use Y?" using the bundled feature-catalog as
  // context and routes unknown features into GitHub issues via the
  // shelly-cs OAuth token.
  ask: {
    title: 'Ask',
    icon: 'help-outline',
    getComponent: () => require('@/components/panes/AskPane').default,
  },
};
