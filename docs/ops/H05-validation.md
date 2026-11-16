# H-05 HubClock 驗證紀錄

- 日期：2026-11-17｜執行者：swe-Tom｜環境：本機 Mac，Node v24.18.0；Mail＝`mcp_agent_mail_rust` 0.3.40（F-01b binary，SHA-256 `4c3804fe…5bead`）；Docker Server 29.9.3
- 程式與說明：`ops/lifecycle/README.md`。**本紀錄不是 VPS 驗收**；TC-07／08／09／12 的「人按鈕、檔案有沒有被建立」部分仍由 H-08 人工跑。

## 1. 單元測試（FakeClock＋記憶體 Mail）

```sh
node --test ops/lifecycle/test/lifecycle.test.mjs
```

```text
✔ question: answered 1 µs before 24 h stays answered and sends no notice
✔ question: 24 h boundary — not before deadline+settle, unanswered exactly at it, notice to asker only
✔ question: answer saved exactly at 24 h is late — unanswered is kept and the late answer recorded
✔ question: a threaded reply item from the recipient counts as the answer
✔ action: approve 1 µs before 30:00 wins even if HubClock only ingests it after the deadline
✔ action: choice saved exactly at 30:00 is late → expired, notice to sender and recipient
✔ action: 30 min boundary — still presented at deadline+settle-1 ms, expired at deadline+settle
✔ TC-12 (unit): action for an offline recipient never times out before it is presented
✔ reject carries the reason; a second choice is ignored (once only)
✔ fail-closed: choice before presented, or from another session, never approves
✔ question reclassified as action by the recipient (TC-08 step 2) follows the 30-minute rule
✔ presented for a root HubClock was not CC'd on is built from the root message
✔ session.closed invalidates only that session's presented requests; no later revival
✔ restart: a new process recomputes missed deadlines from persisted state and sends once
✔ duplicate inbox events and a re-read page are applied once
✔ outbox: unconfirmed send keeps the same key; the retry is a Hub replay, not a second message
✔ outbox: E-AUTH stops the tick and leaves the result pending
✔ result idempotency key is fixed per (group, root, recipient, status)
✔ lock: second writer stands by while the lease is fresh, takes over when stale; the old writer is fenced
✔ lock: a live writer renewing its heartbeat is never pre-empted
✔ identity comes from hubclock.sender.json (generated name), and loose permissions are refused
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ skipped 0
```

涵蓋：24 h 邊界（-1 µs 回答有效／整點算晚到／deadline+settle 前後 1 ms）、30 分鐘邊界（同上，且期限前存的 choice 晚處理仍有效）、重啟後補算（原期限不重設、只發一次）、重複事件（重送事件＋cursor 倒回）、outbox 結果不明後同 key 重送＝replay、E-AUTH 停止、lock 搶占（租約內不可搶、過期接手、舊 writer 被 fencing、續租中永不被搶）、身分取自 `hubclock.sender.json`（權限 644 拒絕）。

**突變檢查**（確認測試真的會抓錯）：把 choice 判斷 `t >= deadline` 改成 `>` → 1 個測試失敗；把逾時判斷 `now < deadline+settle` 改成 `<=` → 4 個測試失敗。改回後全過。

## 2. 整合測試（真的 Mail 程序；收件端 hook 以真的 mail-client 模擬）

```sh
node --test ops/lifecycle/test/lifecycle.integration.test.mjs
```

```text
✔ HubClock runs under the Mail-generated name from hubclock.sender.json
✔ TC-07: no approval is published before the choice; approve → result to both in the root thread (both directions)
✔ TC-08: reject with reason reaches the sender; a "question" the recipient presents is handled as action
✔ TC-09: 30 minutes after presented → expired notice to sender; a later approve does not reopen it
✔ TC-09 step 4: recipient session vanishes without reporting — sender still gets the timeout
✔ session.closed reported by the hook → pending confirmation becomes invalidated, sender notified
✔ TC-12: recipient offline — the action only waits (no timer, no result) until a new session presents it
✔ question: 24 h without answer → "unanswered" notice to the asker only
✔ rerun / crash-before-commit: the same result key is replayed by Mail, never a second message
✔ CLI: `once` runs one tick with the private-dir identity; a second writer stands by (exit 3); no secrets printed
ℹ tests 10
ℹ pass 10
ℹ fail 0
ℹ skipped 0
```

