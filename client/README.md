# client/ — Hub 的 Mac／Windows Node 膠水

`mail-client.mjs`（H-03）負責 Hub 訊息的**送出**與**耐久收件**；`hub-hook.mjs`（H-04）把它接到 Claude Code 的生命週期。依據：`docs/05-sds.md` v0.3 的 API-02、API-03、MOD-02。

## 執行環境與相依

- Node **≥ 22**（用到內建的 `fetch`、`AbortController`、`crypto.randomUUID`、`node --test`）。本機開發測試用 Node 24.18.0。
- **零 runtime 相依**，不需要 `npm install`。只用 Node 內建模組。
- 不在全域安裝任何東西；Mac／Windows 各自裝好 Node 即可（版本由 H-04 鎖定）。

## 匯出的介面（給 H-04 import）

```js
import {
  createMailClient, createStaging, syncInbox, MailError,
  validateItem, detectSecrets, countCodePoints,
  ENVELOPE_VERSION, MAX_TEXT_CODE_POINTS, KINDS, INTENTS, SECRET_RULES, SECRET_RULES_VERSION,
} from './mail-client.mjs';
```

### `createMailClient(opts) → client`

| opts | 必填 | 說明 |
|---|---|---|
| `url` | ✔ | `https://hub.example.invalid/mcp/`（`HUB_MAIL_URL`） |
| `token` | ✔ | 裝置入口 token（`HUB_TOKEN`），放在 `Authorization: Bearer`。**不是** sender registration token |
| `projectKey` | ✔ | 伺服器 project key，例如 `/data/projects/group-a`（不是本機 repo 路徑） |
| `agentName` | ✔ | 這台的 canonical agent，例如 `BlueLake`／`RedStone` |
| `senderToken` | 送信時 ✔ | register 回傳的 `registration_token`，只放本機（fail-closed 送信需要它） |
| `roster` |  | 可送的收件者名單（`hub-client.json` 的 peers）。有給就先在本機擋未知收件者 |
| `timeoutMs` |  | 每個 HTTP 請求逾時，預設 `10000`（SDS SR-ERR-05 工程值，WAN 實測後再調） |
| `clock` |  | `{ now(), setTimeout(fn,ms), clearTimeout(h), sleep(ms) }`；測試注入 FakeClock |
| `fetch`、`randomUUID` |  | 測試注入用 |

`client` 的方法：

| 方法 | 回傳 | 說明 |
|---|---|---|
| `sendItem(item)` | `{ status:'saved', messageId, createdTs, threadId, idempotencyKey, replay }` | 送一則（只試一次）。只有拿到 Hub 的 `message_id` 才回 `saved` |
| `sendWithRetry(item, { maxAttempts=3, baseDelayMs=1000, maxDelayMs=30000 })` | 同上加 `attempts` | 可重試錯誤以指數退避（429 依 `Retry-After`）重送，**永遠用同一個 key**；401／欄位錯誤立即停 |
| `sendControl({ to, cc?, subject, threadId?, control, idempotencyKey })` | 同 `sendItem` | H-05：送 `topic:'control'` 的控制紀錄（`control` 須為 `{ v:1, event_type, … }`）。**key 必填且要固定**（用 `ops/lifecycle/protocol.mjs` 的 `clientControlKey`），重送才會是 replay |
| `sendControlWithRetry(msg, opts)` | 同上加 `attempts` | 同 `sendWithRetry` 的退避與同 key 規則 |
| `fetchEvents({ after?, limit=100 })` | `{ events, nextCursor, hasMore, oldestAvailableCursor, tailCursor }` | 原生 `fetch_inbox_events`；不用 `position_now` |
| `readMessage(messageId)` | `{ raw, message }` | `resources/read resource://message/<id>`；`raw` 是 Hub 回的原文字串，未改寫；**不會標已讀** |
| `markRead(messageId)` | 原生回傳 | `mark_message_read`。只在 agent 真的取得原文後才呼叫 |
| `callTool(name, args)` | 解析後的工具回傳 | 低階出口（bootstrap、`fetch_topic` 取最近 N=5 則交接等） |

`item`（送出內容，對應 SDS `item-v1` envelope）：

