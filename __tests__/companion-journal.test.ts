/**
 * lib/companion-journal.ts — session-digest capture for the companion
 * journal ("一人の相棒" Gap②, 2026-08-25). Covers: eligibility filtering
 * (mirrors ai-pane-store.ts's isCarryForwardEligible), the minimum-message
 * floor, "NOTHING" responses not writing a note, and idempotency (a
 * repeated digest call for the same tail is a no-op, matching G1-P2's
 * carry-forward idempotency test shape).
 *
 * Fable5 product-review gaps (2026-08-25), both covered below:
 *  - Gap A (dormancy detection): the `onDormant` describe block.
 *  - Gap B (MEMORY-001 write routing): the `MEMORY-001 write routing`
 *    describe block. `@/lib/memory/wiring` is NOT mocked here — the real
 *    MEMORY_ENABLED is true (since 2026-08-05), so `activateMemoryWrite`
 *    from `@/lib/memory/shadow` is the primary write path throughout this
 *    file, exactly like production. The MEMORY_ENABLED=false fail-closed
 *    case is covered in its own file,
 *    __tests__/companion-journal-memory-disabled.test.ts — see that file's
 *    header comment for why it can't share this one.
 */
jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));
jest.mock('@/lib/agent-memory', () => ({
  COMPANION_MEMORY_SCOPE: '_companion',
  makeMemoryNote: jest.fn((params) => ({ id: 'note-id', created: '2026-08-25T00:00:00.000Z', tags: [], ...params })),
  writeMemoryNote: jest.fn(async () => {}),
}));
jest.mock('@/lib/memory/shadow', () => ({
  activateMemoryWrite: jest.fn(async () => true),
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
    // MEMORY_ENABLED is true (real value) and activateMemoryWrite resolves
    // true by default -- the v2 write is the primary path, so G2's
    // writeMemoryNote must NOT be touched (see the MEMORY-001 write routing
    // describe block below for the dedicated assertions on this).
    expect(activateMemoryWrite).toHaveBeenCalledTimes(1);
    expect(writeMemoryNote).not.toHaveBeenCalled();
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
    expect(activateMemoryWrite).not.toHaveBeenCalled();
    expect(writeMemoryNote).not.toHaveBeenCalled();

    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    await digestConversationForJournal('retry-key', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2); // NOT skipped as already-digested
    // The retry's write succeeds via v2 (activateMemoryWrite's default mock
    // resolves true) -- G2's writeMemoryNote is never touched, same as every
    // other default-success case in this file.
    expect(activateMemoryWrite).toHaveBeenCalledTimes(1);
    expect(writeMemoryNote).not.toHaveBeenCalled();
  });

  it('leaves the digest marker unset when the LLM call succeeds but the write fails (v2 AND G2 both fail), so a later switch retries the write', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    // Force the v2 write to report an internal failure so this exercises
    // (and pins) the G2 fallback -- see the "MEMORY-001 write routing"
    // describe block below for the case where v2 alone succeeds.
    activateMemoryWrite.mockResolvedValueOnce(false);
    writeMemoryNote.mockRejectedValueOnce(new Error('scoped filesystem write denied'));
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('write-fail-key', messages, config, runCommand);
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);

    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a durable fact.' });
    activateMemoryWrite.mockResolvedValueOnce(false);
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
    expect(activateMemoryWrite).toHaveBeenCalledTimes(1);
    expect(writeMemoryNote).not.toHaveBeenCalled();
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
    expect(activateMemoryWrite).toHaveBeenCalledTimes(2);
    expect(writeMemoryNote).not.toHaveBeenCalled();
  });

  it('different source keys track digest progress independently', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'a digest.' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('key-a', messages, config, runCommand);
    await digestConversationForJournal('key-b', messages, config, runCommand);
    expect(ollamaChat).toHaveBeenCalledTimes(2);
  });
});

// Fable5 product-review Gap A (2026-08-25): dormancy detection. The
// `onDormant` callback is the only piece of the fix that lives in this
// module -- the settings-flag "only ever once" dedup and the actual
// plain-chat notice text live in components/panes/AIPane.tsx and
// lib/agent-companion-notice.ts respectively (see
// __tests__/agent-companion-notice.test.ts for
// postCompanionJournalDormancyNotice's own once-per-session coverage).
describe('digestConversationForJournal onDormant (Gap A)', () => {
  const noBaseUrl = { baseUrl: '', model: '', enabled: false };

  it('calls onDormant when there is enough eligible content to journal but no local LLM base URL is configured', async () => {
    const onDormant = jest.fn();
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('dormant-key', messages, noBaseUrl, runCommand, onDormant);
    expect(onDormant).toHaveBeenCalledTimes(1);
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it('does not call onDormant when below the minimum eligible-message floor, even with no base URL', async () => {
    const onDormant = jest.fn();
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b')];
    await digestConversationForJournal('dormant-key-short', messages, noBaseUrl, runCommand, onDormant);
    expect(onDormant).not.toHaveBeenCalled();
  });

  it('does not call onDormant when a base URL IS configured', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'NOTHING' });
    const onDormant = jest.fn();
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('not-dormant-key', messages, config, runCommand, onDormant);
    expect(onDormant).not.toHaveBeenCalled();
  });

  it('calls onDormant again on a later switch of the same key -- this module does not itself dedup across calls', async () => {
    // The "exactly once, ever" guarantee is the CALLER's responsibility
    // (AppSettings.companionJournalDormancyNoticeShown, checked in
    // components/panes/AIPane.tsx before it acts on this callback) --
    // digestConversationForJournal has no settings-store access and simply
    // reports the condition truthfully every time it holds.
    const onDormant = jest.fn();
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('dormant-key-repeat', messages, noBaseUrl, runCommand, onDormant);
    await digestConversationForJournal('dormant-key-repeat', messages, noBaseUrl, runCommand, onDormant);
    expect(onDormant).toHaveBeenCalledTimes(2);
  });
});

// Fable5 product-review Gap B (2026-08-25): MEMORY-001 write routing. Real
// MEMORY_ENABLED (true) applies throughout this file -- see the file header
// comment for why the MEMORY_ENABLED=false fail-closed case lives in its
// own file instead.
describe('MEMORY-001 write routing (Gap B)', () => {
  it('writes through activateMemoryWrite (v2) as the primary path and never touches G2 writeMemoryNote on success', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'user prefers dark mode.' });
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('v2-primary-key', messages, config, runCommand);
    expect(activateMemoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: '_companion', type: 'fact', text: expect.stringContaining('dark mode') }),
    );
    expect(writeMemoryNote).not.toHaveBeenCalled();
  });

  it('falls back to the G2 write when activateMemoryWrite reports an internal failure (returns false)', async () => {
    ollamaChat.mockResolvedValueOnce({ success: true, content: 'a fact worth keeping.' });
    activateMemoryWrite.mockResolvedValueOnce(false);
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'assistant', 'd')];
    await digestConversationForJournal('v2-fallback-key', messages, config, runCommand);
    expect(activateMemoryWrite).toHaveBeenCalledTimes(1);
    expect(writeMemoryNote).toHaveBeenCalledTimes(1);
  });
});
