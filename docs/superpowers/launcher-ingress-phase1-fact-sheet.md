# Piece A Phase 1 事実シート（移管スナップショット、2026-11-26）

## 実装ステータス（移管時点）
C1〜C9 すべて実装・コミット済み（HEAD `06612c9`）。席側の Codex ゲートは4巡目で OK、フルスイートは main でも失敗する既存4スイート41件を除き通過（詳細は返却 `phase1-return.md` 相当の内容を移管先が確認すること）。

## Phase 1 の範囲（2026-11-26、メイン決定・Issue #4 コメント 7181235301、選択肢 A）
正式ゲート 1 巡目の blocking 2 件は、どちらも Phase 2 の範囲とする（DEFERRED.md「ランチャー ingress」残件 1・2）:
- 承認待ちの投入の非同期承認（既存の承認 UI／通知で決める＝C6・§7 D8）。Phase 1 では `pending_approval` のまま 10 分で `expired`。承認・拒否の監査イベントもこれに伴い Phase 2。
- 投入レコードの run レコード読み取り面（`get_run_result` 等）からの読み出し（§7 D2）。Phase 1 では `McpRunTickets.readSubmissionJson()` は読み出し面に未配線。
Phase 1 の受け入れは「受理＋監査＋承認状態つきの記録＋同期で決まる `approved`（免除オン＋常に許可）」まで（§5 参照）。

## 残作業と受け入れ条件（移管先）
1. 正式ゲート（Codex＋最終レビュー）。
2. ブランチ CI（dispatch は `inputs.signing = "legacy-debug"` 必須）。**このブランチの Kotlin は一度もコンパイルされていない** — CI の APK ビルドが初回コンパイルになる。
3. PR → マージ → 本番ビルド。
4. 実機確認（下記 §7 の7項目すべて）。

---

# Piece A（ランチャー ingress）事実シート — Shelly 側の受け入れ条件

作成：2026-11-25、VM CC（準備作業。コードなし）
正本の入力：`~/workspace/goals/home-screen-task-progress-widget/files/cc9-implementation-brief.md`（F1–F11、D1–D4、A1–A4、契約の補足）、同 `cc9-design-v1.md`、同 `batch23-supply-side-spec.md`、同 `batch23-stream-pane-design-input.md`、`queue-note.md`。
コード実測の基準：Shelly worktree `~/workspace/experiments/shelly-docs-deferred`（detached `9af8e9d`。最終 fetch の `origin/main` = `dcd9344` の1つ前。差分は未確認 → 実装席は `origin/main` 最新から切ること）。
**注意**：主クローン `~/workspace/research/Shelly` の作業ツリーは `feat/mcp-typed-diagnostics`（2026-11-15 に main から分岐）で約10日古く、IngressAuditWriter・typed op・always-allow が存在しない。ランドマークの実測に使ってはならない。

使い方：以後のゲートはこのシートを物差しにする（今回の diff とシート適合のみを見る）。シートが誤りと判明したら、シートを直してから該当項目だけ再ゲートする。各項目の「実測」はコード上の現状、「受け入れ」は A が満たすべき条件。

---

## 1. 契約定数（固定）

| 項目 | 値 | 備考 |
|---|---|---|
| authority | `dev.shelly.terminal.ingress` | 本番 applicationId に紐づく。マニフェストでは `${applicationId}.ingress` と書き、本番で契約値に解決させる（将来 `.dev` 変種が出来ても authority が衝突しない＝インストール失敗 `CONFLICTING_PROVIDER` を防ぐ。dev ビルドは契約対象外：補足1）。実測：現行は単一 applicationId `dev.shelly.terminal`（`app.config.ts:4,40`）、`.dev` 変種なし |
| exported | `true` | 認可は Android パーミッションに依存しない（設計 §2.2）。カスタムパーミッションの多層追加は実装裁量（設計 §9-5） |
| method | `submit_instruction` | ContentProvider.call() の method 文字列 |
| 戻り値 | 常に Bundle。例外を呼び出し元へ伝播させない | 設計 §2.1 |
| target | `hayato`（現行唯一の有効値） | フィールドとしては保持（F4） |

### 1.1 リクエスト Bundle（`call(method, arg, extras)` の extras）

| キー | 型 | 必須 | 上限 | 扱い |
|---|---|---|---|---|
| `instruction_text` | String | 必須 | **4,000 文字**（Unicode コードポイントで数える。UTF-16 の `String.length` ではない — 下記 §8 R3） | 超過は切り詰めず `denied` / `PAYLOAD_TOO_LARGE`。空・非文字列は `denied` / `INVALID_PAYLOAD`（区分名は §1.3） |
| `correlation_ref` | String | 任意 | 数百文字オーダー（実装で確定：推奨 256 コードポイント。D3） | 不透明。解釈せず監査行と run レコードへエコー（A2） |
| `submission_nonce` | String | 任意 | 短い固定長（推奨 `^[A-Za-z0-9_-]{8,64}$`。D3） | 重複排除専用。**認可・優先度判定に使わない**。バッチ20 は送信試行ごとに常時付与、同一試行のリトライは同値（補足2） |

- 上記以外のキーは無視する（provenance・承認状態・優先度の自己申告を含め、何も信頼しない。F2/F6、A3）。
- ペイロード内のファイルパス・コマンド・URL は実行対象として解釈しない（F6）。
- `arg`（call の第2引数）は使わない（null 以外は無視）。

### 1.2 レスポンス Bundle（同期応答＝受付可否まで：F5）

| キー | 値 |
|---|---|
| `status` | `accepted` / `denied` |
| `reason` | `denied` のときの理由区分（§1.3）。`accepted` では無し |
| `approval` | `accepted` のとき `approved`（即時許可：常時許可または全体承認省略スイッチ）または `pending`（承認待ち）。A1 |
| `submission_id` | `accepted` のとき Shelly 発行の識別子（1投入に1つ）。監査行と run レコードの join key（F7） |
| `audit_event` | 記録した監査イベント名（受理・拒否どちらも） |
| `correlation_ref` | 渡された場合はそのままエコー（A2） |
| `duplicate` | 同一 `submission_nonce` の再送で既存の投入を返した場合 `true`（任意） |

