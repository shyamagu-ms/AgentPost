# Agent Post

エージェント同士でポストを送り、必要な本文だけを読むための、小さなローカル郵便受けです。CLI / HTTP / SQLite で動きます。エージェントの起動・通知・タスク管理は行いません。

**サーバはフォルダを指定して起動するだけ。** 初回はそのフォルダにDBと接続情報を作り、次回から同じデータを開きます。利用プロジェクトごとの設定ファイル、workspace作成、連絡帳YAML、別途の初期化は不要です。

## 起動

Node.js 22以降が必要です。本体フォルダで一度ビルドします。

```powershell
Set-Location C:\Dev\AgentPost
npm ci
npm run build
node .\dist\cli.js serve --data-dir C:\AgentPostData
```

サーバは `127.0.0.1:43127` で待ち受けます。別ポートは `--port 43128`。停止は起動端末の Ctrl+C です。データ保存先は本体・利用プロジェクトとは別の専用フォルダにすることを推奨します。初回に指定できるのは新規または空のフォルダだけです。

## Aが送り、Bが読み、返信する

以下はサーバとは別の端末で実行します。CLIは絶対パスで呼べるので、利用先にnpmを導入する必要もありません。

```powershell
$post = 'C:\Dev\AgentPost\dist\cli.js'
$env:AGENT_POST_DATA_DIR = 'C:\AgentPostData'

# A: 宛先が決まっていれば、連絡帳を見ずに直接送信
node $post send --as backend@demo --to architect@demo --subject "APIの相談" --body "この境界の設計を確認してください。"

# B: 本文なしの未読一覧 → 必要な本文 → 返信
node $post list --as architect@demo
node $post read <message-id> --as architect@demo --mark-read
node $post reply <message-id> --as architect@demo --body "この設計で進めてください。"

# A: Bからの返信を確認
node $post list --as backend@demo
node $post read <reply-id> --as backend@demo --mark-read
```

`<message-id>` は送信結果または一覧の `id` に置き換えます。環境変数を使わない場合は、各コマンドに `--data-dir C:\AgentPostData` を付けます。自分のアドレスは人間またはAIが割り当て、カスタムエージェント定義やセッションの指示に記載します。`xxx@xxx` は論理名であり、実際のメールアドレスやDNSは不要です。

## 必要な操作だけ

| 操作 | CLI |
|---|---|
| アドレス登録・更新 | `contacts put architect@demo --name "設計担当" --description "API設計・責務分割の相談"` |
| 相手を探す | `contacts list` / `contacts list --q "API"` |
| ポストする | `send --as backend@demo --to architect@demo --subject "相談" --body "本文"` |
| 自分宛て一覧 | `list --as architect@demo --status unread`（既定）/ `read` / `all` |
| 自分宛て全文 | `read <id> --as architect@demo` |
| 自分宛て状態更新 | `status <id> --as architect@demo --set read` / `unread` |
| 返信のショートカット | `reply <id> --as architect@demo --body "回答"` |

アドレスブックの表示名・担当説明から送信先を選ぶのは呼び出し元のAIまたは人間です。サーバは自動で適任者を判断しません。未登録宛てにも送信でき、その場合は結果に `recipient_registered: false` が返ります。送信だけでは連絡帳に登録されません。

一覧と本文取得は既読にしません。`read --mark-read` は全文取得に続けて明示的に既読更新します。既読は対応完了ではなく、同じアドレスを使う全セッションで共有されます。

## 保存先

```text
C:\AgentPostData\
  connection.json       接続先・自動生成トークン（秘密情報）
  agent-post.sqlite     アドレスブックとポスト
  agent-post.sqlite-wal 稼働中のSQLite補助ファイル
  agent-post.sqlite-shm 稼働中のSQLite補助ファイル
  server.jsonl          サーバ動作ログ（本文・トークンは記録しない）
  server.lock           起動中のPID・起動時刻（異常終了後は安全確認して自動回収）
  server.lock.sqlite    OSが異常終了時にも解放する排他制御用DB（削除しない）
```

ローカルの同じOSユーザー向けです。共有トークンと自己申告アドレスを使い、アドレスごとの本人認証は行いません。外部公開・ネットワーク共有上のDBは対象外です。通常の操作は自分宛てに限定しますが、悪意のある共有トークン保持者からの隔離は提供しません。

## 詳細

- [導入と運用](docs/setup.md)
- [CLI / HTTP API契約](docs/reference.md)
- [カスタムエージェントA → B → Aの試行](docs/trial.md)
- [検証範囲](docs/acceptance.md)
- [仕様](spec.md)
- [利用プロジェクトに統合する指示の例](examples/project/AGENTS.md)

## 開発

```powershell
npm ci
npm run typecheck
npm test
npm run test:package
```

依存バージョンと整合性ハッシュはlockfileで固定し、取得先は各環境のnpmレジストリ設定に従います。

`better-sqlite3` はネイティブ依存です。利用するNode.js / OS用のビルド済みバイナリがない場合は、PythonとC++ビルドツール（WindowsはVisual Studio Build Tools）が必要です。

## ライセンス

[MIT License](LICENSE)。Copyright (c) 2026 shyamagu-ms.
