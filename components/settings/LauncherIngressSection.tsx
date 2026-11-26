/**
 * Settings: the owner-installed launcher's trusted-caller entry and the D1
 * taint exemption (lib/launcher-ingress.ts; TrustedCallerStore.kt is the truth).
 *
 * Shelly ships no package name or certificate pin: the owner types them here.
 * This section only calls the lib wrappers and never logs what was typed.
 */
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { createThemedStyles } from '@/lib/themed-stylesheet';
import { withAlpha } from '@/lib/theme-utils';
import { useLauncherInboxStore } from '@/store/launcher-inbox-store';
import {
  digestLabel,
  isValidPackageName,
  listTrustedCallers,
  parsePinList,
  pinsLabel,
  removeLauncherCaller,
  setLauncherCaller,
  setLauncherExemption,
  type TrustedCaller,
  type TrustedCallerStatus,
} from '@/lib/launcher-ingress';

type Result = TrustedCallerStatus & { ok?: boolean; code?: string };

const KNOWN_CODES = new Set([
  'invalid', 'invalid_package', 'invalid_pin', 'full', 'no_caller',
  'not_exemptable', 'digest_changed', 'failed', 'unavailable',
]);

export const LauncherIngressSection = React.memo(function LauncherIngressSection({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TrustedCallerStatus>({ status: 'empty', callers: [] });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pkg, setPkg] = useState('');
  const [pinsText, setPinsText] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    listTrustedCallers()
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { /* wrapper never throws; keep the last state */ });
    return () => { cancelled = true; };
  }, [visible]);

  const caller: TrustedCaller | undefined = state.callers[0];

  const apply = (res: Result): boolean => {
    setState({ status: res.status, callers: res.callers });
    if (res.ok === false) {
      const code = res.code ?? 'failed';
      setError(KNOWN_CODES.has(code) ? t(`launcher_ingress.err.${code}`) : t('launcher_ingress.err.generic', { code }));
      return false;
    }
    setError(null);
    return true;
  };

  const run = async (fn: () => Promise<Result>): Promise<boolean> => {
    setBusy(true);
    try {
      return apply(await fn());
    } finally {
      setBusy(false);
    }
  };

  const openForm = (c?: TrustedCaller) => {
    setPkg(c?.packageName ?? '');
    setPinsText(c ? c.pins.join('\n') : '');
    setFormEnabled(c?.enabled ?? true);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const name = pkg.trim();
    if (!isValidPackageName(name)) { setError(t('launcher_ingress.err.package')); return; }
    const pins = parsePinList(pinsText);
    if (!pins) { setError(t('launcher_ingress.err.pins')); return; }
    if (await run(() => setLauncherCaller(name, pins, formEnabled))) setEditing(false);
  };

  const toggleEnabled = () => {
    if (!caller) return;
    void run(() => setLauncherCaller(caller.packageName, caller.pins, !caller.enabled));
  };

  const confirmRemove = () => {
    Alert.alert(t('launcher_ingress.remove_title'), t('launcher_ingress.remove_body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.remove'), style: 'destructive', onPress: () => { void run(removeLauncherCaller); } },
    ]);
  };

  const toggleExemption = () => {
    if (!caller) return;
    if (caller.exemptionBound) {
      void run(() => setLauncherExemption(false, null));
      return;
    }
    const digest = caller.pinsDigest;
    Alert.alert(
      t('launcher_ingress.exemption_confirm_title'),
      t('launcher_ingress.exemption_confirm_body', { package: caller.packageName, pins: pinsLabel(caller.pins), digest: digestLabel(digest) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('launcher_ingress.exemption_confirm_ok'), onPress: () => { void run(() => setLauncherExemption(true, digest)); } },
      ],
    );
  };

  const showForm = editing || !caller;

  return (
    <View style={[styles.section, { borderBottomColor: C.border }]}>
      <Text style={styles.sectionTitle}>{t('launcher_ingress.title')}</Text>
      <View style={styles.body}>
        {state.status === 'unreadable' && <Text style={[styles.hint, { color: C.warning }]}>{t('launcher_ingress.unreadable')}</Text>}
        {showForm || !caller ? (
          <>
            <Text style={styles.hint}>{t('launcher_ingress.intro')}</Text>
            <Text style={styles.label}>{t('launcher_ingress.package_label')}</Text>
            <TextInput
              value={pkg}
              onChangeText={setPkg}
              placeholder="com.example.launcher"
              placeholderTextColor={C.text3}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel={t('launcher_ingress.package_label')}
            />
            <Text style={styles.label}>{t('launcher_ingress.pins_label')}</Text>
            <TextInput
              value={pinsText}
              onChangeText={setPinsText}
              placeholder={t('launcher_ingress.pins_placeholder')}
              placeholderTextColor={C.text3}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={[styles.input, { minHeight: 64, textAlignVertical: 'top' }]}
              accessibilityLabel={t('launcher_ingress.pins_label')}
            />
            <Text style={styles.hint}>{t('launcher_ingress.pins_hint')}</Text>
            <View style={styles.toggleRow}>
              <Text style={[styles.label, { flex: 1 }]}>{t('launcher_ingress.enabled_label')}</Text>
              <Switch on={formEnabled} onPress={() => setFormEnabled((v) => !v)} disabled={busy} label={t('launcher_ingress.enabled_label')} />
            </View>
            {error && <Text style={[styles.hint, { color: C.warning }]}>{error}</Text>}
            <View style={styles.actions}>
              {caller && <Button label={t('common.cancel')} onPress={() => { setEditing(false); setError(null); }} disabled={busy} />}
              <Button label={t('common.save')} onPress={() => void save()} disabled={busy} />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.label} numberOfLines={1}>{caller.packageName}</Text>
            <Text style={styles.hint}>{t('launcher_ingress.pin_count', { count: caller.pins.length })}</Text>
            <Text style={styles.hint}>{t('launcher_ingress.digest', { digest: digestLabel(caller.pinsDigest) })}</Text>
            <View style={styles.toggleRow}>
              <Text style={[styles.label, { flex: 1 }]}>{t('launcher_ingress.enabled_label')}</Text>
              <Switch on={caller.enabled} onPress={toggleEnabled} disabled={busy} label={t('launcher_ingress.enabled_label')} />
            </View>
            <View style={styles.actions}>
              <Button label={t('common.edit')} onPress={() => openForm(caller)} disabled={busy} />
              <Button label={t('common.remove')} onPress={confirmRemove} disabled={busy} />
            </View>
            <View style={styles.box}>
              <Text style={styles.label}>{t('launcher_ingress.exemption_title')}</Text>
              <Text style={styles.hint}>{t('launcher_ingress.exemption_body')}</Text>
              <View style={styles.toggleRow}>
                <Text style={[styles.hint, { flex: 1 }]}>
                  {t(caller.exemptionBound ? 'launcher_ingress.exemption_on' : 'launcher_ingress.exemption_off')}
                </Text>
                <Switch on={caller.exemptionBound} onPress={toggleExemption} disabled={busy} label={t('launcher_ingress.exemption_title')} />
              </View>
            </View>
            {/* Phase 2: the read-only approval inbox (pending ones reopen the prompt). */}
            <View style={styles.actions}>
              <Button label={t('launcher_ingress.inbox_button')} onPress={() => useLauncherInboxStore.getState().open()} />
            </View>
            {error && <Text style={[styles.hint, { color: C.warning }]}>{error}</Text>}
          </>
        )}
      </View>
    </View>
  );
});

