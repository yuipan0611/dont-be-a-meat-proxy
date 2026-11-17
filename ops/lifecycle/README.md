# ops/lifecycle — HubClock（H-05）

VPS 上的計時程式。依據：`docs/05-sds.md` API-06、`docs/03-srs.md` §2.3／時限一覽、`docs/07-tickets-mvp.md` H-05。

| 維護者 已定規則 | HubClock 做的事 |
|---|---|
| question 24 小時沒回答 | 標「未回答」(`unanswered`)，同串寄給**發問者**；原問題不刪、不代答 |
| action 在 `presented` 後 30 分鐘沒確認 | 標「已逾時」(`expired`)＝拒絕，同串寄給**寄件者與收件者**；離線期間沒有 presented 就不計時（TC-12） |
| `session.closed` | 該 session 已 `presented` 的請求改「已失效」(`invalidated`)，同串通知；之後不能復活 |
| 同意／拒絕 | `approved`／`rejected`（附理由）同串寄給雙方；**收件端只有拿到綁自己 session 的 `approved` 結果才可動手** |

| auto mode（L-06） | 收件人對指定寄件 agent 開 1～240 分鐘（預設 60）授權；該寄件者在時段內**到達 Hub** 的 action 判 `auto_approved`（不跳卡），開／結束／拒絕／每次執行都在 Hub 留通知。設計見 `docs/ops/L06-auto-mode.md` |

HubClock 只記狀態、發通知；不回答 question、不執行 action、沒有 LLM。收發一律經 `client/mail-client.mjs`。

## 檔案

| 檔 | 作用 |
|---|---|
| `protocol.mjs` | 控制紀錄格式、固定 idempotency key、時間解析。**H-04 也 import 這支**送 presented／choice／answer |
| `lifecycle.mjs` | 邏輯：ingest → evaluate → flush（見檔頭註解） |
| `store-file.mjs` | MVP 的 Store：一個 JSON 狀態檔＋一個租約 lock 檔 |
| `main.mjs` | 服務入口：`run`／`once`／`status` |
| `../../deploy/hubclock/compose.hubclock.yaml` | **建議**：容器（H-02 不在 VPS 裝 Node） |
| `../../deploy/hubclock/hubclock.service` | 備案：systemd 直接跑 Node |

## 控制紀錄（給 H-04）

Mail 訊息 `topic: "control"`，`body_md` 是 JSON。誰送、何時送以 Mail 外層 `from`／`created_ts` 為準，body 自報欄位不當身分證明。

| 誰 → 誰 | event_type | 欄位 | 何時送 |
|---|---|---|---|
| 寄件 hook | （一般 item） | 根訊息 `cc` 加 HubClock 名稱 | 送 question／action 時 |
| 收件 hook → HubClock | `presented` | `root_mail_id`、`recipient_session` | 確認提示**真的顯示在畫面上**之後 |
| 收件 hook → HubClock | `choice` | `root_mail_id`、`recipient_session`、`choice: approve\|reject`、`reason?` | 使用者按下時 |
| 收件 hook → HubClock | `answer` | `root_mail_id`、`recipient_session` | 回答 question 時（或直接在原串回覆並 cc HubClock，也算回答） |
| 收件 hook → HubClock | `session.closed` | `recipient_session`（`root_mail_id: null`） | SessionEnd；現有 `hub-hook.mjs` 草稿格式相容 |
| 收件端使用者 → HubClock | `auto.on`／`auto.off` | `recipient_agent`、`target`、`minutes?`（L-06） | `hub-hook auto on|off` |
| 收件 hook → HubClock | `auto.executed` | `root_mail_id`、`outcome: succeeded\|failed`、`reason?` | auto 執行完（`hub-hook auto done`） |
| HubClock → 雙方 | `result` | `status`、`root_mail_id`、`recipient_agent`、`recipient_session`、`decided_at`、`decided_by`、`reason`、`text` | 結果確定後，寫進根訊息的 thread |

```js
import { buildClientControl, clientControlKey } from '../ops/lifecycle/protocol.mjs';
const control = buildClientControl({ eventType: 'choice', rootMailId, recipientSession, agent, choice: 'approve' });
await client.sendControlWithRetry({ to: [clockName], subject: `choice #${rootMailId}`, threadId, control,
  idempotencyKey: clientControlKey({ groupId: 'group-a', eventType: 'choice', rootMailId, agent, recipientSession }) });
