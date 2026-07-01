# Shelly L1/L2 Capability Catalog — Android 版 Hermes への確定ロードマップ

- **Status**: 🟢 確定カタログ（6ソース統合）。着手前の設計の単一の真実。
- **Date**: 2026-07-01
- **Branch**: `claude/work-handoff-2qb1xd`（HEAD `580f5fa0`, main 未マージ）
- **North Star**: Nous "Hermes Agent" / "OpenClaw" を **on-device Android・単一 uid・privacy-first** で近似する自律エージェント基盤。
- **由来**: 内部エージェント3体（L1面 / L2汎用プリミティブ / Hermes-OpenClaw逆算）＋ 外部レビュー3体（GPT / Claude / Codex）の統合。Codex のみ `origin/claude/work-handoff-2qb1xd @ 580f5fa0` を実読して現状を照合済み。

---

## §0. 能力モデル（L1 / L2 / L3）と壁の位置

| 層 | 定義 | 誰が作るか | 壁の理由 |
|---|---|---|---|
| **L1** | OS 権限・OS イベントサービス | 開発者（ビルド時） | Manifest 宣言＋**再インストール**必須。実行時にも on-device ビルドでも生えない |
| **L2** | native ツールバイナリ／broker（APK 同梱） | 開発者（ビルド時） | Knox SELinux が `libDir` 展開バイナリしか exec 許可しない。`app_data_file` は exec 不可 |
| **L3** | スキル＝PlanSpec が L1/L2 を合成 | **ユーザー（アプリ内・fork 不要）** | 既存の道具/LLM/記憶の組み合わせのみ。新ネイティブも exec バイナリも不要 |

**核心の帰結**: ユーザーの L3 自由度 ＝ 開発者が焼いた L1/L2 の **汎用性の関数**。narrow tool（`x.post`/`slack.post`…）を数で稼ぐより、**少数の深い汎用 primitive（`http.request(allowlist)` 等）を Capability Broker 経由で出す**方が、組み合わせで L3 空間が指数的に開く。開発者の TODO はこのカタログで**有限に固定される**。

---

## §1. 現状（Codex が HEAD を実読して確認）

| 領域 | 現状 |
|---|---|
| **既存 L1（Manifest 宣言済み）** | `MANAGE_EXTERNAL_STORAGE`, `SCHEDULE_EXACT_ALARM`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `REQUEST_INSTALL_PACKAGES`, `WAKE_LOCK`, `INTERNET` |
| **Scheduler** | ✅ 完成。Broadcast trampoline でなく FGS `PendingIntent` 直起動。Samsung/Android 14+ 対策済み（`AgentAlarmScheduler.kt`） |
| **Runtime** | ⚠️ 実行本体はまだ `$HOME/.shelly/agents/run-agent-*.sh` を bundled bash で source（`AgentRuntime.kt` / `agent-executor.ts` の巨大生成 shell）。**ここが P0 の穴** |
| **既存の安全部品** | approval bridge（file-queue → native notifier → `wait_action_approval`, sha256-pin）、boundary policy（`network-send`/`secret-read`/`leaves-root` signals）、secret-guard（秘密混入時 on-device 強制）、autonomous credential policy（API キーを無人経路の env から排除）。＝**secret-by-reference と taint の“芽”は既にある** |
| **不足** | secret-by-reference の一級化 / typed capability broker（envelope）/ 署名付き action approval / PlanSpec 型 skill manifest / MCP-to-native broker |

**含意**: L2 Core の大半は**新規ネイティブでなく、既存 broker を宣言付き primitive に整理し直すリファクタ**。P0 は「Alarm 配線」ではなく「`.sh` 実行本体 → broker/PlanSpec executor への置換」。

---

## §2. L1 カタログ（焼くべき OS 能力）

`E=EVENT / Q=QUERY / A=ACTION`。危険度は lethal-trifecta 視点。工数は native＋broker の人日。★＝優先。「済」＝Manifest 宣言済み。

