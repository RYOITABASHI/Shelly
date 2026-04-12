/**
 * lib/project-context.ts
 *
 * プロジェクトコンテキスト自動生成 & ローダー。
 *
 * 機能:
 *   1. `.shelly/context.md` を読み込んでLLMに注入（ローダー）
 *   2. プロジェクトのソースを走査して context.md を自動生成（ジェネレーター）
 *
 * 自動生成でやること:
 *   - package.json から名前・バージョン・依存関係を抽出
 *   - ディレクトリ構成をツリー表示
 *   - 主要ファイル（.ts/.tsx/.js/.jsx/.py等）を列挙
 *   - tsconfig.json / app.config.ts 等の設定を要約
 */

export type CommandRunner = (cmd: string) => Promise<string>;

/** Escape a string for safe use inside single quotes in shell commands */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// キャッシュ: projectPath -> { content, loadedAt }
const cache = new Map<string, { content: string; loadedAt: number }>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5分
const MAX_CONTEXT_CHARS = 4000; // トークン節約のため上限

/**
 * プロジェクトコンテキストを読み込む。
 * キャッシュがあり有効期限内ならキャッシュを返す。
 */
export async function loadProjectContext(
  projectPath: string,
  runCmd: CommandRunner,
): Promise<string> {
  const cached = cache.get(projectPath);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const escaped = shellEscape(projectPath);
    const raw = await runCmd(`cat '${escaped}/.shelly/context.md' 2>/dev/null || echo ""`);
    const content = raw.trim().slice(0, MAX_CONTEXT_CHARS);

    cache.set(projectPath, { content, loadedAt: Date.now() });
    return content;
  } catch {
    return '';
  }
}

/**
 * キャッシュをクリアする
 */
export function clearProjectContextCache(projectPath?: string): void {
  if (projectPath) {
    cache.delete(projectPath);
  } else {
    cache.clear();
  }
}

/**
 * プロジェクトコンテキストをシステムプロンプトに埋め込む形式にする。
 */
