# Claude Code 再有効化 — 実装計画 (2026-06-12)

> **スコープ**: 実装フェーズの**計画**(コードはまだ書かない)。専用ブランチ `feat/claude-on-device-reenable` で実施。main 不可侵。native/init/SELinux に触れるため push 前に agent code-review 必須。Codex を壊さないこと。
>
> **前提**: 真因は [2026-06-12-bash-tool-exit1-root-cause-investigation.md](./2026-06-12-bash-tool-exit1-root-cause-investigation.md) で OS レベル確定済み。claude は `3095aa47`(2026-05-29, v5.3.8 で Codex 一本化)で意図的撤去。本計画はそれを feasibility-gated で戻す。
>
> Plan エージェントが HEAD `410e5cf0` の実コードを精読して作成。

---

## TL;DR — 修正の核心は symlink 1本の張り替え

Bash tool exit 1 の真因は「CC が spawn する `$HOME/bin/bash` が **libbash.so(共有ライブラリ)への symlink** で raw execve 不可(EACCES)」。**native launcher `shelly_shell` は既にビルド済み・`$libDir/shelly_shell` に展開済み**(LibExtractor.kt:139,161)で、内部で `linker64 libbash.so "$@"` を実行する。よって **`$HOME/bin/bash` の symlink 先を `libbash.so`→`shelly_shell` に変えるだけ**で raw spawn が直接実行可能になる。残りは claude() 関数の復活・install 経路・preload(L1)。

---

## 前提検証(実コードとの照合 — Plan エージェント確認済み)

| 当初の前提 | 実コード確認 |
|---|---|
| `shelly-shell-launcher.c` が linker64+libbash.so へ remap | ✅ 正確(`:168-173`)。`bash -c`/`--noprofile --norc -c` 等**任意引数を透過**。env に LD_PRELOAD/SHELL/BASH/PATH 注入(`:43-150`) |
| launcher バイナリが `$libDir` に展開済み | ✅ `LibExtractor.kt:139` で `libshelly_shell.so → shelly_shell` 展開、`:161` ALWAYS_REFRESH。**既に存在し常に最新** |
| `$HOME/bin/bash` は symlink(`~1957-1961`) | ✅ ただし**先は `$libDir/libbash.so`(共有ライブラリ)**。これが raw spawn EACCES の直接原因 |
| `cleanupRemovedCliRuntime` 2780-2809 | ⚠️ 呼び出し**1083行**、定義**2780-2821**(targets 2785-2802 + 空親削除 2810-2820) |
| `claude()` は 3095aa47 で削除 | ✅ ただし削除されたのは v218 の**musl/native/legacy 3層巨大関数**。**そのまま復元不可**(musl PoC は FAIL 確定) |
| polyfill は HomeInitializer.kt 生成 | ❌ 実は **`shelly-runtime-update.js`(v218版)が生成**。現 HEAD は Codex 専用(`runtimeRoot=.shelly-runtime/codex` 固定)で polyfill 生成は削除済み |
| 同梱 claude npm 資産 | ❌ **存在しない**(assets は Codex の `cli-tools.tar.gz` のみ)。**実行時 npm install 必須** |

**設計結論**: v218 の musl/native 路線は捨て、**「extracted-Node で cli.js@2.1.112 を回す単層 claude()」+「`$HOME/bin/bash`→shelly_shell」** の最小構成にする。

---

## 実装手順(順序付き・ファイル参照付き)

### Step 0 — ブランチ作成
`git switch -c feat/claude-on-device-reenable`(main 不可侵)。

