/**
 * lib/nacre-bridge-context.ts — Shelly → Nacre bridge (feature B).
 *
 * While Shelly is in the foreground, share a small, sanitized slice of the
 * current terminal context (cwd path segments, repo/branch, "safe" recent
 * command terms) with the Nacre IME (space.manus.nacre) so its henkan
 * (conversion) candidates can be biased toward the user's current work.
 *
 * Shelly and Nacre are signed with different keys, so ContentProvider +
 * signature permissions are not available, and Binder/Intent bridges have
 * caused Knox sepolicy trouble before (see CLAUDE.md's shell→RN bridge
 * entry). This uses a shared-storage file instead:
 *
 *   /storage/emulated/0/Android/media/dev.shelly.terminal/nacre-bridge/context.json
 *
 * This is a FIXED CONTRACT agreed with the Nacre side (file path, JSON
 * schema, sanitization rules) — do not change it without updating both
 * sides in lockstep.
 *
 * Raw command text is NEVER written verbatim. sanitizeTerms() below is a
 * pure, independently unit-tested function that extracts only tokens that
 * survive a strict allow-list + secret/entropy deny-list pipeline. The same
 * character-class check is applied to cwd path segments and repo/branch
 * names as a defense against unexpected characters leaking through.
 */

import * as FileSystem from 'expo-file-system/legacy';

// ─── Contract constants ─────────────────────────────────────────────────────

/** Directory Nacre reads from. `Android/media` (not `Android/data`) is
 *  shared storage with looser cross-app read access than app-private dirs. */
export const NACRE_BRIDGE_DIR =
  '/storage/emulated/0/Android/media/dev.shelly.terminal/nacre-bridge';

export const NACRE_BRIDGE_FILE_PATH = `${NACRE_BRIDGE_DIR}/context.json`;

/** Context is considered stale after this long — Nacre must not trust an
 *  entry whose `expiresAt` is in the past. */
export const NACRE_BRIDGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Hard cap on the number of extracted terms. */
export const NACRE_BRIDGE_MAX_TERMS = 20;

export interface NacreBridgeContext {
  schema: 1;
  generatedAt: number;
  expiresAt: number;
  repo?: string;
  branch?: string;
  cwdSegments: string[];
  terms: string[];
}

export interface NacreBridgeContextInput {
  /** Absolute current working directory. */
  cwd: string;
  /** Git repository name (e.g. "Shelly"), if resolvable. */
  repo?: string;
  /** Git branch name (e.g. "main"), if resolvable. */
  branch?: string;
  /** Recent raw command strings (terminal-store command history), most
   *  recent first or last — order only affects which terms are kept once
   *  the 20-item cap is hit. */
  recentCommands: string[];
  /** Injected clock for deterministic tests; defaults to Date.now(). */
  now?: number;
}

// ─── Sanitization: shared character-class gate ─────────────────────────────

/**
 * Step 6 of the sanitization pipeline (see module doc): alnum + `_.-/` only,
 * 1-40 chars. Applied to every surviving command term AND to cwd path
 * segments / repo / branch as a second line of defense against stray
 * unexpected characters.
 */
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.\-\/]{1,40}$/;

export function isSafeToken(value: string): boolean {
  return SAFE_TOKEN_RE.test(value);
}

// ─── Sanitization: command-term extraction pipeline ────────────────────────

/** Known secret-value prefixes (step 4). Case-sensitive — these are real
 *  provider token formats and are defined with a fixed case. */
const SECRET_PREFIXES = [
  'sk-',
  'ghp_',
  'github_pat_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  'ASIA',
  'AIza',
  'ya29.',
  'eyJ', // JWT header ("{" base64-encoded) — covers Bearer JWTs
];

/** High-entropy string shapes (step 5): base64-ish or hex-ish, 20+ chars. */
const HIGH_ENTROPY_BASE64_RE = /^[A-Za-z0-9+/=]{20,}$/;
const HIGH_ENTROPY_HEX_RE = /^[0-9a-fA-F]{20,}$/;

