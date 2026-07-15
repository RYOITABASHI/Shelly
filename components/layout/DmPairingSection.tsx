import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { logError } from '@/lib/debug-logger';
import { flushPendingAgentEnvSync } from '@/lib/agent-env-sync';
import { pairingConfidence, type DmPairing, useDmPairingStore } from '@/store/dm-pairing-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

const POLL_MS = 2_000;
const WINDOW_MS = 300_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Candidate = {
  packageName: string;
  notificationId: number;
  notificationTag: string | null;
  shortcutId: string | null;
  title: string;
  textPreview: string;
};

type Flow =
  | { kind: 'idle' }
  | { kind: 'waiting'; code: string; seconds: number }
  | { kind: 'expired' }
  | { kind: 'candidates'; candidates: Candidate[] }
  | { kind: 'confirm'; candidate: Candidate };

function pairingCode(): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `SHELLY-${suffix}`;
}

// Perf: memoized so this section (which owns its own local flow-state and,
// during an active pairing attempt, a self-rescheduling setTimeout poll — see
// `poll` below) doesn't re-render as a side effect of SettingsDropdown's
// other sibling sections re-rendering. Mirrors the same React.memo wrapping
// applied to every other top-level section in SettingsDropdown.tsx.
export const DmPairingSection = React.memo(function DmPairingSection() {
  const { t } = useTranslation();
  const pairings = useDmPairingStore((state) => state.pairings);
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [replyEnabled, setReplyEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    TerminalEmulator.getNotificationReplyEnabled().then(setReplyEnabled).catch((error) => {
      logError('DmPairing', 'Failed to load reply gate', error);
    });
    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const stop = () => {
    cancelled.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const poll = async (code: string, deadline: number) => {
    if (cancelled.current) return;
    try {
      const candidates = await TerminalEmulator.findDmPairingCandidates(code);
      if (!cancelled.current && candidates.length > 0) {
        setFlow({ kind: 'candidates', candidates });
        return;
      }
    } catch (error) {
      logError('DmPairing', 'Candidate scan failed', error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      setFlow({ kind: 'expired' });
      return;
    }
    setFlow({ kind: 'waiting', code, seconds: Math.ceil(remaining / 1000) });
    timer.current = setTimeout(() => void poll(code, deadline), POLL_MS);
  };

  const start = () => {
    stop();
    cancelled.current = false;
    const code = pairingCode();
    const deadline = Date.now() + WINDOW_MS;
    setFlow({ kind: 'waiting', code, seconds: WINDOW_MS / 1000 });
    timer.current = setTimeout(() => void poll(code, deadline), POLL_MS);
  };

  const toggleReply = async () => {
    setBusy(true);
    try {
      const next = !replyEnabled;
      await TerminalEmulator.setNotificationReplyEnabled(next);
      setReplyEnabled(next);
      ToastAndroid.show(next ? t('dm_pairing.reply_enabled_on') : t('dm_pairing.reply_enabled_off'), ToastAndroid.SHORT);
    } catch (error) {
      logError('DmPairing', 'Failed to update reply gate', error);
      Alert.alert(t('dm_pairing.reply_enabled_failed'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    stop();
    setFlow({ kind: 'idle' });
  };

  const failSafeMirror = async () => {
    await TerminalEmulator.setNotificationReplyEnabled(false).catch(() => undefined);
    setReplyEnabled(false);
  };

  const runSelfTest = async () => {
    setTestBusy(true);
    const message = `shelly-dm-self-test-${Date.now()}`;
    try {
      if (!await TerminalEmulator.hasNotificationListenerAccess()) {
        Alert.alert(t('dm_reply_test.listener_access_required'));
        return;
      }
      if (!await TerminalEmulator.getNotificationTriggerEnabled() ||
          !await TerminalEmulator.getNotificationReplyEnabled()) {
        Alert.alert(t('dm_reply_test.flags_required'));
        return;
      }
      await TerminalEmulator.clearDmReplyTestResult();
      if (!await TerminalEmulator.postDmReplyTestNotification()) throw new Error('post failed');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const { packageName } = await TerminalEmulator.getAppVersionInfo();
      if (!await TerminalEmulator.sendNotificationReply(packageName, message)) throw new Error('send failed');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await TerminalEmulator.getDmReplyTestResult();
      Alert.alert(result.receivedText === message ? t('dm_reply_test.pass') : t('dm_reply_test.unconfirmed'));
    } catch (error) {
      logError('DmReplyTest', 'Self-contained round trip failed', error);
      Alert.alert(t('dm_reply_test.failed'));
    } finally {
      await TerminalEmulator.clearDmReplyTestResult().catch(() => undefined);
      setTestBusy(false);
    }
  };

  return (
    <View style={[styles.section, { borderBottomColor: C.border }]}>
      <Text style={styles.sectionTitle}>{t('dm_pairing.title')}</Text>
      <View style={styles.body}>
        <Text style={styles.hint}>{t('dm_pairing.hint')}</Text>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{t('dm_pairing.reply_enabled_label')}</Text>
            <Text style={styles.hint}>{t('dm_pairing.reply_enabled_hint')}</Text>
          </View>
          <Pressable
            onPress={() => void toggleReply()}
            disabled={busy}
            accessibilityRole="switch"
            accessibilityState={{ checked: replyEnabled }}
            style={[styles.toggle, replyEnabled && styles.toggleOn, busy && { opacity: 0.5 }]}
          >
            <Text style={[styles.toggleText, replyEnabled && { color: C.bgDeep }]}>{replyEnabled ? 'ON' : 'OFF'}</Text>
          </Pressable>
        </View>
        <Button label={testBusy ? t('dm_reply_test.running') : t('dm_reply_test.button')} onPress={() => { if (!testBusy) void runSelfTest(); }} />

        {flow.kind === 'idle' && <Button label={t('dm_pairing.start_button')} onPress={start} />}
        {flow.kind === 'waiting' && (
          <View style={styles.box}>
            <Text style={styles.hint}>{t('dm_pairing.send_instruction')}</Text>
            <Pressable onPress={() => void Clipboard.setStringAsync(flow.code)}>
              <Text selectable style={styles.code}>{flow.code}</Text>
            </Pressable>
            <Text style={styles.hint}>{t('dm_pairing.waiting_countdown', { seconds: flow.seconds })}</Text>
            <Button label={t('common.cancel')} onPress={cancel} />
          </View>
        )}
        {flow.kind === 'expired' && (
          <View style={styles.box}>
            <Text style={[styles.hint, { color: C.warning }]}>{t('dm_pairing.window_expired')}</Text>
            <View style={styles.actions}><Button label={t('dm_pairing.retry_button')} onPress={start} /><Button label={t('common.cancel')} onPress={cancel} /></View>
          </View>
        )}
        {flow.kind === 'candidates' && (
          <View style={styles.box}>
            <Text style={styles.label}>{t('dm_pairing.candidates_heading')}</Text>
            <Text style={styles.hint}>{t('dm_pairing.candidates_hint')}</Text>
            {flow.candidates.map((candidate, index) => (
              <Pressable
                key={`${candidate.packageName}-${candidate.notificationId}-${index}`}
                style={styles.candidate}
                onPress={() => { stop(); setFlow({ kind: 'confirm', candidate }); }}
              >
                <Text style={styles.label} numberOfLines={1}>{candidate.packageName}</Text>
                <Text style={styles.hint} numberOfLines={1}>{candidate.title}</Text>
                <Text style={styles.hint} numberOfLines={2}>{candidate.textPreview}</Text>
              </Pressable>
            ))}
            <Button label={t('common.cancel')} onPress={cancel} />
          </View>
        )}
        {flow.kind === 'confirm' && <ConfirmCandidate candidate={flow.candidate} onDone={() => setFlow({ kind: 'idle' })} onCancel={cancel} onMirrorFailure={failSafeMirror} />}

        <Text style={styles.subheading}>{t('dm_pairing.existing_heading')}</Text>
        {pairings.length === 0
          ? <Text style={styles.hint}>{t('dm_pairing.existing_empty')}</Text>
          : pairings.map((pairing) => <PairingRow key={pairing.id} pairing={pairing} onMirrorFailure={failSafeMirror} />)}
      </View>
    </View>
  );
});

function ConfirmCandidate({ candidate, onDone, onCancel, onMirrorFailure }: { candidate: Candidate; onDone: () => void; onCancel: () => void; onMirrorFailure: () => Promise<void> }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(candidate.title || candidate.packageName);
  const confirm = async () => {
    const savedLabel = label.trim() || candidate.packageName;
    useDmPairingStore.getState().addPairing({
      label: savedLabel,
      packageName: candidate.packageName,
      notificationId: candidate.notificationId,
      notificationTag: candidate.notificationTag,
      shortcutId: candidate.shortcutId,
      titleAtPairing: candidate.title,
    });
    if (await flushPendingAgentEnvSync('DM pairing')) {
      ToastAndroid.show(t('dm_pairing.success_toast'), ToastAndroid.SHORT);
      onDone();
    } else {
      // If the mirror cannot be durably published, force the native send gate
      // off so an older on-disk record cannot remain usable behind newer UI state.
      await onMirrorFailure();
    }
  };
  return (
    <View style={styles.box}>
      <Text style={styles.label}>{t('dm_pairing.confirm_heading')}</Text>
      {!candidate.shortcutId && <Text style={[styles.hint, { color: C.warning }]}>{t('dm_pairing.weak_confidence_note')}</Text>}
      <TextInput value={label} onChangeText={setLabel} style={styles.input} placeholderTextColor={C.text3} />
      <View style={styles.actions}><Button label={t('common.cancel')} onPress={onCancel} /><Button label={t('dm_pairing.confirm_button')} onPress={() => void confirm()} /></View>
    </View>
  );
}

function PairingRow({ pairing, onMirrorFailure }: { pairing: DmPairing; onMirrorFailure: () => Promise<void> }) {
  const { t } = useTranslation();
  const mutate = async (kind: 'revoke' | 'remove') => {
    if (kind === 'revoke') useDmPairingStore.getState().revokePairing(pairing.id);
    else useDmPairingStore.getState().removePairing(pairing.id);
    if (!await flushPendingAgentEnvSync('DM pairing')) {
      await onMirrorFailure();
    }
  };
  return (
    <View style={styles.pairing}>
      <Text style={[styles.label, pairing.revoked && { color: C.text3 }]} numberOfLines={1}>{pairing.label}</Text>
      <Text style={styles.hint}>{pairing.packageName} · {pairingConfidence(pairing)}{pairing.revoked ? ` · ${t('dm_pairing.revoked_badge')}` : ''}</Text>
      <View style={styles.actions}>
        {!pairing.revoked && <Button label={t('dm_pairing.revoke_button')} onPress={() => void mutate('revoke')} />}
        <Button label={t('dm_pairing.remove_button')} onPress={() => void mutate('remove')} />
      </View>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.button} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  section: { borderBottomWidth: S.borderWidth, paddingVertical: 6 },
  sectionTitle: { color: C.text2, fontSize: F.badge.size, fontFamily: F.family, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 10, paddingVertical: 4 },
  body: { paddingHorizontal: 8, gap: 6 },
  hint: { color: C.text3, fontSize: F.badge.size, fontFamily: F.family, lineHeight: 15 },
  label: { color: C.text1, fontSize: F.sidebarItem.size, fontFamily: F.family, fontWeight: '700' },
  subheading: { color: C.text2, fontSize: F.badge.size, fontFamily: F.family, fontWeight: '700', marginTop: 6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: S.borderWidth, borderColor: C.border, padding: 6 },
  toggle: { borderWidth: S.borderWidth, borderColor: C.border, paddingHorizontal: 8, paddingVertical: 4 },
  toggleOn: { backgroundColor: C.accent, borderColor: C.accent },
  toggleText: { color: C.text2, fontFamily: F.family, fontSize: F.badge.size, fontWeight: '700' },
  box: { borderWidth: S.borderWidth, borderColor: C.border, backgroundColor: withAlpha(C.accent, 0.05), padding: 6, gap: 5 },
  code: { color: C.accent, fontFamily: F.family, fontSize: 16, fontWeight: '700', letterSpacing: 1.5 },
  candidate: { borderTopWidth: S.borderWidth, borderTopColor: C.border, paddingVertical: 6 },
  input: { color: C.text1, backgroundColor: C.bgDeep, borderWidth: S.borderWidth, borderColor: C.border, fontFamily: F.family, fontSize: F.sidebarItem.size, padding: 6 },
  pairing: { borderTopWidth: S.borderWidth, borderTopColor: C.border, paddingVertical: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  button: { borderWidth: S.borderWidth, borderColor: C.border, paddingHorizontal: 8, paddingVertical: 5, alignSelf: 'flex-end' },
  buttonText: { color: C.accent, fontFamily: F.family, fontSize: F.badge.size, fontWeight: '700' },
});
