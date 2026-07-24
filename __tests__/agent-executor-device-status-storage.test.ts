/**
 * lib/agent-executor.ts v27 (2026-07-24) — storage capability added to
 * DEVICE_STATUS_CONTEXT.
 *
 * DeviceStatusBridge.kt now also writes storage.json
 * ({"storage":{"freeBytes":…,"totalBytes":…,"asOf":"…"}}, via
 * android.os.StatFs on context.filesDir) alongside the existing
 * battery.json. The DEVICE_STATUS_CONTEXT bash reader itself needs no
 * changes for this (it already merges every *.json file under
 * $HOME/.shelly/device-status/ generically — see
 * agent-executor-device-status.test.ts's "merges MULTIPLE capability
 * files" test, which already covers this with a synthetic storage shape).
 * This file mirrors that same extraction/execution technique but exercises
 * the REAL storage.json shape (including totalBytes and asOf) written by
 * DeviceStatusBridge.writeStorageSnapshot, alongside a real battery.json.
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

/** Same slice as agent-executor-device-status.test.ts's extractDeviceStatusBlock
 *  — kept independent here so this file has no import-time coupling to that
 *  test file's internals. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-device-status-storage-'));
  const scriptPath = path.join(dir, 'run.sh');
  // v29 (2026-07-24): the extracted block is now gated on
  // `${DEVICE_STATUS_RELEVANT:-0}` (see lib/agent-executor.ts's
  // agentNeedsDeviceStatusContext) — this test is about the MERGE logic
  // specifically, not the gate itself, so force the flag on here.
  const wrapper = `#!/bin/bash
set -euo pipefail
HOME=${JSON.stringify(home)}
DEVICE_STATUS_RELEVANT=1
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

describe('generateRunScript — DEVICE_STATUS_CONTEXT merges real storage.json (v27)', () => {
  let block: string;

  beforeAll(() => {
    block = extractDeviceStatusBlock(generateRunScript(agent()));
  });

  it('merges a real storage.json shape alongside a real battery.json shape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      // Exact shape written by DeviceStatusBridge.writeBatterySnapshot.
      fs.writeFileSync(
        path.join(dir, 'battery.json'),
        '{"battery":{"level":83,"charging":false,"asOf":"2026-07-24T00:00:00Z"}}',
      );
      // Exact shape written by DeviceStatusBridge.writeStorageSnapshot.
      fs.writeFileSync(
        path.join(dir, 'storage.json'),
        '{"storage":{"freeBytes":4823400000,"totalBytes":128000000000,"asOf":"2026-07-24T00:00:00Z"}}',
      );
      const result = runBlock(block, home);
      expect(result).toContain('[Device status');
      expect(result).toContain('do not attempt to re-derive via shell commands');
      expect(result).toContain('"battery":{"level":83,"charging":false,"asOf":"2026-07-24T00:00:00Z"}');
      expect(result).toContain('"storage":{"freeBytes":4823400000,"totalBytes":128000000000,"asOf":"2026-07-24T00:00:00Z"}');
      // Both top-level keys present, comma-joined inside a single {...}, no collision.
      expect(result).toMatch(/\{"battery":\{[^}]*\},"storage":\{[^}]*\}\}/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges a real storage.json shape alone (no battery.json present)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-home-'));
    try {
      const dir = path.join(home, '.shelly/device-status');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'storage.json'),
        '{"storage":{"freeBytes":0,"totalBytes":128000000000,"asOf":"2026-07-24T00:00:00Z"}}',
      );
      const result = runBlock(block, home);
      expect(result).toContain('"storage":{"freeBytes":0,"totalBytes":128000000000,"asOf":"2026-07-24T00:00:00Z"}');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
