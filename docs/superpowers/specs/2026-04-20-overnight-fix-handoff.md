# 2026-04-20 夜間修正ハンドオフ

**前提**: 2026-04-20 の desktop セッション (Opus 4.7 1M context)、ユーザー就寝中の夜間作業。デスクトップ Claude Code が実機 (Galaxy Z Fold6, wireless ADB) とのループで bug #101-113 + 派生リグレッションを潰した。

**このファイルが唯一の正**。起床後はここから読み始めて `docs/superpowers/DEFERRED.md` の現状欄と突き合わせる。不確実な断定は避け、実機検証していない箇所は「未検証」と明記した。

---

## 1. 夜間セッションでやったこと

### 1-1. Commit 履歴 (2026-04-20 03:00 JST 以降、main ブランチ)

| commit | ざっくり |
|---|---|
| `5e8c5d0b` | #104 診断ログ (behavior 無し) |
| `914b1052` | #111 LayoutPicker downgrade (p4 → p1 が選べる + disabled 削除 + 破棄件数表示) |
| `a6d1836b` | **後続で一部ロールバック**。#103 polling 3s→15s と #106 paste threshold 変更 — CJK 誤爆発覚 |
| `9c62ea07` | #112 focus auto-refocus の初期実装 (Modal close → `useFocusStore` tick) |
| `f038ee0c` | #106 threshold rollback (16/newline に戻す)、#113 scrcpy KEYCODE_UNKNOWN 救済、#111 session cascade cleanup、#112 CommandPalette/AddRepo/ProcessGuard に refocus 拡張、#108 addPane サイレント失敗を Alert 化 |
| `0e2ac6fa` | BASHRC_VERSION 40→41、#62 Stack key={locale} 再注入、#100 git config default、#105 codex-vendor shim、#102 TMPDIR/TMP/TEMP 3 本 belt-and-suspenders |

### 1-2. レビューパス

夜間中に**計 5 本**の review agent を流した:
1. Native (Kotlin/Java/C) 全域監査
2. TS/RN 全域監査
3. アーキテクチャ俯瞰
4. CLI adapter 固有対処の監査 (ユーザー指示「CLI とかの特定条件は外すな」に応じて)
5. 過去の解決済み bug が現状コードで壊れていないかの監査

検出されたリグレッションは**その場で修正、または handoff にメモ**。

---

## 2. 現在のビルド状態

- **`d613f78c`** (install 済、00:15:20 時点)
- **`24635607242`** (f038ee0c): **build FAILED** — `TerminalView.java:1269` で `sendTextToTerminal` が inner-class scope にしかなく outer `onKeyDown` から見えないコンパイル error
- `24635800179` / `24635864186` / `24635913877`: 同 error を継承するため build FAILED 見込み
- **`24635940831`** (d23165dd, コンパイル fix): `mTermSession.write(...)` に置換、ビルド中。**これが起床後 install すべき APK**

> 注: 確実を期すため、install 前に `gh run list --repo RYOITABASHI/Shelly --limit 5` で `24635940831` が `completed success` になっていることを必ず確認。

---

## 3. 解決 / 前進した bug

| bug | ざっくり fix | 要実機検証 |
|---|---|---|
| #62 | `<Stack key={locale}>` 復帰 — EN/JA 切替が runtime 反映 | ✅ 要 |
| #100 | 初回 shell で git identity 既定値 — auto-savepoint の 💾 が発火 | ✅ 要 |
| #103 | ContextBar + Sidebar ports/git polling を AppState gate + interval 緩和 | ✅ 要 |
| #105 | pipeline で `@openai/codex/vendor/.../codex/codex` に `libDir/codex_exec` を symlink — existsSync throw 回避 | ✅ 要 (`codex "hello"` で認証通った状態から再起動して依然 OK か) |
| #106 | my `a6d1836b` の whitespace 閾値を revert。保守的な `len>=16 or \n` に戻した | ✅ 要 (CJK 日本語 IME typing 正常) |
| #108 | addPane cap 到達時に Alert で理由明示 (`terminal_cap` / `layout_full`) | ✅ 要 |
| #111 | setPreset trim + doRemoveBySlot で `destroySession` + `removeSession` cascade | ✅ 要 |
| #112 | CommandPalette / Sidebar AddRepo / ProcessGuard / LayoutAddSheet / SettingsDropdown / ConfigTUI / VoiceChat 全 Modal で close 時 `useFocusStore.requestTerminalRefocus()` 発火 | ✅ 要 |
| #113 | TerminalView.onKeyDown の KEYCODE_UNKNOWN handler を拡張 — ACTION_DOWN で `event.getCharacters()` / `getUnicodeChar()` を拾い、length==1 は sendTextToTerminal、≥2 は pasteViaEmulator | ✅ 要 (scrcpy から打鍵再現) |

