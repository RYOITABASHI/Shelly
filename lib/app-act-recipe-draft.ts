/**
 * lib/app-act-recipe-draft.ts — app.act Phase 1 (docs/superpowers/DEFERRED.md
 * "段階的汎用化Phase 1": 観測専用accessibility-tree snapshot→レシピ下書き生成
 * →ユーザー保存).
 *
 * Until now, adding a NEW app.act recipe (beyond the two bundled ones,
 * line.send-message / x.post) meant hand-writing recipe JSON after reading a
 * logcat node dump — see ShellyAccessibilityService.kt's dumpNode/
 * "ShellyA11yDump" tag. This module turns a structured screen snapshot
 * (captured read-only via TerminalEmulator.captureAppActScreenSnapshot(),
 * bounded to whatever the Accessibility Service's own package allowlist
 * already covers — LINE/X, see that native function's doc comment) into a
 * DRAFT recipe the user reviews/edits before saving — never auto-saved,
 * never auto-run.
 *
 * The heuristic here targets the one UI shape every bundled recipe already
 * has: an editable text field, then a nearby "send"-like button. It is
 * deliberately narrow and best-effort — a human confirms/edits the result
 * before anything is written to disk (see buildAppActRecipeSaveCommand).
 *
 * Draft ids are namespaced with the `user.` prefix — AppActRecipeStore.kt's
 * loader (native) treats that prefix as the signal to resolve from
 * `$HOME/.shelly/app-act-recipes/` instead of the bundled APK assets, and
 * never lets a drafted recipe collide with a bundled id.
 */
import { getHomePath } from '@/lib/home-path';

export interface AppActSnapshotNode {
  className: string;
  resourceId: string;
  contentDescription: string;
  text: string;
  clickable: boolean;
  editable: boolean;
  bounds: string;
}

/** Raw shape returned (as a JSON string) by
 *  TerminalEmulator.captureAppActScreenSnapshot() — `error` is set instead
 *  of `pkg`/`nodes` when the service isn't connected or the foreground app
 *  isn't in the app.act allowlist. */
export interface AppActSnapshot {
  pkg?: string;
  nodes?: AppActSnapshotNode[];
  error?: string;
}

export interface AppActRecipeMatcher {
  resourceId?: string;
  contentDescription?: string;
  text?: string;
}

export type AppActRecipeStepOp = 'launch' | 'click' | 'setText';

export interface AppActRecipeStep {
  op: AppActRecipeStepOp;
  matcher?: AppActRecipeMatcher;
  param?: string;
  target?: string;
  intent: string;
}

export interface AppActRecipeParamSpec {
  name: string;
  description: string;
  required: boolean;
}

/** Mirrors AppActRecipeStore.kt's Recipe data class exactly — keep both in
 *  sync if either schema changes. */
export interface AppActRecipeDraft {
  id: string;
  pkg: string;
  operation: string;
  displayName: string;
  tier: string;
  params: AppActRecipeParamSpec[];
  steps: AppActRecipeStep[];
}

export const USER_APP_ACT_RECIPE_ID_PREFIX = 'user.';
/** Byte-identical to AppActRecipeStore.kt's SAFE_USER_RECIPE_ID_RE — keep
 *  both in sync. */
export const SAFE_USER_APP_ACT_RECIPE_ID_RE = /^user\.[A-Za-z0-9_-]+$/;

const SEND_LIKE_KEYWORDS = [
  'send', 'post', 'submit', 'ok', 'done', 'confirm', 'save', 'reply',
  '送信', '投稿', '送る', '完了', '返信', '保存', 'ポスト',
];

function isSendLikeNode(node: AppActSnapshotNode): boolean {
  if (!node.clickable) return false;
  const label = `${node.text} ${node.contentDescription}`.toLowerCase();
  return SEND_LIKE_KEYWORDS.some((kw) => label.includes(kw.toLowerCase()));
}

/** Prefer the single most specific field, mirroring the bundled recipes'
 *  own matcher style (resourceId alone when available — see
 *  x.post.json/line.send-message.json) rather than an AND of every
 *  available field, which would make the drafted matcher needlessly
 *  brittle to any one field changing on a future app update. */
function matcherForNode(node: AppActSnapshotNode): AppActRecipeMatcher | null {
  if (node.resourceId) return { resourceId: node.resourceId };
  if (node.contentDescription) return { contentDescription: node.contentDescription };
  if (node.text) return { text: node.text };
  return null;
}

export function slugifyAppActRecipeName(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'recipe';
}

/**
 * Draft a recipe from a captured snapshot. Returns `{ error }` (never
 * throws) when the snapshot itself failed (service not connected /
 * non-allowlisted app) or when the heuristic can't find both an editable
 * field and a plausible send-like button — in either case there is nothing
 * safe to draft, and the caller should tell the user to try again on a
 * screen with a visible text field + send/post/submit button.
 */