```

- **HubClock 的名字不是 `HubClock`**：Mail 拒絕這個名稱，register 時由 Mail 產生（例：`JadeBluff`），存在 H-02 的 `hubclock.sender.json`。client 的 `hub-client.json` 的 `clock_agent` 要填這個實際名稱（範本現為 `hub-clock`，待 H-02／H-04 對齊）。
- 一個請求只能有一個結果（SR-CFM-06）。重複按、逾時後才按、從別的 session 按、presented 之前按，一律不採用，記在 `late`；畫面依收到的 `result` 顯示「已逾時／已處理」。
- 30:00 整點算逾時：choice 的 `created_ts < presented + 30 min` 才有效（SR-CFM-03）。

## 正確性設計

- **單 writer lock**：`hubclock.lock` 用 `O_EXCL` 建立，內含 owner 與 heartbeat；每個 tick 續租。heartbeat 超過租約（預設 60 秒）才可接手，並先把舊 lock 原子改名（兩個接手者只有一個成功）。每次寫入前再確認 lock 仍是自己的（fencing），卡住後醒來的舊 writer 不能覆寫。第二個實例只 `standby`（`once` 回 exit 3）。
- **outbox＋固定 key**：結果先和狀態**同一次寫入**進 outbox，才寄出。key＝`stableUuid("hubclock:<group>:<root>:<recipient>:<status>")`。寄送結果不明時保留 pending，下次用同一把 key 重送，Mail 回 `idempotent_replay`，不會變兩封。
- **cursor 與狀態同一次寫入**；當機後重讀同一頁，以 message ID 去重。
- **先 ingest 再判逾時**，而且要過了 `deadline + settle`（預設 5 秒）才判，確保期限前已存進 Mail 的 choice 一定先被採用。
- **重啟補算**：期限存在狀態檔，用 Mail 伺服器時間算，重啟不重設；停機期間錯過的逾時在下一個 tick 補發，結果時間記原本的期限。
- **時鐘**：期限用 Mail 的 `created_ts`、判斷用 HubClock 的系統時間。兩者必須是同一台 VPS 的時鐘（NTP）；分開部署會有偏差。

## Store 介面與上線批次的 DB 對照

`lifecycle.mjs` 只透過 `store.transact(tx => …)` 存取。上線批次寫一個 `store-pg.mjs` 實作同一組方法即可，邏輯不改：

| tx 方法 | MVP（檔案） | 上線（T15 表，`20261118000000_hub_clock_align_h05.sql` 已對齊） |
|---|---|---|
| `getRequest/putRequest/listRequests` | `requests[key]`，key＝`root:recipient` | `hub_clock_requests`（唯一鍵 `group_id, root_mail_id, recipient_agent`；`version` 做 CAS） |
| `getOutbox/putOutbox/listOutbox` | `outbox[eventKey]` | `hub_clock_outbox`（PK `event_key`） |
| `getGrant/putGrant/listGrants`（L-06） | `grants[key]`，key＝`grant:<開啟訊息 ID>` | **尚無表**：L-01 若要上 Postgres 需加 grant 表 |
| `getCursor/setCursor` | `cursor` | `hub_clock_cursors` |
| `isProcessed/markProcessed` | `processed`（保留最近 20,000 筆） | `hub_clock_processed` |
| `transact` | 讀檔→改→fencing 檢查→tmp＋fsync＋rename | 一個 SQL transaction；lock 改 `pg_advisory_lock` |

欄位名稱以 camelCase 對 snake_case（`deadlineAt`↔`deadline_at`，時間：檔案存 epoch µs，DB 存 timestamptz）。

## 部署（配合 H-02）

H-02 決定 VPS 不裝 Node，所以**用容器**（`deploy/hubclock/compose.hubclock.yaml`，疊在 H-02 的 `deploy/compose.yaml` 上）：

1. 建狀態目錄，擁有者＝憑證檔擁有者（**named volume 是 root 擁有，非 root 容器寫不進去；Linux 實測踩到**）：
   `sudo install -d -o <uid> -g <gid> -m 700 /var/lib/neighbor-hub/hubclock`
2. `HUB_OPS_UID=<uid> HUB_OPS_GID=<gid> docker compose -f deploy/compose.yaml -f deploy/hubclock/compose.hubclock.yaml up -d hubclock`
3. 確認：`docker compose … logs hubclock` 每 15 秒一行 `"ev":"tick"`；`docker compose … run --rm --no-deps hubclock node /app/ops/lifecycle/main.mjs status`。

需要 H-02 知道的兩點：
- override 會在 `mail-a` 加 `HTTP_ALLOWED_HOSTS=mail-a`。否則容器內用 `http://mail-a:8765/mcp/` 會得到 **HTTP 421**（Mail 的 Host 檢查只比對主機名，不含 port；實測）。
- H-06 備份要加 `/var/lib/neighbor-hub/hubclock`（狀態＋cursor＋outbox），還原時和 Mail 一起還原。

## 測試

```sh
node --test ops/lifecycle/test/lifecycle.test.mjs               # 21 個單元測試（FakeClock）
node --test ops/lifecycle/test/auto-mode.test.mjs               # 14 個 L-06 auto mode 單元測試（TC-15 步驟 1～6）
node --test ops/lifecycle/test/lifecycle.integration.test.mjs   # 10 個，對本機 mcp_agent_mail_rust 0.3.40
node --test client/test/mail-client.test.mjs                    # 含 cc／sendControl 新測試
```

整合測試的 binary 取得方式見 `client/README.md`；沒有 binary 時標 skip，不算通過。

## 已知限制

- Mail 的 idempotency 去重窗是 24 h。outbox 一筆若超過 24 h 還沒寄成功（例：Mail 掛了一整天），重送前要人工查原串，否則可能多一封；目前只記 `attempts`／`lastError`，沒有自動查核。
- S1 組內互信：`presented`／`choice` 的寄件者就是收件 agent 本人（Mail 外層 `from`），HubClock 不證明背後是哪個人（SAD GAP-13，S2 前另做）。
- `docs/03-srs.md` SR-MSG-09／SR-ERR-03 仍寫「問答時限待確認」，與 維護者 已定的 24 h 不一致，待 PM 更新文件。
