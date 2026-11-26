【ハヤト】Piece A Phase 2 の実装束を渡す。以下の事実シート（設計）が正本。範囲は (1) 非同期承認の完結、(2) 前面承認面＋承認インボックス（オーナー提案の Google プロンプト型）、(3) 提出記録の読み取り面（D2 はシート §4 で確定済み）、(4) D8 はシート §5 で確定済み。合格したら俺の判定を待たず、PR→CI→導入まで進めてよい。着手したら Inbox で一報してほしい。シートと実装が衝突したら、解釈を変えずに報告してほしい。

================ Phase 2 事実シート ================

# Piece A Phase 2 事実シート（設計）— 非同期承認・前面承認面・提出記録の読み取り面

作成：2026-11-26、ハヤト（設計）。Phase 1 事実シート（`fact-sheet.md`）の継続であり、用語・契約定数・D1 確定はそちらが正本。本書は Phase 2 の範囲だけを固定する。
宛先：Phase 1 出荷席（Shelly Launcher ingress）。ゲートは本書を物差しにする（Phase 1 と同じ運用）。

---

## 0. Phase 2 の範囲

Phase 1 の受け入れは「受理＋監査＋承認状態つき記録＋同期で決まる approved」までで、次が意図的に残された：

1. **C6 非同期承認の完結**：承認待ち（`pending_approval`）の投入を、オーナーが後から判断して `approved` / `denied_by_user` に進める経路。Phase 1 では保留は10分で `expired` になるだけで、判断する面が無かった（2026-11-26 点灯で実測：保留2件は失効した）。
2. **前面承認面（オーナー提案、2026-11-26 採用）**：Google の確認プロンプト型に、承認が要るときだけ前面に出る面。選択肢は「許可／常に許可／許可しない」。同じ面が**承認インボックス**を兼ね、無人で却下・失効した記録も後から見られる。
3. **提出記録の読み取り面と D2 の確定**：承認済みの投入をハヤトが読み取り、実行に回すための面。D2（誰が読めるか）を本書 §4 で確定する。
4. **D8 の確定**：本書 §5。

範囲外：`forward_content` op（常時 tainted、別件）、フィード側の変更、`hayato://chat/<slug>` の消費側（ハヤト側の仕事）。

---

## 1. 非同期承認（C6 の完結）

受け入れ：
- P2-A1. `pending_approval` の投入は、承認期限（10分、Phase 1 の値）内に限り判断できる。判断の入口は2つ：(a) Shelly が前面に来たときの前面承認面（§2）、(b) 背面時の通知（AgentAddHandoff と同形：「確認してください」→タップで Shelly を開き前面面へ）。新しい承認系は作らない（§5）。
- P2-A2. 判断は既存の承認ストア（`useMcpApprovalStore` 相当）に記録され、run レコードの状態を `approved`（転送待ち）／`denied_by_user` に進める。監査には Phase 1 の行形式で `code` と承認イベントを残す（本文は書かない、Phase 1 C2 と同じ）。
- P2-A3. 「常に許可」は Phase 1 C3 のルール（principal(origin=launcher) × op(submit_instruction) × target(hayato)）を既存 `McpAlwaysAllowStore` に書く。以後の投入は同期で `approved` になる（D1 の免除条件を満たす場合のみ。満たさない tainted な投入には常時許可は効かない — Phase 1 の不変条件どおり）。
- P2-A4. 期限切れは `expired` のまま記録に残る（インボックスで見える、§2）。再送はランチャー側の新しい投入として扱う（既存レコードの復活はしない）。
- P2-A5. STOP-ALL 中・ゲート deny は従来どおり承認面に出ない（即時 denied、監査のみ）。

## 2. 前面承認面＋承認インボックス

