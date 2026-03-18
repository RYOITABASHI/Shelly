/**
 * lib/intent-router.ts — v1.1
 *
 * LLM-based intent router.
 *
 * Analyzes user input via local LLM and selects the optimal tool.
 * Uses LLM contextual understanding rather than keyword matching.
 *
 * Flow:
 * 1. Send user input + available tool status to LLM
 * 2. LLM returns JSON: {tool, reason, setupRequired}
 * 3. If setupRequired=true, suggest auto-setup via env-manager
 * 4. Fallback: keyword-based classifyTask() when LLM unavailable
 *
 * Priority order (when LLM unavailable):
 *   chat: groq (if key set) > CLI fallback
 *   code: claude-code > codex > gemini-cli
 */

import type { ToolStatus } from './shelly-system-prompt';
import type { LocalLlmConfig, OllamaMessage, TaskCategory } from './local-llm';
import { ollamaChat, classifyTask } from './local-llm';
import type { ToolId } from './env-manager';
import { getToolById } from './env-manager';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoutingTool = 'claude-code' | 'gemini-cli' | 'codex' | 'local-llm' | 'groq' | 'termux';

export interface RoutingDecision {
  tool: RoutingTool;
  reason: string;
  setupRequired: boolean;
  setupToolId?: ToolId;
  setupMessage?: string;
  prompt: string;
  usedFallback: boolean;
}

// ─── Routing System Prompt ────────────────────────────────────────────────────

function buildRoutingPrompt(toolStatuses: ToolStatus[]): string {
  const toolDescriptions = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      strengths: 'Code generation, file editing, project creation, bug fixing, refactoring, git operations. Can autonomously read/write files. Most capable for complex tasks.',
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      strengths: 'Web search, latest info research, documentation lookup, code generation. Good at information gathering via Google Search. Free tier available.',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      strengths: 'Fast, lightweight code fixes, simple file edits, quick tasks. Lighter than Claude Code, suited for quick modifications.',
    },
    {
      id: 'groq',
      name: 'Groq (Llama 3.3 70B)',
      strengths: 'Fast chat responses, Q&A, translation, summarization. Cloud API with very low latency. Cannot read/write files or execute code.',
    },
    {
      id: 'local-llm',
      name: 'Local LLM',
      strengths: 'General questions, conversations, simple consultations, concept explanations. Works offline with privacy. Cannot generate or execute code.',
    },
    {
      id: 'termux',
      name: 'Termux Command',
      strengths: 'Simple file operations (ls, mkdir, cp, mv, rm), package management, shell script execution. Direct command execution without AI.',
    },
  ];

  const statusLines = toolDescriptions.map((t) => {
    const status = toolStatuses.find((s) => s.id === t.id);
    const available = status?.installed ? 'Available' : 'Not installed';
    return `- ${t.name} (${t.id}): ${t.strengths}\n  Status: ${available}`;
  }).join('\n');

  return `You are the intent router for the Shelly app.
Analyze the user's input and select the single most appropriate tool.

# Available Tools
${statusLines}

# Rules
1. Accurately understand user intent and choose the most appropriate tool
2. For compound tasks (research+implementation), choose the tool best for the primary work
3. Even uninstalled tools can be selected if optimal (setup will be offered)
4. Simple conversation/questions should use local-llm (no external tool needed)
5. Simple file operations (ls, mkdir etc.) should use termux directly
6. Prefer installed tools over uninstalled ones when capabilities are similar

# Output format (always return this exact JSON format)
{"tool":"toolID","reason":"selection reason (1-2 sentences)"}

Return only JSON. No explanation or markdown.`;
}

// ─── LLM-based Router ────────────────────────────────────────────────────────

export async function routeIntent(
  userInput: string,
  config: LocalLlmConfig,
  toolStatuses: ToolStatus[] = [],
  defaultAgent?: 'gemini-cli' | 'claude-code' | 'codex',
  options?: { groqApiKey?: string },
): Promise<RoutingDecision> {
  // LLM disabled → fallback
  if (!config.enabled) {
    return fallbackRoute(userInput, toolStatuses, defaultAgent, options);
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildRoutingPrompt(toolStatuses) },
    { role: 'user', content: userInput },
  ];

  const result = await ollamaChat(config, messages, 15000, undefined, 64);

  if (!result.success || !result.content) {
    return fallbackRoute(userInput, toolStatuses, defaultAgent, options);
  }

  try {
    const parsed = parseRoutingResponse(result.content);
    if (parsed) {
      return buildDecision(parsed.tool, parsed.reason, userInput, toolStatuses, false);
    }
  } catch {
    // parse failure → fallback
  }

  return fallbackRoute(userInput, toolStatuses, defaultAgent, options);
}

function parseRoutingResponse(content: string): { tool: RoutingTool; reason: string } | null {
  const jsonMatch = content.match(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validTools: RoutingTool[] = ['claude-code', 'gemini-cli', 'codex', 'local-llm', 'groq', 'termux'];
    if (validTools.includes(parsed.tool)) {
      return { tool: parsed.tool, reason: parsed.reason || '' };
    }
  } catch {
    // JSON parse error
  }

  return null;
}

