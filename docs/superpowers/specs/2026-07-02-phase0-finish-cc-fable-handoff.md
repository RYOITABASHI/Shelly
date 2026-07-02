# Phase 0 床 仕上げ 引き継ぎ — CC(Fable5) 実装 / Codex(wireless adb) 実機監視

- **Status**: 🟡 夜間バッチ向け。Phase 0 の残り（B-2 の installed 再確認 → Part B 実RUN統合 → B-3 `.sh` parity 移植 → `.sh` 退役ステージング）を CC 単独で「行けるとこまで」。実機確定は Codex 監視へ。
- **Date**: 2026-07-02
- **Branch(work)**: `claude/work-handoff-2qb1xd`（HEAD `ce9a0a33`。fix `694dee87`=LD_PRELOAD 実機バグ修正が着地済み）／**レビュー用**: `cc/phase0-fs-exec`
- **正典**: `docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md`（§7 ロードマップ/§8 不変条件）、`docs/superpowers/specs/2026-07-01-phase0-fs-exec-handoff.md`（§0–§4 の型/地雷/verify）、`DEFERRED.md`「🧭」節。

## 役割分担（重要）
- **実装 = CC(Fable5) 単独**。Codex は実装に使わない。
- **実機監視 = Codex（wireless adb 接続）**。ただし **release ビルドは `run-as` 不可**＝adb(shell uid) から app-uid でハーネスを直接実行できない。だから Codex の実機役割は「build/install・`am` で実エージェント RUN 発火（Part B 本番経路）・logcat/`/sdcard`出力/通知の観測」に限る。app-uid の直叩きハーネス（`node /sdcard/shelly-plan-verify.js`）は**人間が Shelly ターミナルでタップした時のみ**。
- **CC の合格基準はオフラインゲート**（`pnpm check`＋jest＋`bash -n`＋`/code-review`）。**device-green は CC の停止条件にしない**（監視側/人間が閉じる）。ただし「オフライン緑 ≠ 実機緑」を肝に銘じる — 実際、今日 LD_PRELOAD の実機専用バグ（bionic node の OpenSSL クラッシュ）を実機で初めて捕まえた。

## 現状（ここから続ける）
- CAP/SECRET/HTTP/FS/EXEC-001 broker＋PlanSpec executor canary は実装・レビュー済み。executor 安全コアは実機 8/8 PASS（build 1666＋patched executor）。
- 直近の実機バグ fix `694dee87`（`shelly-plan-executor.js` `childEnv` で broker 起動時に `delete env.LD_PRELOAD`）は work ブランチに着地。本ビルド（run 実行中）後に **installed executor（override 無し）で 8/8 再確認**するのが B-2 の残り = **Codex 監視 or 人間タップの device タスク**。
- 実機 verify ハーネスは `/sdcard/shelly-plan-verify.js`（app-uid で実行、結果 `/sdcard/shelly-plan-verify/` に JSON）。期待 executor sha は修正版 `4abc69c9…`（LF）。

## 地雷（`2026-07-01-phase0-fs-exec-handoff.md` §3 全部＋今日の追加）
- **LD_PRELOAD**: `linker64 $libDir/node <script>` で起動する **leaf node には LD_PRELOAD=libexec_wrapper.so を渡さない**（node の OpenSSL config 読込が壊れる＝`BIO_new_file:Bad file descriptor`）。exec-wrapper が要るのは shell/codex exec 経路だけ。broker は純 node（workspace.exec も in-node 実装で外部 exec しない）。
- Node ビルトインフラグ衝突（`--env-file` 等は使わない）／SECRET は per-callsite 条件分岐（broker モードで生ヘッダを組まない）／`.env` は `set -a` 無し・非 export 維持／版数 lockstep（`AGENT_SCRIPT_VERSION` TS2箇所＋`AgentRuntime.CURRENT_SCRIPT_VERSION`＋テスト／`PLAN_SPEC_SCHEMA_VERSION` TS＋script＋asset＋`AgentRuntime.CURRENT_PLAN_SPEC_VERSION`）／asset parity（scripts↔assets byte 一致、parity test 有）／既定 OFF flag＋回帰ゲートで既存 `.sh` 経路を byte-preserve（§8.2 strangler・big-bang 禁止）／`bash -n` は temp-file 経由（Windows argv 制限、Linux は -c 可）／**Windows checkout は CRLF** なので sha 比較は `git show HEAD:<file> | sha256sum`（LF）で／秘密の値を絶対に出力しない。
- **adb 地雷（監視側）**: `adb push` の path 化けは無し（Codex は Linux/Mac 想定）／`run-as` は release で不可／app-private（`$HOME/.shelly/...`）は adb 直読不可 → 監視は `/sdcard` 出力・logcat・通知で。スクショ禁止（screencap/screenrecord/`--record`）。

