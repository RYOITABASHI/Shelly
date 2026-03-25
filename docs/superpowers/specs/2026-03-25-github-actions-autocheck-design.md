# GitHub Actions Auto-check + Advanced Wizard — Design Spec

## Overview

Shellyに「自動チェック」機能を導入する。ユーザーはCI/CD・GitHub Actions・ワークフローという概念を知らなくても、コードが壊れていないか自動で確認してもらえる。

裏では`.github/workflows/ci.yml`が生成されGitHub Actionsが実行されるが、ユーザーにはCI用語を一切見せない。

## 設計思想

- **「CI」「ビルド」「ワークフロー」等の専門用語は使わない**
- ゼロ状態ユーザーには「自動チェック」「壊れてないか確認」「お知らせ」で案内
- セーブポイントが `git commit` を「💾セーブした」に翻訳したのと同じアプローチ
- 上級者は Settings から 3ステップウィザードで詳細カスタマイズ可能

## 2層構造

### Layer 1: AutoCheckProposalBubble（初心者向け）

**トリガー**: `git push` コマンドがシェル実行で成功した後、800ms遅延で表示。

**表示条件**:
- セッション内で一度だけ（`autoCheckShownRef`）
- AsyncStorage `shelly_autocheck_offered` が未設定

**UI**:
```
┌──────────────────────────────────────┐
│ ✓ 自動チェックが使えます             │
│                                      │
│ GitHubに保存するたびに、コードが     │
│ 壊れてないか自動でチェックできます。 │
│ 結果はこのチャットでお知らせします。 │
│                                      │
│              [あとで]  [⚡ つける]    │
└──────────────────────────────────────┘
```

**「つける」タップ時**:
1. `autoCheckState` → `'setting_up'`（ローディング表示）
2. `detectProjectTypeFromDir()` でプロジェクト種別を自動検出
3. デフォルト設定（build + test, on push）で `generateWorkflowFromWizard()` 実行
4. `commitAndPushWorkflow()` で `.github/workflows/ci.yml` を commit + push
5. 成功 → `autoCheckState` → `'done'`
6. AsyncStorage `shelly_autocheck_offered` = `'true'`

**「あとで」タップ時**:
- `autoCheckState` → `'dismissed'`（バブル非表示）
- AsyncStorage `shelly_autocheck_offered` = `'true'`（再表示しない）

### Layer 2: ActionsWizardBubble（上級者向け / Settings）

**起動**: Settings画面 → 「自動チェックの設定」セクション → ボタンタップ

**3ステップ**:

```
Step 1: 何をチェックする？（複数選択OK）
  [✅ ビルド確認] [✅ テスト実行] [デプロイ] [リリース作成]

Step 2: いつチェックする？
  [● 保存するたびに] [○ 1日1回] [○ 自分で指示したときだけ]

Step 3: これでOK？
  ・チェック内容: ビルド確認, テスト実行
  ・タイミング: 保存するたびに
  ・結果はチャットに表示
  [やり直す]  [🚀 設定する]
```

**「設定する」タップ時**:
1. `generateWorkflowFromWizard()` で選択内容からYAML生成
2. `commitAndPushWorkflow()` で commit + push
3. Settings内のモーダルに成功/失敗表示

## ワークフロー生成

### `generateWorkflowFromWizard(data)`

入力の `ActionsWizardData` から `.github/workflows/ci.yml` を生成。

**Actions mapping**:
| 選択肢 | YAML内容 |
|--------|----------|
| build | `npm run build` / `python setup.py build` |
| test | `npm test` / `python -m pytest` |
| deploy | 別ジョブ `deploy:` (needs: ci, main branch only) |
| release | 別ジョブ `release:` (needs: ci, tag trigger) |

**Trigger mapping**:
| 選択肢 | YAML `on:` |
|--------|------------|
| push | `push: branches: [main]` + `pull_request: branches: [main]` |
| daily | `schedule: cron: '0 0 * * *'` + `workflow_dispatch:` |
| manual | `workflow_dispatch:` |

**プロジェクト種別自動検出** (`detectProjectTypeFromDir`):
- `package.json` あり → `node` (Node.js 20, npm ci)
- `requirements.txt` / `setup.py` / `pyproject.toml` あり → `python` (Python 3.12)
- それ以外 → `unknown` (checkout のみ)

### `commitAndPushWorkflow(params)`

1. `mkdir -p .github/workflows/`
2. YAML を `ci.yml` に書き込み
3. `git add .github/workflows/ci.yml`
4. `git commit -m "ci: add GitHub Actions workflow (via Shelly)"`
5. `git push origin main`

## データモデル

### ChatMessage 拡張

```typescript
// Auto-check proposal state
autoCheckState?: 'proposal' | 'setting_up' | 'done' | 'dismissed' | 'error';

// Advanced wizard
wizardType?: 'actions';
wizardData?: ActionsWizardData;
```

### ActionsWizardData

```typescript
type ActionsWizardData = {
  step: 'what' | 'when' | 'confirm' | 'done';
  actions: Array<'build' | 'test' | 'deploy' | 'release'>;
  trigger: 'push' | 'daily' | 'manual' | null;
  projectType?: string;
};
```

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `components/chat/AutoCheckProposalBubble.tsx` | ワンタップ提案UI |
| `components/chat/ActionsWizardBubble.tsx` | 上級者3ステップウィザードUI |
| `lib/github-actions.ts` | YAML生成 + commit+push + プロジェクト検出 |
| `lib/github-auth.ts` | PAT管理（既存） |
| `lib/github-push.ts` | push処理（既存） |
| `store/chat-store.ts` | 型定義（AutoCheckState, ActionsWizardData） |
| `app/(tabs)/index.tsx` | push成功検出 → 提案挿入 → ハンドラ |
| `app/(tabs)/settings.tsx` | 上級者ウィザードモーダル |

## i18n

`autocheck.*` (10キー) + `wizard.*` (25キー) — en.ts / ja.ts 両対応。

自然言語のみ。例:
- EN: "Want to automatically check if your code is working every time you save to GitHub?"
- JA: "GitHubに保存するたびに、コードが壊れてないか自動でチェックできます。"

## 未実装（次期）

- `getLatestWorkflowRun()` 結果のチャット内ポーリング → 結果通知バブル
- ビルド失敗時の自動修正提案（AI連携）
- 複数ワークフロー管理（ci.yml以外）