// ─── Decision Builder ─────────────────────────────────────────────────────────

function buildDecision(
  tool: RoutingTool,
  reason: string,
  userInput: string,
  toolStatuses: ToolStatus[],
  usedFallback: boolean,
): RoutingDecision {
  const decision: RoutingDecision = {
    tool,
    reason,
    setupRequired: false,
    prompt: userInput,
    usedFallback,
  };

  const toolIdMap: Partial<Record<RoutingTool, ToolId>> = {
    'claude-code': 'claude-code',
    'gemini-cli': 'gemini-cli',
  };

  const toolId = toolIdMap[tool];
  if (toolId) {
    const status = toolStatuses.find((s) => s.id === toolId);
    if (status && !status.installed) {
      const toolDef = getToolById(toolId);
      decision.setupRequired = true;
      decision.setupToolId = toolId;
      decision.setupMessage = toolDef
        ? `${toolDef.name} is not installed yet. ${toolDef.userFriendlyDescription}\n\nStart setup?`
        : `${toolId} needs to be set up. Start installation?`;
    }
  }

  return decision;
}

// ─── Fallback (Keyword-based) ─────────────────────────────────────────────────

/**
 * Fallback routing when LLM is unavailable.
 *
 * Priority order (based on installed tools):
 *   claude-code (if installed) > codex (if installed) > gemini-cli
 *
 * - chat → groq (if API key set) > local-llm > best CLI
 * - code → claude-code > codex > gemini-cli
 * - research → gemini-cli (best for search)
 * - file_ops → termux
 * - unknown → best installed CLI
 */
function fallbackRoute(
  userInput: string,
  toolStatuses: ToolStatus[],
  explicitDefault?: RoutingTool,
  options?: { groqApiKey?: string },
): RoutingDecision {
  const input = userInput.toLowerCase();
  const category = classifyTask(userInput);

  // Explicit tool name mentions
  const mentionsClaude = ['claude'].some((k) => input.includes(k));
  const mentionsGemini = ['gemini'].some((k) => input.includes(k));
  if (mentionsClaude && !mentionsGemini) {
    return buildDecision('claude-code', 'Routing to Claude Code', userInput, toolStatuses, true);
  }
  if (mentionsGemini && !mentionsClaude) {
    return buildDecision('gemini-cli', 'Routing to Gemini CLI', userInput, toolStatuses, true);
  }

  // Determine best available CLI based on installed tools
  const hasClaude = toolStatuses.some((s) => s.id === 'claude-code' && s.installed);
  const hasCodex = toolStatuses.some((s) => s.id === 'codex' && s.installed);
  const hasGroqKey = !!(options?.groqApiKey && options.groqApiKey.trim().length > 0);

  // Default agent priority: explicit > claude-code > codex > gemini-cli
  const defaultAgent: RoutingTool = explicitDefault
    ?? (hasClaude ? 'claude-code' : hasCodex ? 'codex' : 'gemini-cli');

  const defaultLabel = defaultAgent === 'claude-code' ? 'Claude Code'
    : defaultAgent === 'codex' ? 'Codex CLI' : 'Gemini CLI';

  // Chat tasks: route to user's default CLI (not Groq — Groq is for intent classification & interpretation)
  // Code tasks: prefer claude-code if available
  const codeTool: RoutingTool = hasClaude ? 'claude-code' : defaultAgent;

  const categoryToTool: Record<TaskCategory, RoutingTool> = {
    chat: defaultAgent,
    code: codeTool,
    research: 'gemini-cli',
    file_ops: 'termux',
    unknown: defaultAgent,
  };

  const categoryReasons: Record<TaskCategory, string> = {
    chat: `Responding via ${defaultLabel}`,
    code: hasClaude ? 'Code task — delegating to Claude Code' : `Code task — using ${defaultLabel}`,
    research: 'Research task — delegating to Gemini CLI',
    file_ops: 'File operation — executing directly',
    unknown: `Using ${defaultLabel}`,
  };

  const tool = categoryToTool[category];
  const reason = categoryReasons[category];

  return buildDecision(tool, reason, userInput, toolStatuses, true);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function formatRoutingMessage(decision: RoutingDecision): string {
  const toolLabels: Record<RoutingTool, string> = {
    'claude-code': 'Claude Code',
    'gemini-cli': 'Gemini CLI',
    'codex': 'Codex CLI',
    'groq': 'Groq',
    'local-llm': 'Local LLM',
    'termux': 'Terminal',
  };

  const label = toolLabels[decision.tool];

  if (decision.setupRequired && decision.setupMessage) {
    return decision.setupMessage;
  }

  return `Delegated to ${label}.\nReason: ${decision.reason}`; // Caller should use t('intent.delegated') if displaying to user
}
