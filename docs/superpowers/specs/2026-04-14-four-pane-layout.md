# 4-Pane Preset Layout 仕様

**作成日**: 2026-04-14
**対象リリース**: v0.1.1
**前提**: v0.1.0 で発覚したマルチペイン系バグ (#29 / #30 / #31) の構造的根治

## 背景

v0.1.0 のマルチペイン実装 (`hooks/use-multi-pane.ts`) は **任意ツリー構造 (PaneSplit + PaneLeaf の再帰)** を採用している。柔軟性は高いが、以下の構造的な問題を抱えることが実機スモークテスト (2026-04-14) で判明した:

- `splitPane` が元 leaf を `makeLeaf` で作り直すため leaf id が変化し、PaneSlot の React key が変わって PTY / WebView / AI session が喪失する (bug #29 part 2)
- Divider の hit area を負 margin で確保していたため Yoga の layout rect が net 0 になり、Android の hit test が通らずドラッグ不能だった (bug #30)
- Divider 修正で hit area が生きた途端、worklet から Zustand setter を直接呼ぶ実装が露出して TypeError で app が落ちた (bug #31)
- `AddPaneSheet` が `focusedPaneId` に依存しており、split 後の stale id で silent fail する問題 (bug #29 part 1)
- 任意ツリーなので N-1 本の Divider が発生し、Gesture.Pan の発火経路が組み合わせ爆発

任意ツリーの自由度は実質的にほぼ使われておらず、ユーザーがやりたいのは **「この配置パターンを選ぶ」** という離散的な選択に過ぎない。Samsung Z Fold6 の分割表示 UX (最大 3 ペイン + レイアウトパターンから選択) がまさにそれであり、Shelly はこれを踏襲しつつ **最大 4 ペイン + 自由な幅/高さ調整** を独自拡張として提供する。

## ゴール

1. **最大 4 ペイン** を表示できる (Fold6 の 3 ペイン上限を 1 枚超える)
2. **Fold6 の分割レイアウト UX を踏襲** する (ユーザーの学習コストゼロ)
3. **各ペインの幅・高さを自由に調整** できる (ドラッグバー)
4. **leaf id が生成後に絶対に変わらない** → PTY / WebView / AI session の喪失を構造的に不可能化
5. **Divider は最大 2 本** に固定 → gesture 発火経路が単純化、worklet 境界問題の表面積を最小化
6. **AsyncStorage 永続化 + migration** で既存ユーザーの任意ツリー state を無損失変換

## 非ゴール

- 5 ペイン以上の対応 (モバイル画面で認知負荷が過大)
- 自由な入れ子ツリー (現行の任意ツリー構造は廃止)
- プリセット外の不規則配置 (ユーザー定義レイアウト)

## データモデル

```ts
// components/multi-pane/types.ts または hooks/use-multi-pane.ts

export type PresetId =
  | 'p1'    // 1 ペイン全画面
  | 'p2h'   // 横 2 分割   [ A | B ]
  | 'p2v'   // 縦 2 分割   [ A / B ]
  | 'p3l'   // L 1 + R 2   [ A | B/C ]   Fold6 踏襲
  | 'p3r'   // L 2 + R 1   [ A/B | C ]   Fold6 踏襲
  | 'p3t'   // Top 1 + Bot 2 [ A / B|C ] 縦持ち時の Fold6 踏襲
  | 'p4';   // 2×2 グリッド [ A|B / C|D ] Shelly 独自

export type PaneTab = 'terminal' | 'ai' | 'browser' | 'preview' | 'markdown';

export type Slot = {
  id: string;       // 生成後に絶対に変えない。PaneSlot の React key と native binding のアンカー
  tab: PaneTab;
} | null;

export type MultiPaneState = {
  preset: PresetId;

  // 常に長さ 4。未使用は null。preset の容量より多く埋めてはいけない。
  slots: [Slot, Slot, Slot, Slot];

  // どのスロットに現在フォーカスがあるか。数値 index のみで id は持たない。
  focusedSlot: 0 | 1 | 2 | 3;

  // 各 preset が参照する比率。preset ごとに使うフィールドが違う。
  // 0.15 - 0.85 の範囲で clamp。
  ratios: {
    mainH: number;    // 横方向の主境界。p2h / p3l / p3r / p4 が使う
    mainV: number;    // 縦方向の主境界。p2v / p3t / p4 が使う
    rightV: number;   // 右列の内部境界。p3l が使う
    leftV: number;    // 左列の内部境界。p3r が使う
    bottomH: number;  // 下段の内部境界。p3t が使う
  };

  // 一時的にフルスクリーン表示しているスロット。null なら通常表示。
  maximizedSlot: 0 | 1 | 2 | 3 | null;
};
```

### 不変条件

- `slots[i]` が非 null である i の数 ≤ preset capacity (下記参照)
- `focusedSlot` は常に非 null の slot index を指す
- `ratios.*` は `[0.15, 0.85]` の範囲
- `slots[i].id` は一度生成したら state migration 以外で変更しない

### Preset capacity

| Preset | Capacity | 使うスロット |
|---|---|---|
| p1   | 1 | [0] |
| p2h  | 2 | [0, 1] |
| p2v  | 2 | [0, 1] |
| p3l  | 3 | [0, 1, 2] |
| p3r  | 3 | [0, 1, 2] |
| p3t  | 3 | [0, 1, 2] |
| p4   | 4 | [0, 1, 2, 3] |

## レイアウト定義

全プリセットの **絶対座標計算** を一箇所にまとめる。container のサイズ `(W, H)` を受け取り、各スロットの rect `{ x, y, w, h }` と Divider 配置を返す純関数にする。

### p1 — 1 ペイン

```
┌─────────────────┐
│                 │
│       0         │
│                 │
└─────────────────┘
```

```ts
slot[0] = { x: 0, y: 0, w: W, h: H }
dividers = []
```

### p2h — 横 2 分割

```
┌────────┬────────┐
│        │        │
│   0    │   1    │
│        │        │
└────────┴────────┘
```

```ts
mx = mainH * W
slot[0] = { x: 0,  y: 0, w: mx,     h: H }
slot[1] = { x: mx, y: 0, w: W - mx, h: H }
dividers = [{ kind: 'vertical', x: mx, y: 0, h: H, ratioKey: 'mainH' }]
```

### p2v — 縦 2 分割

```
┌─────────────────┐
│        0        │
├─────────────────┤
│        1        │
└─────────────────┘
```

```ts
my = mainV * H
slot[0] = { x: 0, y: 0,  w: W, h: my }
slot[1] = { x: 0, y: my, w: W, h: H - my }
dividers = [{ kind: 'horizontal', x: 0, y: my, w: W, ratioKey: 'mainV' }]
```

### p3l — L 1 + R 2 (Fold6 踏襲)

```
┌────────┬────────┐
│        │   1    │
│   0    ├────────┤
│        │   2    │
└────────┴────────┘
```

```ts
mx = mainH * W
ry = rightV * H
slot[0] = { x: 0,  y: 0,  w: mx,     h: H }
slot[1] = { x: mx, y: 0,  w: W - mx, h: ry }
slot[2] = { x: mx, y: ry, w: W - mx, h: H - ry }
dividers = [
  { kind: 'vertical',   x: mx, y: 0,  h: H,     ratioKey: 'mainH' },
  { kind: 'horizontal', x: mx, y: ry, w: W-mx,  ratioKey: 'rightV' },
]
```

### p3r — L 2 + R 1 (Fold6 踏襲)

```
┌────────┬────────┐
│   0    │        │
├────────┤   2    │
│   1    │        │
└────────┴────────┘
```

```ts
mx = mainH * W
ly = leftV * H
slot[0] = { x: 0,  y: 0,  w: mx,     h: ly }
slot[1] = { x: 0,  y: ly, w: mx,     h: H - ly }
slot[2] = { x: mx, y: 0,  w: W - mx, h: H }
dividers = [
  { kind: 'vertical',   x: mx, y: 0,  h: H, ratioKey: 'mainH' },
  { kind: 'horizontal', x: 0,  y: ly, w: mx, ratioKey: 'leftV' },
]
```

### p3t — Top 1 + Bot 2 (縦持ち Fold6 踏襲)

```
┌─────────────────┐
│        0        │
├────────┬────────┤
│   1    │   2    │
└────────┴────────┘
```

```ts
my = mainV * H
bx = bottomH * W
slot[0] = { x: 0,  y: 0,  w: W,      h: my }
slot[1] = { x: 0,  y: my, w: bx,     h: H - my }
slot[2] = { x: bx, y: my, w: W - bx, h: H - my }
dividers = [
  { kind: 'horizontal', x: 0,  y: my, w: W,   ratioKey: 'mainV' },
  { kind: 'vertical',   x: bx, y: my, h: H-my, ratioKey: 'bottomH' },
]
```

### p4 — 2×2 グリッド (Shelly 独自)

```
┌────────┬────────┐
│   0    │   1    │
├────────┼────────┤
│   2    │   3    │
└────────┴────────┘
```

```ts
mx = mainH * W
my = mainV * H
slot[0] = { x: 0,  y: 0,  w: mx,     h: my }
slot[1] = { x: mx, y: 0,  w: W - mx, h: my }
slot[2] = { x: 0,  y: my, w: mx,     h: H - my }
slot[3] = { x: mx, y: my, w: W - mx, h: H - my }
dividers = [
  { kind: 'vertical',   x: mx, y: 0,  h: H, ratioKey: 'mainH' },
  { kind: 'horizontal', x: 0,  y: my, w: W, ratioKey: 'mainV' },
]
```

### Divider の最大本数

| Preset | 本数 |
|---|---|
| p1   | 0 |
| p2h  | 1 |
| p2v  | 1 |
| p3l  | 2 |
| p3r  | 2 |
| p3t  | 2 |
| p4   | 2 |

**最大 2 本** に固定されるのが任意ツリー実装との本質的な差。Gesture.Pan の発火経路が高々 2 で、runOnJS のペアも 2 組で済む。

## アクション (reducer)

```ts
type Action =
  | { type: 'addPane';     tab: PaneTab }
  | { type: 'removePane';  slotId: 0 | 1 | 2 | 3 }
  | { type: 'setPreset';   preset: PresetId }
  | { type: 'setTab';      slotId: 0 | 1 | 2 | 3; tab: PaneTab }
  | { type: 'focusSlot';   slotId: 0 | 1 | 2 | 3 }
  | { type: 'setRatio';    key: keyof Ratios; value: number }
  | { type: 'resetRatio';  key: keyof Ratios }
  | { type: 'maximize';    slotId: 0 | 1 | 2 | 3 | null };
```

### addPane(tab)

1. 現在の preset capacity に空きがあれば (`slots` に `null` が残っていれば)、**最小 index の null** に `{ id: genId(), tab }` を詰める
2. 空きが無ければ **preset を 1 段昇格**:
   - `p1 → p2h` (デフォルト。横分割を標準とする)
   - `p2h → p3l`
   - `p2v → p3t`
   - `p3l → p4`
   - `p3r → p4`
   - `p3t → p4`
   - `p4 → noop` (トーストで「最大 4 枚です」)
3. 昇格後、新しく使えるようになった slot index に詰める
4. `focusedSlot` を新規追加した slot に移す

### removePane(slotId)

1. `slots[slotId] = null`
2. 残っている非 null slot 数が現 preset capacity 未満なら **preset を 1 段降格**:
   - p4 → 残 3 なら p3l (デフォルト)
   - p3l/p3r/p3t → 残 2 なら p2h (デフォルト)
   - p2h/p2v → 残 1 なら p1
3. 降格時は **使っているスロットを左詰め** する (新 slot index への再配置)。**leaf id は保持**。
4. `focusedSlot` が removed slot を指していたら、最小の非 null index に移動
5. 最後の 1 枚は削除不可 (`removePane` を無視)

### setPreset(newPreset)

1. 使用中スロット数 > 新 preset capacity ならエラー (トースト「現在のペイン数が多すぎます」) で noop
2. capacity 以下なら、現在のスロットを **左詰め再配置** して新 preset に適用
3. ratios は保持

### setRatio(key, value)

1. `value` を `[0.15, 0.85]` でクランプ
2. `ratios[key] = clamped`
3. Gesture.Pan の worklet から `runOnJS` 経由で呼ぶ

### resetRatio(key)

1. `ratios[key] = 0.5`

### maximize(slotId)

1. `maximizedSlot = slotId`
2. `MultiPaneContainer` は maximizedSlot が非 null のとき該当 slot のみ全画面描画
3. `maximize(null)` で解除

## UI コンポーネント構成

### `hooks/use-multi-pane.ts` (書き換え)

- Zustand store で `MultiPaneState` を管理
- 全 action を純関数 reducer として実装
- AsyncStorage persist middleware で `slots[].id` を含めて丸ごと永続化
- migration (旧ツリー → 新 flat): 旧 root を DFS で走査して先頭から 4 枠に詰める。余った leaf は捨てる (or 最後の slot に merge)

### `components/multi-pane/MultiPaneContainer.tsx` (書き換え)

- `useMultiPaneStore` から state を購読
- container を `onLayout` で計測し `(W, H)` を state に保持
- preset に応じた `getLayout(preset, ratios, W, H)` を呼んで `{ slotRects, dividers }` を得る
- 各 slot は `<View style={{ position: 'absolute', ...rect }}>` で配置
- 各 slot 内で `<PaneSlot leafId={slot.id} tab={slot.tab} ... />` を描画
- dividers は `<Divider>` コンポーネントを絶対配置

### `components/multi-pane/Divider.tsx` (新規 or 書き換え)

- props: `{ kind: 'vertical' | 'horizontal'; rect; ratioKey; onRatioChange; onReset }`
- `Gesture.Pan()` で `runOnJS(onRatioChange)(key, newRatio)` を呼ぶ
- `Gesture.Tap().numberOfTaps(2)` で `runOnJS(onReset)(key)`
- hit area は rect + 周囲 8px の絶対座標。負 margin は使わない
- grip は rect の中央に `<View>` で配置

### `components/multi-pane/AddPaneSheet.tsx` (簡素化)

- タブ選択のみ。配置ロジックは持たない
- `onSelect(tab)` → `useMultiPaneStore.getState().addPane(tab)` を呼ぶだけ
- 現行の `focusedPaneId` / `splitPane` / `leafExists` ロジック削除

### `components/multi-pane/LayoutPicker.tsx` (新規)

- 現在の preset を表示
- 7 preset の thumbnail をグリッド表示
- タップで `setPreset` 発火
- capacity オーバー時は disabled + ツールチップ

### `components/multi-pane/PaneSlot.tsx` (無変更)

- leaf id が不変になるので React key 問題が消える。既存実装をそのまま流用できる

## 永続化と migration

```ts
// store/multi-pane-persist.ts

type PersistedV1 = {
  version: 1;
  // 旧ツリー構造 (PaneSplit + PaneLeaf)
  root: PaneNode;
  maxPanes: number;
};

type PersistedV2 = {
  version: 2;
  preset: PresetId;
  slots: [Slot, Slot, Slot, Slot];
  focusedSlot: 0 | 1 | 2 | 3;
  ratios: Ratios;
  maximizedSlot: 0 | 1 | 2 | 3 | null;
};

function migrateV1toV2(v1: PersistedV1): PersistedV2 {
  // DFS で左から最大 4 枚の leaf を拾う
  const leaves: PaneLeaf[] = [];
  function walk(n: PaneNode) {
    if (leaves.length >= 4) return;
    if (n.type === 'leaf') { leaves.push(n); return; }
    walk(n.children[0]); walk(n.children[1]);
  }
  walk(v1.root);

  const slots: [Slot, Slot, Slot, Slot] = [null, null, null, null];
  leaves.slice(0, 4).forEach((l, i) => {
    slots[i] = { id: l.id, tab: l.tab };
  });

  // leaves 数に合わせてデフォルト preset を選ぶ
  const preset: PresetId =
    leaves.length <= 1 ? 'p1' :
    leaves.length === 2 ? 'p2h' :
    leaves.length === 3 ? 'p3l' :
    'p4';

  return {
    version: 2,
    preset,
    slots,
    focusedSlot: 0,
    ratios: { mainH: 0.5, mainV: 0.5, rightV: 0.5, leftV: 0.5, bottomH: 0.5 },
    maximizedSlot: null,
  };
}
```

## bug 対応マッピング

| Bug | 旧実装での原因 | 新実装でどう直るか |
|---|---|---|
| #29 part 1 | AddPaneSheet が stale `focusedPaneId` を使っていた | AddPane は preset + 空 slot index だけを見るので focus は無関係 |
| #29 part 2 | `splitPane` が `makeLeaf` で id を作り直していた | id は生成時のみ。以後 reducer は id を触らない |
| #30 | Divider の `marginHorizontal: -8` で layout rect が net 0 | Divider は常に絶対座標。負 margin 使用禁止 |
| #31 | Gesture.Pan の worklet から Zustand setter を直接呼んだ | `runOnJS(applyRatio)` で JS thread に hop。Divider は最大 2 本なので worklet 境界も 2 つだけ |

## 実装見積

| タスク | 行数 | 時間 |
|---|---|---|
| `use-multi-pane.ts` 書き換え (reducer + persist + migration) | 300 | 2 h |
| `getLayout(preset, ratios, W, H)` 純関数 | 120 | 1 h |
| `MultiPaneContainer.tsx` 書き換え | 180 | 1 h |
| `Divider.tsx` 抽出 + 書き換え | 100 | 0.5 h |
| `LayoutPicker.tsx` 新規 | 120 | 1 h |
| `AddPaneSheet.tsx` 簡素化 | -50 | 0.5 h |
| tsc + 手動 smoke | — | 1 h |
| 実機 smoke (全 preset + 全 action) | — | 1 h |
| **合計** | | **7 h** |

## スモークテスト観点 (実装後)

1. **各 preset の描画** — p1/p2h/p2v/p3l/p3r/p3t/p4 全部で slot 内容が正しく見える
2. **preset 間遷移** — addPane で自動昇格、removePane で降格、setPreset で手動切替
3. **Divider ドラッグ** — 全 preset で最大 2 本のハンドルが動く、0.15-0.85 でクランプ
4. **ID 不変** — 4 ペインまで埋めた後、preset 切替してもターミナルの PTY が生き続ける
5. **maximize / restore** — 各 slot でフルスクリーン切替
6. **migration** — 旧任意ツリー state を持つユーザー (v0.1.0 ビルドでインストール済) を v0.1.1 に上げたとき無損失で遷移
7. **永続化** — アプリ kill & 再起動で preset + ratios + slot.id + maximizedSlot が復元される

## Known limitations (v0.1.1 時点)

- 5 ペイン以上は出せない (Fold6 の 3 超え + 1 枚のみが Shelly の拡張範囲)
- 旧任意ツリーで深くネストさせていた場合、migration で 5 番目以降の leaf は落とされる
- 片方の slot が `terminal` 2 枚になる変則構成も現行 2 枚制約 (Android phantom process killer) を継続維持

## 今後の拡張候補 (v0.2.0 以降)

- ペインのドラッグ & ドロップで slot を入れ替える
- ペインの tab type 変更 (terminal ↔ ai ↔ browser) を slot 内で完結
- preset thumbnail の自動プレビュー (ユーザーが選ぶ前にどうなるか見せる)
