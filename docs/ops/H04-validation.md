# H-04 驗收紀錄：hub-hook（開工／收信／收工）

- 負責：swe-Ben｜審查：PM-Emily｜日期：2026-11-17
- 規格：`docs/07-tickets-mvp.md` H-04、SDS CLI-02／CLI-03、API-06；H-04a 結論見 `docs/research/F-09-asyncrewake-spike.md`
- 產出：`client/hub-hook.mjs`、`client/templates/{claude-settings.json,hub-client.json}`、`client/README.md`（hub-hook 段）、測試 `client/test/hub-hook*.test.mjs`、雙 session 模擬 `spikes/h04/`
- 環境：macOS、Claude Code 2.1.325、Node 24.18.0、mcp_agent_mail_rust 0.3.40（本機，SHA-256 `4c3804fe…5bead`）

## 結論

- **H-04 功能完成（Mac 本機）**：開工列未讀＋最近 5 則交接、閒置自動收信、checkpoint 交接、session 結束上報、強退後下次開工提示，都有自動化測試；真 Claude 雙 session 模擬跑過 TC-02、TC-06 與權限提示情境。
- **A-4（PM 暫定判準）**：閒置 ≤60 秒 → 成立（TC-06：問題保存後 10.6–14.6 秒進入對方對話，5/5）；忙碌時「目前這一步結束後立即收到」→ 成立，權限提示也一樣（提示開著 94.8 秒都沒進對話，回答提示後 2.5 秒就處理）。
- **沒做到／要 維護者 驗**：真 Mac↔Windows（H-08）、Windows 上的 hook 與孤兒處理、斷網／睡眠恢復。

## 測試輸出

### 1. 單元（FakeClock＋記憶體假 Hub）

`node --test client/test/hub-hook.test.mjs` → `tests 40, pass 40, fail 0`。涵蓋：開工未讀逐字（舊→新）、沒有新項目要明說、Hub 連不上／缺 token 不得說沒有新項目、顯示過即已讀（AC-03.3）、最近 N=5 新→舊、過長原文截斷且保持未讀、強退後提示「上次已保存 #ID」且不編造、同 agent 另一個活著的 session 不算強退；watch 一行通知不含全文、15 秒輪詢、同一則不重複喚醒、單一 watcher、Claude 消失不讀事件（父程序死亡／被收養兩種）、55 分鐘自我到期早於範本 timeout、撤銷 token 只喚醒一次、連不上只喚醒一次且恢復後照常；checkpoint／send 未送達與結果未確認（同 key 重送只一筆）、本機擋未知收件者與密鑰；stop 只 block 一次、只收信的回合不 block；end 送 session.closed、離線時留待送；read 逐字＋標已讀；H-05 控制紀錄格式與固定 key；HubClock 名稱未設定時不猜名字；範本可載入；經 symlink 的 client/ 也能跑；`--json` 參數；回覆先於 answer 控制紀錄送出。

TDD 說明：第一個垂直切片與後來的 bug（symlink、`--json`、交接誤顯示為動作請求）都是先紅後綠；其餘行為測試是寫完實作後補的，所以另做了 5 個突變測試（拿掉孤兒檢查、連不上時說沒有新項目、拿掉不重複喚醒、重送換新 key、到期改 60 分鐘），每一個都有對應測試變紅。

### 2. 整合（真 Mail 0.3.40＋真 hub-hook 子程序）

`node --test client/test/hub-hook.integration.test.mjs`：TC-02 模擬、session.closed 以 H-05 格式送到「Mail 產生名稱」的 HubClock、question→replyTo（HubClock 收到問題 CC 與 answer 控制紀錄、回覆不 CC）、TC-04 模擬、TC-13 模擬。

TC-13（本機雙 agent、真 15 秒輪詢；A 以 monotonic clock 量 送出→B 喚醒→B 讀原文→回條→A 喚醒；不含 Claude 模型本身的回合時間，F-09 量到每端約 1.3–2.5 秒）：

| 方向 | 送出→B 喚醒（秒） | 來回（秒） |
|---|---|---|
| BlueLake→RedStone ×5 | 2.98／6.12／11.24／0.20／4.24 | 18.00／21.15／26.26／15.24／19.26 |
| RedStone→BlueLake ×5 | 4.69／0.85／1.68／12.21／8.09 | 19.73／15.87／16.71／27.24／23.12 |

10/10 ≤60 秒，最大 27.24 秒（最終程式碼這一輪；前兩輪也都 10/10，最大 27.26／30.02 秒）。