---

## §CC. /goal — CC(Fable5) 実装（そのまま貼る）

```
/goal Shelly の Phase 0 床の残りを strangler で「行けるとこまで」実装する。実装は CC 単独、実機確定は別途 Codex 監視/人間が行うので、私の合格基準はオフラインゲート（pnpm check + jest + bash -n + /code-review）。行番号は目安、着手時に grep で現 HEAD を確認。

0. まず読む: docs/superpowers/specs/2026-07-02-phase0-finish-cc-fable-handoff.md（全体）、2026-07-01-phase0-fs-exec-handoff.md §0-§4、2026-07-01-l1-l2-capability-catalog.md §7/§8、DEFERRED.md「🧭」節。既存実装 lib/agent-plan-spec.ts / scripts/shelly-plan-executor.js（+asset）/ scripts/shelly-capability-broker.js / AgentRuntime.kt(runPlanAgent) / lib/agent-executor.ts(generateRunScript) / lib/agent-manager.ts(materialize) を精読。

1. 制約: 開発は claude/work-handoff-2qb1xd。ただし最終 push 前に自分で /code-review high を回し APPROVE 相当にしてから、まず cc/phase0-fs-exec（レビュー用）に push（人間/別CCの確認後に work へ ff）。PR は作らない。footer は既存ルール。モデル識別子をコード/コミット/成果物に書かない。秘密の値を絶対に出力しない。既定 OFF flag＋回帰ゲートで既存 .sh 経路を byte-preserve（§8.2、big-bang 禁止）。版数 lockstep と asset parity を厳守。地雷（handoff §3＋LD_PRELOAD）を守る。

2. ループ（各チャンク）: 読む → 設計に不確実性があれば必ず Plan サブエージェント（インターフェース/移行手順）、調査は Explore、独立作業は1メッセージ並列 → 実装（周囲の規約、新状態 Zustand、色 useTheme、i18n en/ja） → pnpm check + jest + bash -n(temp-file) を必須 PASS → /code-review high を diff 全体に回し指摘を修正 or 明示却下 → cc/phase0-fs-exec に push → DEFERRED 更新（device-verify 必要な項目は「実機待ち」と明記） → 次チャンク。

3. チャンク（順に、行けるとこまで。各チャンクは独立に offline-green で停止・報告できる粒度に割る）:
   C-1 Part B（native→executor 統合）の host テスト整備: AgentRuntime→executor の起動契約（linker64 $libDir/node + SHELLY_LIB_DIR + 版 gate + unattended/trusted 引数）を host で再現する jest を追加し、承認カード発火・完了通知要求(native-result-notification.json)・STOP-ALL(halt sentinel)中 RUN 拒否・.sh フォールバック不可 を offline で固める。実機発火自体は監視側。
   C-2 §B B-3 `.sh` parity 移植（最大の塊。1機能ずつ・flag/回帰ゲート付き・Plan サブエージェント設計必須）: (a) multi-step orchestration（runLadderAttempts 相当の各ステップを PlanSpec の steps として executor で実行、broker 経由） (b) web→Codex ladder（needsWeb routing の PlanSpec 化） (c) 出力テンプレ/Obsidian ミラー（FS-001 scoped.fs 経由・root 越境不可） (d) scheduled fire の per-fire 実行（native alarm→executor、決定論・無人=事前承認のみ）。各機能は「executor 経路と .sh 経路が同結果（parity）」を host テストで示す。
   C-3 `.sh` executor 退役ステージング: C-2 が全機能 parity green になって初めて、生成 .sh の materialize/版 gate を段階撤去する設計を Plan で起こす（この /goal では設計＋足場まで、一括退役はしない）。
   C-4+ Phase 0 実装が一通り済んだら Phase 1 に進む（この doc の §CC-P1 を読んで続ける）。ただし Phase 1 も全部 flag 既定 OFF＋オフライン緑＝「実装されるが有効化はされない」。未検証の床の上に能力を有効化しない。新 Manifest 権限はレポートで明示（要 rebuild）。

4. verify: 各チャンクは pnpm check + jest + bash -n が PASS。実機（app-uid RUN・redacted audit・completion 通知・.sh parity・STOP-ALL 拒否）は Codex 監視/人間が閉じるので、実機必要項目は DEFERRED に「実機待ち」で残す。offline 緑≠実機緑を忘れない（LD_PRELOAD の教訓）。

5. 停止条件: 「行けるとこまで」= チャンク単位で offline-green＋レビュー APPROVE＋cc/phase0-fs-exec push を積み上げる。各チャンク完了ごとに ①commit SHA ②offline で確認したこと ③実機待ち項目 ④次チャンク を報告し DEFERRED 更新。設計に迷ったら大改修せず Plan サブエージェント相談。夜間で判断不能な設計分岐に当たったら、その手前で停止して AskUserQuestion 相当のメモを残す（勝手に大きな方針転換をしない）。
```

