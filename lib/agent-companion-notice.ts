import { COMPANION_CONVERSATION_KEY, useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import type { AgentRunLog, ChatMessage } from '@/store/types';

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