### 3-1. BASHRC_VERSION 41 が伝播する経路

- 既存ユーザー (`d613f78c` 入れてる人) が新 APK install
- 起動時に `HomeInitializer.initialize()` → `bashrc.exists() || currentVersion < 41` で .bashrc 再生成
- 新しい `CLAUDE_CODE_TMPDIR` + `TMPDIR/TMP/TEMP` + `git config default` が次の bash session から有効
- 次回 bash 起動で codex-vendor shim は pipeline 経由で作られる (`__shelly_bg_cli_update` が run する時)

**失敗パターン**: 古い `.install-marker` が残っていると pipeline 再 run されない可能性 → その場合 shim 作られず #105 再発。**起床後の検証項目**: `~/.shelly-cli/.install-marker` を削除して再起動、`codex` を起動してから `ls -la ~/.shelly-cli/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/codex/` で symlink 確認。

---

## 4. まだ完全には直っていない / 未着手

### 4-1. bug #102 — Claude Code `/login` の OAuth 400 (P0、mitigation のみ)

**現状**: CLAUDE_CODE_TMPDIR + TMPDIR/TMP/TEMP 3 本は export 済。しかし**「sed 後も 400 継続」**という元の症状が本当に tmpdir 由来かは不明。

**真因候補**:
- Samsung Internet ブラウザが OAuth URL の state / code_challenge を rewrite (loopback callback で verifier ミスマッチ)
- Node の `os.tmpdir()` 以外に PKCE state を書く subprocess / MCP サーバー
- claude-code 2.1.112 固有のバグ — 2.1.114 で直るかも、ただし 2.1.113+ は cli.js 消失で Tier 1 path が使えないため pin 外せない

**起床後アクション**:
1. 新 APK install 後に `claude /login` → 400 が消えるか
2. 消えなければ、**デフォルトブラウザを Chrome に切替**して再試行 (Samsung Internet 疑い切り分け)
3. それでも 400 なら `strace -f -e openat,connect` か `adb logcat | grep -iE 'claude|oauth'` を録って、PKCE state の write 先と token exchange リクエストの内容を確認
4. 恒久解は codex-login 方式 (pure-JS device auth) を claude にも作る、または shelly-browser pane 経由の in-app OAuth redirect

### 4-2. bug #101 — codex rustls native roots (P0、暫定のみ)

**現状**: CA bundle 5 本 export は v39 から、codex-login (device auth) の pure-JS 経路は動作するはず。`codex "hello"` 本体 (rustls-native-certs) は env 無視なので**動かない**。

**恒久解**: codex-termux を `rustls-tls-webpki-roots` feature で再ビルドする必要あり — **多日工程**、今夜は手を付けない。

### 4-3. bug #104 — keyboard 回避 (P0、診断のみ)

**現状**: `MultiPaneContainer` で `Keyboard.addListener('keyboardDidShow')` の endCoordinates を logInfo している (commit `5e8c5d0b`)。実機で値を見ていない。

