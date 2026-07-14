/* eslint-disable import/first -- Jest mocks must be registered before imports. */
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
jest.mock('expo-file-system/legacy', () => ({}));

import { rematerializeAutonomousAgents } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('rematerializeAutonomousAgents serialization', () => {
  it('leaves the later consent revocation on disk when the older write is delayed', async () => {
    const agent: Agent = {
      id: 'race-agent',
      name: 'Race agent',
      description: '',
      prompt: '最新ニュースを集めて',
      schedule: '0 8 * * *',
      tool: { type: 'gemini-api' },
      autonomous: true,
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
    };
    useAgentStore.getState().setAgents([agent]);

    let consentEnabled = true;
    let envReads = 0;
    let writes = 0;
    let finalOnDiskCommand = '';
    const writeCommands: string[] = [];
    const firstWriteGate = deferred();
    const firstWriteStarted = deferred();

    const runCommand = jest.fn(async (command: string): Promise<string> => {
      if (command.startsWith('for k in CEREBRAS_API_KEY')) {
        envReads += 1;
        return [
          'CEREBRAS_API_KEY=0',
          'GROQ_API_KEY=0',
          'PERPLEXITY_API_KEY=1',
          'GEMINI_API_KEY=1',
          `SHELLY_AUTONOMOUS_CLOUD='${consentEnabled ? '1' : '0'}'`,
          "SHELLY_AUTONOMOUS_CLOUD_STOP='0'",
        ].join('\n');
      }

      writes += 1;
      writeCommands.push(command);
      if (writes === 1) {
        firstWriteStarted.resolve();
        await firstWriteGate.promise;
      }
      finalOnDiskCommand = command;
      return '';
    });

    const enablePass = rematerializeAutonomousAgents(runCommand);
    await firstWriteStarted.promise;

    // Revoke while the ON-based write is still in flight. Without the queue,
    // this OFF pass writes first and the delayed ON pass overwrites it later.
    consentEnabled = false;
    const revokePass = rematerializeAutonomousAgents(runCommand);
    await Promise.resolve();

    expect(envReads).toBe(1);
    expect(writes).toBe(1);

    firstWriteGate.resolve();
    await Promise.all([enablePass, revokePass]);

    expect(envReads).toBe(2);
    expect(writes).toBe(2);
    expect(writeCommands[0]).toContain('https://generativelanguage.googleapis.com');
    expect(finalOnDiskCommand).toContain('[REFUSED] autonomous mode does not allow the');
    expect(finalOnDiskCommand).toContain('gemini-api');
    expect(finalOnDiskCommand).not.toContain('https://generativelanguage.googleapis.com');
  });
});
