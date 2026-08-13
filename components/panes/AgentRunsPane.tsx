/**
 * components/panes/AgentRunsPane.tsx — Agent Runs pane.
 *
 * Visualizes the background-agent execution history agent-store already keeps
 * (`runHistory`: up to 30 AgentRunLog entries per agent, populated from
 * ~/.shelly/agents/logs/<agentId>/*.json by syncAgentRunLogsFromDisk).
 *
 * Before this pane, the ONLY surface for past runs was Sidebar.tsx's
 * showAgentDetail Alert, which shows the LAST run plus at most one prior
 * failure — the other 28 retained runs were unreachable. This pane is that
 * missing scrollable list, plus the per-run audit detail (full routeDecision,
 * output preview, error, orchestration steps, multi-action results).
 *
 * All display logic (grouping, ordering, formatting, route-row explosion)
 * lives in lib/agent-runs-view.ts so it is unit-testable outside RN.
 */
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';
import { usePaneContentBackground, usePanelBackground } from '@/hooks/use-panel-background';
import { execCommand } from '@/hooks/use-native-exec';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, AgentRunLog } from '@/store/types';
import { runAgentNow, syncAgentRunLogsFromDisk } from '@/lib/agent-manager';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { shouldOfferSkillSave, useSkillSaveOffer } from '@/hooks/use-skill-save-offer';
import {
  buildAgentRunGroups,
  buildRouteDecisionRows,
  describeRunAge,
  formatRunDuration,
  runStatusIcon,
  runStatusTone,
  type RunStatusTone,
} from '@/lib/agent-runs-view';
import {
  getSelectedRunAgentId,
  selectRunAgent,
  subscribeRunAgentSelection,
} from '@/lib/agent-runs-selection';
import { colors as C } from '@/theme.config';

/** Stable key for one run row — timestamp alone can collide across agents. */
function runKey(run: AgentRunLog): string {
  return `${run.agentId}:${run.timestamp}:${run.toolUsed}`;
}

