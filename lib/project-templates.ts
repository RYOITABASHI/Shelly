/**
 * lib/project-templates.ts
 *
 * Project templates for the Creator Engine.
 * Each template defines the files to generate for a given project type.
 * All content is pure string — no external dependencies.
 */

import { ProjectFile, ProjectType } from '@/store/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TemplateContext = {
  projectName: string;    // display name, e.g. "My Portfolio"
  slug: string;           // folder-safe, e.g. "my-portfolio"
  description: string;    // user's original request (1 sentence)
  createdAt: string;      // ISO date string
};

export type ProjectTemplate = {
  type: ProjectType;
  keywords: string[];     // natural language triggers
  label: string;          // human-readable type label
  generate: (ctx: TemplateContext) => ProjectFile[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Web Template ─────────────────────────────────────────────────────────────

const webTemplate: ProjectTemplate = {
  type: 'web',
  label: 'Webアプリ',
  keywords: [
    'web', 'html', 'css', 'js', 'javascript', 'サイト', 'ページ', 'ウェブ',
    'ポートフォリオ', 'portfolio', 'ランディング', 'landing', 'タイマー', 'timer',
    'カウンター', 'counter', 'todo', 'トゥードゥー', 'calculator', '計算機',
    'quiz', 'クイズ', 'game', 'ゲーム', 'clock', '時計',
  ],
  generate: (ctx) => [
    {
      path: 'src/index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ctx.projectName}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <header>
      <h1>${ctx.projectName}</h1>
      <p class="subtitle">${ctx.description}</p>
    </header>

    <main id="app">
      <!-- アプリのコンテンツがここに入ります -->
      <div class="card">
        <p>ここにコンテンツを追加してください。</p>
        <button id="main-btn" class="btn">はじめる</button>
      </div>
    </main>

    <footer>
      <p>Created with Shelly Creator · ${ctx.createdAt}</p>
    </footer>
  </div>
  <script src="app.js"></script>
</body>
</html>
`,
    },
    {
      path: 'src/style.css',
      language: 'css',
      content: `/* ${ctx.projectName} — スタイルシート */
:root {
  --bg: #0a0a0a;
  --surface: #161616;
  --border: #272727;
  --text: #ecedee;
  --muted: #6b7280;
  --accent: #00d4aa;
  --accent-dim: rgba(0, 212, 170, 0.12);
  --error: #f87171;
  --radius: 8px;
  --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.6;
  min-height: 100vh;
}

.container {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
}

header {
  margin-bottom: 32px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 16px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.5px;
}

.subtitle {
  color: var(--muted);
  font-size: 13px;
  margin-top: 4px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  margin-bottom: 16px;
}

.btn {
  background: var(--accent-dim);
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 8px 20px;
  font-family: var(--font);
  font-size: 13px;
  cursor: pointer;
  margin-top: 12px;
  transition: background 0.15s;
}

.btn:hover {
  background: rgba(0, 212, 170, 0.2);
}

footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
`,
    },
    {
      path: 'src/app.js',
      language: 'js',
      content: `// ${ctx.projectName} — メインスクリプト
// Created: ${ctx.createdAt}

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('main-btn');

  btn?.addEventListener('click', () => {
    console.log('ボタンがクリックされました');
    // ここにロジックを追加してください
  });

  console.log('${ctx.projectName} が起動しました');
});
`,
    },
    {
      path: 'README.md',
      language: 'md',
      content: `# ${ctx.projectName}

> ${ctx.description}

## 起動方法

\`\`\`bash
# ブラウザで開く
open src/index.html

# または Live Server で起動
npx live-server src/
\`\`\`

## ファイル構成

\`\`\`
src/
  index.html   ← メインHTML
  style.css    ← スタイルシート
  app.js       ← ロジック
README.md
\`\`\`

## 作成情報

- 作成日: ${ctx.createdAt}
- 作成ツール: Shelly Creator Engine
`,
    },
  ],
};

// ─── Script Template ──────────────────────────────────────────────────────────

