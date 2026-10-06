/**
 * __tests__/shelly-helper-shim-workflow.test.ts
 *
 * Behavioral test for the generated `$HOME/bin/shelly` helper's node body
 * (HomeInitializer.kt, SHELLY_HELPER_SHIM v5): the `sb.appendLine("...")`
 * literals are extracted from the real .kt source, Kotlin-unescaped, and
 * the resulting script is run with this Node against a temp $HOME. Covers
 * `shelly workflow list|show|__prepare-run|__prepare-delete|delete` and the
 * `teach` usage path. The shelly() bash function half (run / y/N prompt)
 * needs a real bash and is covered by on-device QA instead.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ktPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);

/** Kotlin string literal -> generated text (only the escapes the file uses). */
function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    if (ch === '$' && /[A-Za-z{]/.test(lit[i + 1] ?? '')) {
      throw new Error(`unescaped Kotlin template in generated shim: ${lit}`);
    }
    out += ch;
  }
  return out;
}

function extractShimJs(): string {
  const lines = fs.readFileSync(ktPath, 'utf8').split(/\r?\n/);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === "const fs = require('fs');") on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === 'SHELLY_HELPER_NODE') break;
    body.push(text);
  }
  return body.join('\n') + '\n';
}

let tmp: string;
let shimPath: string;
let home: string;

function shelly(...args: string[]) {
  const r = spawnSync(process.execPath, [shimPath, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function writeWorkflow(name: string, description: string, commands: string[]) {
  const dir = path.join(home, '.shelly', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  // Same layout lib/workflow-manager.ts's saveWorkflow() writes.
  fs.writeFileSync(
    path.join(dir, `${name}.sh`),
    ['#!/bin/bash', `# Shelly Workflow: ${name}`, `# ${description}`, '# Created: 2026-10-06T00:00:00.000Z', '', ...commands].join('\n'),
  );
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-shim-'));
  shimPath = path.join(tmp, 'shim.js');
  fs.writeFileSync(shimPath, extractShimJs());
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmp, 'home-'));
});

describe('generated shelly helper shim', () => {
  it('is bumped to v5 alongside BASHRC_VERSION 243', () => {
    const src = fs.readFileSync(ktPath, 'utf8');
    expect(src).toContain('# SHELLY_HELPER_SHIM v5');
    expect(src).toMatch(/private const val BASHRC_VERSION = 243\b/);
  });

  it('parses as valid JavaScript', () => {
    const r = spawnSync(process.execPath, ['--check', shimPath], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('top-level usage lists workflow and teach', () => {
    const r = shelly();
    expect(r.code).toBe(0);
    expect(r.out).toContain('shelly workflow');
    expect(r.out).toContain('shelly teach');
  });

  it('workflow list handles an empty / missing directory', () => {
    const r = shelly('workflow', 'list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('No workflows saved yet');
  });

  it('workflow list shows names, step counts and descriptions', () => {
    writeWorkflow('deploy', 'Build and push', ['cd ~/app', 'make', 'git push']);
    writeWorkflow('backup', 'Nightly backup', ['tar czf b.tgz src']);
    const r = shelly('workflow', 'list');
    expect(r.code).toBe(0);
    const rows = r.out.split('\n').filter((l) => /^(deploy|backup)\s/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^backup\s+1\s+Nightly backup$/);
    expect(rows[1]).toMatch(/^deploy\s+3\s+Build and push$/);
  });

  it('workflow show prints the script', () => {
    writeWorkflow('deploy', 'Build', ['make']);
    const r = shelly('workflow', 'show', 'deploy');
    expect(r.code).toBe(0);
    expect(r.out).toContain('# Shelly Workflow: deploy');
    expect(r.out).toContain('make');
  });

  it('__prepare-run prints numbered steps and succeeds for an existing workflow', () => {
    writeWorkflow('deploy', 'Build', ['cd ~/app', 'make "$1"']);
    const r = shelly('workflow', '__prepare-run', 'deploy');
    expect(r.code).toBe(0);
    expect(r.out).toContain(' 1. cd ~/app');
    expect(r.out).toContain(' 2. make "$1"');
  });

  it.each(['../evil', '..', '.hidden', 'a/b', 'x;rm -rf ~', '$(id)', ''])(
    'rejects unsafe workflow name %p before touching the filesystem',
    (name) => {
      // A file the traversal would hit if names were not validated.
      fs.writeFileSync(path.join(home, 'evil.sh'), 'echo pwned');
      for (const sub of ['show', '__prepare-run', '__prepare-delete', 'delete']) {
        const r = shelly('workflow', sub, name, '--yes');
        expect(r.code).not.toBe(0);
        expect(r.out).not.toContain('pwned');
      }
      expect(fs.existsSync(path.join(home, 'evil.sh'))).toBe(true);
    },
  );

  it('unknown workflow names fail cleanly', () => {
    expect(shelly('workflow', '__prepare-run', 'nope').code).toBe(1);
    expect(shelly('workflow', '__prepare-delete', 'nope').code).toBe(1);
  });

  it('delete requires --yes (the shelly() bash function adds it after the y/N prompt)', () => {
    writeWorkflow('deploy', 'Build', ['make']);
    const file = path.join(home, '.shelly', 'workflows', 'deploy.sh');
    expect(shelly('workflow', 'delete', 'deploy').code).toBe(2);
    expect(fs.existsSync(file)).toBe(true);
    const r = shelly('workflow', 'delete', 'deploy', '--yes');
    expect(r.code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('bare `workflow run` (bypassing the bash function) refuses and prints the direct command', () => {
    writeWorkflow('deploy', 'Build', ['make']);
    const r = shelly('workflow', 'run', 'deploy');
    expect(r.code).toBe(2);
    expect(r.out).toContain('bash ');
  });

  it('teach without an action prints usage without queueing anything', () => {
    const r = shelly('teach');
    expect(r.code).toBe(0);
    expect(r.out).toContain('shelly teach <start [name]|stop|cancel|status>');
    expect(fs.existsSync(path.join(home, '.shelly-command-queue'))).toBe(false);
  });
});
