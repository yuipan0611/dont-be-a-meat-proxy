# client/ — Hub 的 Mac／Windows Node 膠水

`mail-client.mjs`（H-03）負責 Hub 訊息的**送出**與**耐久收件**；`hub-hook.mjs`（H-04，Ben）直接 import 它。依據：`docs/05-sds.md` v0.3 的 API-02、API-03、MOD-02。

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
