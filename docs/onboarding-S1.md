# 08 組員接入手冊（Mac、Windows、Linux）

- **負責**：agy-junior-swe-2（Antigravity）｜**對應票號**：H-07｜**審查**：PM-Emily → 維護者
- **版本**：v0.4 Hub 一行安裝
- **依據**：`docs/05-sds.md`（v0.3 權威）、`docs/04-sad.md`、`docs/research/F-08-hostinger-vscode.md`、`docs/06-test-plan.md`
- **適用對象**：新手工程師、專案協作者（S1 階段供 維護者 於 Mac 與 Windows 操作；S2 開放組員時沿用）
- **目標**：語言白話、步驟分明，**在 Windows 上照做 ≤ 15 分鐘接上**。
- **狀態提醒**：L-09 已部署，組員請等 PM 通知開放接入，再照本手冊操作。驗收進度見 [S1 驗收紀錄](delivery-S1.md)。

---

## 最快方式：三步

1. **加入 Discord。** 用 PM 提供的邀請加入專案伺服器，等 PM 開放接入並綁定你的組員身分。
2. **輸入 `/connect`。** 選這台電腦的 `macos`、`windows` 或 `linux`。從只有你看得到的回覆取得 Agent、平台、組別與 Token。如果 Agent 尚未配發，請向 PM 確認名稱。保留 Token ID，日後可用 `/revoke` 撤銷。
3. **在專案資料夾開啟終端機，貼一行安裝指令。** 需要 [Node.js 22 或更新版](https://nodejs.org/en/download)。依提示貼入 Agent、平台和 Token。Token 提示不會回顯；整段 Token 只貼在這個提示。

**Mac 或 Linux**

```sh
curl -fsS 'https://hub.example.invalid/install.sh' | sh
```

**Windows PowerShell 5.1 或 7**

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://hub.example.invalid/install.ps1')))
```

看到 `✅ Hub readiness 200` 和 `✅ Hub inbox can be listed` 代表這台裝置可以連線並列出收件匣。開一個新終端機，回原專案資料夾執行 `hub claude`，核對 Claude 的專案信任及 MCP 啟用提示。其他專案可在該資料夾執行 `hub setup`。沒裝 Claude Code 時，安裝器會印出 Codex 與 Cursor 的 MCP 設定與啟動方式。

- **更新**用 `hub update`，沿用這台裝置的 Token。新版先驗雜湊、啟動並檢查 Hub，通過才換版。
- **排查**用 `hub doctor`。若找不到 `hub`，重開終端機；Mac／Linux 可直接用 `"$HOME/.hub-client/bin/hub" doctor`，Windows 可用 `& "$env:LOCALAPPDATA\hub-client\bin\hub.cmd" doctor`。
- **卸載**用 `hub uninstall`。已發出的裝置 Token 在 Discord 用 `/revoke` 撤銷。
- **寄信與回報**使用 Agent Mail 的 sender token。向 PM 私下取得對應 Agent 的 `sender-token` 檔並放到見下表的資料夾。Mac／Linux 設為 600；Windows 以目前帳號私有權限保存。原本的 `HUB_SENDER_TOKEN` 也可沿用。

| 平台 | `sender-token` 的資料夾 |
|---|---|
| Mac | `~/Library/Application Support/hub-client/<組別>/<Agent>/` |
| Linux | `${XDG_DATA_HOME:-$HOME/.hub-local/share}/hub-client/<組別>/<Agent>/` |
| Windows | `%LOCALAPPDATA%\hub-client\<組別>\<Agent>\` |

已用舊手動設定的 Claude 專案可保留手動方式。若要切換，先備份 `.mcp.json` 與 `.claude/` 內設定，移除舊 Hub 的伺服器項和舊 `hub-hook.mjs` hooks，再執行 `hub setup`。

---

## 附錄｜手動安裝與排查

### 附錄目錄

1. [前置概念：什麼是裝置 Token？安全第一守則](#1-前置概念什麼是裝置-token安全第一守則)
2. [第一步：加入 Discord、領取並保存裝置 Token](#2-第一步加入-discord領取並保存裝置-token)
   - [Mac 或 Windows 的裝置設定檔](#mac-或-windows-的裝置設定檔)
3. [第二步：Claude Code 專案 `.mcp.json` 設定](#3-第二步claude-code-專案-mcpjson-設定)
4. [第三步：自動化 Hook 設定（`.claude/settings.json`）](#4-第三步自動化-hook-設定claudesettingsjson)
5. [第四步：如何確認成功接上？](#5-第四步如何確認成功接上)
6. [常見其他工具沿用性（Codex、Antigravity、VS Code 擴充）](#6-常見其他工具沿用性codexantigravityvs-code-擴充)
7. [常見錯誤與排查指引（401、連不上、Hook 沒反應）](#7-常見錯誤與排查指引401連不上hook-沒反應)
8. [Windows 新手 15 分鐘極速檢核清單（Checklist）](#8-windows-新手-15-分鐘極速檢核清單checklist)

---

## 1. 前置概念：什麼是裝置 Token？安全第一守則

在我們的專案中，所有的 AI（例如 Mac 上的 Claude、Windows 上的 Claude）都是透過遠端的 **Agent Mail Hub**（網址：`https://hub.example.invalid/mcp/`）來互相傳遞工作進度與交接訊息。

為了確認是誰在連線，伺服器採用「**每台裝置獨立一把 Token**」的規則：
- 你的 Mac 會有一把專屬 Token。
- 你的 Windows 會有一把專屬 Token。

> [!CAUTION]
> **三個絕對不要（秘密保護規則）**：
> 1. **絕對不要把 Token 寫進 Git**：不要把真實 Token 寫死在任何會 `git commit` 的檔案中。
> 2. **絕對不要把 Token 貼到公開聊天室**：不要貼在 Discord 公開頻道、GitHub Issue 或 LINE。
> 3. **絕對不要在截圖中露出完整 Token**：遇到問題請教別人時，請遮蔽 Token。

---

## 2. 第一步：加入 Discord、領取並保存裝置 Token

🟡 1. 用 PM 提供的邀請連結加入專案 Discord 伺服器。

🟡 2. 確認 PM 已開放組員接入，且你的 Discord 帳號已與組員身分綁定。

🟡 3. 在專案頻道選擇 `/connect`，在 `platform` 選這台裝置的 **Mac** 或 **Windows**，可在 `device` 填裝置名稱，再送出。

🟡 4. 確認機器人的回覆顯示「只有你看得到」，並複製 `Token` 欄位中的完整字串。

🟡 5. 私下另外記下回覆中的 Token ID。裝置遺失或 token 外洩時，用 `/revoke` 的 `token_id` 選項撤銷，再用 `/connect` 領新值。

每次 `/connect` 都會新發一把裝置 token，舊值仍有效。既有 MVP 裝置只更新程式時可沿用原本的有效憑證。若看不到指令、顯示非組員或發放失敗，請把錯誤文字回報 PM，並遮蔽憑證。

### Mac 或 Windows 的裝置設定檔

🟡 6. 打開 Hub 專案根目錄；已有桌面 `hub-win` 的 Windows 使用者可先做 [L-09 更新](ops/windows-update-L09.md)。

🟡 7. 在根目錄的 `.hub-local/h02-client/` 中開啟或建立自己的設定檔。Mac 用 `mac.env`，Windows 用 `windows.env`。

🟡 8. 在設定檔填下面兩行，把第二行的佔位文字換成剛拿到的值。等號兩邊貼齊文字，用 UTF-8（無 BOM）存檔。

```dotenv
HUB_MAIL_URL=https://hub.example.invalid/mcp/
HUB_TOKEN=<你的裝置_TOKEN>
```

🟡 9. 把 PM 私下配發的 sender 設定檔放進同一資料夾，Mac 用 `mac.sender.json`，Windows 用 `windows.sender.json`。

🟡 10. 接著完成 §3 的 `.mcp.json`、§4 的 Hook 設定及憑證載入、§5 的連線檢查。

`HUB_TOKEN` 是 Discord 發的入口憑證。PM 配發的 sender 檔提供送信所需的 agent 名稱與 `HUB_SENDER_TOKEN`。Mac 將兩個本機私密檔的權限設成 600，Windows 將它們留在只有自己可讀的資料夾。`.hub-local/` 應由 Git 忽略，請勿分享。MVP 啟動腳本會從對應的 `.env` 讀取 `HUB_TOKEN`。

---

## 3. 第二步：Claude Code 專案 `.mcp.json` 設定

在你的專案根目錄下，檢查或建立 `.mcp.json` 檔案。

這個檔案告訴 Claude Code 如何連線到 Hub，並**參照 §4 B 載入的環境變數**。請使用下面的變數名稱，讓入口憑證留在裝置的私密設定檔。

請直接照抄以下內容（格式嚴格依據 SDS v0.3 CLI-01 契約）：

```json
{
  "mcpServers": {
    "hub": {
      "type": "http",
      "url": "${HUB_MAIL_URL}",
      "headers": {
        "Authorization": "Bearer ${HUB_TOKEN}"
      }
    }
  }
}
```

---

## 4. 第三步：自動化 Hook 設定（`.claude/settings.json`）

這裡接上開工讀交接、15 秒輪詢、checkpoint 與結束回報。**Node ≥22**；本次開發環境為 Node 24.18.0、Claude Code 2.1.325。先在專案根目錄執行 `node --version`、`claude --version`，找不到指令就先處理 PATH，不要繼續。

### A. 放正確設定，保留已有內容

1. 確認目前資料夾內有 `client/hub-hook.mjs`。用 [hub-client.json 範本](../client/templates/hub-client.json) 建立根目錄 `hub-client.json`；有舊檔就逐項核對，別覆蓋。`group_id`、`project_key`、`agents` 與 `peers` 採用 PM 提供的本組設定。`/data/projects/group-a` 是 A 組在 Hub 上的 project key。
2. 向 PM 取得 HubClock 的**公開 canonical 名稱**，填入 `clock_agent`。來源是 VPS `hubclock.sender.json.agentName`，不是字面 `HubClock`；不要索取或複製 HubClock 的 sender token。placeholder 留著會跳過控制回報，不能當作接入完成。
3. 把 [claude-settings.json 範本](../client/templates/claude-settings.json) 的 hooks 及專案所需 `permissions.allow` 合併進 `.claude/settings.json`。僅在目標檔不存在時整份複製；保留其他 hooks 與權限，不調整全域設定或 permission mode。範本用 exec form `command: node` 與 `args`，Mac／Windows 共用；Windows 的 Node 必須是可執行的 `node.exe`。
4. 在 `hub-client.json` 將 `memory_agent` 設為 `NavyOrchid`（維護者 的 A 組）。若舊檔沒有這個欄位，依完整範例新增。其他組請向 PM 確認該組 MemoryBridge 的公開名稱。Hook 會把新交接、checkpoint 和決策副本轉給這個 agent，供 `/status` 查詢。若有設定 `HUB_MEMORY_AGENT`，其值優先於 JSON。 [完整設定範例](ops/windows-update-L09.md#2-備份並換檔)
5. 在根目錄驗 JSON：

```sh
node -e 'const fs=require("node:fs"); for (const p of ["hub-client.json",".claude/settings.json"]) { JSON.parse(fs.readFileSync(p,"utf8")); console.log(p+" JSON OK"); }'
```

Windows PowerShell 改用：

```powershell
foreach ($H04Config in @('hub-client.json', '.claude/settings.json')) {
  Get-Content $H04Config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop | Out-Null
  Write-Output ($H04Config + ' JSON OK')
}
```

預期兩行 `JSON OK`。若 `ENOENT`，核對 cwd 與檔名；若 JSON 語法錯，檢查逗號、引號，不能把註解放進 JSON。

### B. 載入這台裝置的兩種憑證

第一步的 `HUB_TOKEN` 只管入口；Hook 送信另需 `HUB_SENDER_TOKEN`，必須與本機 `HUB_AGENT` 配對。以下讀取 §2 保存的裝置設定與 PM 配發的 sender 檔，只影響目前終端機。從這個終端機啟動的 Claude 才會繼承。

Mac（專案根目錄）：

```zsh
set -a
source .hub-local/h02-client/mac.env
set +a
export HUB_AGENT="$(node -p 'JSON.parse(require("node:fs").readFileSync(".hub-local/h02-client/mac.sender.json","utf8")).agentName')"
export HUB_SENDER_TOKEN="$(node -p 'JSON.parse(require("node:fs").readFileSync(".hub-local/h02-client/mac.sender.json","utf8")).senderToken')"
node -e 'for (const k of ["HUB_TOKEN","HUB_AGENT","HUB_SENDER_TOKEN"]) { if (!process.env[k]) throw Error(k+" missing"); } console.log("device credentials present");'
```

Windows（PowerShell；只放此 Windows 裝置的檔案到自己的 `.hub-local/h02-client`，勿把 Mac sender token 混入）：

```powershell
Get-Content .hub-local/h02-client/windows.env -ErrorAction Stop | ForEach-Object {
  $H04Pair = $_ -split '=', 2
  if ($H04Pair.Count -eq 2 -and $H04Pair[0] -in @('HUB_TOKEN', 'HUB_MAIL_URL')) {
    Set-Item -Path ('Env:' + $H04Pair[0]) -Value $H04Pair[1]
  }
}
$H04Sender = Get-Content .hub-local/h02-client/windows.sender.json -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$env:HUB_AGENT = $H04Sender.agentName
$env:HUB_SENDER_TOKEN = $H04Sender.senderToken
Remove-Variable H04Sender, H04Pair -ErrorAction SilentlyContinue
foreach ($H04Key in @('HUB_TOKEN', 'HUB_AGENT', 'HUB_SENDER_TOKEN')) {
  if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($H04Key))) { throw ($H04Key + ' missing') }
}
Write-Output 'device credentials present'
```

預期只有 `device credentials present`，不印出密鑰。`missing` 就停下核對自己的檔案與環境；此檢查只證明有值，身分是否有效仍須真 Hub 送讀驗證。保持檔案私密並排除 Git，Mac 私密檔權限為 600；Windows 僅自己的使用者可讀。關閉終端機後重新載入，不需更改全域環境設定。

### C. 信任資料夾，再確認 Hook 真的啟動

1. 在剛才的**根目錄與同一終端機**執行 `claude`。如果有資料夾信任提示，核對顯示路徑與設定內容後，明確選中 **Yes, I trust this folder** 再 Enter。實際測試畫面曾預選 **No, exit**，直接 Enter 會退出；不要假設 Yes 是第幾項。
2. 若未核准信任，interactive Claude 會暫停所有設定來源的 hooks。不要透過改全域權限、修改 `.claude.json` 或切換 permission mode 處理。`CLAUDE_CONFIG_DIR` 若有值，代表目前使用另一份 profile；保留原設定並告知 PM「有設定」即可。[官方 Workspace trust](https://code.claude.com/docs/en/hooks#workspace-trust)、[設定來源](https://code.claude.com/docs/en/settings)
3. 進入後用 `/hooks` 核對 SessionStart／Stop／SessionEnd，指令路徑應指到此專案。另一終端機查看下列 `hook.log` 的**本次新事件**，應有 `ev: start` 和 `ev: watch-arm`。記下時間及 session ID，不能只憑舊事件判定。

預設 log 位置（範本為 group-a、Mac BlueLake／Windows RedStone）：

```zsh
tail -n 10 "$HOME/Library/Application Support/hub-client/group-a/BlueLake/hook.log"
```

```powershell
Get-Content "$env:LOCALAPPDATA/hub-client/group-a/RedStone/hook.log" -Tail 10
```

若有 `HUB_DATA_DIR`，改讀該目錄的 `hook.log`。log 與耐久收件含工作資訊，只在本機查看，分享前遮蔽；不要上傳整份目錄。

4. `start.syncError` 應為 null；Claude 應明說無新項目，或逐字列出可取得的項目。出現「無法取得」就查憑證／連線，不能當成空收件匣。`watch-skip` 可能已有同 session watcher，需搭配 `watch-arm` 與程序確認；不能單看 skip 說成功。若開工畫面提醒缺少 `memory_agent`，依 §4 A 補上後重開 Claude。
5. SessionStart 讀最近 5 則交接；watch 每 15 秒輪詢，有訊息 exit 2 喚醒，55 分鐘自行到期、Stop 重掛；SessionEnd 在預算內回報 `session.closed`。watch exit 2 是通知，不是部署壞掉。`/exit` 若顯示背景工作確認，選 **Exit and stop tasks** 才算關完。
6. Windows 的 idle／回答中／長工具／正常退出／孤兒程序，照 [client README Windows 驗證](../client/README.md#yui-的-windows-驗證尚未實測) 執行並交回版本、ID、延遲表。未實測前保留「待驗」，不能以 Mac 模擬結果替代。

## 5. 第四步：如何確認成功接上？

設定好 `.mcp.json` 與環境變數後，請依照以下步驟驗證連線。MCP Connected 只證明 MCP 接入；Hook 另依 §4 的 `/hooks` 與本次 start 事件確認。

### 驗證步驟 A：啟動 Claude Code 並輸入 `/mcp`

1. 打開終端機（Mac Terminal 或 Windows PowerShell），切換到專案資料夾。
2. 啟動 Claude Code：
   ```bash
   claude
   ```
3. 在交談介面中輸入斜線指令：
   ```text
   /mcp
   ```
4. **看到什麼算成功？**
   - 伺服器列表中會顯示 `hub`。
   - 狀態必須顯示為綠色或連線成功（例如：`✓ Connected` 或類似已連線標示）。
   - 在提供的工具清單中，可以看到來自 Agent Mail 的原生通訊工具：
     - `send_message`（發送交接與訊息）
     - `fetch_inbox`（讀取收件匣）
     - `fetch_inbox_events`（以游標讀取事件）
     - `register_agent`（註冊 agent 身分）
   - 若狀態顯示為紅色、Error 或 Disconnected，請參閱後文的排查指引。

### 驗證步驟 B：用命令列快速檢查（不進交談介面）

在終端機中直接執行：
```bash
claude mcp list
```
**預期輸出**：`hub` 旁邊標示為 `Connected`。

### 驗證步驟 C：極速網路探測（進階）

若懷疑網路或 Token 設定有問題，可在本機終端機直接測試 HTTP 連線：

- **Mac (zsh)**：
  ```zsh
  curl -s -o /dev/null -w "HTTP 狀態碼: %{http_code}\n" -X POST https://hub.example.invalid/mcp/ \
    -H "Authorization: Bearer $HUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```
- **Windows (PowerShell)**：
  ```powershell
  curl.exe -s -o $null -w "HTTP 狀態碼: %{http_code}`n" -X POST https://hub.example.invalid/mcp/ `
    -H "Authorization: Bearer $env:HUB_TOKEN" `
    -H "Content-Type: application/json" `
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'
  ```

**判準**（PM 註：MCP 未先 initialize、缺 `Accept: application/json, text/event-stream` 時，伺服器可能回 400／406 而不是 200；實際判準待 H-02 部署後實測再定，目前只把 401 當作確定的判斷）：
- 看到 `HTTP 狀態碼: 200`：只證明 HTTP 回應，還須確認 MCP JSON 沒有 error；正式送讀請用 H-02 驗證指令，不能只據狀態碼報驗收成功。
- 看到 `HTTP 狀態碼: 401`：Token 錯誤或已被撤銷。
- 看到 `HTTP 狀態碼: 502` 或連線超時：Hub 後端維護中或網路受阻。

### 驗證步驟 D：回 Discord 試問 `/status`

🟡 1. 確認 `/mcp` 中的 `hub` 已連線，且 §4 的 Hook 檢查已完成。

🟡 2. 回到專案 Discord 頻道，選 `/status`，在 `question` 輸入「目前最新的交接是什麼？」；保留 `public` 的預設值。

🟡 3. 確認回覆只有本人可見；已有同步的交接時，核對回覆尾端「依據：#ID（台北時間）」是否對得上交接。

🟡 4. 若明知有新交接卻回「記憶中沒有這項資訊」，交回不含憑證的 Mail ID 及時間，請 PM 查該筆同步。

驗收進度以 [S1 驗收紀錄](delivery-S1.md) 的 TC-16、TC-17 為準。

---

## 6. 常見其他工具沿用性（Codex、Antigravity、VS Code 擴充）

依據研究報告 `docs/research/F-08-hostinger-vscode.md` 調研結果，各 AI 工具在 VS Code 或獨立環境中的沿用性如下：

| AI 工具 | 執行型態與路徑 | 能否沿用本專案 MCP 設定？ | 設定檔位置與格式說明 | 狀態與待確認事項 |
|---|---|---|---|---|
| **Claude Code** (CLI / VS Code 擴充) | 官方 CLI 及 VS Code 擴充 | **完全支援** | 專案目錄 `.mcp.json`；或使用者全域：<br>Mac: `~/.claude.json`<br>Win: `%USERPROFILE%\.claude.json` | **S1 MVP 核心支援**。<br>擴充與 CLI 共用設定。 |
| **OpenAI Codex** (CLI / VS Code 擴充) | OpenAI Codex 官方 | **可以沿用** | 設定檔為 TOML 格式：<br>Mac: `~/.codex/config.toml`<br>Win: `%USERPROFILE%\.codex\config.toml`<br>內容如下：<br>`[mcp_servers.hub]`<br>`url = "https://hub.example.invalid/mcp/"`<br>`bearer_token_env_var = "HUB_TOKEN"` | **【待確認】**：<br>1. VS Code 擴充程式是否會完整繼承終端機環境變數（建議 Windows 設為系統使用者變數）。<br>2. Codex 自身不支援 Claude Hook，目前**不保證 ≤60 秒被動喚醒**。 |
| **Antigravity** (IDE / agy CLI) | Google Antigravity 官方獨立 IDE 或 `agy` | **可以沿用（獨立 IDE 內）** | 全域設定檔：<br>Mac: `~/.gemini/config/mcp_config.json`<br>Win: `%USERPROFILE%\.gemini\config\mcp_config.json`<br>格式為 Streamable HTTP（`headers.Authorization`）。 | **【待確認】**：<br>1. 市集現況：微軟 VS Code 市集中**無獨立發行之 Antigravity 擴充**（多數人其實是在執行外觀相同的 Antigravity 獨立 IDE）。<br>2. Antigravity 的自動喚醒機制未列入 S1 保證。 |
| **VS Code 原生** (GitHub Copilot / VS Code 1.96+) | 標準 VS Code 原生 MCP | **可以沿用（需改欄位）** | 工作區檔案 `.vscode/mcp.json`。<br>注意最頂層鍵名為 `"servers"`（**非** `"mcpServers"`），且型態須為 `"type": "http"`。 | **【待確認】**：<br>依 VS Code 官方 1.96+ 規格支援，但不包含自動收發信生命週期 Hook。 |

---

## 7. 常見錯誤與排查指引（401、連不上、Hook 沒反應）

### 錯誤一：HTTP 401（未授權 / 連線未授權或已撤銷，E-AUTH）

- **現象**：執行 `/mcp` 顯示連線失敗；或 curl 測試印出 `401`。
- **原因**：
  1. 環境變數 `HUB_TOKEN` 為空或拼字錯誤。
  2. 你的裝置 Token 已經被管理員在伺服器端撤銷（例如裝置輪替或安全撤銷）。
  3. 設定了環境變數，但終端機/編輯器尚未重啟，導致讀取不到。
- **排查步驟**：
  1. 檢查變數是否真的存在：
     - Mac: `echo "長度: ${#HUB_TOKEN}"`
     - Windows: `Write-Host "長度: $($env:HUB_TOKEN.Length)"`
  2. 若長度為 0，核對 §2 的本機設定檔，並重新執行 §4 B 的憑證載入指令。
  3. 若長度正常但依舊 401，請聯繫 PM（Emily），確認該 Token 是否已被撤銷或未正確加入 Caddy allowlist。

---

### 錯誤二：連不上（HTTP 502 / 連線逾時 / Connection Refused，E-HUB）

- **現象**：出現 `Failed to fetch`、`Bad Gateway` 或等待十幾秒後 Timeout。
- **原因**：
  1. 網址打錯（請特別注意結尾必須有斜線 `/mcp/`）。
  2. VPS 上的 Caddy 伺服器或 Agent Mail 容器正在重啟或維護中。
  3. 本地端 DNS 尚未解析到 `hub.example.invalid`。
- **排查步驟**：
  1. 檢查網址是否完全相符：`https://hub.example.invalid/mcp/`。
  2. 檢查本機 DNS 解析：
     - 在命令列執行 `nslookup hub.example.invalid`。
     - 確認解析出來的 IP 是 Hostinger VPS 的公網 IP。
  3. 測試伺服器是否存活：
     - 在瀏覽器或終端機開啟 `https://hub.example.invalid/`，若回傳 `401 Unauthorized` 代表伺服器運作正常且入口保護生效；若瀏覽器顯示「無法連上這個網站」，代表 VPS 離線或 DNS 異常，請回報 PM。

---

### 錯誤三：Hook 沒觸發或開工報錯

按順序查：

1. 是否仍停在資料夾信任提示，或按了預選 No, exit？核對後明確選 Yes；設定檔存在不代表已執行。
2. cwd 是否是有 `.claude/settings.json`、`hub-client.json`、`client/hub-hook.mjs` 的根目錄？`/hooks` 是否列出本專案路徑？
3. `node --version` 是否 ≥22？Windows `Get-Command node` 是否找到 node.exe？JSON 檢查是否兩個都 OK？
4. 是否從載入憑證的同一個終端機啟動 Claude？`HUB_TOKEN`、`HUB_AGENT`、`HUB_SENDER_TOKEN` 是否都存在且配對？`clock_agent` 是否已換成真 canonical 名稱？不要印出 token。
5. 是否使用 `--bare`、`--restricted` 或忽略 project 的 `--setting-sources`？本驗證使用正常 interactive 啟動。`-p` 的信任處理不同，不能當作 interactive hooks 證據。
6. 是否有本次 `start`／`watch-arm`，`start.syncError` 是否為 null？PID 存在、`/mcp` 綠色、手動送信成功，皆不代表 Hook 載入。只有 `outbox-sent` 更不能代替 start。

仍失敗就交回版本、cwd、`CLAUDE_CONFIG_DIR` 是否存在、錯誤類型、事件時間與 ID；不要傳設定檔中的 token 或整份 profile。詳見 [H-04 診斷](ops/H04-validation.md)。

---

## 8. Windows 新手 15 分鐘極速檢核清單（Checklist）

以下為接入設定的目標時間，雙向真機驗收另依 §4 C 執行。

| 時間（分） | 步驟 | 檢核動作 | 通過判準 |
|---|---|---|---|
| **00 ~ 03** | **步驟 1：載入裝置憑證** | 依 §2 領取並保存 token，在 PowerShell 依 §4 B 載入 Windows 私密檔。 | 印出 `device credentials present`，不印出值。 |
| **03 ~ 06** | **步驟 2：核對本機設定** | 依 §3 檢查 `.mcp.json`，依 §4 A 設定 `hub-client.json` 的 `memory_agent` 及 Hook。 | 設定檔可解析且使用本組名稱。 |
| **06 ~ 10** | **步驟 3：驗證 MCP 連線** | 在專案路徑下執行 `claude`，進入後輸入 `/mcp`。 | 看到 `hub` 狀態為綠色或 Connected，且有 `send_message` 等工具。 |
| **10 ~ 13** | **步驟 4：看 Hook 並試問** | 確認本次 `start`／`watch-arm`，回 Discord 執行 `/status`。 | Hook 讀取成功，收到私人回覆並按 §5 D 核對。 |
| **13 ~ 15** | **步驟 5：完成登記** | 確認 `/hooks` 與本次 start，另完成 client README 的 Windows 驗證。 | 交回實際結果；未驗部分明列待驗。 |

---
*文件維護紀錄：*
- 2026-11-17：初稿建立（H-07，agy-junior-swe-2），遵循 SDS v0.3 與 F-08 調研，涵蓋 Mac/Win 獨立說明與 ≤15 分鐘流程。
- 2026-11-17：H-04 收尾補入雙 token、真 canonical clock 名稱、workspace trust、啟動證據與 Windows 待驗步驟（Codex）。
- 2026-11-18：L-09 補入 Discord 領取裝置 token、`memory_agent` 與 `/status` 試問（P-6）。