最終一次完整執行：`node --test client/test/hub-hook.test.mjs client/test/hub-hook.integration.test.mjs client/test/mail-client.test.mjs client/test/mail-client.integration.test.mjs` → `tests 98, pass 98, fail 0, skipped 0`（含 H-03 的測試，確認沒有改壞）。

### 3. 真 Claude 雙 session 模擬（同一台 Mac；`spikes/h04/`）

兩個互動式 Claude Code（mac＝BlueLake、win＝RedStone）各在自己的專案資料夾，用 `client/templates` 的設定；只有測試腳本代打使用者的字，收信全靠 hook。原始紀錄：`spikes/h04/results/`。

**TC-02（模擬）**：Mac session 留交接（#1）後 `/exit`；新開 win session 只打「開始」。第一則回覆有交接 ID、`/login`、`11/20`、完整 PR 連結（4/4）；接著「再列一次給我的新項目」→「沒有給你的新項目」。

**TC-06（模擬，win 停在等待輸入，n=5）**：

| # | 保存→win 偵測 | →進入 win 對話 | →win 回答已保存 | →mac 偵測到回答 | →mac 回覆 |
|---|---|---|---|---|---|
| 1 | 13.85 | 13.88 | 25.55 | 34.43 | 36.13 |
| 2 | 14.57 | 14.60 | 21.66 | 24.14* | — |
| 3 | 12.28 | 12.32 | 15.03 | 29.44 | 30.94 |
| 4 | 10.60 | 10.63 | 12.87 | 25.96 | 27.29 |
| 5 | 11.45 | 11.47 | 13.91 | 25.03 | 26.33 |

5/5 沒有跳確認就自動回答，回答內容＝README 第一行。\* 第 2 輪腳本把 answer 控制紀錄（#12）當成回答，mac 實際在 24.14 秒偵測到回答 #13；因此修正了 outbox 排序（同一毫秒排入時回覆先送），並加測試。

**權限提示等待中（PM 要求補測；win 以 `--permission-mode default` 開，讓一個 Bash 指令停在權限提示）**：

| 事件 | 時間（以 mac 送出為 0） |
|---|---|
| win watcher 偵測到 #25 | 4.7 秒 |
| 權限提示一直開著 | 到 94.8 秒才回答 |
| 提示開著期間進入對話 | **沒有**（排在 Claude 的佇列，與 F-09 長工具相同） |
| 回答提示後 Claude 處理 #25 | 97.3 秒（回答提示後 2.5 秒） |

→ 權限提示＝「目前這一步」，結束後立即收到，符合 PM 暫定判準；但等多久取決於人什麼時候回答提示。

## 實測中發現並已修正

1. **經 symlink 的 `client/` 會靜默不執行**：主程式判斷拿 `argv[1]`（symlink 路徑）比 `import.meta.url`（實際路徑），永遠不相等 → exit 0、沒有輸出、hook 看起來「成功」。改為比較 realpath，加測試。
2. **auto mode 擋下 `printf … | node client/hub-hook.mjs send`**：開頭不是 `node client/hub-hook.mjs`，對不到範本的允許規則，被判為未核准的對外訊息。改成 `send --json '<JSON>'`，開工說明只教這個寫法。之後 TC-06 5/5 自動回答。
3. **交接被當成動作請求**：交接 envelope 的 intent 預設 action，顯示成 `handoff/action`，模型就照動作請求流程跑 `presented`。改為交接一律標「交接（資訊，不是動作請求）」。
4. **回答不能 CC HubClock**：H-05 把 CC 給它、intent 為 question／action 的 item 當成新請求；回答若 CC 會變成一筆假的動作請求。改為回覆不 CC，另送 `answer` 控制紀錄。

## 已知限制／待 PM、維護者

- **`presented` 的時間點**：權限提示測試中，模型在同一回合先執行 `presented 25`，約 4 秒後才把卡片文字印出來。SDS 要求「真的顯示後」才送；差幾秒對 30 分鐘計時影響小，但嚴格說不符合。若要嚴格，需改成由使用者回應卡片時才送（產品決定）。
- **信任對話框**：範本預先允許 `Bash(node client/hub-hook.mjs:*)`，第一次開會跳「This folder pre-approves 1 tool permission」，**預設選項是 No, exit**；H-07 手冊要寫清楚選 Yes。
- **HubClock 名稱**：範本 `clock_agent` 是佔位字，要填 H-02 產生的實際名稱（`hubclock.sender.json` 的 `agentName`）；沒填時開工會警告、question／action 不會被計時、不送 session.closed，不會猜名字。
- **部署需要兩個資料夾**：hub-hook import `ops/lifecycle/protocol.mjs`（PM 指定共用格式），所以專案裡要同時有 `client/` 與 `ops/lifecycle/protocol.mjs`。
- **同一 agent 同時開兩個 session**：兩個 session 共用同一份本機 staging／cursor，各自有 watcher；不會漏信，但同一則可能兩邊都通知（SDS 規定一個 agent 只開一個主 session）。
- **一次間歇紅燈（已找到原因並修正）**：與 H-05 對齊時，replyTo 測試在一次完整執行中失敗過一次。原因與 TC-06 第 2 輪相同：回覆與 answer 控制紀錄在同一毫秒排入 outbox 時，檔名後半是隨機 key，送出順序約一半機率顛倒，而該測試取「最後一則」當控制紀錄。已改成排序用遞增序號，並加 20 次迴圈的順序測試。
- **未測**：Windows（見下節）、斷網與睡眠恢復、VS Code 擴充裡的 Claude Code。


