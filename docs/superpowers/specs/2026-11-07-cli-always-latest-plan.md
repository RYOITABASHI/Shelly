# Codex / Claude Code / Antigravity を APK 更新なしで常に最新にする計画

作成: 2026-11-07。調査と計画のみ。実装・push・実機操作はしていない。基準コミットは `764ad669e`。
以下、**[確認]** は一次情報またはバイナリの実測で確かめたこと、**[推論]** はそこからの判断、**[未確認]** は実機でしか分からないことを示す。

---

## 0. 結論

1. **Codex は Termux 公式パッケージの bionic バイナリへ移す（案 b）。** Shelly の CI が `.deb` を取得・検証し、既存の `codex-runtime-latest` チャンネルで配る。OpenAI の公式バイナリは aarch64 Linux 向けが静的 musl しかなく、Shelly の exec ラッパーが効かないので本線にならない。ソースビルド（案 c）は Termux が止まったときの非常口として手順だけ残す。
2. **Claude Code は端末が公式バケットから直接取得する。** Shelly が再配布しない。署名付き `manifest.json` を、Shelly に固定した公開鍵で端末の node が検証する（PC で動作確認済み）。glibc は別の小さなパックにする。Claude 内蔵の更新は `DISABLE_UPDATES=1` で止める。
3. **Antigravity も端末が直接取得する。** Google 公式の Android (bionic) 版で、VA39 パッチは不要の可能性が高い。ただし Fold6 での起動実績がまだ無い。内蔵更新は `AGY_CLI_DISABLE_AUTO_UPDATE=true` で止め、Shelly が版を管理する。
4. **更新の仕組みは 1 本にする。** 版ごとのディレクトリ、検証、プローブ、`current` の切り替え、失敗版の保留、自動ロールバックを 3 つの CLI で共有する。
5. **最新と、エージェントが使う版を分ける。** ここがこの計画の核。人が使う TUI は `current`（端末のプローブに通った最新）、エージェントのワーカーは `agent-current`（CI の契約テストにも通った版）を使う。新しい CLI が安全の前提を静かに変えても、エージェントだけが古い版に留まる。
6. **更新の自動化より先に driver を直す。** 現在の driver は「知らないツール」を止めきれない経路が 2 つある（§6.2）。Codex のゲート確認は 0.144.4 が最後で、0.167 へ一気に上げる前に閉じる必要がある。
7. **放置すると Codex は黙って止まる。** fork の最新タグが動かないので Bump ジョブは「変更なし」で成功し続ける（`bump-codex-runtime.yml` の処理から確認）。赤くならない。

オーナー判断が必要な点は §9。特に `shelly codex pair`（ChatGPT からのリモート操作）が Termux 版で動かなくなる可能性がある。

---

## 1. 確認の範囲

- リポジトリ: CLAUDE.md、DEFERRED.md、HomeInitializer.kt、LibExtractor.kt、build-android.yml、bump-codex-runtime.yml、.ci-versions/、shelly-runtime-update.js、shelly-agent-driver.js、BuildsModal.tsx、shelly-glibc-exec.c、exec-wrapper.c。
- PC 上で実物を取得して ELF ヘッダを解析: Termux `codex_0.167.0`、OpenAI `codex-aarch64-unknown-linux-musl`（0.167.0）、fork の `0.163.0-termux.3`、Antigravity 1.5.2 Android 版、Claude Code 2.1.319 linux-arm64。
- Claude Code については規約に配慮し、依存情報（`ldd` 相当の NEEDED、interp、要求シンボル版）と checksum だけを読み、中身の文字列は調べていない。Antigravity は依存情報と文字列の出現数のみ。
- **端末は触っていない。** 実機挙動はすべて §8 の検証項目。取得物はスクラッチ領域で扱い、調査後に大きなものは削除した。

---

## 2. コード側の現状

**[確認]**

- `build-android.yml`（156 行付近の版の照合と 480 行以降）と `bump-codex-runtime.yml` は DioNanos/codex-termux のリリースに直接依存している。`.ci-versions/` は `0.163.0` / `v0.163.0-termux.3`。
- `bump-codex-runtime.yml` は更新があると **APK ビルド全体** を起動し、その中で `codex-runtime-latest` を公開している。ランタイムだけの公開経路は無い。
- 更新の実体は 2 か所に重複している。`BuildsModal.tsx` の `installCodexRuntime()`（シェル文字列）と `shelly-runtime-update.js` の `installFromEnvSync()`。
- `shelly-runtime-update.js` は Codex 専用で、失敗版のクールダウンは現行コードに無い。CLAUDE.md の表にある「Claude/Codex を昇格」「failed-version cooldown」は過去の記述で、今は成り立たない。
- `HomeInitializer.kt` のコメントどおり、CLI のバックグラウンド更新は無効。更新は Builds 画面から手動。
- `agy-install` は単一ファイルを `mv -f` で置き換える。`--version` プローブもロールバックも無い。
- Claude Code は手動配置のみ。`~/.shelly-runtime/claude-glibc/{lib,claude}` が固定パス。
- `export DISABLE_AUTOUPDATER=1` は .bashrc にあるが、`~/.shelly-claude-run.sh`（エージェント用ランナー）には無い。
- shelly-agent-driver.js は APK のアセット、`~/.shelly-claude-run.sh` は HomeInitializer が起動時に生成する。どちらも **修正には APK 更新が要る**。

**CLI 実行パスの落とし穴 [確認＋推論]**: `codex()` と `runtimeCodexTuiPath()` は `.../current/codex_tui` という symlink パスのまま起動する。`SHELLY_CODEX_EXEC_PATH` もこのパスになり、Codex はその隣の `codex-code-mode-host` を解決する。実行中に `current` が切り替わると、古い Codex が新しい host を起動する。host は版固定のプロトコルなので壊れる。起動前に実パスへ解決する必要がある。

---

## 3. Codex の選択肢

### 3.1 実測結果 [確認]

| 項目 | (a) OpenAI 公式 musl | (b) Termux `codex` 0.167.0 | 現行 fork 0.163.0 |
|---|---|---|---|
| ELF | `ET_EXEC`、固定 0x400000 | PIE (`ET_DYN`) | PIE |
| リンク | 完全静的（PT_INTERP なし） | 動的、`/system/bin/linker64` | 動的、linker64 |
| NEEDED | なし | libssl.so.3、libcrypto.so.3、libdl、libm、libc | libdl、libm、libc |
| RUNPATH | なし | `/data/data/com.termux/files/usr/lib` | `$ORIGIN` |
| サイズ（本体） | 278.8MB | 267.7MB | 207.4MB |
| code-mode-host | 別資産、静的 `ET_EXEC` 71.8MB | 同梱、PIE 75.8MB | 同梱、PIE 75.4MB |
| 検証手段 | SHA256SUMS、sigstore | apt の InRelease（PGP 署名）→ Packages → SHA256 | npm integrity |

