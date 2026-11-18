# F-09 spike 報告：Claude Code `asyncRewake` 能否叫醒閒置 session（H-04a）

- **負責**：swe-Ben（Claude）｜**審查**：PM-Emily｜**決策**：維護者
- **實測日期**：2026-11-17（Asia/Taipei）｜**對應**：票 H-04a、Brief A-4、SDS CLI-02、NFR-01
- **環境**：macOS Darwin 27.2.0；**Claude Code 2.1.325**（`claude --version`）；Node v24.18.0；測試 session 的模型是 Opus 5.5、effort medium、權限模式為使用者預設的 auto mode（未更改）；在 Orca 的 Claude profile 下執行（`CLAUDE_CONFIG_DIR` 為 Orca profile，Orca 自己注入的 hook 也在，不影響結果）
- **產出**：本文件＋`spikes/h04a/`（原始紀錄未公開）（最小設定、watcher、driver、原始數據 `results/`）

## 結論（先講）

**部分可行。** `asyncRewake` 確實能把**閒置**中的 Claude Code session 叫醒，從事件出現到 Claude 回覆約 **1.3–1.4 秒**（n=3）。session 正在忙時，訊息**不會插隊**，會排隊到「目前這一步」結束才進對話：

| 情境 | 能否 ≤60 秒 | 實測（事件→Claude 回覆） | 由什麼決定 |
|---|---|---|---|
| (a) 閒置等輸入 | ✅ 可以 | 1.33／1.39／1.40 秒 | Claude 回一句話的時間 |
| (b) AI 正在回答 | ✅ 一般可以；⚠️ 單次回答超過約 60 秒時不行 | 11.70／11.33／12.08 秒 | 目前這則回答還剩多久＋約 1.3 秒 |
| (c) 正在跑長工具 | ⚠️ 只在工具 <約 57 秒時可以 | 45.51／43.01／43.65 秒（工具本身 45 秒） | 這個工具呼叫還剩多久＋約 2.5 秒 |
| 等使用者回權限提示 | 未測，**待確認** | — | 推測同 (c)，要等人回答才交付 |

產品版的 watcher 每 15 秒輪詢一次 Hub（SDS CLI-02），上表要再加 0–15 秒，閒置情境仍遠低於 60 秒。

**對 H-04 的影響**：不需要整體降級成「下一次對話時收到」。保留 `asyncRewake` 設計，但 A-4／NFR-01 的「≤60 秒」只能保證在**閒置**與**一般長度的回答／工具**；忙碌時的實際保證是「**目前這一步（一則回答或一個工具呼叫）結束後立刻收到**」。這個是否算 A-4 通過，屬產品決定，要 PM／維護者 定（見最後的「要 PM 決定」）。

## 1. 官方文件怎麼說（查詢 2026-11-17）

來源：<https://code.claude.com/docs/en/hooks>（原始 Markdown：<https://code.claude.com/docs/en/hooks.md>），重點段落：「Command hook fields」、「Run hooks in the background」→「Limitations」、「Exec form and shell form」。

| 項目 | 文件原文重點 | 實測 |
|---|---|---|
| 設定格式 | command hook 加 `"asyncRewake": true`；只能用在 `type: "command"` | ✅ 照 SDS 範本寫在專案 `.claude/settings.json`，可用 |
| 喚醒條件 | 「runs in the background and wakes Claude on exit code 2」 | ✅ exit 2 才喚醒；exit 0 不喚醒（lock 被占用的第二個 watcher exit 0，沒有喚醒） |
| 閒置時 | 一般 async hook 要等下一次使用者互動；「Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle」 | ✅ 閒置 1.3–1.4 秒回覆 |
| Claude 看到什麼 | 「The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder」 | ✅ stderr 有內容時用 stderr；stderr 空時用 stdout（各實測 2–3 次） |
| `timeout` | 一般 async hook 不強制 timeout，但「Claude Code still enforces `timeout` on a hook you run with `asyncRewake`」 | ✅ 會強制，而且**是安靜地殺掉**（見 §3.4） |
| `claude -p` 非互動模式 | 結束時會殺掉還在跑的 async hook（outcome `cancelled`） | 未測（MVP 不用 `-p` 收信） |
| session 關閉時 watcher 怎麼處理 | **文件沒寫，待確認** → 以實測為準（§3.3） | 正常關閉會送 SIGTERM；SIGKILL 會留下孤兒 |
| 喚醒時正在忙怎麼辦 | **文件沒寫，待確認** → 以實測為準（§2） | 排隊到目前這一步結束 |
| Windows | `shell` 欄位可設 `"bash"`／`"powershell"`；有 `args` 時（exec form）不經 shell、`shell` 被忽略；「The `node` plus script-path pattern works on every platform because `node.exe` is a real binary」。文件沒有說 `asyncRewake` 有平台限制 | **未實測**（見 §4） |

