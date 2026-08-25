/**
 * lib/companion-journal.ts — Gap B fail-closed coverage (Fable5 product
 * review, 2026-08-25): when MEMORY_ENABLED is false (should never happen in
 * production — true since 2026-08-05, see lib/memory/wiring.ts — but the
 * journal write must degrade safely if it ever is), a journal digest must
 * still land, via G2's own writeMemoryNote, and activateMemoryWrite must
 * never even be attempted.
 *
 * Kept in its own file rather than as a case in
 * __tests__/companion-journal.test.ts: MEMORY_ENABLED is read via a live
 * CJS binding (`if (MEMORY_ENABLED) { ... }` inside
 * lib/companion-journal.ts), so overriding it for only ONE test in a
 * shared file would need resetModules/re-require gymnastics mid-file. A
 * dedicated file that mocks lib/memory/wiring for its entire run is
 * simpler and matches __tests__/agent-skills-hybrid-match.test.ts's
 * established pattern for forcing a memory-layer flag across a whole test
 * file (that file forces MEMORY_EMBEDDING_ENABLED; this one forces the
 * sibling MEMORY_ENABLED false).
 */
jest.mock('@/lib/memory/wiring', () => ({
  ...jest.requireActual('@/lib/memory/wiring'),
  MEMORY_ENABLED: false,
}));
jest.mock('@/lib/memory/shadow', () => ({
  activateMemoryWrite: jest.fn(async () => true),
}));
jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));
jest.mock('@/lib/agent-memory', () => ({
  COMPANION_MEMORY_SCOPE: '_companion',
  makeMemoryNote: jest.fn((params) => ({ id: 'note-id', created: '2026-08-25T00:00:00.000Z', tags: [], ...params })),
  writeMemoryNote: jest.fn(async () => {}),
}));

import { digestConversationForJournal } from '@/lib/companion-journal';
import type { ChatMessage } from '@/store/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ollamaChat } = require('@/lib/local-llm') as { ollamaChat: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeMemoryNote } = require('@/lib/agent-memory') as { writeMemoryNote: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activateMemoryWrite } = require('@/lib/memory/shadow') as { activateMemoryWrite: jest.Mock };

const config = { baseUrl: 'http://127.0.0.1:8080', model: 'test-model', enabled: true };
const runCommand = jest.fn(async () => '');

function msg(id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp: 1, ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('digestConversationForJournal with MEMORY_ENABLED=false', () => {
  it('writes only through G2 and never calls activateMemoryWrite', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('fail-closed-key', messages, config, runCommand);
    expect(activateMemoryWrite).not.toHaveBeenCalled();
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);
  });
});
