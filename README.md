# kirinuki-db

社内DBから「ある件に関係する行だけ」を、テーブルや列の意味の説明つきで1つのファイル(Excel など)に切り抜き、社内のAI(M365 Copilot など)に添付して調査や説明をしてもらうための道具です。

- DBは参照権限(SELECT)だけで使います。設定変更はしません
- すべて手元のPCで動きます。外部には何も送りません

構想: [docs/concept.md](docs/concept.md) / 出力イメージ(架空データ): [docs/sample-pack.xlsx](docs/sample-pack.xlsx)

状態: 段階1(SQL Server / Oracle:起点を指定 → 宣言済みの外部キーをたどる → 説明シートつきの Excel)を実装しました。辞書ファイル(列の意味・区分値)は段階2の予定です。

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
| `--out <file>` | 書き出すファイル(既定 `<テーブル>-<値>.xlsx`) |

### たどり方

- **参照先はいつもたどります。** 外部キーで参照している行です(注文 → 得意先、注文明細 → 商品 → 分類 → 親の分類)。
- **子テーブルは明細だけたどります。** 明細とは、親のキーが自分の主キーに含まれる子テーブルです(注文明細 `(order_id, line_no)`、在庫 `(item_cd, wh_cd)`)。それ以外の子テーブル(出荷 `ship_id` など)は `--children` で指定したときだけです。
- **たどってきた外部キーを逆には戻りません。** 注文明細から商品に来たとき、同じ商品を使う他の注文明細へは進みません(逆参照。件数上限つきの逆参照や集計は段階3)。
- 宣言されている外部キーだけをたどります。外部キーのない関係の推測は段階3の予定です。

### ファイルの中身

1. **はじめに**:起点、たどった関係と行数、たどり方、**入っていないもの**(たどらなかった子テーブル、逆参照、打ち切り、読めなかったテーブル)、読み方
2. **テーブル説明**:テーブルの意味(DBのコメント)、抜き出した行数と元の行数、入った経路(〇〇の明細、〇〇の参照先)
3. **列説明**:型、主キー、意味(DBのコメント:SQL Server の `MS_Description`、Oracle / PostgreSQL の `COMMENT`)、参照先(→ customers.customer_id)
4. 各テーブルのシート

M365 Copilot の添付は1ファイル10MBが目安です。超えたときは表示される案内にしたがって `--max-rows` や `--skip` で小さくしてください。

## 開発

```sh
pnpm install
pnpm test        # SQLite のテスト。下の環境変数があれば実物のDBでも
pnpm typecheck
pnpm build
```

`KIRINUKI_TEST_{POSTGRES,MSSQL,ORACLE}_URL`(Oracle は `KIRINUKI_TEST_ORACLE_ADMIN_URL` も)を設定すると、実物のDBに [docs/sample-pack.xlsx](docs/sample-pack.xlsx) と同じ形の架空スキーマを作り、参照権限だけのユーザーで切り抜くテストが走ります。CI はこの3つをコンテナで起動します。
