/**
 * Agent roles (Inc A, WP2): the plain-chat confirm surface, end to end over
 * the REAL role store (bash-executed roles.json in a temp $HOME + in-memory
 * seal), from the detected intent to what is on disk.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetRoleStoreForTests,
  configureRoleSealPort,
  getRoleLevel,
  loadRoles,
  saveRoles,
  setRoleLevel,
  type RoleSealState,
} from '@/lib/agent-role-store';
import { MAX_ROLES, type AgentRole, type PendingRoleChange } from '@/lib/agent-role-types';
import { detectRoleIntent } from '@/lib/agent-role-intent';
import {
  canChangeRolesFrom,
  findRolesByName,
  handlePendingRoleReply,
  handleRoleIntent,
  roleAllowsAllLevel,
  type RoleChatIO,
  type RoleChatSource,
} from '@/lib/agent-role-chat';
import type { ChatMessage } from '@/store/types';
import { touchesProtectedPolicyFiles } from '@/lib/agent-boundary-policy';
import { decideAutoAnswer, parseAutonomyPolicy } from '@/lib/agent-policy';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

jest.setTimeout(60_000);

let home: string;
let shellHome: string;
let seal: RoleSealState | null;
let posts: Array<{ content: string; extra?: Partial<ChatMessage> }>;

/** `C:\x\y` → `/c/x/y` for Git Bash; POSIX paths unchanged. */
function toShellPath(p: string): string {
  const fwd = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : fwd;
}

