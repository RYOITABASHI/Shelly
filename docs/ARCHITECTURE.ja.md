# アーキテクチャ詳細

[Shelly](../README.ja.md)のアーキテクチャの詳しい図解です。[READMEのアーキテクチャ節](../README.ja.md#アーキテクチャ)がシステム全体像とペイン間データフローをカバーし、このファイルは個々のサブシステムの内部実装です。

### 画面レイアウト

```mermaid
block-beta
  columns 5
  AB["Agent Bar — レイアウト / ペイン追加 / 検索 / 設定"]:5
  SB["Sidebar\nリポジトリ, ファイルツリー\nタスク, デバイス"]:1 TP["Terminal Pane\n$ npm run build\nError: missing..."]:2 AP["AI Pane\n「エラーを直して →」\n[hunk を承認]"]:2
  space:1 BP["Browser Pane\nlocalhost:3000\nYouTube / GitHub"]:2 MP["Preview Pane\nCode / MD / Image"]:2
  CB["Context Bar — ~/Shelly  main  ↑2  Native"]:5

  style AB fill:#1a1a1a,stroke:#00D4AA,color:#00D4AA
  style SB fill:#111,stroke:#333,color:#ccc
  style TP fill:#0a0a0a,stroke:#333,color:#0f0
  style AP fill:#0a0a0a,stroke:#D4A574,color:#D4A574
  style BP fill:#0a0a0a,stroke:#333,color:#61AFEF
  style MP fill:#0a0a0a,stroke:#333,color:#ccc
  style CB fill:#1a1a1a,stroke:#333,color:#666
```

### AI Edit のゴールデンパス

```mermaid
flowchart LR
  FT["FileTree をタップ"] --> OF["openFile()"]
  OF -->|*.md| MP["Markdown ペイン"]
  OF -->|それ以外| CT["Preview → Code タブ"]
  CT -->|AI ボタン| SE["stageAiEdit()"]
  SE --> AIP["ファイルをコンテキストに入れた AI ペイン"]
  AIP --> DIFF["アシスタントの unified diff"]
  DIFF --> IND["InlineDiff — hunk 単位の Accept"]
  IND --> ASD["acceptStagedDiff()（strict → fuzzy）"]
  ASD --> WF["writeFileNative() でディスクに書き込み"]
  WF --> RELOAD["Preview の Code タブが自動リロード"]
```

各ステップは実在のモジュールです: `lib/open-file.ts`、`lib/ai-edit.ts`、`components/panes/InlineDiff.tsx`、`hooks/use-native-exec.ts`。

### ネイティブ PTY — JNI forkpty

```mermaid
flowchart TB
  JS["React Native JS"] -- "Expo Module 呼び出し" --> KT["Kotlin NativeModule"]
  KT -- "JNI" --> PTY["shelly-pty.c (forkpty)"]
  KT -- "JNI" --> EXEC["shelly-exec.c (fork+exec+pipe)"]
  PTY -- "ptmx / setsid" --> SH["シェルプロセス\nbash / zsh / sh"]
  PTY -- "read/write fd" --> TV["ShellyTerminalView.kt\nKotlin レンダラ"]
  TV --> VIEW["Android View\nCanvas パス / 任意の GLSurfaceView パス"]
```

用途の違う 2 つの JNI エントリポイントがあります。**`shelly-pty.c`** は対話シェルを担当し、`/dev/ptmx` を開き、`forkpty` 相当のロジック（`grantpt` + `unlockpt` + `setsid` + `/system/bin/linker64` 経由の `execve`）を実行して、マスター fd を Kotlin に返し、ターミナルビューがそれを読みます。**`shelly-exec.c`** はプログラム的な一発実行（`git status`、`ls`、ファイル I/O、AI ディスパッチのヘルパー）を担当し、素直な `fork` + `exec` + `pipe` を行って `{exitCode, stdout, stderr}` を同期的に返します。読み取りループは EAGAIN を認識して、select の空振りと本物の EOF を区別します（bug #70 の修正）。

TCP なし。ソケットのターミナルサーバーなし。別立ての PTY ヘルパーデーモンなし。シェルは普通に fork された子プロセスとして動き、PTY のマスター fd はアプリが所有して、Kotlin から JNI 経由で直接読みます。

### 実行中のテーマ切り替え

```mermaid
flowchart LR
  U["Settings → Font: Shelly"] --> S["settings-store.uiFont"]
  S --> E["RootLayout の effect"]
  E --> AP["applyThemePreset()"]
  AP --> M["Object.assign(colors, palette)"]
  AP --> P["patchTextRenderOnce()"]
  AP --> V["theme-version をインクリメント"]
  V --> R["ShellLayout の key-remount"]
  R --> UI["すべての Text が新しい fontFamily で再描画"]
  PTY["ネイティブ PTY"] -. 影響を受けない .- R
```

`colors` オブジェクトはミュータブルで同一性を保つので、`import { colors as C }` しているすべての箇所がコードの変更なしに新しい値を見ます。フォントの変更は Text のモンキーパッチが担当します。theme-version の key-remount が、描画されるすべての Text をそのパッチに通します。PTY は JS の外にいるので、影響を受けません。
