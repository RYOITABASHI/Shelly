// components/layout/SettingsDropdown.tsx
//
// Drop-down settings panel anchored to the gear button in AgentBar.
// Consolidates Display (Font/Theme), Language, AI Agents, and API Keys
// that were previously scattered across the top bar.

import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  PanResponder,
  Modal,
  TextInput,
  Alert,
  Image,
  ToastAndroid,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useSettingsStore } from '@/store/settings-store';
import { useI18n, useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { McpSectionWrapper } from '@/components/settings/McpSectionWrapper';
import { LlamaCppSectionWrapper } from '@/components/settings/LlamaCppSectionWrapper';
import { applyThemePreset, themePresets } from '@/lib/theme-presets';
import { logInfo, logError } from '@/lib/debug-logger';
import { execCommand } from '@/hooks/use-native-exec';
import { useAddPane } from '@/hooks/use-add-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { flushAutonomousCloudEnvSync, flushPendingAgentEnvSync } from '@/lib/agent-env-sync';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { DmPairingSection } from '@/components/layout/DmPairingSection';
import { normalizeWebhookHost } from '@/lib/webhook-host-allowlist';
import { resolveAgentOutputPathPreview } from '@/lib/agent-executor';
import type { SocialConnectorMeta, SocialPlatform } from '@/store/types';

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpenBuilds?: () => void;
};

type FontSizePreset = { label: 'S' | 'M' | 'L'; size: number };
const FONT_SIZE_PRESETS: FontSizePreset[] = [
  { label: 'S', size: 12 },
  { label: 'M', size: 14 },
  { label: 'L', size: 16 },
];

function panelChromeStyle() {
  return {
    backgroundColor: C.bgSurface,
    borderColor: C.border,
    shadowColor: C.accent,
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  };
}

function borderedChromeStyle(alpha = 1) {
  return {
    borderColor: alpha >= 1 ? C.border : withAlpha(C.accent, alpha),
    backgroundColor: C.bgSurface,
  };
}

export function SettingsDropdown({ visible, onClose, onOpenBuilds }: Props) {
  const { t } = useTranslation();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [llamaOpen, setLlamaOpen] = useState(false);
  // Deliberately opaque, not wallpaper-transparent: usePanelBackground's own
  // scope is Sidebar/AgentBar/ContextBar/PaneSlot header, not this dense
  // text-heavy settings sheet — wallpaper bleeding through hurt readability.

  // Stable identities so React.memo on UpdatesSection/IntegrationsSection
  // actually skips re-render when this component re-renders for an unrelated
  // reason (e.g. mcpOpen/llamaOpen toggling) — an inline arrow literal here
  // would defeat memo on every render since its identity changes each time.
  const handleOpenBuilds = React.useCallback(() => {
    onOpenBuilds?.();
  }, [onOpenBuilds]);
  const handleOpenMcp = React.useCallback(() => setMcpOpen(true), []);
  const handleOpenLlama = React.useCallback(() => setLlamaOpen(true), []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.panel, panelChromeStyle(), { backgroundColor: C.bgSurface }]} onPress={(e) => e.stopPropagation()}>
          <View style={[styles.header, { backgroundColor: C.bgSidebar, borderBottomColor: C.border }]}>
            <MaterialIcons name="settings" size={13} color={C.accent} />
            <Text style={[styles.headerTitle, { color: C.text1 }]}>{t('settings.title')}</Text>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel={t('settings.close_a11y')}
            >
              <MaterialIcons name="close" size={13} color={C.accent} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            // Perf: this ScrollView renders ~13 always-mounted, non-virtualized
            // section components with no windowing. removeClippedSubviews lets
            // Android detach off-screen native views from the hierarchy instead
            // of keeping them all mounted+drawn, which is the standard fix for
            // long non-virtualized ScrollView content on Android (no-op on iOS).
            removeClippedSubviews
          >
            <DisplaySection />
            <WallpaperSection />
            <LanguageSection />
            <AgentsSection visible={visible} />
            <ApiKeysSection />
            <WebhookHostAllowlistSection />
            <SocialConnectorsSection />
            <DmPairingSection />
            <UpdatesSection onOpenBuilds={handleOpenBuilds} />
            <ScouterSection visible={visible} onCloseSettings={onClose} />
            <CodexLoginSection onClose={onClose} />
            <DoctorSection />
            <ResetSettingsSection />
            <IntegrationsSection
              onOpenMcp={handleOpenMcp}
              onOpenLlama={handleOpenLlama}
            />
            <RecoverySection />
          </ScrollView>
        </Pressable>
      </Pressable>

      <Modal
        visible={mcpOpen}
        animationType="slide"
        onRequestClose={() => setMcpOpen(false)}
      >
        <McpSectionWrapper onClose={() => setMcpOpen(false)} />
      </Modal>

      <Modal
        visible={llamaOpen}
        animationType="slide"
        onRequestClose={() => setLlamaOpen(false)}
      >
        <LlamaCppSectionWrapper onClose={() => setLlamaOpen(false)} />
      </Modal>
    </Modal>
  );
}

// Perf: this file mounts ~13 always-expanded section components in a single
// non-virtualized ScrollView (see SettingsDropdown's ScrollView above). None
// of them were memoized, so any re-render of the shared parent re-rendered
// every section's whole subtree. React.memo is cheap/safe defense-in-depth
// here even though a sibling's local state change shouldn't normally cascade
// up in React — it guards the one case that does cascade: the parent
// SettingsDropdown itself re-rendering (e.g. mcpOpen/llamaOpen toggling).
const UpdatesSection = React.memo(function UpdatesSection({ onOpenBuilds }: { onOpenBuilds: () => void }) {
  const { t } = useTranslation();
  return (
    <Section title={t('updates.title')}>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={onOpenBuilds}
        accessibilityRole="button"
        accessibilityLabel={t('updates.open_a11y')}
      >
        <MaterialIcons name="cloud-download" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('updates.check_for_updates')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
    </Section>
  );
});

