/**
 * Codex file-change approvals (apply_patch) go through the same gate as
 * shell commands: v2 item/fileChange/requestApproval (paths from the
 * fileChange item) and legacy applyPatchApproval (paths in fileChanges).
 * A declined change is a normal decision and never makes the step fail;
 * any other unknown server request still does.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FAKE_CODEX_MCP_LIST, FAKE_CODEX_FEATURES_LIST } from './fixtures/fake-codex-mcp-list';

const root = path.resolve(__dirname, '..');
const driverPath = path.join(root, 'scripts/shelly-agent-driver.js');
const gateScript = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js');
const driver = require('../scripts/shelly-agent-driver.js');

describe('fileChangeToActions: the shell-equivalent gate commands', () => {
  const cwd = path.resolve('/w/demo');
  const q = (p: string) => `'${p}'`;

  it('maps v2 changes: add/update → tee, delete → rm, move → mv; relative paths resolve against the cwd', () => {
    const r = driver.fileChangeToActions([
      { path: 'a.txt', kind: { type: 'add' }, diff: '+x' },
      { path: path.join(cwd, 'b.txt'), kind: { type: 'update', move_path: null }, diff: '' },
      { path: 'c.txt', kind: { type: 'delete' }, diff: '' },
      { path: 'd.txt', kind: { type: 'update', move_path: 'sub/e.txt' }, diff: '' },
    ], cwd, 'item/fileChange/requestApproval');
    expect(r.deny).toBeUndefined();
    expect(r.actions.map((a: { command: string }) => a.command)).toEqual([
      `tee -- ${q(path.resolve(cwd, 'a.txt'))}`,
      `tee -- ${q(path.join(cwd, 'b.txt'))}`,
      `rm -- ${q(path.resolve(cwd, 'c.txt'))}`,
      `mv -- ${q(path.resolve(cwd, 'd.txt'))} ${q(path.resolve(cwd, 'sub/e.txt'))}`,
    ]);
    expect(r.actions.map((a: { index: number }) => a.index)).toEqual([0, 1, 2, 3]);
    // the diff (file content) is never carried into the action record
    expect(JSON.stringify(r.actions)).not.toContain('+x');
  });

  it('maps the legacy fileChanges map', () => {
    const r = driver.fileChangeToActions({
      'x.js': { type: 'add', content: 'x' },
      'y.js': { type: 'delete', content: 'y' },
    }, cwd, 'applyPatchApproval');
    expect(r.actions.map((a: { command: string }) => a.command)).toEqual([
      `tee -- ${q(path.resolve(cwd, 'x.js'))}`,
      `rm -- ${q(path.resolve(cwd, 'y.js'))}`,
    ]);
  });

  it('fails closed on no paths, control characters, or an unknown kind', () => {
    expect(driver.fileChangeToActions(undefined, cwd, 's').deny).toMatch(/without any known changed path/);
    expect(driver.fileChangeToActions([], cwd, 's').deny).toMatch(/without any known changed path/);
    expect(driver.fileChangeToActions([{ path: 'a\nb', kind: { type: 'add' } }], cwd, 's').deny).toMatch(/plain paths/);
    expect(driver.fileChangeToActions([{ path: 'a', kind: { type: 'update', move_path: 'b\u0000' } }], cwd, 's').deny).toMatch(/plain paths/);
    expect(driver.fileChangeToActions([{ path: 'a', kind: { type: 'chmod' } }], cwd, 's').deny).toMatch(/unknown file change kind/);
  });
});

// A scripted fake `codex app-server` (the driver's host spawn is `<codex-bin>
// app-server --listen stdio://`, so --codex-bin = node and a file named
// `app-server` in --cwd runs this). After turn/start it plays FAKE_FC_SCRIPT
// in order; for each server request it waits for the driver's answer and
// records it in FAKE_FC_RECORD, then sends turn/completed.
const FAKE_APP_SERVER = `
const fs = require('fs');
const readline = require('readline');
const script = JSON.parse(process.env.FAKE_FC_SCRIPT || '[]');
const record = process.env.FAKE_FC_RECORD;
const responses = {};
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let waitingFor = null;
let step = 0;
const play = () => {
  while (step < script.length) {
    const m = script[step++];
    out(m);
    if (m.id !== undefined && m.method) { waitingFor = String(m.id); return; }
  }
  fs.writeFileSync(record, JSON.stringify(responses));
  out({ method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: { type: 'agentMessage', id: 'msg', text: 'DONE' } } });
  out({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 't1', status: 'completed' } } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { return; }
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: 'th1' } } });
  else if (m.method === 'turn/start') { out({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } }); play(); }
  else if (waitingFor !== null && String(m.id) === waitingFor) {
    responses[waitingFor] = m.result !== undefined ? m.result : { error: m.error };
    waitingFor = null;
    play();
  }
});
`;

describe('driver E2E: Codex file-change approvals through the real gate', () => {
  type Msg = Record<string, unknown>;
  // POSIX outside path: the gate helper models Android paths (as the Claude
  // S4 E2E does with /etc/passwd).
  const OUTSIDE = '/etc/shelly-fc-outside.txt';
  const fcItem = (id: string, changes: Msg[]): Msg => ({
    method: 'item/started',
    params: { threadId: 'th1', turnId: 't1', item: { type: 'fileChange', id, changes, status: 'inProgress' } },
  });
  const v2Req = (id: string, itemId: string): Msg => ({
    id, method: 'item/fileChange/requestApproval',
    params: { threadId: 'th1', turnId: 't1', itemId, startedAtMs: 1 },
  });
  const legacyReq = (id: string, fileChanges: Msg): Msg => ({
    id, method: 'applyPatchApproval',
    params: { conversationId: 'th1', callId: `call-${id}`, fileChanges, reason: null, grantRoot: null },
  });

  function run(policy: object, build: (ws: string, home: string) => Msg[], extraArgs: string[] = []) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-home-'));
    const ws = path.join(home, 'demo');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'app-server'), FAKE_APP_SERVER);
    fs.writeFileSync(path.join(ws, 'mcp'), FAKE_CODEX_MCP_LIST);
    fs.writeFileSync(path.join(ws, 'features'), FAKE_CODEX_FEATURES_LIST);
    const rec = path.join(home, 'rec.json');
    const r = childProcess.spawnSync(process.execPath, [
      driverPath,
      '--cwd', ws,
      '--prompt', 'edit files',
      '--codex-bin', process.execPath,
      '--gate-script', gateScript,
      '--policy-json', JSON.stringify(policy),
      '--allow-unpinned-verifier-key',
      '--escalation-dir', path.join(home, 'esc'),
      '--escalation-reply-dir', path.join(home, 'esc-reply'),
      '--escalation-timeout-ms', '300',
      '--audit-log', path.join(home, 'audit.jsonl'),
      '--answer-file', path.join(home, 'answer.md'),
      '--timeout-ms', '30000',
      ...extraArgs,
    ], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 45000,
      env: { ...process.env, HOME: home, FAKE_FC_SCRIPT: JSON.stringify(build(ws, home)), FAKE_FC_RECORD: rec },
    });
    const responses = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : null;
    const out = `${r.stdout}${r.stderr}`;
    fs.rmSync(home, { recursive: true, force: true });
    return { status: r.status, out, responses };
  }

  it('v2: an in-workspace patch is accepted by the gate (unattended)', () => {
    const r = run({ unattended: true }, () => [
      fcItem('fc-1', [
        { path: 'index.html', kind: { type: 'add' }, diff: '<html>' },
        { path: 'game.js', kind: { type: 'update', move_path: null }, diff: '@@' },
      ]),
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'accept' } });
    expect(r.status).toBe(0);
    expect(r.out).toContain('file_change_accepted');
    expect(r.out.split('\n').filter((l) => l.startsWith('GATE ') && l.includes('item/fileChange/requestApproval'))).toHaveLength(2);
  }, 60_000);

  it('v2: paths from item/fileChange/patchUpdated replace the started item', () => {
    const r = run({ unattended: true }, (_ws, home) => [
      fcItem('fc-1', [{ path: 'a.txt', kind: { type: 'add' }, diff: '' }]),
      { method: 'item/fileChange/patchUpdated', params: { threadId: 'th1', turnId: 't1', itemId: 'fc-1', changes: [{ path: OUTSIDE, kind: { type: 'add' }, diff: '' }] } },
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(0);
  }, 60_000);

  it('v2: a path outside the workspace is declined unattended, and the step does not fail', () => {
    const r = run({ unattended: true }, (_ws, home) => [
      fcItem('fc-1', [
        { path: 'ok.txt', kind: { type: 'add' }, diff: '' },
        { path: OUTSIDE, kind: { type: 'add' }, diff: '' },
      ]),
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(0);
    expect(r.out).toContain('file_change_declined');
    expect(r.out).not.toContain('unknown_server_request');
  }, 60_000);

  it('v2 attended: a path outside the workspace escalates to a human and is declined without an approval', () => {
    const r = run({}, (_ws, home) => [
      fcItem('fc-1', [{ path: OUTSIDE, kind: { type: 'add' }, diff: '' }]),
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(0);
    // reaches the signed human escalation (fails closed here: no verifier key on the host)
    expect(r.out).toContain('escalation_fail_closed');
    expect(r.out).toContain('"escalationDecision":"decline"');
    expect(r.out).not.toContain('escalation_denied_unattended');
  }, 60_000);

  it('protocol drift: an approval for an item never announced is declined AND fails the step', () => {
    const r = run({ unattended: true }, () => [v2Req('req-1', 'missing')]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('file_change_protocol_mismatch');
    expect(r.out).toContain('"itemKnown":false');
  }, 60_000);

  it('protocol drift: an unknown change kind or a change without a path is declined AND fails the step', () => {
    for (const changes of [
      [{ path: 'a.txt', kind: { type: 'chmod' }, diff: 'SECRET-DIFF' }],
      [{ kind: { type: 'add' }, diff: 'SECRET-DIFF' }],
      [],
    ]) {
      const r = run({ unattended: true }, () => [fcItem('fc-1', changes), v2Req('req-1', 'fc-1')]);
      expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
      expect(r.status).toBe(1);
      const mismatch = r.out.split('\n').find((l) => l.includes('"kind":"file_change_protocol_mismatch"'));
      expect(mismatch).toBeDefined();
      expect(mismatch).toContain('"method":"item/fileChange/requestApproval"');
      expect(mismatch).not.toContain('SECRET-DIFF');
    }
    const legacy = run({ unattended: true }, () => [legacyReq('l-1', { 'a.txt': { type: 'rename' } })]);
    expect(legacy.responses).toEqual({ 'l-1': { decision: 'denied' } });
    expect(legacy.status).toBe(1);
    expect(legacy.out).toContain('file_change_protocol_mismatch');
  }, 120_000);

  it('a path with DEL or non-ASCII whitespace is a plain decline (not drift)', () => {
    for (const bad of ['a\u007f.txt', 'a\u00a0.txt', 'a\u2028.txt', 'a\u2029.txt', 'a\u200b.txt']) {
      expect(driver.fileChangeToActions([{ path: bad, kind: { type: 'add' } }], '/w', 's')).toEqual({ deny: 'file change needs plain paths' });
    }
    const r = run({ unattended: true }, () => [
      fcItem('fc-1', [{ path: 'a\u2028b.txt', kind: { type: 'add' }, diff: '' }]),
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('file_change_protocol_mismatch');
  }, 60_000);

  const fcDone = (id: string, changes: Msg[], status = 'completed'): Msg => ({
    method: 'item/completed',
    params: { threadId: 'th1', turnId: 't1', item: { type: 'fileChange', id, changes, status } },
  });

  it('applied = approved: a completed item with only approved paths keeps the step green', () => {
    const changes = [{ path: 'a.txt', kind: { type: 'add' }, diff: '' }, { path: 'b.txt', kind: { type: 'update', move_path: 'c.txt' }, diff: '' }];
    const r = run({ unattended: true }, () => [fcItem('fc-1', changes), v2Req('req-1', 'fc-1'), fcDone('fc-1', changes)]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'accept' } });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('file_change_unapproved_path');
  }, 60_000);

  it('applied ≠ approved: a completed item touching a path never approved fails the step', () => {
    const r = run({ unattended: true }, () => [
      fcItem('fc-1', [{ path: 'a.txt', kind: { type: 'add' }, diff: '' }]),
      v2Req('req-1', 'fc-1'),
      fcDone('fc-1', [{ path: 'a.txt', kind: { type: 'add' }, diff: '' }, { path: 'extra.txt', kind: { type: 'add' }, diff: '' }]),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'accept' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('file_change_unapproved_path');
    expect(r.out).toContain('extra.txt');
  }, 60_000);

  it('applied ≠ approved: a fileChange completed without any approval request fails the step; a declined one does not', () => {
    const changes = [{ path: 'a.txt', kind: { type: 'add' }, diff: '' }];
    const silent = run({ unattended: true }, () => [fcItem('fc-1', changes), fcDone('fc-1', changes)]);
    expect(silent.status).toBe(1);
    expect(silent.out).toContain('file_change_unapproved_path');
    const declined = run({ unattended: true }, () => [
      fcItem('fc-1', [{ path: OUTSIDE, kind: { type: 'add' }, diff: '' }]),
      v2Req('req-1', 'fc-1'),
      fcDone('fc-1', [{ path: OUTSIDE, kind: { type: 'add' }, diff: '' }], 'declined'),
    ]);
    expect(declined.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(declined.status).toBe(0);
    expect(declined.out).not.toContain('file_change_unapproved_path');
  }, 120_000);

  it('multi-file escalation: stops at the first decline and labels the file k/N', () => {
    const r = run({}, () => [
      fcItem('fc-1', [
        { path: '/etc/shelly-fc-1.txt', kind: { type: 'add' }, diff: '' },
        { path: '/etc/shelly-fc-2.txt', kind: { type: 'add' }, diff: '' },
      ]),
      v2Req('req-1', 'fc-1'),
    ]);
    expect(r.responses).toEqual({ 'req-1': { decision: 'decline' } });
    expect(r.status).toBe(0);
    const failClosed = r.out.split('\n').filter((l) => l.includes('"kind":"escalation_fail_closed"'));
    expect(failClosed).toHaveLength(1); // the second file never reached a human
    expect(r.out.split('\n').filter((l) => l.startsWith('GATE ') && l.includes('item/fileChange/requestApproval'))).toHaveLength(2);
  }, 60_000);

  it('legacy applyPatchApproval: approved in the workspace, denied outside', () => {
    const r = run({ unattended: true }, (ws, home) => [
      legacyReq('l-1', { [path.join(ws, 'a.txt')]: { type: 'add', content: 'x' } }),
      legacyReq('l-2', { 'b.txt': { type: 'update', unified_diff: '@@', move_path: null }, [OUTSIDE]: { type: 'add', content: 'y' } }),
    ]);
    expect(r.responses).toEqual({ 'l-1': { decision: 'approved' }, 'l-2': { decision: 'denied' } });
    expect(r.status).toBe(0);
  }, 60_000);

  it('any other unknown server request still fails the step', () => {
    const r = run({ unattended: true }, () => [
      { id: 'u-1', method: 'item/tool/requestUserInput', params: { threadId: 'th1', turnId: 't1', itemId: 'x', questions: [] } },
    ]);
    expect(r.responses['u-1'].error).toBeDefined();
    expect(r.status).toBe(1);
    expect(r.out).toContain('unknown_server_request');
  }, 60_000);
});
