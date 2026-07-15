// Shared TypeScript types for Shelly terminal app

// ─── Connection ───────────────────────────────────────────────────────────────

/** Legacy field kept on TabSession for backward compat */
export type ConnectionStatus = 'local' | 'ssh' | 'disconnected';

/**
 * Active execution mode for the terminal.
 * - 'native'      : JNI forkpty + linker64 (Plan B, no Termux needed)
 * - 'disconnected': session not yet started
 */
export type ConnectionMode = 'native' | 'disconnected';

// ─── Output / Blocks ─────────────────────────────────────────────────────────

export type OutputLine = {
  text: string;
  type: 'stdout' | 'stderr' | 'info' | 'prompt';
};

/**
 * Fine-grained execution state for a command block.
 * - 'running'    : command is executing
 * - 'cancelling' : SIGINT sent, waiting for process to exit
 * - 'cancelled'  : process exited due to cancel (exitCode 130)
 * - 'done'       : process exited normally
 * - 'error'      : process exited with error or WS error
 */
export type BlockStatus = 'running' | 'cancelling' | 'cancelled' | 'done' | 'error';

export type CommandBlock = {
  id: string;
  sessionId: string;
  command: string;
  output: OutputLine[];
  timestamp: number;
  exitCode: number | null;
  isRunning: boolean;
  /** Fine-grained status (superset of isRunning) */
  blockStatus?: BlockStatus;
  isSavedSnippet?: boolean;
  /** Which mode was active when this block was created (always 'native') */
  connectionMode?: 'native';
  // ─── LLM通訳フィールド ─────────────────────────────────────────────────────
  /** Local LLMによる自然言語通訳テキスト（完了後に表示） */
  llmInterpretation?: string;
  /** ストリーミング中の通訳テキスト */
  llmInterpretationStreaming?: string;
  /** 通訳処理中フラグ */
  isInterpreting?: boolean;
  /** LLMが提案する修正コマンド（エラー時） */
  llmSuggestedCommand?: string;
  /** 通訳のタイプ */
  interpretType?: 'progress' | 'error' | 'success';
};

// ─── AI Block ────────────────────────────────────────────────────────────────

/**
 * AI処理の結果を表示するブロック。
 * CommandBlockと区別するためにblockType: 'ai'を持つ。
 *
 * 学習促進型ログ設計:
 * - logSummary: 1行サマリー（常時表示・薄い色）
 * - routingDetail: 詳細（タップで展開）
 * - mentionHint: @mention学習ヒント（3回表示後に消える）
 * - toolSuggestions: ツール提案カード（layer='natural'の場合）
 */
export type AiBlock = {
  id: string;
  sessionId: string;
  blockType: 'ai';
  /** 元のユーザー入力 */
  input: string;
  /** ルーティング先 */
  target: 'local' | 'shell' | 'suggest' | 'gemini' | 'perplexity' | 'groq' | 'cerebras' | 'team' | 'browser' | 'git' | 'agent' | 'codex' | 'plan' | 'arena' | 'actions';
  /** 入力レイヤー */
  layer: 'mention' | 'nl_with_tool' | 'natural' | 'command';
  /** 1行サマリー（常時表示） */
  logSummary: string;
  /** 詳細テキスト（タップで展開） */
  routingDetail?: string;
  /** AI応答テキスト（Local LLMが直接回答した場合） */
  response?: string;
  /** ツール提案リスト（layer='natural'の場合） */
  toolSuggestions?: Array<{
    target: 'local' | 'gemini' | 'perplexity' | 'groq' | 'cerebras' | 'team' | 'codex';
    label: string;
    reason: string;
    mentionExample: string;
    confidence: number;
  }>;
  /** @mention学習ヒント */
  mentionHint?: {
    key: string;
    text: string;
    example: string;
  };
  /** ヒントを表示するかどうか（shouldShowHintの結果） */
  showHint: boolean;
  timestamp: number;
  isStreaming?: boolean;
  /** ストリーミング中の累積テキスト */
  streamingText?: string;
  /** 生成済みトークン数 */
  tokenCount?: number;
  /** ストリーミング開始時刻 (Date.now()) */
  streamingStartTime?: number;
  /** Perplexity引用リスト */
  citations?: Array<{ url: string; title?: string }>;
  /** エラー時のメッセージ */
  error?: string;
  /** ローカルLLM応答時のモデル名+ポート (例: "gemma-3-4b-it (:8080)") */
  llmModelLabel?: string;
};

