export type Feature = {
  id: string;
  name: string;
  description: string;
  category: 'terminal' | 'ai' | 'browser' | 'layout' | 'voice' | 'config' | 'workflow' | 'agent';
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
  { id: 'sound-profiles', name: 'Sound Profiles', description: 'Modern, Retro (8-bit), or Silent sounds', category: 'config' },
  { id: 'fonts', name: 'Font Selection', description: 'Multiple monospace fonts including pixel fonts', category: 'config' },

  // Agent (autonomous background agents — see lib/agent-capability-catalog.ts
  // for a curated example-utterance library built on top of this data)
  { id: 'agent-nl-scheduling', name: 'Natural-Language Scheduling', description: 'Register a background agent by typing `@agent <what> <when>` — no cron syntax. Understands daily, weekly (single or multiple days), hourly/every-N-minutes intervals, and "run once now", in Japanese or English.', category: 'agent', triggerContext: '@agent' },
  { id: 'agent-action-draft', name: 'Agent Action: Draft', description: 'Default agent delivery: writes the run result to a file (e.g. your Obsidian vault) instead of sending it anywhere — the safest default, one-tap approval.', category: 'agent' },
  { id: 'agent-action-notify', name: 'Agent Action: Notify', description: 'Delivers the agent run result as a device notification instead of a file. One-tap approval.', category: 'agent' },
  { id: 'agent-action-webhook', name: 'Agent Action: Webhook', description: 'POSTs the agent run result to an https URL you specify. One-tap approval with the host and payload shown.', category: 'agent' },
  { id: 'agent-action-cli', name: 'Agent Action: CLI', description: 'Runs a shell command template with the agent result. Highest-privilege action — always requires an in-app Review tap before it fires, never one-tap.', category: 'agent' },
  { id: 'agent-action-intent', name: 'Agent Action: Intent', description: 'Opens another app or link (launch) or hands text to the Android share sheet (share) with the run result. Always requires an in-app Review tap.', category: 'agent' },
  { id: 'agent-action-dm-reply', name: 'Agent Action: DM Reply', description: 'Replies to a paired live-notification thread (e.g. a chat message) with the agent result. Always requires an in-app Review tap.', category: 'agent' },
  { id: 'agent-action-app-act', name: 'Agent Action: App-Act', description: "Drives a specific pre-approved recipe in another app (currently: posting to X) with the run result. The recipe and target are reviewed once at registration, so autonomous agents can fire it unattended without a per-run tap.", category: 'agent' },
  { id: 'agent-action-api-call', name: 'Agent Action: API Call', description: 'A structured HTTP call to an allowlisted host (Perplexity/Gemini/Cerebras/Groq) authored as one step of a multi-step agent in the confirm card.', category: 'agent' },
  { id: 'agent-orchestration', name: 'Multi-Step Orchestration', description: 'A single agent can chain several instructions in order — "collect X, then summarize, then post" — each step runs through the exact same safety gate as a single run, so chaining adds no privilege.', category: 'agent' },
  { id: 'agent-escalation-ladder', name: 'Tool Escalation Ladder', description: "If the local model can't produce a real answer (not installed, out of context, transient error), the agent automatically climbs to the next allowed tool — free cloud API, then Codex — instead of dead-ending.", category: 'agent' },
  { id: 'agent-run-visibility', name: 'Run Notifications & Missed-Run Detection', description: "Every scheduled agent tells you when it ran (notification plus next/last-run in the Sidebar), and warns you if an expected run never fired (e.g. blocked by battery optimization).", category: 'agent' },
  { id: 'agent-autonomous-mode', name: 'Autonomous Mode', description: 'Toggle an agent to run unattended with no per-step approval tap, restricted to on-device or Codex-OAuth tools for safety.', category: 'agent' },
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
