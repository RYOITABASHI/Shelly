/**
 * lib/user-profile.ts
 *
 * ユーザープロファイル自動学習モジュール。
 *
 * LLMとのやり取り・コマンド実行パターン・設定変更から
 * ユーザーの特性を自動的に蓄積し、LLMのシステムプロンプトに反映する。
 *
 * 学習する情報:
 *   - 使用言語の傾向（日本語/英語）
 *   - よく使うコマンド・ツール
 *   - 技術レベルの推定
 *   - よく触るプロジェクト・言語
 *   - 好みのAIエージェント
 *   - コミュニケーションスタイル
 *   - ユーザーが教えてくれた自己紹介的情報
 *
 * 保存先: AsyncStorage (shelly_user_profile)
 * プライバシー: 端末ローカルのみ。外部送信なし。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'shelly_user_profile';
const MAX_COMMANDS = 50;
const MAX_FACTS = 30;
const MAX_PROJECTS = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserProfile {
  /** ユーザーが自分について教えてくれた情報 */
  facts: string[];
  /** よく使うコマンド（頻度順） */
  topCommands: Array<{ cmd: string; count: number }>;
  /** よく使うAIエージェント */
  agentUsage: Record<string, number>;
  /** よく触るプロジェクト */
  recentProjects: Array<{ path: string; name: string; lastAccess: number }>;
  /** 検出した技術スタック（コマンドから推定） */
  detectedSkills: string[];
  /** コミュニケーション傾向 */
  style: {
    language: 'ja' | 'en' | 'mixed';
    verbosity: 'concise' | 'detailed' | 'unknown';
    techLevel: 'beginner' | 'intermediate' | 'advanced' | 'unknown';
  };
  /** 最終更新 */
  updatedAt: number;
}

const DEFAULT_PROFILE: UserProfile = {
  facts: [],
  topCommands: [],
  agentUsage: {},
  recentProjects: [],
  detectedSkills: [],
  style: {
    language: 'ja',
    verbosity: 'unknown',
    techLevel: 'unknown',
  },
  updatedAt: 0,
};

// ─── In-memory cache ──────────────────────────────────────────────────────────

let profileCache: UserProfile | null = null;

/**
 * プロファイルをロードする（キャッシュあり）
 */
export async function loadUserProfile(): Promise<UserProfile> {
  if (profileCache) return profileCache;

  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      profileCache = { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
    } else {
      profileCache = { ...DEFAULT_PROFILE };
    }
  } catch {
    profileCache = { ...DEFAULT_PROFILE };
  }

  return profileCache!;
}

/**
 * プロファイルを保存する
 */
async function saveProfile(profile: UserProfile): Promise<void> {
  profile.updatedAt = Date.now();
  profileCache = profile;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // storage full etc — silently fail
  }
}

// ─── 学習関数群 ──────────────────────────────────────────────────────────────

/**
 * コマンド実行を記録する
 */
export async function learnFromCommand(command: string): Promise<void> {
  const profile = await loadUserProfile();
  const cmd = command.trim().split(/\s+/)[0]; // 最初のワードだけ
  if (!cmd || cmd.startsWith('#')) return;

  // コマンド頻度更新
  const existing = profile.topCommands.find(c => c.cmd === cmd);
  if (existing) {
    existing.count++;
  } else {
    profile.topCommands.push({ cmd, count: 1 });
  }
  profile.topCommands.sort((a, b) => b.count - a.count);
  profile.topCommands = profile.topCommands.slice(0, MAX_COMMANDS);

  // スキル推定
  detectSkillsFromCommand(command, profile);

  // 技術レベル推定
  estimateTechLevel(profile);

  await saveProfile(profile);
}

/**
 * AIエージェント使用を記録する
 */
export async function learnFromAgentUse(agent: string): Promise<void> {
  const profile = await loadUserProfile();
  profile.agentUsage[agent] = (profile.agentUsage[agent] ?? 0) + 1;
  await saveProfile(profile);
}

/**
 * プロジェクトアクセスを記録する
 */
