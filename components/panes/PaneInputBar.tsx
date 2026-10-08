/**
 * components/panes/PaneInputBar.tsx
 *
 * Shared bottom input bar for all pane types. Buttons live inside a
 * rounded pill next to the input so the whole row reads as one control
 * rather than three separate circles. Pass `showMic` + `onMicPress` to
 * render a mic button next to send (AI pane). Leave off for browser /
 * markdown panes.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  Image,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { KEY_BAR_HEIGHT } from '@/lib/layout-constants';
import { usePanelBackground } from '@/hooks/use-panel-background';
import { useTheme } from '@/hooks/use-theme';
import { usePaneStore } from '@/store/pane-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { insertQuoteIntoDraft } from '@/lib/quote-to-ai';
import { logInfo } from '@/lib/debug-logger';

type Props = {
  placeholder?: string;
  onSubmit: (text: string) => void;
  onAttach?: () => void;
  showMic?: boolean;
  isRecording?: boolean;
  onMicPress?: () => void;
  onMicLongPress?: () => void;
  /** REMOTE-INPUT-001: this pane's leaf id (from PaneIdContext). When set,
   *  the input bar listens for the native `onRemoteTextInput` event and
   *  inserts the received text at the cursor — but only while this pane is
   *  the focused one (usePaneStore.focusedPaneId), so an adb-triggered
   *  broadcast lands in whichever AI/Browser/Markdown pane the user is
   *  actually looking at, not every mounted PaneInputBar at once. */
  paneId?: string;
  /** Vision v1.1 (Fable5, 2026-08-29): a staged image (AIPane.tsx) shown as
   *  a small thumbnail strip above the pill, with its own remove button.
   *  When present, Send is enabled even with empty text (the caption is
   *  optional — the caller falls back to a default prompt), and `onSubmit`
   *  fires with whatever text is typed (possibly ''). Unused by
   *  Browser/Markdown panes (they never pass this). */
  attachmentPreview?: { uri: string; onRemove: () => void } | null;
  /** Conversational provider-connect flow (2026-09-20, see
   *  lib/provider-connect-intent.ts): the caller sets this true while the
   *  active conversation has a pendingApiKeyProvider, so the next thing
   *  typed here — presumably a pasted API key — isn't shown on-screen
   *  either, not just excluded from storage on the dispatch side. */
  secureEntry?: boolean;
  /** "Quote to AI" (lib/quote-to-ai.ts): when set together with `paneId`,
   *  a quote queued on pane-store for this pane+tab is claimed into the
   *  draft at the cursor (never auto-sent). Only AIPane passes this. */
  quoteTab?: 'ai';
  /** AI pane: let the composer wrap and auto-grow (up to
   *  COMPOSER_MAX_LINES, then scroll) so a multi-line "Ask AI" quote stays
   *  readable instead of collapsing into one scrolling line. The Enter key
   *  still SENDS (submitBehavior="submit"), exactly like the single-line
   *  composer; newlines arrive via paste / quote insertion. Ignored while
   *  `secureEntry` is on (Android password fields must be single-line). */
  multiline?: boolean;
};

const COMPOSER_FONT_SIZE = 11;
const COMPOSER_LINE_HEIGHT = 15;
const COMPOSER_MAX_LINES = 6;
const COMPOSER_VERTICAL_PADDING = 4;
const COMPOSER_MAX_HEIGHT = COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES + COMPOSER_VERTICAL_PADDING * 2;

