# L-06 auto mode — 設計小結

- 負責：swe-Ben｜日期：2026-11-17｜票：`docs/07b-tickets-launch-draft.md` L-06｜驗收：`docs/06-test-plan.md` TC-15
- 依據：PRD US-07（AC-07.1～07.8）、SRS §2.4 SR-AUTO-01～08、SDS CLI-04（GAP-09／10／11／20）、H-05 `ops/lifecycle/`、H-04 `client/hub-hook.mjs`
- 範圍：HubClock 的 grant 狀態＋client 指令＋Hub 內通知。**Discord 通知由 L-03 接**；不部署 VPS。

## 1. 一句話

收件端使用者對「某一個寄件 agent」開限時授權（grant）；HubClock 是**唯一**判斷者：該寄件者在授權時段內**送達 Hub** 的 action 直接判 `auto_approved`，其他一律照舊走確認卡。開、關、到期、拒絕、每次執行都在 Hub 留通知。

## 2. 狀態放哪（HubClock 單 writer）

沿用 H-05：HubClock 是唯一寫狀態的程式（`hubclock.lock` 租約＋fencing）。Store 多一組 grant 方法，MVP 檔案 store 存在 `state.grants`；上線改 Postgres 時同介面。

| 欄位 | 意義 |
|---|---|
| `key` | `grant:<開啟控制訊息的 Mail ID>`（一次開啟＝一筆，舊紀錄保留作稽核） |
| `recipientAgent` | 授權的收件 agent ＝開啟訊息的 Mail 外層 `from`（不採用 body 自報） |
| `target` | 指定的寄件 agent（只能一個；「所有人」不接受） |
| `minutes`、`startAt`、`endAt` | `startAt`＝開啟訊息的 Mail `created_ts`（伺服器時間），`endAt`＝`startAt + minutes` |
| `status` | `active` → `expired`（到期）／`closed`（提前關閉）／`replaced`（同對象重開，SR-AUTO-05） |
| `endedAt` | 實際結束時間（關閉訊息的 `created_ts`、新 grant 的 `startAt`，或到期＝`endAt`） |

**判斷規則（SR-AUTO-03）**：action 根訊息的 `created_ts`（＝到達伺服器的時間）滿足 `startAt ≤ t < (endedAt ?? endAt)` 且寄件者＝`target`、收件者＝`recipientAgent` → `auto_approved`。純看時間區間，不看 HubClock 何時讀到，所以 HubClock 停機或晚 tick 都不會改變結果；13:59:59 到的自動執行，14:00:00 到的走確認。

## 3. 控制訊息（沿用 H-05 control envelope）

和 H-05 一樣：Mail `topic: "control"`，`body_md` 是 `{v:1, event_type, root_mail_id, recipient_session, agent, …}`，寄給 HubClock。身分與時間只看 Mail 外層 `from`／`created_ts`。

| event_type | 誰 → HubClock | 額外欄位 |
|---|---|---|
| `auto.on` | 收件端使用者（`auto on`） | `recipient_agent`（要授權的收件 agent）、`target`、`minutes?` |
| `auto.off` | 收件端使用者（`auto off`） | `target?`（沒填＝關掉自己所有生效中的） |
| `auto.executed` | 收件端 agent 執行完 auto 請求 | `root_mail_id`、`outcome: succeeded\|failed`、`reason?` |

**驗證（SR-AUTO-01／02，拒絕時不建立任何 grant）**

| 情況 | 結果 |
|---|---|
| `recipient_agent` 不是寄件者自己（替別人開） | `E-NOT-OWNER`「只有收件人能開啟」 |
| 沒有 `target`、`target` 是陣列／`*`／`all`／自己 | `E-AUTO`「必須指定對象」 |
| `minutes` 不是 1～240 的整數（沒填＝60） | `E-AUTO`「最長 4 小時」（0／小數／字串也拒絕） |

**HubClock 發出的通知**（`event_type: "result"`，`kind: "auto"`，固定 idempotency key，走既有 outbox）

