# Termux Pain Killer — Design Spec

> Shellyがターミナルアプリとして Termux を超えるための統合改修。
> Termuxユーザーの不満12カテゴリを分析し、Shellyの設計思想（非エンジニア向け・自然言語ファースト・Termuxの存在を消す）に沿う形で解決する。
>
> Created: 2026-03-30
> Prerequisites: Expo 54 / RN 0.81 / TypeScript / NativeWind / Zustand
> Spec: `docs/superpowers/specs/2026-03-30-universal-preview-design.md` 完了後

---

## 0. 設計原則 — Shellyの3本柱から逆算する

| Shellyの原則 | この改修での適用 |
|-------------|----------------|
| **Termuxの存在を消す** | ユーザーは「ターミナルコマンド」を知る必要がない。パッケージ管理もミラー選択もTermux特有の作法もUI裏で吸収する |
| **自然言語オンリー** | VoiceChatとChainが全てのターミナル操作に接続される。コマンドを打てない人でも声で操作できる |
| **5分以内セットアップ** | 初回起動後にストレージ許可、パッケージ更新、プロセスキル対策まで自動で完了。ユーザーの操作は「次へ」ボタンのみ |

---

## 1. VoiceChain — 音声↔ターミナル統合

### 1.1 Problem

現在のVoiceChatは **独立したAIチャット** にすぎない。Gemini APIと会話するだけで、ターミナルの状態を見ない、コマンドを実行しない。これはShellyの「自然言語でターミナルを操作する」ビジョンの未完成部分。

Termuxユーザーの不満「タッチスクリーンでのコマンド入力が苦痛」（日本語フォーラムで高齢者ユーザーからの声多数）に対する根本解決でもある。

### 1.2 Design Decision

VoiceChatを **VoiceChain** に進化させる。音声→テキスト変換後の処理をinput-routerに接続し、ターミナルコマンドの実行・結果の読み上げまでをワンフローで行う。

```
ユーザー音声
  ↓ Groq Whisper / Gemini Flash
テキスト化
  ↓ parseInput() [既存 input-router]
  ├── Layer 4: Shell command → bridge.runRawCommand() → 結果をTTS読み上げ
  ├── Layer 4.5: Lightweight → 直接実行 → 結果をTTS読み上げ
  ├── Layer 1-3: AI prompt → AI応答 → TTS読み上げ（現行VoiceChat動作）
  └── Terminal reference → 出力バッファ注入 → AI応答 → TTS読み上げ
```

### 1.3 Changes

**Modified: `hooks/use-voice-chat.ts`**

追加フィールド:
```typescript
// 既存のsendToAI()をsendToRouter()に置き換え
const sendToRouter = async (transcript: string) => {
  const parsed = parseInput(transcript);

  if (parsed.layer === 'command' || parsed.layer === 'lightweight') {
    // ターミナルコマンド → Bridge実行
    setStatus('thinking');
    const result = await runRawCommand(parsed.prompt);
    const output = result.stdout?.trim() || result.stderr?.trim() || 'Done.';
    // 出力を要約してTTS（長い出力はAIで要約）
    const spoken = output.length > 200
      ? await summarizeForSpeech(output)
      : output;
    setResponse(spoken);
    setStatus('speaking');
    await speakText(spoken);
  } else {
    // AI prompt → 既存フロー（ただしターミナル出力コンテキストを注入）
    const terminalContext = getTerminalOutputContext(); // 既存cross-pane
    await sendToAI(transcript, terminalContext);
  }
};
```

**追加: `summarizeForSpeech()` ヘルパー**
- 長い出力（ls -laの結果、git log等）を音声向けに要約
- 「12個のファイルがあります。一番大きいのはnode_modulesで200MB」のような自然な日本語/英語
- 既存のGemini/Groqを使用（1行プロンプト: "Summarize this terminal output for voice reading in 2 sentences: {output}"）

**Modified: `components/VoiceChat.tsx`**

