/**
 * components/config/ConfigTUI.tsx
 *
 * Settings TUI overlay triggered by `shelly config` in the pseudo-shell.
 * Renders a scrollable list of key-value rows grouped into sections.
 * Tap a row to edit inline: TextInput for strings, toggle for booleans,
 * picker sheet for enums.
 */

import React, { useState, useCallback, useEffect } from 'react';
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
  Alert,
  Share,
  ToastAndroid,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSettingsStore } from '@/store/settings-store';
import { useCosmeticStore, SoundProfile, FontFamily } from '@/store/cosmetic-store';
import { getAllThemes } from '@/lib/theme-engine';
import { useThemeStore } from '@/lib/theme-engine';
import { TERMINAL_THEME_NAMES } from '@/lib/terminal-theme';
import { useI18n, AVAILABLE_LOCALES } from '@/lib/i18n';
import { useUsageStore } from '@/store/usage-store';
import { useDotfilesStore } from '@/lib/dotfiles-sync';
import { saveCustomContext, loadCustomContext } from '@/lib/shelly-system-prompt';
import { useTerminalStore } from '@/store/terminal-store';
import { logInfo, logError, logLifecycle } from '@/lib/debug-logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = '#00D4AA';
const BG = '#0D0D0D';
const SURFACE = '#1A1A1A';
const BORDER = '#2A2A2A';
const MUTED = '#6B7280';
const TEXT = '#E5E7EB';

// ─── Setting descriptor types ─────────────────────────────────────────────────

type SettingType = 'boolean' | 'string' | 'number' | 'enum' | 'secret' | 'action';

interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  options?: string[];          // for enum
  min?: number; max?: number;  // for number
  source: 'settings' | 'cosmetic' | 'custom';
  description?: string;
  actionLabel?: string;        // for 'action' type
  dangerAction?: boolean;      // red styling for destructive actions
}

// ─── Section definitions ──────────────────────────────────────────────────────

const ALL_THEMES = getAllThemes().map((t) => t.id);

