/**
 * tests/snippet-io.test.ts
 *
 * Unit tests for lib/snippet-io.ts (v1.6)
 * Covers: export payload building, JSON validation, merge strategies,
 *         error handling, large imports, and summary text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  Share: {
    share: vi.fn().mockResolvedValue({ action: 'sharedAction' }),
    dismissedAction: 'dismissedAction',
  },
  Platform: {
    OS: 'android',
    Version: '14',
  },
}));

// ── Import functions under test ───────────────────────────────────────────────

import {
  SCHEMA_VERSION,
  buildExportPayload,
  serializePayload,
  exportFilename,
  exportSnippets,
  validateSnippetJson,
  mergeSnippets,
  importSummaryText,
  validationErrorLabel,
  type SnippetExportPayload,
  type ImportResult,
} from '../lib/snippet-io';

// ── Helpers ───────────────────────────────────────────────────────────────────

type Snippet = {
  id: string;
  title: string;
  command: string;
  tags: string[];
  scope: 'global' | 'session';
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
};

let idCounter = 0;
function makeSnippet(command: string, overrides: Partial<Snippet> = {}): Snippet {
  idCounter++;
  return {
    id: `snip-test-${idCounter}`,
    title: command.slice(0, 20),
    command,
    tags: [],
    scope: 'global',
    createdAt: 1_700_000_000_000 + idCounter,
    lastUsedAt: 1_700_000_000_000 + idCounter,
    useCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
  vi.clearAllMocks();
});

// ─── buildExportPayload ───────────────────────────────────────────────────────

describe('buildExportPayload', () => {
  it('should include schemaVersion, exportedAt, device, count, and snippets', () => {
    const snippets = [makeSnippet('ls -la'), makeSnippet('pwd')];
    const payload = buildExportPayload(snippets);

    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof payload.exportedAt).toBe('string');
    expect(new Date(payload.exportedAt).getTime()).not.toBeNaN();
    expect(payload.device).toContain('android');
    expect(payload.count).toBe(2);
    expect(payload.snippets).toHaveLength(2);
    expect(payload.snippets[0].command).toBe('ls -la');
  });

  it('should handle empty snippet list', () => {
    const payload = buildExportPayload([]);
    expect(payload.count).toBe(0);
    expect(payload.snippets).toHaveLength(0);
  });
});

// ─── serializePayload ─────────────────────────────────────────────────────────

describe('serializePayload', () => {
  it('should produce valid JSON', () => {
    const payload = buildExportPayload([makeSnippet('echo hello')]);
    const json = serializePayload(payload);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should be pretty-printed (indented)', () => {
    const payload = buildExportPayload([makeSnippet('echo hello')]);
    const json = serializePayload(payload);
    expect(json).toContain('\n');
    expect(json).toContain('  ');
  });
});

// ─── exportFilename ───────────────────────────────────────────────────────────

describe('exportFilename', () => {
  it('should match shelly-snippets-YYYYMMDD.json pattern', () => {
    const filename = exportFilename();
    expect(filename).toMatch(/^shelly-snippets-\d{8}\.json$/);
  });
});

// ─── exportSnippets ───────────────────────────────────────────────────────────

describe('exportSnippets', () => {
  it('should return false for empty snippet list', async () => {
    const result = await exportSnippets([]);
    expect(result).toBe(false);
  });

  it('should call Share.share and return true on success', async () => {
    const { Share } = await import('react-native');
    (Share.share as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ action: 'sharedAction' });

    const snippets = [makeSnippet('ls -la')];
    const result = await exportSnippets(snippets);
    expect(result).toBe(true);
    expect(Share.share).toHaveBeenCalledOnce();
  });

  it('should return false when share is dismissed', async () => {
    const { Share } = await import('react-native');
    (Share.share as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ action: 'dismissedAction' });

    const result = await exportSnippets([makeSnippet('ls')]);
    expect(result).toBe(false);
  });

  it('should return false when Share.share throws', async () => {
    const { Share } = await import('react-native');
    (Share.share as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Share failed'));

    const result = await exportSnippets([makeSnippet('ls')]);
    expect(result).toBe(false);
  });
});

// ─── validateSnippetJson ──────────────────────────────────────────────────────

describe('validateSnippetJson', () => {
  it('should return ok:true for a valid payload', () => {
    const payload = buildExportPayload([makeSnippet('ls -la'), makeSnippet('pwd')]);
    const json = serializePayload(payload);
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.snippets).toHaveLength(2);
    }
  });

  it('should return INVALID_JSON for malformed JSON', () => {
    const result = validateSnippetJson('{ not valid json }');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_JSON');
    }
  });

  it('should return INVALID_JSON for non-object root', () => {
    const result = validateSnippetJson('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_JSON');
    }
  });

  it('should return MISSING_SCHEMA_VERSION when field is absent', () => {
    const json = JSON.stringify({ snippets: [] });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('MISSING_SCHEMA_VERSION');
    }
  });

  it('should return UNSUPPORTED_SCHEMA_VERSION for future version', () => {
    const json = JSON.stringify({ schemaVersion: 999, snippets: [] });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('UNSUPPORTED_SCHEMA_VERSION');
    }
  });

  it('should return MISSING_SNIPPETS_ARRAY when snippets is not an array', () => {
    const json = JSON.stringify({ schemaVersion: 1, snippets: 'not an array' });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('MISSING_SNIPPETS_ARRAY');
    }
  });

  it('should return INVALID_SNIPPET_ENTRY for entry missing command', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      snippets: [{ id: 'x' }],
    });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_SNIPPET_ENTRY');
    }
  });

  it('should return INVALID_SNIPPET_ENTRY for entry with empty command', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      snippets: [{ id: 'x', command: '' }],
    });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_SNIPPET_ENTRY');
    }
  });

  it('should fill in optional fields with defaults', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      snippets: [{ id: 'abc', command: 'echo hello' }],
    });
    const result = validateSnippetJson(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = result.payload.snippets[0];
      expect(s.tags).toEqual([]);
      expect(s.useCount).toBe(0);
      expect(s.scope).toBe('global');
      expect(typeof s.createdAt).toBe('number');
    }
  });

  it('should not crash on empty string', () => {
    const result = validateSnippetJson('');
    expect(result.ok).toBe(false);
  });

  it('should not crash on null string', () => {
    const result = validateSnippetJson('null');
    expect(result.ok).toBe(false);
  });
});

// ─── mergeSnippets ────────────────────────────────────────────────────────────

describe('mergeSnippets', () => {
  describe('strategy: skip', () => {
    it('should add new snippets', () => {
      const existing = [makeSnippet('ls -la')];
      const incoming = [makeSnippet('pwd')];
      const result = mergeSnippets(existing, incoming, 'skip');

      expect(result.added).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.mergedSnippets).toHaveLength(2);
    });

    it('should skip duplicates and not modify existing', () => {
      const existing = [makeSnippet('ls -la')];
      const incoming = [makeSnippet('ls -la')];
      const result = mergeSnippets(existing, incoming, 'skip');

      expect(result.added).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.mergedSnippets).toHaveLength(1);
      expect(result.mergedSnippets[0].id).toBe(existing[0].id);
    });

    it('should skip duplicate only if command AND scope match', () => {
      const existing = [makeSnippet('ls -la', { scope: 'global' })];
      const incoming = [makeSnippet('ls -la', { scope: 'session' })];
      const result = mergeSnippets(existing, incoming, 'skip');

      expect(result.added).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.mergedSnippets).toHaveLength(2);
    });
  });

  describe('strategy: overwrite', () => {
    it('should overwrite duplicate with new title and tags', () => {
      const existing = [makeSnippet('ls -la', { title: 'Old Title', tags: ['old'] })];
      const incoming = [makeSnippet('ls -la', { title: 'New Title', tags: ['new'] })];
      const result = mergeSnippets(existing, incoming, 'overwrite');

      expect(result.updated).toBe(1);
      expect(result.added).toBe(0);
      expect(result.mergedSnippets).toHaveLength(1);
      expect(result.mergedSnippets[0].title).toBe('New Title');
      expect(result.mergedSnippets[0].tags).toEqual(['new']);
    });

    it('should preserve original createdAt on overwrite', () => {
      const original = makeSnippet('ls -la', { createdAt: 1000 });
      const incoming = makeSnippet('ls -la', { createdAt: 9999 });
      const result = mergeSnippets([original], [incoming], 'overwrite');

      expect(result.mergedSnippets[0].createdAt).toBe(1000);
    });
  });

  describe('strategy: keepBoth', () => {
    it('should add duplicate with disambiguated title', () => {
      const existing = [makeSnippet('ls -la', { title: 'List Files' })];
      const incoming = [makeSnippet('ls -la', { title: 'List Files' })];
      const result = mergeSnippets(existing, incoming, 'keepBoth');

      expect(result.added).toBe(1);
      expect(result.mergedSnippets).toHaveLength(2);
      expect(result.mergedSnippets[1].title).toBe('List Files (2)');
    });

    it('should increment suffix when (2) also exists', () => {
      const existing = [
        makeSnippet('ls -la', { title: 'List Files' }),
        makeSnippet('ls -la', { title: 'List Files (2)', scope: 'session' }), // different scope, won't match
      ];
      // Force both to have same title in mergedSnippets by adding (2) manually
      const existingWithDup = [
        makeSnippet('ls -la', { id: 'a', title: 'List Files' }),
        makeSnippet('ls -la', { id: 'b', title: 'List Files (2)', scope: 'global' }),
      ];
      const incoming = [makeSnippet('ls -la', { title: 'List Files' })];
      const result = mergeSnippets(existingWithDup, incoming, 'keepBoth');

      // Both existing have 'ls -la' global, so first match is found, keepBoth adds with suffix
      // The first existing is the dup; keepBoth adds with new title
      const titles = result.mergedSnippets.map((s) => s.title);
      expect(titles).toContain('List Files (3)');
    });
  });

  it('should count failed for snippets with empty command', () => {
    const existing: Snippet[] = [];
    const incoming = [
      { ...makeSnippet('ls'), command: '' },
      { ...makeSnippet('  '), command: '   ' },
    ];
    const result = mergeSnippets(existing, incoming, 'skip');

    expect(result.failed).toBe(2);
    expect(result.mergedSnippets).toHaveLength(0);
  });

  it('should not mutate the existing array', () => {
    const existing = [makeSnippet('ls -la')];
    const originalLength = existing.length;
    mergeSnippets(existing, [makeSnippet('pwd')], 'skip');
    expect(existing).toHaveLength(originalLength);
  });

  it('should handle large imports without errors', () => {
    const existing: Snippet[] = [];
    const incoming = Array.from({ length: 500 }, (_, i) => makeSnippet(`cmd-${i}`));
    const result = mergeSnippets(existing, incoming, 'skip');

    expect(result.added).toBe(500);
    expect(result.mergedSnippets).toHaveLength(500);
  });

  it('should handle 1000 snippets without errors', () => {
    const existing = Array.from({ length: 500 }, (_, i) => makeSnippet(`existing-${i}`));
    const incoming = Array.from({ length: 500 }, (_, i) => makeSnippet(`incoming-${i}`));
    const result = mergeSnippets(existing, incoming, 'skip');

    expect(result.added).toBe(500);
    expect(result.mergedSnippets).toHaveLength(1000);
  });
});

// ─── importSummaryText ────────────────────────────────────────────────────────

describe('importSummaryText', () => {
  it('should return "変更なし" when all counts are 0', () => {
    const result: ImportResult = { added: 0, updated: 0, skipped: 0, failed: 0, mergedSnippets: [] };
    expect(importSummaryText(result)).toBe('変更なし');
  });

  it('should include added count', () => {
    const result: ImportResult = { added: 3, updated: 0, skipped: 0, failed: 0, mergedSnippets: [] };
    expect(importSummaryText(result)).toContain('3 件追加');
  });

  it('should include all non-zero counts', () => {
    const result: ImportResult = { added: 2, updated: 1, skipped: 3, failed: 1, mergedSnippets: [] };
    const text = importSummaryText(result);
    expect(text).toContain('2 件追加');
    expect(text).toContain('1 件更新');
    expect(text).toContain('3 件スキップ');
    expect(text).toContain('1 件失敗');
  });
});

// ─── validationErrorLabel ─────────────────────────────────────────────────────

describe('validationErrorLabel', () => {
  it('should return Japanese label for each error type', () => {
    const errors = [
      'INVALID_JSON',
      'MISSING_SCHEMA_VERSION',
      'UNSUPPORTED_SCHEMA_VERSION',
      'MISSING_SNIPPETS_ARRAY',
      'INVALID_SNIPPET_ENTRY',
    ] as const;

    for (const error of errors) {
      const label = validationErrorLabel(error);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── Round-trip test ──────────────────────────────────────────────────────────

describe('round-trip: export → validate → merge', () => {
  it('should preserve all snippet fields through a full round-trip', () => {
    const original = [
      makeSnippet('ls -la', { title: 'List all files', tags: ['files', 'ls'], useCount: 5 }),
      makeSnippet('git status', { title: 'Git status', tags: ['git'], scope: 'session' }),
    ];

    // Export
    const payload = buildExportPayload(original);
    const json = serializePayload(payload);

    // Validate
    const validation = validateSnippetJson(json);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    // Merge into empty store
    const result = mergeSnippets([], validation.payload.snippets, 'skip');
    expect(result.added).toBe(2);
    expect(result.mergedSnippets).toHaveLength(2);

    const ls = result.mergedSnippets.find((s) => s.command === 'ls -la');
    expect(ls?.title).toBe('List all files');
    expect(ls?.tags).toEqual(['files', 'ls']);
    expect(ls?.useCount).toBe(5);

    const git = result.mergedSnippets.find((s) => s.command === 'git status');
    expect(git?.scope).toBe('session');
  });
});
