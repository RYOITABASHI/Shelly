# Claude Code オンデバイス実装 — 経緯調査と今後の経路 (2026-06-10)

> 調査のみ。実装は未着手。3 エージェント (リポジトリ履歴 / Android OSS 検証 / CC アーキ + Codex 連携) の並行調査を統合したハンドオフ。

## TL;DR

1. **「ネイティブ断念」の正体は「Bun SEA バイナリ直接実行の断念」**であり、CC 自体は現在も Shelly で動いている。v29〜v59 (2026-04) で musl linker / proot / musl preload の 3 経路を試して全滅し、v67 以降「Bun SEA から埋め込み cli.js を抽出して Shelly 同梱 Node で実行する」extracted Node 方式に転換、これが v5.3.1 の正式サポートの実体。
2. **未解決の本丸は Bash tool exit code 1** (DEFERRED.md P1、40 ビルド超の試行でも未確定) と、**OAuth 400 による credential transplant 必須** (bug #102)。
3. **「Codex から CC を呼ぶ」経路は今日の Shelly で技術的に成立する**。`claude mcp serve` は誤解されがちな罠 (CC の頭脳は公開されない)。正解は Codex の shell から `claude -p` 直叩き、または zen-mcp-server の `clink`。ただし **2026-06-15 開始の Agent SDK クレジット制度**で `claude -p` はサブスク内の月次クレジット消費 (Pro $20 相当/月) になる — API 従量課金ではないが上限つき。対話 TUI は従来通り無制限枠。
4. **新発見が 2 つ**: ① Anthropic は `@anthropic-ai/claude-code-linux-arm64-musl` (240MB、最新 2.1.170 まで継続配信) を公式 npm で配布している。② `claude setup-token` による 1 年有効 OAuth トークン (`CLAUDE_CODE_OAUTH_TOKEN`) が credential transplant の上位互換になり得る。

---

## A. ネイティブ実装断念の経緯 (リポジトリ調査)

| 時期 | 試行 | 結果 |
|---|---|---|
| 2026-04-18 (v29) | bionic linker64 経由で musl ld + Bun SEA 実行 | ELF 形式非互換 (`Could not find a PHDR`) で**却下** |
| 2026-04-18 (v30) | Alpine rootfs + proot で chroot 実行 | 起動はするが Bash tool が exit 1 |
| 2026-04-19〜21 (v44-59) | `shelly_musl_exec` トランポリン + `libexec_wrapper_musl.so` (musl 専用 preload) | Bash tool exit 1 が解消せず**放棄** |
| 2026-04-24 (v55) | native 全パスを opt-in 診断用に降格 | legacy cli.js (v2.1.112) のみ信頼可と判断 |
| 2026-04-29 (v67) | **Path D: Bun SEA から objcopy で埋め込み cli.js を抽出→同梱 Node で実行** | **採用**。CI で fail-loud 検証、Bun.* polyfill preload 付き |
| 2026-05-13 (v5.3.1) | extracted Node 方式で CC 正式サポート | 現行運用 |

**現在の実行経路 (3 段 tier)**:
1. `~/.shelly-runtime/claude/current/` の extracted cli.js (updater が staging→probe→昇格、クラッシュ時 24h クールダウン、signal 133/135/139/159 ハンドリング)
2. APK 同梱 extracted tar.gz
3. legacy v2.1.112 cli.js (最終 fallback)

詳細は [HomeInitializer.kt](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt) の tier ladder と `~/.shelly-claude-node-preload.js` (Bun.which / semver / YAML / hash 等を polyfill、Bun.spawn 等は throw stub)。

**断念の真因は 2 つ**:
- (a) Bun SEA バイナリが ET_EXEC 非 PIE で bionic の execve/linker が受け付けない
- (b) どの経路でも Bash tool が exit 1 になり、Claude Code 2.1.143+ で harness 側の挙動が頻繁に変わるため追従できなかった (2026-05-21 の集中セッションで 7 ビルド投入しても診断が毎回反証された)

---

## B. OSS 調査の検証結果

### ferrumclaudepilgrim/claude-code-android (最有力リファレンス)
- 実在、★86、2026-05-30 更新。3 パス (Termux glibc-runner / proot Ubuntu / AVF)。
- **Path A の実体はシンプル**: `patchelf --set-interpreter` を公式 glibc バイナリに 1 発当てて直接 execve、LD_PRELOAD を unset するだけ。
- **Samsung S26 Ultra (Knox 環境) での動作実績が互換表に記載** → Knox がこのアプローチをブロックしない実例。ただし TUI 動作の直接証拠 (スクショ級) は未取得、状況証拠のみ。
- **Shelly 移植の壁**: Termux の glibc パッケージは prefix `/data/data/com.termux` がビルド時ハードコードでリロケータブルでない ([termux-packages#5982](https://github.com/termux/termux-packages/issues/5982))。流用不可、自前 prefix での glibc 再ビルドが必要 (工数大)。

### musl 版公式バイナリ — **エージェント間で報告が矛盾 (要解消)**
- エージェント 2: npm tarball から ELF ヘッダを抽出、`DT_NEEDED` は `libc.musl-aarch64.so.1` の 1 個だけ → ~1MB の ld-musl 同梱 + patchelf で動く可能性。`ET_EXEC` 非 PIE なので直接 execve 不可、`patchelf --set-interpreter <libDir>/ld-musl...` 経由が必要。
- エージェント 3: 公式 docs が Alpine で libgcc/libstdc++/ripgrep の導入を要求しており「銀の弾丸ではない (動的リンク)」。
- Shelly 自身の v29 で musl ld 経由起動は一度失敗 (ただし bionic linker64 で musl ld をロードする経路で、patchelf 直接 execve 方式とは別物)。
- patchelf が Bun 単一ファイル形式に「Could not find a PHDR」で失敗する報告と、ferrum が patchelf-glibc で成功している事実も食い違う (patchelf のバージョン/フォーク差の可能性)。
- → **位置づけ: 「安い PoC (1 日級) で白黒つく未検証の有望株」**。

### 死んだ経路 (確定)
- **AVF (Linux VM)**: Z Fold6 では二重に不可。AVF API は `@SystemApi` + preinstalled アプリ限定で 3rd パーティから使えず、かつ Snapdragon 機は non-protected VM 非対応 (One UI 8.5 の Linux Terminal も Exynos/Tensor 限定)。
- **proot**: 遅さ + Samsung Android 16 更新で悪化報告 ([proot-distro#567](https://github.com/termux/proot-distro/issues/567))。Shelly が #139 で撤去した判断は正しかった。

### その他の検証事実
- ripgrep は Shelly が同梱済み → `USE_BUILTIN_RIPGREP=0` で解決済み。
- Claude Code は PTY 不使用 (Bash tool はパイプ実行) → node-pty は障害にならない。`-p` も TTY 不要。
- `/tmp/claude` ハードコードは `CLAUDE_CODE_TMPDIR` で一部回避できるが全箇所では尊重されない ([#17936](https://github.com/anthropics/claude-code/issues/17936))。sed パッチ併用が引き続き必要。

---

## C. Codex から CC を呼ぶ経路 (戦略 B)

**最重要の訂正**: `claude mcp serve` は CC の**ツール実装 (Bash/Read/Edit 等) だけ**を公開し、Claude の推論・エージェントループは公開しない。Codex は自前ツールを持つので接続価値はほぼゼロ。

成立する構成 (いずれも現行 extracted Node 経路で claude が動く前提でそのまま使える):
1. **最小構成 (推奨)**: Codex の shell から `claude -p "..." --output-format json` 直叩き。`-p` は TTY 不要・`--resume` でセッション継続可・Bash tool も公式に動作対象。Codex 側 AGENTS.md に規約を書くだけ、追加デーモン不要。
2. **zen-mcp-server (pal-mcp-server) の `clink`**: Codex→Claude のサブエージェント起動を明示サポートする最も成熟した OSS。Python 3.10+ (Shelly 同梱済み)。`~/.codex/config.toml` に stdio MCP 登録。
3. steipete/claude-code-mcp (1.3k★) は同コンセプトだが **2026-05-15 にアーカイブ済み** — 参考止まり。

**注意**: 新 `--bare` モードは高速だが OAuth/`CLAUDE_CODE_OAUTH_TOKEN` を読まないため Shelly では使用不可 (将来 `-p` のデフォルト化予告がありリスク)。

---

## D. 認証とポリシー (条件「API 従量課金 NG」との整合)

- **`claude setup-token` が第一候補**: PC 側でブラウザ OAuth→1 年有効トークン (`sk-ant-oat01-`) 発行→Shelly で `CLAUDE_CODE_OAUTH_TOKEN` に設定。現行 credential transplant (`~/.claude.json` + `~/.claude/` 移植、9 時間で失効、refresh 不安定 [#50743](https://github.com/anthropics/claude-code/issues/50743)) の上位互換。
- **ポリシー線引き (検証済み)**: 公式 claude バイナリ/Agent SDK をローカル起動してサブスク認証 = ✅。OAuth トークンを抜いて別クライアントから API 直叩き = ❌ (2026-01 サーバーブロック + 2026-02 ToS 明文化)。Codex→`claude -p` は前者なので許容範囲。
- **2026-06-15 から Agent SDK クレジット制度**: `claude -p`・Agent SDK・サードパーティ harness 経由のサブスク利用が公式サンクション化される代わり、月次クレジット (Pro $20/Max5x $100/Max20x $200 相当、繰越なし) を消費。**対話 TUI (`claude` そのもの) は従来のサブスク枠で無制限側**。
  - 非自明なトレードオフ: 「Codex 経由で CC を酷使する」設計は Pro だとすぐ枯渇、「ユーザーが直接 TUI で CC を使う」現行設計の方が課金的に有利。
  - 旧クライアント (extracted 2.1.112 系) への適用挙動は**未検証**。

---

## E. 推奨優先順位と実機 PoC チェックリスト

| 優先 | 経路 | 工数感 | 賭けどころ |
|---|---|---|---|
| 🥇 | 現行 extracted Node 維持 + Codex→`claude -p` 連携 + setup-token 認証 | 小 (既存基盤) | Bash tool exit 1 の再現率、06-15 クレジット制度の旧クライアント挙動 |
| 🥈 | musl 版公式バイナリ + ld-musl 同梱 PoC | 小〜中 (PoC 自体 1 日級) | ELF 解析「musl 1 ファイルで足りる」vs docs「libgcc 等必要」の矛盾を白黒つける |
| 🥉 | userland exec wrapper (bun-on-termux 方式) で公式バイナリ起動 | 中 (C 実装、参考コードあり) | execve を使わず Knox/SELinux 的に有利。Bun env 落ち対策 (env-preload) 必要 |
| 保留 | 自前 prefix glibc 一式ビルド (ferrum Path A 内製) | 大 | glibc ビルドインフラ構築。musl PoC 失敗時の次善 |
| ❌ | AVF / proot | — | Z Fold6 では構造的に不可 / 撤去済み・性能劣化報告 |

### 実機で確認すべき項目 (Codex↔CC レビューループに流せる粒度)
1. `claude -p "pwd を実行して" --allowedTools Bash` が exit 0 で返るか (Bash tool 問題の現状再現)
2. `claude setup-token` 発行トークンを `CLAUDE_CODE_OAUTH_TOKEN` に入れて、transplant なしで extracted 経路の `-p`/TUI が通るか
3. musl PoC: `@anthropic-ai/claude-code-linux-arm64-musl` の `claude` バイナリに ld-musl を patchelf で当て、`$libDir` 展開 + `$HOME/bin` symlink パターン (Knox 実証済みパターン) で `--version` が返るか
4. 06-15 以降、extracted 2.1.112 系の `-p` がクレジット消費扱いになるか/旧クライアント拒否が来ないか

### 戦略的指摘
- DEFERRED.md の結論 (「当て推量ビルド禁止、観測手段の確立が先」) は今回の調査でも裏付けられた。どの経路でも Bash tool exit 1 の観測基盤 (シンボル付き tombstone or syscall trace) が共通の先行投資。
- ferrum の S26 Ultra/Knox 動作実績は「公式 glibc バイナリ + patchelf なら Bash tool も動く」状況証拠 → exit 1 が **Shelly の extracted Node 経路 (Bun polyfill) 固有**の問題である可能性が新たに浮上。切り分け優先度を上げる材料。

---

## 主要ソース
- [anthropics/claude-code#50270](https://github.com/anthropics/claude-code/issues/50270) (Termux 破損, platform:android)
- [Claude Code setup docs](https://code.claude.com/docs/en/setup) / [authentication](https://code.claude.com/docs/en/authentication) / [headless](https://code.claude.com/docs/en/headless)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) / [Agent SDK クレジット support 記事](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [ferrumclaudepilgrim/claude-code-android](https://github.com/ferrumclaudepilgrim/claude-code-android)
- [@anthropic-ai/claude-code-linux-arm64-musl (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-code-linux-arm64-musl)
- [tribixbite/bun-on-termux](https://github.com/tribixbite/bun-on-termux) / [zen-mcp-server clink](https://github.com/BeehiveInnovations/zen-mcp-server/blob/main/docs/tools/clink.md)
- [termux-packages#5982](https://github.com/termux/termux-packages/issues/5982) (prefix ハードコード) / [proot-distro#567](https://github.com/termux/proot-distro/issues/567) (Samsung A16 性能劣化)
- The Register 2026-02-20 (ToS 明確化) / The New Stack (Agent SDK credits)
