import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { ToolSuggestion } from '@/lib/agent-tool-router';
import { createAgent, generateSaveCommand } from '@/lib/agent-manager';
import { installSchedule } from '@/lib/agent-scheduler';

interface Props {
  prompt: string;
  suggestion: ToolSuggestion;
  onConfirm: (message: string) => void;
  onCancel: () => void;
  runCommand: (cmd: string) => Promise<string>;
}

export function AgentCreateFlow({ prompt, suggestion, onConfirm, onCancel, runCommand }: Props) {
  const [confirmed, setConfirmed] = useState(false);

  const agentName = extractAgentName(prompt);
  const schedule = extractSchedule(prompt);
  const outputPath = extractOutputPath(prompt);

  const handleConfirm = async () => {
    setConfirmed(true);

    const agent = createAgent({
      name: agentName,
      description: prompt,
      prompt: prompt,
      schedule: schedule,
      tool: suggestion.tool,
      outputPath: outputPath,
    });

    await runCommand(generateSaveCommand(agent));

    if (agent.schedule) {
      await installSchedule(agent);
    }

    onConfirm(`Agent "${agent.name}" created. ${schedule ? 'Next run: scheduled.' : 'Run manually with @agent run ' + agentName}`);
  };

  if (confirmed) {
    return (
      <View className="bg-green-900/30 rounded-lg p-3 m-2">
        <Text className="text-green-400">Agent created</Text>
      </View>
    );
  }

  return (
    <View className="bg-gray-800 rounded-lg p-4 m-2">
      <Text className="text-white font-bold mb-2">Create Background Agent</Text>

      <View className="gap-1 mb-3">
        <Text className="text-gray-300">Name: {agentName}</Text>
        <Text className="text-gray-300">Tool: {suggestion.label}</Text>
        <Text className="text-gray-400 text-xs ml-5">{suggestion.reason}</Text>
        <Text className="text-gray-300">Schedule: {schedule || 'Manual trigger only'}</Text>
        <Text className="text-gray-300">Output: {outputPath}</Text>
      </View>

      <View className="flex-row gap-3">
        <TouchableOpacity
          className="bg-emerald-600 rounded-lg px-4 py-2 flex-1"
          onPress={handleConfirm}
        >
          <Text className="text-white text-center font-medium">Create</Text>
        </TouchableOpacity>
        <TouchableOpacity
          className="bg-gray-600 rounded-lg px-4 py-2"
          onPress={onCancel}
        >
          <Text className="text-white text-center">Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function extractAgentName(prompt: string): string {
  const cleaned = prompt.replace(/毎|週|月|日|朝|夕|に|を|して|の|で|から/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(w => w.length > 1).slice(0, 3);
  return words.join(' ') || prompt.slice(0, 30);
}

function extractSchedule(prompt: string): string | null {
  if (/毎日|every\s*day|daily/i.test(prompt)) return '0 9 * * *';
  if (/毎週|weekly|every\s*week/i.test(prompt)) return '0 9 * * 1';
  if (/月水金/i.test(prompt)) return '0 9 * * 1,3,5';
  if (/火木/i.test(prompt)) return '0 9 * * 2,4';
  return null;
}

function extractOutputPath(prompt: string): string {
  const pathMatch = prompt.match(/[~\/][\w\/.-]+\//);
  if (pathMatch) return pathMatch[0];
  return '~/.shelly/agents/output/';
}