---

## §MON. Codex（wireless adb）実機監視（そのまま貼る）

```
Shelly の Phase 0 実機監視を担当する。あなたは wireless adb で実機に接続済み。実装はしない（CC が別途行う）。目的は「CC が push→ビルドした成果を実機で確認/監視し、結果を報告する」。

前提/制約: release ビルドなので run-as 不可＝adb(shell uid) から app-uid で直接ハーネスを走らせられない。app-private（$HOME/.shelly/...）も adb 直読不可。だから観測は (a) am で実エージェント RUN を発火（native→executor 本番経路）(b) logcat (c) /sdcard 出力 (d) 通知 で行う。スクショ禁止（screencap/screenrecord/--record は使わない、テキストのみ）。秘密の値を出力しない。

手順:
1. ビルド取得/インストール: gh run list --branch claude/work-handoff-2qb1xd で最新 success を確認 → gh run download <id> -R RYOITABASHI/Shelly -n shelly-apk → APK 内 assets/shelly-plan-executor.js の sha256 が repo の `git show HEAD:scripts/shelly-plan-executor.js | sha256sum`（LF）と一致することを確認 → adb install -r。
2. B-2 installed 再確認: 人間が Shelly ターミナルで `node /sdcard/shelly-plan-verify.js`（override 無し）を実行できる時、adb で /sdcard/shelly-plan-verify/report.txt を pull し 8/8 と asset-sha=installed を確認。人間不在なら 3 の実RUN観測を主にする。
3. Part B（実RUN統合）観測: canary agent（$HOME/.shelly/agents/.env に SHELLY_PLAN_EXECUTOR=1 と SHELLY_PLAN_EXECUTOR_AGENT_ID=<id>、CAP flags）を、adb shell am（shell uid は am 可）で発火 or スケジュール発火を待つ。observe: `adb logcat -s AgentRuntime:D Shelly:D`（executor 経路で version/plan gate/起動、完了 or error）、通知（dumpsys notification | grep dev.shelly.terminal）、出力を /sdcard か Obsidian(/sdcard/Documents/ObsidianVault) に吐く agent なら adb で pull して内容確認。STOP-ALL 中に発火→拒否も確認。
4. 報告: 各確認について「adb で刺激/観測したこと」と「app-uid で実現できたか」を区別して記録（adb identity ≠ app-uid）。実機で壊れる項目（今日の LD_PRELOAD の様な device-only バグ）を見つけたら、logcat/エラーの生テキストを添えて CC に渡す。app-private 監査が必要なケースは、その旨（adb 直読不可、人間タップ or /sdcard 出力が要る）を明記。
```

