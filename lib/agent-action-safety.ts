import { checkCommandSafety, DangerLevel } from './command-safety';

export type AgentActionSafety = {
  level: DangerLevel;
  reason: string;
  message: string;
  autoApprovable: boolean;
};

const AUTO_APPROVABLE_LEVELS = new Set<DangerLevel>(['SAFE', 'LOW']);

export function evaluateAgentActionCommand(command: string): AgentActionSafety {
  const result = checkCommandSafety(command);
  return {
    level: result.level,
    reason: result.reason || 'No risky command pattern matched.',
    message: result.message || '',
    autoApprovable: AUTO_APPROVABLE_LEVELS.has(result.level),
  };
}