## 2. 三種情境的實測

### 測法

- `spikes/h04a/driver.py` 在 pseudo-terminal 開一個**互動式** `claude`（cwd＝`spikes/h04a/sandbox`，只有這個資料夾的專案設定有 hook），先打 `Reply with exactly: ready` 讓 session 進入正常狀態，再依情境操作。driver 打字只是代替 維護者 操作測試 session；喚醒本身完全靠 hook，沒有注入鍵盤。
- 假事件：`node trigger.mjs <id>` 在 `sandbox/state/inbox/` 放一個檔，並記下 t0。
- watcher（`watch.mjs`，掛在 SessionStart 與 Stop、`asyncRewake: true`、`timeout: 3600`）每 200 ms 看一次 inbox。這裡刻意用很短的輪詢間隔，量的是 **Claude Code 這一側**的延遲；產品版 15 秒輪詢另外加上去。
- watcher 的 stderr：`HUB-EVENT ids=<id> — spike test event. Reply with exactly one line: ACK <id>`。
- 時間點：t0（trigger）→ watcher 偵測（`events.log`）→ 提醒進入 Claude 對話（transcript 的 user 訊息時間）→ Claude 回覆 `ACK <id>`（transcript 的 assistant 訊息時間）。同一台機器同一個時鐘，可以直接相減。
- 計算：`node spikes/h04a/analyze.mjs`。原始數據：`spikes/h04a/results/events-mac-2026-11-17.jsonl`、`latency-mac-2026-11-17.md`。

### 原始數據（秒，以 t0 為 0）

| 情境 | 事件 ID | 偵測 | 進入對話 | Claude 回覆 ACK |
|---|---|---|---|---|
| (a) 閒置 | idle-010822-1 | 0.10 | 0.12 | **1.33** |
| (a) 閒置 | idle-010822-2 | 0.20 | 0.21 | **1.39** |
| (a) 閒置 | idle-010822-3 | 0.04 | 0.06 | **1.40** |
| (b) 回答中（請它寫 500 字故事，開始後 4 秒放事件） | answering-010934-1 | 0.06 | 9.68 | **11.70** |
| (b) 回答中 | answering-010934-2 | 0.01 | 10.12 | **11.33** |
| (b) 回答中 | answering-010934-3 | 0.07 | 10.81 | **12.08** |
| (c) 長工具（前景跑 45 秒的 `node long-task.mjs 45`，開始後 3 秒放事件） | tool-011234-1 | 0.07 | 工具結束時（約 42.9）* | **45.51** |
| (c) 長工具 | tool-011234-2 | 0.07 | 工具結束時（約 42.2）* | **43.01** |
| (c) 長工具 | tool-011234-3 | 0.11 | 工具結束時（約 42.2）* | **43.65** |

\* (c) 的提醒是先以 `queued_command`（task-notification）排進佇列，等工具回來才放進對話，所以 transcript 裡沒有獨立的 user 訊息；時間取 PostToolUse hook 的時間（事件 log：PostToolUse 之後 0.07 秒就觸發了喚醒那一輪的 UserPromptSubmit）。

被排除的一輪：第一次跑 (c) 用 `sleep 45`，Claude Code 不讓前景跑 `sleep`，自動改丟背景，工具立刻返回，不算「長工具」；數據（tool-011056-*，0.06 秒進對話、1.06–1.74 秒回覆）留在 results 裡但不列入結論。它顯示的是：**背景工具不會擋喚醒**。

### 觀察

- (a) 喚醒是一個新的回合：transcript 出現一則 user 訊息，內容是 `<task-notification><summary>Stop hook feedback</summary></task-notification>` 加上 system reminder：`Stop hook blocking error from command "SessionStart:startup": <watcher 的 stderr>`。喚醒那一輪會觸發 **UserPromptSubmit** hook，結束時觸發 **Stop** hook。
- (b) 不會打斷正在串流的回答。事件在回答進行中就排進佇列，回答一結束（Stop）0.07 秒內就開始喚醒回合。
- (c) 不會打斷工具。工具回來（PostToolUse）0.07 秒後就把提醒塞進**同一輪**繼續處理（UserPromptSubmit 早於 Stop），不用等整個多步驟回合結束。所以一個多步驟的 agent 回合裡，最晚在下一個工具邊界就會看到。
- 9 次（加排除的 3 次與其他情境）Claude 都照 stderr 指示回了正確的 `ACK <id>`。雖然文字被包成「Stop hook blocking error」，模型還是當成一般訊息處理；產品版 stderr 要寫清楚「這是 Hub 新訊息，不是錯誤」。

