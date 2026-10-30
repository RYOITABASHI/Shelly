/**
 * hooks/use-monitor-provider-pick.ts — state + side effects of the MONITOR
 * provider picker (components/monitor/MonitorProviderPicker.tsx). The pure
 * decision lives in lib/monitor-provider-pick.ts; this hook only wires exec,
 * updateAgent and the one-line chat note in the agent's own thread.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { MonitorRun } from '@/lib/agent-progress';
import type { Agent } from '@/store/types';
import { providerPickLabel, toolToProviderPick, type ProviderPick } from '@/lib/agent-provider-overrides';
import {
  applyProviderPick,
  foldPendingProviderOverride,
  hasPendingProviderFold,
  type PickExec,
  type PickUpdate,
} from '@/lib/monitor-provider-pick';

// Lazy: the native module is only touched when the user actually picks.
function terminal(): { execCommand: (command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
}

const exec: PickExec = (command, timeoutMs) => terminal().execCommand(command, timeoutMs);

async function runShell(cmd: string): Promise<string> {
  const result = await terminal().execCommand(cmd, 30_000);
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
  return result.stdout;
}

const update: PickUpdate = async (agentId, partial) => {
  // Lazy: keeps the MONITOR pane's module graph free of the agent manager.
  const { updateAgent } = await import('@/lib/agent-manager');
  return updateAgent(agentId, partial, runShell);
};

function stepIndexOf(defId: string | undefined): number | null {
  const m = defId ? /^s(\d{1,2})$/.exec(defId) : null;
  return m ? Number(m[1]) : null;
}

function currentPickFor(agent: Agent | undefined, index: number): ProviderPick {
  const steps = agent?.orchestration?.steps;
  if (steps && steps.length >= 2) {
    const step = steps[index];
    return toolToProviderPick(step && typeof step !== 'string' ? step.tool : undefined);
  }
  return toolToProviderPick(agent?.tool);
}

function postNote(agentId: string, text: string): void {
  const now = Date.now();
  // Lazy: the persisted chat store is only needed when a note is posted.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAIPaneStore, agentThreadKey } = require('@/store/ai-pane-store') as typeof import('@/store/ai-pane-store');
  useAIPaneStore.getState().addMessage(agentThreadKey(agentId), {
    id: `provider-pick-${now.toString(36)}`,
    role: 'system',
    content: text,
    timestamp: now,
  });
}

type T = (key: string, params?: Record<string, string | number>) => string;

export function useMonitorProviderPick(run: MonitorRun | null, agent: Agent | undefined, defId: string | undefined, t: T) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const index = stepIndexOf(defId);
  const available = !!run && !!agent && index !== null && agent.id === run.agentId;
  const runActive = !!run && !run.endedAt;
  const branchState = run && index !== null ? run.branches.find((b) => b.stepIndex === index)?.state : undefined;
  const canRestart = runActive && branchState === 'RUNNING';
  const current = useMemo(() => (available ? currentPickFor(agent, index!) : 'auto'), [available, agent, index]);

  // A different camera / run closes the picker.
  useEffect(() => setOpen(false), [defId, run?.runId]);

  // Fold this agent's override into its definition once its run has ended.
  const endedAt = run?.endedAt;
  useEffect(() => {
    if (!agent || !run || !endedAt || !hasPendingProviderFold(agent.id)) return;
    foldPendingProviderOverride(exec, update, agent)
      .then((changed) => logInfo('Monitor', `provider override folded for ${agent.id} (changed=${changed})`))
      .catch((error) => logWarn('Monitor', 'provider override fold failed', error));
  }, [agent, run, endedAt]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const apply = useCallback(
    (pick: ProviderPick, restart: boolean) => {
      if (!available || !agent || index === null || busy) return;
      setBusy(true);
      const n = index + 1;
      const tool = providerPickLabel(pick);
      applyProviderPick(exec, update, { agent, stepIndex: index, pick, restart, runId: run?.runId, runActive })
        .then((result) => {
          logInfo('Monitor', `provider pick ${agent.id} step ${index} → ${pick} (${result}, restart=${restart})`);
          if (result === 'unchanged') return;
          const key = result === 'saved' ? 'monitor.provider.note_saved' : restart ? 'monitor.provider.note_restart' : 'monitor.provider.note_keep';
          postNote(agent.id, t(key, { agent: agent.name, n, tool }));
        })
        .catch((error) => {
          logWarn('Monitor', 'provider pick failed', error);
          postNote(agent.id, t('monitor.provider.failed', { error: error instanceof Error ? error.message : String(error) }));
        })
        .finally(() => {
          setBusy(false);
          setOpen(false);
        });
    },
    [available, agent, index, busy, run?.runId, runActive, t],
  );

  return { open, busy, available, canRestart, current, toggle, apply };
}
