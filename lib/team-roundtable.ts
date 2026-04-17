/**
 * lib/team-roundtable.ts — v1.0
 *
 * @team Table — 複数AIエージェント合議機能
 *
 * 複数AIエージェント（Claude/Gemini/Codex CLI + Perplexity API + Local LLM）に
 * 同じプロンプトを並列投げし、ファシリテーターAIが統合サマリーを生成する。
 *
 * 設計方針:
 * - CLI経由（Claude/Gemini/Codex）: サブスクリプション活用、追加課金なし
 * - API経由（Perplexity/Gemini API）: 最新情報・ソース担保
 * - Local LLM: ファシリ優先候補、オフライン動作
 * - ファシリ自動選択: Local LLM → Claude → Gemini → Codex → Perplexity
 * - 各回答が返ってきた順にコールバックで通知（ストリーミング的UI）
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeamMemberId =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'perplexity'
  | 'local'
  | 'cerebras'
  | 'groq';

export interface TeamMemberConfig {
  id: TeamMemberId;
  label: string;
  color: string;
  emoji: string;
  /** CLI コマンド名 or 'api' */
  mode: 'cli' | 'api' | 'local';
  /** 設定でON/OFFされているか */
  enabled: boolean;
}

export interface TeamMemberResult {
  memberId: TeamMemberId;
  label: string;
  color: string;
  emoji: string;
  response: string;
  error?: string;
  durationMs: number;
  isFacilitator?: boolean;
}

export interface TeamRoundtableResult {
  prompt: string;
  members: TeamMemberResult[];
  facilitator: TeamMemberResult | null;
  facilitatorSummary: string;
  totalDurationMs: number;
}

export interface TeamSettings {
  /** 参加メンバーのON/OFF */
  claudeEnabled: boolean;
  geminiEnabled: boolean;
  codexEnabled: boolean;
  perplexityEnabled: boolean;
  localEnabled: boolean;
  cerebrasEnabled: boolean;
  groqEnabled: boolean;
  /** ファシリテーター優先順位（配列の先頭が最優先） */
  facilitatorPriority: TeamMemberId[];
  /** Codex CLIのコマンド名（デフォルト: 'codex'） */
  codexCmd: string;
  /** Claude CLIのコマンド名（デフォルト: 'claude'） */
  claudeCmd: string;
  /** Gemini CLIのコマンド名（デフォルト: 'gemini'） */
  geminiCmd: string;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  claudeEnabled: true,
  geminiEnabled: true,
  codexEnabled: false,
  perplexityEnabled: true,
  localEnabled: true,
  cerebrasEnabled: true,
  groqEnabled: true,
  // Facilitator picks: Cerebras is both fast and smart (Qwen3-235B) so
  // it sits near the top; groq is a fine secondary reasoner. Local LLM
  // only wins when nothing cloud-side is configured.
  facilitatorPriority: ['cerebras', 'groq', 'claude', 'gemini', 'codex', 'perplexity', 'local'],
  codexCmd: 'codex',
  claudeCmd: 'claude',
  geminiCmd: 'gemini',
};

export type TeamMemberCallback = (result: TeamMemberResult) => void;
export type FacilitatorStartCallback = () => void;
export type FacilitatorChunkCallback = (chunk: string) => void;

// ─── Member definitions ───────────────────────────────────────────────────────

export function buildTeamMembers(settings: TeamSettings): TeamMemberConfig[] {
  return [
    {
      id: 'claude',
      label: 'Claude',
      color: '#F59E0B',
      emoji: '🟡',
      mode: 'cli',
      enabled: settings.claudeEnabled,
    },
    {
      id: 'gemini',
      label: 'Gemini',
      color: '#3B82F6',
      emoji: '🔵',
      mode: 'cli',
      enabled: settings.geminiEnabled,
    },
    {
      id: 'codex',
      label: 'Codex',
      color: '#10B981',
      emoji: '🟢',
      mode: 'cli',
      enabled: settings.codexEnabled,
    },
    {
      id: 'perplexity',
      label: 'Perplexity',
      color: '#20B2AA',
      emoji: '🔷',
      mode: 'api',
      enabled: settings.perplexityEnabled,
    },
    {
      id: 'local',
      label: 'Local LLM',
      color: '#8B5CF6',
      emoji: '⚪',
      mode: 'local',
      enabled: settings.localEnabled,
    },
    {
      id: 'cerebras',
      label: 'Cerebras (Qwen3)',
      color: '#F97316',
      emoji: '🧠',
      mode: 'api',
      enabled: settings.cerebrasEnabled,
    },
    {
      id: 'groq',
      label: 'Groq (Llama3)',
      color: '#EF4444',
      emoji: '⚡',
      mode: 'api',
      enabled: settings.groqEnabled,
    },
  ];
}

