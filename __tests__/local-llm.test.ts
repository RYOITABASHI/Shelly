jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en' }],
}));

import { ollamaChat, ollamaChatStream, orchestrateChatStream, type OllamaMessage } from '@/lib/local-llm';

const messages: OllamaMessage[] = [{ role: 'user', content: 'hello' }];
const originalFetch = global.fetch;
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalXHR = globalThis.XMLHttpRequest;

function mockJsonFetch(data: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockStreamFetch(text: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestBody(fetchMock: jest.Mock) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
  if (originalXHR) {
    globalThis.XMLHttpRequest = originalXHR;
  } else {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
});

describe('local LLM request compatibility', () => {
  it('disables Qwen thinking for llama.cpp OpenAI-compatible requests', async () => {
    const fetchMock = mockJsonFetch({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });

    await ollamaChat(
      { baseUrl: 'http://127.0.0.1:8080', model: 'qwen-3.5-local', enabled: true },
      messages,
    );

    expect(requestBody(fetchMock)).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.4,
      max_tokens: 384,
    });
  });

  it('disables thinking for generic Ollama aliases used by Shelly local setup', async () => {
    const fetchMock = mockJsonFetch({
      model: 'default',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    });

    await ollamaChat(
      { baseUrl: 'http://127.0.0.1:11434', model: 'default', enabled: true },
      messages,
    );

    expect(requestBody(fetchMock)).toMatchObject({
      think: false,
      options: {
        temperature: 0.4,
        num_ctx: 1024,
        num_predict: 384,
      },
    });
  });

  it('parses an unterminated final OpenAI SSE content chunk', async () => {
    const fetchMock = mockStreamFetch(
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
    );
    const chunks: string[] = [];

    const result = await ollamaChatStream(
      { baseUrl: 'http://127.0.0.1:8080', model: 'default', enabled: true },
      messages,
      (chunk) => chunks.push(chunk),
      1000,
    );

    expect(result.success).toBe(true);
    expect(chunks.join('')).toBe('OK');
    expect(requestBody(fetchMock)).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('ignores Ollama thinking chunks and keeps final content', async () => {
    const fetchMock = mockStreamFetch(
      [
        '{"message":{"thinking":"internal"},"done":false}',
        '{"message":{"content":"visible"},"done":false}',
      ].join('\n'),
    );
    const chunks: string[] = [];

    const result = await ollamaChatStream(
      { baseUrl: 'http://127.0.0.1:11434', model: 'local', enabled: true },
      messages,
      (chunk) => chunks.push(chunk),
      1000,
    );

    expect(result.success).toBe(true);
    expect(chunks.join('')).toBe('visible');
    expect(requestBody(fetchMock)).toMatchObject({ think: false });
  });

  it('does not reject orchestration when the UI chunk callback throws', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'stream failed',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
        }),
        text: async () => 'fallback',
      }) as unknown as typeof fetch;

    await expect(orchestrateChatStream(
      'hello',
      { baseUrl: 'http://127.0.0.1:8080', model: 'default', enabled: true },
      () => {
        throw new Error('render update failed');
      },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    )).resolves.toMatchObject({
      handledBy: 'local_llm',
      response: 'fallback',
    });
  });

  it('parses an RN XHR final buffered SSE line without a trailing newline', async () => {
    const instances: Array<{ body: string }> = [];
    class FakeXHR {
      responseText = '';
      status = 200;
      timeout = 0;
      body = '';
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;

      constructor() {
        instances.push(this);
      }

      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.();
      }
      send(body?: unknown) {
        this.body = String(body ?? '');
        this.responseText =
          'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}';
        this.onprogress?.();
        setTimeout(() => this.onload?.(), 120);
      }
    }

    Object.defineProperty(globalThis, 'navigator', {
      value: { product: 'ReactNative' },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: FakeXHR,
      configurable: true,
    });

    const chunks: string[] = [];
    const result = await ollamaChatStream(
      { baseUrl: 'http://127.0.0.1:8080', model: 'default', enabled: true },
      messages,
      (chunk) => chunks.push(chunk),
      1000,
    );

    expect(result.success).toBe(true);
    expect(chunks.join('')).toBe('OK');
    expect(JSON.parse(instances[0].body)).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('returns a controlled error when RN XHR responseText throws during progress', async () => {
    class ThrowingXHR {
      status = 200;
      timeout = 0;
      responseReads = 0;
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;

      get responseText() {
        this.responseReads += 1;
        if (this.responseReads === 1) {
          throw new Error('responseText unavailable');
        }
        return 'data: {"choices":[{"index":0,"delta":{"content":"LATE"},"finish_reason":null}]}';
      }

      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.();
      }
      send() {
        this.onprogress?.();
        setTimeout(() => this.onload?.(), 120);
      }
    }

    Object.defineProperty(globalThis, 'navigator', {
      value: { product: 'ReactNative' },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: ThrowingXHR,
      configurable: true,
    });

    const chunks: string[] = [];
    const result = await ollamaChatStream(
      { baseUrl: 'http://127.0.0.1:8080', model: 'default', enabled: true },
      messages,
      (chunk) => chunks.push(chunk),
      1000,
    );

    expect(result).toMatchObject({
      success: false,
      error: 'responseText unavailable',
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(chunks).toEqual([]);
  });

  it('returns a controlled error when RN XHR construction fails', async () => {
    class ThrowingConstructorXHR {
      constructor() {
        throw new Error('xhr unavailable');
      }
    }

    Object.defineProperty(globalThis, 'navigator', {
      value: { product: 'ReactNative' },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: ThrowingConstructorXHR,
      configurable: true,
    });

    await expect(ollamaChatStream(
      { baseUrl: 'http://127.0.0.1:8080', model: 'default', enabled: true },
      messages,
      () => {},
      1000,
    )).resolves.toMatchObject({
      success: false,
      error: 'xhr unavailable',
    });
  });
});
