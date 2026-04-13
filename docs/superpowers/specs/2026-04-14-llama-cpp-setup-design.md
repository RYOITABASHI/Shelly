# llama.cpp Guided Setup — Design

**日付**: 2026-04-14
**親 spec**: `docs/superpowers/specs/2026-04-14-coming-soon-design.md` 機能 5
**ステータス**: 設計

---

## ゴール

ユーザーが Settings → Local LLM セクションを開いて数タップで **ローカルの llama-server を Shelly 内から起動 → `@local` で会話できる** 状態にする。`wget` を使うので端末にネットワーク接続は必要。

## 非ゴール

- APK にバイナリを同梱する
- GPU / Vulkan / OpenCL バックエンドを選ばせる (初回は CPU のみ)
- モデルを 3 個以上選ばせる
- 量子化方式を選ばせる (Q4_K_M 固定)
- 複数モデル切替 (1 モデル固定、切替は手動再起動)

## 現状把握

- `lib/local-llm.ts` (既存、未確認) に `@local` 経路のルータがある想定。実装時に grep で確認、無ければ新規作成
- Ports monitor (`store/ports-store.ts`) は既に `:8080` を検出できる
- `execCommand` / `writeFileNative` は `hooks/use-native-exec.ts` で top-level export 済み

## アーキテクチャ

```
┌─────────────────────┐
│ LocalLlmSection.tsx │  ← UI。Install / Model / Start / Stop / Status 表示
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   lib/llama-setup   │  ← 純関数群。全部 Promise<...>
└──────────┬──────────┘
           │ execCommand / wget / mkdir / pkill
           ▼
┌─────────────────────┐
│   シェル (PTY 外)    │  ← JNI execCommand
└─────────────────────┘

Status detection:
  usePortsStore → :8080 listener があれば running と判定
```

全ロジックを `lib/llama-setup.ts` に純関数で切り出す。UI は状態を Zustand 経由で購読するだけ。

## データモデル

```ts
// store/llama-setup-store.ts
type InstallStage =
  | 'not-installed'
  | 'downloading-binary'
  | 'downloading-model'
  | 'installed'
  | 'error';

type LlamaSetupState = {
  stage: InstallStage;
  binaryVersion: string | null;  // 'b4562'
  modelFile: string | null;      // 'gemma-2-2b-it-Q4_K_M.gguf'
  errorMessage: string | null;

  setStage: (s: InstallStage) => void;
  setBinaryVersion: (v: string | null) => void;
  setModelFile: (m: string | null) => void;
  setError: (e: string | null) => void;
};
```

永続化: AsyncStorage (持ち回す情報はテキストだけなので SecureStore 不要)。

## モデル選択

ユーザーが選べるのは 2 つだけ:

| モデル | サイズ | RAM 要件目安 | 特徴 |
|---|---|---|---|
| **Gemma-2-2B-IT (Q4_K_M)** | ~1.6 GB | 3 GB | 汎用、多言語、Google 公式 |
| **Qwen2.5-1.5B-Instruct (Q4_K_M)** | ~1.1 GB | 2 GB | 軽量、中国語/日本語に強い |

DL 先:
- Gemma: `https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf`
- Qwen: `https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf`

これらは **実装時に一度 curl --head で存在確認** すること。HuggingFace は URL を変えない建前だが重要なのでガード。

## 保存パス

```
~/.shelly/llama/
├── llama-server          (実行バイナリ)
├── libllama.so           (依存ライブラリ、リリース zip に同梱)
├── VERSION               (テキスト: 'b4562\n')
└── models/
    ├── gemma-2-2b-it-Q4_K_M.gguf
    └── qwen2.5-1.5b-instruct-q4_k_m.gguf
```

## バイナリ入手フロー

1. `curl -sL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest` で最新 release JSON を取得
2. `.assets[] | select(.name | test("android-arm64.*\\\\.zip"))` の browser_download_url を抽出 (jq が無い環境対策で sed/grep でパース)
3. `wget -O /tmp/llama.zip <url>`
4. `mkdir -p ~/.shelly/llama && unzip -q /tmp/llama.zip -d ~/.shelly/llama/ && chmod +x ~/.shelly/llama/llama-server`
5. `tag_name` を `~/.shelly/llama/VERSION` に書き込む
6. `/tmp/llama.zip` 削除

失敗時の fallback: hardcoded URL を 1 つ持ち、`b4562-bin-android-arm64.zip` を使う (設計当日時点の最新)。

## 起動フロー

```bash
cd ~/.shelly/llama
./llama-server \
  -m models/<selected>.gguf \
  --port 8080 \
  -c 4096 \
  --log-disable \
  > ~/.shelly/llama/server.log 2>&1 &
disown
```

起動後 `usePortsStore` が :8080 を拾うまで最大 20 秒 (poll interval)。UI は "Starting..." 表示を 20 秒出して、まだ検出されなければ `server.log` を `cat` して error 表示。

