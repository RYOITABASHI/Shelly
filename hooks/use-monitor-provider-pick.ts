/**
 * hooks/use-monitor-provider-pick.ts — state + side effects of the MONITOR
 * provider picker (components/monitor/MonitorProviderPicker.tsx). The pure
 * decision lives in lib/monitor-provider-pick.ts; this hook only wires exec,
 * updateAgent and the one-line chat note in the agent's own thread. Folding a
 * mid-run override into the definition is NOT done here — it happens on the
 * run-completion path (lib/agent-manager.ts foldProviderOverridesFromDisk).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { MonitorRun } from '@/lib/agent-progress';
import type { Agent } from '@/store/types';
import { groupStepsForDisplay } from '@/lib/agent-orchestration';
import { providerPickLabel, toolToProviderPick, type ProviderPick } from '@/lib/agent-provider-overrides';
import { applyProviderPick, type PickExec, type PickUpdate } from '@/lib/monitor-provider-pick';

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

function isMultiStep(agent: Agent | undefined): boolean {
  return (agent?.orchestration?.steps?.length ?? 0) >= 2;
}

function currentPickFor(agent: Agent | undefined, index: number): ProviderPick {
  if (isMultiStep(agent)) {
    const step = agent!.orchestration!.steps[index];
    return toolToProviderPick(step && typeof step !== 'string' ? step.tool : undefined);
  }
  return toolToProviderPick(agent?.tool);
}

/** The step's number as the chat summary shows it (a parallel group is one line). */
function summaryLineNumber(agent: Agent | undefined, index: number): number {
  const steps = agent?.orchestration?.steps;
  if (!steps || steps.length < 2) return index + 1;
  let next = 0;
  const lines = groupStepsForDisplay(steps).entries.map((entry) => entry.items.map(() => next++));
  const line = lines.findIndex((members) => members.includes(index));
  return line >= 0 ? line + 1 : index + 1;
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
  // Redo only exists for a step of a multi-step chain (a single-step run is
  // not restarted mid-way; its change applies from the next run).
  const canRestart = runActive && branchState === 'RUNNING' && isMultiStep(agent);
  const current = useMemo(() => (available ? currentPickFor(agent, index!) : 'auto'), [available, agent, index]);

  // A different camera / run closes the picker.
  useEffect(() => setOpen(false), [defId, run?.runId]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const apply = useCallback(
    (pick: ProviderPick, restart: boolean) => {
      if (!available || !agent || index === null || busy) return;
      setBusy(true);
      const n = summaryLineNumber(agent, index);
      const tool = providerPickLabel(pick);
      applyProviderPick(exec, update, { agent, stepIndex: index, pick, restart: restart && canRestart, runId: run?.runId, runActive })
        .then(({ result, appliesNow, paidNextRun }) => {
          logInfo('Monitor', `provider pick ${agent.id} step ${index} → ${pick} (${result}, now=${appliesNow}, restart=${restart})`);
          if (result === 'unchanged') return;
          const key =
            result === 'saved'
              ? 'monitor.provider.note_saved'
              : paidNextRun
                ? 'monitor.provider.note_paid_next'
                : !appliesNow
                  ? 'monitor.provider.note_next_run'
                  : restart && canRestart
                    ? 'monitor.provider.note_restart'
                    : 'monitor.provider.note_keep';
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
    [available, agent, index, busy, run?.runId, runActive, canRestart, t],
  );

  return { open, busy, available, canRestart, current, toggle, apply };
}
