/**
 * lib/parse-plan.ts — Plan Mode出力のパーサー
 *
 * Plan Mode 出力や、AI応答内の計画フォーマットを
 * 構造化データ (PlanMessage) にパースする。
 */

import { generateId } from '@/lib/id';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export type PlanStep = {
  id: string;
  number: number;
  title: string;
  substeps: string[];
  command?: string;       // コードブロック内のコマンド
  commandLang?: string;   // コードブロックの言語指定
  status: PlanStepStatus;
  output?: string;        // 実行結果
};

export type PlanMessage = {
  id: string;
  source: string;         // 'codex' | 'local' | 'assistant' etc
  title: string;
  steps: PlanStep[];
  createdAt: number;
};

// ─── Patterns ──────��────────────────────────────────────────────────────────

const PLAN_HEADER = /^##?\s*(Plan|計画|プラン|手順|Steps)\s*:?\s*$/im;
const STEP_LINE = /^(\d+)\.\s+(.+)$/;
const SUBSTEP_LINE = /^\s+[-*]\s+(.+)$/;
const CODE_BLOCK_START = /^```(\w*)$/;
const CODE_BLOCK_END = /^```$/;

// ─── Parser ─���───────────────────────────────���───────────────────────────────

export function parsePlanOutput(text: string, source?: string): PlanMessage | null {
  const lines = text.split('\n');
  const steps: PlanStep[] = [];
  let title = 'Plan';
  let currentStep: PlanStep | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code block boundaries
    if (!inCodeBlock && CODE_BLOCK_START.test(line)) {
      inCodeBlock = true;
      codeLang = line.match(CODE_BLOCK_START)?.[1] || '';
      codeLines = [];
      continue;
    }
    if (inCodeBlock && CODE_BLOCK_END.test(line.trim())) {
      inCodeBlock = false;
      if (currentStep && codeLines.length > 0) {
        currentStep.command = codeLines.join('\n');
        currentStep.commandLang = codeLang;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Plan header → extract title
    const headerMatch = line.match(PLAN_HEADER);
    if (headerMatch) {
      title = headerMatch[1];
      continue;
    }

    // Numbered step
    const stepMatch = line.match(STEP_LINE);
    if (stepMatch) {
      if (currentStep) steps.push(currentStep);
      currentStep = {
        id: generateId(),
        number: parseInt(stepMatch[1], 10),
        title: stepMatch[2].trim(),
        substeps: [],
        status: 'pending',
      };
      continue;
    }

    // Sub-step (indented bullet)
    const substepMatch = line.match(SUBSTEP_LINE);
    if (substepMatch && currentStep) {
      currentStep.substeps.push(substepMatch[1].trim());
      continue;
    }
  }

  // Push last step
  if (currentStep) steps.push(currentStep);

  if (steps.length < 2) return null;

  return {
    id: generateId(),
    source: source || 'unknown',
    title,
    steps,
    createdAt: Date.now(),
  };
}

/**
 * Plan Mode出力かどうかの判定。
 * "## Plan" 系ヘッダー + 2つ以上の番号付きステップ。
 */
export function isPlanOutput(text: string): boolean {
  if (!PLAN_HEADER.test(text)) return false;
  const stepMatches = text.match(/^\d+\.\s+.+$/gm);
  return (stepMatches?.length ?? 0) >= 2;
}