// ─── Setup Block ────────────────────────────────────────────────────────────

export type SetupStepId = 'welcome' | 'cli-select' | 'cli-install' | 'cli-auth' | 'git-config' | 'git-input' | 'git-ssh' | 'project-scan' | 'done';

export type SetupOption = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  badge?: string;
  selected?: boolean;
};

export type SetupBlock = {
  id: string;
  sessionId: string;
  blockType: 'setup';
  stepId: SetupStepId;
  title: string;
  description?: string;
  /** Tappable options (buttons/checkboxes) */
  options?: SetupOption[];
  /** Whether multiple options can be selected */
  multiSelect?: boolean;
  /** Text input fields */
  inputs?: Array<{
    key: string;
    label: string;
    placeholder?: string;
    value?: string;
  }>;
  /** Log lines (install progress, etc.) */
  logLines?: string[];
  /** Step status */
  status: 'active' | 'completed' | 'skipped' | 'error';
  /** Error message */
  errorMessage?: string;
  /** Show skip button */
  skippable: boolean;
  /** Show back button */
  showBack?: boolean;
  /** Primary action label override */
  actionLabel?: string;
  timestamp: number;
};

/** ターミナルに表示するブロックの共用型 */
export type TerminalEntry = CommandBlock | AiBlock | SetupBlock;

// ─── Sessions ─────────────────────────────────────────────────────────────────

export type SessionStatus = 'starting' | 'alive' | 'exited' | 'recovering';

export type TabSession = {
  id: string;
  name: string;
  currentDir: string;
  blocks: CommandBlock[];
  /** AI応答ブロック（CommandBlockと混在して表示） */
  entries: TerminalEntry[];
  commandHistory: string[];
  historyIndex: number;
  /** 現在実行中のCLI（復帰用） */
  activeCli: 'codex' | 'cody' | null;
  /** 対応するtmuxセッション名 */
  tmuxSession: string;
  /** Native terminal session identifier */
  nativeSessionId: string;
  /** Session lifecycle status */
  sessionStatus: SessionStatus;
  /** Whether the session process is alive */
  isAlive: boolean;
  /**
   * Transcript snapshot captured on save. Replayed into the emulator on next
   * launch so users can scroll back through what they saw last time (bug #65
   * / "Immortal Sessions" — Case C pseudo-immortal). This is visual-only —
   * the underlying shell (cwd, running vim/agent CLI, env) is not restored.
   */
  transcriptSnapshot?: string;
};

// ─── Snippets ─────────────────────────────────────────────────────────────────

/**
 * Scope of a snippet:
 * - 'global'  : available in all sessions
 * - 'session' : only in the session it was created in
 */
export type SnippetScope = 'global' | 'session';

/**
 * Sort order for the Snippets list.
 */
export type SnippetSortOrder = 'lastUsed' | 'useCount' | 'createdAt';

export type Snippet = {
  id: string;
  title: string;           // auto-generated from first 20 chars, editable
  command: string;         // the actual command (required)
  tags: string[];          // optional tags for filtering
  createdAt: number;       // Unix ms
  lastUsedAt: number;      // Unix ms (updated on Run)
  useCount: number;        // incremented on Run
  scope: SnippetScope;
};

// ─── Creator Engine ──────────────────────────────────────────────────────────

/**
 * A single step in the build log shown in the Build lane.
 */
export type BuildStep = {
  id: string;
  message: string;          // human-readable log line
  command?: string;         // underlying shell command (optional)
  status: 'pending' | 'running' | 'done' | 'error';
  timestamp: number;
};

/**
 * The AI plan shown before execution.
 */
export type CreatorPlan = {
  summary: string;          // 1-2 sentence natural language description
  steps: string[];          // ordered list of what will be done
  projectType: ProjectType;
  projectName: string;      // slug-style, e.g. "portfolio-site"
  estimatedFiles: number;
};

export type ProjectType =
  | 'web'        // HTML + CSS + JS
  | 'script'     // Node.js or Python script
  | 'document'   // Markdown / JSON
  | 'api'        // Express/Fastify server
  | 'cli'        // Node.js CLI tool
  | 'mobile'     // Expo/React Native app
  | 'static'     // Astro/Hugo static site
  | 'unknown';

/**
 * A generated project stored in Projects/YYYY-MM-DD_name/
 */
