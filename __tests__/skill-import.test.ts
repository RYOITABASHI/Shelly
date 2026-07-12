jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  parseSkillMdFrontmatter,
  SKILL_NAME_RE,
  validateSkillMdContent,
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