## Windows：待 維護者 驗（照做約 15 分鐘）

本機只有 Mac，下面是 維護者 在 Windows 上照做的步驟。前提：H-02 的 Hub 已上線，手上有 Windows 的裝置 token 與 RedStone 的 registration token，以及 H-02 產生的 HubClock 名稱。

```powershell
# 0. 版本
claude --version
node --version          # 需 ≥ 22

# 1. 單元測試（預期最後：tests 38, pass 38, fail 0）
cd <repo>
node --test client\test\hub-hook.test.mjs

# 2. 在要測的專案資料夾放設定（<專案> 根目錄要有 client\ 與 ops\lifecycle\protocol.mjs）
Copy-Item client\templates\hub-client.json <專案>\hub-client.json
New-Item -ItemType Directory -Force <專案>\.claude | Out-Null
Copy-Item client\templates\claude-settings.json <專案>\.claude\settings.json
#   打開 <專案>\hub-client.json，把 clock_agent 改成 HubClock 的實際名稱。

# 3. 秘密只放這個 PowerShell 視窗的環境變數（不要寫進任何檔案或 Git）
$env:HUB_TOKEN = '<HUB_TOKEN>'
$env:HUB_SENDER_TOKEN = '<RedStone 的 registration token>'

# 4. 開 Claude（第一次會問 trust：選「Yes, I trust this folder」，預設是 No）
cd <專案>
claude
#   輸入：開始
```

判讀與要記下的東西（截圖要看得到時間）：

| 步驟 | 預期 | 不符合時 |
|---|---|---|
| 4 開工 | 第一則回覆就列出 Mac 留的交接 ID、摘要、PR 連結，並有「最近 5 則交接」 | 若說「Hub 未設定」：檢查步驟 3；若說「無法取得」：Hub 或 token 問題，**不能**說沒有新項目 |
| 5 閒置收信 | Claude 停在等待輸入時，請 Mac 送一則 question 給 RedStone；60 秒內 Windows 自己出現「Hub 新訊息 #ID（不是錯誤）」並回答 | 記實際秒數；>60 秒依 A-4 記為降級 |
| 6 正常結束 | 輸入 `/exit` 後，下列指令沒有輸出（沒有殘留 watcher） | 截圖輸出 |
| 7 強制結束 | 重開 claude，用工作管理員結束 claude.exe（或 `Stop-Process -Id <PID> -Force`），等 20 秒再跑下列指令 → 沒有輸出；再開 claude 輸入「開始」→ 顯示「上次 session 未正常交接」 | 截圖 |

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*hub-hook.mjs*watch*' | Select-Object ProcessId, CommandLine
Get-Content "$env:LOCALAPPDATA\hub-client\group-a\RedStone\hook.log" -Tail 20
```

注意：Windows 不會「收養」孤兒程序，watcher 改用「父程序是否還活著」判斷；這段在 Mac 以單元測試＋真機驗過，Windows 上是第一次實測。強制結束後 watcher 最慢在下一次輪詢（≤15 秒）退出。

## 清理（本次 Mac 測試留下的東西）

- 本機測試 Mail、watcher、測試用 Claude session 都已停止（`ps` 查過無殘留）；單元測試的暫存資料夾改為測完自動刪除。
- `spikes/h04/state/`（已 gitignore）：測試專案、本機 journal、tty 紀錄；不要了就 `rm -rf spikes/h04/state spikes/h04/state-hub.out`。
- 測試 session 的 transcript 在目前 Claude profile 的 projects 目錄：`ls "$CLAUDE_CONFIG_DIR/projects" | grep -E 'spikes-h04-(state|probe)'`，確認後刪除。
- 沒有改任何使用者層或全域設定；信任對話框只在測試資料夾出現過（profile 的 `.claude.json` 沒有新增這些資料夾的紀錄）。
