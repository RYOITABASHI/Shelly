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
 *   chat: groq (if key set) > local-llm
 *   code: codex
 */

import type { ToolStatus } from './shelly-system-prompt';
import type { LocalLlmConfig, OllamaMessage, TaskCategory } from './local-llm';
import { ollamaChat, classifyTask } from './local-llm';
import type { ToolId } from './env-manager';
import { getToolById } from './env-manager';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoutingTool = 'codex' | 'local-llm' | 'groq';

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
      id: 'codex',
      name: 'Codex CLI',
      strengths: 'Code generation, file editing, project creation, bug fixing, refactoring, git operations, and quick modifications.',
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
5. Simple file operations (ls, mkdir etc.) can be delegated to any available CLI
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
  defaultAgent?: 'codex',
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
    const validTools: RoutingTool[] = ['codex', 'local-llm', 'groq'];
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

  const toolIdMap: Partial<Record<RoutingTool, ToolId>> = {};

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
 *   codex (if installed) > local-llm
 *
 * - chat → default backend
 * - code → codex
 * - research → default supported backend
 * - file_ops → codex
 * - unknown → default supported backend
 */
function fallbackRoute(
  userInput: string,
  toolStatuses: ToolStatus[],
  explicitDefault?: RoutingTool,
  options?: { groqApiKey?: string },
): RoutingDecision {
  const input = userInput.toLowerCase();
  const category = classifyTask(userInput);

  // Determine best available CLI based on installed tools
  const hasCodex = toolStatuses.some((s) => s.id === 'codex' && s.installed);
  const hasGroqKey = !!(options?.groqApiKey && options.groqApiKey.trim().length > 0);

  // Default agent priority: explicit > codex > groq > local-llm.
  const defaultAgent: RoutingTool = explicitDefault
    ?? (hasCodex ? 'codex' : hasGroqKey ? 'groq' : 'local-llm');

  const defaultLabel = defaultAgent === 'codex' ? 'Codex CLI'
    : defaultAgent === 'local-llm' ? 'Local LLM'
    : 'Groq';

  const codeTool: RoutingTool = hasCodex ? 'codex' : defaultAgent;

  const categoryToTool: Record<TaskCategory, RoutingTool> = {
    chat: defaultAgent,
    code: codeTool,
    research: defaultAgent,
    file_ops: defaultAgent,
    unknown: defaultAgent,
  };

  const categoryReasons: Record<TaskCategory, string> = {
    chat: `Responding via ${defaultLabel}`,
    code: `Code task — using ${codeTool === 'codex' ? 'Codex CLI' : defaultLabel}`,
    research: `Research task — using ${defaultLabel}`,
    file_ops: `File operation — using ${defaultLabel}`,
    unknown: `Using ${defaultLabel}`,
  };

  const tool = categoryToTool[category];
  const reason = categoryReasons[category];

  return buildDecision(tool, reason, userInput, toolStatuses, true);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function formatRoutingMessage(decision: RoutingDecision): string {
  const toolLabels: Record<RoutingTool, string> = {
    'codex': 'Codex CLI',
    'groq': 'Groq',
    'local-llm': 'Local LLM',
  };

  const label = toolLabels[decision.tool];

  if (decision.setupRequired && decision.setupMessage) {
    return decision.setupMessage;
  }

  return `Delegated to ${label}.\nReason: ${decision.reason}`; // Caller should use t('intent.delegated') if displaying to user
}
