# CLI / HTTP API 契約（v0.2）

## 接続とアドレス

`agent-post serve --data-dir <folder> [--port 43127]` が初回の初期化と起動を兼ねます。`--port 0` は空きポートを選び、実際の接続先を保存・出力します。相対フォルダは実行時のcwd基準です。

クライアントは `--data-dir` または環境変数 `AGENT_POST_DATA_DIR` で保存先を指定します。プロジェクトやユーザーフォルダの自動探索はしません。そのフォルダの `connection.json` からURLとトークンを読みます。フォルダ未初期化・ファイル破損・接続不能は明示的なエラーです。クライアントがDBを直接開いたり初期化したりすることはありません。

自己アドレスは `--as` または `AGENT_POST_ADDRESS` で指定します。CLI指定が環境変数より優先します。送信・一覧・全文取得・状態更新には必須で、healthと連絡帳には不要です。

アドレスはASCIIの `local@namespace` です。localは `[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}`、namespaceは `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`。全体を小文字に正規化し、大文字小文字では区別しません。人名・役割・セッションIDなどへの割り当ては外部で行います。DNS解決やメール送信はしません。

## CLI

既定でJSON出力です。共通オプション `--data-dir`、`--as`、`--timeout` はコマンドの前後どちらでも使えます。timeoutは1〜300000 ms、既定10000 msです。

| コマンド | 内容 |
|---|---|
| `serve --data-dir <folder> [--port <number>]` | フォアグラウンド起動・初回初期化 |
| `health` | 接続確認 |
| `contacts put <address> --name <text> --description <text>` | 連絡帳の追加・置換 |
| `contacts list [--q <text>] [--limit <n>] [--cursor <value>]` | 連絡帳検索 |
| `send --to <address> --subject <text> --body <text>` | 直接送信。未登録宛て可 |
| `send --reply-to <id> --body <text>` | 自分が受け取ったポストへの返信 |
| `reply <id> --body <text>` | 上記のショートカット |
| `list [--status unread\|read\|all] [--limit <n>] [--cursor <value>]` | 自分宛て一覧。既定unread |
| `read <id> [--mark-read]` | 自分宛て全文。既定は状態変更なし |
| `status <id> --set read\|unread` | 自分宛て既読・未読更新 |

送信と返信は `--body`、`--body-file <UTF-8-file>`、`--body-stdin` のいずれか一つだけを指定します。任意の `--idempotency-key <key>` を受け付け、省略時はUUIDを生成します。長文・複数行はファイルまたはstdinを推奨します。Windows PowerShellのstdinはUTF-8設定が必要です。

`read --mark-read` はGET成功後にPATCHを実行し、更新後の状態と本文を返します。どちらかが失敗すればコマンドは失敗します。両操作は単一トランザクションではなく、PATCH失敗時もGETは完了している可能性があります。

返信は受信した親ポストの送信元へ送り、件名とthread_idを継承します。APIと `send --reply-to` では件名の明示変更も可能です。別宛先の指定は拒否します。親の既読状態は変わりません。会話全体の閲覧APIは持たず、各アドレスは自分が受け取ったポストだけを読みます。

## 出力

成功は標準出力へ `{ "ok": true, "data": ... }`、失敗は標準エラーへ `{ "ok": false, "error": { "code": "...", "message": "..." } }` です。起動結果はURL・PID・保存先だけを返し、トークンは出力しません。

一覧・連絡帳は `data.items` と `data.next_cursor`。送信は `data.message`、`data.replayed`、`data.recipient_registered`。全文取得は `data` が本文を含むポスト、状態更新は `data` が本文なしのポストです。

ポスト概要のフィールドは `id`、`thread_id`、`reply_to`、`from`、`to`、`subject`、`created_at`、`read_at`、`status`。全文取得だけが `body` と `idempotency_key` を追加します。連絡帳は `address`、`name`、`description`、`updated_at` です。日時はUTC ISO 8601、未設定値はnullです。

