// Same mocking discipline as __tests__/skill-import.test.ts: skill-catalog.ts
// imports pure helpers (SKILL_NAME_RE, MAX_DESCRIPTION_CHARS) from
// lib/skill-import.ts, which transitively touches expo-file-system/legacy and
// lib/home-path — neither of which this test exercises, so both are stubbed.
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

// expo-crypto is a native-module-backed package lazily require()'d inside
// sha256Hex() (see skill-catalog.ts's module doc for why: same class of bug
// fixed for lib/memory/crypto-expo.ts in 303c36efe). jest.mock intercepts
// require() calls the same as static imports, so this stub is picked up by
// fetchCatalogSkillContent without needing real native crypto in the ts-jest
// "unit" project (testEnvironment: node).
const digestStringAsync = jest.fn();
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'HEX' },
  digestStringAsync: (...args: unknown[]) => digestStringAsync(...args),
}));

import {
  parseSkillCatalogManifest,
  fetchSkillCatalogManifest,
  fetchCatalogSkillContent,
  SKILLS_CATALOG_TAG,
  SKILLS_CATALOG_MANIFEST_ASSET,
  type SkillCatalogEntry,
} from '@/lib/skill-catalog';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  digestStringAsync.mockReset();
});

function validEntryRaw(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'git-commit-craft',
    description: 'Write small, scoped git commits.',
    version: '1.0.0',
    tags: ['git', 'workflow'],
    contentAssetName: 'git-commit-craft.SKILL.md',
    contentUrl: 'https://github.com/RYOITABASHI/Shelly/releases/download/skills-catalog-latest/git-commit-craft.SKILL.md',
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('parseSkillCatalogManifest', () => {
  it('accepts a well-formed manifest with one valid entry', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      channel: SKILLS_CATALOG_TAG,
      skills: [validEntryRaw()],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.skills).toHaveLength(1);
    expect(result.manifest?.skills[0].name).toBe('git-commit-craft');
    expect(result.manifest?.skills[0].sha256).toBe('a'.repeat(64));
  });

  it('rejects a non-object payload', () => {
    expect(parseSkillCatalogManifest(null).valid).toBe(false);
    expect(parseSkillCatalogManifest('a string').valid).toBe(false);
    expect(parseSkillCatalogManifest(42).valid).toBe(false);
  });

  it('rejects a manifest with a missing/invalid schemaVersion', () => {
    const result = parseSkillCatalogManifest({ skills: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schemaVersion/);
  });

  it('rejects a manifest whose "skills" field is not an array', () => {
    const result = parseSkillCatalogManifest({ schemaVersion: 1, skills: 'nope' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/skills.*not an array/);
  });

  it('drops an entry with an invalid name but keeps the manifest valid', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw({ name: 'Not_Valid' })],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills).toHaveLength(0);
    expect(result.errors.some((e) => e.includes('.name'))).toBe(true);
  });

  it('drops an entry with a non-https contentUrl', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw({ contentUrl: 'http://example.com/skill.md' })],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills).toHaveLength(0);
    expect(result.errors.some((e) => e.includes('.contentUrl'))).toBe(true);
  });

  it('drops an entry with a malformed sha256', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw({ sha256: 'not-a-hash' })],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills).toHaveLength(0);
    expect(result.errors.some((e) => e.includes('.sha256'))).toBe(true);
  });

  it('drops an entry missing a description', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw({ description: '' })],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills).toHaveLength(0);
    expect(result.errors.some((e) => e.includes('.description'))).toBe(true);
  });

  it('drops a duplicate-named entry, keeping only the first', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw(), validEntryRaw()],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills).toHaveLength(1);
    expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('keeps valid entries even when a sibling entry is malformed', () => {
    const result = parseSkillCatalogManifest({
      schemaVersion: 1,
      skills: [validEntryRaw({ name: 'bad name!' }), validEntryRaw({ name: 'shell-safety-review' })],
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.skills.map((s) => s.name)).toEqual(['shell-safety-review']);
    expect(result.errors).toHaveLength(1);
  });
});

function mockFetchSequence(responses: (Partial<Response> & { json?: () => Promise<any>; text?: () => Promise<string> })[]) {
  const fetchMock = jest.fn();
  for (const response of responses) {
    fetchMock.mockImplementationOnce(async () => response as Response);
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('fetchSkillCatalogManifest', () => {
  it('returns null when the release tag does not exist (404)', async () => {
    mockFetchSequence([{ ok: false, status: 404, text: async () => '' }]);
    const manifest = await fetchSkillCatalogManifest();
    expect(manifest).toBeNull();
  });

  it('resolves the manifest asset and returns a validated manifest', async () => {
    const manifestJson = { schemaVersion: 1, skills: [validEntryRaw()] };
    mockFetchSequence([
      {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            { name: SKILLS_CATALOG_MANIFEST_ASSET, browser_download_url: 'https://example.com/skills-catalog.json' },
          ],
        }),
      },
      { ok: true, status: 200, json: async () => manifestJson },
    ]);
    const manifest = await fetchSkillCatalogManifest();
    expect(manifest?.skills).toHaveLength(1);
    expect(manifest?.skills[0].name).toBe('git-commit-craft');
  });

  it('throws when the release exists but has no manifest asset', async () => {
    mockFetchSequence([{ ok: true, status: 200, json: async () => ({ assets: [] }) }]);
    await expect(fetchSkillCatalogManifest()).rejects.toThrow(/no .* asset/);
  });

  it('throws when the fetched manifest JSON is malformed', async () => {
    mockFetchSequence([
      {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            { name: SKILLS_CATALOG_MANIFEST_ASSET, browser_download_url: 'https://example.com/skills-catalog.json' },
          ],
        }),
      },
      { ok: true, status: 200, json: async () => ({ not: 'a valid manifest' }) },
    ]);
    await expect(fetchSkillCatalogManifest()).rejects.toThrow();
  });
});

const entry: SkillCatalogEntry = validEntryRaw({
  sha256: 'b'.repeat(64),
}) as SkillCatalogEntry;

describe('fetchCatalogSkillContent', () => {
  it('returns the content when the sha256 matches', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '---\nname: git-commit-craft\n---\nbody',
    }) as unknown as typeof fetch;
    digestStringAsync.mockResolvedValue('b'.repeat(64));

    const result = await fetchCatalogSkillContent(entry);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('---\nname: git-commit-craft\n---\nbody');
  });

  it('rejects content whose sha256 does not match the manifest-declared hash', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'tampered content',
    }) as unknown as typeof fetch;
    digestStringAsync.mockResolvedValue('c'.repeat(64));

    const result = await fetchCatalogSkillContent(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sha256 mismatch/);
  });

  it('reports a download failure without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const result = await fetchCatalogSkillContent(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 404/);
    expect(digestStringAsync).not.toHaveBeenCalled();
  });
});