const SECTIONS: { title: string; icon: string; items: SettingDef[] }[] = [
  {
    title: 'Terminal',
    icon: 'terminal',
    items: [
      { key: 'fontSize',       label: 'Font Size',        type: 'number', min: 8, max: 32, source: 'settings' },
      { key: 'lineHeight',     label: 'Line Height',      type: 'number', min: 1.0, max: 2.5, source: 'settings', description: 'e.g. 1.4' },
      { key: 'cursorShape',    label: 'Cursor Shape',     type: 'enum',   options: ['block', 'underline', 'bar'], source: 'settings' },
      { key: 'autoScroll',     label: 'Auto Scroll',      type: 'boolean', source: 'settings' },
      { key: 'autocomplete',   label: 'Autocomplete',     type: 'boolean', source: 'settings' },
      { key: 'syntaxHighlight',label: 'Syntax Highlight', type: 'boolean', source: 'settings' },
      { key: 'externalKeyboardShortcuts', label: 'External Keyboard', type: 'boolean', source: 'settings', description: 'Physical keyboard shortcuts' },
    ],
  },
  {
    title: 'Display',
    icon: 'palette',
    items: [
      { key: 'themeEngine',    label: 'Color Theme',      type: 'enum', options: ALL_THEMES, source: 'custom', description: 'WezTerm-style themes' },
      { key: 'terminalTheme',  label: 'Terminal Theme',   type: 'enum', options: TERMINAL_THEME_NAMES, source: 'settings' },
      { key: 'fontFamily',     label: 'Font Family',      type: 'enum', options: ['jetbrains-mono', 'fira-code', 'source-code-pro', 'ibm-plex-mono', 'pixel-mplus', 'press-start-2p', 'silkscreen'], source: 'cosmetic' },
      { key: 'crtEnabled',     label: 'CRT Effect',       type: 'boolean', source: 'cosmetic' },
      { key: 'crtIntensity',   label: 'CRT Intensity',    type: 'number', min: 0, max: 100, source: 'cosmetic' },
      { key: 'gpuRendering',   label: 'GPU Rendering',    type: 'boolean', source: 'settings' },
    ],
  },
  {
    title: 'AI / LLM',
    icon: 'auto-awesome',
    items: [
      { key: 'localLlmEnabled', label: 'Local LLM',       type: 'boolean', source: 'settings' },
      { key: 'localLlmUrl',     label: 'Local LLM URL',   type: 'string',  source: 'settings', description: 'e.g. http://127.0.0.1:8080' },
      { key: 'localLlmModel',   label: 'Local LLM Model', type: 'string',  source: 'settings' },
      { key: 'groqApiKey',      label: 'Groq API Key',    type: 'secret',  source: 'settings' },
      { key: 'groqModel',       label: 'Groq Model',      type: 'string',  source: 'settings', description: 'e.g. llama-3.3-70b-versatile' },
      { key: 'cerebrasApiKey',  label: 'Cerebras API Key', type: 'secret', source: 'settings' },
      { key: 'perplexityApiKey',label: 'Perplexity API Key', type: 'secret', source: 'settings' },
      { key: 'geminiApiKey',    label: 'Gemini API Key',   type: 'secret',  source: 'settings' },
    ],
  },
  {
    title: 'Team',
    icon: 'groups',
    items: [
      { key: 'teamMembers.claude',     label: 'Claude',      type: 'boolean', source: 'custom', description: 'Enable Claude agent' },
      { key: 'teamMembers.gemini',     label: 'Gemini',      type: 'boolean', source: 'custom', description: 'Enable Gemini agent' },
      { key: 'teamMembers.codex',      label: 'Codex',       type: 'boolean', source: 'custom', description: 'Enable Codex agent' },
      { key: 'teamMembers.perplexity', label: 'Perplexity',  type: 'boolean', source: 'custom', description: 'Enable Perplexity agent' },
      { key: 'teamMembers.local',      label: 'Local LLM',   type: 'boolean', source: 'custom', description: 'Enable local LLM agent' },
      { key: 'defaultAgent',           label: 'Default Agent', type: 'enum', options: ['gemini-cli', 'claude-code', 'codex', 'local'], source: 'settings' },
      { key: 'experienceMode',         label: 'Experience Mode', type: 'enum', options: ['learning', 'standard', 'power'], source: 'settings' },
      { key: 'autoApproveLevel',       label: 'CLI Approval Level', type: 'enum', options: ['safe', 'moderate', 'yolo'], source: 'settings', description: 'How much to auto-approve' },
    ],
  },
  {
    title: 'Sound',
    icon: 'volume-up',
    items: [
      { key: 'soundEffects',  label: 'Sound Effects', type: 'boolean', source: 'settings' },
      { key: 'soundVolume',   label: 'Volume',        type: 'number', min: 0, max: 1.0, source: 'settings', description: '0.0 – 1.0' },
      { key: 'soundProfile',  label: 'Sound Profile', type: 'enum', options: ['modern', 'retro', 'silent'], source: 'cosmetic' },
      { key: 'hapticFeedback', label: 'Haptic Feedback', type: 'boolean', source: 'settings' },
    ],
  },
  {
    title: 'Language',
    icon: 'language',
    items: [
      { key: 'locale', label: 'Language', type: 'enum', options: AVAILABLE_LOCALES.map(l => l.code), source: 'custom', description: 'App language' },
    ],
  },
  {
    title: 'Context',
    icon: 'psychology',
    items: [
      { key: 'customContext', label: 'Custom System Prompt', type: 'string', source: 'custom', description: 'Injected into AI context' },
      { key: 'llmInterpreterEnabled', label: 'LLM Interpreter', type: 'boolean', source: 'settings' },
      { key: 'realtimeTranslateEnabled', label: 'Realtime Translate', type: 'boolean', source: 'settings' },
    ],
  },
  {
    title: 'Safety',
    icon: 'shield',
    items: [
      { key: 'enableCommandSafety',  label: 'Command Safety',    type: 'boolean', source: 'settings' },
      { key: 'highContrastOutput',   label: 'High Contrast',     type: 'boolean', source: 'settings' },
    ],
  },
  {
    title: 'Data',
    icon: 'storage',
    items: [
      { key: 'usageAlertEnabled', label: 'Usage Alerts',  type: 'boolean', source: 'custom', description: 'Notify on cost threshold' },
      { key: 'exportLogs',        label: 'Export Logs',    type: 'action', source: 'custom', actionLabel: 'Share as text' },
      { key: 'deleteHistory',     label: 'Delete All History', type: 'action', source: 'custom', actionLabel: 'Delete', dangerAction: true },
    ],
  },
  {
    title: 'Sync',
    icon: 'cloud',
    items: [
      { key: 'dotfilesPat',  label: 'GitHub PAT',      type: 'secret', source: 'custom', description: 'For dotfiles gist sync' },
      { key: 'syncToGist',   label: 'Sync to Gist',    type: 'action', source: 'custom', actionLabel: 'Upload' },
      { key: 'syncFromGist', label: 'Sync from Gist',  type: 'action', source: 'custom', actionLabel: 'Download' },
    ],
  },
];