受け入れ：
- P2-B1. Shelly が前面化した時点で未決の `pending_approval` があれば、他の画面より前に承認プロンプトを出す。表示するのは投入の本文（オーナー自身が書いた文であり、端末内表示は可。監査・ログには書かない原則は不変）、送信時刻、残り期限。選択肢は「許可／常に許可／許可しない」の3つだけ。
- P2-B2. 複数件ある場合は古い順に1件ずつ出す（キュー表示）。全件処理するか閉じると通常画面に戻る。閉じた未決分は期限まで通知とインボックスに残る。
- P2-B3. 承認インボックスは同じ面のリスト表示で、次を見られる：未決（判断可）、承認済み（転送待ち／消費済み）、却下（`denied_by_user`）、失効（`expired`）、無人却下（`not_attended` 等で同期 denied になった記録 — 理由区分つき）。保持は直近 50 件または 7 日のうち短い方（実装で確定し、本書へ追記）。
- P2-B4. インボックスは読み取り専用（判断はプロンプトでのみ行う）。ただし未決分についてはリストからプロンプトを再表示できる。
- P2-B5. 免除スイッチ ON・全体承認省略で同期 `approved` になった投入はプロンプトに出ない（インボックスの「承認済み」にだけ載る）。

## 3. 状態機械（Phase 1 への追加分）

既存：`accepted → pending_approval → approved | denied_by_user | expired`、同期 `approved`、`denied`（同期、理由区分つき）。
Phase 2 で追加する終端側の状態：
- `approved` の後に、ハヤトの消費をもって `consumed`（§4）。`approved` のまま一定期間（推奨 24 時間）消費されなければ `stale` としてインボックスに表示する（自動削除はしない）。

## 4. D2 確定 — 提出記録の読み取り面

**決定（ハヤト、2026-11-26）**：ハヤトの MCP principal は、origin=launcher の提出記録について、次の範囲でのみ読み取りできる。これが承認済み投入の「転送」の実体であり、Phase 1 の終端（転送待ち）を解消する。

- P2-C1. 読み取りは型付き op（新規 `get_launcher_submission` および一覧 `list_launcher_submissions`、名称は実装で確定し本書へ追記）で行う。MCP の既存の判定順（設定→STOP-ALL→常時許可は読み取りには適用しない→監査）を通す。読み取り自体に承認は要らない（オーナーが承認済みのものを、本来の宛先であるハヤトが読む）。
- P2-C2. 読めるフィールドは状態で変わる：
  - `approved`：`submission_id`、状態、時刻、`correlation_ref`、**`instruction_text` 全文**（これが実行の入力）。
  - それ以外の状態（pending／denied／expired／consumed）：状態・時刻・理由区分のみ。**本文は返さない**（オーナーが承認しなかった文をハヤトが読む理由はない）。
- P2-C3. 消費の記録：ハヤトが承認済み投入を取り込んだら `mark_launcher_submission_consumed`（名称は実装で確定）で `consumed` に進める。二重実行の防止は `submission_id` の冪等性で担保する（同じ id の再読み取りは `consumed` を返し、本文は返さない）。
- P2-C4. 読み取り・消費はすべて監査に残す（principal・submission_id・code のみ、本文なし）。
- P2-C5. taint の扱い：免除が適用された投入は ingress 時点で untainted（D1）。免除なしで承認された投入は、オーナーが前面面で本文を見て承認した時点で「オーナー本人の指示」としてハヤトへ渡る（承認＝転送への同意）。どちらの経路でも、ハヤト側は通常の指示として処理し、投入文中の URL・ファイル等を新たに読む場合はその時点で通常の taint 規律がかかる（D1 の単調性）。

## 5. D8 確定

**決定（ハヤト、2026-11-26）**：§1・§2 の実装は「既存承認系の利用」と見なす。根拠：判断の記録先は既存の承認ストア、ルールの保存先は既存 `McpAlwaysAllowStore`、通知は AgentAddHandoff の既存形であり、新しいのは「前面化したときに未決分をプロンプト表示する」プレゼンテーションと、run レコードの状態遷移の接続だけである。新しい承認ストア・新しい決定種別・新しいルール形式を作った場合は D8 違反としてゲートで止める。

## 6. 受け入れ条件（まとめ、ゲート用）

