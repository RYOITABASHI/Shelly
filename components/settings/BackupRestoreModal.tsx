// components/settings/BackupRestoreModal.tsx
//
// Encrypted backup / restore UI (signing-key migration: back up on the old
// install, restore on the new one). Logic lives in lib/backup/*; this file is
// presentation + flow only.
//
// The passphrase only ever lives in this component's state. It is cleared on
// close, on unmount, and as soon as a run finishes. Never log it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { assessPassphrase, BackupDecryptError, generatePassphrase } from '@/lib/backup/crypto';
import {
  listBackupCandidates,
  runBackup,
  runRestore,
  siblingTarPath,
  type BackupCandidate,
  type BackupPhase,
  type BackupResult,
  type RestoreSummary,
} from '@/lib/backup/service';
import { createDeviceBackupDeps, reloadAppAfterRestore } from '@/lib/backup/device';
import { useBackupModalStore } from '@/store/backup-modal-store';

export type BackupRestoreModalProps = {
  visible: boolean;
  onClose: () => void;
  initialMode?: 'backup' | 'restore';
  reason?: 'signing-migration';
};

type Mode = 'backup' | 'restore';
type Step = 'intro' | 'passphrase' | 'running' | 'done' | 'error';

export function BackupRestoreModal({ visible, onClose, initialMode = 'backup', reason }: BackupRestoreModalProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState<Step>('intro');
  // backup options
  const [includeCodexAuth, setIncludeCodexAuth] = useState(true);
  const [includeLarge, setIncludeLarge] = useState(false);
  // passphrase (component state ONLY)
  const [generated, setGenerated] = useState('');
  const [useOwn, setUseOwn] = useState(false);
  const [own, setOwn] = useState('');
  const [ownConfirm, setOwnConfirm] = useState('');
  const [writtenDown, setWrittenDown] = useState(false);
  const [restorePass, setRestorePass] = useState('');
  // restore selection
  const [candidates, setCandidates] = useState<BackupCandidate[] | null>(null);
  const [selected, setSelected] = useState<BackupCandidate | null>(null);
  const [manualPath, setManualPath] = useState('');
  // progress / results
  const [phase, setPhase] = useState<BackupPhase | null>(null);
  const [kdfPct, setKdfPct] = useState(0);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null);
  const [errorText, setErrorText] = useState('');
  const [restartFailed, setRestartFailed] = useState(false);
  const mounted = useRef(true);

  const clearSecrets = useCallback(() => {
    setGenerated('');
    setOwn('');
    setOwnConfirm('');
    setRestorePass('');
    setWrittenDown(false);
  }, []);

  const resetAll = useCallback((m: Mode) => {
    clearSecrets();
    setMode(m);
    setStep('intro');
    setUseOwn(false);
    setPhase(null);
    setKdfPct(0);
    setBackupResult(null);
    setRestoreSummary(null);
    setErrorText('');
    setRestartFailed(false);
    setSelected(null);
    setManualPath('');
  }, [clearSecrets]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset whenever the modal opens; wipe secrets whenever it closes.
  useEffect(() => {
    if (visible) resetAll(initialMode);
    else clearSecrets();
  }, [visible, initialMode, resetAll, clearSecrets]);

  const refreshCandidates = useCallback(async () => {
    setCandidates(null);
    try {
      const list = await listBackupCandidates(createDeviceBackupDeps());
      if (!mounted.current) return;
      setCandidates(list);
      setSelected((cur) => cur ?? list[0] ?? null);
    } catch {
      if (mounted.current) setCandidates([]);
    }
  }, []);

  useEffect(() => {
    if (visible && mode === 'restore' && step === 'intro' && candidates === null) void refreshCandidates();
  }, [visible, mode, step, candidates, refreshCandidates]);

  const handleClose = useCallback(() => {
    if (step === 'running') return; // don't abandon a half-written backup/restore
    clearSecrets();
    onClose();
  }, [step, clearSecrets, onClose]);

  const goPassphrase = useCallback(async () => {
    setWrittenDown(false);
    setOwn('');
    setOwnConfirm('');
    if (mode === 'backup' && !generated) {
      try {
        const p = await generatePassphrase();
        if (mounted.current) setGenerated(p);
      } catch {
        setUseOwn(true);
      }
    }
    setStep('passphrase');
  }, [mode, generated]);

  const ownAssessment = useMemo(() => assessPassphrase(own), [own]);
  const backupPassphrase = useOwn ? own : generated;
  const canStartBackup = useOwn
    ? ownAssessment.ok && own === ownConfirm
    : generated.length > 0 && writtenDown;

  const restoreBundlePath = manualPath.trim() || selected?.bundlePath || '';
  const restoreTarPath = manualPath.trim() ? siblingTarPath(manualPath.trim()) : selected?.tarPath ?? null;

  const onProgress = useCallback((p: BackupPhase, f?: number) => {
    if (!mounted.current) return;
    setPhase(p);
    if (p === 'kdf' && typeof f === 'number') setKdfPct(Math.round(f * 100));
  }, []);

  const startBackup = useCallback(async () => {
    const pass = backupPassphrase;
    setStep('running');
    setPhase('listing');
    try {
      const result = await runBackup(createDeviceBackupDeps(), {
        passphrase: pass,
        includeCodexAuth,
        includeLarge,
        onProgress,
      });
      if (!mounted.current) return;
      clearSecrets();
      setBackupResult(result);
      setStep('done');
    } catch (e) {
      if (!mounted.current) return;
      clearSecrets();
      setErrorText(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [backupPassphrase, includeCodexAuth, includeLarge, onProgress, clearSecrets]);

  const startRestore = useCallback(async () => {
    const pass = restorePass;
    setStep('running');
    setPhase('reading');
    try {
      const summary = await runRestore(createDeviceBackupDeps(), {
        bundlePath: restoreBundlePath,
        tarPath: restoreTarPath,
        passphrase: pass,
        onProgress,
      });
      if (!mounted.current) return;
      clearSecrets();
      setRestoreSummary(summary);
      setStep('done');
    } catch (e) {
      if (!mounted.current) return;
      clearSecrets();
      setErrorText(e instanceof BackupDecryptError ? t('backup.wrong_passphrase') : e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }, [restorePass, restoreBundlePath, restoreTarPath, onProgress, clearSecrets, t]);

  const handleRestart = useCallback(async () => {
    const ok = await reloadAppAfterRestore();
    if (!ok && mounted.current) setRestartFailed(true);
  }, []);

  const s = useMemo(() => makeStyles(colors), [colors]);

  // ─── render helpers ──────────────────────────────────────────────────────

  const Btn = ({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[s.btn, primary ? s.btnPrimary : null, disabled ? s.btnDisabled : null]}
    >
      <Text style={[s.btnText, primary ? s.btnPrimaryText : null]}>{label}</Text>
    </Pressable>
  );

  const ToggleRow = ({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) => (
    <View style={s.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.body}>{label}</Text>
        <Text style={s.hint}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );

  const phaseLabel = phase
    ? phase === 'kdf'
      ? t('backup.phase.kdf', { pct: kdfPct })
      : t(`backup.phase.${phase}`)
    : '';

  const renderBackupIntro = () => (
    <>
      <Text style={s.sectionTitle}>{t('backup.intro_title')}</Text>
      <Text style={s.body}>{t('backup.intro_secrets')}</Text>
      <Text style={s.body}>{t('backup.intro_files')}</Text>
      <View style={s.warnBox}>
        <MaterialIcons name="warning" size={14} color={colors.warning} />
        <Text style={[s.body, { flex: 1 }]}>{t('backup.storage_warning')}</Text>
      </View>
      <ToggleRow label={t('backup.toggle_codex')} hint={t('backup.toggle_codex_hint')} value={includeCodexAuth} onChange={setIncludeCodexAuth} />
      <ToggleRow label={t('backup.toggle_large')} hint={t('backup.toggle_large_hint')} value={includeLarge} onChange={setIncludeLarge} />
      <View style={s.actions}>
        <Btn label={t('backup.next')} onPress={() => void goPassphrase()} primary />
      </View>
    </>
  );

  const renderBackupPassphrase = () => (
    <>
      <Text style={s.sectionTitle}>{t('backup.passphrase_title')}</Text>
      {!useOwn ? (
        <>
          <Text style={s.hint}>{t('backup.generated_label')}</Text>
          <Text selectable style={s.passphrase} accessibilityLabel={t('backup.generated_label')}>
            {generated}
          </Text>
          <View style={s.dangerBox}>
            <MaterialIcons name="error-outline" size={14} color={colors.error} />
            <Text style={[s.body, s.dangerText, { flex: 1 }]}>{t('backup.generated_warning')}</Text>
          </View>
          <Pressable
            style={s.checkRow}
            onPress={() => setWrittenDown((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: writtenDown }}
          >
            <MaterialIcons name={writtenDown ? 'check-box' : 'check-box-outline-blank'} size={18} color={colors.accent} />
            <Text style={s.body}>{t('backup.confirm_written')}</Text>
          </Pressable>
          <Pressable onPress={() => setUseOwn(true)} accessibilityRole="button">
            <Text style={s.link}>{t('backup.use_own')}</Text>
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            style={s.input}
            value={own}
            onChangeText={setOwn}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            placeholder={t('backup.own_placeholder')}
            placeholderTextColor={colors.inactive}
          />
          <TextInput
            style={s.input}
            value={ownConfirm}
            onChangeText={setOwnConfirm}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            placeholder={t('backup.own_confirm_placeholder')}
            placeholderTextColor={colors.inactive}
          />
          {own.length > 0 && (
            <Text style={[s.hint, { color: ownAssessment.ok ? colors.success : colors.error }]}>
              {ownAssessment.ok ? t('backup.strength_ok') : t(`backup.weak.${ownAssessment.reason}`)}
            </Text>
          )}
          {ownConfirm.length > 0 && own !== ownConfirm && (
            <Text style={[s.hint, { color: colors.error }]}>{t('backup.mismatch')}</Text>
          )}
          <Text style={[s.body, s.dangerText]}>{t('backup.generated_warning')}</Text>
          {generated ? (
            <Pressable onPress={() => { setUseOwn(false); setOwn(''); setOwnConfirm(''); }} accessibilityRole="button">
              <Text style={s.link}>{t('backup.use_generated')}</Text>
            </Pressable>
          ) : null}
        </>
      )}
      <View style={s.actions}>
        <Btn label={t('backup.back')} onPress={() => { setOwn(''); setOwnConfirm(''); setStep('intro'); }} />
        <Btn label={t('backup.start_backup')} onPress={() => void startBackup()} disabled={!canStartBackup} primary />
      </View>
    </>
  );

  const renderRestoreIntro = () => (
    <>
      <Text style={s.sectionTitle}>{t('backup.restore_pick')}</Text>
      {candidates === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : candidates.length === 0 ? (
        <Text style={s.hint}>{t('backup.no_candidates')}</Text>
      ) : (
        candidates.map((c) => {
          const active = !manualPath.trim() && selected?.bundlePath === c.bundlePath;
          return (
            <Pressable
              key={c.bundlePath}
              onPress={() => { setSelected(c); setManualPath(''); }}
              style={[s.candidate, active ? s.candidateActive : null]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <MaterialIcons name={active ? 'radio-button-checked' : 'radio-button-unchecked'} size={16} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={s.mono}>{c.bundlePath.split('/').pop()}</Text>
                <Text style={s.hint}>{c.tarPath ? t('backup.tar_found', { path: c.tarPath.split('/').pop() ?? '' }) : t('backup.tar_missing')}</Text>
              </View>
            </Pressable>
          );
        })
      )}
      <Pressable onPress={() => void refreshCandidates()} accessibilityRole="button">
        <Text style={s.link}>{t('backup.refresh')}</Text>
      </Pressable>
      <Text style={s.hint}>{t('backup.manual_path')}</Text>
      <TextInput
        style={s.input}
        value={manualPath}
        onChangeText={setManualPath}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="/sdcard/Download/shelly-backup-….shellybak"
        placeholderTextColor={colors.inactive}
      />
      {manualPath.trim() ? (
        <Text style={s.hint}>{restoreTarPath ? t('backup.tar_found', { path: restoreTarPath }) : t('backup.tar_missing')}</Text>
      ) : null}
      <View style={s.warnBox}>
        <MaterialIcons name="warning" size={14} color={colors.warning} />
        <Text style={[s.body, { flex: 1 }]}>{t('backup.restore_warning')}</Text>
      </View>
      <View style={s.actions}>
        <Btn label={t('backup.next')} onPress={() => void goPassphrase()} disabled={!restoreBundlePath.startsWith('/')} primary />
      </View>
    </>
  );

  const renderRestorePassphrase = () => (
    <>
      <Text style={s.sectionTitle}>{t('backup.passphrase_enter')}</Text>
      <Text style={s.mono}>{restoreBundlePath}</Text>
      <TextInput
        style={s.input}
        value={restorePass}
        onChangeText={setRestorePass}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        placeholder={t('backup.own_placeholder')}
        placeholderTextColor={colors.inactive}
      />
      <View style={s.actions}>
        <Btn label={t('backup.back')} onPress={() => { setRestorePass(''); setStep('intro'); }} />
        <Btn label={t('backup.start_restore')} onPress={() => void startRestore()} disabled={restorePass.length === 0} primary />
      </View>
    </>
  );

  const renderRunning = () => (
    <View style={s.center}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Text style={s.body}>{phaseLabel}</Text>
      <Text style={s.hint}>{t('backup.running_hint')}</Text>
    </View>
  );

  const reasonLabel = (r: string) => t(`backup.skip_reason.${r}`);

  const renderBackupDone = (r: BackupResult) => (
    <>
      <Text style={s.sectionTitle}>{t('backup.done_title')}</Text>
      <Text style={s.hint}>{t('backup.done_bundle')}</Text>
      <Text selectable style={s.mono}>{r.bundlePath}</Text>
      <Text style={s.hint}>{t('backup.done_tar')}</Text>
      <Text selectable style={s.mono}>{r.tarPath ?? t('backup.done_no_tar')}</Text>
      <Text style={s.body}>{t('backup.done_counts', r.counts)}</Text>
      <Text style={s.body}>{t('backup.done_keys', { count: r.secureKeys.length })}</Text>
      <Text style={s.body}>{t('backup.done_credfiles', { count: r.credentialFiles.length })}</Text>
      {r.skippedLargeFiles > 0 ? <Text style={s.hint}>{t('backup.done_skipped_large', { count: r.skippedLargeFiles })}</Text> : null}
      {r.skippedSecretFiles.map((f) => (
        <Text key={f.path} style={s.hint}>{`${t('backup.summary_skipped')}: ${f.path} (${reasonLabel(f.reason)})`}</Text>
      ))}
      <View style={s.warnBox}>
        <MaterialIcons name="info-outline" size={14} color={colors.accent} />
        <Text style={[s.body, { flex: 1 }]}>{t('backup.done_next_steps')}</Text>
      </View>
      <View style={s.actions}>
        <Btn label={t('backup.done')} onPress={handleClose} primary />
      </View>
    </>
  );

  const renderRestoreDone = (r: RestoreSummary) => (
    <>
      <Text style={s.sectionTitle}>{t('backup.summary_title')}</Text>
      <Text style={s.body}>{t('backup.summary_settings', { count: r.settingsKeys.length })}</Text>
      <Text style={s.hint}>{r.settingsKeys.join(', ') || t('backup.none')}</Text>
      <Text style={s.body}>{t('backup.summary_keys')}</Text>
      <Text style={s.hint}>{r.apiKeys.join(', ') || t('backup.none')}</Text>
      <Text style={s.body}>{t('backup.summary_files')}</Text>
      <Text style={s.hint}>{r.credentialFiles.join(', ') || t('backup.none')}</Text>
      <Text style={s.body}>{t('backup.summary_home', { count: r.homeFilesRestored })}</Text>
      <Text style={s.body}>{t('backup.done_counts', r.counts)}</Text>
      {r.tarSkippedReason ? <Text style={[s.hint, { color: colors.warning }]}>{t('backup.summary_tar_skipped')}</Text> : null}
      {(r.skippedSecureKeys.length > 0 || r.skippedFiles.length > 0 || r.skippedSettingsKeys.length > 0) && (
        <>
          <Text style={s.body}>{t('backup.summary_skipped')}</Text>
          {r.skippedSecureKeys.map((k) => <Text key={`k-${k.name}`} style={s.hint}>{`${k.name} (${reasonLabel(k.reason)})`}</Text>)}
          {r.skippedFiles.map((f) => <Text key={`f-${f.path}`} style={s.hint}>{`${f.path} (${reasonLabel(f.reason)})`}</Text>)}
          {r.skippedSettingsKeys.map((k) => <Text key={`s-${k}`} style={s.hint}>{`${k} (${reasonLabel('install_specific')})`}</Text>)}
        </>
      )}
      <View style={s.warnBox}>
        <MaterialIcons name="link-off" size={14} color={colors.warning} />
        <Text style={[s.body, { flex: 1 }]}>{t('backup.repair_note')}</Text>
      </View>
      <Text style={s.hint}>{t('backup.agents_note')}</Text>
      {restartFailed ? <Text style={[s.body, { color: colors.warning }]}>{t('backup.restart_manual')}</Text> : null}
      <View style={s.actions}>
        <Btn label={t('backup.restart')} onPress={() => void handleRestart()} primary />
      </View>
    </>
  );

  const renderError = () => (
    <>
      <Text style={s.sectionTitle}>{t('backup.error_title')}</Text>
      <Text selectable style={[s.body, { color: colors.error }]}>{errorText}</Text>
      <View style={s.actions}>
        <Btn label={t('backup.close')} onPress={handleClose} />
        <Btn label={t('backup.retry')} onPress={() => resetAll(mode)} primary />
      </View>
    </>
  );

  let content: React.ReactNode;
  if (step === 'running') content = renderRunning();
  else if (step === 'error') content = renderError();
  else if (step === 'done') content = mode === 'backup' && backupResult ? renderBackupDone(backupResult) : restoreSummary ? renderRestoreDone(restoreSummary) : null;
  else if (mode === 'backup') content = step === 'intro' ? renderBackupIntro() : renderBackupPassphrase();
  else content = step === 'intro' ? renderRestoreIntro() : renderRestorePassphrase();

  const tabsLocked = step === 'running' || step === 'done';

  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={handleClose}>
      <View style={[s.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
        <View style={s.header}>
          <MaterialIcons name="settings-backup-restore" size={16} color={colors.accent} />
          <Text style={s.title}>{t('backup.title')}</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={handleClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('backup.close')} disabled={step === 'running'}>
            <MaterialIcons name="close" size={18} color={step === 'running' ? colors.inactive : colors.accent} />
          </Pressable>
        </View>
        <View style={s.tabs}>
          {(['backup', 'restore'] as const).map((m) => (
            <Pressable
              key={m}
              disabled={tabsLocked}
              onPress={() => { if (m !== mode) { resetAll(m); setCandidates(null); } }}
              style={[s.tab, mode === m ? s.tabActive : null]}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m, disabled: tabsLocked }}
            >
              <Text style={[s.tabText, mode === m ? s.tabTextActive : null]}>{t(m === 'backup' ? 'backup.tab_backup' : 'backup.tab_restore')}</Text>
            </Pressable>
          ))}
        </View>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          {reason === 'signing-migration' && (
            <View style={s.warnBox}>
              <MaterialIcons name="verified-user" size={14} color={colors.warning} />
              <Text style={[s.body, { flex: 1 }]}>{t('backup.migration_banner')}</Text>
            </View>
          )}
          {content}
        </ScrollView>
      </View>
    </Modal>
  );
}

type Palette = ReturnType<typeof useTheme>['colors'];

function makeStyles(c: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background, paddingHorizontal: 16 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    title: { color: c.foreground, fontSize: 15, fontWeight: '700' },
    tabs: { flexDirection: 'row', gap: 8, paddingVertical: 10 },
    tab: { flex: 1, paddingVertical: 8, borderWidth: 1, borderColor: c.border, borderRadius: 6, alignItems: 'center', backgroundColor: c.surface },
    tabActive: { borderColor: c.accent },
    tabText: { color: c.muted, fontSize: 13 },
    tabTextActive: { color: c.accent, fontWeight: '700' },
    scroll: { paddingBottom: 32, gap: 10 },
    sectionTitle: { color: c.foreground, fontSize: 14, fontWeight: '700', marginTop: 4 },
    body: { color: c.foreground, fontSize: 13, lineHeight: 19 },
    hint: { color: c.muted, fontSize: 12, lineHeight: 17 },
    link: { color: c.link, fontSize: 13, paddingVertical: 4 },
    mono: { color: c.foreground, fontFamily: 'monospace', fontSize: 12 },
    passphrase: {
      color: c.foreground,
      fontFamily: 'monospace',
      fontSize: 22,
      lineHeight: 34,
      letterSpacing: 1,
      textAlign: 'center',
      paddingVertical: 14,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 8,
      backgroundColor: c.surface,
    },
    warnBox: { flexDirection: 'row', gap: 8, padding: 10, borderWidth: 1, borderColor: c.warning, borderRadius: 6, backgroundColor: c.surface, alignItems: 'flex-start' },
    dangerBox: { flexDirection: 'row', gap: 8, padding: 10, borderWidth: 1, borderColor: c.error, borderRadius: 6, backgroundColor: c.surface, alignItems: 'flex-start' },
    dangerText: { color: c.error, fontWeight: '700' },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: c.foreground, backgroundColor: c.surface, fontFamily: 'monospace', fontSize: 13 },
    candidate: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 6, backgroundColor: c.surface },
    candidateActive: { borderColor: c.accent },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
    btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    btnPrimary: { borderColor: c.accent, backgroundColor: c.accent },
    btnDisabled: { opacity: 0.4 },
    btnText: { color: c.foreground, fontSize: 13, fontWeight: '600' },
    btnPrimaryText: { color: c.background },
    center: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  });
}

/** Globally-mounted instance (ShellLayout) driven by store/backup-modal-store —
 *  opened from Settings and the shelly://backup / shelly://restore deep links. */
export function BackupRestoreModalHost() {
  const visible = useBackupModalStore((st) => st.visible);
  const mode = useBackupModalStore((st) => st.mode);
  const close = useBackupModalStore((st) => st.close);
  return <BackupRestoreModal visible={visible} onClose={close} initialMode={mode} />;
}

export default BackupRestoreModal;
