# Shelly Coming Soon — 6 機能統括設計

**日付**: 2026-04-14 (設計日)
**ステータス**: 設計完了、実装は別セッションで `writing-plans` → `subagent-driven-development` 経由
**対象コミットベース**: `ca428062` 以降の main
**関連**:
- `docs/superpowers/specs/2026-04-13-handoff.md` — 全体の引き継ぎ
- `docs/superpowers/specs/2026-04-14-llama-cpp-setup-design.md` — 機能 5 の詳細
- `docs/superpowers/specs/2026-04-14-cloud-oauth-design.md` — 機能 6 の詳細

---

## ゴール

README の `Coming Soon` セクションに並んでいる 6 機能を、**6 時間以内で全部 main ブランチに載せる**。実装難易度が揃っていないため、単純な順番で消化せずに「軽い × インパクト大」を先に片付ける。

---

## スコープ外

- unit test のセットアップ (Jest がまだ入っていない、別 issue #5)
- Dropbox / OneDrive の OAuth 実装 — Browser pane 直リンクのみで済ます
- llama.cpp バイナリの APK 同梱 — ランタイム `wget` で解決
- MCP server の新規追加 UI — 既存 catalog の toggle のみ対応
- Background agent の **作成** UI — 既存 `@agent` syntax 経由のみ、一覧/削除/run-now だけ UI 化

---

## 実装順(合理的最適解)

| # | 機能 | 所要 | 依存 | 効果 |
|---|---|---|---|---|
| 1 | Additional theme presets | 20 分 | なし | 見た目即効、Shelly preset の差別化 |
| 2 | MCP manager (enable/disable) | 30 分 | なし | 既存実験機能の完成度↑ |
| 3 | Background agent scheduler UI | 45 分 | 既存 `agent-manager` | Sidebar Tasks セクションが完成 |
| 4 | SSH Profiles (key auth only) | 60 分 | なし | Pentester / SRE 向け、Profiles セクション充実 |
| 5 | llama.cpp guided setup | 90 分 | 既存 Ports monitor | プライバシー価値訴求の目玉 |
| 6 | Google Drive OAuth + Dropbox/OneDrive 直リンク | 120 分 | 既存 Browser pane | Cloud セクション完成 |

**合計: 約 6 時間(設計当日を除く)**

依存がない順に並べてあるので、上から線形に実装する。5 → 6 は `local-llm` routing と `@local` 経路に触れるが、既存コードで足りる。

---

## 機能 1: Additional terminal theme presets

### 要件
Shelly preset の他に 4 個 (`dracula` / `nord` / `gruvbox` / `tokyo-night`) を追加する。フォントは Silkscreen 継続。UI で切り替えた瞬間にランタイム反映 (既存の `applyThemePreset` + `useThemeVersionStore` 経路で動く)。

### データモデル
```ts
// lib/theme-presets.ts
export type ThemePresetId =
  | 'shelly'
  | 'silkscreen'
  | 'pixel'
  | 'mono'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night';
```

各 preset は `Palette` 型の全フィールドを埋める。色は以下の公式スキームから **neon-glow に耐える飽和度** を選んで実機で微調整する。

- **Dracula** — 公式 HEX (bg `#282A36`, accent `#BD93F9`, green `#50FA7B`, red `#FF5555`, …)
- **Nord** — 公式 (bg `#2E3440`, accent `#88C0D0`, green `#A3BE8C`, …)
- **Gruvbox dark medium** — 公式 (bg `#282828`, accent `#FABD2F`, green `#B8BB26`, …)
- **Tokyo Night** — 公式 (bg `#1A1B26`, accent `#7AA2F7`, …)

### UI 変更
- `components/layout/SettingsDropdown.tsx` の `FontFamilyRow` を廃止 → `ThemePresetGrid` にリネーム、8 プリセット (4 font + 4 theme) を 2×4 タイルで並べる
- 既存の `settings-store.uiFont` を `settings-store.themePreset` にリネーム
- `store/types.ts` の `uiFont` フィールドも同様にリネームし、マイグレーション (`settings-store.ts` の persist storage から旧 `uiFont` キーを読んで新キーにコピー)
- Command Palette の既存 4 行に加えて 4 行追加 (`Theme: Dracula` etc.)

### ファイル
- `lib/theme-presets.ts` (編集 — palette 4 個追加)
- `store/types.ts`, `store/settings-store.ts` (編集 — field rename + migration)
- `components/layout/SettingsDropdown.tsx` (編集 — UI リネーム)
- `components/CommandPalette.tsx` (編集 — 4 行追加)
- `app/_layout.tsx` (編集 — `settings.uiFont` 参照を `settings.themePreset` に)

### 検証
- Settings で Dracula に切り替え → 全画面の accent が紫、bg が `#282A36` になる
- PTY セッション生存 (既存 monkey-patch に乗るだけなので vim 生存)

---

## 機能 2: MCP manager (enable/disable toggle)

### 要件
既存の MCP server catalog (Context7 等) を Settings から toggle できるようにする。新規 server の追加 UI は対象外。

### 現状把握
- `lib/mcp-*.ts` あたりに catalog があるはず、実装時にまず `grep -rn "mcp" lib/ store/` で特定する
- 既存 store に `enabledIds` フィールドがなければ追加

### データモデル
```ts
// store/mcp-store.ts (新規 or 既存拡張)
type McpState = {
  enabledIds: string[];
  toggleEnabled: (id: string) => void;
};
```
`persist` (AsyncStorage) で永続化。

### UI
- 新規 `components/settings/MCPSection.tsx`: catalog を list、各 row に `[TOGGLE]` 表示
- `SettingsDropdown` から開ける Modal 配下に配置

### 起動配線
MCP server を起動するロジック (`lib/mcp-manager.ts` 想定) に `startupEnabledServers()` を追加、app 起動時に `enabledIds` を読んで該当 server のみ起動。既存コードに起動ロジックがなければ **この Task は UI と store のみ** で止める (実際に server が起動するかは手動検証)。

### ファイル
- `store/mcp-store.ts` (新規 or 編集)
- `components/settings/MCPSection.tsx` (新規)
- `components/layout/SettingsDropdown.tsx` (編集 — MCP row 追加)
- `app/_layout.tsx` (編集 — 起動時 toggle 反映)

### 検証
- toggle ON → 再起動しても ON が維持される
- catalog の全 server が一覧される

---

## 機能 3: Background agent scheduler UI

### 要件
既存の `agent-manager` registry (`lib/agent-manager.ts` に `agentRegistry` がある前提) を Sidebar Tasks セクション末尾に一覧表示。各 row に `[● 状態] name [▶ Run now] [🗑]`。

### 現状把握
- Sidebar の Tasks セクションは現在ダミー `NPM RUN DEV` と `GIT PUSH` をハードコード表示 (`components/layout/Sidebar.tsx` の Tasks section)
- 実装時にまず `loadAgentsFromDisk` と `useAgentStore.runHistory` を読み、実データに接続する

### UI
```
TASKS                          ^
  ● NPM RUN DEV      RUNNING
  ✓ GIT PUSH             25
  ─────────────────────────
  AGENTS
  ● perplexity-daily  ▶ 🗑
  ● claude-review    ▶ 🗑
```
下の "AGENTS" 区切りより下が新機能。

### 配線
- `store/agent-store.ts` に `agents: Agent[]` (registry) と `runAgent(id)` / `deleteAgent(id)` を expose
- `Sidebar.tsx` の Tasks セクションで `useAgentStore((s) => s.agents)` を購読
- run-now は `lib/agent-manager.ts` の既存 runner を呼ぶ。無ければ `pendingCommand` で `shelly agent run <id>` のような CLI fallback

### ファイル
- `store/agent-store.ts` (編集)
- `components/layout/Sidebar.tsx` (編集 — Tasks section 拡張)
- `lib/agent-manager.ts` (必要なら編集)

### 検証
- `@agent create perplexity-daily …` で登録 → Sidebar に現れる
- `▶` タップ → ターミナルで該当 agent が走る
- `🗑` タップ → Alert 確認 → 削除

---

## 機能 4: SSH Profiles UI (key auth only)

### 要件
セキュリティ重視のため **秘密鍵本体もパスワードも保存しない**。アプリが持つのはメタだけ:
```ts
type SshProfile = {
  id: string;
  label: string;      // "prod-vps"
  host: string;       // "example.com"
  port: number;       // 22
  user: string;       // "ryo"
  keyPath?: string;   // "~/.ssh/id_ed25519"
};
```
Profile tap で `ssh -i KEYPATH USER@HOST -p PORT` を組み立てて `useTerminalStore.setState({ pendingCommand: cmd })` で active terminal pane に送る。

### なぜパスワード禁止か
1. Android Keystore 経由でも RN 層で平文に戻る瞬間があり、mem dump リスクあり
2. 現代的な sshd は password 認証を無効化しているケースが多い
3. 秘密鍵本体は `~/.ssh/` にあるので **アプリが鍵を持たない設計** が綺麗
4. passphrase 入力が必要なら ssh-agent か初回 ssh コマンドで対話
5. ユーザーが key を shoulder-surfed されるより、パスワード保存の方が一撃で破られる

### データモデル
```ts
// store/ssh-profiles-store.ts (新規)
type SshProfilesState = {
  profiles: SshProfile[];
  addProfile: (profile: Omit<SshProfile, 'id'>) => void;
  updateProfile: (id: string, patch: Partial<SshProfile>) => void;
  deleteProfile: (id: string) => void;
};
```
`persist` で永続化 (秘密情報は含まれないので `AsyncStorage` で OK、SecureStore は不要)。

### UI
- 既存 `components/layout/ProfilesSection.tsx` を拡張 (or 新規 `components/profiles/SshProfileList.tsx` を追加)
- 各 row tap → profile を active にして terminal pane に `ssh …` を送る
- 長押しで `[Edit | Delete]` Alert メニュー
- セクション末尾の `+ ADD PROFILE` tap → `components/profiles/SshProfileModal.tsx` (新規) モーダル表示、`label/host/user/port/keyPath` の 5 フィールド TextInput
- `keyPath` のデフォルトは `~/.ssh/id_ed25519`, プレースホルダーで `~/.ssh/id_ed25519` を表示

### 削除確認
`Delete 'prod-vps'?` Alert → 破壊的操作なので style: 'destructive'

### ファイル
- `store/ssh-profiles-store.ts` (新規)
- `components/profiles/SshProfileModal.tsx` (新規)
- `components/layout/ProfilesSection.tsx` (編集)
- `lib/ssh-cmd.ts` (新規 — コマンド組み立てヘルパー、単体テストしやすいように切り出す)

### 検証
- ADD → プロファイル保存、再起動で残る
- 行 tap → terminal pane に `ssh -i ~/.ssh/id_ed25519 ryo@example.com -p 22` が現れる (実行前に `\r` を付けるかは未決 — 付けない方針、ユーザーが Enter で確定)
- 長押し → Edit / Delete メニュー

---

## 機能 5: llama.cpp guided setup

詳細は `docs/superpowers/specs/2026-04-14-llama-cpp-setup-design.md` を参照。要点のみ:

### フロー
1. Settings → Local LLM セクション開く
2. 状態表示 (`Not installed` / `Installed v<tag>` / `Running on :8080`)
3. `[Install]` タップ → GitHub API で latest release URL 動的取得 → `wget` で `~/.shelly/llama/` に展開 → モデル 2 択 (Gemma-2-2B-IT / Qwen2.5-1.5B-Instruct) 選ばせて同じく wget
4. `[Start]` → `~/.shelly/llama/llama-server -m <model>.gguf --port 8080 -c 4096 &` を `pendingCommand` 送信
5. 状態 detection: 既存 Ports monitor が `:8080` を検出 → `Running` バッジ
6. `[Stop]` → `pkill -f llama-server`
7. AI pane で `@local` 経路が自動的にこの base URL に向く (`lib/local-llm.ts` 既存?)

### 重要判断
- **バイナリ入手**: GitHub API `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest` を curl でパース、`android-arm64` asset URL を取る。失敗時は hardcoded fallback tag へ
- **APK 同梱はしない**: +80MB, 月次アップデートに追従不可
- **モデル入手**: HuggingFace 公式 GGUF から wget、 client-side 選択
- **ポート固定**: 8080 (`:8080` は Ports monitor で既に拾える)

### ファイル
- `components/settings/LocalLlmSection.tsx` (新規)
- `lib/llama-setup.ts` (新規 — install/start/stop/status の純関数)
- `components/layout/SettingsDropdown.tsx` (編集)
- `lib/local-llm.ts` (既存確認、base URL 固定なら変更なし)

---

## 機能 6: Google Drive OAuth + Dropbox/OneDrive 直リンク

詳細は `docs/superpowers/specs/2026-04-14-cloud-oauth-design.md` を参照。要点のみ:

### Google Drive (本格 OAuth)
- PKCE flow: `expo-auth-session` (既に入っている or 追加する) で WebView 認証
- scope: `https://www.googleapis.com/auth/drive.readonly` (読み取り専用)
- access/refresh token は `expo-secure-store` に保存
- Drive API `files.list` で root 20 件取得、Sidebar Cloud セクションに表示
- ファイル tap → `~/Downloads/shelly-gdrive/<name>` に DL → `openFile()` で Preview pane

### Dropbox / OneDrive (直リンクのみ)
- Sidebar Cloud セクションに `Open Dropbox` / `Open OneDrive` の 2 行
- tap で `useBrowserStore.openUrl('https://www.dropbox.com/home')` / `https://onedrive.live.com`
- OAuth なし、file API なし、割り切って Browser pane 任せ

### CLIENT_ID の扱い
`lib/google-drive.ts` に:
```ts
const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || 'REPLACE_ME';
```
README に「自分の Google Cloud Console で OAuth Client を作り、`.env.local` に `EXPO_PUBLIC_GOOGLE_CLIENT_ID=...` を入れてください」と明記。未設定なら Cloud セクションは `Configure CLIENT_ID` 警告バナー + Dropbox/OneDrive の 2 行だけ表示。

### ファイル
- `lib/google-drive.ts` (新規 — auth/list/download の純関数)
- `store/google-drive-store.ts` (新規 — token + cached file list)
- `components/cloud/GoogleDriveAuthModal.tsx` (新規)
- `components/layout/Sidebar.tsx` (編集 — Cloud section 実装)
- `README.md` (編集 — CLIENT_ID セットアップ手順追記)

---

## 共通方針

### コミット粒度
1 機能につき 1 コミット原則。機能 5 / 6 は Step ごとに分けても良い (install / start/stop / detection で 3 コミット、など)。

### ブランチ戦略
main に直接 push 継続。現セッションのコミット流量に合わせる。

### 検証
各機能の完了基準は **実機で smoke test 1 回通ればよし**。 unit test はスコープ外。

### ロールバック
機能 1 (theme preset rename) は persist migration が入るので、旧 `uiFont` キーは 2 週間後に削除、それまでは両方読む。

### README/handoff 更新
各機能の着地時に `README.md` の Status テーブルから該当行を Coming Soon → ✅ shipping に移動。`docs/superpowers/specs/2026-04-13-handoff.md` にも追記。

---

## リスクと対応

| リスク | 発生機能 | 対応 |
|---|---|---|
| persist migration 失敗で設定ロスト | 1 | 旧 `uiFont` キーを読んで新 `themePreset` に書き、成功後も旧キー保持 (2 週間後削除) |
| llama-server バイナリ DL 失敗 | 5 | fallback: 固定 tag URL を 1 個ハードコード |
| Drive API quota exceeded | 6 | files.list を 20 件に絞る、pagination 追加しない |
| 秘密鍵パス入力ミスで ssh 接続失敗 | 4 | エラーは terminal に出るので UI 側は何もしない、プレースホルダーで `~/.ssh/id_ed25519` を明示 |
| MCP server 起動ロジックが無い | 2 | UI と store だけ完成させ、起動配線は未実装メモを残す |
| agent-manager の run-now 経路不明 | 3 | 実装時に再調査、不明なら `pendingCommand` CLI fallback |

---

## 成功判定

6 機能すべてが以下を満たせば成功:
1. `npx tsc --noEmit` 0 エラー
2. main に push 済み
3. `README.md` の Status テーブルで該当行が ✅ shipping
4. 1 度は実機で UI を触って smoke test 済み
5. `docs/superpowers/specs/2026-04-13-handoff.md` が更新済み

---

## 次アクション

1. このファイルを commit
2. 重機能 5 / 6 の詳細 mini-spec を別ファイルで書く (`2026-04-14-llama-cpp-setup-design.md`, `2026-04-14-cloud-oauth-design.md`)
3. spec review loop (本体 + 2 mini-spec)
4. ユーザー承認
5. `writing-plans` skill で `2026-04-14-coming-soon-plan.md` を生成
6. 新セッションで `executing-plans` or `subagent-driven-development` で実装開始
