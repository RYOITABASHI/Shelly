import { detectRoleIntent, deriveRoleHandles, isRoleQuestion, roleNameKey } from '@/lib/agent-role-intent';

type Create = Extract<NonNullable<ReturnType<typeof detectRoleIntent>>, { kind: 'create' }>;
type Edit = Extract<NonNullable<ReturnType<typeof detectRoleIntent>>, { kind: 'edit' }>;

function create(text: string): Create {
  const i = detectRoleIntent(text);
  expect(i?.kind).toBe('create');
  return i as Create;
}
function edit(text: string): Edit {
  const i = detectRoleIntent(text);
  expect(i?.kind).toBe('edit');
  return i as Edit;
}

describe('detectRoleIntent — create (design §2 examples)', () => {
  it('EN reviewer with Claude Code', () => {
    const i = create('make a reviewer role using Claude Code that reviews code for bugs and security issues and lists them by severity');
    expect(i.name).toBe('Reviewer');
    expect(i.engine).toEqual({ type: 'cli', cli: 'claude' });
    expect(i.instructions).toBe('Reviews code for bugs and security issues and lists them by severity');
    expect(i.handles).toEqual(['review']);
    expect(i.autoAttach).toBeUndefined();
    expect(i.level).toBeUndefined();
  });

  it('EN implementer called … with Codex:', () => {
    const i = create('create a role called Implementer with Codex: write working code in the workspace and run a syntax check');
    expect(i.name).toBe('Implementer');
    expect(i.engine).toEqual({ type: 'cli', cli: 'codex' });
    expect(i.instructions).toBe('Write working code in the workspace and run a syntax check');
    expect(i.handles).toEqual(['implement']);
  });

  it('EN quoted Judge with the local LLM', () => {
    const i = create('add a role "Judge" using the local LLM that compares two implementations and picks the better one');
    expect(i.name).toBe('Judge');
    expect(i.engine).toEqual({ type: 'local' });
    expect(i.instructions).toBe('Compares two implementations and picks the better one');
    expect(i.handles).toEqual(['judge']);
  });

  it('JA レビュー役 with Claude Code', () => {
    const i = create('Claude Codeでコードのバグとセキュリティの問題を重大度つきで洗い出すレビュー役を作って');
    expect(i.name).toBe('レビュー役');
    expect(i.engine).toEqual({ type: 'cli', cli: 'claude' });
    expect(i.instructions).toBe('コードのバグとセキュリティの問題を重大度つきで洗い出す');
    expect(i.handles).toEqual(['review']);
  });

  it('JA 実装役というロール with a second sentence', () => {
    const i = create('Codexを使う実装役というロールを作って。ワークスペースの中で動くコードを書いて構文チェックまでする');
    expect(i.name).toBe('実装役');
    expect(i.engine).toEqual({ type: 'cli', cli: 'codex' });
    expect(i.instructions).toBe('ワークスペースの中で動くコードを書いて構文チェックまでする');
    expect(i.handles).toEqual(['implement']);
  });

  it('JA 審査役 with the local LLM', () => {
    const i = create('ローカルLLMで2つの実装を比べて良い方を選ぶ審査役を作って');
    expect(i.name).toBe('審査役');
    expect(i.engine).toEqual({ type: 'local' });
    expect(i.instructions).toBe('2つの実装を比べて良い方を選ぶ');
    expect(i.handles).toEqual(['judge']);
  });

  it('extracts and strips level, workspace and auto-attach settings', () => {
    const i = create(
      "make a reviewer role using Codex that checks the diff for bugs in ~/demo, run it fully without approval, and don't attach it automatically",
    );
    expect(i.level).toBe('all');
    expect(i.workspace).toEqual({ mode: 'fixed', path: '~/demo' });
    expect(i.autoAttach).toBe(false);
    expect(i.instructions).toBe('Checks the diff for bugs');
    const j = create('Codexで~/demoの中でゲームを実装する実装役を作って。承認なしで実行して');
    expect(j.level).toBe('standard');
    expect(j.workspace).toEqual({ mode: 'fixed', path: '~/demo' });
    expect(j.instructions).not.toMatch(/承認|~\/demo|Codex/);
  });

  it('a path that cannot be a workspace is reported, not dropped silently', () => {
    const i = create('make a reviewer role using Codex that reviews code in ~/.ssh');
    expect(i.workspace).toBeUndefined();
    expect(i.workspaceInvalid).toBe('~/.ssh');
  });

  it('no engine → engine left unset (the chat states the default)', () => {
    const i = create('make a writer role that drafts release notes');
    expect(i.engine).toBeUndefined();
    expect(i.handles).toEqual(['write']);
  });

  it('polite requests are not questions', () => {
    expect(detectRoleIntent('Could you make a reviewer role using Codex that reviews code?')?.kind).toBe('create');
  });
});

describe('detectRoleIntent — Antigravity', () => {
  it.each([
    'make a judge role using Antigravity',
    'make a judge role using Antigravity that compares two implementations',
    'Antigravityで審査役を作って',
    'change the judge role to use Antigravity',
  ])('refuses %s', (text) => {
    expect(detectRoleIntent(text)).toEqual({ kind: 'antigravity-refused' });
  });
});

