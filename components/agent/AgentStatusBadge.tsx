import React from 'react';
import { View, Text } from 'react-native';
import { Agent } from '@/store/types';

interface Props {
  agent: Agent;
}

export function AgentStatusBadge({ agent }: Props) {
  const icon = !agent.enabled
    ? '⏸️'
    : agent.lastResult === 'success'
    ? '✅'
    : agent.lastResult === 'error'
    ? '❌'
    : '⏳';

  const lastRun = agent.lastRun
    ? new Date(agent.lastRun).toLocaleString('ja-JP', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Not run yet';

  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-base">{icon}</Text>
      <View>
        <Text className="text-white font-medium">{agent.name}</Text>
        <Text className="text-gray-400 text-xs">{lastRun}</Text>
      </View>
    </View>
  );
}
