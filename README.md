# kirinuki-db

社内DBから「ある件に関係する行だけ」を、テーブルや列の意味の説明つきで1つのファイル(Excel など)に切り抜き、社内のAI(M365 Copilot など)に添付して調査や説明をしてもらうための道具です。

- DBは参照権限(SELECT)だけで使います。設定変更はしません
- すべて手元のPCで動きます。外部には何も送りません

構想: [docs/concept.md](docs/concept.md) / 出力イメージ(架空データ): [docs/sample-pack.xlsx](docs/sample-pack.xlsx)

状態: 段階1(SQL Server / Oracle:起点を指定 → 関係をたどる → 説明シートつきの Excel)を実装しました。外部キーが宣言されていないDBでも、主キーと同じ名前の列や関係ファイルでたどれます。辞書ファイル(列の意味・区分値)は段階2の予定です。

## 使い方

Node.js 22.5 以降が必要です。npm にはまだ公開していないので、このリポジトリから作ります。DBのドライバーは使うDBの分だけ入れます(SQLite は不要)。

```sh
git clone https://github.com/ishibashi0112/kirinuki-db && cd kirinuki-db
pnpm install && pnpm build             # ドライバー(mssql、oracledb、pg)も開発用に入ります
npm link                               # kirinuki コマンドが使えるようになります

kirinuki orders 1042 --db "mssql://user:pass@dbserver/salesdb"
```

```
接続しました(SQL Server: salesdb)
  orders 1行 → order_items 2行 → customers 1行 → items 2行 → stock 3行
  たどった関係のうち1つは列名からの推測です(kirinuki relations で一覧を確かめられます)
  たどらなかった子テーブル: shipments(入れるなら --children shipments のように指定)
→ orders-1042.xlsx を書き出しました(12KB)
```

できた Excel を Copilot に添付して「この注文の状態と在庫を説明して」のように聞きます。

### 接続先

`--db`、または環境変数 `KIRINUKI_DB_URL` で指定します。

| DB | 接続URL |
|---|---|
| SQL Server | `mssql://user:pass@host:1433/db`(名前付きインスタンスは `?instance=SQLEXPRESS`、Windows ログインは `?domain=ドメイン名` とそのユーザー名・パスワード) |
| Oracle | `oracle://user:pass@host:1521/service`(ほかのユーザーのテーブルは `?schema=所有者`。Oracle 12.1 以降) |
| PostgreSQL | `postgres://user:pass@host:5432/db` |
| SQLite | `sqlite:./test.db` |

パスワードの記号はパーセントエンコードします(`@` → `%40`、`#` → `%23`、`%` → `%25`)。

### オプション

| オプション | 内容 |
|---|---|
| `<テーブル> <値...>` | 起点。値は主キーの順に(`kirinuki order_items 1042 1`)。テーブル名の大文字・小文字は区別しません |
| `--by <列,...>` | 値を主キーではなくこの列で探す(`kirinuki orders S-1042 --by order_no`) |
| `--children <表,...>` | 明細ではない子テーブルもたどる(出荷、請求など) |
| `--skip <表,...>` | このテーブルには進まない(大きな履歴テーブルなど) |
| `--parents-only` | 子テーブルはたどらない(明細も。参照先だけ) |
| `--max-rows <n>` | 1テーブルから取る行の上限(既定 1000)。超えたら打ち切り、そのことをファイルに書きます |
| `--relations <file>` | 関係ファイル(下の「外部キーがないDB」) |
| `--no-infer` | 列名から関係を推測しない(外部キーと関係ファイルだけ) |
| `--out <file>` | 書き出すファイル(既定 `<テーブル>-<値>.xlsx`) |

### たどる関係

次の3つを合わせて使います。

1. **DBに宣言された外部キー**
2. **主キーと同じ名前の列(推測)**:あるテーブルの主キー(主キーがなければ一意索引)と同じ名前の列を持つテーブルは、そのテーブルを参照しているとみなします。`order_items` に `order_id` があれば `orders` へ、`(company_cd, item_cd)` が主キーの `items` に対して両方の列を持つ `order_lines` は `items` へ。大文字・小文字は区別しません。型が合わないもの(数値と文字)と、3つ以上のテーブルの主キーになっている名前(`id`、`seq` など)は使いません。推測でたどった関係は、Excel にも「列名からの推測」と書きます
3. **関係ファイル**(`--relations`):名前の違う関係を足したり、まちがった推測を取り消したりします

### 外部キーがないDB

まず、いま使われる関係の一覧を出して確かめます。

```sh
kirinuki relations --db ... --out relations.txt     # --table orders で、そのテーブルの関係だけ
```

```
# 主キーと同じ名前の列からの推測(索引あり = 子の列で引ける索引がある)
order_items(order_id) -> orders(order_id)    # 索引あり
orders(customer_id) -> customers(customer_id)    # 索引なし
```

まちがっている行は先頭に `!` を付け、名前の違う関係は1行ずつ書き足して、`--relations relations.txt` で渡します。

```
orders(tokui_cd) -> customers(customer_cd)          # 名前の違う関係
categories(parent_id) -> categories(category_id)    # 自分自身を指す関係
! shipments(order_id) -> orders(order_id)           # この推測は使わない
```

### たどり方

- **参照先はいつもたどります。** 参照している行です(注文 → 得意先、注文明細 → 商品 → 分類 → 親の分類)。
- **子テーブルは明細だけたどります。** 明細とは、主キーの先頭が親のキーになっている子テーブルです(注文明細 `(order_id, line_no)`、在庫 `(item_cd, wh_cd)` は商品の明細)。それ以外の子テーブル(出荷 `ship_id` など)は `--children` で指定したときだけです。
- **たどってきた関係を逆には戻りません。** 注文明細から商品に来たとき、同じ商品を使う他の注文明細へは進みません(逆参照。件数上限つきの逆参照や集計は段階3)。明細から上がってきた親(注文から来た会社、在庫から来た商品)の、ほかの明細へも進みません。主キーの先頭に会社コードがあるDBで、会社の全データが入ってしまうのを防ぎます。
- 参照先からたどる明細は、100行までのときだけ入れます(商品の長い履歴など)。

### ファイルの中身

1. **はじめに**:起点、たどった関係と行数、たどり方、**入っていないもの**(たどらなかった子テーブル、逆参照、打ち切り、読めなかったテーブル)、読み方
2. **テーブル説明**:テーブルの意味(DBのコメント)、抜き出した行数と元の行数、入った経路(〇〇の明細、〇〇の参照先)
3. **列説明**:型、主キー(主キーのないテーブルは一意索引)、意味(DBのコメント:SQL Server の `MS_Description`、Oracle / PostgreSQL の `COMMENT`)、参照先(→ customers.customer_id、推測なら「(推測)」)
4. 各テーブルのシート

M365 Copilot の添付は1ファイル10MBが目安です。超えたときは表示される案内にしたがって `--max-rows` や `--skip` で小さくしてください。

## 開発

```sh
pnpm install
pnpm test        # SQLite のテスト。下の環境変数があれば実物のDBでも
pnpm typecheck
pnpm build
```

`KIRINUKI_TEST_{POSTGRES,MSSQL,ORACLE}_URL`(Oracle は `KIRINUKI_TEST_ORACLE_ADMIN_URL` も)を設定すると、実物のDBに [docs/sample-pack.xlsx](docs/sample-pack.xlsx) と同じ形の架空スキーマを(外部キーあり・なしの両方で)作り、参照権限だけのユーザーで切り抜くテストが走ります。CI はこの3つをコンテナで起動します。
