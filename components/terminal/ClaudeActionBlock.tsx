// components/terminal/ClaudeActionBlock.tsx
// Renders Claude Code-style action badges (READ, EDIT, BASH) matching mock design.
// Used inline in terminal output to replace plain-text action lines.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';


export type ActionType = 'read' | 'edit' | 'bash' | 'autosave' | 'tip';

const ACTION_COLORS: Record<ActionType, string> = {
  read: C.accent,
  edit: '#FFB86C',
  bash: '#FF5555',
  autosave: '#50FA7B',
  tip: C.text2,
};

const ACTION_ICONS: Record<ActionType, string> = {
  read: 'visibility',
  edit: 'edit',
  bash: 'warning',
  autosave: 'lock',
  tip: 'lightbulb',
};

// ─── Read Block ──────────────────────────────────────────────────────────────

type ReadBlockProps = {
  filePath: string;
  duration?: string;
  /** Preview lines of the file content — e.g. ["1 IMPORT REACT, { USESTATE }...", "2 IMPORT { VIEW }..."] */
  previewLines?: string[];
  /** Total line count shown as "... 340 LINES" */
  totalLines?: number;
};

export function ReadActionBlock({ filePath, duration, previewLines, totalLines }: ReadBlockProps) {
  return (
    <View style={styles.readContainer}>
      <View style={styles.actionRow}>
        <View style={[styles.dot, { backgroundColor: ACTION_COLORS.read }]} />
        <Text style={[styles.actionLabel, { color: ACTION_COLORS.read }]}>READ</Text>
        <Text style={styles.actionPath} numberOfLines={1}>{filePath}</Text>
        <View style={styles.spacer} />
        {duration && <Text style={styles.actionDuration}>{duration}</Text>}
        <MaterialIcons name="content-copy" size={12} color="#6B7280" />
      </View>
      {/* Code preview lines */}
      {previewLines && previewLines.length > 0 && (
        <View style={styles.codePreview}>
          {previewLines.map((line, i) => (
            <Text key={i} style={styles.codePreviewLine} numberOfLines={1}>{line}</Text>
          ))}
          {totalLines != null && (
            <Text style={styles.codePreviewEllipsis}>// ... {totalLines} LINES</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Edit Block (with diff) ─────────────────────────────────────────────────

type EditBlockProps = {
  filePath: string;
  removedLines?: string[];
  addedLines?: string[];
  onAccept?: () => void;
  onReject?: () => void;
  /** Show green checkmark when edit is applied */
  isComplete?: boolean;
};

export function EditActionBlock({ filePath, removedLines, addedLines, onAccept, onReject, isComplete }: EditBlockProps) {
  return (
    <View style={styles.editContainer}>
      <View style={styles.actionRow}>
        <View style={[styles.dot, { backgroundColor: ACTION_COLORS.edit }]} />
        <Text style={[styles.actionLabel, { color: ACTION_COLORS.edit }]}>EDIT</Text>
        <Text style={styles.actionPath} numberOfLines={1}>{filePath}</Text>
        <View style={styles.spacer} />
        {isComplete ? (
          <MaterialIcons name="check" size={14} color={C.accent} />
        ) : (
          <MaterialIcons name="edit" size={12} color={ACTION_COLORS.edit} />
        )}
      </View>
      {/* Diff lines */}
      {removedLines && removedLines.map((line, i) => (
        <Text key={`rm-${i}`} style={styles.diffRemoved}>{'−   '}{line}</Text>
      ))}
      {addedLines && addedLines.map((line, i) => (
        <Text key={`add-${i}`} style={styles.diffAdded}>{'＋   '}{line}</Text>
      ))}
      {/* Accept / Reject buttons */}
      <View style={styles.diffActions}>
        <Pressable style={styles.acceptBtn} onPress={onAccept}>
          <Text style={styles.acceptText}>ACCEPT</Text>
        </Pressable>
        <Pressable style={styles.rejectBtn} onPress={onReject}>
          <Text style={styles.rejectText}>REJECT</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Bash Confirm Block ──────────────────────────────────────────────────────

type BashConfirmProps = {
  command: string;
  description?: string;
  onAllow?: () => void;
  onDeny?: () => void;
};

export function BashConfirmBlock({ command, description, onAllow, onDeny }: BashConfirmProps) {
  return (
    <View style={styles.bashContainer}>
      <View style={styles.bashHeader}>
        <MaterialIcons name="warning" size={14} color="#FFB86C" />
        <Text style={styles.bashLabel}>BASH: {command.toUpperCase()}</Text>
        <View style={styles.spacer} />
        <Text style={styles.confirmTag}>CONFIRM?</Text>
      </View>
      {description && (
        <Text style={styles.bashDesc}>{description}</Text>
      )}
      <View style={styles.bashActions}>
        <Pressable style={styles.allowBtn} onPress={onAllow}>
          <Text style={styles.allowText}>ALLOW</Text>
        </Pressable>
        <Pressable style={styles.denyBtn} onPress={onDeny}>
          <Text style={styles.denyText}>DENY</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Auto-save Bar ───────────────────────────────────────────────────────────

type AutoSaveBarProps = {
  filesChanged: number;
  onUndo?: () => void;
  onViewDiff?: () => void;
};

export function AutoSaveBar({ filesChanged, onUndo, onViewDiff }: AutoSaveBarProps) {
  return (
    <View style={styles.autoSaveBar}>
      <MaterialIcons name="lock" size={12} color={ACTION_COLORS.autosave} />
      <Text style={styles.autoSaveText}>
        AUTO-SAVED · {filesChanged} FILES CHANGED
      </Text>
      <View style={styles.spacer} />
      <Pressable onPress={onUndo}>
        <Text style={styles.autoSaveAction}>UNDO</Text>
      </Pressable>
      <Pressable onPress={onViewDiff}>
        <Text style={styles.autoSaveAction}>VIEW DIFF</Text>
      </Pressable>
    </View>
  );
}

// ─── Tip Bar ─────────────────────────────────────────────────────────────────

type TipBarProps = {
  message: string;
  onDismiss?: () => void;
};

export function TipBar({ message, onDismiss }: TipBarProps) {
  return (
    <View style={styles.tipBar}>
      <MaterialIcons name="lightbulb" size={12} color="#6B7280" />
      <Text style={styles.tipText}>TIP: {message}</Text>
      <View style={styles.spacer} />
      {onDismiss && (
        <Pressable onPress={onDismiss}>
          <MaterialIcons name="close" size={11} color="#6B7280" />
        </Pressable>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#111',
    borderRadius: 6,
    marginVertical: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  actionLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  actionPath: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '500',
    color: C.text1,
    flexShrink: 1,
  },
  actionDuration: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: C.text2,
  },
  // Read
  readContainer: {
    backgroundColor: '#111',
    borderRadius: 6,
    marginVertical: 2,
  },
  codePreview: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  codePreviewLine: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '500',
    color: C.text1,
    lineHeight: 16,
  },
  codePreviewEllipsis: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '500',
    color: C.text2,
    marginTop: 2,
  },
  spacer: {
    flex: 1,
  },
  // Edit
  editContainer: {
    backgroundColor: '#111',
    borderRadius: 6,
    marginVertical: 2,
    paddingBottom: 8,
  },
  diffRemoved: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#FF5555',
    backgroundColor: 'rgba(255,85,85,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  diffAdded: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#50FA7B',
    backgroundColor: 'rgba(80,250,123,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  diffActions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  acceptBtn: {
    backgroundColor: C.accent,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 4,
  },
  acceptText: {
    color: '#000',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  rejectBtn: {
    backgroundColor: '#333',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 4,
  },
  rejectText: {
    color: C.text1,
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // Bash confirm
  bashContainer: {
    backgroundColor: '#111',
    borderRadius: 6,
    marginVertical: 2,
    paddingBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#FFB86C',
  },
  bashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bashLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '800',
    color: '#FFB86C',
    letterSpacing: 0.5,
  },
  confirmTag: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#FF5555',
    letterSpacing: 0.5,
  },
  bashDesc: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: C.text1,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  bashActions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
  },
  allowBtn: {
    backgroundColor: C.accent,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 4,
  },
  allowText: {
    color: '#000',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  denyBtn: {
    backgroundColor: '#333',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 4,
  },
  denyText: {
    color: C.text1,
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // Auto-save
  autoSaveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,212,170,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 4,
    marginVertical: 2,
  },
  autoSaveText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#50FA7B',
    letterSpacing: 0.5,
  },
  autoSaveAction: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.5,
    paddingHorizontal: 4,
    textDecorationLine: 'underline',
  },
  // Tip
  tipBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginVertical: 2,
  },
  tipText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '500',
    color: C.text2,
    letterSpacing: 0.3,
    flex: 1,
  },
});
