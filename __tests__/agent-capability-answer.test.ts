import { answerCapabilityQuestion, type CapabilityAnswerConfig } from '@/lib/agent-capability-answer';

jest.mock('@/lib/groq', () => ({
  groqChatStream: jest.fn(),
  GROQ_DEFAULT_MODEL: 'llama-3.3-70b-versatile',
}));
jest.mock('@/lib/gemini', () => ({
  geminiChatStream: jest.fn(),
  GEMINI_DEFAULT_MODEL: 'gemini-2.0-flash',
}));
jest.mock('@/lib/cerebras', () => ({
  cerebrasChatStream: jest.fn(),
  CEREBRAS_DEFAULT_MODEL: 'qwen-3-235b-a22b-instruct-2507',
}));
jest.mock('@/lib/local-llm', () => ({
  ollamaChat: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { groqChatStream } = require('@/lib/groq') as { groqChatStream: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { geminiChatStream } = require('@/lib/gemini') as { geminiChatStream: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cerebrasChatStream } = require('@/lib/cerebras') as { cerebrasChatStream: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ollamaChat } = require('@/lib/local-llm') as { ollamaChat: jest.Mock };

function streamingSuccess(text: string) {
  return (
    _apiKey: string,
    _prompt: string,
    onChunk: (text: string, done: boolean) => void,
  ) => {
    onChunk(text, true);
    return Promise.resolve({ success: true, content: text });
  };
}

const NO_PROVIDER_CONFIG: CapabilityAnswerConfig = {};

beforeEach(() => {
  groqChatStream.mockReset();
  geminiChatStream.mockReset();
  cerebrasChatStream.mockReset();
  ollamaChat.mockReset();
});

describe('answerCapabilityQuestion', () => {
  it('returns success:false with no provider configured, and never throws', async () => {
    const result = await answerCapabilityQuestion('what can you do?', NO_PROVIDER_CONFIG);
    expect(result.success).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('answers via Groq when a Groq API key is configured, stripping the trailing status tag', async () => {
    groqChatStream.mockImplementation(streamingSuccess('Shelly can split panes.\n[AVAILABLE]'));
    const result = await answerCapabilityQuestion('can Shelly split panes?', { groqApiKey: 'gsk_test' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('groq');
    expect(result.status).toBe('AVAILABLE');
    expect(result.text).toBe('Shelly can split panes.');
    expect(geminiChatStream).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when Groq is not configured', async () => {
    geminiChatStream.mockImplementation(streamingSuccess('Yes, via Worktrees.\n[AVAILABLE]'));
    const result = await answerCapabilityQuestion('q', { geminiApiKey: 'gm_test' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('gemini');
  });

  it('falls back to Cerebras when Groq/Gemini are not configured', async () => {
    cerebrasChatStream.mockImplementation(streamingSuccess('Planned for a future release.\n[PLANNED]'));
    const result = await answerCapabilityQuestion('q', { cerebrasApiKey: 'cb_test' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('cerebras');
    expect(result.status).toBe('PLANNED');
  });

  it('falls back to the local LLM as the last resort', async () => {
    ollamaChat.mockResolvedValue({ success: true, content: 'No evidence of that.\n[NOT_AVAILABLE]' });
    const result = await answerCapabilityQuestion('q', {
      localLlmEnabled: true,
      localLlmUrl: 'http://127.0.0.1:8080',
      localLlmModel: 'Qwen3.5-0.8B-Q4_K_M',
    });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.status).toBe('NOT_AVAILABLE');
    expect(result.text).toBe('No evidence of that.');
  });

  it('tries providers in order (Groq -> Gemini -> Cerebras -> local) and moves on when an earlier one fails', async () => {
    groqChatStream.mockResolvedValue({ success: false, error: 'Groq API キーが設定されていません。' });
    geminiChatStream.mockImplementation(streamingSuccess('Answered by Gemini.\n[AVAILABLE]'));
    const result = await answerCapabilityQuestion('q', { groqApiKey: 'bad', geminiApiKey: 'good' });
    expect(result.provider).toBe('gemini');
  });

  it('moves on to the next provider when a call throws instead of propagating the error', async () => {
    groqChatStream.mockRejectedValue(new Error('network down'));
    geminiChatStream.mockImplementation(streamingSuccess('Answered by Gemini.\n[AVAILABLE]'));
    const result = await answerCapabilityQuestion('q', { groqApiKey: 'x', geminiApiKey: 'y' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('gemini');
  });

  it('streams incremental deltas to onChunk, not the accumulated total', async () => {
    groqChatStream.mockImplementation(
      (_apiKey: string, _prompt: string, onChunk: (text: string, done: boolean) => void) => {
        onChunk('Hello', false);
        onChunk(' world.\n[AVAILABLE]', true);
        return Promise.resolve({ success: true, content: 'Hello world.\n[AVAILABLE]' });
      },
    );
    const deltas: string[] = [];
    await answerCapabilityQuestion('q', { groqApiKey: 'x' }, (delta) => deltas.push(delta));
    expect(deltas).toEqual(['Hello', ' world.\n[AVAILABLE]']);
  });

  it('does not treat the local LLM as configured when enabled is false, even with a baseUrl/model set', async () => {
    const result = await answerCapabilityQuestion('q', {
      localLlmEnabled: false,
      localLlmUrl: 'http://127.0.0.1:8080',
      localLlmModel: 'Qwen3.5-0.8B-Q4_K_M',
    });
    expect(result.success).toBe(false);
    expect(ollamaChat).not.toHaveBeenCalled();
  });
});
