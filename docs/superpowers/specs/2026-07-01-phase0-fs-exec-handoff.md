# Phase 0 床 残り実装 引き継ぎ — FS-001 / EXEC-001 → PlanSpec executor / .sh 退役

- **Status**: 🟢 実装引き継ぎ（モバイル連動クラウドセッション向け）。CAP-001/SECRET-001/HTTP-001 は着地＋実機 VERIFIED 済み（build 1659）。
- **Date**: 2026-07-01
- **Branch(work)**: `claude/work-handoff-2qb1xd`（main 未マージ）
- **正典**: `docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md`（§3 L2 / §4 安全の背骨 / §7 ロードマップ / §8 不変条件）。進捗の真実は `docs/superpowers/DEFERRED.md`「🧭 L1/L2 Capability Catalog」節。
- **North Star**: on-device Android 版 Hermes。今回作るのは Phase 0「床」の残り。planner / skill 自動登録には進まない。

## 使い方
- **実装セッション**（wireless adb を握れる＝Codex 等、または USB/adb 有のローカル CC）に **§A**（次チャンク）の /goal ブロックをそのまま貼る。#A が実機グリーンで停止・報告 → 次回 **§B**。
- **レビューセッション**（CC・モバイルクラウド）に **§R** を貼る。実装側は **push 前に §R レビューで APPROVE 相当**を取る（噛み合わせは「レビュー用ブランチ方式」参照）。
- 両方とも下の **§0〜§4（共有コンテキスト）を先に読む**こと。/goal ブロックはこの doc を参照する前提で自己完結させてある。

---

## §0. 正典（着手前に読む）
- 上記 spec の §3/§4/§7/§8。特に **§8.2「big-bang 禁止・strangler 移行」**、**§4.3「唯一の構造ルール（tainted×秘密/非allowlist は無承認不可）」**、**§4.4「secret-by-reference」**、**§9「無人＝決定論 PlanSpec のみ、承認ゲートは無人時 fail-closed」**。
- DEFERRED「🧭」節の Phase 0 進捗（G0-1/2/3 済の記録＋残タスク＋P1 follow-up）。

## §1. 現状（G0-1/2/3 = CAP/SECRET/HTTP-001 済・実機 VERIFIED）
着地済み（commits `996f2d73` / `2b149307` / `9c7b51d4`、build 1659）:
- `lib/capability-envelope.ts` — 純粋コア（egress allowlist / auth-ref の **host-binding** / taint 構造ルール §4.3 / budget / redacted audit builder）。
- `scripts/shelly-capability-broker.js`（+ APK asset ミラー `modules/terminal-emulator/android/src/main/assets/shelly-capability-broker.js`、byte-identical・parity test）— node broker。`http_post_json` が `SHELLY_CAP_BROKER=1` で委譲。broker は `.env` を **自身で読んで** `auth_ref`→ヘッダ解決（`.sh` は生 `Bearer $KEY` を組まない）。allowlist / budget fail-closed / redacted audit を強制。
- wiring: `lib/agent-executor.ts` の `http_post_json`（broker 分岐＋不在時 fail-closed）、perplexity/gemini/cerebras/groq の各 call-site（broker モードは `SHELLY_CAP_AUTH_REF`、legacy else は生ヘッダ＝回帰保存）、webhook `SHELLY_CAP_APPROVED=1`、per-run budget reset、version 10→11。
- 版数 lockstep: `AGENT_SCRIPT_VERSION`（`lib/agent-executor.ts:16`、メイン script と `refusalScript` の2箇所で使用）＝ `CURRENT_SCRIPT_VERSION`（`AgentRuntime.kt`）＝ テスト期待値、全て **11**。
- asset 展開: `HomeInitializer.kt`（`shelly-capability-broker.js` を毎起動 `$HOME/.shelly-capability-broker.js` へ）。
- テスト: `__tests__/capability-envelope.test.ts` / `capability-broker.test.ts` / `capability-broker-parity.test.ts` / `agent-executor-cap-broker.test.ts`。