const ScouterSection = React.memo(function ScouterSection({ visible, onCloseSettings }: { visible: boolean; onCloseSettings: () => void }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [petBusy, setPetBusy] = useState(false);

  const load = React.useCallback(async () => {
    try {
      const info = await TerminalEmulator.getScouterDebugInfo();
      const parsed = JSON.parse(info);
      setEnabled(Boolean(parsed?.enabled));
      setPort(Number(parsed?.port ?? -1));
    } catch (e: any) {
      logError('SettingsDropdown', 'Failed to load Scouter debug info', e);
    }
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const toggle = React.useCallback(async () => {
    const next = !enabled;
    setBusy(true);
    try {
      await TerminalEmulator.setScouterEnabled(next);
      setEnabled(next);
      await load();
      ToastAndroid.show(next ? t('scouter.enabled') : t('scouter.disabled'), ToastAndroid.SHORT);
      logInfo('SettingsDropdown', 'Scouter enabled=' + next);
    } catch (e: any) {
      Alert.alert(t('scouter.failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to toggle Scouter', e);
    } finally {
      setBusy(false);
    }
  }, [enabled, load, t]);

  const copyDebug = React.useCallback(async () => {
    try {
      const info = await TerminalEmulator.getScouterDebugInfo();
      await Clipboard.setStringAsync(info);
      Alert.alert(t('scouter.debug_title'), `${info.slice(0, 2500)}\n\n${t('common.copied_clipboard')}`);
    } catch (e: any) {
      Alert.alert(t('scouter.debug_failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to get Scouter debug info', e);
    }
  }, [t]);

  const copyHooks = React.useCallback(async () => {
    try {
      if (!enabled || port <= 0) {
        Alert.alert(t('scouter.disabled'), t('scouter.enable_first'));
        return;
      }
      const codex = await TerminalEmulator.getScouterHookTemplate('codex');
      const local = await TerminalEmulator.getScouterHookTemplate('local');
      const text = `Codex:\n${codex}\n\nLocal LLM:\n${local}`;
      await Clipboard.setStringAsync(text);
      Alert.alert(t('scouter.hooks_title'), `${text.slice(0, 2500)}\n\n${t('common.copied_clipboard')}`);
    } catch (e: any) {
      Alert.alert(t('scouter.hooks_failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to get Scouter hook templates', e);
    }
  }, [enabled, port, t]);

  const importPets = React.useCallback(async () => {
    if (!TerminalEmulator.installScouterCodexPetZip) {
      Alert.alert(t('scouter.import_pets_failed'), t('scouter.import_pets_unavailable'));
      return;
    }
    setPetBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const installed = await TerminalEmulator.installScouterCodexPetZip(result.assets[0].uri);
      const ids = installed.installedIds.join(', ');
      Alert.alert(
        t('scouter.import_pets_done_title'),
        t('scouter.import_pets_done_body', {
          count: installed.installedCount,
          ids: ids || '-',
        }),
      );
      await load();
    } catch (e: any) {
      Alert.alert(t('scouter.import_pets_failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to import Scouter Codex pets', e);
    } finally {
      setPetBusy(false);
    }
  }, [load, t]);

  return (
    <Section title={t('scouter.title')}>
      <Row label="Scouter">
        <Pressable
          style={[
            styles.switchTrack,
            { backgroundColor: enabled ? withAlpha(C.accent, 0.36) : C.border },
            busy && styles.integrationRowDisabled,
          ]}
          onPress={toggle}
          disabled={busy}
          hitSlop={4}
        >
          <View
            style={[
              styles.switchThumb,
              { backgroundColor: enabled ? C.accent : C.text2 },
              enabled && { alignSelf: 'flex-end' },
            ]}
          />
        </Pressable>
      </Row>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={copyDebug}
        accessibilityRole="button"
        accessibilityLabel={t('scouter.copy_debug_a11y')}
      >
        <MaterialIcons name="bug-report" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('scouter.copy_debug')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="content-copy" size={14} color={C.text3} />
      </Pressable>
      <View style={styles.credentialGap} />
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={() => {
          onCloseSettings();
          useSettingsStore.getState().setShowScouterDetail(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('scouter.open_monitor_a11y')}
      >
        <MaterialIcons name="desktop-windows" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('scouter.open_monitor')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="open-in-new" size={14} color={C.text3} />
      </Pressable>
      <View style={styles.credentialGap} />
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={copyHooks}
        accessibilityRole="button"
        accessibilityLabel={t('scouter.copy_hooks_a11y')}
      >
        <MaterialIcons name="webhook" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('scouter.copy_hooks')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="content-copy" size={14} color={C.text3} />
      </Pressable>
      <View style={styles.credentialGap} />
      <Pressable
        style={[
          styles.integrationRow,
          borderedChromeStyle(),
          petBusy && styles.integrationRowDisabled,
        ]}
        onPress={importPets}
        disabled={petBusy}
        accessibilityRole="button"
        accessibilityLabel={t('scouter.import_pets_a11y')}
      >
        <MaterialIcons name="pets" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('scouter.import_pets')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="upload-file" size={14} color={C.text3} />
      </Pressable>
    </Section>
  );
});

const IntegrationsSection = React.memo(function IntegrationsSection({
  onOpenMcp,
  onOpenLlama,
}: {
  onOpenMcp: () => void;
  onOpenLlama: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t('integrations.title')}>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={onOpenMcp}
        accessibilityRole="button"
        accessibilityLabel={t('integrations.open_mcp_a11y')}
      >
        <MaterialIcons name="extension" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>MCP Servers</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={onOpenLlama}
        accessibilityRole="button"
        accessibilityLabel={t('integrations.open_llama_a11y')}
      >
        <MaterialIcons name="memory" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>Local LLM · llama.cpp</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
    </Section>
  );
});

// bug #131 + #136 (2026-04-27): user-facing escape hatch surfaced in
// the gear-button SettingsDropdown so it's reachable without opening
// the comprehensive ConfigTUI (which is gated behind the Command
// Palette and harder to find). Original Recovery entry stays in
// ConfigTUI; this is the discoverable mirror.
const RecoverySection = React.memo(function RecoverySection() {
  const { t } = useTranslation();
  const handleRecover = React.useCallback(() => {
    Alert.alert(
      t('recovery.confirm_title'),
      t('recovery.confirm_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('recovery.recover'),
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await TerminalEmulator.forceRecoverFromFrozenState();
              const cleanedCount = Array.isArray(result?.cleaned) ? result.cleaned.length : 0;
              const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
              if (errorCount > 0) {
                Alert.alert(
                  t('recovery.warn_title'),
                  t('recovery.warn_body', { cleaned: cleanedCount, errors: errorCount }) + '\n\n' +
                  (result.errors as string[]).slice(0, 5).join('\n') +
                  (errorCount > 5 ? `\n...+${errorCount - 5} ${t('common.more')}` : ''),
                );
              } else {
                Alert.alert(
                  t('recovery.complete_title'),
                  t('recovery.complete_body', { cleaned: cleanedCount }),
                );
              }
              logInfo('SettingsDropdown', 'forceRecoverFromFrozenState ok=' + result?.ok + ' cleaned=' + cleanedCount + ' errors=' + errorCount);
            } catch (e: any) {
              logError('SettingsDropdown', 'forceRecoverFromFrozenState failed', e);
              Alert.alert(t('recovery.failed'), String(e?.message || e));
            }
          },
        },
      ],
    );
  }, [t]);
  return (
    <Section title={t('recovery.title')}>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={handleRecover}
        accessibilityRole="button"
        accessibilityLabel={t('recovery.action_a11y')}
      >
        <MaterialIcons name="healing" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('recovery.action')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
    </Section>
  );
});

// ─── Wallpaper (Phase B) ─────────────────────────────────────────────────────
//
// User-picked background image + transparency sliders. expo-image-picker
// handles the photo-gallery permission prompt automatically (READ_MEDIA_IMAGES
// on API 33+, READ_EXTERNAL_STORAGE below — Shelly already holds
// MANAGE_EXTERNAL_STORAGE from bug #92 so the prompt is usually skipped).
//
// The picked file is copied into app document storage so it survives cache
// eviction and OS cleanup; the source URI under /data/user/0/.../cache would
// eventually be purged and leave the wallpaper blank.
//
const WallpaperSection = React.memo(function WallpaperSection() {
  const { t } = useTranslation();
  const wallpaperUri = useCosmeticStore((s) => s.wallpaperUri);
  const wallpaperOpacity = useCosmeticStore((s) => s.wallpaperOpacity);
  const panelOpacity = useCosmeticStore((s) => s.panelOpacity);
  const setWallpaper = useCosmeticStore((s) => s.setWallpaper);
  const terminalWallpaperTransparency = useSettingsStore((s) => s.settings.terminalWallpaperTransparency ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setWallpaperOpacity = useCosmeticStore((s) => s.setWallpaperOpacity);
  const setPanelOpacity = useCosmeticStore((s) => s.setPanelOpacity);
  // Note: blurEnabled / blurIntensity still live in cosmetic-store but no
  // UI toggle renders today — there is no chrome BlurView consumer yet,
  // so exposing a toggle would be a dead switch. Store fields stay so the
  // consumer can land later without a persisted-state migration.

  const pick = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          t('wallpaper.permission_title'),
          t('wallpaper.permission_body'),
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        // expo-image-picker 17 deprecated the `MediaTypeOptions.Images`
        // enum in favour of the string-array form; accepting both with a
        // console warning. We use the new form to stay warning-free.
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const picked = result.assets[0];
      // Copy into app document dir so the URI survives cache eviction.
      const ext = picked.uri.split('.').pop()?.split('?')[0] ?? 'jpg';
      const dest = `${FileSystem.documentDirectory}wallpaper-${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: picked.uri, to: dest });
      // Delete the previous wallpaper file (best-effort) so repeated
      // picks don't accumulate orphan files in documentDirectory. Run
      // AFTER the new copy succeeds so a mid-flight crash can't leave
      // the user wallpaper-less.
      if (wallpaperUri) {
        FileSystem.deleteAsync(wallpaperUri, { idempotent: true }).catch(() => {});
      }
      setWallpaper(dest);
    } catch (e) {
      Alert.alert(t('wallpaper.pick_failed'), String((e as Error)?.message ?? e));
    }
  };

  const clear = () => {
    if (!wallpaperUri) return;
    // Best-effort delete; ignore failures (user can always overwrite next pick).
    FileSystem.deleteAsync(wallpaperUri, { idempotent: true }).catch(() => {});
    setWallpaper(null);
  };

  return (
    <Section title={t('wallpaper.title')}>
      <Row label={t('wallpaper.image')}>
        <View style={styles.wallpaperRow}>
          {wallpaperUri ? (
            <Image
              source={{ uri: wallpaperUri }}
              style={[styles.wallpaperPreview, { borderColor: C.border }]}
              // Perf: without an explicit resizeMode, Android decodes the
              // full-resolution user-picked photo before scaling it down to
              // this 28x28 thumbnail, which can hitch a frame when this row
              // scrolls into view. "cover" crops to fit the fixed box.
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.wallpaperPreview, styles.wallpaperPreviewEmpty, { borderColor: C.border, backgroundColor: C.bgDeep }]}>
              <MaterialIcons name="image" size={14} color={C.text3} />
            </View>
          )}
          <Pressable
            style={[styles.wallpaperBtn, { backgroundColor: withAlpha(C.accent, 0.14), borderColor: withAlpha(C.accent, 0.4) }]}
            onPress={pick}
            hitSlop={4}
          >
            <Text style={[styles.wallpaperBtnText, { color: C.accent }]}>
              {wallpaperUri ? t('wallpaper.change') : t('wallpaper.pick')}
            </Text>
          </Pressable>
          {wallpaperUri && (
            <Pressable style={[styles.wallpaperBtn, styles.wallpaperBtnGhost, { borderColor: C.border }]} onPress={clear} hitSlop={4}>
              <Text style={[styles.wallpaperBtnText, { color: C.text2 }]}>{t('common.clear')}</Text>
            </Pressable>
          )}
        </View>
      </Row>

      {wallpaperUri && (
        <>
          <SliderRow
            label={t('wallpaper.image_opacity')}
            value={wallpaperOpacity}
            onChange={setWallpaperOpacity}
          />
          <SliderRow
            label={t('wallpaper.panel_opacity')}
            value={panelOpacity}
            onChange={setPanelOpacity}
          />
          {/* Experimental, default-off — see the field's doc comment in
              store/types.ts for why this is opt-in rather than just
              re-enabling terminal transparency outright. */}
          <Row label={t('wallpaper.terminal_transparency')}>
            <Pressable
              style={[
                styles.switchTrack,
                { backgroundColor: terminalWallpaperTransparency ? withAlpha(C.accent, 0.36) : C.border },
              ]}
              onPress={() => updateSettings({ terminalWallpaperTransparency: !terminalWallpaperTransparency })}
              hitSlop={4}
            >
              <View
                style={[
                  styles.switchThumb,
                  { backgroundColor: terminalWallpaperTransparency ? C.accent : C.text2 },
                  terminalWallpaperTransparency && { alignSelf: 'flex-end' },
                ]}
              />
            </Pressable>
          </Row>
          <Text style={[styles.credentialHint, { color: C.text3 }]}>
            {t('wallpaper.terminal_transparency_hint')}
          </Text>
        </>
      )}
    </Section>
  );
});

/**
 * Small reusable 0-100 slider row. Extracted so WallpaperSection can
 * keep opacity controls consistent without copy-pasting the PanResponder
 * boilerplate.
 */
function SliderRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const trackWidth = 140;
  // Fine-tuning was hard: with a 140px track mapped 1:1 to 0-100%, every
  // pixel of finger jitter was ~0.7%, so small adjustments jumped several
  // percent. Track relative drag distance (gestureState.dx) from the value
  // at gesture-start instead of absolute finger position, and divide by a
  // SENSITIVITY wider than the visible track — same physical drag distance
  // now covers less of the range, without needing a wider (layout-breaking)
  // slider. valueAtGrant is a ref, not state, so onPanResponderMove reads
  // the value as of touch-down rather than a stale closure from render time.
  const SENSITIVITY = trackWidth * 2.5;
  const valueAtGrant = useRef(value);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        valueAtGrant.current = value;
      },
      onPanResponderMove: (_e, gestureState) => {
        const delta = (gestureState.dx / SENSITIVITY) * 100;
        onChange(Math.round(Math.max(0, Math.min(100, valueAtGrant.current + delta))));
      },
    })
  ).current;
  const fillWidth = (value / 100) * trackWidth;
  return (
    <Row label={label}>
      <View style={styles.sliderGroup}>
        <View style={styles.sliderTrackWrap} {...panResponder.panHandlers}>
          <View style={[styles.sliderTrack, { backgroundColor: C.border }]}>
            <View style={[styles.sliderFill, { width: fillWidth, backgroundColor: C.accent }]} />
            <View style={[styles.sliderThumb, { left: fillWidth - 5, backgroundColor: C.accent }]} />
          </View>
        </View>
        <Text style={[styles.sliderPercent, { color: C.text2 }]}>{value}%</Text>
      </View>
    </Row>
  );
}

// ─── Display ─────────────────────────────────────────────────────────────────

const DisplaySection = React.memo(function DisplaySection() {
  const { t } = useTranslation();
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <Section title={t('settings.display')}>
      {/* Font size preset */}
      <Row label={t('settings.font_size')}>
        <View style={[styles.segGroup, { borderColor: C.border }]}>
          {FONT_SIZE_PRESETS.map((p) => {
            const active = fontSize === p.size;
            return (
              <Pressable
                key={p.label}
                style={[
                  styles.segBtn,
                  active && { backgroundColor: withAlpha(C.accent, 0.16) },
                ]}
                onPress={() => updateSettings({ fontSize: p.size })}
                hitSlop={4}
              >
                <Text style={[styles.segLabel, { color: active ? C.accent : C.text2 }]}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Row>

      {/* UI visual preset */}
      <ThemeRow />
    </Section>
  );
});

type UiFontId =
  | 'blue'
  | 'orange'
  | 'purple'
  | 'scouter-green'
  | 'shelly'
  | 'blackline'
  | 'modal'
  | 'silkscreen'
  | 'pixel'
  | 'mono'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'rose-pine'
  | 'kanagawa'
  | 'everforest'
  | 'one-dark';

function ThemeRow() {
  const { t } = useTranslation();
  const rawUiFont = useSettingsStore((s) => s.settings.uiFont ?? 'blue');
  const uiFont: UiFontId =
    rawUiFont === 'shelly' || rawUiFont === 'modal' ? 'purple'
      : rawUiFont === 'blackline' ? 'blue'
        : rawUiFont;
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const options: { value: UiFontId; label: string; swatch: string }[] = [
    { value: 'blue',   label: t('theme.blue'), swatch: themePresets.blue.colors.accent },
    { value: 'orange', label: t('theme.red'), swatch: themePresets.orange.colors.accent },
    { value: 'purple', label: t('theme.purple'), swatch: themePresets.purple.colors.accent },
    { value: 'scouter-green', label: t('theme.scouter_green'), swatch: themePresets['scouter-green'].colors.accent },
  ];
  return (
    <Row label={t('settings.theme')}>
      <View style={[styles.segGroup, { borderColor: C.border }]}>
        {options.map((opt) => {
          const active = uiFont === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[
                styles.segBtn,
                active && { backgroundColor: withAlpha(C.accent, 0.15) },
              ]}
              onPress={() => {
                // Apply synchronously to avoid the AsyncStorage race that
                // caused bug #28/#54.
                applyThemePreset(opt.value);
                updateSettings({ uiFont: opt.value, terminalTheme: opt.value });
              }}
              hitSlop={4}
            >
              <View
                style={[
                  styles.themeSwatch,
                  { backgroundColor: opt.swatch },
                  active && styles.themeSwatchActive,
                  active && { shadowColor: opt.swatch, shadowOpacity: 0.45, shadowRadius: 5 },
                ]}
              />
              <Text style={[styles.segLabel, { color: active ? C.accent : C.text2 }]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Row>
  );
}

// ─── Language ────────────────────────────────────────────────────────────────

const LanguageSection = React.memo(function LanguageSection() {
  const { t } = useTranslation();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);

  return (
    <Section title={t('settings.language')}>
      <View style={styles.langRow}>
        <Pressable
          style={styles.langOption}
          onPress={() => setLocale('en')}
          hitSlop={4}
        >
          <View
            style={[
              styles.radio,
              { borderColor: locale === 'en' ? C.accent : C.text2 },
              locale === 'en' && { backgroundColor: C.accent },
            ]}
          />
          <Text style={[styles.langLabel, { color: locale === 'en' ? C.text1 : C.text2 }]}>EN</Text>
        </Pressable>
        <Pressable
          style={styles.langOption}
          onPress={() => setLocale('ja')}
          hitSlop={4}
        >
          <View
            style={[
              styles.radio,
              { borderColor: locale === 'ja' ? C.accent : C.text2 },
              locale === 'ja' && { backgroundColor: C.accent },
            ]}
          />
          <Text style={[styles.langLabel, { color: locale === 'ja' ? C.text1 : C.text2 }]}>JA</Text>
        </Pressable>
      </View>
    </Section>
  );
});

// ─── AI Agents ───────────────────────────────────────────────────────────────

const DEFAULT_AGENT_OPTIONS: { value: 'cerebras' | 'groq' | 'codex'; label: string }[] = [
  { value: 'cerebras',    label: 'Cerebras' },
  { value: 'groq',        label: 'Groq' },
  { value: 'codex',       label: 'Codex' },
];

const AgentsSection = React.memo(function AgentsSection({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const defaultAgent = useSettingsStore((s) => s.settings.defaultAgent);
  const autoApproveLevel = useSettingsStore((s) => s.settings.autoApproveLevel);
  const cloudConsent = useSettingsStore((s) => s.settings.autonomousCloudConsent ?? false);
  const cloudExhaustion = useSettingsStore((s) => s.settings.autonomousCloudOnExhaustion ?? 'escalate');
  const outputTarget = useSettingsStore((s) => s.settings.agentOutputTarget ?? 'local');
  const vaultPath = useSettingsStore((s) => s.settings.agentVaultPath ?? '');
  const topicFolder = useSettingsStore((s) => s.settings.agentTopicFolder ?? '');
  const customPath = useSettingsStore((s) => s.settings.agentCustomPath ?? '');
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Local edit state for the path fields so each keystroke doesn't trigger an
  // .env sync; commit on blur (onEndEditing).
  const [vaultDraft, setVaultDraft] = React.useState(vaultPath);
  const [topicDraft, setTopicDraft] = React.useState(topicFolder);
  const [customDraft, setCustomDraft] = React.useState(customPath);
  const [cloudSyncBusy, setCloudSyncBusy] = React.useState(false);
  const cloudSyncBusyRef = React.useRef(false);
  React.useEffect(() => setVaultDraft(vaultPath), [vaultPath]);
  React.useEffect(() => setTopicDraft(topicFolder), [topicFolder]);
  React.useEffect(() => setCustomDraft(customPath), [customPath]);

  const cycleOutputTarget = () => {
    const order = ['local', 'obsidian', 'custom'] as const;
    const next = order[(order.indexOf(outputTarget) + 1) % order.length];
    updateSettings({ agentOutputTarget: next });
    void flushPendingAgentEnvSync('Agent Output');
  };

  const currentLabel =
    DEFAULT_AGENT_OPTIONS.find((o) => o.value === defaultAgent)?.label ?? 'Codex';

  const toggleAutoApprove = () => {
    const next = autoApproveLevel === 'none' ? 'safe' : 'none';
    updateSettings({ autoApproveLevel: next as any });
  };

  const autoOn = autoApproveLevel !== 'none';

  // N1: enabling autonomous cloud needs informed consent — an unattended agent
  // will spend your cloud quota/cost without asking each time.
  const toggleCloudConsent = async () => {
    if (cloudSyncBusyRef.current) return;
    cloudSyncBusyRef.current = true;
    setCloudSyncBusy(true);
    try {
      if (!cloudConsent) {
        const ok = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('agents.cloud_consent_title'),
            t('agents.cloud_consent_body'),
            [
              { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('agents.cloud_consent_enable'), style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
        if (!ok) return;
      }
      updateSettings({ autonomousCloudConsent: !cloudConsent });
      // Consent flush also re-bakes autonomous agents' on-disk scripts so a
      // scheduled fire picks up the toggle immediately (N1 follow-up).
      await flushAutonomousCloudEnvSync('Autonomous Cloud');
    } finally {
      cloudSyncBusyRef.current = false;
      setCloudSyncBusy(false);
    }
  };

  const toggleExhaustion = async () => {
    if (cloudSyncBusyRef.current) return;
    cloudSyncBusyRef.current = true;
    setCloudSyncBusy(true);
    try {
      updateSettings({ autonomousCloudOnExhaustion: cloudExhaustion === 'stop' ? 'escalate' : 'stop' });
      await flushAutonomousCloudEnvSync('Autonomous Cloud');
    } finally {
      cloudSyncBusyRef.current = false;
      setCloudSyncBusy(false);
    }
  };

  const [notificationTriggerEnabled, setNotificationTriggerEnabled] = React.useState(false);
  const [notificationTriggerBusy, setNotificationTriggerBusy] = React.useState(false);

  const loadNotificationTrigger = React.useCallback(async () => {
    try {
      const enabled = await TerminalEmulator.getNotificationTriggerEnabled();
      setNotificationTriggerEnabled(enabled);
    } catch (e: any) {
      logError('SettingsDropdown', 'Failed to load notification-trigger flag', e);
    }
  }, []);

  useEffect(() => {
    if (visible) loadNotificationTrigger();
  }, [visible, loadNotificationTrigger]);

  const toggleNotificationTrigger = React.useCallback(async () => {
    const next = !notificationTriggerEnabled;
    setNotificationTriggerBusy(true);
    try {
      await TerminalEmulator.setNotificationTriggerEnabled(next);
      setNotificationTriggerEnabled(next);
      ToastAndroid.show(
        next ? t('agents.notification_trigger_enabled') : t('agents.notification_trigger_disabled'),
        ToastAndroid.SHORT,
      );
      logInfo('SettingsDropdown', 'notificationTriggerEnabled=' + next);
    } catch (e: any) {
      Alert.alert(t('agents.notification_trigger_failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to toggle notification trigger', e);
    } finally {
      setNotificationTriggerBusy(false);
    }
  }, [notificationTriggerEnabled, t]);

  const checkNotificationOsAccess = React.useCallback(async () => {
    try {
      const granted = await TerminalEmulator.hasNotificationListenerAccess();
      if (granted) {
        Alert.alert(t('agents.notification_os_access_title'), t('agents.notification_os_access_granted'));
      } else {
        Alert.alert(
          t('agents.notification_os_access_title'),
          t('agents.notification_os_access_not_granted'),
          [
            {
              text: t('agents.notification_os_access_open_settings'),
              onPress: () => TerminalEmulator.requestNotificationListenerAccess(),
            },
          ],
        );
      }
    } catch (e: any) {
      Alert.alert(t('agents.notification_os_access_failed'), String(e?.message || e));
      logError('SettingsDropdown', 'Failed to check notification OS access', e);
    }
  }, [t]);

  return (
    <Section title={t('agents.title')}>
      <Row label={t('agents.default')}>
        <Pressable
          style={[styles.defaultAgentBtn, { borderColor: withAlpha(C.accent, 0.38), backgroundColor: withAlpha(C.accent, 0.08) }]}
          onPress={() => setPickerOpen((v) => !v)}
          hitSlop={4}
        >
          <Text style={[styles.defaultAgentLabel, { color: C.text1 }]}>{currentLabel}</Text>
          <MaterialIcons
            name={pickerOpen ? 'arrow-drop-up' : 'arrow-drop-down'}
            size={14}
            color={C.text2}
          />
        </Pressable>
      </Row>
      {pickerOpen && (
        <View style={[styles.defaultAgentPicker, { borderColor: C.border, backgroundColor: C.bgDeep }]}>
          {DEFAULT_AGENT_OPTIONS.map((opt) => {
            const active = opt.value === defaultAgent;
            return (
              <Pressable
                key={opt.value}
                style={[styles.pickerRow, active && { backgroundColor: withAlpha(C.accent, 0.10) }]}
                onPress={() => {
                  updateSettings({ defaultAgent: opt.value });
                  setPickerOpen(false);
                }}
              >
                <Text style={[styles.pickerLabel, { color: active ? C.accent : C.text2 }, active && { fontWeight: '700' }]}>
                  {opt.label}
                </Text>
                {active && <MaterialIcons name="check" size={11} color={C.accent} />}
              </Pressable>
            );
          })}
        </View>
      )}
      <Row label={t('agents.auto_approve')}>
        <Pressable
          style={[
            styles.switchTrack,
            { backgroundColor: autoOn ? withAlpha(C.accent, 0.36) : C.border },
          ]}
          onPress={toggleAutoApprove}
          hitSlop={4}
        >
          <View
            style={[
              styles.switchThumb,
              { backgroundColor: autoOn ? C.accent : C.text2 },
              autoOn && { alignSelf: 'flex-end' },
            ]}
          />
        </Pressable>
      </Row>
      <Row label={t('agents.autonomous_cloud')}>
        <Pressable
          style={[
            styles.switchTrack,
            { backgroundColor: cloudConsent ? withAlpha(C.accent, 0.36) : C.border },
            cloudSyncBusy && { opacity: 0.5 },
          ]}
          onPress={toggleCloudConsent}
          disabled={cloudSyncBusy}
          hitSlop={4}
        >
          <View
            style={[
              styles.switchThumb,
              { backgroundColor: cloudConsent ? C.accent : C.text2 },
              cloudConsent && { alignSelf: 'flex-end' },
            ]}
          />
        </Pressable>
      </Row>
      {cloudConsent && (
        <Row label={t('agents.cloud_on_exhaustion')}>
          <Pressable
            style={[styles.defaultAgentBtn, { borderColor: withAlpha(C.accent, 0.38), backgroundColor: withAlpha(C.accent, 0.08) }, cloudSyncBusy && { opacity: 0.5 }]}
            onPress={toggleExhaustion}
            disabled={cloudSyncBusy}
            hitSlop={4}
          >
            <Text style={[styles.defaultAgentLabel, { color: C.text1 }]}>
              {cloudExhaustion === 'stop' ? t('agents.cloud_exhaust_stop') : t('agents.cloud_exhaust_escalate')}
            </Text>
          </Pressable>
        </Row>
      )}
      <Row label={t('agents.notification_trigger')}>
        <Pressable
          style={[
            styles.switchTrack,
            { backgroundColor: notificationTriggerEnabled ? withAlpha(C.accent, 0.36) : C.border },
            notificationTriggerBusy && styles.integrationRowDisabled,
          ]}
          onPress={toggleNotificationTrigger}
          disabled={notificationTriggerBusy}
          hitSlop={4}
        >
          <View
            style={[
              styles.switchThumb,
              { backgroundColor: notificationTriggerEnabled ? C.accent : C.text2 },
              notificationTriggerEnabled && { alignSelf: 'flex-end' },
            ]}
          />
        </Pressable>
      </Row>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={checkNotificationOsAccess}
        accessibilityRole="button"
        accessibilityLabel={t('agents.notification_os_access_a11y')}
      >
        <MaterialIcons name="notifications" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('agents.notification_os_access')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
      <Row label={t('agents.output_target')}>
        <Pressable
          style={[styles.defaultAgentBtn, { borderColor: withAlpha(C.accent, 0.38), backgroundColor: withAlpha(C.accent, 0.08) }]}
          onPress={cycleOutputTarget}
          hitSlop={4}
        >
          <Text style={[styles.defaultAgentLabel, { color: C.text1 }]}>{t(`agents.output_${outputTarget}`)}</Text>
        </Pressable>
      </Row>
      {outputTarget === 'obsidian' && (
        <TextInput
          value={vaultDraft}
          onChangeText={setVaultDraft}
          onEndEditing={() => {
            updateSettings({ agentVaultPath: vaultDraft.trim() });
            void flushPendingAgentEnvSync('Agent Output');
          }}
          style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
          placeholder={t('agents.vault_path_ph')}
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      )}
      {outputTarget === 'custom' && (
        <TextInput
          value={customDraft}
          onChangeText={setCustomDraft}
          onEndEditing={() => {
            updateSettings({ agentCustomPath: customDraft.trim() });
            void flushPendingAgentEnvSync('Agent Output');
          }}
          style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
          placeholder={t('agents.custom_path_ph')}
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      )}
      {(outputTarget === 'obsidian' || outputTarget === 'custom') && (
        <TextInput
          value={topicDraft}
          onChangeText={setTopicDraft}
          onEndEditing={() => {
            updateSettings({ agentTopicFolder: topicDraft.trim() });
            void flushPendingAgentEnvSync('Agent Output');
          }}
          style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
          placeholder={t('agents.topic_folder_ph')}
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      )}
      {/* Read-only preview of the CURRENTLY RESOLVED save path, mirroring the
          exact OUT_BASE/SAVED_FILE resolution save_draft_result() runs on-device
          (lib/agent-executor.ts's resolveAgentOutputPathPreview). `<date>` and
          `<title>` are literal placeholders — both are only known at the moment
          an agent actually saves, never guessed here. */}
      <Text style={[styles.apiKeyHint, { marginTop: 6, color: C.text2 }]}>
        {t('agents.output_resolved_path', {
          path: resolveAgentOutputPathPreview(
            {
              agentOutputTarget: outputTarget,
              agentVaultPath: vaultPath,
              agentTopicFolder: topicFolder,
              agentCustomPath: customPath,
            },
            '<title>',
          ),
        })}
      </Text>
      <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{t('agents.output_resolved_path_hint')}</Text>
    </Section>
  );
});

// ─── API Keys ────────────────────────────────────────────────────────────────

type ApiKeyFieldKey = 'geminiApiKey' | 'cerebrasApiKey' | 'groqApiKey' | 'perplexityApiKey';

type ApiKeyField = {
  key: ApiKeyFieldKey;
  label: string;
  hint: string;
};

const API_KEY_FIELDS: ApiKeyField[] = [
  { key: 'geminiApiKey',     label: 'Gemini',     hint: 'aistudio.google.com/app/apikey' },
  { key: 'cerebrasApiKey',   label: 'Cerebras',   hint: 'cloud.cerebras.ai' },
  { key: 'groqApiKey',       label: 'Groq',       hint: 'console.groq.com' },
  { key: 'perplexityApiKey', label: 'Perplexity', hint: 'perplexity.ai/settings/api' },
];

function maskKey(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return value.slice(0, 4) + '…' + value.slice(-4);
}

function ApiKeyRow({ field }: { field: ApiKeyField }) {
  const { t } = useTranslation();
  const stored = useSettingsStore((s) => (s.settings[field.key] as string | undefined) ?? '');
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stored);
  const [reveal, setReveal] = useState(false);

  // Keep draft in sync when stored value changes externally
  useEffect(() => {
    if (!editing) setDraft(stored);
  }, [stored, editing]);

  const hasStored = stored.trim().length > 0;

  const handleSave = async () => {
    const trimmed = draft.trim();
    updateSettings({ [field.key]: trimmed } as Record<string, string>);
    await flushPendingAgentEnvSync(field.label);
    setEditing(false);
    setReveal(false);
  };

  const handleCancel = () => {
    setDraft(stored);
    setEditing(false);
    setReveal(false);
  };

  const handleClear = async () => {
    updateSettings({ [field.key]: '' } as Record<string, string>);
    await flushPendingAgentEnvSync(field.label);
    setDraft('');
    setEditing(false);
    setReveal(false);
  };

  if (!editing) {
    return (
      <View style={[styles.apiKeyRow, { borderTopColor: C.border }]}>
        <View style={styles.apiKeyRowHead}>
          <Text style={[styles.apiKeyLabel, { color: C.text1 }]}>{field.label}</Text>
          {hasStored ? (
            <View style={styles.statusOn}>
              <MaterialIcons name="check" size={10} color={C.accent} />
              <Text style={[styles.statusOnText, { color: C.accent }]}>{maskKey(stored)}</Text>
            </View>
          ) : (
            <Text style={[styles.statusOff, { color: C.text3 }]}>{t('common.not_set')}</Text>
          )}
        </View>
        <View style={styles.apiKeyActions}>
          <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{field.hint}</Text>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => setEditing(true)}
            style={[styles.apiKeyBtn, { borderColor: C.border }]}
            hitSlop={6}
          >
            <Text style={[styles.apiKeyBtnText, { color: C.text2 }]}>
              {hasStored ? t('common.edit') : t('common.set')}
            </Text>
          </Pressable>
          {hasStored && (
            <Pressable
              onPress={handleClear}
              style={[styles.apiKeyBtn, { borderColor: C.border }]}
              hitSlop={6}
            >
              <Text style={[styles.apiKeyBtnText, { color: C.text2 }]}>{t('common.clear')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.apiKeyRow, { borderTopColor: C.border }]}>
      <View style={styles.apiKeyRowHead}>
        <Text style={[styles.apiKeyLabel, { color: C.text1 }]}>{field.label}</Text>
        <Pressable
          onPress={() => setReveal((v) => !v)}
          hitSlop={6}
          style={styles.eyeBtn}
        >
          <MaterialIcons
            name={reveal ? 'visibility-off' : 'visibility'}
            size={12}
            color={C.text2}
          />
        </Pressable>
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
        placeholder={t('api_keys.paste_placeholder', { name: field.label })}
        placeholderTextColor={C.text3}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        secureTextEntry={!reveal}
        selectTextOnFocus
      />
      <View style={styles.apiKeyActions}>
        <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{field.hint}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={handleCancel} style={[styles.apiKeyBtn, { borderColor: C.border }]} hitSlop={6}>
          <Text style={[styles.apiKeyBtnText, { color: C.text2 }]}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          style={[styles.apiKeyBtn, { backgroundColor: C.accent, borderColor: C.accent }]}
          hitSlop={6}
        >
          <Text style={[styles.apiKeyBtnText, { color: C.bgDeep }]}>
            {t('common.save')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const ApiKeysSection = React.memo(function ApiKeysSection() {
  const { t } = useTranslation();
  return (
    <Section title={t('api_keys.title')}>
      {API_KEY_FIELDS.map((f) => (
        <ApiKeyRow key={f.key} field={f} />
      ))}
    </Section>
  );
});

const WebhookHostAllowlistSection = React.memo(function WebhookHostAllowlistSection() {
  const { t } = useTranslation();
  const hosts = useSettingsStore((s) => s.settings.webhookHostAllowlist ?? []);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [draft, setDraft] = useState('');

  const persist = async (next: string[]) => {
    updateSettings({ webhookHostAllowlist: next });
    await flushPendingAgentEnvSync(t('webhook_allowlist.title'));
  };

  const addHost = async () => {
    const host = normalizeWebhookHost(draft);
    if (!host) {
      Alert.alert(t('webhook_allowlist.invalid'));
      return;
    }
    if (!hosts.includes(host)) await persist([...hosts, host]);
    setDraft('');
  };

  return (
    <Section title={t('webhook_allowlist.title')}>
      <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{t('webhook_allowlist.description')}</Text>
      {hosts.map((host) => (
        <View key={host} style={[styles.integrationRow, borderedChromeStyle()]}>
          <MaterialIcons name="verified-user" size={13} color={C.accent} />
          <Text selectable style={[styles.integrationLabel, { color: C.text1 }]}>{host}</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => void persist(hosts.filter((item) => item !== host))} hitSlop={8}>
            <MaterialIcons name="delete-outline" size={15} color={C.errorText} />
          </Pressable>
        </View>
      ))}
      <View style={styles.apiKeyEditRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void addHost()}
          style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
          placeholder={t('webhook_allowlist.placeholder')}
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        <Pressable onPress={() => void addHost()} style={[styles.apiKeyBtn, { backgroundColor: C.accent, borderColor: C.accent }]} hitSlop={6}>
          <Text style={[styles.apiKeyBtnText, { color: C.bgDeep }]}>{t('webhook_allowlist.add')}</Text>
        </Pressable>
      </View>
    </Section>
  );
});

// ─── Social Connectors ───────────────────────────────────────────────────────
// Credential-registration UI for the free-API social/publishing dispatch path
// (agent action type 'social-post' in AgentConfirmCard.tsx — see
// store/types.ts's AgentSocialPostConfig / SocialConnectorMeta). This is
// metadata-only: SocialConnectorMeta never carries a secret value, so nothing
// rendered here needs masking — the actual credential goes straight into
// SecureStore via addSocialConnector's second (secrets) argument and this
// component never reads it back.

const SOCIAL_PLATFORMS: SocialPlatform[] = ['discord', 'slack', 'telegram', 'mastodon', 'misskey', 'wordpress', 'bluesky'];

const SOCIAL_PLATFORM_ICON: Record<SocialPlatform, React.ComponentProps<typeof MaterialIcons>['name']> = {
  discord: 'forum',
  slack: 'groups',
  telegram: 'send',
  mastodon: 'public',
  misskey: 'chat-bubble',
  wordpress: 'article',
  bluesky: 'cloud',
};

// Field NAMES here must match Track A's dispatch code exactly — it reads the
// SecureStore secret for each connector by these keys, so this list is the
// single source of truth for what the add-connector form collects per
// platform (feature spec's per-platform field table).
const SOCIAL_PLATFORM_META: Record<SocialPlatform, {
  fields: string[];
  /** Host is fixed and baked in silently — never shown as an input. */
  fixedHost?: string;
  /** Host is user-instance-specific but has a sane prefilled default. */
  defaultHost?: string;
}> = {
  discord:   { fields: ['webhookUrl'], fixedHost: 'discord.com' },
  slack:     { fields: ['webhookUrl'], fixedHost: 'hooks.slack.com' },
  telegram:  { fields: ['botToken', 'chatId'], fixedHost: 'api.telegram.org' },
  mastodon:  { fields: ['accessToken'] },
  misskey:   { fields: ['apiToken'] },
  wordpress: { fields: ['username', 'appPassword'] },
  bluesky:   { fields: ['handle', 'appPassword'], defaultHost: 'bsky.social' },
};

const SOCIAL_ID_RE = /^[a-z0-9-]+$/;

type TFunc = (key: string, params?: Record<string, string | number>) => string;

function SocialConnectorRow({
  connector,
  onRemove,
  t,
}: {
  connector: SocialConnectorMeta;
  onRemove: () => void;
  t: TFunc;
}) {
  return (
    <View style={[styles.integrationRow, borderedChromeStyle()]}>
      <MaterialIcons name={SOCIAL_PLATFORM_ICON[connector.platform]} size={13} color={C.text2} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.integrationLabel, { color: C.text1 }]} numberOfLines={1}>
          {connector.label}
        </Text>
        <Text style={[styles.apiKeyHint, { color: C.text3 }]} numberOfLines={1}>
          {t(`social_connectors.platform_${connector.platform}`)} · {connector.host}
        </Text>
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('social_connectors.remove_a11y')}
      >
        <MaterialIcons name="delete-outline" size={15} color={C.errorText} />
      </Pressable>
    </View>
  );
}

// Inline "add connector" form: platform picker (dropdown, mirrors
// AgentsSection's default-agent picker) → label/id/host + exactly that
// platform's secret fields (masked, mirrors ApiKeyRow's editing state).
function SocialConnectorAddForm({
  existingIds,
  onDone,
  t,
}: {
  existingIds: string[];
  onDone: () => void;
  t: TFunc;
}) {
  const [platform, setPlatform] = useState<SocialPlatform | null>(null);
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false);
  const [idDraft, setIdDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [hostDraft, setHostDraft] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectPlatform = (p: SocialPlatform) => {
    setPlatform(p);
    setPlatformPickerOpen(false);
    setHostDraft(SOCIAL_PLATFORM_META[p].defaultHost ?? '');
    setFieldValues({});
    setError(null);
  };

  const handleSave = async () => {
    if (!platform) return;
    const meta = SOCIAL_PLATFORM_META[platform];
    const id = idDraft.trim().toLowerCase();
    const label = labelDraft.trim();
    const host = meta.fixedHost ?? hostDraft.trim();
    if (!SOCIAL_ID_RE.test(id)) {
      setError(t('social_connectors.id_invalid'));
      return;
    }
    if (existingIds.includes(id)) {
      setError(t('social_connectors.id_duplicate'));
      return;
    }
    if (!label) {
      setError(t('social_connectors.label_required'));
      return;
    }
    if (!meta.fixedHost && !host) {
      setError(t('social_connectors.host_required'));
      return;
    }
    const missingField = meta.fields.find((f) => !(fieldValues[f] ?? '').trim());
    if (missingField) {
      setError(t('social_connectors.field_required', { field: t(`social_connectors.field_${missingField}`) }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const secrets: Record<string, string> = {};
      for (const f of meta.fields) secrets[f] = (fieldValues[f] ?? '').trim();
      await useSettingsStore.getState().addSocialConnector(
        { id, platform, label, host, fields: meta.fields },
        secrets,
      );
      ToastAndroid.show(t('social_connectors.added_toast', { label }), ToastAndroid.SHORT);
      onDone();
    } catch (e: any) {
      // Keep the form open (all drafts intact) so the user can fix and retry
      // — same convention as Sidebar's skill-import failure handling.
      setError(String(e?.message || e));
      logError('SettingsDropdown', 'addSocialConnector failed', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ marginTop: 4 }}>
      <Pressable
        style={[styles.defaultAgentBtn, { borderColor: withAlpha(C.accent, 0.38), backgroundColor: withAlpha(C.accent, 0.08) }]}
        onPress={() => setPlatformPickerOpen((v) => !v)}
        hitSlop={4}
      >
        <Text style={[styles.defaultAgentLabel, { color: C.text1 }]}>
          {platform ? t(`social_connectors.platform_${platform}`) : t('social_connectors.select_platform')}
        </Text>
        <MaterialIcons name={platformPickerOpen ? 'arrow-drop-up' : 'arrow-drop-down'} size={14} color={C.text2} />
      </Pressable>
      {platformPickerOpen && (
        <View style={[styles.defaultAgentPicker, { borderColor: C.border, backgroundColor: C.bgDeep }]}>
          {SOCIAL_PLATFORMS.map((p) => {
            const active = p === platform;
            return (
              <Pressable
                key={p}
                style={[styles.pickerRow, active && { backgroundColor: withAlpha(C.accent, 0.10) }]}
                onPress={() => selectPlatform(p)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <MaterialIcons name={SOCIAL_PLATFORM_ICON[p]} size={12} color={active ? C.accent : C.text2} />
                  <Text style={[styles.pickerLabel, { color: active ? C.accent : C.text2 }, active && { fontWeight: '700' }]}>
                    {t(`social_connectors.platform_${p}`)}
                  </Text>
                </View>
                {active && <MaterialIcons name="check" size={11} color={C.accent} />}
              </Pressable>
            );
          })}
        </View>
      )}
      {platform && (
        <>
          <Text style={[styles.credentialHint, { color: C.text2 }]}>{t(`social_connectors.hint_${platform}`)}</Text>
          <TextInput
            value={labelDraft}
            onChangeText={setLabelDraft}
            style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
            placeholder={t('social_connectors.label_placeholder')}
            placeholderTextColor={C.text3}
            autoCorrect={false}
            spellCheck={false}
          />
          <TextInput
            value={idDraft}
            onChangeText={setIdDraft}
            style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
            placeholder={t('social_connectors.id_placeholder')}
            placeholderTextColor={C.text3}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          {!SOCIAL_PLATFORM_META[platform].fixedHost && (
            <TextInput
              value={hostDraft}
              onChangeText={setHostDraft}
              style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
              placeholder={t('social_connectors.host_placeholder')}
              placeholderTextColor={C.text3}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          )}
          {SOCIAL_PLATFORM_META[platform].fields.map((f) => (
            <TextInput
              key={f}
              value={fieldValues[f] ?? ''}
              onChangeText={(v) => setFieldValues((prev) => ({ ...prev, [f]: v }))}
              style={[styles.apiKeyInput, { backgroundColor: C.bgDeep, borderColor: C.border, color: C.text1 }]}
              placeholder={t(`social_connectors.field_${f}`)}
              placeholderTextColor={C.text3}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              secureTextEntry={!reveal}
            />
          ))}
          {error && <Text style={[styles.apiKeyHint, { color: C.errorText, marginTop: 4 }]}>{error}</Text>}
          <View style={styles.apiKeyActions}>
            <Pressable onPress={() => setReveal((v) => !v)} hitSlop={6} style={styles.eyeBtn}>
              <MaterialIcons name={reveal ? 'visibility-off' : 'visibility'} size={12} color={C.text2} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={onDone} style={[styles.apiKeyBtn, { borderColor: C.border }]} hitSlop={6}>
              <Text style={[styles.apiKeyBtnText, { color: C.text2 }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void handleSave()}
              disabled={saving}
              style={[styles.apiKeyBtn, { backgroundColor: C.accent, borderColor: C.accent }, saving && { opacity: 0.6 }]}
              hitSlop={6}
            >
              <Text style={[styles.apiKeyBtnText, { color: C.bgDeep }]}>
                {saving ? t('social_connectors.saving') : t('common.save')}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const SocialConnectorsSection = React.memo(function SocialConnectorsSection() {
  const { t } = useTranslation();
  const connectors = useSettingsStore((s) => s.socialConnectors ?? []);
  const removeSocialConnector = useSettingsStore((s) => s.removeSocialConnector);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Section title={t('social_connectors.title')}>
      <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{t('social_connectors.description')}</Text>
      {connectors.length === 0 && !addOpen && (
        <Text style={[styles.credentialHint, { color: C.text2 }]}>{t('social_connectors.empty')}</Text>
      )}
      {connectors.map((connector: SocialConnectorMeta, i: number) => (
        <React.Fragment key={connector.id}>
          {i > 0 && <View style={styles.credentialGap} />}
          <SocialConnectorRow connector={connector} onRemove={() => void removeSocialConnector(connector.id)} t={t} />
        </React.Fragment>
      ))}
      {connectors.length > 0 && <View style={styles.credentialGap} />}
      {addOpen ? (
        <SocialConnectorAddForm
          existingIds={connectors.map((c: SocialConnectorMeta) => c.id)}
          onDone={() => setAddOpen(false)}
          t={t}
        />
      ) : (
        <Pressable style={styles.manageBtn} onPress={() => setAddOpen(true)} hitSlop={4}>
          <Text style={[styles.manageBtnText, { color: C.accent }]}>{t('social_connectors.add_button')}</Text>
        </Pressable>
      )}
    </Section>
  );
});

// ─── Codex login (ChatGPT subscription device-auth) ─────────────────────────
// Minimal trigger for the existing `codex-login --open` flow defined in
// HomeInitializer.kt:1493 and implemented in assets/shelly-codex-auth.js.
// Tapping the button closes this Modal, spawns a fresh terminal pane, and
// queues `codex-login --open` so the user sees the device code, browser
// pane opens via the shelly://browser deep link, and ~/.codex/auth.json
// (mode 0600) is written on success. Verification is delegated to
// shelly-doctor (which already reports `codex auth: <exists|missing>`).

const CodexLoginSection = React.memo(function CodexLoginSection({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const addPane = useAddPane();

  const start = React.useCallback(() => {
    Alert.alert(
      t('codex_login.confirm_title'),
      t('codex_login.confirm_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('codex_login.sign_in'),
          onPress: () => {
            const result = addPane('terminal');
            if (result !== null) return; // useAddPane already alerted
            const sessionId = useTerminalStore.getState().activeSessionId;
            useTerminalStore.getState().insertCommand('codex-login --open\n', sessionId);
            logInfo('SettingsDropdown', 'codex-login launched');
            onClose();
          },
        },
      ],
    );
  }, [addPane, onClose, t]);

  return (
    <Section title={t('codex_login.title')}>
      <Text style={[styles.credentialHint, { color: C.text2 }]}>
        {t('codex_login.description')}
      </Text>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle()]}
        onPress={start}
        accessibilityRole="button"
        accessibilityLabel={t('codex_login.sign_in_a11y')}
      >
        <MaterialIcons name="login" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{t('codex_login.sign_in_chatgpt')}</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
    </Section>
  );
});

// ─── Doctor ──────────────────────────────────────────────────────────────────
// bug #122 minimal slice (DEFERRED.md, 2026-07-16): `shelly-doctor --json`
// already exists (bashrc v48, modules/terminal-emulator/.../shelly-doctor.js)
// and checks native binaries, codex tui/js/auth, local LLM endpoints, and
// security posture (leftover Download credentials, private-file mode, env
// key leaks) — but had zero UI surface, only reachable by typing
// `shelly-doctor` in a terminal pane. This wires a single Settings row that
// runs it via execCommand() and renders the parsed JSON as an OK/WARN list
// modal. Deliberately NOT the full DoctorPane / ContextBar health icon / 24h
// background tick from the original bug #122 scope (see DEFERRED.md for the
// descoped items and rationale).
//
// Invocation note: execCommand()'s non-interactive shell does not source
// ~/.bashrc (see TerminalEmulatorModule.execCommand's comment), so the
// `shelly-doctor()` bash alias (`SHELLY_LIB_DIR="$libDir" _run $libDir/node
// "$HOME/.shelly-doctor.js" "$@"`) isn't reachable here. DOCTOR_CMD below
// inlines the same resolve-then-linker64-exec pattern used everywhere else
// node is invoked in this codebase (see shelly_run_app_binary /
// shelly_node in lib/agent-executor.ts's generated bash script): resolve the
// node binary via PATH (execCommand already exports PATH to include the
// extracted lib dir), then exec it through /system/bin/linker64 with
// LD_LIBRARY_PATH pointed at its directory, rather than relying on a bare
// `node ...` PATH-exec working directly.
//
// `dirname` is NOT a real PATH binary here: HomeInitializer.kt only defines
// it (and every other coreutils applet) as a .bashrc FUNCTION
// (`dirname() { _run $libDir/coreutils --coreutils-prog=dirname "$@"; }`,
// see COREUTILS_APPLETS), which this non-interactive shell never sources —
// the exact same class of gap already called out above for the
// `shelly-doctor()` alias itself. Use bash's own `${VAR%/*}` suffix-strip
// parameter expansion instead, which needs no external command. Built as a
// plain string (not a template literal) so there is no JS `${...}`
// interpolation hazard to escape around.
type DoctorFinding = { label: string; ok: boolean; detail?: string };

const DOCTOR_CMD = [
  'set -e',
  'NODE_BIN="$(command -v node 2>/dev/null || true)"',
  'if [ -z "$NODE_BIN" ]; then',
  '  echo \'{"__error":"node binary not found on PATH"}\'',
  '  exit 0',
  'fi',
  'NODE_DIR="${NODE_BIN%/*}"',
  'if [ -x /system/bin/linker64 ]; then',
  '  SHELLY_LIB_DIR="$NODE_DIR" LD_LIBRARY_PATH="$NODE_DIR" /system/bin/linker64 "$NODE_BIN" "$HOME/.shelly-doctor.js" --json',
  'else',
  '  SHELLY_LIB_DIR="$NODE_DIR" "$NODE_BIN" "$HOME/.shelly-doctor.js" --json',
  'fi',
].join('\n');

// Mirrors shelly-doctor.js's own printHuman() OK/WARN judgment (native
// binaries + codex tui/js exist checks, download-credential leftovers,
// private-file mode, env key leaks) but reshaped into a flat findings list
// so the modal can just group by `ok` instead of duplicating per-field
// formatting logic.
function buildDoctorFindings(data: any, t: (key: string, opts?: Record<string, any>) => string): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const native = data?.native ?? {};
  findings.push({ label: t('doctor.check_node'), ok: Boolean(native.node?.exists) });
  findings.push({ label: t('doctor.check_bash'), ok: Boolean(native.bash?.exists) });
  findings.push({ label: t('doctor.check_exec_wrapper'), ok: Boolean(native.execWrapper?.exists) });
  findings.push({ label: t('doctor.check_xdg_open'), ok: Boolean(native.xdgOpen?.exists) });

  const codex = data?.codex ?? {};
  findings.push({
    label: t('doctor.check_codex_tui'),
    ok: Boolean(codex.tui?.version?.ok),
    detail: codex.tui?.version?.output ? String(codex.tui.version.output).slice(0, 120) : undefined,
  });
  findings.push({ label: t('doctor.check_codex_js'), ok: Boolean(codex.jsDispatcher?.exists) });
  findings.push({ label: t('doctor.check_codex_auth'), ok: Boolean(codex.auth?.exists) });

  const security = data?.security ?? {};
  const leftover: any[] = Array.isArray(security.downloadCredentials)
    ? security.downloadCredentials.filter((f: any) => f?.exists)
    : [];
  findings.push({
    label: t('doctor.check_download_credentials'),
    ok: leftover.length === 0,
    detail: leftover.length > 0
      ? leftover.map((f: any) => String(f.file ?? '').split('/').pop()).join(', ')
      : undefined,
  });

  const privateFiles: any[] = Array.isArray(security.privateFiles) ? security.privateFiles : [];
  for (const file of privateFiles) {
    if (!file?.exists) continue;
    const name = String(file.file ?? '').split('/').pop() || String(file.file ?? '');
    findings.push({
      label: t('doctor.check_private_file', { name }),
      ok: Boolean(file.privateMode),
      detail: file.privateMode ? undefined : t('doctor.check_private_file_hint', { mode: file.mode }),
    });
  }

  const envKeys: string[] = Array.isArray(security.envKeysPresent) ? security.envKeysPresent : [];
  findings.push({
    label: t('doctor.check_env_keys'),
    ok: envKeys.length === 0,
    detail: envKeys.length > 0 ? envKeys.join(', ') : undefined,
  });

  return findings;
}

const DoctorSection = React.memo(function DoctorSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [resultVisible, setResultVisible] = useState(false);
  const [findings, setFindings] = useState<DoctorFinding[] | null>(null);

  const run = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await execCommand(DOCTOR_CMD, 30_000);
      const stdout = result.stdout.trim();
      // --json prints a single JSON.stringify(data, null, 2) blob; take the
      // whole trimmed stdout (multi-line pretty-printed JSON), not just the
      // last line.
      const data = JSON.parse(stdout);
      if (data?.__error) throw new Error(data.__error);
      setFindings(buildDoctorFindings(data, t));
      setResultVisible(true);
      logInfo('SettingsDropdown', 'shelly-doctor ran ok, exit=' + result.exitCode);
    } catch (e: any) {
      logError('SettingsDropdown', 'shelly-doctor failed', e);
      Alert.alert(t('doctor.failed_title'), String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const okItems = React.useMemo(() => findings?.filter((f) => f.ok) ?? [], [findings]);
  const warnItems = React.useMemo(() => findings?.filter((f) => !f.ok) ?? [], [findings]);

  return (
    <Section title={t('doctor.title')}>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle(), busy && styles.integrationRowDisabled]}
        onPress={run}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('doctor.run_a11y')}
      >
        <MaterialIcons name="favorite" size={13} color={C.text2} />
        <Text style={[styles.integrationLabel, { color: C.text1 }]}>
          {busy ? t('doctor.running') : t('doctor.run')}
        </Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>

      <Modal
        visible={resultVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setResultVisible(false)}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={() => setResultVisible(false)}>
          <Pressable
            style={[styles.panel, panelChromeStyle(), { backgroundColor: C.bgSurface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[styles.header, { backgroundColor: C.bgSidebar, borderBottomColor: C.border }]}>
              <MaterialIcons name="favorite" size={13} color={C.accent} />
              <Text style={[styles.headerTitle, { color: C.text1 }]}>{t('doctor.title')}</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => setResultVisible(false)}
                hitSlop={8}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel={t('settings.close_a11y')}
              >
                <MaterialIcons name="close" size={13} color={C.accent} />
              </Pressable>
            </View>
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              {warnItems.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: C.errorText }]}>
                    {t('doctor.warn_group', { count: warnItems.length })}
                  </Text>
                  <View style={styles.sectionBody}>
                    {warnItems.map((f, i) => (
                      <React.Fragment key={`warn-${i}`}>
                        {i > 0 && <View style={styles.credentialGap} />}
                        <View style={[styles.integrationRow, borderedChromeStyle(), { borderColor: C.errorText }]}>
                          <MaterialIcons name="warning" size={13} color={C.errorText} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.integrationLabel, { color: C.text1 }]}>{f.label}</Text>
                            {f.detail ? (
                              <Text style={[styles.apiKeyHint, { color: C.text3 }]}>{f.detail}</Text>
                            ) : null}
                          </View>
                        </View>
                      </React.Fragment>
                    ))}
                  </View>
                </View>
              )}
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: C.text2 }]}>
                  {t('doctor.ok_group', { count: okItems.length })}
                </Text>
                <View style={styles.sectionBody}>
                  {okItems.map((f, i) => (
                    <React.Fragment key={`ok-${i}`}>
                      {i > 0 && <View style={styles.credentialGap} />}
                      <View style={[styles.integrationRow, borderedChromeStyle()]}>
                        <MaterialIcons name="check-circle" size={13} color={C.accent} />
                        <Text style={[styles.integrationLabel, { color: C.text1 }]}>{f.label}</Text>
                      </View>
                    </React.Fragment>
                  ))}
                </View>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </Section>
  );
});

