/* eslint-disable import/first -- Jest mocks must be registered before imports. */
// G2 follow-up: scheduled (alarm-fired) runs finish with no TS runtime alive, so
// captureRunMemory (the foreground/runAgentNow hook) never sees them. Coverage
// for the fix: loadAgentsFromDisk's app-launch log sync now captures the latest
// success digest for every remember-enabled agent via
// captureRunMemoryFromSyncedLogs (fire-and-forget, after setAgents/setRunHistory).

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
jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
}));
jest.mock('@/lib/unattended-skill-save', () => {
  const actual = jest.requireActual('@/lib/unattended-skill-save');
  return {
    ...actual,
    saveUnattendedSkillWithNotification: jest.fn(actual.saveUnattendedSkillWithNotification),
  };
});
// Empty FileSystem mock: readAgentMetadataViaFileSystem/readMemoryNotes both
// call into it and their try/catch falls back to the shell path / empty list,
// exactly like the existing loadAgentsFromDisk tests in this suite.
jest.mock('expo-file-system/legacy', () => ({}));

import { loadAgentsFromDisk, syncAgentRunLogsFromDisk } from '@/lib/agent-manager';
import { LOCAL_FALLBACK_DIGEST_MARKER } from '@/lib/agent-escalation-ladder';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, AgentRunLog } from '@/store/types';
import * as Notifications from 'expo-notifications';
import { saveUnattendedSkillWithNotification } from '@/lib/unattended-skill-save';

const AGENT_LIST_MARKER = '---SEPARATOR---';
const LOG_MARKER = '---SHELLY_AGENT_LOG---';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'sched-agent',
    name: 'Scheduled agent',
    description: '',
    prompt: '最新ニュースを集めて',
    schedule: '0 8 * * *',
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
  };
}

function makeRunLog(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  return {
    agentId: 'sched-agent',
    timestamp: Date.now(),
    status: 'success',
    outputPreview: 'Top headline: local news roundup for today.',
    durationMs: 1000,
    toolUsed: 'gemini-api',
    ...overrides,
  };
}

/** Builds a runCommand mock that serves loadAgentsFromDisk's fixed sequence of
 * shell probes, plus records any write that looks like a memory-note write. */
function buildRunCommand(opts: {
  agent: Agent | null;
  log: AgentRunLog | null;
}) {
  const memoryWrites: string[] = [];
  const skillWrites: string[] = [];
  const writeSeen = deferredFlag();
  const runCommand = jest.fn(async (command: string): Promise<string> => {
    if (command.startsWith('[ -f ')) return 'HALTED_NO'; // halt-sentinel check
    if (command.startsWith('d=')) {
      // readAgentMetadataViaShell
      return opts.agent ? `${JSON.stringify(opts.agent)}\n${AGENT_LIST_MARKER}\n` : '';
    }
    if (command.startsWith('for d in')) {
      // readAgentRunLogs
      return opts.log ? `${JSON.stringify(opts.log)}\n${LOG_MARKER}\n` : '';
    }
    if (command.startsWith('cd ')) return ''; // cleanupOrphanAgentFiles
    if (command.includes('.shelly/agents/memory/')) {
      memoryWrites.push(command);
      writeSeen.resolve();
      return '';
    }
    if (command.includes('.shelly/agents/skills/')) {
      skillWrites.push(command);
      return '';
    }
    return '';
  });
  return { runCommand, memoryWrites, skillWrites, writeSeen: writeSeen.promise };
}