### Step 1 — `$HOME/bin/bash` を native launcher へ向ける【核心・A】
`HomeInitializer.kt:1957`
```kotlin
// 現状: __shelly_bash_target="$SHELLY_LIB_DIR/libbash.so"
// 変更: __shelly_bash_target="$SHELLY_LIB_DIR/shelly_shell"
```
- これで `spawnSync('$HOME/bin/bash', ['-c','...'])` が**直接 execve 可能**(libDir ラベルは exec 許可, CLAUDE.md:208)。
- **シェル関数 `bash()`(`:1977`)はそのまま残す** — 対話シェルでは関数が PATH バイナリを shadow(対話=関数経路、非対話 raw spawn=バイナリ経路、役割分担で衝突なし)。
- `export SHELL="$HOME/bin/bash"`(`:1967`)は不変(symlink 先だけ変わる)。
- **要実機確認**: launcher の `SHELL=$HOME/bin/bash` 再注入(`:86`)が再帰 spawn ループを生まないか(bash の子は libbash.so で launcher を再経由しない=ループなしと判断、実機で裏取り)。

### Step 2 — `cleanupRemovedCliRuntime` から claude を除外【B】
`HomeInitializer.kt:2785-2802, 2810-2814`。**削除をやめる**: `File(bin,"claude")`(:2786)、`.claude-tmp`(:2789)、`runtime/claude`(:2790)、`runtime/claude-extracted`(:2791)、`shellyCli/.../claude-code`(:2793)、`libRoot` の claude-code/extracted(:2795-2796)、`libRoot/claude`(:2798)、`@anthropic-ai` 空親(:2811,2813)。
**残す(legacy なので削除継続)**: gemini 系(:2787,2792,2794,2797)、musl 遺物(:2799-2801)。
- cleanup は毎起動実行(:1083)なので、install 先が消されなくなることを Step 7 で確認。

### Step 3 — claude install 経路を新設【B】
同梱資産が無いため**実行時 npm install** が現実解。
- **案A(推奨)**: claude() 初回呼び出しで `~/.shelly-cli/node_modules/@anthropic-ai/claude-code` が無ければ bundled node で `npm install @anthropic-ai/claude-code@2.1.112` を実行。**2.1.112 = cli.js を同梱する最終 npm release**(v218 注釈 :507。2.1.113+ は cli.js→Bun SEA 化, #50270)。install 先 `~/.shelly-cli/node_modules/...`。
- 案B(非推奨): `shelly-runtime-update.js` に claude tool 再追加(重い・brittle、将来課題)。
- **リスク**: ネットワーク無しでは install 不可(初回オンライン前提・以後キャッシュ)。2.1.112 が古く API 互換切れの可能性 → Step 7 の bare REPL で必ず検証。

### Step 4 — 最小 `claude()` を新規生成【B/C】
`HomeInitializer.kt`、codex() 生成(:2059)直後に挿入。v218 の3層は**復元せず**最小形:
```sh
claude() {
  local __cli="$HOME/.shelly-cli/node_modules/@anthropic-ai/claude-code/cli.js"
  # 案A: __cli 不在なら npm install（Step 3）
  __shelly_paste_tui_begin
  SHELL="$HOME/bin/bash" BASH="$HOME/bin/bash" CLAUDE_CODE_SHELL="$HOME/bin/bash" \
  CLAUDE_CODE_TMPDIR="$HOME/.claude-tmp" \
  NODE_OPTIONS="--require $HOME/.shelly-claude-node-preload.js" \
  _run "$SHELLY_LIB_DIR/node" "$__cli" "$@"
  local __rc=$?; __shelly_paste_tui_end; return $__rc
}
```
- **C**: `SHELL`/`BASH`/`CLAUDE_CODE_SHELL` を `$HOME/bin/bash`(=shelly_shell) に**明示固定** → CC の Bash tool は `$SHELL` を spawn → shelly_shell → 動作。Node `shell:true`(ENOENT)に到達させない。
- `CLAUDE_CODE_TMPDIR=$HOME/.claude-tmp`(OAuth PKCE の /tmp 不可問題, v218 注釈 :356)。
- TUI paste マーカー(:1857-1858 既存ヘルパ)流用。

### Step 5 — Bun polyfill preload 復活【L1・最大の未知数】
`HomeInitializer.kt` に inline 生成ブロック追加(または runtime-update.js から移植)。**まず Step 4 を polyfill 無しで実機テストし、Bash tool が exit-1/空出力なら**復活:
- L1 return-contract を満たす: `Bun.spawn().stdout` が `.text()` 可能な ReadableStream / `.exited` が number / `Bun.spawnSync().success` が boolean。
- 移植元: `git show 3095aa47^:.../shelly-runtime-update.js` の polyfill 本体。**ただし `shell` 既定値を `/system/bin/sh`→`$HOME/bin/bash`(shelly_shell)に書き換え**。
- **フォールバック**: polyfill でも駄目なら cli.js の `spawn(...,{shell:true})` を静的パッチで `shell:"$HOME/bin/bash"` に書き換え(Node の shell 解決を回避)。`PATCHER_JS` に claude op 復活。

### Step 6 — BASHRC_VERSION bump【E】
`HomeInitializer.kt:1044` `BASHRC_VERSION = 225 → 226`。bump 忘れると実機 .bashrc が再生成されず**全変更が無効**。

### Step 7 — 検証ゲート(マージ前必須)【D】
実機 Z Fold6 で順に: (1)`claude --version` (2)`claude -p "say hi"` (3)**bare `claude` REPL 起動**(memory 規約: runtime/route 変更は bare-TUI 必須、--version/-p だけ不可) (4)REPL で Bash 実行依頼 + `ANTHROPIC_LOG=debug` で a)spawn が `$HOME/bin/bash`(EACCES でない) b)`~/.claude/shell-snapshots/snapshot-bash-*.sh` 生成 c)Bash tool exit 0 + 正しい stdout (5)**Codex 非回帰**(`codex --version`/bare codex REPL/Codex の Bash tool)。1〜5 全通過 + Codex 非回帰で初めてマージ可。