| L1 能力 | Android 機構 | 型 | 解禁する世界 | 危険 | 工数 |
|---|---|---|---|---|---|
| ★ **背景生存スパイン** | `FGS_SPECIAL_USE`(済)＋`RECEIVE_BOOT_COMPLETED`＋`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`＋`SCHEDULE_EXACT_ALARM`(済) | E | 全 autonomy の土台。Doze / One UI「Sleeping apps」/ 再起動を生き延びる | 低 | 〜3（大半済） |
| ★ Intent / deep-link / share / widget | file-queue → RN `startActivity`（`am start` は Knox 拒否）＋ ShortcutManager | A/Q | アプリ起動・共有・1タップ実行（Scouter） | 中 | 〜3 |
| Contacts＋Calendar（→CONTENT-001） | `READ/WRITE_CONTACTS`,`READ/WRITE_CALENDAR`,`ContentObserver` | E/Q/A | 宛先解決・予定認識・招待反応。通常権限＝摩擦ゼロ | 中(PII) | 〜4 |
| System-state イベントバス | battery/screen/network/thermal broadcasts,`UsageStatsManager` | E/Q | 「充電＋idle＋wifi→重いローカルLLM」等の発火条件 | 低 | 〜2 |
| Mic（音声窓口） | `RECORD_AUDIO`(済)＋mic FGS | Q/E | 音声入力・wake-word。モバイルでは server より高価値 | 高 | 〜3 |
| Location＋geofence＋activity | Fused/Geofencing/ActivityTransition,`ACTIVITY_RECOGNITION` | E/Q | 「帰宅→通勤スキル」等の文脈トリガ | 中 | 〜4 |
| **Notification Listener＋返信** | `NotificationListenerService`(Special Access)＋`RemoteInput` | E/Q/A | **クロスアプリ横断の受信バス**：WhatsApp/Slack/銀行/2FA を per-app 統合なしで読取＋quick-reply。a11y と違い Android 17 APM で死なない | **CRITICAL**（全通知＝完璧な exfil 源・untrusted firehose） | 4〜8 |
| File-change イベント | FileObserver / native inotify（`MANAGE_EXTERNAL_STORAGE` 済） | E | 「新規スクショ→OCR」等。既存権限をイベント源化 | 低 | 〜2 |
| Overlay | `SYSTEM_ALERT_WINDOW`(済) | A | 操作フィードバック HUD（computer-use 対） | 中(tapjacking) | 〜2 |
| MediaProjection | `MediaProjectionManager`＋media FGS | Q | 画面 OCR / computer-use の「眼」。a11y と別系統で APM に強い | **CRITICAL**（画面全内容） | 5〜10 |
| **Accessibility** | `AccessibilityService`＋`BIND_ACCESSIBILITY_SERVICE` | E/Q/A | 他アプリ UI 読取＋クリック/入力＝真の computer-use（OpenClaw 級） | **CRITICAL**（untrusted-input 源と ACTION 経路が同居＝trifecta 最悪） | 8〜15 |
| **VpnService（＝防御）** | `VpnService`＋TUN＋consent | E/Q/A | **アプリ uid 全体の egress を allowlist 化＝exfil 脚を折る**。機能でなく安全装置として作る。tun2socks 相当を同梱 | 諸刃 | 12〜25 |
| Clipboard | `ClipboardManager` | Q/A/E | copy/paste bridge。**背景読取は a11y 保持時のみ開く** | 高(秘密混入) | 〜3 |
| SAF / FileProvider | `ACTION_OPEN_DOCUMENT_TREE`＋persistable grant | Q/A | 明示フォルダ grant（all-files の防御的代替） | 中 | 〜3 |
| （後回し）SMS / Telephony | `RECEIVE_SMS`/`READ_SMS`/`SEND_SMS`/`ROLE_SMS`,`CallScreeningService` | E/Q/A | OTP 反応・着信 screening・SMS 送受信 | **CRITICAL**（2FA＝trifecta 両端） | 5〜12 |
| （非推奨）Device Admin | `DeviceAdminReceiver` | A | lock/wipe。エージェント価値低・大半 Device Owner walled | 高 | — |

---

## §3. L2 カタログ（汎用プリミティブ）

### 設計原則
1. **narrow tool を数で増やさない**。深い汎用 primitive に集約。
2. **秘密は参照（ref）、値は渡さない**。skill は `auth_ref` を渡すだけ、broker 内でのみ実トークンを解決・注入。
3. **egress は capability で allowlist、broker で強制**。どの skill も `*` を得ない。
4. **trifecta は prompt でなく構造で切る**（taint tracking）。
5. **全 primitive は broker 呼び出し**。モデルのテキストがコマンドになるのは curated な `EXEC-001` のみ。

