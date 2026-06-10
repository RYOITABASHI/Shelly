# Claude Code パッチ済み公式バイナリ PoC — 詳細計画 (2026-06-10)

> **目的**: 公式 Claude Code バイナリ (Bun SEA) を Shelly の bionic + Knox 環境で動かせるかを 1〜2 日級の PoC で白黒つける。実装ではなく**検証**。現行 extracted Node 経路 ([2026-06-10-claude-code-on-device-investigation.md](./2026-06-10-claude-code-on-device-investigation.md) 参照) を置き換える/補完する候補の物理可否を判定する。
>
> **前提**: ネットワーク/リモート/Termux 不使用。サブスク認証 (`CLAUDE_CODE_OAUTH_TOKEN` または credential transplant)。

---

## 0. 調査で確定した前提 (PoC 設計の根拠)

| 事実 | ソース | 設計への影響 |
|---|---|---|
| ferrum は **glibc** linux-arm64 バイナリに `patchelf --set-interpreter $PREFIX/glibc/lib/ld-linux-aarch64.so.1` を当て、`unset LD_PRELOAD` して**直接 exec**。`--set-rpath` 不使用 | ferrum install.sh (WebFetch 実取得) | Track G の手順そのもの。Knox/S26 Ultra で実証済 = 最有力 |
| **musl 版は「1 ファイル」ではない**: 公式 docs が `libgcc` + `libstdc++` + `ripgrep` の同梱と `USE_BUILTIN_RIPGREP=0` を要求 | code.claude.com/docs/en/setup (Alpine 節, 実取得) | エージェント2 の ELF 解析は不完全。musl も C++ ランタイムが要る |
| musl libs は Termux glibc と違い **prefix ハードコードがなく再配置可能** | termux-packages#5982 (glibc は不可) | musl は Shelly 自前 prefix でそのまま使える = 軽さの源 |
| Shelly は **arm64-v8a only / minSdk 24** | [app.config.ts:148](../../../app.config.ts), [build.gradle:20](../../../modules/terminal-emulator/android/build.gradle) | 単一 ABI の musl/glibc を 1 本同梱すれば済む |
| **SELinux**: untrusted_app は app_data_file を直接 execve 不可。`$libDir` (termux-libs) ラベルは exec 許可、`/system/bin/linker64` 経由が必須 | [HomeInitializer.kt:1825](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt) `_run`、CLAUDE.md Architecture Decisions | パッチ済バイナリも `$libDir` 展開 + linker64 経由で起動する必要あり。**ただしパッチ済バイナリは独自 interpreter を持つので linker64 経由が成立するか自体が PoC の核** |
| repo に **patchelf は未導入** | Explore grounding | PoC 用に NDK ホストで patchelf するか、on-device patchelf バイナリを一時同梱 |

---

## 1. PoC が答えを出す問い (Exit Criteria)

1. **Q1 (起動)**: パッチ済 claude バイナリが Shelly の `$libDir` から `--version` を返すか？(Knox の app_data_file exec 制約を独自 interpreter で踏み抜けるか)
2. **Q2 (Bash tool)**: `claude -p "run: echo OK" --allowedTools Bash` が **exit 0** で `OK` を返すか？(現行 extracted Node 経路の積年の exit 1 問題が、公式バイナリ経路では出ないか)
3. **Q3 (認証)**: `CLAUDE_CODE_OAUTH_TOKEN` (PC で `claude setup-token` 発行) で transplant なしに `-p` が通るか？
4. **Q4 (TUI)**: 対話 `claude` TUI が Shelly の JNI PTY 上で描画・入力できるか？(任意・Q1-3 が通ってから)

**判定**: Q1 NG → パッチ済バイナリ経路は物理的に不可、extracted Node 一本化を確定。Q1 OK / Q2 NG → exit 1 は CC harness 全般の問題 (経路非依存) と確定し、観測基盤 plan ([姉妹spec](./2026-06-10-bash-tool-exit1-observability-plan.md)) に合流。Q1+Q2 OK → 公式バイナリ経路が extracted Node の上位互換候補に昇格。

---

## 2. 2 トラック構成

PoC は**ホスト PC (WSL/Linux) で patchelf 済みバイナリを作り、adb push で Shelly の `$libDir` 相当に置いて手動検証**する。APK ビルドは PoC 段階では不要 (確証が出てから build-android.yml に組み込む)。

### Track G — glibc バイナリ (ferrum 方式、本命・実証済み前例あり)
**賭けどころ**: glibc 一式 (~50MB) を `$libDir` に同梱して再配置できるか。Termux glibc は prefix ハードコードで流用不可なので、Alpine 等の**再配置可能な glibc** か、`--set-rpath` で lib パスを焼き込む。

