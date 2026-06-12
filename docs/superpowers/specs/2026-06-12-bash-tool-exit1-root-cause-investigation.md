# Claude Code Bash tool Exit code 1 — 真因特定調査 (2026-06-12)

> **スコープ**: デスクリサーチ + 既存コード/ログ読解のみ。Shelly 本体は変更しない。実機 PoC も今回はしない。実装は次フェーズ。**v6.0.0 リリーススコープには入れない。着手は v6.0.0 告知一段落後。**
>
> 3 エージェント並列調査 (Shelly 実コード精読 / CC Bash tool 内部機構 / Bun・ferrum・クロス環境 issue) を一次ソースで突き合わせた結果。先行 spec [2026-06-10-bash-tool-exit1-observability-plan.md](./2026-06-10-bash-tool-exit1-observability-plan.md) のレイヤー切り分けを、検証可能な根拠で絞り込んだもの。

---

## 1. TL;DR

- **真因は L6(CC の shell snapshot パイプライン)× L1(Shelly の Bun.spawn polyfill 戻り値契約)の複合**に高確度で絞れた。CC の Bash tool は「シェルを spawn → snapshot 生成 → source → 出力捕捉 → exit code 捕捉」のパイプラインで、**このどこが折れても UI 上は一律「Error: Exit code 1, 出力空」に潰れる**(検証済み issue 多数)。
- **Knox SELinux (L5) と bionic 一般 (L4) は一次ソースで実質除外**。SELinux 拒否は EACCES→exit **126** + `avc: denied` ログという別シグネチャを持ち、しかも同じ untrusted_app ドメインで同じ bash が TUI(PTY)経由で日常的に exec できている。
- **「Shelly のシェル関数が壊す」説 (L3-replay) は実コードで反証**: `$libDir` は .bashrc 生成時に Kotlin がハードコード置換済み(runtime 変数でない)、`SHELLY_LD_LIBRARY_PATH` は export 済み、`_run` は `export -f` 済み。関数の**再生(replay)**は壊れない。問題は関数 replay でなく、snapshot **生成 spawn** と polyfill の**戻り値契約**。
- **回帰の証拠**: DEFERRED 履歴で build 693(claude 2.1.140)では extracted cli.js 経路の Bash tool が **exit 0(正常)** だった。現在の失敗は **claude 2.1.143+ の harness 変更による回帰**。→ 探索範囲は「2.1.143+ で snapshot/spawn 経路の何が変わったか」に狭まる。
- **次の一手は実機ビルド不要**: `claude --debug` のログに「Failed to create shell snapshot」が出るか1点を見るだけで、locus が「snapshot 生成(env/シェルパス)」か「polyfill 戻り値契約」かが切れる。

---

## 2. レイヤー別仮説評価

各層: **尤度** / 根拠(一次ソース) / 反証条件 / 観測方法(=どう白黒つけるか)。

