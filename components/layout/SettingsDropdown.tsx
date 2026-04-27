// components/layout/SettingsDropdown.tsx
//
// Drop-down settings panel anchored to the gear button in AgentBar.
// Consolidates Display (CRT/Font), Language, AI Agents, and API Keys
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
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useSettingsStore } from '@/store/settings-store';
import { useI18n } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { McpSectionWrapper } from '@/components/settings/McpSectionWrapper';
import { LlamaCppSectionWrapper } from '@/components/settings/LlamaCppSectionWrapper';
import { applyThemePreset } from '@/lib/theme-presets';
import { logInfo, logError } from '@/lib/debug-logger';

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

export function SettingsDropdown({ visible, onClose }: Props) {
  const [mcpOpen, setMcpOpen] = useState(false);
  const [llamaOpen, setLlamaOpen] = useState(false);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.panel} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <MaterialIcons name="settings" size={13} color={C.text2} />
            <Text style={styles.headerTitle}>SETTINGS</Text>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
            >
              <MaterialIcons name="close" size={13} color={C.text2} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <DisplaySection />
            <WallpaperSection />
            <LanguageSection />
            <AgentsSection />
            <ApiKeysSection />
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
    </Modal>
  );
}

function IntegrationsSection({
  onOpenMcp,
  onOpenLlama,
}: {
  onOpenMcp: () => void;
  onOpenLlama: () => void;
}) {
  return (
    <Section title="INTEGRATIONS">
      <Pressable
        style={styles.integrationRow}
        onPress={onOpenMcp}
        accessibilityRole="button"
        accessibilityLabel="Open MCP Servers settings"
      >
        <MaterialIcons name="extension" size={13} color={C.text2} />
        <Text style={styles.integrationLabel}>MCP Servers</Text>
        <View style={{ flex: 1 }} />
        <MaterialIcons name="chevron-right" size={14} color={C.text3} />
      </Pressable>
      <Pressable
        style={styles.integrationRow}
        onPress={onOpenLlama}
        accessibilityRole="button"
        accessibilityLabel="Open Local LLM llama.cpp settings"
      >
        <MaterialIcons name="memory" size={13} color={C.text2} />
        <Text style={styles.integrationLabel}>Local LLM · llama.cpp</Text>
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
  const handleRecover = React.useCallback(() => {
    Alert.alert(
      'Force-recover Shelly?',
      'Wipes ~/.shelly-cli.staging and the stale update lockfile. ' +
      'Live install (~/.shelly-cli) is preserved — your CLIs keep working. ' +
      'Use this only if Shelly freezes on launch and task-kill from the ' +
      'recents list does not recover.\n\n' +
      'After recovery, fully close Shelly (recents → swipe up) and ' +
      'relaunch. The next launch will refresh from upstream automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Recover',
          style: 'destructive',
          onPress: async () => {
            try {
              const TerminalEmulator = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
              const result = await TerminalEmulator.forceRecoverFromFrozenState();
              const cleanedCount = Array.isArray(result?.cleaned) ? result.cleaned.length : 0;
              const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
              if (errorCount > 0) {
                Alert.alert(
                  'Recovery completed with warnings',
                  `Cleaned ${cleanedCount} item(s). ${errorCount} could not be removed:\n\n` +
                  (result.errors as string[]).slice(0, 5).join('\n') +
                  (errorCount > 5 ? `\n…+${errorCount - 5} more` : ''),
                );
              } else {
                Alert.alert(
                  'Recovery complete',
                  `Cleaned ${cleanedCount} item(s). Force-stop Shelly (recents → swipe up) and relaunch.`,
                );
              }
              logInfo('SettingsDropdown', 'forceRecoverFromFrozenState ok=' + result?.ok + ' cleaned=' + cleanedCount + ' errors=' + errorCount);
            } catch (e: any) {
              logError('SettingsDropdown', 'forceRecoverFromFrozenState failed', e);
              Alert.alert('Recovery failed', String(e?.message || e));
            }
          },
        },
      ],
    );
  }, []);
  return (
    <Section title="RECOVERY">
      <Pressable
        style={styles.integrationRow}
        onPress={handleRecover}
        accessibilityRole="button"
        accessibilityLabel="Force-recover from frozen state"
      >
        <MaterialIcons name="healing" size={13} color={C.text2} />
        <Text style={styles.integrationLabel}>Force-recover from frozen state</Text>
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
// CRT + wallpaper both enabled reads poorly (scanlines over a photo =
// visual mud), so we warn on toggle but do not hard-block — some users
// might actually want that retro-monitor-over-poster look.

function WallpaperSection() {
  const wallpaperUri = useCosmeticStore((s) => s.wallpaperUri);
  const wallpaperOpacity = useCosmeticStore((s) => s.wallpaperOpacity);
  const panelOpacity = useCosmeticStore((s) => s.panelOpacity);
  const setWallpaper = useCosmeticStore((s) => s.setWallpaper);
  const setWallpaperOpacity = useCosmeticStore((s) => s.setWallpaperOpacity);
  const setPanelOpacity = useCosmeticStore((s) => s.setPanelOpacity);
  const crtEnabled = useCosmeticStore((s) => s.crtEnabled);
  // Note: blurEnabled / blurIntensity still live in cosmetic-store but no
  // UI toggle renders today — there is no chrome BlurView consumer yet,
  // so exposing a toggle would be a dead switch. Store fields stay so the
  // consumer can land later without a persisted-state migration.

  const pick = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Permission needed',
          'Shelly needs access to your photo library to pick a wallpaper.',
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
      if (crtEnabled) {
        Alert.alert(
          'CRT + Wallpaper',
          'CRT scanlines tend to read as visual noise over a photo. Disable CRT?',
          [
            { text: 'Keep both', style: 'cancel' },
            { text: 'Disable CRT', onPress: () => useCosmeticStore.getState().setCrt(false) },
          ],
        );
      }
    } catch (e) {
      Alert.alert('Pick failed', String((e as Error)?.message ?? e));
    }
  };

  const clear = () => {
    if (!wallpaperUri) return;
    // Best-effort delete; ignore failures (user can always overwrite next pick).
    FileSystem.deleteAsync(wallpaperUri, { idempotent: true }).catch(() => {});
    setWallpaper(null);
  };

  return (
    <Section title="WALLPAPER">
      <Row label="Image">
        <View style={styles.wallpaperRow}>
          {wallpaperUri ? (
            <Image source={{ uri: wallpaperUri }} style={styles.wallpaperPreview} />
          ) : (
            <View style={[styles.wallpaperPreview, styles.wallpaperPreviewEmpty]}>
              <MaterialIcons name="image" size={14} color={C.text3} />
            </View>
          )}
          <Pressable style={styles.wallpaperBtn} onPress={pick} hitSlop={4}>
            <Text style={styles.wallpaperBtnText}>
              {wallpaperUri ? 'Change' : 'Pick'}
            </Text>
          </Pressable>
          {wallpaperUri && (
            <Pressable style={[styles.wallpaperBtn, styles.wallpaperBtnGhost]} onPress={clear} hitSlop={4}>
              <Text style={[styles.wallpaperBtnText, { color: C.text2 }]}>Clear</Text>
            </Pressable>
          )}
        </View>
      </Row>

      {wallpaperUri && (
        <>
          <SliderRow
            label="Image Opacity"
            value={wallpaperOpacity}
            onChange={setWallpaperOpacity}
          />
          <SliderRow
            label="Panel Opacity"
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
 * reuse the same geometry as DisplaySection's CRT Intensity control
 * without copy-pasting the PanResponder boilerplate.
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
          <View style={styles.sliderTrack}>
            <View style={[styles.sliderFill, { width: fillWidth }]} />
            <View style={[styles.sliderThumb, { left: fillWidth - 5 }]} />
          </View>
        </View>
        <Text style={styles.sliderPercent}>{value}%</Text>
      </View>
    </Row>
  );
}

// ─── Display ─────────────────────────────────────────────────────────────────

function DisplaySection() {
  const crtEnabled = useCosmeticStore((s) => s.crtEnabled);
  const crtIntensity = useCosmeticStore((s) => s.crtIntensity);
  const setCrt = useCosmeticStore((s) => s.setCrt);
  const setCrtIntensity = useCosmeticStore((s) => s.setCrtIntensity);

  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const trackWidth = 140;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const x = e.nativeEvent.locationX;
        setCrtIntensity(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        setCrtIntensity(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
      },
    })
  ).current;

  const fillWidth = (crtIntensity / 100) * trackWidth;

  return (
    <Section title="DISPLAY">
      {/* CRT Effect toggle */}
      <Row label="CRT Effect">
        <Pressable
          style={[styles.switchTrack, crtEnabled && styles.switchTrackOn]}
          onPress={() => setCrt(!crtEnabled)}
          hitSlop={4}
        >
          <View style={[styles.switchThumb, crtEnabled && styles.switchThumbOn]} />
        </Pressable>
      </Row>

      {/* Intensity slider (only when CRT enabled) */}
      {crtEnabled && (
        <Row label="Intensity">
          <View style={styles.sliderGroup}>
            <View style={styles.sliderTrackWrap} {...panResponder.panHandlers}>
              <View style={styles.sliderTrack}>
                <View style={[styles.sliderFill, { width: fillWidth }]} />
                <View style={[styles.sliderThumb, { left: fillWidth - 5 }]} />
              </View>
            </View>
            <Text style={styles.sliderPercent}>{crtIntensity}%</Text>
          </View>
        </Row>
      )}

      {/* Font size preset */}
      <Row label="Font Size">
        <View style={styles.segGroup}>
          {FONT_SIZE_PRESETS.map((p) => {
            const active = fontSize === p.size;
            return (
              <Pressable
                key={p.label}
                style={[styles.segBtn, active && styles.segBtnActive]}
                onPress={() => updateSettings({ fontSize: p.size })}
                hitSlop={4}
              >
                <Text style={[styles.segLabel, active && styles.segLabelActive]}>
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
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'shelly');
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const options: Array<{ value: UiFontId; label: string }> = [
    { value: 'shelly',    label: 'Studio' },
    { value: 'blackline', label: 'Blackline' },
    { value: 'modal',     label: 'Modal' },
  ];
  return (
    <Row label="Theme">
      <View style={styles.segGroup}>
        {options.map((opt) => {
          const active = uiFont === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.segBtn, active && styles.segBtnActive]}
              onPress={() => {
                // Apply synchronously to avoid the AsyncStorage race that
                // caused bug #28/#54.
                applyThemePreset(opt.value);
                updateSettings({ uiFont: opt.value });
              }}
              hitSlop={4}
            >
              <Text style={[styles.segLabel, active && styles.segLabelActive]}>
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
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);

  return (
    <Section title="LANGUAGE">
      <View style={styles.langRow}>
        <Pressable
          style={styles.langOption}
          onPress={() => setLocale('en')}
          hitSlop={4}
        >
          <View style={[styles.radio, locale === 'en' && styles.radioOn]} />
          <Text style={[styles.langLabel, locale === 'en' && styles.langLabelActive]}>EN</Text>
        </Pressable>
        <Pressable
          style={styles.langOption}
          onPress={() => setLocale('ja')}
          hitSlop={4}
        >
          <View style={[styles.radio, locale === 'ja' && styles.radioOn]} />
          <Text style={[styles.langLabel, locale === 'ja' && styles.langLabelActive]}>JA</Text>
        </Pressable>
      </View>
    </Section>
  );
}

// ─── AI Agents ───────────────────────────────────────────────────────────────

const DEFAULT_AGENT_OPTIONS: Array<{ value: 'cerebras' | 'groq' | 'gemini-cli' | 'claude-code' | 'codex'; label: string }> = [
  { value: 'cerebras',    label: 'Cerebras' },
  { value: 'groq',        label: 'Groq' },
  { value: 'gemini-cli',  label: 'Gemini' },
  { value: 'claude-code', label: 'Claude' },
  { value: 'codex',       label: 'Codex' },
];

function AgentsSection() {
  const defaultAgent = useSettingsStore((s) => s.settings.defaultAgent);
  const autoApproveLevel = useSettingsStore((s) => s.settings.autoApproveLevel);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const currentLabel =
    DEFAULT_AGENT_OPTIONS.find((o) => o.value === defaultAgent)?.label ?? 'Gemini';

  const toggleAutoApprove = () => {
    const next = autoApproveLevel === 'none' ? 'safe' : 'none';
    updateSettings({ autoApproveLevel: next as any });
  };

  const autoOn = autoApproveLevel !== 'none';

  return (
    <Section title="AI AGENTS">
      <Row label="Default">
        <Pressable
          style={styles.defaultAgentBtn}
          onPress={() => setPickerOpen((v) => !v)}
          hitSlop={4}
        >
          <Text style={styles.defaultAgentLabel}>{currentLabel}</Text>
          <MaterialIcons
            name={pickerOpen ? 'arrow-drop-up' : 'arrow-drop-down'}
            size={14}
            color={C.text2}
          />
        </Pressable>
      </Row>
      {pickerOpen && (
        <View style={styles.defaultAgentPicker}>
          {DEFAULT_AGENT_OPTIONS.map((opt) => {
            const active = opt.value === defaultAgent;
            return (
              <Pressable
                key={opt.value}
                style={[styles.pickerRow, active && styles.pickerRowActive]}
                onPress={() => {
                  updateSettings({ defaultAgent: opt.value });
                  setPickerOpen(false);
                }}
              >
                <Text style={[styles.pickerLabel, active && styles.pickerLabelActive]}>
                  {opt.label}
                </Text>
                {active && <MaterialIcons name="check" size={11} color={C.accent} />}
              </Pressable>
            );
          })}
        </View>
      )}
      <Row label="Auto-approve">
        <Pressable
          style={[styles.switchTrack, autoOn && styles.switchTrackOn]}
          onPress={toggleAutoApprove}
          hitSlop={4}
        >
          <View style={[styles.switchThumb, autoOn && styles.switchThumbOn]} />
        </Pressable>
      </Row>
    </Section>
  );
}

// ─── API Keys ────────────────────────────────────────────────────────────────

type ApiKeyFieldKey = 'cerebrasApiKey' | 'groqApiKey' | 'geminiApiKey' | 'perplexityApiKey';

type ApiKeyField = {
  key: ApiKeyFieldKey;
  label: string;
  hint: string;
};

const API_KEY_FIELDS: ApiKeyField[] = [
  { key: 'cerebrasApiKey',   label: 'Cerebras',   hint: 'cloud.cerebras.ai' },
  { key: 'groqApiKey',       label: 'Groq',       hint: 'console.groq.com' },
  { key: 'geminiApiKey',     label: 'Gemini',     hint: 'aistudio.google.com/apikey' },
  { key: 'perplexityApiKey', label: 'Perplexity', hint: 'perplexity.ai/settings/api' },
];

function maskKey(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return value.slice(0, 4) + '…' + value.slice(-4);
}

function ApiKeyRow({ field }: { field: ApiKeyField }) {
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

  const handleSave = () => {
    const trimmed = draft.trim();
    updateSettings({ [field.key]: trimmed } as Record<string, string>);
    setEditing(false);
    setReveal(false);
  };

  const handleCancel = () => {
    setDraft(stored);
    setEditing(false);
    setReveal(false);
  };

  const handleClear = () => {
    updateSettings({ [field.key]: '' } as Record<string, string>);
    setDraft('');
    setEditing(false);
    setReveal(false);
  };

  if (!editing) {
    return (
      <View style={styles.apiKeyRow}>
        <View style={styles.apiKeyRowHead}>
          <Text style={styles.apiKeyLabel}>{field.label}</Text>
          {hasStored ? (
            <View style={styles.statusOn}>
              <MaterialIcons name="check" size={10} color={C.accent} />
              <Text style={styles.statusOnText}>{maskKey(stored)}</Text>
            </View>
          ) : (
            <Text style={styles.statusOff}>未設定</Text>
          )}
        </View>
        <View style={styles.apiKeyActions}>
          <Text style={styles.apiKeyHint}>{field.hint}</Text>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => setEditing(true)}
            style={styles.apiKeyBtn}
            hitSlop={6}
          >
            <Text style={styles.apiKeyBtnText}>
              {hasStored ? 'EDIT' : 'SET'}
            </Text>
          </Pressable>
          {hasStored && (
            <Pressable
              onPress={handleClear}
              style={styles.apiKeyBtn}
              hitSlop={6}
            >
              <Text style={styles.apiKeyBtnText}>CLEAR</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.apiKeyRow}>
      <View style={styles.apiKeyRowHead}>
        <Text style={styles.apiKeyLabel}>{field.label}</Text>
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
        style={styles.apiKeyInput}
        placeholder={`Paste ${field.label} API key`}
        placeholderTextColor={C.text3}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        secureTextEntry={!reveal}
        selectTextOnFocus
      />
      <View style={styles.apiKeyActions}>
        <Text style={styles.apiKeyHint}>{field.hint}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={handleCancel} style={styles.apiKeyBtn} hitSlop={6}>
          <Text style={styles.apiKeyBtnText}>CANCEL</Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          style={[styles.apiKeyBtn, styles.apiKeyBtnPrimary]}
          hitSlop={6}
        >
          <Text style={[styles.apiKeyBtnText, styles.apiKeyBtnTextPrimary]}>
            SAVE
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ApiKeysSection() {
  return (
    <Section title="API KEYS">
      {API_KEY_FIELDS.map((f) => (
        <ApiKeyRow key={f.key} field={f} />
      ))}
    </Section>
  );
}

// ─── Shared atoms ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
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
  switchThumbOn: {
    backgroundColor: C.accent,
    alignSelf: 'flex-end',
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
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: 'transparent',
  },
  segBtnActive: {
    backgroundColor: withAlpha(C.accent, 0.15),
  },
  segLabel: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
  segLabelActive: {
    color: C.accent,
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
  integrationLabel: {
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    fontWeight: '700',
    color: C.text1,
    letterSpacing: 0.4,
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
