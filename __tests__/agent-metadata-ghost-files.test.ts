/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// Ghost blank rows in the Sidebar AGENT list (observed on-device 2026-07-22):
// ~/.shelly/agents/ holds NON-agent top-level json files — dm-pairings.json
// (a JSON array mirror written by store/dm-pairing-store.ts) and potentially
// policy.json. Both load paths (readAgentMetadataViaShell / ...ViaFileSystem)
// glob *.json and validated chunks with isSafeAgentId(parsed.id), where a
// missing id (undefined) was string-coerced by RegExp.test to "undefined" —
// which MATCHES /^[A-Za-z0-9_-]+$/ — so any JSON.parse-able non-agent file
// became a store entry with no name and rendered as a blank agent row.
// Coverage: the isAgentMetadata shape guard rejects those files while real
// agent metadata still loads.

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
// Empty FileSystem mock: readAgentMetadataViaFileSystem falls back to the
// shell path, exactly like the existing loadAgentsFromDisk tests.
jest.mock('expo-file-system/legacy', () => ({}));

import { isAgentMetadata, isSafeAgentId, loadAgentsFromDisk } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

const AGENT_LIST_MARKER = '---SEPARATOR---';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-mrngjhhn',
    name: 'Perplexity STEAM collector',
    description: '',
    prompt: '最新のSTEAMニュースを集めて',
    schedule: null,
    tool: { type: 'gemini-api' },
    autonomous: false,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    ...overrides,
  } as Agent;
}

/** Real-world shapes of the non-agent json files that live in ~/.shelly/agents/. */
const DM_PAIRINGS_JSON = JSON.stringify([
  {
    id: 'pairing-1',
    label: 'LINE Keep memo',
    packageName: 'jp.naver.line.android',
    notificationId: 42,
    notificationTag: null,
    shortcutId: null,
    titleAtPairing: 'Keep',
    pairedAt: 1750000000000,
    lastConfirmedAt: null,
    revoked: false,
  },
]);
const POLICY_JSON = JSON.stringify({
  level: 'L2',
  secretPaths: ['.codex/auth.json'],
  policyPath: '.shelly/agents/policy.json',
  denyPatterns: [],
  allowPatterns: [],
});

function buildRunCommand(metadataChunks: string[]) {
  return jest.fn(async (command: string): Promise<string> => {
    if (command.startsWith('[ -f ')) return 'HALTED_NO'; // halt-sentinel check
    if (command.startsWith('d=')) {
      // readAgentMetadataViaShell — one chunk per *.json file in glob order.
      return metadataChunks.map((chunk) => `${chunk}\n${AGENT_LIST_MARKER}\n`).join('');
    }
    if (command.startsWith('for d in')) return ''; // readAgentRunLogs
    if (command.startsWith('cd ')) return ''; // cleanupOrphanAgentFiles
    return '';
  });
}

describe('isSafeAgentId — string coercion hole', () => {
  it('rejects a missing id instead of matching the coerced string "undefined"', () => {
    expect(isSafeAgentId(undefined)).toBe(false);
    expect(isSafeAgentId(null)).toBe(false);
    expect(isSafeAgentId(123)).toBe(false);
  });

  it('still accepts real generated ids', () => {
    expect(isSafeAgentId('agent-mrngjhhn')).toBe(true);
    expect(isSafeAgentId('agent-testsocial1')).toBe(true);
  });
});

describe('isAgentMetadata — shape guard for ~/.shelly/agents/*.json', () => {
  it('accepts a persisted Agent object', () => {
    expect(isAgentMetadata(makeAgent())).toBe(true);
  });

  it('rejects the dm-pairings.json array mirror', () => {
    expect(isAgentMetadata(JSON.parse(DM_PAIRINGS_JSON))).toBe(false);
  });

  it('rejects the policy.json object (no id)', () => {
    expect(isAgentMetadata(JSON.parse(POLICY_JSON))).toBe(false);
  });

  it('rejects empty objects, arrays, and JSON scalars', () => {
    expect(isAgentMetadata({})).toBe(false);
    expect(isAgentMetadata([])).toBe(false);
    expect(isAgentMetadata('agent-x')).toBe(false);
    expect(isAgentMetadata(42)).toBe(false);
    expect(isAgentMetadata(null)).toBe(false);
  });

  it('rejects an object with a valid id but missing name (would render blank)', () => {
    expect(isAgentMetadata({ id: 'agent-x', prompt: 'p' })).toBe(false);
  });
});

describe('loadAgentsFromDisk — ghost non-agent json files', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('drops dm-pairings.json / policy.json chunks and keeps only real agents', async () => {
    const agentA = makeAgent();
    const agentB = makeAgent({ id: 'agent-testsocial1', name: 'Social test' });
    const runCommand = buildRunCommand([
      DM_PAIRINGS_JSON, // would previously become a blank ghost row
      JSON.stringify(agentA),
      JSON.stringify(agentB),
      POLICY_JSON, // would previously become a second blank ghost row
    ]);

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });

    const agents = useAgentStore.getState().agents;
    expect(agents.map((a) => a.id)).toEqual(['agent-mrngjhhn', 'agent-testsocial1']);
    expect(agents.every((a) => typeof a.name === 'string' && a.name.length > 0)).toBe(true);
  });
});