- ステータス表示にコマンド実行状態を追加: `'executing'` (ターミナルアイコン + 回転アニメーション)
- 実行されたコマンドをトランスクリプト下に `$ command` で表示
- 結果プレビュー（3行まで）をレスポンス表示エリアに

**Modified: `app/(tabs)/terminal.tsx`**

- VoiceChatの起動元をターミナル画面にも配置（現状もあるがルーティングが未接続）
- VoiceChainモード時、実行されたコマンドはターミナルにも反映（`writeToSession()`）

### 1.4 UX Flow

```
ユーザー: 🎤「このフォルダのファイル見せて」
  ↓ Whisper: "このフォルダのファイル見せて"
  ↓ parseInput → Layer 4.5: lightweight → "ls -la"
  ↓ bridge.runRawCommand("ls -la")
  ↓ 結果: "total 48\ndrwxr-xr-x ..."
  ↓ summarizeForSpeech → "12個のファイルがあります。フォルダが3つ、コードファイルが9つです"
  ↓ TTS読み上げ
  ↓ ターミナルにも "ls -la" が表示される
```

```
ユーザー: 🎤「右のエラー直して」
  ↓ Whisper: "右のエラー直して"
  ↓ parseInput → terminal reference detected
  ↓ output buffer injected → AI応答 → TTS読み上げ + ActionBlock生成
  ↓ 「このエラーはimportパスの間違いです。修正コマンドを実行しますか？」
  ↓ ユーザー: 🎤「うん」→ コマンド実行
```

---

## 2. SmartKeyBar — コンテキスト適応キーバー

### 2.1 Problem

Termux不満: 「Android標準キーボードにEsc/Ctrl/Alt/Tabがない」「Extra keys barが邪魔」「外付けキーボード時もExtra keysが消えない」。

現在のCommandKeyBarは7キー固定（Ctrl+C, Tab, ↑, ↓, Paste, Alt, Enter）。状況に応じた変化がない。

### 2.2 Design Decision

| Decision | Choice | Rationale |
|----------|--------|-----------|
| キー切替方式 | PTY出力パターン検出 + 手動切替 | 自動検出のみだと誤判定あり、手動でオーバーライド可能に |
| キーセット数 | 5セット (Default, Vim, Git, REPL, Navigate) | 主要ユースケースをカバー、多すぎると混乱 |
| 外付けキーボード検出 | KeyboardEvent.META判定 + 設定 | ハードウェアキーボード接続時は自動非表示 |
| レイアウト | 横スクロール + ページインジケーター | 1行に7キー、スワイプで次セット |

### 2.3 Key Sets

```typescript
type KeySet = 'default' | 'vim' | 'git' | 'repl' | 'navigate';

const KEY_SETS: Record<KeySet, KeyConfig[]> = {
  default: [
    { label: 'Ctrl+C', key: '\x03' },
    { label: 'Tab', key: '\t' },
    { label: '↑', key: '\x1b[A' },
    { label: '↓', key: '\x1b[B' },
    { label: 'Paste', action: 'paste' },
    { label: 'Alt', action: 'alt-toggle' },
    { label: '⏎', key: '\r' },
  ],
  vim: [
    { label: 'Esc', key: '\x1b' },
    { label: ':w', key: ':w\r' },
    { label: ':q', key: ':q\r' },
    { label: ':wq', key: ':wq\r' },
    { label: 'dd', key: 'dd' },
    { label: 'u', key: 'u' },
    { label: 'Ctrl+R', key: '\x12' },
  ],
  git: [
    { label: 'status', key: 'git status\r' },
    { label: 'diff', key: 'git diff\r' },
    { label: 'add .', key: 'git add .\r' },
    { label: 'commit', key: 'git commit -m "' },
    { label: 'push', key: 'git push\r' },
    { label: 'log', key: 'git log --oneline -10\r' },
    { label: 'stash', key: 'git stash\r' },
  ],
  repl: [
    { label: 'Tab', key: '\t' },
    { label: '↑', key: '\x1b[A' },
    { label: 'Ctrl+C', key: '\x03' },
    { label: 'Ctrl+D', key: '\x04' },
    { label: 'Ctrl+L', key: '\x0c' },
    { label: 'Paste', action: 'paste' },
    { label: '⏎', key: '\r' },
  ],
  navigate: [
    { label: '←', key: '\x1b[D' },
    { label: '→', key: '\x1b[C' },
    { label: 'Home', key: '\x1b[H' },
    { label: 'End', key: '\x1b[F' },
    { label: 'PgUp', key: '\x1b[5~' },
    { label: 'PgDn', key: '\x1b[6~' },
    { label: 'Del', key: '\x1b[3~' },
  ],
};
```

