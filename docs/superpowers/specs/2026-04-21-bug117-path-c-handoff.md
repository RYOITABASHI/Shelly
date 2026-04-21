# 2026-04-21 bug #117 Path C 実装ハンドオフ

**ターゲット**: claude-code 2.1.113+ (Bun SEA) を Android bionic で動かし、Shelly v0.1.1 の目玉機能「**Android で最新 Claude Code を動かせる唯一のアプリ**」を成立させる。

**前提**: このセッションは Termux (モバイル Claude Code) 上で実施。次セッションは PC 環境で続行予定。

**このファイルが唯一の正**。`DEFERRED.md` bug #117 と併読すると時系列が追える。

---

## 1. なぜこの作業をしているか (ユーザー体験)

現状、**Android で最新 Claude Code をオンデバイスで動かす方法は世界に存在しない**:

- Termux: 2.1.112 で止まる (cli.js 消失で 2.1.113+ 死亡、[#50270](https://github.com/anthropics/claude-code/issues/50270))
- iSH / Andronix: x86 エミュレーション、遅すぎて非実用
- JuiceSSH + remote: ネット常時必須、オンデバイスではない
- 公式 Android サポート: Anthropic 未対応、対応予定なし

**Shelly が Path C を搭載すれば**:
- ✅ 最新版 claude-code が Android native で動作
- ✅ Shelly の APK 更新で claude も自動的に最新化 (CI で `@latest` 同梱)
- ✅ root 不要、初回認証以外ネット接続不要

→ **Shelly が Anthropic が放棄した市場の公式ソリューション**になる。

---

## 2. 今日 (2026-04-21) Termux 上で判明したこと

### 2-1. claude musl binary は bionic で起動する (✅ 実機確認)

```bash
# 1. claude-code 2.1.116 の musl variant を取得
npm pack @anthropic-ai/claude-code-linux-arm64-musl@2.1.116
tar xzf anthropic-ai-claude-code-linux-arm64-musl-2.1.116.tgz
# → package/claude (220 MB, ELF ET_EXEC, musl-aarch64 linked)

# 2. Alpine musl libc を取得
curl -sL https://dl-cdn.alpinelinux.org/alpine/v3.19/main/aarch64/musl-1.2.4_git20230717-r6.apk | tar xz
# → lib/ld-musl-aarch64.so.1 (723 KB, ELF ET_DYN)

# 3. Termux 特有の LD_PRELOAD をクリアして ld-musl loader 経由で起動
env -i HOME=$HOME PATH=$PATH ./lib/ld-musl-aarch64.so.1 ./package/claude --version
# → 2.1.116 (Claude Code)  ✅
```

`--help` も完全動作。

**技術的な要点**:
- claude binary は ET_EXEC、bionic の `/system/bin/linker64` は `unexpected e_type: 2` で拒否
- だが **musl ld (`ld-musl-aarch64.so.1`)** は ET_DYN なので bionic linker で普通に exec できる
- そしてその musl ld が **自分で ELF ローダーとして claude binary を mmap する** (bionic linker の制約を迂回)

**Shelly 側で `libexec_wrapper.so`** を使う分には問題なさそう (Termux の `libtermux-exec-ld-preload.so` は musl 環境で symbol 不在エラーを出したが、Shelly の wrapper は bionic-clean)。

### 2-2. しかし対話モード (`--print`) は hang する

strace で追跡:

```
openat(AT_FDCWD, "/etc/hosts", O_RDONLY|...)      = OK
openat(AT_FDCWD, "/etc/resolv.conf", ...)          = -1 ENOENT
sendto(16, DNS_QUERY_api.anthropic.com, 127.0.0.1:53) = 35
# 127.0.0.1:53 は listen してない → 応答なし → 永久 hang
```

**根本原因**: musl libc は `/etc/resolv.conf` を**ハードコードで参照**する ([musl src/network/resolvconf.c](https://git.musl-libc.org/cgit/musl/tree/src/network/resolvconf.c))。Android では `/etc → /system/etc` の readonly symlink で `resolv.conf` 不在 (bionic は `net.dns*` property で別経路 DNS 解決)。musl はファイル不在で fallback で `127.0.0.1:53` にクエリするが、当然応答なし → hang。

### 2-3. LD_PRELOAD shim は musl では効かない

試した手順:
1. Alpine musl-dev apk を展開、Termux clang で `--target=aarch64-linux-musl -nostdinc -isystem ...` で `resolv_shim_musl.so` を build (3.6 KB)
2. `LD_PRELOAD=resolv_shim_musl.so` で `openat("/etc/resolv.conf")` を別パスにリダイレクトしようとした
3. **shim はロードされた** (strace で `openat(.../resolv_shim_musl.so, ...)` 確認)
4. **しかし openat リダイレクトは効かなかった** (strace に `openat("/etc/resolv.conf", ...)` 依然残る)

**理由**: musl libc は自身の syscall を **`__syscall_openat` (インライン asm で SYS_openat 直接発行)** で実装。glibc のように libc 関数 → syscall wrapper の段階を踏まない。LD_PRELOAD で `openat()` シンボルを上書きしても musl は通過しない。

これは **musl の設計思想 (static linking first)** の副作用であり、設定ミスや実装ミスではない。

---

## 3. 残る唯一の現実的解決策: Custom Musl Libc Build

### 3-1. 方針

Alpine 公式 musl source を Shelly 専用にカスタムビルドする:

1. `src/network/resolvconf.c` の hardcoded path `"/etc/resolv.conf"` を build-time macro で上書き可能に patch:

   ```c
   // src/network/resolvconf.c (patch)
   #ifndef MUSL_RESOLV_CONF_PATH
   #define MUSL_RESOLV_CONF_PATH "/etc/resolv.conf"
   #endif
   // existing code: replace "/etc/resolv.conf" literal with MUSL_RESOLV_CONF_PATH
   ```

2. Build with:

   ```bash
   CFLAGS="-DMUSL_RESOLV_CONF_PATH=\\\"/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf\\\"" \
   ./configure --target=aarch64-linux-musl --prefix=/tmp/musl-shelly
   make && make install
   ```

3. 生成された `libc.musl-aarch64.so.1` を Shelly に `libld_musl_shelly.so` として同梱

### 3-2. 予想工数

| タスク | 見込み |
|---|---|
| musl source clone + patch | 30 分 |
| cross-compile 環境整備 (Alpine sdk or Termux clang) | 1-2 時間 |
| ビルド + 実機検証 | 30 分 |
| Shelly CI workflow に build step 追加 | 1 時間 |
| LibExtractor + HomeInitializer 配線 | 30 分 |
| **合計** | **3-4 時間** |

### 3-3. Shelly 本体への組込み (設計案)

#### CI workflow (`.github/workflows/build-android.yml`)

```yaml
- name: Build Shelly-patched musl libc
  run: |
    git clone https://git.musl-libc.org/cgit/musl /tmp/musl-src
    cd /tmp/musl-src
    git checkout v1.2.4  # Alpine 3.19 と同じ version
    # apply patch
    sed -i 's|"/etc/resolv.conf"|MUSL_RESOLV_CONF_PATH|g' src/network/resolvconf.c
    cat > src/network/resolvconf_path.h <<'EOF'
#ifndef MUSL_RESOLV_CONF_PATH
#define MUSL_RESOLV_CONF_PATH "/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf"
#endif
EOF
    sed -i '1i#include "resolvconf_path.h"' src/network/resolvconf.c
    # cross-compile
    CC="aarch64-linux-musl-gcc" ./configure --target=aarch64-linux-musl
    make -j$(nproc)
    cp lib/libc.so ${GITHUB_WORKSPACE}/modules/.../jniLibs/arm64-v8a/libld_musl_shelly.so

- name: Download claude-code latest musl variant
  run: |
    cd /tmp && npm pack @anthropic-ai/claude-code-linux-arm64-musl@latest
    tar xzf anthropic-ai-claude-code-linux-arm64-musl-*.tgz
    cp package/claude ${GITHUB_WORKSPACE}/.../jniLibs/arm64-v8a/libclaude.so
```

#### LibExtractor 追加エントリ

```kotlin
// modules/terminal-emulator/android/src/main/java/.../LibExtractor.kt
"lib/arm64-v8a/libclaude.so" to "claude",
"lib/arm64-v8a/libld_musl_shelly.so" to "ld_musl",
```

#### HomeInitializer `claude()` bash 関数 (BASHRC_VERSION 43)

```kotlin
sb.appendLine("claude() {")
sb.appendLine("  local __claude=\"\$libDir/claude\"")
sb.appendLine("  local __ld_musl=\"\$libDir/ld_musl\"")
sb.appendLine("  # Ensure resolv.conf exists for musl DNS (bionic has no /etc/resolv.conf)")
sb.appendLine("  mkdir -p \"\$HOME/.shelly-ssl\"")
sb.appendLine("  if [ ! -f \"\$HOME/.shelly-ssl/resolv.conf\" ]; then")
sb.appendLine("    echo 'nameserver 8.8.8.8' > \"\$HOME/.shelly-ssl/resolv.conf\"")
sb.appendLine("    echo 'nameserver 1.1.1.1' >> \"\$HOME/.shelly-ssl/resolv.conf\"")
sb.appendLine("  fi")
sb.appendLine("  if [ -x \"\$__claude\" ] && [ -x \"\$__ld_musl\" ]; then")
sb.appendLine("    \"\$__ld_musl\" \"\$__claude\" \"\$@\"")
sb.appendLine("  else")
sb.appendLine("    echo \"claude: binary missing — upgrade to Shelly v42+\" >&2")
sb.appendLine("    return 127")
sb.appendLine("  fi")
sb.appendLine("}")
```

### 3-4. 自動追従の実装

v0.1.1 リリース後の運用:

- CI で毎 push 時に `npm pack @anthropic-ai/claude-code-linux-arm64-musl@latest` → **常に最新同梱**
- 追加で `.github/workflows/build-android.yml` に:
  ```yaml
  on:
    schedule:
      - cron: '0 0 * * *'  # 毎日 UTC 0:00 に re-build
  ```
- Anthropic が新版リリース → 24 時間以内に Shelly CI が最新取り込み → EAS Update or 新 APK 配信
- ユーザー視点: Shelly アプリ更新するだけで claude も最新化

---

## 4. 次セッション (PC) での具体手順

### 4-0. PC / Termux 役割分担

| フェーズ | 実施環境 | 理由 |
|---|---|---|
| **musl source patch + cross-compile** | ✅ **PC** (Docker alpine:3.19) | ビルドツールチェーン整備済、再現性高い、CI yaml に直接コピー可能 |
| **ビルド成果物の動作確認** | Termux (adb push or curl で転送) | 実機 bionic 環境が必要 |
| **Shelly CI workflow 化** | ✅ **PC** | yaml 編集 + PR レビュー |
| **LibExtractor / HomeInitializer 実装** | ✅ **PC** | Kotlin 編集 + tsc チェック |
| **APK install + 最終動作確認** | Termux (ワイヤレス ADB) | 実機 GUI 検証 |

**要点**: **ビルドは一切 Termux でやらない**。
- PC で Docker 使って musl を再現性高くビルド → adb push or GitHub Release artifact で Termux に転送して動作確認
- 最終的に CI workflow に組み込んでしまえば、それ以降は PC での CLI 操作すらなく、GitHub Actions が毎回自動ビルド

### 4-1. ステップ

1. このファイル + `DEFERRED.md` bug #117 を精読
2. `git pull` で最新 (`c9786078`)
3. **PC で** musl patch + cross-compile を Docker で実施:

   ```bash
   # PC 側、任意のディレクトリで
   mkdir shelly-musl-poc && cd shelly-musl-poc
   docker run --rm -v $PWD:/out alpine:3.19 sh -c '
     apk add build-base git linux-headers
     cd /tmp && git clone --depth 1 -b v1.2.4 https://git.musl-libc.org/git/musl
     cd musl
     # resolv.conf path を macro で上書き可能に patch
     sed -i "s|\"/etc/resolv.conf\"|MUSL_RESOLV_CONF_PATH|g" src/network/resolvconf.c
     # patch 用 header を冒頭に挿入
     printf "#ifndef MUSL_RESOLV_CONF_PATH\n#define MUSL_RESOLV_CONF_PATH \"/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf\"\n#endif\n" | cat - src/network/resolvconf.c > /tmp/rc.c && mv /tmp/rc.c src/network/resolvconf.c
     # cross-compile (alpine:3.19 はネイティブで aarch64-linux-musl ターゲット)
     ./configure --target=aarch64-linux-musl --prefix=/tmp/out
     make -j$(nproc) && make install
     cp /tmp/out/lib/libc.so /out/libc.musl-aarch64.so.1
   '
   ls -lh libc.musl-aarch64.so.1  # ~700 KB 程度の想定
   ```

4. 生成物を **Termux に転送して実機確認**:

   ```bash
   # PC → Termux (ワイヤレス ADB 経由)
   adb push libc.musl-aarch64.so.1 /sdcard/Download/
   ```

   ```bash
   # Termux 側で、既存の bun-sea-test 構成を流用
   cd /data/data/com.termux/files/usr/tmp/bun-sea-test
   cp /sdcard/Download/libc.musl-aarch64.so.1 alpine/lib/  # 上書き
   mkdir -p ~/.shelly-ssl
   echo "nameserver 8.8.8.8" > ~/.shelly-ssl/resolv.conf
   echo "nameserver 1.1.1.1" >> ~/.shelly-ssl/resolv.conf

   # 実行 (credentials は ~/.claude に既に配置済)
   env -i HOME=$HOME PATH=$PATH TERM=xterm-256color \
     ./alpine/lib/ld-musl-aarch64.so.1 \
     ./musl/package/claude --print "reply with OK"
   # → "OK" が返れば勝ち
   ```

5. 動けば **PC で** Shelly CI に musl build step を追加 (`.github/workflows/build-android.yml`)
6. LibExtractor + HomeInitializer + BASHRC_VERSION 43 を実装
7. ビルド → APK install → Shelly 実機で `claude` 対話モード完走
8. 動けば v0.1.1 リリース、README の **ヒーロー文言を「Android で最新 Claude Code を動かせる唯一のアプリ」に変更**

---

## 5. ユーザーが気にしている「自動追従」の再確認

> 「Anthropic が新バージョンをリリースした際に、それを自動的に Shelly 上で対応できるような仕組みを組み込みたいと思うんだけど、現実的に可能かな?」

**A. 可能**。

具体的には:

1. **CI で `@latest` 同梱** (Path C 実装後に自動)
2. **毎日 cron で再ビルド** (yaml 1 行追加で済む)
3. **Shelly APK 更新 → claude も自動最新化** (ユーザーは何もしない)

**制限事項**:
- Shelly のリリース頻度 < claude の頻度 → 最大数日のラグ
- Anthropic が破壊的変更した場合 (musl build 廃止など) は Shelly 側が追従実装必須

**refresh token 失効時**:
- 現状は別環境で再 login + credentials transplant が必要
- **v0.1.2 で `shelly-claude-auth.js` を実装** すれば Shelly 単体で再認証も完結 (codex-login と対称、~250 LoC)

---

## 6. 今日のセッションのやり取り (要旨)

1. **2026-04-21 朝**: Termux で `claude` 起動 → MODULE_NOT_FOUND (cli.js 消失)
2. 調査: claude-code が 2.1.113 で Bun SEA + platform-native binary に切替、cli.js 廃止
3. Path A〜F の候補を並列エージェントで洗い出し、Path C (ld-musl loader) を選定
4. 実機で `--version` / `--help` 動作確認 ✅
5. `--print` で hang → strace で DNS 問題と特定
6. LD_PRELOAD shim を musl target で build → musl syscall 直発行で効かず ❌
7. **次手: custom musl libc build** — PC 環境で続行

### ユーザー確認済の設計決定

- ✅ CLI 3 本すべてを Shelly 単体で最新バージョン動作させる方向
- ✅ 初回のみ transplant or login 必要、以降は自動追従
- ✅ refresh token 失効時もゆくゆくは Shelly 単体で再認証 (v0.1.2)
- ✅ bug #104 / #116 は他セッションで解決済と判断、本セッションのタスク #12/#13 は削除

---

## 7. 参考リンク

- [#50270 claude-code 2.1.113+ broken on Termux](https://github.com/anthropics/claude-code/issues/50270)
- [tribixbite/bun-on-termux](https://github.com/tribixbite/bun-on-termux) — 先行事例 (Path B 手法)
- [guysoft/opencode-termux](https://github.com/guysoft/opencode-termux) — Bun を bionic port した例
- [musl libc src/network/resolvconf.c](https://git.musl-libc.org/cgit/musl/tree/src/network/resolvconf.c) — patch 対象
- [Alpine aarch64 main repo](https://dl-cdn.alpinelinux.org/alpine/v3.19/main/aarch64/) — musl-dev / musl パッケージ

---

**作成者**: Claude Opus 4.7 (1M context), on Termux / Galaxy Z Fold6
**次担当**: PC 環境の Claude Code
**関連コミット**: DEFERRED bug #117 変遷は `88dfc7cb` → 本コミットで更新