export type CreatorProject = {
  id: string;
  name: string;             // display name
  slug: string;             // folder-safe slug
  projectType: ProjectType;
  createdAt: number;
  /** Last time the project was opened (updated on Open action) */
  lastOpenedAt?: number;
  path: string;             // e.g. "Projects/2026-02-25_portfolio-site"
  files: ProjectFile[];
  status: 'building' | 'done' | 'error';
  userInput: string;        // original natural language request
  plan: CreatorPlan | null;
  buildSteps: BuildStep[];
  /** Next action suggestions shown in Result lane */
  suggestions: string[];
  /** User-defined tags for filtering (e.g. ['school', 'website']) */
  tags?: string[];
  /** Whether files were actually written to Termux filesystem */
  termuxWritten?: boolean;
};

/** Sort order for project history */
export type ProjectSortOrder = 'createdAt' | 'lastOpenedAt' | 'name' | 'tags';

export type ProjectFile = {
  path: string;             // relative to project root, e.g. "src/index.html"
  content: string;
  language: string;         // "html" | "css" | "js" | "md" | "json" | "py" | "ts"
};

/**
 * A Recipe is a Snippet that represents a reusable Creator project template.
 * Stored in the Snippets store with tag "recipe".
 */
export type RecipeSnippet = {
  snippetId: string;        // references Snippet.id
  projectType: ProjectType;
  userInput: string;        // original prompt
  projectPath: string;
};

/**
 * Overall state of the Creator session (one active at a time).
 */
export type CreatorSessionStatus =
  | 'idle'        // waiting for user input
  | 'planning'    // AI generating plan
  | 'confirming'  // showing plan, waiting for user confirm
  | 'building'    // executing build steps
  | 'done'        // project complete
  | 'error';      // something went wrong

// ─── Settings ─────────────────────────────────────────────────────────────────

export type CursorShape = 'block' | 'underline' | 'bar';

export type ThemeVariant = 'black' | 'navy' | 'gray';

/**
 * How running a snippet from the Snippets tab behaves.
 * - 'insertOnly'  : paste command into input field, do NOT auto-submit
 * - 'insertAndRun': paste + submit immediately
 */
export type SnippetRunMode = 'insertOnly' | 'insertAndRun';

