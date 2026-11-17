# 上線批次工作票（11-17 提前開工～11-30）

- 負責：PM-Emily｜狀態：**已核准**（維護者 2026-11-17「全部照建議，開始上線批次」；MVP 驗收見 `docs/delivery-MVP.md`）｜日期：2026-11-17
- 依據：PRD 上線批次 US、`docs/06-test-plan.md` TC-14～21、`docs/08-data-layer-supabase.md`、`docs/research/F-05`、`F-06`、`F-07`

| 票 | 內容 | 建議負責 | 依賴 | 完成條件 |
|---|---|---|---|---|
| L-00 | MVP 顯示修正：回覆訊息不再標成 `help/action`／`task/action`；HubClock 通知不再顯示 `action/undefined` | Tom | MVP | client 單元測試；實機看一則回覆與一則 HubClock 通知 |
| L-01 | Postgres（pgvector）＋ Supabase 規格 migrations 上 VPS（hub database，T15） | Codex | MVP | migrations＋RLS 測試在 VPS 通過 |
| L-02 | Hindsight＋bank-proxy（每人 token、關 delete/clear、Haiku 5.5、每日上限 0.50 USD） | Ben | L-01 | TC-21（原文、繁中）；記憶體實測 |
| L-03 | Discord bot（js-llmcord 為底）：`/status`（只給本人看）、`/connect`、通知 | Tom | L-01 | TC-16、17、18 |
| L-04 | GitHub Issues：建任務（官方 GitHub MCP） | agy-2 | L-03 | TC-19 |
| L-05 | 決策草稿→正式 | agy-1 | L-03 | TC-20 |
| L-06 | auto mode（1 小時預設、最長 4 小時，GAP-20） | Ben | MVP | TC-15 |
| L-07 | 伺服器端 validator（2 萬字、密鑰；S2 開放組員前必須） | Codex | MVP | 繞過 client 直接送也被擋 |
| L-08 | 跨組隔離（S3 前提） | Codex | L-01 | TC-14 |
| L-09 | 上線驗收＋`docs/delivery-S1.md` | 維護者＋PM | 全部 | — |

## 維護者 決定

SRS 4.1 剩下的項目已照 PM 建議定案，見 `docs/03-srs.md` §4.5。

## 派工順序

- 第一波（現在，互不依賴）：L-00 Tom、L-01 Codex、L-06 Ben。
- 第二波：L-01 完成 → L-07、L-08 Codex，L-02 Ben，L-03 Tom；L-03 完成 → L-04 agy-2、L-05 agy-1。
- 最後：L-09。

## 已知風險

- VPS 記憶體：既有服務已用 1.6 GiB；L-01＋L-02 峰值約 1.5～2 GB，S1 夠用，S3 五組不夠（見 `docs/ops/vps-inventory.md`）。
- Claude 用量：Ben 在 H-04 碰到用量上限，上線批次 Claude worker 的工作量要分散，必要時改派 Codex／Antigravity。
