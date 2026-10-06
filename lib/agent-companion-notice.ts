import { COMPANION_CONVERSATION_KEY, agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import type { AgentRunLog, ChatMessage } from '@/store/types';
import { buildHandoffDigest, type HandoffTranslate } from '@/lib/agent-handoff';
import { logInfo } from '@/lib/debug-logger';

export type AgentRunHistory = Record<string, AgentRunLog[]>;

export function agentRunLogIdentity(log: Pick<AgentRunLog, 'agentId' | 'timestamp'>): string {
  return `${log.agentId}:${log.timestamp}`;
}

export function buildAgentCompanionNotice(
  log: AgentRunLog,
  agentName: string,
  fallbackText: string,
): ChatMessage {
  const preview = (log.outputPreview || '').trim();
  const icon = log.status === 'error' ? '❌' : log.status === 'skipped' ? '⏭️' : '✅';
  const resultLine = preview ? `${icon} ${preview}` : `${icon} ${fallbackText}`;
  const runIdentity = agentRunLogIdentity(log);
  const now = Date.now();
  return {
    id: `agent-run-${runIdentity}-${now.toString(36)}`,
    role: 'assistant',
    content: `${agentName}: ${resultLine}`,
    timestamp: now,
    agentRunLogId: runIdentity,
  };
}

/** Sidebar attended-run start hook: append an independent in-progress notice. */
export function postAgentRunStartedNotice(agentId: string, agentName: string): void {
  const now = Date.now();
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: `agent-run-started-${agentId}-${now.toString(36)}`,
    role: 'assistant',
    content: `${agentName}: ⏳ Running`,
    timestamp: now,
  });
}

/** Add one completion notice, unless this exact on-disk run is already present. */
export function postAgentCompanionNotice(
  log: AgentRunLog,
  agentName: string,
  fallbackText: string,
): boolean {
  const store = useAIPaneStore.getState();
  const runIdentity = agentRunLogIdentity(log);
  const messages = store.conversations[COMPANION_CONVERSATION_KEY]?.messages ?? [];
  if (messages.some((message) => message.agentRunLogId === runIdentity)) return false;
  store.addMessage(
    COMPANION_CONVERSATION_KEY,
    buildAgentCompanionNotice(log, agentName, fallbackText),
  );
  return true;
}

/** Sidebar attended-run success hook: surface the latest log synchronized by runAgentNow. */
export function postLatestAgentRunToCompanion(
  agentId: string,
  agentName: string,
  fallbackText: string,
): boolean {
  const log = useAgentStore.getState().getRunHistory(agentId).at(-1);
  return log ? postAgentCompanionNotice(log, agentName, fallbackText) : false;
}

// Fixed id (not per-timestamp, unlike the run-started/run-completed notices
// above) so a within-session dedup check is a plain lookup rather than a
// scan for a marker field — there is only ever at most ONE of these in a
// conversation, ever.
const COMPANION_JOURNAL_DORMANT_NOTICE_ID = 'companion-journal-dormant-notice';

/**
 * Companion journal dormancy notice (Fable5 review Gap A, 2026-08-25): posts
 * ONE plain-chat-text line — never a card/modal, see this session's standing
 * no-confirm-card rule and lib/agent-onboarding-nudge.ts's sibling comment —
 * the first time lib/companion-journal.ts's digestConversationForJournal
 * detects it had something worth journaling but no local LLM configured to
 * write it with (its `onDormant` callback).
 *
 * Idempotent WITHIN a session via the fixed id above (same "check messages
 * before appending" shape as postAgentCompanionNotice's agentRunLogId
 * check). The CALLER (components/panes/AIPane.tsx) is additionally
 * responsible for checking AppSettings.companionJournalDormancyNoticeShown
 * before calling this, and flipping it true after a `true` result, so the
 * notice also never resurfaces across app restarts — this function alone
 * has no settings-store access, consistent with every other export in this
 * file being conversation/run-log-scoped, not settings-scoped.
 */
export function postCompanionJournalDormancyNotice(noticeText: string): boolean {
  const store = useAIPaneStore.getState();
  const messages = store.conversations[COMPANION_CONVERSATION_KEY]?.messages ?? [];
  if (messages.some((message) => message.id === COMPANION_JOURNAL_DORMANT_NOTICE_ID)) return false;
  store.addMessage(COMPANION_CONVERSATION_KEY, {
    id: COMPANION_JOURNAL_DORMANT_NOTICE_ID,
    role: 'assistant',
    content: noticeText,
    timestamp: Date.now(),
  });
  return true;
}

// ─── Agent hand-off narration (lib/agent-handoff.ts) ─────────────────────────

