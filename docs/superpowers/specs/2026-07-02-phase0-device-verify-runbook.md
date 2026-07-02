# Phase 0 PlanSpec executor — 実機 device-verify runbook（Codex / wireless adb 用）

- **Date**: 2026-07-02
- **対象 build**: branch `claude/work-handoff-2qb1xd` = `cc/phase0-fs-exec` tip `99cae9e76`（またはそれ以降）。
- **前提**: release ビルド＝`run-as` 不可。app-uid 監査（`$HOME/.shelly/...`）は adb 直読不可 → 観測は (a) `am` 実 RUN 発火 (b) `logcat` (c) `/sdcard` 出力 (d) 通知。スクショ禁止（`screencap`/`screenrecord`/`--record`）。秘密の値を出力しない。adb identity ≠ app-uid を区別記録。

このファイルは CC(Fable5) が offline-green にしたチャンク（C-1 / C-2 inc1–4 / b-1）を **app-uid 実 RUN で検証**するための copy-paste runbook。offline 緑 ≠ 実機緑（LD_PRELOAD の前例）。

---

## 0. ビルド取得・整合（必須・毎回）

```sh
gh run list --branch claude/work-handoff-2qb1xd -L 5
gh run download <run-id> -R RYOITABASHI/Shelly -n shelly-apk
# APK 内 asset sha が repo HEAD(LF) と一致すること:
unzip -p shelly-*.apk assets/shelly-plan-executor.js    | sha256sum   # 期待 96b47eed5a484b305198b7c4d507c49b61f51ce90477dc4f5f79c976629e9602
unzip -p shelly-*.apk assets/shelly-capability-broker.js | sha256sum   # 期待 d1d48d0034ec9544b077810b6f8fdf38c0c5ab2023588a2f6a77620df93562c5
adb install -r shelly-*.apk
```
※ 期待 sha は build 時の HEAD で変わる。基準は常に `git show HEAD:scripts/shelly-plan-executor.js | sha256sum`（LF）。**executor を変更したチャンクでは sha が変わる**ので毎回取り直す。

canary 設定（対象 agent 1 体、app-uid で `$HOME/.shelly/agents/.env` に追記）:
```
SHELLY_PLAN_EXECUTOR=1
SHELLY_PLAN_EXECUTOR_AGENT_ID=<agentId>
SHELLY_CAP_BROKER=1
SHELLY_CAP_FS=1
SHELLY_CAP_EXEC=1
```

**⚠️ schema v1→2**: 既存 on-disk `plan-agent-*.json` は全て stale。テスト前に **Shelly を開く / 対象 agent を一度手動 RUN** して再生成（`CURRENT_PLAN_SPEC_VERSION=2`）。

観測の基本:
```sh
adb logcat -c && adb logcat -s AgentRuntime:D Shelly:D    # 別ターミナルで流しっぱなし
# 実 RUN 発火（shell uid から FGS へ）:
adb shell am start-foreground-service \
  -n dev.shelly.terminal/expo.modules.terminalemulator.TerminalSessionService \
  -a expo.modules.terminalemulator.RUN_AGENT --es agent_id <agentId>
# ↑ 効かない場合は app UI で agent を tap RUN（＝人間タップ、app-uid 経路）。
```

---

## 1. per-chunk 検証

### stale-gate（schema v2 移行の回帰防止）
- 手順: v1 plan のまま（再生成前に）実 RUN 発火。
- 期待: `logcat AgentRuntime` に `stale PlanSpec: ... version=1 expected=2`、RUN は拒否（exit 126）、draft 生成なし。
- → その後 app で再生成して以降のテストへ。

### C-1a STOP-ALL kill-switch（`.halted` 中 RUN 拒否）
- 手順: app で **STOP ALL**（`.halted` sentinel 生成）→ 実 RUN 発火。
- 期待: `logcat` に `Agent <id> refused: All agents are stopped (global kill-switch is on).`、モデル IO ゼロ（draft/通知なし）。
- 裏取り: `/sdcard` に出す agent なら出力ファイル未生成。RESUME 後は通常 RUN が通ること。

### C-1b 起動契約（executor 経路・完了通知）
- 手順: 通常（`.halted` 無）に実 RUN 発火。
- 期待: `logcat` に `starting via PlanSpec executor plan=... version=2 unattended=... trustedAction=... trustedTool=...` → `completed via PlanSpec executor`。完了通知が出る（`adb shell dumpsys notification | grep dev.shelly.terminal`）。`.sh` フォールバックのログが出ないこと。

### C-2 inc1/2 Obsidian mirror（content-studio agent）
- 前提: content-studio agent（`useGlobalOutput=false`、`outputDir` が `.../drafts/x` 等）、`.env` に `OBSIDIAN_VAULT_PATH=/sdcard/Documents/ObsidianVault`（存在させる）。
- 期待: primary（`outputDir/<date>_<slug>.md`）と mirror（`/sdcard/Documents/ObsidianVault/50_Drafts/X/<rel>`）の**両方生成**、内容一致。root 越境ゼロ。
- 裏取り: `adb pull` で両ファイル取得し内容一致確認。vault 不在時は mirror スキップ・RUN は success（別 agent で確認可）。

### C-2 inc4 source-registry
- 手順: URL を含む結果を出す content-studio draft を RUN。
- 期待: `<contentProject>/sources/source-registry.tsv` に `ts\tagentId\ttoolLabel\turl` 追記、URL 列 dedup、再 RUN で重複追加なし。fresh project（`sources/` 事前不在）でも自動生成。
- 裏取り: `adb pull` で TSV 確認、鍵値/`Bearer` grep 0 件。

### C-2 b-1 needsWeb no-URL guard
- 手順: needsWeb（research-collection）agent が **URL を含まない結果**を出すケースを RUN。
- 期待: draft 生成なし（sourceless essay を vault/output に書かない）、run-log status=`error`（→ foreground ladder が escalate）。Codex 段は現状 unsupported なので最終 error で停止しても正。
- 裏取り: `$HOME/.shelly/agents/logs/<id>/` を `/sdcard` にコピーして `plan-executor-audit.jsonl`（`status:"error"`, reason に `no primary-source links`）を確認。needsWeb で URL を含む結果は通常 draft されること（対照）。

---

## 2. 監査裏取り（毎回）
app-private を `/sdcard` にコピーして pull:
```sh
adb shell run-as ... 不可（release）→ harness/agent 側で /sdcard にコピーするか、app UI 経由で export。
```
確認: `plan-executor-audit.jsonl` / `agent-driver-audit.jsonl` の decision/status が期待通り、**鍵値・`Bearer`・`sk-`/`AIza`/`gsk_`/`csk-`/`gh[pousr]_` が grep 0 件**、`redact` 済み。「adb で刺激した」と「app-uid で実現した」を区別記録。

## 3. device-only バグ報告
LD_PRELOAD の類（bionic node の OpenSSL 等）が出たら、`logcat` の**生テキスト**を添えて CC に返す → 最優先で修正。offline 緑だけで実機を主張しない。

## 4. b-2（`codex.exec`＝Codex spawn）は未実装・保留
CC の security 判断待ち（spawn codex の broker 外 OpenAI egress／unattended codex 可否）。b-2 の device-verify 項目はここには**まだ無い**。b-1 までの ladder は「no-URL→fail-closed→escalate→Codex 段 unsupported で最終 error」まで。
