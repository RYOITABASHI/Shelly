# Claude Code 再有効化 — 実装ハンドオフ (2026-06-13)

> **目的**: ブランチ `feat/claude-on-device-reenable` での Claude Code 再有効化作業を、別環境/別セッションから再開できるようにする引き継ぎ。実機 (Galaxy Z Fold6, Android 16, Knox) で検証しながら進めた長時間セッションの全成果と、残る 1 個のブロッカーを記録。
>
> **関連**: [真因調査](./2026-06-12-bash-tool-exit1-root-cause-investigation.md) / [実装計画](./2026-06-12-claude-reenable-implementation-plan.md)。本ドキュメントが最新の実態。

---

## TL;DR — 現状

- **背景**: Claude Code は `3095aa47`(2026-05-29, v5.3.8 で Codex 一本化)で意図的撤去済み。本ブランチで feasibility-gated に復活中。
- **コミット済み (push 済み, branch `feat/claude-on-device-reenable`)**:
  - **Chunk 1** `ec1a140f`: `$HOME/bin/bash` symlink を `libbash.so` → `shelly_shell`(native launcher)に張替 + `cleanupRemovedCliRuntime` から claude 除外 + BASHRC_VERSION bump。
  - **Chunk 2** `52d037d4`: `claude()` 関数復活(@2.1.112 を `~/.shelly-cli` に npm install → cli.js を bundled node で `--require` polyfill 2枚 + `LD_PRELOAD=libexec_wrapper.so` + `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` で起動)+ 865行 Bun polyfill heredoc 復元(3095aa47^ から byte-identical)。
  - **Chunk 3** `3e47240e` + marker `e195717b`: `exec-wrapper.c` の `open`/`openat` を、codex 書換不要時は raw syscall でなく**本物の libc(dlsym RTLD_NEXT)に fall-through**。build marker v217→v218。
  - **merge** `c02b98a0`: origin/main をマージ(versionCode を 1495 超にするため。後述)。BASHRC_VERSION は衝突解決で **228**(main の v226 eval-bootstrap を維持し我々を 227/228 に再番号)。
- **進捗**: 各レイヤーを実機で潰し、**Chunk 3 (v218) で `uv_fs_close` SIGABRT (134) は解消確認**。
- **🔴 残るブロッカー**: claude 起動が**さらに奥で SIGSEGV**(`claude -p "hi"` → `Segmentation fault`, exit 139 / 対話 `claude` → ハング)。tombstone は出ない(Knox 環境で app-spawned crash は debuggerd に残らない)。**ここで時間切れ・bank**。

---

## 確定した事実(実機で検証済み・再litigateしない)

Bash tool exit-1 の根本原因と、各回避策の検証結果。すべて Z Fold6 実機 node v24.14.1 で確認。