---

## §CC-P1. Phase 1（反応＋永続＋脳）— Phase 0 実装完了後に続ける

**進行条件**: Phase 0 の C-1〜C-3 が offline-green＋review push 済み。**Phase 1 も全チャンク flag 既定 OFF＋オフライン緑**で「実装されるが有効化はされない」状態に留める（未検証の床の上で能力を有効化しない＝§8.1 の実質遵守）。デバイス確定は監視/人間が後で閉じる。各 primitive は着手前に **Plan サブエージェントで型/境界/移行を設計**。正典 `2026-07-01-l1-l2-capability-catalog.md` §3（EVENT-001/MEMORY-001/MODEL-001）§4（署名承認）§7 を読む。既存資産（.sh 世界の memory=G2 / router=G4 / scheduler）を L2 primitive に「整理し直す」リファクタが主で、新規発明は最小。

チャンク（順に、各々 offline-green で停止・報告できる粒度）:
- **P1-1 EVENT-001 event.queue**: schedule/inbound/poller/retry/lease を統一する durable queue（純粋コア＋jest。file or bundled-sqlite backed、lease/retry/dedup/at-least-once）。native alarm は「queue への trigger」専用に寄せる設計（配線は flag OFF）。
- **P1-2 MEMORY-001**: `get/put/query`（per-skill ns）を **FS-001 scoped.fs＋bundled sqlite FTS5** 上の薄い層として。埋め込みは llama-server `/embedding`（任意）。純粋ロジック＋契約テスト。sqlite バインディングの host テスト可否を Plan で確認（不可なら純粋層＋契約テストに留め、実バインドは flag gate）。既存 G2 memory を移行。
- **P1-3 MODEL-001**: 多モデル推論を **eligibility-first＋routing-floor** の純粋モジュールに（既存 `agent-router-scoring` / `agent-credential-policy` / secret-guard を統合）。**秘密データ含む run は cloud 不可**を構造で。オフライン決定論テスト。
- **P1-4 署名付き action approval**: action approval を Codex escalation と同等の署名（既存 escalation pin/verifier-key 資産を再利用）に格上げ。純粋な署名/検証ロジック＋テスト。
- **P1-L1（要 rebuild・レポートで明示）**: Manifest に `RECEIVE_BOOT_COMPLETED`＋`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` を追加（背景生存スパイン）。**追加してよいが、L1 grant＝要 APK 再ビルド＋実機付与導線なので、コミットで明示しレポート先頭に「新 Manifest 権限追加」と書く**。受信 receiver の実装は flag/no-op ガード付きで。

各チャンク: Plan 設計 → 実装 → pnpm check + jest + bash -n PASS → /code-review high → cc/phase0-fs-exec に push → DEFERRED「🧭」更新（実機待ち明記）→ 次。設計分岐で判断不能なら手前で停止しメモ（勝手な大方針転換をしない）。

## メモ
- Phase 2〜5 の /goal はまだ未作成（正典 §7 に設計あり）。Phase 1 が一段落したら同形式で起こす。順序（§8.1「床が先」）は「未検証の床の上で能力を*有効化*しない」で担保（実装は flag OFF で先行可）。
- device-only バグの前例: LD_PRELOAD が bionic node の OpenSSL を壊す（fix `694dee87`）。offline 緑だけで実機を主張しない。
