/**
 * lib/parse-code-blocks.ts — AI応答テキストからコードブロックを検出・分割
 */

export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string };

/**
 * Strip reasoning-model `<think>...</think>` wrappers before parsing.
 * Some models (qwen reasoning, deepseek) emit think traces that would
 * otherwise hide the real response containing code fences.
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
}

/**
 * Fenced-code-block regex.
 *
 * Accepts optional whitespace between the opening fence and the language,
 * optional whitespace after the language, and either LF or CRLF line endings.
 * The closing fence is matched non-greedily on its own line or inline.
 */
const FENCE_RE = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const FENCE_TEST_RE = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n[\s\S]*?```/;

/**
 * マークダウンのfenced code blocks (```) を検出し、
 * テキスト部分とコードブロック部分に分割する。
 */
export function parseCodeBlocks(text: string): ContentSegment[] {
  const cleaned = stripThinkTags(text);
  const segments: ContentSegment[] = [];
  const regex = new RegExp(FENCE_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const textContent = cleaned.slice(lastIndex, match.index).trim();
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
    }
    const language = match[1] || undefined;
    const code = match[2].replace(/\s+$/, '');
    if (code) {
      segments.push({ type: 'code', content: code, language });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    const remaining = cleaned.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', content: remaining });
    }
  }

  return segments;
}

/**
 * テキストにfenced code blocksが含まれるかチェック。
 * `<think>` wrappers are stripped first so reasoning models don't hide
 * genuine code fences in the reply body.
 */
export function hasCodeBlocks(text: string): boolean {
  return FENCE_TEST_RE.test(stripThinkTags(text));
}
