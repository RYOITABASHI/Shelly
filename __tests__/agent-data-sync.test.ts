import { collectFlatBundle, collectNestedBundle, restoreBundle, SyncFsPort } from '@/lib/agent-data-sync';

/** In-memory fake SyncFsPort — a nested Map keyed by directory path, each
 *  holding {name: content | 'DIR'} so listEntries can report isDirectory.
 *  writeFile REJECTS when its parent directory was never ensureDir'd (or
 *  seeded via `initial`/a prior write in that same dir) — mirrors real Expo
 *  FileSystem.writeAsStringAsync, which fails on a missing parent directory.
 *  This is what makes the "create the dir before writing a flat bundle
 *  entry" regression (2026-08-06 Codex review finding) an actual RED test
 *  instead of silently passing against an over-permissive fake. */
function makeFakeFs(initial: Record<string, string> = {}): { fs: SyncFsPort; files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  const ensuredDirs = new Set<string>();
  const dirsOf = (path: string) => Object.keys(files).filter((f) => f.startsWith(`${path}/`));
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

  // Seed: any directory that already (transitively) contains a file from
  // `initial` counts as pre-existing, same as a real filesystem.
  for (const path of Object.keys(files)) {
    let dir = parentOf(path);
    while (dir) {
      ensuredDirs.add(dir);
      dir = dir.includes('/') ? parentOf(dir) : '';
    }
  }

  const fs: SyncFsPort = {
    async readFile(path) {
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
    },
    async writeFile(path, data) {
      const parent = parentOf(path);
      if (!ensuredDirs.has(parent)) {
        throw new Error(`ENOENT (fake): parent directory not ensured before write: ${parent}`);
      }
      files[path] = data;
    },
    async deleteFile(path) {
      delete files[path];
    },
    async listEntries(dir) {
      const seen = new Map<string, boolean>();
      for (const full of dirsOf(dir)) {
        const rest = full.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          seen.set(rest, false);
        } else {
          seen.set(rest.slice(0, slash), true);
        }
      }
      return Array.from(seen.entries()).map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async ensureDir(dir) {
      ensuredDirs.add(dir);
    },
  };
  return { fs, files };
}

describe('collectFlatBundle', () => {
  it('bundles files matching the extension directly under dir, keyed by filename', async () => {
    const { fs } = makeFakeFs({
      '/agents/a1.json': '{"id":"a1"}',
      '/agents/a2.json': '{"id":"a2"}',
      '/agents/readme.txt': 'not an agent',
    });
    const bundle = await collectFlatBundle(fs, '/agents', ['.json']);
    expect(bundle).toEqual({ 'a1.json': '{"id":"a1"}', 'a2.json': '{"id":"a2"}' });
  });

  it('skips subdirectories entirely (agents/memory, agents/skills, etc. sitting alongside *.json)', async () => {
    const { fs } = makeFakeFs({
      '/agents/a1.json': '{"id":"a1"}',
      '/agents/memory/a1/fact-1.md': 'a memory note',
      '/agents/skills/some-skill.md': 'a skill',
    });
    const bundle = await collectFlatBundle(fs, '/agents', ['.json']);
    expect(bundle).toEqual({ 'a1.json': '{"id":"a1"}' });
  });

  it('returns an empty object for a missing/empty directory', async () => {
    const { fs } = makeFakeFs({});
    expect(await collectFlatBundle(fs, '/agents', ['.json'])).toEqual({});
  });

  it('applies an optional isValid content filter, excluding non-matching files (2026-08-06 Codex review finding: ~/.shelly/agents/*.json is not exclusively agent metadata)', async () => {
    const { fs } = makeFakeFs({
      '/agents/agent-1.json': '{"id":"agent-1","name":"A","prompt":"do X"}',
      '/agents/dm-pairings.json': '[{"id":"pair-1"}]',
      '/agents/policy.json': '{"level":"L2"}',
    });
    const looksLikeAgent = (content: string) => {
      try {
        const p = JSON.parse(content);
        return typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.prompt === 'string';
      } catch {
        return false;
      }
    };
    const bundle = await collectFlatBundle(fs, '/agents', ['.json'], looksLikeAgent);
    expect(bundle).toEqual({ 'agent-1.json': '{"id":"agent-1","name":"A","prompt":"do X"}' });
  });

  it('with no isValid filter, behaves exactly as before (no filtering) — the skills category has no such ambiguity', async () => {
    const { fs } = makeFakeFs({ '/skills/my-skill.md': '# skill' });
    expect(await collectFlatBundle(fs, '/skills', ['.md'])).toEqual({ 'my-skill.md': '# skill' });
  });
});

