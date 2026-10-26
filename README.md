# claude-code-mods

Claude Code の mod（フックモジュール）を集めたリポジトリです。このリポジトリ自体が marketplace になっているので、1 行でインストールできます。

## インストール

Claude Code のプロンプトで次を実行します。

```
/plugin install token-weather --marketplace haruki-cl/claude-code-mods
```

`Add marketplace?` に `y`、スコープは `user` を選ぶと、そのセッションからすぐ動き、以降のセッションでも読み込まれます。`run-cat` と `highlight-words` も同じ形で入ります。

```
/plugin install run-cat --marketplace haruki-cl/claude-code-mods
/plugin install highlight-words --marketplace haruki-cl/claude-code-mods
```

## mod 一覧

| mod | 何をするか |
|---|---|
| `token-weather` | コンテキストの使用量を天気で、使用量の枠（5 時間・週）、このセッションが読んだ CLAUDE.md と auto-memory を右のペインに出す。`/weather` で開閉。各カードの見出しを押すと詳細が開く |
| `run-cat` | Claude が考えている間、プロンプト下のヒント行で AA の猫が走る |
| `highlight-words` | Claude の応答が 1 回終わるたびに Haiku が重要な語句と確認が必要な語句を選び、ピンクとオレンジ（Dracula の配色）で描き直す。80 文字未満の応答は飛ばす。Haiku の呼び出し分の利用料がかかる |

## 開発

インストールせずにフォルダから読み込むには `--plugin-dir` を使います。

```
claude --plugin-dir ./token-weather --plugin-dir ./run-cat --plugin-dir ./highlight-words
```

検査とテストは次のとおりです。

```
claude plugin validate ./token-weather
claude plugin test ./token-weather
```

`.claude-plugin/types/` はエンジンが書き出す型定義で、git には含めません。