export type AppSettings = {
  fontSize: number;
  lineHeight: number;
  themeVariant: ThemeVariant;
  cursorShape: CursorShape;
  hapticFeedback: boolean;
  autoScroll: boolean;
  /** Sound effects (UI feedback sounds) */
  soundEffects: boolean;
  /** Sound volume (0.0 - 1.0) */
  soundVolume: number;
  /** How snippet Run works */
  snippetRunMode: SnippetRunMode;
  /** Auto-navigate to Terminal tab after running a snippet */
  snippetAutoReturn: boolean;
  /**
   * Debug: Force high-contrast colors for stdout/stderr output.
   * ON (default): stdout = #E8E8E8, stderr = #FF7878 — guaranteed readable on OLED.
   * OFF: use theme-dependent colors (may be harder to read on some displays).
   */
  highContrastOutput: boolean;
  // ─── Local LLM (Ollama) ───────────────────────────────────────────────────
  /** Enable local LLM for chat (Ollama-compatible API) */
  localLlmEnabled: boolean;
  /** Ollama API base URL (default: http://127.0.0.1:11434) */
  localLlmUrl: string;
  /** Model name to use (default: Qwen3.5-0.8B-Q4_K_M) */
  localLlmModel: string;
  /** Optional selected GGUF path for llama-server auto-start */
  localLlmModelPath?: string;
  // ─── Telegram inbound gateway (Phase 3) ──────────────────────────────────────────
  /** Accept @agent messages from a single authorized Telegram chat (opt-in). */
  telegramInboundEnabled?: boolean;
  /** Bot token from @BotFather — secret, stored in SecureStore (not AsyncStorage). */
  telegramBotToken?: string;
  /** The SINGLE pre-authorized chat id; messages from any other chat are dropped. */
  telegramAuthorizedChatId?: string;

  // ─── Perplexity Sonar API ────────────────────────────────────────────────────────
  /** Perplexity Sonar API キー (https://www.perplexity.ai/settings/api) */
  perplexityApiKey?: string;
  /** Perplexityに使用するモデル (default: sonar-reasoning-pro) */
  perplexityModel?: string;
  // ─── Gemini API ────────────────────────────────────────────────────────────────
  /** Gemini API キー (https://aistudio.google.com/app/apikey) */
  geminiApiKey?: string;
  /** Geminiに使用するモデル (default: gemini-2.5-flash — 無料枠 + grounding) */
  geminiModel?: string;
  // ─── Groq API ─────────────────────────────────────────────────────────────────
  /** Groq API キー — Whisper音声文字起こし用 (https://console.groq.com) */
  groqApiKey?: string;
  /** Groqに使用するモデル (default: llama-3.3-70b-versatile) */
  groqModel?: string;
  // ─── Cerebras API ──────────────────────────────────────────────────────────────
  /** Cerebras API キー (https://cloud.cerebras.ai) */
  cerebrasApiKey?: string;
  /** Cerebrasに使用するモデル (default: qwen-3-235b-a22b-instruct-2507) */
  cerebrasModel?: string;
  // ─── Autonomous cloud opt-in (N1) ──────────────────────────────────────────
  /** Informed consent: autonomous agents may use cloud API keys (Gemini /
   *  Perplexity) UNATTENDED for web-mandatory tasks. Default OFF — fail-closed:
   *  without it, autonomous web tasks stay Codex-only. The key authenticates the
   *  request to the provider and is never sent to the model; what this gates is
   *  unattended quota/cost usage. secret-guard still always forces local. */
  autonomousCloudConsent?: boolean;
  /** On cloud quota exhaustion (HTTP 429) during an autonomous web task:
   *  'escalate' (default) climbs to Codex; 'stop' halts at the free tier and
   *  reports exhaustion instead of consuming Codex / paid quota. */
  autonomousCloudOnExhaustion?: 'escalate' | 'stop';
  /** Webhook destination hosts the user has previously vetted. Informational
   *  only: membership never bypasses the per-request human approval gate. */
  webhookHostAllowlist?: string[];
  // ─── Agent output destination (where saved drafts land) ─────────────────────
  /** Where an agent's saved draft is written. 'local' (default) → a clean,
   *  findable local folder ($HOME/agent-output); 'obsidian' → the configured
   *  Vault; 'custom' → an arbitrary path (e.g. a Drive-synced /sdcard folder).
   *  Applies to general collection agents; content-studio agents keep their
   *  explicit paths. Layout: <base>/<topic?>/{date}/{date}_{title}.md. */
  agentOutputTarget?: 'local' | 'obsidian' | 'custom';
  /** Obsidian Vault root (also used for the content-studio mirror). */
  agentVaultPath?: string;
  /** Optional topic root inserted before the date folder (e.g. "STEAM_AI"). */
  agentTopicFolder?: string;
  /** Base path when agentOutputTarget === 'custom'. */
  agentCustomPath?: string;
  // ─── @team Table ────────────────────────────────────────────────────────────
  /** @teamに参加させるエージェントのON/OFF */
  teamMembers: {
    gemini: boolean;
    codex: boolean;
    cerebras: boolean;
    groq: boolean;
    perplexity: boolean;
    local: boolean;
  };
  /** ファシリテーターの優先順位（先頭が最優先） */
  teamFacilitatorPriority: Array<'local' | 'gemini' | 'cerebras' | 'groq' | 'codex' | 'perplexity'>;
  /** Codex CLIコマンド名 (default: codex) */
  codexCmd?: string;
  // ─── コマンド安全システム ─────────────────────────────────────────────────────────────────────────────────────
  /** コマンド安全システムを有効にする (default: true) */
  enableCommandSafety: boolean;
  /** 確認ダイアログを表示する最低危険度 (default: 'HIGH') */
  safetyConfirmLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  /** 体験モード: 初心者向け詳細表示 / 経験者向け高速モード */
  experienceMode: 'learning' | 'fast';
  // ─── CLI Permission Proxy ────────────────────────────────────────────────────
  /** Chatタブ経由でのCLI自動承認レベル (default: 'safe') */
  autoApproveLevel: 'none' | 'safe' | 'all';
  // ─── Default Agent ─────────────────────────────────────────────────────────
  /** Default agent for chat / AI pane. Legacy removed-agent values
   * are migrated to codex when old settings are loaded. */
  defaultAgent: 'cerebras' | 'groq' | 'codex';
  /** リアルタイム翻訳ON/OFF（デフォルト: false） */
  realtimeTranslateEnabled?: boolean;
  /** LLM出力通訳（学習モード）ON/OFF（デフォルト: false） */
  llmInterpreterEnabled?: boolean;
  /** 外部キーボードのショートカット表示（デフォルト: false） */
  externalKeyboardShortcuts?: boolean;
  // ─── Terminal Appearance ──────────────────────────────────────────────────
  /** Terminal ANSI color theme (default: 'shelly') */
  terminalTheme: string;
  /** Enable OpenGL ES 3.0 GPU hardware acceleration for terminal rendering */
  gpuRendering?: boolean;
  /**
   * bug #48: Show the Vim-specific key set in the terminal CommandKeyBar.
   * When false (default), the Vim page is hidden so `Esc / :w / :q / :wq / dd`
   * don't clutter the key bar for users who never open vim. Users who live
   * in vim can flip this on from Settings. v0.2.0 will replace this with
   * PTY-state auto-detection.
   */
  showVimKeyBar?: boolean;
  // ─── Approval defaults (project owner directive 2026-07-14) ─────────────────
  /** Registration confirm for NL-self-registered agents that still use
   *  AgentConfirmCard (non-app-act, non-tool-pinned drafts — see
   *  lib/agent-plan-summary.ts's shouldUseChatConfirm for the chat-native
   *  drafts this does NOT apply to). Default false = auto-register the
   *  parsed draft immediately (no human tap) whenever it already has a
   *  fireable schedule; a draft that still needs a schedule restated always
   *  surfaces the card regardless of this setting ("never register an agent
   *  that will never fire" is not an approval-frequency knob). true = restore
   *  today's mandatory Confirm tap. */
  agentRegistrationRequireConfirm?: boolean;
  /** Runtime per-action "Runtime Review" approval tap (draft/notify/webhook/
   *  cli/intent/dm-reply — see wait_action_approval in lib/agent-executor.ts
   *  and scripts/shelly-plan-executor.js). Default false = auto-approve, no
   *  human tap required. true = restore today's mandatory-approval flow.
   *  Per-agent Agent.requireActionApproval overrides this when set.
   *  Does NOT affect app-act, which has its own narrower Tier-B trust gate
   *  (Agent.autonomous alone, see AgentActionType's doc comment) —
   *  intentionally not unified with this blanket switch because a wrong
   *  external post is not equivalent in risk to a local draft or CLI call.
   *  Does NOT relax command-safety CRITICAL / secret-scan / workspace-root
   *  gates, which are hard content/action classifiers independent of any
   *  approval-frequency setting. */
  defaultRequireActionApproval?: boolean;
  /** P1 scheduling-reliability audit (2026-07-15): true once the user has
   *  dismissed the one-time AgentScheduleReadinessCard (exact-alarm grant /
   *  battery-optimization exemption / Samsung sleeping-apps guidance) shown
   *  after their FIRST scheduled (non-one-shot) agent registration. Device-
   *  scoped, not per-agent, so it never nags again once seen — see
   *  hooks/use-ai-pane-dispatch.ts's confirmAgentDraft. Default false/absent
   *  = not yet shown. This is a dismissible nudge, never a registration gate:
   *  the agent is always created first, the card is a best-effort follow-up. */
  scheduleReadinessNudgeShown?: boolean;
  /** UI visual preset. Legacy ids remain accepted for existing installs. */
  uiFont?:
    | 'blue'
    | 'orange'
    | 'purple'
    | 'scouter-green'
    | 'shelly'
    | 'blackline'
    | 'modal'
    | 'silkscreen'
    | 'pixel'
    | 'mono'
    | 'dracula'
    | 'nord'
    | 'gruvbox'
    | 'tokyo-night'
    | 'catppuccin-mocha'
    | 'rose-pine'
    | 'kanagawa'
    | 'everforest'
    | 'one-dark';
};