```js
{
  to: ['RedStone'],            // 必填，canonical 名稱
  cc: ['<HubClock 實際名稱>'],  // 選填；question／action 要 cc HubClock（名稱見 hubclock.sender.json，不是字面 'HubClock'）
  subject: '交接登入頁',        // 必填
  kind: 'handoff',             // handoff | help | decision | task；同時寫入原生 topic
  intent: 'question',          // question | action；沒給 → 'action'（SRS）
  sourceSession: 'mac-session-01',
  summary: '登入頁完成',        // 必填非空
  text: '……',                  // 必填非空，≤ 20,000 Unicode code points，原樣送出、不正規化
  links: ['https://github.com/…/pull/1'],  // http(s) URL；選填
  unfinished: ['…'],           // 字串陣列；選填
  clientEventId: '<uuid>',     // 選填；沒給自動產生。= idempotency_key = 新 root 的 thread_id
  threadId: '<uuid>',          // 選填；回覆／控制事件沿用原串
}
```

送出到 Hub 的是 `send_message`：`body_md` = envelope JSON（`v:1, client_event_id, kind, intent, source_session, summary, text, links, unfinished`）、`topic=kind`、`idempotency_key=client_event_id`、`convert_images:false`，**永遠不送 `attachment_paths`**。

### 耐久收件

```js
const staging = createStaging({ dir });   // dir 放 OS 使用者資料目錄，排除 Git
const { staged, cursor } = await syncInbox({ client, staging, limit: 100 });
```

- `syncInbox`：從已提交的 cursor 往後 oldest-first 讀 `fetch_inbox_events`，`has_more` 就繼續；每則用 `readMessage` 取原文、**逐字**寫入 staging；整頁都寫好才提交 cursor。中途失敗 cursor 不前進，下次重跑補齊；已 staged 的不重抓。不標已讀。
- `staging`：`put(id, raw)`（已存在就不覆寫，回 `false`）、`get(id) → { raw, message } | null`、`has(id)`、`list() → id[]`、`getCursor() → number | null`、`setCursor(n)`。寫檔用 tmp＋rename。
- 檔案：`<dir>/messages/<id>.json`（Hub 回的原字串）、`<dir>/cursor.json`。

### 錯誤：`MailError { code, message, reason, delivery, retryable, idempotencyKey?, details? }`

`delivery` 是給畫面用的關鍵欄位：`not_saved`＝確定沒存；`unconfirmed`＝**「保存結果未確認」**，不能說成功也不能說沒存，保留同一個 key 待送；`n/a`＝讀取端。

| 情況 | code | reason | delivery | retryable |
|---|---|---|---|---|
| 欄位錯／20,001 字 | `E-FIELD` | `field`（`details.field`、`limit`、`actual`） | not_saved | ✗ |
| 帶附件 | `E-ATTACH` | `attachment` | not_saved | ✗ |
| 疑似密鑰 | `E-SECRET` | `secret`（`details.rules`＝規則 ID，不含原文） | not_saved | ✗ |
| 收件者不存在（本機 roster 或 Hub） | `E-RCPT` | `recipient_not_found`（`details.unknown`） | not_saved | ✗ |
| 同 key 不同內容 | `E-CONFLICT`（工程新增碼） | `idempotency_conflict` | not_saved（原訊息保留） | ✗ |
| HTTP 401／403 | `E-AUTH` | `unauthorized` | not_saved | ✗（停止輪詢／送信） |
| HTTP 429 | `E-HUB` | `rate_limited`（`details.retryAfterMs`） | not_saved | ✔ |
| HTTP 5xx（含 Caddy 502） | `E-HUB` | `unavailable` | **unconfirmed** | ✔ |
| 逾時 | `E-HUB` | `timeout` | **unconfirmed** | ✔ |
| 連線中斷（reset 等） | `E-HUB` | `network` | **unconfirmed** | ✔ |
| 根本連不上（ECONNREFUSED／DNS） | `E-HUB` | `network` | not_saved | ✔ |
| 200 但內容無法解析 | `E-HUB` | `protocol` | **unconfirmed** | ✔ |
| `CURSOR_EXPIRED`／`CURSOR_AHEAD` | `E-CURSOR`（工程新增碼） | `cursor_expired`／`cursor_ahead` | n/a | ✗（需全量核對重建，禁止跳到 tail） |