### 2.4 Auto-Detection

```typescript
const VIM_PATTERNS = [/vim\s|nvim\s|vi\s/, /~\s+\d+,\d+\s+\w+$/]; // prompt line
const GIT_PATTERNS = [/\$ git\s/, /On branch\s/, /Changes not staged/];
const REPL_PATTERNS = [/^>>>/, /^In \[\d+\]/, /^irb/, /^>\s*$/, /node>/];

// PTY出力の最新5行をチェック → マッチしたらキーセット提案（バッジ表示）
// ユーザーがタップで確定 or 無視で現状維持（自動切替はしない）
```

### 2.5 外付けキーボード自動検出

```typescript
// KeyboardAvoidingView + Keyboard.addListener で高さ0を検出
// → ソフトウェアキーボードが出ていない = 外付け可能性
// settings-storeに「外付けキーボード時にKeyBar非表示」オプション追加
```

### 2.6 ピンチズームロック

settings-storeに `fontSizeLocked: boolean` 追加。`true` の場合、NativeTerminalViewのピンチジェスチャーを無効化。設定画面のフォントサイズスライダーでのみ変更可能。

---

## 3. ClipboardPlus — スマートクリップボード

### 3.1 Problem

Termux不満 #2: 「Ctrl+C=SIGINT。長押しペーストが不安定。外付けキーボードで効かない。Samsung DeXで壊れる」。

### 3.2 Design Decision

| Decision | Choice | Rationale |
|----------|--------|-----------|
| テキスト選択 | NativeTerminalView側のロングプレス検出 + 選択ハンドル | Android標準のテキスト選択UX |
| コピー | 選択確定時にフローティングツールバー (Copy / Share / Preview) | Androidの標準アクションモード |
| ペースト | CommandKeyBar常設 + 外付けキーボードCtrl+Shift+V | 最も要望の多かった改善 |
| 出力のタップ可能化 | URL/パス検出 + タップハンドラ | Warp/iTerm2のスタンダード機能 |

### 3.3 Implementation

**A. ターミナル出力のリンク化** (JS Bridge)

NativeTerminalView (Kotlin) の描画後処理としてはコスト高。代わりにPTY出力のテキストバッファを解析してリンク領域を特定する。

```typescript
// lib/terminal-link-detector.ts
const URL_PATTERN = /https?:\/\/[^\s)"']+/g;
const FILE_PATH_PATTERN = /(?:^|\s)((?:\/|\.\/|~\/)[^\s:]+\.[a-zA-Z0-9]+)/g;
const ERROR_LOCATION = /([^\s:]+):(\d+):(\d+)/g; // file:line:col

export type TerminalLink = {
  text: string;
  startCol: number;
  endCol: number;
  row: number;
  type: 'url' | 'file' | 'error-location';
};
```

タップ時のアクション:
- URL → PreviewTabs WebTabで開く or 外部ブラウザ
- ファイルパス → PreviewTabs FilesTabで開く
- error-location → CodeTabで該当行にジャンプ

**B. Ctrl+Shift+C/V インターセプト**

TerminalView.kt の `onKeyDown()` でCtrl+Shift+C/Vを検出:
- Ctrl+Shift+C → 選択テキストをクリップボードにコピー（SIGINTではなく）
- Ctrl+Shift+V → クリップボードからペースト