// ─── Reset settings ──────────────────────────────────────────────────────────
// resetSettings() (store/settings-store.ts) has existed since the store's
// original design but had no UI trigger anywhere — every other per-field
// toggle in this screen was reachable, this whole-settings reset never was.
// Wipes fontSize/theme/API keys stored in settings/local LLM config/autonomous
// consent/etc. back to DEFAULT_SETTINGS, so this needs the same destructive
// confirm pattern as DM-pairing's revoke/delete, not a bare button.

const ResetSettingsSection = React.memo(function ResetSettingsSection() {
  const { t } = useTranslation();

  const confirmReset = React.useCallback(() => {
    Alert.alert(
      t('settings.reset_confirm_title'),
      t('settings.reset_confirm_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.reset_action'),
          style: 'destructive',
          onPress: () => {
            useSettingsStore.getState().resetSettings();
            ToastAndroid.show(t('settings.reset_done_toast'), ToastAndroid.SHORT);
          },
        },
      ],
    );
  }, [t]);

  return (
    <Section title={t('settings.reset_title')}>
      <Pressable
        style={[styles.integrationRow, borderedChromeStyle(), { borderColor: C.errorText }]}
        onPress={confirmReset}
        accessibilityRole="button"
        accessibilityLabel={t('settings.reset_action')}
      >
        <MaterialIcons name="restore" size={13} color={C.errorText} />
        <Text style={[styles.integrationLabel, { color: C.errorText }]}>{t('settings.reset_action')}</Text>
      </Pressable>
    </Section>
  );
});