`sendWithRetry` 只要有一次是 unconfirmed，用完次數後最終仍回 unconfirmed（不會被後面一次乾淨的 429 洗成「沒存」）。

### 密鑰預檢（client 端，MVP）

規則 `SECRET_RULES_VERSION = 2026-11-17.1`：`sk-` 後 ≥20 字元、`ghp_` 後 ≥30、`github_pat_` 後 ≥20、`-----BEGIN … PRIVATE KEY-----`。檢查 subject／summary／text／links／unfinished。長度門檻是工程預設（SDS：未決）；伺服器端 validator 在上線批、S2 前補。

## 測試

```sh
cd client
node --test test/mail-client.test.mjs                 # 單元（FakeClock、注入 401/429/503/逾時）
node --test test/mail-client.integration.test.mjs     # 對本機 mcp_agent_mail_rust 0.3.40
```

整合測試會自己起一個暫時的 Mail 程序（隨機 port、暫存資料夾、隨機 upstream token，測完關掉並刪資料），設定照 SDS API-01 的 `mail-a` 環境變數。binary 取自 `MAIL_BIN`，預設 `<repo>/.hub-local/bin/mcp-agent-mail`（已在 `.gitignore`）。沒有 binary 時整合測試會標 skip，不算通過。

H-02 也可用 `MAIL_TEST_URL=http://127.0.0.1:<port>/mcp/` 與 `MAIL_TEST_ENV_FILE=<私密mail-a.env路徑>`，讓同一套斷言連到隔離容器。只接受 loopback HTTP；指定後不再因缺少 binary 而 skip。容器生命週期由呼叫端管理，helper 的 stop 不會停止它；`node ops/test/local-stack.mjs` 會建立並清理自己的容器、網路與 volume。不要把這組測試指向已在使用的正式 Mail，它會 bootstrap 測試身分與寫入合成訊息。

取得 binary（F-01b 已建好的同一版本，SHA-256 `4c3804fe…5bead`）：

```sh
mkdir -p .hub-local/bin
cp "<codex-senior-swe worktree>/spikes/f01b/target/release/mcp-agent-mail" .hub-local/bin/
shasum -a 256 .hub-local/bin/mcp-agent-mail   # 應為 4c3804feff45cd068e48fa57e1141f236849687e4e0e2e8394fc4b811735bead
```

## H-04：Claude Code Hook 接入

從**專案根目錄**啟動；此處必須同時有 `client/hub-hook.mjs`、`hub-client.json`、`.claude/settings.json`。Node ≥22，已測 Claude Code 2.1.325。沒有 runtime 套件要安裝。

