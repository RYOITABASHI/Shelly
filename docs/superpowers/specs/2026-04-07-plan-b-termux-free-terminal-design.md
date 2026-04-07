# Plan B: Termux-Free Terminal — Design Specification

**Status:** Draft
**Date:** 2026-04-07
**Supersedes:** 2026-03-29 PTY Direct Architecture (partially), 2026-04-05 TCP Hardening (fully)

## Problem

Shellyは現在Termuxに依存している:
- bash実行 → Termuxの `/data/data/com.termux/files/usr/bin/bash`
- パッケージ管理 → `pkg install`
- pty-helper実行 → Termux内のCプロセス
- ブリッジ接続 → TCP 127.0.0.1 (クロスUID IPC)

この依存はユーザー体験を悪化させる:
- セットアップにTermuxインストールが必要
- ブリッジ接続の断続的な切断
- 2アプリ間のUID境界によるSELinux制約
- ユーザーにTermuxの存在が見える

## Solution

APKにbash + 基本ツールを同梱し、linker64トリック + JNI forkptyで直接実行。Termux完全不要。

## Phase 0 検証結果 (2026-04-07)

linker64トリックによるbash実行が成功:
```
execve("/system/bin/linker64", ["linker64", "/path/to/libbash.so", "-c", "echo EXECVE_OK"], envp)
→ EXECVE_OK
→ exitCode=0
```

- **環境:** Android 16 (SDK 36), Z Fold6, SELinux enforcing, 非root
- **SELinuxドメイン:** `u:r:untrusted_app:s0`
- **実行方式:** `/system/bin/linker64`経由で`app_data_file`ラベルのELFを実行
- **依存ライブラリ:** APKから`filesDir/termux-libs/`に抽出、`LD_LIBRARY_PATH`で解決

## Architecture

### Before (TCP Bridge)
```
Shelly (uid A) → TCP 127.0.0.1:8765 → bridge.js (Termux, uid B) → pty-helper → PTY → bash
```
- 4 IPC境界、クロスUID、TCP切断問題

### After (Plan B)
```
Shelly (Kotlin/JNI) → forkpty() → execve(linker64, bash) → PTY → bash
```
- 0 IPC境界、同一プロセス内fork、PTY fd直接操作

### Data Flow
```
User Input → ShellyInputHandler.kt → write(ptyFd, data)
                                          ↓
                                    linker64 → bash → command
                                          ↓
                                    read(ptyFd) → output
                                          ↓
                           TerminalEmulator.append() → 16ms batched event → RN
```

### Resize Flow
```
onSizeChanged(w, h) → ioctl(ptyFd, TIOCSWINSZ, {cols, rows})
                           ↓
                     bash receives SIGWINCH → instant resize
```

## Components

### 1. Native Library: `libtermux.so` (JNI)

既存の`termux.c`を拡張。forkpty + linker64 execveを実装。

```c
// 新規JNI関数
JNIEXPORT jint JNICALL
Java_expo_modules_terminalemulator_JNI_createSubprocess(
    JNIEnv *env, jclass clazz,
    jstring linkerPath,    // "/system/bin/linker64"
    jstring bashPath,      // ".../termux-libs/libbash.so"
    jstring ldLibPath,     // ".../termux-libs"
    jstring homePath,      // Shellyのfiles/home
    jint rows, jint cols,
    jintArray resultArray  // [masterFd, childPid]
);

JNIEXPORT void JNICALL
Java_expo_modules_terminalemulator_JNI_setPtyWindowSize(
    JNIEnv *env, jclass clazz,
    jint fd, jint rows, jint cols
);

JNIEXPORT jint JNICALL
Java_expo_modules_terminalemulator_JNI_waitFor(
    JNIEnv *env, jclass clazz, jint pid
);

JNIEXPORT void JNICALL
Java_expo_modules_terminalemulator_JNI_close(
    JNIEnv *env, jclass clazz, jint fd
);
```

`createSubprocess`の実装:
1. `forkpty(&masterFd, NULL, NULL, &winsize)` でPTY作成
2. 子プロセス内で環境変数設定 (`HOME`, `PATH`, `TERM`, `LD_LIBRARY_PATH`, `SHELL`)
3. `execve("/system/bin/linker64", argv, envp)` でbash起動
4. 親プロセスに`[masterFd, childPid]`を返却

### 2. Kotlin: `ShellyTerminalSession.kt` (大幅変更)

TCP Socket接続を**全削除**。代わりにPTY fdを直接操作。

```kotlin
class ShellyTerminalSession(
    private val sessionId: String,
    private val masterFd: Int,
    private val childPid: Int,
    private val emulator: TerminalEmulator
) {
    // OutputReader: masterFdからread() → emulator.append()
    // InputWriter: write(masterFd, data)
    // Resize: JNI.setPtyWindowSize(masterFd, rows, cols)
    // Exit detection: JNI.waitFor(childPid) on background thread
}
```

