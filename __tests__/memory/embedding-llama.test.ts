import { LlamaEmbeddingPort, llamaEmbeddingEndpointFromBaseUrl } from '@/lib/memory/embedding-llama';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

function mockJsonFetch(status: number, data: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('llamaEmbeddingEndpointFromBaseUrl', () => {
  it('appends the OpenAI-compatible embeddings path', () => {
    expect(llamaEmbeddingEndpointFromBaseUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1/embeddings',
    );
  });
  it('tolerates a trailing slash on the base URL', () => {
    expect(llamaEmbeddingEndpointFromBaseUrl('http://127.0.0.1:8080/')).toBe(
      'http://127.0.0.1:8080/v1/embeddings',
    );
  });
});

describe('LlamaEmbeddingPort — loopback-only guard', () => {
  it('refuses a non-loopback endpoint without ever touching the network', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const port = new LlamaEmbeddingPort({ endpoint: 'https://example.com/v1/embeddings' });
    await expect(port.embed(['hello'])).rejects.toThrow(/loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts 127.0.0.1 and localhost endpoints', async () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      const fetchMock = mockJsonFetch(200, { data: [{ embedding: [1, 2, 3], index: 0 }] });
      const port = new LlamaEmbeddingPort({ endpoint: `http://${host}:8080/v1/embeddings` });
      await expect(port.embed(['hi'])).resolves.toEqual([[1, 2, 3]]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('returns [] for empty input without calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings' });
    await expect(port.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LlamaEmbeddingPort — response handling', () => {
  it('sends an OpenAI-compatible request body and re-orders rows by `index`', async () => {
    // Deliberately out of order in the response, mirroring the OpenAI
    // embeddings contract (row order is not guaranteed to match input order).
    const fetchMock = mockJsonFetch(200, {
      data: [
        { embedding: [0, 1], index: 1 },
        { embedding: [1, 0], index: 0 },
      ],
    });
    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings' });
    const result = await port.embed(['first', 'second']);
    expect(result).toEqual([[1, 0], [0, 1]]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ input: ['first', 'second'] });
  });

  it('throws on a non-2xx response — the expected shape when the server was started without --embedding', async () => {
    mockJsonFetch(501, { error: 'this server does not support embeddings' });
    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings' });
    await expect(port.embed(['hi'])).rejects.toThrow(/HTTP 501/);
  });

  it('throws when the response shape is unexpected (missing/short data array)', async () => {
    mockJsonFetch(200, { data: [{ embedding: [1, 2], index: 0 }] }); // asked for 2, got 1
    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings' });
    await expect(port.embed(['a', 'b'])).rejects.toThrow(/unexpected shape/);
  });

  it('throws when `data` is missing entirely', async () => {
    mockJsonFetch(200, {});
    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings' });
    await expect(port.embed(['a'])).rejects.toThrow(/unexpected shape/);
  });
});

describe('LlamaEmbeddingPort — timeout', () => {
  it('aborts the request once timeoutMs elapses, rather than hanging', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const port = new LlamaEmbeddingPort({ endpoint: 'http://127.0.0.1:8080/v1/embeddings', timeoutMs: 50 });
    const pending = port.embed(['hi']);
    // Attach a rejection observer before advancing timers, so Node never
    // reports an "unhandled rejection" for the (expected) timeout.
    const assertion = expect(pending).rejects.toThrow(/aborted/i);
    jest.advanceTimersByTime(50);
    await assertion;
  });
});