### Core 8（leverage/工数で確定順・P8→P1→P2 は不可逆）

| # | Primitive | 役割 | 工数 |
|---:|---|---|---|
| 1 | **`CAP-001 capability.envelope`** | 全 tool call の grant / consent / budget / audit / 署名 / taint の土台（GPT audit＋Claude grant＋Codex 署名承認を1本化） | 5〜7 |
| 2 | **`SECRET-001 secret.invoke`** | secret-by-reference の実装体。raw env secret を廃止。skill は生値を読めない | 6〜9 |
| 3 | **`HTTP-001 http.request`** | allowlist＋`auth_ref` 付き万能ネット。Slack/Telegram/Notion/GitHub/webhook/RSS/search を vendor 個別実装なしで被覆 | 5〜7 |
| 4 | **`MODEL-001 model.run`** | 多モデル推論（local/Codex/cloud）を eligibility-first＋routing-floor で。秘密データは cloud 不可 | 7〜10 |
| 5 | **`FS-001 scoped.fs`** | skill root 配下に再スコープした read/write/list/search。memory/draft/RAG/artifact の基盤。**workspace 越境バグの構造修正をここで強制** | 4〜6 |
| 6 | **`EVENT-001 event.queue`** | schedule/inbound/poller/retry/lease を統一する durable queue。native alarm は trigger 専用に寄せる | 6〜8 |
| 7 | **`NOTIFY-001 notify`** | NotificationListener 1本で Telegram/WhatsApp/Slack/メールの読取＋`RemoteInput` 返信。Hermes 窓口の 6 割を a11y の 1/3 工数・危険で取る安価ルート | 4〜6 |
| 8 | **`UI-001 ui.observe/act`（a11y）** | computer-use。P7/P1 で届かない任意アプリ操作。**最危険＝最後** | 8〜15 |

### 拡張 primitive

| ID | 役割 | 秘密 | 危険/実装 |
|---|---|---|---|
| `EXEC-001 workspace.exec` | cwd jail＋template＋timeout の **curated exec**（raw shell を L3 に出さない）。開発/ビルド/検証を安全に解禁 | env secret 禁止 | CRITICAL / TS driver＋native kill |
| `MEMORY-001 memory` | 永続記憶（`get/put/query`, per-skill ns）。**FS-001＋bundled sqlite FTS5 上の薄い層**。Hermes 最重要機能。埋め込みは llama-server `/embedding` | — | LOW / TS |
| `CONTENT-001 content` | Contacts/Calendar/MediaStore を1つの ContentResolver primitive に | PII は cloud 原則不可 | HIGH / native |
| `BROWSER-001 browser.session` | まず WebView 内に閉じた open/read/click/type/screenshot。compact element refs（OpenClaw 流・2B ローカル LLM のトークン節約） | password fill は `secret.invoke` | HIGH-CRITICAL / RN WebView |
| `VOICE-001 voice` | TTS＋STT（既存 `use-speech-input` / Groq Whisper 資産） | — | MED / native |
| `INTENT-001 intent.open` | app 起動・deep-link・share（file-queue → RN `startActivity`） | secret extras は承認 | 中 / native |
| `MCP-001 mcp.call` | MCP は境界でなく broker 配下の **adapter**。Shelly が自前の Tool Contract を強制 | 直渡し禁止 | HIGH / TS adapter |
| `SKILL-001 skill.manage` | agentskills.io / `SKILL.md` をまるごと採用（Hermes＋OpenClaw のスキル資産をタダで継承）。3-tier progressive disclosure（tiny context 向き）。**import は quarantine＋owner 承認** | — | 中 / TS |
| `EGRESS-001 egress.policy` | VpnService 補助線。主防御にしない。policy DB は L3 書込不可 | — | HIGH / VpnService |

---

## §4. 安全の背骨（単一 uid を塞ぐ設計）