手順:
1. ホストで公式バイナリ取得:
   `curl -fsSLO https://downloads.claude.ai/claude-code-releases/<VER>/linux-arm64/claude`
   (manifest.json の sha256 で検証 — docs の Binary integrity 節)
2. glibc ランタイム一式を用意 (`ld-linux-aarch64.so.1` + libc.so.6 + libgcc_s + libstdc++ + libm 等)。候補: Debian arm64 の glibc deb 展開、または Alpine の gcompat ではなく素の glibc。
3. `patchelf --set-interpreter <libDir>/glibc/ld-linux-aarch64.so.1 --set-rpath <libDir>/glibc/lib claude`
   - ferrum は `--set-rpath` 不使用 (Termux が LD_LIBRARY_PATH で解決) だが、Shelly は `_run` で `LD_LIBRARY_PATH=$SHELLY_LD_LIBRARY_PATH` を渡すので**同じく LD_LIBRARY_PATH 経由でも可**。両方試す。
4. **重要な分岐検証**: パッチ済バイナリは PT_INTERP が `<libDir>/glibc/ld-...` を指す。Knox は (a) `/system/bin/linker64 <bin>` 経由で起動できるか、(b) glibc の ld を interpreter とする ELF を kernel binfmt が直接 exec 許可するか — Shelly の既存 `_run` は bionic linker64 前提なので、**glibc ld を interpreter とする ELF を linker64 に食わせて動くかは未知**。ferrum (Termux) は kernel 直接 exec で動いている。
   - 検証 A: `LD_LIBRARY_PATH=<libDir>/glibc/lib /system/bin/linker64 <bin> --version` (Shelly 流)
   - 検証 B: glibc ld を直接呼ぶ `<libDir>/glibc/ld-linux-aarch64.so.1 --library-path <libDir>/glibc/lib <bin> --version`
   - 検証 C: パッチ後そのまま `./claude --version` (kernel binfmt が PT_INTERP を解決できるか)
5. `unset LD_PRELOAD` (ferrum 必須)。`USE_BUILTIN_RIPGREP=0` + `PATH` に Shelly の `rg` (librg.so→rg)。`CLAUDE_CODE_TMPDIR` 設定。

### Track M — musl バイナリ (軽量・未実証)
**賭けどころ**: musl ランタイム (~5MB、再配置可能) で足りるか。glibc 一式が重すぎる/動かない場合の本命。

手順:
1. ホストで取得: npm の `@anthropic-ai/claude-code-linux-arm64-musl@<VER>` を展開し `package/claude` を取り出す (240MB、ET_EXEC 非 PIE)。
**前例 (重要)**: bug #117 (DEFERRED.md History 2026-04-21) で **DNS patch 済み musl** (`src/network/resolvconf.c` を patch して cross-build した ld-musl v1.2.4) 経由で `./ld-musl ./claude --print "OK"` が Termux 実機成功済み (claude 2.1.116)。**素の ld-musl は DNS 解決で hang した**点に注意 — Track M / 検証B はこの再現だが、resolvconf patch (または `/etc/resolv.conf` 相当の供給) が前提条件。当時も Bash tool までは未確認、Shelly 本番 route には定着しなかった。

2. **musl ランタイム一式を Alpine arm64 から抽出** (補正後の正確なリスト):
   - `/lib/ld-musl-aarch64.so.1` (= libc.musl-aarch64.so.1、~1MB)
   - `libgcc_s.so.1` (musl 版)
   - `libstdc++.so.6` (musl 版)
   - ripgrep は Shelly 同梱の `rg` を `USE_BUILTIN_RIPGREP=0` で流用
3. `patchelf --set-interpreter <libDir>/musl/ld-musl-aarch64.so.1 --set-rpath <libDir>/musl claude`
4. 検証 A/B/C は Track G と同型 (linker64 経由 / ld-musl 直接 / kernel binfmt 直接)。
   - **特記**: Shelly v29 は「bionic linker64 で musl ld をロード」して失敗済み。今回は **patchelf で interpreter を musl ld に書き換えてから linker64 を介さず ld-musl 直接呼び or kernel binfmt** を試す点が v29 と違う。
5. **Bun self-exe 懸念**: Bun SEA は `/proc/self/exe` から自身の `.bun` section を読む。ld 経由起動だと `/proc/self/exe` が ld を指して self-extract が壊れる既知問題 (bun-on-termux の env-preload 知見)。→ patchelf で interpreter 書換 + kernel 直接 exec (検証 C) なら `/proc/self/exe` が claude 自身を指すので回避できる**はず**。検証 C が musl で最重要。

---

## 3. オンデバイス実行手順 (両トラック共通)

`$libDir` = `/data/data/dev.shelly.terminal/files/termux-libs` ([LibExtractor.kt getLibDir](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt))。PoC では adb push で配置 (本番は LibExtractor + jniLibs)。