削除するもの:
- TCP Socket接続ロジック
- WebSocket Bridge通信
- Heartbeat/reconnect/exponential backoff
- Ring buffer replay
- socat/pty-helper起動コード

### 3. Kotlin: `TerminalEmulatorModule.kt` (変更)

`createSession`の引数変更:

```kotlin
// Before
AsyncFunction("createSession") { config: Map<String, Any> ->
    val port = config["port"] as Int  // TCP port
    ...
}

// After
AsyncFunction("createSession") { config: Map<String, Any> ->
    val sessionId = config["sessionId"] as String
    val rows = (config["rows"] as? Number)?.toInt() ?: 24
    val cols = (config["cols"] as? Number)?.toInt() ?: 80

    // Extract libs if needed
    extractTermuxLibs(context)

    // Create PTY via JNI
    val result = IntArray(2)
    JNI.createSubprocess(
        "/system/bin/linker64",
        "$libDir/libbash.so",
        libDir,
        homeDir,
        rows, cols, result
    )
    val masterFd = result[0]
    val childPid = result[1]

    // Create session with PTY fd
    val session = ShellyTerminalSession(sessionId, masterFd, childPid, ...)
    sessionRegistry[sessionId] = session
    sessionId
}
```

### 4. ライブラリ抽出: `LibExtractor.kt` (新規)

APKからバイナリを`filesDir/termux-libs/`に抽出するユーティリティ。
testExecveの抽出ロジックを汎用化。

```kotlin
object LibExtractor {
    // APKエントリ名 → 抽出後ファイル名のマッピング
    private val LIBS = mapOf(
        "lib/arm64-v8a/libbash.so" to "libbash.so",
        "lib/arm64-v8a/libandroid-support.so" to "libandroid-support.so",
        "lib/arm64-v8a/libiconv.so" to "libiconv.so",
        "lib/arm64-v8a/libreadline8.so" to "libreadline.so.8",
        "lib/arm64-v8a/libncursesw6.so" to "libncursesw.so.6",
        // Phase 2で追加:
        // "lib/arm64-v8a/libnode.so" to "node",
        // "lib/arm64-v8a/libgit.so" to "git",
        // etc.
    )

    fun extractAll(context: Context): File  // returns libDir
    fun getLibDir(context: Context): File
    fun getBashPath(context: Context): String
}
```

### 5. TypeScript: `terminal.tsx` (変更)

ブリッジ起動・TCP接続を削除。`createSession`をシンプルに。

```typescript
// Before
const port = await allocatePort();
await bridge.send('startPty', { sessionId, port });
await TerminalEmulator.createSession({ sessionId, port, rows, cols });

// After
await TerminalEmulator.createSession({ sessionId, rows, cols });
```

### 6. ホームディレクトリ: `filesDir/home/`

Termuxの`/data/data/com.termux/files/home`の代わりに、Shellyの`filesDir/home/`を使用。

初回起動時に作成:
- `~/.bashrc` (プロンプト設定、PATH、OSC 133)
- `~/.profile`
- `~/projects/` (プロジェクトディレクトリ)

```bash
# .bashrc (自動生成)
export HOME="$SHELLY_HOME"
export PATH="$SHELLY_LIBS:$PATH"
export TERM=xterm-256color
export SHELL="$SHELLY_LIBS/libbash.so"
export LANG=en_US.UTF-8

# OSC 133 for command block detection
PS1='\[\e]133;A\a\]\u@shelly:\w\$ \[\e]133;B\a\]'
PROMPT_COMMAND='echo -ne "\033]133;D;$?\007"'
```

## 同梱バイナリ (Phase 2)

| バイナリ | APKエントリ名 | 抽出後名 | サイズ | 優先度 |
|---------|-------------|---------|--------|--------|
| bash | libbash.so | libbash.so | ~880KB | Phase 1 |
| coreutils | libcoreutils.so | coreutils | ~10MB | Phase 2 |
| Node.js | libnode.so | node | ~80MB | Phase 2 |
| git | libgit.so | git | ~15MB | Phase 2 |
| curl + libssl | libcurl.so | curl | ~10MB | Phase 2 |
| Python | libpython.so | python3 | ~30MB | Phase 2 |
| sqlite3 | libsqlite3.so | sqlite3 | ~2MB | Phase 2 |

**Phase 1**: bash + 依存ライブラリのみ。PTY接続の動作確認。
**Phase 2**: 基本ツール同梱。Claude Codeが使えるレベル。

## デュアルモード設計

### モード切替

