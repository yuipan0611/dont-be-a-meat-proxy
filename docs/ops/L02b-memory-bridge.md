# L-02b：Mail → Hindsight 索引 bridge（GAP-16）

> 2026-11-17 F-11 更新：正式 LLM 呼叫已改經共用 request-count gateway；本文 Anthropic／USD 設定為歷史紀錄。個人 Gemini CLI OAuth 已有官方停用公告，請依 [F-11 調研與部署設計](../research/F-11-gemini-subscription-backend.md) 的 backend／條款／隱私限制操作；目前預設 disabled。

2026-11-17，swe-Ben。**本機驗證完成，VPS 未部署**。依據：SDS API-04（唯一 bridge）、GAP-16、`docs/ops/runbook-L02-memory.md`。

## 1. 一句話

交接與決策照舊只寄一次 Mail（Mail 是正式紀錄）。client 在寄 `handoff`／`decision` 時多 CC 一個 Mail agent「MemoryBridge」。bridge 從自己的收件匣讀到後，把**原文**寫進 Hindsight（`document_id = mail-<Mail ID>`），寫成功才記 `indexed`。agent 不直接寫 Hindsight（bank-proxy 本來就只給唯讀工具）。

```
agent ──send(handoff/decision, cc MemoryBridge)──▶ Mail（保存＝耐久事件）
                                                      │ 收件匣事件（cursor）
                                                      ▼
                       memory-bridge：同一交易寫 ingest 紀錄＋cursor ──▶ retain（sync）──▶ Hindsight
                                     （pending → in_flight → indexed｜pending｜unknown｜error）
                                                                       │ LLM
                                                                       ▼
                                                           bank-proxy 的 LLM gateway（每日 0.50 USD）
```

## 2. 狀態與重試（`ops/memory-bridge/bridge.mjs`）

| 狀態 | 意思 | 下一步 |
|---|---|---|
| `pending` | 已排入，或上次失敗但可重試（Hindsight 連不上、5xx、**每日額度用完**、429） | 依退避（30 秒起倍增，上限 15 分鐘）重試；記 `lastError`、`lastAttemptAt`、`attempts` |
| `in_flight` | 正在 retain（已先寫進狀態檔） | 程式中斷時，下一輪改成 `unknown` |
| `unknown` | 送出了但結果不明（逾時、連線中斷、程式當掉） | **先查同一個 document ID**：Hindsight 有、且原文 sha256 一致 → 直接 `indexed`；沒有 → 用同一個 document ID 再 retain |
| `indexed` | Hindsight 已存原文 | — |
| `error` | 4xx，或 Mail 原文的 sha256 和排入時不同 | 不自動重試；查原因後 `reindex <Mail ID>` |

- **原文**：retain 前一定重新從 Mail 讀原文並核對 sha256；索引的是 envelope 的 `text`（逐字），`metadata` 帶 `mail_id`、`from`、`kind`、`created_ts`、`thread_id`、`summary`。
- **按 Mail ID 重跑**：`node ops/memory-bridge/main.mjs reindex <id>`（已有紀錄就改回 pending；沒有紀錄就從 Mail 讀那則訊息補建，舊 client 沒 CC 的交接也能補；非 handoff／decision 要加 `--force`）。
- **不是 exactly-once**：同一個 document ID 重寫的行為見 §4；寫兩次會收斂成一份文件，但萃取出的記憶會重新產生。
- 狀態檔沿用 HubClock 的 `ops/lifecycle/store-file.mjs`（租約 lock、fencing、cursor、已處理 Mail ID），在 bridge 自己的目錄。只能一個 writer；手動 `once`／`reindex` 在服務運行時會 standby（exit 3）。

## 3. 部署（PM 依此做；我沒有登入 VPS）

前置：L-02 已部署（`neighbor-hub-memory` 在跑）。

```bash
cd /opt/neighbor-hub
# 1) 註冊 MemoryBridge（已存在的註冊保留，不輪替）
/opt/neighbor-hub/ops/bootstrap            # 會多一行 BOOTSTRAPPED role MemoryBridge: <名字>
python3 -c "import json;print(json.load(open('/var/lib/neighbor-hub/private/memorybridge.sender.json'))['agentName'])"
# 2) tenant key 給 bridge 一份（擁有者＝HubClock 憑證的擁有者，600）
OWNER=$(stat -c %u:%g /var/lib/neighbor-hub/private/hubclock.sender.json)
install -m 600 -o "${OWNER%%:*}" -g "${OWNER##*:}" /var/lib/neighbor-hub/private/memory/hindsight/hindsight-api.key /var/lib/neighbor-hub/private/memorybridge.hindsight-api.key
install -d -m 700 -o "${OWNER%%:*}" -g "${OWNER##*:}" /var/lib/neighbor-hub/memory-bridge
# 3) 啟動（和 mail-a、HubClock 同一個 project）
HUB_OPS_UID=${OWNER%%:*} HUB_OPS_GID=${OWNER##*:} docker compose -f deploy/compose.yaml \
  -f deploy/hubclock/compose.hubclock.yaml -f deploy/memory-bridge/compose.bridge.yaml up -d memory-bridge
docker compose -f deploy/compose.yaml -f deploy/hubclock/compose.hubclock.yaml -f deploy/memory-bridge/compose.bridge.yaml logs --tail 5 memory-bridge   # 每 15 秒 "ev":"tick"
```

