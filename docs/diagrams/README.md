# 流程圖（階段 D）— don't be a meat proxy

- 作者：swe-Ben（Claude）｜任務：T6（<ORCA_ID>）｜日期：2026-11-16｜狀態：**草稿，待 PM／維護者 審圖**
- 上游：`docs/01-brief.md`（G1 已確認）、`docs/gates/G1-decision.md`、`docs/02-prd.md`（草稿）、`docs/research/F-01b、F-02、F-05、F-06`。**SRS（T5）與 SAD／SDS（T7）同時在寫，本次沒有讀到**；跟它們可能衝突的地方標「待對齊」。
- 方法：流程提示詞 `03-通用提示詞/04-D-流程檢查.md`＋`skills/archify/SKILL.md`（直接從流程參考資料夾執行，沒有安裝到全域）。
- 原則：只畫 Brief／PRD／G1 已寫的行為。沒寫的不畫進主流程，改列在下方「缺口」。

## 圖表索引

| 圖 | 批次 | 內容 | 對應 |
|---|---|---|---|
| [D1 非同步交接](D1-async-handoff.html) | **MVP**（Discord 通知部分是上線批次） | A 留交接 → Caddy 驗證 → Agent Mail 存原文 → B ≥10 分鐘後開新 session 只打「開始」→ 第一則回覆列出交接 | G-02、US-02、US-03、AC-13.2 |
| [D2 同步問答／動手確認＋逾時](D2-sync-request.html) | **MVP** | question 自動回答；action（含混合、不明）在 B 的畫面徵求同意；拒絕或 30 分鐘逾時就不執行並通知 A；B 離線轉 D1 | G-03、US-05、US-06 |
| [D3 auto mode](D3-auto-mode.html) | **待對齊**（建議放上線批次，見 GAP-20） | 收件人指定對象＋時長（預設 1h、最長 4h）→ 有效期間 action 自動執行，每次都記錄＋通知 → 到期或提前關閉 | G-03、US-07 |
| [D4 /connect 與撤銷](D4-connect-revoke.html) | **上線**；MVP 由 維護者 手動改 Caddyfile | 成員檢查 → 產生個人 token → 加進 Caddy allowlist 並 reload → 只給本人的回覆（一行設定）→ 撤銷後下一個請求 401 | G-05、US-12、F-01b E5 |
| [D5 Discord 查進度](D5-discord-status.html) | **上線** | 成員與每日額度檢查 → 專案助理只用唯讀工具讀 Hindsight＋GitHub → 回覆附 ID 與時間，預設只給提問者看 | G-04、US-08 |

- 原始檔：`src/*.workflow.json`（Archify workflow v2）。改圖請改 JSON，再跑一次 finalize（指令在文末）。
- `*.finalize*.json`、`*.delivery.json`、`*.browser-check.json` 是 Archify 自動產生的檢查收據。
- 驗證狀態：5 張圖都通過 Archify 的自動檢查（validate、deliver、strict check、browser-check）。**沒有做人工看圖檢查**。

## 畫圖時發現的流程缺口

「建議由誰處理」只是建議；屬於產品決策的項目，由 PM 轉交 維護者 決定。

