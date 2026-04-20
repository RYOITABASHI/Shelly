import React, { useState, useCallback, useMemo, memo, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  
  TouchableOpacity,
  TouchableWithoutFeedback,
  Linking,
} from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withRepeat,
  withTiming,
  FadeInDown,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { CommandBlock, BlockStatus } from '@/store/types';
import { useTerminalStore } from '@/store/terminal-store';
import { useSnippetStore } from '@/store/snippet-store';
import { getOutputColor } from '@/lib/output-colors';
import { segmentText } from '@/lib/link-detector';
import { detectErrors } from '@/lib/error-pattern-detector';
import { isDiffOutput } from '@/lib/diff-parser';
import { LinkContextMenu, type LinkInfo } from '@/components/terminal/LinkContextMenu';
import { DiffViewer } from '@/components/terminal/DiffViewer';
import { detectContentType, type ContentType } from '@/lib/content-block-detector';
import MarkdownBlock from '@/components/terminal/MarkdownBlock';
import JsonTreeBlock from '@/components/terminal/JsonTreeBlock';
import ImagePreviewBlock from '@/components/terminal/ImagePreviewBlock';
import TableBlock from '@/components/terminal/TableBlock';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS, TIMING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';
import { parseAnsi, hasAnsiCodes } from '@/lib/ansi-parser';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

export { getOutputColor };

const COLLAPSE_THRESHOLD = 30;

type Props = {
  block: CommandBlock;
  fontSize: number;
  lineHeight: number;
  onRerun?: (command: string) => void;
  onCancel?: (blockId: string) => void;
  highContrastOutput?: boolean;
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ─── Running Dots Animation ──────────────────────────────────────────────────

function RunningDots({ color }: { color: string }) {
  const dot1 = useSharedValue(0.3);
  const dot2 = useSharedValue(0.3);
  const dot3 = useSharedValue(0.3);

  useEffect(() => {
    dot1.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 300 }),
        withTiming(0.3, { duration: 300 }),
      ),
      -1, false,
    );
    setTimeout(() => {
      dot2.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 300 }),
          withTiming(0.3, { duration: 300 }),
        ),
        -1, false,
      );
    }, 100);
    setTimeout(() => {
      dot3.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 300 }),
          withTiming(0.3, { duration: 300 }),
        ),
        -1, false,
      );
    }, 200);
  }, []);

  const s1 = useAnimatedStyle(() => ({ opacity: dot1.value }));
  const s2 = useAnimatedStyle(() => ({ opacity: dot2.value }));
  const s3 = useAnimatedStyle(() => ({ opacity: dot3.value }));

  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      <Animated.Text style={[{ color, fontSize: 14, fontFamily: F.family }, s1]}>{'\u00B7'}</Animated.Text>
      <Animated.Text style={[{ color, fontSize: 14, fontFamily: F.family }, s2]}>{'\u00B7'}</Animated.Text>
      <Animated.Text style={[{ color, fontSize: 14, fontFamily: F.family }, s3]}>{'\u00B7'}</Animated.Text>
    </View>
  );
}

// ─── Action Menu ──────────────────────────────────────────────────────────────

type ActionMenuProps = {
  visible: boolean;
  onClose: () => void;
  onCopyCommand: () => void;
  onCopyOutput: () => void;
  onCopyBlock: () => void;
  onSaveSnippet: () => void;
  onRerun: () => void;
  isSaved: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
};

