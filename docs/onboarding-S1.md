# 08 組員接入手冊（S1 初稿：Mac 與 Windows 端）

- **負責**：agy-junior-swe-2（Antigravity）｜**對應票號**：H-07｜**審查**：PM-Emily → 維護者
- **版本**：v0.1 初稿（2026-11-17）
- **依據**：`docs/05-sds.md`（v0.3 權威）、`docs/04-sad.md`、`docs/research/F-08-hostinger-vscode.md`、`docs/06-test-plan.md`
- **適用對象**：新手工程師、專案協作者（S1 階段供 維護者 於 Mac 與 Windows 操作；S2 開放組員時沿用）
- **目標**：語言白話、步驟分明，**在 Windows 上照做 ≤ 15 分鐘接上**。
- **狀態提醒**：本文件為 S1 初稿；待 H-02（VPS 部署）與 H-04（Hook 膠水）交付定稿後，由 PM 安排填入實際運行值。

---

## 快速目錄

1. [前置概念：什麼是裝置 Token？安全第一守則](#1-前置概念什麼是裝置-token安全第一守則)
2. [第一步：拿到 Token 後放哪裡？怎麼設定？](#2-第一步拿到-token-後放哪裡怎麼設定)
   - [A. Mac 使用者（zsh 終端機）](#a-mac-使用者zsh-終端機)
   - [B. Windows 使用者（PowerShell 終端機）](#b-windows-使用者powershell-終端機)
3. [第二步：Claude Code 專案 `.mcp.json` 設定](#3-第二步claude-code-專案-mcpjson-設定)
4. [第三步：自動化 Hook 設定（`.claude/settings.json`）【待 H-04 定稿】](#4-第三步自動化-hook-設定claudesettingsjson待-h-04-定稿)
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

## 2. 第一步：拿到 Token 後放哪裡？怎麼設定？

當 PM 或管理員發給你一組 Token（外觀通常是一串英文與數字，例如 `tok_win_abc123...`），請**將它存放在電腦的「環境變數」中**，變數名稱固定為 `HUB_TOKEN`。
同時，我們將 Hub 的網址也放入環境變數 `HUB_MAIL_URL`，固定為 `https://hub.example.invalid/mcp/`。

請依照你的作業系統選擇對應說明：

### A. Mac 使用者（zsh 終端機）

Mac 預設使用 `zsh`。

#### 1. 暫時設定（只在目前的終端機視窗有效）
適合快速測試：
```zsh
export HUB_MAIL_URL='https://hub.example.invalid/mcp/'
export HUB_TOKEN='<你的_MAC_裝置_TOKEN>'
```
*(請將 `<你的_MAC_裝置_TOKEN>` 替換為實際收到的 Token)*

#### 2. 長久設定（每次打開終端機都有效，推薦）
把變數寫入個人設定檔 `~/.zshrc`：
```zsh
echo 'export HUB_MAIL_URL="https://hub.example.invalid/mcp/"' >> ~/.zshrc
echo 'export HUB_TOKEN="<你的_MAC_裝置_TOKEN>"' >> ~/.zshrc   # 注意：token 會以明文存在 ~/.zshrc，不要把這個檔案同步或分享
source ~/.zshrc
```

#### 3. 怎麼確認設好了？
執行以下指令檢查變數是否有值（為防外洩，只印出長度）：
```zsh
echo "HUB_MAIL_URL: $HUB_MAIL_URL"
echo "HUB_TOKEN 長度: ${#HUB_TOKEN} 字元"
```
若「HUB_TOKEN 長度」大於 0（非空），即表示設定成功！

---

### B. Windows 使用者（PowerShell 終端機）

Windows 使用者請打開 **PowerShell**（非 CMD 命令提示字元）。

#### 1. 暫時設定（只在目前的 PowerShell 視窗有效）
適合快速測試：
```powershell
$env:HUB_MAIL_URL = "https://hub.example.invalid/mcp/"
$env:HUB_TOKEN = "<你的_WINDOWS_裝置_TOKEN>"
```
*(請將 `<你的_WINDOWS_裝置_TOKEN>` 替換為實際收到的 Token)*

#### 2. 長久設定（永久寫入使用者環境變數，重開視窗仍在，推薦）
在 PowerShell 中執行以下兩行指令，將設定儲存到 Windows 使用者註冊表：
```powershell
[System.Environment]::SetEnvironmentVariable('HUB_MAIL_URL', 'https://hub.example.invalid/mcp/', 'User')
[System.Environment]::SetEnvironmentVariable('HUB_TOKEN', '<你的_WINDOWS_裝置_TOKEN>', 'User')
```
> [!NOTE]
> 設定完成後，**必須將目前開著的 PowerShell / VS Code 視窗全部關閉並重新打開**，新的環境變數才會被讀入。

#### 3. 怎麼確認設好了？
在新開的 PowerShell 視窗中執行：
```powershell
Write-Host "HUB_MAIL_URL: $env:HUB_MAIL_URL"
Write-Host "HUB_TOKEN 長度: $($env:HUB_TOKEN.Length) 字元"
```
若看到網址正確且長度大於 0，即表示設定成功！

---

## 3. 第二步：Claude Code 專案 `.mcp.json` 設定

在你的專案根目錄下，檢查或建立 `.mcp.json` 檔案。

這個檔案告訴 Claude Code 如何連線到我們的通訊 Hub。因為我們在第一步已經設定好環境變數，這裡**直接參照環境變數名稱**，不需要寫入真實密鑰，這個檔案也可以安心被 Git 追蹤。

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

> [!TIP]
> **如果不方便手動編輯檔案**，也可以在專案目錄下用命令列指令加入（以 Mac/Linux bash 為例）：
> ```bash
> claude mcp add --transport http --scope local hub https://hub.example.invalid/mcp/ --header "Authorization: Bearer <HUB_TOKEN>"
> ```
> *注意：透過命令列指令加入時，Token 可能會被留在終端機歷史紀錄中，建議優先使用範本檔案配合環境變數展開。*

---

## 4. 第三步：自動化 Hook 設定（`.claude/settings.json`）【待 H-04 定稿】

在我們的架構中，AI 需要在「開工時自動讀取最近交接」、「工作時每隔一段時間檢查新訊息」、「結束時回報交接」。這套自動化依靠 Claude Code 的 Hook 機制執行。

> [!IMPORTANT]
> **區塊狀態：【待 H-04 定稿】**
> 目前 swe-Ben 正在進行 H-04 / H-04a 開發（`client/hub-hook.mjs` 與 `asyncRewake` 測試）。
> 預計於 11-20～11-22 定稿。以下為 SDS v0.3 設計之標準設定內容，供預覽參考：

設定檔路徑：專案目錄下之 `.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [
      {"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/client/hub-hook.mjs","start"],"timeout":20},
      {"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/client/hub-hook.mjs","watch"],"asyncRewake":true,"timeout":3600}
    ]}],
    "Stop": [{"hooks": [
      {"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/client/hub-hook.mjs","stop"],"timeout":15},
      {"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/client/hub-hook.mjs","watch"],"asyncRewake":true,"timeout":3600}
    ]}],
    "SessionEnd": [{"hooks": [
      {"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/client/hub-hook.mjs","end"],"timeout":5}
    ]}]
  }
}
```

- **先決條件**：本機電腦必須安裝有 Node.js（終端機輸入 `node -v` 能正確印出版本，建議 LTS v18 或 v20 以上）。
- **行為說明**：
  - `SessionStart`：啟動 session 時，自動抓取未讀訊息與最近 5 則交接（G2+G3 已定 N=5）。
  - `watch`（`asyncRewake: true`）：在背景每 15 秒檢查一次是否有新訊息，有訊息時喚醒 Claude Code。
  - `Stop`：每段工作停止時檢查 checkpoint。
  - `SessionEnd`：session 結束時上報狀態，避免懸掛未完成狀態。

---

## 5. 第四步：如何確認成功接上？

設定好 `.mcp.json` 與環境變數後，請依照以下步驟驗證連線：

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
- 看到 `HTTP 狀態碼: 200`：恭喜！Token 正確且 Hub 連線順暢。
- 看到 `HTTP 狀態碼: 401`：Token 錯誤或已被撤銷。
- 看到 `HTTP 狀態碼: 502` 或連線超時：Hub 後端維護中或網路受阻。

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
  2. 若長度為 0，請重新執行第一步的環境變數設定指令。
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

- **現象**：啟動 Claude Code 時沒有自動印出交接摘要，或終端機跳出 `command not found: node` / `spawn node ENOENT`。
- **原因**：
  1. 本機未安裝 Node.js，或 Node.js 沒有加入系統 PATH。
  2. 專案尚未拉取最新的 `client/hub-hook.mjs` 檔案（此票目前為 S1 初稿階段，H-04 正在實作中）。
  3. `.claude/settings.json` 的 JSON 格式有語法錯誤（例如少逗號或括號）。
- **排查步驟**：
  1. 檢查 Node 是否就緒：終端機執行 `node -v`。若顯示找不到指令，請先至 [Node.js 官方網站](https://nodejs.org/) 下載安裝 LTS 版本。
  2. 檢查檔案是否存在：確認專案目錄下是否有 `client/hub-hook.mjs`。若檔案尚未存在，請暫時不要啟用 `.claude/settings.json`，等 H-04 定稿後再合併使用。

---

## 8. Windows 新手 15 分鐘極速檢核清單（Checklist）

維護者 或組員在 Windows 上設定時，可對照以下時間表，15 分鐘內輕鬆完成：

| 時間（分） | 步驟 | 檢核動作 | 通過判準 |
|---|---|---|---|
| **00 ~ 03** | **步驟 1：設環境變數** | 打開 PowerShell，貼上 SetEnvironmentVariable 指令設定 `HUB_TOKEN` 與 `HUB_MAIL_URL`。關閉並重開 PowerShell。 | 執行 `Write-Host $env:HUB_TOKEN.Length`，數值 > 0。 |
| **03 ~ 06** | **步驟 2：放 `.mcp.json`** | 確保專案根目錄有 `.mcp.json`，內容參照第三節範本（使用 `${HUB_MAIL_URL}` 與 `${HUB_TOKEN}`）。 | 檔案存在且 JSON 語法無誤。 |
| **06 ~ 10** | **步驟 3：驗證 MCP 連線** | 在專案路徑下執行 `claude`，進入後輸入 `/mcp`。 | 看到 `hub` 狀態為綠色或 Connected，且有 `send_message` 等工具。 |
| **10 ~ 13** | **步驟 4：快速健康探測** | 在 PowerShell 執行 `curl.exe` 探測指令。 | 回傳 `HTTP 狀態碼: 200`。 |
| **13 ~ 15** | **步驟 5：完成登記** | 在群組中回報「Windows 已接上 Hub」。 | 準備開始接收非同步交接任務！ |

---
*文件維護紀錄：*
- 2026-11-17：初稿建立（H-07，agy-junior-swe-2），遵循 SDS v0.3 與 F-08 調研，涵蓋 Mac/Win 獨立說明與 ≤15 分鐘流程。