const scriptTemplate: ProjectTemplate = {
  type: 'script',
  label: 'スクリプト',
  keywords: [
    'script', 'スクリプト', 'python', 'node', 'nodejs', 'bash', 'sh',
    '自動化', 'automation', 'ツール', 'tool', 'csv', 'json', 'parse',
    '整理', 'sort', 'filter', 'rename', 'リネーム', 'batch', 'バッチ',
    '変換', 'convert', 'scrape', 'スクレイピング',
  ],
  generate: (ctx) => [
    {
      path: 'src/main.py',
      language: 'py',
      content: `#!/usr/bin/env python3
"""
${ctx.projectName}
${ctx.description}

Usage:
    python3 src/main.py [options]

Created: ${ctx.createdAt}
"""

import sys
import os
import json
from pathlib import Path


def main():
    """メイン処理"""
    print(f"[${ctx.slug}] 起動しました")

    # ここにメインロジックを追加してください
    args = sys.argv[1:]
    if not args:
        print("使い方: python3 src/main.py <引数>")
        return

    for arg in args:
        process(arg)


def process(item: str) -> None:
    """個別アイテムの処理"""
    print(f"  処理中: {item}")
    # TODO: 実装してください


if __name__ == "__main__":
    main()
`,
    },
    {
      path: 'src/utils.py',
      language: 'py',
      content: `"""
ユーティリティ関数
"""

import json
from pathlib import Path
from typing import Any


def read_json(path: str) -> Any:
    """JSONファイルを読み込む"""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_json(path: str, data: Any, indent: int = 2) -> None:
    """JSONファイルに書き込む"""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)


def ensure_dir(path: str) -> None:
    """ディレクトリを作成する（存在する場合はスキップ）"""
    Path(path).mkdir(parents=True, exist_ok=True)
`,
    },
    {
      path: 'README.md',
      language: 'md',
      content: `# ${ctx.projectName}

> ${ctx.description}

## 実行方法

\`\`\`bash
python3 src/main.py
\`\`\`

## 依存関係

標準ライブラリのみ使用。追加パッケージが必要な場合:

\`\`\`bash
pip install -r requirements.txt
\`\`\`

## ファイル構成

\`\`\`
src/
  main.py    ← メインスクリプト
  utils.py   ← ユーティリティ関数
README.md
\`\`\`

## 作成情報

- 作成日: ${ctx.createdAt}
- 作成ツール: Shelly Creator Engine
`,
    },
  ],
};

// ─── Document Template ────────────────────────────────────────────────────────

const documentTemplate: ProjectTemplate = {
  type: 'document',
  label: 'ドキュメント',
  keywords: [
    'document', 'ドキュメント', 'markdown', 'md', 'readme', 'note', 'メモ',
    'report', 'レポート', 'spec', '仕様', 'design', '設計', 'api', 'wiki',
    'json', 'config', '設定ファイル', 'template', 'テンプレート',
  ],
  generate: (ctx) => [
    {
      path: 'README.md',
      language: 'md',
      content: `# ${ctx.projectName}

> ${ctx.description}

---

## 概要

ここに概要を記入してください。

## 目的

- 目的1
- 目的2
- 目的3

## 内容

### セクション1

内容を記入してください。

### セクション2

内容を記入してください。

## 参考

- [参考リンク1](https://example.com)

---

*作成日: ${ctx.createdAt} — Shelly Creator Engine*
`,
    },
    {
      path: 'notes.md',
      language: 'md',
      content: `# メモ — ${ctx.projectName}

## TODO

- [ ] 項目1
- [ ] 項目2
- [ ] 項目3

## アイデア

- アイデア1
- アイデア2

---
*更新日: ${ctx.createdAt}*
`,
    },
    {
      path: 'config.json',
      language: 'json',
      content: JSON.stringify(
        {
          name: ctx.slug,
          version: '1.0.0',
          description: ctx.description,
          createdAt: ctx.createdAt,
          settings: {},
        },
        null,
        2
      ),
    },
  ],
};

// ─── API Template ────────────────────────────────────────────────────────────

const apiTemplate: ProjectTemplate = {
  type: 'api',
  label: 'API サーバー',
  keywords: [
    'api', 'server', 'サーバー', 'rest', 'express', 'fastify', 'backend',
    'バックエンド', 'endpoint', 'エンドポイント',
  ],
  generate: (ctx) => [
    {
      path: 'package.json',
      language: 'json',
      content: JSON.stringify({
        name: ctx.slug,
        version: '1.0.0',
        description: ctx.description,
        main: 'src/index.js',
        scripts: {
          start: 'node src/index.js',
          dev: 'node --watch src/index.js',
        },
        dependencies: { express: '^4.18.0', cors: '^2.8.5' },
      }, null, 2),
    },
    {
      path: 'src/index.js',
      language: 'javascript',
      content: `const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: '${ctx.projectName}' });
});

app.get('/api/items', (req, res) => {
  res.json({ items: [], total: 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`${ctx.projectName} running on http://localhost:\${PORT}\`);
});
`,
    },
    {
      path: 'README.md',
      language: 'markdown',
      content: `# ${ctx.projectName}\n\n${ctx.description}\n\n## Usage\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
    },
  ],
};

