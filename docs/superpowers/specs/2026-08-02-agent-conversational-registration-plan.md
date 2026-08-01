# エージェント登録フローのLLMファースト化（Hermes Agent型への転換）

## Context

このセッションで既にX connector（OAuth/Articles）とLLMフォールバックの拡張（`platformHint`/`autonomousIntent`/`autonomous`スロット）を実装したが、ユーザーから根本的な指摘が入った: 今日の変更は「Shellyの固定パイプラインが主で、LLMは狭いツールとして呼ばれるだけ」という構造のままで、Hermes Agent（比較対象OSSエージェント）とは違う。Hermesはタスク登録時にHermes側の決定論的な事前判断が入らず、**LLM自身が会話全体を主導し、多ターンで自分の言葉で聞き返し、最終的な登録内容を組み立てる**。これはWeb調査（DeepWiki解析）で裏付け済み: Hermesにはタスク登録専用の決定論的事前解析・分類器コンポーネントは存在しない。

目的: Shellyのエージェント登録フローを、決定論パーサーが主導する構造から、LLMが会話を主導する構造に転換する。ただし、①ローカルLLM不在時でも動作すること、②危険な操作（webhook/cli等）の安全性を落とさないこと、③既存300件超のテスト資産・確認UI（人間の最終Confirmタップ）は変更しないこと、が譲れない前提。

## 中核設計: 3段階（Tier）モデル

```
Tier 1: 高速パス（決定論、LLM呼び出しゼロ） — parseAgentNL が全フィールドを高確信度で解決 → 即確認へ
Tier 2: 狭いスロットフィル（既存のまま） — 1フィールドだけ不足 → 固定テンプレ質問1問ずつ
Tier 3: LLM主導の会話型登録（NEW） — 曖昧な場合、LLMが会話全体を主導し自分の言葉で聞き返す
```

**既存コードは何も捨てない**。`lib/agent-nl-parser.ts`・`lib/agent-slot-fill.ts`・`lib/agent-llm-fallback.ts`の狭い抽出は全てTier 1/2の権威ソース、かつTier 3の「ヒント供給源」「全滅時のフォールバック先」として生き残る。300件超の既存テストは無改変でgreenを維持する設計。

### Tier 3 の状態管理 — 新しいステートマシンを増やさない

`store/ai-pane-store.ts`の`PendingAgentSession`（既に`phase: 'slot-fill' | 'await-confirm'`, `attemptCounts: Record<string, number>`を持つ）に`phase: 'llm-conversation'`を追加するだけ。会話履歴は`ai-pane-store`の既存`ChatMessage[]`をそのまま使い、`hooks/use-ai-pane-dispatch.ts`の既存`toOpenAIHistory()`（175行）と同型の抽出関数で組み立てる（通常のAIチャットと同じ「フル履歴投げ直し」方式）。

### Tier 3 の出口 — 既存パイプラインへ完全合流

LLMの最終提案は新しい広域バリデータ`mergeConversationalExtractionIntoDraft()`で`ParsedAgentDraft`に変換し、`presentDraftForConfirmation()`（`hooks/use-ai-pane-dispatch.ts:353`）に合流。`AgentConfirmCard`/`AgentChatConfirm`/`confirmAgentDraft`/capability broker は**1行も変更しない**（`draftToConfirmedAgentDraft`はaction種別非依存で透過することを確認済み）。

## 安全性の考え方の転換（重要）

「LLMが提案できるフィールドを狭く制限する」→「LLMは何でも提案してよいが、(a) connector/secret参照は必ず実在照合、(b) 人間の最終Confirmタップ不動、(c) 実行時ディスパッチ（capability broker等）完全不変」という3点で担保する方針に転換する。

- (b)(c)は元々このコードベースの不動原則で、コスト変更ゼロで維持できる。
- 新規リスクはハルシネーション（会話に無いURL/コマンドをLLMがもっともらしく生成）。対策は**段階的スキーマ拡大**（Phase制、下記）と、高リスクaction（webhook/cli/app-act）限定の**verbatim-substringガード**（`requireVerbatimSubstringMatch()` — LLM提案の危険文字列は会話の生テキストに実在する部分文字列でなければ採用しない）。

## フェーズ分け

