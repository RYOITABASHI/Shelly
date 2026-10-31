/**
 * 2026-10-31 on-device bug (agent "プロジェクト概要作成", agent-mvvx3o28): a
 * step pinned to Claude Code read "Claude Code" in MONITOR while it ran, then
 * "cli:cli" once the run finished. The attended chain re-reported the finished
 * step's tool as `{ type: rd.toolType }` (route decisions carry no CLI id) and
 * the progress writer rendered a cli tool without `cli` as `cli:cli`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { toolForRouteDecision } from '@/lib/agent-cli-workers';
import { progressProviderForTool } from '@/lib/agent-progress-writer';
import { liveProviderLabel } from '@/lib/monitor-live';
import type { ToolChoice } from '@/store/types';

const CLAUDE: ToolChoice = { type: 'cli', cli: 'claude' } as ToolChoice;
const CODEX: ToolChoice = { type: 'cli', cli: 'codex' } as ToolChoice;

const finishedLabel = (rd: { toolType?: string; toolLabel?: string }, last?: ToolChoice) => {
  const provider = progressProviderForTool(toolForRouteDecision(rd, last));
  return provider ? liveProviderLabel(provider.name) : undefined;
};

describe('completed-state MONITOR label for a CLI step', () => {
  it('the reported case: a finished Claude Code step stays "Claude Code"', () => {
    expect(finishedLabel({ toolType: 'cli', toolLabel: 'Claude Code' }, CLAUDE)).toBe('Claude Code');
  });

  it('matches the running-state label exactly', () => {
    const running = liveProviderLabel(progressProviderForTool(CLAUDE)!.name);
    expect(finishedLabel({ toolType: 'cli', toolLabel: 'Claude Code' }, CLAUDE)).toBe(running);
  });

  it('without the attempt tool, the route-decision label names the worker', () => {
    expect(finishedLabel({ toolType: 'cli', toolLabel: 'Claude Code' })).toBe('Claude Code');
    expect(finishedLabel({ toolType: 'cli', toolLabel: 'Codex CLI' })).toBe('Codex CLI');
  });

  it('the exact attempt tool wins over a stale label', () => {
    expect(finishedLabel({ toolType: 'cli', toolLabel: 'Codex CLI' }, CLAUDE)).toBe('Claude Code');
  });

  it('never renders "cli:cli", even for a cli tool missing its id', () => {
    expect(progressProviderForTool({ type: 'cli' } as ToolChoice)?.name).not.toBe('cli:cli');
    expect(finishedLabel({ toolType: 'cli' })).not.toMatch(/cli:cli/);
    expect(toolForRouteDecision({ toolType: 'cli' })).toEqual(CODEX); // legacy cliIdOf fallback
  });

  it('non-CLI tools are passed through unchanged', () => {
    expect(toolForRouteDecision({ toolType: 'local', toolLabel: 'Local LLM' }, CLAUDE)).toEqual({ type: 'local' });
    expect(finishedLabel({ toolType: 'local' })).toBe('Local LLM');
    expect(toolForRouteDecision({})).toBeUndefined();
    expect(toolForRouteDecision(undefined)).toBeUndefined();
  });

  it('agent-manager re-reports the finished step through toolForRouteDecision (no bare { type: rd.toolType })', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib/agent-manager.ts'), 'utf8');
    expect(src).not.toContain('progress.stepTool(i, { type: rd.toolType } as ToolChoice');
    expect(src).toContain('toolForRouteDecision(rd, lastAttemptTool)');
  });
});
