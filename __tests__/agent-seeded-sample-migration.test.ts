// One-time switch-off of the sample agents older builds seeded, run through the
// real loadAgentsFromDisk against an in-memory agents dir. The seed text is not
// part of this repo any more, so the samples here are stand-ins with a test
// fingerprint table under neutral ids; the shipped table is checked for shape
// only.

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    cancelAgent: jest.fn(async () => undefined),
    scheduleAgent: jest.fn(async () => undefined),
    execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runAgent: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

let mockTable: Record<string, string[]> = {};
jest.mock('@/lib/agent-seeded-sample-migration', () => {
  const actual = jest.requireActual('@/lib/agent-seeded-sample-migration');
  return {
    ...actual,
    migrateSeededSampleAgents: (agents: unknown[], deps: object) =>
      actual.migrateSeededSampleAgents(agents, { ...deps, table: mockTable }),
  };
});

import { DEFAULT_WORKSPACE_PROBE } from '@/lib/agent-default-workspace';
import { loadAgentsFromDisk, setAgentEnabled } from '@/lib/agent-manager';
import {
  SEEDED_SAMPLE_FINGERPRINTS,
  classifySeededSample,
  hasTurnedOffSeededSample,
  seededAgentIdHash,
  seededSampleFingerprint,
} from '@/lib/agent-seeded-sample-migration';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

const AGENTS_DIR = '/home/shelly-test/.shelly/agents';
const SEPARATOR = '---SEPARATOR---';
const SEED_IDS = ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5', 'sample-6', 'sample-7'];
const SCHEDULED_ID = 'sample-1';
const MANUAL_ID = 'sample-2';

const cancelAgent = TerminalEmulator.cancelAgent as unknown as jest.Mock;
const scheduleAgent = TerminalEmulator.scheduleAgent as unknown as jest.Mock;