1. `adb push` でパッチ済 `claude` + ランタイム lib 群を `/sdcard/Download/claude-poc/` へ。
2. Shelly ターミナル内 bash で `$libDir` 配下の書込可能な PoC ディレクトリ (例 `$HOME/.shelly-claude-poc/`) にコピー。**注意**: SELinux exec 可否は `$libDir` (termux-libs) ラベルに依存。`$HOME` 配下は app_data_file で exec 不可の可能性が高い → **PoC でも実際に exec するバイナリは LibExtractor が触る `$libDir` 直下に置く必要がある**。adb で `run-as dev.shelly.terminal` 経由か、一時的に LibExtractor のリストに足してビルドするのが確実。
3. `claude()` 関数の代わりに PoC ラッパーを定義 (既存 [codex TUI 起動 HomeInitializer.kt:2170-2198](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt) を雛形に):
   ```bash
   claude_poc() {
     unset LD_PRELOAD
     USE_BUILTIN_RIPGREP=0 \
     PATH="$libDir:$HOME/bin:$PATH" \
     CLAUDE_CODE_TMPDIR="$HOME/.claude-tmp" \
     CLAUDE_CODE_OAUTH_TOKEN="$(cat $HOME/.claude-poc-token)" \
     LD_LIBRARY_PATH="$libDir/musl" \
     "$libDir/claude_poc_bin" "$@"   # 検証 C 形。A は linker64 prefix
   }
   ```
4. Q1: `claude_poc --version` → Q3: `claude_poc -p "say OK"` → Q2: `claude_poc -p "run echo OK" --allowedTools Bash` → Q4: `claude_poc` (bare TUI)。
5. クラッシュ時は logcat + tombstone (`/data/tombstones/`、要 run-as)。シグナル 132-139 のパターンを記録 ([姉妹spec](./2026-06-10-bash-tool-exit1-observability-plan.md) の観測基盤を先に当てると診断が速い)。

---

## 4. 認証 PoC (Q3 詳細)

1. **PC 側で** `claude setup-token` → ブラウザ OAuth → `sk-ant-oat01-...` (1 年有効) を取得。
2. Shelly の SecureStore か `$HOME/.claude-poc-token` (PoC 限り) に置き、`CLAUDE_CODE_OAUTH_TOKEN` で注入。
3. **2026-06-15 リスク**: Agent SDK クレジット制度開始後、`-p` がクレジット消費になる/旧クライアント拒否が来ないか観察。対話 TUI (Q4) は従来サブスク枠なので Q4 が通れば課金影響は小さい。
4. transplant 代替: `~/.claude.json` + `~/.claude/` を /sdcard 経由 (bug #102 既知手順、9h 失効・refresh 不安定なので setup-token を優先)。

---

## 5. 作業見積もりと撤退ライン

| フェーズ | 内容 | 時間 | 撤退条件 |
|---|---|---|---|
| P0 | ホストで Track G/M の patchelf 済バイナリ作成 + ローカル (x86 Docker arm64 emu or 実 arm64) で `--version` 確認 | 2-4h | どちらも host arm64 で動かないなら設計見直し |
| P1 | `$libDir` 配置 + SELinux exec 可否確認 (Q1) | 2-3h | linker64 経由・ld 直接・binfmt 直接の 3 検証が全滅 → パッチ済経路は不可、extracted Node 確定 |
| P2 | OAuth (Q3) + `-p` Bash tool (Q2) | 2-3h | — |
| P3 | TUI (Q4、任意) | 1-2h | — |

**最小コストで答えが出る順**: P1 の検証 C (musl + kernel binfmt 直接 exec) が一番 Bun self-exe 問題を回避できる本命。ここが通れば Track M が最有力、ダメなら Track G (glibc + ferrum 実証済み方式) にフォールバック。

---

## 6. PoC 後の意思決定マトリクス

| Q1 | Q2 | 結論 |
|---|---|---|
| NG | — | パッチ済バイナリ不可。**extracted Node 一本化を確定**、本 spec をクローズ |
| OK | NG | exit 1 は経路非依存の CC harness 問題。**観測基盤 plan に全投資**、バイナリ経路は保留 |
| OK | OK (musl) | **Track M を v7.0.0 Experimental 候補**に昇格。+5MB で済むので APK 影響小 |
| OK | OK (glibc only) | Track G を候補に。ただし +50MB の glibc 同梱コストと天秤 |

---

## 関連
- 調査本体: [2026-06-10-claude-code-on-device-investigation.md](./2026-06-10-claude-code-on-device-investigation.md)
- 観測基盤: [2026-06-10-bash-tool-exit1-observability-plan.md](./2026-06-10-bash-tool-exit1-observability-plan.md)
- 既存 exit 1 記録: DEFERRED.md (Claude Code Bash tool Exit code 1, P1)
- Codex↔CC レビューループで実機検証を回す ([memory: workflow_codex_cc_review_loop])