### L6 — Claude Code harness(shell snapshot パイプライン) … **尤度: 高(増幅要因かつ症状の漏斗)**
- **機構(検証済み)**: Bash tool は起動時にシェルを spawn して snapshot を作る。`bash -l` 系でログイン/`.bashrc` を source → `declare -F` で全関数を列挙 → base64 で `~/.claude/shell-snapshots/snapshot-bash-<ts>-<token>.sh` に書き、以後の各コマンドはこの snapshot を source した非対話シェルで実行する。
- **根拠**: [#12115 (Fedora 43)](https://github.com/anthropics/claude-code/issues/12115) は debug ログに **`Failed to create shell snapshot: spawn /usr/bin/env bash ENOENT`** → 全 Bash 呼び出しが「Error: Exit code 1」出力なし。[#52983 / #52821 (AlmaLinux9/RHEL9)](https://github.com/anthropics/claude-code/issues/52983) は snapshot 生成の `bash -c -l` 引数順崩れで exit 127/snapshot 未生成。[#42461](https://github.com/anthropics/claude-code/issues/42461) / [#51814](https://github.com/anthropics/claude-code/issues/51814) は `/tmp` 満杯だけで silent exit 1。[#41124 (CachyOS)](https://github.com/anthropics/claude-code/issues/41124) / [#22105 (macOS native Bun)](https://github.com/anthropics/claude-code/issues/22105) は**コマンドは実行されるが出力/exit code 捕捉だけ壊れる**(=CC 側 capture バグ)。
- **Shelly 固有の刺さりどころ**: (a) **Android に `/usr/bin/env` が無い**(bionic、`/usr` 不在)。CC が snapshot 生成で `/usr/bin/env bash` を spawn するなら #12115 と同型の ENOENT になり得る。ただし Shelly の `exec-wrapper.c rewrite_path()` は `/usr/bin/*`→`/system/bin/*` を書き換え、Android は toybox の `/system/bin/env` を持つ(kernel uname に "Toybox")ので、**LD_PRELOAD interposer を通る spawn なら救済され得る** → ここが「通るか通らないか」未確定で観測の核。(b) `env bash` は `bash` を**PATH 実行ファイルとして**探すが、Shelly の `bash` は**シェル関数**。PATH(`$HOME/bin:...`)の `$HOME/bin/bash`(libbash.so への symlink)に解決され、その実行は再び linker64 経由が必要 → snapshot 生成シェルの素性次第で折れる。
- **反証**: `claude --debug` で snapshot が正常生成され、source も通り、コマンドも走るのに exit 1 が返るなら、locus は L6 の**生成**でなく**capture**(#22105/#41124 型=Anthropic 側バグ)。
- **観測方法**: ① `ANTHROPIC_LOG=debug claude --debug` 実行→ stderr/ログに「Failed to create shell snapshot」「spawn … ENOENT」の有無。② `~/.claude/shell-snapshots/` にファイルが生成されるか。③ 生成された snapshot を `bash --noprofile --norc -c 'source <snap>; pwd; echo $?'` で Shelly ターミナル内手動実行。

### L1 — Bun.spawn polyfill 戻り値契約(Shelly 独自実装) … **尤度: 高**
- **背景**: Shelly は公式 cli.js(Bun 依存)を **bionic Node + 手書き Bun polyfill** で動かす。polyfill が `Bun.spawn`/`spawnSync` を提供するが、**Node child_process と Bun の検証済み仕様差**を naive な wrapper が踏みやすい。
- **検証済みの仕様差**([Bun Spawn docs](https://bun.com/docs/runtime/child-process) / [SpawnOptions](https://bun.com/reference/bun/Spawn/SpawnOptions)):
  1. `proc.stdout` は **Web ReadableStream**(`await proc.stdout.text()` で読む)。Node は EventEmitter Readable。cli.js が `.text()`/`new Response()` で読むと、Node stream を返す polyfill では throw/空文字 → **「stdout 空」に直結**。
  2. `proc.exited` は **exit code の数値に resolve する Promise**。`undefined`/Subprocess を resolve する実装だと exit code が NaN/undefined → harness が汎用 **exit 1** にフォールバック。
  3. stdio デフォルト差(Bun: stdin ignore / stdout pipe / stderr inherit、Node: 3 本 pipe)。
  4. `spawnSync` は `{ exitCode, success, stdout: Buffer, stderr: Buffer, signalCode, pid }`。`success`(=exitCode===0)欠落で成否判定が常に falsy。
  5. spawn 失敗(ENOENT)時に Bun は**同期 throw**(Node は非同期 `error` イベント)— polyfill が `error` イベントのままだと `exited` 未 resolve → タイムアウト→exit 1(docs 明文化なし、**inferred**)。
- **回帰との整合**: 2.1.143+ で snapshot/spawn コードが使う Bun API が増減すれば、2.1.140 で足りていた polyfill が不足に転じる。→ build 693 で動いて今動かない事実と合致。
- **反証**: legacy v2.1.112 cli.js(`SHELLY_FORCE_LEGACY_CLAUDE=1`)経路でも Bash tool が exit 1 なら、polyfill 単独説は弱まる(polyfill は両経路共通だが、2.1.112 は古い snapshot コードなので使う Bun API が違う可能性に注意)。
- **観測方法**: Shelly ターミナル内 node REPL で preload を読み込み、`Bun.spawn(['/system/bin/sh','-c','echo hi'])` を実行 → `await p.exited`(数値か?)、`await p.stdout.text()`(生えてるか?)、`Bun.spawnSync(...).success`(あるか?)を単体確認。preload の実体は [HomeInitializer.kt のヒアドキュメント生成部](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt)。

### L3 — シェル環境(bash/node/git をシェル関数化) … **尤度: 中→低(replay 説は反証済み、生成 spawn 説は L6 に統合)**
- **実コード**([HomeInitializer.kt:1825-1834, 1967-1979](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt)):
  - `_run(){ ... LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 "$@"; }` + `export -f _run`
  - `bash(){ _run $libDir/libbash.so "$@"; }`(`$libDir` は生成時にハードコード置換済み、runtime 変数ではない)
  - `export SHELLY_LD_LIBRARY_PATH="$libDir"`、`export SHELL="$HOME/bin/bash"`、`export BASH="$SHELL"`
  - **`.bashrc` に interactive ガード(`case $- in *i*) return`)は無い** → snapshot 生成シェルでも .bashrc は丸ごと走る前提。
- **判定**: 関数 **replay** が runtime 変数欠落で壊れる説は**反証(IMPLAUSIBLE)** — ハードコード + export 済みのため。ただし「snapshot 生成シェルが `bash` 関数 vs PATH 実行ファイルのどちらを掴むか」「`$HOME/bin/bash` symlink 起動が linker64 を要する」点は L6 の生成 spawn 問題として残る。
- **観測方法**: snapshot ファイルを base64 デコードして `bash()` 定義が含まれるか、含まれるなら非対話 source で機能するかを確認(L6 観測③と同じ)。

### L2 — Node.js child_process 層 … **尤度: 低**
- cli.js は Bun.spawn を呼ぶ(child_process を直接ではない)ので、実体は L1 の polyfill が child_process に橋渡しする部分。橋渡しの引数・cwd・stdio・env 設定ミスは L1 に包含。単独の新規仮説は無し。
- **観測方法**: L1 の単体テストで polyfill→child_process の変換を確認すれば足りる。

### L4 — bionic libc 層 … **尤度: 低**
- **反証**: ferrum/claude-code-android(本物の Bun on bionic, [README](https://github.com/ferrumclaudepilgrim/claude-code-android))や Termux+glibc-runner で「Bash tool が全滅 exit 1」という同型報告が**皆無**(報告されるのは install/TMPDIR/PTY ばかり、[#50270](https://github.com/anthropics/claude-code/issues/50270) / [GGPrompts gist](https://gist.github.com/GGPrompts/73bcc5b9d22c71d6ea926ca609f43823))。bionic それ自体が exit 1 を生むなら本物 Bun でも出るはず。
- **留意**: ferrum の `tests/verify-claims.sh` は環境 claim のみで **Bash tool の exit code を直接検証していない**(verified)ので、「bionic で本物 Bun の Bash tool が動く」は**弱い肯定**止まり(反証も無い)。
- **観測方法**: 追加観測不要(他層が確定すれば自動的に棄却)。

### L5 — Knox SELinux 層 … **尤度: 低(実質除外)**
- **反証(強)**: untrusted_app/targetSdk≥29 の app_data_file exec 拒否は **EACCES → exit 126**(shebang なら「bad interpreter」+126)で、`avc: denied` が必ず logcat/dmesg に残る([app-data-file-execute-restrictions](https://github.com/agnostic-apollo/Android-Docs/blob/master/site/pages/en/projects/docs/apps/processes/app-data-file-execute-restrictions.md) / [AOSP SELinux validate](https://source.android.com/docs/security/features/selinux/validate))。**「黙って exit 1」にはならない**。かつ同じドメインで同じ bash(libDir+linker64)が TUI の PTY 経由で日常的に exec 成功している → Knox が bash exec を拒否しているなら端末ごと死ぬ。
- **観測方法**: 疑うなら `adb logcat | grep avc` で `denied` が出ていないこと1点を確認すれば即棄却(将来の保険)。

### 尤度ランキング(総合)
| 順位 | レイヤー | 尤度 | 一言 |
|---|---|---|---|
| 1 | **L6 snapshot 生成 + L1 polyfill 戻り値契約(複合)** | 高 | 症状の漏斗。回帰タイミングと完全整合 |
| 2 | L1 polyfill 単独(stdout/exited 契約) | 高 | Shelly 側で直せる本命 |
| 3 | L6 capture バグ(Anthropic 側) | 中 | これだと Shelly 側で直せない(give-up 条件) |
| 4 | L3 生成 spawn の bash 解決 | 中 | L6 に統合して観測 |
| 5 | L2 / L4 / L5 | 低 | 一次ソースで実質棄却 |

---

## 3. デスクリサーチで判明した既知情報

**「Bash tool exit 1 / 出力空」は CC のプラットフォーム横断の恒常パターン**(全て anthropics/claude-code、verified):

| Issue | 環境 | 原因 |
|---|---|---|
| [#12115](https://github.com/anthropics/claude-code/issues/12115) | Fedora 43 | `Failed to create shell snapshot: spawn /usr/bin/env bash ENOENT` → 全 Bash exit 1。closed/not planned |
| [#41124](https://github.com/anthropics/claude-code/issues/41124) | CachyOS | コマンドは走るが**出力捕捉だけ**壊れる。根因未診断 |
| [#22105](https://github.com/anthropics/claude-code/issues/22105) | macOS native(Bun) | exit 0 のコマンドを CC が exit 1 と誤報 = capture 機構バグ |
| [#42461](https://github.com/anthropics/claude-code/issues/42461) / [#51814](https://github.com/anthropics/claude-code/issues/51814) | Linux | `/tmp`(`/tmp/claude-$UID`)満杯だけで silent exit 1 / 空出力 |
| [#52983](https://github.com/anthropics/claude-code/issues/52983) / [#52821](https://github.com/anthropics/claude-code/issues/52821) | AlmaLinux9 / RHEL9 | snapshot 生成の `bash -c -l` 引数順で exit 127 / snapshot 未生成 |
| [#26505](https://github.com/anthropics/claude-code/issues/26505)〜[#26558](https://github.com/anthropics/claude-code/issues/26558) | Windows v2.1.45 | stdout capture 破壊で全コマンド silent exit 1(**2.1.x のリグレッション実績**) |
| [#31437](https://github.com/anthropics/claude-code/issues/31437) | 各種 | snapshot が対話用関数(`__git_*` 等 195KB/199 eval)を取り込み肥大化・破壊。`.bashrc` の interactive ガードを無視して source |
| [#31948](https://github.com/anthropics/claude-code/issues/31948) | Termux/Android | `/tmp` ハードコードで snapshot 失敗 → `CLAUDE_CODE_TMPDIR` で回避 |
| [#47978](https://github.com/anthropics/claude-code/issues/47978) | mise | snapshot が env 依存関数を取り込み source 失敗(関数×runtime env 依存の前例) |

**バージョン感応性**(verified, [changelog](https://code.claude.com/docs/en/changelog) + #31437): v2.1.45 で stdout capture 変更、v2.1.69 で snapshot が対話用関数を取り込み肥大化、v2.1.87 で snapshot が親 PATH を取り込む変更([#42639])、v2.1.147 で全コマンド exit 127 リグレッション→v2.1.148 hotfix。**snapshot/spawn 経路は 2.1.x で頻繁に変わっている** = Shelly が「40 ビルドで harness 追従しても反証された」現象の正体。

**Bun 公式は Android/bionic 非サポート**([bun#5085](https://github.com/oven-sh/bun/issues/5085) / [#8685](https://github.com/oven-sh/bun/issues/8685))。Shelly が本物 Bun を捨て Node+polyfill にしたのは合理的。だが polyfill 忠実度が問われる(L1)。

**Shelly 固有の決定的証拠(DEFERRED 履歴 v55, 2026-04-24)**: build 693 で「musl Bun SEA は `/bin/sh -c` をハードコードして全 Bash tool が exit 1、**cli.js(extracted Node)tier は期待通りの出力(exit 0)**」と実機確認。→ **extracted Node 経路の Bash tool は過去に動いていた**。現症状は後続 CC バージョンでの回帰。

**切り分け結論**: 症状は「Shelly 固有」ではなく「**CC 全般の snapshot/capture 脆弱性**を、Shelly の環境(`/usr/bin/env` 不在 + polyfill + 関数シェル)が**踏み抜いている**」。bionic 一般でも Knox でもない。

---

## 4. 推奨観測経路(最も軽量に真因へ)

**APK 変更不要・root 不要・Shelly コード変更不要**。すべて既存インストールの実機で完結(次フェーズで実施)。

| 手順 | コマンド/操作 | 何が分かる | コスト |
|---|---|---|---|
| **O1(最優先)** | Shelly ターミナルで `ANTHROPIC_LOG=debug claude --debug` → Bash tool で `pwd` 実行 → stderr/`~/.claude/logs/` を確認 | 「Failed to create shell snapshot」「spawn … ENOENT」の有無で **L6 生成失敗 vs L1 capture/契約** が一発で切れる | 数十分 |
| O2 | `ls -la ~/.claude/shell-snapshots/` → 最新を `base64 -d` 相当で展開し、`bash --noprofile --norc -c 'source <snap>; pwd; echo $?'` を手動実行 | snapshot が**生成されるか**/**source で落ちるか**/`bash()` 関数が含まれ機能するか | 数十分 |
| O3 | `command -v /usr/bin/env; ls -la /usr/bin/env /system/bin/env /bin/sh; echo "$SHELL"; type bash` を Shelly ターミナルで | snapshot 生成 spawn の解決先(`/usr/bin/env`→`/system/bin/env` rewrite が効くか、`bash` が関数/PATH どちらに解決か) | 数分 |
| O4 | node REPL で preload を読み、`Bun.spawn`/`spawnSync` の戻り値契約(`exited`→数値 / `stdout.text()` / `success`)を単体検査 | **L1 polyfill 契約**の白黒 | 1 時間 |
| O5(O1-O4 で不足時のみ) | 先行 spec の層2(`SHELLY_EXEC_TRACE` を exec-wrapper.c に追加)/ APK 同梱 strace | 失敗 execve の errno | APK 変更要・後回し |

**O1 が圧倒的に費用対効果が高い**。3 行のログ確認で locus が「snapshot 生成(L6/L3/環境)」か「polyfill 契約(L1)」かに二分される。ここを通さずに当て推量ビルドをするのは DEFERRED の禁則の再犯。

**観測手段自体が起動を阻害しない原則**(DEFERRED の `SHELLY_CLAUDE_PATCH_TRACE` が起動を壊した反省): O1-O4 はすべて**読み取り専用 / 公式 debug フラグ / 別 REPL**で、PTY 出力や起動経路に介入しない。

---

## 5. 修正経路の事前評価

| 真因が… だった場合 | Shelly 側で直せるか | 想定対応 |
|---|---|---|
| **L1 polyfill 戻り値契約** | ✅ **直せる(本命)** | preload の `Bun.spawn`/`spawnSync` を契約準拠に: `stdout` を `.text()` 付き ReadableStream に、`exited` を exit code の数値 Promise に、`success` を付与、stdio デフォルトを Bun 準拠に。preload は Shelly 独自実装なので自由に直せる |
| **L6 snapshot 生成 spawn(env/シェルパス)** | ✅ **概ね直せる** | `CLAUDE_CODE_TMPDIR` を確実に設定(既に対応?要確認)、`/usr/bin/env` を `$HOME/bin/env`→toybox env に symlink or rewrite 確認、`SHELL` を snapshot 互換な bash に、必要なら `BASH_ENV` で非対話シェルにも _run/$libDir を供給。多くは settings.json `env` か .bashrc で対応可 |
| **L6 capture バグ(#22105/#41124 型)** | ❌ **直せない(Anthropic 側)** | コマンドは走るが CC が exit code/出力を誤って捨てる内部バグ。upstream 修正待ち。→ give-up 条件へ |
| L3 関数シェル replay | (反証済み) | 対応不要 |
| L5 Knox / L4 bionic | (実質棄却) | 対応不要 |

**最良ケース**: O1 で「snapshot は出来てるが exit 1」かつ O4 で polyfill 契約に欠陥 → **L1 を Shelly 側で修正して解決**(過去 build 693 で動いていた事実が「直せる」ことの傍証)。

---

## 6. 「やらない判断」の発火条件

以下が観測で確定したら **Bash tool 修正を諦め**、Claude Code は現状維持(TUI + Read/Edit/Write は動くので**機能制限を明示**して残す):

1. **O1 で snapshot は正常生成・source も通る・コマンドも実行されるのに CC が exit 1 を返す** → #22105/#41124 型の **Anthropic 側 capture バグ**。Shelly 側で直せない。
2. **O4 で polyfill 契約は正しい**(`exited`→数値 / `stdout.text()` / `success` すべて OK)のに exit 1 → locus が Shelly 外。
3. polyfill 修正 + env 修正を**観測付きで 2〜3 反復しても動かない**(DEFERRED の「当て推量ビルド禁止」を守り、各反復に O1-O4 の証拠を必須とする)。

**諦めた場合の Shelly での扱い**: Claude Code を**「TUI + ファイル編集ツールは動作、Bash tool は CC 側既知問題により unsupported」と README/設定 UI に明示**して experimental 維持(削除はしない)。Codex CLI が Bash 相当の実行を担えるので機能欠落の実害は限定的。`→ sync:` README Status 表 + DEFERRED。

---

## 7. 次フェーズへの handoff

**着手タイミング**: v6.0.0 告知一段落後。専用ブランチ(main 不可侵)。

**観測の優先順位**:
1. **O1(`claude --debug` で snapshot ログ確認)を最初に**。これ無しで polyfill/launcher を触らない。1 時間・ビルド不要。
2. O3(`/usr/bin/env`・`SHELL`・`type bash` の実機事実確認)を O1 と同時に。
3. O1 の結果で分岐:
   - 「snapshot 生成失敗」→ O2 + O3 を深掘り(env/シェルパス修正、L6/L3 系)。
   - 「snapshot OK だが exit 1」→ O4(polyfill 契約単体テスト、L1 系)。
4. O5(exec-wrapper trace / strace)は O1-O4 で不足した時のみ。APK 変更を伴うので最後。

**実機 PoC の最小スコープ**(次フェーズの第一歩): 既存インストールの Shelly ターミナルで `ANTHROPIC_LOG=debug claude --debug` を 1 回走らせ、`~/.claude/logs/` と `~/.claude/shell-snapshots/` を読むだけ。**APK 変更なし・root なし・Shelly コード変更なし**。これで真因 locus が L6-生成 か L1-契約 かに二分でき、次フェーズ全体の投資先が決まる。

**先行 spec との関係**: [2026-06-10-bash-tool-exit1-observability-plan.md](./2026-06-10-bash-tool-exit1-observability-plan.md) の 3 セル切り分け表は、(a) cell 3(native binary 経路)が [2026-06-11 実機 PoC](./2026-06-10-claude-patched-binary-poc-plan.md) で SIGSEGV FAIL 確定したため **extracted Node vs legacy cli.js の 2 経路比較に縮約**、(b) 本 spec の O1(snapshot debug ログ)を**最速プローブとして層1 の手前に追加**する形で更新する。層2(syscall trace)/層3(tombstone)は O1-O4 で locus が exec 経路に確定した場合のみ起動。

---

## 関連
- 先行: [2026-06-10-bash-tool-exit1-observability-plan.md](./2026-06-10-bash-tool-exit1-observability-plan.md)(観測基盤の 3 層設計)
- 調査本体: [2026-06-10-claude-code-on-device-investigation.md](./2026-06-10-claude-code-on-device-investigation.md)
- 実機 PoC(native 経路 FAIL 確定): [2026-06-10-claude-patched-binary-poc-plan.md](./2026-06-10-claude-patched-binary-poc-plan.md)
- DEFERRED.md: Claude Code Bash tool Exit code 1(P1)— 本 spec が「次の一手」を locus 二分まで具体化
- 実コード: [HomeInitializer.kt](../../../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt)(claude()/_run()/bash()/preload 生成)、[shelly-shell-launcher.c](../../../modules/terminal-emulator/android/src/main/jni/shelly-shell-launcher.c)、[exec-wrapper.c](../../../modules/terminal-emulator/android/src/main/jni/exec-wrapper.c)(rewrite_path)
