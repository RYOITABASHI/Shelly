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
import { neonGlowSky } from '@/lib/neon-glow';

type Cli = 'claude' | 'codex';

// Anthropic Claude brand: warm copper/orange (#CC785C). Codex green matches
// OpenAI's primary brand identity.
const CLI_COLORS: Record<Cli, string> = {
  claude: '#CC785C',
  codex: '#22C55E',
};

const CLI_EMOJI: Record<Cli, string> = {
  claude: '🟠',
  codex: '🟢',
};

const CLI_LABEL: Record<Cli, string> = {
  claude: 'Claude',
  codex: 'Codex',
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
      const sessionId = useTerminalStore.getState().activeSessionId;
      // The shell function name on the user's $PATH matches the cli token
      // (claude/codex are bashrc-defined functions in HomeInitializer.kt).
      // Trailing newline so bash auto-runs it the
      // moment the new pane's TerminalPane effect picks the command up.
      useTerminalStore.getState().insertCommand(`${cli}\n`, sessionId);
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
        {(['claude', 'codex'] as const).map((cli) => (
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
    flexWrap: 'nowrap',
    gap: 6,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
  },
  chip: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: R.agentTab,
    borderWidth: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  emoji: {
    fontSize: 9,
    lineHeight: 11,
  },
  chipLabel: {
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '600',
  },
});
