# H-04 收尾驗證與 interactive 信任診斷

2026-11-17，Codex；承接 Ben 分支 `example-org/swe-Ben` 的 `e0ed89f`，合併點 `9cba67e`。這次完成 Hook 單元／真 Mail 子程序整合重跑，補 client README 及 H-07 操作步驟；未執行真 Claude 模型對話、Windows、正式 VPS 或 SSH 操作。

## 本機測試

環境：macOS、Node `v24.18.0`、Claude Code `2.1.325`。Mail 是 F-01b 已有的本機 binary，SHA-256 `4c3804feff45cd068e48fa57e1141f236849687e4e0e2e8394fc4b811735bead`。沒有新建 helper worker。

實際在 repo 根目錄執行：

```sh
node --test client/test/hub-hook.test.mjs
MAIL_BIN="$PWD/spikes/f01b/target/release/mcp-agent-mail" node --test client/test/hub-hook.integration.test.mjs
```

- 單元：exit 0；tests 36、pass 36、fail 0、skipped 0，約 0.88 秒。[完整輸出](evidence/H04-hook-unit.txt)
- 整合：runner 完整收尾；tests 5、pass 5、fail 0、skipped 0，約 312.89 秒。[完整輸出](evidence/H04-hook-integration.txt)
- 整合逐項：TC-02 模擬 Mac 留交接／新 Windows session 逐字收到且不重複；session.closed 到 generated-name HubClock 並符合 H-05 shape；question CC 與 answer control 同串；TC-04 空匣／不可達區分；TC-13 雙向各 5 次。

TC-13 使用一台 Mac 上兩個 Hook 子程序，真 Mail 與固定 15 秒輪詢，隨機發送相位，採同一個 `performance.now()` 單調時鐘量測。下列秒數為 send → 對端 watcher 通知 → 讀原文 → 回執的 round trip，沒有模型生成或實際 Windows；不是正式 WAN 或真 Claude 被動喚醒數據。測試本身有 900 秒上限。

| 方向 | 第 1 次 | 第 2 次 | 第 3 次 | 第 4 次 | 第 5 次 |
|---|---:|---:|---:|---:|---:|
| BlueLake → RedStone | 22.76 | 22.60 | 16.65 | 29.85 | 29.17 |
| RedStone → BlueLake | 16.36 | 27.26 | 21.70 | 24.57 | 20.00 |

十次皆 ≤60 秒，只能支持本機子程序測試的這個斷言。真 Claude 回答中、長工具與權限等待的承諾仍依 [F-09](../research/F-09-asyncrewake-spike.md#6-對-brief-a-4-的判定與降級範圍照-brief不成立的部分降級為下一次對話時收到)，不把排隊或等待期間說成已送進對話。

文件另以一次性 Python 檢查 Markdown shell 區塊（去除 blockquote 前綴後送 `bash -n`）、相對檔案連結與範本 JSON，輸出 `PASS documentation QA: 14 shell blocks parsed; 14 relative file links exist; 2 template JSON files parsed`；比對 84 個已知 fixture 私密值，5 份交付文件均未含這些值。`git diff --check` 無輸出；PowerShell 指令僅文件審查，尚未實機執行。

## 為何現有真 Claude 測試沒有載入 Hook

只讀檢查 Ben 自己的 `spikes/h04/state` 既有證據，未修改其 worktree、設定或程序：

- `proj-mac/.claude/settings.json` 與 `proj-win/.claude/settings.json` 皆有 SessionStart／Stop／SessionEnd。這證明檔案已放置，不證明執行。
- `tty-mac.log` 的信任畫面含 `❯ No, exit` 與 `Yes, I trust this folder`；預選是 No。這是歷史 TTY 內容，不表示當前畫面或仍有相同程序存活。
- `data-BlueLake/hook.log` 僅有一個 `outbox-sent`，沒有 `start`。手動 CLI 送信可成功，但不能拿它當 SessionStart 已執行。
- driver 的實際 ANSI 去除與空白處理能找到該 Yes 標籤；沒有證據支持「只是字串比對不到」或「ArrowDown 一定選錯」。TTY 為追加紀錄，無法據此斷言每次嘗試的按鍵結果。

**判讀**：信任閘門是已有直接畫面支持的阻擋因素；這份紀錄沒有完成 interactive Hook 載入的證據。官方說明：interactive 模式在使用者接受專案（或父目錄）的 workspace trust 前，暫停所有 settings 的 hooks，連 user scope 也包括。`-p`／SDK 的信任處理不同，所以用它們啟動成功不能推論 interactive 通過。[官方 Hooks：Workspace trust](https://code.claude.com/docs/en/hooks#workspace-trust)

`CLAUDE_CONFIG_DIR` 會改變 profile 位置，信任狀態與啟動 cwd 都要核對；不要手改 `.claude.json`、修改全域 permission mode 或複製另一 profile 的信任紀錄。此輪沒有更改任何全域設定。[官方設定範圍](https://code.claude.com/docs/en/settings)

## H-07 必要步驟（已寫入接入文件）

1. 確認 Node ≥22、cwd 是含 project settings 的根目錄，合併 template 並保留既有權限／hooks。
2. 載入該裝置的 bearer 與 sender token，填實際 canonical clock 名稱；不可傳遞 HubClock sender token 到客戶端。
3. interactive 啟動時核對資料夾與設定，明確選 Yes；不要直接按預選 Enter。
4. 用 `/hooks` 核對三個事件與路徑，再查本次新 `start`、`watch-arm` 與 `syncError: null`。舊事件、PID、MCP Connected 或 outbox-sent 都不能替代。
5. Windows 依 F-09 §4 做 idle 三次、回答中、45 秒前景工具、正常退出、強制結束後孤兒清理，再做真 Hub 的 TC-02／04／13、session.closed；記版本、ID、時間與是否有人按鍵。

完整可複製指令：[H-07 §4](../onboarding-S1.md#4-第三步自動化-hook-設定claudesettingsjson)、[client README Windows 步驟](../../client/README.md#yui-的-windows-驗證尚未實測)。未執行的 Windows 指令與真 Claude 對話明列待 維護者 操作。

## 未解決事項與驗收邊界

- **真 Claude／實體 Windows 尚未驗**；本輪未啟動 Claude 模型對話或消耗額度，也沒有取得新的 workspace trust 核准。不能宣稱 S1、TC-13 真機或全情境 ≤60 秒已通過。
- `spikes/h04/e2e.py` 是實驗 driver，不作本次驗收入口：其 constructor 等待 start 逾時後仍印出 `session up`；`hub-up.mjs` 仍嘗試把範本 clock placeholder 當註冊名稱，未把 generated canonical name 傳入 setup。這兩處未在本輪改動；若要重用此 driver，須先修正並另驗。維護者 使用上述手動接入／Windows 步驟，不照舊 driver 的「up」字樣報成功。
- Hook 核心程式承接 Ben 未改；控制事件已用真 Mail 整合驗證。此次只補接入文件、證據與專案安全地圖。正式系統的 TLS、裝置撤銷與 office 保持原狀仍由 H-02 維護者 流程驗。