1. **`capability.envelope`（CAP-001）**: 全 tool call が通る唯一の関門。grant（短命）/ consent / budget・timeout・loop-limit / redacted audit / 署名 / taint を一元化。
2. **taint tracking**: untrusted 源（`notify`/`ui.observe`/`browser.read`/非 allowlist HTTP レスポンス）由来の値に色を付ける。**「allowlist＝どこへ送れるか」「taint＝何を送れるか」の両輪**。
3. **唯一の構造ルール**: *tainted な run は「秘密使用 or 非 allowlist ホストへの送信」を human 承認なしに実行できない*。→ `untrusted-input → reasoning → http.request` の exfil を構造的に遮断。
4. **secret-by-reference**: 秘密は broker 内で使う時のみ安全。skill には opaque handle のみ。生シェルには秘密 env を渡さない（/proc で同 uid の別 skill に漏れるため）。
5. **承認の堅牢化**: in-process の悪性 skill も署名経路を呼べる（単一 uid の限界）。→ 高リスク action は**生体（BiometricPrompt / user-presence）束縛**で縛る。ソフト署名だけに依存しない。
6. **DM-pairing**（OpenClaw 拝借）: 未知の inbound 送信者に承認コード。隔離できない単一 uid の主要な補償コントロール。
7. **無人＝決定論**: 無人（スケジュール/イベント）実行は**事前承認済みの決定論的 PlanSpec のみ**。承認ゲートは無人時 fail-closed。

---

## §5. Trifecta 集中点と無害化

**危険の中心**: `EXEC-001` / `HTTP-001` / `SECRET-001` / `FS-001` / `BROWSER-001` / `UI-001(a11y)` / `NOTIFY-001` / `MANAGE_EXTERNAL_STORAGE`。

**禁止すべき組み合わせ**: `秘密 ＋ 外部送信 ＋ 信用できない入力` と `信用できない入力 ＋ 生シェル`。
※ `draft`/`notify` も registry / schedule / config / code / webhook payload に触れるなら**低リスクではない**。

**共通の無害化**: broker-only / raw secret 禁止 / egress allowlist / method・path・schema 制限 / taint tracking / redacted audit / short-lived grant / 生体 human confirmation。

---

## §6. 単一 uid Android で**安全に実現不能**な L3（構造的な壁・6ソース一致）

| L3 | 理由 | 代替 |
|---|---|---|
| 任意 skill が shell/curl/secret を自由利用 | 同一 uid は子プロセスを firewall/隔離できない | brokered PlanSpec / curated `EXEC-001` |
| skill ごとの OS-level egress firewall | app 子プロセスを OS レベルで個別遮断不可 | VpnService でアプリ全体を allowlist（per-skill 帰属は best-effort） |
| skill 間隔離前提の**共有スキルマーケット** | /proc・ファイル・Keystore 共有 | ユーザー自作・信頼前提。import は quarantine |
| 改竄不能な承認/署名 | in-process コードが Keystore 鍵を使用可能 | 生体 user-presence 束縛 |
| Accessibility による任意アプリ完全自動操作 | 画面内 secret/OTP/決済が混ざる | app/flow allowlist＋local-only＋手動確認 |
| 自動生成 skill の即登録/即再実行 | persistence＋privilege creep | quarantine＋owner 承認 |
| 全ファイル RAG＋任意 web 投稿 | private files と egress が直結 | scoped corpus＋destination-bound publish |
| WhatsApp / Signal / iMessage 窓口 | 外部プラットフォームの ToS/BAN/Mac 必須（2026） | Telegram/Discord(text)/Slack(Socket)/Email に限定 |
| RL / 大規模 trajectory 学習 | GPU/クラスタ必須（ハードの壁） | trajectory ログ採取のみ→端末外 export |
| Doze/One UI 下の OS 保証つき無人自律 | OEM kill を保証で覆えない | 無人＝決定論 PlanSpec のみ |

---

## §7. Ordered Roadmap（依存順・工数）