公式リリースに aarch64 の gnu 版 CLI は無い（gnu は補助ツールのみ。wheel は manylinux 名だが中身は未確認）。

### 3.2 (a) 公式 musl をローダーで動かす

**以前の記録は原因が違う [確認]**: DEFERRED.md の「mmap_min_addr 制限」は誤り。実際のエラーは `has unexpected e_type: 2` で、これは bionic の `linker_phdr.cpp` の `VerifyElfHeader()` が `ET_DYN` 以外を拒否するときの文言。読み込み先 0x400000 は mmap_min_addr よりはるかに上にある。Knox とも無関係の可能性が高い（`/proc/sys/vm/mmap_min_addr` は §8 T2 で確認）。

**ローダーで変わること**: 変わる。`shelly_glibc_exec` は `ET_DYN` しか受け付けないが、固定アドレスに PT_LOAD を置く版を作れば起動はできるはず **[推論]**。根拠は 2 つ。Claude 本体も `ET_EXEC`（0x200000）で、同じプロセス内に読み込めている。`mmap(PROT_EXEC)` は app_data_file でも許可されている（S1 の実機結果）。

**それでも本線にしない理由**: 起動の次が問題になる。

- 静的バイナリには `LD_PRELOAD` が効かない。Shelly の exec ラッパーは全く効かない **[確認: PT_INTERP なし]**。
- 子プロセスの `execve` は素のカーネル呼び出しになり、`$HOME` や termux-libs 配下は W^X で拒否される（S3 と同じ壁）。`bash`、`git`、`node`、`rg` のどれも起動できない **[推論]**。Claude の `CLAUDE_CODE_SHELL` に当たる公式の抜け道は Codex では未確認。
- `/proc/self/exe` が linker64 を指す。Codex は自分の隣から host を探すので失敗する。shim も効かない **[推論]**。
- `/etc/resolv.conf` 固定で DNS が解決できない（文字列を確認）。Claude と同様の CONNECT プロキシが必要。
- ソケット、OAuth、ファイル監視など exec-wrapper が担っている修正が全部使えない。

評価: 遅延ゼロが唯一の利点。exec を通すには大きな追加開発が要り、成否も不明。**非採用、将来の選択肢として記録のみ。**

### 3.3 (b) Termux 公式パッケージ

**ビルド [確認]**: `packages/codex/build.sh` は openai/codex の `rust-v<版>` タグから `codex-cli` と `codex-code-mode-host` をビルドする。ターゲットは `$CARGO_TARGET_NAME`（Android）。V8 はソースからビルド。パッチは小さく、`daemon_auto_start` を Android で既定オフ、`mxc-sdk` を Android で除外、ほか依存のビルド調整。ライセンスは Apache-2.0 と MIT。自動更新対象。

**com.termux への固定 [確認]**: 固定されているのは 2 点だけ。

1. RUNPATH。実行時は `LD_LIBRARY_PATH` が先に効くはずで、Shelly は libssl.so.3 / libcrypto.so.3 を `$SHELLY_LIB_DIR` に展開している。要求シンボル版は `OPENSSL_3.0.0` のみなので OpenSSL 3 系なら読める。
2. CA 証明書の既定パス。`SSL_CERT_FILE` で上書きでき、.bashrc は既に `$HOME/.shelly-ssl/ca-certificates.crt` を export している。

**exec ラッパーとの相性 [確認]**: `execvp`、`fork`、`readlink`、`open*`、`connect`、`bind`、`realpath`、`syscall` などの libc 取り込みは fork と Termux 版で同じ。既存の linker64 経由起動と interposer はそのまま効く見込み **[推論]**。差分の主なものは OpenSSL 系の追加、pty 取得が `openpty` になった点。

**fork との差 [確認]**:

- fork 独自の `cdx-termux-` と `app-server-control-termux` が無い。Termux 版は `app-server-control` と、上流の `/tmp/codex-daemon-<euid>`（`codex-rs/uds/src/daemon_directory.rs`、HOME 等に依存しない固定）。
- Android に `/tmp` は無い。exec-wrapper v224 の変換規則は `/data/data/com.termux/cdx-termux-` 向けなので一致しない。`shelly codex pair` が使う `$CODEX_HOME/app-server-control-termux` も変わる。
- fork の README は `/remote-control` などを別パッケージ `@mmmbuto/codex-vl` の機能としている。公式パッケージで使えない可能性がある **[推論]**。exec-wrapper の `realpath` / ソケット系 interposer に `/tmp/codex-daemon-*` の変換を足せば通る見込みだが、機能自体が閉じている可能性も残る。§8 T1 で確認。

**遅延 [確認]**: upstream の公開から Termux の `build.sh` bump コミットまで。

| 版 | upstream 公開 (UTC) | Termux bump (UTC) | 遅延 |
|---|---|---|---|
| 0.163.0 | 10/15 21:30 | 10/16 01:29 | 4h |
| 0.164.0 | 10/23 04:48 | 10/24 14:08 | 33h |
| 0.165.0 | 10/27 20:09 | 10/28 03:51 | 8h |
| 0.166.0 | 10/29 19:47 | 10/30 07:24 | 12h |
| 0.167.0 | 11/06 01:40 | 11/06 07:52 | 6h |

0.167.0 は 11/6 23:00 UTC 時点の apt に載っている（InRelease の日付で確認）。さらにパッケージのビルド時間と Shelly 側の周期が足される。実質 **半日〜2 日遅れ** **[推論]**。fork の 0.163.0-termux.1 は upstream の約 2 日後だったので悪化はしない。2026-10-08 の追加以降、上の表を含む主要な安定版に追随している。

**リスク**: 保守の中心は実質少人数で、V8 周りのビルド破損で止まる可能性がある（0.164.0 の直後に V8 パッチを追加している）。apt の index は最新版のみ。→ Shelly のリリースに残す CI 中継なら過去版を保持できる。

### 3.4 取得経路の選択（端末直接か CI 中継か）