// ─── Background Agents ──────────────────────────────────────────────────────

export type ToolChoice =
  | { type: 'cli'; cli: 'codex' }
  | { type: 'gemini-api'; model?: string }
  | { type: 'cerebras'; model?: string }
  | { type: 'groq'; model?: string }
  | { type: 'local'; model?: string }
  | { type: 'perplexity'; model?: string }
  | { type: 'ab-article-eval'; localModel?: string; codexCmd?: string }
  | { type: 'auto' };

/**
 * What an agent does with its run result — the MVP action layer (Phase 0 §2.3).
 * The capability boundary lives here, NOT as a Codex-prompt convention: a future
 * NL-parsed "post to X" must not silently inherit publish. `publish` is deliberately
 * NOT a member — draft-only is a hard capability guarantee for the MVP.
 *
 * Approval tiering by blast radius (Phase 0 §2.6) is enforced at the approval layer,
 * keyed off `type`: draft/notify = one-tap; webhook = one-tap with host+payload shown;
 * cli/intent/dm-reply = never one-tap (in-app Review before Allow) — intent additionally shows
 * the resolved target app/URI/share-text so the user sees exactly what will fire.
 *
 * `app-act` is a DELIBERATE exception to that pattern: it is Tier-B and
 * unattended/autonomous-run-capable, unlike its `cli`/`intent`/`dm-reply` siblings
 * which either hard-refuse unattended execution or are refused when running
 * unattended. This is intentional, not an oversight a future reader should "fix"
 * by adding a matching hard-refusal — do not do that. The reason it's safe: unlike
 * `intent`/`dm-reply`, which can point at an arbitrary target resolved at run time
 * (a package/URI or a paired notification fingerprint chosen dynamically), an
 * `app-act` action's recipe + target + content-pipeline (`appActRecipeId` +
 * `appActParams`) is fixed and explicitly consented to once at registration time,
 * and remains visible in the Sidebar for the lifetime of the agent — there is no
 * run-time target resolution step that could diverge from what the user approved.
 *
 * Implemented gate (2026-07-14, see docs/superpowers/DEFERRED.md's now-resolved
 * "app-act Tier-B" entry, widened same day per project owner directive —
 * "たとえパープレだろうとCodexだろうと", chat-confirmed consent is the
 * boundary, not the tool backend): the unattended-allow ONLY fires when the
 * SAME registration-time consent already gates draft/notify's native fast-path
 * — `Agent.autonomous === true` alone (AgentRuntime.kt's trustedPlanLaunch /
 * lib/agent-executor.ts's ACTION_APP_ACT_AUTO_FIRE_TRUSTED). A cloud tool
 * still can't reach a runnable autonomous script at all unless
 * AppSettings.autonomousCloudConsent was separately granted (Spec A §4, N1
 * exception) — this gate only governs whether app-act may fire unattended
 * once a script exists. This is a NARROWER gate than
 * AppSettings.defaultRequireActionApproval/Agent.requireActionApproval
 * (which only ever affect draft/notify/webhook/cli/intent/dm-reply) — flipping
 * the global "no approval tap" default does NOT by itself unlock unattended
 * app-act; only the pre-existing autonomous consent does, because a wrong
 * external post is not equivalent in risk to a local draft or CLI call.
 */