### Step 8 — レビュー・rollout・rollback【E】
- **agent code-review 必須**(native/init/SELinux, `/code-review high`)。
- **staged rollout**: claude() を `SHELLY_ENABLE_CLAUDE=1` gate で当初 opt-in、安定後に既定有効化。
- **rollback**: (a) BASHRC_VERSION 戻し再生成 (b) Step1 symlink を libbash.so に戻す (c) claude() ブロック削除。`shelly_shell` を外しても Codex 無影響。

---

## 残る未知数 / ブロッカー候補
1. **L1 Bun polyfill(最大)**: extracted-Node で CC が Bun API を呼ぶ箇所を polyfill が忠実に転送するか。Step 5 で対処、最終フォールバックは cli.js 静的パッチ。
2. **cli.js@2.1.112 の API 互換**: 古い版なので Anthropic API 側で弾かれる可能性 → bare REPL で検証。
3. **launcher 再帰 spawn**: Step 1 の懸念、実機で裏取り。
4. **ネットワーク前提**: 初回 npm install にオンライン必須。

## Critical Files
- `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt`(:1044 version, :1957-1962 symlink, :1967 SHELL, :2059 codex template, :2780-2821 cleanup, claude() 新規)
- `modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js`(polyfill/install の移植元・先)
- `modules/terminal-emulator/android/src/main/java/.../LibExtractor.kt`(:139/:161 shelly_shell 展開確認、変更不要)
- `modules/terminal-emulator/android/src/main/jni/shelly-shell-launcher.c`(launcher 挙動の根拠、変更不要)
- 参照(git): `3095aa47^` の HomeInitializer.kt / shelly-runtime-update.js(削除された claude()/polyfill の移植元)

---

## 関連
- 真因: [2026-06-12-bash-tool-exit1-root-cause-investigation.md](./2026-06-12-bash-tool-exit1-root-cause-investigation.md)(L6 OS レベル CONFIRMED + feasibility=YES)
- 観測基盤: [2026-06-10-bash-tool-exit1-observability-plan.md](./2026-06-10-bash-tool-exit1-observability-plan.md)
- DEFERRED.md: Claude Code Bash tool Exit code 1 — 本計画で「fixable・実装計画あり」に更新
