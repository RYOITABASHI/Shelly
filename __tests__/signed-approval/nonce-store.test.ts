import { InMemoryNonceStore } from '@/lib/signed-approval/nonce-store';

describe('InMemoryNonceStore single-use', () => {
  it('consumes a nonce exactly once', () => {
    const s = new InMemoryNonceStore();
    expect(s.consume('n1')).toBe(true);
    expect(s.consume('n1')).toBe(false); // replay
    expect(s.consume('n2')).toBe(true); // independent
  });

  it('rejects an empty nonce', () => {
    const s = new InMemoryNonceStore();
    expect(s.consume('')).toBe(false);
  });
});
