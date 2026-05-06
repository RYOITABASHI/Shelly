// components/layout/QuickLaunchSection.tsx
//
// One-tap CLI launchers in the sidebar. Spawns a fresh Terminal pane and
// queues the matching CLI as a pendingCommand so it runs as soon as the
// new session is alive. Mirrors the WorktreesSection chip styling but
// skips the worktree-binding dance — this is for "I just want a Codex
// REPL right now" use cases.
//
// Trigger: tapping a chip → addPane('terminal') → insertCommand(cli).
// If the terminal pane cap (3) is hit the underlying useAddPane shows
// the standard alert and we bail without queuing the command.

import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useAddPane } from '@/hooks/use-add-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { SidebarSection } from './SidebarSection';
import { colors as C, fonts as F, padding as P, sizes as S } from '@/theme.config';
import { neonGlowSky } from '@/lib/neon-glow';

type Cli = 'claude' | 'codex' | 'gemini';

const CLI_COLORS: Record<Cli, string> = {
  claude: '#A78BFA',
  codex: '#22C55E',
  gemini: '#60A5FA',
};

const CLI_EMOJI: Record<Cli, string> = {
  claude: '🟣',
  codex: '🟢',
  gemini: '🔵',
};

const CLI_LABEL: Record<Cli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
};

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  iconsOnly: boolean;
};

export function QuickLaunchSection({ isOpen, onToggle, iconsOnly }: Props) {
  const addPane = useAddPane();

  const launch = useCallback(
    (cli: Cli) => {
      const result = addPane('terminal');
      if (result !== null) return; // useAddPane already alerted
      // The shell function name on the user's $PATH matches the cli token
      // (claude/codex/gemini are all bashrc-defined functions in
      // HomeInitializer.kt). Trailing newline so bash auto-runs it the
      // moment the new pane's TerminalPane effect picks pendingCommand up.
      useTerminalStore.getState().insertCommand(`${cli}\n`);
    },
    [addPane],
  );

  return (
    <SidebarSection
      title="QUICK LAUNCH"
      icon="rocket-launch"
      isOpen={isOpen}
      onToggle={onToggle}
      iconsOnly={iconsOnly}
      accent={C.accentSky}
      glow={neonGlowSky}
    >
      <View style={styles.row}>
        {(['claude', 'codex', 'gemini'] as const).map((cli) => (
          <Pressable
            key={cli}
            style={[styles.chip, { borderColor: CLI_COLORS[cli] }]}
            onPress={() => launch(cli)}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={`Launch ${CLI_LABEL[cli]} in a new terminal pane`}
          >
            <Text style={styles.emoji}>{CLI_EMOJI[cli]}</Text>
            <Text style={[styles.chipLabel, { color: CLI_COLORS[cli] }]}>
              {CLI_LABEL[cli]}
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
    flexWrap: 'wrap',
    gap: P.xs,
    paddingHorizontal: P.sm,
    paddingVertical: P.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: P.sm,
    paddingVertical: 4,
    borderRadius: S.radius,
    borderWidth: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  emoji: {
    fontSize: 11,
    lineHeight: 14,
  },
  chipLabel: {
    fontFamily: F.mono,
    fontSize: 11,
    fontWeight: '600',
  },
});