- 承認待ちは `denied` ではなく `accepted` + `approval=pending`（F5）。
- `VERIFY_FAILED` は詳細を返さない（どの検査で落ちたかを応答に出さない。F3）。

### 1.3 理由区分（reason 列挙、固定英語）

| reason | 検出箇所 | ランチャー表示（F8） |
|---|---|---|
| `VERIFY_FAILED` | 呼び出し元検証（パッケージ不一致・署名不一致・UID 解決不能・複数パッケージ共有 UID） | 一般的な失敗表示 |
| `PAYLOAD_TOO_LARGE` | ペイロード検証（instruction_text / correlation_ref / nonce の上限超過） | 文字数超過を表示 |
| `INVALID_PAYLOAD` | ペイロード検証（必須欠落・型違い・制御文字等） | 人間可読化可 |
| `STOP_ALL_ACTIVE` | STOP-ALL（`.halted`、判定不能時も停止扱い） | 「一時停止中」 |
| `GATE_DENIED` | 既存ゲートの deny（D1 下の taint 拒否を含む場合はその旨の細区分は監査側のみ） | 理由区分の人間可読化可 |
| `DISABLED` | 設定でこの ingress が無効 | 人間可読化可 |
| `BUSY` | 保留中の投入が上限超過（推奨：未決の承認待ち 8 件まで。既存 `MAX_PENDING_APPROVALS = 8` に合わせる） | 人間可読化可 |
| `INTERNAL_ERROR` | 監査の書き込み失敗・記録作成失敗など（fail-closed） | 一般的な失敗表示 |

- 理由区分名はランチャー（バッチ20）と共有する契約値。`DISABLED`・`BUSY`・`INVALID_PAYLOAD`・`GATE_DENIED`・`INTERNAL_ERROR` は設計 §8 の表に無い補完で、**HAYATO-OS ラインとの統合確認で確定**させる（§7 D7）。
- 非同期の承認拒否は同期応答の対象外（run レコードで後から分かる。設計 §8）。

---

## 2. 呼び出し元検証（F2/F3、A3）

受け入れ：
- 呼び出しごとに `Binder.getCallingUid()` → `PackageManager.getPackagesForUid(uid)` を解決し、**ちょうど1パッケージ**かつ `com.rebuildfactoryz.hayatoos` と一致すること（sharedUserId で複数返る場合は拒否）。`getCallingPackage()` は自己申告由来になり得るので信頼の根拠にしない（UID からの解決を正とする）。
- そのパッケージの署名証明書 SHA-256 がピン集合のいずれかと一致すること。判定は `PackageManager.hasSigningCertificate(pkg, certBytes, CERT_INPUT_SHA256)`（API 28+。28 未満は拒否）。現行ピン：`a8ad4766f1ca993aad465ea7f4f81a193187d2845607e2844dfe2827acc100cd`。
- ピンは**配列（複数世代）**として保持する構造（ローテーション手順は D4）。
- 通過時のみ `origin=launcher` を発行する（MCP とは別の確認済み起源値）。失敗時は origin を発行せず `denied`/`VERIFY_FAILED`、監査には詳細（どの検査か）を残す。
- **A3**：ペイロードに自己申告の身元（アプリ名・パッケージ名・"approved" 等）を入れた呼び出しでも provenance 判定が変わらないこと。署名違いのテストとは**別のテスト**で固定する（検証済み呼び出し＋偽の身元キー → 結果・origin・監査が身元キー無しと同一であること、検証失敗呼び出し＋「正しい」身元キー → VERIFY_FAILED のまま）。

実測（再利用元）：
- 呼び出し元 UID を検証する既存ヘルパーは**無い**（`getCallingUid`/`getPackagesForUid` はリポジトリに不在）。
- 再利用できる部品：`ClosePawHandoff.kt:188-204`（単一ピン `VARIANT_CERT_SHA256`、`hexColonToBytes`、`hasSigningCertificate` によるインストール済みパッケージの照合）。これは「インストール済みパッケージの照合」であり「呼び出し元の照合」ではない。UID 解決は新規。
- ピンの文字列形式は既存がコロン区切り16進（ClosePaw）、契約値は区切りなし小文字16進。どちらかに統一し、テストで両方の表記を往復させること。

---

## 3. 既存経路への合流（F1/F4、実測で前提を補正）

**前提の補正（重要）**：設計は「dispatch → ゲート → IngressAuditWriter → 承認フレームワーク」が汎用の収束点として存在する前提だが、実測では**この収束点は MCP 専用に結合している**。新規の実行経路・監査系・承認系を作らずに合流するには、既存コアの入力型を MCP から一般化する**リファクタが前置作業として必要**。

実測：
- 判定コア：`McpTypedOpDecision.decide(req, steps, nowMs)`（`McpTypedOpDecision.kt:247-290`）は純関数だが、`Request` は `parseRequest`（HMAC・`ingress.kind=="mcp"`・32 hex principal 必須、`:118-147`）でしか作れない。判定順：設定 ON → op/引数 → epoch → target 有効 → **STOP-ALL（`halted`）** → taint（`tainted`）→ action-consent → native step 7 → requestId 冪等 → **常時許可（principal, op, target, bind）** → RN 生存なら引き渡し、そうでなければ `not_attended`。RN 側に同順の写し（`lib/mcp-server-bridge.ts:2178-2281`）＋ step 8b 全体承認省略スイッチ（`isApproveAllWithoutAskingOn`、正本は native `ApproveAllStore`）＋ 90 秒の承認ダイアログ。
- 監査：`IngressAuditWriter.kt` は kind/event/フィールドが**閉じた集合**（`MCP_KINDS`・`NATIVE_MCP_KINDS`・`NATIVE_MCP_EVENTS`、`principal` は 32 hex、`code` は `^[a-z_]{1,32}$`）。callId・run handle・origin・correlation のフィールドは**現行に無い**。本文は一切書かない設計（`:188`）。
- 常時許可：`McpAlwaysAllowStore.kt`（Keystore HMAC、`principal\0op\0target` キー、`TYPED_OPS=['run_agent']` 固定、principal 32 hex）。設定画面 `McpAlwaysAllowSection`（一覧・取消のみ）。
- 全体承認省略スイッチ：`ApproveAllStore`（native、Keystore）／`lib/approve-all-without-asking.ts`。
- STOP-ALL：`$HOME/.shelly/agents/.halted`、判定不能時は停止扱い（`McpTypedOpConsumer.kt:174-178`）。
- run レコード：`McpRunTickets.kt`、`$HOME/.shelly-mcp-queue/runs/<handle>.json`（tmp+rename）、handle `mr_`+32hex、状態 `accepted → running → succeeded|failed|skipped|cancelled|lost`。**承認待ち状態は無い**。`accepted` は 2 分で `lost` になる stale 規則あり（`:81,:293-305`）。読み取り面は MCP `get_run_result`（**principal スコープ**）。
- 非ブロッキングで「受理→後で確認」する前例：`AgentAddHandoff.kt`（即時 `notified` 応答、通知、アプリ内確認、10 分失効、入力上限 `MAX_CODE_POINTS`）。MCP の承認ダイアログは同期（最大 90 秒）で、非同期の通知タップ承認は MCP には無い（エージェントのアクション承認 `AgentActionApprovalBridge` にのみ存在）。

