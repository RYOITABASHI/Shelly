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
import { BuildsModal } from '@/components/layout/BuildsModal';
import { applyThemePreset, themePresets } from '@/lib/theme-presets';
import { logInfo, logError } from '@/lib/debug-logger';
import { useAddPane } from '@/hooks/use-add-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { flushPendingAgentEnvSync } from '@/lib/agent-env-sync';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

type Props = {
  visible: boolean;
  onClose: () => void;
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

export function SettingsDropdown({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [llamaOpen, setLlamaOpen] = useState(false);
  const [buildsOpen, setBuildsOpen] = useState(false);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.panel, panelChromeStyle()]} onPress={(e) => e.stopPropagation()}>
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

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <DisplaySection />
            <WallpaperSection />
            <LanguageSection />
            <AgentsSection />
            <ApiKeysSection />
            <UpdatesSection onOpenBuilds={() => setBuildsOpen(true)} />
            <ScouterSection visible={visible} onCloseSettings={onClose} />
            <CodexLoginSection onClose={onClose} />
            <IntegrationsSection
              onOpenMcp={() => setMcpOpen(true)}
              onOpenLlama={() => setLlamaOpen(true)}
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

      <BuildsModal
        visible={buildsOpen}
        onClose={() => setBuildsOpen(false)}
      />
    </Modal>
  );
}

function UpdatesSection({ onOpenBuilds }: { onOpenBuilds: () => void }) {
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
}

function ScouterSection({ visible, onCloseSettings }: { visible: boolean; onCloseSettings: () => void }) {
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
}

function IntegrationsSection({
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
}

// bug #131 + #136 (2026-04-27): user-facing escape hatch surfaced in
// the gear-button SettingsDropdown so it's reachable without opening
// the comprehensive ConfigTUI (which is gated behind the Command
// Palette and harder to find). Original Recovery entry stays in
// ConfigTUI; this is the discoverable mirror.
function RecoverySection() {
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
}

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
function WallpaperSection() {
  const { t } = useTranslation();
  const wallpaperUri = useCosmeticStore((s) => s.wallpaperUri);
  const wallpaperOpacity = useCosmeticStore((s) => s.wallpaperOpacity);
  const panelOpacity = useCosmeticStore((s) => s.panelOpacity);
  const setWallpaper = useCosmeticStore((s) => s.setWallpaper);
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
            <Image source={{ uri: wallpaperUri }} style={[styles.wallpaperPreview, { borderColor: C.border }]} />
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
        </>
      )}
    </Section>
  );
}

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
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const x = e.nativeEvent.locationX;
        onChange(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        onChange(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
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

function DisplaySection() {
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
}

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

function LanguageSection() {
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
}

// ─── AI Agents ───────────────────────────────────────────────────────────────

const DEFAULT_AGENT_OPTIONS: { value: 'cerebras' | 'groq' | 'codex'; label: string }[] = [
  { value: 'cerebras',    label: 'Cerebras' },
  { value: 'groq',        label: 'Groq' },
  { value: 'codex',       label: 'Codex' },
];

function AgentsSection() {
  const { t } = useTranslation();
  const defaultAgent = useSettingsStore((s) => s.settings.defaultAgent);
  const autoApproveLevel = useSettingsStore((s) => s.settings.autoApproveLevel);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const currentLabel =
    DEFAULT_AGENT_OPTIONS.find((o) => o.value === defaultAgent)?.label ?? 'Codex';

  const toggleAutoApprove = () => {
    const next = autoApproveLevel === 'none' ? 'safe' : 'none';
    updateSettings({ autoApproveLevel: next as any });
  };

  const autoOn = autoApproveLevel !== 'none';

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
    </Section>
  );
}

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

function ApiKeysSection() {
  const { t } = useTranslation();
  return (
    <Section title={t('api_keys.title')}>
      {API_KEY_FIELDS.map((f) => (
        <ApiKeyRow key={f.key} field={f} />
      ))}
    </Section>
  );
}

// ─── Codex login (ChatGPT subscription device-auth) ─────────────────────────
// Minimal trigger for the existing `codex-login --open` flow defined in
// HomeInitializer.kt:1493 and implemented in assets/shelly-codex-auth.js.
// Tapping the button closes this Modal, spawns a fresh terminal pane, and
// queues `codex-login --open` so the user sees the device code, browser
// pane opens via the shelly://browser deep link, and ~/.codex/auth.json
// (mode 0600) is written on success. Verification is delegated to
// shelly-doctor (which already reports `codex auth: <exists|missing>`).

function CodexLoginSection({ onClose }: { onClose: () => void }) {
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
}

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
    backgroundColor: 'rgba(0,0,0,0.5)',
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