export type AgentActionType =
  | 'draft'
  | 'notify'
  | 'webhook'
  | 'cli'
  | 'intent'
  | 'dm-reply'
  | 'app-act';

export interface AgentAction {
  type: AgentActionType;
  /** webhook: destination URL (https required for one-tap approval). */
  webhookUrl?: string;
  /** cli: command template run with the result. Highest privilege — never one-tap. */
  command?: string;
  // TODO(INTENT-001): if a future extra needs a secret, express it as an authRef
  // pointer (see CustomAuthRefMeta's shape) resolved only inside fireAgentIntent,
  // never in the plan/request/preview/log — see SECRET-001. Not needed for v1.
  /** intent: 'launch' opens another app (by package name or a URI the OS resolves
   *  via ACTION_VIEW); 'share' hands text to the OS share sheet (ACTION_SEND).
   *  Never one-tap — always routes through in-app Review (same tier as cli). */
  intentMode?: 'launch' | 'share';
  /** intent/launch: a package name OR a URI (geo:, https:, market:, custom scheme).
   *  intent/share: unused in v1 (no preferred-package hint — plain OS chooser). */
  intentTarget?: string;
  /** intent/share: ACTION_SEND EXTRA_TEXT content. May contain the literal
   *  placeholder "{{result}}", string-replaced (no template engine) with the
   *  agent's run preview text at request-build time, BEFORE the approval request
   *  is written — so native/RN code only ever sees the final resolved string. */
  intentShareText?: string;
  /** dm-reply: opaque reference to a paired live-notification fingerprint. */
  dmPairingId?: string;
  /** dm-reply: reply text template. A literal {{result}} is replaced with the run preview. */
  dmReplyText?: string;
  /** app-act: which registered app-action recipe to invoke (e.g. 'x.post').
   *  Schema only in this phase — no dispatch logic reads this yet. */
  appActRecipeId?: string;
  /** app-act: recipe parameters (e.g. { text: '{{result}}' } for 'x.post').
   *  Values may contain the literal placeholder "{{result}}", string-replaced
   *  (no template engine) with the agent's run preview text, following the same
   *  convention as intentShareText/dmReplyText. Schema only in this phase. */
  appActParams?: Record<string, string>;
  /** app-act: delivery mechanism for the recipe. 'accessibility' = drive the
   *  target app's UI via AccessibilityService (what Phase 3/4 implement first);
   *  'api' = call the target service's own API (e.g. X API v2 OAuth 1.0a
   *  user-context) as a forward-compatible alternative, not yet implemented.
   *  Absent/undefined means 'accessibility' — kept optional so existing
   *  app-act actions written before this field existed don't need a migration.
   *  Schema only in this phase; no dispatch logic reads this yet. */
  appActMethod?: 'accessibility' | 'api';
}