1. 点灯シナリオ再演：免除 OFF でランチャーから送信 → 保留 → Shelly を前面化 → プロンプト表示 → 「許可」→ レコード `approved` → ハヤトが読み取り（本文あり）→ 消費 → `consumed`。再読み取りで本文が返らないこと。
2. 「常に許可」→ ルールが設定画面の一覧に出て取り消せること。次回送信が同期 `approved` になること（免除条件を満たす場合）。
3. 「許可しない」→ `denied_by_user`、ハヤトの読み取りで本文が返らないこと。
4. 期限切れ → `expired` がインボックスに見えること。プロンプトには出ないこと。
5. STOP-ALL 中の送信 → プロンプトに出ず、同期 denied（`STOP_ALL_ACTIVE`）でインボックスに理由つきで載ること。
6. 監査・ログに本文が出ないこと（既存の no-input-in-logs 規律に新ファイルを加える）。
7. 既存の MCP 承認フロー（同期ダイアログ）と run_agent の挙動が変わらないこと（Phase 1 R1 と同じ固定）。

## 7. 実装上の注意（Phase 1 からの引き継ぎ）

- Kotlin の新規ロジックは純粋な Core に切り出し、CI に乗る jest 文字列固定と併用する（Phase 1 R2）。
- Binder スレッドで重い処理をしない、UI を同期で待たない（R4）。前面化の検知は既存のアプリ状態購読を使う。
- run レコードの状態追加が既存の stale 規則・同時実行上限に波及しないこと（R7）。投入レコードは「live run」に数えない（Phase 1 どおり）。


---

## 実装で確定（2026-11-26、ブランチ `feat/launcher-ingress-p2`、Kotlin 未コンパイル・実機未検証）

本文（§0〜§7）は変更していない。以下は実装で決めた値と解釈。

### op 名（§4 P2-C1・C3）
- `get_launcher_submission` `{submissionId}`（`^ls_[0-9a-f]{32}$`）
- `list_launcher_submissions` `{limit?}`（整数 1〜50、既定 20。新しい順、保持期間内のみ）
- `mark_launcher_submission_consumed` `{submissionId}`
- 3 つとも「MCP: 型付き操作を許可」（`SHELLY_MCP_TYPED_OPS`、run_agent / put_stream_feed と同じスイッチ）が ON のときだけ一覧に出る。`APPROVAL_TOOLS` ではない（承認タップなし、常時許可も適用しない）。MCP サーバーは `typed-requests/` に積み、ネイティブの `McpTypedOpConsumer` だけが答える（RN へのハンドオフなし）。
- 判定順（`IngressDecision.STAGES`、TS 写し `lib/ingress-origin.ts`）：設定 → 引数 → epoch（MCP トークン）→ STOP-ALL。その後、`commitLock` とレコードのロックの下で epoch・設定・STOP-ALL・署名期限を再確認してから返す／書く。
- 読み手の principal：MCP トークン由来の 32 hex（Shelly の MCP principal は 1 つ）。principal ごとの登録は作っていない。

### 返すフィールド（P2-C2）
- `approved`：`submission_id`、`state`、`accepted_at`、`decided_at`、`correlation_ref`（あれば）、`instruction_text`（`get_launcher_submission` のみ）。
- それ以外（`pending_approval`・`denied_by_user`・`expired`・`consumed`・`stale`）：`submission_id`、`state`、時刻（`accepted_at`・`decided_at`・`consumed_at`）、`reason`（`awaiting_approval`／`denied_by_user`／`expired`／`consumed`／`stale`）。本文・`correlation_ref` は返さない。`submission_id` は問い合わせのキーなので全状態で返す（解釈）。
- `list_launcher_submissions` は状態を問わず本文を一切返さない（本文は `get` で 1 件ずつ、監査行つきで読む）。
- 本文は承認時点の SHA-256（レコードの `textSha256`）と一致するときだけ返す。一致しない・読めないときは `text_unavailable`。

### 消費（P2-C3）
- `approved`（`stale` でない）→ `consumed`（`consumedAt` を記録）。監査行を先に書き、書けなければ何もしない（`audit_failed`）。消費後に本文ファイルを削除する。
- 同じ id の再消費は `ok`＋`state: consumed`・`already_consumed: true`（冪等）。再読み取りは `consumed` を返し本文なし。
- `approved` 以外の消費は `not_approved`。

### STOP-ALL 中の reader（§4、判断）
- get / list / consume の 3 つとも `halted` で拒否する（MCP の既存の型付き op の判定順どおり。STOP-ALL 中は何も渡さない）。判定は `.halted` の lstat で ENOENT 以外の失敗も停止扱い（`StreamFeedStore.haltedStrict`）。