受け入れ（合流の定義）：
- C1. 判定は既存の判定コアを通す。具体的には `McpTypedOpDecision` の判定順のうち該当段（設定 → op/引数 → STOP-ALL → taint/D1 → 常時許可 → 全体承認省略スイッチ）を、**起源を一般化した同じ関数**で評価する。ランチャー専用の別判定ロジックを書かない（ただし run_agent 固有段＝target 有効・action-consent・step 7・bind は submit_instruction では「該当なし」として明示的にスキップし、テストで固定）。
- C2. 監査は `IngressAuditWriter` に新しい kind/event を**追加**して書く（別ファイル・別ライター禁止）。行は固定フィールドのみ：`ts`（Shelly 側時刻）、`kind`、`event`（`launcher_submit_instruction`）、`origin`（`launcher`）、`code`、`submission_id`、`correlation_ref`（A2、§8 R5 参照）、`principal`（ランチャー principal、§3.1）。**`instruction_text` の内容は書かない**（長さのみ可）。
- C3. 常時許可の単位は `principal(origin=launcher) × op(submit_instruction) × target(hayato)` の1行で、既存 `McpAlwaysAllowStore` に載せる（`TYPED_OPS` と target 正規表現 `^hayato$` を追加）。設定画面の既存一覧に出て取り消せること。
- C4. 全体承認省略スイッチ（ingress 横断）が ON ならこの経路にも適用（F4）。ただし D1 下で taint 付きの投入には適用しない（既存不変条件「tainted は無人全面許可を得ない」）。§4 参照。
- C5. STOP-ALL とゲート deny は承認画面なしで即時 `denied`（`STOP_ALL_ACTIVE` / `GATE_DENIED`）。
- C6. 自由文の生実行がこの経路で常時許可対象になることはない。submit_instruction はローカル実行力（run_command / write_file / エージェント起動）を一切持たない（F4、設計 §4.3）。

### 3.1 ランチャー principal
- 既存の principal は MCP トークン由来の 32 hex。ランチャー principal は「検証条件を満たす呼び出し元そのもの」（設計 §5.1）なので、**origin を型として持たせる**のが正（推奨：`Principal(origin, id)`、launcher の id はピン集合の正規化ハッシュから決定的に導出した 32 hex）。32 hex 偽装で MCP 側の型に押し込む案は、MCP ルールとランチャー・ルールが同じ名前空間で衝突しうるので採らない。

---

## 4. origin と taint（D1 未決、A4）

受け入れ：
- **A4**：origin→taint のラベル付けは **1か所（origin 定義側）に集約**する。ランチャーの taint 扱いは定義表の1行（例 `launcher → tainted=true（暫定）`）で決まり、D1 確定時の修正がその1行（＋それを固定するテスト）で済むこと。ゲート・監査・承認・run レコードの各所は表を引くだけで、`launcher` を個別に分岐しない。
- D1 暫定：**免除なし**＝検証済みランチャー入力も taint 付き（外部起源）として扱う。run レコードと応答の記録には `untrusted: true`（既存 run_agent の応答と同形）を付ける。
- 帰結（暫定下）：常時許可・全体承認省略スイッチによる「無人の即時許可」は taint 付きには効かない、が既存不変条件。したがって**D1 が免除なしのままなら、初回以降も毎回承認が必要**になり、受け入れ B「常時許可後の2回目以降はダイアログなし」と衝突する。→ §7 D1 に明記。実装は表の1行で切り替わる形にしておき、テストは両方の値でパラメータ化する。

実測：
- origin→taint の対応は現行**散在**している（`agent-action-policy.ts:57-83` の RunOrigin、`AgentRuntime.normalizeRunOrigin`、`TerminalSessionService.kt:539-548`、`mcp-ingress-gate.ts:22`、`AgentIngressTaint.kt:91`（SOURCES=`mcp` のみ）、`mcp-request-auth.ts`、`ShellyNotificationListener.kt:520`、`agent-run-origin-registry.ts`、`app/_layout.tsx` の `trustedRequestOrigin`）。既存箇所の集約は A のスコープ外。A は**新しい origin 定義表を1つ作り、launcher の判定はそこだけを見る**（既存 MCP 経路の書き換えは不要、ただし表に `mcp → tainted` も載せて整合をテストする程度は可）。
- 「検証済みの非 MCP origin」の概念は現行に無い（新規）。

---

## 5. 承認と run レコード（F5/F7、A1/A2）

**Phase 1 の受け入れ（2026-11-26 メイン決定）**：受理＋監査＋承認状態つきの記録＋同期で決まる `approved` まで。下記のうち「既存の承認 UI を非同期に使う」承認（承認・拒否の監査イベントを含む）と、「run レコードの通常の読み取り面」からの投入レコードの読み出しは Phase 2（冒頭「Phase 1 の範囲」参照）。