| モード | 対象 | ターミナル実行 | セッション永続化 | セットアップ |
|-------|------|-------------|--------------|------------|
| **Built-in (デフォルト)** | 全ユーザー | linker64 + JNI forkpty | アプリkillで消失 | 不要 |
| **Termux (上級者向け)** | パワーユーザー | 既存TCPブリッジ | tmux経由で永続 | 手動 |

- デフォルトはBuilt-inモード。Termuxインストール不要
- Settings画面に「Termux接続」オプションを残す
- SetupWizardからTermux必須ステップは消す
- Termuxモードの接続・復帰は上級者前提のため手厚いガイド不要

### コード方針

**残すコード（Termuxフォールバック用）:**
- `lib/use-termux-bridge.ts` — WebSocket Bridge通信
- `shelly-bridge/` — bridge.js, start-shelly.sh
- `modules/termux-bridge/` — TermuxBridge Native Module
- `ShellyTerminalSession.kt`のTCP接続パス
- tmux-manager.ts

**変更するコード:**
- `ShellyTerminalSession.kt` — Built-in (PTY fd) とTermux (TCP) のデュアルパス
- `TerminalEmulatorModule.kt` — `createSession`にmode引数追加
- `terminal.tsx` — モードに応じた起動フロー分岐
- SetupWizard — Termux関連ステップをオプション化

**新規コード:**
- `termux.c` (JNI拡張) — forkpty + linker64 execve
- `LibExtractor.kt` — APKからバイナリ抽出
- `JNI.kt` — JNIブリッジクラス
- `HomeInitializer.kt` — filesDir/home/ 初期化

### createSessionのデュアルパス

```kotlin
AsyncFunction("createSession") { config: Map<String, Any> ->
    val mode = config["mode"] as? String ?: "builtin"

    when (mode) {
        "builtin" -> {
            // Plan B: JNI forkpty + linker64
            val libDir = LibExtractor.extractAll(context)
            val result = IntArray(2)
            JNI.createSubprocess(
                "/system/bin/linker64",
                LibExtractor.getBashPath(context),
                libDir.absolutePath,
                homeDir, rows, cols, result
            )
            ShellyTerminalSession.fromPtyFd(sessionId, result[0], result[1], emulator)
        }
        "termux" -> {
            // 既存: TCPブリッジ経由
            val port = config["port"] as Int
            ShellyTerminalSession.fromTcpPort(sessionId, port, emulator)
        }
    }
}
```

## セッション永続化

### Built-inモード
- bashクラッシュ/終了 → `waitFor(childPid)` → `onSessionExit` → 再起動ボタン
- アプリバックグラウンド → WakeLock (PARTIAL_WAKE_LOCK)で維持
- アプリkill → セッション消失（再起動で新規セッション）
- これは許容範囲: Built-inモードは軽量な使い方を想定

### Termuxモード
- tmux経由でセッション永続化（既存動作）
- アプリkill後もtmuxセッション生存
- 復帰時にtmux attachで接続復帰
- 上級者は自力で復旧できる前提

## セキュリティ考慮

- linker64トリックはAndroidの正規メカニズムではない。将来のAndroidバージョンで塞がれる可能性がある
- **緩和策**: Termuxフォールバック維持。linker64ブロック検知時にSettings画面で「Termuxモード推奨」を表示
- 同梱バイナリはTermuxのAPTリポジトリのビルド済みバイナリを使用（ライセンス: GPL v3 for bash, 各ツールのライセンスに準拠）
- 起動時にlinker64トリックの動作確認を行い、失敗時は自動でTermuxモードを提案

## Success Criteria

Phase 1:
- [ ] Shelly起動 → Termuxなしでbashプロンプトが表示される
- [ ] コマンド入力・出力が正常に動作する
- [ ] リサイズ（画面回転、Fold開閉）が即座に反映される
- [ ] セッション終了検知 + 再起動が動作する
- [ ] WakeLockでバックグラウンド維持

Phase 2:
- [ ] node, git, python, curl, sqlite3が全て動作する
- [ ] Claude Codeが起動・動作する
- [ ] SetupWizardからTermux関連ステップが消える
- [ ] APKサイズ < 250MB

## Risk & Mitigation

| リスク | 影響 | 緩和策 |
|-------|------|--------|
| linker64が将来塞がれる | 全機能停止 | Termuxフォールバック維持、targetSdk=28の選択肢 |
| coreutils/nodeのクロスコンパイル失敗 | Phase 2遅延 | Termuxの既存バイナリを流用 |
| PTY fd漏洩 | fd枯渇 | セッション破棄時に必ずclose()、finalizerでも |
| forkpty()がSELinuxで拒否 | Phase 1不能 | 検証済み: forkptyは同一UID内なので問題なし |
| APKサイズ肥大 | ダウンロード遅い | Split APK (ABI別) |
