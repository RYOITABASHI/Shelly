# 2026-04-21 bug #117 Path C-bis 実機デッドロック → C trampoline loader 引き継ぎ

**ターゲット**: Shelly v0.1.1 の目玉機能「Android で最新 Claude Code を動かせる唯一のアプリ」成立。

**現状**: musl cross-build + CI 配線 + LibExtractor + HomeInitializer の claude() 書き換え、APK ビルド、実機 install まで完了。**claude を起動すると SIGABRT/SIGSEGV で落ちる**。Termux 単体で同じ binary 構成が動いたが、Shelly（通常 Android app）の SELinux + libexec_wrapper LD_PRELOAD + bionic linker64 のトリプルコンボで実行経路が閉塞。

**次の担当**: **C trampoline loader** を書き、bionic の relocation を迂回して musl ld-musl を生のまま起動する。

---

## 0. このセッションに入る人が最初にやること

```bash
# 1. worktree に入る（あるいは自分で main から branch out して作業）
cd C:\Users\ryoxr\Shelly
git fetch origin
git checkout claude/elegant-chatterjee-814adb
git pull

# 2. 既存の handoff と DEFERRED を順に精読（合計 1000 行ほど、30 分）
# - docs/superpowers/specs/2026-04-21-bug117-path-c-handoff.md（PoC までの経緯）
# - docs/superpowers/DEFERRED.md の bug #117 セクション（Path A〜F 比較、実機検証ログ、Path C-bis 成立報告）
# - docs/superpowers/specs/2026-04-21-bug117-trampoline-handoff.md（このファイル、今日のデッドロック状況）

# 3. CLAUDE.md も冒頭だけ確認（プロジェクト全体のアーキ概要と Architecture Decisions 表）
```

---

## 1. Shelly 30 秒で把握

- **Shelly** = Android 向けネイティブターミナル IDE。Expo 54 / RN / Kotlin + C JNI。Samsung Galaxy Z Fold6 上で開発。
- **Termux 不要**。PTY は `modules/terminal-emulator/` の自前 JNI forkpty。
- CLI ツール（bash / node / git / python / claude / gemini / codex 等）は APK 内 `jniLibs/arm64-v8a/libXXX.so` に同梱 → 初回起動で `LibExtractor.kt` が `termux-libs/` に展開 → `.bashrc` の bash function から `_run` で起動する仕掛け。
- **HOME** = `/data/user/0/dev.shelly.terminal/files/home`（= `/data/data/dev.shelly.terminal/files/home`、同一 inode）。
- `_run()` = `/system/bin/linker64 "$@"` の thin wrapper。SELinux が app_data_file からの直接 execve を禁じるので、bionic の linker64 を「subject」にしてそこから .so を dlopen させる形。
- `libexec_wrapper.so` = bashrc 経由で LD_PRELOAD される exec hook。全ての `execve()` を `/system/bin/linker64 ...` にリライトして SELinux denial を回避する。**これが今回の詰まりの主犯格の一つ**。

---

## 2. bug #117 Path C-bis とは

**背景**: claude-code 2.1.113+ で Anthropic が `cli.js` を廃止し、Bun SEA (Single Executable Application) の静的リンク ET_EXEC バイナリに移行。`@anthropic-ai/claude-code-linux-arm64-musl` の `package/claude` 本体は 220 MB の aarch64 musl リンク ET_EXEC。

**Path C-bis**:
1. Alpine 3.19 相当の musl v1.2.4 を `src/network/resolvconf.c` の `/etc/resolv.conf` ハードコードを `/data/user/0/dev.shelly.terminal/files/home/.shelly-ssl/resolv.conf` に差し替えて cross-build
2. 生成した `ld-musl-aarch64.so.1`（ET_DYN、~630 KB）+ `@anthropic-ai/claude-code-linux-arm64-musl@latest` の `claude`（ET_EXEC、~220 MB）の 2 点を APK の jniLibs に同梱
3. 実行時 `_run $ld_musl $claude "$@"` で bionic linker64 に ld-musl を渡し、ld-musl が claude を mmap して走らせる
4. musl は `$HOME/.shelly-ssl/resolv.conf` を読むので DNS 解決可能 → api.anthropic.com に到達

