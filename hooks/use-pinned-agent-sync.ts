/**
 * hooks/use-pinned-agent-sync.ts
 *
 * Task B (Scouter widget one-tap RUN): keep the native ScouterStateStore snapshot
 * in sync with the pinned agent, so the home-screen widget — a separate process
 * that cannot read the no-persist RN agent store — has ground truth for what to
 * display and fire.
 *
 * Writes {agentId, agentName, status} via TerminalEmulator.setScouterPinnedAgent
 * whenever the pinned id or the pinned agent's display-relevant fields change, and
 * clears it (agentId: null) when nothing is pinned or the pinned agent is gone
 * (e.g. deleted) — so the widget never offers RUN for a stale/absent agent.
 */
import { useEffect } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useSettingsStore } from '@/store/settings-store';
import { useAgentStore } from '@/store/agent-store';
import { nextTriggerMs } from '@/lib/agent-scheduler';
import type { Agent } from '@/store/types';

function formatNextFire(ms: number): string {
  try {
    const d = new Date(ms);
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${days[d.getDay()]} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

/** A short human status line for the widget: last result + next scheduled fire. */
function buildPinnedStatus(agent: Agent): string {
  const parts: string[] = [];
  if (agent.lastResult === 'success') parts.push('last OK');
  else if (agent.lastResult === 'error') parts.push('last ERR');
  if (agent.enabled && agent.schedule) {
    const next = nextTriggerMs(agent.schedule);
    if (Number.isFinite(next) && next > 0) parts.push(`next ${formatNextFire(next)}`);
  } else if (!agent.schedule) {
    parts.push('manual');
  } else if (!agent.enabled) {
    parts.push('paused');
  }
  return parts.join(' · ');
}

export function usePinnedAgentSync(): void {
  const pinnedAgentId = useSettingsStore((s) => s.settings.pinnedAgentId);
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === pinnedAgentId) ?? null);

  // Re-sync whenever the pin or any display-relevant field changes.
  const agentId = agent?.id ?? null;
  const agentName = agent?.name ?? null;
  const lastResult = agent?.lastResult ?? null;
  const lastRun = agent?.lastRun ?? null;
  const schedule = agent?.schedule ?? null;
  const enabled = agent?.enabled ?? null;

  useEffect(() => {
    const setPinned = TerminalEmulator.setScouterPinnedAgent;
    if (!setPinned) return; // older native build without the bridge — no-op
    if (!pinnedAgentId || !agent) {
      setPinned({ agentId: null }).catch(() => {});
      return;
    }
    setPinned({
      agentId: agent.id,
      agentName: agent.name,
      status: buildPinnedStatus(agent),
    }).catch(() => {});
    // agent is intentionally excluded; the primitive fields below capture the
    // display-relevant changes without re-firing on unrelated object identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedAgentId, agentId, agentName, lastResult, lastRun, schedule, enabled]);
}
