# Claude Code Bash tool Exit code 1 — 観測基盤 設計計画 (2026-06-10)

> **目的**: DEFERRED.md (P1) が「当て推量ビルド禁止、まず観測手段を確立する」と結論づけた積年の Bash tool exit 1 を、**1 仮説 1 証拠**で潰せる観測基盤を設計する。実装ではなく**設計のみ**。
>
> **新しい切り分けの仮説**: ferrum の claude-code-android が公式 glibc バイナリ + patchelf で Bash tool を Samsung S26 Ultra/Knox 上で動かしている状況証拠から、**exit 1 は Shelly の extracted Node 経路 (Bun polyfill) 固有の問題である可能性**が浮上した。観測基盤はこの「経路依存 vs CC 全般」の切り分けを最優先で出す。

---

## 0. 何が分かっていないか (DEFERRED.md より)

- Claude Code 2.1.143+ で Bash tool harness / nested shell / env scrub / bionic `LD_PRELOAD` interposer の組合せが頻繁に変わり、`.bashrc_version` 148〜186 で約 40 改訂しても安定修正に至らず。
- 主な仮説 (いずれも未確証): `libexec_wrapper.so` null-deref、`env` relay / SELinux EACCES、`execve()` stack frame overflow。
- 観測の壁: `--print` canary が hang する、`SHELLY_CLAUDE_PATCH_TRACE` 自体が起動を阻害する、リモートスクショ往復では切り分けきれない。

## 1. Bash tool の実行経路 (grounding で確定)

Claude CLI が Bash tool でコマンドを実行する経路:
1. claude が `export SHELL=$HOME/bin/bash` し、`child_process.spawn` でシェル起動
2. [shelly-shell-launcher.c の main() :152-184](../../../modules/terminal-emulator/android/src/main/jni/shelly-shell-launcher.c) が `$SHELL` を捕捉し、`argv` を `/system/bin/linker64 $libDir/libbash.so ...` にリマップ (ヘルパ `lib_dir_from_env`/`copy_env_with_preload` は :20-150、[LINKER64 定数:18](../../../modules/terminal-emulator/android/src/main/jni/shelly-shell-launcher.c))
3. `copy_env_with_preload()` が `LD_PRELOAD=$libDir/libexec_wrapper.so`、`LD_LIBRARY_PATH=$libDir`、`SHELL=$HOME/bin/bash` を再注入
4. `execve(LINKER64, ...)` ([:181](../../../modules/terminal-emulator/android/src/main/jni/shelly-shell-launcher.c))
5. bash 内の各コマンドの execve は [exec-wrapper.c](../../../modules/terminal-emulator/android/src/main/jni/exec-wrapper.c) (libexec_wrapper.so) が raw syscall (`svc #0`、arm64 inline asm :122-146) で intercept し linker64 経由にリライト

**exit 1 が出るのはこのチェーンのどこか。** 観測基盤はチェーンの各ノードにプローブを置く。

**既にある足場** (再利用する):
- exec-wrapper.c に `trace_env_keys[]` ([:41-44](../../../modules/terminal-emulator/android/src/main/jni/exec-wrapper.c): PATH/SHELL/BASH/HOME/TMPDIR/SHELLY_LIB_DIR/LD_LIBRARY_PATH/LD_PRELOAD) と build marker (`shelly-exec-wrapper:v217:bti-open-interposer`) — **環境トレースの土台が既にある**
- `SHELLY_CLAUDE_DIAG` ([HomeInitializer.kt:636-646](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt)): preload の uncaughtException / `[SHELLY-BUN-MISSING]` polyfill 漏れ検出
- `__shelly_consume_runtime_failures` (HomeInitializer.kt の BASHRC changelog コメント [:592-596](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt) に記述、`~/.shelly-runtime/.runtime-failures` → `.failed-versions` を drain) + シグナル 132-139 のクラッシュ分類 `__shelly_codex_native_crash_rc` ([:1596-1597](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt)): クラッシュ記録 cooldown DB の足場

**欠けている足場** (PoC で追加):
- on-device strace/syscall trace は**未同梱** (Explore 確認)
- unstripped `.so` の保持なし (CI は `strip --strip-unneeded`、build ID はあるが symbol table 破棄) → **tombstone を関数名まで解決できない**

---

## 2. 観測基盤の 3 層 (設計)

### 層1 — 切り分けプローブ (最優先・最小コスト)
**問い: exit 1 は (a) extracted Node/Bun polyfill 固有か、(b) Shelly のシェル/exec チェーン固有か、(c) CC harness 全般か。**

3 経路で同一の Bash tool テスト (`claude -p "run: echo OK" --allowedTools Bash`) を回し、結果を突き合わせる:
1. **現行 extracted Node 経路** (`~/.shelly-runtime/claude/current/cli.js` + Bun polyfill preload) ← 今 exit 1 が出ている経路
2. **legacy v2.1.112 cli.js 経路** (`SHELLY_FORCE_LEGACY_CLAUDE=1`) ← Bun polyfill を通らない純 JS
3. **パッチ済公式バイナリ経路** ([姉妹spec](./2026-06-10-claude-patched-binary-poc-plan.md) の Track G/M) ← Node も Bun polyfill も通らない

| 1 | 2 | 3 | 結論 |
|---|---|---|---|
| NG | OK | — | **Bun polyfill 固有** → preload の Bun.spawn stub 等が原因。最も直しやすい |
| NG | NG | OK | extracted+legacy 共通 = Shelly シェル/exec チェーンと CC harness の相性。バイナリ経路へ移行が解 |
| NG | NG | NG | **CC harness 全般** = bionic シェル環境そのもの。最難関、要 層2/層3 |

