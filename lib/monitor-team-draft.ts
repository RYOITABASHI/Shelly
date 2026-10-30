/**
 * lib/monitor-team-draft.ts — turn a MONITOR wiring-map team
 * (lib/monitor-team.ts) into the same ParsedAgentDraft the `@agent` NL flow
 * builds, so "Register this team" goes through the identical summary →
 * plain-chat "OK" → registration path (hooks/use-ai-pane-dispatch.ts
 * presentDraftForConfirmation). Pure: no store, no I/O.
 *
 * Mapping:
 *   - name / prompt: the team title (prompt also names the destination).
 *   - steps: toOrchestrationSteps() — columns left → right, a multi-node
 *     column shares one parallelGroup id so planParallelGroups() runs it as
 *     one fan-out group (the chat summary shows it as one "In parallel: A / B" line, matching the MAP column).
 *     A one-node team is a plain single-step agent (no orchestration).
 *   - tool pins: a node's provider; Auto → no pin (the router decides).
 *   - sub-agents: there is no sub-agent runtime yet, so a sub-agent's role
 *     is folded into its parent step's instruction ("…; then: <role>").
 *   - schedule: always manual (Run now). The team's free-form schedule text
 *     is not parsed; the summary says how to make the agent recurring.
 *   - final action: 'draft' (save the result). The team destination is the
 *     displayed save target (advisory — same as the `@agent` outputPath hint).
 *   - "ask before writing": the agent action layer has no per-step approval,
 *     so ANY node asking collapses to the agent-level setting
 *     (Agent.requireActionApproval = true). The summary says so in one line
 *     (actionCaveat). No node asking → the global default is inherited.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
import { tFor, type Locale } from './i18n';
import {
  chainNodes,
  normalizeRole,
  providerToTool,
  requiresWriteApproval,
  toOrchestrationSteps,
  validate,
  MONITOR_PROVIDER_LABEL,
  type MonitorTeam,
  type MonitorTeamError,
} from './monitor-team';
import type { AgentOrchestrationStep, ToolChoice } from '@/store/types';

export interface MonitorTeamDraft {
  draft: ParsedAgentDraft;
  /** Apply to the registered agent (Agent.requireActionApproval) — see the
   *  module doc for the team-level collapse. */
  requireActionApproval: boolean;
}

export type MonitorTeamDraftResult =
  | { ok: true; value: MonitorTeamDraft }
  | { ok: false; errors: MonitorTeamError[] };

/** Registration is only offered for a team that passes validate(). */
export function canRegisterTeam(team: MonitorTeam): boolean {
  return validate(team).length === 0;
}

function teamName(team: MonitorTeam, locale: Locale): string {
  const title = team.title.replace(/\s+/g, ' ').trim();
  return (title || tFor(locale, 'monitor.register.default_name')).slice(0, 80);
}

export function teamToAgentDraft(team: MonitorTeam, locale: Locale): MonitorTeamDraftResult {
  const errors = validate(team);
  if (errors.length > 0) return { ok: false, errors };

  const name = teamName(team, locale);
  const nodes = chainNodes(team);
  const subRoles = new Map<string, string[]>();
  for (const s of team.subAgents) {
    const role = normalizeRole(s.role);
    if (!role) continue;
    subRoles.set(s.parentId, [...(subRoles.get(s.parentId) ?? []), role]);
  }
  const thenWord = tFor(locale, 'monitor.register.sub_then');
  const steps: AgentOrchestrationStep[] = toOrchestrationSteps(team).map((step, i) => {
    const subs = subRoles.get(nodes[i].id);
    return subs?.length ? { ...step, instruction: `${step.instruction}; ${thenWord} ${subs.join('; ')}` } : step;
  });

  const destination = team.destination
    ? `${team.destination.label}: ${team.destination.path}`
    : undefined;
  const single = steps.length === 1;
  const singlePin: ToolChoice | undefined = single ? providerToTool(nodes[0].provider) : undefined;
  const tool: ToolChoice = singlePin ?? { type: 'auto' };
  const prompt = single
    ? steps[0].instruction
    : destination
      ? tFor(locale, 'monitor.register.prompt_with_dest', { title: name, dest: destination })
      : name;
  const requireActionApproval = requiresWriteApproval(team);

  const draft: ParsedAgentDraft = {
    name,
    prompt,
    schedule: null,
    scheduleConfident: true,
    scheduleLabel: tFor(locale, 'agentcard.sched_manual'),
    trigger: 'manual',
    // Manual was chosen for the user, not said by them: one human confirm
    // before it registers (hasDraftAssumptions) — on top of the
    // 'monitor-team' source always requiring the chat confirm.
    triggerAssumed: true,
    action: { type: 'draft' },
    ...(destination ? { outputPath: destination } : {}),
    tool,
    toolLabel: singlePin ? MONITOR_PROVIDER_LABEL[nodes[0].provider] : MONITOR_PROVIDER_LABEL.auto,
    ...(singlePin ? { toolExplicit: true } : {}),
    ...(single ? {} : { orchestrationSteps: steps }),
    ...(requireActionApproval ? { actionCaveat: tFor(locale, 'monitor.register.ask_collapsed') } : {}),
    // detectMessageLocale reads this: the header keeps the summary in the
    // viewer's language even when every role is written in English.
    rawText: `${tFor(locale, 'monitor.register.raw_header', { title: name })}\n${nodes.map((n) => normalizeRole(n.role)).join('\n')}`,
  };
  return { ok: true, value: { draft, requireActionApproval } };
}
