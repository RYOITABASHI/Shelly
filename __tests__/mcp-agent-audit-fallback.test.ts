/**
 * read_agent_audit / read_article_history, RN side (lib/mcp-server-bridge.ts):
 * the queue fallback used when the MCP server has no verified snapshot. The
 * generated shell script is run for real (bash) against a temp $HOME, so the
 * symlink / hard-link / missing-file checks are exercised end to end.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const mockFiles = new Map<string, string>();
const mockHomeRoot: string = (() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mcp-audit-rn-'));
})();
const mockAgents = [{ id: 'a1', name: 'Example', enabled: true, schedule: null, autonomous: false }];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: `file://${mockHomeRoot}/`,
  readDirectoryAsync: jest.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...mockFiles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'));
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const v = mockFiles.get(uri);
    if (v === undefined) throw new Error('ENOENT ' + uri);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(`${uri}/`)) mockFiles.delete(k);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  }),
}));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: mockAgents }), subscribe: () => () => {} } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/settings-store', () => ({ useSettingsStore: { getState: () => ({ settings: { mcpServerEnabled: true } }) } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
const mockExecCommand = jest.fn(async (cmd: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const r = require('child_process').spawnSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 4 << 20 });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
});
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...a: unknown[]) => (mockExecCommand as any)(...a) }));
jest.mock('@/lib/agent-user-policy-store', () => ({ getCachedUserPolicy: () => null, getCachedUserPolicyPin: () => null, loadUserPolicy: jest.fn() }));

import {
  __setMCPRequestSha256ForTests,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_TAIL_READ_BYTES,
  ARTICLE_HISTORY_READ_MAX_BYTES,
  agentLogReadScript,
  articleHistoryUrl,
  projectArticleHistory,
  projectAuditLine,
  setMCPBridgeKey,
  startMCPPoller,
  stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { TEST_BRIDGE_KEY, nodeSha256, signedRequest } from './helpers/mcp-signed-request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

const HOME = `${mockHomeRoot}/home`;
const LOGS = `${HOME}/.shelly/agents/logs`;
const QUEUE = `file://${HOME}/.shelly-mcp-queue`;
const REQUESTS = `${QUEUE}/requests`;
const RESULTS = `${QUEUE}/results`;
const AUDIT = `${LOGS}/a1/plan-executor-audit.jsonl`;
const line = (i: number) => JSON.stringify({ ts: i, event: 'step_done', stepIndex: i });

const hasBash = spawnSync('bash', ['-c', 'stat -c %h / && tail -c 1 /dev/null'], { encoding: 'utf8' }).status === 0;

beforeAll(() => {
  __setMCPRequestSha256ForTests(nodeSha256);
  setMCPBridgeKey(TEST_BRIDGE_KEY);
});

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(`${LOGS}/a1`, { recursive: true });
});

afterEach(() => {
  stopMCPPoller();
  mockFiles.clear();
  mockExecCommand.mockClear();
});

afterAll(() => {
  fs.rmSync(mockHomeRoot, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let seq = 0;
async function call(tool: string, args: Record<string, unknown> = {}) {
  const callId = `aud${++seq}`;
  mockFiles.set(`${REQUESTS}/${callId}.json`, await signedRequest(callId, tool, args));
  startMCPPoller();
  const resultUri = `${RESULTS}/${callId}.json`;
  await waitFor(() => mockFiles.has(resultUri));
  return JSON.parse(mockFiles.get(resultUri)!);
}

/** The server's direct read over the same files, for a same-answer check. */
function serverRead(tool: string, args: Record<string, unknown>) {
  const fallback = jest.fn();
  return { fallback, run: async (snapAgents = mockAgents) => {
    const queueDir = path.join(HOME, '.shelly-mcp-queue');
    fs.mkdirSync(queueDir, { recursive: true });
    const body = JSON.stringify({ v: 1, agents: snapAgents, repoPaths: [] });
    fs.writeFileSync(path.join(queueDir, 'snapshot.json'), JSON.stringify({ body, mac: mcp.snapshotMac('t', body) }));
    return mcp.createDirectReadCallTool({ queueDir, token: 't', fallback })(tool, args);
  } };
}

