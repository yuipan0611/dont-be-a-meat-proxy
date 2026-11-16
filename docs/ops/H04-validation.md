# H-04 驗收紀錄：hub-hook（開工／收信／收工）

- 負責：swe-Ben｜審查：PM-Emily｜日期：2026-11-17
- 規格：`docs/07-tickets-mvp.md` H-04、SDS CLI-02／CLI-03、API-06；H-04a 結論見 `docs/research/F-09-asyncrewake-spike.md`
- 產出：`client/hub-hook.mjs`、`client/templates/{claude-settings.json,hub-client.json}`、`client/README.md`（hub-hook 段）、測試 `client/test/hub-hook*.test.mjs`、雙 session 模擬 `spikes/h04/`
- 環境：macOS、Claude Code 2.1.325、Node 24.18.0、mcp_agent_mail_rust 0.3.40（本機，SHA-256 `4c3804fe…5bead`）

<!-- RESULTS -->

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
