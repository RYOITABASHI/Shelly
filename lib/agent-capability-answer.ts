/**
 * lib/agent-capability-answer.ts — grounded capability-question answering
 * for the main AI Chat pane (2026-07-23).
 *
 * components/panes/AskPane.tsx already answers "can Shelly do X?" questions
 * grounded in the feature catalog (lib/ask-context.ts's buildAskSystemPrompt,
 * with the trailing [AVAILABLE]/[PLANNED]/[NOT_AVAILABLE] status-tag
 * convention) — but only via a hardcoded Groq call, and only from its own
 * separate pane. This module reuses the EXACT same prompt/status-tag
 * pattern (see AskPane.tsx's `ask()` for the reference implementation this
 * mirrors) but is callable from anywhere, so
 * hooks/use-ai-pane-dispatch.ts's @agent capability-question interception
 * (see lib/agent-llm-fallback.ts's isCapabilityQuestionForAgentFlow) can
 * answer a capability question typed into the main AI Chat pane with
 * whatever provider the user already has configured there — not just Groq.
 *
 * Provider order mirrors lib/llm-interpreter.ts's interpretWithFallback
 * (Cerebras/Groq-class fast cloud APIs before the on-device model) — the
 * project's established "fast general-purpose text task" tier ordering; the
 * local model is the fallback of last resort, same as everywhere else this
 * pattern appears in the codebase. Every branch fails closed (never throws)
 * so a broken/unconfigured provider is simply skipped in favor of the next
 * one, and `success: false` (never a thrown error) is returned when nothing
 * is configured or every attempt failed.
 */
import { buildAskSystemPrompt, extractStatus, stripStatusTag, type AskStatus } from './ask-context';
import type { LocalLlmConfig } from './local-llm';

export interface CapabilityAnswerConfig {
  groqApiKey?: string;
  groqModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  cerebrasApiKey?: string;
  cerebrasModel?: string;
  localLlmEnabled?: boolean;
  localLlmUrl?: string;
  localLlmModel?: string;
}

export interface CapabilityAnswerResult {
  success: boolean;
  /** Status tag stripped (see lib/ask-context.ts's stripStatusTag). Empty on failure. */
  text: string;
  status: AskStatus;
  provider?: 'groq' | 'gemini' | 'cerebras' | 'local';
  error?: string;
}

function finalize(raw: string, provider: CapabilityAnswerResult['provider']): CapabilityAnswerResult {
  return {
    success: true,
    text: stripStatusTag(raw),
    status: extractStatus(raw),
    provider,
  };
}

/**
 * Answers a capability question using lib/ask-context.ts's grounded system
 * prompt, trying each configured provider in turn until one succeeds.
 * `onChunk` (optional) receives each incremental text DELTA as it streams in
 * (not the accumulated total) — same convention as groqChatStream/
 * geminiChatStream/cerebrasChatStream's own onChunk, and as the local
 * (non-streaming) branch's single one-shot "delta" of the full response —
 * so callers can accumulate however suits their UI (see
 * hooks/use-ai-pane-dispatch.ts's usage for the reference accumulation
 * pattern already used by its `@team` roundtable feature).
 */
export async function answerCapabilityQuestion(
  question: string,
  config: CapabilityAnswerConfig,
  onChunk?: (delta: string) => void,
): Promise<CapabilityAnswerResult> {
  const system = buildAskSystemPrompt();

  if (config.groqApiKey) {
    let acc = '';
    try {
      const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('./groq');
      const result = await groqChatStream(
        config.groqApiKey,
        question,
        (text) => { if (text) { acc += text; onChunk?.(text); } },
        config.groqModel ?? GROQ_DEFAULT_MODEL,
        [],
        undefined,
        system,
      );
      if (result.success && acc.trim()) return finalize(acc, 'groq');
    } catch {
      // fall through to the next provider
    }
  }

  if (config.geminiApiKey) {
    let acc = '';
    try {
      const { geminiChatStream, GEMINI_DEFAULT_MODEL } = await import('./gemini');
      const result = await geminiChatStream(
        config.geminiApiKey,
        question,
        (text) => { if (text) { acc += text; onChunk?.(text); } },
        config.geminiModel ?? GEMINI_DEFAULT_MODEL,
        [],
        undefined,
        system,
      );
      if (result.success && acc.trim()) return finalize(acc, 'gemini');
    } catch {
      // fall through to the next provider
    }
  }

  if (config.cerebrasApiKey) {
    let acc = '';
    try {
      const { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } = await import('./cerebras');
      const result = await cerebrasChatStream(
        config.cerebrasApiKey,
        question,
        (text) => { if (text) { acc += text; onChunk?.(text); } },
        config.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
        [],
        undefined,
        system,
      );
      if (result.success && acc.trim()) return finalize(acc, 'cerebras');
    } catch {
      // fall through to the local model
    }
  }

  if (config.localLlmEnabled && config.localLlmUrl && config.localLlmModel) {
    try {
      const { ollamaChat } = await import('./local-llm');
      const localConfig: LocalLlmConfig = {
        baseUrl: config.localLlmUrl,
        model: config.localLlmModel,
        enabled: true,
      };
      const result = await ollamaChat(
        localConfig,
        [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        20_000,
        undefined,
        600,
      );
      if (result.success && result.content?.trim()) {
        onChunk?.(result.content);
        return finalize(result.content, 'local');
      }
    } catch {
      // fall through to the final failure result
    }
  }

  return {
    success: false,
    text: '',
    status: null,
    error: 'No AI provider is configured to answer this question.',
  };
}
