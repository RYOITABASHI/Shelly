import { openRouterChatStream } from '@/lib/openrouter';

describe('openRouterChatStream', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the OpenAI-compatible endpoint and streams SSE deltas', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () =>
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}\n' +
        'data: [DONE]\n',
    } as Response);
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

  it('fails closed when no attended API key is supplied', async () => {
    expect(await openRouterChatStream('', 'prompt', jest.fn())).toEqual({
      success: false,
      error: 'OpenRouter API key is not configured.',
    });
  });
});