**PoC 検証** (2026-04-21 Termux): 同じ binary 構成で `claude --print "reply with OK"` が `OK` 返した。exit=0。

**Shelly 検証** (2026-04-21 本日): **失敗**。次節。

---

## 3. 現行 branch (`claude/elegant-chatterjee-814adb`) で既に実装済みの部分

### 3.1 コミット履歴

```
477f5f10 ci(bug #117): swap musl.cc cross-build for Alpine aarch64 + qemu native
65eb70be feat(bug #117): Path C-bis ships claude-code 2.1.113+ on Android bionic
4a31f8a0 docs(bug #117): Path C-bis end-to-end ✅ — patched musl libc + claude 2.1.116 returns OK from live API
```

### 3.2 変更ファイル (main 差分)

| ファイル | 役割 | 状態 |
|---|---|---|
| `.github/workflows/build-android.yml` | musl cross-build（alpine:3.19 + qemu）+ claude-code-linux-arm64-musl@latest fetch + 毎日 00:00 UTC cron | ✅ CI green、`libld_musl_shelly.so`（633 KB, PT_PHDR **なし**）+ `libclaude.so`（220 MB）を jniLibs に焼き込む |
| `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt` | `libld_musl_shelly.so → ld-musl-aarch64.so.1`、`libclaude.so → claude` の 2 エントリ追加 | ✅ 初回起動で `termux-libs/` に展開（633 KB + 220 MB） |
| `modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt` | BASHRC_VERSION 43 → **44**、`claude()` を Path C-bis 優先 + legacy cli.js fallback の 2 段構成に、`$HOME/.shelly-ssl/resolv.conf` を seed する処理を `claude()` 内に追加 | ❌ 実装はあるが、Path C-bis 側が落ちた時の fallback が発火しないロジックになっている（`return $?` で即終了）、要修正 |
| `docs/superpowers/DEFERRED.md` | bug #117 section 更新（Path C-bis end-to-end 成立報告、CI 実装計画、未検証項目） | ✅ |

### 3.3 APK

