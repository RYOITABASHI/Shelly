/**
 * lib/companion-greeting.ts
 *
 * Design 2-a ("welcome back" session-start greeting) + Design 2-b ("keep an
 * eye on X" watch-note preference), 2026-08-28 — Fable5 minimal-slice
 * proactivity pass. Shelly's AI companion currently only surfaces memory
 * when asked; this is the smallest step toward it initiating a "welcome
 * back" line on its own, the first time an AI Pane is opened in a fresh app
 * process, IF there's something recent worth mentioning.
 *
 * Same pure-gate-function + separate-builder-function shape as
 * lib/agent-onboarding-nudge.ts: the gate is a plain boolean function with
 * no IO, unit-testable offline, and the caller (components/panes/AIPane.tsx)
 * appends an ordinary assistant ChatMessage when it returns true. Never a
 * modal/card — see CLAUDE.md's "旧 AuthWizard / WelcomeWizard は廃止" and
 * this codebase's standing no-confirm-card rule.
 *
 * ─── Why this must be template-based, never LLM-generated ───────────────────
 *
 * Shelly's default local model (Qwen3.5-2B) has a known quality-floor
 * problem — self-generated fake confirmations, refusal-flavored non-answers
 * (see CLAUDE.md's Local LLM section). Handing it "write a warm welcome-back
 * line" with no grounding would risk exactly that failure mode showing up as
 * the companion's unprompted FIRST word in a session, which is the worst
 * possible place for it. So the greeting is assembled deterministically from
 * a real note's text via i18n templates (buildCompanionGreetingText below) —
 * it never calls any model.
 *
 * ─── Two note sources ────────────────────────────────────────────────────────
 *
 *  - "Journal" notes: the companion-journal (`_companion` memory scope,
 *    lib/companion-journal.ts's digestConversationForJournal) — an automatic
 *    summary written when a conversation thread is left. This is the
 *    ordinary "what were we talking about" case.
 *  - "Watch" notes: `_global` memory-scope notes whose body was prefixed
 *    "[watch] " because they were written via an explicit "keep an eye on
 *    X" / "気にかけておいて" phrase (lib/agent-global-memory-intent.ts's
 *    GlobalMemoryWriteIntent.kind, resolved in
 *    hooks/use-ai-pane-dispatch.ts's pendingGlobalMemory confirm branch).
 *    pickGreetingNote below prefers a fresh watch note over a fresh journal
 *    note, since the user explicitly asked to be reminded about it.
 */

export type TranslationFunction = (key: string, params?: Record<string, string | number>) => string;

/** 7 days, in ms — the recency window for both note sources. */
export const GREETING_MAX_NOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Interpolated `{{topic}}` is truncated to roughly this many characters. */
const TOPIC_MAX_CHARS = 60;

/** Marker prefix a watch-triggered `_global` note is saved with on disk. */
export const WATCH_NOTE_PREFIX = '[watch] ';

// ─── Module-level "shown this process" flag ─────────────────────────────────
//
// Deliberately a plain in-memory variable, NOT a new settings-store field
// and NOT any new persisted flag — this project has a standing preference
// for trigger-and-react designs over adding new persistent storage. Showing
// the greeting once per app-process-lifetime (i.e. again after every real
// app restart, same as e.g. a splash screen) is the INTENDED behavior here,
// not a bug to fix later.
let shownThisProcess = false;

/** True once the greeting has already been shown in this app process. */
export function hasShownCompanionGreetingThisProcess(): boolean {
  return shownThisProcess;
}

/** Mark the greeting as shown for the remainder of this app process. */
export function markCompanionGreetingShown(): void {
  shownThisProcess = true;
}

// bug #169 (found 2026-08-29 on-device: the identical "Welcome back..." line
// appeared twice in a row in the same app process). Root cause: the caller
// (AIPane.tsx) checks hasShownCompanionGreetingThisProcess() before starting
// async disk reads and again after they resolve, but nothing stopped two
// concurrent invocations (e.g. two AIPane effect runs racing) from both
// passing the "not shown yet" check before either had called
// markCompanionGreetingShown(). This separate claim flag lets the caller
// reserve the one-shot attempt atomically, synchronously, before any await —
// so a second concurrent caller bails out before it ever touches disk.
let attemptClaimed = false;

/**
 * Atomically claim this process's single greeting attempt. Must be called
 * synchronously, before starting the async note reads that decide whether to
 * actually show anything. Returns false for every caller after the first —
 * including when the first caller ultimately shows nothing (no eligible
 * note, pane unmounted, etc.). "At most once per process" is the invariant
 * this exists to guarantee, not "exactly once when eligible".
 */