受け入れ：
- **A1**：承認待ちの投入は Binder 呼び出しを**ブロックしない**。call() は検証・ペイロード検証・同期判定（STOP-ALL / deny / 常時許可 / スイッチ）だけを行い、承認が要る場合は `accepted` + `approval=pending` を即時返す（目安：call 全体が数百 ms 以内。UI スレッド・RN を待たない）。
- 承認待ちの状態が **run レコードに見える**こと：`McpRunTickets` に状態を追加する（推奨名 `pending_approval`、および承認後の `approved`／拒否時の `denied_by_user`・失効時の `expired`）。既存の 2 分 stale→`lost` 規則を投入レコードに適用しない（または承認期限に合わせて別閾値）こと。
- 承認は**既存の承認 UI**（`useMcpApprovalStore` + `McpApprovalModal`、決定 `deny|once|always`）を非同期に使う：Binder 応答後に承認要求をキューへ積み、Shelly 前面時にモーダル、背面時は通知（AgentAddHandoff と同形の「確認してください」通知→タップでアプリ→既存モーダル）。承認期限（推奨 10 分、AgentAddHandoff と同じ）を過ぎたら `expired`。「新しい承認系を作らない」の解釈は §7 D8。
- **A2**：`correlation_ref` を渡した場合、監査行（全イベント：受理・承認・拒否）と run レコードの両方にエコーされること。`submission_id` が両者の join key（F7）。
- 結果取得は run レコードの通常の読み取り面のみ。ingress 専用の結果コールバックは作らない（F7）。
- `submission_nonce` の重複排除：同一 nonce（＋同一 principal）の再送は新規レコードを作らず既存の `submission_id` を `duplicate=true` で返す（窓は既存 requestId 冪等と同じ 10 分）。認可には使わない。

D2 下の終端：A の受け入れは「受理＋監査＋run レコードに記録（承認状態つき）」まで。承認後のレコードは `approved`（転送待ち）で止まる。ハヤトへの転送・実行は行わない（§7 D2）。

---

## 6. 追加スコープ

### 6.1 (a) チャットスラッグ受信 `hayato://chat/<slug>`

- ランチャーはタスク行タップで `hayato://chat/<slug>` を発行する（現状は受け手が無く「! NO HANDLER FOR CHAT REF」表示）。Shelly がこの URI の VIEW ハンドラになり、slug→チャットを解決する。
- slug 表（hayato-status の status.json v2 に登録済みとされる値）：`shelly-dev` / `closepaw` / `council` / `hayato-os` / `shelly-bridge` / `nacre`。**本セッションでは公開 status.json の再取得が権限で拒否されたため未再確認**（実装着手時に確認）。
- 受け入れ：
  - S1. slug は `^[a-z0-9-]{1,40}$` のみ受理。それ以外・未知 slug は何もせず「未解決」を表示（クラッシュ・任意 URL 遷移なし）。
  - S2. `hayato://chat/<slug>` 以外の `hayato://` パスは無視。
  - S3. VIEW Intent は送信元を検証できない（どのアプリも発行可）ので、slug 受信は**表示・遷移のみ**で、実行・承認・投入には一切つながらない。
  - S4. slug 表の置き場は §7 D5/D6 の決定に従う（推奨：端末側データ。リポジトリに既定値として焼き込まない）。
- 実測：
  - スキーム `shelly` のみ（`app.config.ts:5,53,112-124`）。`hayato` は全リポジトリで NOT FOUND。新スキームは `android.intentFilters` への追加 or モジュールマニフェストの intent-filter。
  - `normalizeDeepLinkTarget`（`app/_layout.tsx:983-989`）は「最初のパスセグメント→無ければホスト」を target にするため、`hayato://chat/<slug>` は target が `<slug>` になる。スキーム別の分岐が必要。
  - `handleDeepLink`（`app/_layout.tsx:1511-`）の if/else 連鎖に分岐を足す。
  - Shelly に slug を持つチャット概念は無い（`AgentChatSession` は `codexSessionId` キー、slug 無し）。**「チャット」が何を指すか（Muse のサイドチャットか、Shelly 内のセッションか）は未定義** → §7 D5。

### 6.2 (b) バッチ23 ストリームフィードの取り込み

- 供給：VM 上で 15 分ごとに feed JSON v1（`{v:1, updatedAt, items:[{id, source, ts, author, context?, text, unread?, link?}]}`、最新 50 件、ts 降順、id で重複排除）を生成。生成物 `~/workspace/hayato-stream/feed.json`（実測：現時点 約 20 KB。稼働ソースは承認カード制約により X と Bluesky のみ — `hayato-stream/README.md`）。
- 経路（オーナー決定）：VM → Shelly は MCP 経由で Shelly 側ストレージへ着地、Shelly → HAYATO-OS は同じ Provider 経由で供給。
- 受け入れ：
  - P1. **不透明な v1 ペイロード**として扱う：Shelly は `v===1`・JSON として妥当・サイズ上限内であることだけを検査し、項目の意味解釈・並べ替え・加工をしない。
  - P2. サイズ上限つき（推奨 256 KiB、既存 `update_pipeline_config` と同じ。現行 20 KB、50 件×約 140 字の最悪見積もりでも十分）。超過は拒否し last-good を保持。
  - P3. **原子的置換**：一時ファイル→fsync→リネーム（既存 `PayloadHygiene.replaceVerified` / `ClosePawRunResults.writePrivateAtomic` の型）。失敗・検査不合格・途中切断のいずれでも**前回分（last-good）を保持**し、空白にしない。
  - P4. 保存先はアプリ専用領域（バックアップ対象外）。共有ストレージ・ログ・監査・chat・リポジトリに実データを残さない。監査は sha256・bytes・件数・結果コードのみ。
  - P5. MCP の投入 op は 15 分ごとに**承認タップなしで**回る必要がある（毎回承認だとカード洪水）。→ 常時許可の対象 op にする（op × MCP principal × target=`stream-feed`）。投入データは外部起源（メール・SNS）であり taint 付き。**保存された feed は Shelly のどの実行・プロンプト・エージェント入力にも流さない**（Provider での読み出し専用）。
  - P6. Provider の読み出し method（推奨 `get_stream_feed`）は §2 と同じ呼び出し元検証を通過した呼び出しにだけ返す。応答は `{status, updated_at, sha256, bytes, feed_json}`（feed が未着なら `status=empty`）。読み出しは承認不要・監査は件数ベースの軽量行（またはレート集約）とし、本文は書かない。
  - P7. 消費側の規律（必須欠落は読み飛ばし、壊れた文書は前回分保持）はランチャー側の責務。Shelly は last-good を返し続ける。
