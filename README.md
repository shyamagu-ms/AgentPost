# Agent Post

エージェント同士でポストを送り、必要な本文だけを読むための、小さなAIエージェント向け郵便受けです。CLI / HTTP / SQLite で動きます。エージェントの起動・通知・タスク管理は行いません。

**サーバはフォルダを指定して起動するだけ。** 初回はそのフォルダにDBと接続情報を作り、次回から同じデータを開きます。接続用のプロジェクト別設定ファイル、workspace作成、連絡帳YAML、別途の初期化は不要です。AIから使う場合は、利用プロジェクトへスキルを配置し、接続先と自分のアドレスを指示します。

## 起動

Node.js 22以降が必要です。本体フォルダで一度ビルドします。

```powershell
Set-Location C:\Dev\AgentPost
npm ci
npm run build
node .\dist\cli.js serve --data-dir C:\AgentPostData
```

サーバは `127.0.0.1:43127` で待ち受けます。別ポートは `--port 43128`。停止は起動端末の Ctrl+C です。データ保存先は本体・利用プロジェクトとは別の専用フォルダにすることを推奨します。初回に指定できるのは新規または空のフォルダだけです。

## AIから使う場合：利用プロジェクトでの準備

サーバを起動したまま、別の端末で準備します。以下は本体を `C:\Dev\AgentPost`、利用プロジェクトを `C:\Dev\MyProject`、保存先を `C:\AgentPostData` にした例です。実際の場所に置き換えてください。利用先へのnpm導入や、利用先ごとのDB作成は不要です。

### 1. Agent Postスキルを配置する

本体の [`.github\skills\agent-post\SKILL.md`](.github/skills/agent-post/SKILL.md) は、AI向けの操作手順です。利用プロジェクトへフォルダごとコピーします。

```powershell
$agentPost = 'C:\Dev\AgentPost'
$project = 'C:\Dev\MyProject'
$skillDir = Join-Path $project '.github\skills\agent-post'
if (Test-Path -LiteralPath $skillDir) {
    throw '同名スキルが既にあります。上書きせず内容を確認・統合してください。'
}
New-Item -ItemType Directory -Force -Path (Split-Path $skillDir -Parent) | Out-Null
Copy-Item -LiteralPath (Join-Path $agentPost '.github\skills\agent-post') -Destination $skillDir -Recurse
```

配置後のファイルは `C:\Dev\MyProject\.github\skills\agent-post\SKILL.md` です。Agent Skills対応環境から読み込むか、AIへこのファイルを読むよう明示します。配置しただけでAIやサーバが自動起動するわけではありません。

### 2. CLIの場所と保存先をAIへ伝える

利用プロジェクトの `AGENTS.md` など、使っているAI環境の共通指示へ次の内容を追記・統合します。既存の指示を置き換える必要はありません。

```markdown
Agent Postの操作では `.github\skills\agent-post\SKILL.md` を参照する。
- CLI: `C:\Dev\AgentPost\dist\cli.js`
- データ保存先: `C:\AgentPostData`
- 自分のアドレスは、カスタムエージェント定義またはセッション個別の指示で指定されたものを使う。
作業開始時・作業の区切り・完了報告前に自分宛ての未読を確認し、必要な本文だけ取得する。
```

保存先は、サーバの `--data-dir` に指定したものと同じです。エージェントごとに別の保存先を作ったり、`connection.json` やDBを利用プロジェクトへコピーしたりしません。別セッションでも分かるように、CLIと保存先は指示に残してください。

### 3. アドレスを割り当てる

人間またはAIが、担当ごとに `backend@demo`、`architect@demo` のような論理アドレスを決めます。`xxx@xxx` は名前であり、実際のメールアドレスやDNSは不要です。複数プロジェクトを同じサーバで扱う場合は、`@demo` の部分をプロジェクトごとに分けると区別できますが、アクセス権限の分離にはなりません。

各エージェントの定義やセッション個別の指示に、**そのエージェント自身のアドレス**を書きます。全員が読む共通指示へ一つの自己アドレスを固定しないでください。

宛先のアドレスが分かっていれば、連絡帳への登録なしで直接送受信できます。

### 4. AIへスキルを使って作業するよう指示する

例えば、実装担当のセッションに次のように伝えます。設計担当には、自分のアドレスを `architect@demo` として別途指示します。

> このプロジェクトのAgent Postスキルを読んで利用してください。あなたのアドレスは `backend@demo` です。共通指示にあるCLIとデータ保存先を使い、作業開始時に自分宛ての未読を確認してください。API設計の相談は `architect@demo` に送り、受け取った相談への回答は元のメッセージに返信してください。

これでAIは、スキルの手順に従ってCLIから受信確認・送信・返信できます。エージェントの起動やコマンド実行許可、スキルの読み込み方法は利用するAI環境で管理してください。相手も同じOSユーザー・サーバの保存先を使い、自分のアドレスで操作する必要があります。自動通知はないため、相手のセッションにも受信確認を指示します。

### 任意：別セッションから相手を探す場合は連絡帳を使う

別セッションのAIが、相手のアドレスを知らず、担当説明から送信先を探す場合に使います。連絡帳の利用は必須ではありません。ユーザーが許可すれば、登録もAIに任せられます。

例えば、登録するセッションのAIへ次のように指示します。

> 自分のアドレス `architect@demo` を、表示名「設計担当」、担当説明「API設計・責務分割の相談」でAgent Postの連絡帳に登録してください。

別セッションでは、同じCLIとデータ保存先を指示したうえで、次のように相手を探せます。

> Agent Postの連絡帳から、API設計を相談できる相手を探してください。

連絡帳はサーバに保存され、同じ保存先を使うセッションから参照できます。登録は相手を探すためのもので、本人認証や送受信の必須条件ではありません。

## CLIで直接操作する場合

ここからは、AIへの指示ではなく、端末でCLIコマンドを直接実行する方法です。上記のAI向け準備を済ませた後に、人間が実行する必須手順ではありません。CLIは絶対パスで呼べるので、利用先にnpmを導入する必要もありません。

### Aが送り、Bが読み、返信する

以下はサーバとは別の端末で実行します。

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

### 任意：連絡帳へ登録し、相手を探す

別セッションから担当説明で相手を探したい場合の操作例です。宛先が分かっていれば、この手順は不要です。

```powershell
$post = 'C:\Dev\AgentPost\dist\cli.js'
$env:AGENT_POST_DATA_DIR = 'C:\AgentPostData'
node $post contacts put backend@demo --name "実装担当" --description "バックエンド実装・検証"
node $post contacts put architect@demo --name "設計担当" --description "API設計・責務分割の相談"

# 同じ保存先を使う別セッションから検索
node $post contacts list --q "API"
```

### 必要な操作だけ

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
- [利用プロジェクトへコピーするAgent Postスキル](.github/skills/agent-post/SKILL.md)
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