// ─── Value helpers ────────────────────────────────────────────────────────────

function getValue(
  key: string,
  source: 'settings' | 'cosmetic' | 'custom',
  settings: ReturnType<typeof useSettingsStore.getState>['settings'],
  cosmetics: ReturnType<typeof useCosmeticStore.getState>,
  customValues: Record<string, unknown>,
): unknown {
  if (source === 'custom') return customValues[key];
  if (source === 'cosmetic') {
    return (cosmetics as unknown as Record<string, unknown>)[key];
  }
  // Handle nested keys like 'teamMembers.claude'
  if (key.includes('.')) {
    const [parent, child] = key.split('.');
    const obj = (settings as Record<string, unknown>)[parent];
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[child] : undefined;
  }
  return (settings as Record<string, unknown>)[key];
}

function formatValue(value: unknown, type: SettingType): string {
  if (value === undefined || value === null) return '—';
  if (type === 'boolean') return value ? 'on' : 'off';
  if (type === 'number') return String(value);
  if (type === 'secret') return value ? '••••••••' : '(not set)';
  if (type === 'action') return '';
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
  onAction?: () => void;
}

function SettingRow({ def, value, onToggle, onStringEdit, onEnumOpen, onAction }: SettingRowProps) {
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

  // action
  if (def.type === 'action') {
    return (
      <TouchableOpacity style={styles.row} onPress={onAction} activeOpacity={0.7}>
        <View style={styles.rowLeft}>
          <Text style={[styles.rowKey, def.dangerAction && { color: '#F87171' }]}>{def.label}</Text>
          {def.description && <Text style={styles.rowDesc}>{def.description}</Text>}
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.rowValue, def.dangerAction && { color: '#F87171' }]}>{def.actionLabel ?? 'Run'}</Text>
          <MaterialIcons name="chevron-right" size={16} color={def.dangerAction ? '#F87171' : MUTED} />
        </View>
      </TouchableOpacity>
    );
  }

  // secret (API key with masked display)
  if (def.type === 'secret') {
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
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            selectionColor={ACCENT}
            placeholderTextColor={MUTED}
            placeholder="Enter API key..."
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
          <Text style={[styles.rowValue, !value && { color: MUTED }]}>{value ? '••••••••' : '(not set)'}</Text>
          <MaterialIcons name="edit" size={14} color={MUTED} />
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
  const dotfiles = useDotfilesStore();
  const themeStore = useThemeStore();
  const i18n = useI18n();
  const usageStore = useUsageStore();

  const [picker, setPicker] = useState<{
    def: SettingDef;
    current: string;
  } | null>(null);

  // Custom context (loaded async)
  const [customContextText, setCustomContextText] = useState('');
  useEffect(() => {
    if (visible) {
      logLifecycle('ConfigTUI', 'opened');
      loadCustomContext().then(setCustomContextText).catch((e) => {
        logError('ConfigTUI', 'Failed to load custom context', e);
      });
    }
  }, [visible]);

  // Build custom values map for 'custom' source items
  const customValues: Record<string, unknown> = {
    themeEngine: themeStore.currentThemeId,
    locale: i18n.locale,
    'teamMembers.claude': settings.teamMembers?.claude,
    'teamMembers.gemini': settings.teamMembers?.gemini,
    'teamMembers.codex': settings.teamMembers?.codex,
    'teamMembers.perplexity': settings.teamMembers?.perplexity,
    'teamMembers.local': settings.teamMembers?.local,
    customContext: customContextText,
    usageAlertEnabled: usageStore.alertEnabled,
    dotfilesPat: dotfiles.pat,
  };

  const getVal = useCallback(
    (def: SettingDef) => getValue(def.key, def.source, settings, cosmetics, customValues),
    [settings, cosmetics, customValues],
  );

  const applyValue = useCallback(
    (def: SettingDef, rawValue: unknown) => {
      const displayValue = def.type === 'secret' ? (rawValue ? 'set' : 'empty') : String(rawValue);
      logInfo('ConfigTUI', 'Setting ' + def.key + ' = ' + displayValue);
      try {
      // Custom source handling
      if (def.source === 'custom') {
        switch (def.key) {
          case 'themeEngine':
            themeStore.setTheme(String(rawValue));
            break;
          case 'locale':
            i18n.setLocale(String(rawValue) as any);
            break;
          case 'customContext':
            setCustomContextText(String(rawValue));
            saveCustomContext(String(rawValue));
            break;
          case 'usageAlertEnabled':
            usageStore.setAlertSettings({ alertEnabled: Boolean(rawValue) });
            break;
          case 'dotfilesPat':
            dotfiles.setPat(String(rawValue));
            break;
          default:
            // teamMembers.xxx
            if (def.key.startsWith('teamMembers.')) {
              const member = def.key.split('.')[1];
              updateSettings({
                teamMembers: { ...settings.teamMembers, [member]: Boolean(rawValue) },
              } as any);
            }
            break;
        }
        return;
      }
      if (def.source === 'settings') {
        // Handle nested keys
        if (def.key.includes('.')) {
          const [parent, child] = def.key.split('.');
          const current = (settings as Record<string, unknown>)[parent] ?? {};
          updateSettings({ [parent]: { ...(current as object), [child]: rawValue } } as any);
        } else {
          updateSettings({ [def.key]: rawValue } as any);
        }
      } else {
        // cosmetic store
        switch (def.key) {
          case 'crtEnabled':    cosmetics.setCrt(Boolean(rawValue)); break;
          case 'crtIntensity':  cosmetics.setCrtIntensity(Number(rawValue)); break;
          case 'soundProfile':  cosmetics.setSoundProfile(rawValue as SoundProfile); break;
          case 'fontFamily':    cosmetics.setFontFamily(rawValue as FontFamily); break;
          case 'hapticEnabled': cosmetics.setHapticEnabled(Boolean(rawValue)); break;
          default: break;
        }
      }
      } catch (e) {
        logError('ConfigTUI', 'Failed to apply ' + def.key, e);
      }
    },
    [updateSettings, cosmetics, settings, themeStore, i18n, dotfiles, usageStore],
  );

  // Action handlers
  const handleAction = useCallback((def: SettingDef) => {
    logInfo('ConfigTUI', 'Action: ' + def.key);
    switch (def.key) {
      case 'exportLogs': {
        // Try execution log first (has actual native terminal output)
        let text = '';
        try {
          const { useExecutionLogStore } = require('@/store/execution-log-store');
          const logStore = useExecutionLogStore.getState();
          // Per-session output using stored sessionIds
          const sessionOutputs = logStore.getRecentOutputForAllSessions(500);
          if (sessionOutputs && sessionOutputs.length > 0) {
            text = sessionOutputs
              .map((s: { sessionId: string; output: string }) => `=== Session: ${s.sessionId} ===\n${s.output}`)
              .join('\n\n');
          }
          // Fallback: all output combined (no sessionId filter)
          if (!text.trim()) {
            text = logStore.getRecentOutput(500, 0);
          }
        } catch {}
        // Fallback to entries if execution log is empty
        if (!text.trim()) {
          const sessions = useTerminalStore.getState().sessions;
          text = sessions.map((s: any) =>
            s.entries.map((e: any) => `$ ${e.command ?? ''}\n${(e.output ?? []).map((o: any) => o.text).join('\n')}`).join('\n\n')
          ).join('\n---\n');
        }
        if (!text.trim()) text = 'No terminal output to export.';
        Share.share({ message: text, title: 'Shelly Terminal Logs' });
        break;
      }
      case 'deleteHistory':
        Alert.alert('Delete All History', 'This cannot be undone.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => {
            useTerminalStore.getState().sessions.forEach(s => useTerminalStore.getState().clearSession(s.id));
            ToastAndroid.show('History deleted', ToastAndroid.SHORT);
          }},
        ]);
        break;
      case 'syncToGist':
        dotfiles.syncToGist();
        ToastAndroid.show('Syncing to Gist...', ToastAndroid.SHORT);
        break;
      case 'syncFromGist':
        dotfiles.syncFromGist();
        ToastAndroid.show('Syncing from Gist...', ToastAndroid.SHORT);
        break;
    }
  }, [dotfiles]);

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
                        onAction={() => handleAction(def)}
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
