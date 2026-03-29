/**
 * lib/creator-engine.ts
 *
 * Pure functions for the Creator Engine.
 * - createProject: generate a CreatorProject from user input
 * - buildCompletionMessage: natural language result message
 * - buildRecipeCommand: snippet command for re-creating the project
 * - buildRunCommand: command to open/serve the project
 */

import {
  CreatorProject,
  CreatorPlan,
  BuildStep,
  ProjectFile,
  ProjectType,
} from '@/store/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ProjectType, string> = {
  web: 'Webサイト',
  script: 'スクリプト',
  document: 'ドキュメント',
  api: 'APIサーバー',
  cli: 'CLIツール',
  mobile: 'モバイルアプリ',
  static: '静的サイト',
  unknown: 'プロジェクト',
};

// ─── Slug / ID helpers ────────────────────────────────────────────────────────

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

function generateId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function todayStr(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// ─── Project type detection ───────────────────────────────────────────────────

function detectProjectType(input: string): ProjectType {
  const lower = input.toLowerCase();
  if (
    lower.includes('html') ||
    lower.includes('web') ||
    lower.includes('サイト') ||
    lower.includes('ページ') ||
    lower.includes('ホームページ') ||
    lower.includes('ランディング') ||
    lower.includes('portfolio') ||
    lower.includes('css')
  ) {
    return 'web';
  }
  if (
    lower.includes('script') ||
    lower.includes('python') ||
    lower.includes('node') ||
    lower.includes('スクリプト') ||
    lower.includes('自動化') ||
    lower.includes('ツール') ||
    lower.includes('cli') ||
    lower.includes('bot')
  ) {
    return 'script';
  }
  if (
    lower.includes('readme') ||
    lower.includes('markdown') ||
    lower.includes('json') ||
    lower.includes('ドキュメント') ||
    lower.includes('文書') ||
    lower.includes('メモ')
  ) {
    return 'document';
  }
  return 'web'; // default to web
}

// ─── Scaffold generators ──────────────────────────────────────────────────────

function generateWebFiles(name: string, input: string): ProjectFile[] {
  return [
    {
      path: 'index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>${name}</h1>
  <p>${input}</p>
  <script src="main.js"></script>
</body>
</html>`,
    },
    {
      path: 'style.css',
      language: 'css',
      content: `* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0a0a0a;
  color: #e8e8e8;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
h1 {
  color: #00D4AA;
  margin-bottom: 1rem;
}`,
    },
    {
      path: 'main.js',
      language: 'js',
      content: `// ${name}\nconsole.log('${name} loaded');`,
    },
  ];
}

function generateScriptFiles(name: string, input: string): ProjectFile[] {
  return [
    {
      path: 'main.py',
      language: 'py',
      content: `#!/usr/bin/env python3\n"""${name} - ${input}"""\n\ndef main():\n    print("${name}")\n\nif __name__ == "__main__":\n    main()`,
    },
    {
      path: 'README.md',
      language: 'md',
      content: `# ${name}\n\n${input}\n\n## Usage\n\n\`\`\`bash\npython3 main.py\n\`\`\``,
    },
  ];
}

function generateDocumentFiles(name: string, input: string): ProjectFile[] {
  return [
    {
      path: 'README.md',
      language: 'md',
      content: `# ${name}\n\n${input}`,
    },
  ];
}

function generateFiles(type: ProjectType, name: string, input: string): ProjectFile[] {
  switch (type) {
    case 'web':
      return generateWebFiles(name, input);
    case 'script':
      return generateScriptFiles(name, input);
    case 'document':
      return generateDocumentFiles(name, input);
    default:
      return generateWebFiles(name, input);
  }
}

// ─── Build steps ──────────────────────────────────────────────────────────────

function generateBuildSteps(files: ProjectFile[]): BuildStep[] {
  const now = Date.now();
  const steps: BuildStep[] = [
    {
      id: `step_${now}_0`,
      message: 'プロジェクトフォルダを作成',
      command: 'mkdir -p',
      status: 'pending',
      timestamp: now,
    },
  ];

  files.forEach((f, i) => {
    steps.push({
      id: `step_${now}_${i + 1}`,
      message: `${f.path} を生成`,
      command: `write ${f.path}`,
      status: 'pending',
      timestamp: now,
    });
  });

  steps.push({
    id: `step_${now}_${files.length + 1}`,
    message: '完了チェック',
    status: 'pending',
    timestamp: now,
  });

  return steps;
}

// ─── Plan generation ──────────────────────────────────────────────────────────

function generatePlan(
  input: string,
  type: ProjectType,
  name: string,
  files: ProjectFile[]
): CreatorPlan {
  const typeLabel = TYPE_LABELS[type];
  return {
    summary: `「${input}」を${typeLabel}として作るよ。`,
    steps: [
      `プロジェクトフォルダ ${name} を作成`,
      ...files.map((f) => `${f.path} を生成`),
      '完了チェック',
    ],
    projectType: type,
    projectName: name,
    estimatedFiles: files.length,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new CreatorProject from user input.
 * Generates plan, files, and build steps.
 */
export function createProject(userInput: string): CreatorProject {
  const type = detectProjectType(userInput);
  const slug = toSlug(userInput);
  const name = userInput.slice(0, 60).trim() || 'New Project';
  const files = generateFiles(type, name, userInput);
  const plan = generatePlan(userInput, type, slug, files);
  const buildSteps = generateBuildSteps(files);
  const date = todayStr();

  return {
    id: generateId(),
    name,
    slug,
    projectType: type,
    createdAt: Date.now(),
    path: `${date}_${slug}`,
    files,
    status: 'building',
    userInput,
    plan,
    buildSteps,
    suggestions: [
      'ブラウザで開く',
      'ファイルを編集',
      'Terminalでコマンド実行',
    ],
  };
}

/**
 * Generate the natural language completion message shown in the Result lane.
 */
export function buildCompletionMessage(project: CreatorProject): string {
  const typeLabel = TYPE_LABELS[project.projectType];
  return `${project.name}の${typeLabel}を作ったよ 🎉`;
}

/**
 * Generate a recipe command that can recreate this project.
 * Stored as a Snippet with tag "recipe".
 */
export function buildRecipeCommand(project: CreatorProject): string {
  return `# Recipe: ${project.name}\n# Type: ${project.projectType}\n# Created: ${new Date(project.createdAt).toISOString()}\n# Original: ${project.userInput}`;
}

/**
 * Generate a command to open/serve the project in the terminal.
 */
export function buildRunCommand(project: CreatorProject): string {
  const dir = `~/Projects/${project.path}`;
  switch (project.projectType) {
    case 'web':
      return `cd ${dir} && python3 -m http.server 8080`;
    case 'script':
      return `cd ${dir} && python3 main.py`;
    case 'document':
      return `cd ${dir} && cat README.md`;
    default:
      return `cd ${dir} && ls -la`;
  }
}
