/**
 * lib/monitor-team-source.ts — a still MonitorSource for a team that is not
 * running: DRAFT mode (your own team in the MAP editor, no playback, no
 * sample costs) and a just-registered agent that has not run yet (LIVE ▸
 * <agent>, every channel on STANDBY until "Run now").
 */
import type { Agent } from '@/store/types';
import { normalizeSteps, planParallelGroups } from './agent-orchestration';
import type { MonitorAgentDef, MonitorAgentSnapshot, MonitorSnapshot, MonitorSource } from './monitor-source';
import {
  chainNodes,
  MONITOR_PROVIDER_KIND,
  MONITOR_PROVIDER_LABEL,
  type MonitorProvider,
  type MonitorTeam,
  type MonitorTeamNode,
} from './monitor-team';

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

function standby(): MonitorAgentSnapshot {
  return { state: 'STANDBY', lines: [], note: null, logs: 0, totalLogs: 1, tokens: 0, usd: null };
}

/** Defs for every chain node and sub-agent, CH-01.. in column order. */
export function teamDefs(team: MonitorTeam): MonitorAgentDef[] {
  const defs: MonitorAgentDef[] = [];
  const nodes = chainNodes(team);
  nodes.forEach((n, i) => {
    defs.push(defFor(n, `CH-${pad2(i + 1)}`, (i % 5) + 1));
    team.subAgents
      .filter((s) => s.parentId === n.id)
      .forEach((s, j) => {
        defs.push({ ...defFor(s, `CH-${pad2(i + 1)}${String.fromCharCode(65 + j)}`, ((i + j + 1) % 5) + 1), parentId: n.id });
      });
  });
  return defs;
}

function defFor(n: MonitorTeamNode, channel: string, op: number): MonitorAgentDef {
  return {
    id: n.id,
    channel,
    name: (n.name ?? n.role).slice(0, 24).toUpperCase(),
    kind: MONITOR_PROVIDER_KIND[n.provider],
    provider: n.provider,
    providerName: MONITOR_PROVIDER_LABEL[n.provider],
    model: '',
    operator: op as MonitorAgentDef['operator'],
  };
}

export function createTeamSource(team: MonitorTeam): MonitorSource {
  const agents = teamDefs(team);
  const snap: MonitorSnapshot = {
    t: 0,
    agents: Object.fromEntries(agents.map((d) => [d.id, standby()])),
    approvalPending: false,
    approvalAgentId: null,
    complete: false,
    chat: [],
    missionPct: 0,
  };
  return { isDemo: false, agents, team, snapshot: () => snap };
}

function providerOf(tool: { type: string; cli?: string } | undefined): MonitorProvider {
  if (!tool) return 'auto';
  if (tool.type === 'cli') return tool.cli === 'codex' ? 'codex-cli' : tool.cli === 'claude' ? 'claude-cli' : 'auto';
  return (['perplexity', 'gemini-api', 'cerebras', 'groq', 'local'] as const).find((p) => p === tool.type) ?? 'auto';
}

/** Wiring of a registered agent's chain (effective parallel groups stacked). */
export function teamFromAgent(agent: Agent): MonitorTeam {
  const steps = normalizeSteps(agent.orchestration);
  const columns: MonitorTeamNode[][] = [];
  if (steps.length === 0) {
    columns.push([{ id: 's0', role: agent.prompt || agent.name, provider: providerOf(agent.tool), askBeforeWrite: !!agent.requireActionApproval }]);
  } else {
    const { group } = planParallelGroups(steps);
    let last: string | undefined;
    steps.forEach((s, i) => {
      const node: MonitorTeamNode = {
        id: `s${i}`,
        role: s.instruction,
        provider: providerOf(s.tool),
        askBeforeWrite: false,
      };
      if (group[i] && group[i] === last && columns.length) columns[columns.length - 1].push(node);
      else columns.push([node]);
      last = group[i];
    });
  }
  return { title: agent.name, columns, subAgents: [] };
}