| | 端末が Termux 直接 | CI が中継（推奨） |
|---|---|---|
| 検証 | 端末で PGP・apt チェーンが必要 | CI の gpg で完結 |
| `.deb` 展開 | xz が要る（端末に有るか未確認） | CI で tar.gz に詰め替え |
| 過去版の保持 | 不可 | Release に残せる |
| 既存資産 | 新規 | `codex-runtime.json` と Builds 画面を流用 |
| 再配布 | 無し | Apache-2.0/MIT。LICENSE と NOTICE の同梱が必要 |

build-android.yml には Termux apt の取得処理が既にあり、複数ミラーも扱っている（226 行付近）。これを流用する。

### 3.5 (c) CI でソースからビルド

Termux の `build.sh` は V8 を GN/Ninja でビルドする。GitHub の標準ランナーでは時間とディスクが厳しい **[推論]**。遅延はビルド時間だけになり、任意の prefix で作れるので RUNPATH も消せる。代わりに Rust、NDK、V8 パッチを Shelly が背負う。**非常口**として、Termux の更新が 7 日止まったら検討する位置づけにする。

### 3.6 比較

| | (a) musl | (b) Termux + CI 中継 | (c) ソース |
|---|---|---|---|
| 信頼性 | exec が通らず不明 | 高（現行とほぼ同じ起動経路） | 中（ビルド破損を自前で） |
| upstream との遅れ | ほぼゼロ | 半日〜2 日 | ビルド時間次第 |
| ライセンス | Apache-2.0 | Apache-2.0/MIT | 同左 |
| Knox / SELinux | linker64 不可、自作ローダー必須、子の exec 不可 | 問題なし（bionic PIE、linker64 経由） | 問題なし |
| 開発量 | 大 | 小〜中 | 大＋継続保守 |

---

## 4. Claude Code

### 4.1 取得と検証 [確認]

- 最新版: `https://downloads.claude.ai/claude-code-releases/latest`（本文は版番号のみ。今日は 2.1.319）。`stable` は 2.1.311。
- マニフェスト: `<base>/<版>/manifest.json` と `manifest.json.sig`。`platforms.linux-arm64` に `checksum`（SHA-256）と `size`（339,797,432 バイト）。
- 本体: `<base>/<版>/linux-arm64/claude`。今回取得して checksum 一致を確認。
- 署名: OpenPGP v4、RSA、SHA-512 の分離署名。公開鍵の指紋は公式文書の `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`。
- **gpg 無しで検証できる**: node の `crypto` だけで書いた約 40 行の検証コードで、指紋の一致と `verify true` を PC で確認した。端末の bionic node でも動くはず。Shelly に公開鍵（または指紋）を固定する。
- `manifest.zst.json` と `claude.zst` もある。端末に zstd があれば通信量を減らせるが、まずは無圧縮でよい。
- 公式インストーラは使わない。`claude install` が走り、シェル設定とランチャーを作るため。

### 4.2 必要なライブラリ

2.1.319 の依存 [確認]: `ET_EXEC`、interp `/lib/ld-linux-aarch64.so.1`、NEEDED は `librt.so.1`、`libc.so.6`、`ld-linux-aarch64.so.1`、`libpthread.so.0`、`libdl.so.2`、`libm.so.6`。要求は GLIBC_2.17 のみ。

- `libstdc++` と `libgcc_s` は NEEDED に無い。S1 の手順より少なくて済む可能性がある。ただし `dlopen` で読まれるもの（`libgcc_s`、`libnss_*`、`libresolv`）は実行してみないと分からない（§8 T4）。
- 取得元: Termux の `termux-glibc` リポジトリ（`dists/glibc/stable`）。`glibc` 2.44（9.8MB）、`gcc-libs-glibc` 14.2.1（24MB、必要なら）。S1 以降この組み合わせで実機動作している。
- ライセンス: glibc は LGPL-2.1 以降、libgcc_s は GPLv3 + GCC Runtime Library Exception（どちらも一般に知られた条件で、Termux の Packages に License 欄は無い）。

**配り方は 2 通り。**

| | 端末が Termux から直接 | CI で小さなパックを作る（推奨） |
|---|---|---|
| 再配布義務 | 発生しない | LGPL の対応ソースの提供が必要 |
| 必要なもの | 端末で `.deb`（ar + xz）を展開 | CI で必要な数ファイルに絞って tar.gz |
| サイズ | 全体を展開 | 数 MB〜10MB 台 |
| 版の固定 | Termux が消すと取れない | Release に残る |

推奨は CI パック。同じ Release に `COPYING.LIB`、glibc の元ソース tarball、Termux のパッチへの案内を置いて LGPL を満たす。xz が端末で使えるなら直接方式でもよい（§8 T4）。**法的な最終判断はオーナー**（§9）。

### 4.3 `claude-install` と自動更新の流れ

```text
claude-install [--channel latest|stable]
  1. 版番号を取得し、形式を検査
  2. manifest.json と .sig を取得、固定鍵で署名検証
  3. platforms.linux-arm64 の checksum と size を読む
  4. 空き容量を確認
  5. 本体を staging へダウンロード、size と SHA-256 を照合
  6. glibc パックが無ければ先に導入
  7. プローブ（§6.1）
  8. versions/<版>/ へ移動し current を切り替え
  9. 失敗時は failed-versions に記録、current は変更しない
```

`~/.shelly-runtime/claude-glibc/claude` は `current/claude` への symlink として残す。起動判定やテストがこのパスを見ているため。バイナリは無改変のまま（patchelf しない）。

### 4.4 内蔵アップデータ [確認]

**止める必要がある。** 公式文書の記述から:

- ネイティブ版は起動時と実行中に確認し、裏で更新する。
- ランチャーが独自のときは `~/.local/share/claude/versions/` に新版を入れ続け、Claude は全版を残す。1 版 340MB なのでディスクを圧迫する。
- 独自チャンネルで配るなら `DISABLE_UPDATES=1` を使う、と明記されている。`DISABLE_AUTOUPDATER` だけでは `claude update` と `claude install` が動く。