const run = async (cmd: string): Promise<string> =>
  execFileSync('bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, HOME: shellHome } });

function io(): RoleChatIO {
  return {
    post: (content, extra) => posts.push({ content, extra }),
    run,
    home: shellHome,
    now: () => 1_000,
  };
}

const TYPED: RoleChatSource = { typedByUser: true };

function lastPost() {
  return posts[posts.length - 1];
}
function lastPending(): PendingRoleChange {
  const p = lastPost().extra?.pendingRoleChange;
  expect(p).toBeDefined();
  return p as PendingRoleChange;
}

async function say(text: string, src: RoleChatSource = TYPED, locale: 'en' | 'ja' = 'en'): Promise<boolean> {
  const intent = detectRoleIntent(text);
  expect(intent).not.toBeNull();
  return handleRoleIntent(intent!, locale, io(), src);
}
async function reply(text: string, src: RoleChatSource = TYPED, locale: 'en' | 'ja' = 'en'): Promise<boolean> {
  return handlePendingRoleReply(lastPending(), text, locale, io(), src);
}

function role(over: Partial<AgentRole> = {}): AgentRole {
  return {
    id: 'role_impl',
    name: 'Implementer',
    instructions: 'Write working code in the workspace and run a syntax check.',
    engine: { type: 'cli', cli: 'codex' },
    handles: ['implement'],
    workspace: { mode: 'request' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-role-chat-'));
  shellHome = toShellPath(home);
  seal = { fileHashes: [], levels: [] };
  posts = [];
  configureRoleSealPort({
    read: async () => (seal ? JSON.parse(JSON.stringify(seal)) : null),
    write: async (s) => {
      seal = JSON.parse(JSON.stringify(s));
    },
  });
  __resetRoleStoreForTests();
});
afterEach(() => {
  configureRoleSealPort(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('create', () => {
  it('echoes the interpretation, saves only on OK', async () => {
    expect(await say('make a reviewer role using Claude Code that reviews code for bugs and security issues and lists them by severity')).toBe(true);
    const text = lastPost().content;
    expect(text).toContain(en['roles.create_header']);
    expect(text).toContain('- Name: Reviewer');
    expect(text).toContain('- Engine: Claude Code');
    expect(text).toContain('- Handles: review');
    expect(text).toContain("- Workspace: the request's workspace");
    expect(text).toContain('- Auto-attach after implementation: on');
    expect(text).toContain("don't attach the Reviewer automatically");
    expect(text).toContain('- Run without approval: off');
    expect(text).toContain(en['roles.confirm_footer']);
    expect(lastPost().extra?.flowTurn).toBeUndefined(); // the dispatcher adds flowTurn
    // Nothing on disk yet.
    expect((await loadRoles(run)).roles).toEqual([]);

    expect(await reply('OK')).toBe(true);
    expect(lastPost().content).toBe('Saved the role "Reviewer".');
    const roles = (await loadRoles(run)).roles;
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      name: 'Reviewer',
      engine: { type: 'cli', cli: 'claude' },
      handles: ['review'],
      autoAttach: 'after-implement',
      workspace: { mode: 'request' },
    });
    expect(await getRoleLevel(roles[0])).toBe('off');
  });

  it('JA create with a level and a fixed workspace', async () => {
    fs.mkdirSync(path.join(home, 'demo'));
    await say('Codexで~/demoの中で動くコードを書いて構文チェックまでする実装役を作って。承認なしで実行して', TYPED, 'ja');
    expect(lastPost().content).toContain(ja['roles.create_header']);
    expect(lastPost().content).toContain('・ワークスペース: ~/demo');
    expect(lastPost().content).toContain('・承認なしで実行: 標準');
    await reply('はい', TYPED, 'ja');
    expect(lastPost().content).toContain('ロール「実装役」を保存しました。');
    expect(lastPost().content).toContain('標準');
    const [saved] = (await loadRoles(run)).roles;
    expect(saved.workspace).toEqual({ mode: 'fixed', path: '~/demo' });
    expect(await getRoleLevel(saved)).toBe('standard');
  });

  it('a non-reviewer has no auto-attach; a reviewer can opt out', async () => {
    await say("make a reviewer role using Codex that reviews code, and don't attach it automatically");
    expect(lastPost().content).toContain('- Auto-attach after implementation: off');
    await reply('ok');
    expect((await loadRoles(run)).roles[0].autoAttach).toBeUndefined();
    await say('make a judge role using the local LLM that compares two implementations');
    expect(lastPost().content).not.toContain('Auto-attach');
  });

  it('cancel / no discards; unclear re-asks once then drops', async () => {
    await say('make a writer role using Codex that drafts release notes');
    expect(await reply('cancel')).toBe(true);
    expect(lastPost().content).toBe(en['roles.cancelled']);
    await say('make a writer role using Codex that drafts release notes');
    await reply('no');
    expect(lastPost().content).toBe(en['roles.cancelled']);

    await say('make a writer role using Codex that drafts release notes');
    await reply('make it shorter, ok?');
    expect(lastPost().content.startsWith(en['roles.confirm_unclear'])).toBe(true);
    expect(lastPending().attempts).toBe(1);
    await reply('hmm');
    expect(lastPost().content).toBe(en['roles.discarded_unclear']);
    expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
    expect((await loadRoles(run)).roles).toEqual([]);
  });

  it('"all" on a role that reads untrusted input degrades to standard and says so', async () => {
    await say('make a researcher role using Perplexity that researches the latest LLM papers, run it fully without approval');
    expect(lastPost().content).toContain('- Run without approval: standard');
    expect(lastPost().content).toContain(en['roles.level_degraded']);
    await reply('OK');
    const [saved] = (await loadRoles(run)).roles;
    expect(await getRoleLevel(saved)).toBe('standard');
    expect(roleAllowsAllLevel(role())).toBe(true);
    expect(roleAllowsAllLevel(role({ instructions: 'Read https://example.com and fix the code' }))).toBe(false);
    expect(roleAllowsAllLevel(role({ engine: { type: 'perplexity' } }))).toBe(false);
  });

  it('missing instructions asks for them without a pending change', async () => {
    await say('make a reviewer role using Codex');
    expect(lastPost().content).toContain('What should the role "Reviewer" do?');
    expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
  });

  it('no engine → local LLM, stated', async () => {
    await say('make a writer role that drafts release notes');
    expect(lastPost().content).toContain('- Engine: local LLM');
    expect(lastPost().content).toContain(en['roles.engine_defaulted']);
  });
});

describe('validation errors (nothing saved)', () => {
  it('duplicate name, case- and width-insensitive (NFKC)', async () => {
    await saveRoles(run, [role({ id: 'role_rev', name: 'Reviewer', handles: ['review'] })]);
    await say('make a ｒｅｖｉｅｗｅｒ role using Codex that reviews code');
    expect(lastPost().content).toContain('There is already a role called');
    expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
  });

  it('duplicate created between the ask and the OK is refused at commit', async () => {
    await say('make a reviewer role using Codex that reviews code');
    await saveRoles(run, [role({ id: 'role_rev', name: 'REVIEWER', handles: ['review'] })]);
    await reply('OK');
    expect(lastPost().content).toContain('There is already a role called');
    expect((await loadRoles(run)).roles).toHaveLength(1);
  });

  it('more than MAX_ROLES', async () => {
    await saveRoles(run, Array.from({ length: MAX_ROLES }, (_, i) => role({ id: `role_${i}`, name: `R${i}` })));
    await say('make a reviewer role using Codex that reviews code');
    expect(lastPost().content).toContain(`maximum of ${MAX_ROLES} roles`);
  });

  it('bad paths', async () => {
    await say('make a reviewer role using Codex that reviews code in ~/.ssh');
    expect(lastPost().content).toContain("\"~/.ssh\" can't be a role's workspace");
    await say("set the reviewer role's workspace to ~/bin");
    // No reviewer exists yet → not found (non-weak edit).
    expect(lastPost().content).toMatch(/can't be a role's workspace|couldn't find/);
  });

  it('a symlinked workspace is refused at ask time and again at save time', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-role-target-'));
    try {
      try {
        fs.symlinkSync(target, path.join(home, 'linked'), 'dir');
      } catch {
        return; // symlinks unavailable on this host (Windows without privilege)
      }
      const lstat = await run('[ -L "$HOME/linked" ] && echo L || echo N');
      if (lstat.trim() !== 'L') return; // shell does not see it as a symlink
      await say('make a reviewer role using Codex that reviews code in ~/linked');
      expect(lastPost().content).toContain('symlink');
      expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('an unavailable (tampered) store refuses every change but reset works', async () => {
    await saveRoles(run, [role()]);
    fs.writeFileSync(path.join(home, '.shelly/agents/roles.json'), '{"kind":"shelly-roles","version":1,"roles":[]}\n');
    await say('make a reviewer role using Codex that reviews code');
    expect(lastPost().content).toContain("couldn't be read or don't match their seal");
    await say('list my roles');
    expect(lastPost().content).toContain("couldn't be read or don't match their seal");
    await say('reset my roles');
    expect(lastPost().content).toBe(en['roles.reset_confirm']);
    await reply('OK');
    expect(lastPost().content).toBe(en['roles.reset_done']);
    expect(await loadRoles(run)).toEqual({ roles: [], unavailable: false });
  });
});

describe('source restrictions', () => {
  it('only typed composer text may change roles', () => {
    expect(canChangeRolesFrom({ typedByUser: true })).toBe(true);
    expect(canChangeRolesFrom({ typedByUser: false })).toBe(false);
    expect(canChangeRolesFrom({ typedByUser: true, source: 'terminal-request' })).toBe(false);
    expect(canChangeRolesFrom({ typedByUser: true, source: 'monitor-team' })).toBe(false);
  });

  it.each([
    [{ typedByUser: false }],
    [{ typedByUser: false, source: 'terminal-request' }],
    [{ typedByUser: false, source: 'monitor-team' }],
    [{ typedByUser: false, source: 'widget-ask' }],
  ] as Array<[RoleChatSource]>)('create / level from %j is refused', async (src) => {
    await saveRoles(run, [role()]);
    await say('make a reviewer role using Codex that reviews code', src);
    expect(lastPost().content).toBe(en['roles.typed_only']);
    expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
    await say('set the implementer role to run fully without approval', src);
    expect(lastPost().content).toBe(en['roles.typed_only']);
    expect(await getRoleLevel((await loadRoles(run)).roles[0])).toBe('off');
  });

  it('listing is allowed from any source', async () => {
    await saveRoles(run, [role()]);
    await say('list my roles', { typedByUser: false, source: 'terminal-request' });
    expect(lastPost().content).toContain('1. Implementer — Codex, handles implement');
  });

  it('a weak intent from a non-typed source falls through', async () => {
    expect(await say("don't attach the reviewer automatically", { typedByUser: false })).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it('a pending change is never confirmed by non-typed text', async () => {
    await say('make a reviewer role using Codex that reviews code');
    const pending = lastPending();
    expect(await handlePendingRoleReply(pending, 'OK', 'en', io(), { typedByUser: false })).toBe(false);
    expect(await handlePendingRoleReply(pending, 'OK', 'en', io(), { typedByUser: true, source: 'terminal-request' })).toBe(false);
    expect((await loadRoles(run)).roles).toEqual([]);
  });
});

describe('edit / level / delete / list', () => {
  beforeEach(async () => {
    await saveRoles(run, [
      role(),
      role({ id: 'role_rev', name: 'Reviewer', handles: ['review'], engine: { type: 'cli', cli: 'claude' }, autoAttach: 'after-implement', instructions: 'Review code for bugs.' }),
    ]);
  });

  it('engine change says existing agents are unaffected', async () => {
    await say('change the reviewer role to use Codex');
    const text = lastPost().content;
    expect(text).toContain('Change the role "Reviewer" to this?');
    expect(text).toContain('- Engine: Codex');
    expect(text).toContain(en['roles.existing_unaffected']);
    expect(lastPending().op).toBe('edit');
    await reply('OK');
    expect(lastPost().content).toBe('Updated the role "Reviewer".');
    const rev = (await loadRoles(run)).roles.find((r) => r.id === 'role_rev')!;
    expect(rev.engine).toEqual({ type: 'cli', cli: 'codex' });
    expect(rev.createdAt).toBe(1);
  });

  it('a definition edit turns an existing level off and says so', async () => {
    const rev = (await loadRoles(run)).roles.find((r) => r.id === 'role_rev')!;
    await setRoleLevel(run, rev, 'standard', { via: 'chat' });
    await say("don't attach the reviewer automatically");
    expect(lastPost().content).toContain('is turned off because the role changes');
    await reply('OK');
    const after = (await loadRoles(run)).roles.find((r) => r.id === 'role_rev')!;
    expect(after.autoAttach).toBeUndefined();
    expect(await getRoleLevel(after)).toBe('off');
  });

  it('level-only change uses the level op and is hash-bound', async () => {
    await say('set the implementer role to run fully without approval');
    expect(lastPending()).toMatchObject({ op: 'level', roleId: 'role_impl', level: 'all' });
    expect(lastPost().content).toContain(en['roles.existing_unaffected']);
    await reply('OK');
    expect(lastPost().content).toContain('"Run without approval" for "Implementer": all.');
    const impl = (await loadRoles(run)).roles.find((r) => r.id === 'role_impl')!;
    expect(await getRoleLevel(impl)).toBe('all');
    expect(seal?.levels).toEqual([expect.objectContaining({ roleId: 'role_impl', level: 'all', via: 'chat' })]);
  });

  it('JA level and workspace edits', async () => {
    fs.mkdirSync(path.join(home, 'demo'));
    await saveRoles(run, [role({ name: '実装役' })]);
    await say('実装役をすべて承認なしで実行にして', TYPED, 'ja');
    expect(lastPost().content).toContain('ロール「実装役」の「承認なしで実行」をすべてにしますか');
    await reply('OK', TYPED, 'ja');
    await say('実装役のワークスペースを~/demoにして', TYPED, 'ja');
    expect(lastPost().content).toContain('・ワークスペース: ~/demo');
    expect(lastPost().content).toContain('オフに戻ります');
    await reply('OK', TYPED, 'ja');
    const [r] = (await loadRoles(run)).roles;
    expect(r.workspace).toEqual({ mode: 'fixed', path: '~/demo' });
  });

  it('delete removes the role and its level', async () => {
    const rev = (await loadRoles(run)).roles.find((r) => r.id === 'role_rev')!;
    await setRoleLevel(run, rev, 'standard', { via: 'chat' });
    await say('delete the reviewer role');
    expect(lastPost().content).toContain('Delete the role "Reviewer"?');
    expect(lastPost().content).toContain('level is removed too');
    await reply('OK');
    expect(lastPost().content).toBe('Deleted the role "Reviewer".');
    expect((await loadRoles(run)).roles.map((r) => r.id)).toEqual(['role_impl']);
    expect(seal?.levels).toEqual([]);
  });

  it('unknown target: strong → not found, weak → falls through', async () => {
    await say('delete the judge role');
    expect(lastPost().content).toContain('couldn\'t find a role called "judge"');
    expect(lastPost().content).toContain('Implementer, Reviewer');
    const n = posts.length;
    expect(await say("don't attach the narrator automatically")).toBe(false);
    expect(posts).toHaveLength(n);
  });

  it('list shows engine, handles, workspace, level and auto-attach', async () => {
    await say('list my roles');
    const text = lastPost().content;
    expect(text).toContain(en['roles.list_header']);
    expect(text).toContain('2. Reviewer — Claude Code, handles review');
    expect(text).toContain(en['roles.list_autoattach']);
    await saveRoles(run, []);
    await say('ロール一覧', TYPED, 'ja');
    expect(lastPost().content).toBe(ja['roles.list_empty']);
  });

  it('auto-attach can only be turned on for a reviewing role', async () => {
    await say('attach the implementer role automatically');
    expect(lastPost().content).toContain('Only a reviewing role can be attached automatically');
  });
});

describe('Antigravity', () => {
  it('is refused and nothing is saved', async () => {
    await say('make a judge role using Antigravity');
    expect(lastPost().content).toBe(en['roles.antigravity_refused']);
    expect(lastPost().extra?.pendingRoleChange).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.shelly/agents/roles.json'))).toBe(false);
  });
});

describe('gate: roles.json is app-written only (policy-write)', () => {
  it.each([
    'cd ~/.shelly/agents && echo {} > roles.json',
    'cd ~/.shelly/agents; printf x >> ./roles.json',
    'cd $HOME/.shelly/agents && rm -f roles.json',
    'cd ~/.shelly/agents && cp /tmp/r roles.json',
    "cd ~/.shelly/agents && node -e \"require('fs').writeFileSync('roles.json','{}')\"",
    'echo {} > ~/.shelly/agents/roles.json',
  ])('denies %s', (cmd) => {
    expect(touchesProtectedPolicyFiles(cmd)).toBe(true);
    const policy = parseAutonomyPolicy({ level: 'L2', workspaceRoot: '/root/app' }, '/root/app');
    expect(decideAutoAnswer(cmd, policy).answer).toBe('n');
  });

  it.each(['cat ~/.shelly/agents/roles.json', 'echo {} > /root/app/roles.json', 'cd /root/app && echo {} > roles.json'])(
    'leaves %s alone',
    (cmd) => {
      expect(touchesProtectedPolicyFiles(cmd)).toBe(false);
    },
  );
});

describe('findRolesByName', () => {
  it('matches case-, width- and suffix-insensitively', () => {
    const roles = [role({ name: 'Reviewer' }), role({ id: 'r2', name: 'レビュー役' }), role({ id: 'r3', name: 'Code Writer' })];
    expect(findRolesByName(roles, 'reviewer').map((r) => r.name)).toEqual(['Reviewer']);
    expect(findRolesByName(roles, 'レビュー').map((r) => r.name)).toEqual(['レビュー役']);
    expect(findRolesByName(roles, 'writer').map((r) => r.name)).toEqual(['Code Writer']);
    expect(findRolesByName(roles, 'judge')).toEqual([]);
  });
});