**注意**: Ctrl+C (Shiftなし) は従来どおりSIGINT。これはターミナルの標準動作を壊さない。

### 3.4 Edge Cases

| Scenario | Behavior |
|----------|----------|
| 選択中にスクロール | 選択範囲を維持、スクロールに追従 |
| 選択中に新しい出力 | 選択範囲固定（新出力は下に流れる） |
| バイナリ出力中のタップ | リンク検出しない（パフォーマンス保護） |
| 非常に長いURL | 末尾を自動トリム（2048文字上限） |

---

## 4. ProcessGuard — プロセスキル対策ウィザード

### 4.1 Problem

Termux不満 #1: Android 12+のPhantom Process Killerが全プロセスを殺す。修正にADB知識が必要。メーカー独自のバッテリー最適化がさらに悪化させる。

### 4.2 Design Decision

Shellyが直接OSの制限を回避することはできない。しかし **検出→診断→ガイド** を自動化することで、ユーザーが一人で解決できるようにする。

### 4.3 Components

**A. KillDetector** (`lib/process-guard.ts`)

```typescript
// セッション異常終了の検出
// TerminalEmulator.addListener('onSessionExit') で signal 9 を検出
// 連続2回以上のsignal 9 → ProcessGuardモーダルを表示

export function detectProcessKill(exitCode: number, signal: number): boolean {
  return signal === 9 || exitCode === 137; // SIGKILL
}
```

**B. DeviceProfiler** (`lib/device-profiler.ts`)

```typescript
import { Platform } from 'react-native';
import * as Device from 'expo-device';

export type DeviceProfile = {
  androidVersion: number;      // Build.VERSION.SDK_INT
  manufacturer: string;        // samsung, xiaomi, huawei, oppo, oneplus...
  phantomProcessKillerActive: boolean;
  batteryOptimizationStatus: 'unrestricted' | 'optimized' | 'restricted' | 'unknown';
};

// Android 14+ → Developer Options に「Disable child process restrictions」トグルあり
// Android 12-13 → ADBコマンドが必要
// メーカー別 → dontkillmyapp.com のガイドをアプリ内に埋め込み
```

**C. ProcessGuardModal** (`components/terminal/ProcessGuardModal.tsx`)

ステップバイステップのウィザード形式:

```
Step 1: 問題の説明
  「Androidがバックグラウンドプロセスを強制終了しています」
  （技術用語なし、絵文字で状況を図示）

Step 2: 端末に応じた解決策
  if (androidVersion >= 14) {
    → 「設定 > 開発者向けオプション > バックグラウンドプロセス制限を無効化」
    → ワンタップで設定画面にジャンプ（Intent）
  } else if (androidVersion >= 12) {
    → ADBコマンドを表示 + コピーボタン
    → PC接続手順をイラスト付きで表示
  }

Step 3: メーカー別バッテリー最適化
  if (manufacturer === 'samsung') → 「バッテリー > アプリのバッテリー使用量 > Shelly > 制限なし」
  if (manufacturer === 'xiaomi') → 「バッテリーとパフォーマンス > アプリのバッテリーセーバー > Shelly > 制限なし」
  // etc. (dontkillmyapp.com ベース)
  → 各設定画面へのIntentジャンプボタン

Step 4: 確認
  → Shellyを裏に回して30秒待機テスト
  → 戻ってきてセッション生存確認
  → OK / 再度対策
```

**D. 初回セットアップへの統合**

SetupWizardに「バックグラウンド保護」ステップを追加。初回でまとめて設定させる。

---

## 5. FirstMate — インテリジェント・オンボーディング

### 5.1 Problem

Termux不満: 「真っ黒画面にドロップ。何していいかわからない」「pkg updateを手動で最初にやらないと壊れる」「termux-setup-storageを知らないとファイルにアクセスできない」。

### 5.2 Design Decision

初回ターミナル起動時にインタラクティブな目的選択UIを表示。選択に応じてパッケージバンドルを自動インストール。

### 5.3 Components

