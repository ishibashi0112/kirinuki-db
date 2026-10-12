# kirinuki-db

社内DBから「ある件に関係する行だけ」を、テーブルや列の意味の説明つきで1つのファイル(Excel など)に切り抜き、社内のAI(M365 Copilot など)に添付して調査や説明をしてもらうための道具です。

- DBは参照権限(SELECT)だけで使います。設定変更はしません
- すべて手元のPCで動きます。外部には何も送りません

構想: [docs/concept.md](docs/concept.md) / 出力イメージ(架空データ): [docs/sample-pack.xlsx](docs/sample-pack.xlsx)

状態: 構想段階(実装はこれから)