/** Phase 1 persistent memory (lib/agent-memory.ts). On-device only. */
export interface AgentMemoryConfig {
  /** true = after a successful run, save the result digest as a memory note. */
  remember?: boolean;
  /** A fact captured from the registering utterance ("remember that …"), written
   *  as a memory note at creation so the very next run can recall it. */
  rememberFact?: string;
  /** Default tags applied to notes this agent writes. */
  tags?: string[];
}

export type AgentRouteDecisionGuard =
  | 'secret'
  | 'manual-pin'
  | 'autonomous-policy'
  | 'keyword'
  | 'scorer'
  | 'configured-tool'
  | 'default';

/** Phase 2b Layer-2 scoring metadata (lib/agent-router-scoring.ts). Offline. */
export interface AgentRouteScore {
  /** 0–1, from the gap between the top two candidates. */
  confidence: number;
  /** All candidate tools with their scores (highest first), for the audit log. */
  candidates: { toolType: ToolChoice['type']; score: number }[];
}

export interface AgentRouteDecision {
  route: 'on-device' | 'cloud' | 'hybrid';
  toolType: ToolChoice['type'];
  toolLabel: string;
  guard: AgentRouteDecisionGuard;
  why: string;
  keyword?: string;
  secretKinds?: string[];
  noCloudFallback?: boolean;
  /** Present when the Layer-2 scorer chose the route (auto agents, post-guards). */
  score?: AgentRouteScore;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string | null;     // cron expression, null = manual only
  /** Packages whose notifications trigger an immediate one-shot run of this agent.
   *  Coarse allowlist, no per-package sub-config. Dormant until Increment 2 adds a
   *  UI to configure it. */
  notificationTrigger?: { packageNames: string[] } | null;
  tool: ToolChoice;
  /** true = runs in autonomous mode (no per-step human approval): OAuth/local only,
   *  gated by the policy engine. Optional; absent/false = today's manual behaviour. */
  autonomous?: boolean;
  /** Per-agent override of AppSettings.defaultRequireActionApproval. Absent =
   *  inherit the global default (false = auto-approve). true = this agent's
   *  runtime actions always require the manual "Runtime Review" tap regardless
   *  of the global default. Does not affect app-act's separate Tier-B gate. */
  requireActionApproval?: boolean;
  /** autonomy level for autonomous runs: L1 read-only / L2 workspace / L3 full.
   *  Set by the human (ConfigTUI); absent = L2 default. The B2 driver builds the
   *  AutonomyPolicy from this and holds it driver-side — never passed to codex. */
  autonomyLevel?: 'L1' | 'L2' | 'L3';
  /** workspace root the autonomous run operates in (canonicalised at run start). */
  workspaceRoot?: string;
  outputPath: string;
  outputTemplate: string | null;
  /** What to do with the run result (Phase 0 §2.3). Absent = 'draft' (write to
   *  outputPath) — today's behaviour made explicit, so legacy agents keep working. */
  action?: AgentAction;
  /** Manual routing pin set in the confirm card (Phase 0 §2.4). 'auto' = default
   *  local-first routing (hard-guards + keyword). 'on-device' / 'cloud' override it.
   *  Absent = 'auto'. The escape hatch for bad local quality — widen control, not default. */
  runOn?: 'auto' | 'on-device' | 'cloud';
  /** Phase 1 persistent memory. Absent = no memory writes (recall is always
   *  attempted but is a no-op when the agent has no saved notes). */
  memory?: AgentMemoryConfig;
  /** Phase 2a: id of a reused skill recipe (lib/agent-skills.ts) attached at
   *  creation after a user-gated "use skill X?" confirm. Its recipe is injected
   *  into the run prompt and its success-count bumps on a successful run. */
  skillId?: string;
  /** Phase 4: multi-step orchestration. Absent/<2 steps = single-run. Each step
   *  runs through the SAME gated single-run path, so chaining adds no privilege. */
  orchestration?: AgentOrchestrationConfig;
  enabled: boolean;
  lastRun: number | null;
  lastResult: 'success' | 'error' | null;
  createdAt: number;
  version: number;             // schema version (1 for v1)
  /** P0-1 reliability: the next time this schedule is expected to fire,
   *  recomputed and persisted whenever the alarm is (re)armed (installSchedule
   *  via materializeAgent). Observability/reconciliation aid — startup repair's
   *  actual missed-fire DETECTION uses a fresh lastTriggerMs(schedule) recompute
   *  (see lib/agent-scheduler.ts's isScheduleMissed), not this field, so a stale
   *  value here can never mask or fabricate a missed-run notification. Absent on
   *  agents created before this field existed. */
  nextExpectedAt?: number | null;
  /** P0-1 reliability: the expected-fire timestamp (isScheduleMissed's
   *  `expectedAt`) that the startup-repair pass already notified the user about,
   *  so re-opening the app before the next successful fire doesn't re-post the
   *  same "schedule missed" notification every launch. Cleared implicitly once
   *  a new run's lastRun timestamp moves past this window. Absent = never
   *  notified. */
  lastMissedNotifiedAt?: number | null;
}

