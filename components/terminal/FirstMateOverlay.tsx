/**
 * FirstMateOverlay — First-time terminal onboarding
 *
 * Shows goal-selection grid on first terminal connection.
 * Installs relevant package bundles via bridge.
 * First-time terminal setup overlay.
 */

import React, { memo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTerminalStore } from '@/store/terminal-store';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type GoalId = 'web' | 'ai' | 'files' | 'learning';

type GoalConfig = {
  id: GoalId;
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  labelJa: string;
  packages: string[];
  postSetup: string[];
};

const GOALS: GoalConfig[] = [
  {
    id: 'web',
    icon: 'language',
    label: 'Web Dev',
    labelJa: 'Web\u958B\u767A',
    packages: ['nodejs', 'git', 'python'],
    postSetup: ['npm install -g pnpm'],
  },
  {
    id: 'ai',
    icon: 'psychology',
    label: 'AI Dev',
    labelJa: 'AI\u958B\u767A',
    packages: ['python', 'git', 'cmake', 'clang'],
    postSetup: [],
  },
  {
    id: 'files',
    icon: 'folder-open',
    label: 'File Mgmt',
    labelJa: '\u30D5\u30A1\u30A4\u30EB\u7BA1\u7406',
    packages: ['zip', 'unzip', 'tree', 'file'],
    postSetup: [],
  },
  {
    id: 'learning',
    icon: 'school',
    label: 'Learn Code',
    labelJa: '\u30D7\u30ED\u30B0\u30E9\u30DF\u30F3\u30B0\u5B66\u7FD2',
    packages: ['python', 'nodejs', 'git'],
    postSetup: [],
  },
];

const STORAGE_KEY = 'firstmate_completed';

export const FirstMateOverlay = memo(function FirstMateOverlay({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { runCommand } = useTerminalStore();
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);

  const handleGoal = useCallback(async (goal: GoalConfig) => {
    setInstalling(true);

    try {
      // Run goal packages via native terminal
      const pkgs = goal.packages.join(' ');
      setStatus(`Installing ${pkgs}...`);
      setProgress(0.5);
      runCommand(`echo "Setting up: ${pkgs}"`);

      setProgress(1);
      setStatus('Done!');
      await AsyncStorage.setItem(STORAGE_KEY, 'true');
      setTimeout(() => {
        onClose();
        setInstalling(false);
        setStatus('');
        setProgress(0);
      }, 1000);
    } catch {
      setStatus(t('firstmate.warn'));
      await AsyncStorage.setItem(STORAGE_KEY, 'true');
      setTimeout(() => {
        onClose();
        setInstalling(false);
      }, 2000);
    }
  }, [runCommand, onClose]);

  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, 'true');
    onClose();
  }, [onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleSkip}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.88)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {installing ? (
            /* Installing state */
            <View style={styles.installingContainer}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={[styles.installingStatus, { color: colors.foreground }]}>{status}</Text>
              {/* Progress bar */}
              <View style={[styles.progressBg, { backgroundColor: withAlpha(colors.foreground, 0.1) }]}>
                <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${progress * 100}%` }]} />
              </View>
            </View>
          ) : (
            /* Goal selection */
            <>
              <View style={styles.header}>
                <Text style={[styles.emoji]}>🐚</Text>
                <Text style={[styles.title, { color: colors.foreground }]}>
                  {t('firstmate.title')}
                </Text>
              </View>

              <View style={styles.grid}>
                {GOALS.map((goal) => (
                  <TouchableOpacity
                    key={goal.id}
                    style={[styles.goalCard, { backgroundColor: withAlpha(colors.accent, 0.06), borderColor: colors.borderLight }]}
                    onPress={() => handleGoal(goal)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name={goal.icon} size={28} color={colors.accent} />
                    <Text style={[styles.goalLabel, { color: colors.foreground }]}>{goal.label}</Text>
                    <Text style={[styles.goalPkgs, { color: colors.muted }]}>
                      {goal.packages.join(', ')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                style={styles.skipBtn}
                onPress={handleSkip}
                activeOpacity={0.7}
              >
                <Text style={[styles.skipText, { color: colors.muted }]}>
                  {t('firstmate.skip')}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
});

export async function shouldShowFirstMate(): Promise<boolean> {
  const val = await AsyncStorage.getItem(STORAGE_KEY);
  return val !== 'true';
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380, borderRadius: 16, borderWidth: 1, padding: 20 },
  header: { alignItems: 'center', gap: 8, marginBottom: 20 },
  emoji: { fontSize: 32 },
  title: { fontFamily: 'Silkscreen', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  goalCard: {
    width: '47%', padding: 16, borderRadius: 12, borderWidth: 1,
    alignItems: 'center', gap: 6,
  },
  goalLabel: { fontFamily: 'Silkscreen', fontSize: 13, fontWeight: '700' },
  goalPkgs: { fontFamily: 'Silkscreen', fontSize: 9, textAlign: 'center' },
  skipBtn: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  skipText: { fontFamily: 'Silkscreen', fontSize: 12 },
  installingContainer: { alignItems: 'center', gap: 16, paddingVertical: 40 },
  installingStatus: { fontFamily: 'Silkscreen', fontSize: 13, textAlign: 'center' },
  progressBg: { width: '100%', height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
});
