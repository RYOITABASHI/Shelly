import React from 'react';
import { View, Text } from 'react-native';
import type { ComponentType } from 'react';
import type { PaneTab } from '@/hooks/use-multi-pane';

type PaneEntry = {
  title: string;
  icon: string;
  getComponent: () => ComponentType;
};

function StubPane({ label }: { label: string }) {
  return React.createElement(View, {
    style: { flex: 1, backgroundColor: '#0A0A0A', justifyContent: 'center', alignItems: 'center' },
  }, React.createElement(Text, {
    style: { color: '#666', fontFamily: 'monospace', fontSize: 12 },
  }, `${label} — Coming Soon`));
}

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
};