| ID | 圖 | 缺口 | 為什麼重要 | 建議由誰處理 |
|---|---|---|---|---|
| GAP-01 | D1 | **MVP 的「專案現況」從哪裡來**。G-02 要求第一則回覆含專案現況，但 Hindsight 和 GitHub Issues 都排在上線批次 | MVP 驗收 G-02 時無法判定 | 待對齊 T5／T7（PRD Q-10）。建議 MVP 先用 Agent Mail 最近 N 則交接當作現況 |
| GAP-02 | D1 | **開工讀取、收工寫入，各由什麼觸發**。B 只打「開始」時，誰呼叫 `fetch_inbox`（Claude Code 的 SessionStart hook？專案 CLAUDE.md 的指示？）；A 收工時的自動寫入要靠 session 結束 hook，還是每段完成就寫 | G-02「只輸入開始」、AC-04.1 能不能過，取決於這點（A-5） | SDS（T7） |
| GAP-03 | D1 | Rust 版 `fetch_inbox` **讀取時就會標成已讀**（F-01b E2）。如果 agent 讀完、還沒顯示就當掉，這則交接就不會再以「新項目」出現 | 交接可能悄悄消失（違反 AC-03.3 的前提） | SDS：先用 `mark_read=false` 讀，顯示後再標已讀 |
| GAP-04 | D1、D2 | **Agent Mail 沒有「在線」的概念**。AC-02.1「已保存，對方離線」、AC-05.3「轉為非同步」都要先知道 B 在不在線 | 寄件端的文案和分流無法實作 | SRS 定判定規則（例：最近 N 秒內有 fetch），或把 MVP 文案改成只顯示「已保存」 |
| GAP-05 | D2 | **閒置的 Claude Code session 不會自己去收信**。F-01b 只證明「主動 fetch」約 0.2 秒；session 停在等使用者輸入時，沒有東西會觸發它 | G-03 的「≤60 秒」是 MVP 最大風險（A-4） | SDS：選定喚醒機制（hook／背景監看／定時迴圈）並實測；不成立就照 A-4 降級為「下一次對話時收到」 |
| GAP-06 | D2 | **30 分鐘逾時由誰計時**。如果靠 B 的 session 計時，B 一關掉就沒人判定逾時，A 永遠收不到逾時通知 | AC-06.4 可能永遠不會觸發 | SDS：以送出時間＋30 分鐘為準，由 A 端或 Hub 判定 |
| GAP-07 | D2 | **question 沒回應的時限沒有定**（AC-05.4）。G1 只定了 action 的確認逾時是 30 分鐘 | 寄件端不知道何時顯示「未回應，已轉為留言」 | **維護者 決定**（PRD Q-02 的剩餘部分） |
| GAP-08 | D2 | 「在 B 的畫面徵求同意」**用哪一種介面**：Claude Code 內建的權限提示，還是 agent 在對話中詢問。內建提示看不到「是誰提出請求」 | AC-06.1 要求顯示請求者、內容、會做的事 | SDS |
| GAP-09 | D3 | **auto mode 的狀態存在哪裡**。存在 B 本機，Hub 和 Discord 都看不到；存在 Hub，Agent Mail 沒有這個概念，要另寫膠水程式 | AC-07.1 要求記錄並通知 | SAD／SDS |
| GAP-10 | D3 | **到期以哪個時鐘為準，B 的 session 重啟後 auto mode 還算不算數** | 可能出現「到期後還在自動執行」（R-2） | SDS：存絕對到期時間，每次執行前都比對 |
| GAP-11 | D3 | PRD 沒寫：**遠端的 action 不能修改 auto mode 本身**（延長時間、增加對象）。Rakazo RKZ-4 的做法是這類動作一律要人確認 | 對方可以透過 action 自己延長授權 | 待對齊：建議補一條 AC |
| GAP-12 | D4 | **token 是每人一份，還是每裝置一份**。Brief R-4 寫「每人一個 token」；AC-12.4 卻要求撤銷「Windows 那份」時不影響其他裝置 | 撤銷的範圍、測試的預期結果不同 | 待對齊（本測試計畫先假設**每裝置一份**） |
| GAP-13 | D4 | Caddy 會把個人 token 換成**整組共用**的後端 token（F-01b E5），Agent Mail 因此不知道請求來自哪一個人；寄件者身分只靠 agent 自己報的名字＋`sender_token` | S1 只有 維護者，影響小；S2 開放組員前要決定 | SAD（S2 前） |
| GAP-14 | D4 | token **以明文寫在 Caddyfile**；bot 改 Caddyfile＋reload 需要的權限、兩個指令同時執行的處理、reload 失敗時的回復方式，都沒定；撤銷指令的名稱也沒定 | R-4 金鑰外洩；撤銷可能失效 | SDS |
| GAP-15 | D4 | 只有 Claude Code、Antigravity 能用一行指令接上；Codex 需要環境變數，VS Code／Cursor 要改 JSON（F-02） | `/connect` 要依工具給不同設定 | SDS（S1 只用 Claude Code，不擋 MVP） |
| GAP-16 | D5 | **交接寫進 Agent Mail 後，怎麼進 Hindsight**：agent 兩邊都寫？還是 bot／排程同步？ | 查進度要讀 Hindsight，資料進不去就答不出來 | SAD |
| GAP-17 | D5 | Discord 的「只有你看得到」（ephemeral）**只能用在 slash 指令或互動回覆**（F-06 OC-6）。在頻道直接打「現在做到哪」，回覆就會公開 | G-04 的驗收說法、與 G1 #11「預設只給提問者看」會互相衝突 | 待對齊：建議用 `/status` 指令或私訊 |
| GAP-18 | D5 | LLM 還沒選（D-4／F-07）；js-llmcord 沒有每日費用上限的機制（F-06 V6-3） | AC-08.5 要自己寫計數 | 維護者（D-4）＋SDS |
| GAP-19 | D5 | 回覆要引用的「ID」是哪一種：Hindsight memory ID、Agent Mail 訊息 ID，還是 Issue 編號 | G-04 驗收要能比對 | SRS |
| GAP-20 | D3 | **auto mode 屬於 MVP 還是上線批次**。Brief 的 MVP 只寫「同步傳訊」，但 G-03 包含 auto mode | 影響 11-23 的範圍 | **維護者 決定**；建議放上線批次（它的通知要靠 Discord） |
| GAP-21 | 全部 | 寄件者**撤回**（AC-02.3、AC-06.5）：Agent Mail 有沒有這個功能**待確認**（F-01b 沒測），所以沒畫 | PRD 已標「待人工審查」 | T7 查上游工具清單 |
| GAP-22 | D1 | **重送不能產生重複**（AC-02.4）：Agent Mail 是否支援冪等送信（同一請求重送只算一次）**待確認** | 網路不穩時可能出現兩筆交接 | T7 |

## 重跑指令

在本 worktree 根目錄執行（`<archify>` 指 `/project`）：

```sh
node "<archify>/bin/archify.mjs" finalize workflow \
  "$PWD/docs/diagrams/src/D1-async-handoff.workflow.json" \
  "$PWD/docs/diagrams/D1-async-handoff.html" --quality showcase --json
```

D2～D5 的檔名請照上表替換。產生的 HTML 已經完整打包（不需要網路），可以直接用瀏覽器開啟。