### Phase 0 — 基盤（非破壊、dispatch配線なし）
- `store/ai-pane-store.ts`: `PendingAgentSession.phase`に`'llm-conversation'`追加（型のみ）
- 新規`lib/agent-conversational-registration.ts`: システムプロンプト構築・ターン応答パーサー・広域マージ関数（**draft/notifyのみ**対応、既存`mergeLlmExtractionIntoDraft`の設計思想=スケジュール再検証・`resolvePlatformHintConnector`実在照合・fail-closedを踏襲）
- 新規`__tests__/agent-conversational-registration.test.ts`: プロンプト生成、フェンス検出、フィールド検証の単体テスト

### Phase 1 — Tier 3 配線（初回ディスパッチ、draft/notifyのみ）
- `hooks/use-ai-pane-dispatch.ts`: `isLowConfidenceAgentDraft`分岐（1404行付近）をTier 3昇格に置き換え。新規`llm-conversation`ルーティングブロックを`await-confirm`分岐（737-877行）と対称な構造で追加
- `store/settings-store.ts`: `agentConversationalRegistrationEnabled`（default **false**）追加、既存の`widgetAgentRegistrationNoConfirm`と同じopt-in慣習に倣う
- プロバイダ呼び出し: `lib/agent-capability-answer.ts`のフォールバックチェーンパターンを参考に、クラウド優先（Groq/Cerebras等の高速API→ローカル最後）の`runConversationalRegistrationTurn()`を実装。全滅時は即座にTier 2（`nextMissingSlot`固定テンプレ）へフォールバック
- 実機検証: フラグOFF→ONで既存動作に回帰がないことを確認してからマージ

### Phase 2 — Tier 2行き詰まり時の昇格 + social-post拡張
- スロットフィル再開ブランチ（1119-1195行）の狭いリトライ失敗後にTier 3昇格を追加
- `actionType`許可集合に`social-post`を追加（`resolvePlatformHintConnector`再利用、connectorId/secretはLLMが直接生成不可のまま）

### Phase 3 — autonomous統合
- システムプロンプトに`nextMissingSlot`の既存autonomous判定条件を自然文で埋め込む
- 最終提案直前に、autonomous判定条件だけを1回再チェックする安全網（LLMの聞き忘れ対策。既に設定済みならスキップ、二重に聞かない）

### Phase 4（オプション・別フラグ・当面default false推奨） — webhook/cli/app-act拡張
- `requireVerbatimSubstringMatch()`実装（transcriptTextは「Tier 3セッション開始以降のユーザー発言のみ」に限定、LLM自身の過去出力を根拠にできないようにする）
- `agentConversationalHighRiskActionsEnabled`（default false）で独立ガード
- ハルシネーション対策特化のテスト（会話に無い文字列を提案させて棄却されることを確認）

### Phase 5 — 整理
- Phase 1で置き換えた狭い`extractAgentFieldsWithLlm`呼び出しは削除せず、Tier 3全滅時の正式なフォールバック経路としてdocコメントを更新するのみ

## 重要な制約

- **人間の最終Confirmタップは絶対省略しない**（不動の原則）
- ローカルLLM不在・タイムアウト時のfail-closedを必ず維持
- i18n（日英）対応、既存の`slot_fill.*`/`agentplan.*`命名規則を踏襲
- 既存テストは無改変でgreenを維持（新規ロジックは`lib/agent-conversational-registration.ts`に集約）

## Critical Files
- `lib/agent-llm-fallback.ts`（安全策の踏襲元: `mergeLlmExtractionIntoDraft` 553-702行）
- `lib/agent-nl-parser.ts`（Tier 1、無改変）
- `lib/agent-slot-fill.ts`（Tier 2、無改変）
- `lib/agent-plan-summary.ts`（`hasDraftAssumptions`/`shouldAutoRegisterDraft`/`draftToConfirmedAgentDraft`、無改変で安全弁として効く）
- `hooks/use-ai-pane-dispatch.ts`（配線変更の中心）
- `store/ai-pane-store.ts`（`PendingAgentSession`型拡張1箇所）
- `lib/local-llm.ts`（`ollamaChat`、function-calling非対応を前提にプロンプト+パース方式を継続）
- 新規: `lib/agent-conversational-registration.ts`

## 検証方法
- 各PhaseでJest実行（新規テスト + 既存300件超の回帰確認）+ `npx tsc --noEmit`
- Phase 1完了後、Fable5に実機検証を依頼（フラグON状態で、曖昧な発話に対しLLMが自分の言葉で聞き返すことを確認）
- ローカルLLM未起動状態でのfail-closed動作（Tier 2への降格）も実機で確認
