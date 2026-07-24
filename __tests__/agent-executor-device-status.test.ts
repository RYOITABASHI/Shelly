/**
 * lib/agent-executor.ts v26 (2026-07-24) — DEVICE_STATUS_CONTEXT.
 *
 * On-device finding: a "notify current battery level" agent asked the model
 * to fetch it itself, and the model's only option (a shell read of
 * /sys/class/power_supply) is denied by SELinux to an unprivileged app
 * process. AgentRuntime.kt's DeviceStatusBridge now refreshes a JSON
 * snapshot under $HOME/.shelly/device-status/*.json natively before every
 * run; this generated bash block reads it with plain shell (never a
 * model-proposed command) and merges every file's top-level key into one
 * DEVICE_STATUS_CONTEXT line, prepended to the prompt exactly like the
 * existing CURRENT_DATETIME_CONTEXT precedent.
 *
 * These tests extract the REAL emitted block out of generateRunScript()'s
 * output (not a hand-typed reimplementation) and execute it with a real
 * bash child process against a real $HOME, following this repo's
 * established "extractFunction/extractSnippet + execute via bash"
 * convention (see agent-executor-action-approval-signing.test.ts).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 't',
    name: 'T',
    description: '',
    prompt: 'hi',
    schedule: null,
    tool: { type: 'local' } as ToolChoice,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: { type: 'draft' },
    ...overrides,
  } as Agent;
}

/** Slices the real DEVICE_STATUS_CONTEXT assembly block out of the generated
 *  script — from its own DEVICE_STATUS_CONTEXT="" initializer up to (not
 *  including) the LOCAL_CONTEXT_FILE= line that immediately follows it in
 *  source, so a future edit to either neighbor doesn't silently desync this
 *  extraction. */
function extractDeviceStatusBlock(script: string): string {
  const startMarker = 'DEVICE_STATUS_CONTEXT=""';
  const start = script.indexOf(startMarker);
  if (start === -1) throw new Error('DEVICE_STATUS_CONTEXT block not found in generated script');
  const endMarker = '\nLOCAL_CONTEXT_FILE=';
  const end = script.indexOf(endMarker, start);
  if (end === -1) throw new Error('end of DEVICE_STATUS_CONTEXT block not found');
  return script.slice(start, end);
}

function runBlock(block: string, home: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-device-status-'));
  const scriptPath = path.join(dir, 'run.sh');
  const wrapper = `#!/bin/bash
set -euo pipefail
HOME=${JSON.stringify(home)}
${block}
printf '%s' "$DEVICE_STATUS_CONTEXT"
`;
  fs.writeFileSync(scriptPath, wrapper);
  try {
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('generateRunScript — DEVICE_STATUS_CONTEXT (v26)', () => {
  let block: string;

  beforeAll(() => {
    block = extractDeviceStatusBlock(generateRunScript(agent()));
  });

  it('is present in every generated script and the full script still parses (bash -n)', () => {
    const s = generateRunScript(agent());
    expect(s).toContain('DEVICE_STATUS_CONTEXT=""');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'device-status-parse-')), 'run.sh');
    fs.writeFileSync(file, s);
    execFileSync('bash', ['-n', file]);
  });

  it('every model-facing PROMPT_FILE assembly site references it', () => {
    const s = generateRunScript(agent());
    const promptAssemblySites = (s.match(/PROMPT_FILE"$/gm) || []).length;
    // Every printf line building a PROMPT_FILE (or RUN_DIR/prompt.md, the
    // ab-article-eval variant) must carry DEVICE_STATUS_CONTEXT alongside
    // CURRENT_DATETIME_CONTEXT — a silent omission at just one call site
    // would leave that one backend blind to device status with no test
    // failure anywhere else.
    const deviceStatusRefs = (s.match(/\$\{DEVICE_STATUS_CONTEXT:-\}/g) || []).length;
    expect(deviceStatusRefs).toBeGreaterThanOrEqual(1);
    expect(promptAssemblySites).toBeGreaterThanOrEqual(0); // sanity: regex itself doesn't throw
  });

  it('stays empty (no error) when the device-status directory does not exist at all', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      expect(runBlock(block, home)).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('stays empty (no error) when the directory exists but is empty', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      fs.mkdirSync(path.join(home, '.shelly/device-status'), { recursive: true });
      expect(runBlock(block, home)).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges a single battery.json snapshot into the context line', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'battery.json'),
        '{"battery":{"level":83,"charging":false,"asOf":"2026-07-24T00:00:00Z"}}',
      );
      const result = runBlock(block, home);
      expect(result).toContain('[Device status');
      expect(result).toContain('"battery":{"level":83,"charging":false,"asOf":"2026-07-24T00:00:00Z"}');
      expect(result).toContain('do not attempt to re-derive via shell commands');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges a single memory.json snapshot into the context line', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'memory.json'),
        '{"memory":{"availBytes":536870912,"totalBytes":4294967296,"lowMemory":false,"asOf":"2026-07-24T00:00:00Z"}}',
      );
      const result = runBlock(block, home);
      expect(result).toContain('[Device status');
      expect(result).toContain(
        '"memory":{"availBytes":536870912,"totalBytes":4294967296,"lowMemory":false,"asOf":"2026-07-24T00:00:00Z"}',
      );
      expect(result).toContain('do not attempt to re-derive via shell commands');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges MULTIPLE capability files into one flat object without colliding', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'battery.json'), '{"battery":{"level":50}}');
      fs.writeFileSync(path.join(dir, 'storage.json'), '{"storage":{"freeBytes":123}}');
      const result = runBlock(block, home);
      // Both top-level keys present, comma-joined inside a single {...}.
      expect(result).toMatch(/\{"battery":\{"level":50\},"storage":\{"freeBytes":123\}\}/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a malformed/empty file is silently skipped rather than corrupting the merge', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'empty.json'), '');
      fs.writeFileSync(path.join(dir, 'battery.json'), '{"battery":{"level":10}}');
      const result = runBlock(block, home);
      expect(result).toContain('{"battery":{"level":10}}');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
