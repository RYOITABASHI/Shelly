import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useAgentStore } from '@/store/agent-store';
import { AgentStatusBadge } from './AgentStatusBadge';
import { deleteAgent } from '@/lib/agent-manager';
import { toolChoiceToLabel } from '@/lib/agent-tool-router';

export function AgentListPanel() {
  const agents = useAgentStore((s) => s.agents);

  if (agents.length === 0) {
    return (
      <View className="p-4">
        <Text className="text-gray-400 text-center">
          No background agents configured.{'\n'}
          Use @agent in chat to create one.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={agents}
      keyExtractor={(a) => a.id}
      renderItem={({ item }) => (
        <TouchableOpacity
          className="flex-row items-center justify-between p-3 border-b border-gray-800"
          onLongPress={() => {
            Alert.alert(
              'Delete Agent',
              `Delete "${item.name}"?`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => deleteAgent(item.id),
                },
              ]
            );
          }}
        >
          <AgentStatusBadge agent={item} />
          <View className="items-end">
            <Text className="text-gray-400 text-xs">
              {item.schedule || 'Manual'}
            </Text>
            <Text className="text-gray-500 text-xs">
              {toolChoiceToLabel(item.tool)}
            </Text>
          </View>
        </TouchableOpacity>
      )}
    />
  );
}
