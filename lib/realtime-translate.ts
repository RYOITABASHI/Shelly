/**
 * lib/realtime-translate.ts — CLI出力のリアルタイム翻訳・解説
 *
 * LLMフォールバックチェーン:
 * 1. Cerebras API（高速推論）
 * 2. Groq API
 * 3. ローカルLLM
 *
 * 承認プロンプト検出（Phase 5-2）も含む。
 */

import { useTerminalStore } from '@/store/terminal-store';

// ─── 承認プロンプト検出 (5-2) ────────────────────────────────────────────────

const CLI_APPROVAL_PATTERNS = [
  /Allow.*\?\s*\(Y\/n\)/i,
  /Do you want to (proceed|continue)\?/i,
  /Confirm.*\(y\/N\)/i,
  /Press (y|enter) to continue/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
];

export function detectApprovalPrompt(text: string): boolean {
  return CLI_APPROVAL_PATTERNS.some((p) => p.test(text));
}

// ─── セキュリティ出力検出 (Tier 1) ──────────────────────────────────────────

const SECURITY_OUTPUT_PATTERNS = [
  /CVE-\d{4}-\d+/,
  /\b(vulnerability|exploit|injection|XSS|CSRF|SQL injection)\b/i,
  /\b(critical|high|medium|low)\s+severity\b/i,
  /\bnpm audit\b/,
  /\bsecurity advisory\b/i,
];

export function detectSecurityOutput(text: string): boolean {
  return SECURITY_OUTPUT_PATTERNS.some((p) => p.test(text));
}

// ─── 翻訳リクエスト ─────────────────────────────────────────────────────────

export type TranslateResult = {
  translated: string;
  provider: string;
  isApprovalAlert?: boolean;
};

/**
 * LLMフォールバックチェーンでCLI出力を翻訳・解説する。
 * 利用可能なプロバイダーを順番に試す。
 */
export async function translateTerminalOutput(
  text: string,
  contextLines: string[],
  signal?: AbortSignal,
): Promise<TranslateResult | null> {
  const settings = useTerminalStore.getState().settings;

  const isApproval = detectApprovalPrompt(text);
  const isSecurity = detectSecurityOutput(text);
  const systemPrompt = isApproval
    ? '以下はCLIツールの承認プロンプトです。何をしようとしているか、リスクは何かを日本語で簡潔に説明してください。'
    : isSecurity
    ? 'セキュリティレポートを非エンジニア向けに翻訳してください。CVE番号や専門用語は使わず、絵文字で深刻度を示してください（🔴重大 🟠高 🟡中 🟢低）。何が危険かを平易な日本語で1-3文で。修正可能なら末尾に「[修正する]」を付けてください。'
    : 'ターミナル出力を日本語で簡潔に説明してください。専門用語は噛み砕いて。1-2文で。';

  const fullPrompt = contextLines.length > 0
    ? `${systemPrompt}\n\nContext:\n${contextLines.join('\n')}\n\nCurrent output:\n${text}`
    : `${systemPrompt}\n\n${text}`;

  // 1. Cerebras
  if (settings.cerebrasApiKey) {
    try {
      const { cerebrasChatStream } = await import('@/lib/cerebras');
      let result = '';
      const res = await cerebrasChatStream(
        settings.cerebrasApiKey, fullPrompt,
        (chunk: string, done: boolean) => { if (chunk) result += chunk; },
        undefined, undefined, signal,
      );
      if (res.success && result) {
        return { translated: result, provider: 'Cerebras', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  // 2. Groq
  if (settings.groqApiKey) {
    try {
      const { groqChatStream } = await import('@/lib/groq');
      let result = '';
      const res = await groqChatStream(
        settings.groqApiKey, fullPrompt,
        (chunk: string, done: boolean) => { if (chunk) result += chunk; },
        undefined, undefined, signal,
      );
      if (res.success && result) {
        return { translated: result, provider: 'Groq', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  // 3. ローカルLLM
  if (settings.localLlmEnabled) {
    try {
      const { ollamaChatStream } = await import('@/lib/local-llm');
      let result = '';
      await ollamaChatStream(
        { baseUrl: settings.localLlmUrl, model: settings.localLlmModel, enabled: true },
        [{ role: 'user' as const, content: fullPrompt }],
        (chunk: string) => { if (chunk) result += chunk; },
        undefined,
        signal,
      );
      if (result) {
        return { translated: result, provider: 'Local LLM', isApprovalAlert: isApproval };
      }
    } catch {}
  }

  return null;
}