- 実測（前例）：`update_pipeline_config`（`shelly-mcp-server.js:441-464`、staged path + `expectedSha256` + `expectedBytes`、256 KiB、`.bak`・前 sha の CAS・`mv`、`lib/mcp-server-bridge.ts:1501-1555`、監査 kind `mcp_update_pipeline_config`）と `update_delivery_script`（1 MiB）。どちらも `APPROVAL_TOOLS` で**毎回承認**であり、P5 とは異なる。MCP リクエストファイル上限は 64 KiB（`McpTypedOpConsumer.kt:85`）なので、インライン投入なら feed 上限はそれ未満に制約される（§8 R6）。

---

## 7. 未決事項（実装で確定扱いにしてはいけない点）

- **D1（オーナー判断待ち・メインで保留中）**：検証済みランチャー入力の taint 免除可否。暫定＝免除なし。A は origin 定義表の1行で切り替わる形で実装（A4）。帰結として、免除なしでは常時許可・全体スイッチが効かず毎回承認になる（受け入れ B の「2回目以降ダイアログなし」が成立しない）ことをメインへ併記して判断を仰ぐ。
- **D2（ブロッカー、別判断）**：Shelly→ハヤト転送経路。A の受け入れは「受理＋監査＋run レコード記録（承認状態つき）」まで。加えて、現行 `get_run_result` は MCP principal スコープなので、ハヤト（MCP principal）がランチャー投入のレコードを読めるかも D2 で決める。
- D3：上限値（correlation_ref・nonce の長さ、call タイムアウト秒数＝ランチャー側、承認期限、保留件数上限、feed 上限）。本シートの推奨値を実装の初期値とし、統合確認で確定。
- D4：署名ピンのローテーション運用手順（構造は配列で複数世代）。
- **D5（新規）**：`hayato://chat/<slug>` の解決先「チャット」の定義。候補：(i) Muse のサイドチャットを開く（Muse 側のディープリンク対応が外部依存、設計 §7.3）、(ii) Shelly 内の対応ビュー（例：該当ラインの状況表示）を開く、(iii) slug を `correlation_ref` 付きの投入画面に渡す。HAYATO-OS ラインとの統合確認で決める。
- **D6（新規、Shelly 不変条件との整合）**：「オーナーの個人情報・利用パターン・環境固有値を公開リポジトリとその既定値に入れない」「Shelly はハヤト無しで完全に動く」との関係。契約どおりに実装すると公開リポジトリに `com.rebuildfactoryz.hayatoos`・署名ピン・`hayato://` スキーム・slug 表が入る。推奨：コードは汎用（「信頼する呼び出し元の登録」「チャット参照スキーム」）とし、具体値は端末側の封印済み設定（Keystore HMAC。既存 `McpAlwaysAllowStore` と同型）にオーナー操作で登録。ただし intent-filter のスキームはビルド時固定なのでマニフェストに入らざるを得ない → スキーム名の扱いをメインで判断。
- **D7（新規）**：理由区分の補完値（`DISABLED`・`BUSY`・`INVALID_PAYLOAD`・`GATE_DENIED`・`INTERNAL_ERROR`）と `approval` フィールドをバッチ20 と擦り合わせて確定。
- **D8（新規）**：「新しい承認系を作らない」の解釈。既存 MCP 承認は同期ダイアログ（最大 90 秒）で、非同期承認（Binder 応答後に承認）は既存部品の組み合わせ（承認ストア＋モーダル＋AgentAddHandoff 型の通知）で実現するが、MCP には非同期承認の前例が無い。これを「既存承認系の利用」と見なしてよいかをメイン（ゲート担当）で確認する。
- D9：feed 投入 op を常時許可（無人）にすること（P5）の承認。feed は taint 付きデータだが、op 自体は「アプリ専用領域の1ファイルを原子的に差し替える」だけで実行力を持たない。

---

## 8. 実装で問題になりうる点（ゲートでの確認項目）

- R1. 判定コアの一般化リファクタ（§3）が既存 run_agent の挙動を変えないこと：既存テスト（`McpTypedOpDecisionTest.kt`、`mcp-run-agent-bridge.test.ts`、`mcp-typed-op-native-parity.test.ts` 等）が無修正で通ることを先に固定する。
- R2. Kotlin JVM テストは **CI で走っていない**（`build.gradle:43-46` のコメント、ワークフローに test タスク無し）。CI で効くのは jest のソース文字列固定テスト。新規 Kotlin ロジックは純粋な Core に切り出して JVM テストを書き、加えて jest 側の文字列固定（authority・exported・ピン検査呼び出し・origin 表）で CI に乗せる。
- R3. 4,000「文字」はコードポイントで判定（`String.codePointCount`）。UTF-16 長で判定すると絵文字・サロゲートで食い違う。境界値（4,000／4,001、サロゲートペア境界）をテストで固定。
- R4. Binder スレッドで重い処理をしない：検証・判定・記録の書き込みだけ。RN ブリッジ・UI を同期で待たない。ContentProvider は `onCreate` がアプリ起動時に走るので軽量にする。
- R5. `correlation_ref` は不透明だが監査行は「本文を書かない」閉じた形式：エコーには文字種・長さ制限（推奨 `^[A-Za-z0-9._:/-]{1,256}$`、違反は `INVALID_PAYLOAD`）を課し、自由文の密輸経路にしない。
- R6. feed の MCP 投入方式：インライン（64 KiB のリクエスト上限に縛られる）か、staged path（`/sdcard/Download` に置く＝共有ストレージに私物が一時的に出る、P4 と衝突）か。推奨はインライン＋上限 48 KiB 程度（現行 20 KB）、超過時は供給側で件数を削る — 供給側との合意が要る（§7 D3）。
- R7. run レコード状態の追加（`pending_approval` 等）が既存の `get_run_result`・MONITOR・stale 規則・同時実行上限（principal あたり 2）に波及しないこと。投入レコードは実行ではないので「live run」に数えない。
- R8. 監査書き込み失敗時は fail-closed（既存の「executing 行が書けなければ止める」と同じ）で `INTERNAL_ERROR`。ただし `VERIFY_FAILED` の監査が書けない場合も応答は `VERIFY_FAILED` のまま（詳細を漏らさない）。
- R9. ログ：`instruction_text`・feed の内容を logcat・監査・例外メッセージに出さない（既存 `__tests__/no-input-in-logs.test.ts` の規律に新ファイルを加える）。
- R10. Knox 等の端末制約で ContentProvider 間 Binder IPC が阻まれないかの実機スパイク（cc9 ブリーフ「着手順 1」）は未実施。端末作業（Tier H／M）でメイン経由。