describe('detectRoleIntent — edit / list / delete / reset', () => {
  it('engine change', () => {
    const i = edit('change the reviewer role to use Codex');
    expect(i.target).toBe('reviewer');
    expect(i.changes).toEqual({ engine: { type: 'cli', cli: 'codex' } });
    expect(i.weak).toBeUndefined();
    expect(edit('レビュー役をCodexに変えて').changes).toEqual({ engine: { type: 'cli', cli: 'codex' } });
  });

  it('level change', () => {
    expect(edit('set the implementer role to run fully without approval').changes).toEqual({ level: 'all' });
    expect(edit('set the implementer role to run without approval').changes).toEqual({ level: 'standard' });
    expect(edit('set the implementer role to require approval').changes).toEqual({ level: 'off' });
    const ja = edit('実装役をすべて承認なしで実行にして');
    expect(ja.target).toBe('実装役');
    expect(ja.changes).toEqual({ level: 'all' });
  });

  it('workspace change', () => {
    const i = edit("set the reviewer role's workspace to ~/demo");
    expect(i.target).toBe('reviewer');
    expect(i.changes).toEqual({ workspace: { mode: 'fixed', path: '~/demo' } });
    expect(edit('レビュー役のワークスペースを~/demoにして').changes).toEqual({ workspace: { mode: 'fixed', path: '~/demo' } });
    expect(edit("set the reviewer role's workspace to ~/.shelly").changes).toEqual({ workspaceInvalid: '~/.shelly' });
  });

  it('auto-attach', () => {
    const i = edit("don't attach the reviewer automatically");
    expect(i.target).toBe('reviewer');
    expect(i.changes).toEqual({ autoAttach: false });
    expect(i.weak).toBe(true);
    expect(edit('attach the reviewer role automatically').changes).toEqual({ autoAttach: true });
    expect(edit('レビュー役を自動で付けないで').changes).toEqual({ autoAttach: false });
  });

  it('instructions change', () => {
    const i = edit("change the reviewer role's instructions to list only security issues");
    expect(i.changes).toEqual({ instructions: 'list only security issues' });
  });

  it('list', () => {
    expect(detectRoleIntent('list my roles')).toEqual({ kind: 'list' });
    expect(detectRoleIntent('show me my roles')).toEqual({ kind: 'list' });
    expect(detectRoleIntent('ロール一覧')).toEqual({ kind: 'list' });
    expect(detectRoleIntent('ロールを見せて')).toEqual({ kind: 'list' });
  });

  it('delete', () => {
    expect(detectRoleIntent('delete the judge role')).toEqual({ kind: 'delete', target: 'judge' });
    expect(detectRoleIntent('remove the role called Judge')).toEqual({ kind: 'delete', target: 'Judge' });
    expect(detectRoleIntent('審査役を削除して')).toEqual({ kind: 'delete', target: '審査役', weak: false });
  });

  it('reset', () => {
    expect(detectRoleIntent('ロール設定を初期化')).toEqual({ kind: 'reset' });
    expect(detectRoleIntent('reset my roles')).toEqual({ kind: 'reset' });
    expect(detectRoleIntent('ロールをリセットして')).toEqual({ kind: 'reset' });
  });

  it('@agent prefix is accepted', () => {
    expect(detectRoleIntent('@agent list my roles')).toEqual({ kind: 'list' });
  });
});

describe('detectRoleIntent — negatives', () => {
  it.each([
    // questions
    'how do I make a reviewer role?',
    'what is the role of the reviewer?',
    'can I create a reviewer role with Codex?',
    'レビュー役を作れますか',
    'ロールって何？',
    // "the role of X" / other senses of role
    'explain the role of the judge in this system',
    'make a role-playing game in ~/demo',
    'make a role playing game',
    'add an admin role to the users table',
    'create a role-based access control module',
    '悪役を作って',
    '主役のゲームを作って',
    '実装役を使ってゲームを作って',
    // normal agent creation sentences
    '@agent Right now, build a brick breaker game in ~/demo',
    '@agent Right now, have both implementers build a brick breaker game in ~/demo and compare',
    'have the implementer build a snake game in ~/demo and the reviewer check it',
    'build a snake game in ~/demo without roles',
    '毎朝9時にニュースを要約して通知して',
    'ロールなしで ~/demo にブロック崩しを作って',
    // quoted / pasted text
    'translate this: "make a reviewer role using Claude Code that reviews code"',
    '「レビュー役を作って」ってどういう意味',
    '> make a reviewer role using Codex that reviews code',
    '```\ndelete the judge role\n```',
  ])('null for %s', (text) => {
    expect(detectRoleIntent(text)).toBeNull();
  });
});

describe('helpers', () => {
  it('isRoleQuestion', () => {
    expect(isRoleQuestion('how do I make a role')).toBe(true);
    expect(isRoleQuestion("don't attach the reviewer automatically")).toBe(false);
    expect(isRoleQuestion('please could you make a role')).toBe(false);
  });

  it('roleNameKey folds width, case and the role suffix', () => {
    expect(roleNameKey('Ｒｅｖｉｅｗｅｒ')).toBe('reviewer');
    expect(roleNameKey('Reviewer role')).toBe('reviewer');
    expect(roleNameKey('レビュー役')).toBe('レビュー役');
  });

  it('deriveRoleHandles uses the name first', () => {
    expect(deriveRoleHandles('Reviewer', 'fix the bugs it finds')).toEqual(['review', 'implement']);
    expect(deriveRoleHandles('Helper', 'summarize the results')).toEqual(['summarize']);
    expect(deriveRoleHandles('Helper', 'do things')).toEqual([]);
  });
});