`read_at` は現在の既読化日時です。未読へ戻すとnullになり、同じ状態の再設定では変わりません。対応中・完了・担当確保の意味は持ちません。

## 一覧と連絡帳

既定50件、limitは1〜200件です。メッセージはサーバ受付順（単調増加連番）、連絡帳はアドレス順です。次ページには同じアドレス・フィルタと `next_cursor` を渡します。ページサイズだけは変更可能です。

スナップショットではなくライブ一覧です。後から届いたメッセージが次ページに入る場合や、途中の既読更新により結果が変わる場合があります。連絡帳では既に通過した位置への追加・変更を完全に追跡しないため、最新全体を必要とするときは最初から取得します。

連絡帳のqはアドレス・表示名・担当説明に対する部分一致です。ASCIIのみ大文字小文字を区別せず、日本語はそのまま比較します。担当の意味的な判断は呼び出し側が行います。連絡帳は登録された連絡先であり、在席・稼働中の保証ではありません。

## HTTP

全APIに `Authorization: Bearer <connection.jsonのtoken>` が必要です。メッセージ操作には `X-Agent-Address: backend@demo` を付けます。送信元はこのヘッダーから決め、JSONの `from` は受け付けません。

| メソッド | 経路 | 入力 |
|---|---|---|
| GET | `/v1/health` | なし |
| PUT | `/v1/contacts` | address, name, description |
| GET | `/v1/contacts` | q, limit, cursor |
| POST | `/v1/messages` | to, subject, body, idempotency_key。返信はreply_toを指定しto/subject省略可 |
| GET | `/v1/messages` | status（unread/read/all）, limit, cursor |
| GET | `/v1/messages/{id}` | なし |
| PATCH | `/v1/messages/{id}/status` | `{ "status": "read" }` またはunread |

body付き要求は `Content-Type: application/json` が必要です。不明なJSONフィールド、一覧クエリの重複、不明なクエリを拒否します。送信成功は201（再送含む）、他は200です。親参照・全文取得・状態更新は宛先一致が必須で、一致しなければ存在しないIDと同じ404になります。

主なHTTPエラーは400（入力・カーソル）、401（トークン）、403（Host・Origin）、404（受信箱にないID・経路）、409（再送キー競合）、413（要求サイズ）、415（Content-Type）、500（内部失敗）です。

件名は最大512 bytes、本文256 KiB、表示名512 bytes、担当説明4096 bytes、検索512 bytes、再送キー200 bytes、JSON要求1 MiBです。テキストは非空UTF-8で、空白のみ・NUL・不正なUnicodeを拒否します。

## 再送と失敗

キーは送信元アドレス内で一意・自動失効なし。同じキーと同じ正規化済みの内容なら元のIDを返し、異なる内容は `IDEMPOTENCY_CONFLICT` です。返信元、宛先、件名、本文も同じにします。新しいキーは別の送信です。

CLIの送信・返信結果には最上位の `idempotency_key` も含まれます。失敗時の `delivery: unknown` は保存済みの可能性を表し、同じキー・内容で再試行します。`not_saved` は当該試行の拒否で、同じキーの過去の保存がないという保証ではありません。通信不能を成功や空受信箱として扱いません。

終了コードは0（成功・help）、1（設定・サーバ拒否・ローカル失敗）、2（使い方・入力不正）、3（接続・タイムアウト・応答不正）です。

## ローカルの境界

127.0.0.1のみで待受し、ループバックのHostだけを許可します。Origin付き・cross-site要求を拒否し、CORSは提供しません。共有トークンはサーバ全体の資格情報で、アドレスの本人認証・namespace別認可はありません。アドレスの `@demo` 部分は単なる名前で、隔離境界ではありません。

別の信頼境界が必要なら、保存先とポートを分けた別サーバを使います。エージェントの自動起動、通知、定期ポーリング、添付ファイル転送、タスク状態管理は範囲外です。
