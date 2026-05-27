/**
 * lib/agent-tool-router.ts — Selects the appropriate CLI/LLM for agent tasks.
 * When tool.type === 'auto', analyzes the prompt keywords and suggests.
 */
import { ToolChoice } from '@/store/types';

export interface ToolSuggestion {
  tool: ToolChoice;
  label: string;
  reason: string;
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
    return {
      tool: { type: 'ab-article-eval', localModel: 'Qwen3.5-4B-Q4_K_M', codexCmd: 'codex' },
      label: 'Qwen/Codex A/B Eval',
      reason: 'Article drafting comparison — runs local Qwen and Codex against the same source context',
    };
  }

  // Priority 2: Academic
  if (ACADEMIC_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      tool: { type: 'perplexity', model: 'sonar-deep-research' },
      label: 'Perplexity API',
      reason: 'Academic/research content — Perplexity provides search-backed results with citations',
    };
  }

  // Priority 3: Code/GitHub
  if (CODE_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      tool: { type: 'cli', cli: 'codex' },
      label: 'Codex CLI',
      reason: 'Code/GitHub tasks — Codex is the supported background CLI path',
    };
  }

  // Priority 4: Text transformation
  if (TRANSFORM_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      tool: { type: 'local' },
      label: 'Local LLM',
      reason: 'Text processing — local LLM is free and fast for transformation tasks',
    };
  }

  // Default: Gemini API (free Google AI Studio quota, no fragile TUI/PTY path)
  return {
    tool: { type: 'gemini-api' },
    label: 'Gemini API',
    reason: 'General-purpose — Gemini API uses the free Google quota without relying on the experimental CLI',
  };
}

/**
 * Check if a CLI tool is available in the system PATH.
 */
export async function checkToolAvailability(
  runCommand: (cmd: string) => Promise<string>
): Promise<Record<string, boolean>> {
  const tools = ['claude', 'gemini', 'codex'];
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
      'node -e "const http=require(\'http\'); const req=http.get(\'http://127.0.0.1:8080/health\', res=>{process.stdout.write(\'found\'); res.resume();}); req.setTimeout(2000,()=>req.destroy()); req.on(\'error\',()=>process.stdout.write(\'notfound\'));" 2>/dev/null || echo "notfound"'
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
