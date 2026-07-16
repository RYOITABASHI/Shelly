import { detectLocalhostUrl } from '@/lib/localhost-detector';

describe('detectLocalhostUrl', () => {
  it('detects a plain localhost dev server URL', () => {
    expect(detectLocalhostUrl('Server running at http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
  });

  it('normalizes 127.0.0.1 / 0.0.0.0 / [::] to localhost', () => {
    expect(detectLocalhostUrl('Listening on http://127.0.0.1:8000')).toBe(
      'http://localhost:8000',
    );
    expect(detectLocalhostUrl('Listening on http://0.0.0.0:8000')).toBe(
      'http://localhost:8000',
    );
    expect(detectLocalhostUrl('Listening on http://[::]:8000')).toBe(
      'http://localhost:8000',
    );
  });

  it('still excludes internal /hook/ URLs', () => {
    expect(detectLocalhostUrl('POST http://127.0.0.1:9000/hook/abc123')).toBeNull();
  });

  // Regression: buildDaemonStartScript echoes
  // "API: http://127.0.0.1:8080/v1/chat/completions" when llama-server
  // starts, and a user/agent manually curl-testing the same endpoint in the
  // terminal produces identical PTY output. Without this exclusion, that
  // exact URL gets auto-offered as a "preview", and WebTab's GET-only
  // WebView then always shows "Cannot connect to localhost:8080/..." even
  // when llama-server is completely healthy (it only accepts POST there).
  it('excludes non-browsable OpenAI-compatible / Ollama JSON API paths', () => {
    expect(
      detectLocalhostUrl('API: http://127.0.0.1:8080/v1/chat/completions'),
    ).toBeNull();
    expect(
      detectLocalhostUrl('curl http://127.0.0.1:8080/v1/completions -d "{}"'),
    ).toBeNull();
    expect(
      detectLocalhostUrl('POST http://localhost:8080/v1/embeddings'),
    ).toBeNull();
    expect(
      detectLocalhostUrl('curl http://127.0.0.1:11434/api/chat -d "{}"'),
    ).toBeNull();
    expect(
      detectLocalhostUrl('curl http://127.0.0.1:11434/api/generate -d "{}"'),
    ).toBeNull();
  });

  it('still detects the llama-server /v1/models health-check and base URL as browsable', () => {
    // /v1/models is a GET-able listing endpoint and the bare base URL serves
    // llama-server's own built-in web UI — both remain useful previews.
    expect(detectLocalhostUrl('GET http://127.0.0.1:8080/v1/models')).toBe(
      'http://localhost:8080/v1/models',
    );
    expect(detectLocalhostUrl('llama-server ready on http://127.0.0.1:8080')).toBe(
      'http://localhost:8080',
    );
  });

  it('returns null when no localhost URL is present', () => {
    expect(detectLocalhostUrl('just some regular output')).toBeNull();
  });
});