export async function learnFromProject(path: string, name: string): Promise<void> {
  const profile = await loadUserProfile();
  const existing = profile.recentProjects.find(p => p.path === path);
  if (existing) {
    existing.lastAccess = Date.now();
    existing.name = name;
  } else {
    profile.recentProjects.push({ path, name, lastAccess: Date.now() });
  }
  profile.recentProjects.sort((a, b) => b.lastAccess - a.lastAccess);
  profile.recentProjects = profile.recentProjects.slice(0, MAX_PROJECTS);
  await saveProfile(profile);
}

/**
 * ユーザーの発言からファクトを抽出する。
 * LLMは使わず、パターンマッチで自己紹介的な情報を拾う。
 */
export async function learnFromUserInput(input: string): Promise<void> {
  const profile = await loadUserProfile();
  const extracted = extractFacts(input);

  for (const fact of extracted) {
    // 重複チェック（似た内容があれば上書き）
    const dupeIdx = profile.facts.findIndex(f =>
      f.toLowerCase().includes(fact.toLowerCase().slice(0, 20)) ||
      fact.toLowerCase().includes(f.toLowerCase().slice(0, 20))
    );
    if (dupeIdx >= 0) {
      profile.facts[dupeIdx] = fact;
    } else {
      profile.facts.push(fact);
    }
  }
  profile.facts = profile.facts.slice(-MAX_FACTS);

  // 言語傾向
  detectLanguage(input, profile);

  await saveProfile(profile);
}

/**
 * プロファイルをLLMシステムプロンプト用の文字列に変換する
 */
export function formatProfileForPrompt(profile: UserProfile): string {
  const parts: string[] = [];

  if (profile.facts.length > 0) {
    parts.push('ユーザーについて:');
    for (const f of profile.facts.slice(-10)) parts.push(`- ${f}`);
  }

  if (profile.topCommands.length > 0) {
    const top5 = profile.topCommands.slice(0, 5).map(c => c.cmd);
    parts.push(`よく使うコマンド: ${top5.join(', ')}`);
  }

  if (profile.detectedSkills.length > 0) {
    parts.push(`技術スキル: ${profile.detectedSkills.join(', ')}`);
  }

  const { style } = profile;
  if (style.techLevel !== 'unknown') {
    const levelMap = { beginner: '初心者', intermediate: '中級者', advanced: '上級者' };
    parts.push(`技術レベル: ${levelMap[style.techLevel]}`);
  }
  if (style.verbosity !== 'unknown') {
    parts.push(`好みの回答スタイル: ${style.verbosity === 'concise' ? '簡潔' : '詳細'}`);
  }

  if (profile.recentProjects.length > 0) {
    const recent = profile.recentProjects.slice(0, 3).map(p => p.name);
    parts.push(`最近のプロジェクト: ${recent.join(', ')}`);
  }

  const favoriteAgent = Object.entries(profile.agentUsage)
    .sort(([, a], [, b]) => b - a)[0];
  if (favoriteAgent) {
    parts.push(`よく使うAI: ${favoriteAgent[0]}`);
  }

  if (parts.length === 0) return '';

  return parts.join('\n');
}

// ─── 内部ヘルパー ────────────────────────────────────────────────────────────

/**
 * ユーザー入力から自己紹介的な情報を抽出する
 */
