# Cloud Integration — Google Drive OAuth + Dropbox/OneDrive 直リンク

**日付**: 2026-04-14
**親 spec**: `docs/superpowers/specs/2026-04-14-coming-soon-design.md` 機能 6
**ステータス**: 設計

---

## ゴール

Sidebar Cloud セクションを実装する。Google Drive は本格 OAuth 連携、Dropbox / OneDrive は Browser pane に飛ばすだけの 2 段構え。

## 非ゴール

- Dropbox / OneDrive の OAuth 実装
- Google Drive の write (作成/編集/削除)
- 大量ファイルのページング (最初の 20 件のみ)
- 画像プレビュー (DL 後に Preview pane 任せ)
- offline cache
- 複数アカウント

## 現状把握

- Sidebar の Cloud セクションは現状ダミー (`components/layout/Sidebar.tsx` の Cloud section)
- `expo-auth-session` / `expo-web-browser` が入っているか実装時に `package.json` で確認、無ければ追加
- `expo-secure-store` は既に入っている (API key editor で使用中)

## アーキテクチャ

```
┌──────────────────────────┐
│  Sidebar Cloud section   │
│  ┌────────────────────┐  │
│  │ 🔗 Google Drive    │  │  ← OAuth 未完了時
│  │    [ Sign in ]     │  │
│  └────────────────────┘  │
│  ┌────────────────────┐  │
│  │ 📁 GDrive / root   │  │  ← OAuth 完了時、files.list 結果
│  │    my-doc.md       │  │
│  │    photos/         │  │
│  └────────────────────┘  │
│  ┌────────────────────┐  │
│  │ 🔗 Open Dropbox    │  │  ← 直リンク
│  └────────────────────┘  │
│  ┌────────────────────┐  │
│  │ 🔗 Open OneDrive   │  │  ← 直リンク
│  └────────────────────┘  │
└──────────────────────────┘
```

## 使うライブラリ

**`expo-auth-session`** (PKCE flow 対応済み) を追加。既に依存ツリーにあるなら追加不要。

```bash
pnpm add expo-auth-session expo-crypto
```

`expo-crypto` は PKCE の code_challenge 生成に必要。

## CLIENT_ID の扱い

OSS なので **CLIENT_ID は同梱しない**。`lib/google-drive.ts`:

```ts
const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';

export function hasClientId(): boolean {
  return CLIENT_ID.length > 0 && CLIENT_ID !== 'REPLACE_ME';
}
```

README に以下を追記:

````markdown
## Google Drive integration (optional)

To enable Google Drive browsing in the Cloud sidebar section, you need
your own OAuth 2.0 Client ID:

1. Go to https://console.cloud.google.com/apis/credentials
2. Create project → OAuth 2.0 Client ID → Android (package name: dev.shelly.terminal)
3. Add the SHA-1 of your signing keystore
4. Copy the Client ID and paste it into `.env.local`:
   ```
   EXPO_PUBLIC_GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
   ```
5. Rebuild the APK

Without a Client ID, the Cloud sidebar shows Dropbox and OneDrive links
but Google Drive shows a "Not configured" banner.
````

Client ID 未設定時の UI:

```
┌────────────────────────┐
│ ⚠ Google Drive         │
│   Not configured       │
│   [ Setup guide → ]    │
└────────────────────────┘
```

"Setup guide" tap で README の該当セクションを Browser pane で開く。

## OAuth flow (PKCE)

1. ユーザーが Cloud セクションで `[Sign in with Google]` tap
2. `expo-auth-session` の `useAuthRequest` で auth URL 組み立て
   - scope: `https://www.googleapis.com/auth/drive.readonly openid email`
   - response_type: `code`
   - redirect_uri: `dev.shelly.terminal://oauth/callback` (custom scheme)
   - code_challenge: PKCE S256
3. `promptAsync()` で system browser 起動 → ユーザー認証
4. redirect を listen、`code` を抽出
5. `code` を `https://oauth2.googleapis.com/token` に POST で交換
   - client_id + code + code_verifier + redirect_uri + grant_type: `authorization_code`
6. レスポンスの `access_token` / `refresh_token` / `expires_in` を取得
7. SecureStore に保存:
   ```
   gdrive.access_token
   gdrive.refresh_token
   gdrive.expires_at  (epoch ms)
   ```
8. Sidebar Cloud section が re-render → file list 取得

## トークンリフレッシュ

```ts
async function getValidToken(): Promise<string | null> {
  const expiresAt = parseInt(await SecureStore.getItemAsync('gdrive.expires_at') ?? '0', 10);
  if (Date.now() < expiresAt - 30_000) {
    return await SecureStore.getItemAsync('gdrive.access_token');
  }
  // Refresh
  const refresh = await SecureStore.getItemAsync('gdrive.refresh_token');
  if (!refresh) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  await SecureStore.setItemAsync('gdrive.access_token', data.access_token);
  await SecureStore.setItemAsync('gdrive.expires_at', String(Date.now() + data.expires_in * 1000));
  return data.access_token;
}
```

## Files API