/** Shape the seed wrote (Kotlin agentJson). */
function sample(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Stand-in ${id}`,
    description: `Stand-in description of ${id}`,
    prompt: `Stand-in prompt of ${id}\nsecond line`,
    schedule: id === MANUAL_ID ? null : '0 8 * * *',
    tool: { type: 'local', model: 'stand-in-model' },
    outputPath: `/data/user/0/dev.shelly.terminal/files/home/projects/shelly-content-studio/out/${id}`,
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 5,
    ...overrides,
  } as Agent;
}

class Disk {
  files = new Map<string, string>();
  writes: string[] = [];
  failWritesTo: string | null = null;

  put(agent: Agent): void {
    this.files.set(`${AGENTS_DIR}/${agent.id}.json`, `${JSON.stringify(agent, null, 2)}\n`);
  }
  raw(id: string): string {
    return this.files.get(`${AGENTS_DIR}/${id}.json`) as string;
  }
  read(id: string): Agent {
    return JSON.parse(this.raw(id)) as Agent;
  }

  run = async (command: string): Promise<string> => {
    if (command === DEFAULT_WORKSPACE_PROBE) return '';
    if (command.startsWith('[ -f ')) return 'HALTED_NO';
    if (command.startsWith('d=')) {
      return [...this.files.values()].map((content) => `${content}\n${SEPARATOR}\n`).join('');
    }
    const cat = command.match(/^cat '([^']+)' 2>\/dev\/null \|\| true$/);
    if (cat) return this.files.get(cat[1]) ?? '';
    const write = command.match(/^set -e\n[\s\S]*?<<'(\w+)'[\s\S]*?mv -f '[^']+' '([^']+)'\n([\s\S]*)\n\1$/);
    if (write) {
      if (write[2] === this.failWritesTo) throw new Error('disk full');
      this.files.set(write[2], write[3]);
      this.writes.push(write[2]);
    }
    return '';
  };
}

const load = (disk: Disk) => loadAgentsFromDisk(disk.run, { syncLogs: false, repairSchedules: false });

function tableFor(agents: Agent[]): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const id of SEED_IDS) table[seededAgentIdHash(id)] = [];
  for (const agent of agents) {
    table[seededAgentIdHash(agent.id)].push(seededSampleFingerprint(agent) as string);
  }
  return table;
}

function allSamplesOnDisk(): Disk {
  const disk = new Disk();
  const agents = SEED_IDS.map((id) => sample(id));
  agents.forEach((agent) => disk.put(agent));
  mockTable = tableFor(agents);
  return disk;
}

function storeAgent(id: string): Agent | undefined {
  return useAgentStore.getState().agents.find((agent) => agent.id === id);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  useAgentStore.setState({ agents: [], halted: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('migration', () => {
  it('turns off every unchanged sample, keeps it on disk and cancels through the normal path', async () => {
    const disk = allSamplesOnDisk();
    await load(disk);

    for (const id of SEED_IDS) {
      expect(disk.read(id)).toEqual({ ...sample(id), enabled: false, seedMigration: 'turned-off' });
      expect(storeAgent(id)?.enabled).toBe(false);
      expect(cancelAgent).toHaveBeenCalledWith(id);
    }
    expect(disk.files.size).toBe(SEED_IDS.length);
    expect(hasTurnedOffSeededSample(useAgentStore.getState().agents)).toBe(true);
  });

  it('runs once: a second launch writes nothing and cancels nothing', async () => {
    const disk = allSamplesOnDisk();
    await load(disk);
    const before = new Map(disk.files);
    disk.writes = [];
    cancelAgent.mockClear();

    await load(disk);

    expect(disk.writes).toEqual([]);
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(disk.files).toEqual(before);
  });

  it('respects a user who turns one back on', async () => {
    const disk = allSamplesOnDisk();
    await load(disk);

    await setAgentEnabled(SCHEDULED_ID, true, disk.run);
    expect(disk.read(SCHEDULED_ID).enabled).toBe(true);
    expect(disk.read(SCHEDULED_ID).seedMigration).toBe('turned-off');

    cancelAgent.mockClear();
    await load(disk);

    expect(disk.read(SCHEDULED_ID).enabled).toBe(true);
    expect(storeAgent(SCHEDULED_ID)?.enabled).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  it('marks a sample the user had already paused, so turning it on later sticks, with no notice', async () => {
    const disk = new Disk();
    const paused = sample(SCHEDULED_ID, { enabled: false });
    disk.put(paused);
    mockTable = tableFor([paused]);

    await load(disk);

    expect(disk.read(SCHEDULED_ID).seedMigration).toBe('left-off');
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(hasTurnedOffSeededSample(useAgentStore.getState().agents)).toBe(false);

    await setAgentEnabled(SCHEDULED_ID, true, disk.run);
    await load(disk);
    expect(disk.read(SCHEDULED_ID).enabled).toBe(true);
  });

  it('does not re-arm a sample in startup repair', async () => {
    const disk = allSamplesOnDisk();
    await loadAgentsFromDisk(disk.run, { syncLogs: false, repairSchedules: true, repairDelayMs: 0, shouldRepair: () => true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduleAgent).not.toHaveBeenCalled();
  });
});

describe('agents that are left alone', () => {
  // Every edit keeps version 5 and createdAt 0: no edit path changes them.
  it.each<[string, Partial<Agent>]>([
    ['prompt', { prompt: 'My own prompt' }],
    ['name', { name: 'My agent' }],
    ['description', { description: 'Mine' }],
    ['schedule', { schedule: '0 9 * * *' }],
    ['tool', { tool: { type: 'local', model: 'another-model' } }],
    ['output path', { outputPath: '/sdcard/Documents/mine' }],
    ['action', { action: { type: 'notify' } as Agent['action'] }],
    ['orchestration', { orchestration: { steps: [] } as unknown as Agent['orchestration'] }],
    ['autonomy', { autonomous: true, autonomyLevel: 'L2' }],
    ['memory', { memory: { remember: true } as unknown as Agent['memory'] }],
  ])('an edited %s', async (_label, edit) => {
    const disk = new Disk();
    const edited = sample(SCHEDULED_ID, edit);
    disk.put(edited);
    mockTable = tableFor([sample(SCHEDULED_ID)]);
    const bytes = disk.raw(SCHEDULED_ID);

    await load(disk);

    expect(disk.raw(SCHEDULED_ID)).toBe(bytes);
    expect(disk.writes).toEqual([]);
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(storeAgent(SCHEDULED_ID)?.enabled).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`cannot tell it is the sample: ${SCHEDULED_ID}`), '');
  });

  it('a seed id with no version or marker fields but a different definition', () => {
    mockTable = tableFor([sample(SCHEDULED_ID)]);
    const { version: _version, createdAt: _createdAt, ...rest } = sample(SCHEDULED_ID, { prompt: 'x' });
    expect(classifySeededSample(rest as Agent, mockTable)).toBe('unsure');
  });

  it('the seed definition under an id outside the seed list', async () => {
    const disk = new Disk();
    disk.put({ ...sample(SCHEDULED_ID), id: 'agent-mx1abc' });
    mockTable = tableFor([sample(SCHEDULED_ID)]);

    await load(disk);

    expect(disk.writes).toEqual([]);
    expect(disk.read('agent-mx1abc').enabled).toBe(true);
  });
});

describe('article agents registered from a plan', () => {
  const PLAN_NAMES = [
    'Stream A',
    'Stream B',
    'Stream C',
    'Stream D',
    'Stream E',
    'Stream digest',
  ];

  function planAgent(name: string, index: number): Agent {
    return {
      id: `agent-mx${index}plan`,
      name,
      description: name,
      prompt: `${name} の下書きを作る`,
      schedule: `${index * 20} 6 * * *`,
      tool: { type: 'cerebras-api' },
      outputPath: `/sdcard/Documents/Vault/Drafts/Stream${index}`,
      outputTemplate: null,
      action: { type: 'draft' },
      orchestration: {
        longform: true,
        steps: [
          { id: 'research', tool: { type: 'gemini-api' }, prompt: 'research' },
          { id: 'write', tool: { type: 'cerebras-api' }, prompt: 'write' },
          { id: 'assemble', local: { kind: 'assemble' } },
        ],
      },
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 1_793_000_000_000 + index,
      version: 1,
    } as unknown as Agent;
  }

  it('never touches them, next to samples that are turned off', async () => {
    const disk = allSamplesOnDisk();
    const plans = PLAN_NAMES.map(planAgent);
    plans.forEach((agent) => disk.put(agent));
    const bytes = plans.map((agent) => disk.raw(agent.id));

    await load(disk);
    await load(disk);

    plans.forEach((agent, index) => {
      expect(disk.raw(agent.id)).toBe(bytes[index]);
      expect(disk.read(agent.id).orchestration?.longform).toBe(true);
      expect(storeAgent(agent.id)?.enabled).toBe(true);
      expect(cancelAgent).not.toHaveBeenCalledWith(agent.id);
      expect(classifySeededSample(agent)).toBe('other');
    });
    expect(SEED_IDS.every((id) => disk.read(id).enabled === false)).toBe(true);
  });

  it('leaves a longform agent alone even under a seed id', () => {
    mockTable = tableFor([sample(SCHEDULED_ID)]);
    const longform = sample(SCHEDULED_ID, { orchestration: planAgent('Stream B', 1).orchestration });
    expect(classifySeededSample(longform, mockTable)).toBe('unsure');
  });
});

describe('failures', () => {
  it('skips bad JSON without crashing loading, and still handles the rest', async () => {
    const disk = allSamplesOnDisk();
    disk.files.set(`${AGENTS_DIR}/broken.json`, '{ not json');
    disk.files.set(`${AGENTS_DIR}/${MANUAL_ID}.json`, `{"id":"${MANUAL_ID}",`);

    await expect(load(disk)).resolves.toBeUndefined();

    expect(disk.raw(MANUAL_ID)).toBe(`{"id":"${MANUAL_ID}",`);
    expect(disk.read(SCHEDULED_ID).enabled).toBe(false);
    expect(useAgentStore.getState().agents).toHaveLength(SEED_IDS.length - 1);
  });

  it('leaves an agent whose file went bad after it was listed', async () => {
    const disk = new Disk();
    const agent = sample(SCHEDULED_ID);
    disk.put(agent);
    mockTable = tableFor([agent]);
    const run = disk.run;
    disk.run = async (command) => (command.startsWith('cat ') ? '{ truncated' : run(command));

    await expect(load(disk)).resolves.toBeUndefined();

    expect(disk.writes).toEqual([]);
    expect(storeAgent(SCHEDULED_ID)?.enabled).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  it('leaves an agent the user edited after it was listed', async () => {
    const disk = new Disk();
    const agent = sample(SCHEDULED_ID);
    disk.put(agent);
    mockTable = tableFor([agent]);
    const run = disk.run;
    disk.run = async (command) => {
      if (command.startsWith('cat ')) disk.put({ ...agent, prompt: 'Edited just now' });
      return run(command);
    };

    await load(disk);

    expect(disk.writes).toEqual([]);
    expect(disk.read(SCHEDULED_ID).enabled).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  it('a failed alarm cancel does not lose the disable', async () => {
    const disk = allSamplesOnDisk();
    cancelAgent.mockRejectedValue(new Error('binder died'));

    await expect(load(disk)).resolves.toBeUndefined();

    for (const id of SEED_IDS) {
      expect(disk.read(id).enabled).toBe(false);
      expect(disk.read(id).seedMigration).toBe('turned-off');
      expect(storeAgent(id)?.enabled).toBe(false);
    }
    expect(useAgentStore.getState().agents).toHaveLength(SEED_IDS.length);
  });

  it('a failed write leaves the agent as it was, skips the cancel and retries next launch', async () => {
    const disk = new Disk();
    const agent = sample(SCHEDULED_ID);
    disk.put(agent);
    mockTable = tableFor([agent]);
    disk.failWritesTo = `${AGENTS_DIR}/${SCHEDULED_ID}.json`;

    await expect(load(disk)).resolves.toBeUndefined();

    expect(disk.read(SCHEDULED_ID).enabled).toBe(true);
    expect(disk.read(SCHEDULED_ID).seedMigration).toBeUndefined();
    expect(storeAgent(SCHEDULED_ID)?.enabled).toBe(true);
    expect(cancelAgent).not.toHaveBeenCalled();

    disk.failWritesTo = null;
    await load(disk);

    expect(disk.read(SCHEDULED_ID).enabled).toBe(false);
    expect(cancelAgent).toHaveBeenCalledWith(SCHEDULED_ID);
  });
});

describe('fingerprints', () => {
  it('hold seven ids and 22 variants, as hashes only', () => {
    const entries = Object.entries(SEEDED_SAMPLE_FINGERPRINTS);
    expect(entries).toHaveLength(7);
    expect(entries.flatMap(([, hashes]) => hashes)).toHaveLength(22);
    for (const [idHash, hashes] of entries) {
      expect(idHash).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes.length).toBeGreaterThan(0);
      for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('treat an id whose hash is not listed as not a sample', () => {
    expect(classifySeededSample(sample('agent-mx1abc'))).toBe('other');
  });

  it('do not depend on the home path alias', () => {
    const agent = sample(SCHEDULED_ID);
    const alias = sample(SCHEDULED_ID, {
      outputPath: agent.outputPath.replace('/data/user/0/', '/data/data/'),
    });
    expect(seededSampleFingerprint(alias)).toBe(seededSampleFingerprint(agent));
  });

  it('do not depend on run state', () => {
    const agent = sample(SCHEDULED_ID);
    const ran = sample(SCHEDULED_ID, { lastRun: 5, lastResult: 'success', enabled: false, version: 3, createdAt: 9 });
    expect(seededSampleFingerprint(ran)).toBe(seededSampleFingerprint(agent));
  });
});

describe('notice text', () => {
  it('exists in both languages', () => {
    expect((en as Record<string, string>)['chat.seeded_agents_turned_off']).toBeTruthy();
    expect((ja as Record<string, string>)['chat.seeded_agents_turned_off']).toBeTruthy();
  });
});