→ `shelly-claude-glibc()` の中で `DISABLE_UPDATES=1` を設定する（.bashrc とランナーの両方に効く）。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` は Remote Control を無効にする副作用があるので使わない。

### 4.5 規約で確認したこと（判断はオーナー）

判断はせず、書かれていることだけを並べる。

- `code.claude.com/docs/en/legal-and-compliance`: 利用は Team/Enterprise/API 利用者は Commercial Terms、Free/Pro/Max/Ultra は Consumer Terms。
- 同ページ「製品に Claude Code を入れられるか」: 製品やサービスに **プリインストールまたは実行** する場合は Commercial Terms への同意が必要。条件は、バイナリを公開されたまま無改変で導入・実行すること、組み込みの認証方法を外したり制限したりしないこと、各エンドユーザーが自分の認証情報を使い本人に課金されること。
- 同ページの認証の節: 第三者開発者が claude.ai ログインを自製品で提供すること、ユーザーの代わりにサブスク認証情報で要求を流すこと、資格情報やセッショントークンを収集・保管・仲介することは許されない。ただし、エンドユーザーが無改変バイナリに自分のサブスクでサインインすることは妨げない、とも書かれている。
- 名称: 「Claude Code を実行できる」と平文で正確に述べるのは可。製品名への使用や提携を匂わせる使い方は不可。
- Consumer Terms §3: bot やスクリプト等の自動手段でのアクセスは、API キー経由か Anthropic が明示的に許す場合を除き禁止。逆コンパイルやリバースエンジニアリングも禁止。§9: ソフトウェア更新を提供しうる。§10: 明示された以外の権利は与えられない。
- Commercial Terms D.4: 競合製品の構築、無承認の再販、リバースエンジニアリング、複製を禁止。ダウンロード可能なソフトウェアの再配布を別途許す条項はこのページに無い。
- 対応 OS の一覧に Android は無い。

**実務上の帰結 [推論]**: 再配布の許可が見当たらないので、計画では Shelly のサーバーや Release に Claude 本体を置かない。ユーザーの操作または設定に基づいて端末が公式 URL から取得する形にする。

**オーナーに見てほしい点**: (1) 専用ローダーと自前の ld.so 経由の起動が「公開されたまま実行」に当たるか、文書に明記は無い。(2) Shelly が「製品に実行」の範囲に入るかと、Commercial Terms への同意の要否。(3) 既定 ON の `claudeSubscriptionUnattended`（サブスクでの無人実行）と Consumer Terms §3 の自動アクセス条項の関係。これは更新の話ではないが今回の読解で目についた。(4) `~/.claude-token.env` の扱いと「保管」の範囲。

---

## 5. Antigravity

### 5.1 `agy-install` の現状 [確認]

- `.../manifests/android_arm64.json` を取得。内容は `version`、`url`、`sha512`。今日は 1.5.2、`storage.googleapis.com/antigravity-public/...` の `cli_android_arm64.tar.gz`（63.5MB、展開後 201.9MB）。
- URL を `https://storage.googleapis.com/antigravity-public/*` に限定、SHA-512 が 128 桁かを検査、ハッシュを照合、`antigravity` を展開して `mv -f`。ベンダーの `install` ステップは実行しない。
- **SHA-512 の出どころ**: 本体と同じ Google のマニフェスト。HTTPS のみで署名は無い。
- **版の固定はできない**: `manifests/android_arm64/1.5.1.json` は 404。常に最新を指す `no-cache` の JSON のみ。最新追従しかできず、ロールバックには自分で旧版を保持する必要がある。URL にビルド ID が入っているので、控えておけば旧版を取れるかもしれない **[未確認]**。
- Google の公式 `install.sh` も同じマニフェストを使い、コメントで Termux には Bionic ビルドが必要と説明し、Android を `android_arm64` に振り分けている。つまり **Android 版は Google の公式配布物**。

### 5.2 VA39 / TCMalloc

- wallentx/antigravity-cli-termux の問題 [確認]: **linux-arm64 の glibc 版** を出発点に、TCMalloc の 48bit アドレス前提を 39bit 向けにバイナリパッチしている。症状は segfault や `MmapAligned() failed`。
- 公式 Android 版 1.5.2 [確認]: bionic PIE、NEEDED は liblog/libc/libm/libdl。TCMalloc のシンボルは含まれる。
- wallentx の README は公式 Android マニフェストに触れていない。公式の不具合報告で出ているのも Linux 版やサーバー版。
- **[推論]** Google が Android 向けに別ビルドしているので、39bit 環境を想定している可能性が高い。ただし保証は無い。
- **[未確認]** DEFERRED.md 上、Fold6 で agy を起動した記録は無い。Shelly のインストールは本体を実行しないので、VA39 問題があってもインストールは成功し、起動時に初めて落ちる。その時点で旧版は置き換えられている。

バイナリパッチは採らない。改変になるうえ、規約上の問題も増える。

### 5.3 Google が更新したとき

- [確認] CLI は通常実行の裏で自己更新する（公式 `install.sh` の案内）。`~/.gemini/antigravity-cli/updater/` に確認マーカーとロックを置き、15 分周期。`AGY_CLI_DISABLE_AUTO_UPDATE=true` で無効化できる（公式 troubleshooting）。
- [確認] `agy()` はこの変数を設定していない。`agy-install` を再実行しない限り Shelly 側の版は変わらない。
- [推論] Shelly では linker64 経由で動くので、自分の実行ファイルを `/system/bin/linker64` と認識し、自己更新は失敗するか別の場所に書く。どちらにしても Shelly の管理から外れる。§8 T3 で確認。
- 公式 changelog には段階的ロールアウトの記述がある。マニフェストが端末によって違う版を返す可能性はある **[未確認]**。

### 5.4 規約で確認したこと（判断はオーナー）

- `antigravity.google/terms` §6: 第三者のソフトウェアやツールでサービスにアクセスすることは違反で、アカウント停止の理由になる。例は Antigravity OAuth を使う第三者クライアント。
- 公式 CLI を第三者ツールから起動してよいかという公開質問に、Google 側の回答は見当たらない。
- Shelly の既存の制約（`agy -p` 等は禁止、対話 TUI の起動のみ、エージェントのワーカーにしない）は維持する。
- **更新に関わる新しい判断点**: 更新プローブの `agy --version` は、OAuth もモデルも使わないが Shelly による自動起動になる。また `agy()` は `libexec_wrapper.so` を Google のバイナリに LD_PRELOAD している。子プロセスの起動に必要だが、「第三者ツールでのアクセス」の解釈に関わるかは書かれていない。

---

## 6. 3 つに共通の更新設計

### 6.1 手順

