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
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useSettingsStore } from '@/store/settings-store';
import { useI18n } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S, radii as R } from '@/theme.config';

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
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <MaterialIcons name="close" size={13} color={C.text2} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <DisplaySection />
            <LanguageSection />
            <AgentsSection />
            <ApiKeysSection />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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

      {/* UI font family */}
      <FontFamilyRow />
    </Section>
  );
}

function FontFamilyRow() {
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'shelly');
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const options: Array<{ value: 'shelly' | 'silkscreen' | 'pixel' | 'mono'; label: string }> = [
    { value: 'shelly',     label: 'Shelly' },
    { value: 'silkscreen', label: 'Silk' },
    { value: 'pixel',      label: '8bit' },
    { value: 'mono',       label: 'Mono' },
  ];
  return (
    <Row label="Font">
      <View style={styles.segGroup}>
        {options.map((opt) => {
          const active = uiFont === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.segBtn, active && styles.segBtnActive]}
              onPress={() => updateSettings({ uiFont: opt.value })}
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
    flexGrow: 0,
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
    borderColor: 'rgba(0,212,170,0.25)',
    backgroundColor: 'rgba(0,212,170,0.06)',
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
    backgroundColor: 'rgba(0,212,170,0.10)',
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
    backgroundColor: 'rgba(0,212,170,0.35)',
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
    backgroundColor: 'rgba(0,212,170,0.15)',
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
