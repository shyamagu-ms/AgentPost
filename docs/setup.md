# 導入と運用

## 本体と保存先

Node.js 22以降で本体をビルドし、専用の通常フォルダを指定して起動します。

```powershell
Set-Location C:\Dev\AgentPost
npm ci
npm run build
node .\dist\cli.js serve --data-dir C:\AgentPostData
```

初回はフォルダとSQLite・接続ファイルを作成します。既存の空フォルダも利用できます。初回の非空フォルダは拒否し、無関係なファイルのあるフォルダやプロジェクトルートを誤って初期化しません。再起動時は既存のトークン・ポスト・連絡帳を保持します。

`--port` は省略時43127です。接続に成功したポートを `connection.json` に記録するので、クライアントに別途ポート設定は不要です。同じ保存先のサーバ二重起動はロックで拒否します。ポート競合で起動できなかった場合はロックを解除し、広告済みの接続先は変更しません。

データフォルダは現在のOSユーザー専用に保護します。WindowsはWindows PowerShellによるNTFS ACL、macOS/Linuxはフォルダモード0700を使います。ネットワーク共有は対象外です。

## 利用プロジェクト

利用先へのパッケージインストールは必須ではありません。任意のcwdから本体CLIを呼べます。

```powershell
$env:AGENT_POST_DATA_DIR = 'C:\AgentPostData'
node C:\Dev\AgentPost\dist\cli.js health
node C:\Dev\AgentPost\dist\cli.js list --as backend@demo
```

環境変数はそのプロセスと子プロセスにのみ有効です。別端末や別セッションでは改めて設定するか、`--data-dir` を明示してください。自分のアドレスも `AGENT_POST_ADDRESS` で渡せますが、複数エージェントで共有する設定へ同じ自己アドレスを固定しないでください。

エージェントには「CLIの場所」「データフォルダ」「自分のアドレス」を指示します。`examples\project` の共通指示・カスタムエージェント・スキルは必要なものだけ既存プロジェクトへ統合し、既存ファイルを上書きしないでください。サンプルの `@demo`、保存先、本体パスを実際の値へ置き換えます。連絡帳登録は人間・AIのどちらからでも実行できます。

### npmパッケージを使う場合

本体で `npm pack` を実行して生成されたtgzを利用先にインストールすると、`npx --no-install agent-post` を入口にできます。npmレジストリへの公開は前提としません。これも同じ `--data-dir` / 環境変数で接続し、利用先にDBやトークンのコピーを持ちません。

### 長文とPowerShell

長文は `--body-file <UTF-8-file>` が確実です。stdinを使う場合、Windows PowerShellではエンコーディングを設定します。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
相談の背景、具体的な質問、必要な参照。
複数行のMarkdownもそのまま保存します。
'@ | node C:\Dev\AgentPost\dist\cli.js send --data-dir C:\AgentPostData --as backend@demo --to architect@demo --subject "相談" --body-stdin
```

## 停止・バックアップ・復元

停止は起動端末のCtrl+Cです。ウィンドウを閉じた際の終了通知（SIGHUP）でも停止処理を試みますが、Windowsでは終了までの猶予が限られるため完了は保証しません。自動起動・サービス登録は行いません。

排他制御にはメール用DBと別の `server.lock.sqlite` を使用し、起動中はSQLiteの排他トランザクションを保持します。この排他は強制終了でもOSが解放します。`server.lock.sqlite` は空でも正常な管理ファイルなので、手動削除・置換しないでください。`server.lock` はPIDと起動時刻を記録する補助ファイルです。異常終了後は次の起動時にPIDの不存在を確認できた場合だけ自動回収し、`server.jsonl` に `stale_lock_recovered` を記録します。同時に再起動しても回収処理は排他制御されます。

バックアップはサーバを停止してから、保存先フォルダ全体を別の専用フォルダへコピーしてください。稼働中のSQLiteを単純なファイルコピーでバックアップしないでください。DBだけでなく接続ファイルにも秘密情報があり、バックアップ先も同じユーザー専用に保護します。

復元はサーバ停止中にバックアップを別の専用フォルダへ戻し、そのフォルダを指定して `serve` します。クラッシュ後の `server.lock` は通常、次回起動時に自動回収されます。PIDが存在する場合（別プロセスに再利用された場合を含む）、権限不足などで確認できない場合、内容が壊れている場合は自動削除せず起動を拒否します。その場合だけ、当該保存先のサーバが停止していることを確認して `server.lock` のみを削除してください。DBの `-wal` / `-shm` や `server.lock.sqlite` は手動削除しないでください。
