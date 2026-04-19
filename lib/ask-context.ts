/**
 * lib/ask-context.ts
 *
 * Builds the system prompt for the ASK Pane (Shelly's self-documenting
 * assistant). Aggregates the structured feature catalog plus a trimmed
 * slice of the high-level docs so any capable LLM can answer "can
 * Shelly do X?" / "how do I use Y?" grounded in facts.
 *
 * Stage 1 minimum: feature-catalog only + a short primer. Subsequent
 * stages will ingest README / CLAUDE.md / DEFERRED.md excerpts via a
 * generated docs-content.ts. For now we keep this inline + small so it
 * ships in one commit without touching the build pipeline.
 */

import { FEATURE_CATALOG, type Feature } from './feature-catalog';

const PRIMER = `
You are the ASK Pane of Shelly — a chat-first terminal IDE for Android
(Samsung Galaxy Z Fold6 primary target). Users open this pane to ask
"can Shelly do X?" / "how do I use Y?" Answer based only on the
context provided below. Do not invent features or behaviour.

Answer rules:
1. Be concrete and short (3-8 sentences).
2. When relevant, cite the source (feature id, file path, or doc
   section) in a trailing "(source: ...)" tag.
3. End every response on its own final line with one of these status
   tags — no other text after, no markdown around them:
     [AVAILABLE]      — the feature ships today; walk through usage.
     [PLANNED]        — in the backlog (BACKLOG section); mention
                        priority if stated, otherwise "planned".
     [NOT_AVAILABLE]  — no evidence in any source; recommend the user
                        file an issue (Shelly has built-in support:
                        one tap on the "Create GitHub issue" button
                        below the answer).
4. If the question is ambiguous, prefer [AVAILABLE] and describe the
   closest feature — users would rather discover something nearby than
   be told "not found".
5. Respond in Japanese when asked in Japanese; otherwise English.
`;

function formatFeature(f: Feature): string {
  const trigger = f.triggerContext ? ` — triggers: ${f.triggerContext}` : '';
  return `- [${f.category}] ${f.name} (id: ${f.id}): ${f.description}${trigger}`;
}

const CATALOG_SECTION = FEATURE_CATALOG.map(formatFeature).join('\n');

// Hand-curated snippets from README / CLAUDE.md / DEFERRED.md. Keeps
// the prompt small while still surfacing the most-asked capabilities
// that the pure feature-catalog description doesn't cover (ship state,
// roadmap).
const CURATED_DOCS = `
SHIPPING (as of 2026-04):
- Shelly runs standalone on Android (JNI forkpty; Termux not required).
- Bundled CLIs: claude (pinned 2.1.112, the last cli.js release before
  Anthropic's Bun-SEA switch), gemini (latest), codex (via
  DioNanos/codex-termux Android-native fork).
- Auto-update pipeline with snapshot + health check + rollback — a
  broken upstream @latest never blocks the claude command.
- GitHub Codespaces integration via shelly-cs CLI: OAuth device flow,
  list / create / open / use / stop / delete / doctor. The \`cs\`
  alias resolves to a default codespace for a one-tap "open my dev
  env" flow. Opens the codespace in Shelly's in-app Browser Pane via
  a shelly://browser?url=… deep link.
- Multi-pane layout: up to 4 panes on wide (Z Fold6 expanded), 1 on
  compact/standard. Pane types: Terminal, AI, Browser, Markdown,
  Preview, Ask.
- Cross-Pane Intelligence: AI Pane auto-injects Terminal output into
  its context (READING TERMINAL badge when active).
- Paste pipeline: bracketed-paste via an ESC-free \\C-x\\C-b trigger
  to bracketed-paste-begin — works around bionic bash's readline
  meta-prefix bug. Multi-line paste is atomic again.

ROADMAP / PLANNED (DEFERRED.md highlights):
- SSH tunneling for shelly-cs (dev-tunnels-connections + ssh2). Will
  drop the user directly into the codespace's bash inside Shelly's
  Terminal Pane instead of the web terminal.
- SecureStore bridge for the shelly-cs token (currently 0600 file).
- "What's new" card in the Ask Pane pulling from CHANGELOG.md.
- Sidebar CODESPACES section (Worktrees-pattern) for one-tap codespace
  management.

EXPLICITLY OUT OF SCOPE:
- Cloud storage providers (Google Drive / Dropbox / OneDrive) — Shelly
  defers to rclone, which already speaks 40+ backends.
- Anthropic / OpenAI paid-API direct integration — user policy is
  "no paid APIs except Perplexity". Claude and Codex ship as CLIs only.
`;

export function buildAskSystemPrompt(): string {
  return `${PRIMER}

<FEATURE_CATALOG>
${CATALOG_SECTION}
</FEATURE_CATALOG>

<SHIPPING_AND_ROADMAP>
${CURATED_DOCS}
</SHIPPING_AND_ROADMAP>
`;
}

export type AskStatus = 'AVAILABLE' | 'PLANNED' | 'NOT_AVAILABLE' | null;

/**
 * Extract the trailing status tag from a streaming response.
 * Robust to minor LLM deviations (optional brackets, trailing whitespace).
 */
export function extractStatus(text: string): AskStatus {
  const m = text.match(/\[?(AVAILABLE|PLANNED|NOT_AVAILABLE)\]?\s*$/);
  return (m ? (m[1] as AskStatus) : null);
}

/**
 * Strip the trailing status tag from a response for cleaner display.
 */
export function stripStatusTag(text: string): string {
  return text.replace(/\s*\[?(AVAILABLE|PLANNED|NOT_AVAILABLE)\]?\s*$/, '').trimEnd();
}