// ─── CLI Template ────────────────────────────────────────────────────────────

const cliTemplate: ProjectTemplate = {
  type: 'cli',
  label: 'CLI ツール',
  keywords: [
    'cli', 'command', 'コマンド', 'tool', 'ツール', 'terminal', 'ターミナル',
    'commander', 'bin',
  ],
  generate: (ctx) => [
    {
      path: 'package.json',
      language: 'json',
      content: JSON.stringify({
        name: ctx.slug,
        version: '1.0.0',
        description: ctx.description,
        bin: { [ctx.slug]: './src/cli.js' },
        scripts: { start: 'node src/cli.js' },
        dependencies: { commander: '^12.0.0', chalk: '^5.3.0' },
      }, null, 2),
    },
    {
      path: 'src/cli.js',
      language: 'javascript',
      content: `#!/usr/bin/env node
const { Command } = require('commander');

const program = new Command();

program
  .name('${ctx.slug}')
  .description('${ctx.description}')
  .version('1.0.0');

program
  .command('run')
  .description('Run the main command')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => {
    console.log('${ctx.projectName} is running...');
    if (options.verbose) console.log('Verbose mode enabled');
  });

program.parse();
`,
    },
    {
      path: 'README.md',
      language: 'markdown',
      content: `# ${ctx.projectName}\n\n${ctx.description}\n\n## Usage\n\n\`\`\`bash\nnpm install\nnode src/cli.js run\n\`\`\`\n`,
    },
  ],
};

// ─── Mobile Template ─────────────────────────────────────────────────────────

const mobileTemplate: ProjectTemplate = {
  type: 'mobile',
  label: 'モバイルアプリ',
  keywords: [
    'mobile', 'モバイル', 'app', 'アプリ', 'expo', 'react native',
    'android', 'ios', 'スマホ', 'smartphone',
  ],
  generate: (ctx) => [
    {
      path: 'package.json',
      language: 'json',
      content: JSON.stringify({
        name: ctx.slug,
        version: '1.0.0',
        main: 'expo/AppEntry.js',
        scripts: {
          start: 'expo start',
          android: 'expo start --android',
        },
        dependencies: {
          expo: '~54.0.0',
          'expo-status-bar': '~2.2.0',
          react: '19.0.0',
          'react-native': '0.81.0',
        },
      }, null, 2),
    },
    {
      path: 'App.js',
      language: 'javascript',
      content: `import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>${ctx.projectName}</Text>
      <Text style={styles.subtitle}>${ctx.description}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888' },
});
`,
    },
    {
      path: 'app.json',
      language: 'json',
      content: JSON.stringify({
        expo: {
          name: ctx.projectName,
          slug: ctx.slug,
          version: '1.0.0',
          platforms: ['android'],
        },
      }, null, 2),
    },
  ],
};

// ─── Static Template ─────────────────────────────────────────────────────────