export interface AgentRunLog {
  agentId: string;
  timestamp: number;
  // 'unavailable' = all web backends failed transiently (429/5xx/network) after
  // retry; the ladder still climbs on it, but it does NOT trip the circuit breaker.
  status: 'success' | 'error' | 'skipped' | 'unavailable';
  outputPreview: string;       // first 500 chars
  durationMs: number;
  toolUsed: string;
  errorMessage?: string;
  routeDecision?: AgentRouteDecision;
  /** Phase 4: present when this was a multi-step orchestrated run. */
  steps?: AgentRunStep[];
}

/** Phase 4 orchestration: one step within a multi-step run, for the run log. */
export interface AgentRunStep {
  index: number;
  instruction: string;
  // 'unavailable' mirrors AgentRunLog: a step whose only failure was a transient
  // web outage. reduceStatus folds it to an 'unavailable' run (not 'error') so a
  // multi-step agent is NOT auto-disabled by a transient outage either.
  status: 'success' | 'error' | 'skipped' | 'unavailable';
  durationMs: number;
  outputPreview: string;
  routeDecision?: AgentRouteDecision;
}

/**
 * Phase 5: a step can optionally pin a concrete tool/provider, skipping the
 * keyword-based auto-routing for that step only. A plain string step (below)
 * is the original shape and keeps today's exact auto-routing behavior — no
 * migration needed for existing on-disk agents.
 */
export interface AgentOrchestrationStep {
  instruction: string;
  /** Absent/omitted = auto-routed exactly like a plain-string step. A concrete
   *  (non-'auto') tool here is resolved via the SAME 'configured-tool' path a
   *  top-level pinned `Agent.tool` already uses — it does not widen privilege:
   *  autonomous unattended runs still force local/Codex via resolveForAutonomous,
   *  and a top-level `Agent.runOn` on-device/cloud pin still outranks it. */
  tool?: ToolChoice;
}

/** Phase 4 orchestration config on an agent. Absent = single-run (today). */
export interface AgentOrchestrationConfig {
  /** Ordered step instructions; ≥ 2 → runs as a linear chain. Each entry is
   *  EITHER a plain string (legacy shape, always auto-routed) OR an object with
   *  an optional tool pin (Phase 5). */
  steps: Array<string | AgentOrchestrationStep>;
  /** Max steps to launch (clamped to a hard cap for the phantom-process ceiling). */
  maxSteps?: number;
  /** Total wall-clock budget in ms (clamped to a hard ceiling). */
  totalTimeoutMs?: number;
  /** G6: target character budget for the FINAL step (e.g. an X/Twitter digest).
   *  Enforced by the PlanSpec executor before result persistence/draft writes. */
  charLimit?: number;
}