```text
~/.shelly-runtime/<cli>/
  versions/<版>-<id>/      # 不変。昇格後は書き換えない
  current -> versions/...   # TUI 用
  agent-current -> ...      # エージェント用（Codex / Claude のみ）
  previous -> ...           # 直前の版
  state.json                # 確認時刻、失敗版、ロールバック履歴
  leases/<pid>              # 実行中の印
```

`shelly-runtime-update.js` を CLI ごとの定義（取得元、検証、プローブ、ファイル一覧）を持つ形に一般化し、`BuildsModal.tsx` の重複シェルを廃止してここを呼ぶ。

**昇格の条件（全部通過して初めて `current` を切り替える）**

| 段階 | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 真正性 | Shelly マニフェスト＋署名（Inc 3） | Anthropic の PGP 署名＋固定鍵 | URL 制限＋SHA-512＋CI の観測値と照合 |
| 整合 | SHA-256、版番号一致 | size、SHA-256、版番号一致 | 版番号一致 |
| 起動 | `--version`、`exec --help` | `--version`、`--help` | `--version`（オーナー判断） |
| 機能 | `app-server --help`、`mcp list --json`、host の存在 | オフライン・カナリア（Bash ツール） | なし |
| 通信 | TLS/CA | プロキシ経由の到達 | なし |

オフライン・カナリアは、端末内の node で動く偽の Messages API を立て、ダミーの API キーで Claude を実行し、`echo` を Bash ツールで走らせる。トークンを消費せず、ローダー、`CLAUDE_CODE_SHELL`、`CLAUDE_ENV_FILE`、snapshot 無害化（S3c/S3d）の全経路を試せる。これらは Claude の内部挙動に頼っているので、版が上がると最も壊れやすい。

### 6.2 エージェント用の昇格条件（安全の前提を守る）

`agent-current` は、CI の判定が「合格」で、かつ端末の driver の契約番号（`DRIVER_CONTRACT`）と一致する場合だけ進める。判定は `cli-compat.json` として Release に置く。

```json
{ "contract": 7, "codex": { "approved": "0.167.0", "schemaSha256": "..." },
  "claude": { "approved": "2.1.319" } }
```

**CI の契約テスト**: x64 の公式 Codex と Claude を同じ版で取得し、偽のモデルサーバーを相手に実際の `shelly-agent-driver.js` を動かす。API 料金はかからない。端末の Termux 版とは別ビルドだが、プロトコルの実装は同じソース **[推論]**。

**Codex で必須**

