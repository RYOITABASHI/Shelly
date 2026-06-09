/**
 * lib/agent-manager.ts — Agent CRUD, orchestration, and @agent command parsing.
 * Entry point for all agent operations from the chat UI.
 */
import { useAgentStore } from '@/store/agent-store';
import { Agent, AgentRunLog, ToolChoice } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { generateRunScript, generateStopCommand, generateInstallCommands, getScriptPath } from './agent-executor';
import { installSchedule, uninstallSchedule } from './agent-scheduler';
import { getHomePath } from '@/lib/home-path';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';

const agentsDir = () => `${getHomePath()}/.shelly/agents`;

/**
 * Parse @agent commands from chat input.
 *
 * Supported commands:
 *   @agent list               — List all agents
 *   @agent run <name>         — Manual trigger
 *   @agent stop <name>        — Stop running agent
 *   @agent delete <name>      — Delete agent
 *   @agent edit <name>        — Edit agent (opens creation flow)
 *   @agent history <name>     — Show run history
 *   @agent status             — All agents status summary
 *   @agent <natural language> — Create new agent via wizard
 */
export interface AgentCommandResult {
  type: 'list' | 'run' | 'stop' | 'delete' | 'history' | 'status' | 'create' | 'error';
  message: string;
  data?: any;
}

export function parseAgentCommand(input: string): AgentCommandResult {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();
  const nameArg = parts.slice(1).join(' ');

  const store = useAgentStore.getState();

  switch (subcommand) {
    case 'list':
      return listAgents(store.agents);

    case 'run': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'run', message: `Running ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'stop': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'stop', message: `Stopping ${agent.name}...`, data: { agentId: agent.id } };
    }

    case 'delete': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'delete', message: `Delete ${agent.name}?`, data: { agent } };
    }

    case 'history': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      const logs = store.getRunHistory(agent.id);
      return { type: 'history', message: formatHistory(agent, logs), data: { logs } };
    }

    case 'edit': {
      const agent = store.getAgentByName(nameArg);
      if (!agent) return { type: 'error', message: `Agent "${nameArg}" not found` };
      return { type: 'create', message: nameArg, data: { suggestion: suggestTool(agent.prompt), editAgent: agent } };
    }

    case 'status':
      return statusAll(store.agents);

    default:
      // Natural language — trigger creation flow
      return {
        type: 'create',
        message: trimmed,
        data: { suggestion: suggestTool(trimmed) },
      };
  }
}

function listAgents(agents: Agent[]): AgentCommandResult {
  if (agents.length === 0) {
    return { type: 'list', message: 'No agents configured. Describe a task to create one.' };
  }
  const lines = agents.map((a) => {
    const status = a.lastResult === 'success' ? '✅' : a.lastResult === 'error' ? '❌' : '⏸️';
    const schedule = a.schedule || 'manual';
    return `${status} **${a.name}** — ${schedule} — ${toolChoiceToLabel(a.tool)}`;
  });
  return { type: 'list', message: lines.join('\n') };
}

function statusAll(agents: Agent[]): AgentCommandResult {
  if (agents.length === 0) {
    return { type: 'status', message: 'No agents configured.' };
  }
  const lines = agents.map((a) => {
    const status = a.enabled ? (a.lastResult === 'success' ? '✅' : a.lastResult === 'error' ? '❌' : '⏳') : '⏸️';
    const lastRun = a.lastRun ? new Date(a.lastRun).toLocaleString('ja-JP') : 'never';
    return `${status} **${a.name}** — last: ${lastRun}`;
  });
  return { type: 'status', message: lines.join('\n') };
}

function formatHistory(agent: Agent, logs: any[]): string {
  if (logs.length === 0) return `No run history for ${agent.name}.`;
  const lines = logs.slice(-10).reverse().map((log) => {
    const date = new Date(log.timestamp).toLocaleString('ja-JP');
    const icon = log.status === 'success' ? '✅' : log.status === 'error' ? '❌' : '⏭️';
    const duration = `${(log.durationMs / 1000).toFixed(0)}s`;
    return `${icon} ${date} — ${duration} — ${log.toolUsed}`;
  });
  return `**${agent.name}** — Last ${lines.length} runs:\n${lines.join('\n')}`;
}

/**
 * Create a new agent from parsed creation data.
 */
export function createAgent(params: {
  name: string;
  description: string;
  prompt: string;
  schedule: string | null;
  tool: ToolChoice;
  outputPath: string;
  outputTemplate?: string;
}): Agent {
  const agent: Agent = {
    id: `agent-${Date.now().toString(36)}`,
    name: params.name,
    description: params.description,
    prompt: params.prompt,
    schedule: params.schedule,
    tool: params.tool,
    outputPath: params.outputPath,
    outputTemplate: params.outputTemplate || null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: Date.now(),
    version: 1,
  };

  useAgentStore.getState().addAgent(agent);
  return agent;
}

/**
 * Materialize an agent into Shelly HOME so AlarmManager can run it without
 * Termux: JSON metadata, generated bash script, executable bit, and schedule.
 */
export async function installAgent(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  await materializeAgent(agent, runCommand, true);
}

async function materializeAgent(
  agent: Agent,
  runCommand: (cmd: string) => Promise<string>,
  installAlarm: boolean
): Promise<void> {
  const scriptPath = getScriptPath(agent.id);
  const metadataPath = `${agentsDir()}/${agent.id}.json`;
  const commands = [
    `mkdir -p ${shellQuote(agentsDir())}`,
    writeFileCommand(metadataPath, JSON.stringify(agent, null, 2)),
    writeFileCommand(scriptPath, generateRunScript(agent)),
    ...generateInstallCommands(agent),
  ];

  await runCommand(`set -e\n${commands.join('\n')}`);
  if (installAlarm) {
    await installSchedule(agent);
  }
}

export async function runAgentNow(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (agent) {
    await materializeAgent(agent, runCommand, false);
  }
  await TerminalEmulator.runAgent(agentId);
  await syncAgentRunLogsFromDisk(runCommand, agentId);
}

export async function stopAgent(
  agentId: string,
  runCommand: (cmd: string) => Promise<string>
): Promise<void> {
  await runCommand(generateStopCommand(agentId));
}

/**
 * Delete an agent and clean up.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  await uninstallSchedule(agentId);
  const dir = agentsDir();
  const command = [
    `rm -f ${shellQuote(`${dir}/${agentId}.json`)}`,
    `rm -f ${shellQuote(`${dir}/run-agent-${agentId}.sh`)}`,
    `rm -f ${shellQuote(`${dir}/locks/${agentId}.pid`)}`,
    `rm -rf ${shellQuote(`${dir}/logs/${agentId}`)}`,
  ].join(' && ');
  try {
    await TerminalEmulator.execCommand(command, 30_000);
  } catch {
    // Deleting store state should not be blocked by filesystem cleanup.
  }
  useAgentStore.getState().removeAgent(agentId);
}

/**
 * Send notification for agent result.
 */
export async function notifyAgentResult(
  agent: Agent,
  status: 'success' | 'error' | 'skipped',
  summary: string
): Promise<void> {
  const icon = status === 'success' ? '✅' : status === 'error' ? '❌' : '⏭️';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${icon} ${agent.name}`,
      body: summary,
      data: { agentId: agent.id },
    },
    trigger: null,
  });
}

