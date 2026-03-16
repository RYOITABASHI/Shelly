import React, { useRef, useEffect, useCallback, useState, memo } from 'react';
import {
  FlatList,
  View,
  Text,
  StyleSheet,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  FadeIn,
} from 'react-native-reanimated';
import { CommandBlock, TerminalEntry, AiBlock as AiBlockType } from '@/store/types';
import { TerminalBlock } from './TerminalBlock';
import { AiBlock } from '@/components/terminal/AiBlock';
import { useTerminalStore } from '@/store/terminal-store';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS, TIMING_CONFIGS } from '@/hooks/use-motion';

type Props = {
  blocks: CommandBlock[];
  entries?: TerminalEntry[];
  currentDir: string;
  onRerun?: (command: string) => void;
  onCancel?: (blockId: string) => void;
  onSelectTool?: (mentionExample: string) => void;
};

function isAiBlock(entry: TerminalEntry): entry is AiBlockType {
  return 'blockType' in entry && entry.blockType === 'ai';
}

// ─── BlinkingCursor ─────────────────────────────────────────────────────────

function BlinkingCursor({ color, size = 14 }: { color: string; size?: number }) {
  const opacity = useSharedValue(0.9);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 500 }),
        withTiming(0.2, { duration: 500 }),
      ),
      -1,
      false,
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text style={[{ color, fontFamily: 'monospace', fontSize: size }, animStyle]}>
      {'\u258B'}
    </Animated.Text>
  );
}

// ─── WelcomeBanner ──────────────────────────────────────────────────────────

const WelcomeBanner = memo(function WelcomeBanner() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Animated.View
      entering={FadeIn.duration(400).delay(100)}
      style={[styles.welcome, { borderBottomColor: colors.surface }]}
    >
      <Text style={[styles.welcomeAscii, { color: colors.accent }]} allowFontScaling={false}>
        {`  ____  _          _ _\n`}
        {` / ___|| |__   ___| | |_   _\n`}
        {` \\___ \\| '_ \\ / _ \\ | | | | |\n`}
        {`  ___) | | | |  __/ | | |_| |\n`}
        {` |____/|_| |_|\\___|_|_|\\__, |\n`}
        {`                       |___/`}
      </Text>
      <Text style={[styles.welcomeSubtitle, { color: colors.muted }]}>{t('welcome.subtitle')}</Text>
      <Text style={[styles.welcomeHint, { color: colors.hint }]}>{t('welcome.hint_help')}</Text>
      <Text style={[styles.welcomeHint, { color: colors.hint }]}>{t('welcome.hint_ai')}</Text>
      <Text style={[styles.welcomeHint, { color: colors.hint }]}>{t('welcome.hint_natural')}</Text>
    </Animated.View>
  );
});

// ─── ScrollToBottomButton ──────────────────────────────────────────────────

function ScrollToBottomButton({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  const scale = useSharedValue(0);
  const btnOpacity = useSharedValue(0);

  useEffect(() => {
    scale.value = withSpring(1, SPRING_CONFIGS.bouncy);
    btnOpacity.value = withTiming(1, TIMING_CONFIGS.fast);
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: btnOpacity.value,
  }));

  return (
    <Animated.View style={[styles.scrollBtnWrapper, animStyle]} pointerEvents="box-none">
      <Text
        style={[styles.scrollBtn, { backgroundColor: colors.accent, color: colors.background }]}
        onPress={onPress}
      >
        {'\u2193 \u6700\u65B0\u3078'}
      </Text>
    </Animated.View>
  );
}

// ─── BlockList ──────────────────────────────────────────────────────────────