function Switch({ on, onPress, disabled, label }: { on: boolean; onPress: () => void; disabled?: boolean; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled: !!disabled }}
      style={[styles.track, { backgroundColor: on ? withAlpha(C.accent, 0.36) : C.border }, disabled && { opacity: 0.5 }]}
    >
      <View style={[styles.thumb, { backgroundColor: on ? C.accent : C.text2 }, on && { alignSelf: 'flex-end' }]} />
    </Pressable>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.button, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled} accessibilityRole="button">
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = createThemedStyles(() => ({
  section: { borderBottomWidth: S.borderWidth, paddingVertical: 6 },
  sectionTitle: { color: C.text2, fontSize: F.badge.size, fontFamily: F.family, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 10, paddingVertical: 4 },
  body: { paddingHorizontal: 8, gap: 6 },
  hint: { color: C.text3, fontSize: F.badge.size, fontFamily: F.family, lineHeight: 15 },
  label: { color: C.text1, fontSize: F.sidebarItem.size, fontFamily: F.family, fontWeight: '700' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  box: { borderWidth: S.borderWidth, borderColor: C.border, backgroundColor: withAlpha(C.accent, 0.05), padding: 6, gap: 5, marginTop: 4 },
  input: { color: C.text1, backgroundColor: C.bgDeep, borderWidth: S.borderWidth, borderColor: C.border, fontFamily: F.family, fontSize: F.sidebarItem.size, padding: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  button: { borderWidth: S.borderWidth, borderColor: C.border, paddingHorizontal: 8, paddingVertical: 5 },
  buttonText: { color: C.accent, fontFamily: F.family, fontSize: F.badge.size, fontWeight: '700' },
  track: { width: 28, height: 14, borderRadius: 7, justifyContent: 'center', paddingHorizontal: 2 },
  thumb: { width: 10, height: 10, borderRadius: 5 },
}));
