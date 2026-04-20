/**
 * components/panes/IssueDraftAction.tsx
 *
 * Ask Pane Stage 2 — "📝 Create GitHub issue" button + preview modal.
 *
 * Rendered below a NOT_AVAILABLE status badge. On tap, opens a slide-up
 * modal with an editable title + body pre-populated from the user's
 * question and the AI's explanation, plus environment info. A second
 * tap POSTs to /repos/RYOITABASHI/Shelly/issues via the shelly-cs
 * OAuth token (already has `repo` scope).
 *
 * On success, collapses to an inline `✓ Issue #NN filed — [View]`
 * chip; [View] opens the issue URL in Shelly's in-app Browser Pane
 * via the existing `shelly://browser?url=…` deep link.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
} from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { buildDraft, createIssue, getEnvInfo, type IssueDraft } from '@/lib/github-issues';

type Props = {
  question: string;
  answer: string;
  shellyVersion?: string;
  bashrcVersion?: string;
  /** Called when an issue is successfully created so the parent turn
   *  can render the follow-up link inline. */
  onCreated?: (issue: { number: number; html_url: string }) => void;
};

export default function IssueDraftAction({
  question,
  answer,
  shellyVersion,
  bashrcVersion,
  onCreated,
}: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ number: number; html_url: string } | null>(null);

  // Env info — loaded once on mount so the draft body has real values
  // (Shelly version + BASHRC_VERSION) instead of "(unknown)". Missing
  // info still posts fine; this is purely cosmetic.
  const [envInfo, setEnvInfo] = useState<{ shellyVersion: string; bashrcVersion: string }>({
    shellyVersion: shellyVersion ?? '(unknown)',
    bashrcVersion: bashrcVersion ?? '(unknown)',
  });
  useEffect(() => {
    // Skip auto-load if the parent explicitly passed values (tests, etc.)
    if (shellyVersion && bashrcVersion) return;
    let cancelled = false;
    getEnvInfo().then((info) => {
      if (!cancelled) setEnvInfo(info);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [shellyVersion, bashrcVersion]);

  const initialDraft = useMemo<IssueDraft>(
    () => buildDraft({
      question,
      answer,
      shellyVersion: envInfo.shellyVersion,
      bashrcVersion: envInfo.bashrcVersion,
    }),
    [question, answer, envInfo.shellyVersion, envInfo.bashrcVersion],
  );
  const [title, setTitle] = useState(initialDraft.title);
  const [body, setBody] = useState(initialDraft.body);

  const styles = useMemo(() => makeStyles(theme), [theme]);

  const openModal = useCallback(() => {
    setTitle(initialDraft.title);
    setBody(initialDraft.body);
    setError(null);
    setOpen(true);
  }, [initialDraft]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await createIssue({
      title: title.trim(),
      body: body.trim(),
      labels: initialDraft.labels,
    });
    setSubmitting(false);
    if (result.ok) {
      setCreated({ number: result.number, html_url: result.html_url });
      setOpen(false);
      onCreated?.({ number: result.number, html_url: result.html_url });
    } else {
      setError(result.error);
    }
  }, [submitting, title, body, initialDraft.labels, onCreated]);

  const openIssueInBrowserPane = useCallback(() => {
    if (!created) return;
    // Uses the shelly://browser?url=... deep link handled in
    // app/_layout.tsx (same bridge that Codespace open uses).
    const deepLink = `shelly://browser?url=${encodeURIComponent(created.html_url)}`;
    Linking.openURL(deepLink).catch(() => {
      // Fallback: the issue URL itself. OS picks whatever handles https.
      Linking.openURL(created.html_url).catch(() => {});
    });
  }, [created]);

  // ─── Rendered inline in the turn bubble ───────────────────────────
  if (created) {
    return (
      <Pressable style={styles.createdChip} onPress={openIssueInBrowserPane}>
        <MaterialIcons name="check-circle" size={12} color={theme.colors.success} />
        <Text style={styles.createdText}>
          ✓ Issue #{created.number} を作成しました
        </Text>
        <Text style={styles.createdLink}>View</Text>
      </Pressable>
    );
  }

  return (
    <>
      <Pressable style={styles.actionBtn} onPress={openModal}>
        <MaterialIcons name="add-task" size={12} color={theme.colors.accent} />
        <Text style={styles.actionText}>GitHub Issue を作成</Text>
      </Pressable>

      <ShellyModal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={closeModal}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={closeModal}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <View style={styles.sheetHeader}>
              <MaterialIcons name="add-task" size={16} color={theme.colors.accent} />
              <Text style={styles.sheetTitle}>GitHub Issue を作成</Text>
            </View>
            <Text style={styles.sheetSubtitle}>RYOITABASHI/Shelly に `from-ask-pane` ラベル付きで投稿されます</Text>

            <ScrollView
              style={styles.formScroll}
              contentContainerStyle={{ paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput
                style={styles.titleInput}
                value={title}
                onChangeText={setTitle}
                editable={!submitting}
                placeholder="[Ask Pane] …"
                placeholderTextColor={theme.colors.muted}
              />

              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Body (Markdown)</Text>
              <TextInput
                style={styles.bodyInput}
                value={body}
                onChangeText={setBody}
                editable={!submitting}
                multiline
                textAlignVertical="top"
              />
            </ScrollView>

            {error && (
              <View style={styles.errorBox}>
                <MaterialIcons name="error-outline" size={14} color={theme.colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.actions}>
              <Pressable
                onPress={closeModal}
                disabled={submitting}
                style={[styles.btn, styles.btnGhost, submitting && { opacity: 0.4 }]}
              >
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={submitting || !title.trim()}
                style={[styles.btn, styles.btnPrimary, (submitting || !title.trim()) && { opacity: 0.6 }]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={theme.colors.background} />
                ) : (
                  <Text style={styles.btnPrimaryText}>Create</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </ShellyModal>
    </>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  const c = theme.colors;
  return StyleSheet.create({
    // ─── inline chip/button (rendered under the turn) ───
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      marginLeft: 20,
      marginTop: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.accent,
    },
    actionText: {
      color: c.accent,
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 10,
    },
    createdChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      marginLeft: 20,
      marginTop: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.success,
      backgroundColor: (c.success ?? '#22c55e') + '14',
    },
    createdText: {
      color: c.foreground,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
    },
    createdLink: {
      color: c.accent,
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 10,
      textDecorationLine: 'underline',
    },

    // ─── slide-up modal ───
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingTop: 8,
      paddingBottom: Platform.OS === 'ios' ? 28 : 18,
      maxHeight: '80%',
    },
    handle: {
      width: 40,
      height: 3,
      borderRadius: 2,
      backgroundColor: c.border,
      alignSelf: 'center',
      marginBottom: 10,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 2,
    },
    sheetTitle: {
      color: c.foreground,
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 13,
    },
    sheetSubtitle: {
      color: c.muted,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
      paddingHorizontal: 2,
      marginTop: 2,
      marginBottom: 10,
    },
    formScroll: {
      maxHeight: 420,
    },
    fieldLabel: {
      color: c.muted,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
      letterSpacing: 0.5,
      marginBottom: 4,
      paddingHorizontal: 2,
    },
    titleInput: {
      color: c.foreground,
      backgroundColor: c.surfaceAlt ?? c.background,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 12,
    },
    bodyInput: {
      color: c.foreground,
      backgroundColor: c.surfaceAlt ?? c.background,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 11,
      minHeight: 200,
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingHorizontal: 2,
      marginTop: 8,
    },
    errorText: {
      flex: 1,
      color: c.error,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 14,
    },
    btn: {
      minWidth: 88,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnGhost: {
      borderWidth: 1,
      borderColor: c.border,
    },
    btnGhostText: {
      color: c.muted,
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 12,
    },
    btnPrimary: {
      backgroundColor: c.accent,
    },
    btnPrimaryText: {
      color: c.background,
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 12,
    },
  });
}