- 時間：HubClock 的時鐘＝真實時間＋測試可調的位移，所以用的是**真的 24 h／30 分鐘常數**，不是縮短版。
- 第一次跑有 2 個失敗，原因是測試：前一個測試把 HubClock 時鐘往前撥，但 Mail 的 created_ts 是真時間，新請求一進來就被判逾時。改成每個測試結束重設位移後通過。正式環境兩者同一台 VPS 時鐘，已寫進 README「時鐘」。

## 3. client（H-03）回歸

```sh
node --test client/test/mail-client.test.mjs client/test/mail-client.integration.test.mjs
```

```text
ℹ tests 53
ℹ pass 53
ℹ fail 0
ℹ skipped 0
```

H-05 對 `mail-client.mjs` 的改動：`sendItem` 現在會送 `cc`（README 原本就說有 cc，但程式漏送，這次補上並加測試）；新增 `sendControl`／`sendControlWithRetry`（共用原本的退避邏輯）。原有 48 個測試不變全過，另加 5 個。

## 4. Linux 容器實跑（H-02 的 mail-a image＋HubClock 容器）

在 scratch 目錄複製 H-02 的 `deploy/compose.yaml`（mail-a `sha256:49a3c779…`，linux/amd64）＋本票 `deploy/hubclock/compose.hubclock.yaml`，從 Mac 用 mail-client bootstrap（HubClock 不指定名稱 → Mail 產生 `JadeBluff`，寫入 600 權限的 `hubclock.sender.json`），送 3 個 action（同意／拒絕附理由／session.closed）後啟動 HubClock 容器。

| 步驟 | 結果 |
|---|---|
| 第 1 次啟動 | ❌ `EACCES: permission denied, open '/data/hubclock.lock'`：named volume 由 root 擁有，非 root 容器寫不進 → 改用 operator 先建的主機目錄 |
| 第 2 次 | ❌ `HTTP 421`：`Host 'mail-a' not in allowed-hosts allow-list` → override 加 `HTTP_ALLOWED_HOSTS: mail-a`（試過 `mail-a:8765` 無效，只比主機名） |
| 第 3 次 | ✅ 一個 tick：`ingested 9, sent 3`；Mac 收件匣：`#10 approved`、`#11 rejected 理由：測試拒絕`、`#12 invalidated`，收件者皆為 BlueLake,RedStone |
| 服務執行中另跑 `run --rm hubclock … once` | ✅ `"ev":"standby"`，exit 3 |
| `restart hubclock` | ✅ 重啟後 `ingested 0, sent 0`；Mac 仍只有 3 封結果（沒有重發） |
| 記憶體 | 68.76 MiB／128 MiB（amd64 在 Apple Silicon 上 qemu 模擬，實機應更低；待 VPS `docker stats`） |

用完 `docker compose down -v`，容器 0 個。

## 5. T15 schema 對齊

新增 `supabase/migrations/20261118000000_hub_clock_align_h05.sql`（加 `recipient_agent`、session 可空、結果欄位、`hub_clock_processed`；表非空就拒跑），`rls_test.sql` 加 T7c／T7d／T9。在 `postgres:17`（17.12）從零跑全部 migration＋seed＋測試：14 項 PASS、`ALL RLS TESTS PASSED`，容器已刪。

## 6. 未驗／待對齊

| 項目 | 找誰 |
|---|---|
| VPS 實機部署與 `docker stats` | H-02／維護者 |
| H-04 送 presented／choice／answer，並 cc HubClock 實際名稱（`hub-client.json` 的 `clock_agent` 目前寫 `hub-clock`） | Ben／PM |
| H-02 的 compose 是否直接收 `HTTP_ALLOWED_HOSTS`、狀態目錄建立步驟寫進 runbook | Codex／PM |
| H-06 備份加 `/var/lib/neighbor-hub/hubclock` | agy-1／PM |
| SRS SR-MSG-09／SR-ERR-03 仍寫問答時限「待確認」，與 維護者 定的 24 h 不一致 | PM |
| outbox 超過 Mail 24 h 去重窗仍未送出時，重送前沒有自動查核 | 上線批次 |
