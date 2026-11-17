# MVP 驗收紀錄（H-08，目標 2026-11-23）

- 負責：維護者 執行｜PM 記錄｜依據：`docs/06-test-plan.md` TC-01～13
- 狀態：**未開始**，等 VPS 部署（`docs/ops/runbook-H02-deploy.md`）
- 規則：每個 TC 附實際輸出或截圖路徑；沒過的寫原因與處理，不寫「通過」二字代替證據。

## 前置

| 項目 | 狀態 | 證據 |
|---|---|---|
| H-02 VPS 部署（mail-a＋hub Caddy 片段＋HubClock） | ✅ mail-a＋Caddy＋HubClock（SandyThrush） | docs/ops/vps-inventory.md「H-02 實機部署紀錄」 |
| office.example.invalid 部署前後都正常 | ✅ | before 200 → after 200 |
| H-06 備份上線（每日備份、還原演練、Mac 每週加密拉回） | ✅ | docs/ops/vps-inventory.md「H-06 實機備份上線」 |
| Mac 接入（onboarding-S1） | ✅ 2026-11-17 09:56：hook.log `start`（unread 0、syncError null）＋`watch-arm`，watcher 程序存在。正式環境喚醒預驗：PM 以 RedStone 身分送 #3，09:56:59 送出 → 09:57:02 BlueLake watcher 偵測（約 3 秒）。原：PM 已備好 `~/hub-mac`（client、protocol、設定、只含 Mac 憑證、啟動腳本 `start-hub-claude.sh`）；`hub-hook inbox` 對正式 Hub 連線成功。待 維護者 啟動 Claude 並信任資料夾 | |
| Windows 接入，≤15 分鐘 | 🟡 PM 已打包 `~/hub-win.zip`（只含 Windows 憑證、`start-hub-claude.ps1`）；待 維護者 搬到 Windows | 實際分鐘： |
| 兩台都已信任專案、`/hooks` 看得到 hub-hook | ⬜ | |

## 本機已有的自動化證據（PM 2026-11-17 在 master 重跑）

client 45、hub-hook 36、hub-hook 整合 5（TC-02／04／13、session.closed、問答）、lifecycle 21、備份還原演練 1、ops 7（1 skip：無本機 caddy）、local-stack 驗收（TC-01／05／10／11）。這些是本機證據，**不代替**下面的實機驗收。

## 實機驗收

| TC | 內容 | 方式 | 結果 | 證據 |
|---|---|---|---|---|
| TC-01 | 無／錯 token 一律 401 | Mac 跑 runbook-H02 §6 | ✅ | 20 次 401（9 路徑 GET＋MCP POST） |
| TC-02 | G-02 非同步交接 Mac→Windows，再反向 | 人工 | ⬜ | |
| TC-03 | 交接原文逐字取回 | 自動 | ✅ | `verify-h02.mjs mcp` 對正式 Hub 送讀繁中／換行／emoji，sha256 一致（message 1、2）；TC-06 回覆 #5 原文逐字顯示 |
| TC-04 | 沒未讀／Hub 連不上時的開工畫面 | 人工 | ⬜ | |
| TC-05 | 重啟後持久 | runbook-H02 §6 | ✅ | StartedAt 01:04:03Z→01:32:22Z，同 ID 同 sha256 |
| TC-06 | question 60 秒內自動回答 | 人工 | ✅（Mac 真 session＋模擬 RedStone） | #4 問 → #5 答，**18 秒**，答案正確（列出 8 個項目）；HubClock `question:answered`。真 Windows 發問待 Windows 接入 |
| TC-07 | action 先同意才執行 | 人工 | ✅ | #11：卡片先顯示（presented #12）、檔案未建；維護者 同意 → HubClock approved（#14，02:42:58Z）→ 10:43:06 才建立 tc07.txt（approved-ok） |
| TC-08 | action 拒絕；混合請求當 action | 人工 | ✅ 拒絕部分 | #16：維護者 拒絕 → HubClock rejected（#19），tc08.txt 未建立。混合請求：envelope 未帶 intent 時預設 action（程式行為，見下方已知問題） |
| TC-09 | 確認逾時 30 分鐘＝拒絕 | 人工（要等 30 分鐘） | ⬜ | |
| TC-10 | 撤銷 Windows，Mac 不受影響 | runbook-H02 §6 | ✅ | 同 session 下一請求 401、Mac 正常；Mail／Caddy 未重啟 |
| TC-11 | 收件者不存在不保存 | 自動 | ✅ | E-RCPT，delivery tail 不變 |
| TC-12 | 收件者離線時 action 只保存不執行 | 人工 | 🟡 前半 ✅ | #22 送給沒有 session 的 RedStone：已保存、無執行。待 Windows 開工時確認以卡片呈現、不自動執行 |
| TC-13 | 延遲（每方向 n≥5，≤60 秒） | 自動＋人工 | 🟡 RedStone→BlueLake ✅ | 正式 Hub，送出→Mac watcher 偵測：12.5／15.1／14.6／14.9／14.6 秒（#23～#27），再加 Claude 被喚醒約 1～2 秒，全部 ≤60 秒。BlueLake→RedStone 方向待 Windows 接入 |

Mac 雙真 session 預驗（Ben，2026-11-17）：TC-02 4/4、TC-06 5/5（24～36 秒）、權限提示中訊息排隊、回答後 2.5 秒處理；見 `docs/ops/H04-validation.md`。

TC-06／13 判準（**維護者 2026-11-17 同意**）：閒置 ≤60 秒；AI 忙時「目前這一步結束後立即收到」。另外補記：等待權限提示時的實際行為（H-04a／H-04 未測）。

## 額外驗證

- **session.closed → 待確認失效（SR-CFM-08）** ✅：TC-07 第一次送出（#7）時卡片已顯示，維護者 關閉 cmux 的 session → SessionEnd 送 session.closed（#9）→ HubClock `action:invalidated`，並通知 RedStone（#10）。
- **正式環境喚醒**：#3 送出 09:56:59 → Mac watcher 09:57:02 偵測。

## 已知問題（不影響驗收）

- 回覆訊息沿用 envelope 預設 intent，顯示成 `help/action`／`task/action`，實際內容會註明「同一串裡的回覆，不是新的請求」，不會被當成新請求（HubClock 只記到 1 個 answered）。屬顯示問題，上線批次修。
- HubClock 通知的標籤顯示 `action/undefined`，同屬顯示問題。

## 未過項目與處理

（驗收時填）