## 3. 其他要求的行為

### 3.1 stderr 還是 stdout 進對話

| 事件 ID | watcher 輸出 | 進入對話 | 回覆 |
|---|---|---|---|
| idle-*（3 次） | 只寫 stderr | 0.06–0.21 秒，內容＝stderr | 1.33–1.40 秒 |
| stdout-011714-1 | 只寫 stdout（stderr 空） | 0.12 秒，內容＝stdout | 1.76 秒 |
| stdout-011714-2 | 只寫 stdout（stderr 空） | 0.01 秒，內容＝stdout | 1.39 秒 |

符合文件：stderr 優先，stderr 空才用 stdout。**H-04 一律寫 stderr**（SDS 原設計）。

### 3.2 多個事件連續到來

每輪：先放 a，0.05 秒後放 b，1 秒後放 c，再 1 秒後放 d（共 3 輪、12 個事件）。

| 事件 | 偵測 | 回覆 | 跟誰一起送 |
|---|---|---|---|
| 1a／1b／1c／1d | 0.05／2.26／1.18／0.08 | 2.31／3.79／2.71／1.61 | a 單獨；b,c,d 合併一次 |
| 2a／2b／2c／2d | 0.07／1.38／0.28／0.71 | 1.41／2.80／1.70／1.85 | a；b,c 合併；d 單獨 |
| 3a／3b／3c／3d | 0.11／1.41／0.33／0.75 | 1.43／2.85／1.77／1.98 | a；b,c 合併；d 單獨 |

- **12 個事件全部送達、沒有遺失、沒有重複**，最慢 3.79 秒。
- watcher 送出一次喚醒就結束；喚醒回合期間到的事件會留在 inbox，等這一輪的 Stop hook 重新掛上 watcher 後，**合併成一次喚醒**送出。
- 同一時間只會有一個 watcher：SessionStart 的 watcher 還活著時，Stop 啟動的那個看到 lock 就 exit 0（不喚醒），log 記為 `skip`。

### 3.3 session 關閉時會不會留孤兒程序

| 關閉方式 | Claude 退出碼 | watcher 怎麼了 | 3 秒後殘留 |
|---|---|---|---|
| `/exit`（所有情境都用過，共 10 次以上） | 0 | 收到 SIGTERM，然後 SessionEnd（reason `prompt_input_exit`） | 無 |
| 終端直接關掉（driver 異常結束，pty 關閉；2 次） | — | 收到 SIGTERM，SessionEnd（reason `other`） | 無 |
| `kill -TERM <claude>` | 143 | 收到 SIGTERM | 無 |
| `kill -KILL <claude>`（模擬當機／強制結束） | -9 | **沒收到任何訊號，被 PID 1 收養，繼續輪詢** | **有（孤兒）** |

**孤兒的實際危害（已重現）**：SIGKILL 後的孤兒 watcher（pid 36972）仍持有 lock。下一個新 session 的 watcher 看到 lock 就 `skip`；接著到的事件 `orphan-012111-1` **被孤兒偵測、搬到 staged、exit 2 卻沒有任何 session 可喚醒**，新 session 從頭到尾沒收到（表中「進入對話」與「回覆」都是 n/a）。換成真的 Hub，等於孤兒把 cursor 往前推、把信「讀掉」。

**修正（已在 spike 實作並驗證）**：watcher 啟動時記下父程序 PID，每次輪詢先檢查「父程序已換人（POSIX 被收養）或已不存在（Windows 不會收養）」，是的話**不讀任何事件**、釋放 lock、exit 0。

- 單元測試：`orphaned watcher (its Claude process died) exits 0 and leaves events for the next session` 先紅後綠。
- 真機重驗：`kill -KILL` 後，watcher 自己記下 `{"ev":"orphan","parentPid":38721,"newPpid":1}` 並退出，3 秒後無殘留；接著新 session 收到 `orphan-012354-1`，2.35 秒回覆。

另外遇到：session 有背景工具還在跑時，`/exit` 會跳出「Exit and stop tasks／Move to background and exit／Stay」對話框，沒人回答就不會關。driver 已改成自動選第一項。H-04 的 `end` 要考慮這種「卡在退出確認」的狀況。

### 3.4 Hook `timeout` 與 watcher 自我到期

