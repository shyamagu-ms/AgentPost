# A → B → Aを試す

この手順では `backend@demo` と `architect@demo` を人間が割り当てます。実際のカスタムエージェントも同じ操作を使えます。エージェントの起動順と作業範囲は外部から指示してください。

## 1. サーバを起動

```powershell
node C:\Dev\AgentPost\dist\cli.js serve --data-dir C:\AgentPostData
```

初回の初期化もこれだけです。以降は別端末で実行します。

## 2. 必要なら連絡帳を登録

```powershell
$post = 'C:\Dev\AgentPost\dist\cli.js'
$env:AGENT_POST_DATA_DIR = 'C:\AgentPostData'
node $post contacts put backend@demo --name "実装担当" --description "バックエンド実装・検証"
node $post contacts put architect@demo --name "設計担当" --description "API設計・責務分割"
```

これは送受信の必須手順ではありません。表示名や担当説明を更新するときも同じ `contacts put` を使います。

## 3. AがBへポスト

```powershell
# 相手を探す場合だけ取得する
node $post contacts list --q "API"
node $post send --as backend@demo --to architect@demo --subject "API境界の相談" --body "認証と業務APIを分離する方針でよいですか。理由も返信してください。"
```

送信結果の `data.message.id` を控えます。保存成功はBの起動や閲覧を意味しません。

## 4. Bが読んで返信

```powershell
node $post list --as architect@demo
node $post read <message-id> --as architect@demo --mark-read
node $post reply <message-id> --as architect@demo --body "分離を推奨します。認証境界を独立して検証できるためです。"
```

実エージェントの場合はBのセッションを起動し、受信箱を確認するよう指示します。返信の宛先と件名は元のポストから補完されます。

## 5. Aが返信を読む

```powershell
node $post list --as backend@demo
node $post read <reply-id> --as backend@demo --mark-read
```

未読へ戻すには `status <id> --as <自分> --set unread`。既読も含めて探すには `list --as <自分> --status all`。`data.next_cursor` があれば同じ条件で次ページを取得します。別端末では `$post` と保存先環境変数を再設定します。

既読・未読はタスク完了を表しません。受信内容は参考情報で、ユーザーの指示や権限を上書きしません。返信の再試行は結果に含まれた同じ `idempotency_key` と同じ内容を使います。