**A. FirstMateOverlay** (`components/terminal/FirstMateOverlay.tsx`)

初回ターミナル接続成功時のみ表示（`AsyncStorage: firstmate_completed`）。

```
┌──────────────────────────────┐
│  🐚 何をしたい？             │
│                              │
│  ┌────────┐  ┌────────┐     │
│  │ 🌐     │  │ 🤖     │     │
│  │ Web    │  │ AI     │     │
│  │ 開発   │  │ 開発   │     │
│  └────────┘  └────────┘     │
│  ┌────────┐  ┌────────┐     │
│  │ 📁     │  │ 📚     │     │
│  │ファイル│  │プログラ│     │
│  │ 管理   │  │ミング  │     │
│  │        │  │ 学習   │     │
│  └────────┘  └────────┘     │
│                              │
│  [ とりあえずスキップ ]       │
└──────────────────────────────┘
```

各選択のバンドル:
```typescript
const BUNDLES: Record<string, { packages: string[]; postSetup?: string[] }> = {
  web: {
    packages: ['nodejs', 'git', 'python'],
    postSetup: ['npm install -g pnpm'],
  },
  ai: {
    packages: ['python', 'git', 'cmake', 'clang'],
    postSetup: ['pip install torch transformers'],
  },
  files: {
    packages: ['zip', 'unzip', 'tree', 'imagemagick'],
    postSetup: [],
  },
  learning: {
    packages: ['python', 'nodejs', 'git'],
    postSetup: [],
  },
};
```

**B. 自動初期化** (SetupWizard拡張)

SetupWizard完了後、ターミナル初回接続時に自動実行:
1. `pkg update -y && pkg upgrade -y` (進捗バー付き)
2. `termux-setup-storage` (ストレージ許可ダイアログを自動トリガー)
3. 選択されたバンドルのインストール
4. 完了通知 → FirstMateOverlayを閉じる

すべてバックグラウンドでbridge経由実行。ユーザーには進捗バー+「インストール中...」のみ表示。

---

## 6. ThemeStudio — テーマ・フォントのGUI設定

### 6.1 Problem

Termuxは別アプリ (Termux:Styling) がないとテーマ変更できない。設定はファイル編集のみ。

### 6.2 Design Decision

既存のsettings-storeに統合。設定画面内にリアルタイムプレビュー付きのテーマセレクター。

Shellyは既に30テーマ持っている（theme-engine.ts）。これは **Chat画面のテーマ** 。ターミナル側のテーマ（背景色、文字色、ANSIカラーパレット）を連動させる。

### 6.3 Components

**A. TerminalThemeSection** (設定画面に追加)

```
┌──────────────────────────────┐
│ Terminal Appearance           │
│──────────────────────────────│
│ Theme:  [Dark ▼]             │
│  ┌─────────────────────┐    │
│  │ $ ls -la             │    │  ← リアルタイムプレビュー
│  │ drwxr-xr-x  node_mod │    │
│  │ -rw-r--r--  index.ts │    │
│  └─────────────────────┘    │
│                              │
│ Font Size: ───●──── 14       │
│ Font:     [JetBrains Mono ▼] │
│ Cursor:   ● Block  ○ Under  ○ Bar │
│                              │
│ ☐ Lock font size (disable pinch zoom) │
│ ☐ Hide key bar with hardware keyboard │
│──────────────────────────────│
```

**B. Terminal ANSIカラーパレット**

```typescript
// lib/terminal-theme.ts
export type TerminalTheme = {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  // ANSI 16 colors
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export const TERMINAL_THEMES: Record<string, TerminalTheme> = {
  dark: { /* デフォルト — 現在のShelly色 */ },
  monokai: { /* ... */ },
  dracula: { /* ... */ },
  solarized_dark: { /* ... */ },
  nord: { /* ... */ },
  tokyo_night: { /* ... */ },
  gruvbox: { /* ... */ },
  catppuccin: { /* ... */ },
};
```

**C. NativeTerminalViewへの反映**

