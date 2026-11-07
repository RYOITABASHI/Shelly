/**
 * The Bump Codex Runtime job watches Termux's index, so a package that stops
 * following upstream stays green forever. scripts/check-codex-freeze.js fails the
 * job when upstream has been ahead of what we ship for more than the limit.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/check-codex-freeze.js');
const { checkFreeze } = require('../scripts/check-codex-freeze.js');

const NOW = Date.parse('2026-11-07T00:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const release = (version: string, days: number, isPrerelease = false) => ({
  tagName: `rust-v${version}`,
  publishedAt: daysAgo(days),
  isPrerelease,
});
const check = (shipped: string, releases: unknown, maxLagDays = 3) => checkFreeze({ shipped, releases, maxLagDays, now: NOW });

describe('checkFreeze', () => {
  it('passes when we ship the latest upstream', () => {
    expect(check('0.167.0', [release('0.167.0', 1), release('0.166.0', 8)]).status).toBe('ok');
  });

  it('passes when upstream moved within the limit', () => {
    expect(check('0.166.0', [release('0.167.0', 2.9), release('0.166.0', 8)]).status).toBe('ok');
  });

  it('fails past the limit, and the clock starts at the oldest newer release', () => {
    const result = check('0.163.0', [release('0.167.0', 1), release('0.164.0', 15), release('0.163.0', 22)]);
    expect(result.status).toBe('frozen');
    expect(result.message).toContain('shipped 0.163.0, upstream 0.167.0');
    expect(result.message).toContain('0.164.0 came out 15.0 days ago');
  });

  it('compares versions as numbers, not strings', () => {
    expect(check('0.99.0', [release('0.100.0', 10)]).status).toBe('frozen');
    expect(check('0.100.0', [release('0.99.0', 10)]).status).toBe('ok');
  });

  it('ignores prereleases and non-release tags', () => {
    expect(check('0.167.0', [
      release('0.167.0', 9),
      release('0.168.0-alpha.1', 9),
      release('0.168.0', 9, true),
      { tagName: 'v9.9.9', publishedAt: daysAgo(9) },
    ]).status).toBe('ok');
  });

  it('cannot tell = not green', () => {
    expect(check('not-a-version', [release('0.167.0', 1)]).status).toBe('unknown');
    expect(check('0.163.0', []).status).toBe('unknown');
    expect(check('0.163.0', null).status).toBe('unknown');
    expect(check('0.163.0', [release('0.167.0', 1)], Number.NaN).status).toBe('unknown');
  });
});

describe('check-codex-freeze CLI', () => {
  const runCli = (releases: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-freeze-'));
    const file = path.join(dir, 'releases.json');
    if (releases !== null) fs.writeFileSync(file, releases);
    const r = childProcess.spawnSync(process.execPath, [
      script, '--shipped', '0.163.0', '--releases', file, '--max-lag-days', '3',
    ], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  it('exits 0 when nothing is newer', () => {
    const r = runCli(JSON.stringify([{ tagName: 'rust-v0.163.0', publishedAt: old }]));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('::error');
  });

  it('exits 1 with a workflow error when frozen', () => {
    const r = runCli(JSON.stringify([{ tagName: 'rust-v0.164.0', publishedAt: old }]));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=Codex freeze check::Codex runtime is frozen');
  });

  it('exits 2 when the release list is missing or broken', () => {
    expect(runCli(null).status).toBe(2);
    expect(runCli('not json').status).toBe(2);
  });
});

describe('Bump Codex Runtime workflow', () => {
  const yml = fs.readFileSync(path.join(root, '.github/workflows/bump-codex-runtime.yml'), 'utf8');
  const stepAt = yml.indexOf('- name: Fail if Codex is frozen behind upstream');

  it('runs the check last, on the no-change path too, with the plan limit of 3 days', () => {
    expect(stepAt).toBeGreaterThan(yml.indexOf('- name: Publish the pinned runtime'));
    const step = yml.slice(stepAt);
    expect(step).not.toMatch(/^\s+if:/m);
    expect(step).not.toContain('continue-on-error');
    expect(step).toContain("MAX_LAG_DAYS: '3'");
    expect(step).toContain('--repo openai/codex');
    expect(step).toContain('node scripts/check-codex-freeze.js');
    expect(step).toContain('set -euo pipefail');
  });

  it('measures what devices can get from the channel, not the pin in the repo', () => {
    const step = yml.slice(stepAt);
    expect(step).toContain('--pattern "$RUNTIME_MANIFEST"');
    expect(step).not.toContain('.ci-versions');
    expect(step).not.toContain('--shipped "$(tr');
  });

  it('takes Codex from Termux', () => {
    expect(yml).toContain('node scripts/codex-termux-apt.js bump');
  });
});