const staticTemplate: ProjectTemplate = {
  type: 'static',
  label: '静的サイト',
  keywords: [
    'static', '静的', 'astro', 'hugo', 'blog', 'ブログ', 'jekyll',
    'gatsby', 'ssg',
  ],
  generate: (ctx) => [
    {
      path: 'index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ctx.projectName}</title>
  <style>
    :root { --bg: #0a0a0a; --fg: #e8e8e8; --accent: #00D4AA; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; }
    .hero { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; padding: 2rem; }
    h1 { font-size: 3rem; margin-bottom: 1rem; background: linear-gradient(135deg, var(--accent), #3B82F6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { color: #888; max-width: 40ch; text-align: center; line-height: 1.6; }
    .posts { max-width: 720px; margin: 0 auto; padding: 2rem; }
    .post { border-bottom: 1px solid #222; padding: 1.5rem 0; }
    .post h2 { font-size: 1.3rem; margin-bottom: 0.5rem; }
    .post time { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>${ctx.projectName}</h1>
    <p>${ctx.description}</p>
  </div>
  <section class="posts">
    <article class="post">
      <h2>First Post</h2>
      <time>${ctx.createdAt}</time>
      <p>Welcome to ${ctx.projectName}.</p>
    </article>
  </section>
</body>
</html>
`,
    },
    {
      path: 'README.md',
      language: 'markdown',
      content: `# ${ctx.projectName}\n\n${ctx.description}\n\nOpen \`index.html\` in a browser to preview.\n`,
    },
  ],
};

// ─── Wizard Step Types ───────────────────────────────────────────────────────

export type WizardStepInput = 'text' | 'select';

export type WizardSelectOption = {
  label: string;
  value: string;
};

export type WizardStep = {
  key: string;
  question: string;
  inputType: WizardStepInput;
  options?: WizardSelectOption[];
  required: boolean;
};

export type TemplateWithWizard = ProjectTemplate & {
  icon: string;
  wizardSteps: WizardStep[];
};

export const TEMPLATE_GALLERY: TemplateWithWizard[] = [
  {
    ...webTemplate,
    icon: 'language',
    wizardSteps: [
      { key: 'who_uses', question: '誰が使いますか？', inputType: 'text', required: true },
      { key: 'main_feature', question: 'メイン機能は？', inputType: 'text', required: true },
      { key: 'style', question: 'デザインの方向性は？', inputType: 'select', options: [
        { label: 'モダン', value: 'modern' },
        { label: 'ミニマル', value: 'minimal' },
        { label: 'ポップ', value: 'playful' },
      ], required: false },
    ],
  },
  {
    ...apiTemplate,
    icon: 'cloud',
    wizardSteps: [
      { key: 'what_data', question: 'どんなデータを扱う？', inputType: 'text', required: true },
      { key: 'auth', question: '認証は必要？', inputType: 'select', options: [
        { label: 'なし', value: 'none' },
        { label: 'APIキー', value: 'api-key' },
        { label: 'JWT', value: 'jwt' },
      ], required: false },
    ],
  },
  {
    ...cliTemplate,
    icon: 'terminal',
    wizardSteps: [
      { key: 'purpose', question: '何をするCLIツール？', inputType: 'text', required: true },
      { key: 'input', question: '入力は何？', inputType: 'select', options: [
        { label: 'ファイル', value: 'file' },
        { label: 'テキスト引数', value: 'args' },
        { label: '対話式', value: 'interactive' },
      ], required: false },
    ],
  },
  {
    ...mobileTemplate,
    icon: 'phone-android',
    wizardSteps: [
      { key: 'target', question: '何のアプリ？', inputType: 'text', required: true },
      { key: 'screens', question: '最初の画面は？', inputType: 'text', required: true },
    ],
  },
  {
    ...staticTemplate,
    icon: 'web',
    wizardSteps: [
      { key: 'topic', question: 'テーマは？', inputType: 'text', required: true },
      { key: 'pages', question: '最初に何ページ作る？', inputType: 'select', options: [
        { label: '1ページ', value: '1' },
        { label: '3ページ', value: '3' },
        { label: '5ページ', value: '5' },
      ], required: false },
    ],
  },
  {
    ...scriptTemplate,
    icon: 'code',
    wizardSteps: [
      { key: 'task', question: '何をするスクリプト？', inputType: 'text', required: true },
    ],
  },
  {
    ...documentTemplate,
    icon: 'description',
    wizardSteps: [
      { key: 'doctype', question: '何のドキュメント？', inputType: 'text', required: true },
    ],
  },
];

// ─── Registry ─────────────────────────────────────────────────────────────────

export const TEMPLATES: ProjectTemplate[] = [
  webTemplate,
  scriptTemplate,
  documentTemplate,
  apiTemplate,
  cliTemplate,
  mobileTemplate,
  staticTemplate,
];

/**
 * Detect the most likely project type from a natural language prompt.
 */
export function detectProjectType(input: string): ProjectType {
  const lower = input.toLowerCase();

  for (const template of TEMPLATES) {
    if (template.keywords.some((kw) => lower.includes(kw))) {
      return template.type;
    }
  }

  return 'web'; // default
}

/**
 * Get the template for a given project type.
 */
export function getTemplate(type: ProjectType): ProjectTemplate {
  return TEMPLATES.find((t) => t.type === type) ?? webTemplate;
}

/**
 * Convert a natural language string to a URL/folder-safe slug.
 * e.g. "写真整理ツール" → "photo-organizer-tool" (falls back to timestamp)
 */
export function toSlug(input: string): string {
  // Try to extract ASCII words first
  const ascii = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-');

  if (ascii.length >= 3) return ascii;

  // Fallback: timestamp-based
  return `project-${Date.now().toString(36)}`;
}

/**
 * Generate a human-readable project name from user input.
 */
export function toProjectName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 30) return trimmed;
  return trimmed.slice(0, 27) + '…';
}

/**
 * Build the project folder path.
 * Format: Projects/YYYY-MM-DD_slug
 */
export function buildProjectPath(slug: string): string {
  const date = today();
  return `Projects/${date}_${slug}`;
}
