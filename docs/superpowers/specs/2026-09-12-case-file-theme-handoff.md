# 2026-09-12 — "Case File" テーマ 実装引き継ぎ

## 経緯

ユーザーとの雑談から発展したUI検討。「Shellyのテーマをレトロ日本PC風にできないか」→「実機のX68000はネオングロー等のシンセウェイブ的演出とは違う」→最終的にユーザーが提示した参考画像（デスゲーム系ADVの「事件記録」データベースUI、紙質クリーム地+黒罫線+ドロップダウン密集）にたどり着き、方向性が固まった。

**モックアップ（Artifact、全バージョン履歴あり）**: https://claude.ai/code/artifact/4e3e56a4-34ac-4ff6-a088-6f2be1203f9c

最終形（v7時点）は Shelly の実レイアウト（AgentBar + 左ペイン履歴 + 中央本文パネル + 右ステータスボックス群）をそのまま踏襲し、配色をクリーム地(`#E8E3D0`)+黒罫線(`#2A2416`)のフラットな紙質デザインに、アイコンは絵文字ではなくモノクロ線画SVGに統一している。

## 実装済み（このセッション、リモート環境）

- `lib/theme-engine.ts` の `BUILTIN_THEMES` 配列に `case-file` テーマを追加（既存の30テーマと同じ `Theme` 型に準拠、色のみの変更でコンポーネント構造への影響なし）。
  - 配色はモックアップのトークンをそのまま転記: background `#E8E3D0` / surface `#F2ECD6` / surfaceAlt `#D9D0B0` / foreground `#201D16` / border・accent `#2A2416` など。ANSI 16色も同系統の彩度を落とした色で埋めている。
- `npx tsc` はこのリモート環境に `node_modules` が無いため実行不能（`expo missing`）。追加した object literal は既存エントリと構造が同一なので構文リスクは低いが、**ローカル/CI での `npx tsc --noEmit` 実走確認はまだ行っていない**。

## 未実装（ローカル/実機セッションでの継続を想定）

### 1. フォント（本命）

モックアップは本文に `BIZ UDGothic`、UIチャンク（ヘッダー/タブ/リスト/ステータスラベル）に `DotGothic16` を使い分けている。Shelly側の対応箇所:

- `store/cosmetic-store.ts` の `FontFamily` 型（現在 `'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'pixel-mplus' | 'press-start-2p' | 'silkscreen'`）に新しい値を追加する必要がある。
- 実フォントファイル（.ttf）を `assets/fonts/`（JS側）と `modules/terminal-view/android/src/main/assets/fonts/`（ネイティブ側、こちらが実際にターミナル描画に使われる）の両方に配置する必要がある。
- ネイティブ側のマッピングは `modules/terminal-view/android/src/main/java/expo/modules/terminalview/FontManager.kt` の `getTypeface()` 内の `when (family) { ... }` 分岐に新規 `family` 文字列 → asset パスのエントリを追加する形。既存パターン（`"pixel-mplus" -> "fonts/PixelMplus12-Regular.ttf"`）に倣う。
- BIZ UDGothic・DotGothic16 は Google Fonts で配布されており OFL ライセンスなのでバンドル自体は問題ないはずだが、ライセンス表記の要否は念のため確認すること。
- CLAUDE.md の設定表には「UI要素とテキスト要素でフォントを出し分ける」機能は現状無い（`fontFamily`/`crtFont` の2系統のみ）。モックのような「本文とUIチャンクで別フォント」を本当にやるなら、cosmetic-store に軸を1本追加する設計判断が要る（過剰設計にならないよう、まず本文・UI共通の単一フォント追加から始めるのも手）。

### 2. アイコン

モックでは絵文字（☁🔍⚙📎🎤等）を全てモノクロ線画SVGに置き換えている。Shelly本体側で同種の絵文字依存箇所（AgentBar・Sidebar・PaneInputBar 等）が実際にあるかは未調査。もしあれば同じ理由（環境によってカラー絵文字フォントで描画され意匠と衝突する）で置き換え候補になる。**このセッションでは未調査**。

### 3. 実機検証

CLAUDE.md の開発文化として、UI変更は実機スクリーンショット証跡を求められる（`terminalWallpaperTransparency` の例を参照）。今回のテーマ追加も:

- Z Fold6（またはその他実機）に `adb install` し、ConfigTUI からテーマを `Case File` に切り替えて実際の見た目がモックアップと近いか確認する。
- このリモート環境には adb・実機アクセスが無いため、**この工程はローカルセッションで行う想定**（ユーザーとの合意事項）。

## 次にやること（ローカルセッション向けの提案順）

1. `pnpm install` 後 `npx tsc --noEmit` で今回の `case-file` テーマ追加が型エラーを出さないことを確認。
2. フォント方針を決める（単一フォント追加 or 本文/UI出し分け設計）→ `.ttf` 入手・配置 → `FontManager.kt` 分岐追加 → `cosmetic-store.ts` の `FontFamily` 型拡張。
3. ConfigTUI からテーマ・フォントを選べることを確認し、実機スクショを撮ってモックアップと突き合わせる。
4. 絵文字アイコン依存箇所の棚卸し（該当があれば別タスクとして切り出し）。
5. 完了したら本ファイルの内容を要約して `DEFERRED.md` の該当エントリに `✅` を付けて完了記録し、README Status表への反映要否を確認。