/** Flag / env-var assignments that carry a secret-shaped name, e.g.
 *  `--token=abc`, `Authorization:Bearer-xyz`, `KEY=...`, `PASSWORD=...`,
 *  `SECRET=...`, `API_KEY=...` — step 3's first bullet. Anchored (`^...$`)
 *  and applied to ONE already-split token at a time (see
 *  extractSafeTermsFromCommand below) rather than the raw command string:
 *  applying it unanchored across a whole whitespace-delimited run before
 *  splitting would let a single `?`-attached match (e.g.
 *  `api/resource?token=abc123`) swallow the safe path prefix along with
 *  the secret suffix. Case-insensitive: env var names and flags vary in
 *  case across tools. */
const SECRET_ASSIGNMENT_RE = /^\S*(?:token|password|secret|key|auth)\S*[:=]\S*$/i;

/** Shell-ish separators used to split a command into candidate tokens:
 *  whitespace plus the common pipe/redirect/grouping punctuation. */
const SHELL_SEPARATOR_RE = /[\s|;&<>(){}]+/;

/**
 * Unwraps or drops quoted spans (step 3's third bullet) before tokenizing.
 * A quoted span whose INNER content is longer than 20 chars is dropped
 * entirely (quotes + content); a short quoted span has its quotes removed
 * so the inner text re-enters the token stream as plain words, still
 * subject to every later filter.
 */
function stripLongQuotedSpans(command: string): string {
  return command.replace(/"([^"]*)"|'([^']*)'/g, (_match, dq, sq) => {
    const inner: string = dq !== undefined ? dq : sq;
    if (inner.length > 20) return ' ';
    return ` ${inner} `;
  });
}

/** Step 2's URL-query-parameter bullet: drop everything from the first `?`
 *  onward in a single token (covers both absolute and schemeless paths —
 *  an absolute `https://...` token is excluded anyway once `:` hits the
 *  step-6 char-class gate, but a schemeless `api/resource?token=x` would
 *  otherwise leak the query string). */
function stripUrlQuery(token: string): string {
  const qIndex = token.indexOf('?');
  return qIndex === -1 ? token : token.slice(0, qIndex);
}

function hasSecretPrefix(token: string): boolean {
  return SECRET_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function isHighEntropy(token: string): boolean {
  return HIGH_ENTROPY_BASE64_RE.test(token) || HIGH_ENTROPY_HEX_RE.test(token);
}

/**
 * Full token safety check: char-class gate AND secret-prefix AND high-entropy
 * rejection. `sanitizeTerms()` already applies all three per-token via
 * `extractSafeTermsFromCommand`; this is the same bar applied to cwd path
 * segments and repo/branch, which previously only went through the
 * char-class gate (`isSafeToken`) — a directory or branch literally named
 * e.g. `sk-testtoken` or a 20+ char hex/base64-looking string would pass the
 * char-class check and get written to shared storage even though Nacre's
 * own re-filter would later drop it — the leak onto disk already happened by
 * then (Codex review, 2026-08-30).
 */
function isSafeAndUnsecretive(value: string): boolean {
  return isSafeToken(value) && !hasSecretPrefix(value) && !isHighEntropy(value);
}

/** Extracts the "safe technical terms" allow-listed by the bridge contract
 *  out of one raw command string. Pure function — no I/O.
 *
 *  Order matters: tokenize (on whitespace/shell separators) BEFORE running
 *  the per-token secret-assignment / prefix / entropy / char-class checks,
 *  so each check only ever sees one already-whitespace-bounded candidate
 *  and can't bleed across an unrelated safe prefix (see SECRET_ASSIGNMENT_RE's
 *  doc comment for the specific bug this avoids). */
function extractSafeTermsFromCommand(command: string): string[] {
  const withoutQuotedSpans = stripLongQuotedSpans(command);
  const rawTokens = withoutQuotedSpans.split(SHELL_SEPARATOR_RE).filter(Boolean);

  const kept: string[] = [];
  for (const rawToken of rawTokens) {
    const token = stripUrlQuery(rawToken);
    if (!token) continue;
    if (SECRET_ASSIGNMENT_RE.test(token)) continue;
    if (hasSecretPrefix(token)) continue;
    if (isHighEntropy(token)) continue;
    if (!isSafeToken(token)) continue;
    kept.push(token);
  }
  return kept;
}

/**
 * Full sanitization pipeline for the bridge's `terms` field: given raw
 * recent command strings, returns a deduplicated list of "safe technical
 * terms" (command names, flags without values, file paths, project/tool
 * identifiers) with all secret-shaped, high-entropy, and oddly-charactered
 * content removed. Never includes anything not already present verbatim in
 * the input, and never invents or reorders content across commands beyond
 * dedup + truncation.
 *
 * Pure function — safe to unit test directly, no mocking required.
 */
export function sanitizeTerms(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const command of commands) {
    if (typeof command !== 'string' || !command.trim()) continue;
    for (const term of extractSafeTermsFromCommand(command)) {
      if (seen.has(term)) continue;
      seen.add(term);
      result.push(term);
      if (result.length >= NACRE_BRIDGE_MAX_TERMS) return result;
    }
  }
  return result;
}

