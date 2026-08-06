const mockAsyncStorageValues = new Map<string, string>();
const mockAsyncStorageGetItem = jest.fn((key: string) => Promise.resolve(mockAsyncStorageValues.get(key) ?? null));
const mockAsyncStorageSetItem = jest.fn((key: string, value: string) => {
  mockAsyncStorageValues.set(key, value);
  return Promise.resolve();
});
const mockAsyncStorageRemoveItem = jest.fn((key: string) => {
  mockAsyncStorageValues.delete(key);
  return Promise.resolve();
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockAsyncStorageGetItem,
    setItem: mockAsyncStorageSetItem,
    removeItem: mockAsyncStorageRemoveItem,
  },
}));

const mockSecureStoreValues = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockSecureStoreValues.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    mockSecureStoreValues.set(key, value);
    return Promise.resolve();
  }),
}));

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

// In-memory fake filesystem backing the mocked SyncFsPort — separate from
// the AsyncStorage/SecureStore maps above since it models real files under
// ~/.shelly/agents, not app settings.
const fakeDiskFiles = new Map<string, string>();

function fakeListEntries(dir: string) {
  const seen = new Map<string, boolean>();
  for (const path of fakeDiskFiles.keys()) {
    if (!path.startsWith(`${dir}/`)) continue;
    const rest = path.slice(dir.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) seen.set(rest, false);
    else seen.set(rest.slice(0, slash), true);
  }
  return Promise.resolve(Array.from(seen.entries()).map(([name, isDirectory]) => ({ name, isDirectory })));
}

const deleteFileCalls: string[] = [];

jest.mock('@/lib/agent-data-sync-fs-expo', () => ({
  createAgentDataSyncFsPort: () => ({
    readFile: (path: string) => Promise.resolve(fakeDiskFiles.has(path) ? (fakeDiskFiles.get(path) as string) : null),
    writeFile: (path: string, data: string) => {
      fakeDiskFiles.set(path, data);
      return Promise.resolve();
    },
    deleteFile: (path: string) => {
      deleteFileCalls.push(path);
      fakeDiskFiles.delete(path);
      return Promise.resolve();
    },
    listEntries: fakeListEntries,
    ensureDir: () => Promise.resolve(),
  }),
}));

import { useDotfilesStore } from '@/lib/dotfiles-sync';

function resetStore() {
  mockAsyncStorageValues.clear();
  mockSecureStoreValues.clear();
  fakeDiskFiles.clear();
  deleteFileCalls.length = 0;
  useDotfilesStore.setState({
    pat: 'test-pat',
    gistId: '',
    lastSync: null,
    isSyncing: false,
    error: null,
    includeAgentData: false,
  });
}