settings-storeの `terminalTheme` が変更されたら、NativeTerminalViewにpropとして渡す。TerminalRenderer.javaでANSIカラーマッピングを更新。

---

## 7. PackageWizard — パッケージ管理UI

### 7.1 Problem

Termux不満: 「ミラー障害でpkg installが通らない」「GPGエラー」「dpkg中断で壊れる」。初心者はコマンドすら知らない。

### 7.2 Design Decision

フルGUIパッケージマネージャーは作らない。それはTermuxのGUI化であり、Shellyの設計思想に反する。

代わりに **自然言語でのパッケージ管理** + **問題自動修復** を実装:

### 7.3 自然言語パッケージ管理

input-router Layer 4.5 に追加:

```typescript
// パッケージ管理の自然言語パターン
const PACKAGE_PATTERNS = [
  { pattern: /(?:install|インストール)\s+(.+)/i, action: 'install' },
  { pattern: /(?:remove|削除|アンインストール)\s+(.+)/i, action: 'remove' },
  { pattern: /(?:search|探す|検索)\s+(.+)/i, action: 'search' },
  { pattern: /(?:update|アップデート|更新)/i, action: 'update' },
];

// 「pythonインストールして」→ pkg install -y python
// 「gitとnodeを入れて」→ pkg install -y git nodejs
// 「パッケージを更新して」→ pkg update -y && pkg upgrade -y
```

### 7.4 自動修復

```typescript
// lib/package-doctor.ts

// bridge実行後のstderr解析
export function diagnosePackageError(stderr: string): PackageFix | null {
  if (stderr.includes('Unable to locate package')) {
    return { fix: 'pkg update', message: 'パッケージリストを更新します' };
  }
  if (stderr.includes('NOSPLIT') || stderr.includes('Clearsigned')) {
    return { fix: 'termux-change-repo', message: 'ミラーを変更します' };
  }
  if (stderr.includes('dpkg was interrupted')) {
    return { fix: 'dpkg --configure -a', message: 'パッケージ管理を修復します' };
  }
  if (stderr.includes('Unable to acquire the dpkg frontend lock')) {
    return { fix: 'rm -f $PREFIX/var/lib/dpkg/lock-frontend && dpkg --configure -a',
             message: 'ロックを解除して修復します' };
  }
  return null;
}

// エラー検出 → 自動修復提案 → ユーザー承認 → 修復実行 → 元のコマンド再実行
```

---

## 8. OutputIntel — 出力のインテリジェント化

### 8.1 Problem

Termuxの出力は全てプレーンテキスト。URLもパスもクリックできない。100行の出力も折りたたみなし。

### 8.2 Design Decision

出力解析はPTYバッファ側ではなくChat側の **既存エラー検出パイプライン** を拡張する形で実装。ターミナル描画自体は変えない（パフォーマンス保護）。

### 8.3 Components

**A. Warp風コマンドブロック** は実装しない

理由: NativeTerminalViewはKotlinレンダラー。コマンドブロック化はターミナルエミュレーター自体の大幅改修が必要。代わりに **Chat側のExecutionLogをリッチ化** する方針。

Chat画面のActionBlock/TerminalBlockが既にコマンド+出力を構造化している。これを強化:

**B. SmartOutput** (Chat側のターミナル出力ブロック強化)

```typescript
// components/chat/SmartOutputBlock.tsx

// 長い出力の折りたたみ
// 20行超 → 最初の5行 + 最後の5行 + 「{n}行省略」ボタン

// URL検出 → タップ可能なリンク
// ファイルパス検出 → タップでPreview FilesTab表示
// エラー行のハイライト（赤背景）
```

**C. use-terminal-output.ts 拡張**

現在のURL検出（localhost）に加えて:
- 一般URL検出（https://...）→ PreviewBannerに「Open in Preview」
- コマンド完了検出（$プロンプト復帰）→ 最後のコマンド+出力をchat-storeにサマリー追加（Wide mode時）

---