## §2. 再利用する「型」（今日確立、そのまま踏襲）
新プリミティブは全てこの順で作る:
1. **純粋 TS コア** `lib/capability-*.ts`（判定ロジックのみ／副作用なし）＋ jest。
2. **node broker/helper** `scripts/shelly-*.js` を書き、`cp` で `modules/.../assets/` にミラー（**byte-identical**）＋ **parity test**（scripts↔asset の byte 一致＋定数一致）。
3. **flag-gated wiring** を `lib/agent-executor.ts` の生成シェルに。**既定 OFF＝既存経路 byte-preserve（回帰ゲート）**。broker 不在/失敗時は **fail-closed**（無防備 fallback 禁止）。
4. **版数 lockstep 更新**（TS 2箇所＋kt＋テスト期待値）。asset は `HomeInitializer.kt` で展開。
5. **jest ＋ `bash -n`**（生成シェルのパース検証。**大きい script は一時ファイルに書いて `bash -n <file>`**＝`bash -c` は Windows で argv 長超過。Linux/Mac の実装セッションは `-c` でも可だが temp-file が可搬）。
6. **プッシュ前 §R レビュー（必須ゲート）** → **実機 verify**（§4）→ **DEFERRED 更新**。

## §3. 地雷（必読・今日踏んだ/Codex 指摘）
1. **Node ビルトインフラグ衝突**: `--env-file` は Node 自身のフラグ（不在で exit 9）。broker の CLI フラグは **Node 予約語と衝突しない名前**にする（今日 `--secret-env-file` に改名）。新フラグ命名時に必ず確認。
2. **SECRET は per-callsite 条件分岐**: broker モードでは call-site で **生ヘッダ（`Bearer $KEY` / `x-goog-api-key: $KEY`）を組まない**。`SHELLY_CAP_AUTH_REF=<ref>` だけ渡す。両方セットすると子 environ に秘密が載る。legacy else 側だけ生ヘッダ。
3. **`.env` は依然 source されるが `set -a` 無し・非 export** ⇒ 秘密は shell 変数どまりで子 environ に載らない（＝broker の secret-by-ref が意味を持つ前提）。**この不変を壊すな**（allexport / `export KEY=` を足さない）。
4. **版数 lockstep**: 生成シェルを変えたら **必ず** TS 2箇所＋kt＋テスト期待値を +1。ズレると scheduled fire が "stale script" で全滅。
5. **既存 on-disk `run-agent-*.sh` は版数バンプで stale**（v10→v11）。app から一度 RUN/再登録すると再生成。scheduled agent は一度手動 RUN が要る（version gate は設計通り）。
6. **`set -euo pipefail`**: broker/exec 呼び出しは非 0 を返すので、呼び出しは既存同様 `set +e ... set -e` で囲む（backend call-site は既にそう）。
7. **exec 可能なのは APK 同梱 native libDir のみ**（Knox）。`$HOME`/`/sdcard` に置いた script は **bash 引数として実行**（`bash /path`）はできるが、shebang 直実行や PATH shim は不可。新ネイティブ/権限は **APK 再ビルド＋再インストール（in-app updater）**が要る。
8. **adb identity ≠ Shelly app-uid**（Codex 指摘）: `adb shell` は外部観測者。**app-uid での実現可否**（本番能力）と **adb での刺激/裏取り**を **別に記録**する。今日の broker 検証は **Shelly ターミナル（app uid）で broker を実行**し、adb は harness を `/sdcard` に push・結果 pull しただけ。FS-001/EXEC-001 も同様に **app-uid（Shelly ターミナル or 実 agent RUN）で実行**して立証すること。
9. **`/sdcard` は harness/fixture/result 専用**（exec 不可）。
10. **スクショ禁止（standing rule）**: `adb shell screencap` / `screenrecord` / `scrcpy --record` は使わない（CC を壊す）。裏取りは **テキスト成果物（JSON/log）** ＋ 必要ならライブ scrcpy ミラー（録画なし）。
11. **adb push の path 化け**（ローカル Windows/git-bash のみ）: `MSYS_NO_PATHCONV=1 adb push ... /sdcard/...`。Codex(Linux/Mac) は不要。
12. **秘密の値を絶対に出力しない**（`echo "${VAR:+set}"` すら禁止。存在確認はキー名を出さない形／値は grep 検索語にしない）。

## §4. 実機 verify ハーネスの型（2モード）
今日の `shelly-cap-verify.sh` を雛形にする。**broker/exec は app-uid で走らせ、結果を `/sdcard/<name>/` に JSON/テキストで吐く**。

