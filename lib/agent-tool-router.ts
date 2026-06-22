/**
 * lib/agent-tool-router.ts — Selects the appropriate CLI/LLM for agent tasks.
 * When tool.type === 'auto', analyzes the prompt keywords and suggests.
 */
import { Agent, AgentRouteDecision, ToolChoice } from '@/store/types';
import { credentialClass } from './agent-credential-policy';
import { scanForSecrets } from './secret-guard';

export interface ToolSuggestion {
  tool: ToolChoice;
  label: string;
  reason: string;
  keyword?: string;
}

export interface AgentRouteResolution {
  tool: ToolChoice;
  decision: AgentRouteDecision;
}

const ACADEMIC_KEYWORDS = [
  'paper', 'research', 'study', 'evidence', 'journal', 'academic',
  '論文', '研究', '学術',
];

const CODE_KEYWORDS = [
  'pr', 'issue', 'commit', 'repo', 'code review', 'github',
  'pull request', 'merge',
];

const TRANSFORM_KEYWORDS = [
  'summarize', 'format', 'translate', 'rewrite',
  '要約', '整形', '翻訳', '書き直',
];

const ARTICLE_EVAL_KEYWORDS = [
  'qwen', 'qwen3', 'codex', 'a/b', 'ab test', 'article eval',
  '記事評価', '文章評価', '比較', '書き比べ',
];

export function suggestTool(prompt: string): ToolSuggestion {
  const lower = prompt.toLowerCase();

  // Priority 1: Qwen/Codex article drafting evaluation
  if (ARTICLE_EVAL_KEYWORDS.some((kw) => lower.includes(kw))) {
    const keyword = ARTICLE_EVAL_KEYWORDS.find((kw) => lower.includes(kw));
    return {
      tool: { type: 'ab-article-eval', localModel: 'Qwen3.5-2B-Q4_K_M', codexCmd: 'codex' },
      label: 'Qwen/Codex A/B Eval',
      reason: 'Article drafting comparison — runs local Qwen and Codex against the same source context',
      keyword,
    };
  }

  // Priority 2: Academic
  if (ACADEMIC_KEYWORDS.some((kw) => lower.includes(kw))) {
    const keyword = ACADEMIC_KEYWORDS.find((kw) => lower.includes(kw));
    return {
      tool: { type: 'perplexity', model: 'sonar-deep-research' },
      label: 'Perplexity API',
      reason: 'Academic/research content — Perplexity provides search-backed results with citations',
      keyword,
    };
  }

  // Priority 3: Code/GitHub
  if (CODE_KEYWORDS.some((kw) => lower.includes(kw))) {
    const keyword = CODE_KEYWORDS.find((kw) => lower.includes(kw));
    return {
      tool: { type: 'cli', cli: 'codex' },
      label: 'Codex CLI',
      reason: 'Code/GitHub tasks — Codex is the supported background CLI path',
      keyword,
    };
  }

  // Priority 4: Text transformation
  if (TRANSFORM_KEYWORDS.some((kw) => lower.includes(kw))) {
    const keyword = TRANSFORM_KEYWORDS.find((kw) => lower.includes(kw));
    return {
      tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' },
      label: 'Local LLM',
      reason: 'Text processing — local LLM is free and fast for transformation tasks',
      keyword,
    };
  }

  // Default: Gemini API. It keeps background agents on an API path without
  // reintroducing the removed Gemini CLI/OAuth surface.
  return {
    tool: { type: 'gemini-api' },
    label: 'Gemini API',
    reason: 'General-purpose — Gemini API uses Google AI Studio quota without relying on the removed CLI path',
  };
}

function textForSecretScan(agent: Agent): string {
  return [
    agent.name,
    agent.description,
    agent.prompt,
    agent.outputTemplate,
    agent.action?.webhookUrl,
    agent.action?.command,
  ].filter(Boolean).join('\n');
}

function routeForTool(tool: ToolChoice): AgentRouteDecision['route'] {
  if (tool.type === 'local') return 'on-device';
  if (tool.type === 'ab-article-eval') return 'hybrid';
  return 'cloud';
}

function cloudFallbackTool(agent: Agent): ToolChoice {
  if (credentialClass(agent.tool) === 'api-key' && agent.tool.type !== 'auto') {
    return agent.tool;
  }
  const suggested = suggestTool(agent.prompt);
  return credentialClass(suggested.tool) === 'api-key' ? suggested.tool : { type: 'gemini-api' };
}

