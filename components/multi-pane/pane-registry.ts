import type { ComponentType } from 'react';
import type { PaneTab } from '@/hooks/use-multi-pane';

type PaneEntry = {
  title: string;
  icon: string; // MaterialIcons name
  getComponent: () => ComponentType;
};

export const PANE_REGISTRY: Record<PaneTab, PaneEntry> = {
  projects: {
    title: 'Projects',
    icon: 'folder',
    getComponent: () => require('@/app/(tabs)/projects').default,
  },
  index: {
    title: 'Chat',
    icon: 'chat',
    getComponent: () => require('@/app/(tabs)/index').default,
  },
  terminal: {
    title: 'Terminal',
    icon: 'terminal',
    getComponent: () => require('@/app/(tabs)/terminal').default,
  },
  snippets: {
    title: 'Snippets',
    icon: 'bookmark',
    getComponent: () => require('@/app/(tabs)/snippets').default,
  },
  creator: {
    title: 'Creator',
    icon: 'auto-awesome',
    getComponent: () => require('@/app/(tabs)/creator').default,
  },
obsidian: {
    title: 'Obsidian',
    icon: 'psychology',
    getComponent: () => require('@/app/(tabs)/obsidian').default,
  },
  search: {
    title: 'Search',
    icon: 'search',
    getComponent: () => require('@/app/(tabs)/search').default,
  },
  settings: {
    title: 'Settings',
    icon: 'settings',
    getComponent: () => require('@/app/(tabs)/settings').default,
  },
};