[CI run 24702672633](https://github.com/RYOITABASHI/Shelly/actions/runs/24702672633) 成果物 `shelly-apk` (411 MiB zip)。Galaxy Z Fold6 / Android 16 / One UI に install 済。起動して terminal pane 開くと LibExtractor が ~10 秒展開 → bashrc v44 が書き出される。

---

## 4. 実機検証で何が起きたか（4 ラウンド）

### 4.1 ラウンド 1: `_run` 経由（デフォルトの claude() が呼ぶ経路）

```bash
$ claude --version
[shelly] claude: Path C-bis (musl Bun SEA)
Could not find a PHDR: broken executable?
Aborted                    /system/bin/linker64 "$@"
```

`exit=134` (SIGABRT)。

**エラーの出元**: bionic `/system/bin/linker64` が ld-musl の program header を走査するが、**PT_PHDR エントリが無い**ので `"could not find a PHDR: broken executable?"` で abort。

我々がビルドした ld-musl の readelf 結果:

```
  LOAD, LOAD, DYNAMIC, GNU_EH_FRAME, GNU_STACK, GNU_RELRO
```

PT_PHDR なし。GNU ld は PT_INTERP を持たない self-hosting dynamic loader には PT_PHDR を emit しない設計。

### 4.2 ラウンド 2: 直接 execve（`_run` を噛ませない）

```bash
$ "$LIBDIR/ld-musl-aarch64.so.1" "$LIBDIR/claude" --version
Could not find a PHDR: broken executable?
Aborted                    /system/bin/linker64 "$@"
```

**同じエラー**。bash の execve は `libexec_wrapper.so` の LD_PRELOAD hook で `/system/bin/linker64 ...` にリライトされるので、`env -i` / `env -u LD_PRELOAD` を付けても効かない（hook は親プロセスの address space に既にロード済み）。

### 4.3 ラウンド 3: PT_PHDR を patch した ld-musl

手元 PoC バイナリを Python で in-place 編集、GNU_EH_FRAME エントリ（例外処理、musl C code では未使用）を PT_PHDR に書き換え:

```python
# C:\Users\ryoxr\shelly-musl-poc\patch-phdr.py 参照
new_phdr = struct.pack('<IIQQQQQQ',
    6,              # p_type = PT_PHDR
    4,              # p_flags = R
    e_phoff,        # p_offset = 64
    e_phoff,        # p_vaddr（first LOAD が p_vaddr=0 p_offset=0 なので phdr 位置は vaddr=offset=64）
    e_phoff,        # p_paddr
    e_phentsize * e_phnum,  # p_filesz = 336 = 6×56
    e_phentsize * e_phnum,  # p_memsz
    8,              # p_align
)
```

readelf で PHDR 出現を確認後、adb push → Shelly 実行:

```bash
$ claude --version
Segmentation fault         /system/bin/linker64 "$@"
```

`exit=139` (SIGSEGV)。**エラーは変わったが死ぬ**。

**診断**: bionic linker64 は PT_PHDR の追加で ELF パースを通過するようになったが、今度は runtime で死ぬ。**bionic が ld-musl を「普通の PIE」として扱い自力で relocation を適用した結果、ld-musl が自分でやる relocation と二重発生**してメモリが壊れる、というのがもっともらしい。ld-musl は self-hosting loader なので「kernel が relocate 前の状態で呼ぶ」前提を置いている。

### 4.4 ラウンド 4: proot + Alpine rootfs 経由

Shelly は既に `libproot.so` + `alpine-rootfs.tar.gz` を同梱済。`$HOME/.shelly-rootfs` に Alpine mini rootfs が展開される。そこに Alpine の純正 ld-musl（`/lib/ld-musl-aarch64.so.1`）が入っているので、chroot 内で claude を走らせれば我々の musl build すら不要になる、という筋書き。

```bash
$ _run $LIBDIR/libproot.so -r $ROOTFS -b /dev -b /proc -b /sys /bin/busybox echo hello
proot error: execve("/system/bin/ls"): Operation not permitted
proot info: It seems your kernel contains this bug:
    https://bugs.launchpad.net/ubuntu/+source/linux/+bug/1202161
To workaround it, set the env. variable PROOT_NO_SECCOMP to 1.
```

**Samsung OneUI の kernel に proot seccomp の既知バグ**。`PROOT_NO_SECCOMP=1` を付けると:

```bash
$ PROOT_NO_SECCOMP=1 _run $LIBDIR/libproot.so -r $ROOTFS ... /bin/busybox echo hello
proot error: execve("/bin/busybox"): Function not implemented
```

ENOSYS。seccomp 無しでは proot の execve 翻訳が機能しない。catch-22。

他にも `proot warning: can't chdir("/data/data/dev.shelly.terminal/files/home/./.") in the guest rootfs` という canonicalize 異常（`/data/data` と `/data/user/0` の扱いのずれ、末尾に謎の `/./.`）も併発、複数箇所で死んでいる。

**結論: この端末では proot は動かせない**。

### 4.5 Path C-bis 実行経路の詰み

| 経路 | 詰まりポイント |
|---|---|
| `_run` + 素の ld-musl | bionic linker64 が PT_PHDR 無いと abort |
| `_run` + PT_PHDR patch 済 ld-musl | bionic の relocation と musl の self-relocation 二重発生で SIGSEGV |
| 直接 execve | libexec_wrapper が LD_PRELOAD で execve hook 済、`env -u` でも逃げられない |
| raw syscall で直接 execve | SELinux の `untrusted_app → app_data_file:execute_no_trans` で Permission denied（この端末では未検証だが Android 10+ の定番ルール） |
| proot + Alpine rootfs | kernel の seccomp バグ、`PROOT_NO_SECCOMP=1` では execve 翻訳が停止 |

**残る道は C trampoline loader 一択**。次節で設計を書く。

---

## 5. C trampoline loader 設計案

### 5.1 狙い

bionic が ld-musl を「自分の子」として扱って relocate してしまうのを避ける。bionic からは bionic-linked の **自前 loader** を呼ぶ → 自前 loader が **kernel が execve するのと同じ stack/auxv layout** を手で構築 → ld-musl の entry (`_dlstart`) に jump、あとは musl 側で完結。

bionic の relocation も LD_PRELOAD hook も「自前 loader バイナリ」が受け取るだけ、musl 側には届かない。

### 5.2 入出力

```
$ shelly-musl-exec /path/to/ld-musl /path/to/claude [args...]
        ↓
    bionic linker64 が shelly-musl-exec を PIE として load
        ↓
    main() が ld-musl と claude の path を argv から拾う
        ↓
    ld-musl ファイルを raw mmap、LOAD segment を配置
        ↓
    新しい stack を alloca/malloc で確保、argc/argv/envp/auxv を kernel と同じ layout で書く
        ↓
    SP を新しい stack に切り替え、ld-musl の e_entry (_dlstart) に jump
        ↓
    musl は auxv 読み、self-relocate、claude を mmap、claude の entry に jump
        ↓
    claude 本体が走る
```

### 5.3 実装の Rough Cut

```c
// modules/terminal-emulator/android/src/main/jni/shelly-musl-exec.c
//
// Compile as aarch64 bionic PIE with NDK:
//   $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android29-clang \
//     -fPIE -pie -O2 -o libshelly_musl_exec.so shelly-musl-exec.c
//
// Usage (from bash function):
//   _run $libDir/shelly_musl_exec $libDir/ld-musl-aarch64.so.1 $libDir/claude "$@"

#include <elf.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

// 1. /path/to/ld-musl を open + fstat + mmap
// 2. ELF header 読み取り、PT_LOAD segment を走査
// 3. 各 LOAD segment を mmap (MAP_PRIVATE | MAP_FIXED, load base + p_vaddr) で配置
//    メモリは page size aligned、.bss は memsz > filesz の差分を memset(0)
// 4. kernel が execve 時に構築する stack を alloca ではなく mmap で確保（align 要注意）:
//    SP:    argc
//    SP+8:  argv[0]  = "/path/to/ld-musl"
//    SP+16: argv[1]  = "/path/to/claude"
//    SP+...: argv[2..] (元 argv をスライド)
//    SP+...: NULL
//    SP+...: envp[0..]
//    SP+...: NULL
//    SP+...: auxv[] — getauxval でない raw Elf_auxv_t 並びを再構築
//             AT_PHDR   = load_base + e_phoff
//             AT_PHENT  = e_phentsize
//             AT_PHNUM  = e_phnum
//             AT_BASE   = 0（musl は ld-musl 自身が実行主体なので AT_BASE は 0）
//             AT_ENTRY  = load_base + e_entry
//             AT_PAGESZ = sysconf(_SC_PAGESIZE)
//             AT_RANDOM, AT_UID, AT_GID, AT_EUID, AT_EGID, AT_SECURE も必須
//             AT_NULL で terminate
// 5. inline asm で SP を新 stack に切り替え + ld-musl の entry (load_base + e_entry) に jmp
//    AArch64:
//      mov sp, %[newsp]
//      br  %[entry]
```

### 5.4 工数見積もり

| 項目 | 時間 |
|---|---|
| C コード書く | 2〜3 時間 |
| NDK 経由で cross build する CI step を追加 | 30 分 |
| LibExtractor 登録 + bashrc 差し替え | 30 分 |
| 実機デバッグ (SIGSEGV 周り) | 1〜3 時間 |
| 合計 | **半日〜1 日** |

実機で最初から動くことはまず無いので strace でアラインメント / auxv の異常を潰すサイクルが要る。

### 5.5 参考実装

- [musl の ldso/dlstart.c](https://git.musl-libc.org/cgit/musl/tree/ldso/dlstart.c) — _dlstart の入り口。AArch64 の最初の動作を見れば expected stack layout がわかる
- [Linux kernel fs/binfmt_elf.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/binfmt_elf.c) — kernel が exec 時にどう stack を組み立てるかのリファレンス、`create_elf_tables` 関数
- [musl-nolibc linker](https://github.com/rui314/mold) mold のソースにも参考になる PT_LOAD mapping コードあり
- bionic の `linker64` ソース (AOSP) — どこで失敗してるか追うのに便利

---

## 6. 実装ステップ（提案）

### Phase 1: C trampoline loader を書く

1. `modules/terminal-emulator/android/src/main/jni/shelly-musl-exec.c` を新規作成
2. ローカルで NDK を落として cross-compile、aarch64 Android emulator で最低限の動作確認（`./shelly_musl_exec /path/to/hello-world-musl-binary` みたいなので）
3. `.github/workflows/build-android.yml` に build step 追加（NDK は actions/setup-android が入れてくれる、そこから $ANDROID_NDK_ROOT で clang を叩く）
4. 成果物を `modules/terminal-emulator/android/src/main/jniLibs/arm64-v8a/libshelly_musl_exec.so` に置く

### Phase 2: Shelly に組込み

5. `LibExtractor.kt` の LIBS に `"lib/arm64-v8a/libshelly_musl_exec.so" to "shelly_musl_exec"` を追加
6. `HomeInitializer.kt` の `claude()` bash function を:
   ```bash
   claude() {
     local __trampoline="$libDir/shelly_musl_exec"
     local __musl_ld="$libDir/ld-musl-aarch64.so.1"
     local __musl_claude="$libDir/claude"
     if [ -x "$__trampoline" ] && [ -x "$__musl_ld" ] && [ -x "$__musl_claude" ]; then
       # resolv.conf seed（既存ロジック流用）
       ...
       _run "$__trampoline" "$__musl_ld" "$__musl_claude" "$@"
       return $?
     fi
     # legacy cli.js 2.1.112 fallback（現行コード維持）
     ...
   }
   ```
7. BASHRC_VERSION を 44 → 45 に bump

### Phase 3: CI + 実機検証

8. push → workflow_dispatch で CI build
9. APK artifact を download、実機 install
10. Shelly terminal で `claude --version` → `claude --print "reply with OK"` が通ることを確認
11. 長時間対話 (`claude` interactive) も 5〜10 分ほど走らせて SIGSEGV / SIGBUS が無いか確認（fstat / mmap 周りのコーナーが出やすい）

### Phase 4: 仕上げ

12. `docs/superpowers/DEFERRED.md` の bug #117 を ✅ close に更新、History に v0.1.1 リリースエントリ追加
13. README Status 表のヒーロー文言を「Android で最新 Claude Code を動かせる唯一のアプリ」に差し替え
14. v0.1.1 タグ + GitHub Release ノート

---

## 7. 手元の成果物 (PC, uncommitted)

```
C:\Users\ryoxr\shelly-musl-poc\
├── libc.musl-aarch64.so.1          # 元 PoC build、PT_PHDR 無し (633 KB)
├── libc.musl-aarch64-phdr.so.1     # PT_PHDR patch 済み (633 KB)、実機で SIGSEGV を引いた版
├── resolvconf.patched.c            # musl に当てた sed patch 結果の写し
├── test-path-c.log                 # 2026-04-21 Termux PoC 成功ログ (claude --print OK 返る)
├── patch-phdr.py                   # PT_PHDR 埋め込みスクリプト、trampoline 不要になれば捨てて良い
└── shelly-verify.md                # 実機検証手順書（古い、proot 前提は無視して OK）
```

Termux PoC ログ `test-path-c.log` に記録されている「musl libc + claude 2.1.116 が `OK` を返す」事実は brand safety 上強力。spec / PR の根拠として引用すると良い。

---

## 8. Fallback シナリオ（trampoline がどうしても上手く行かない場合）

完全に詰んだら以下に降格:

1. Path C-bis を **optional** にする：`HomeInitializer.kt` の `claude()` で、Path C-bis が試行後落ちた場合に legacy cli.js に fall through するよう改修（`return $?` ではなく exit code を見て分岐）。ユーザーは `SHELLY_FORCE_LEGACY_CLAUDE=1` を export すれば legacy 直行にできる。
2. README / DEFERRED に「Path C-bis は experimental、本番は 2.1.112 cli.js」と明記。
3. v0.1.1 は他の修正（BASHRC_VERSION 44 の claude() ルーティング改善 + CI の musl build 基盤整備）をまとめて出す。
4. bug #117 は **🟡 partially shipped** として P1 継続。

この場合の工数はたぶん 1 時間以下。

---

## 9. 自動追従 (ユーザー要求機能)

`.github/workflows/build-android.yml` に **毎日 00:00 UTC の cron** は既に埋まっている (`on.schedule.cron: '0 0 * * *'`)。Anthropic が新版リリース → 翌日 UTC 0 時に CI が `npm pack @anthropic-ai/claude-code-linux-arm64-musl@latest` を実行 → 新 claude binary 入りの APK が artifact として生成される。あとは Release 発行 or EAS Update に乗せれば prod 配信。

trampoline が完成すれば、この自動追従は brand の核になる。

---

## 10. 作業前に徹底してほしい点（お作法）

- **commit メッセージは英語**、末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer（または Codex 用に適切な trailer）
- **BASHRC_VERSION は毎回 bump**。bashrc 差し替えを強制するため（現行 44）
- **既存の tsc エラー 7 件は触らない**。Path C-bis と無関係
- **DEFERRED.md を編集したら同じコミットで commit** (`docs(deferred): ...`)
- **ブランチ保護を破らない**。main への直 push は禁じ、feature branch → PR → merge
- **push 前に `gh auth status` 確認**。PC 環境にはこのセッションで auth 済、Codex 環境で別途必要なら `gh auth login --web --hostname github.com --git-protocol https`
- **実機検証はワイヤレス ADB**。ユーザーに Z Fold6 側で「開発者オプション → ワイヤレスデバッグ → コードでペア設定」開いてもらって `adb pair 192.168.x.x:PORT CODE` → メイン IP:PORT で `adb connect`。scrcpy でミラーリング可
- **インストール先は `/sdcard/Download/`**。Shelly は Termux と別 app なので Termux 実機検証と混ぜる時は注意（Termux HOME と Shelly HOME は完全別）

---

## 11. 質問されたら答えるべきトピック

- 「なぜ bionic で musl を走らせる必要が？」 → claude-code 2.1.113+ が musl-only で配布、bionic 版は無い。Shelly は bionic app data で動く Android app なので共存が必要。
- 「Termux でやらないの？」 → Termux は app data を独自 SELinux 緩和で動かしてる、ユーザーは別 app。Shelly の中で完結させないと UX の売り物にならない。
- 「219 MB の binary を毎 APK 更新で再 DL 強いるの？」 → v0.1.1 は yes、v0.1.2 で optional download UI を検討（DEFERRED 登録済）。
- 「proot をもう一度何とかならないか？」 → Samsung One UI カーネルの seccomp バグが根治しない限り厳しい。別端末なら動く可能性あり。

---

**作成**: 2026-04-21 14:00 JST、Claude Opus 4.7 セッション上。
**次担当**: Codex 環境
**前セッション spec**: [`2026-04-21-bug117-path-c-handoff.md`](./2026-04-21-bug117-path-c-handoff.md)