```
Phase 0 — 床/substrate（〜14pd）※L1 追加なし・既存権限で足りる
  0-1  FGS→生成.sh 実行本体を廃止 → TS PlanSpec executor / broker-first に置換（P0 の穴）
  0-2  CAP-001 capability.envelope（grant/consent/budget/loop/audit/taint 骨格/署名）
  0-3  SECRET-001 secret.invoke（.env raw secret 注入を縮小）
  0-4  HTTP-001 http.request＋egress allowlist
  0-5  FS-001 scoped.fs（workspace 越境バグの構造修正）
  0-6  EXEC-001 を command template / cwd jail / timeout / secret-env 禁止に制限
  ← ここが済むまで planner / skill 自動登録に進まない

Phase 1 — 反応＋永続＋脳（〜10pd）
  L1: RECEIVE_BOOT_COMPLETED ＋ REQUEST_IGNORE_BATTERY_OPTIMIZATIONS（Manifest→再インストール）
  EVENT-001 event.queue（durable, lease, retry）→ MEMORY-001（FS-001＋sqlite FTS5 上）
  → MODEL-001 に eligibility-first＋routing-floor 実装
  → action approval を Codex escalation と同等の署名付きに

Phase 2 — マルチ窓口・安価ルート（〜10pd）
  L1: NotificationListenerService（Special Access＋Restricted-Settings 導線）
  NOTIFY-001（read＋RemoteInput 返信）＋ notify 入力の taint tagging
  ＋ DM-pairing ＋ Samsung deep-sleep 対策
  ＋ SKILL-001（agentskills.io 採用・quarantine 付き）

Phase 3 — 音声＋起動＋公式窓口（〜7pd）
  L1: mic FGS（RECORD_AUDIO は宣言済）
  VOICE-001（既存 STT/TTS＋Groq Whisper 資産）→ INTENT-001 app.launch
  ＋ Telegram 公式 bot（HTTP-001 経由・sanctioned）／Discord(text)/Slack(Socket)/Email

Phase 4 — computer-use・高危険・最後（〜16pd）
  L1: AccessibilityService（Settings 付与）。SYSTEM_ALERT_WINDOW は宣言済
  UI-001 ui.observe/act ＋ target allowlist ＋【never-auto-approve】＋ 生体束縛ゲート ＋ ui 入力 taint
  段階導入: observe-only → suggest → 承認付き act → 限定自律
  ＋ MediaProjection（眼）＋ BROWSER-001（compact refs）＋ CONTENT-001 ＋ MCP-001

Phase 5 — egress 封じ込め・防御の本丸（stretch・〜15pd+）
  L1: VpnService。tun2socks 同梱でアプリ egress 許可制（per-skill は best-effort）
  ← これで初めて生シェル系スキルの安全性が上がる

後回し（要求駆動のみ）: SMS/Telephony（2FA＝高危険）, 背景位置, Camera, DeviceAdmin(非推奨)
```

**Phase 0+1（約 4〜5 週）で「TS 実行統一＋秘密ブローカー＋API＋記憶＋反応＋監査/予算/署名承認」＝安全な床＋Hermes 核**。Phase 2 で窓口、Phase 4 で computer-use。

---

## §8. 確定した設計判断（不変条件）

1. **床が先、planner/capability 拡張は後**（6ソース一致）。
2. **P0 ＝ `.sh` 実行本体の broker/PlanSpec 化**（Alarm 配線は完成済み）。
3. **記憶は残す**が FS-001＋sqlite 上の薄い primitive として（North Star＝Hermes と GPT/Codex の「新ネイティブ不要」を両立）。
4. **Accessibility は最後**。taint と never-auto-approve が熟すまで積まない（早期投入＝trifecta 最悪化）。
5. **NOTIFY-001 が最大の梃子、UI-001 が最大の落とし穴**。
6. **VpnService は安全装置**であって機能ではない。アプリ全体 egress は縛れる／per-skill 帰属は best-effort。
7. **危険度は「ネット/シェルに触るか」でなく「秘密・ファイル書込・ネット送信・シェル・webhook・永続化のどれに触るか」で分類**。draft/notify も無条件安全ではない。
8. **共有スキルマーケットは単一 uid では安全に成立しない**。ユーザー自作・信頼前提で設計、import は quarantine。
9. **無人＝決定論 PlanSpec のみ**、承認ゲートは無人時 fail-closed。
10. **達成できる窓口 ＝ Telegram / Discord(text) / Slack(Socket) / Email**。WhatsApp/Signal/iMessage は descope（Experimental/Deferred）。

---

## §9. 次アクション

1. **Phase 0 に着手**（`.sh` → broker executor ＋ CAP-001 ＋ SECRET-001）。着手前に HEAD の `agent-executor.ts` / `AgentRuntime.kt` の実行本体を精読して残タスクに絞る。
2. `DEFERRED.md` に本カタログの Phase 別を P0〜P3 として登録（WhatsApp/Signal/iMessage/RL 学習を明示 descope）。
3. README Status 表と同期（達成窓口・構造的な壁を明記）。
4. 各 Phase は「実装→プッシュ前エージェントレビュー必須→ビルド→実機テスト」で回す。
