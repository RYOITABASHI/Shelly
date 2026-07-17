jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  importSkillContentToQuarantine,
  parseSkillMdFrontmatter,
  SKILL_NAME_RE,
  validateSkillMdContent,
  importSkillFromPickedFile,
  pickedSkillFileAsset,
  quarantineDir,
  type RunCommand,
} from '@/lib/skill-import';

function validSkillMd(overrides: { name?: string; description?: string; body?: string } = {}): string {
  const name = overrides.name ?? 'my-skill';
  const description = overrides.description ?? 'Does a useful thing.';
  const body = overrides.body ?? 'Do the thing step by step.';
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe('SKILL_NAME_RE', () => {
  it('accepts a single lowercase char', () => {
    expect(SKILL_NAME_RE.test('a')).toBe(true);
  });
  it('accepts lowercase/digits/hyphen', () => {
    expect(SKILL_NAME_RE.test('my-skill-2')).toBe(true);
  });
  it('rejects leading/trailing hyphen, uppercase, space, underscore, dot', () => {
    expect(SKILL_NAME_RE.test('-my-skill')).toBe(false);
    expect(SKILL_NAME_RE.test('my-skill-')).toBe(false);
    expect(SKILL_NAME_RE.test('My-Skill')).toBe(false);
    expect(SKILL_NAME_RE.test('my skill')).toBe(false);
    expect(SKILL_NAME_RE.test('my_skill')).toBe(false);
    expect(SKILL_NAME_RE.test('my.skill')).toBe(false);
  });
});

describe('parseSkillMdFrontmatter', () => {
  it('returns null for input with no --- delimiters', () => {
    expect(parseSkillMdFrontmatter('just some text, no frontmatter')).toBeNull();
  });

  it('returns null for a frontmatter block missing the closing delimiter', () => {
    expect(parseSkillMdFrontmatter('---\nname: x\ndescription: y\nbody text')).toBeNull();
  });

  it('parses fields and trims the body', () => {
    const parsed = parseSkillMdFrontmatter('---\nname: my-skill\ndescription: hi\n---\n\n  body here  \n');
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.name).toBe('my-skill');
    expect(parsed!.fields.description).toBe('hi');
    expect(parsed!.body).toBe('body here');
  });

  it('strips one layer of double quotes from a value', () => {
    const parsed = parseSkillMdFrontmatter('---\nname: "my-skill"\n---\nbody');
    expect(parsed!.fields.name).toBe('my-skill');
  });

  it('strips one layer of single quotes from a value', () => {
    const parsed = parseSkillMdFrontmatter("---\nname: 'my-skill'\n---\nbody");
    expect(parsed!.fields.name).toBe('my-skill');
  });

  it('skips blank lines and lines that are not key: value shaped', () => {
    const parsed = parseSkillMdFrontmatter('---\nname: my-skill\n\nnot a valid line\ndescription: hi\n---\nbody');
    expect(parsed!.fields.name).toBe('my-skill');
    expect(parsed!.fields.description).toBe('hi');
    expect(Object.keys(parsed!.fields)).toEqual(['name', 'description']);
  });
});

