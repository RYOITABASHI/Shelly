/**
 * components/panes/AgentUndoButton.tsx
 *
 * The "元に戻す" (Undo) affordance for a rollback-eligible attended agent run
 * (2026-08-04). Rendered by AIPane.tsx's MessageBubble only when
 * ChatMessage.agentRollbackOffer is set on that message — see its doc
 * comment in store/types.ts and lib/agent-manager.ts's
 * rollbackOfferEligible() for the full eligibility chain that decides that.
 *
 * That message-level flag proves the run which produced THIS message was, at
 * capture time, independently classified reversible (not inferred from
 * handle-presence alone). It does NOT prove the undo handle is still alive
 * right now — it may have since been consumed by an earlier tap, invalidated
 * by a newer run of the same agent, or lost to an app restart
 * (lib/agent-manager.ts's pendingRollbackHandles is deliberately in-memory
 * only, see its doc comment there for why persisting it was rejected). So
 * THIS component re-checks peekAgentRollbackHandle() itself, live, before
 * deciding whether to render anything, and rollbackAgentRun() re-checks it
 * again atomically at tap time via consumeAgentRollbackHandle(). Never trust
 * the message flag alone — that is exactly the "stray handle" failure mode
 * __tests__/agent-rollback-offer-eligibility.test.ts exercises.
 *
 * Split out of AIPane.tsx into its own file so this safety-critical, easily
 * mis-wired affordance can be unit-tested (@testing-library/react-native)
 * without dragging in AIPane's much larger dependency graph (every AI
 * provider client, the whole dispatch hook, etc.) just to mount it.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { peekAgentRollbackHandle, rollbackAgentRun } from '@/lib/agent-manager';
import { execCommand } from '@/hooks/use-native-exec';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

export function AgentUndoButton({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'offer' | 'busy' | 'done' | 'unavailable' | 'failed'>('offer');

  const handlePress = useCallback(async () => {
    if (phase !== 'offer') return;
    // Liveness re-check right before acting — a previous render may be
    // stale (this bubble doesn't re-render on every unrelated event), so the
    // button itself could still be showing after the handle was already
    // consumed/invalidated elsewhere. rollbackAgentRun's own
    // consumeAgentRollbackHandle() call is the atomic, authoritative check;
    // this one is just to skip a doomed native round-trip and go straight to
    // the honest "unavailable" state.
    if (peekAgentRollbackHandle(agentId) === null) {
      setPhase('unavailable');
      return;
    }
    setPhase('busy');
    try {
      // RollbackRunCommand is a plain (cmd) => Promise<{stdout, exitCode}>;
      // execCommand's ExecResult ({stdout, stderr, exitCode}) already
      // satisfies that shape structurally.
      const ok = await rollbackAgentRun(agentId, (cmd: string) => execCommand(cmd, 30_000));
      setPhase(ok ? 'done' : 'unavailable');
    } catch {
      setPhase('failed');
    }
  }, [agentId, phase]);

  // Render-time liveness gate: an offer whose handle is already gone shows
  // nothing at all rather than a button that would just fail on tap — never
  // an "always available" affordance for something that quietly expired.
  if (phase === 'offer' && peekAgentRollbackHandle(agentId) === null) {
    return null;
  }

  if (phase === 'done') {
    return <Text style={styles.resultText}>{t('agents.undo_run_success')}</Text>;
  }
  if (phase === 'unavailable') {
    return <Text style={styles.resultText}>{t('agents.undo_run_unavailable')}</Text>;
  }
  if (phase === 'failed') {
    return <Text style={styles.resultText}>{t('agents.undo_run_failed')}</Text>;
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={phase === 'busy'}
      style={[styles.btn, phase === 'busy' && styles.btnBusy]}
      hitSlop={6}
      accessibilityLabel={t('agents.undo_run_button')}
      accessibilityRole="button"
    >
      <MaterialIcons name="undo" size={11} color={C.accent} />
      <Text style={styles.btnLabel}>
        {phase === 'busy' ? t('agents.undo_run_in_progress') : t('agents.undo_run_button')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.4),
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  btnBusy: {
    opacity: 0.6,
  },
  btnLabel: {
    fontSize: 8,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.4,
  },
  resultText: {
    fontSize: 7,
    fontFamily: F.family,
    color: C.text2,
    marginTop: 6,
    fontStyle: 'italic',
  },
});
