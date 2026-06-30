# agency-crawler — Google Places 代理店候補クローラ

Rumina 代理店開拓 OS の「AIでエリア発掘」を、**Google Places** で実クロールするためのバックエンドです。
会社名・住所・**電話番号（携帯含む）・公式サイト** を取得して候補化します。
設立直後で携帯番号しか連絡先がないベンチャーも拾えます。

> なぜバックエンドが必要か：Google の API キーをブラウザ（公開ページ）に置くと**キーが漏れて悪用・課金される**ため、キーはこのサーバ側だけに置き、アプリはこのサーバのURLを叩きます。

## 1. 事前準備（Google 側）
- [Google Cloud Console](https://console.cloud.google.com/) で **Places API (New)** を有効化
  - ※旧「Places API（レガシー）」ではなく **(New)** の方。レガシーは現在新規プロジェクトで無効です
- キーは既存の `GOOGLE_MAPS_API_KEY`（`AIza…`／Geocode・StreetViewで使用中のもの）をそのまま流用可
  - ✅ 動作確認済み：このキーで Places API (New) から社名・電話・サイトを取得できました
- 推奨：キーの「API制限」で Places API (New) を許可、課金アラートを設定
- （任意）Web全文検索も使うなら **Custom Search JSON API** を有効化し、[Programmable Search Engine](https://programmablesearchengine.google.com/) を作成して `cx`(=CSE_ID) を取得

## 2. セットアップ
```bash
cd agency-crawler
cp .env.example .env        # .env に GOOGLE_API_KEY を記入(rumina_server/.env から流用可)
npm install
npm start                   # → http://localhost:8787
```
動作確認：
```bash
curl http://localhost:8787/health
# {"ok":true,"places":true,"customSearch":false}
```

## 3. アプリ側の設定
1. アプリの「AIでエリア発掘」を開く
2. **クローラAPI URL** に `http://localhost:8787` を入力
3. エリア・件数・条件を選んで「発掘する」→ 電話番号付きで候補が追加されます
4. 追加後に「一括リサーチ」を押すと、チャネル/商材/フックを AI が自動補完します

URLを空欄にすると、従来どおり **AI Web検索** で発掘します。

## 4. API
`POST /api/discover`
```json
{ "area": "関東", "count": 8, "keyword": "通信回線系" }
```
レスポンス：
```json
{ "companies": [
  { "name": "株式会社○○", "url": "https://...", "area": "関東",
    "address": "東京都...", "phone": "090-1234-5678", "mobileOnly": true,
    "types": ["..."], "maps": "https://maps.google.com/..." }
], "scanned": 24 }
```

## 5. 公開して使う場合（チームで共有）
- Render / Railway / Cloud Run などにデプロイ（環境変数に GOOGLE_API_KEY を設定）
- デプロイ先のURL（例 `https://agency-crawler.onrender.com`）をアプリの「クローラAPI URL」に入れるだけ
- キーは各ホスティングの環境変数に置き、リポジトリには**絶対にコミットしない**（`.env` は `.gitignore` 済み）

## メモ／拡張余地
- Places の `formatted_phone_number` が `070/080/090` の場合に `mobileOnly:true`
- 既定クエリ（訪販/通信/催事/美容健康/太陽光）は `server.js` の `buildQueries` で調整可
- さらに精度を上げるなら、取得後に Anthropic で「ライト商材の若手営業会社か」を分類してフィルタする層を追加できます（アプリの「一括リサーチ」が実質その役割）