- `codex app-server generate-json-schema` の差分。承認メソッド（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`）、決定値の列挙、item の型一覧が前回と同じこと。schema コマンドの存在は fork と Termux の両方の文字列で確認済み（オプション名は CI で確認）。
- **新しい item 型が増えたら自動で不合格**にして人が読む。
- `codex features list` の差分。**新しい既定有効の機能**があれば不合格。`CODEX_WORKER_DISABLED_FEATURES` は拒否リストで、`-c features.<未知>=false` は無視されるので、改名や新機能は黙ってすり抜ける。
- MCP preflight の実動作: 偽の MCP サーバーを設定し、`mcp list --json` の二度目で無効になること、`mcpToolCall` が来たらターンが止まること。
- ユーザーのプロジェクトの `.codex/config.toml` が読まれないこと（driver のコメントでは 0.144.4 で確認したきり）。
- コマンド実行とファイル変更で実際に承認要求が来ること。無人時に decline が効くこと。

**Claude で必須**

- `--tools`、`--disallowedTools`、`--setting-sources`、`--strict-mcp-config`、`--permission-prompt-tool`、`--input-format stream-json` が受理されること。未知のフラグなら Claude が usage エラーで終わるので fail closed。
- `system/init` の `tools` が `CLAUDE_GATED_TOOLS` に収まる（driver も実行時に確認する。deny リストの名前は有効ではないので許容。PC の 2.1.220 では deny された名前はそもそも一覧から消える）、`mcp_servers` が空、`apiKeySource` が想定どおり。
- Bash、Read、Write、Edit の全部で `can_use_tool` が来ること。`control_response` の拒否が効くこと。
- 許可外の `tool_use` で driver が止まること。
- `permissions.ask` と `disableAllHooks` の動作。新しい組み込みツールの検出（`--tools` なしの init と `CLAUDE_DENIED_TOOLS` の比較。許可リストが主防御なので検出は通知のみ）。 PC の 2.1.220 で `--tools` なしの init を見ると `CronDelete`、`CronList`、`DesignSync`、`PowerShell`、`PushNotification`、`ReportFindings`、`ScheduleWakeup`、`TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate` が `CLAUDE_DENIED_TOOLS` に無かった。

**端末でも確認（CI と端末のずれ防止）**: Codex は `generate-json-schema` のハッシュが `schemaSha256` と一致すること。Claude は `--help` に上記フラグがあること。

**driver の穴 2 つ（自動更新の前に修正）[確認]** 2026-11-07 に `fix/cli-update-groundwork` で実装済み（実機未検証）。下の 1、2 は修正前の状態。

実装で分かったこと: `commandExecution` と `fileChange` と MCP 以外にも既定で有効な未ゲートの item があった。`multi_agent`（`collabAgentToolCall`）と `view_image`（`imageView`）は既定で有効なので、許可リストから外すだけでは通常の実行が止まる。ワーカーでは機能も無効にした。`webSearch` は DEFERRED.md P1 の判断待ち。

1. Codex: driver が能動的に止めるのは MCP 関連（`mcpToolCall`、進捗、elicitation、startup）だけ。`commandExecution` と `fileChange` 以外の未知の item（新しい組み込みツールなど）は止めない。Claude 側の「許可外の tool_use で即停止」に相当するものが無い。→ 既知の item 型の許可リストにし、未知の型でターンを止める。
2. Claude: `system/init` で見ているのは `apiKeySource` だけで、`tools` を確認していない。→ 許可リストと一致しなければ起動直後に止める。

**プロトコルが変わったとき**: 契約テストが不合格 → `agent-current` は据え置き → TUI の `current` だけ進む → オーナーに通知 → driver を直し `DRIVER_CONTRACT` を上げて APK を出す。古い APK の端末は自分の契約番号の最後の合格版に留まる。Builds 画面に「エージェント用: 0.167.0（新しい版は Shelly の更新待ち）」と出す。**APK の更新が遅れても、エージェントは検証済みの版で動き続ける。**

Antigravity はワーカーではないので `agent-current` を持たない。

### 6.3 実行のタイミング

| 契機 | 内容 |
|---|---|
| アプリ前面の起動 60 秒後 | 確認のみ、6 時間に 1 回まで。条件を満たせばダウンロード |
| Builds 画面 | 手動の確認と更新、版の表示、ロールバック |
| `shelly-update-clis` | ターミナルから手動 |
| 定期（任意、Inc 7） | WorkManager（充電中＋非従量回線）。APK 更新が必要 |

既定は Wi-Fi のみ、または非従量回線のみ。モバイル回線では通知だけ。エージェントの実行直前には更新しない。

### 6.4 壊れた最新版を止める

- プローブ失敗: `state.json` に版、段階、理由を記録し 24 時間スキップ。2 回失敗したらより新しい版が出るまで保留。
- 署名や checksum の失敗: クールダウン無しで即保留し、ユーザーに警告（ネットワーク不調ではなく改ざんの可能性があるため）。
- 昇格後の起動失敗: 昇格から最初の 3 回の起動を監視。10 秒以内に異常終了（SIGSEGV、SIGBUS、exit 127 など）したら `previous` に戻し、その版を保留。TUI の正常な短時間終了と区別するため、対象はシグナル死と loader エラーに限る。
- 手動での固定: `shelly-update-clis <cli> --pin <版>` と `--unpin`。
- 版のダウングレードは拒否（マニフェストの巻き戻し対策）。ロールバックは明示操作のみ。

### 6.5 実行中の保護

- **切り替えは symlink の rename のみ。** 上書きしない。開いている TUI は影響を受けない。
- **起動時に実パスへ解決する。** `codex()`、`$HOME/bin/codex`、driver の `runtimeCodexTuiPath()` は 2026-11-07 に実装済み（`cd -P` / `realpath` でディレクトリだけ解決、BASHRC_VERSION 286、実機未検証）。`shelly-claude-glibc()` は `current` を持つ Inc 6 で同じことをする。解決後のパスでは `__shelly_codex_mark_tui_failed` の照合も versions/ を受ける必要がある。これをしないと §2 の host 不整合が起きる。
- **Claude は実行中に自分のファイルを読み続ける**（公式文書に記載）。ファイルが読めなくなるとセッションが落ちるので、起動した版は消さない。
- **削除の条件**: `leases/<pid>` が生きていない、かつ `/proc/*/maps` にそのパスが無い。同じ UID のプロセスは読める。
- **エージェント**: driver がリースを取り、実行中は `agent-current` を動かさない。チェーンの途中で版が変わらないようにする（chain lock と per-agent 単一飛行は変更しない）。
- 実行中の TUI には「新しい版は次の起動から」とだけ出す。

### 6.6 ディスク

| | 1 版 | current + previous |
|---|---|---|
| Codex（本体 + host） | 344MB | 690MB |
| Claude Code | 340MB | 680MB |
| Antigravity | 202MB | 404MB |
| glibc パック | 〜30MB | 〜30MB |
| 合計 | | **約 1.8GB** |

- `agent-current` が別の版なら Codex / Claude で各 340MB 増えて、最大 2.5GB ほど。
- 開始前に「新版サイズ × 2 + 500MB」の空きを確認（ダウンロードと展開のため）。足りなければ `previous` を解放するか、通知して中止。
- 使わない CLI は取得しない。Claude と agy はインストールした人だけ更新する。
- Claude の latest はほぼ毎日出るので、毎日 340MB の通信になる。頻度は §9 で判断。
- 将来 APK から Codex を外せば 280MB ほど減る。ただしオフラインの初回起動で Codex が無くなる。Inc 7 の判断事項。

### 6.7 配信の信頼性

`codex-runtime.json` の sha256 は同じ Release 内の値で、独立した署名が無い。実行ファイルはユーザーのトークンを扱うので、CI 中継が高価値の標的になる。CI の秘密鍵で Ed25519 署名し、公開鍵を APK に固定して node の `crypto` で検証する（Inc 3）。GitHub Secret の登録はオーナーの作業。

---

## 7. 推奨の実装順

| Inc | 内容 | APK | リスク | 完了条件 |
|---|---|---|---|---|
| 0 | 凍結の検知。`.ci-versions` より新しい upstream の安定版のうち最も古いものの公開から 3 日を超えたら Bump ジョブを失敗させる（2026-11-07 実装済み、`scripts/check-codex-freeze.js`）。CLAUDE.md の陳腐な記述を修正 | 不要 | 低 | fork のままなら赤くなる |
| 1 | 実機検証 §8 の T1〜T3 | 不要 | 低 | `shelly codex pair` の可否、agy の起動可否が判明 |
| 2 | driver の 2 つの穴を閉じる。起動時の実パス解決。（ここまで 2026-11-07 実装済み、実機未検証）残りは `DISABLE_UPDATES=1`、`AGY_CLI_DISABLE_AUTO_UPDATE=true` | 要 | 中 | 既存のエージェントテスト全通過、未知の item と tool で停止 |
| 3 | CI を Termux へ切り替え（InRelease の GPG 検証）。`publish-cli-runtime.yml` を新設して APK と分離。bump は Termux の版を見る。cron は 6 時間ごと。Ed25519 署名。`exec-wrapper` と `shelly codex pair` の新パス対応 | 要（1 回） | **高**: 起動経路、TLS、remote control | 実機で TUI、`!` コマンド、Code Mode、エージェント実行、`codex login` 済みの再実行 |
| 4 | CI の契約テストと `cli-compat.json`、`DRIVER_CONTRACT` | 要 | 中 | 0.167.0 が合格し、意図的に壊した偽サーバーで不合格になる |
| 5 | 共通アップデータ（§6.1 の構成、`agent-current`、失敗記録、ロールバック、GC）。Codex を移行。`BuildsModal` の重複削除 | 要 | 中 | 実行中の切り替えと、壊れた版の自動ロールバックを実機で確認 |
| 6 | `claude-install`、glibc パック、署名検証、カナリア。既存の手動配置からの移行 | 要 | 中: S3c/S3d の前提 | 2.1.314 → 最新で Bash ツールとエージェントが通る |
| 7 | `agy` を共通アップデータへ。自動チェックを既定 ON。Builds 画面の 3 CLI 表示。任意で WorkManager | 要 | 低〜中 | 3 CLI が前面起動だけで最新に追従 |

**順序の理由**: Inc 2 は Inc 3 より先。0.163 → 0.167 に上げる前にゲートを固めるため。Inc 3 が最も危険なので単独で出す。Inc 4 より前は自動更新しない。

**Inc 3 の変更点の詳細**

- `.ci-versions/codex-termux.txt` を Termux の版（`0.167.0`）に、integrity を `.deb` の SHA-256 に置換し、名前も変更。
- `build-android.yml` 480 行以降の fork 依存を Termux の `.deb` 取得に置換。`codex.bin` と `libc++_shared.so` の処理を削除。tarball に LICENSE と NOTICE を追加。
- 関連テスト（`__tests__/exec-wrapper-source-invariants.test.ts` など）を更新。`@openai/codex` の npm ディスパッチャが不要になるか確認。
- worker の config に `check_for_update_on_startup = false`。公式の Codex は npm での更新を案内する文字列を持つ。
- 版の一致は `--version` の比較で続ける（Termux 版の表示は §8 T1 で確認）。

**一度は APK 更新が要る**: exec-wrapper、driver、更新機構は APK の中にあるので、Inc 2〜7 の導入は APK で届く。導入後は、Codex / Claude / Antigravity の更新に APK は要らない。プロトコル変更で driver の修正が要るときだけ、エージェント用の版が APK を待つ（TUI は待たない）。

---

## 8. 実機検証

すべて Shelly のターミナルで実行する。Inc 1 の前提。**今回は未実施。**

### T1 Termux 版 Codex（本命）

PC（WSL）で準備し、端末へ送る:

```bash
curl -fLO https://packages-cf.termux.dev/apt/termux-main/pool/main/c/codex/codex_0.167.0_aarch64.deb
sha256sum codex_0.167.0_aarch64.deb   # e1b5d01c147edc1d5cfe5ba5a2a54cd353f320829d49690eb407ae26ca107837
mkdir x && dpkg-deb -x codex_0.167.0_aarch64.deb x
tar -C x/data/data/com.termux/files/usr/bin -czf codex-spike.tgz codex codex-code-mode-host
adb push codex-spike.tgz /sdcard/Download/
```

端末:

```bash
mkdir -p ~/spike/codex && tar -xzf /sdcard/Download/codex-spike.tgz -C ~/spike/codex
cd ~/spike/codex && mv codex codex_tui
cx() {
  LD_LIBRARY_PATH="$SHELLY_LIB_DIR" LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so" \
  SHELLY_CODEX_EXEC_PATH="$HOME/spike/codex/codex_tui" SHELLY_CODEX_PROC_EXE_SHIM=1 SHELLY_CODEX_PROC_EXE_OPEN_SHIM=1 \
  SSL_CERT_FILE="$HOME/.shelly-ssl/ca-certificates.crt" \
  /system/bin/linker64 "$HOME/spike/codex/codex_tui" "$@"
}
cx --version
cx exec --help | head -5
cx app-server --help | head -20
cx app-server generate-json-schema --help
cx features list | head -40
CODEX_HOME=$(mktemp -d) cx mcp list --json
cx login status
cx exec --skip-git-repo-check "Reply with exactly: ok"   # 少量の使用量を消費
ls -ld /tmp
cx remote-control --help
cx remote-control --no-daemon     # /tmp と app-server-control の扱いを見る。Ctrl-C で終了
```

TUI とエージェントの通し確認（戻せるように控える）:

```bash
R=~/.shelly-runtime/codex; readlink "$R/current" > ~/spike/codex/prev-current; cat ~/spike/codex/prev-current
V="$R/versions/spike-0.167.0"; mkdir -p "$V"
cp ~/spike/codex/codex_tui ~/spike/codex/codex-code-mode-host "$V/"; chmod 700 "$V"/*
printf '{"schemaVersion":1,"version":"0.167.0","codexVersion":"0.167.0"}\n' > "$V/manifest.json"; date > "$V/.healthy"
ln -sfn "$V" "$R/current"
codex          # 起動後に `!echo $SHELL` と `!python3 -c "print(1)"`。Code Mode の可否も確認
```

その後、チャットで `@agent ~/spike/agent-test にhello.txtを作って` を Codex 指定で実行し、承認カードが出て実行されることを確認する。`shelly codex pair` も試す。

戻す:

```bash
ln -sfn "$(cat ~/spike/codex/prev-current)" ~/.shelly-runtime/codex/current
# prev-current が空だった場合: shelly-update-clis codex --reset-runtime
```

合格: `--version` が通る、TLS で API に届く、`!` コマンドと承認が動く。`pair` の結果は §9 の判断材料。

### T2 公式 musl の失敗理由の確定（10 分）

```bash
mkdir -p ~/spike/musl && cd ~/spike/musl
curl -fL https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-aarch64-unknown-linux-musl.tar.gz | tar -xz
chmod 700 codex-aarch64-unknown-linux-musl
./codex-aarch64-unknown-linux-musl --version                    # Permission denied（W^X）か、ラッパー経由で下と同じエラー
/system/bin/linker64 "$PWD/codex-aarch64-unknown-linux-musl" --version   # unexpected e_type: 2 の見込み
cat /proc/sys/vm/mmap_min_addr
rm -rf ~/spike/musl
```

### T3 Antigravity と VA39

```bash
tail -3 /proc/self/maps        # 先頭アドレスが 0x8000000000 未満なら 39bit
agy-install
AGY_CLI_DISABLE_AUTO_UPDATE=true agy --version
agy        # TUI が起動するか。MmapAligned、segfault の有無を見る
ls -la ~/.gemini/antigravity-cli/updater/ 2>/dev/null
ls -la ~/.shelly-runtime/agy/
```

内蔵更新の確認（環境変数を付けず TUI で 20 分放置後）:

```bash
ls -la ~/.gemini/antigravity-cli/updater/ ~/.shelly-runtime/agy/ ~/.local/bin 2>/dev/null
find ~ -maxdepth 4 -name 'antigravity*' -o -name 'agy' 2>/dev/null | head
```

### T4 Claude 取得と最小 glibc

```bash
mkdir -p ~/spike/claude && cd ~/spike/claude
B=https://downloads.claude.ai/claude-code-releases
V=$(curl -fsSL $B/latest); echo $V
curl -fsSLO $B/$V/manifest.json && curl -fsSLO $B/$V/manifest.json.sig
curl -fL -o claude.new $B/$V/linux-arm64/claude
_run "$SHELLY_LIB_DIR/node" -e 'console.log(JSON.parse(require("fs").readFileSync("manifest.json")).platforms["linux-arm64"])'
sha256sum claude.new
L=~/.shelly-runtime/claude-glibc/lib; mkdir -p lib-min
cp "$L/ld-linux-aarch64.so.1" "$L/libc.so.6" "$L/libm.so.6" "$L/libdl.so.2" "$L/libpthread.so.0" "$L/librt.so.1" lib-min/
LD_LIBRARY_PATH="$SHELLY_LIB_DIR" DISABLE_UPDATES=1 /system/bin/linker64 "$SHELLY_LIB_DIR/shelly_glibc_exec" \
  "$PWD/lib-min/ld-linux-aarch64.so.1" --library-path "$PWD/lib-min" "$PWD/claude.new" --version
command -v xz zstd; toybox tar --help 2>&1 | grep -iE 'xz|zstd'; python3 -c 'import lzma; print("lzma ok")'
_run "$SHELLY_LIB_DIR/node" -e 'console.log(process.version, typeof require("zlib").zstdDecompressSync)'
```

通常の `claude` 経路の確認（`shelly-claude-glibc` は固定パスなので一時的に入れ替える）:

```bash
R=~/.shelly-runtime/claude-glibc; cp -p "$R/claude" ~/spike/claude/claude.old
mv ~/spike/claude/claude.new "$R/claude"; chmod 700 "$R/claude"
claude --version
claude -p "Run the command: echo SHELLY_OK"      # Bash ツールと libgcc_s の要否
DISABLE_UPDATES=1 claude update                  # 拒否されること
claude doctor
```

戻す: `mv ~/spike/claude/claude.old ~/.shelly-runtime/claude-glibc/claude`。この検証は Claude の使用量を少し消費する。

### T5 実行中の切り替え

Claude の TUI を開いたまま、別タブで:

```bash
R=~/.shelly-runtime/claude-glibc
mv "$R/claude" "$R/claude.moved"       # 版ディレクトリの切り替えを模す
```

元のタブで Bash ツールと会話が続くか確認し、`mv "$R/claude.moved" "$R/claude"` で戻す。削除は試さない（§6.5 は削除しない前提なので不要）。

---

## 9. オーナーが決めること

1. **`shelly codex pair` が Termux 版で動かない場合**（T1 の結果次第）: (a) exec-wrapper で通るなら直す、(b) 通らなければ機能を諦めて移行する、(c) `@mmmbuto/codex-vl` を別に入れる（第三者 fork で再び同じ依存を抱える）、(d) (c) の代わりにソースビルドで patch を持つ。ChatGPT からのデモに影響するので最優先。推奨は (a)、無理なら一時的に (b)。
2. **Claude の更新チャンネル**: `latest`（要望どおり、ほぼ毎日 340MB）か `stable`（約 1 週間遅れ、退行を飛ばす）か。推奨は `latest` で確認は毎日、ダウンロードは Wi-Fi のみ。
3. **エージェントが最新より遅れるのを許すか**（§6.2）: 推奨は許す。ここを同じにすると安全の検証を飛ばすことになる。
4. **自動更新の既定**: 既定 ON で Wi-Fi のみ、を推奨。Claude と agy は規約の点からインストールを明示操作にし、その時点で自動更新への同意を取るのが無難。
5. **Anthropic の規約**（§4.5）: ローダー経由の実行の解釈、Commercial Terms の要否、無人のサブスク実行の既定値。必要なら Anthropic に問い合わせる。
6. **Google の規約**（§5.4）: 更新プローブでの `agy --version` と、LD_PRELOAD の継続。プローブを避けるなら、agy は検証なしで昇格し初回起動の監視だけに頼る。
7. **LGPL の扱い**（§4.2）: glibc パックを Shelly のリリースで配る（ソース同梱）か、端末が Termux から直接取るか。xz の有無（T4）で変わる。
8. **署名鍵の登録**（§6.7）: GitHub Secret への Ed25519 秘密鍵の登録はオーナーの作業。
9. **CI の Claude 実行**: 偽サーバー相手の契約テストで公式バイナリを CI 上で動かす。文書上の禁止は見当たらないが、確認の意味で判断を仰ぐ。

---

## 10. 未確認のまま残るもの

- Termux 版 Codex が Knox 端末で linker64 経由に動くか（構造は同じだが未実行）。
- `app-server` が Android ビルドでも同じプロトコルを返すか、起動時に Android 固有の分岐があるか。
- Codex の TLS が `SSL_CERT_FILE` だけで足りるか。CI で使っている Shelly の libssl/libcrypto との組み合わせ。
- driver の起動環境に `SSL_CERT_FILE` が渡るか（TUI と別経路）。
- Android の Antigravity 1.5.2 が 39bit で動くか、内蔵更新の実際の書き込み先、マニフェストが端末で変わるか。
- Claude のスナップショット周り（S3d）が 2.1.319 でも同じか。S3d 自体が実機未検証。
- 偽モデルサーバーで `can_use_tool` まで届くか（設計上は可能、PoC は Inc 4）。
- 公式 wheel の中身。結論に影響しないので未調査。

---

## 出典

- DioNanos/codex-termux: https://github.com/DioNanos/codex-termux
- Termux codex: https://github.com/termux/termux-packages/tree/master/packages/codex 、apt index: https://packages-cf.termux.dev/apt/termux-main/
- Termux glibc index: https://packages-cf.termux.dev/apt/termux-glibc/dists/glibc/stable/binary-aarch64/Packages.gz
- OpenAI Codex releases: https://github.com/openai/codex/releases/tag/rust-v0.167.0
- ソケット: https://github.com/openai/codex/blob/main/codex-rs/uds/src/daemon_directory.rs
- bionic: https://android.googlesource.com/platform/bionic/+/refs/heads/main/linker/linker_phdr.cpp
- Claude Code: https://code.claude.com/docs/en/setup 、https://code.claude.com/docs/en/env-vars 、https://code.claude.com/docs/en/legal-and-compliance 、https://claude.ai/install.sh
- Anthropic 規約: https://www.anthropic.com/legal/consumer-terms 、https://www.anthropic.com/legal/commercial-terms
- Antigravity: https://antigravity.google/cli/install.sh 、https://antigravity.google/docs/cli/troubleshooting/ 、https://antigravity.google/docs/changelog 、https://antigravity.google/terms
- VA39: https://github.com/wallentx/antigravity-cli-termux 、https://discuss.ai.google.dev/t/antigravity-server-crash-by-tcmalloc-48bit/135330
- 第三者起動の質問（Google の回答なし）: https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462