## 9. 新規ファイル一覧

| File | Responsibility | Est. Lines |
|------|---------------|-----------|
| `lib/terminal-link-detector.ts` | URL/パス/エラー位置の検出 | ~60 |
| `lib/process-guard.ts` | プロセスキル検出 + デバイスプロファイル | ~80 |
| `lib/package-doctor.ts` | パッケージエラー診断 + 自動修復 | ~60 |
| `lib/terminal-theme.ts` | ターミナルANSIテーマ定義 | ~150 |
| `lib/voice-chain-helpers.ts` | 音声→コマンド変換ヘルパー | ~40 |
| `components/terminal/ProcessGuardModal.tsx` | プロセスキル対策ウィザード | ~200 |
| `components/terminal/FirstMateOverlay.tsx` | 初回目的選択オーバーレイ | ~150 |
| `components/terminal/SmartKeyBar.tsx` | コンテキスト適応キーバー（CommandKeyBar置換） | ~200 |

## 10. 変更ファイル一覧

| File | Changes |
|------|---------|
| `hooks/use-voice-chat.ts` | sendToRouter()追加、ターミナル実行フロー追加 |
| `components/VoiceChat.tsx` | executingステータス、コマンド表示 |
| `components/terminal/CommandKeyBar.tsx` | SmartKeyBarに置換 or 拡張 |
| `hooks/use-terminal-output.ts` | URL/パス検出拡張 |
| `lib/input-router.ts` | パッケージ管理パターン追加 |
| `store/settings-store.ts` | terminalTheme, fontSizeLocked, hideKeyBarWithHwKeyboard 追加 |
| `app/(tabs)/settings.tsx` | Terminal Appearanceセクション追加 |
| `app/(tabs)/terminal.tsx` | ProcessGuardModal, FirstMateOverlay統合 |
| `lib/i18n/locales/en.ts` | 新規キー追加 |
| `lib/i18n/locales/ja.ts` | 新規キー追加 |

## 11. 実装順序（依存関係考慮）

```
Phase 1 (独立して実装可能、基盤系)
├── Task 1: TerminalTheme定義 + settings-store拡張
├── Task 2: SmartKeyBar（CommandKeyBar拡張）
├── Task 3: lib/process-guard.ts + DeviceProfiler
└── Task 4: lib/package-doctor.ts

Phase 2 (Phase 1の上に構築)
├── Task 5: ProcessGuardModal
├── Task 6: FirstMateOverlay
├── Task 7: TerminalAppearance設定画面
└── Task 8: パッケージNLパターン追加 (input-router)

Phase 3 (最も複雑、他機能に依存)
├── Task 9: VoiceChain (use-voice-chat.ts改修)
├── Task 10: ClipboardPlus (Ctrl+Shift+C/V, ターミナルリンク検出)
└── Task 11: OutputIntel (SmartOutputBlock)

Phase 4 (統合・仕上げ)
├── Task 12: i18n全キー追加
├── Task 13: SetupWizardへのProcessGuardステップ統合
└── Task 14: 最終検証 + worklog更新
```

## 12. 実装しないもの（理由付き）

| 提案 | 不採用理由 |
|------|-----------|
| フルGUIパッケージマネージャー | Shellyは「ターミナルのGUI化」ではなく「自然言語によるターミナル」。UIでpkgを操作するのはTermuxのGUI版であってShellyではない |
| Warp風コマンドブロック（ターミナル側） | NativeTerminalViewのKotlinレンダラー大改修が必要。Chat側のActionBlockが既にこの役割を果たしている |
| ネイティブテキスト選択ハンドル | Kotlin側のTerminalView改修が大規模。Phase 1ではCtrl+Shift+C/V対応で最低限のコピーを確保 |
| ADB自動実行（プロセスキル修正） | ShellyアプリからADBコマンドを実行することは権限上不可能。ガイド表示が最善 |
| TalkBackフル対応 | TerminalView(Kotlin)のAccessibilityNodeProvider改修が必要。将来課題 |
