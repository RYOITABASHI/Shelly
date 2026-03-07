/**
 * components/chat/ChatHeader.tsx
 *
 * Chat screen header — session title, new chat button, connection status.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useChatStore } from '@/store/chat-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';

export function ChatHeader() {
  const { colors } = useTheme();
  const { isConnected } = useTermuxBridge();
  const { getActiveSession, createSession } = useChatStore();
  const session = getActiveSession();

  const handleNewChat = () => {
    createSession('New Chat');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
      <View style={styles.left}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {session?.title ?? 'Shelly'}
        </Text>
        <View style={[styles.statusDot, { backgroundColor: isConnected ? '#4ADE80' : colors.inactive }]} />
      </View>
      <TouchableOpacity
        onPress={handleNewChat}
        style={styles.newChatBtn}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="New chat"
      >
        <MaterialIcons name="add" size={20} color={colors.accent} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  newChatBtn: {
    padding: 10,
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
});