describe('collectNestedBundle', () => {
  it('bundles files one level below dir, keyed as "<subdir>/<filename>"', async () => {
    const { fs } = makeFakeFs({
      '/agents/memory/agent-1/fact-1.md': 'note A',
      '/agents/memory/agent-1/fact-2.md': 'note B',
      '/agents/memory/_global/pref-1.md': 'global note',
    });
    const bundle = await collectNestedBundle(fs, '/agents/memory', ['.md']);
    expect(bundle).toEqual({
      'agent-1/fact-1.md': 'note A',
      'agent-1/fact-2.md': 'note B',
      '_global/pref-1.md': 'global note',
    });
  });

  it('ignores files sitting directly in dir (not one level down) and non-matching extensions', async () => {
    const { fs } = makeFakeFs({
      '/agents/memory/stray.md': 'should be ignored — not inside a subdir',
      '/agents/memory/agent-1/fact.md': 'kept',
      '/agents/memory/agent-1/fact.tmp': 'ignored — wrong extension',
    });
    const bundle = await collectNestedBundle(fs, '/agents/memory', ['.md']);
    expect(bundle).toEqual({ 'agent-1/fact.md': 'kept' });
  });
});

describe('restoreBundle', () => {
  it('restores a flat bundle (agents/skills shape) directly under dir', async () => {
    const { fs, files } = makeFakeFs({});
    await restoreBundle(fs, '/agents', { 'a1.json': '{"id":"a1"}' });
    expect(files['/agents/a1.json']).toBe('{"id":"a1"}');
  });

  it('restores a nested bundle (memory shape), creating the subdir', async () => {
    const { fs, files } = makeFakeFs({});
    await restoreBundle(fs, '/agents/memory', { 'agent-1/fact.md': 'note content' });
    expect(files['/agents/memory/agent-1/fact.md']).toBe('note content');
  });

  it('round-trips collectFlatBundle -> restoreBundle -> collectFlatBundle unchanged', async () => {
    const { fs: sourceFs } = makeFakeFs({ '/src/a1.json': 'A', '/src/a2.json': 'B' });
    const bundle = await collectFlatBundle(sourceFs, '/src', ['.json']);
    const { fs: destFs } = makeFakeFs({});
    await restoreBundle(destFs, '/dest', bundle);
    const restored = await collectFlatBundle(destFs, '/dest', ['.json']);
    expect(restored).toEqual(bundle);
  });

  it('round-trips collectNestedBundle -> restoreBundle -> collectNestedBundle unchanged', async () => {
    const { fs: sourceFs } = makeFakeFs({ '/src/memory/a1/x.md': 'X', '/src/memory/_global/y.md': 'Y' });
    const bundle = await collectNestedBundle(sourceFs, '/src/memory', ['.md']);
    const { fs: destFs } = makeFakeFs({});
    await restoreBundle(destFs, '/dest/memory', bundle);
    const restored = await collectNestedBundle(destFs, '/dest/memory', ['.md']);
    expect(restored).toEqual(bundle);
  });

  it('rejects a key with ".." path traversal instead of writing outside dir (hostile/corrupt Gist content)', async () => {
    const { fs, files } = makeFakeFs({});
    await restoreBundle(fs, '/agents', { '../../etc/passwd': 'malicious' });
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('rejects a key with more than one path separator (never a valid agents/skills/memory shape)', async () => {
    const { fs, files } = makeFakeFs({});
    await restoreBundle(fs, '/agents/memory', { 'a/b/c.md': 'too deep' });
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('rejects an absolute-path key', async () => {
    const { fs, files } = makeFakeFs({});
    await restoreBundle(fs, '/agents', { '/etc/passwd': 'malicious' });
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('does not throw on an empty bundle, and returns empty key lists', async () => {
    const { fs } = makeFakeFs({});
    await expect(restoreBundle(fs, '/agents', {})).resolves.toEqual({ writtenKeys: [], mirrorDeletedKeys: [] });
  });

  it('returns the safe, actually-written key list — never the raw untrusted bundle keys (2026-08-06 Codex review finding: a caller doing its own side-effecting work keyed off "what was restored" must use this, not Object.keys(bundle))', async () => {
    const { fs } = makeFakeFs({});
    const returned = await restoreBundle(fs, '/agents', {
      'agent-1.json': '{"id":"agent-1"}',
      '../../etc/passwd': 'malicious — must never appear in the returned list',
    });
    expect(returned.writtenKeys).toEqual(['agent-1.json']);
  });

  describe('mirror mode (2026-08-06 Codex review finding: a deletion on one device must reach the other)', () => {
    it('without mirror (default), a local file absent from the bundle is left behind — a stale leftover', async () => {
      const { fs, files } = makeFakeFs({ '/agents/deleted-elsewhere.json': 'still here' });
      await restoreBundle(fs, '/agents', { 'agent-1.json': '{"id":"agent-1"}' });
      expect(files['/agents/deleted-elsewhere.json']).toBe('still here');
      expect(files['/agents/agent-1.json']).toBe('{"id":"agent-1"}');
    });

    it('mirror: true without shape throws — refuses to guess the deletion scope (2026-08-06 Codex review finding, second pass)', async () => {
      const { fs } = makeFakeFs({ '/agents/agent-1.json': '{"id":"agent-1"}' });
      await expect(restoreBundle(fs, '/agents', { 'agent-1.json': '{"id":"a"}' }, { mirror: true })).rejects.toThrow(
        'mirror requires shape',
      );
    });

    it('with mirror: true + shape, a flat local file matching the shape and absent from the bundle is deleted', async () => {
      const { fs, files } = makeFakeFs({ '/agents/deleted-elsewhere.json': 'stale' });
      await restoreBundle(
        fs,
        '/agents',
        { 'agent-1.json': '{"id":"agent-1"}' },
        { mirror: true, shape: { nested: false, extensions: ['.json'] } },
      );
      expect(files['/agents/deleted-elsewhere.json']).toBeUndefined();
      expect(files['/agents/agent-1.json']).toBe('{"id":"agent-1"}');
    });

    it('with mirror: true + shape, a nested (memory-shape) local file absent from the bundle is deleted', async () => {
      const { fs, files } = makeFakeFs({
        '/agents/memory/agent-1/deleted-fact.md': 'stale note',
        '/agents/memory/agent-1/kept-fact.md': 'kept note',
      });
      await restoreBundle(
        fs,
        '/agents/memory',
        { 'agent-1/kept-fact.md': 'kept note' },
        { mirror: true, shape: { nested: true, extensions: ['.md'] } },
      );
      expect(files['/agents/memory/agent-1/deleted-fact.md']).toBeUndefined();
      expect(files['/agents/memory/agent-1/kept-fact.md']).toBe('kept note');
    });

    it('with mirror: true, an EMPTY bundle deletes nothing UNLESS allowEmptyMirror is also set (network hiccup must never look like "delete everything")', async () => {
      const { fs, files } = makeFakeFs({ '/agents/agent-1.json': 'still here' });
      await restoreBundle(fs, '/agents', {}, { mirror: true, shape: { nested: false, extensions: ['.json'] } });
      expect(files['/agents/agent-1.json']).toBe('still here');
    });

    it('with mirror: true + allowEmptyMirror: true, an EMPTY bundle DOES clear the category — the explicit "category is now genuinely empty" case (2026-08-06 Codex review finding)', async () => {
      const { fs, files } = makeFakeFs({ '/agents/agent-1.json': 'last one, now deleted upstream' });
      await restoreBundle(fs, '/agents', {}, { mirror: true, allowEmptyMirror: true, shape: { nested: false, extensions: ['.json'] } });
      expect(files['/agents/agent-1.json']).toBeUndefined();
    });

    it('mirror NEVER touches a sibling subdirectory when shape is flat — agents mirror leaves agents/skills/* completely alone (2026-08-06 Codex review finding, second pass: the P1 unrelated-file-deletion bug)', async () => {
      const { fs, files } = makeFakeFs({
        '/agents/agent-1.json': 'stale, will be removed',
        '/agents/skills/some-skill.md': 'must survive — not this category',
        '/agents/memory/agent-1/fact.md': 'must survive — not this category',
      });
      await restoreBundle(fs, '/agents', {}, { mirror: true, allowEmptyMirror: true, shape: { nested: false, extensions: ['.json'] } });
      expect(files['/agents/agent-1.json']).toBeUndefined();
      expect(files['/agents/skills/some-skill.md']).toBe('must survive — not this category');
      expect(files['/agents/memory/agent-1/fact.md']).toBe('must survive — not this category');
    });

    it('mirror NEVER touches a flat file matching the extension but NOT owned by this category, when isValid is given — dm-pairings.json/policy.json survive an agents mirror (2026-08-06 Codex review finding, second pass)', async () => {
      const isAgentShaped = (content: string) => {
        try {
          const p = JSON.parse(content);
          return typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.prompt === 'string';
        } catch {
          return false;
        }
      };
      const { fs, files } = makeFakeFs({
        '/agents/agent-1.json': '{"id":"agent-1","name":"A","prompt":"x"}',
        '/agents/dm-pairings.json': '[{"id":"pair-1"}]',
        '/agents/policy.json': '{"level":"L2"}',
      });
      // Bundle now contains ONLY agent-2 — agent-1 was deleted elsewhere.
      await restoreBundle(
        fs,
        '/agents',
        { 'agent-2.json': '{"id":"agent-2","name":"B","prompt":"y"}' },
        { mirror: true, shape: { nested: false, extensions: ['.json'], isValid: isAgentShaped } },
      );
      expect(files['/agents/agent-1.json']).toBeUndefined(); // correctly mirror-deleted — it WAS agent-shaped
      expect(files['/agents/dm-pairings.json']).toBe('[{"id":"pair-1"}]'); // never touched — not agent-shaped
      expect(files['/agents/policy.json']).toBe('{"level":"L2"}'); // never touched — not agent-shaped
      expect(files['/agents/agent-2.json']).toBe('{"id":"agent-2","name":"B","prompt":"y"}');
    });

    it('write path also rejects an isValid-failing bundle entry (a contaminated/manually-edited Gist cannot write to an unrelated file even without mirror)', async () => {
      const isAgentShaped = (content: string) => {
        try {
          const p = JSON.parse(content);
          return typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.prompt === 'string';
        } catch {
          return false;
        }
      };
      const { fs, files } = makeFakeFs({});
      await restoreBundle(
        fs,
        '/agents',
        { 'agent-1.json': '{"id":"agent-1","name":"A","prompt":"x"}', 'policy.json': '{"level":"L2"}' },
        { shape: { nested: false, extensions: ['.json'], isValid: isAgentShaped } },
      );
      expect(files['/agents/agent-1.json']).toBe('{"id":"agent-1","name":"A","prompt":"x"}');
      expect(files['/agents/policy.json']).toBeUndefined();
    });

    it('a NON-EMPTY bundle where every entry fails isValid is treated as CORRUPT, not "deliberately empty" — must NOT mirror-delete the local category (2026-08-06 Codex review finding, fifth pass)', async () => {
      const isAgentShaped = (content: string) => {
        try {
          const p = JSON.parse(content);
          return typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.prompt === 'string';
        } catch {
          return false;
        }
      };
      const { fs, files } = makeFakeFs({ '/agents/agent-1.json': '{"id":"agent-1","name":"A","prompt":"x"}' });
      // Bundle is non-empty but every entry is non-agent-shaped — e.g. a
      // foreign/manually-edited gist file that happens to sit under the
      // agents bundle filename.
      const returned = await restoreBundle(
        fs,
        '/agents',
        { 'dm-pairings.json': '[{"id":"pair-1"}]', 'policy.json': '{"level":"L2"}' },
        { mirror: true, allowEmptyMirror: true, shape: { nested: false, extensions: ['.json'], isValid: isAgentShaped } },
      );
      expect(returned.writtenKeys).toEqual([]);
      // The load-bearing assertion: agent-1.json must SURVIVE. Under the bug
      // this regression-tests, a non-empty-but-fully-rejected bundle reduced
      // to keys.length === 0 and was indistinguishable from a genuine `{}`,
      // so allowEmptyMirror wiped every real local agent file.
      expect(files['/agents/agent-1.json']).toBe('{"id":"agent-1","name":"A","prompt":"x"}');
    });

    it('a flat shape (nested: false) rejects a key containing "/" even if its basename matches the extension — never writes outside dir into a sibling subdirectory like agents/plans/ (2026-08-06 Codex review finding, fifth pass)', async () => {
      const { fs, files } = makeFakeFs({});
      const returned = await restoreBundle(
        fs,
        '/agents',
        { 'plans/agent-1.json': '{"id":"agent-1"}' },
        { shape: { nested: false, extensions: ['.json'] } },
      );
      expect(returned.writtenKeys).toEqual([]);
      expect(files['/agents/plans/agent-1.json']).toBeUndefined();
    });

    it('a nested shape (nested: true) rejects a key with zero slashes (flat) or two-plus slashes (too deep) — only exactly one slash is the real memory/<agentId>/<file> shape (2026-08-06 Codex review finding, fifth pass)', async () => {
      const { fs, files } = makeFakeFs({});
      const returned = await restoreBundle(
        fs,
        '/agents/memory',
        { 'flat-file.md': 'wrong shape for a nested category' },
        { shape: { nested: true, extensions: ['.md'] } },
      );
      expect(returned.writtenKeys).toEqual([]);
      expect(files['/agents/memory/flat-file.md']).toBeUndefined();
      // Two-plus slashes is already rejected by isSafeRelativeKey's own
      // segments.length > 2 guard — confirmed here for completeness under
      // the SAME shape-aware path this test targets.
      const { fs: fs2, files: files2 } = makeFakeFs({});
      await restoreBundle(fs2, '/agents/memory', { 'a/b/c.md': 'too deep' }, { shape: { nested: true, extensions: ['.md'] } });
      expect(files2['/agents/memory/a/b/c.md']).toBeUndefined();
    });
  });
});
