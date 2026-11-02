/**
 * MONITOR staff roster (lib/monitor-roster.ts): the display-only snapshot RN
 * publishes next to roles.json for the widget's idle tiles and the in-app
 * MONITOR — shape, no instructions / levels / paths, caps, unavailable,
 * write-on-change + widget ping, and the in-app STANDBY source. Real bash in a
 * temp $HOME (the same shell commands the app runs), in-memory seal.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetRoleStoreForTests,
  configureRoleSealPort,
  loadRoles,
  resetRoles,
  saveRoles,
  type RoleSealState,
} from '@/lib/agent-role-store';
import type { AgentRole } from '@/lib/agent-role-types';
import {
  __resetMonitorRosterForTests,
  buildMonitorRoster,
  configureMonitorRosterPublisher,
  createRosterSource,
  getMonitorRoster,
  publishMonitorRoster,
  roleEngineLabel,
  rosterDefs,
  sanitizeRosterText,
  subscribeMonitorRoster,
  ROSTER_MAX_ENTRIES,
  ROSTER_TEXT_MAX_CHARS,
} from '@/lib/monitor-roster';
import { detectRoleIntent } from '@/lib/agent-role-intent';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

jest.setTimeout(60_000);

let home: string;
const rosterFile = () => path.join(home, '.shelly/agents/monitor-roster.json');
const run = async (cmd: string): Promise<string> =>
  execFileSync('bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, HOME: home.replace(/\\/g, '/') } });
let seal: RoleSealState | null;
let notify: jest.Mock;
let writes: string[];

function role(over: Partial<AgentRole> = {}): AgentRole {
  return {
    id: 'role_impl',
    name: 'Implementer',
    instructions: 'SECRET-INSTRUCTIONS write working code in the workspace and run a syntax check.',
    engine: { type: 'cli', cli: 'codex' },
    handles: ['implement'],
    workspace: { mode: 'fixed', path: '~/demo-secret-path' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}
const reviewer = () =>
  role({ id: 'role_rev', name: 'Reviewer', engine: { type: 'cli', cli: 'claude' }, handles: ['review'], workspace: { mode: 'request' } });

/** Let the fire-and-forget publish (role-store listener) finish. */
const settle = () => publishMonitorRoster(getMonitorRoster() ?? buildMonitorRoster({ roles: [], unavailable: false }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-roster-'));
  seal = { fileHashes: [], levels: [] };
  configureRoleSealPort({
    read: async () => (seal ? JSON.parse(JSON.stringify(seal)) : null),
    write: async (s) => {
      seal = JSON.parse(JSON.stringify(s));
    },
  });
  __resetRoleStoreForTests();
  __resetMonitorRosterForTests();
  notify = jest.fn();
  writes = [];
  configureMonitorRosterPublisher({
    run: async (cmd) => {
      writes.push(cmd);
      return run(cmd);
    },
    notify,
  });
});
afterEach(() => {
  configureRoleSealPort(null);
  configureMonitorRosterPublisher(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('roster publish', () => {
  it('saving roles publishes name / engine / kind / handles only — no instructions, levels or paths', async () => {
    await saveRoles(run, [role(), reviewer()]);
    await settle();
    const text = fs.readFileSync(rosterFile(), 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      kind: 'shelly-monitor-roster',
      version: 1,
      unavailable: false,
      total: 2,
      roles: [
        { name: 'Implementer', engine: 'Codex', kind: 'CLI', handles: ['implement'] },
        { name: 'Reviewer', engine: 'Claude Code', kind: 'CLI', handles: ['review'] },
      ],
    });
    expect(text).not.toMatch(/SECRET|instructions|demo-secret-path|level|workspace|role_impl/);
    // No top-level id: every agents-dir scanner skips it.
    expect(parsed.id).toBeUndefined();
    // Same dir as roles.json, no new directory, no leftover tmp file.
    expect(fs.readdirSync(path.join(home, '.shelly/agents')).sort()).toEqual(['monitor-roster.json', 'roles.json']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('writes and pings the widget only when the roster changed', async () => {
    await saveRoles(run, [role()]);
    await settle();
    expect(writes).toHaveLength(1);
    await loadRoles(run);
    await settle();
    expect(writes).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    await saveRoles(run, [role(), reviewer()]);
    await settle();
    expect(writes).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('caps entries and text; total keeps the real count', () => {
    const roles = Array.from({ length: 12 }, (_, i) => role({ id: `r${i}`, name: `Role ${i} ${'x'.repeat(10)}` }));
    const roster = buildMonitorRoster({ roles, unavailable: false });
    expect(roster.roles).toHaveLength(ROSTER_MAX_ENTRIES);
    expect(roster.total).toBe(12);
    expect(roster.roles.every((r) => Array.from(r.name).length <= ROSTER_TEXT_MAX_CHARS)).toBe(true);
  });

  it('strips control / format characters from display text', () => {
    expect(sanitizeRosterText('Re\u202Eview\u200Ber\n\u001b[31m')).toBe('Re view er [31m');
    expect(sanitizeRosterText(42)).toBe('');
    expect(Array.from(sanitizeRosterText('あ'.repeat(40)))).toHaveLength(ROSTER_TEXT_MAX_CHARS);
  });

  it('an unverifiable roles.json publishes no names (unavailable)', async () => {
    fs.mkdirSync(path.join(home, '.shelly/agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.shelly/agents/roles.json'), '{"kind":"shelly-roles","version":1,"roles":[]}');
    seal = { fileHashes: [], levels: [] }; // a non-empty file with an empty seal → unsealed
    await loadRoles(run);
    await settle();
    expect(JSON.parse(fs.readFileSync(rosterFile(), 'utf8'))).toEqual({
      kind: 'shelly-monitor-roster',
      version: 1,
      unavailable: true,
      total: 0,
      roles: [],
    });
    expect(getMonitorRoster()?.unavailable).toBe(true);
  });

  it('reset publishes an empty roster; subscribers hear every change', async () => {
    const heard = jest.fn();
    subscribeMonitorRoster(heard);
    await saveRoles(run, [role()]);
    await resetRoles(run);
    await settle();
    expect(JSON.parse(fs.readFileSync(rosterFile(), 'utf8')).roles).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('no publisher (web / tests): nothing written, roster still tracked in memory', async () => {
    configureMonitorRosterPublisher(null);
    await saveRoles(run, [role()]);
    expect(fs.existsSync(rosterFile())).toBe(false);
    expect(getMonitorRoster()?.roles.map((r) => r.name)).toEqual(['Implementer']);
  });
});

describe('engine labels', () => {
  it('Codex / Claude Code / Local LLM / API names', () => {
    expect(roleEngineLabel({ type: 'cli', cli: 'codex' })).toBe('Codex');
    expect(roleEngineLabel({ type: 'cli', cli: 'claude' })).toBe('Claude Code');
    expect(roleEngineLabel({ type: 'local' })).toBe('Local LLM');
    expect(roleEngineLabel({ type: 'gemini-api' })).toBe('Gemini API');
    expect(roleEngineLabel({ type: 'groq' })).toBe('Groq');
    expect(roleEngineLabel({ type: 'openrouter' })).toBe('OpenRouter');
    expect(roleEngineLabel({ type: 'perplexity' })).toBe('Perplexity');
  });
});

describe('in-app STANDBY source', () => {
  it('one STANDBY channel per role, named like a live role step', () => {
    const roster = buildMonitorRoster({ roles: [role(), reviewer(), role({ id: 'j', name: 'Judge', engine: { type: 'local' } })], unavailable: false });
    const defs = rosterDefs(roster);
    expect(defs.map((d) => d.channel)).toEqual(['IMPLEMENTE', 'REVIEWER', 'JUDGE']);
    expect(defs.map((d) => [d.provider, d.kind, d.providerName])).toEqual([
      ['codex-cli', 'CLI', 'Codex'],
      ['claude-cli', 'CLI', 'Claude Code'],
      ['local', 'LOCAL', 'Local LLM'],
    ]);
    const source = createRosterSource(roster, 'STAFF');
    expect(source.isDemo).toBe(false);
    const snap = source.snapshot(0, []);
    expect(Object.values(snap.agents).map((a) => a.state)).toEqual(['STANDBY', 'STANDBY', 'STANDBY']);
    expect(snap.approvalPending).toBe(false);
    expect(source.team.columns).toHaveLength(3);
  });
});

describe('the no-roles hint is a real role request', () => {
  it.each([
    ['en', 'make a reviewer role using Claude Code'],
    ['ja', 'Claude Codeでレビュー役を作って'],
  ])('%s: %s', (_lang, utterance) => {
    const intent = detectRoleIntent(utterance);
    expect(intent?.kind).toBe('create');
    if (intent?.kind === 'create') expect(intent.engine).toEqual({ type: 'cli', cli: 'claude' });
  });

  it('the hint strings quote those utterances', () => {
    expect((en as Record<string, string>)['monitor.staff.none']).toContain('make a reviewer role using Claude Code');
    expect((ja as Record<string, string>)['monitor.staff.none']).toContain('Claude Codeでレビュー役を作って');
  });
});
