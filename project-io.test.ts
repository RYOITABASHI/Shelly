/**
 * tests/project-io.test.ts
 *
 * Tests for lib/project-io.ts:
 *  - Export payload generation
 *  - JSON serialization / deserialization
 *  - Schema validation
 *  - Duplicate detection
 *  - Import result computation (add / skip / overwrite / keep-both)
 *  - Corrupted JSON handling
 *  - Large dataset performance (500 projects)
 */

import { describe, it, expect, vi } from 'vitest';

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

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  cacheDirectory: '/tmp/',
}));

// ── Import functions under test ───────────────────────────────────────────────
import {
  projectToExported,
  buildProjectExportPayload,
  serializeProjectPayload,
  projectExportFilename,
  parseProjectImportJson,
  validateExportedProject,
  findDuplicate,
  resolveProjectImport,
  PROJECT_SCHEMA_VERSION,
  type ExportedProject,
  type ProjectExportPayload,
} from '../lib/project-io';
import { CreatorProject } from '../store/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<CreatorProject> = {}): CreatorProject {
  return {
    id: 'proj-001',
    name: 'テストプロジェクト',
    slug: 'test-project',
    projectType: 'web',
    createdAt: 1700000000000,
    lastOpenedAt: undefined,
    path: '20231114-test-project',
    status: 'done',
    userInput: 'テストアプリを作って',
    plan: { summary: 'シンプルなWebアプリを作るよ。', steps: ['HTMLを作る', 'CSSを追加する'], projectType: 'web', projectName: 'test-project', estimatedFiles: 1 },
    buildSteps: [
      { id: 'step-1', status: 'done', message: '完了したよ', timestamp: 1700000000000 },
    ],
    suggestions: ['次はAPIを追加できるよ'],
    files: [
      { path: 'src/index.html', language: 'html', content: '<html></html>' },
    ],
    tags: ['test', 'web'],
    termuxWritten: false,
    ...overrides,
  };
}

function makeExportedProject(overrides: Partial<ExportedProject> = {}): ExportedProject {
  return {
    id: 'proj-001',
    name: 'テストプロジェクト',
    slug: 'test-project',
    projectType: 'web',
    createdAt: 1700000000000,
    path: '20231114-test-project',
    status: 'done',
    userInput: 'テストアプリを作って',
    planSummary: 'シンプルなWebアプリを作るよ。',
    planSteps: ['HTMLを作る'],
    resultSuggestions: [],
    buildLog: '[done] 完了したよ',
    filesManifest: [{ path: 'src/index.html', language: 'html', sizeChars: 13 }],
    tags: ['test', 'web'],
    termuxWritten: false,
    projectPath: null,
    ...overrides,
  };
}

// ─── Export tests ─────────────────────────────────────────────────────────────

describe('projectToExported', () => {
  it('converts a CreatorProject to ExportedProject', () => {
    const p = makeProject();
    const exported = projectToExported(p);

    expect(exported.id).toBe('proj-001');
    expect(exported.name).toBe('テストプロジェクト');
    expect(exported.tags).toEqual(['test', 'web']);
    expect(exported.termuxWritten).toBe(false);
    expect(exported.projectPath).toBeNull();
  });

  it('includes build log from buildSteps', () => {
    const p = makeProject({
      buildSteps: [
        { id: 's1', status: 'done', message: 'ステップ1完了', timestamp: 1700000000000 },
        { id: 's2', status: 'done', message: 'ステップ2完了', timestamp: 1700000001000 },
      ],
    });
    const exported = projectToExported(p);
    expect(exported.buildLog).toContain('ステップ1完了');
    expect(exported.buildLog).toContain('ステップ2完了');
  });

  it('truncates build log to MAX_BUILD_LOG_CHARS', () => {
    const longMessage = 'x'.repeat(5000);
    const p = makeProject({
      buildSteps: [{ id: 's1', status: 'done', message: longMessage, timestamp: 1700000000000 }],
    });
    const exported = projectToExported(p);
    expect(exported.buildLog.length).toBeLessThanOrEqual(4000);
  });

  it('includes filesManifest with path, language, sizeChars', () => {
    const p = makeProject({
      files: [
        { path: 'src/app.js', language: 'javascript', content: 'console.log("hi")' },
      ],
    });
    const exported = projectToExported(p);
    expect(exported.filesManifest).toHaveLength(1);
    expect(exported.filesManifest[0].path).toBe('src/app.js');
    expect(exported.filesManifest[0].language).toBe('javascript');
    expect(exported.filesManifest[0].sizeChars).toBe(17);
  });

  it('preserves tags array', () => {
    const p = makeProject({ tags: ['school', 'timer', 'react'] });
    const exported = projectToExported(p);
    expect(exported.tags).toEqual(['school', 'timer', 'react']);
  });

  it('handles empty tags', () => {
    const p = makeProject({ tags: [] });
    const exported = projectToExported(p);
    expect(exported.tags).toEqual([]);
  });
});

