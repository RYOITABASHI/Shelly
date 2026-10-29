/**
 * lib/optional-packs.ts — pack manifest data. Fable5 roadmap item #6
 * (on-demand optional-tool packs, dormant infra ahead of any real bundle
 * split). This suite locks down the shape every consumer (pseudo-shell.ts's
 * `shelly install`, optional-pack-installer.ts) depends on, plus the
 * build-time sha256 pinning (2026-10-29): CI writes
 * lib/optional-packs-pins.json before the APK build, and a pack is only
 * installable when that pin is well-formed and content-addressed.
 */
import {
  OPTIONAL_PACKS,
  getOptionalPack,
  isValidOptionalPackId,
  listOptionalPackIds,
  packForTool,
  resolveOptionalPack,
  validPin,
} from '@/lib/optional-packs';

describe('OPTIONAL_PACKS manifest', () => {
  it('lists exactly the ids used as manifest keys', () => {
    expect(listOptionalPackIds().sort()).toEqual(Object.keys(OPTIONAL_PACKS).sort());
  });

  it('every pack id is a lowercase-hyphen string matching its own key', () => {
    for (const [key, pack] of Object.entries(OPTIONAL_PACKS)) {
      expect(pack.id).toBe(key);
      expect(pack.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('every pack has at least one tool and a .tar.gz archive name', () => {
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      expect(pack.tools.length).toBeGreaterThan(0);
      expect(pack.archiveAssetName).toMatch(/\.tar\.gz$/);
    }
  });

  it('no tool appears in more than one pack (packs are disjoint)', () => {
    const seen = new Set<string>();
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      for (const tool of pack.tools) {
        expect(seen.has(tool)).toBe(false);
        seen.add(tool);
      }
    }
  });

  it('together the packs cover exactly the 11 tools flagged as movable out of the default bundle', () => {
    const allTools = Object.values(OPTIONAL_PACKS)
      .flatMap((pack) => pack.tools)
      .sort();
    const expected = ['gh', 'jq', 'less', 'make', 'nano', 'python3', 'rg', 'sqlite3', 'tmux', 'unzip', 'vim'].sort();
    expect(allTools).toEqual(expected);
  });

  // Every pack is live (2026-08-25) — the CI publishing step confirmed the
  // release + assets actually exist (gh release view optional-packs-latest).
  // sha256 stays deliberately null (a hardcoded hash would go stale the
  // next time the underlying binary changes and the archive is
  // republished) — installOptionalPack() treats null as "skip the optional
  // integrity check", not a bug.
  it('the committed (non-CI) build carries no pins, so no pack is installable', () => {
    // lib/optional-packs-pins.json is empty in git; CI fills it before the
    // release build. An unpinned build must never install unverified bytes.
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      expect(pack.published).toBe(false);
      expect(pack.sha256).toBeNull();
    }
  });

  it('downloadUrl points at the real optional-packs-latest release, not a placeholder', () => {
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      expect(pack.downloadUrl).not.toContain('NOT-YET-PUBLISHED');
      expect(pack.downloadUrl).toContain('/releases/download/optional-packs-latest/');
      expect(pack.downloadUrl).toContain(pack.archiveAssetName);
    }
  });
});

describe('resolveOptionalPack / validPin (build-time sha256 pinning)', () => {
  const sha = 'c0ffee'.padEnd(64, '0');
  const goodPin = { assetName: `shelly-pack-dev-tools-arm64-${sha.slice(0, 16)}.tar.gz`, sha256: sha, bytes: 4096 };

  it('applies a well-formed pin: content-addressed URL, sha256, exact size, published', () => {
    const pack = resolveOptionalPack('dev-tools', { schema: 1, packs: { 'dev-tools': goodPin } });
    expect(pack).not.toBeNull();
    expect(pack!.published).toBe(true);
    expect(pack!.sha256).toBe(sha);
    expect(pack!.approxSizeBytes).toBe(4096);
    expect(pack!.archiveAssetName).toBe(goodPin.assetName);
    expect(pack!.downloadUrl).toBe(
      `https://github.com/RYOITABASHI/Shelly/releases/download/optional-packs-latest/${goodPin.assetName}`
    );
  });

  it.each([
    ['missing pin', {}],
    ['short sha', { 'dev-tools': { ...goodPin, sha256: 'abc' } }],
    ['uppercase sha', { 'dev-tools': { ...goodPin, sha256: sha.toUpperCase() } }],
    ['asset name not derived from sha', { 'dev-tools': { ...goodPin, assetName: 'shelly-pack-dev-tools-arm64.tar.gz' } }],
    ['asset name for another pack', { 'dev-tools': { ...goodPin, assetName: `shelly-pack-editor-tools-arm64-${sha.slice(0, 16)}.tar.gz` } }],
    ['zero bytes', { 'dev-tools': { ...goodPin, bytes: 0 } }],
    ['fractional bytes', { 'dev-tools': { ...goodPin, bytes: 1.5 } }],
  ])('treats %s as unpinned (not installable)', (_label, packs) => {
    const pack = resolveOptionalPack('dev-tools', { schema: 1, packs: packs as any });
    expect(pack!.published).toBe(false);
    expect(pack!.sha256).toBeNull();
    expect(validPin('dev-tools', { schema: 1, packs: packs as any })).toBeNull();
  });

  it('rejects an unknown schema version', () => {
    expect(validPin('dev-tools', { schema: 2, packs: { 'dev-tools': goodPin } })).toBeNull();
  });

  it('returns null for an unknown pack id', () => {
    expect(resolveOptionalPack('nope', { schema: 1, packs: {} })).toBeNull();
  });

  it('packForTool maps every pack tool back to its pack', () => {
    expect(packForTool('jq')).toBe('dev-tools');
    expect(packForTool('rg')).toBe('editor-tools');
    expect(packForTool('bash')).toBeNull();
  });
});

describe('getOptionalPack / isValidOptionalPackId', () => {
  it('returns the manifest entry for a known id', () => {
    const pack = getOptionalPack('dev-tools');
    expect(pack).not.toBeNull();
    expect(pack?.id).toBe('dev-tools');
  });

  it('returns null for an unknown id', () => {
    expect(getOptionalPack('does-not-exist')).toBeNull();
  });

  it('isValidOptionalPackId agrees with getOptionalPack', () => {
    expect(isValidOptionalPackId('editor-tools')).toBe(true);
    expect(isValidOptionalPackId('nope')).toBe(false);
  });
});