1. **真因(L6)**: Claude Code の Bash tool / shell-snapshot 生成は node が `child_process.spawn` でシェルを起動するが、**Knox SELinux 下で app-data バイナリの raw execve は EACCES**。`$HOME/bin/bash` は元々 `libbash.so`(共有ライブラリ)への symlink で、生 execve 不可。
2. **node spawn 実測**(`spawnSync`): `sh`/`/bin/sh`/`/system/bin/sh` → ✅ st:0。`bash`/`$HOME/bin/bash`/`/usr/bin/env bash` → ❌ EACCES/ENOENT。Node `shell:true` → ENOENT。
3. **LD_PRELOAD が鍵**: node を `LD_PRELOAD=libexec_wrapper.so` で起動すると、execve が interposer 経由で linker64 にリダイレクトされ、`$HOME/bin/bash`(→shelly_shell)も `libbash.so` も spawn 成功(st:0)。**旧 claude()(v5.3.0 で動作)も同じ `LD_PRELOAD=$libDir/libexec_wrapper.so` + `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` を使っていた**(grep で確認)= proven レシピ。
4. **node24 の `--require` crash**: `LD_PRELOAD` 下で node24 が `--require` プリロードを CJS 解決する際、`trySelf → getNearestParentPackageJSON → ReadFileSync` で `CHECK_EQ(0, uv_fs_close(...))` (util.cc:279) が **SIGABRT (134)**。原因 = open/openat interposer が raw syscall を使い bionic libc の open path を迂回していたため。**`--require` 機構自体・cli.js 単体は LD_PRELOAD 無しなら正常**。trivial preload も正常。crash は「LD_PRELOAD + --require + main が cli.js(exports 付き package.json を持つ)」の組合せ。
5. **main も同じ crash に遭遇**: main の BASHRC v226 コメント =「shelly-update-clis Node helper を eval bootstrap で起動し Node の Android ReadFileSync ESM main-file 検出 crash を回避」。**同じ node24 ReadFileSync crash を別経路(codex updater)で踏み、eval-bootstrap で回避していた**。我々の native fix (Chunk 3) はその根治。
6. **Chunk 3 で 134 abort は解消**(v218 wrapper インストール後、あの abort はもう出ない)。
7. **`@anthropic-ai/claude-code@2.1.112`** が cli.js を同梱する最後の npm リリース(2.1.113+ は Bun SEA バイナリで Android SIGSEGV、6/11 PoC で確認済み)。npm install は `--force --omit=optional --no-save` + `npm_config_os=linux npm_config_cpu=arm64 npm_config_libc=musl` で成功(`added 1 package`)。`cli.js --version` は node で起動・`2.1.112 (Claude Code)` 表示成功。
8. **launcher.cjs 実験**: `--require` を避け、`.cjs`(CJS強制)で polyfill→cli.js を `require()`+dynamic `import()` するラッパーを package dir(package.json 隣接)に置くと `--version` は通った。が、これは v218 native fix 前の回避で、**v218 があれば標準 `--require` でよい**(launcher は不要)。

---

## 🔴 残るブロッカー: 起動奥の SIGSEGV

- **症状**: v218 wrapper インストール後、`claude -p "hi"` → `Segmentation fault`(exit 139, 出力ゼロ)。対話 `claude` → TUI に到達せずハング(Ctrl-C 効かず)。npm install(`added 1 package`)は成功し、その後の cli.js 起動で死ぬ。
- **134 (abort) とは別物**: uv_fs_close abort は v218 で消えた。これは**より深い SIGSEGV**。
- **tombstone なし**: `adb logcat` に node プロセスの debuggerd tombstone が出ない(Knox 環境の app-spawned crash 共通。原始 Bun SEA crash と同じ挙動)。logcat に出る `execSubprocess+2452` の libsigchain backtrace は **Shelly の execCommand 経路の別 crash**(セッション序盤からアプリ通常動作中に出ており libsigchain が SIG_DFL 処理・概ね無害)で、claude プロセスの crash ではない。
- **未実行の切り分けプローブ(次の一手)**:
  ```sh
  LD_PRELOAD="$SHELLY_LD_LIBRARY_PATH/libexec_wrapper.so" _run $SHELLY_LD_LIBRARY_PATH/node \
    --require $HOME/.shelly-node-compat-preload.js --require $HOME/.shelly-claude-node-preload.js \
    $HOME/.shelly-cli/node_modules/@anthropic-ai/claude-code/cli.js --version 2>&1 | tail -6; echo "EXIT=${PIPESTATUS[0]}"
  ```
  - `2.1.112`+EXIT=0 なら → segfault は `-p` の深い処理(snapshot 生成のシェル spawn / prompt 処理)。起動・preload は健全。
  - Segfault なら → preload を LD_PRELOAD 下で読む段階で死ぬ → **Chunk 3 の open fall-through(`g_open_fn`/`g_openat_fn` 変数 ABI 呼び)か Bun polyfill が疑わしい**。
- **次に試す仮説(優先順)**:
  1. 上記プローブで segfault locus を二分。
  2. polyfill 抜き(`--require` を compat のみ、bun polyfill 無し)で `claude -p` → segfault するか。polyfill の `Bun.spawn` stub 等が原因か切り分け。
  3. Chunk 3 の `g_openat_fn(dirfd, path, flags, mode)` variadic 呼びを疑う → 一時的に open fall-through を無効化(raw syscall に戻す)した v219 wrapper をビルドし、segfault が abort に戻るか確認(fall-through が segfault 源かの判定)。レビューでは ABI 正当と判断済みだが実機未確証。
  4. main の eval-bootstrap 方式(`node -e "process.argv[1]=...; require(cli)"`)を claude() にも適用してみる(main が同種 crash を回避した実績ある手法)。
  5. snapshot 生成を疑う場合: `CLAUDE_CODE_SHELL` や snapshot 無効化フラグ、`SHELL=/system/bin/sh` 等で claude のシェル経路を変えて切り分け。