describe('buildProjectExportPayload', () => {
  it('builds a valid payload with correct schema version', () => {
    const projects = [makeProject(), makeProject({ id: 'proj-002', name: 'プロジェクト2' })];
    const payload = buildProjectExportPayload(projects);

    expect(payload.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(payload.count).toBe(2);
    expect(payload.projects).toHaveLength(2);
    expect(payload.exportedAt).toBeTruthy();
  });

  it('sets exportedAt as ISO string', () => {
    const payload = buildProjectExportPayload([makeProject()]);
    expect(() => new Date(payload.exportedAt)).not.toThrow();
    expect(new Date(payload.exportedAt).toISOString()).toBe(payload.exportedAt);
  });

  it('handles empty project list', () => {
    const payload = buildProjectExportPayload([]);
    expect(payload.count).toBe(0);
    expect(payload.projects).toHaveLength(0);
  });
});

describe('serializeProjectPayload', () => {
  it('produces valid JSON', () => {
    const payload = buildProjectExportPayload([makeProject()]);
    const json = serializeProjectPayload(payload);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips through JSON.parse', () => {
    const projects = [makeProject()];
    const payload = buildProjectExportPayload(projects);
    const json = serializeProjectPayload(payload);
    const parsed = JSON.parse(json) as ProjectExportPayload;
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.projects[0].id).toBe('proj-001');
  });
});

describe('projectExportFilename', () => {
  it('returns a filename starting with shelly-projects-', () => {
    const name = projectExportFilename();
    expect(name).toMatch(/^shelly-projects-\d{8}\.json$/);
  });
});

// ─── Validation tests ─────────────────────────────────────────────────────────