function deferredFlag(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Give the fire-and-forget captureRunMemoryFromSyncedLogs a chance to run,
 * without hanging forever when no write is expected. */
async function settleMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('loadAgentsFromDisk — scheduled-run memory capture (G2 follow-up)', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('captures the latest success digest for a remember-enabled agent after a log sync', async () => {
    const agent = makeAgent({ memory: { remember: true, tags: ['news'] } });
    const log = makeRunLog();
    const { runCommand, memoryWrites, writeSeen } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await Promise.race([writeSeen, settleMicrotasks(10)]);

    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(memoryWrites[0]).toContain('local news roundup');
  });

  it('auto-saves a newly synced successful unattended run and posts a deletable notification', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog();
    const { runCommand, skillWrites, writeSeen } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await Promise.race([writeSeen, settleMicrotasks(10)]);
    await settleMicrotasks(20);

    expect(skillWrites).toHaveLength(1);
    expect(skillWrites[0]).toContain('Scheduled agent');
    expect(saveUnattendedSkillWithNotification).toHaveBeenCalledWith(
      runCommand,
      expect.objectContaining({ status: 'success', unattended: true }),
      expect.any(Object),
    );
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      'skill-saved',
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'delete-saved-skill',
          options: { opensAppToForeground: true },
        }),
      ]),
    );
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('does not write memory for an agent that has not opted into remember', async () => {
    const agent = makeAgent({ memory: undefined });
    const log = makeRunLog();
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });

  // Regression test for the on-device QA bug this fix addresses: a real
  // successful, secret-free, correctly schedule-configured unattended run
  // never triggered a skill auto-save. Root cause was that the skill-save
  // call lived downstream of memory-only gates (agent.memory?.remember,
  // a non-empty digest, and the memory-note dedup check) that have nothing
  // to do with skill-save eligibility. Skill-save must fire on its own even
  // when the agent never opted into memory.remember at all.
  it('auto-saves a successful scheduled run even when the agent has not opted into memory.remember', async () => {
    const agent = makeAgent({ memory: undefined });
    const log = makeRunLog();
    const { runCommand, memoryWrites, skillWrites, writeSeen } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await Promise.race([writeSeen, settleMicrotasks(10)]);
    await settleMicrotasks(20);

    expect(memoryWrites).toHaveLength(0);
    expect(skillWrites).toHaveLength(1);
    expect(saveUnattendedSkillWithNotification).toHaveBeenCalledWith(
      runCommand,
      expect.objectContaining({ status: 'success', unattended: true }),
      expect.any(Object),
    );
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  // Second regression case for the same bug: a run whose ENTIRE outputPreview
  // is a fenced code block collapses to an empty digest (extractRunDigest
  // strips ``` fences before collapsing whitespace), which used to `continue`
  // past the skill-save call even for a remember-enabled agent. Skill-save
  // doesn't need a digest at all (the recipe is built from the agent's
  // prompt/name/route, never from outputPreview), so it must still fire.
  it('auto-saves a successful scheduled run whose output has no extractable memory digest', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog({ outputPreview: '```\nfully fenced output, nothing left after stripping\n```' });
    const { runCommand, memoryWrites, skillWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(20);

    expect(memoryWrites).toHaveLength(0);
    expect(skillWrites).toHaveLength(1);
    expect(saveUnattendedSkillWithNotification).toHaveBeenCalledWith(
      runCommand,
      expect.objectContaining({ status: 'success', unattended: true }),
      expect.any(Object),
    );
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('does not write memory when the latest run was not a success', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog({ status: 'error', outputPreview: 'boom' });
    const { runCommand, memoryWrites, skillWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
    expect(skillWrites).toHaveLength(0);
    expect(saveUnattendedSkillWithNotification).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('does not double-fire the synced hook for an attended manual @agent run', async () => {
    const agent = makeAgent({
      schedule: null,
      memory: { remember: true },
    });
    const log = makeRunLog();
    const { runCommand, memoryWrites, skillWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(20);

    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(skillWrites).toHaveLength(0);
    expect(saveUnattendedSkillWithNotification).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('never captures a local-context-fallback digest, even one logged by an older script version (defense in depth)', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const log = makeRunLog({
      status: 'success',
      outputPreview: `${LOCAL_FALLBACK_DIGEST_MARKER}\nran on-device without cloud access`,
    });
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });

  it('does nothing when there is no run history for the agent yet', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log: null });

    await loadAgentsFromDisk(runCommand, { repairSchedules: false });
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });
});

// Regression guard for a real production bug: app/_layout.tsx's only call to
// loadAgentsFromDisk deliberately passes syncLogs:false (fast startup path),
// so the capture hook above is unreachable in production. The actual live
// entry point is syncAgentRunLogsFromDisk, called on a timer and on app-resume
// (app/_layout.tsx's syncAgentLogs). It has to carry its own capture call --
// this suite existing only for loadAgentsFromDisk is exactly what let that
// gap ship unnoticed.
describe('syncAgentRunLogsFromDisk — scheduled-run memory capture (the actual production path)', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    jest.clearAllMocks();
  });

  it('captures the latest success digest for a remember-enabled agent after a periodic sync', async () => {
    const agent = makeAgent({ memory: { remember: true, tags: ['news'] } });
    useAgentStore.getState().setAgents([agent]);
    const log = makeRunLog();
    const { runCommand, memoryWrites, writeSeen } = buildRunCommand({ agent, log });

    await syncAgentRunLogsFromDisk(runCommand);
    await Promise.race([writeSeen, settleMicrotasks(10)]);

    expect(memoryWrites.length).toBeGreaterThan(0);
    expect(memoryWrites[0]).toContain('local news roundup');
  });

  it('auto-saves a newly synced successful unattended run via the periodic sync path too', async () => {
    const agent = makeAgent({ memory: { remember: true } });
    useAgentStore.getState().setAgents([agent]);
    const log = makeRunLog();
    const { runCommand, skillWrites, writeSeen } = buildRunCommand({ agent, log });

    await syncAgentRunLogsFromDisk(runCommand);
    await Promise.race([writeSeen, settleMicrotasks(10)]);
    await settleMicrotasks(20);

    expect((saveUnattendedSkillWithNotification as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    void skillWrites;
  });

  it('does not double-fire when there is no remember-enabled agent in the store', async () => {
    const agent = makeAgent({ memory: undefined });
    useAgentStore.getState().setAgents([agent]);
    const log = makeRunLog();
    const { runCommand, memoryWrites } = buildRunCommand({ agent, log });

    await syncAgentRunLogsFromDisk(runCommand);
    await settleMicrotasks(10);

    expect(memoryWrites).toHaveLength(0);
  });
});