export function draftAppActRecipeFromSnapshot(
  snapshot: AppActSnapshot,
  displayName: string,
): AppActRecipeDraft | { error: string } {
  if (snapshot.error) return { error: snapshot.error };
  const pkg = snapshot.pkg;
  const nodes = snapshot.nodes ?? [];
  if (!pkg || nodes.length === 0) {
    return { error: 'No screen data was captured. Make sure the target app is in the foreground.' };
  }

  // Nodes arrive in traversal order (same order the screen renders/reads
  // top-to-bottom for a typical single-column chat/compose layout), so the
  // LAST editable node is the best guess for "the message/compose field"
  // rather than an earlier search box or unrelated input higher up.
  let textFieldIndex = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].editable) {
      textFieldIndex = i;
      break;
    }
  }
  if (textFieldIndex === -1) {
    return { error: 'No editable text field found on this screen.' };
  }
  const textFieldMatcher = matcherForNode(nodes[textFieldIndex]);
  if (!textFieldMatcher) {
    return { error: 'The text field has no resourceId, contentDescription, or text to match on.' };
  }

  // A send/post button logically comes AFTER the field it sends, but is not
  // guaranteed to be later in traversal order (e.g. a top app-bar action) —
  // search the whole node list for the best keyword match, preferring one
  // that appears after the field when there is a choice.
  const keywordMatches = nodes.filter(isSendLikeNode);
  const sendNode =
    keywordMatches.find((n) => nodes.indexOf(n) > textFieldIndex) ?? keywordMatches[0] ?? null;
  if (!sendNode) {
    return { error: 'No send/post/submit-like button found on this screen.' };
  }
  const sendMatcher = matcherForNode(sendNode);
  if (!sendMatcher) {
    return { error: 'The send button has no resourceId, contentDescription, or text to match on.' };
  }

  const id = `${USER_APP_ACT_RECIPE_ID_PREFIX}${slugifyAppActRecipeName(displayName)}`;
  return {
    id,
    pkg,
    operation: 'custom',
    displayName: displayName.trim() || id,
    tier: 'draft',
    params: [{ name: 'text', description: 'Message text', required: true }],
    steps: [
      { op: 'launch', target: pkg, intent: `Bring the target app to the foreground (or launch it) so the rest of the recipe has a window to act on.` },
      { op: 'setText', matcher: textFieldMatcher, param: 'text', intent: 'Type into the drafted text field.' },
      { op: 'click', matcher: sendMatcher, intent: 'Tap the drafted send/post/submit button.' },
    ],
  };
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function appActRecipesDir(): string {
  return `${getHomePath()}/.shelly/app-act-recipes`;
}

/**
 * Build the crash-safe shell command that saves a user-drafted recipe to
 * `$HOME/.shelly/app-act-recipes/<id>.json`, so AppActRecipeStore.kt's
 * `user.`-prefixed loader path picks it up on the very next
 * fireAgentAppAct()/debug-run call — no separate registration step needed.
 * Same defensive pattern as lib/agent-memory.ts's buildMemoryWriteCommand:
 * `set -e`, a heredoc with a unique marker (no injection / no premature
 * EOF), and a post-write `[ -s ]` assert so a silent failure surfaces
 * loudly instead of pretending success.
 *
 * Throws synchronously (before returning any command string) if `recipe.id`
 * is not a `user.`-prefixed safe id — this must never be used to write
 * outside the user-recipe namespace, matching the same
 * SAFE_USER_APP_ACT_RECIPE_ID_RE the native loader enforces on read.
 *
 * Codex review (2026-08-29, app.act Phase 1 batch), P0: a saved recipe is a
 * plain on-disk JSON file, so its content can drift after a human reviewed
 * it once at agent-registration time — e.g. a later `cli` action (itself
 * separately approval-gated) could rewrite the SAME file to retarget an
 * already-approved agent's app-act action without any new review surfacing.
 * `chmod 444` after the write does not make this impossible (anything with
 * shell access can chmod it back before rewriting), but it does turn a
 * casual/accidental overwrite into a deliberate two-step action, which is
 * a real, cheap narrowing of the risk to ship now. A full fix — binding a
 * content hash into the agent's registration/approval record and rejecting
 * at execution time if the loaded recipe's hash has changed — is tracked
 * as a follow-up in docs/superpowers/DEFERRED.md rather than rushed into
 * this pass.
 */
export function buildAppActRecipeSaveCommand(recipe: AppActRecipeDraft): string {
  if (!SAFE_USER_APP_ACT_RECIPE_ID_RE.test(recipe.id)) {
    throw new Error(`refusing to save app.act recipe with unsafe id: ${recipe.id}`);
  }
  const dir = appActRecipesDir();
  const file = `${dir}/${recipe.id}.json`;
  const marker = `SHELLY_APPACT_RECIPE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const json = JSON.stringify(recipe, null, 2);
  return [
    `set -e`,
    `mkdir -p ${shellQuote(dir)}`,
    // A re-save under the SAME id (e.g. redrafting after a mistake) must
    // still work even though the previous save left the file read-only —
    // restore write permission first (best-effort; a fresh file has
    // nothing to chmod, hence the trailing `|| true`).
    `chmod u+w ${shellQuote(file)} 2>/dev/null || true`,
    `cat > ${shellQuote(file)} <<'${marker}'`,
    json,
    marker,
    `[ -s ${shellQuote(file)} ] || { echo "app.act recipe save failed: ${recipe.id}" >&2; exit 1; }`,
    `chmod 444 ${shellQuote(file)}`,
  ].join('\n');
}