/**
 * Load agents from filesystem on app startup.
 * Called from app initialization.
 */
export async function loadAgentsFromDisk(
  runCommand: (cmd: string) => Promise<string>,
  options: {
    syncLogs?: boolean;
    repairSchedules?: boolean;
    repairDelayMs?: number;
    shouldRepair?: () => boolean;
  } = {}
): Promise<void> {
  const {
    syncLogs = true,
    repairSchedules = true,
    repairDelayMs,
    shouldRepair,
  } = options;

  try {
    const agents = syncLogs
      ? await readAgentMetadataViaShell(runCommand)
      : await readAgentMetadataLightweight(runCommand);

    if (agents.length === 0) {
      useAgentStore.getState().setAgents([]);
      return;
    }
    const runHistory = syncLogs
      ? await readAgentRunLogs(runCommand)
      : useAgentStore.getState().runHistory;
    const agentsWithStatus = agents.map((agent) => {
      const latest = runHistory[agent.id]?.at(-1);
      return latest
        ? {
            ...agent,
            lastRun: latest.timestamp,
            lastResult: latest.status === 'success' ? 'success' as const : latest.status === 'error' ? 'error' as const : agent.lastResult,
          }
        : agent;
    });

    if (syncLogs) {
      useAgentStore.getState().setRunHistory(runHistory);
    }
    useAgentStore.getState().setAgents(agentsWithStatus);
    if (repairSchedules) {
      scheduleAgentStartupRepair(agentsWithStatus, runCommand, repairDelayMs, shouldRepair);
    }
  } catch {
    useAgentStore.getState().setAgents([]);
  }
}