describe('validateSkillMdContent', () => {
  it('accepts a valid minimal skill.md', () => {
    const result = validateSkillMdContent(validSkillMd(), 'my-skill');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('errors when no frontmatter delimiters are present', () => {
    const result = validateSkillMdContent('no frontmatter here at all', 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'SKILL.md has no valid frontmatter block (missing --- delimiters)',
    ]);
  });

  it('errors on a name/folder mismatch', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'my-skill' }), 'other-folder');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'name "my-skill" must exactly match the folder name "other-folder"'
    );
  });

  it('errors on an uppercase name', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'My-Skill' }), 'My-Skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors on a name with a space', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'my skill' }), 'my skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors on a name with an underscore', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'my_skill' }), 'my_skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors on a name with a dot', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'my.skill' }), 'my.skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors on a name that is too long (65+ chars)', () => {
    const longName = 'a'.repeat(65);
    const result = validateSkillMdContent(validSkillMd({ name: longName }), longName);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`name must be ${MAX_NAME_CHARS} characters or fewer`);
  });

  it('errors on a name with a leading hyphen', () => {
    const result = validateSkillMdContent(validSkillMd({ name: '-my-skill' }), '-my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors on a name with a trailing hyphen', () => {
    const result = validateSkillMdContent(validSkillMd({ name: 'my-skill-' }), 'my-skill-');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
  });

  it('errors when the name field is missing entirely', () => {
    const raw = '---\ndescription: hi\n---\nbody';
    const result = validateSkillMdContent(raw, 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required');
  });

  it('errors when the description field is missing', () => {
    const raw = '---\nname: my-skill\n---\nbody';
    const result = validateSkillMdContent(raw, 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('description is required');
  });

  it('errors when the description field is empty', () => {
    const raw = '---\nname: my-skill\ndescription:\n---\nbody';
    const result = validateSkillMdContent(raw, 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('description is required');
  });

  it('errors when the description is over 1024 chars', () => {
    const longDescription = 'd'.repeat(1025);
    const result = validateSkillMdContent(validSkillMd({ description: longDescription }), 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`description must be ${MAX_DESCRIPTION_CHARS} characters or fewer`);
  });

  it('errors specifically on a multi-line block-scalar description, not a generic missing-description error', () => {
    const raw = '---\nname: my-skill\ndescription: |\n  line one\n  line two\n---\nbody';
    const result = validateSkillMdContent(raw, 'my-skill');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'description must be a single-line scalar value, multi-line block scalars ("description: |") are not supported'
    );
    expect(result.errors).not.toContain('description is required');
  });

  it('flags a folded block-scalar description (">") the same way', () => {
    const raw = '---\nname: my-skill\ndescription: >\n  line one\n  line two\n---\nbody';
    const result = validateSkillMdContent(raw, 'my-skill');
    expect(result.errors.some((e) => e.includes('multi-line block scalars'))).toBe(true);
  });

  it('warns (non-blocking) when the body is large (~over 5000 estimated tokens)', () => {
    const bigBody = 'x'.repeat(20001); // 20001/4 = 5000.25 > 5000
    const result = validateSkillMdContent(validSkillMd({ body: bigBody }), 'my-skill');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('skill body is large'))).toBe(true);
  });

  it('does not warn for a body under the size threshold', () => {
    const result = validateSkillMdContent(validSkillMd({ body: 'short body' }), 'my-skill');
    expect(result.warnings).toEqual([]);
  });

  it('accumulates multiple simultaneous errors instead of short-circuiting', () => {
    const raw = '---\nname: Bad Name\n---\nbody';
    const result = validateSkillMdContent(raw, 'Bad Name');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('lowercase letters, numbers, and hyphens'))).toBe(true);
    expect(result.errors).toContain('description is required');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// SAF (Storage Access Framework) picker import path — see lib/skill-import.ts's
// importSkillFromPickedFile doc comment. Unlike importSkillToQuarantine (whose
// source-side `cat` needs a shell-readable path, in practice MANAGE_EXTERNAL_
// STORAGE), this path's content already lives in JS memory by the time it's
// called — the picker's scoped content:// URI grant needs no broad storage
// permission at all. The write side (into the app's own quarantine dir) is
// unchanged either way, so these tests focus on: (1) does picked content
// correctly flow into the same validation used by the path-based import, and
// (2) does a cancelled/asset-less picker result resolve to a clean no-op.

describe('pickedSkillFileAsset', () => {
  it('returns null when the picker was cancelled', () => {
    expect(pickedSkillFileAsset({ canceled: true })).toBeNull();
  });

  it('returns null when not cancelled but no assets were returned', () => {
    expect(pickedSkillFileAsset({ canceled: false, assets: [] })).toBeNull();
    expect(pickedSkillFileAsset({ canceled: false, assets: null })).toBeNull();
    expect(pickedSkillFileAsset({ canceled: false })).toBeNull();
  });

  it('returns the first asset when the picker succeeded', () => {
    const asset = { uri: 'content://com.android.providers/document/SKILL.md', name: 'SKILL.md' };
    expect(pickedSkillFileAsset({ canceled: false, assets: [asset] })).toEqual(asset);
  });
});

describe('importSkillFromPickedFile', () => {
  function makeRunCommand(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    const calls: string[] = [];
    const fn: RunCommand = jest.fn(async (cmd: string) => {
      calls.push(cmd);
      return { stdout: opts.stdout ?? '', stderr: opts.stderr ?? '', exitCode: opts.exitCode ?? 0 };
    });
    return { fn, calls };
  }

  it('writes the quarantine SKILL.md + metadata for valid picked content, keyed off the frontmatter name', async () => {
    const raw = validSkillMd({ name: 'picked-skill', description: 'A picked skill.' });
    const { fn, calls } = makeRunCommand();

    const result = await importSkillFromPickedFile(raw, fn);

    expect(result.ok).toBe(true);
    expect(result.name).toBe('picked-skill');
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(1);
    const script = calls[0];
    const destDir = `${quarantineDir('/home/shelly-test')}/picked-skill`;
    expect(script).toContain(`mkdir -p '${destDir}'`);
    expect(script).toContain(`cat > '${destDir}/SKILL.md' <<`);
    expect(script).toContain(raw);
    expect(script).toContain(`cat > '${destDir}/.shelly-import-meta.json' <<`);
    expect(script).toContain('"sourcePath": "picked-file (SAF)"');
    expect(script).toContain('"approvedAt": null');
  });

  it('rejects invalid picked content without ever touching the filesystem', async () => {
    const raw = '---\nname: my-skill\n---\nbody'; // missing description
    const { fn, calls } = makeRunCommand();

    const result = await importSkillFromPickedFile(raw, fn);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('description is required');
    expect(calls).toHaveLength(0);
  });

  it('rejects content with no frontmatter block at all, without touching the filesystem', async () => {
    const { fn, calls } = makeRunCommand();

    const result = await importSkillFromPickedFile('just plain text, no --- delimiters', fn);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'SKILL.md has no valid frontmatter block, or is missing a name field',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('rejects frontmatter that is missing the name field, without touching the filesystem', async () => {
    const { fn, calls } = makeRunCommand();

    const result = await importSkillFromPickedFile('---\ndescription: hi\n---\nbody', fn);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'SKILL.md has no valid frontmatter block, or is missing a name field',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the shell error when the quarantine write fails', async () => {
    const raw = validSkillMd({ name: 'picked-skill' });
    const { fn } = makeRunCommand({ exitCode: 1, stderr: 'disk full' });

    const result = await importSkillFromPickedFile(raw, fn);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['import failed: disk full']);
  });

  it('propagates warnings (e.g. large body) through to the result even when valid', async () => {
    const bigBody = 'x'.repeat(20001);
    const raw = validSkillMd({ name: 'picked-skill', body: bigBody });
    const { fn } = makeRunCommand();

    const result = await importSkillFromPickedFile(raw, fn);

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('skill body is large'))).toBe(true);
  });
});

// SKILL-002: content-based import (skill-catalog.ts hands already-fetched,
// sha256-verified SKILL.md text here instead of a local path). This must
// reuse validateSkillMdContent exactly like the path-based import above —
// these tests exist to prove that reuse, not to re-test validation itself.
describe('importSkillContentToQuarantine', () => {
  function okRunCommand(): jest.Mock {
    return jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  }

  it('writes a valid skill straight to quarantine and reports success', async () => {
    const runCommand = okRunCommand();
    const result = await importSkillContentToQuarantine(
      validSkillMd({ name: 'git-commit-craft' }),
      'git-commit-craft',
      'catalog:git-commit-craft',
      runCommand as unknown as RunCommand,
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe('git-commit-craft');
    expect(result.errors).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const script = runCommand.mock.calls[0][0] as string;
    // Quarantine dir path + a quoted (expansion-disabled) heredoc write —
    // never a `cp -r` (that's the path-based importSkillToQuarantine only).
    expect(script).toContain('skills-quarantine/git-commit-craft');
    expect(script).toMatch(/<<'SHELLY_SKILLMD_/);
    expect(script).not.toContain('cp -r');
  });

  it('rejects (without touching the shell) when the content fails validateSkillMdContent', async () => {
    const runCommand = okRunCommand();
    // frontmatter name "other-name" won't match the catalog's declared
    // expectedName "git-commit-craft" — same "name must match" rule the
    // path-based folder-name check enforces.
    const result = await importSkillContentToQuarantine(
      validSkillMd({ name: 'other-name' }),
      'git-commit-craft',
      'catalog:git-commit-craft',
      runCommand as unknown as RunCommand,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('must exactly match'))).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('reports a write failure without throwing', async () => {
    const runCommand = jest.fn().mockResolvedValue({ stdout: '', stderr: 'disk full', exitCode: 1 });
    const result = await importSkillContentToQuarantine(
      validSkillMd({ name: 'git-commit-craft' }),
      'git-commit-craft',
      'catalog:git-commit-craft',
      runCommand as unknown as RunCommand,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('disk full');
  });
});
