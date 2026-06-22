/**
 * store/inbound-store.ts — pending inbound utterances awaiting a confirm card.
 *
 * The Telegram poller (hooks/use-telegram-inbound.ts) only ever ENQUEUES an
 * already-authorized, sanitized utterance here; it never creates or runs an
 * agent. A focused AI pane drains the queue into the SAME @agent confirm-card
 * pipeline a local utterance uses, so inbound carries no extra privilege.
 */
import { create } from 'zustand';

export type InboundSource = 'telegram';

export interface PendingInbound {
  id: string;
  /** Normalized @agent utterance (authz + sanitization already applied). */
  text: string;
  source: InboundSource;
  receivedAt: number;
}

const MAX_PENDING = 20;

interface InboundState {
  pending: PendingInbound[];
  enqueue: (text: string, source?: InboundSource) => void;
  /** Pop the oldest pending utterance (or undefined when empty). */
  consume: () => PendingInbound | undefined;
  clear: () => void;
}

export const useInboundStore = create<InboundState>((set, get) => ({
  pending: [],
  enqueue: (text, source = 'telegram') =>
    set((s) => ({
      pending: [
        ...s.pending,
        {
          id: `inb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text,
          source,
          receivedAt: Date.now(),
        },
      ].slice(-MAX_PENDING),
    })),
  consume: () => {
    const [first, ...rest] = get().pending;
    if (!first) return undefined;
    set({ pending: rest });
    return first;
  },
  clear: () => set({ pending: [] }),
}));