## 決定事項（2026-11-25、メイン回答）
- **D6 承認**：コードは汎用の「信頼する呼び出し元の登録」として作る。パッケージ名・署名ピンは端末側の封印済み設定に置き、公開リポジトリ・既定値には入れない。公開側に残るのは intent-filter のスキーム名 `hayato://` のみ。
- **D5 v1 の定義（メイン）**：`hayato://chat/<slug>` は「Hayato へのナビゲーション要求」。Shelly は検証してキューに積み、「Hayato に <slug> を開くよう伝えた」旨の確認表示までが v1 の範囲。消費（該当ラインの Muse サイドチャットへの誘導）は Hayato 側。
- **D1**：オーナー判断の前に Fable 評決を取る（帰結「免除なし＝毎回タップ、ウィジェット受け入れ条件と衝突」を入力に含める）。微妙なら Codex Astra のセカンドオピニオン。評決はメインへ報告し、オーナーへはメインから推奨つきで上がる。評決待ちの間も他の部分は止めない。
- **feed**：インライン投入＋約48KiB 上限、投入 op の常時許可対象化が前提（メイン了解済み）。

## D1 確定（2026-11-25、オーナー確定：Fable 評決どおり条件付き免除）

**線引き**：taint はチャンネルの認証ではなく、内容の作者を追う。免除は op 単位でのみ与え、次の3条件をすべて満たす場合に限る（「オーナー製アプリ」であること自体は何も生まない）：
1. 境界で検証された認証済みチャンネル（登録済み principal に対する検証）
2. 型付きスキーマが、人の入力面で書かれ明示的な送信行為で送られた内容だけを運ぶ
3. プログラム（登録済みアプリ自身を含む）がフィールドを埋める／送信を発火させる経路が存在しない

MCP は条件2を恒久的に満たさない（呼び出し側のプログラムが入力を決める）ため、同意があっても tainted のまま。これは検索パリティの Fable 評決（「入力を誰が決めたか」）と一貫する。submit_instruction は「Shelly のリモートキーボード」であり導管ではない。

**Shelly 側の条件（コードで確認可能）**：
- 免除は（署名ピン digest、op、スキーマ版）の組に束縛する allowlist で fail closed。未知の op・フィールド・スキーマ版は tainted か拒否
- 免除対象の submit_instruction は instruction_text のみ。添付・引用・URL ペイロード等のフィールドがあれば tainted
- 既定オフ。オーナーが Shelly の Settings で署名ピンに束ねて有効化。ピンの追加・ローテーションで失効し、再確認まで免除なし
- 免除は ingress 時点のみ。ランが外部入力（Web・ファイル・MCP・指示文中の URL 等）を読んだ瞬間に taint が付く（単調）。「2回目以降ダイアログなし」はクリーンなままのランにだけ成立
- origin=launcher のラベルは保持する（規則の対象範囲指定と、tainted へ落とす kill switch のため）
- 監査：各レコードに署名 digest・op・スキーマ版・免除適用フラグ・テキストハッシュ
- レートブレーキ：人間が書く速度を超える送信は tainted に落とす

**ランチャー側の条件（ランチャー側リポジトリのテストで固定し、Shelly と同じレビューゲートに載せる）**：
- フィールドへの書き込みはユーザー編集のみ（フィード・通知・intent extras・共有ターゲット・ディープリンクからの setText 禁止）
- 送信はタップハンドラからのみ到達可能（exported component・broadcast・自動化フックから Provider 呼び出しに到達できない＝confused deputy の遮断）
- 上記2性質を assert するテストを置き、新しい呼び出し箇所が増えたら落ちる形にする

**将来の「フィード項目をハヤトへ送る」**：別 op（例：forward_content、origin=launcher-forwarded）として実装し、**常時 tainted、免除対象外**。タップは送信の許可であって内容の作者にはならない。オーナーのメモを付けても別フィールドで運び、全体は tainted のまま。免除フィールドへの外部テキストの事前入力は条件違反であって設計の選択肢ではない。

**残余リスク（受容済み）**：悪意あるテキストの貼り付けは Shelly へ直接打つ場合と等価として受容。ランチャー側規律はランタイムでは検証できないため、ランチャー側のテストとレビューゲートが条件そのものになる。

評決全文：`~/workspace/research/launcher-ingress/d1/fable-review.log`、プロンプト：同 `fable-prompt.md`。Astra のセカンドオピニオンは評決が明確だったため未実施。

## Knox スパイク結果（2026-11-25、PC CC 実施・Inbox 報告コメント 7159790195）
- **A1〜A4 すべて PASS**：Binder 経由の ContentProvider.call() 往復、呼び出し元 UID／パッケージ／署名 SHA-256 の取得、誤署名の判別、callee バックグラウンドでの往復、Knox の拒否なし。C5（Provider ingress）の前提は実証された。
- **設計所見（呼び出し側の必須事項）**：呼び出し側の manifest に `<queries>` が無いと、Android 11 以降のパッケージ可視性で "Unknown authority" となり初回呼び出しが失敗する。**HAYATO-OS 側の manifest に Shelly の authority を `<queries><provider>` で宣言することが必須**。callee（Shelly）側は `<queries>` 無しでも呼び出し元の解決ができた。

---

# C7 契約 — stream feed（Shelly 側の確定値）

作成：2026-11-25、VM CC（Piece A Phase 1 再開席）。対象コミット：`feat/launcher-ingress` の C7 = `722ff50`（Codex レビュー OK 済み、3 巡目で OK）。
正本のコード：`StreamFeedCore.kt`（定数・検査・応答形）、`StreamFeedStore.kt`（保存・last-good）、`McpTypedOpConsumer.kt`（無人経路）、`lib/mcp-stream-feed.ts`・`lib/mcp-server-bridge.ts`（承認経路）、`scripts/shelly-mcp-server.js`（MCP ツール定義と事前検査）。
読み出しメソッド `get_stream_feed` の Provider への配線は C5（呼び出し元検証）と同じコミット列で入る。応答の形は C7 で固定済み（`StreamFeedCore.readResponse` / `deniedResponse`）で、C5 はそれを Bundle に詰めるだけ。