| 測試 | 設定 | 結果 |
|---|---|---|
| hook 逾時（`sandbox-timeout/`） | watcher hook `timeout: 15`，watcher 自身不到期 | 15.5 秒時 watcher 收到 SIGTERM；**沒有喚醒、Claude 對話裡什麼都沒有、Stop 也不會重掛**，之後到 59 秒都沒有 watcher。等於**安靜地停止收信** |
| watcher 自我到期（`H04A_MAX_MS=20000`） | `timeout: 3600`，watcher 20 秒後 exit 2 送 `WATCHER-EXPIRED` | 2 次都喚醒（到期→喚醒回合結束的 Stop：2.36／1.33 秒），喚醒回合的 Stop 重新掛上 watcher，再過 20 秒又到期、又重掛 |

→ SDS 的「55 分鐘自我到期＋`timeout: 3600`」順序是對的（自我到期一定要比 hook timeout 早），H-04 必須保留這個差距，而且要有測試鎖住。代價是閒置 session 每 55 分鐘會被叫醒一次、跑一個小回合（耗少量 token）。

## 4. Windows

**本機無法實測（只有 Mac）→ 標「待 維護者 在 Windows 上驗」。** 文件判斷：

- **可行性**：hooks 文件沒有寫 `asyncRewake` 有平台限制。SDS 範本用 exec form（`"command": "node", "args": [...]`），文件明寫在 Windows 可用（`node.exe` 是真的執行檔），**不經過 shell，所以不需要 PowerShell 語法**，同一份 `settings.json` 兩邊共用。
- 若要改用 shell form，Windows 上沒裝 Git Bash 時預設會用 PowerShell。寫法要用 `"shell": "powershell"`，`command` 用 `& node "$env:CLAUDE_PROJECT_DIR\..\watch.mjs"`（文件規定：路徑含變數的程式要加 `&`；環境變數寫成 `$env:`）。**建議不要用**，exec form 比較單純。
- **孤兒偵測**：Windows 的程序不會被收養，`process.ppid` 不會改變，所以 watcher 另外檢查父 PID 是否還活著（`process.kill(pid, 0)`）。這段在 Mac 測過，**Windows 上未驗**。
- **SIGTERM**：Windows 沒有 POSIX 訊號，Claude Code 結束 watcher 時 `signal` 那行 log 可能不會出現；留下的 lock 會被下一個 watcher 判定為「持有者已死」而接手（單元測試 `stale lock` 已覆蓋）。

### 維護者 在 Windows 上照做的步驟（PowerShell，約 10 分鐘）

先決：Windows 上已裝 Claude Code 與 Node（`node --version` 有輸出）。把本分支的 `spikes/h04a` 資料夾帶到 Windows（git pull 或複製）。

```powershell
# 0. 記版本
claude --version
node --version

# 1. watcher 單元測試（預期最後幾行：tests 9, pass 9, fail 0）
cd <repo>\spikes\h04a
node --test test\watch.test.mjs

# 2. 開測試 session（視窗 A）：cwd 一定要是 sandbox，hook 只在這裡生效
cd <repo>\spikes\h04a\sandbox
claude
#   若問「Allow external CLAUDE.md file imports?」選 No。
#   輸入：Reply with exactly: ready   → 等它回 ready，然後什麼都不要打。

# 3. 另開視窗 B 放假事件（閒置情境），各做 3 次，每次間隔約 10 秒
cd <repo>\spikes\h04a
node trigger.mjs win-idle-1
node trigger.mjs win-idle-2
node trigger.mjs win-idle-3
#   預期：視窗 A 在幾秒內自己出現「ACK win-idle-N」，不用你按任何鍵。

# 4. 回答中：在視窗 A 輸入「Without using any tools, write a 500-word story about a lighthouse keeper.」
#    它開始輸出後，馬上在視窗 B：
node trigger.mjs win-answering-1
#   預期：故事寫完後立刻出現「ACK win-answering-1」。

# 5. 長工具：在視窗 A 輸入「Run this exact Bash command in the foreground (do not use run_in_background): node ../long-task.mjs 45 — then reply with exactly: slept」
#    （Windows 上 Claude 可能用 PowerShell 工具跑，一樣可以；若要權限，按允許）
#    工具開始後，在視窗 B：
node trigger.mjs win-tool-1
#   預期：約 45 秒後工具結束，接著出現「ACK win-tool-1」。

# 6. 關閉與孤兒：在視窗 A 輸入 /exit，然後在視窗 B：
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*watch.mjs*' | Select-Object ProcessId, CommandLine
#   預期：沒有輸出。
#   強制結束測試：重開視窗 A 的 claude（步驟 2），再用工作管理員或
#   Stop-Process -Id <claude 的 PID> -Force 結束它，等 3 秒後再跑上面那行 Get-CimInstance。預期：沒有輸出。

# 7. 產出延遲表，整段貼回給 Ben／PM
node analyze.mjs
Get-Content sandbox\state\events.log | Select-String '"ev":"(orphan|signal|skip)"'
```