(hasBash ? describe : describe.skip)('MCP read_agent_audit / read_article_history — RN queue fallback', () => {
  it('constants match the server', () => {
    expect(AUDIT_TAIL_READ_BYTES).toBe(mcp.AUDIT_TAIL_READ_BYTES);
    expect(AUDIT_DEFAULT_LIMIT).toBe(mcp.AUDIT_DEFAULT_LIMIT);
    expect(AUDIT_MAX_LIMIT).toBe(mcp.AUDIT_MAX_LIMIT);
    expect(ARTICLE_HISTORY_READ_MAX_BYTES).toBe(mcp.ARTICLE_HISTORY_READ_MAX_BYTES);
  });

  it('answers read_agent_audit with the newest lines, redacted, same as the server', async () => {
    fs.writeFileSync(AUDIT, `${[1, 2, 3].map(line).join('\n')}\n${JSON.stringify({ note: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123' })}\n`);
    const res = await call('read_agent_audit', { agentId: 'a1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(res.data.lines).toBe(3);
    expect(res.data.truncated).toBe(true);
    expect(res.data.untrusted).toBe(true);
    expect(res.data.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(res).toEqual(await serverRead('read_agent_audit', { agentId: 'a1', limit: 3 }).run());
  });

  it('a large file: only the tail window, cut first line dropped, same as the server', async () => {
    const tail = `QQQQ${'\n'.repeat(AUDIT_TAIL_READ_BYTES - 4 - line(1).length - 1)}${line(1)}\n`;
    fs.writeFileSync(AUDIT, `${'P'.repeat(1000)}\nQQ${tail}`);
    const res = await call('read_agent_audit', { agentId: 'a1', limit: 500 });
    expect(res).toEqual({ ok: true, data: { agentId: 'a1', lines: 1, truncated: true, text: line(1), untrusted: true } });
    expect(res).toEqual(await serverRead('read_agent_audit', { agentId: 'a1', limit: 500 }).run());
  });

  it('refuses unknown / traversal agent ids without running anything', async () => {
    for (const agentId of ['other', '../a1', 'a1/..', '', 'a.1']) {
      const res = await call('read_agent_audit', { agentId });
      expect(res.ok).toBe(false);
    }
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('missing file, symlinked file, hard-linked file and symlinked directory', async () => {
    expect((await call('read_agent_audit', { agentId: 'a1' })).error).toContain('no audit log for agent a1');
    const outside = path.join(mockHomeRoot, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE-CONTENT\n');
    fs.symlinkSync(outside, AUDIT);
    let res = await call('read_agent_audit', { agentId: 'a1' });
    expect(res.error).toMatch(/^refused/);
    fs.unlinkSync(AUDIT);
    fs.linkSync(outside, AUDIT);
    res = await call('read_agent_audit', { agentId: 'a1' });
    expect(res.error).toMatch(/^refused/);
    fs.unlinkSync(AUDIT);
    const elsewhere = path.join(mockHomeRoot, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'plan-executor-audit.jsonl'), 'OUTSIDE-CONTENT\n');
    fs.rmdirSync(`${LOGS}/a1`);
    fs.symlinkSync(elsewhere, `${LOGS}/a1`);
    res = await call('read_agent_audit', { agentId: 'a1' });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('OUTSIDE-CONTENT');
  });

  it('read_article_history: projected to the executor schema, and the same refusals as the server', async () => {
    const history = {
      version: 1,
      access_token: 'TOPLEVEL-SECRET',
      entries: [{ title: 'A study', url: 'https://user:pw@example.org/x?sig=SIGNED-SECRET#f', date: '2026-11-01', access_token: 'ENTRY-SECRET', extra: 1 }],
    };
    fs.writeFileSync(`${LOGS}/article-history-s1.json`, JSON.stringify(history));
    const res = await call('read_article_history', { stream: 's1' });
    expect(res).toEqual({ ok: true, data: { stream: 's1', untrusted: true, history: { version: 1, entries: [{ title: 'A study', url: 'https://example.org/x', date: '2026-11-01' }] } } });
    expect(res).toEqual(await serverRead('read_article_history', { stream: 's1' }).run());

    expect((await call('read_article_history', { stream: '../x' })).error).toContain('stream must match');
    expect((await call('read_article_history', { stream: 'none' })).error).toContain('no article history for stream none');
    fs.symlinkSync(`${LOGS}/article-history-s1.json`, `${LOGS}/article-history-link.json`);
    expect((await call('read_article_history', { stream: 'link' })).error).toMatch(/^refused/);
    fs.writeFileSync(`${LOGS}/article-history-big.json`, JSON.stringify({ x: 'y'.repeat(ARTICLE_HISTORY_READ_MAX_BYTES) }));
    expect((await call('read_article_history', { stream: 'big' })).error).toContain('larger than');
    fs.writeFileSync(`${LOGS}/article-history-bad.json`, '{nope');
    expect((await call('read_article_history', { stream: 'bad' })).error).toContain('not valid JSON');
    fs.writeFileSync(`${LOGS}/article-history-shape.json`, '{"secret":"S"}');
    expect((await call('read_article_history', { stream: 'shape' })).error).toBe('the article history is not in the expected format');
  });

  it('audit lines are projected the same way as the server', async () => {
    const corpus = [
      { ts: '2026-11-18T00:00:00Z', kind: 'draft_write_failed', agentId: 'a1', code: 'other', target: '/v/x.md', swallowed: true, error: 'free text' },
      { kind: 'draft_saved', folder: '/v', file: 'a.md', bytes: 3 },
      { kind: 'article_config_mismatch', problems: ['p1', 'x'.repeat(400)] },
      { kind: 'after_draft_hook', status: 'ok', draftPresent: false },
      { reason: 'stale-lock' }, { reason: 'Prose reason' }, { preview: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123' },
      { 'weird key': 1, omitted: 'x', secretCount: 3 }, { target: 'https://h/?token=abcdefghijk123' }, { exitCode: 1, ok: true, score: 4.5 },
    ];
    const lines = [...corpus.map((c) => JSON.stringify(c)), 'nope', '[1]', 'null'];
    for (const l of lines) expect(projectAuditLine(l)).toEqual(mcp.projectAuditLine(l));
    for (const url of ['https://us\ter:pw@evil.example/x', 'https://a@b@host.example:80/p@q?x#y', 'https://host.example/a@b', 'https://h/caf\u00e9', 'http://H.example', 'javascript:x']) {
      expect(articleHistoryUrl(url)).toBe(mcp.projectArticleHistory({ entries: [{ url }] }).entries[0].url);
    }
    for (const h of [{ version: 1, entries: [{ title: 't', url: 'https://a.b/c?d=e', date: '2026-01-01', x: 1 }] }, { entries: [] }, {}, [], null]) {
      expect(projectArticleHistory(h)).toEqual(mcp.projectArticleHistory(h));
    }
    fs.writeFileSync(AUDIT, `${lines.join('\n')}\n`);
    const res = await call('read_agent_audit', { agentId: 'a1', limit: 500 });
    expect(res).toEqual(await serverRead('read_agent_audit', { agentId: 'a1', limit: 500 }).run());
    expect(res.data.text).not.toContain('free text');
    expect(res.data.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('shell script: a descriptor that is not the checked path is refused (/proc/$$/fd), the physical path is accepted', () => {
    if (!fs.existsSync('/proc/self/fd')) return;
    fs.writeFileSync(AUDIT, `${line(1)}\n`);
    const outside = path.join(mockHomeRoot, 'outside.jsonl');
    fs.writeFileSync(outside, 'OUTSIDE-CONTENT\n');
    const script = agentLogReadScript(HOME, ['.shelly', 'agents', 'logs', 'a1'], 'plan-executor-audit.jsonl', 1024);
    // Simulate the race: the checks pass on the real file, the open lands elsewhere.
    expect(script).toContain('} 3< "$f"');
    const swapped = script.replace('} 3< "$f"', `} 3< ${JSON.stringify(outside)}`);
    const bad = spawnSync('bash', ['-c', swapped], { encoding: 'utf8' });
    expect(bad.stdout.trim()).toBe('refused');
    // Home given through a symlink: cd -P makes the expected path physical.
    const linkHome = path.join(mockHomeRoot, 'home-link');
    fs.symlinkSync(HOME, linkHome);
    const good = spawnSync('bash', ['-c', agentLogReadScript(linkHome, ['.shelly', 'agents', 'logs', 'a1'], 'plan-executor-audit.jsonl', 1024)], { encoding: 'utf8' });
    expect(good.stdout).toBe(`ok ${line(1).length + 1}\n${line(1)}\n`);
    fs.unlinkSync(linkHome);
  });
});
