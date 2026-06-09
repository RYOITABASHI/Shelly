// components/layout/QuickLaunchSection.tsx
//
// One-tap CLI launchers in the sidebar. Spawns a fresh Terminal pane and
// queues the matching CLI for the exact new session so it runs as soon as
// that session is alive. Mirrors the WorktreesSection chip styling but
// skips the worktree-binding dance — this is for "I just want a Codex
// REPL right now" use cases.
//
// Trigger: tapping a chip → addPane('terminal') → insertCommand(cli, sessionId).
// If the terminal pane cap (3) is hit the underlying useAddPane shows
// the standard alert and we bail without queuing the command.

import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useAddPane } from '@/hooks/use-add-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { SidebarSection } from './SidebarSection';
import { colors as C, fonts as F, padding as P, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

type QuickLaunchCommand = 'codex' | 'diag';

const COMMAND_LABEL: Record<QuickLaunchCommand, string> = {
  codex: 'Codex',
  diag: 'Diag',
};

const COMMAND_TEXT: Record<QuickLaunchCommand, string> = {
  codex: 'codex',
  diag: 'shelly-codex-diagnose',
};

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  iconsOnly: boolean;
};

export function QuickLaunchSection({ isOpen, onToggle, iconsOnly }: Props) {
  const { t } = useTranslation();
  const addPane = useAddPane();

  const launch = useCallback(
    (command: QuickLaunchCommand) => {
      const result = addPane('terminal');
      if (result !== null) return; // useAddPane already alerted
      const sessionId = useTerminalStore.getState().activeSessionId;
      // The command tokens are bashrc-defined functions in HomeInitializer.kt.
      // Trailing newline so bash auto-runs it the
      // moment the new pane's TerminalPane effect picks the command up.
      useTerminalStore.getState().insertCommand(`${COMMAND_TEXT[command]}\n`, sessionId);
    },
    [addPane],
  );

  return (
    <SidebarSection
      title={t('quick_launch.title')}
      icon="rocket-launch"
      isOpen={isOpen}
      onToggle={onToggle}
      iconsOnly={iconsOnly}
    >
      <View style={styles.row}>
        {(['codex', 'diag'] as const).map((command) => (
          <Pressable
            key={command}
            style={[
              styles.chip,
              { borderColor: C.accent, backgroundColor: withAlpha(C.accent, 0.08) },
            ]}
            onPress={() => launch(command)}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={t('quick_launch.launch_a11y', { name: COMMAND_LABEL[command] })}
          >
            <Text style={[styles.chipLabel, { color: C.accent }]}>
              {COMMAND_LABEL[command]}
            </Text>
          </Pressable>
        ))}
      </View>
    </SidebarSection>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 6,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
  },
  chip: {
    flex: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: R.agentTab,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: 'transparent',
  },
  chipLabel: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '600',
  },
});