1. 用 [hub-client.json 範本](templates/hub-client.json) 建立根目錄的同名設定，保留正確的 `group_id`、伺服器 `project_key`、Mac／Windows agent 與 peers。把 `clock_agent` 換成 PM 提供的 **canonical 名稱**（來自 H-02 `hubclock.sender.json.agentName`）；不要填字面 `HubClock`，也不要把服務端 sender token 複製到客戶端。placeholder 未換時會警告並跳過控制事件。
2. 把 [claude-settings.json 範本](templates/claude-settings.json) 的 hooks 與專案所需的那條 `permissions.allow` **合併**進 `.claude/settings.json`，保留既有 hooks／權限。只有原檔不存在時才整份複製。不要改全域權限模式。範本的 exec form `command: node`＋`args` 在兩邊共用，Windows 需要真的 `node.exe` 在 PATH 上；不經 PowerShell 展開。
3. 在要啟動 Claude 的同一個終端機載入該裝置的私密檔。完整步驟見 [H-07 §4](../docs/onboarding-S1.md#4-第三步自動化-hook-設定claudesettingsjson)。入口 bearer `HUB_TOKEN` 和送信 registration `HUB_SENDER_TOKEN` 是兩把不同的 token。不要貼進設定檔、訊息、Git 或除錯輸出。
4. 執行 `claude`。如果出現資料夾信任提示，先核對路徑與設定，**明確選中「Yes, I trust this folder」再 Enter**。既有測試曾停在預選「No, exit」；不能只按 Enter 或假定選項順序。未信任時 interactive Claude 會暫停所有 settings hooks，連全域 hooks 也會暫停。[官方說明](https://code.claude.com/docs/en/hooks#workspace-trust)
5. 用 `/hooks` 確認 SessionStart／Stop／SessionEnd 及本專案路徑；另確認本次 `hook.log` 有新的 `ev: start`。`/mcp` Connected、Claude PID 存在、手動送信成功都不代表 Hook 已載入。`claude -p` 的信任處理不同，不能拿它代替 interactive 驗證。不要用 `--bare`、`--restricted`、忽略 project 的 `--setting-sources` 啟動這項驗證；它們會跳過或限制設定。若 `CLAUDE_CONFIG_DIR` 已設，記錄「有／無」即可，不要改另一套 profile 的信任資料。[設定範圍](https://code.claude.com/docs/en/settings)

| 環境變數 | 用途 |
|---|---|
| `HUB_TOKEN` | 必填；裝置入口 bearer |
| `HUB_SENDER_TOKEN` | 送信身分；也可從下述 dataDir 的 `sender-token` 私密檔讀取 |
| `HUB_AGENT` | 覆蓋設定中的 per-OS canonical agent；必須與 sender token 配對 |
| `HUB_MAIL_URL` | 覆蓋設定的 MCP URL，結尾 `/mcp/` |
| `HUB_CLOCK_AGENT` | 覆蓋設定的 HubClock canonical 名稱；公開名稱，非 token |
| `HUB_DATA_DIR` | 可選；此裝置的私密耐久狀態目錄，不要共用或進 Git |
| `CLAUDE_PROJECT_DIR` | Claude 傳入的專案根目錄；手動 CLI 未設時用 cwd |

預設 dataDir：Mac `~/Library/Application Support/hub-client/<group_id>/<agent>`；Windows `%LOCALAPPDATA%\hub-client\<group_id>\<agent>`。內含收件原文、cursor、待送與 session 狀態及 `hook.log`。報錯只交回時間、`ev`、錯誤類型與 Mail ID，勿整份公開。

### Hook 的行為與 agent 指令

| 模式 | 行為 |
|---|---|
| `start` | 取最近 5 則交接與耐久未讀，逐字提供內容；空收件匣與無法取得分開顯示 |
| `watch` | 每 15 秒輪詢；每 session 原子鎖；有新訊息 exit 2 觸發 asyncRewake，並非故障；55 分鐘自我到期，早於 hook 的 3600 秒 timeout；父程序消失就退出 |
| `stop` | 重送待送，工作有變更而沒 checkpoint 時提醒一次；並由 Stop hook 重掛 watcher |
| `end` | 在預算內送 `session.closed` 給實際 HubClock；失敗保留待送 |
| `read <ID>`／`inbox` | agent 取得指定原文／列待處理項目 |
| `send`／`checkpoint` | JSON stdin；保存訊息／本段交接，只有 Hub 回 message ID 才說已保存 |
| `presented <ID>`／`choice <ID> approve\|reject [理由]` | 卡片真的顯示後／使用者明確選擇後才送相應控制事件；動作仍須等 HubClock 的 approved 結果才執行 |

一般送信 stdin 欄位沿用上面的 item；可用 `replyTo` 指向已知 root，讓回覆沿用 thread 並回報 answer。checkpoint 的 stdin 是 `{ "summary":"…", "text":"…", "unfinished":[], "links":[] }`。不要用合成的 approve 取代使用者決定。

### H-04 測試與證據範圍

在 repo 根目錄：

```sh
node --test client/test/hub-hook.test.mjs
MAIL_BIN="$PWD/spikes/f01b/target/release/mcp-agent-mail" node --test client/test/hub-hook.integration.test.mjs
```

本次分別 **36 pass／0 fail**、**5 pass／0 fail／0 skip**。整合測試使用真 Mail、Hook 子程序與合成訊息，涵蓋 TC-02、TC-04、TC-13、session.closed 與 question／answer 控制。TC-13 兩端都在一台 Mac，用同一單調時鐘量測 15 秒輪詢、讀原文、回執；**不代表真 Claude 已載入 hooks，也不代表實體 Windows 驗收**。完整輸出與信任診斷見 [H04-validation](../docs/ops/H04-validation.md)。

### 維護者 的 Windows 驗證（尚未實測）

先完成上面的設定與信任確認。以下沿用 [F-09 §4](../docs/research/F-09-asyncrewake-spike.md#4-windows)，先隔離驗 asyncRewake，再驗實際 Hub。這些步驟會使用 Claude 額度，請由 維護者 在自己的 Windows 操作。

1. PowerShell 記 `claude --version`、`node --version`、`Get-Command node`。進 `spikes/h04a` 執行 `node --test test/watch.test.mjs`，預期 9 pass／0 fail。
2. 視窗 A 進 `spikes/h04a/sandbox` 啟動 `claude`；external CLAUDE.md imports 選 No；核對資料夾後，信任提示明確選 Yes。請它 `Reply with exactly: ready`，等 ready 後不要按鍵。
3. 視窗 B 在 `spikes/h04a` 分別執行 `node trigger.mjs win-idle-1`、`win-idle-2`、`win-idle-3`，各隔約 10 秒。A 應自動出現相應 ACK；不要用鍵盤注入當作喚醒。
4. A 回答 500 字故事途中，B 執行 `node trigger.mjs win-answering-1`；A 應在本次回答結束後 ACK。另請 A 在前景執行 `node ../long-task.mjs 45`（有正常權限提示就由人回答），開始後 B 執行 `node trigger.mjs win-tool-1`，工具結束後應 ACK。超長工具／等待權限期間的 ≤60 秒未成立，依 F-09 降級為目前步驟結束或下一次對話收到。
5. A `/exit`，若問背景工作選 **Exit and stop tasks**；B 檢查下方程序清單，應無 watcher。再重開這個測試 Claude，只對其明確 PID 用工作管理員或 `Stop-Process -Id <測試ClaudePID> -Force` 結束，等 3 秒重查，仍應無 watcher。不要結束其他 node／Claude 程序。

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*watch.mjs*' | Select-Object ProcessId, CommandLine
node analyze.mjs
Get-Content sandbox/state/events.log | Select-String '"ev":"(orphan|signal|skip)"'
```

6. 回到實際專案根目錄，用本機裝置憑證啟動 Claude；確認 `/hooks` 與新的 `start`、`watch-arm`。Mac 留交接後關 session，Windows 新 session 第一輪應逐字列出、再次列新項目不重複（TC-02）；空收件匣明說無新項目，無法連線明說無法取得（TC-04）；正常 `/exit` 應送出 session.closed。再雙向各 5 次做真 Hub 問答（TC-13），記 message ID、送出／收到／回覆時間、是否閒置及是否有人按鍵；任何缺項就回報未驗。退出後用上面程序查詢將 pattern 換為 `*hub-hook.mjs*`，限核對本次專案程序。
7. 把版本、分析表、ID 與失敗步驟交 PM；勿貼 token、整份私密狀態或含憑證的除錯 log。Windows／真 Claude 通過前保留「待 維護者 驗」狀態。

## 已知限制

- 字數與密鑰檢查只在 client（PM 已定 MVP 取捨）；原生 MCP 直呼可以繞過。
- Hub 實際回傳的送信收據是 `{ message_id, created_ts, thread_id, target_outcomes, idempotent_replay? }`，不是 SDS 文字寫的 `deliveries[].payload.id`；本模組依實測格式解析。
- idempotency 去重窗是原生預設 24 h；超過 24 h 的待送要先查原文，不能換 key 盲送。

---

## `hub-hook.mjs`（H-04）— Claude Code hook 膠水

依據：SDS CLI-02／CLI-03、API-06（控制紀錄照 `ops/lifecycle/protocol.mjs`）、F-09（asyncRewake spike）。收發一律經上面的 `mail-client.mjs`。

### 裝到一個專案（Mac／Windows 相同）

1. 專案根目錄要有 `client/`（本資料夾）與 `ops/lifecycle/protocol.mjs`（hub-hook 會 import 它）。
2. 複製 `templates/hub-client.json` → `<專案>/hub-client.json`，把 `clock_agent` 改成 H-02 bootstrap 產生的 HubClock 名稱（`hubclock.sender.json` 的 `agentName`；Mail 不接受字面 `HubClock`）。這個檔沒有秘密，可以進 Git。
3. 複製 `templates/claude-settings.json` → `<專案>/.claude/settings.json`。第一次開 Claude 會問「This folder pre-approves 1 tool permission… trust?」，**預設選項是 No, exit**，要選 **Yes, I trust this folder**。
4. 秘密只放環境變數（不進 Git）：`HUB_TOKEN`（裝置入口 token）、`HUB_SENDER_TOKEN`（register 回傳的 registration token；也可放 `<資料目錄>/sender-token` 檔）。選填：`HUB_MAIL_URL`（蓋過 json 的網址）、`HUB_AGENT`（蓋過依 OS 選的 agent 名）、`HUB_CLOCK_AGENT`、`HUB_DATA_DIR`。
5. 本機資料目錄（staging、journal、outbox、log；不進 Git）：Mac `~/Library/Application Support/hub-client/<group>/<agent>/`、Windows `%LOCALAPPDATA%\hub-client\<group>\<agent>\`。診斷看裡面的 `hook.log`。

### 模式

| 模式 | 由誰觸發 | 做什麼 |
|---|---|---|
| `start` | SessionStart | 補報上次沒正常結束的 session（`session.closed`，只講「上次已保存 #ID」，不編造）、補送待送、同步收件、列**未讀（舊→新，原文逐字）**與**最近 5 則交接**；Hub 連不上時明說「無法取得」，絕不說「沒有新項目」。完整顯示過的項目標已讀 |
| `watch` | SessionStart＋Stop（`asyncRewake`） | 每 15 秒同步；有新訊息 → stderr 一行「Hub 新訊息 #ID（不是錯誤）：來源｜類型｜主旨｜摘要。原文：read ID」並 exit 2 喚醒。每 session 一個 watcher；Claude 程序消失就不讀任何事件直接退出；55 分鐘自行到期（早於 hook timeout 3600 秒）由 Stop 重掛；授權失敗只喚醒一次；連不上約 1 分鐘喚醒一次後持續重試 |
| `stop` | Stop | 補送待送；這段工作（git HEAD＋status）有變更但還沒 checkpoint → 只 block 一次請 agent 存交接；只收信的回合不會 block |
| `end` | SessionEnd | 送 `session.closed`、停 watcher、補送待送（5 秒內）；送不出留本機，下次 `start` 補送並顯示 |

agent 自己執行（設定已允許 `Bash(node client/hub-hook.mjs:*)`）。JSON 用 `--json '<JSON>'` 傳；**不要用 `printf … | node …` 管線**——指令開頭不是 `node client/hub-hook.mjs` 就對不到允許規則，實測在 auto mode 會被當成「未核准的對外訊息」擋下（stdin 仍可用，hook 模式就是走 stdin）：

| 指令 | 用途 |
|---|---|
| `read <ID>` | 印原文（逐字）、標已讀 |
| `inbox` | 列還沒看過的新項目 |
| `send` | `{"to":[…],"subject","kind","intent","summary","text","links","unfinished"}`；回覆用 `{"replyTo":<ID>,"summary","text"}`（自動帶收件者與同一串；回答提問會另送 `answer` 控制紀錄給 HubClock） |
| `checkpoint` | `{"summary","text","unfinished","links"}` → 交接給 peers，主旨標「agent 自動交接」 |
| `presented <ID>` | 動作請求的確認卡**真的顯示給使用者後**才送 |
| `choice <ID> approve\|reject [理由]` | 使用者明確同意／拒絕後才送；動手前仍要等 HubClock 的 approved 結果 |

只有印出「已保存 #ID」才算送出。「未送達」＝確定沒存；「保存結果未確認」＝可能已存，已用同一 key 留在本機待送，之後自動重送不會變兩筆。question／action 的根訊息會 CC HubClock；回答不 CC（H-05 會把 CC 給它、intent 為 question／action 的 item 當成新請求），改送 `answer` 控制紀錄。

### 測試

```sh
node --test client/test/hub-hook.test.mjs                # 單元：FakeClock＋記憶體假 Hub
node --test client/test/hub-hook.integration.test.mjs    # 真 Mail 0.3.40＋真 hub-hook 子程序（含 TC-13 模擬，約 5 分鐘）
```

真 Claude 雙 session 模擬（同一台 Mac）：`spikes/h04/`（`hub-up.mjs` 起本機 Mail；`e2e.py setup|tc02|tc06 N|perm`）。