/** Shell-command shape lib/agent-manager.ts expects (throws on non-zero exit). */
async function runAgentShellCommand(cmd: string): Promise<string> {
  const result = await execCommand(cmd, 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
  return result.stdout;
}

export default function AgentRunsPane() {
  const theme = useTheme();
  const { t } = useTranslation();
  const colors = theme.colors;

  const runHistory = useAgentStore((s) => s.runHistory);
  const agents = useAgentStore((s) => s.agents);

  // Agent scoping arrives out-of-band (see lib/agent-runs-selection.ts) —
  // read the retained value on mount so a selection made before this pane
  // finished mounting is not lost, then follow later changes.
  const [agentFilter, setAgentFilter] = React.useState<string | null>(() => getSelectedRunAgentId());
  React.useEffect(() => subscribeRunAgentSelection(setAgentFilter), []);

  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyAgentId, setBusyAgentId] = React.useState<string | null>(null);

  const paneBg = usePaneContentBackground(C.bgDeep);
  const cardBg = usePanelBackground(colors.surface);
  const headerBg = usePanelBackground(colors.surface);

  const toneColor = React.useCallback(
    (tone: RunStatusTone): string => {
      switch (tone) {
        case 'success':
          return colors.success;
        case 'error':
          return colors.error;
        case 'warning':
          return colors.warning;
        case 'muted':
        default:
          return colors.muted;
      }
    },
    [colors],
  );

  const groups = React.useMemo(
    () => buildAgentRunGroups(runHistory, agents, { agentId: agentFilter }),
    [runHistory, agents, agentFilter],
  );

  // Re-read the on-disk logs so a run that completed while this pane was
  // closed (or fired from an alarm) shows up without an app restart.
  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await syncAgentRunLogsFromDisk(runAgentShellCommand, agentFilter ?? undefined);
    } catch {
      // Best effort — a read failure must never blank the already-shown list.
    } finally {
      setRefreshing(false);
    }
  }, [agentFilter]);

  React.useEffect(() => {
    void refresh();
    // Intentionally only on mount / filter change — this pane is a viewer,
    // not a poller; the Sidebar already owns the periodic sync.
  }, [refresh]);

  const { offerSkillSave, offerSkillImprovement } = useSkillSaveOffer({ runCommand: runAgentShellCommand });

  const agentById = React.useCallback(
    (agentId: string): Agent | undefined => agents.find((a) => a.id === agentId),
    [agents],
  );

  const handleSaveSkill = React.useCallback(
    (agentId: string, run: AgentRunLog) => {
      const agent = agentById(agentId);
      if (!agent) return;
      offerSkillSave({
        name: agent.name,
        prompt: agent.prompt,
        routeDecision: run.routeDecision,
        timestamp: run.timestamp,
        status: run.status,
        alreadySkillId: agent.skillId,
        planSpec: run.steps && run.steps.length >= 2 ? buildAgentPlanSpec(agent) : undefined,
      });
    },
    [agentById, offerSkillSave],
  );

  // "Re-run" reuses the same run-now path Sidebar.tsx's play-arrow uses.
  // AgentRunLog does not snapshot the config that produced it, so this
  // necessarily re-runs the agent's CURRENT definition — the pane labels it
  // as such rather than pretending to replay the exact past invocation.
  const handleRerun = React.useCallback(
    async (agentId: string) => {
      const agent = agentById(agentId);
      if (!agent || busyAgentId) return;
      setBusyAgentId(agentId);
      try {
        await runAgentNow(agentId, runAgentShellCommand);
        // Skill self-improvement confirm (no-op unless this re-run of a
        // skill-reusing agent staged a body-learning proposal).
        offerSkillImprovement(agentId);
        await syncAgentRunLogsFromDisk(runAgentShellCommand, agentId);
      } catch (error) {
        Alert.alert(
          t('agent_runs.rerun_failed_title'),
          t('agent_runs.rerun_failed_body', {
            name: agent.name,
            error: String((error as Error)?.message || error),
          }),
        );
      } finally {
        setBusyAgentId(null);
      }
    },
    [agentById, busyAgentId, offerSkillImprovement, t],
  );

  // Undo is deliberately inert here. The only rollback mechanism in the app
  // (the AI Pane chat-run git savepoint behind lib/agent-manager's
  // rollbackAgentRun / AgentUndoButton) is scoped to a live, just-finished
  // attended chat run — a historical background run has no retained handle,
  // so there is nothing honest to undo. Shown disabled with an explanation
  // rather than omitted, so "why can't I undo this?" is answerable in place.
  const handleUndoExplain = React.useCallback(() => {
    Alert.alert(t('agent_runs.action_undo'), t('agent_runs.undo_unavailable_hint'), [
      { text: t('common.close'), style: 'cancel' },
    ]);
  }, [t]);

  const filteredAgentName =
    agentFilter ? agentById(agentFilter)?.name ?? agentFilter : null;

  return (
    <View style={[styles.container, { backgroundColor: paneBg }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: headerBg }]}>
        <MaterialIcons name="history" size={16} color={colors.accent} />
        <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
          {filteredAgentName
            ? t('agent_runs.header_scoped', { name: filteredAgentName })
            : t('pane.agent_runs.header')}
        </Text>
        {filteredAgentName ? (
          <TouchableOpacity
            onPress={() => selectRunAgent(null)}
            style={[styles.headerButton, { borderColor: colors.border }]}
            accessibilityLabel={t('agent_runs.clear_filter')}
          >
            <Text style={[styles.headerButtonText, { color: colors.accent }]}>
              {t('agent_runs.clear_filter')}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={() => void refresh()}
          disabled={refreshing}
          style={[styles.headerButton, { borderColor: colors.border }]}
          accessibilityLabel={t('agent_runs.refresh')}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <MaterialIcons name="refresh" size={16} color={colors.accent} />
          )}
        </TouchableOpacity>
      </View>

      {groups.length === 0 ? (
        <View style={styles.centered}>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            {t('agent_runs.empty_title')}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.muted }]}>
            {t('agent_runs.empty_body')}
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {groups.map((group) => {
            const agent = agentById(group.agentId);
            return (
              <View key={group.agentId} style={styles.group}>
                <View style={styles.groupHeader}>
                  <Text
                    style={[styles.groupTitle, { color: colors.accent }]}
                    numberOfLines={1}
                  >
                    {group.agentName}
                  </Text>
                  <Text style={[styles.groupCount, { color: colors.muted }]}>
                    {t('agent_runs.runs_count', { count: group.runs.length })}
                  </Text>
                </View>

                {group.runs.map((run) => {
                  const key = runKey(run);
                  const expanded = expandedKey === key;
                  const tone = toneColor(runStatusTone(run.status));
                  const age = describeRunAge(run.timestamp, Date.now());
                  const duration = formatRunDuration(run.durationMs);
                  const routeRows = buildRouteDecisionRows(run.routeDecision);
                  const canSaveSkill =
                    Boolean(agent) &&
                    shouldOfferSkillSave({ status: run.status, alreadySkillId: agent?.skillId });

                  return (
                    <View
                      key={key}
                      style={[styles.card, { backgroundColor: cardBg, borderColor: colors.border }]}
                    >
                      <TouchableOpacity
                        style={styles.row}
                        onPress={() => setExpandedKey(expanded ? null : key)}
                        accessibilityLabel={t('agent_runs.toggle_detail_a11y')}
                      >
                        <MaterialIcons
                          name={runStatusIcon(run.status) as never}
                          size={16}
                          color={tone}
                        />
                        <View style={styles.rowMain}>
                          <Text style={[styles.rowStatus, { color: tone }]} numberOfLines={1}>
                            {t(`agent_runs.status_${run.status}`)}
                          </Text>
                          <Text style={[styles.rowMeta, { color: colors.muted }]} numberOfLines={1}>
                            {[
                              t(age.key, age.params),
                              duration,
                              run.toolUsed,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                        </View>
                        <MaterialIcons
                          name={expanded ? 'expand-less' : 'expand-more'}
                          size={18}
                          color={colors.muted}
                        />
                      </TouchableOpacity>

                      {expanded ? (
                        <View style={[styles.detail, { borderTopColor: colors.border }]}>
                          {/* Route decision */}
                          {routeRows.length > 0 ? (
                            <View style={styles.section}>
                              <Text style={[styles.sectionTitle, { color: colors.accent }]}>
                                {t('agent_runs.section_route')}
                              </Text>
                              {routeRows.map((row) => (
                                <View key={row.labelKey} style={styles.kv}>
                                  <Text style={[styles.kvLabel, { color: colors.muted }]}>
                                    {t(row.labelKey)}
                                  </Text>
                                  <Text style={[styles.kvValue, { color: colors.foreground }]}>
                                    {row.valueKey ? t(row.valueKey) : row.value}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          ) : null}

                          {/* Output preview */}
                          <View style={styles.section}>
                            <Text style={[styles.sectionTitle, { color: colors.accent }]}>
                              {t('agent_runs.section_output')}
                            </Text>
                            <Text style={[styles.body, { color: colors.foreground }]}>
                              {run.outputPreview?.trim() || t('agent_runs.no_output')}
                            </Text>
                            {run.savedPath ? (
                              <Text style={[styles.body, { color: colors.muted }]}>
                                {t('agent_runs.saved_path', { path: run.savedPath })}
                              </Text>
                            ) : null}
                          </View>

                          {/* Error */}
                          {run.errorMessage ? (
                            <View style={styles.section}>
                              <Text style={[styles.sectionTitle, { color: colors.error }]}>
                                {t('agent_runs.section_error')}
                              </Text>
                              <Text style={[styles.body, { color: colors.error }]}>
                                {run.errorMessage}
                              </Text>
                            </View>
                          ) : null}

                          {/* Orchestration steps */}
                          {run.steps && run.steps.length > 0 ? (
                            <View style={styles.section}>
                              <Text style={[styles.sectionTitle, { color: colors.accent }]}>
                                {t('agent_runs.section_steps')}
                              </Text>
                              {run.steps.map((step) => (
                                <Text
                                  key={`${key}-step-${step.index}`}
                                  style={[
                                    styles.body,
                                    { color: toneColor(runStatusTone(step.status)) },
                                  ]}
                                >
                                  {`${step.index + 1}. ${t(`agent_runs.status_${step.status}`)} — ${step.instruction}`}
                                </Text>
                              ))}
                            </View>
                          ) : null}

                          {/* Multi-action fan-out results */}
                          {run.actionResults && run.actionResults.length > 0 ? (
                            <View style={styles.section}>
                              <Text style={[styles.sectionTitle, { color: colors.accent }]}>
                                {t('agent_runs.section_actions')}
                              </Text>
                              {run.actionResults.map((result) => (
                                <Text
                                  key={`${key}-action-${result.index}`}
                                  style={[
                                    styles.body,
                                    { color: toneColor(runStatusTone(result.status)) },
                                  ]}
                                >
                                  {`${result.index + 1}. ${result.actionType} — ${t(`agent_runs.status_${result.status}`)}${result.message ? ` — ${result.message}` : ''}`}
                                </Text>
                              ))}
                            </View>
                          ) : null}

                          {/* Row actions */}
                          <View style={styles.actions}>
                            <TouchableOpacity
                              onPress={() => handleSaveSkill(group.agentId, run)}
                              disabled={!canSaveSkill}
                              style={[
                                styles.actionButton,
                                {
                                  borderColor: colors.border,
                                  opacity: canSaveSkill ? 1 : 0.4,
                                },
                              ]}
                              accessibilityLabel={t('agent_runs.action_save_skill')}
                            >
                              <MaterialIcons
                                name="bookmark-add"
                                size={14}
                                color={canSaveSkill ? colors.accent : colors.muted}
                              />
                              <Text
                                style={[
                                  styles.actionText,
                                  { color: canSaveSkill ? colors.accent : colors.muted },
                                ]}
                              >
                                {t('agent_runs.action_save_skill')}
                              </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                              onPress={() => void handleRerun(group.agentId)}
                              disabled={!agent || busyAgentId !== null}
                              style={[
                                styles.actionButton,
                                {
                                  borderColor: colors.border,
                                  opacity: agent && busyAgentId === null ? 1 : 0.4,
                                },
                              ]}
                              accessibilityLabel={t('agent_runs.action_rerun')}
                            >
                              {busyAgentId === group.agentId ? (
                                <ActivityIndicator size="small" color={colors.accent} />
                              ) : (
                                <MaterialIcons
                                  name="replay"
                                  size={14}
                                  color={agent ? colors.accent : colors.muted}
                                />
                              )}
                              <Text
                                style={[
                                  styles.actionText,
                                  { color: agent ? colors.accent : colors.muted },
                                ]}
                              >
                                {t('agent_runs.action_rerun')}
                              </Text>
                            </TouchableOpacity>

                            {/* Disabled by design — see handleUndoExplain. */}
                            <TouchableOpacity
                              onPress={handleUndoExplain}
                              style={[
                                styles.actionButton,
                                { borderColor: colors.border, opacity: 0.4 },
                              ]}
                              accessibilityLabel={t('agent_runs.undo_unavailable_hint')}
                            >
                              <MaterialIcons name="undo" size={14} color={colors.muted} />
                              <Text style={[styles.actionText, { color: colors.muted }]}>
                                {t('agent_runs.action_undo_unavailable')}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    minHeight: 44,
  },
  headerTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  headerButton: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerButtonText: { fontSize: 11, fontWeight: '600' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 6 },
  emptyTitle: { fontSize: 14, fontWeight: '600' },
  emptyBody: { fontSize: 12, textAlign: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32, gap: 14 },
  group: { gap: 6 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupTitle: { flex: 1, fontSize: 13, fontWeight: '700' },
  groupCount: { fontSize: 11 },
  card: { borderWidth: 1, borderRadius: 6, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 },
  rowMain: { flex: 1, gap: 2 },
  rowStatus: { fontSize: 12, fontWeight: '600' },
  rowMeta: { fontSize: 11 },
  detail: { borderTopWidth: 1, padding: 10, gap: 10 },
  section: { gap: 3 },
  sectionTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  kv: { flexDirection: 'row', gap: 6 },
  kvLabel: { fontSize: 11, minWidth: 78 },
  kvValue: { flex: 1, fontSize: 11 },
  body: { fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  actionText: { fontSize: 11, fontWeight: '600' },
});