`GET https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)&q='root' in parents`

- root 直下の 20 件
- サブフォルダを tap したら `q='<folderId>' in parents` で再クエリ
- フォルダ navigation は Sidebar 内でやる (breadcrumb 付き、"← Up" 行)

## ファイルダウンロード

```ts
async function downloadFile(fileId: string, name: string): Promise<string> {
  const token = await getValidToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);
  const localPath = `${FileSystem.documentDirectory}shelly-gdrive/${name}`;
  await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}shelly-gdrive/`, { intermediates: true });
  await FileSystem.writeAsStringAsync(localPath, base64, { encoding: 'base64' });
  return localPath;
}
```

DL 後 `openFile(localPath)` で Preview pane に表示。

## データモデル

```ts
// store/google-drive-store.ts
type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  isFolder: boolean;
};

type GoogleDriveState = {
  isSignedIn: boolean;
  userEmail: string | null;
  currentFolderId: string;      // 'root' or folder id
  currentPath: string[];        // ['Root', 'Documents', …] for breadcrumb
  files: DriveFile[];
  loading: boolean;
  error: string | null;

  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  enterFolder: (id: string, name: string) => Promise<void>;
  goUp: () => Promise<void>;
};
```

token 本体は store に入れず SecureStore に置く。store が持つのは isSignedIn フラグとキャッシュのみ。

## UI コンポーネント

- `components/cloud/GoogleDriveAuthModal.tsx` — 初回認証ボタン + エラー表示
- `components/cloud/GoogleDriveList.tsx` — breadcrumb + file list (Sidebar 内で使う)
- `components/layout/Sidebar.tsx` — Cloud section の中身を書き換え

## Dropbox / OneDrive 直リンク

```tsx
<Pressable
  style={styles.cloudRow}
  onPress={() => openUrl('https://www.dropbox.com/home')}
>
  <MaterialIcons name="cloud" size={10} color={C.accentBlue} />
  <Text style={styles.cloudLabel}>OPEN DROPBOX</Text>
  <View style={styles.cloudSpacer} />
  <MaterialIcons name="open-in-new" size={I.externalLink} color={C.text2} />
</Pressable>
<Pressable
  style={styles.cloudRow}
  onPress={() => openUrl('https://onedrive.live.com')}
>
  <MaterialIcons name="cloud" size={10} color={C.accentSky} />
  <Text style={styles.cloudLabel}>OPEN ONEDRIVE</Text>
  <View style={styles.cloudSpacer} />
  <MaterialIcons name="open-in-new" size={I.externalLink} color={C.text2} />
</Pressable>
```

OAuth なし、ただのブックマーク。

## エラーハンドリング

| ケース | 対応 |
|---|---|
| CLIENT_ID 未設定 | Cloud section に "Not configured" バナー、Dropbox/OneDrive のみ表示 |
| User が auth をキャンセル | Sidebar は何もしない、"Sign in" ボタンのまま |
| token 交換失敗 | エラー toast、"Sign in" ボタンのまま |
| refresh 失敗 (revoked) | SecureStore 全消し、"Sign in" に戻る |
| files.list 401 | refresh → retry 1 回、それでもダメなら sign out 扱い |
| files.list 403 (quota) | "Quota exceeded, try later" toast |
| 大ファイル DL 中に back | fetch abort、キャッシュディレクトリ残さない |

## セキュリティ

- `drive.readonly` スコープ固定 (write 権限を要求しない)
- refresh_token は **SecureStore のみ**、メモリに平文で保持しない (毎回読む)
- redirect_uri は custom scheme `dev.shelly.terminal://oauth/callback` 固定 (localhost redirect は禁止)
- OAuth state パラメータで CSRF 防止 (expo-auth-session が自動対応)

## ファイル一覧

- `lib/google-drive.ts` (新規, ~200 行)
- `store/google-drive-store.ts` (新規, ~100 行)
- `components/cloud/GoogleDriveAuthModal.tsx` (新規, ~80 行)
- `components/cloud/GoogleDriveList.tsx` (新規, ~120 行)
- `components/layout/Sidebar.tsx` (編集 — Cloud section)
- `README.md` (編集 — CLIENT_ID セットアップ)
- `.env.example` (新規 — CLIENT_ID の型見本)
- `app.config.ts` (編集 — scheme: 'dev.shelly.terminal' が無ければ追加)

## 検証チェックリスト

- [ ] CLIENT_ID 未設定時: Cloud section に警告バナー + Dropbox/OneDrive のみ
- [ ] CLIENT_ID 設定時: Sign in ボタン tap → system browser で認証 → 戻って file list 表示
- [ ] files.list で root 20 件が出る
- [ ] フォルダ tap → 中身に入る、breadcrumb 更新
- [ ] "← Up" で戻れる
- [ ] ファイル tap → DL → Preview pane で開く (text ファイルで検証)
- [ ] Sign out → SecureStore から token 消える、Sign in に戻る
- [ ] app 再起動 → 既存 token でそのまま file list 表示
- [ ] Dropbox / OneDrive tap → Browser pane で開く