4) 兩台電腦的 `hub-client.json` 加 `"memory_agent": "<上面印出的名字>"`（和 `clock_agent` 一樣是 Mail 產生的名字）。沒設就不 CC，行為與 L-02 前相同。
5) 已存在的交接補索引：對每個要補的 Mail ID 跑
   `docker compose … run --rm --no-deps memory-bridge node /app/ops/memory-bridge/main.mjs reindex <id>`（服務運行時會 standby，先 `stop memory-bridge` 再跑，跑完再 `start`）。
6) 檢查：`… run --rm --no-deps memory-bridge node /app/ops/memory-bridge/main.mjs status` → `byStatus`、`lastIndexedAt`、`notIndexed`（含錯誤與下次重試時間）。
7) 備份：state 目錄 `/var/lib/neighbor-hub/memory-bridge` 跟 HubClock state 一起備份（H-06）。遺失也不會丟資料：Mail 是紀錄，可重建 cursor 後用 `reindex` 補。

## 4. Hindsight 1.2.1 黑箱結果（同一個 document_id）

見 §5 實測紀錄；結論寫在這裡給 bridge 的重試設計用：

- 同一 document ID、同一原文再 retain：文件數 1→1，記憶數 4→4（**替換**，不是疊加）。
- 同一 document ID、不同原文：文件數 1→1，`original_text` 被**取代**成後寫的內容，舊文件萃取的 4 筆記憶也一起換成新內容的 1 筆。
- LLM 失敗（gateway 每日額度 429）時，sync retain 回 HTTP 500「Fact extraction failed … RateLimitError 429」，而且**整份文件都不存**（GET document 404）——沒有半套。
- 所以「結果不明就再寫一次」會收斂成 Mail 的原文；bridge 也用這點在被外部改寫時以 `reindex` 寫回 Mail 原文。

## 5. 實測紀錄

2026-11-17，Apple Silicon、Docker Desktop；真 Mail（`mcp_agent_mail_rust` 固定 digest，amd64 模擬）、L-01 Postgres、Hindsight 1.2.1、bank-proxy／gateway、bridge 容器（本 overlay）；LLM＝本機 Ollama qwen2.5:7b。`node --test ops/test/memory-bridge.integration.test.mjs` → **7/7 pass**（469 秒）：

| 情境 | 結果 |
|---|---|
| bootstrap | 多註冊 MemoryBridge；重跑 `RETAINED`，不輪替 |
| Hindsight 停止時收到交接 | `pending`，`lastError={kind:unreachable, ENOTFOUND}`，有 `lastAttemptAt` |
| Hindsight 恢復＋`reindex <id>` | `indexed`；Hindsight 的 `original_text` sha256＝Mail 原文（TC-21 fixture 1,500 字）；metadata 帶 mail_id／from／kind／created_ts／thread_id；retain 54 秒（本機模型） |
| 同 document ID 黑箱 | `{"before":{"documents":1,"memories":4},"sameAgain":{"documents":1,"memories":4},"different":{"documents":1,"memories":1},"original_text_replaced":true}`；之後 `reindex` 寫回 Mail 原文，sha256 一致 |
| 每日額度用完（gateway cap 1 µUSD、Hindsight 用 anthropic provider） | bridge `pending`（500 + RateLimitError 429 原因）；Hindsight 沒存文件（404）；gateway `spentMicros=0`、log 有 `budget_refused`（沒送出）；改回可用後 `reindex` → `indexed`，原文一致 |
| 重啟／第二個 writer | 新容器讀到同一份 state（cursor、2 筆 indexed）；服務運行時手動 `once` → exit 3 standby |

單元測試：`node --test ops/memory-bridge/test/*.test.mjs` → 16/16（含：只收 handoff／decision、退避上限、unknown 已存→不重寫、unknown 未存→查後重寫、程式中斷 in_flight→下一輪先查、4xx→error＋reindex、Mail 原文被改→error、重啟不重收、重複事件去重）。

## 6. 未做／限制

- 真 Anthropic key 還沒有：超額路徑用真 gateway（上限設 1 µUSD）＋Hindsight 的 anthropic provider 驗證「先拒絕、不送出」；成功路徑用本機 Ollama。Haiku 5.5 的萃取品質與實際花費未測。
- 只索引 `handoff`、`decision`。`help`／`task` 不進記憶（SDS：交接與決策）。
- 撤回／刪除 Mail（上線批次不做撤回）不會連動刪除 Hindsight 文件；到期清除另票。
- bridge 讀 Mail 用自己的收件匣；client 沒設 `memory_agent` 時不會 CC，需要 `reindex` 補。