function extractFacts(input: string): string[] {
  // Sanitize: strip control characters and limit input length to prevent regex abuse
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 1000);
  const facts: string[] = [];

  // 「俺は〜」「私は〜」「名前は〜」パターン
  const selfPatterns = [
    /(?:俺|私|僕|自分|わたし|おれ|ぼく)(?:は|の(?:名前|仕事|職業|趣味|専門)は?)([^。！？\n]{3,40})/g,
    /(?:名前|ニックネーム|HN)(?:は|:)\s*([^\s。！？\n]{1,20})/g,
    /(?:仕事|職業|職種)(?:は|:)\s*([^。！？\n]{2,30})/g,
    /(?:my name is|i'm|i am)\s+([^\s,.!?]{1,20})/gi,
    /(?:i work as|i'm a|i am a)\s+([^,.!?\n]{2,30})/gi,
  ];

  for (const pat of selfPatterns) {
    let match;
    while ((match = pat.exec(sanitized)) !== null) {
      const fact = match[1].trim();
      if (fact.length >= 2) facts.push(fact);
    }
  }

  // 「〜が好き」「〜を使ってる」パターン
  const prefPatterns = [
    /([^\s。、]{2,15})(?:が好き|を(?:よく)?使(?:ってる|っている|う)|を愛用|派)/g,
    /(?:prefer|love|like using)\s+([^\s,.!?]{2,20})/gi,
  ];

  for (const pat of prefPatterns) {
    let match;
    while ((match = pat.exec(sanitized)) !== null) {
      const pref = match[1].trim();
      if (pref.length >= 2) facts.push(`${pref}を好む`);
    }
  }

  // 明示的な「覚えて」指示
  const rememberPatterns = [
    /(?:覚えて(?:おいて)?|remember|記録して|メモして)(?:[:：]?\s*)([^。！？\n]{3,60})/gi,
  ];

  for (const pat of rememberPatterns) {
    let match;
    while ((match = pat.exec(sanitized)) !== null) {
      facts.push(match[1].trim());
    }
  }

  return facts;
}

/**
 * コマンドからスキルを推定する
 */
function detectSkillsFromCommand(command: string, profile: UserProfile): void {
  const skillMap: Record<string, string[]> = {
    'git': ['Git'],
    'docker': ['Docker'],
    'npm': ['Node.js'], 'pnpm': ['Node.js'], 'yarn': ['Node.js'], 'bun': ['Bun'],
    'python': ['Python'], 'python3': ['Python'], 'pip': ['Python'],
    'cargo': ['Rust'], 'rustc': ['Rust'],
    'go': ['Go'],
    'gradle': ['Android/Java'], 'javac': ['Java'],
    'swift': ['Swift'], 'xcodebuild': ['iOS'],
    'kubectl': ['Kubernetes'], 'helm': ['Kubernetes'],
    'terraform': ['Terraform'],
    'aws': ['AWS'], 'gcloud': ['GCP'], 'az': ['Azure'],
    'psql': ['PostgreSQL'], 'mysql': ['MySQL'], 'mongosh': ['MongoDB'],
    'ssh': ['SSH/Networking'], 'curl': ['HTTP/API'],
    'expo': ['Expo'], 'eas': ['EAS Build'],
    'claude': ['Claude Code'], 'gemini': ['Gemini'],
  };

  const cmd = command.trim().split(/\s+/)[0];
  const skills = skillMap[cmd];
  if (!skills) return;

  for (const skill of skills) {
    if (!profile.detectedSkills.includes(skill)) {
      profile.detectedSkills.push(skill);
    }
  }
  // 最大20個
  profile.detectedSkills = profile.detectedSkills.slice(0, 20);
}

/**
 * コマンドパターンから技術レベルを推定する
 */
function estimateTechLevel(profile: UserProfile): void {
  const total = profile.topCommands.reduce((s, c) => s + c.count, 0);
  if (total < 10) return; // まだデータ不足

  const advancedCmds = ['docker', 'kubectl', 'terraform', 'ssh', 'awk', 'sed', 'tmux', 'vim', 'nvim'];
  const intermediateCmds = ['git', 'npm', 'pnpm', 'python', 'cargo', 'go', 'curl'];

  const cmdNames = profile.topCommands.map(c => c.cmd);
  const advancedCount = cmdNames.filter(c => advancedCmds.includes(c)).length;
  const intermediateCount = cmdNames.filter(c => intermediateCmds.includes(c)).length;

  if (advancedCount >= 3 || profile.detectedSkills.length >= 8) {
    profile.style.techLevel = 'advanced';
  } else if (intermediateCount >= 2 || profile.detectedSkills.length >= 4) {
    profile.style.techLevel = 'intermediate';
  } else if (total >= 20) {
    profile.style.techLevel = 'beginner';
  }
}

/**
 * 言語傾向を検出する
 */
function detectLanguage(input: string, profile: UserProfile): void {
  const hasJa = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(input);
  const hasEn = /[a-zA-Z]{3,}/.test(input);

  if (hasJa && hasEn) {
    profile.style.language = 'mixed';
  } else if (hasJa) {
    profile.style.language = 'ja';
  } else if (hasEn) {
    profile.style.language = 'en';
  }
}

/**
 * プロファイルをリセットする
 */
export async function resetUserProfile(): Promise<void> {
  profileCache = { ...DEFAULT_PROFILE };
  await AsyncStorage.removeItem(STORAGE_KEY);
}