export function buildSystemPromptWithContext(
  basePrompt: string,
  projectContext: string,
): string {
  if (!projectContext) return basePrompt;

  return `${basePrompt}

--- プロジェクトコンテキスト ---
${projectContext}
--- ここまで ---

上記のプロジェクト情報を踏まえて回答してください。`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 自動生成
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * cwdのプロジェクトを走査して .shelly/context.md を自動生成する。
 * ネイティブシェル（JNI forkpty）経由でコマンドを実行する。
 *
 * @returns 生成されたコンテキスト文字列
 */
export async function generateProjectContext(
  projectPath: string,
  runCmd: CommandRunner,
): Promise<string> {
  const lines: string[] = [];

  // ── 1. package.json（Node.js系プロジェクト）──────────────────────────────
  const escaped = shellEscape(projectPath);
  const pkgRaw = await runCmd(`cat '${escaped}/package.json' 2>/dev/null || echo ""`);
  let projectName = projectPath.split('/').pop() ?? 'Unknown';
  let version = '';
  let deps: string[] = [];
  let devDeps: string[] = [];
  let scripts: string[] = [];

  if (pkgRaw.trim() && pkgRaw.trim().startsWith('{')) {
    try {
      const pkg = JSON.parse(pkgRaw.trim());
      projectName = pkg.name ?? projectName;
      version = pkg.version ?? '';
      deps = Object.keys(pkg.dependencies ?? {});
      devDeps = Object.keys(pkg.devDependencies ?? {});
      scripts = Object.keys(pkg.scripts ?? {});
    } catch { /* not valid JSON */ }
  }

  // ── 2. 言語/フレームワーク検出 ────────────────────────────────────────────
  const detectedStack = detectStack(deps, devDeps);

  // ── 3. ディレクトリ構成 ─────────────────────────────────────────────────
  const tree = await runCmd(
    `cd '${escaped}' && find . -maxdepth 2 -type d ` +
    `-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
    `-not -path '*/.expo/*' -not -path '*/dist/*' ` +
    `-not -path '*/__pycache__/*' -not -path '*/.next/*' ` +
    `-not -path '*/build/*' -not -path '*/.shelly/*' ` +
    `2>/dev/null | sort | head -40`,
  );

  // ── 4. 主要ソースファイル ──────────────────────────────────────────────
  const sourceFiles = await runCmd(
    `cd '${escaped}' && find . -maxdepth 3 -type f ` +
    `\\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" ` +
    `-o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.rb" ` +
    `-o -name "*.java" -o -name "*.kt" -o -name "*.swift" \\) ` +
    `-not -path '*/node_modules/*' -not -path '*/.expo/*' ` +
    `-not -path '*/dist/*' -not -path '*/.next/*' ` +
    `-not -path '*/build/*' ` +
    `2>/dev/null | sort | head -60`,
  );

  // ── 5. 設定ファイル検出 ────────────────────────────────────────────────
  const configFiles = await runCmd(
    `cd '${escaped}' && ls -1 ` +
    `tsconfig.json app.config.ts app.config.js next.config.* ` +
    `vite.config.* webpack.config.* Cargo.toml go.mod pyproject.toml ` +
    `setup.py requirements.txt Gemfile Makefile Dockerfile ` +
    `docker-compose.yml .env.example eas.json ` +
    `2>/dev/null`,
  );

  // ── 6. README / PRESENTATION / CLAUDE.md 冒頭（あれば）────────────────
  const readmeSnippet = await runCmd(
    `head -20 '${escaped}/README.md' 2>/dev/null || echo ""`,
  );
  const presentationSnippet = await runCmd(
    `head -30 '${escaped}/PRESENTATION.md' 2>/dev/null || echo ""`,
  );
  const claudeMd = await runCmd(
    `head -30 '${escaped}/CLAUDE.md' 2>/dev/null || echo ""`,
  );

  // ── 7. git情報 ────────────────────────────────────────────────────────
  const gitRemote = await runCmd(
    `cd '${escaped}' && git remote get-url origin 2>/dev/null || echo ""`,
  );
  const gitBranch = await runCmd(
    `cd '${escaped}' && git branch --show-current 2>/dev/null || echo ""`,
  );

  // ── Markdown生成 ──────────────────────────────────────────────────────
  lines.push(`# ${projectName}${version ? ` v${version}` : ''}`);
  lines.push('');

  // プロジェクト概要（PRESENTATION.md > README.md から抽出）
  const overviewSource = presentationSnippet.trim() || readmeSnippet.trim();
  if (overviewSource) {
    const descLines = overviewSource.split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
      .slice(0, 3);
    if (descLines.length > 0) {
      lines.push('## Overview');
      for (const l of descLines) lines.push(l.trim());
      lines.push('');
    }
  }

  // CLAUDE.md（プロジェクトルール・設計方針）
  if (claudeMd.trim()) {
    const claudeLines = claudeMd.trim().split('\n')
      .filter(l => l.trim())
      .slice(0, 10);
    if (claudeLines.length > 0) {
      lines.push('## Project Rules (CLAUDE.md)');
      for (const l of claudeLines) lines.push(l);
      lines.push('');
    }
  }

  if (detectedStack.length > 0) {
    lines.push('## Tech Stack');
    for (const s of detectedStack) lines.push(`- ${s}`);
    lines.push('');
  }

  if (gitRemote.trim()) {
    lines.push(`## Repository`);
    lines.push(`- Remote: ${gitRemote.trim()}`);
    if (gitBranch.trim()) lines.push(`- Branch: ${gitBranch.trim()}`);
    lines.push('');
  }

  if (scripts.length > 0) {
    lines.push('## Scripts');
    for (const s of scripts.slice(0, 15)) lines.push(`- \`${s}\``);
    lines.push('');
  }

  const treeDirs = tree.trim().split('\n').filter(l => l.trim());
  if (treeDirs.length > 0) {
    lines.push('## Directory Structure');
    lines.push('```');
    for (const d of treeDirs) lines.push(d);
    lines.push('```');
    lines.push('');
  }

  const files = sourceFiles.trim().split('\n').filter(l => l.trim());
  if (files.length > 0) {
    lines.push(`## Source Files (${files.length})`);
    for (const f of files) lines.push(`- ${f}`);
    lines.push('');
  }

  const configs = configFiles.trim().split('\n').filter(l => l.trim());
  if (configs.length > 0) {
    lines.push('## Config Files');
    for (const c of configs) lines.push(`- ${c}`);
    lines.push('');
  }

  if (deps.length > 0) {
    lines.push(`## Dependencies (${deps.length})`);
    for (const d of deps.slice(0, 30)) lines.push(`- ${d}`);
    if (deps.length > 30) lines.push(`- ... and ${deps.length - 30} more`);
    lines.push('');
  }

  const context = lines.join('\n').slice(0, MAX_CONTEXT_CHARS);

  // ファイルに書き出し
  await runCmd(`mkdir -p '${escaped}/.shelly'`);
  // ヒアドキュメントだとエスケープが面倒なのでbase64経由で書く
  const b64 = btoa(unescape(encodeURIComponent(context)));
  await runCmd(`echo '${shellEscape(b64)}' | base64 -d > '${escaped}/.shelly/context.md'`);

  // キャッシュ更新
  clearProjectContextCache(projectPath);

  return context;
}

/**
 * 依存関係からテックスタックを推定する
 */
function detectStack(deps: string[], devDeps: string[]): string[] {
  const all = [...deps, ...devDeps];
  const stack: string[] = [];

  // フレームワーク
  if (all.some(d => d === 'expo')) stack.push('Expo');
  if (all.some(d => d === 'react-native')) stack.push('React Native');
  if (all.some(d => d === 'react' && !all.includes('react-native'))) stack.push('React');
  if (all.some(d => d === 'next')) stack.push('Next.js');
  if (all.some(d => d === 'vue')) stack.push('Vue.js');
  if (all.some(d => d === 'nuxt')) stack.push('Nuxt');
  if (all.some(d => d === 'svelte')) stack.push('Svelte');
  if (all.some(d => d === 'express')) stack.push('Express');
  if (all.some(d => d === 'fastify')) stack.push('Fastify');
  if (all.some(d => d === 'hono')) stack.push('Hono');

  // 言語
  if (all.some(d => d === 'typescript')) stack.push('TypeScript');

  // 状態管理
  if (all.some(d => d === 'zustand')) stack.push('Zustand');
  if (all.some(d => d === 'redux' || d === '@reduxjs/toolkit')) stack.push('Redux');
  if (all.some(d => d === 'jotai')) stack.push('Jotai');

  // API
  if (all.some(d => d.startsWith('@trpc/'))) stack.push('tRPC');
  if (all.some(d => d.startsWith('@tanstack/react-query'))) stack.push('TanStack Query');
  if (all.some(d => d.startsWith('@apollo/'))) stack.push('Apollo GraphQL');

  // UI
  if (all.some(d => d === 'nativewind')) stack.push('NativeWind (Tailwind)');
  if (all.some(d => d === 'tailwindcss' && !all.includes('nativewind'))) stack.push('TailwindCSS');
  if (all.some(d => d.startsWith('@mui/'))) stack.push('Material UI');
  if (all.some(d => d.startsWith('chakra'))) stack.push('Chakra UI');

  // DB
  if (all.some(d => d === 'prisma' || d === '@prisma/client')) stack.push('Prisma');
  if (all.some(d => d === 'drizzle-orm')) stack.push('Drizzle ORM');
  if (all.some(d => d === 'mongoose')) stack.push('MongoDB (Mongoose)');

  // Testing
  if (all.some(d => d === 'jest')) stack.push('Jest');
  if (all.some(d => d === 'vitest')) stack.push('Vitest');

  return stack;
}