// ─── Sanitization: path / repo / branch ────────────────────────────────────

/** Splits an absolute (or relative) path into its non-empty segments and
 *  drops any segment that doesn't pass the full token safety check (char
 *  class + secret-prefix + high-entropy — see isSafeAndUnsecretive). */
export function sanitizeCwdSegments(cwd: string): string[] {
  if (typeof cwd !== 'string' || !cwd) return [];
  return cwd
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter(isSafeAndUnsecretive);
}

/** Repo/branch are single free-text-ish values from git; omit the field
 *  entirely (never coerce to '') if it's missing or fails the full token
 *  safety check (char class + secret-prefix + high-entropy) — matches the
 *  contract's "省略可...空文字列にしない" rule. */
export function sanitizeRepoOrBranch(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isSafeAndUnsecretive(trimmed) ? trimmed : undefined;
}

// ─── JSON assembly ──────────────────────────────────────────────────────────

/** Builds the exact JSON contract object (does not write it). Pure
 *  function — the caller decides when/whether to persist it. */
export function buildNacreBridgeContext(input: NacreBridgeContextInput): NacreBridgeContext {
  const now = input.now ?? Date.now();
  const context: NacreBridgeContext = {
    schema: 1,
    generatedAt: now,
    expiresAt: now + NACRE_BRIDGE_TTL_MS,
    cwdSegments: sanitizeCwdSegments(input.cwd),
    terms: sanitizeTerms(input.recentCommands),
  };
  const repo = sanitizeRepoOrBranch(input.repo);
  if (repo) context.repo = repo;
  const branch = sanitizeRepoOrBranch(input.branch);
  if (branch) context.branch = branch;
  return context;
}

// ─── File I/O (device only) ─────────────────────────────────────────────────

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** Writes the context file, creating the shared-storage directory first if
 *  needed. Requires MANAGE_EXTERNAL_STORAGE (already held by this app —
 *  see lib/first-launch-setup.ts). Best-effort: throws on failure so the
 *  caller can log/ignore, matching the other fire-and-forget bridge writes
 *  in this codebase (e.g. saveSessionState). */
export async function writeNacreBridgeContext(context: NacreBridgeContext): Promise<void> {
  const dirUri = toFileUri(NACRE_BRIDGE_DIR);
  const info = await FileSystem.getInfoAsync(dirUri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
  }
  await FileSystem.writeAsStringAsync(toFileUri(NACRE_BRIDGE_FILE_PATH), JSON.stringify(context));
}

/** Invalidates the shared context when Shelly leaves the foreground.
 *  Deletes the file outright (simplest correct way to make it
 *  unavailable); idempotent, and swallows errors since this is a
 *  best-effort courtesy cleanup, not a safety boundary — the `expiresAt`
 *  TTL is the actual safety net if deletion fails for any reason. */
export async function invalidateNacreBridgeContext(): Promise<void> {
  try {
    await FileSystem.deleteAsync(toFileUri(NACRE_BRIDGE_FILE_PATH), { idempotent: true });
  } catch {
    // best-effort cleanup only
  }
}
