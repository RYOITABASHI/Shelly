# Shelly E2E Tests with Maestro

このディレクトリには、ShellyアプリのE2E（End-to-End）テストフローが含まれています。

## テストフロー一覧

### 日本語版（推奨）
アプリのデフォルトが日本語モードのため、以下の日本語版テストを使用してください。

1. **01_setup_wizard_ja.yaml** - セットアップウィザードの完全フロー
   - ようこそ → アプリインストール → 初期化 → 仕上げ → 完了

2. **02_chat_tab_ja.yaml** - チャットタブの機能テスト
   - テキスト入力
   - コマンド実行
   - タブ切り替え

3. **03_terminal_tab_ja.yaml** - ターミナルタブのテスト
   - ttyd接続確認
   - 日本語入力

4. **04_settings_tab_ja.yaml** - 設定タブの表示テスト
   - 各セクションの表示確認
   - 上級設定トグル

5. **05_bridge_recovery_ja.yaml** - ブリッジ切断時の復帰UIテスト
   - バナー表示確認
   - 再接続ボタン

### 英語版（参考）

1. **01_setup_wizard.yaml** - SetupWizardの完全フロー
2. **02_chat_tab.yaml** - Chatタブの機能テスト
3. **03_terminal_tab.yaml** - Terminalタブのテスト
4. **04_bridge_recovery_banner.yaml** - Bridge切断時の復帰UIテスト
5. **05_settings_tab.yaml** - Settingsタブの表示テスト

## 前提条件

- Maestro CLI 2.3.0以上がインストール済み
- Android Debug Bridge (adb) がパスに通っている
- Z Fold6がUSBデバッグモードで接続済み
- Shellyアプリがインストール済み

## テスト実行方法

### 環境変数設定（オプション）

```bash
# Maestro CLI パスを通す（初回のみ）
export PATH="$PATH:/c/Users/ryoxr/maestro/maestro/bin"
```

### adbパスを通す（オプション）

```bash
export PATH="$PATH:/c/android-sdk/platform-tools"
```

### 単一テストの実行

```bash
# チャットタブのテストを実行（日本語版）
cd /c/Users/ryoxr/maestro/maestro/bin
./maestro.bat test /c/Users/ryoxr/Shelly/.maestro/02_chat_tab_ja.yaml
```

### セットアップウィザードのテスト

```bash
# セットアップウィザードのテストを実行
# 注意: アプリデータをクリアして初期状態にしてから実行してください
cd /c/Users/ryoxr/maestro/maestro/bin
./maestro.bat test /c/Users/ryoxr/Shelly/.maestro/01_setup_wizard_ja.yaml
```

### 全テストの実行（日本語版のみ）

```bash
# 日本語版テストのみを実行
cd /c/Users/ryoxr/maestro/maestro/bin
./maestro.bat test /c/Users/ryoxr/Shelly/.maestro/*_ja.yaml
```

### デバイス確認

```bash
# 接続されているデバイスを確認
adb devices
```

## 注意事項

### セットアップウィザードテスト (01_setup_wizard_ja.yaml)

- **アプリデータをクリアして初期状態にしてから実行してください**
  ```bash
  adb shell pm clear space.manus.shelly.terminal.t20260224103125
  ```
- Termuxがインストール済みでないと、アプリインストール画面で停止します
- 実際のセットアップには数分かかる場合があります（初回は特に時間がかかります）

### チャットタブテスト (02_chat_tab_ja.yaml)

- Termux Bridgeが接続されていない場合、デモモードで動作します
- コマンド実行結果の確認は、接続状態に依存します

### Terminal タブテスト (03_terminal_tab.yaml)

- ttydがTermuxで起動している必要があります
- 接続できない場合、エラー画面が表示されますが、テストは継続します（optional要素を使用）

### Bridge Recovery バナーテスト (04_bridge_recovery_banner.yaml)

- Bridgeが切断されている場合のみバナーが表示されます
- 全ての要素が `optional: true` なので、接続済みでもテストは成功します

### Settings タブテスト (05_settings_tab.yaml)

- 全てのUI要素の表示確認のみ
- 設定値の変更はテストしません

## トラブルシューティング

### デバイスが認識されない

```bash
adb kill-server
adb start-server
adb devices
```

### テストが失敗する

- アプリの状態を確認（セットアップ完了しているか？）
- Termux Bridgeが起動しているか確認
- Maestroのログを確認（`--verbose` オプション）

```bash
./maestro.bat test --verbose /c/Users/ryoxr/Shelly/.maestro/02_chat_tab.yaml
```

### タイムアウトエラー

- `timeout` 値を増やす（特に初回セットアップ時）
- ネットワーク接続を確認（API呼び出しがある場合）

## Maestro Studioでの実行（GUI）

1. Maestro Studio (MaestroStudio.exe) を起動
2. デバイスを選択（RFCX71399SK）
3. YAMLファイルを開く
4. "Run" ボタンをクリック

## カスタマイズ

各YAMLファイルは編集可能です：
- `timeout` 値の調整
- `optional: true` で柔軟な検証
- `continueIf` で条件付き実行

詳細は[Maestro公式ドキュメント](https://maestro.mobile.dev/)を参照してください。