// ─── Facilitator selection ────────────────────────────────────────────────────

/**
 * ファシリテーターを自動選択する。
 * 優先順位リストの先頭から、有効なメンバーを選ぶ。
 */
export function selectFacilitator(
  members: TeamMemberConfig[],
  priority: TeamMemberId[],
): TeamMemberConfig | null {
  const enabledIds = new Set(members.filter((m) => m.enabled).map((m) => m.id));
  for (const id of priority) {
    if (enabledIds.has(id)) {
      return members.find((m) => m.id === id) ?? null;
    }
  }
  return null;
}

// ─── Individual member runner ─────────────────────────────────────────────────

/**
 * 単一メンバーにプロンプトを投げて回答を取得する。
 * CLI経由またはAPI経由。
 */
export async function runTeamMember(
  member: TeamMemberConfig,
  prompt: string,
  opts: {
    runCommand: (cmd: string) => Promise<string>;
    perplexityApiKey?: string;
    perplexityModel?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    localLlmUrl?: string;
    localLlmModel?: string;
    cerebrasApiKey?: string;
    cerebrasModel?: string;
    groqApiKey?: string;
    groqModel?: string;
    teamSettings: TeamSettings;
  },
): Promise<TeamMemberResult> {
  const start = Date.now();

  try {
    let response = '';

    if (member.mode === 'cli') {
      // CLI経由: claude/gemini/codex コマンドを実行
      const cmdMap: Record<string, string> = {
        claude: opts.teamSettings.claudeCmd,
        gemini: opts.teamSettings.geminiCmd,
        codex: opts.teamSettings.codexCmd,
      };
      const cmd = cmdMap[member.id] ?? member.id;
      // プロンプトをシングルクォートでエスケープ
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const fullCmd = `${cmd} -p '${escapedPrompt}' 2>&1 | head -200`;
      response = await opts.runCommand(fullCmd);
    } else if (member.id === 'perplexity') {
      // Perplexity API経由
      if (!opts.perplexityApiKey) {
        throw new Error('Perplexity APIキーが設定されていません');
      }
      const { perplexitySearchStream } = await import('@/lib/perplexity');
      let pplxAccumulated = '';
      await perplexitySearchStream(
        opts.perplexityApiKey,
        prompt,
        (chunk: string) => { pplxAccumulated += chunk; },
        opts.perplexityModel ?? 'sonar-reasoning-pro',
      );
      response = pplxAccumulated;
    } else if (member.id === 'local') {
      // Local LLM (Ollama/llama-server)
      const { orchestrateChatStream } = await import('@/lib/local-llm');
      let accumulated = '';
      await orchestrateChatStream(
        prompt,
        {
          baseUrl: opts.localLlmUrl ?? 'http://127.0.0.1:11434',
          model: opts.localLlmModel ?? 'llama3.2:3b',
          enabled: true,
        },
        (chunk: string, _done: boolean) => { accumulated += chunk; },
      );
      response = accumulated;
    } else if (member.id === 'cerebras') {
      if (!opts.cerebrasApiKey) throw new Error('Cerebras APIキーが設定されていません');
      const { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } = await import('@/lib/cerebras');
      let accumulated = '';
      const result = await cerebrasChatStream(
        opts.cerebrasApiKey,
        prompt,
        (text) => { accumulated += text; },
        opts.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
      );
      if (!result.success && result.error) throw new Error(result.error);
      response = accumulated;
    } else if (member.id === 'groq') {
      if (!opts.groqApiKey) throw new Error('Groq APIキーが設定されていません');
      const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('@/lib/groq');
      let accumulated = '';
      const result = await groqChatStream(
        opts.groqApiKey,
        prompt,
        (text) => { accumulated += text; },
        opts.groqModel ?? GROQ_DEFAULT_MODEL,
      );
      if (!result.success && result.error) throw new Error(result.error);
      response = accumulated;
    }

    return {
      memberId: member.id,
      label: member.label,
      color: member.color,
      emoji: member.emoji,
      response: response.trim() || '（応答なし）',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      memberId: member.id,
      label: member.label,
      color: member.color,
      emoji: member.emoji,
      response: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ─── Facilitator summary ──────────────────────────────────────────────────────

/**
 * ファシリテーターが各メンバーの回答を受け取り、統合サマリーを生成する。
 */
export async function runFacilitatorSummary(
  facilitator: TeamMemberConfig,
  originalPrompt: string,
  memberResults: TeamMemberResult[],
  opts: {
    runCommand: (cmd: string) => Promise<string>;
    perplexityApiKey?: string;
    perplexityModel?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    localLlmUrl?: string;
    localLlmModel?: string;
    cerebrasApiKey?: string;
    cerebrasModel?: string;
    groqApiKey?: string;
    groqModel?: string;
    teamSettings: TeamSettings;
    onChunk?: FacilitatorChunkCallback;
  },
): Promise<string> {
  // 各メンバーの回答をまとめたファシリプロンプトを構築
  const memberSummaries = memberResults
    .filter((r) => r.memberId !== facilitator.id)
    .map((r) => {
      if (r.error) {
        return `【${r.label}】エラー: ${r.error}`;
      }
      return `【${r.label}】\n${r.response.slice(0, 1500)}`;
    })
    .join('\n\n---\n\n');

  const { getCurrentLocale } = await import('@/lib/i18n');
  const isJa = getCurrentLocale() === 'ja';

  const facilitatorPrompt = isJa
    ? `あなたはAIエージェントたちの議論をまとめるファシリテーターです。

元の質問:
${originalPrompt}

各エージェントの回答:
${memberSummaries}

上記の回答を踏まえて、以下の形式で統合サマリーを作成してください:
1. 各エージェントの主要な主張・観点を1〜2文で要約
2. 共通している点・合意事項
3. 意見が分かれている点
4. あなた自身の総合的な見解と推奨事項

日本語で回答してください。`
    : `You are a facilitator summarizing a discussion between AI agents.

Original question:
${originalPrompt}

Agent responses:
${memberSummaries}

Based on the above, create an integrated summary in this format:
1. Summarize each agent's key points in 1-2 sentences
2. Points of agreement
3. Points of disagreement
4. Your overall assessment and recommendation

Reply in English.`;

  try {
    if (facilitator.mode === 'local') {
      const { orchestrateChatStream } = await import('@/lib/local-llm');
      let accumulated = '';
      await orchestrateChatStream(
        facilitatorPrompt,
        {
          baseUrl: opts.localLlmUrl ?? 'http://127.0.0.1:11434',
          model: opts.localLlmModel ?? 'llama3.2:3b',
          enabled: true,
        },
        (chunk: string, _done: boolean) => {
          accumulated += chunk;
          opts.onChunk?.(chunk);
        },
      );
      return accumulated;
    } else if (facilitator.mode === 'cli') {
      const cmdMap: Record<string, string> = {
        claude: opts.teamSettings.claudeCmd,
        gemini: opts.teamSettings.geminiCmd,
        codex: opts.teamSettings.codexCmd,
      };
      const cmd = cmdMap[facilitator.id] ?? facilitator.id;
      const escapedPrompt = facilitatorPrompt.replace(/'/g, "'\\''");
      const fullCmd = `${cmd} -p '${escapedPrompt}' 2>&1 | head -300`;
      const result = await opts.runCommand(fullCmd);
      opts.onChunk?.(result);
      return result;
    } else if (facilitator.id === 'perplexity') {
      if (!opts.perplexityApiKey) throw new Error('Perplexity APIキーなし');
      const { perplexitySearchStream } = await import('@/lib/perplexity');
      let pplxFacili = '';
      await perplexitySearchStream(
        opts.perplexityApiKey,
        facilitatorPrompt,
        (chunk: string) => { pplxFacili += chunk; opts.onChunk?.(chunk); },
        opts.perplexityModel ?? 'sonar-reasoning-pro',
      );
      return pplxFacili;
    } else if (facilitator.id === 'cerebras') {
      if (!opts.cerebrasApiKey) throw new Error('Cerebras APIキーなし');
      const { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } = await import('@/lib/cerebras');
      let cerebrasFacili = '';
      await cerebrasChatStream(
        opts.cerebrasApiKey,
        facilitatorPrompt,
        (text) => { cerebrasFacili += text; opts.onChunk?.(text); },
        opts.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
      );
      return cerebrasFacili;
    } else if (facilitator.id === 'groq') {
      if (!opts.groqApiKey) throw new Error('Groq APIキーなし');
      const { groqChatStream, GROQ_DEFAULT_MODEL } = await import('@/lib/groq');
      let groqFacili = '';
      await groqChatStream(
        opts.groqApiKey,
        facilitatorPrompt,
        (text) => { groqFacili += text; opts.onChunk?.(text); },
        opts.groqModel ?? GROQ_DEFAULT_MODEL,
      );
      return groqFacili;
    }
  } catch (err) {
    const msg = `ファシリテーターエラー: ${err instanceof Error ? err.message : String(err)}`;
    opts.onChunk?.(msg);
    return msg;
  }

  return '（ファシリテーター応答なし）';
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * @team Table のメインオーケストレーター。
 *
 * 1. 有効なメンバーを並列実行
 * 2. 各回答が返ってきたらコールバックで通知
 * 3. 全員揃ったらファシリテーターが統合サマリーを生成
 */
export async function runTeamRoundtable(
  prompt: string,
  settings: TeamSettings,
  opts: {
    runCommand: (cmd: string) => Promise<string>;
    perplexityApiKey?: string;
    perplexityModel?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    localLlmUrl?: string;
    localLlmModel?: string;
    cerebrasApiKey?: string;
    cerebrasModel?: string;
    groqApiKey?: string;
    groqModel?: string;
    onMemberResult?: TeamMemberCallback;
    onFacilitatorStart?: FacilitatorStartCallback;
    onFacilitatorChunk?: FacilitatorChunkCallback;
  },
): Promise<TeamRoundtableResult> {
  const totalStart = Date.now();
  const allMembers = buildTeamMembers(settings);
  const enabledMembers = allMembers.filter((m) => m.enabled);

  if (enabledMembers.length === 0) {
    return {
      prompt,
      members: [],
      facilitator: null,
      facilitatorSummary: '@teamメンバーが設定されていません。設定画面でメンバーを有効にしてください。',
      totalDurationMs: Date.now() - totalStart,
    };
  }

  // ファシリテーターを選択
  const facilitator = selectFacilitator(enabledMembers, settings.facilitatorPriority);

  // ファシリテーター以外のメンバーを並列実行
  // ※ファシリテーターも参加者として回答する（ただし最後にサマリーを追加）
  const participantPromises = enabledMembers.map((member) =>
    runTeamMember(member, prompt, {
      runCommand: opts.runCommand,
      perplexityApiKey: opts.perplexityApiKey,
      perplexityModel: opts.perplexityModel,
      geminiApiKey: opts.geminiApiKey,
      geminiModel: opts.geminiModel,
      localLlmUrl: opts.localLlmUrl,
      localLlmModel: opts.localLlmModel,
      cerebrasApiKey: opts.cerebrasApiKey,
      cerebrasModel: opts.cerebrasModel,
      groqApiKey: opts.groqApiKey,
      groqModel: opts.groqModel,
      teamSettings: settings,
    }).then((result) => {
      // 回答が返ってきたらコールバックで即通知
      opts.onMemberResult?.(result);
      return result;
    }),
  );

  const memberResults = await Promise.all(participantPromises);

  // ファシリテーターサマリー生成
  let facilitatorSummary = '';
  let facilitatorResult: TeamMemberResult | null = null;

  if (facilitator && memberResults.length > 1) {
    opts.onFacilitatorStart?.();
    facilitatorSummary = await runFacilitatorSummary(
      facilitator,
      prompt,
      memberResults,
      {
        runCommand: opts.runCommand,
        perplexityApiKey: opts.perplexityApiKey,
        perplexityModel: opts.perplexityModel,
        geminiApiKey: opts.geminiApiKey,
        geminiModel: opts.geminiModel,
        localLlmUrl: opts.localLlmUrl,
        localLlmModel: opts.localLlmModel,
        cerebrasApiKey: opts.cerebrasApiKey,
        cerebrasModel: opts.cerebrasModel,
        groqApiKey: opts.groqApiKey,
        groqModel: opts.groqModel,
        teamSettings: settings,
        onChunk: opts.onFacilitatorChunk,
      },
    );
    facilitatorResult = {
      memberId: facilitator.id,
      label: `${facilitator.label}（ファシリ）`,
      color: facilitator.color,
      emoji: '🎙️',
      response: facilitatorSummary,
      durationMs: 0,
      isFacilitator: true,
    };
  } else if (memberResults.length === 1) {
    facilitatorSummary = memberResults[0].response;
  }

  return {
    prompt,
    members: memberResults,
    facilitator: facilitatorResult,
    facilitatorSummary,
    totalDurationMs: Date.now() - totalStart,
  };
}
