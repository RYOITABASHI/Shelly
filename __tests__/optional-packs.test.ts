/**
 * lib/optional-packs.ts — pack manifest data. Fable5 roadmap item #6
 * (on-demand optional-tool packs, dormant infra ahead of any real bundle
 * split). This suite locks down the shape every consumer (pseudo-shell.ts's
 * `shelly install`, optional-pack-installer.ts) depends on. Since
 * 2026-08-25 the archives are real and `published: true`
 * (.github/workflows/build-android.yml's "Publish optional tool pack
 * archives" step republishes them from the live jniLibs binaries on every
 * push to main) — `sha256` stays deliberately null (see lib/optional-packs.ts's
 * own doc comment for why a hardcoded hash would go stale), but the
 * download URL must point at the real `optional-packs-latest` release, not
 * a placeholder.
 */
import {
  OPTIONAL_PACKS,
  getOptionalPack,
  isValidOptionalPackId,
  listOptionalPackIds,
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
  it('every pack is published, with sha256 deliberately left unpinned', () => {
    for (const pack of Object.values(OPTIONAL_PACKS)) {
      expect(pack.published).toBe(true);
      expect(pack.sha256).toBeNull();
      expect(pack.approxSizeBytes).toBeGreaterThan(0);
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