export default function PaneInputBar({
  placeholder,
  onSubmit,
  onAttach,
  showMic,
  isRecording,
  onMicPress,
  onMicLongPress,
  paneId,
  attachmentPreview,
  secureEntry,
  quoteTab,
  multiline,
}: Props) {
  const isMultiline = Boolean(multiline) && !secureEntry;
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  // Text colors MUST come from the live theme at render time, never from
  // StyleSheet.create: that snapshot is taken once at module load with the
  // seed palette, so after applyThemePreset() swapped the palette the typed /
  // "Ask AI"-inserted composer text kept the stale seed text1 and read as
  // faint as the placeholder on the new background (2026-10-06 on-device).
  const { colors: themeColors } = useTheme();
  // Matches CommandKeyBar's own background source (TerminalPane.tsx passes
  // it `terminalPaneBg`, i.e. C.bgDeep) so the two panes' footer strips
  // blend into their pane body the same way, instead of this one reading
  // as a visibly darker band the other footer doesn't have.
  const containerBg = usePanelBackground(C.bgDeep);
  const pillBg = usePanelBackground(C.bgSurface);
  const disabledBg = usePanelBackground(C.bgSidebar);

  // REMOTE-INPUT-001: last-known cursor position, tracked passively via
  // onSelectionChange (the `selection` prop is intentionally left
  // uncontrolled — controlling it every render fights normal typing on RN).
  // Falls back to "append at end" if the user never focused/selected in
  // this field yet.
  const selectionRef = useRef({ start: 0, end: 0 });
  const textRef = useRef('');
  textRef.current = text;

  useEffect(() => {
    if (!paneId) return;
    const sub = TerminalEmulator.addListener('onRemoteTextInput', (event: { text: string }) => {
      if (usePaneStore.getState().focusedPaneId !== paneId) return;
      const current = textRef.current;
      const { start, end } = selectionRef.current;
      const from = Math.min(Math.max(start, 0), current.length);
      const to = Math.min(Math.max(end, from), current.length);
      const next = current.slice(0, from) + event.text + current.slice(to);
      const cursor = from + event.text.length;
      selectionRef.current = { start: cursor, end: cursor };
      setText(next);
    });
    return () => sub.remove();
  }, [paneId]);

  // "Quote to AI": claim a terminal selection queued for this pane. Runs on
  // mount too, so a pane opened by the quote itself picks it up. While the
  // field is in masked API-key entry (secureEntry) the pane is marked blocked
  // so the router skips it, and we never claim — a quote typed invisibly into
  // a secret field would be stored as the key on Send.
  const pendingInsert = usePaneStore((s) => s.pendingComposerInsert);
  const pendingCursorRef = useRef<number | null>(null);
  useEffect(() => {
    if (!paneId || !quoteTab) return;
    usePaneStore.getState().setComposerQuoteBlocked(paneId, Boolean(secureEntry));
  }, [paneId, quoteTab, secureEntry]);
  useEffect(() => {
    if (!paneId || !quoteTab) return;
    return () => usePaneStore.getState().releaseComposerPane(paneId);
  }, [paneId, quoteTab]);
  useEffect(() => {
    if (!paneId || !quoteTab || !pendingInsert || secureEntry) return;
    const taken = usePaneStore.getState().takeComposerInsert(paneId, quoteTab);
    if (!taken) return;
    const { text: next, cursor } = insertQuoteIntoDraft(textRef.current, taken.text, selectionRef.current);
    selectionRef.current = { start: cursor, end: cursor };
    pendingCursorRef.current = cursor;
    setText(next);
    logInfo('PaneInputBar', `quote inserted into draft (${taken.text.length} chars)`);
    inputRef.current?.focus();
  }, [paneId, quoteTab, pendingInsert, secureEntry]);
  // Move the native caret once the inserted text has been committed, so it
  // matches selectionRef (the `selection` prop itself stays uncontrolled).
  useEffect(() => {
    const cursor = pendingCursorRef.current;
    if (cursor === null) return;
    pendingCursorRef.current = null;
    inputRef.current?.setSelection(cursor, cursor);
  }, [text]);

  const hasAttachment = Boolean(attachmentPreview);
  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && !hasAttachment) return;
    onSubmit(trimmed);
    setText('');
  }, [text, onSubmit, hasAttachment]);

  const canSend = text.trim().length > 0 || hasAttachment;

  return (
    <View style={[styles.container, { backgroundColor: containerBg }]}>
      {attachmentPreview ? (
        <View style={styles.attachmentStrip}>
          <Image source={{ uri: attachmentPreview.uri }} style={styles.attachmentThumb} />
          <TouchableOpacity
            onPress={attachmentPreview.onRemove}
            style={styles.attachmentRemoveBtn}
            hitSlop={8}
            accessibilityLabel="Remove attachment"
            accessibilityRole="button"
          >
            <MaterialIcons name="close" size={12} color={C.text2} />
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        <Text style={[styles.promptGlyph, { color: themeColors.accent }]}>{'>'}</Text>
        <TextInput
          ref={inputRef}
          style={[styles.input, isMultiline && styles.inputMultiline, { color: themeColors.foreground }]}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => {
            selectionRef.current = e.nativeEvent.selection;
          }}
          placeholder={placeholder ?? ''}
          placeholderTextColor={themeColors.hint}
          onSubmitEditing={handleSubmit}
          // Enter sends and keeps focus, in both single- and multi-line mode
          // (the multiline default would insert a newline instead).
          submitBehavior="submit"
          multiline={isMultiline}
          scrollEnabled
          returnKeyType="send"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={secureEntry}
        />
        {onAttach ? (
          <TouchableOpacity
            onPress={onAttach}
            style={styles.iconBtn}
            hitSlop={6}
            accessibilityLabel="Attach file"
            accessibilityRole="button"
          >
            <MaterialIcons name="attach-file" size={14} color={C.text2} />
          </TouchableOpacity>
        ) : null}
        {showMic ? (
          <TouchableOpacity
            onPress={onMicPress}
            onLongPress={onMicLongPress}
            delayLongPress={500}
            style={[styles.iconBtn, isRecording && styles.iconBtnRecording]}
            hitSlop={6}
            accessibilityLabel={isRecording ? 'Stop recording' : 'Start voice input'}
            accessibilityRole="button"
          >
            <MaterialIcons
              name={isRecording ? 'mic' : 'mic-none'}
              size={14}
              color={isRecording ? '#000' : C.text2}
            />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={!canSend}
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled, !canSend && { backgroundColor: disabledBg }]}
          hitSlop={6}
          accessibilityLabel="Send"
          accessibilityRole="button"
        >
          <MaterialIcons
            name="arrow-upward"
            size={14}
            color={canSend ? C.btnPrimaryText : C.text3}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
    // Matches Terminal pane's CommandKeyBar (lib/layout-constants.ts's
    // KEY_BAR_HEIGHT) so side-by-side panes' bottom bars line up instead
    // of sitting at two different heights.
    minHeight: KEY_BAR_HEIGHT,
    justifyContent: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    paddingLeft: 10,
    paddingRight: 4,
    minHeight: 32,
  },
  promptGlyph: {
    fontSize: 10,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.accent,
    marginRight: 6,
  },
  input: {
    flex: 1,
    // A long single-line draft must never widen the pill past the pane edge.
    minWidth: 0,
    fontFamily: F.family,
    fontSize: COMPOSER_FONT_SIZE,
    // color is applied inline from useTheme() — see the comment in the
    // component body.
    paddingVertical: COMPOSER_VERTICAL_PADDING,
    paddingHorizontal: 0,
  },
  inputMultiline: {
    lineHeight: COMPOSER_LINE_HEIGHT,
    maxHeight: COMPOSER_MAX_HEIGHT,
    textAlignVertical: 'center',
  },
  iconBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 2,
  },
  iconBtnRecording: {
    backgroundColor: C.accent,
  },
  sendBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  sendBtnDisabled: {
  },
  attachmentStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  attachmentThumb: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: C.bgSurface,
  },
  attachmentRemoveBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: -10,
    marginTop: -20,
    backgroundColor: C.bgSidebar,
    borderWidth: 1,
    borderColor: C.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