判讀：步驟 3 的 ACK 有自己出現＝Windows 的閒置喚醒成立。步驟 6 沒有殘留 node 程序＝孤兒處理成立。任一步沒有反應，把視窗 A 的畫面與 `node analyze.mjs` 的輸出一起回報。

清理：`Remove-Item -Recurse -Force <repo>\spikes\h04a\sandbox\state`。

## 5. 給 H-04 的具體影響（工程面，依 SDS 自行決定的部分）

1. **照 SDS 用 `asyncRewake`，不降級**。設定格式（exec form、SessionStart＋Stop 各掛一個 watcher、`timeout: 3600`）實測可用。
2. **一律寫 stderr**，第一行就寫清楚是 Hub 新訊息與 Mail ID，例如 `Hub 新訊息 #<id>（不是錯誤）…`。因為 Claude Code 會把它包成「Stop hook blocking error」。
3. **單一 watcher**：SessionStart 與 Stop 都會啟動 watcher，要用 lock 擋重複。SDS 寫「每 session 原子鎖」，H-04 照做，lock key 用 `session_id`。
4. **孤兒防護必做**：父程序 PID 檢查（POSIX 被收養，或 Windows 父程序消失）→ 不讀事件、exit 0。另外 `start` 時要把「已 staged、但沒有 session 確認看過」的事件重新提示，防止任何漏網的消費。
5. **自我到期一定早於 hook timeout**（55 分鐘 < 3600 秒），要寫測試鎖住；hook 逾時是安靜死亡，不會有任何提示。
6. **喚醒回合會觸發 UserPromptSubmit 與 Stop**。H-04 的 `stop` checkpoint 邏輯要能接受「這一輪只是收信」，不要每次收信都產生一筆交接。
7. **只有真的有新事件才 exit 2**。每次喚醒都是一次模型回合，會耗 token。
8. `/exit` 可能卡在「背景工具還在跑」的確認框，`end` hook 要把這情況算進 5 秒預算外的已知限制。
9. `claude -p` 會在結束時殺掉 async hook（文件），所以 fallback 不能用 `-p` 收信（SDS 本來就禁止）。

## 6. 對 Brief A-4 的判定與降級範圍（照 Brief：不成立的部分降級為「下一次對話時收到」）

| 情況 | A-4（≤60 秒）判定 | 實際行為／降級後的承諾 |
|---|---|---|
| 閒置 | **成立**（Mac 實測；Windows 待驗） | 15 秒輪詢＋約 1.5 秒 → 約 17 秒內 |
| 回答中、工具中，且這一步 ≤約 55 秒 | **成立** | 這一步結束後約 1–3 秒 |
| 單一回答或單一工具超過約 55 秒、等權限提示 | **不成立** | 降級為「目前這一步結束後收到」。這比 Brief 的「下一次對話時收到」好，因為不用等人再打字 |
| watcher 因 hook 逾時或 SIGKILL 消失 | 不成立（已用自我到期＋孤兒防護把機率降低） | 降級為「下一次對話時收到」（下一次 Stop 會重掛；新 session 的 `start` 會列未讀） |
| Windows | **待 維護者 驗**（§4） | 驗證前不能算 A-4 在 Windows 成立 |

## 要 PM 決定（產品，不是工程細節）

1. A-4／NFR-01 的「≤60 秒」是否接受定義成「閒置及一般長度的回答／工具 ≤60 秒；超長的單一步驟則在該步驟結束後立即收到」？若不接受，就沒有在 Claude Code 現有機制內可以達成的做法：要打斷工具只能靠鍵盤注入或重開 session，而這兩種 SDS 已經禁止。
2. 權限提示情境本次沒測，要不要列入 H-04 或 H-08 一起驗。

## 未完成／待確認

- Windows 實測：待 維護者 照 §4 執行。
- 權限提示等待中的喚醒：未測。
- 斷網、睡眠恢復（SDS CLI-02 列的情境）：未測，屬 H-04／H-08 接 Hub 後的範圍。
- 真 Hub 的 15 秒輪詢與 round-trip（TC-13，n≥5）：H-04 範圍。
- VS Code 擴充裡的 Claude Code 是否同樣載入專案 hook：未測（SDS 已列兩端分別驗）。