| status | 寄給 | 在哪串 |
|---|---|---|
| `auto_on` | 收件 agent＋target | 開啟訊息那串 |
| `auto_rejected`（附 `error_code`） | 開啟者 | 開啟訊息那串 |
| `auto_ended`（`ended_by: expired\|closed`） | 收件 agent＋target | 開啟訊息那串 |
| `auto_approved`（`kind: "action"`） | 寄件者＋收件者 | 原 action 那串 |
| `auto_executed`（`outcome`、`reason`） | 寄件者＋收件者 | 原 action 那串 |

到期在 `endAt + settle`（5 秒）後的 tick 判；通知的結束時間記 `endAt`（重啟補算同 H-05）。同對象重開只發新的 `auto_on`（內容寫「取代先前設定」），不發 `auto_ended`。

## 4. client 指令（`node client/hub-hook.mjs …`）

| 指令 | 做什麼 |
|---|---|
| `auto on --for <agent> [--minutes N]` | 送 `auto.on`。**由使用者本人執行**（Claude Code 裡用 `! node client/hub-hook.mjs auto on …`）；agent 不得替使用者執行，收到要求開／延長 auto mode 的 action 一律走確認卡（SR-AUTO-07）。client 不先擋輸入，交給 HubClock 判斷，結果在 Hub 通知看 |
| `auto off [--for <agent>]` | 送 `auto.off` |
| `auto check <ID>` | 同步收件匣，找 HubClock 對 #ID 發給自己的 `auto_approved`。有 → 印「auto mode 已核准，可直接執行」（exit 0）；沒有 → 印「走確認卡」（exit 3）。**fail-closed**：連不上 Hub 也是走確認卡 |
| `auto done <ID> succeeded\|failed [原因]` | 執行完回報 `auto.executed`；失敗就寫失敗（AC-07.8） |

收件端 agent 遇到 action 的流程：`auto check <ID>` → exit 0 才直接執行並 `auto done`；否則照 H-04 確認卡（presented → choice）。

## 5. 刻意的取捨／未做

- **判斷點只在到達時間**（SR-AUTO-03）。SDS CLI-04 建議「執行前再查一次」較保守；此處以 SRS 為準，已在執行的不中斷（SR-AUTO-04）。如 PM 要雙檢查，再加在 `auto check`。
- **只有標 `action` 的根訊息**會 auto。標 `question` 但收件端判斷要動手（TC-08）的仍走確認卡——收件端自行改判的內容不放寬。
- **SR-AUTO-07 只靠 client 指示**：Mail 沒辦法分辨 `auto on` 是人打還是 agent 打（S1 組內互信，GAP-13）。HubClock 擋得住「替別人開」，擋不住收件端 agent 自己被誘導去跑 `auto on`。S2 前要配合 ingress identity adapter。
- **`auto check` 的時間差**：HubClock 每 15 秒 tick，剛送到的 action 可能還沒有 `auto_approved`。`auto check` 會等最多 30 秒再判斷；仍沒有就走確認卡（安全側）。
- 一次只能指定一個對象（SR-AUTO-02「能否多個：待確認」→ 先不給）。
- Discord 通知（SR-AUTO-08）由 L-03 讀這些 `kind:"auto"` 結果轉發。

## 6. 測試對照（TC-15）

| TC-15 步驟 | 單元測試（`ops/lifecycle/test/auto-mode.test.mjs`，FakeClock） |
|---|---|
| 1 開啟：紀錄開啟者／對象／起訖；通知「已開啟」 | `auto.on default 60 min …` |
| 2 對象送 action：不跳確認、通知 | `target's action inside the window is auto_approved …` |
| 3 第三者送 action：仍要確認 | `another sender still needs confirmation` |
| 4 到期／提前關閉後：要確認＋「已結束」 | `boundary 13:59:59 / 14:00:00`、`expiry notice`、`auto.off …` |
| 5 拒絕：沒對象／5 小時／替別人開 | `rejections leave no grant …` |
| 6 執行失敗如實記錄 | `auto.executed failed …` |
| 7 GAP-11 用 action 延長 | 不屬 HubClock：client 指示走確認卡（§5） |

client 指令另有 `client/test/hub-hook.test.mjs` 的 `auto …` 測試。實機 TC-15 由 PM 部署後執行。
