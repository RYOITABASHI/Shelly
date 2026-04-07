/**
 * components/config/ConfigTUI.tsx
 *
 * Settings TUI overlay triggered by `shelly config` in the pseudo-shell.
 * Renders a scrollable list of key-value rows grouped into sections.
 * Tap a row to edit inline: TextInput for strings, toggle for booleans,
 * picker sheet for enums.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Pressable,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Animated, { FadeIn, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSettingsStore } from '@/store/settings-store';
import { useCosmeticStore, SoundProfile, FontFamily } from '@/store/cosmetic-store';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = '#00D4AA';
const BG = '#0D0D0D';
const SURFACE = '#1A1A1A';
const BORDER = '#2A2A2A';
const MUTED = '#6B7280';
const TEXT = '#E5E7EB';

// ─── Setting descriptor types ─────────────────────────────────────────────────

type SettingType = 'boolean' | 'string' | 'number' | 'enum';

interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  options?: string[];          // for enum
  min?: number; max?: number;  // for number
  source: 'settings' | 'cosmetic';
  description?: string;
}

// ─── Section definitions ──────────────────────────────────────────────────────

const SECTIONS: { title: string; icon: string; items: SettingDef[] }[] = [
  {
    title: 'Terminal',
    icon: 'terminal',
    items: [
      { key: 'fontSize',       label: 'Font Size',        type: 'number', min: 8, max: 32, source: 'settings' },
      { key: 'cursorShape',    label: 'Cursor Shape',     type: 'enum',   options: ['block', 'underline', 'bar'], source: 'settings' },
      { key: 'autoScroll',     label: 'Auto Scroll',      type: 'boolean', source: 'settings' },
      { key: 'autocomplete',   label: 'Autocomplete',     type: 'boolean', source: 'settings' },
      { key: 'syntaxHighlight',label: 'Syntax Highlight', type: 'boolean', source: 'settings' },
    ],
  },
  {
    title: 'AI',
    icon: 'auto-awesome',
    items: [
      { key: 'localLlmEnabled', label: 'Local LLM',       type: 'boolean', source: 'settings' },
      { key: 'localLlmUrl',     label: 'Local LLM URL',   type: 'string',  source: 'settings', description: 'e.g. http://127.0.0.1:8080' },
      { key: 'localLlmModel',   label: 'Local LLM Model', type: 'string',  source: 'settings' },
    ],
  },
  {
    title: 'Sound',
    icon: 'volume-up',
    items: [
      { key: 'soundEffects',  label: 'Sound Effects', type: 'boolean', source: 'settings' },
      { key: 'soundProfile',  label: 'Sound Profile', type: 'enum', options: ['modern', 'retro', 'silent'], source: 'cosmetic' },
    ],
  },
  {
    title: 'Display',
    icon: 'palette',
    items: [
      { key: 'fontFamily',   label: 'Font Family',    type: 'enum', options: ['jetbrains-mono', 'fira-code', 'source-code-pro', 'ibm-plex-mono', 'pixel-mplus', 'press-start-2p', 'silkscreen'], source: 'cosmetic' },
      { key: 'crtEnabled',   label: 'CRT Effect',     type: 'boolean', source: 'cosmetic' },
      { key: 'crtIntensity', label: 'CRT Intensity',  type: 'number', min: 0, max: 100, source: 'cosmetic' },
    ],
  },
  {
    title: 'Advanced',
    icon: 'settings',
    items: [
      { key: 'hapticFeedback',       label: 'Haptic Feedback',   type: 'boolean', source: 'settings' },
      { key: 'highContrastOutput',   label: 'High Contrast',     type: 'boolean', source: 'settings' },
      { key: 'enableCommandSafety',  label: 'Command Safety',    type: 'boolean', source: 'settings' },
      { key: 'llmInterpreterEnabled',label: 'LLM Interpreter',   type: 'boolean', source: 'settings' },
      { key: 'realtimeTranslateEnabled', label: 'Realtime Translate', type: 'boolean', source: 'settings' },
      { key: 'gpuRendering',         label: 'GPU Rendering',     type: 'boolean', source: 'settings' },
    ],
  },
];

// ─── Value helpers ────────────────────────────────────────────────────────────

function getValue(
  key: string,
  source: 'settings' | 'cosmetic',
  settings: ReturnType<typeof useSettingsStore.getState>['settings'],
  cosmetics: ReturnType<typeof useCosmeticStore.getState>,
): unknown {
  if (source === 'cosmetic') {
    return (cosmetics as unknown as Record<string, unknown>)[key];
  }
  return (settings as Record<string, unknown>)[key];
}

function formatValue(value: unknown, type: SettingType): string {
  if (value === undefined || value === null) return '—';
  if (type === 'boolean') return value ? 'on' : 'off';
  if (type === 'number') return String(value);
  return String(value);
}

// ─── EnumPickerSheet ──────────────────────────────────────────────────────────

interface EnumPickerProps {
  visible: boolean;
  label: string;
  options: string[];
  current: string;
  onSelect: (v: string) => void;
  onClose: () => void;
}

function EnumPickerSheet({ visible, label, options, current, onSelect, onClose }: EnumPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.pickerBackdrop} onPress={onClose} />
      <Animated.View entering={SlideInDown.duration(200)} exiting={SlideOutDown.duration(150)} style={styles.pickerSheet}>
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>{label}</Text>
          <TouchableOpacity onPress={onClose}>
            <MaterialIcons name="close" size={20} color={MUTED} />
          </TouchableOpacity>
        </View>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt}
            style={styles.pickerOption}
            onPress={() => { onSelect(opt); onClose(); }}
            activeOpacity={0.7}
          >
            <Text style={[styles.pickerOptionText, opt === current && styles.pickerOptionActive]}>
              {opt}
            </Text>
            {opt === current && (
              <MaterialIcons name="check" size={16} color={ACCENT} />
            )}
          </TouchableOpacity>
        ))}
      </Animated.View>
    </Modal>
  );
}

// ─── SettingRow ───────────────────────────────────────────────────────────────

interface SettingRowProps {
  def: SettingDef;
  value: unknown;
  onToggle: () => void;
  onStringEdit: (v: string) => void;
  onEnumOpen: () => void;
}

function SettingRow({ def, value, onToggle, onStringEdit, onEnumOpen }: SettingRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = useCallback(() => {
    setDraft(String(value ?? ''));
    setEditing(true);
  }, [value]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    if (def.type === 'number') {
      const n = parseFloat(draft);
      if (!isNaN(n)) {
        const clamped = def.min !== undefined && def.max !== undefined
          ? Math.max(def.min, Math.min(def.max, n))
          : n;
        onStringEdit(String(clamped));
      }
    } else {
      onStringEdit(draft);
    }
  }, [def, draft, onStringEdit]);

  const displayValue = formatValue(value, def.type);

  if (def.type === 'boolean') {
    return (
      <View style={styles.row}>
        <View style={styles.rowLeft}>
          <Text style={styles.rowKey}>{def.label}</Text>
          {def.description && <Text style={styles.rowDesc}>{def.description}</Text>}
        </View>
        <Switch
          value={Boolean(value)}
          onValueChange={onToggle}
          trackColor={{ false: BORDER, true: ACCENT + '66' }}
          thumbColor={value ? ACCENT : MUTED}
        />
      </View>
    );
  }

  if (def.type === 'enum') {
    return (
      <TouchableOpacity style={styles.row} onPress={onEnumOpen} activeOpacity={0.7}>
        <View style={styles.rowLeft}>
          <Text style={styles.rowKey}>{def.label}</Text>
          {def.description && <Text style={styles.rowDesc}>{def.description}</Text>}
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowValue}>{displayValue}</Text>
          <MaterialIcons name="chevron-right" size={16} color={MUTED} />
        </View>
      </TouchableOpacity>
    );
  }

  // string / number
  if (editing) {
    return (
      <View style={styles.rowEditing}>
        <Text style={styles.rowKey}>{def.label}</Text>
        <TextInput
          style={styles.rowInput}
          value={draft}
          onChangeText={setDraft}
          onBlur={commitEdit}
          onSubmitEditing={commitEdit}
          autoFocus
          keyboardType={def.type === 'number' ? 'numeric' : 'default'}
          returnKeyType="done"
          selectionColor={ACCENT}
          placeholderTextColor={MUTED}
        />
      </View>
    );
  }

  return (
    <TouchableOpacity style={styles.row} onPress={startEdit} activeOpacity={0.7}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowKey}>{def.label}</Text>
        {def.description && <Text style={styles.rowDesc}>{def.description}</Text>}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowValue}>{displayValue}</Text>
        <MaterialIcons name="edit" size={14} color={MUTED} />
      </View>
    </TouchableOpacity>
  );
}

// ─── Main ConfigTUI ───────────────────────────────────────────────────────────

interface ConfigTUIProps {
  visible: boolean;
  onClose: () => void;
}

export function ConfigTUI({ visible, onClose }: ConfigTUIProps) {
  const { settings, updateSettings } = useSettingsStore();
  const cosmetics = useCosmeticStore();

  const [picker, setPicker] = useState<{
    def: SettingDef;
    current: string;
  } | null>(null);

  const getVal = useCallback(
    (def: SettingDef) => getValue(def.key, def.source, settings, cosmetics),
    [settings, cosmetics],
  );

  const applyValue = useCallback(
    (def: SettingDef, rawValue: unknown) => {
      if (def.source === 'settings') {
        updateSettings({ [def.key]: rawValue } as Parameters<typeof updateSettings>[0]);
      } else {
        // cosmetic store — map key to setter
        switch (def.key) {
          case 'crtEnabled':    cosmetics.setCrt(Boolean(rawValue)); break;
          case 'crtIntensity':  cosmetics.setCrtIntensity(Number(rawValue)); break;
          case 'soundProfile':  cosmetics.setSoundProfile(rawValue as SoundProfile); break;
          case 'fontFamily':    cosmetics.setFontFamily(rawValue as FontFamily); break;
          default: break;
        }
      }
    },
    [updateSettings, cosmetics],
  );

  const handleToggle = useCallback(
    (def: SettingDef) => applyValue(def, !getVal(def)),
    [applyValue, getVal],
  );

  const handleStringEdit = useCallback(
    (def: SettingDef, raw: string) => {
      const coerced = def.type === 'number' ? parseFloat(raw) : raw;
      applyValue(def, isNaN(coerced as number) ? raw : coerced);
    },
    [applyValue],
  );

  const handleEnumOpen = useCallback((def: SettingDef) => {
    setPicker({ def, current: String(getVal(def) ?? '') });
  }, [getVal]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
        pointerEvents="box-none"
      >
        <Animated.View entering={SlideInDown.duration(220)} exiting={SlideOutDown.duration(180)} style={styles.panel}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <MaterialIcons name="tune" size={18} color={ACCENT} />
              <Text style={styles.headerTitle}>shelly config</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={MUTED} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {SECTIONS.map((section, si) => (
              <View key={section.title} style={si > 0 ? styles.section : styles.sectionFirst}>
                {/* Section header */}
                <View style={styles.sectionHeader}>
                  <MaterialIcons name={section.icon as any} size={13} color={ACCENT} />
                  <Text style={styles.sectionTitle}>{section.title.toUpperCase()}</Text>
                </View>

                {/* Rows */}
                <View style={styles.card}>
                  {section.items.map((def, ri) => (
                    <View key={def.key}>
                      {ri > 0 && <View style={styles.divider} />}
                      <SettingRow
                        def={def}
                        value={getVal(def)}
                        onToggle={() => handleToggle(def)}
                        onStringEdit={(v) => handleStringEdit(def, v)}
                        onEnumOpen={() => handleEnumOpen(def)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ))}

            {/* Footer hint */}
            <Text style={styles.footer}>
              {'shelly config set <key> <value>  ·  shelly config get <key>'}
            </Text>
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>

      {/* Enum picker sheet */}
      {picker && (
        <EnumPickerSheet
          visible
          label={picker.def.label}
          options={picker.def.options ?? []}
          current={picker.current}
          onSelect={(v) => applyValue(picker.def, v)}
          onClose={() => setPicker(null)}
        />
      )}
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  panel: {
    backgroundColor: BG,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '85%',
    borderTopWidth: 1,
    borderColor: BORDER,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: TEXT,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'JetBrainsMono_400Regular',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },

  sectionFirst: { marginTop: 12 },
  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  sectionTitle: {
    color: ACCENT,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  card: {
    marginHorizontal: 12,
    backgroundColor: SURFACE,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    overflow: 'hidden',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: BORDER,
    marginLeft: 12,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  rowEditing: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowLeft: { flex: 1, marginRight: 8 },
  rowKey: {
    color: TEXT,
    fontSize: 13,
  },
  rowDesc: {
    color: MUTED,
    fontSize: 11,
    marginTop: 1,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rowValue: {
    color: ACCENT,
    fontSize: 13,
    fontFamily: 'JetBrainsMono_400Regular',
  },
  rowInput: {
    color: ACCENT,
    fontSize: 13,
    fontFamily: 'JetBrainsMono_400Regular',
    borderBottomWidth: 1,
    borderBottomColor: ACCENT,
    paddingVertical: 4,
    marginTop: 4,
  },

  // Picker sheet
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  pickerSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: SURFACE,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: BORDER,
    paddingBottom: 28,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  pickerTitle: {
    color: TEXT,
    fontSize: 14,
    fontWeight: '600',
  },
  pickerOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  pickerOptionText: {
    color: MUTED,
    fontSize: 14,
    fontFamily: 'JetBrainsMono_400Regular',
  },
  pickerOptionActive: {
    color: ACCENT,
  },

  footer: {
    color: MUTED,
    fontSize: 10,
    textAlign: 'center',
    marginTop: 20,
    fontFamily: 'JetBrainsMono_400Regular',
  },
});
