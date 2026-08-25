import { openRouterChatStream } from '@/lib/openrouter';

/**
 * Builds a real ReadableStream (as `fetch`'s `response.body` would provide on
 * a live network response) that yields the given SSE frames across separate
 * `enqueue` calls -- i.e. as distinct chunks arriving over time, not one
 * pre-buffered string. This is what exercises openRouterChatStream's actual
 * ReadableStreamDefaultReader loop (readOpenRouterSSE) instead of its
 * `response.body` missing fallback (`response.text()`), matching how
 * lib/groq.ts / lib/cerebras.ts streaming is proven true-streaming rather
 * than a single batched flush at the end.
 */
function mockSSEStreamFetch(frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    body,
  } as unknown as Response);
}

describe('openRouterChatStream', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the OpenAI-compatible endpoint and streams SSE deltas incrementally as chunks arrive', async () => {
    const fetchMock = mockSSEStreamFetch([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n',
      'data: [DONE]\n',
    ]);
    const chunks: Array<[string, boolean]> = [];

    const result = await openRouterChatStream(
      'sk-or-test',
      'prompt',
      (text, done) => chunks.push([text, done]),
      'anthropic/claude-sonnet-4',
    );

    expect(result).toEqual({ success: true, content: 'hello world' });
    expect(chunks).toEqual([['hello', false], [' world', false], ['', true]]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-or-test' }),
      }),
    );
  });

  it('accumulates deltas split mid-frame across separate network chunks', async () => {
    // Simulates a delta JSON payload arriving split across two TCP reads --
    // the reader loop must buffer the incomplete trailing line and resume
    // parsing once the rest arrives, same as groq.ts / cerebras.ts.
    const fetchMock = mockSSEStreamFetch([
      'data: {"choices":[{"delta":{"content":"par',
      'tial"}}]}\ndata: [DONE]\n',
    ]);
    const chunks: Array<[string, boolean]> = [];

    const result = await openRouterChatStream('sk-or-test', 'prompt', (text, done) => chunks.push([text, done]));

    expect(result).toEqual({ success: true, content: 'partial' });
    expect(chunks).toEqual([['partial', false], ['', true]]);
    fetchMock.mockRestore();
  });

  it('completes via finish_reason without an explicit [DONE] frame', async () => {
    const fetchMock = mockSSEStreamFetch([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n',
    ]);
    const chunks: Array<[string, boolean]> = [];

    const result = await openRouterChatStream('sk-or-test', 'prompt', (text, done) => chunks.push([text, done]));

    expect(result).toEqual({ success: true, content: 'done' });
    expect(chunks).toEqual([['done', true]]);
    fetchMock.mockRestore();
  });

  it('falls back to parsing the buffered body when no reader is available (RN polyfill gap)', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () =>
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}\n' +
        'data: [DONE]\n',
    } as Response);
    const chunks: Array<[string, boolean]> = [];

    const result = await openRouterChatStream('sk-or-test', 'prompt', (text, done) => chunks.push([text, done]));

    expect(result).toEqual({ success: true, content: 'hello world' });
    expect(chunks).toEqual([['hello world', true]]);
    fetchMock.mockRestore();
  });

  it('fails closed when no attended API key is supplied', async () => {
    expect(await openRouterChatStream('', 'prompt', jest.fn())).toEqual({
      success: false,
      error: 'OpenRouter API key is not configured.',
    });
  });
});