function scheduleAgentStartupRepair(
  agents: Agent[],
  runCommand: (cmd: string) => Promise<string>,
  delayMs = 60_000,
  shouldRun: (() => boolean) | undefined
): void {
  const scheduledAgents = agents.filter((agent) => agent.enabled && agent.schedule);
  if (scheduledAgents.length === 0) return;

  setTimeout(() => {
    if (shouldRun && !shouldRun()) return;
    void (async () => {
      for (const agent of scheduledAgents) {
        if (shouldRun && !shouldRun()) return;
        try {
          await materializeAgent(agent, runCommand, true);
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch (error) {
          console.warn('Failed to repair scheduled agent on startup', agent.id, error);
        }
      }
    })();
  }, delayMs);
}

async function readAgentMetadataLightweight(
  runCommand: (cmd: string) => Promise<string>
): Promise<Agent[]> {
  const agents = await readAgentMetadataViaFileSystem();
  if (agents) return agents;
  return readAgentMetadataViaShell(runCommand);
}

async function readAgentMetadataViaFileSystem(): Promise<Agent[] | null> {
  try {
    const dirUri = toFileUri(agentsDir());
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dirUri);
    const agents: Agent[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const content = await FileSystem.readAsStringAsync(`${dirUri}/${name}`);
        agents.push(JSON.parse(content) as Agent);
      } catch {
        // Skip malformed or concurrently-written metadata files.
      }
    }
    return agents;
  } catch {
    return null;
  }
}

async function readAgentMetadataViaShell(
  runCommand: (cmd: string) => Promise<string>
): Promise<Agent[]> {
  const output = await runCommand(
    `ls ${shellQuote(agentsDir())}/*.json 2>/dev/null | while read f; do cat "$f"; echo "---SEPARATOR---"; done`
  );
  if (!output.trim()) return [];
  const agents: Agent[] = [];
  const chunks = output.split('---SEPARATOR---').filter((c) => c.trim());
  for (const chunk of chunks) {
    try {
      agents.push(JSON.parse(chunk.trim()) as Agent);
    } catch {
      // Skip malformed agent files.
    }
  }
  return agents;
}

export async function syncAgentRunLogsFromDisk(
  runCommand: (cmd: string) => Promise<string>,
  agentId?: string
): Promise<void> {
  const runHistory = await readAgentRunLogs(runCommand, agentId);
  const store = useAgentStore.getState();
  const mergedHistory = agentId
    ? { ...store.runHistory, [agentId]: runHistory[agentId] || [] }
    : runHistory;

  const agents = store.agents.map((agent) => {
    const latest = mergedHistory[agent.id]?.at(-1);
    if (!latest) return agent;
    return {
      ...agent,
      lastRun: latest.timestamp,
      lastResult: latest.status === 'success' ? 'success' as const : latest.status === 'error' ? 'error' as const : agent.lastResult,
    };
  });

  store.setRunHistory(mergedHistory);
  store.setAgents(agents);
}

async function readAgentRunLogs(
  runCommand: (cmd: string) => Promise<string>,
  agentId?: string
): Promise<Record<string, AgentRunLog[]>> {
  const logsRoot = `${agentsDir()}/logs`;
  const command = agentId
    ? `find ${shellQuote(`${logsRoot}/${agentId}`)} -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort | tail -n 30 | while IFS= read -r f; do cat "$f"; printf '\\n---SHELLY_AGENT_LOG---\\n'; done`
    : `for d in ${shellQuote(logsRoot)}/*; do [ -d "$d" ] || continue; find "$d" -maxdepth 1 -type f -name '*.json' 2>/dev/null | sort | tail -n 30 | while IFS= read -r f; do cat "$f"; printf '\\n---SHELLY_AGENT_LOG---\\n'; done; done 2>/dev/null`;
  const output = await runCommand(command);
  const logs: AgentRunLog[] = [];
  for (const chunk of output.split('---SHELLY_AGENT_LOG---')) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      const log = JSON.parse(text) as AgentRunLog;
      if (
        typeof log.agentId === 'string' &&
        typeof log.timestamp === 'number' &&
        (log.status === 'success' || log.status === 'error' || log.status === 'skipped')
      ) {
        logs.push(log);
      }
    } catch {
      // Ignore partially written or malformed logs.
    }
  }

  const grouped: Record<string, AgentRunLog[]> = {};
  for (const log of logs.sort((a, b) => a.timestamp - b.timestamp)) {
    grouped[log.agentId] = [...(grouped[log.agentId] || []), log].slice(-30);
  }
  return grouped;
}

/**
 * Persist a single agent to disk.
 */
export function generateSaveCommand(agent: Agent): string {
  const json = JSON.stringify(agent, null, 2);
  const escaped = json.replace(/'/g, "'\\''");
  const dir = agentsDir();
  return `mkdir -p ${shellQuote(dir)} && echo '${escaped}' > ${shellQuote(`${dir}/${agent.id}.json`)}`;
}

function writeFileCommand(path: string, content: string): string {
  const marker = `SHELLY_AGENT_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `mkdir -p "$(dirname ${shellQuote(path)})" && cat > ${shellQuote(path)} <<'${marker}'
${content}
${marker}`;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}