### 監査（P2-A2・C4、§6-6）
- 判断：既存の `launcher_submit_approved`（code `approved_user`／`approved_always`）、`launcher_submit_user_denied`（`denied_user`）。失効：`launcher_submit_expired`（`expired`、Phase 1 は失効時に行を書いていなかった）。いずれも Phase 1 の LauncherLine の固定フィールド（principal・cert digest・submission_id・correlation_ref・taint・テキストのハッシュと長さ）のみ。
- reader：新しい閉じた kind `launcher_submission_get`／`launcher_submission_list`／`launcher_submission_consume`（kind == event、`origin: mcp`、`principal`（32 hex）、`submission_id`、`code`、list は `count`）。本文・correlation_ref は書かない。行を書けない応答は返さない（`audit_failed`）。

### `stale` の扱い（§3）
- 派生状態で保存しない：`approved` かつ承認時刻（無ければ受理時刻）から 24 時間（`LauncherIngressLimits.STALE_AFTER_MS`）を超えたもの。自動削除はしない（保持期間で剪定されるまで残る）。
- reader は `stale` に本文を返さず、消費も `not_approved` で拒否する（解釈：一日以上誰も取らなかった指示を遅れて実行させない。必要ならランチャーから送り直す）。
- run チケットの stale 規則・live run の数え方・同時実行上限は変更なし（投入は引き続き `ls_` で、run の読み手はすべて `mr_` だけを見る）。

### インボックスの保持（P2-B3）
- 直近 50 件（`INBOX_MAX_RECORDS`）と 7 日（`INBOX_MAX_AGE_MS`）の短い方を、全 principal 合計で適用。新しい投入の書き込み時に剪定（判断待ちは件数では落とさない）、表示時にも同じ規則で絞る。Phase 1 の「24 時間・principal あたり 100 件」は投入レコードには適用しない（24 時間の `stale` 表示より前に消えないように）。
- 「即時拒否」（STOP-ALL・無効・上限超過・BUSY など、同期 `denied`）は Phase 1 どおり投入レコードを作らないので、監査ファイル末尾 256 KiB の `launcher_submit_denied` 行（検証済み＝launcher principal 付きのもののみ）から理由区分つきで表示する。
- 本文は判断待ちのプロンプトにだけ渡す（インボックスには出さない）。却下・失効・消費の時点で本文ファイルは削除する。

### 前面承認面（P2-A1・B1〜B5、§5 D8）
- 既存の `useMcpApprovalStore` に kind `submit_instruction` の要求として積み、既存の `McpApprovalModal` が表示する（ボタンは「許可しない／常に許可／許可」＝既存の deny／always／once）。新しい承認ストア・決定種別・ルール形式はない。ストアに足したのは「閉じる」（`dismiss`、何も決めない）だけ。
- 前面化（既存の AppState 購読、`hooks/use-launcher-approval.ts`）と前面中の 4 秒ごとの確認で、最古の未決 1 件を表示。判断すると次に古いものを表示。閉じると、次の前面化かインボックスからのタップまで自動では出さない。表示中に期限が来たら閉じる（判断なし、ネイティブ側で `expired`）。
- STOP-ALL 中はプロンプトを出さない。STOP-ALL 中や、送信後にランチャーの登録が無効化・削除・ピン変更された場合、「許可」「常に許可」はネイティブが拒否し（`halted`／`registration_changed`）、「許可しない」だけが通る。
- 「常に許可」は承認を記録した後、既存の C3 ルール（`launcher:<32hex>` × `submit_instruction` × `hayato`、bind なし）を `McpAlwaysAllowStore` に書く。設定の既存一覧に「ランチャー」として出て取り消せる。以後の投入が同期 `approved` になるのは D1 の免除条件を満たす（untainted）場合だけ（`LauncherIngressCore.decide` の既存の不変条件）。
- MCP トークンの再生成（`denyAll`）はランチャーのプロンプトを「却下」せず閉じるだけ（MCP トークンの配下ではないため）。
- 背面時の通知：保留を記録した直後、Provider は通知用の別スレッドに渡すだけ（Binder スレッドで待たない）。Shelly が前面でなければ「確認してください」通知（本文なし、`VISIBILITY_PRIVATE`、10 分でタイムアウト）を出し、タップで Shelly を開く。判断・失効で未決が 0 件になれば取り消す。
