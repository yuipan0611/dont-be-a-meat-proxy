# G2+G3 審查包（設計＋MVP 工作票）

- PM：PM-Emily｜決策人：維護者｜日期：2026-11-16｜狀態：**已核准（維護者，2026-11-17）**
- 因 MVP 時程（11-23），G2（設計）與 G3（票）合併一次審查。

## 審查標的

| 文件 | 作者 | 重點 |
|---|---|---|
| `docs/02-prd.md` | Tom | 每個 US 標批次：MVP 6 個、上線 7 個、S2+ 1 個 |
| `docs/03-srs.md` | Tom | 30 FR、規則群、錯誤碼、逾時表；4.4 為 維護者 已定 |
| `docs/04-sad.md`、`05-sds.md`（v0.3） | Codex | Hostinger compose、`hub.example.invalid`、每裝置 token、`asyncRewake` hook 收信、HubClock 計時、Haiku 5.5；GAP-01～22 逐條回應 |
| `docs/diagrams/`、`06-test-plan.md` | Ben | 5 張流程圖、21 個 TC（MVP 13 個） |
| `docs/07-tickets-mvp.md` | PM | H-01～H-08，11-19～11-23 |

## 主要風險

1. **閒置 Claude Code 收信（A-4）**：靠 `asyncRewake` hook，尚未實測 → H-04a 第一天先 spike，不行就降級為「下一次對話收到」。
2. **單一入口繞過檢查**：MVP 的字數／密鑰檢查只在 client；S2 前要補伺服器端。
3. **記憶體**：MVP 只用約 1.9 GB；五組全開預留 6.9 GB，S3 前重量。

## 要 維護者 決定

| # | 事項 | PM 建議 |
|---|---|---|
| 1 | 核准設計與 MVP 票 | 核准 |
| 2 | 開工顯示最近幾則交接（N） | 5 |
| 3 | 備份的異地副本放哪 | 每週加密後拉回 維護者 的 Mac（另有 Hostinger 每週快照） |
| 4 | 先把目前文件 commit 成檢查點 | 同意：worker 的 worktree 要以它為基底開分支才能寫程式 |
| 5 | H-01 的 VPS 操作誰做 | 維護者 照 runbook 做（不把 SSH 金鑰交給 agent） |

## G2+G3 結果（維護者，2026-11-17）：全部照建議

| # | 決定 |
|---|---|
| 1 | 核准設計（SAD/SDS v0.3、流程圖、測試計畫）與 MVP 票 H-01～H-08 |
| 2 | N＝5（開工顯示最近 5 則交接） |
| 3 | 異地備份：每週加密後拉回 維護者 的 Mac |
| 4 | 目前文件 commit 成檢查點（只 commit，不 push） |
| 5 | H-01 的 VPS 操作由 維護者 照 runbook 執行；SSH 金鑰不交給 agent |

## G2+G3 之後的補充決定

| 日期 | 事項 | 維護者 的答案 |
|---|---|---|
| 2026-11-17 | A-4／NFR-01「60 秒內收到」判準 | 同意：閒置 ≤60 秒；AI 忙時「目前這一步（一則回答或一個工具呼叫）結束後立即收到」。依據 F-09 與 H-04 真 session 實測 |