---

## 1. 読み取り：`ContentResolver.call(authority, "get_stream_feed", null, null)`

- authority：`dev.shelly.terminal.ingress`（本番。マニフェストは `${applicationId}.ingress`）。呼び出し側 manifest に `<queries><provider android:authorities="dev.shelly.terminal.ingress" /></queries>` が必須（Knox スパイクの所見）。
- `arg`・`extras` は使わない（何を渡しても無視）。
- 呼び出し元検証は `submit_instruction` と同一（Binder UID → ちょうど1パッケージ → オーナーが Shelly の設定に登録したパッケージ名＋署名ピン）。承認は不要。STOP-ALL の影響を受けない（表示用の読み出しのため）。
- 例外は呼び出し元へ伝播しない。常に Bundle が返る。

### 1.1 応答 Bundle

| キー | 型 | いつ | 内容 |
|---|---|---|---|
| `status` | String | 常に | `ok` / `empty` / `denied` / `error` |
| `response_version` | Int | 常に | `1`（この表の形の版。形を変えるときに上げる） |
| `feed_json` | String | `ok` | 保存された feed 文書そのもの（投入時のバイト列を UTF-8 で復号した文字列。Shelly は加工・並べ替え・項目の解釈をしない） |
| `sha256` | String | `ok` | `feed_json` の UTF-8 バイト列の SHA-256（小文字16進64桁）。投入時の `expectedSha256` と同値 |
| `bytes` | Int | `ok` | `feed_json` の UTF-8 バイト数（1〜49152） |
| `updated_at` | Long | `ok` | Shelly がその feed を受け取って保存した時刻（epoch ミリ秒、Shelly 側の時計）。feed 自身の `updatedAt` は `feed_json` の中にあり、Shelly は読まない |
| `reason` | String | `denied` / `error` | `denied`：`VERIFY_FAILED`（呼び出し元検証の失敗。どの検査で落ちたかは返さない）または `DISABLED`（ランチャー連携が設定で無効）。`error`：`INTERNAL_ERROR` |

- `empty`：まだ一度も feed が保存されていない（`feed_json` 等のキーは無い）。
- `error`：保存ファイルが読めない・形式が壊れている（サイズかダイジェストの再検査に失敗）。原子的置換なので通常は起きない。この場合も Shelly は前回分を消さない。
- 受け取り側は `sha256` を自分で再計算して照合できる（任意）。

### 1.2 サイズ上限と超過時の振る舞い

- 上限：**49,152 バイト（48 KiB、UTF-8）**。定数 `LauncherIngressLimits.MAX_FEED_BYTES`（TS 写し `STREAM_FEED_MAX_BYTES`、テストで一致を固定）。
- 超過した投入は**切り詰めずに拒否**（`too_large`）し、保存済みの前回分をそのまま残す。読み出し側から見ると `updated_at` が進まないだけで、`feed_json` は前回の妥当な feed のまま。
- 追加の制約：投入は署名付き MCP リクエスト1ファイル（上限 64 KiB）にインラインで載るため、JSON 文字列としてのエスケープで膨らんだ結果が 64 KiB を超える場合も MCP サーバーが投入前に `too_large` で拒否する。供給側は 48 KiB 以内でも、引用符・改行の多い本文では件数を減らして収めること（現行実測 約 20 KB）。

### 1.3 last-good の振る舞い

- 保存は「O_EXCL の一時ファイル → 書き込み → fsync → 読み戻して形式・サイズ・SHA-256 を再検査 → rename(2)」。rename が成功するまで読み出しは常に前回分を見る。
- 次のいずれでも**前回分を保持**し、空にしない：引数不正・上限超過・サイズ不一致・ダイジェスト不一致・`v` が 1 でない／JSON オブジェクトでない・STOP-ALL 中・監査行の書き込み失敗・一時ファイルの書き込み／fsync／読み戻し／rename の失敗・承認の拒否／タイムアウト。
- 読み出し側の規律（必須欠落の読み飛ばし、壊れた文書は手元の前回分を保持）はランチャー側の責務（P7）。Shelly は保存済みの last-good を返し続ける。
- 保存場所はアプリ専用領域の `noBackupFilesDir/stream-feed/feed-v1`（`$HOME` の外：シェル・エージェント・MCP のファイル系ツールからは見えない。バックアップ対象外）。

---

## 2. 取り込み：MCP 型付き op `put_stream_feed`（VM の hayato-stream → Shelly）

- MCP ツール名：**`put_stream_feed`**。Shelly の設定「MCP: 型付き操作を許可」（`SHELLY_MCP_TYPED_OPS`）が ON のときだけ一覧に出る（`run_agent` と同じスイッチ）。
- 引数（すべて必須、追加キーは拒否）：

| 引数 | 型 | 制約 |
|---|---|---|
| `feedJson` | string | feed 文書そのもの。供給側がハッシュしたバイト列と同一の文字列（UTF-8） |
| `expectedSha256` | string | `^[0-9a-f]{64}$`。UTF-8(`feedJson`) の SHA-256 |
| `expectedBytes` | integer | 1〜49152。UTF-8(`feedJson`) のバイト数 |

- 検査（この順、最初の失敗で終了。MCP サーバーの事前検査・RN・native の3か所で同じ順）：
  1. 引数の欠落・型違い・未知キー → `invalid_params`
  2. UTF-8 で 49,152 バイト超 → `too_large`（署名付きリクエストが 64 KiB を超える場合も `too_large`）
  3. バイト数が `expectedBytes` と不一致 → `size_mismatch`
  4. SHA-256 が `expectedSha256` と不一致 → `digest_mismatch`
  5. 厳密な JSON（RFC 8259。`JSON.parse` と同じ文法、入れ子は 64 段まで）のオブジェクトでない、または `v` が数値 1 でない → `invalid_feed`（項目の中身は検査しない）
  - 補足：`expectedBytes` が 49,152 を超える値の場合は手順1で `invalid_params` になる（`too_large` は宣言値が上限内で実体が上限超のとき）。`feedJson` に対になっていない UTF-16 サロゲートがある場合も `invalid_params`。
