/* eslint-disable @typescript-eslint/no-require-imports -- Pane components are lazy-loaded here to avoid eager pane cycles. */
import type { ComponentType } from 'react';
import type { PaneTab } from '@/hooks/use-multi-pane';

type PaneEntry = {
  title: string;
  titleKey?: string;
  headerTitle?: string;
  headerTitleKey?: string;
  icon: string;
  getComponent: () => ComponentType;
};

export const PANE_REGISTRY: Record<PaneTab, PaneEntry> = {
  terminal: {
    title: 'Terminal',
    titleKey: 'pane.terminal.title',
    headerTitle: 'Terminal',
    headerTitleKey: 'pane.terminal.header',
    icon: 'terminal',
    getComponent: () => require('@/components/panes/TerminalPane').default,
  },
  ai: {
    title: 'AI',
    titleKey: 'pane.ai.title',
    headerTitle: 'AI',
    headerTitleKey: 'pane.ai.header',
    icon: 'auto-awesome',
    getComponent: () => require('@/components/panes/AIPane').default,
  },
  'agent-chat': {
    title: 'Agent Chat',
    titleKey: 'pane.agent_chat.title',
    headerTitle: 'Agent Chat',
    headerTitleKey: 'pane.agent_chat.header',
    icon: 'forum',
    getComponent: () => require('@/components/panes/AgentChatPane').default,
  },
  browser: {
    title: 'Browser',
    titleKey: 'pane.browser.title',
    headerTitle: 'Browser',
    headerTitleKey: 'pane.browser.header',
    icon: 'language',
    getComponent: () => require('@/components/panes/BrowserPane').default,
  },
  markdown: {
    title: 'Markdown',
    titleKey: 'pane.markdown.title',
    headerTitle: 'Markdown',
    headerTitleKey: 'pane.markdown.header',
    icon: 'description',
    getComponent: () => require('@/components/panes/MarkdownPane').default,
  },
  preview: {
    title: 'Preview',
    titleKey: 'pane.preview.title',
    headerTitle: 'Preview',
    headerTitleKey: 'pane.preview.header',
    icon: 'preview',
    getComponent: () => require('@/components/panes/PreviewPane').default,
  },
  // ASK Pane — Shelly's self-documenting assistant. Answers "can Shelly
  // do X?" / "how do I use Y?" using the bundled feature-catalog as
  // context and routes unknown features into GitHub issues via the
  // shelly-cs OAuth token.
  ask: {
    title: 'Ask',
    titleKey: 'pane.ask.title',
    headerTitle: 'Ask',
    headerTitleKey: 'pane.ask.header',
    icon: 'help-outline',
    getComponent: () => require('@/components/panes/AskPane').default,
  },
  // Agent Runs pane — scrollable history of past background-agent runs
  // (agent-store's runHistory, up to 30 per agent) with the per-run audit
  // detail the Sidebar's 3-button Alert could never fit.
  'agent-runs': {
    title: 'Agent Runs',
    titleKey: 'pane.agent_runs.title',
    headerTitle: 'Agent Runs',
    headerTitleKey: 'pane.agent_runs.header',
    icon: 'history',
    getComponent: () => require('@/components/panes/AgentRunsPane').default,
  },
  // Memory Workbench pane — browse/search/edit/delete an agent's memory
  // notes plus the shared _global notes. Opened from the Sidebar agent
  // detail popup's Memory button (agent target flows through agent-store's
  // memoryWorkbenchAgentId).
  'memory-workbench': {
    title: 'Memory',
    titleKey: 'pane.memory_workbench.title',
    headerTitle: 'Memory',
    headerTitleKey: 'pane.memory_workbench.header',
    icon: 'psychology',
    getComponent: () => require('@/components/panes/MemoryWorkbenchPane').default,
  },
};

export function resolvePaneTitle(
  tab: PaneTab,
  translate?: (key: string) => string,
  variant: 'label' | 'header' = 'label',
): string {
  const entry = PANE_REGISTRY[tab];
  if (!entry) return String(tab);
  if (variant === 'header') {
    if (entry.headerTitleKey && translate) return translate(entry.headerTitleKey);
    return entry.headerTitle ?? entry.title;
  }
  if (entry.titleKey && translate) return translate(entry.titleKey);
  return entry.title;
}
