/**
 * lib/companion-journal.ts — session-digest capture for the companion
 * journal ("一人の相棒" Gap②, 2026-08-25). Covers: eligibility filtering
 * (mirrors ai-pane-store.ts's isCarryForwardEligible), the minimum-message
 * floor, "NOTHING" responses not writing a note, and idempotency (a
 * repeated digest call for the same tail is a no-op, matching G1-P2's
 * carry-forward idempotency test shape).
 */
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

const config = { baseUrl: 'http://127.0.0.1:8080', model: 'test-model', enabled: true };
const runCommand = jest.fn(async () => '');

function msg(id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp: 1, ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('digestConversationForJournal', () => {
  it('does nothing when the local LLM base URL is unset', async () => {
    await digestConversationForJournal('key', [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')], { baseUrl: '', model: '', enabled: false }, runCommand);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('does nothing below the minimum eligible-message floor', async () => {
    await digestConversationForJournal('key', [msg('1', 'user', 'a'), msg('2', 'assistant', 'b')], config, runCommand);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('excludes system/streaming/interactive-payload messages from both the floor count and the digest input', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'user is planning a Kyoto trip in October.' });
    const messages: ChatMessage[] = [
      msg('sys', 'system', 'switched threads'),
      msg('u1', 'user', 'planning a trip to Kyoto in October'),
      msg('a1', 'assistant', 'sounds fun, want hotel recs?'),
      msg('u2', 'user', 'yes please'),
      msg('a2', 'assistant', 'here are three options'),
      msg('streaming', 'assistant', 'partial...', { isStreaming: true }),
      msg('draft', 'assistant', 'confirm this agent?', { agentCardState: 'pending' }),
    ];
    await digestConversationForJournal('key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1);
    const [, sentMessages] = ollamaChat.mock.calls[0];
    const transcript = sentMessages[1].content as string;
    expect(transcript).not.toContain('switched threads');
    expect(transcript).not.toContain('partial...');
    expect(transcript).not.toContain('confirm this agent?');
    expect(transcript).toContain('Kyoto');
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);
  });

  it.each(['NOTHING', 'NOTHING worth remembering.', 'nothing.'])(
    'writes no note when the model replies with a NOTHING-led response: %s',
    async (reply) => {
      ollamaChat.mockResolvedValueOnce({ success: true, content: reply });
      // Unique key + unique last-message id per case: reusing one key across
      // iterations would make the idempotency marker (correctly) skip the
      // 2nd/3rd calls entirely, leaving their queued mock responses
      // unconsumed and bleeding into later tests.
      const key = `nothing-variant-${reply}`;
      const messages = [msg('1', 'user', 'hi'), msg('2', 'assistant', 'hello'), msg('3', 'user', 'how are you'), msg(`4-${reply}`, 'assistant', 'good, you?')];
      await digestConversationForJournal(key, messages, config, runCommand);
      expect(ollamaChat).toHaveBeenCalledTimes(1);
      expect(writeMemoryNote).not.toHaveBeenCalled();
    },
  );

  it('does not re-ask about a tail the model already determined has nothing worth saving', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'NOTHING' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('nothing-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1);

    await digestConversationForJournal('nothing-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1); // marker set even on a no-write outcome
  });

  it('writes no note and leaves the digest marker unset when the model call fails, so a later switch retries', async () => {
    ollamaChat.mockResolvedValueOnce({ success: false, content: '', error: 'timeout' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('retry-key', messages, config, runCommand);
    expect(writeMemoryNote).not.toHaveBeenCalled();

    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    await digestConversationForJournal('retry-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2); // NOT skipped as already-digested
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);
  });

  it('leaves the digest marker unset when the LLM call succeeds but the write fails, so a later switch retries the write', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    writeMemoryNote.mockRejectedValueOnce(new Error('scoped filesystem write denied'));
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('write-fail-key', messages, config, runCommand);
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);

    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    await digestConversationForJournal('write-fail-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2); // NOT skipped -- the first attempt never actually landed
    expect(writeMemoryNote).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: a repeated call for the same source key with no new tail content does not re-digest', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'first digest.' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('idem-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1);

    // Same key, identical tail (e.g. a rapid companion<->provider round-trip
    // switching back before anything new was said) -- must not re-call.
    await digestConversationForJournal('idem-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1);
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);
  });

  it('digests again once genuinely new content is appended to the same source key', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'first digest.' });
    const first = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('grow-key', first, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(1);

    ollamaChat.mockResolvedValueOnce({ success: true, content: 'second digest.' });
    const second = [...first, msg('5', 'user', 'e'), msg('6', 'assistant', 'f')];
    await digestConversationForJournal('grow-key', second, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2);
    expect(writeMemoryNote).toHaveBeenCalledTimes(2);
  });

  it('different source keys track digest progress independently', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'a digest.' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('key-a', messages, config, runCommand);
    await digestConversationForJournal('key-b', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2);
  });
});