function onDeviceFallbackTool(tool: ToolChoice): ToolChoice {
  if (tool.type === 'local') return tool;
  return { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' };
}

export function resolveAgentRoute(agent: Agent): AgentRouteResolution {
  const secret = scanForSecrets(textForSecretScan(agent));
  if (secret.hasSecret) {
    const tool = onDeviceFallbackTool(agent.tool);
    return {
      tool,
      decision: {
        route: 'on-device',
        toolType: tool.type,
        toolLabel: toolChoiceToLabel(tool),
        guard: 'secret',
        why: 'Secret guard matched task text; this run is forced to local/on-device and cloud fallback is disabled.',
        secretKinds: secret.kinds,
        noCloudFallback: true,
      },
    };
  }

  const runOn = agent.runOn ?? 'auto';
  if (runOn === 'on-device') {
    const tool = onDeviceFallbackTool(agent.tool);
    return {
      tool,
      decision: {
        route: 'on-device',
        toolType: tool.type,
        toolLabel: toolChoiceToLabel(tool),
        guard: 'manual-pin',
        why: 'Agent is manually pinned to on-device execution.',
      },
    };
  }

  if (runOn === 'cloud') {
    const tool = cloudFallbackTool(agent);
    return {
      tool,
      decision: {
        route: 'cloud',
        toolType: tool.type,
        toolLabel: toolChoiceToLabel(tool),
        guard: 'manual-pin',
        why: 'Agent is manually pinned to cloud execution.',
      },
    };
  }

  if (agent.autonomous && agent.tool.type === 'auto') {
    return {
      tool: agent.tool,
      decision: {
        route: 'cloud',
        toolType: agent.tool.type,
        toolLabel: toolChoiceToLabel(agent.tool),
        guard: 'autonomous-policy',
        why: 'Autonomous auto route resolves to the OAuth Codex driver path; API-key backends are refused.',
      },
    };
  }

  if (agent.tool.type === 'auto') {
    const suggested = suggestTool(agent.prompt);
    return {
      tool: suggested.tool,
      decision: {
        route: routeForTool(suggested.tool),
        toolType: suggested.tool.type,
        toolLabel: toolChoiceToLabel(suggested.tool),
        guard: suggested.keyword ? 'keyword' : 'default',
        keyword: suggested.keyword,
        why: suggested.reason,
      },
    };
  }

  return {
    tool: agent.tool,
    decision: {
      route: routeForTool(agent.tool),
      toolType: agent.tool.type,
      toolLabel: toolChoiceToLabel(agent.tool),
      guard: 'configured-tool',
      why: 'Agent uses its configured tool.',
    },
  };
}

/**
 * Check if a CLI tool is available in the system PATH.
 */
export async function checkToolAvailability(
  runCommand: (cmd: string) => Promise<string>
): Promise<Record<string, boolean>> {
  const tools = ['codex'];
  const results: Record<string, boolean> = {};

  for (const tool of tools) {
    try {
      const output = await runCommand(`which ${tool} 2>/dev/null && echo "found" || echo "notfound"`);
      results[tool] = output.trim().includes('found');
    } catch {
      results[tool] = false;
    }
  }

  // Check local LLM
  try {
    const output = await runCommand(
      [
        `(command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && echo found)`,
        `(command -v wget >/dev/null 2>&1 && wget -q -T 2 -O - http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && echo found)`,
        `(command -v toybox >/dev/null 2>&1 && printf 'GET /v1/models HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' | toybox nc -w 2 127.0.0.1 8080 2>/dev/null | grep -q 'HTTP/1\\.[01] 200' && echo found)`,
        `echo notfound`,
      ].join(' || ')
    );
    results['local'] = !output.includes('notfound');
  } catch {
    results['local'] = false;
  }

  return results;
}

export function toolChoiceToLabel(tool: ToolChoice): string {
  switch (tool.type) {
    case 'cli':
      return `${tool.cli.charAt(0).toUpperCase()}${tool.cli.slice(1)} CLI`;
    case 'gemini-api':
      return tool.model ? `Gemini API (${tool.model})` : 'Gemini API';
    case 'local':
      return 'Local LLM';
    case 'perplexity':
      return tool.model ? `Perplexity API (${tool.model})` : 'Perplexity API';
    case 'ab-article-eval':
      return `A/B Article Eval (${tool.localModel || 'local'} vs ${tool.codexCmd || 'codex'})`;
    case 'auto':
      return 'Auto';
  }
}