// ─── Shared atoms ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={[styles.section, { borderBottomColor: C.border }]}>
      <Text style={[styles.sectionTitle, { color: C.text2 }]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: C.text1 }]}>{label}</Text>
      <View style={styles.rowControl}>{children}</View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const PANEL_WIDTH = 260;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    zIndex: 300,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  panel: {
    width: PANEL_WIDTH,
    maxHeight: '85%',
    marginTop: S.agentBarHeight + 4,
    marginRight: 8,
    backgroundColor: C.bgSurface,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 6,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  headerTitle: {
    color: C.text1,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
  },
  closeBtn: {
    padding: 2,
  },
  scroll: {
    // bug #138 (2026-04-27): was `flexGrow: 0`. With RN's default
    // flexShrink: 0, the ScrollView measured to its natural content
    // height and ignored the panel's maxHeight: '85%' constraint —
    // the panel's overflow: 'hidden' then silently clipped any
    // section past the screen edge. Recovery (last in the list)
    // got clipped on Z Fold6 cover-screen, looking like it didn't
    // render. ConfigTUI has used `flex: 1` since the start which is
    // why its identical Recovery entry has always been reachable.
    // Diagnosed by independent agent review of build #749 — agent
    // verified bundled JS contained the section AND verified
    // expo-updates `enabled: false` was actually bypassing OTA cache
    // (DisabledUpdatesController → NoDatabaseLauncher,
    // isUsingEmbeddedAssets = true) before pinning the layout bug.
    flexShrink: 1,
  },
  // Section
  section: {
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    paddingVertical: 6,
  },
  sectionTitle: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionBody: {
    paddingHorizontal: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  rowLabel: {
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
  },
  rowControl: {
    alignItems: 'flex-end',
  },
  rowValue: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
  },
  // Default agent dropdown
  defaultAgentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.25),
    backgroundColor: withAlpha(C.accent, 0.06),
  },
  defaultAgentLabel: {
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
  defaultAgentPicker: {
    marginHorizontal: 4,
    marginBottom: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgDeep,
    overflow: 'hidden',
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pickerRowActive: {
    backgroundColor: withAlpha(C.accent, 0.10),
  },
  pickerLabel: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
  },
  pickerLabelActive: {
    color: C.accent,
    fontWeight: '700',
  },
  // Switch
  switchTrack: {
    width: 28,
    height: 14,
    borderRadius: 7,
    backgroundColor: C.border,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  switchTrackOn: {
    backgroundColor: withAlpha(C.accent, 0.35),
  },
  switchThumb: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.text2,
  },
  // Slider
  sliderGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sliderTrackWrap: {
    width: 140,
    height: 20,
    justifyContent: 'center',
  },
  sliderTrack: {
    width: 140,
    height: 4,
    backgroundColor: C.border,
    borderRadius: 2,
    position: 'relative',
  },
  sliderFill: {
    height: 4,
    backgroundColor: C.accent,
    borderRadius: 2,
  },
  sliderThumb: {
    position: 'absolute',
    top: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.accent,
  },
  sliderPercent: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    minWidth: 28,
    textAlign: 'right',
  },
  // Wallpaper picker row (Phase B)
  wallpaperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wallpaperPreview: {
    width: 28,
    height: 28,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgDeep,
  },
  wallpaperPreviewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wallpaperBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: withAlpha(C.accent, 0.14),
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.4),
  },
  wallpaperBtnGhost: {
    backgroundColor: 'transparent',
    borderColor: C.border,
  },
  wallpaperBtnText: {
    color: C.accent,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  // Segmented (font size)
  segGroup: {
    flexDirection: 'row',
    gap: 2,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  segBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: 'transparent',
  },
  segBtnActive: {
    backgroundColor: withAlpha(C.text1, 0.08),
  },
  segLabel: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
  segLabelActive: {
    color: C.text1,
  },
  themeSwatch: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    opacity: 0.65,
  },
  themeSwatchActive: {
    opacity: 1,
  },
  // Integrations
  integrationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.badge,
    backgroundColor: C.bgSurface,
  },
  integrationRowDisabled: {
    opacity: 0.55,
  },
  integrationLabel: {
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    fontWeight: '700',
    color: C.text1,
    letterSpacing: 0.4,
  },
  credentialHint: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    lineHeight: 15,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  credentialGap: {
    height: 6,
  },
  // Language
  langRow: {
    flexDirection: 'row',
    gap: 16,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  langOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  radio: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: C.text2,
  },
  radioOn: {
    borderColor: C.accent,
    backgroundColor: C.accent,
  },
  langLabel: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  langLabelActive: {
    color: C.text1,
  },
  // API key status
  statusOn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  statusOnText: {
    color: C.accent,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
  },
  statusOff: {
    color: C.text3,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
  },
  manageBtn: {
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  manageBtnText: {
    color: C.accent,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  apiKeyRow: {
    paddingVertical: 6,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
  },
  apiKeyRowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  apiKeyLabel: {
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    flex: 1,
  },
  eyeBtn: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  apiKeyInput: {
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    backgroundColor: C.bgDeep,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 3,
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
  },
  apiKeyActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  apiKeyEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 5,
  },
  apiKeyHint: {
    color: C.text3,
    fontSize: F.badge.size,
    fontFamily: F.family,
  },
  apiKeyBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 3,
  },
  apiKeyBtnPrimary: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  apiKeyBtnText: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  apiKeyBtnTextPrimary: {
    color: C.bgDeep,
  },
});