- **adb 自走版（実装セッションが adb 有）**: harness を `MSYS_NO_PATHCONV=1 adb push` で `/sdcard` へ → **Shelly ターミナルで `bash /sdcard/<name>.sh`（app uid）** → `adb shell cat /sdcard/<name>/report.txt` で解析 → 修正 → 再実行。app-private（`$HOME/.shelly/...`）は release ビルドで adb 直読不可なので、必要な監査は harness 内で `/sdcard` にコピーして pull。
- **ハーネス貼り戻し版（クラウド CC・adb 無）**: harness を成果物として push → **ユーザーが Shelly ターミナルで実行 → `report.txt` を貼り戻す** → セッションが判定。
- 監査の裏取り観点（毎回）: 該当 broker/op の audit 行が **redacted**（`authRef` は名前のみ・鍵値/`Bearer`/`AIza` 等が grep 0 件）／decision・fail-closed が期待通り／**app-uid で実行**していること。

## レビュー用ブランチ方式（レビュー前 push の噛み合わせ）
独立クラウド2セッションでも review-before-(final)-push を成立させる:
1. 実装は **`cc/phase0-fs-exec`（レビュー用）** に push。
2. **§R の CC セッションがそのブランチを `/code-review high`** → 指摘を返す。
3. 実装が指摘を解消し **APPROVE 相当**になったら `claude/work-handoff-2qb1xd` に **ff/merge**。
（relay 方式でも可: 実装が diff/patch を relay で CC に渡し、CC がレビュー→返却。どちらでも「最終 push 前に CC レビュー」を満たすこと。）

---

## §A. /goal — 実装 #1: FS-001 + EXEC-001（次チャンク）

```
/goal Phase 0 床の残りプリミティブ FS-001 と EXEC-001 を strangler で実装し、実機グリーンまで進める。

0. まず読む: docs/superpowers/specs/2026-07-01-phase0-fs-exec-handoff.md の §0〜§4・レビュー方式、正典 spec 2026-07-01-l1-l2-capability-catalog.md §3/§4/§7/§8、DEFERRED「🧭」節。既存の型（lib/capability-envelope.ts / scripts/shelly-capability-broker.js / __tests__/capability-*.test.ts / agent-executor.ts の http_post_json broker 分岐）を精読してそのまま踏襲する。

1. 環境・制約: 開発・最終 push は claude/work-handoff-2qb1xd のみ（レビューは cc/phase0-fs-exec 経由=handoff のレビュー方式）。PR は作らない。コミット footer は既存ルール。モデル識別子をコード/コミット/成果物に書かない。秘密の値を絶対に出力しない。Knox 制約（handoff §3-7〜9）。既定 OFF のフラグ＋回帰ゲートで既存 .sh 経路を緑のまま保つ（§8.2 strangler、big-bang 禁止）。

2. 実装ループ（各チャンク）: 読む→迷えばサブエージェント（調査=Explore / 設計=Plan / 横断=general-purpose、独立作業は1メッセージ並列）→実装（周囲の規約に合わせる。新状態は Zustand、色は useTheme、i18n は en/ja 両方）→ jest＋bash -n(temp-file) PASS を必須ゲート→ プッシュ前 CC レビュー(§R, /code-review high)で APPROVE 相当→ ビルド(gh workflow run "Build Android APK" --ref …、gh run で取得)→ 実機 verify(§4 ハーネス, app-uid 実行＋/sdcard 裏取り、スクショ禁止)→ DEFERRED 更新→次へ。

3. チャンク:
   G0-5 FS-001 scoped.fs — skill/agent root 配下に再スコープした read/write/list/search を capability broker の op として追加（純粋コア lib/capability-fs.ts に canonicalize＋許可 root 集合の isWithinRoot 判定=lib/agent-boundary-policy.ts の normalizePath(:56)/isWithinRoot(:70) を再利用）。**workspace 越境の構造修正をここで強制**: 現状の出力書き込み save_draft_result(lib/agent-executor.ts:699 の OUTPUT_DIR/SAVED_FILE(:740)/OBSIDIAN_DEST(:754)/global-output(:723)、outputDir 導出 :203) が許可 root 外へ書けてしまう経路を、FS 検証（許可 root: agent output base / Obsidian vault / content-studio 等の宣言集合）に通して root 外は fail-closed 拒否＋redacted audit。flag(例 SHELLY_CAP_FS=1)＋回帰ゲート、既定 OFF で現状 byte-preserve。
     受け入れ: root 外パスへの書き込みが拒否され audit に残る／in-root 書き込みは不変（回帰ゼロ）／read/write/list/search が root 境界を越えない／jest＋bash -n＋実機ハーネス（app-uid 実行で root 越境が構造的に不可）。
   G0-6 EXEC-001 workspace.exec — curated exec に制限。現状 cli action の raw `bash -lc "$ACTION_COMMAND"`(lib/agent-executor.ts:857) を、(a) cwd jail（許可 root 内でのみ、越境拒否＝isWithinRoot 再利用）(b) command template/allowlist（evaluateAgentActionCommand=lib/agent-action-safety.ts:12 と checkCommandSafety=lib/command-safety.ts:170 を通し CRITICAL は hard-deny）(c) timeout（既存 TIMEOUT）(d) **secret-env 禁止**（exec 前に全 API キー env を unset した最小 env で実行＝秘密を curated exec に渡さない）に置換。cli は決して one-tap 不可（必ず in-app confirm、既存 write_action_approval_request/wait_action_approval を維持）。flag＋回帰ゲート。
     受け入れ: cli action が **秘密 env 無し**で実行（env をダンプするコマンドで鍵が出ないことを app-uid 実機で確認、鍵値は出力しない形で）／cwd 越境拒否／timeout 効く／CRITICAL ブロック／one-tap 不可（in-app confirm 必須）／jest＋bash -n＋実機ハーネス。

4. 実機 verify（handoff §4）: FS-001/EXEC-001 用の verify ハーネス(shelly-cap-verify.sh 相当)を作り、app-uid（Shelly ターミナル or 実 agent RUN）で実行して /sdcard に JSON/テキストで結果を吐く。adb 有なら自走(push→ターミナル実行→pull→解析)、無ければユーザー実行→貼り戻しで判定。STOP-ALL(halt sentinel)中は RUN 拒否も確認（回帰防止）。

5. 停止条件（キリのいいとこ）: **FS-001 と EXEC-001 が両方 flag-ON で実機グリーン**（越境拒否／secret-env-free exec／回帰ゼロ）になったら停止し、①やったチャンク＋commit SHA、②実機で確認できたこと/できなかったこと（app-uid vs adb を区別）、③次(#B=PlanSpec executor/.sh 退役)の残タスク、を報告。ビルド失敗が infra flake なら rerun、コード起因なら直す。迷えば大改修せずサブエージェント相談 or AskUserQuestion。
```