- 成功時の結果：`{ "stored": true, "sha256": "...", "bytes": n, "receivedAt": <epoch ms>, "untrusted": true }`。
- 締め切り：署名から 100 秒（既存の型付き op と同じ）。保存の直前（rename の直前）に STOP-ALL と締め切りを再確認する。
- 失敗時：MCP のエラー結果 `Error: [<code>] <message>`。code は上記に加えて `disabled`（型付き操作が OFF）、`revoked`（MCP トークン更新）、`halted`（STOP-ALL 中）、`not_attended`（常時許可ルールが無く、Shelly が前面に無い）、`denied`（承認画面で拒否・タイムアウト）、`approval_timeout`／`timeout`（締め切り切れ。native 経路は前者、RN 経路は後者）、`target_changed`（照合したルールが直前に消えた）、`audit_failed`、`store_failed`、`handoff_failed`、`native_error`。いずれも前回分は保持。

### 2.1 常時許可（無人で15分ごとに回すための条件）

- ルールの単位：**MCP principal（トークン由来の 32 hex）× op `put_stream_feed` × target `stream-feed`**（bind なし）。`McpAlwaysAllowStore` / `lib/mcp-always-allow.ts` の既存一覧に載り、設定画面から取り消せる。
- 作り方：初回の `put_stream_feed` を Shelly が前面にある状態で送り、承認画面で「常に許可」をタップする。以後はその MCP クライアントからの投入が承認なしで保存される（Shelly が背面・画面ロック中でも native の消費側が処理する）。
- MCP トークンを再生成すると全 MCP ルールが消える（既存の連鎖）。再度「常に許可」が必要。
- **全体承認省略スイッチ（Skip all approvals）はこの op に効かない**。feed は外部起源（メール・SNS）で常に tainted なので、包括的な無人許可の対象にしない（既存不変条件）。無人化はこの op 専用のルールだけで行う（D9、メイン了解済み）。
- 判定順（native、`IngressDecision` の `put_stream_feed` 行）：設定 → 引数 → epoch → STOP-ALL → 常時許可ルール（一致すれば保存、無ければ RN が生きていて承認画面を出せるときだけ RN へ引き渡し、それ以外は `not_attended`）。

### 2.2 保存された feed の扱い（不変条件）

- feed は外部起源で常に tainted。Shelly のどの実行・プロンプト・エージェント入力・ログ・監査・チャット・リポジトリにも内容を流さない。読み出し口は `get_stream_feed`（検証済みランチャー）だけ。
- 監査（`~/.shelly/agents/audits/mcp-ingress-audit.jsonl`、kind = event = `mcp_stream_feed`）は principal・code・sha256・bytes・件数（`items` が配列ならその長さ）のみ。保存前に `storing` 行を書き、書けなければ保存しない。

---

## 3. HAYATO-OS 側（バッチ27）への要点

1. 読み出しは `call("get_stream_feed")` → `status` で分岐。`ok` なら `feed_json` を v1 として解析、`empty` は「未着」、`denied`/`error` は手元の前回分を表示し続ける。
2. 鮮度は `updated_at`（Shelly の受信時刻）で判断できる。供給が止まっても Shelly は最後の妥当な feed を返し続ける。
3. manifest の `<queries><provider>` 宣言が必須。署名ピン・パッケージ名はオーナーが Shelly の設定で登録する（公開リポジトリに値は無い）。
4. 供給側（VM hayato-stream）は MCP `put_stream_feed` を 15 分ごとに呼ぶ。`expectedSha256`/`expectedBytes` は送る文字列の UTF-8 バイト列から計算する。初回のみ前面で「常に許可」。

## 未確定（統合確認で確定）
- 上限値（48 KiB）と `response_version` の扱いは D3 の範囲。変更は `LauncherIngressLimits.kt` と TS 写しの2か所。
- 実機未検証（端末側の確認項目：初回承認→常に許可→背面での無人保存、`get_stream_feed` の ok/empty、上限超過時に前回分が返り続けること）。

## 残余（Codex レビューとの調整、受容済み）
- 同一 UID のコード（Shelly 自身の PTY シェル）はアプリ専用領域のファイルを読み書きできる。これは Shelly 全体で文書化済みの境界（`McpAlwaysAllowStore` と同じ）で、feed には適用範囲外。DEFERRED に記録する（C9）。
- 判定と rename の間のルール取り消し／トークン更新の競合は残る（STOP-ALL と締め切りは rename 直前に再確認済み）。op は表示用の不透明ファイル1つを差し替えるだけで実行力が無いため受容。

---

## 実機確認リスト（返却 §7）
## 7. 端末側で確認が必要なこと（ハヤト経由）

1. CI の APK ビルドで Kotlin がコンパイルできること（最優先。この VM では一度もコンパイルしていない）。
2. 設定 → ランチャー連携：パッケージとピンを登録できる。確認ダイアログにピンが表示され、免除をオン・オフできる。ピンを変えると免除がオフに戻る。
3. HAYATO-OS からの `submit_instruction`：
   - 登録済みの呼び出し → `accepted`（`pending`）
   - 署名違い・未登録 → `VERIFY_FAILED`（詳細なし）
   - 無効 → `DISABLED`
   - STOP-ALL 中 → `STOP_ALL_ACTIVE`
   - 4,001 文字 → `PAYLOAD_TOO_LARGE`
   - 同じ nonce の再送 → `duplicate=true`
   - 免除オン＋常に許可のルール → `approved`
   - 3 秒以内の連投 → tainted になり `pending`
4. `get_stream_feed`：feed 未着なら `empty`。`put_stream_feed` で初回承認→「常に許可」の後、背面で無人保存され、`ok` で同じ sha256 が返る。上限を超えた投入の後も前回分が返り続ける。
5. 監査ファイル（`~/.shelly/agents/audits/mcp-ingress-audit.jsonl`）に本文が無いこと。`submission_id` で応答と結合できること。
6. HAYATO-OS 側の manifest に `<queries><provider android:authorities="dev.shelly.terminal.ingress"/></queries>` があること（Knox スパイクの所見）。
7. `hayato://chat/<slug>` のタップ（C8、前回からの残り）。

## 8. PR 下書き（ハヤト用）