## 停止フロー

```bash
pkill -f llama-server
```

pkill 後 1 秒待って :8080 が Ports list から消えるのを確認、消えなければ `pkill -9 -f llama-server`。

## `@local` 配線

`lib/local-llm.ts` 既存確認:
- base URL が `http://localhost:8080` ハードコードか環境変数か確認
- もし動的に `useLlamaSetupStore` を参照する必要があれば、`getLocalLlmBaseUrl()` 関数を公開し、AI pane dispatcher から呼ぶ
- API は OpenAI 互換 (`/v1/chat/completions`) なので既存 dispatcher がそのまま動くはず

## UI フロー (LocalLlmSection.tsx)

### 初期状態 (not-installed)

```
┌─ Local LLM ─────────────────────┐
│ Status: Not installed           │
│                                 │
│ Select a model:                 │
│ ○ Gemma-2-2B-IT (~1.6 GB)       │
│ ○ Qwen2.5-1.5B-Instruct (~1.1)  │
│                                 │
│ [ Install llama-server + model ]│
└─────────────────────────────────┘
```

モデル未選択時は Install ボタン disabled。

### ダウンロード中

```
│ Status: Downloading llama-server │
│ [=======>           ] (binary)   │
│                                  │
│ → Downloading model              │
│ [====>              ] (model)    │
│                                  │
│ [ Cancel ]                       │
```

進捗は wget の stderr を stream 読みしたいが、`execCommand` は完了までブロックするので**進捗バーなし**。代わりに「Downloading binary... (may take 1-2 min)」のスピナー表示に留める。

### インストール済み

```
│ Status: Installed (b4562)       │
│ Model: gemma-2-2b-it-Q4_K_M     │
│                                 │
│ [ Start server ]                │
│ [ Re-install ]                  │
│ [ Change model ]                │
```

### 起動中

```
│ Status: Starting...             │
│ Waiting for :8080               │
```

### 起動済み

```
│ Status: Running on :8080         │
│ Model: gemma-2-2b-it-Q4_K_M      │
│                                  │
│ Use @local in AI pane to chat.  │
│                                  │
│ [ Stop server ]                  │
│ [ View log ]                     │
```

### エラー状態

```
│ Status: Error                    │
│ llama-server failed to start:    │
│ <最後の 3 行 from server.log>    │
│                                  │
│ [ Retry ]                        │
│ [ View full log ]                │
```

## ファイル一覧

- `store/llama-setup-store.ts` (新規, ~80 行)
- `lib/llama-setup.ts` (新規, ~200 行) — install/start/stop/fetchLatestUrl/detectRunning
- `components/settings/LocalLlmSection.tsx` (新規, ~250 行)
- `components/layout/SettingsDropdown.tsx` (編集 — LocalLlm row 追加)
- `lib/local-llm.ts` (必要なら編集)

## エラーハンドリング

| ケース | 対応 |
|---|---|
| ネット未接続 | wget exit code 4 / 5 → "No network. Connect and retry." |
| GitHub API rate limit | JSON に `"message": "API rate limit"` あれば fallback URL へ |
| DL 途中切断 | `wget -c` で再開可能、UI は Cancel → Install ボタン |
| zip 破損 | `unzip -q` exit code ≠ 0 → バイナリ削除して "Download corrupted, retry" |
| モデル DL 失敗 | バイナリは残したまま、モデル選択に戻る |
| 起動失敗 (port 既に使用中) | `lsof -i :8080` を事前確認、occupied なら "Port 8080 in use, stop other services first" |
| crash (OOM) | server.log に "killed" → "Out of memory — try Qwen (smaller model)" |

## セキュリティ考察

- バイナリは GitHub からしか落とさない (第三者 mirror 禁止)
- DL 後 SHA256 検証は **v1 ではやらない** (GitHub API の `.assets[].digest` から取れるが実装コスト中)。README に「GitHub Releases 直 DL」と明記してユーザー責任
- llama-server は `--host 127.0.0.1` 相当の loopback 固定 (ネットワーク経由の攻撃を防ぐ)。llama.cpp の `--host` オプション既定が `127.0.0.1` なので明示しなくても OK、念のため `--host 127.0.0.1` を渡す

## 検証チェックリスト

- [ ] クリーンインストールから Gemma / Qwen どちらでも設置できる
- [ ] インストール後、再起動しても Installed 状態が維持される
- [ ] Start → 20 秒以内に Running 表示
- [ ] AI pane で `@local こんにちは` に応答
- [ ] Stop → Ports list から :8080 が消える
- [ ] Re-install → バイナリ/モデル両方上書き
- [ ] Change model → バイナリはそのまま、モデルだけ切替
- [ ] ネット未接続で Install → エラー表示
- [ ] 起動中に Re-install ボタン disabled