---

## ビルド & インストール手順(重要な落とし穴あり)

- **CI**: `git push` は branch では自動ビルドしない(`build-android.yml` は `main` + `workflow_dispatch` のみ)。branch ビルドは `gh workflow run build-android.yml --ref feat/claude-on-device-reenable` → `gh run watch <id>`。~13分。`docs/**` 変更は paths-ignore でスキップされる(docs だけの push では CI 不要)。
- **build marker 同期**: `exec-wrapper.c` の marker を変えたら `.github/workflows/build-android.yml:718` の `check_marker` も同値に(でないと「Validate bionic exec wrapper」step で FATAL)。現在 v218。
- **versionCode**: `git rev-list --count HEAD`(`app.config.ts`)。**branch が main より遅れると versionCode が下がり、Knox が `INSTALL_FAILED_VERSION_DOWNGRADE` で拒否(`-r -d` でも拒否)**。対策 = `git merge origin/main` で count を上げてから再ビルド(uninstall するとログイン全消去なので避ける)。現在 merge 後 1501 > 端末 1495。
- **インストール**: `adb -s <serial> install -r ".apk2/app-release.apk"`(`-r` でデータ保持。再インストールでアプリは一旦終了 → 起動で HomeInitializer が .bashrc を新 version に再生成)。APK ~810MB。
- **CI build はたまに transient 失敗**(gradle step が無出力で落ちる=OOM/runner 喪失)。`gh run rerun <id> --failed` で再実行すれば通ることが多い(コンパイルエラーではない)。
- **ホスト C: ドライブ満杯に注意**: 本セッション中 C: が 99-100%(空き ~4G)になり `gh run download` が無言でスタックした(`$TEMP/gh-artifact.*.zip` に中途半端な DL が残る)。DL 前に空き容量確認。要 ~1.2GB(403MB zip + 810MB 展開)。

## 検証ゲート(マージ前)
bare `claude` REPL 実機 PASS 必須(memory ルール: runtime/route 変更は --version/-p だけ不可)。Bash tool で `pwd && echo OK` が exit 0 + 出力。`~/.claude/shell-snapshots/snapshot-bash-*.sh` 生成確認。**codex 非回帰必須**(Chunk 3 は codex も使う wrapper を触る — `codex --version` / bare codex REPL / codex の Bash tool)。

## 実機 scratch(掃除推奨)
デバッグ中に作った不要ファイル(claude() は使わない): `$HOME/claunch.js`, `$HOME/tp.js`, `$HOME/.shelly-node/`, `$HOME/.shelly-cli/.../claude-code/.shelly-*.cjs`, `$HOME/.shelly-cli/claude-bundled.js`, `$HOME/.shelly-claunch/`。

## 関連で見つけた別件
- **キーボードレイアウト崩れ**: ソフトキーボードを開くとペインが過剰に縮み黒い空白(二重インセット補正疑い)。別タスク `task_e72e167a` 化済み。Bash tool 修正とは無関係。
- **ホスト C: ドライブ 99%**: 要クリーンアップ(本セッションで gh 残骸 + claude-poc 233MB は削除済み)。
- **CI versionCode 非単調**: branch が main 遅れだと downgrade。merge 運用 or `SHELLY_ANDROID_VERSION_CODE` env での明示。

---

## レビュー状況
- Chunk 1 / Chunk 2 / Chunk 3 すべて agent code-review 通過(BLOCKER なし)。Chunk 3 (native exec-wrapper) も「無限再帰なし・codex shim byte 等価・variadic ABI 正・NULL fallback・errno 改善」で承認。ただし**残る SIGSEGV を踏まえると Chunk 3 の open fall-through が segfault 源である可能性は実機で未排除**(上記「次に試す仮説 3」)。