---

## §B. /goal — 実装 #2: PlanSpec executor ＋ .sh 退役（Phase 0 完了）

> **着手条件**: §A の全ブローカー（CAP/SECRET/HTTP/FS/EXEC-001）が個別に実機検証済みであること（§8.2/§7 0-6）。未達なら §A を先に。

```
/goal Phase 0 の終点=orchestration を TS/node PlanSpec executor へ寄せ、最後に生成 .sh executor を退役する。strangler・big-bang 厳禁（正典 §8.2）。

0. まず読む: docs/superpowers/specs/2026-07-01-phase0-fs-exec-handoff.md 全体、正典 §7(0-6)/§8/§9、DEFERRED「🧭」節。現状の実行本体= AgentRuntime.kt（FGS→bash で run-agent-*.sh を source、版 gate）、agent-executor.ts の generateRunScript 全体、approval bridge/audit/notification/web-ladder の焼き込み箇所、lib/agent-manager.ts の materialize（writeFileCommand/generateInstallCommands）を精読。

1. 制約: §A と同じ（branch/PR/footer/モデル識別子/秘密非出力/Knox/レビュー方式）。**既存 .sh 経路は緑のまま**維持し、PlanSpec executor を併設して段階移行。**一括置換禁止**。無人=決定論 PlanSpec のみ・承認ゲートは無人時 fail-closed（§9）。

2. 実装ループ: §A と同じ（読む→サブエージェント→実装→jest+bash -n→プッシュ前 CC レビュー→ビルド→実機 verify→DEFERRED）。設計判断（PlanSpec 型・executor 境界・移行手順）は着手前に Plan サブエージェント必須。

3. チャンク:
   B-1 PlanSpec 型＋ node executor を新設（bundled: scripts/shelly-*.js＋asset ミラー＋parity、HomeInitializer 展開）。executor は各ステップを CAP/SECRET/HTTP/FS/EXEC-001 broker 経由で実行（モデルのテキストが直接コマンドになるのは curated EXEC-001 のみ=§3.5）。approval/audit/budget/taint/version gate を executor 側でも一元化。
   B-2 flag(例 SHELLY_PLAN_EXECUTOR=1)で 1 エージェントを **.sh を通さず** executor で end-to-end 実行。既存 .sh 経路と **parity**（同じ approval/audit/通知/結果）を実機で突き合わせ。
   B-3 カバレッジを広げる（backend 種別・orchestration 多段・スケジュール発火・STOP-ALL）。**全ケースが executor で緑**になって初めて .sh を段階退役（生成・材料化・版 gate の撤去は最後）。

4. 実機 verify: §A §4。特に (a) executor 経路で完了通知＝回帰ゼロ (b) audit redacted (c) 無人スケジュール発火が決定論 PlanSpec で回る (d) STOP-ALL 中 RUN 拒否 (e) .sh 経路と結果 parity。app-uid で立証、adb は裏取り。

5. 停止条件: **executor が 1 エージェントを end-to-end 実行し既存 .sh と parity（B-2 完了）**でいったん停止・報告（①commit ②実機確認 app-uid/adb 区別 ③残=カバレッジ拡大と .sh 退役）。.sh の一括退役までは1セッションで狙わない（段階移行の終点、複数セッション）。
```