describe('parseProjectImportJson', () => {
  it('returns ok:true for valid payload', () => {
    const payload: ProjectExportPayload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      device: 'test',
      count: 1,
      projects: [makeExportedProject()],
    };
    const result = parseProjectImportJson(JSON.stringify(payload));
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for invalid JSON', () => {
    const result = parseProjectImportJson('not json {{{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('parse');
    }
  });

  it('returns ok:false for missing schemaVersion', () => {
    const result = parseProjectImportJson(JSON.stringify({ projects: [makeExportedProject()] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema');
    }
  });

  it('returns ok:false for missing projects field', () => {
    const result = parseProjectImportJson(JSON.stringify({ schemaVersion: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema');
    }
  });

  it('returns ok:false for empty projects array', () => {
    const result = parseProjectImportJson(JSON.stringify({ schemaVersion: 1, projects: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('empty');
    }
  });

  it('returns ok:false for non-object JSON (array)', () => {
    const result = parseProjectImportJson(JSON.stringify([1, 2, 3]));
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for null JSON', () => {
    const result = parseProjectImportJson('null');
    expect(result.ok).toBe(false);
  });
});

describe('validateExportedProject', () => {
  it('returns null for valid entry', () => {
    expect(validateExportedProject(makeExportedProject())).toBeNull();
  });

  it('returns error for missing id', () => {
    const p = { ...makeExportedProject(), id: '' };
    expect(validateExportedProject(p)).toBeTruthy();
  });

  it('returns error for missing name', () => {
    const p = { ...makeExportedProject(), name: '' };
    expect(validateExportedProject(p)).toBeTruthy();
  });

  it('returns error for non-number createdAt', () => {
    const p = { ...makeExportedProject(), createdAt: 'not-a-number' };
    expect(validateExportedProject(p)).toBeTruthy();
  });

  it('returns error for non-object input', () => {
    expect(validateExportedProject('string')).toBeTruthy();
    expect(validateExportedProject(null)).toBeTruthy();
    expect(validateExportedProject([1, 2])).toBeTruthy();
  });
});

// ─── Duplicate detection tests ────────────────────────────────────────────────

describe('findDuplicate', () => {
  const existing: CreatorProject[] = [
    makeProject({ id: 'proj-001', name: 'プロジェクト1', createdAt: 1700000000000 }),
    makeProject({ id: 'proj-002', name: 'プロジェクト2', createdAt: 1700000001000 }),
  ];

  it('finds duplicate by id match', () => {
    const ep = makeExportedProject({ id: 'proj-001' });
    const dup = findDuplicate(ep, existing);
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe('proj-001');
  });

  it('finds duplicate by name + createdAt match', () => {
    const ep = makeExportedProject({ id: 'proj-999', name: 'プロジェクト2', createdAt: 1700000001000 });
    const dup = findDuplicate(ep, existing);
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe('proj-002');
  });

  it('returns null for no match', () => {
    const ep = makeExportedProject({ id: 'proj-999', name: '新しいプロジェクト', createdAt: 9999999999999 });
    const dup = findDuplicate(ep, existing);
    expect(dup).toBeNull();
  });
});

// ─── Import result computation tests ─────────────────────────────────────────

describe('resolveProjectImport', () => {
  const existing: CreatorProject[] = [
    makeProject({ id: 'proj-001', name: 'プロジェクト1' }),
  ];

  function makePayload(projects: ExportedProject[]): ProjectExportPayload {
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), device: 'test', count: projects.length, projects };
  }

  it('adds new project (no duplicate)', () => {
    const payload = makePayload([makeExportedProject({ id: 'proj-new', name: '新プロジェクト', createdAt: 9999 })]);
    const result = resolveProjectImport(payload, existing, 'skip');
    expect(result.addCount).toBe(1);
    expect(result.skipCount).toBe(0);
    expect(result.items[0].action).toBe('add');
  });

  it('skips duplicate when action=skip', () => {
    const payload = makePayload([makeExportedProject({ id: 'proj-001' })]);
    const result = resolveProjectImport(payload, existing, 'skip');
    expect(result.skipCount).toBe(1);
    expect(result.addCount).toBe(0);
    expect(result.items[0].action).toBe('skip');
  });

  it('overwrites duplicate when action=overwrite', () => {
    const payload = makePayload([makeExportedProject({ id: 'proj-001' })]);
    const result = resolveProjectImport(payload, existing, 'overwrite');
    expect(result.updateCount).toBe(1);
    expect(result.skipCount).toBe(0);
    expect(result.items[0].action).toBe('overwrite');
  });

  it('keeps both when action=keep-both', () => {
    const payload = makePayload([makeExportedProject({ id: 'proj-001', name: 'プロジェクト1' })]);
    const result = resolveProjectImport(payload, existing, 'keep-both');
    expect(result.addCount).toBe(1);
    expect(result.items[0].action).toBe('keep-both');
  });

  it('marks invalid entries as error', () => {
    const payload = makePayload([{ id: '', name: '', createdAt: 'bad' } as unknown as ExportedProject]);
    const result = resolveProjectImport(payload, existing, 'skip');
    expect(result.failCount).toBe(1);
    expect(result.items[0].action).toBe('error');
  });

  it('handles mixed batch (add + skip)', () => {
    const payload = makePayload([
      makeExportedProject({ id: 'proj-001' }),
      makeExportedProject({ id: 'proj-new', name: '新プロジェクト', createdAt: 9999 }),
    ]);
    const result = resolveProjectImport(payload, existing, 'skip');
    expect(result.skipCount).toBe(1);
    expect(result.addCount).toBe(1);
  });
});

// ─── Large dataset performance test ───────────────────────────────────────────

describe('large dataset (500 projects)', () => {
  it('processes 500 projects without throwing', () => {
    const projects: CreatorProject[] = Array.from({ length: 500 }, (_, i) =>
      makeProject({ id: `proj-${i}`, name: `プロジェクト${i}`, createdAt: 1700000000000 + i })
    );

    expect(() => {
      const payload = buildProjectExportPayload(projects);
      const json = serializeProjectPayload(payload);
      const parsed = parseProjectImportJson(json);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const result = resolveProjectImport(parsed.payload, [], 'skip');
        expect(result.addCount).toBe(500);
      }
    }).not.toThrow();
  });

  it('export payload for 500 projects is valid JSON', () => {
    const projects: CreatorProject[] = Array.from({ length: 500 }, (_, i) =>
      makeProject({ id: `proj-${i}`, name: `プロジェクト${i}`, createdAt: 1700000000000 + i })
    );
    const payload = buildProjectExportPayload(projects);
    const json = serializeProjectPayload(payload);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).count).toBe(500);
  });
});