export function tryClaimCompanionGreetingAttempt(): boolean {
  if (attemptClaimed) return false;
  attemptClaimed = true;
  return true;
}

/** Test-only: reset the module-level flags between test cases. */
export function resetCompanionGreetingShownForTests(): void {
  shownThisProcess = false;
  attemptClaimed = false;
}

/**
 * true iff the companion "welcome back" greeting should be appended to this
 * pane's conversation right now:
 *  - at least one journal/watch note exists, AND
 *  - the newest such note is within the 7-day recency window (both bounds
 *    inclusive of 0, exclusive past the boundary — a note written exactly
 *    7*24h ago still counts; a moment older does not), AND
 *  - the companion conversation already has at least one existing message
 *    (a brand-new user with zero conversation history is
 *    lib/agent-onboarding-nudge.ts's territory, not this one — this
 *    greeting is about picking up a THREAD, which requires one to exist),
 *    AND
 *  - it hasn't already been shown this process.
 */
export function shouldShowCompanionGreeting(
  hasJournalNotes: boolean,
  newestNoteAgeMs: number,
  conversationLength: number,
  alreadyShownThisProcess: boolean,
): boolean {
  if (alreadyShownThisProcess) return false;
  if (!hasJournalNotes) return false;
  if (!Number.isFinite(newestNoteAgeMs)) return false;
  if (newestNoteAgeMs < 0 || newestNoteAgeMs > GREETING_MAX_NOTE_AGE_MS) return false;
  if (conversationLength < 1) return false;
  return true;
}

function truncateTopic(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TOPIC_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TOPIC_MAX_CHARS).trim()}…`;
}

/** Strip the on-disk "[watch] " marker before it's ever shown to the user. */
export function stripWatchPrefix(text: string): string {
  return text.startsWith(WATCH_NOTE_PREFIX) ? text.slice(WATCH_NOTE_PREFIX.length) : text;
}

/**
 * Build the greeting text. Deterministic template interpolation only — see
 * the module doc for why this must never be handed to the local model.
 * `isWatch` (Design 2-b) picks the watch-flavored template
 * (chat.companion_greeting_watch) over the plain one (chat.companion_greeting)
 * when the referenced note came from an explicit watch-phrase.
 */
export function buildCompanionGreetingText(
  newestNoteText: string,
  t: TranslationFunction,
  isWatch: boolean = false,
): string {
  const topic = truncateTopic(stripWatchPrefix(newestNoteText));
  return t(isWatch ? 'chat.companion_greeting_watch' : 'chat.companion_greeting', { topic });
}

/** Minimal shape pickGreetingNote needs — matches lib/agent-memory.ts's MemoryNote. */
export interface GreetingNoteCandidate {
  text: string;
  /** ISO-8601 creation timestamp, same field name as MemoryNote.created. */
  created: string;
}

export interface SelectedGreetingNote {
  /** Raw note text, still carrying the "[watch] " prefix when isWatch is true. */
  text: string;
  ageMs: number;
  isWatch: boolean;
}

/**
 * Pick which note the greeting should reference out of two candidate pools:
 * `watchNotes` (already filtered to WATCH_NOTE_PREFIX-tagged `_global`
 * notes) and `journalNotes` (companion-journal `_companion` notes). A fresh
 * watch note wins over a fresh journal note — the user explicitly asked to
 * be reminded about it — but only when it is itself within the recency
 * window; an old watch note never displaces a fresh journal note. Returns
 * null when neither pool has anything within the window.
 */
export function pickGreetingNote(
  journalNotes: GreetingNoteCandidate[],
  watchNotes: GreetingNoteCandidate[],
  nowMs: number,
): SelectedGreetingNote | null {
  const ageOf = (note: GreetingNoteCandidate): number => nowMs - Date.parse(note.created);
  const withinWindow = (note: GreetingNoteCandidate): boolean => {
    const age = ageOf(note);
    return Number.isFinite(age) && age >= 0 && age <= GREETING_MAX_NOTE_AGE_MS;
  };
  const newestWithinWindow = (notes: GreetingNoteCandidate[]): GreetingNoteCandidate | undefined =>
    notes
      .filter(withinWindow)
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];

  const watch = newestWithinWindow(watchNotes);
  if (watch) {
    return { text: watch.text, ageMs: ageOf(watch), isWatch: true };
  }
  const journal = newestWithinWindow(journalNotes);
  if (journal) {
    return { text: journal.text, ageMs: ageOf(journal), isWatch: false };
  }
  return null;
}
