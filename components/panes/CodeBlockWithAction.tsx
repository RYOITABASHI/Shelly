/**
 * components/panes/CodeBlockWithAction.tsx
 *
 * Fenced-code renderer for assistant messages. Adds a header row with
 * the language tag and two one-tap actions: Copy and Insert-to-Terminal.
 * Insert routes through TerminalEmulator.writeToSession so the code
 * lands in the active terminal as if the user had pasted + pressed
 * Enter at the prompt.
 */

import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ToastAndroid, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useTerminalStore } from '@/store/terminal-store';
import { getStagedEdit, applyStagedEdit } from '@/lib/ai-edit';
import { playSound } from '@/lib/sounds';
import { colors as C, fonts as F } from '@/theme.config';

type Props = {
  lang?: string;
  code: string;
};

function isShellLike(lang?: string): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase();
  return l === 'bash' || l === 'sh' || l === 'zsh' || l === 'shell' || l === 'console' || l === 'terminal';
}

function langMatchesFile(lang: string | undefined, path: string): boolean {
  if (!lang) return false;
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return false;
  const l = lang.toLowerCase();
  // Accept the exact extension plus common aliases so ```typescript and
  // ```ts both count as "this block is user.ts-compatible".
  const aliases: Record<string, string[]> = {
    ts: ['ts', 'typescript'],
    tsx: ['tsx', 'typescriptreact'],
    js: ['js', 'javascript'],
    jsx: ['jsx', 'javascriptreact'],
    py: ['py', 'python'],
    rb: ['rb', 'ruby'],
    go: ['go', 'golang'],
    rs: ['rs', 'rust'],
    md: ['md', 'markdown'],
    yml: ['yml', 'yaml'],
    yaml: ['yml', 'yaml'],
    json: ['json', 'jsonc'],
    sh: ['sh', 'bash', 'shell'],
  };
  return (aliases[ext] ?? [ext]).includes(l);
}

export function CodeBlockWithAction({ lang, code }: Props) {
  const trimmed = code.replace(/\s+$/, '');

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(trimmed);
    try { playSound('copy'); } catch {}
    if (Platform.OS === 'android') {
      ToastAndroid.show('Copied to clipboard', ToastAndroid.SHORT);
    }
  }, [trimmed]);

  const handleInsert = useCallback(async () => {
    const sessionId = useTerminalStore.getState().activeSessionId;
    if (!sessionId) {
      if (Platform.OS === 'android') {
        ToastAndroid.show('No active terminal', ToastAndroid.SHORT);
      }
      return;
    }
    try {
      // No trailing newline on purpose so the user can review / edit the
      // command before pressing Enter. For shell-like langs we still drop
      // the snippet inline; for diff / json / other non-executable content
      // we let the user decide whether to keep the inserted text.
      await TerminalEmulator.writeToSession(sessionId, trimmed);
      try { playSound('send'); } catch {}
      if (Platform.OS === 'android') {
        ToastAndroid.show('Inserted into terminal', ToastAndroid.SHORT);
      }
    } catch (err) {
      if (Platform.OS === 'android') {
        ToastAndroid.show(
          'Insert failed: ' + (err instanceof Error ? err.message : String(err)),
          ToastAndroid.SHORT,
        );
      }
    }
  }, [trimmed]);

  const canInsert = isShellLike(lang);
  // If the AI pane has a staged file whose extension matches this block's
  // language, surface an APPLY button that writes the block to that file.
  // Primarily a fallback for when the model ignored the "respond with diff"
  // instruction and emitted the whole file as a ```ts fence instead — still
  // lets the user accept with one tap.
  const staged = getStagedEdit();
  const canApplyToFile =
    staged != null && !canInsert && langMatchesFile(lang, staged.path);

  const handleApplyToFile = useCallback(async () => {
    if (!staged) return;
    const err = await applyStagedEdit(trimmed);
    try { playSound(err === null ? 'success' : 'error'); } catch {}
    if (Platform.OS === 'android') {
      ToastAndroid.show(
        err === null ? `Wrote ${staged.path}` : `Apply failed: ${err}`,
        ToastAndroid.SHORT,
      );
    }
  }, [staged, trimmed]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.lang}>
          {lang ? lang.toLowerCase() : 'code'}
          {canApplyToFile && staged ? `  ·  ${staged.path.split('/').pop()}` : ''}
        </Text>
        <View style={styles.actions}>
          <Pressable onPress={handleCopy} style={styles.btn} hitSlop={6} accessibilityLabel="Copy code">
            <MaterialIcons name="content-copy" size={12} color={C.text2} />
            <Text style={styles.btnLabel}>COPY</Text>
          </Pressable>
          {canInsert ? (
            <Pressable onPress={handleInsert} style={[styles.btn, styles.btnPrimary]} hitSlop={6} accessibilityLabel="Insert into terminal">
              <MaterialIcons name="arrow-forward" size={12} color={C.btnPrimaryText} />
              <Text style={[styles.btnLabel, styles.btnLabelPrimary]}>INSERT</Text>
            </Pressable>
          ) : null}
          {canApplyToFile ? (
            <Pressable onPress={handleApplyToFile} style={[styles.btn, styles.btnPrimary]} hitSlop={6} accessibilityLabel="Apply to staged file">
              <MaterialIcons name="save" size={12} color={C.btnPrimaryText} />
              <Text style={[styles.btnLabel, styles.btnLabelPrimary]}>APPLY</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text style={styles.code} selectable>
        {trimmed}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    backgroundColor: C.bgDeep,
    marginVertical: 6,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  lang: {
    fontSize: 8,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  actions: {
    flexDirection: 'row',
    gap: 4,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  btnPrimary: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  btnLabel: {
    fontSize: 8,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text2,
    letterSpacing: 0.5,
  },
  btnLabelPrimary: {
    color: C.btnPrimaryText,
  },
  code: {
    fontSize: 9,
    fontFamily: F.family,
    lineHeight: 13,
    color: C.text1,
    padding: 8,
  },
});

/**
 * Split assistant text into alternating plain / code-block segments
 * so the renderer can wrap each fenced block in CodeBlockWithAction.
 */
export type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'code'; lang?: string; content: string };

export function splitFencedCode(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```(\w+)?\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: 'text', content: text.slice(last, m.index) });
    }
    out.push({ kind: 'code', lang: m[1], content: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push({ kind: 'text', content: text.slice(last) });
  }
  // Collapse entirely-empty trailing text segments so we don't render a
  // stray Text with zero height under the last code block.
  return out.filter((s) => !(s.kind === 'text' && s.content.trim().length === 0));
}