この 3 セル表が出るだけで「次にどこを掘るか」が確定する。**まずここに投資する。**

### 層2 — syscall トレース (どの syscall が失敗するか)
exit 1 はサブプロセスの非ゼロ終了。bash が起動したコマンドのどの execve/openat が EACCES/ENOENT になるかを捕まえる。

選択肢 (軽い順):
1. **exec-wrapper.c の trace 拡張** (既存 `trace_env_keys` を活用): `SHELLY_EXEC_TRACE=1` ゲートで、intercept した各 execve の argv[0]・解決後パス・rc・errno を `$HOME/.shelly-exec-trace.log` に追記。**新規 .so を増やさず既存 interposer に足すだけ**なので Knox/SELinux リスク最小。
2. **strace バイナリ同梱**: NDK で arm64 strace をビルドし jniLibs に `libstrace.so→strace` で同梱 (既存 LibExtractor パターン [LibExtractor.kt:12-148](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt))。`strace -f -e trace=execve,openat,access claude -p ...`。**注意**: Android の seccomp/ptrace 制約で untrusted_app が自プロセスを ptrace できるかは要確認 (`PR_SET_PTRACER` / yama)。strace 自体が動かない可能性 → 選択肢1を先に。
3. **bash の xtrace**: claude が起動する bash に `BASH_XTRACEFD` + `set -x` を仕込み、Bash tool が実際に渡すコマンド文字列をキャプチャ。harness が何を実行しようとして 1 を返すのか (コマンド自体が失敗か、起動が失敗か) を切り分け。

### 層3 — symbol 化クラッシュ解析 (クラッシュ系の場合)
exit 1 がシグナル (132-139) 由来なら tombstone 解析。現状 unstripped .so がないので:
1. **CI で symbolized .so を artifact 保持**: build-android.yml の `aarch64-linux-gnu-strip --strip-unneeded` 呼び出し ([:256 / :275 / :322](../../../.github/workflows/build-android.yml)、binutils install は :130-139) の**前**に `libexec_wrapper.so` / `shelly_shell` / `libbash.so` の unstripped コピーを build artifact に退避。build ID ([readelf -n で確認:675-699](../../../.github/workflows/build-android.yml)) で実機 tombstone とマッチング。
2. 実機 tombstone は `/data/tombstones/` (要 `run-as dev.shelly.terminal` または developer options)。`ndk-stack -sym <unstripped-dir> -dump tombstone_xx` で関数名解決。
3. これで DEFERRED.md が挙げた「`libexec_wrapper.so` null-deref」仮説を初めて**証拠付きで**肯定/否定できる。

---

## 3. 設計原則 (DEFERRED.md の教訓を制度化)

1. **当て推量ビルド禁止**: 観測 → 仮説 → 証拠 → 修正の順を守る。観測なしの修正コミットは main に入れない。
2. **観測手段がそれ自体バグを隠さないこと**: `SHELLY_CLAUDE_PATCH_TRACE` が起動を阻害した反省 → 新トレースは全て env ゲート (`SHELLY_EXEC_TRACE` 等) で、デフォルト無効・有効時もファイル追記のみ (stdout 汚染で PTY を壊さない)。
3. **`--print` canary hang 対策**: タイムアウト付き ([shelly-runtime-update.js の spawnSync timeout:15000 と同型](../../../modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js)) でラップし、hang 自体を 1 データポイントとして記録。
4. **1 仮説 1 証拠**: 層1 の 3 セル表で経路を確定してから層2/層3 に進む。同時に複数仮説を build しない。

---

## 4. 実行順と見積もり

| フェーズ | 内容 | 時間 | 出力 |
|---|---|---|---|
| O0 | 層1 切り分け: 3 経路で Bash tool テスト (パッチ済バイナリは [姉妹spec](./2026-06-10-claude-patched-binary-poc-plan.md) P1 完了後) | 1-2h | 3 セル表 = 次の投資先確定 |
| O1 | 層2-1: exec-wrapper.c に `SHELLY_EXEC_TRACE` 追加設計 (実装は別タスク) | 設計 1-2h | 失敗 syscall の argv/path/errno ログ仕様 |
| O2 | 層3-1: CI で unstripped .so を artifact 保持する build-android.yml 変更設計 | 設計 1h | tombstone symbol 化パイプライン |
| O3 | (クラッシュ系と判明時のみ) 実機 tombstone → ndk-stack | 2-3h | 関数名付きスタック |

**今回のスコープは O0 の準備 (3 経路を回す手順書) と O1/O2 の設計まで。** 実装は Codex↔CC レビューループ ([memory: workflow_codex_cc_review_loop]) で実機検証しながら別セッションで。

---

## 5. 姉妹 PoC との依存関係

層1 の経路3 (パッチ済バイナリ) は [claude-patched-binary-poc-plan.md](./2026-06-10-claude-patched-binary-poc-plan.md) の Q1 (起動) が通って初めて回せる。**実行順**: パッチ済 PoC の P1 (Q1) → 本 spec の O0 (層1 3セル表) → 結果次第で層2 or バイナリ経路移行。逆に言えば、パッチ済バイナリが起動しさえすれば「exit 1 が経路依存か」が即判定でき、両 spec が 1 つの実験で同時に前進する。

---

## 関連
- 調査本体: [2026-06-10-claude-code-on-device-investigation.md](./2026-06-10-claude-code-on-device-investigation.md)
- 姉妹 PoC: [2026-06-10-claude-patched-binary-poc-plan.md](./2026-06-10-claude-patched-binary-poc-plan.md)
- DEFERRED.md: Claude Code Bash tool Exit code 1 (P1) — 本 spec が「次の一手」を具体化
- ログタグ: ShellyExec / HomeInitializer (CLAUDE.md デバッグログタグ表)
