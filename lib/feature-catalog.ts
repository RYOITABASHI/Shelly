export type Feature = {
  id: string;
  name: string;
  description: string;
  category: 'terminal' | 'ai' | 'browser' | 'layout' | 'voice' | 'config' | 'workflow';
  triggerContext?: string; // when to suggest this feature
};

export const FEATURE_CATALOG: Feature[] = [
  // Terminal
  { id: 'autocomplete', name: 'Fig-Style Autocomplete', description: 'Fuzzy command/path/git completions while typing', category: 'terminal', triggerContext: 'user typing commands' },
  { id: 'syntax-highlight', name: 'Syntax Highlighting', description: 'Colored shell command input', category: 'terminal' },
  { id: 'clickable-paths', name: 'Clickable Paths', description: 'Tap file paths and errors in terminal output to navigate', category: 'terminal', triggerContext: 'error output detected' },
  { id: 'inline-blocks', name: 'Inline Content Blocks', description: 'JSON tree, markdown, tables, images rendered inline', category: 'terminal', triggerContext: 'JSON or markdown output' },
  { id: 'multi-line', name: 'Multi-Line Input', description: 'Shift+Enter or ↵ button for multi-line commands', category: 'terminal' },
  { id: 'bracket-close', name: 'Auto-Close Brackets', description: 'Automatic matching brackets and quotes', category: 'terminal' },
  { id: 'command-blocks', name: 'Command Blocks', description: 'Collapsible command output with copy/fold', category: 'terminal' },
  { id: 'cli-notify', name: 'CLI Completion Notify', description: 'Sound + badge when background command finishes', category: 'terminal' },

  // AI
  { id: 'ai-pane', name: 'AI Pane', description: 'Streaming AI responses with terminal context', category: 'ai' },
  { id: 'inline-diff', name: 'Inline Diff Preview', description: 'Green/red diff with accept/reject in AI responses', category: 'ai', triggerContext: 'AI suggests code changes' },
  { id: 'agent-selector', name: 'Agent Selector', description: 'Switch AI agents per pane (Codex, Local, cloud APIs...)', category: 'ai' },
  { id: 'terminal-context', name: 'Terminal Context', description: 'AI reads your terminal output automatically', category: 'ai' },

  // Browser
  { id: 'browser-pane', name: 'Browser Pane', description: 'In-app browser with bookmarks and background audio', category: 'browser' },
  { id: 'bg-media', name: 'Background Media', description: 'YouTube/music keeps playing when switching panes', category: 'browser' },
  { id: 'bookmarks', name: 'Bookmarks Bar', description: 'Quick-access bookmarks (YouTube, GitHub, localhost)', category: 'browser' },

  // Layout
  { id: 'pane-split', name: 'Pane Split', description: 'Split screen into up to 4 panes', category: 'layout' },
  { id: 'sidebar', name: 'Sidebar', description: 'File tree, repos, tasks, device folders, ports', category: 'layout' },
  { id: 'agent-bar', name: 'Agent Bar', description: 'Top bar for AI agent switching with color coding', category: 'layout' },
  { id: 'context-bar', name: 'Context Bar', description: 'Bottom bar showing cwd, git branch, connection', category: 'layout' },

  // Voice
  { id: 'voice-ai', name: 'Voice in AI Pane', description: 'Mic button for voice input to AI', category: 'voice' },
  { id: 'voice-terminal', name: 'Voice in Terminal', description: 'Mic button for voice commands', category: 'voice' },

  // Workflow
  { id: 'workflows', name: 'Workflow Manager', description: 'Save and replay command sequences: shelly workflow', category: 'workflow' },
  { id: 'savepoints', name: 'Auto Savepoints', description: 'Automatic git snapshots with undo', category: 'workflow' },

  // Config
  { id: 'crt-mode', name: 'CRT Mode', description: 'Retro CRT display effect with scanlines', category: 'config' },
  { id: 'sound-profiles', name: 'Sound Profiles', description: 'Modern, Retro (8-bit), or Silent sounds', category: 'config' },
  { id: 'fonts', name: 'Font Selection', description: 'Multiple monospace fonts including pixel fonts', category: 'config' },
];

/** Compressed catalog for AI system prompt injection */
export function getCompressedCatalog(): string {
  return FEATURE_CATALOG.map(f => `- ${f.name}: ${f.description}`).join('\n');
}

/** Find features relevant to a given context string */
export function suggestFeatures(context: string): Feature[];
/** Find features relevant to an array of recent command names */
export function suggestFeatures(recentCommandNames: string[]): Feature[];
export function suggestFeatures(contextOrCommands: string | string[]): Feature[] {
  if (Array.isArray(contextOrCommands)) {
    // Context from recent terminal command names
    const joined = contextOrCommands.join(' ').toLowerCase();
    const matched = FEATURE_CATALOG.filter(
      (f) => f.triggerContext && joined.includes(f.triggerContext.toLowerCase().split(' ')[0]),
    );
    if (matched.length >= 2) return matched.slice(0, 3);
    // Fall back to popular always-useful features
    const fallbackIds = ['ai-pane', 'command-blocks', 'savepoints'];
    const fallbacks = FEATURE_CATALOG.filter((f) => fallbackIds.includes(f.id));
    // Merge: matched first, then fill from fallbacks without duplicates
    const seen = new Set(matched.map((f) => f.id));
    const extra = fallbacks.filter((f) => !seen.has(f.id));
    return [...matched, ...extra].slice(0, 3);
  }
  // Legacy string-based path
  const lower = contextOrCommands.toLowerCase();
  return FEATURE_CATALOG.filter(
    (f) => f.triggerContext && lower.includes(f.triggerContext.toLowerCase().split(' ')[0]),
  ).slice(0, 3);
}