---

## §R. レビュー用プロンプト（CC・モバイルクラウド、pre-push ゲート）

```
Shelly の Phase 0 床（capability broker）実装をレビューする。security-critical（単一 uid Android・秘密・egress・native/IPC）なので特に厳格に。

対象: ブランチ cc/phase0-fs-exec（または渡された diff/patch）。まず docs/superpowers/specs/2026-07-01-phase0-fs-exec-handoff.md §1〜§3、正典 spec §4/§8/§9 を読み、既存 lib/capability-envelope.ts / scripts/shelly-capability-broker.js の設計に整合しているか確認。

手順: /code-review high を実行（diff 全体）。加えて以下の不変条件を明示的に検証し、CONFIRMED/PLAUSIBLE のみ報告:
1. 秘密非漏洩: 生 API キーが argv / 子プロセス environ / audit / err / log に載らないか。broker モードで生ヘッダを組んでいないか。.env の source が allexport/export で子に漏れないか。
2. allowlist / host-binding / root 境界の迂回: URL/パスの正規化（userinfo `user@host`、trailing dot、大文字、`..`、シンボリックリンク境界）で越境できないか。secret/exec/fs が許可先以外に届かないか。
3. fail-closed: broker/executor 不在・エラー・budget 超過・非 allowlist・root 越境・CRITICAL コマンドで、無防備 fallback せず必ず拒否するか。無人時の承認ゲートが fail-closed か。
4. 回帰ゲート: flag 既定 OFF で既存 .sh 経路が byte-preserve か。call-site else 分岐が元コマンドと一致か。
5. 版数 lockstep（TS 2箇所＋kt＋テスト）・asset parity（scripts↔assets byte 一致）・Node フラグ衝突（予約語回避）。
6. adb identity と app-uid 能力の混同（adb で通っても app-uid で不可なものを「実現」と誤記録していないか）。

出力: 深刻度順の findings（file:line＋具体的な失敗シナリオ）。指摘は「修正 or 明示的却下理由」を実装側に返し、APPROVE 相当まで最終 push させない。テスト（jest＋bash -n）と実機 verify（app-uid 実行＋redacted audit）の証跡も確認する。
```

---

## 付記
- 今日の実機検証の実例（雛形）: `scripts/`（履歴）や DEFERRED「🧭」節の検証手順、および本セッションで使った `shelly-cap-verify.sh`（deny40/block41/budget42/loopback-allow/実鍵送信の非漏洩を app-uid で実行し /sdcard→adb で裏取り）。
- P1 follow-up（DEFERRED 記載）: SECRET 完全 de-source（config も broker 解決）／非 allowlist の対話承認（`--approved` を nonce/host 束縛）／policy-deny の診断表示／budget と retry×escalation の関係。FS-001/EXEC-001 実装時に関連すれば併せて解消可。
