import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

interface PreviewBannerProps {
  url: string;
  onOpen: () => void;
  onDismiss: () => void;
}

export function PreviewBanner({ url, onOpen, onDismiss }: PreviewBannerProps) {
  const { colors: c } = useTheme();
  const slideAnim = useRef(new Animated.Value(-50)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 100,
      friction: 12,
    }).start();

    // Auto-dismiss after 10 seconds
    const timer = setTimeout(onDismiss, 10000);
    return () => clearTimeout(timer);
  }, []);

  const handleCopyUrl = async () => {
    await Clipboard.setStringAsync(url);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // Display shortened URL
  const shortUrl = url.replace(/^https?:\/\//, '');

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: withAlpha(c.accent, 0.12),
          borderBottomColor: withAlpha(c.accent, 0.3),
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <MaterialIcons name="language" size={16} color={c.accent} />
      <Pressable onPress={handleCopyUrl} style={styles.urlArea}>
        <Text style={[styles.label, { color: c.muted }]}>Preview available: </Text>
        <Text style={[styles.url, { color: c.accent }]} numberOfLines={1}>{shortUrl}</Text>
      </Pressable>
      <Pressable onPress={onOpen} style={[styles.openBtn, { backgroundColor: c.accent }]}>
        <Text style={[styles.openBtnText, { color: c.background }]}>Open</Text>
      </Pressable>
      <Pressable onPress={onDismiss} style={styles.dismissBtn} hitSlop={8}>
        <MaterialIcons name="close" size={16} color={c.muted} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  urlArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  url: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  openBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 4,
  },
  openBtnText: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
  },
  dismissBtn: {
    padding: 4,
  },
});