export function BlockList({ blocks, entries, currentDir, onRerun, onCancel, onSelectTool }: Props) {
  const { colors } = useTheme();
  const flatListRef = useRef<FlatList>(null);
  const fontSize = useTerminalStore((s) => s.settings.fontSize);
  const lineHeight = useTerminalStore((s) => s.settings.lineHeight);
  const autoScroll = useTerminalStore((s) => s.settings.autoScroll);

  const displayData: TerminalEntry[] = entries && entries.length > 0 ? entries : blocks;

  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevDataLenRef = useRef(displayData.length);

  useEffect(() => {
    const newItemArrived = displayData.length > prevDataLenRef.current;
    prevDataLenRef.current = displayData.length;

    if (!newItemArrived) return;

    if (autoScroll && isAtBottomRef.current) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 80);
    } else if (!isAtBottomRef.current) {
      setShowScrollBtn(true);
    }
  }, [displayData, autoScroll]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      const atBottom = distanceFromBottom < 60;
      isAtBottomRef.current = atBottom;
      if (atBottom) setShowScrollBtn(false);
    },
    []
  );

  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToEnd({ animated: true });
    setShowScrollBtn(false);
    isAtBottomRef.current = true;
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: TerminalEntry }) => {
      if (isAiBlock(item)) {
        return (
          <AiBlock
            block={item}
            onSelectTool={onSelectTool}
            onRunCommand={onRerun}
            onRetry={onRerun}
            onAskOther={onSelectTool}
            fontSize={fontSize}
          />
        );
      }
      return (
        <TerminalBlock
          block={item}
          fontSize={fontSize}
          lineHeight={lineHeight}
          onRerun={onRerun}
          onCancel={onCancel}
        />
      );
    },
    [fontSize, lineHeight, onRerun, onCancel, onSelectTool]
  );

  const keyExtractor = useCallback((item: TerminalEntry) => item.id, []);

  const lastInputMode = useTerminalStore((s) => s.lastInputMode);

  const PromptFooter = useCallback(
    () => {
      if (lastInputMode === 'natural') {
        return (
          <View style={styles.promptFooterRow}>
            <View style={[styles.promptBubble, { backgroundColor: withAlpha(colors.aiPurple, 0.08), borderColor: withAlpha(colors.aiPurple, 0.2) }]}>
              <Text style={[styles.promptAi, { color: colors.aiPurple, fontSize: fontSize - 1 }]}>
                AI
              </Text>
              <Text
                style={[styles.promptNatural, { color: colors.muted, fontSize: fontSize - 1 }]}
                numberOfLines={1}
              >
                {'\u4F55\u3067\u3082\u805E\u3044\u3066\u304F\u3060\u3055\u3044'}
              </Text>
              <BlinkingCursor color={colors.aiPurple} size={fontSize} />
            </View>
          </View>
        );
      }
      return (
        <View style={styles.promptFooterRow}>
          <View style={[styles.promptBubble, { backgroundColor: withAlpha(colors.accent, 0.06), borderColor: withAlpha(colors.accent, 0.15) }]}>
            <Text
              style={[styles.promptDir, { color: colors.success, fontSize: fontSize - 1 }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {`user@shelly:${currentDir}`}
            </Text>
            <Text style={[styles.promptSymbol, { color: colors.accent, fontSize }]}>
              {' $ '}
            </Text>
            <BlinkingCursor color={colors.accent} size={fontSize} />
          </View>
        </View>
      );
    },
    [currentDir, fontSize, lastInputMode, colors]
  );

  return (
    <View style={styles.container}>
      <FlatList
        ref={flatListRef}
        data={displayData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={<WelcomeBanner />}
        ListFooterComponent={<PromptFooter />}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
        showsVerticalScrollIndicator
        indicatorStyle="white"
        onScroll={handleScroll}
        scrollEventThrottle={100}
        removeClippedSubviews
        maxToRenderPerBatch={8}
        windowSize={10}
        initialNumToRender={12}
        updateCellsBatchingPeriod={50}
      />

      {showScrollBtn && (
        <ScrollToBottomButton onPress={scrollToBottom} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  listContent: {
    paddingBottom: 12,
    flexGrow: 1,
  },
  welcome: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    marginBottom: 8,
  },
  welcomeAscii: {
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15,
  },
  welcomeSubtitle: {
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 8,
  },
  welcomeHint: {
    fontFamily: 'monospace',
    fontSize: 10,
    marginTop: 2,
  },
  promptFooterRow: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
  },
  promptBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    flexWrap: 'nowrap',
  },
  promptDir: {
    fontFamily: 'monospace',
    flexShrink: 1,
  },
  promptSymbol: {
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  promptAi: {
    fontFamily: 'monospace',
    fontWeight: '700',
    marginRight: 6,
  },
  promptNatural: {
    fontFamily: 'monospace',
    flex: 1,
  },
  scrollBtnWrapper: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    zIndex: 10,
  },
  scrollBtn: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
  },
});
