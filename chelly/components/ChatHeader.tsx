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
import { StatusIndicator } from '@/components/StatusIndicator';
import { useNativeExec } from '@/hooks/use-native-exec';
import { UsagePanel } from '@/components/UsagePanel';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { SaveBadge } from '@/components/SaveBadge';
import { HEADER_HEIGHT, HEADER_PADDING_H, BORDER_WIDTH } from '@/lib/layout-constants';

type ChatHeaderProps = {
  onVoiceChat?: () => void;
};

export function ChatHeader({ onVoiceChat }: ChatHeaderProps = {}) {
  const { colors } = useTheme();
  const { createSession } = useChatStore();

  const session = useChatStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId) ?? null
  );
  const layout = useDeviceLayout();
  const { isMultiPane, toggleMultiPane } = useMultiPaneStore();
  const { readFile: readFileAdapter, listFiles: listFilesAdapter } = useNativeExec();

  const handleNewChat = () => {
    createSession('New Chat');
  };

  return (
    <>
      <View style={[styles.container, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View style={styles.left}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {session?.title ?? 'Shelly'}
          </Text>
          <View style={[styles.statusDot, { backgroundColor: '#4ADE80' }]} />
          <SaveBadge />
        </View>
        <View style={styles.rightActions}>
          {layout.isWide && (
            <TouchableOpacity
              onPress={toggleMultiPane}
              style={styles.newChatBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Multi-pane"
            >
              <MaterialIcons name={isMultiPane ? 'fullscreen' : 'view-column'} size={18} color={isMultiPane ? colors.accent : colors.inactive} />
            </TouchableOpacity>
          )}
          {onVoiceChat && (
            <TouchableOpacity
              onPress={onVoiceChat}
              style={styles.newChatBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Voice chat"
            >
              <MaterialIcons name="record-voice-over" size={18} color={colors.accent} />
            </TouchableOpacity>
          )}
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
      </View>
      <StatusIndicator />
      <UsagePanel readFile={readFileAdapter} listFiles={listFilesAdapter} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: HEADER_PADDING_H,
    height: HEADER_HEIGHT,
    borderBottomWidth: BORDER_WIDTH,
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
  rightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
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
