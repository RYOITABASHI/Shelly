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

// ─── Registry ─────────────────────────────────────────────────────────────────

export const TEMPLATES: ProjectTemplate[] = [
  webTemplate,
  scriptTemplate,
  documentTemplate,
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
