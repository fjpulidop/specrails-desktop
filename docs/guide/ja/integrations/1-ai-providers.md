# AI プロバイダー（Claude、Codex、Gemini、Kimi）

Specrails は特定の AI に縛られません。Claude、Codex、Gemini、Kimi
はファーストクラスのプロバイダーで、各画面には必要な capability
を満たすエンジンだけが表示されます。

## 4 つのプロバイダー

| プロバイダー | CLI | 提供元 | 備考 |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | ネイティブコストと永続的な対話 transport。 |
| **Codex** | `codex` | OpenAI | codex `0.128.0+` が必要です。MCP サーバーはグローバルな `~/.codex/config.toml` から読み込みます。 |
| **Gemini** | `gemini` | Google | gemini `0.11.0+` が必要です。ネイティブのテレメトリと `GEMINI.md` 指示ファイルを使用します。 |
| **Kimi Code** | `kimi` | Moonshot AI | Kimi `0.27.0+` が必要です。Desktop は外部 CLI を `-p` で起動し、server をインストール・起動しません。 |

4 つとも**デフォルトで有効**です。CLI が `PATH` にあれば表示されます。
Kimi は `kimi --version` を確認し、`kimi login` を実行してください。

## プロジェクトに 1 つのプロバイダーをインストールする

プロジェクトを追加すると、セットアップウィザードがどのプロバイダーをインストールするか尋ねます。1 つ選んでインストールのステップを進めれば完了です。あとはそのプロジェクトがそのプロバイダーを*持っている*状態になり、それ以降は意識する必要はありません。スペック、レール、チャット、アナリティクスは、どれを選んでも同じように動きます。

使いたい CLI が Add Project に出てこない場合、ほとんどはその CLI がインストールされていないか、`PATH` 上にないのが原因です。インストールしてから Add Project を開き直してください。

## 1 つのプロジェクトに複数のプロバイダーをインストールする

同じプロジェクトに**複数**のプロバイダーをインストールできます — たとえば Claude *と* Gemini を一緒に、といった具合です。**Add Project** では、プロバイダーの一覧がチェックボックスになるので、使いたいものをすべてチェックしてください。最初に選んだものがそのプロジェクトの**プライマリ**（デフォルト）プロバイダーになり、残りは代替として使えるようになります。

マルチプロバイダーのプロジェクトについて、知っておくとよいことがいくつかあります。

- **プロバイダーが 1 つなら、これまでとまったく同じ挙動です。** プロジェクトにプロバイダーが 1 つしかなければ、プロバイダーの選択 UI はどこにも表示されません — アプリはすっきりシンプルなままです。
- **UI は capability に従います。** Claude と Kimi はプロバイダー別の
  profile に対応し、Codex と Gemini は legacy mode で実行します。
- **プロバイダーの選択は作成後に固定されます。** このバージョンでは、プロジェクトを追加するときにプロバイダーを選び、あとから設定で変更することはできません。別の組み合わせが必要になったら、新しいプロジェクトを作成してください。

## 呼び出しごとにプロバイダーを選ぶ

マルチプロバイダーのプロジェクトの真価は、グローバル設定を一切変えずに、タスクごとに最適な AI を選べることにあります。AI が動くところには、小さなプロバイダー選択 UI が現れます（プロジェクトに複数のプロバイダーがあるときだけです）。

- **Add Spec** — Explore は Kimi に対応します。Quick Spec は安全な
  pure-output 境界を持つプロバイダーだけを表示するため、Kimi は除外されます。
- **レールのヘッダー** — その特定のレールを起動する前に、使うエンジンを選べます。
- **ターミナル** — 「Open AI CLI」（Sparkles）ボタンを押すとプロバイダーメニューが開き、そのプロジェクトのディレクトリで任意のインストール済み CLI に入れます。

選んだエンジンはプロジェクトごとに記憶され、デフォルトはプライマリプロバイダーです。毎回選び直す必要はありません。

## Capability の違い

Kimi は Project/Agent Chat、Explore/proposal、Quick Launcher
(`/opsx:ff`)、rail、Freestyle、Decider のない loop、profile/手動 role、
MCP、Serena、terminal、attachment に対応します。

`kimi -p` は tool を自動承認し、no-tools/read-only 境界を強制できません。
そのため Quick Spec、AI Edit、Contract Refine、SMASH/Re-SMASH、
Project Builder の blueprint/milestone 生成、Loop Decider、file summary/
construction story、Agent Studio automation は spawn 前に拒否されます。
AI auto-title は deterministic fallback を使います。詳細は
[Kimi guide](../../../kimi.md) を参照してください。

## プロバイダー横断のコスト追跡

**Analytics** は実際に起動した invocation を記録します。Claude は
cost を報告し、Codex/Gemini は推定値です。Kimi は authoritative な
token/USD cost を報告しないため、その項目は空欄です。

## トラブルシューティング

- **インストールしたプロバイダーが表示されない。** `claude --version` / `codex --version` / `gemini --version` / `kimi --version` を確認してください。
- **チャットで Codex の MCP サーバーが読み込まれない。** Codex は MCP サーバーをグローバルな `~/.codex/config.toml` から読み込みます — `codex mcp add` でそこに登録してください。
- **緊急時の無効化。** プロバイダーは環境変数（`SPECRAILS_CODEX_BETA=0` または `SPECRAILS_GEMINI_BETA=0`）でアプリ全体から無効にできます。これはプロバイダーを*選択肢*から隠すだけで、めったに必要にはなりません。

## 関連項目

[Kimi guide](../../../kimi.md)、Codex guide、Gemini guide を参照してください。