function ActionMenu({
  visible, onClose,
  onCopyCommand, onCopyOutput, onCopyBlock,
  onSaveSnippet, onRerun, isSaved, colors,
}: ActionMenuProps) {
  return (
    <ShellyModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={menuStyles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[menuStyles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[menuStyles.menuTitle, { color: colors.inactive, borderBottomColor: colors.border }]}>
                {'\u30D6\u30ED\u30C3\u30AF\u64CD\u4F5C'}
              </Text>

              <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={onCopyCommand}>
                <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u2318'}</Text>
                <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }]}>Copy Command</Text>
                <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u30B3\u30DE\u30F3\u30C9\u3092\u30B3\u30D4\u30FC'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={onCopyOutput}>
                <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u2261'}</Text>
                <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }]}>Copy Output</Text>
                <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u51FA\u529B\u3092\u30B3\u30D4\u30FC'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={onCopyBlock}>
                <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u29C9'}</Text>
                <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }]}>Copy Block</Text>
                <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u30B3\u30DE\u30F3\u30C9\uFF0B\u51FA\u529B\u3092\u30B3\u30D4\u30FC'}</Text>
              </TouchableOpacity>

              <View style={[menuStyles.menuDivider, { backgroundColor: colors.border }]} />

              <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={onSaveSnippet}>
                <Text style={[menuStyles.menuIcon, isSaved && { color: colors.warning }]}>
                  {isSaved ? '\u2605' : '\u2606'}
                </Text>
                <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }, isSaved && { color: colors.warning }]}>
                  {isSaved ? 'Saved' : 'Save Snippet'}
                </Text>
                <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u30B9\u30CB\u30DA\u30C3\u30C8\u3068\u3057\u3066\u4FDD\u5B58'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={menuStyles.menuItem} onPress={onRerun}>
                <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u21BA'}</Text>
                <Text style={[menuStyles.menuLabel, { color: colors.accent }]}>Rerun</Text>
                <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u518D\u5B9F\u884C'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[menuStyles.cancelBtn, { borderTopColor: colors.border }]} onPress={onClose}>
                <Text style={[menuStyles.cancelText, { color: colors.muted }]}>{'\u30AD\u30E3\u30F3\u30BB\u30EB'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </ShellyModal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function TerminalBlockComponent({ block, fontSize, lineHeight, onRerun, onCancel, highContrastOutput }: Props) {
  const { colors } = useTheme();
  const runCommand = useTerminalStore((s) => s.runCommand);
  const hapticFeedback = useTerminalStore((s) => s.settings.hapticFeedback);
  const highContrastSetting = useTerminalStore((s) => s.settings.highContrastOutput);
  const llmInterpreterEnabled = useTerminalStore((s) => s.settings.llmInterpreterEnabled ?? false);
  const { addSnippet: saveSnippet, findByCommand, updateSnippet } = useSnippetStore();
  const router = useRouter();

  // Exit code badge animation
  const exitScale = useSharedValue(0);
  const exitAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: exitScale.value }],
  }));

  // Feedback toast animation
  const feedbackOpacity = useSharedValue(0);
  const feedbackTranslateY = useSharedValue(8);
  const feedbackAnimStyle = useAnimatedStyle(() => ({
    opacity: feedbackOpacity.value,
    transform: [{ translateY: feedbackTranslateY.value }],
  }));

  // Collapse icon rotation
  const collapseRotation = useSharedValue(0);
  const _collapseAnimStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${collapseRotation.value}deg` }],
  }));

  // Play sound and animate on exit code change
  useEffect(() => {
    if (!block.isRunning && block.exitCode !== null) {
      exitScale.value = withSpring(1, SPRING_CONFIGS.bouncy);
      if (block.exitCode === 0) {
        playSound('success');
      } else {
        playSound('error');
      }
    }
  }, [block.isRunning, block.exitCode]);

  const handleLinkPress = useCallback((linkText: string, linkType: 'url' | 'filepath') => {
    if (linkType === 'url') {
      const url = linkText.startsWith('www.') ? `https://${linkText}` : linkText;
      Linking.openURL(url).catch(() => {});
    } else {
      if (onRerun) onRerun(`cat ${linkText}`);
    }
  }, [router, onRerun]);

  const [menuVisible, setMenuVisible] = useState(false);
  const [linkMenuVisible, setLinkMenuVisible] = useState(false);
  const [activeLinkInfo, setActiveLinkInfo] = useState<LinkInfo | null>(null);

  const handleLinkLongPress = useCallback((info: LinkInfo) => {
    if (hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setActiveLinkInfo(info);
    setLinkMenuVisible(true);
  }, [hapticFeedback]);
  const [dupDialogVisible, setDupDialogVisible] = useState(false);
  const [existingSnippetId, setExistingSnippetId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(
    block.output.length > COLLAPSE_THRESHOLD
  );
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [richView, setRichView] = useState(true);
  const [richCollapsed, setRichCollapsed] = useState(false);

  const useHighContrast = highContrastOutput ?? highContrastSetting ?? true;
  const lineHeightPx = Math.round(fontSize * lineHeight);
  const shouldCollapse = block.output.length > COLLAPSE_THRESHOLD;
  const visibleOutput = isCollapsed
    ? block.output.slice(0, COLLAPSE_THRESHOLD)
    : block.output;

  const blockStatus: BlockStatus | undefined = block.blockStatus;
  const isCancelling = blockStatus === 'cancelling';
  const isCancelled = blockStatus === 'cancelled';
  const canCancel = block.isRunning && !isCancelling;

  const outputText = useMemo(
    () => block.output.map((l) => l.text).join('\n'),
    [block.output],
  );
  const isDiff = useMemo(
    () => isDiffOutput(block.command, outputText),
    [block.command, outputText],
  );

  const contentType: ContentType = useMemo(() => {
    if (block.isRunning || block.exitCode === null) return 'plain';
    return detectContentType(block.command, outputText);
  }, [block.isRunning, block.exitCode, block.command, outputText]);

  // Only show rich view for non-plain, non-running blocks
  const showRichRenderer = richView && !block.isRunning && block.exitCode !== null && contentType !== 'plain';

  const showFeedback = useCallback((msg: string) => {
    setFeedbackMsg(msg);
    feedbackOpacity.value = withSpring(1, SPRING_CONFIGS.quick);
    feedbackTranslateY.value = withSpring(0, SPRING_CONFIGS.snappy);
    playSound('copy');
    setTimeout(() => {
      feedbackOpacity.value = withTiming(0, TIMING_CONFIGS.exit);
      feedbackTranslateY.value = withTiming(8, TIMING_CONFIGS.exit);
      setTimeout(() => setFeedbackMsg(null), 250);
    }, 1500);
  }, [feedbackOpacity, feedbackTranslateY]);

  const handleLongPress = useCallback(() => {
    if (hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setMenuVisible(true);
  }, [hapticFeedback]);

  const handleCopyCommand = useCallback(async () => {
    setMenuVisible(false);
    await Clipboard.setStringAsync(block.command);
    if (hapticFeedback) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    showFeedback('\u30B3\u30DE\u30F3\u30C9\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F');
  }, [block.command, hapticFeedback, showFeedback]);

  const handleCopyOutput = useCallback(async () => {
    setMenuVisible(false);
    const text = block.output.map((l) => l.text).join('\n');
    await Clipboard.setStringAsync(text);
    if (hapticFeedback) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    showFeedback('\u51FA\u529B\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F');
  }, [block.output, hapticFeedback, showFeedback]);

  const handleCopyBlock = useCallback(async () => {
    setMenuVisible(false);
    const text = `$ ${block.command}\n${block.output.map((l) => l.text).join('\n')}`;
    await Clipboard.setStringAsync(text);
    if (hapticFeedback) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    showFeedback('\u30D6\u30ED\u30C3\u30AF\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F');
  }, [block.command, block.output, hapticFeedback, showFeedback]);

  const handleSaveSnippet = useCallback(() => {
    setMenuVisible(false);
    const existing = findByCommand(block.command);
    if (existing) {
      setExistingSnippetId(existing.id);
      setDupDialogVisible(true);
      return;
    }
    saveSnippet({ command: block.command });
    if (hapticFeedback) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    showFeedback('Saved to Snippets');
  }, [block.command, findByCommand, saveSnippet, hapticFeedback, showFeedback]);

  const handleDupOverwrite = useCallback(() => {
    setDupDialogVisible(false);
    if (existingSnippetId) {
      updateSnippet(existingSnippetId, { command: block.command });
      showFeedback('\u30B9\u30CB\u30DA\u30C3\u30C8\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F');
    }
    setExistingSnippetId(null);
  }, [existingSnippetId, block.command, updateSnippet, showFeedback]);

  const handleDupSaveNew = useCallback(() => {
    setDupDialogVisible(false);
    saveSnippet({ command: block.command });
    showFeedback('\u65B0\u898F\u30B9\u30CB\u30DA\u30C3\u30C8\u3068\u3057\u3066\u4FDD\u5B58\u3057\u307E\u3057\u305F');
    setExistingSnippetId(null);
  }, [block.command, saveSnippet, showFeedback]);

  const handleRerun = useCallback(() => {
    setMenuVisible(false);
    if (hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (onRerun) {
      onRerun(block.command);
    } else {
      runCommand(block.command);
    }
  }, [block.command, onRerun, runCommand, hapticFeedback]);

  const handleCancel = useCallback(() => {
    if (hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    playSound('ctrl_c');
    onCancel?.(block.id);
  }, [block.id, onCancel, hapticFeedback]);

  const handleCollapseToggle = useCallback(() => {
    setIsCollapsed((v) => {
      const next = !v;
      collapseRotation.value = withSpring(next ? 0 : 180, SPRING_CONFIGS.snappy);
      return next;
    });
  }, [collapseRotation]);

  // Quick copy with animation
  const copyScale = useSharedValue(1);
  const copyAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: copyScale.value }],
  }));
  const handleQuickCopy = useCallback(async () => {
    const text = block.output.map((l) => l.text).join('\n');
    await Clipboard.setStringAsync(text);
    if (hapticFeedback) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    copyScale.value = withSequence(
      withSpring(0.7, SPRING_CONFIGS.quick),
      withSpring(1.2, SPRING_CONFIGS.bouncy),
      withSpring(1, SPRING_CONFIGS.snappy),
    );
    showFeedback('Copied');
  }, [block.output, hapticFeedback, copyScale, showFeedback]);

  return (
    <>
      <ActionMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        onCopyCommand={handleCopyCommand}
        onCopyOutput={handleCopyOutput}
        onCopyBlock={handleCopyBlock}
        onSaveSnippet={handleSaveSnippet}
        onRerun={handleRerun}
        isSaved={!!block.isSavedSnippet}
        colors={colors}
      />

      {/* Link context menu */}
      {activeLinkInfo && (
        <LinkContextMenu
          visible={linkMenuVisible}
          onClose={() => setLinkMenuVisible(false)}
          link={activeLinkInfo}
          position={{ x: 0, y: 0 }}
          onOpenInSidebar={(filePath, line, col) => {
            if (onRerun) onRerun(`cat ${filePath}`);
          }}
          onCopied={showFeedback}
        />
      )}

      {/* Duplicate snippet confirmation dialog */}
      <ShellyModal
        visible={dupDialogVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDupDialogVisible(false)}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={() => setDupDialogVisible(false)}>
          <View style={menuStyles.overlay}>
            <TouchableWithoutFeedback>
              <View style={[menuStyles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[menuStyles.menuTitle, { color: colors.inactive, borderBottomColor: colors.border }]}>
                  {'\u540C\u3058\u30B3\u30DE\u30F3\u30C9\u304C\u3059\u3067\u306B\u4FDD\u5B58\u3055\u308C\u3066\u3044\u307E\u3059'}
                </Text>
                <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={handleDupOverwrite}>
                  <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u21BA'}</Text>
                  <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }]}>{'\u65E2\u5B58\u3092\u66F4\u65B0\u3059\u308B'}</Text>
                  <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u30BF\u30A4\u30C8\u30EB\u30FB\u30BF\u30B0\u306F\u5F15\u304D\u7D99\u304E'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[menuStyles.menuItem, { borderBottomColor: colors.surface }]} onPress={handleDupSaveNew}>
                  <Text style={[menuStyles.menuIcon, { color: colors.muted }]}>{'\u2605'}</Text>
                  <Text style={[menuStyles.menuLabel, { color: colors.foregroundDim }]}>{'\u65B0\u898F\u3068\u3057\u3066\u4FDD\u5B58'}</Text>
                  <Text style={[menuStyles.menuHint, { color: colors.inactive }]}>{'\u5225\u30B9\u30CB\u30DA\u30C3\u30C8\u3068\u3057\u3066\u8FFD\u52A0'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[menuStyles.cancelBtn, { borderTopColor: colors.border }]} onPress={() => setDupDialogVisible(false)}>
                  <Text style={[menuStyles.cancelText, { color: colors.muted }]}>{'\u30AD\u30E3\u30F3\u30BB\u30EB'}</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </ShellyModal>

      {/* User command bubble (right-aligned) */}
      <Animated.View
        entering={FadeInDown.duration(200).springify().damping(18)}
      >
        <Pressable
          onLongPress={handleLongPress}
          delayLongPress={350}
          style={styles.userBubbleRow}
        >
          <View style={[
            styles.userBubble,
            { backgroundColor: withAlpha(colors.accent, 0.12), borderColor: withAlpha(colors.accent, 0.25) },
          ]}>
            {/* Command with prompt symbol */}
            <View style={styles.commandLine}>
              <Text style={[styles.prompt, { fontSize, lineHeight: lineHeightPx, color: colors.accent }]}>
                {'$ '}
              </Text>
              <Text
                style={[styles.command, { fontSize, lineHeight: lineHeightPx, color: colors.foreground }]}
                selectable
              >
                {block.command}
              </Text>
            </View>
            {/* Meta row: time + badges */}
            <View style={styles.userMetaRow}>
              <Text style={[styles.userTimestamp, { color: colors.hint }]}>{formatTimestamp(block.timestamp)}</Text>
              {block.isSavedSnippet && (
                <Text style={[styles.snippetStar, { color: colors.warning }]}>{'\u2605'}</Text>
              )}
              {block.isRunning && <RunningDots color={colors.warning} />}
              {!block.isRunning && block.exitCode !== null && (
                <Animated.View style={[
                  styles.exitBadge,
                  { backgroundColor: withAlpha(block.exitCode === 0 ? colors.success : colors.error, 0.12) },
                  exitAnimStyle,
                ]}>
                  <Text style={[
                    styles.exitText,
                    { color: block.exitCode === 0 ? colors.success : colors.error },
                  ]}>
                    {block.exitCode === 0 ? '\u2713' : `\u2717 ${block.exitCode}`}
                  </Text>
                </Animated.View>
              )}
            </View>
          </View>
        </Pressable>
      </Animated.View>

      {/* Cancelled state banner */}
      {isCancelled && (
        <View style={styles.cancelledRow}>
          <View style={[styles.cancelledBanner, { backgroundColor: withAlpha(colors.error, 0.07), borderColor: withAlpha(colors.error, 0.19) }]}>
            <Text style={[styles.cancelledBannerText, { color: colors.error }]}>{'\u2298 Cancelled (exit 130)'}</Text>
          </View>
        </View>
      )}

      {/* Output block (left-aligned, terminal style) */}
      {(block.isRunning || block.output.length > 0) && (
        <Animated.View
          entering={FadeInDown.duration(200).delay(50).springify().damping(18)}
          style={styles.outputBubbleRow}
        >
          {/* Terminal icon */}
          <View style={[styles.terminalIcon, { backgroundColor: withAlpha(colors.command, 0.1), borderColor: withAlpha(colors.command, 0.2) }]}>
            <Text style={[styles.terminalIconText, { color: colors.command }]}>{'>_'}</Text>
          </View>

          <View style={[
            styles.outputBubble,
            { backgroundColor: '#0F1318', borderColor: withAlpha(colors.command, 0.12) },
          ]}>
            {/* Output header bar */}
            <View style={[styles.outputHeader, { borderBottomColor: withAlpha(colors.command, 0.08) }]}>
              {/* Left: label + content type badge (tappable to collapse rich view) */}
              <Pressable
                style={styles.outputHeaderLeft}
                onPress={showRichRenderer ? () => setRichCollapsed((v) => !v) : undefined}
                hitSlop={4}
              >
                <Text style={[styles.outputHeaderLabel, { color: colors.inactive }]}>output</Text>
                {showRichRenderer && (
                  <>
                    <View style={[styles.contentTypeBadge, { backgroundColor: withAlpha(colors.accent, 0.13), borderColor: withAlpha(colors.accent, 0.25) }]}>
                      <Text style={[styles.contentTypeLabel, { color: colors.accent }]}>{contentType}</Text>
                    </View>
                    <Text style={[styles.richChevron, { color: colors.inactive }]}>
                      {richCollapsed ? '\u25BA' : '\u25BC'}
                    </Text>
                  </>
                )}
              </Pressable>
              <View style={styles.outputHeaderRight}>
                {/* Plain/Rich toggle */}
                {!block.isRunning && block.exitCode !== null && contentType !== 'plain' && (
                  <Pressable
                    style={[styles.viewToggleBtn, { backgroundColor: withAlpha(colors.command, 0.08) }]}
                    hitSlop={6}
                    onPress={() => setRichView((v) => !v)}
                  >
                    <Text style={[styles.viewToggleText, { color: richView ? colors.accent : colors.inactive }]}>
                      {richView ? 'Rich' : 'Plain'}
                    </Text>
                  </Pressable>
                )}
                {!block.isRunning && block.output.length > 0 && (
                  <Animated.View style={copyAnimStyle}>
                    <Pressable
                      style={[styles.quickCopyBtn, { backgroundColor: withAlpha(colors.command, 0.08) }]}
                      hitSlop={6}
                      onPress={handleQuickCopy}
                    >
                      <MaterialIcons name="content-copy" size={12} color={colors.inactive} />
                    </Pressable>
                  </Animated.View>
                )}
              </View>
            </View>

            {block.isRunning ? (
              <View style={styles.outputBody}>
                {block.output.length > 0 && (
                  <View style={styles.outputLines}>
                    {block.output.map((line, i) => {
                      const baseColor = getOutputColor(line.type, useHighContrast);
                      if (hasAnsiCodes(line.text)) {
                        const segments = parseAnsi(line.text);
                        return (
                          <Text key={i} style={[styles.outputLine, { fontSize: fontSize - 1, lineHeight: lineHeightPx, color: baseColor }]} selectable>
                            {segments.map((seg, j) => (
                              <Text key={j} style={[
                                seg.color ? { color: seg.color } : undefined,
                                seg.bold ? { fontWeight: '700' } : undefined,
                                seg.dim ? { opacity: 0.6 } : undefined,
                                seg.underline ? { textDecorationLine: 'underline' as const } : undefined,
                              ].filter(Boolean) as any}>
                                {seg.text}
                              </Text>
                            ))}
                          </Text>
                        );
                      }
                      return (
                        <Text key={i} style={[styles.outputLine, { fontSize: fontSize - 1, lineHeight: lineHeightPx, color: baseColor }]} selectable>
                          {line.text}
                        </Text>
                      );
                    })}
                  </View>
                )}
                <View style={styles.runningFooter}>
                  <View style={styles.runningIndicator}>
                    {isCancelling ? (
                      <>
                        <RunningDots color={colors.error} />
                        <Text style={[styles.runningLabel, { color: colors.error }]}>Cancelling...</Text>
                      </>
                    ) : (
                      <>
                        <RunningDots color={colors.warning} />
                        <Text style={[styles.runningLabel, { color: colors.muted }]}>
                          {'\u5B9F\u884C\u4E2D...'}
                        </Text>
                      </>
                    )}
                  </View>
                  <Pressable
                    onPress={canCancel ? handleCancel : undefined}
                    style={[
                      styles.cancelButton,
                      { borderColor: withAlpha(colors.error, 0.27), backgroundColor: withAlpha(colors.error, 0.06) },
                      !canCancel && { borderColor: colors.border, backgroundColor: 'transparent', opacity: 0.4 },
                      isCancelling && { borderColor: withAlpha(colors.error, 0.53), backgroundColor: withAlpha(colors.error, 0.13) },
                    ]}
                  >
                    <Text style={[
                      styles.cancelButtonText,
                      { color: colors.error },
                      !canCancel && { color: colors.inactive },
                    ]}>
                      {isCancelling ? 'Cancelling...' : 'Cancel'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.outputBody}>
                {/* Rich content renderers (non-plain detected types) */}
                {showRichRenderer && !richCollapsed && (
                  <View style={styles.richRendererContainer}>
                    {contentType === 'markdown' && <MarkdownBlock content={outputText} />}
                    {contentType === 'json' && <JsonTreeBlock json={outputText} />}
                    {contentType === 'image' && <ImagePreviewBlock output={outputText} cwd={''} />}
                    {contentType === 'table' && <TableBlock output={outputText} />}
                    {contentType === 'diff' && <DiffViewer output={outputText} />}
                  </View>
                )}
                {/* Plain rendering: always shown when richView=false, or for plain/collapsed-rich */}
                {(!showRichRenderer || richCollapsed) && (
                  isDiff ? (
                    <DiffViewer output={outputText} />
                  ) : (
                  <View style={styles.outputLines}>
                    {visibleOutput.map((line, i) => {
                      const segments = segmentText(line.text);
                      const errors = detectErrors(line.text);
                      const baseColor = getOutputColor(line.type, useHighContrast);
                      const hasLinks = segments.some((s) => s.link) || errors.length > 0;

                      // Build enriched segments: merge error spans on top of link segments
                      const enrichedSegments = hasLinks
                        ? segments.map((seg) => {
                            if (!seg.link) return { ...seg, errorInfo: null };
                            // Check if this link text matches an error pattern
                            const err = errors.find(
                              (e) =>
                                e.filePath === seg.link!.text ||
                                seg.link!.text.startsWith(e.filePath),
                            );
                            return { ...seg, errorInfo: err ?? null };
                          })
                        : [];

                      return (
                        <Text
                          key={i}
                          style={[
                            styles.outputLine,
                            { fontSize: fontSize - 1, lineHeight: lineHeightPx, color: baseColor },
                          ]}
                          selectable
                        >
                          {hasLinks
                            ? enrichedSegments.map((seg, j) => {
                                if (!seg.link) return <Text key={j}>{seg.text}</Text>;
                                const isError = seg.errorInfo != null;
                                const isUrl = seg.link.type === 'url';
                                const linkColor = isError
                                  ? colors.error
                                  : isUrl
                                  ? colors.link
                                  : colors.accent;
                                const linkInfo: LinkInfo = isError
                                  ? {
                                      text: seg.text,
                                      type: 'error',
                                      filePath: seg.errorInfo!.filePath,
                                      line: seg.errorInfo!.line,
                                      col: seg.errorInfo!.col,
                                    }
                                  : {
                                      text: seg.text,
                                      type: seg.link.type,
                                      filePath:
                                        seg.link.type === 'filepath'
                                          ? seg.text
                                          : undefined,
                                      url:
                                        seg.link.type === 'url'
                                          ? seg.text
                                          : undefined,
                                    };
                                return (
                                  <Text
                                    key={j}
                                    style={[
                                      styles.linkText,
                                      { color: linkColor },
                                    ]}
                                    onPress={() =>
                                      handleLinkPress(
                                        seg.link!.text,
                                        seg.link!.type,
                                      )
                                    }
                                    onLongPress={() => handleLinkLongPress(linkInfo)}
                                  >
                                    {seg.text}
                                  </Text>
                                );
                              })
                            : hasAnsiCodes(line.text)
                              ? parseAnsi(line.text).map((seg, j) => (
                                  <Text key={j} style={[
                                    seg.color ? { color: seg.color } : undefined,
                                    seg.bold ? { fontWeight: '700' } : undefined,
                                    seg.dim ? { opacity: 0.6 } : undefined,
                                    seg.underline ? { textDecorationLine: 'underline' as const } : undefined,
                                  ].filter(Boolean) as any}>
                                    {seg.text}
                                  </Text>
                                ))
                              : line.text}
                        </Text>
                      );
                    })}
                  </View>
                  )
                )}

                {shouldCollapse && block.output.length > 0 && !showRichRenderer && (
                  <Pressable
                    onPress={handleCollapseToggle}
                    style={[styles.collapseToggle, { backgroundColor: withAlpha(colors.command, 0.08) }]}
                  >
                    <Text style={[styles.collapseText, { color: colors.accent }]}>
                      {isCollapsed
                        ? `\u25BC ${block.output.length - COLLAPSE_THRESHOLD} \u884C\u3092\u5C55\u958B...`
                        : '\u25B2 \u6298\u308A\u305F\u305F\u3080'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        </Animated.View>
      )}

      {/* No output indicator */}
      {!block.isRunning && block.output.length === 0 && (
        <View style={styles.noOutputRow}>
          <Text style={[styles.noOutputText, { color: colors.hint }]}>(no output)</Text>
        </View>
      )}

      {/* LLM interpret area — only shown when learning mode is enabled */}
      {llmInterpreterEnabled && (block.isInterpreting || block.llmInterpretation || block.llmInterpretationStreaming) && (
        <Animated.View
          entering={FadeInDown.duration(200).delay(100).springify().damping(18)}
          style={styles.interpretRow}
        >
          <View style={[styles.interpretAvatar, { backgroundColor: withAlpha(colors.interpretPurple, 0.12), borderColor: withAlpha(colors.interpretPurple, 0.25) }]}>
            <Text style={[styles.interpretAvatarText, { color: colors.interpretPurple }]}>AI</Text>
          </View>
          <View style={[styles.interpretContainer, { borderColor: withAlpha(colors.interpretPurple, 0.2), backgroundColor: '#1A1A2E' }]}>
            <View style={[styles.interpretHeader, { borderBottomColor: withAlpha(colors.interpretPurple, 0.13), backgroundColor: withAlpha(colors.interpretPurple, 0.06) }]}>
              <Text style={[styles.interpretLabel, { color: colors.interpretPurple }]}>
                {block.isInterpreting ? '\u25CE AI\u901A\u8A33\u4E2D...' : (block.interpretType === 'error' ? '\u2717 \u30A8\u30E9\u30FC\u89E3\u6790' : '\u2713 \u89E3\u8AAC')}
              </Text>
            </View>
            <Text style={[styles.interpretText, { color: colors.interpretText }]} selectable>
              {block.isInterpreting
                ? (block.llmInterpretationStreaming || '')
                : (block.llmInterpretation || '')}
              {block.isInterpreting && <Text style={[styles.interpretCursor, { color: colors.interpretPurple }]}>{'\u258B'}</Text>}
            </Text>
            {!block.isInterpreting && block.llmSuggestedCommand && (
              <View style={[styles.suggestBox, { borderColor: withAlpha(colors.success, 0.2), backgroundColor: withAlpha(colors.success, 0.06) }]}>
                <Text style={[styles.suggestLabel, { color: colors.success }]}>{'\u63D0\u6848\u30B3\u30DE\u30F3\u30C9'}</Text>
                <Text style={styles.suggestCommand} selectable>
                  {'$ '}{block.llmSuggestedCommand}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>
      )}

      {/* Inline feedback toast */}
      {feedbackMsg && (
        <Animated.View style={[
          styles.feedbackToast,
          { backgroundColor: withAlpha(colors.accent, 0.13), borderColor: withAlpha(colors.accent, 0.27) },
          feedbackAnimStyle,
        ]}>
          <Text style={[styles.feedbackText, { color: colors.accent }]}>{feedbackMsg}</Text>
        </Animated.View>
      )}
    </>
  );
}

export const TerminalBlock = memo(TerminalBlockComponent);

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ─── User command bubble (right-aligned) ───────────────────────────────────
  userBubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: 48,
    paddingRight: 8,
    marginTop: 8,
    marginBottom: 2,
  },
  userBubble: {
    borderRadius: 16,
    borderTopRightRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    maxWidth: '100%',
  },
  commandLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  prompt: {
    fontFamily: F.family,
    fontWeight: '700',
    textShadowColor: 'rgba(0, 212, 170, 0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  command: {
    fontFamily: F.family,
    flex: 1,
    flexWrap: 'wrap',
  },
  userMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    marginTop: 4,
  },
  userTimestamp: {
    fontSize: 9,
    fontFamily: F.family,
  },
  termuxBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  termuxBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: F.family,
    letterSpacing: 0.5,
  },
  snippetStar: {
    fontSize: 10,
  },
  exitBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 6,
  },
  exitText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: F.family,
  },

  // ─── Cancelled row ─────────────────────────────────────────────────────────
  cancelledRow: {
    paddingHorizontal: 12,
    marginBottom: 2,
  },
  cancelledBanner: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: 'center',
  },
  cancelledBannerText: {
    fontSize: 11,
    fontFamily: F.family,
  },

  // ─── Output bubble (left-aligned, terminal style) ─────────────────────────
  outputBubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingLeft: 8,
    paddingRight: 32,
    marginBottom: 4,
    gap: 8,
  },
  terminalIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  terminalIconText: {
    fontSize: 9,
    fontWeight: '800',
    fontFamily: F.family,
  },
  outputBubble: {
    flex: 1,
    borderRadius: 12,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
  },
  outputHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: 1,
  },
  outputHeaderLabel: {
    fontSize: 9,
    fontFamily: F.family,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  outputHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  quickCopyBtn: {
    padding: 4,
    borderRadius: 4,
  },
  outputHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flex: 1,
  },
  contentTypeBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  contentTypeLabel: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: F.family,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  richChevron: {
    fontSize: 8,
    lineHeight: 12,
  },
  viewToggleBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  viewToggleText: {
    fontSize: 9,
    fontFamily: F.family,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  richRendererContainer: {
    paddingVertical: 4,
  },
  outputBody: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  outputLines: {
    gap: 0,
  },
  outputLine: {
    fontFamily: F.family,
    flexWrap: 'wrap',
    minHeight: 0,
  },
  linkText: {
    textDecorationLine: 'underline',
  },
  noOutputRow: {
    paddingLeft: 44,
    marginBottom: 4,
  },
  noOutputText: {
    fontFamily: F.family,
    fontSize: 11,
    fontStyle: 'italic',
    paddingVertical: 2,
  },
  collapseToggle: {
    marginTop: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  collapseText: {
    fontSize: 11,
    fontFamily: F.family,
  },

  // ─── Running / Cancel ──────────────────────────────────────────────────────
  runningFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
  },
  runningIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  runningLabel: {
    fontSize: 11,
    fontFamily: F.family,
  },
  cancelButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  cancelButtonText: {
    fontSize: 11,
    fontFamily: F.family,
    fontWeight: '600',
  },

  // ─── Feedback ──────────────────────────────────────────────────────────────
  feedbackToast: {
    alignSelf: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    marginBottom: 4,
  },
  feedbackText: {
    fontSize: 10,
    fontFamily: F.family,
  },

  // ─── LLM Interpret (left-aligned bubble) ──────────────────────────────────
  interpretRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingLeft: 8,
    paddingRight: 48,
    marginBottom: 4,
    gap: 8,
  },
  interpretAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  interpretAvatarText: {
    fontSize: 10,
    fontWeight: '800',
    fontFamily: F.family,
  },
  interpretContainer: {
    flex: 1,
    borderRadius: 12,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
  },
  interpretHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: 1,
  },
  interpretLabel: {
    fontSize: 10,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  interpretText: {
    fontSize: 12,
    fontFamily: F.family,
    lineHeight: 18,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  interpretCursor: {
    fontSize: 12,
    fontFamily: F.family,
  },
  suggestBox: {
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: 6,
    borderWidth: 1,
    padding: 8,
  },
  suggestLabel: {
    fontSize: 9,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  suggestCommand: {
    color: '#86EFAC',
    fontSize: 12,
    fontFamily: F.family,
  },
});

const menuStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
    paddingBottom: 24,
    paddingHorizontal: 12,
  },
  menu: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  menuTitle: {
    fontSize: 12,
    fontFamily: F.family,
    textAlign: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    gap: 12,
  },
  menuIcon: {
    fontSize: 16,
    width: 20,
    textAlign: 'center',
    fontFamily: F.family,
  },
  menuLabel: {
    fontSize: 15,
    flex: 1,
  },
  menuHint: {
    fontSize: 11,
  },
  menuDivider: {
    height: 1,
    marginVertical: 2,
  },
  cancelBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: 1,
    marginTop: 4,
  },
  cancelText: {
    fontSize: 15,
  },
});