describe('dotfiles-sync — agent data (agents/skills/memory) opt-in backup', () => {
  beforeEach(() => {
    resetStore();
    (global as any).fetch = jest.fn();
  });

  it('setIncludeAgentData persists the toggle to AsyncStorage', () => {
    useDotfilesStore.getState().setIncludeAgentData(true);
    expect(useDotfilesStore.getState().includeAgentData).toBe(true);
    expect(mockAsyncStorageValues.get('@shelly/dotfiles_include_agent_data')).toBe('1');
  });

  it('loadConfig restores includeAgentData from AsyncStorage (defaults to false when unset)', async () => {
    mockAsyncStorageValues.set('@shelly/dotfiles_include_agent_data', '1');
    await useDotfilesStore.getState().loadConfig();
    expect(useDotfilesStore.getState().includeAgentData).toBe(true);

    mockAsyncStorageValues.delete('@shelly/dotfiles_include_agent_data');
    await useDotfilesStore.getState().loadConfig();
    expect(useDotfilesStore.getState().includeAgentData).toBe(false);
  });

  it('syncToGist does NOT upload agent/skill/memory bundles when includeAgentData is off (default)', async () => {
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/agent-1.json', '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}');
    mockAsyncStorageValues.set('shelly_settings', '{"theme":"dark"}');
    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-gist-id' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    expect(capturedBody.files['shelly-settings.json']).toBeDefined();
    expect(capturedBody.files['shelly-agents-bundle.json']).toBeUndefined();
    expect(capturedBody.files['shelly-skills-bundle.json']).toBeUndefined();
    expect(capturedBody.files['shelly-memory-bundle.json']).toBeUndefined();
  });

  it('syncToGist uploads all three agent-data bundles when includeAgentData is on', async () => {
    useDotfilesStore.getState().setIncludeAgentData(true);
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/agent-1.json', '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}');
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/skills/my-skill.md', '# skill');
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/memory/agent-1/fact-1.md', 'a fact');
    // Directories that must NOT leak into the flat agents bundle.
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/skills/my-skill.md', '# skill');

    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-gist-id' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    expect(JSON.parse(capturedBody.files['shelly-agents-bundle.json'].content)).toEqual({
      'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    });
    expect(JSON.parse(capturedBody.files['shelly-skills-bundle.json'].content)).toEqual({ 'my-skill.md': '# skill' });
    expect(JSON.parse(capturedBody.files['shelly-memory-bundle.json'].content)).toEqual({ 'agent-1/fact-1.md': 'a fact' });
  });

  it('syncToGist deletes stale agent-data bundles (sends null) when includeAgentData was turned back off on an EXISTING gist (2026-08-06 Codex review finding)', async () => {
    // includeAgentData is off (the resetStore default) but a gistId already
    // exists — simulating "a prior sync uploaded agent data, then the user
    // opted back out." Without the fix, PATCH simply omits these three
    // filenames, which GitHub's Gist API treats as "leave unchanged," so the
    // old agent/memory content would remain in the gist forever.
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: false });
    mockAsyncStorageValues.set('shelly_settings', '{"theme":"dark"}');
    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'existing-gist' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    expect(capturedBody.files['shelly-agents-bundle.json']).toBeNull();
    expect(capturedBody.files['shelly-skills-bundle.json']).toBeNull();
    expect(capturedBody.files['shelly-memory-bundle.json']).toBeNull();
    // Unrelated settings sync is unaffected.
    expect(capturedBody.files['shelly-settings.json']).toEqual({ content: '{"theme":"dark"}' });
  });

  it('syncToGist does NOT send agent-data deletion markers when creating a BRAND NEW gist (nothing to delete yet)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: '', includeAgentData: false });
    mockAsyncStorageValues.set('shelly_settings', '{"theme":"dark"}');
    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'brand-new-gist' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    expect('shelly-agents-bundle.json' in capturedBody.files).toBe(false);
    expect('shelly-skills-bundle.json' in capturedBody.files).toBe(false);
    expect('shelly-memory-bundle.json' in capturedBody.files).toBe(false);
  });

  it('syncFromGist restores agent-data bundles to disk when includeAgentData is on', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}' }),
            },
            'shelly-memory-bundle.json': { content: JSON.stringify({ 'agent-1/fact-1.md': 'a fact' }) },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/agent-1.json')).toBe(
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/memory/agent-1/fact-1.md')).toBe('a fact');
  });

  it('syncFromGist does not restore agent-data bundles when includeAgentData is off, even if present in the gist', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: false });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}' }),
            },
          },
        }),
    });

    await useDotfilesStore.getState().syncFromGist();
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/agent-1.json')).toBe(false);
  });

  it('syncFromGist tolerates a corrupt/foreign agent-data gist file (malformed JSON) without throwing', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: { 'shelly-agents-bundle.json': { content: 'not valid json {{{' } },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
  });

  it('syncToGist excludes non-agent JSON files (dm-pairings.json, policy.json) sitting flat in ~/.shelly/agents from the agents bundle (2026-08-06 Codex review finding)', async () => {
    useDotfilesStore.getState().setIncludeAgentData(true);
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/agent-1.json',
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/dm-pairings.json', '[{"id":"pair-1"}]');
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/policy.json', '{"level":"L2"}');

    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new-gist-id' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    const bundle = JSON.parse(capturedBody.files['shelly-agents-bundle.json'].content);
    expect(bundle).toEqual({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}' });
    expect(bundle['dm-pairings.json']).toBeUndefined();
    expect(bundle['policy.json']).toBeUndefined();
  });

  it('syncToGist uploads an explicit {} (not a null delete) for a category that is now empty on an existing gist — e.g. every memory note was deleted since the last sync (2026-08-06 Codex review finding, third pass: null vs {} distinguishes "never synced" from "deliberately emptied" on restore)', async () => {
    useDotfilesStore.getState().setIncludeAgentData(true);
    useDotfilesStore.setState({ gistId: 'existing-gist' });
    // Only an agent exists on disk now; skills and memory are both empty
    // (as if the user deleted every skill/note since the previous sync).
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/agent-1.json',
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );

    let capturedBody: any = null;
    (global.fetch as jest.Mock).mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'existing-gist' }) });
    });

    const ok = await useDotfilesStore.getState().syncToGist();
    expect(ok).toBe(true);
    expect(capturedBody.files['shelly-agents-bundle.json']).toEqual({
      content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}' }),
    });
    expect(capturedBody.files['shelly-skills-bundle.json']).toEqual({ content: '{}' });
    expect(capturedBody.files['shelly-memory-bundle.json']).toEqual({ content: '{}' });
  });

  it('syncFromGist mirrors deletions: a local agent absent from the gist bundle is removed (2026-08-06 Codex review finding)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    // Locally present but no longer in the gist bundle — simulates "deleted on device A, then this device syncs."
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/deleted-on-other-device.json',
      '{"id":"deleted-on-other-device","name":"Stale Agent","prompt":"x"}',
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}' }),
            },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/deleted-on-other-device.json')).toBe(false);
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/agent-1.json')).toBe('{"id":"agent-1","name":"Agent One","prompt":"x"}');
  });

  it('syncFromGist skips a bundle whose values are not all strings, instead of failing the whole sync — and crucially does NOT mirror-delete the local category as a side effect (2026-08-06 Codex review finding, second pass: an object-shaped-but-invalid bundle was falling through as an EMPTY bundle and wiping the category)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    // A real, agent-shaped local file — WOULD be mirror-deleted by the bug
    // this test locks (object-shaped-but-non-string-values bundle silently
    // treated as "genuinely empty" -> allowEmptyMirror wipes the category).
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/kept.json',
      '{"id":"kept","name":"Kept Agent","prompt":"stay"}',
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            // A malformed/foreign gist file: valid JSON object, but the value is a number, not a string.
            'shelly-agents-bundle.json': { content: JSON.stringify({ 'bad.json': 42 }) },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/bad.json')).toBe(false);
    // The load-bearing assertion: kept.json must SURVIVE. Under the bug this
    // regression-tests, the malformed bundle fell through as `bundle = {}`,
    // which (indistinguishable from "gist genuinely has zero agents now")
    // triggered allowEmptyMirror and deleted every real local agent file.
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/kept.json')).toBe(
      '{"id":"kept","name":"Kept Agent","prompt":"stay"}',
    );
  });

  it('syncFromGist does NOT touch local agent data when the Gist has no agent-data bundles at all — e.g. an ordinary settings-only Gist that predates includeAgentData (2026-08-06 Codex review finding, third pass: the most severe version of the "missing vs deliberately-empty" bug — turning includeAgentData on and downloading an existing settings-only Gist must never wipe local agents)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-settings-only-gist', includeAgentData: true });
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/agent-1.json',
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/skills/my-skill.md', '# skill');
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/memory/agent-1/fact.md', 'a fact');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      // No shelly-*-bundle.json keys at all — a real ordinary settings-only gist shape.
      json: () => Promise.resolve({ files: { 'shelly-settings.json': { content: '{"theme":"dark"}' } } }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/agent-1.json')).toBe(
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/skills/my-skill.md')).toBe('# skill');
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/memory/agent-1/fact.md')).toBe('a fact');
  });

  it('syncFromGist DOES clear a category when the Gist bundle is explicitly {} (present but empty — the deliberate-deletion signal)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/memory/agent-1/deleted-elsewhere.md',
      'stale — deleted on every device that synced since',
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: { 'shelly-memory-bundle.json': { content: '{}' } } }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/memory/agent-1/deleted-elsewhere.md')).toBe(false);
  });

  it('syncFromGist clears a stale .deleted marker for an agent that is being restored, so the restored agent is not hidden by loadAgentsFromDisk (2026-08-06 Codex review finding)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    // Simulates: this device deleted "agent-1" earlier (leaving a marker),
    // then syncs FROM a Gist where another device still has agent-1 — the
    // restore should bring it back, which means the marker must go away too.
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/.deleted/agent-1', '2026-08-01T00:00:00Z');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}' }),
            },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/agent-1.json')).toBe(
      '{"id":"agent-1","name":"Agent One","prompt":"x"}',
    );
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/.deleted/agent-1')).toBe(false);
  });

  it('syncToGist and syncFromGist refuse to run concurrently — a second call while one is in flight returns false without touching the network or disk (2026-08-06 Codex review finding, round 10: an overlapping upload/download could mirror-delete a local agent mid-upload and lose it both locally and in the Gist)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/agent-1.json',
      '{"id":"agent-1","name":"Agent One","prompt":"do the thing"}',
    );
    let fetchCallCount = 0;
    (global.fetch as jest.Mock).mockImplementation(() => {
      fetchCallCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 'existing-gist', files: {} }),
      });
    });

    const firstCall = useDotfilesStore.getState().syncFromGist();
    // Fired while the first call is still in flight (isSyncing was set
    // synchronously before its first await) — must be rejected outright.
    const secondCall = useDotfilesStore.getState().syncToGist();

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult).toBe(true);
    expect(secondResult).toBe(false);
    expect(fetchCallCount).toBe(1);
  });

  it('syncFromGist writes a .deleted marker for an agent mirror-deleted by an incoming bundle, so HomeInitializer.kt does not silently recreate a seeded agent on next launch (2026-08-06 Codex review finding, seventh pass)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    // Present locally, but the incoming bundle no longer has it — a deletion
    // made on another device that this sync must mirror.
    fakeDiskFiles.set(
      '/home/shelly-test/.shelly/agents/x-trend-source-collector.json',
      '{"id":"x-trend-source-collector","name":"X Trend Collector","prompt":"x"}',
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({ 'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}' }),
            },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/x-trend-source-collector.json')).toBe(false);
    // The load-bearing assertion: a marker must exist, or installAgentIfMissing()
    // would recreate this exact seeded agent on the next app launch, silently
    // undoing the deletion that was supposed to have synced.
    expect(fakeDiskFiles.has('/home/shelly-test/.shelly/agents/.deleted/x-trend-source-collector')).toBe(true);
  });

  it('syncFromGist rejects a tampered bundle entry keyed as an unrelated file (policy.json) even when its forged content parses as agent-shaped, because the content\'s own id does not match the filename (2026-08-06 Codex review finding, sixth pass)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    fakeDiskFiles.set('/home/shelly-test/.shelly/agents/policy.json', '{"level":"L2"}');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({
                'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}',
                // Forged: parses as {id, name, prompt} but its own id is
                // "agent-1", not "policy" — must not be allowed to land on
                // policy.json just because the bundle KEY says so.
                'policy.json': '{"id":"agent-1","name":"Forged","prompt":"evil"}',
              }),
            },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/policy.json')).toBe('{"level":"L2"}');
    expect(fakeDiskFiles.get('/home/shelly-test/.shelly/agents/agent-1.json')).toBe(
      '{"id":"agent-1","name":"Agent One","prompt":"x"}',
    );
  });

  it('syncFromGist never attempts a marker delete outside .deleted/ even when a tampered gist bundle carries a path-traversal key (2026-08-06 Codex review finding, fourth pass)', async () => {
    useDotfilesStore.setState({ pat: 'test-pat', gistId: 'existing-gist', includeAgentData: true });
    // A real file that HAPPENS to sit at the path a "../../some-other-file-
    // outside-agents" traversal key would resolve `.deleted/../../...` to —
    // if clearDeletedAgentMarkers ever used the raw untrusted bundle key
    // instead of restoreBundle's safe/filtered return value, this is exactly
    // what it would delete.
    fakeDiskFiles.set('/home/shelly-test/some-other-file-outside-agents', 'must survive');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          files: {
            'shelly-agents-bundle.json': {
              content: JSON.stringify({
                'agent-1.json': '{"id":"agent-1","name":"Agent One","prompt":"x"}',
                '../../some-other-file-outside-agents.json': 'malicious traversal key',
              }),
            },
          },
        }),
    });

    const ok = await useDotfilesStore.getState().syncFromGist();
    expect(ok).toBe(true);
    // The load-bearing assertion: NO deleteFile call ever resolves through
    // the traversal key. Checking the call log directly (not just the end
    // state) means this test would have failed under the actual bug this
    // regression-tests, even though the fake's naive string-keyed Map
    // wouldn't itself "resolve" `..` segments the way a real filesystem does.
    expect(deleteFileCalls.some((p) => p.includes('some-other-file-outside-agents'))).toBe(false);
    expect(fakeDiskFiles.get('/home/shelly-test/some-other-file-outside-agents')).toBe('must survive');
  });
});