/**
 * Process-lifetime set of run identities (`<agentId>:<timestamp>`) whose
 * hand-off lines were already posted LIVE by the attended chain, so the
 * periodic disk sync never replays the same run a second time as a digest.
 * The persisted-thread check in postAgentHandoffDigest covers restarts.
 */
const narratedHandoffRuns = new Set<string>();

/** Attended path: mark the aggregate run log as already narrated live. */
export function markAgentHandoffRunNarrated(log: Pick<AgentRunLog, 'agentId' | 'timestamp'>): void {
  narratedHandoffRuns.add(agentRunLogIdentity(log));
}

/** Append ONE hand-off line to the agent's own `agent:<id>` thread. Plain
 *  system text (excluded from LLM history and thread carry-forward by role). */
export function postAgentHandoffLine(agentId: string, runId: string, seq: number, text: string): void {
  const now = Date.now();
  if (seq === 0) collapseOlderHandoffRuns(agentThreadKey(agentId), runId);
  useAIPaneStore.getState().addMessage(agentThreadKey(agentId), {
    id: `handoff-${runId}-${seq}-${now.toString(36)}`,
    role: 'system',
    content: text,
    timestamp: now,
    handoff: { runId, seq },
  });
  logInfo('Handoff', `posted line ${seq} for ${runId}`);
}

/**
 * Growth bound for the 200-message per-thread cap: when a NEW run starts
 * narrating, every OLDER run keeps only its last (terminal) hand-off line,
 * so a frequently scheduled agent costs ~1 message per past run instead of
 * up to 9 and never evicts the user's real conversation early.
 */
function collapseOlderHandoffRuns(threadKey: string, currentRunId: string): void {
  const store = useAIPaneStore.getState();
  const messages = store.conversations[threadKey]?.messages ?? [];
  const lastIdByRun = new Map<string, string>();
  for (const m of messages) {
    if (m.handoff && m.handoff.runId !== currentRunId) lastIdByRun.set(m.handoff.runId, m.id);
  }
  for (const m of messages) {
    if (m.handoff && lastIdByRun.has(m.handoff.runId) && lastIdByRun.get(m.handoff.runId) !== m.id) {
      store.deleteMessage(threadKey, m.id);
    }
  }
}

/**
 * Unattended path: replay an already-written multi-step run log's per-step
 * records into ONE coalesced digest line in the agent's thread. Returns true
 * when posted. Skips single-step runs, runs the attended chain already
 * narrated live, and runs whose digest is already in the (persisted) thread.
 */
export function postAgentHandoffDigest(
  log: AgentRunLog,
  agentName: string,
  translate: HandoffTranslate,
): boolean {
  if (!log.steps || log.steps.length < 2) return false;
  const runId = agentRunLogIdentity(log);
  if (narratedHandoffRuns.has(runId)) return false;
  const store = useAIPaneStore.getState();
  const messages = store.conversations[agentThreadKey(log.agentId)]?.messages ?? [];
  if (messages.some((m) => m.handoff?.runId === runId)) return false;
  const digest = buildHandoffDigest(agentName, log.steps, translate);
  if (!digest) return false;
  narratedHandoffRuns.add(runId);
  postAgentHandoffLine(log.agentId, runId, 0, digest);
  return true;
}

/** Test-only: reset the process-lifetime dedupe set. */
export function __resetHandoffDedupeForTests(): void {
  narratedHandoffRuns.clear();
}

/**
 * Session-only cursor for the root disk-sync loop. `beginSync` deliberately
 * observes everything already in the RN store (including attended runs) before
 * disk I/O; `completeSync` returns only identities introduced by that sync.
 * The first cycle therefore seeds existing history instead of backfilling it.
 */
export class AgentRunLogNoticeTracker {
  private readonly seen = new Set<string>();
  private initialized = false;

  beginSync(history: AgentRunHistory): void {
    this.observe(history);
  }

  completeSync(history: AgentRunHistory): AgentRunLog[] {
    if (!this.initialized) {
      this.observe(history);
      this.initialized = true;
      return [];
    }
    const fresh: AgentRunLog[] = [];
    for (const logs of Object.values(history)) {
      for (const log of logs) {
        const identity = agentRunLogIdentity(log);
        if (!this.seen.has(identity)) fresh.push(log);
        this.seen.add(identity);
      }
    }
    return fresh.sort((a, b) => a.timestamp - b.timestamp);
  }

  private observe(history: AgentRunHistory): void {
    for (const logs of Object.values(history)) {
      for (const log of logs) this.seen.add(agentRunLogIdentity(log));
    }
  }
}