**起床後アクション**:
1. 新 APK install → `adb logcat | grep '\[Keyboard\]'` 張った状態でキーボード開閉
2. `didShow raw=857 adjusted=813` 等が出れば「値は届いてるが padding 適用が壊れている」
3. `didShow raw=0` or 未発火なら `react-native-keyboard-controller` 導入 (設計側 Agent #3 の推奨)

### 4-4. shelly-cs ネイティブ SSH tunneling (P1、feat ブランチで Day 3 停止)

**現状**: main は Phase 1 minimum (list/create/open 等) のみ。SSH tunnel は `feat/ssh-tunneling` ブランチに Day 1-3 commit:
- Day 1: lazy-install scaffold (`shelly-cs.js` 内 npm install トリガー)
- Day 2 draft: tunnel-client library drop-in
- Day 2 wire-up: `--probe-tunnel` で WebSocket 確立
- Day 3: gRPC `StartRemoteServerAsync`

**Day 4/5 未完**: remote に code-server / sshd を立ち上げて SSH 握手、クライアント側ポート forward。

**判断**: feat ブランチは main にマージしない。リスク高、実機で検証できていない。

**起床後アクション**: SSH tunneling は別日対応。今夜は触らない旨を `DEFERRED.md` に明記する。

### 4-5. 設計上の綻び (中長期、今夜は対象外)

Agent #3 が指摘した 4 大負債:
1. **State ownership 4 層**: `terminal-store.sessions` / `multi-pane.slots[i].sessionId` / `pane-store.focusedPaneId` / native `sessionRegistry` — 整合検証なし
2. **TerminalPane.tsx 956 LoC**: 8 責務の神コンポ。`useNativeSessionLifecycle` 等への分解が必要
3. **`<ShellyModal>` wrapper 不在**: 各 Modal で refocus 手動発火 — 抜け漏れ発生中 (今夜 5 箇所 patch したが構造的再発リスクあり)
4. **BASHRC_VERSION 手動 bump**: SHA ベース invalidation に移行すべき

これらは v0.1.1 以降の refactor スプリントで扱う。今夜は触らない。

---

## 5. 実機残り hack (起床時に消えているかも)

`desktop-handoff.md` の hack と同じ条件が当てはまる:

| hack | 対象 | 消失条件 |
|---|---|---|
| codex vendor symlink | `~/.shelly-cli/.../codex/vendor/.../codex/codex` | post-install staging → live 置換。**新 APK で symlink pipeline に入ったので恒久化のはず** |
| claude cli.js sed (`/tmp/claude` → `.claude-tmp`) | `~/.shelly-cli/.../claude-code/cli.js` | post-install の npm install 再実行時に消える。**新 APK の TMPDIR 3 本はコード改変不要で env ベースの対策なので消えない** |

---

## 6. 新規発掘の bug / 整備で追加済

DEFERRED.md には以下を **新規追加する必要あり** (起床時にバッチで追記):

- **#107**: タスクキル後 ターミナル空描画 (session 再接続失敗) — 再現未確認、新 APK で解消の可能性あり
- **#108**: addPane サイレント失敗 — 本 handoff で Alert 追加済 (`LayoutAddSheet` / `AddPaneSheet` のみ)。CommandPalette / app/_layout.tsx / WorktreesSection は未対応 (HIGH follow-up)
- **#109**: PaneCliTabs の close [×] が極小 (size=9) — 誤タップ頻発。MaterialIcons size を 12 に、closeBtn 16×16、hitSlop 10 以上。未対応。
- **#110**: LayoutPicker サムネ視認性 (透明度 0.25 が暗すぎ) — 未対応
- **#111**: Layout p4 trap — **本 handoff で fix** (914b1052 + f038ee0c cleanup cascade)
- **#112**: Modal dismiss 後 focus loss — **本 handoff で fix** (9c62ea07 + f038ee0c)
- **#113**: scrcpy KEYCODE_UNKNOWN — **本 handoff で fix** (f038ee0c)

---

## 7. 起床後のチェックリスト

```
[ ] 新 APK が install 済か確認 (lastUpdateTime > 2026-04-20 03:00 JST)
[ ] `adb logcat -d | grep HomeInitializer | grep 'bashrc v'` で v41 regen 確認
[ ] `adb logcat -d | grep '\[install\] codex-vendor shim'` で shim OK 確認
[ ] `claude` 起動 → `/login` → 400 が出るかブラウザ起動するか
[ ] `codex "hello"` 起動 → ET_EXEC throw 解消、401 Unauthorized は許容 (rustls CA は別問題)
[ ] `gemini` 起動 → `/auth` で Google ブラウザ起動
[ ] サイドバー操作 + キー入力 — ラグが 3s 毎から消えたか (ContextBar polling 15s)
[ ] Modal 開閉 + タイピング — タップ無しで再開できるか (#112 検証)
[ ] 日本語 IME 確定 (`あいう` 等) — 誤って paste 扱いされないか (#106 検証)
[ ] LayoutPicker で p4 から p1 に戻る + 破棄数表示 — ソフトキーボード開きっぱなしでもタップ可能 (#111 検証)
[ ] scrcpy 起動して PC キーボードから打つ — 依然打てないなら UHID モードに切替
[ ] 💾 SaveBadge が点滅するか (#66 + #100 検証)
[ ] EN/JA 切替が runtime 反映 (#62 検証)
```

---

## 8. 次セッションのやり残し優先順 (手が空いたら)

1. **#102 claude OAuth 400** の真因特定 — strace / ブラウザ切替 / 2.1.114 検証
2. **#104 keyboard 回避** の diag 結果を見て恒久実装 (`react-native-keyboard-controller` 導入推奨)
3. **#109 close [×] サイズ拡大 + #110 LayoutPicker 視認性**
4. Agent #3 推奨の 3 件 refactor:
   - `<ShellyModal>` wrapper (IME inset + refocus 共通化)
   - `pane-store.focusedPaneId` を `multi-pane.focusedSlot` に統合
   - TerminalPane の session lifecycle を `useNativeSessionLifecycle` 単一フックに抽出
5. **shelly-cs SSH tunneling Day 4/5** — remote sshd 立ち上げ + ポート forward
6. **BASHRC_VERSION の SHA ベース invalidation** — 手動 bump 忘れ防止

---

**作成者**: デスクトップ Claude Code (Opus 4.7 1M context)
**セッション**: 2026-04-20 03:00 JST〜
**次担当**: ユーザー自身 or デスクトップ版次セッション
