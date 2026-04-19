# Hyperliquid Monitor

公開ページ予定: `https://harunamitrader.github.io/Hyperliquid-monitor/`

Hyperliquid 上の24時間取引されるperpマーケットを 5 分ごとに取得し、GitHub Pages で公開するためのシンプルな監視ページです。

現行の `weekend_monitor` と同じ構成を前提にしています。Cloudflare Worker は GitHub Actions を起動するだけで、データ取得とJSON生成は GitHub Actions 上の `npm run build:data` が担当します。

## 構成

- `docs/`: 公開用の静的ページ
- `docs/data/latest.json`: フロントエンドが読む最新データ
- `docs/data/chart-series.json`: 24時間/2026年4月15日以降チャート用データ
- `scripts/`: Hyperliquid API 取得とデータ生成スクリプト
- `data/markets.json`: 監視対象銘柄の固定定義
- `data/snapshots/baselines.json`: 前日終値・金曜終値の保存状態
- `data/history/YYYY-MM-DD.json`: 5分ごとの価格履歴
- `data/history/index.json`: 履歴ファイル一覧
- `.github/workflows/update-data.yml`: GitHub Actions によるデータ更新
- `cloudflare-worker/`: 5分ごとに GitHub Actions をdispatchするWorker

## 取得元

Hyperliquid の公開 `info` API を使います。`app.trade.xyz` のHTMLスクレイピングは使いません。

- Endpoint: `https://api.hyperliquid.xyz/info`
- DEX: default, `xyz`, `km`
- 主な利用API:
  - `metaAndAssetCtxs`
  - `l2Book`
  - `candleSnapshot`

銘柄リンクは `https://app.hyperliquid.xyz/trade` の対象マーケットを開くURLにしています。

## 監視対象

初期定義は `data/markets.json` にあります。

- 株価指数: `SP500`, `US Tech 100`, `JP225`
- 商品: `Gold`, `Silver`, `Platinum`, `Copper`, `WTI Oil`, `Natural Gas`
- 為替: `USDJPY`, `EURJPY`, `EURUSD`
- 暗号資産: `Bitcoin`, `Ethereum`

`EURJPY` は `xyz:EUR * xyz:JPY` の派生値として計算します。`Dow 30`, `Euro Stoxx 50`, `Hang Seng`, `VIX`, `Corn` はHyperliquid API上で24時間動く上場中マーケットが確認できないため、監視対象から外しています。

## 基準価格ロジック

### 優先順位

1. 保存済みの終値スナップショットを使う
2. スナップショットがまだ無い場合だけ、Hyperliquid API の `prevDayPx` から算出する

### スナップショットの動き

- 毎回の取得で当日分の終値候補を更新する
- 日付が変わったタイミングで、前日の最終取得値を「終値」として繰り上げる
- 月曜から金曜の終値だけを `previousClose` として保持する
- 金曜日の終値は `fridayClose` として別枠でも保持する
- 土曜日と日曜日は `fridayClose` を優先する

## ローカルでデータ生成

```bash
npm run build:data
```

日時を指定してスナップショットのロールオーバー挙動を確認できます。

```bash
$env:BUILD_NOW="2026-04-19T00:05:00+09:00"
npm run build:data
```

## GitHub 公開手順

1. このフォルダを `harunamitrader/Hyperliquid-monitor` の public GitHub リポジトリとして push する
2. GitHub の `Settings > Actions > General` で Workflow permissions を `Read and write permissions` にする
3. GitHub の `Settings > Pages` で `Deploy from a branch` を選ぶ
4. ブランチは `main`、公開フォルダは `/docs` を指定する
5. `Actions` タブから `Update Hyperliquid market data` を一度手動実行して初回データを作る
6. `docs/data/latest.json`、`data/snapshots/baselines.json`、`data/history/` が更新されることを確認する

## Cloudflare Worker

`cloudflare-worker/worker.mjs` をCloudflare Workerに設定し、以下のCronで実行します。

```text
*/5 * * * *
```

Worker secret:

- `GITHUB_TOKEN`: `harunamitrader/Hyperliquid-monitor` に対する Actions write 権限を持つ fine-grained GitHub token

## OSSメモ

- APIキーやウォレット秘密鍵は不要です
- GitHub Pages と Cloudflare Worker の設定値以外に機密情報は含めません
- `data/history/` は運用すると増え続けます
- 2026年4月15日以降の5分足は初回または新規銘柄追加時だけバックフィルし、通常更新では保存済みチャートの最新時刻付近から差分取得します
- Hyperliquid API のレート制限を踏まえ、5分ごとの取得を標準にします
