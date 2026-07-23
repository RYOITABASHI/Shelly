/**
 * lib/ask-context.ts
 *
 * Builds the system prompt for the ASK Pane (Shelly's self-documenting
 * assistant). Aggregates the structured feature catalog plus a trimmed
 * slice of the high-level docs so any capable LLM can answer "can
 * Shelly do X?" / "how do I use Y?" grounded in facts.
 *
 * Stage 1 minimum: feature-catalog only + a short primer. Subsequent
 * stages will ingest README / AGENTS.md / DEFERRED.md excerpts via a
 * generated docs-content.ts. For now we keep this inline + small so it
 * ships in one commit without touching the build pipeline.
 */

import { FEATURE_CATALOG, getCompressedCatalog, type Feature } from './feature-catalog';

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

// Hand-curated snippets from README / AGENTS.md / DEFERRED.md. Keeps
// the prompt small while still surfacing the most-asked capabilities
// that the pure feature-catalog description doesn't cover (ship state,
// roadmap).
const CURATED_DOCS = `
SHIPPING (as of 2026-05):
- Shelly runs standalone on Android (JNI forkpty; Termux not required).
- Bundled CLI: codex (via DioNanos/codex-termux Android-native fork).
- Local LLM and cloud API panes are available for non-CLI assistant work.
- CLI update checks are limited to Codex and run only when explicitly
  requested by the user.
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
- Removed legacy CLI providers.
- OpenAI paid-API direct integration outside the Codex CLI.
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

// Matches the trailing status tag plus any decoration a model tends to wrap
// it in. Before the tag: only whitespace/newlines and markdown emphasis
// chars (*/_/`) — deliberately NOT sentence punctuation (./。/！), which
// would belong to the actual answer's last sentence, not the tag, and must
// stay. After the tag: markdown emphasis AND trailing punctuation, since a
// model closing "**[AVAILABLE]**" or adding a stray "。" after the tag is
// pure decoration with nothing meaningful following it. On-device testing
// (2026-07-23, local Qwen model) found the original bare `\[?TAG\]?\s*$`
// anchor left the tag visibly leaking into the displayed answer whenever the
// model added so much as a trailing "。" or wrapped the tag in **bold**.
const TRAILING_STATUS_RE = /[\s*_`]*\[?(AVAILABLE|PLANNED|NOT_AVAILABLE)\]?[\s*_`.。!！]*$/;

/**
 * Extract the trailing status tag from a streaming response.
 * Robust to minor LLM deviations (optional brackets, surrounding markdown
 * emphasis/punctuation, trailing whitespace).
 */
export function extractStatus(text: string): AskStatus {
  const m = text.match(TRAILING_STATUS_RE);
  return (m ? (m[1] as AskStatus) : null);
}

/**
 * Strip the trailing status tag from a response for cleaner display. Loops
 * a few times so a model that echoes the tag twice at the very end (rare,
 * but observed from a local model) doesn't leave the earlier copy visible.
 */
export function stripStatusTag(text: string): string {
  let result = text;
  for (let i = 0; i < 3; i += 1) {
    const next = result.replace(TRAILING_STATUS_RE, '').trimEnd();
    if (next === result) break;
    result = next;
  }
  return result;
}

// ─── Capability-question detection (main AI Chat grounding) ──────────────────

export function isCapabilityQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  // Include both hiragana できる and the common kanji form 出来る.
  const jaPatterns =
    /(何が(でき|出来)|なにが(でき|出来)|使い方|使えます?か|使える(の|機能|？|\?)|って機能|機能あります?か|機能ある|(でき|出来)ます?か|(でき|出来)るの|(でき|出来)る[？?]|どうやって|やり方|の仕方|設定方法|方法(を|は)教えて)/;
  const enPatterns =
    /\b(what can (you|shelly) do|how do i\b|how to\b|how can i\b|can shelly\b|does shelly\b|is there a way to\b|what features\b|what does shelly\b|how does shelly\b|are you able to\b)/;

  return jaPatterns.test(trimmed) || enPatterns.test(lower);
}

const CAPABILITY_GROUNDING_PRIMER =
  "The user's message looks like a question about what Shelly can do or how " +
  'to use it. Answer grounded in Shelly\'s real feature catalog below — be ' +
  'concrete, reference actual feature names, and do not invent capabilities ' +
  "that aren't listed. If nothing below covers what they're asking, say so " +
  'plainly instead of guessing.';

const AMBIENT_CAPABILITY_PRIMER =
  "For reference (not necessarily relevant to this message) — Shelly's real " +
  'feature names. If the user asks what Shelly can do or how to use ' +
  "something, answer grounded in this list and don't invent capabilities " +
  "that aren't in it. When the question is broad (e.g. \"what can you do?\"), " +
  'summarize by a handful of categories with 1-2 concrete examples each — do ' +
  'NOT enumerate every single item in the list, that produces a wall of text ' +
  "that gets cut off before it finishes. Otherwise ignore this block and " +
  'answer normally.';

function getCompactFeatureNames(): string {
  return FEATURE_CATALOG.map((feature) => feature.name).join(', ');
}

export function buildCapabilityGroundingBlock(compact = false): string {
  const catalog = compact ? getCompactFeatureNames() : getCompressedCatalog();
  return `${CAPABILITY_GROUNDING_PRIMER}\n\n<SHELLY_FEATURES>\n${catalog}\n</SHELLY_FEATURES>`;
}

/** Always-present names-only catalog for every main AI Chat provider. */
export function buildAmbientCapabilityBlock(): string {
  return `${AMBIENT_CAPABILITY_PRIMER}\n\n<SHELLY_FEATURES>\n${getCompactFeatureNames()}\n</SHELLY_FEATURES>`;
}
