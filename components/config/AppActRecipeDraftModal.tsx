/**
 * components/config/AppActRecipeDraftModal.tsx
 *
 * app.act Phase 1 (docs/superpowers/DEFERRED.md "段階的汎用化Phase 1":
 * 観測専用accessibility-tree snapshot→レシピ下書き生成→ユーザー保存).
 *
 * Until now, the only way to add a new app.act recipe beyond the two
 * bundled ones (line.send-message / x.post) was to hand-write recipe JSON
 * after reading a logcat node dump. This modal walks a human through the
 * whole loop instead: name the recipe, capture a read-only snapshot of the
 * current screen (bounded to whatever the Accessibility Service's own
 * package allowlist already covers — LINE/X, see
 * ShellyAccessibilityService.captureScreenSnapshot's doc comment), review
 * the drafted steps, then save. Nothing is captured or saved without an
 * explicit tap at each stage — no auto-capture, no auto-save.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import {
  draftAppActRecipeFromSnapshot,
  buildAppActRecipeSaveCommand,
  type AppActSnapshot,
  type AppActRecipeDraft,
} from '@/lib/app-act-recipe-draft';
import { logError } from '@/lib/debug-logger';

type Phase = 'name' | 'capturing' | 'drafted' | 'saving' | 'saved';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function AppActRecipeDraftModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState('');
  const [phase, setPhase] = useState<Phase>('name');
  const [draft, setDraft] = useState<AppActRecipeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDisplayName('');
    setPhase('name');
    setDraft(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleCapture = useCallback(async () => {
    setError(null);
    setPhase('capturing');
    try {
      const raw = await TerminalEmulator.captureAppActScreenSnapshot?.();
      if (!raw) {
        setError(t('app_act_recipe.capture_unavailable'));
        setPhase('name');
        return;
      }
      const snapshot = JSON.parse(raw) as AppActSnapshot;
      const result = draftAppActRecipeFromSnapshot(snapshot, displayName);
      if ('error' in result) {
        setError(result.error);
        setPhase('name');
        return;
      }
      setDraft(result);
      setPhase('drafted');
    } catch (err) {
      logError('AppActRecipeDraftModal', 'capture failed', err);
      setError(t('app_act_recipe.capture_failed'));
      setPhase('name');
    }
  }, [displayName, t]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setError(null);
    setPhase('saving');
    try {
      const cmd = buildAppActRecipeSaveCommand(draft);
      const result = await execCommand(cmd, 15_000);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `exit ${result.exitCode}`);
      }
      setPhase('saved');
    } catch (err) {
      logError('AppActRecipeDraftModal', 'save failed', err);
      setError(t('app_act_recipe.save_failed'));
      setPhase('drafted');
    }
  }, [draft, t]);

  const canCapture = displayName.trim().length > 0 && (phase === 'name' || phase === 'capturing');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <MaterialIcons name="auto-fix-high" size={20} color={colors.accent} />
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {t('app_act_recipe.title')}
            </Text>
            <Pressable onPress={handleClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <MaterialIcons name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={[styles.note, { color: colors.muted }]}>{t('app_act_recipe.allowlist_note')}</Text>

            {phase !== 'saved' && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.accent }]}>{t('app_act_recipe.name_label')}</Text>
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={t('app_act_recipe.name_placeholder')}
                  placeholderTextColor={colors.muted}
                  editable={phase === 'name' || phase === 'capturing'}
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
                />
              </View>
            )}

            {error ? (
              <Text style={[styles.errorText, { color: colors.error }]} selectable>
                {error}
              </Text>
            ) : null}

            {draft && phase !== 'name' ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.accent }]}>{t('app_act_recipe.steps_label')}</Text>
                {draft.steps.map((step, i) => (
                  <Text key={i} style={[styles.sectionText, { color: colors.foreground }]}>
                    {i + 1}. {step.intent}
                  </Text>
                ))}
              </View>
            ) : null}

            {phase === 'saved' ? (
              <Text style={[styles.sectionText, { color: colors.foreground }]} selectable>
                {t('app_act_recipe.saved_body', { id: draft?.id ?? '' })}
              </Text>
            ) : null}
          </ScrollView>

          <View style={[styles.actions, { borderTopColor: colors.border }]}>
            {phase === 'saved' ? (
              <Pressable onPress={handleClose} style={({ pressed }) => [styles.actionBtn, { borderColor: colors.border }, pressed && { backgroundColor: withAlpha(colors.accent, 0.12) }]}>
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t('common.close')}</Text>
              </Pressable>
            ) : (
              <>
                {phase === 'drafted' ? (
                  <Pressable
                    onPress={handleCapture}
                    style={({ pressed }) => [styles.actionBtn, { borderColor: colors.border }, pressed && { backgroundColor: withAlpha(colors.accent, 0.12) }]}
                  >
                    <Text style={[styles.actionText, { color: colors.foreground }]}>{t('app_act_recipe.recapture_button')}</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handleCapture}
                    disabled={!canCapture || phase === 'capturing'}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      { borderColor: colors.border },
                      pressed && canCapture && { backgroundColor: withAlpha(colors.accent, 0.12) },
                      (!canCapture || phase === 'capturing') && styles.actionBtnDisabled,
                    ]}
                  >
                    {phase === 'capturing' ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Text style={[styles.actionText, { color: canCapture ? colors.foreground : colors.muted }]}>
                        {t('app_act_recipe.capture_button')}
                      </Text>
                    )}
                  </Pressable>
                )}
                {draft ? (
                  <Pressable
                    onPress={handleSave}
                    disabled={phase === 'saving'}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      { borderColor: colors.border },
                      pressed && { backgroundColor: withAlpha(colors.accent, 0.12) },
                    ]}
                  >
                    {phase === 'saving' ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Text style={[styles.actionText, { color: colors.foreground }]}>{t('app_act_recipe.save_button')}</Text>
                    )}
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '80%',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: {
    flex: 1,
    fontFamily: F.family,
    fontSize: 14,
    fontWeight: '700',
  },
  body: {
    maxHeight: 420,
  },
  bodyContent: {
    padding: 14,
    gap: 14,
  },
  note: {
    fontFamily: F.family,
    fontSize: 11,
    lineHeight: 16,
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionText: {
    fontFamily: F.family,
    fontSize: 12,
    lineHeight: 18,
  },
  errorText: {
    fontFamily: F.family,
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    fontFamily: F.family,
    fontSize: 13,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  actionBtn: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  actionText: {
    fontFamily: F.family,
    fontSize: 13,
    fontWeight: '600',
  },
});
