# F-05｜Hindsight 自架實測（feasibility spike）

- 執行：swe-Ben（Claude）｜日期：2026-11-16｜任務：<ORCA_ID>
- 對象：Hindsight（https://github.com/vectorize-io/hindsight，MIT），commit `5318be8`（2026-11-14），PyPI `hindsight-api==1.2.1`
- 方法：指導者 `skills/feasibility/SKILL.md`。先讀文件，再在本機做隔離、可逆的原型。
- 環境：MacBook Air（Apple Silicon arm64，24 GB RAM），pip 版、內嵌 Postgres（pg0）、本機 Ollama `qwen2.5:7b`。**全程沒有使用任何付費 key、沒有啟動 Docker、沒有連線 VPS。**
- 所有測試檔都在 scratchpad：`/private/tmp/claude-501/-Users-panh-c-orca-workspaces-don-t-be-a-meat-proxy-swe-Ben/1c03185c-d7af-4573-b11d-16c70d5dae77/scratchpad/hs/`（`scripts/mcp_test.py`、`scripts/bank_proxy.py`、`api.log`、`ollama.log`）。這個資料夾會被清掉；要保留證據，PM 需要另外複製。

---

## 0. 結論：**需改造**（核心可以照抄，外面要包一層薄的驗證代理）

| 問題 | 判斷 |
|---|---|
| 記憶層要不要自己寫？ | **不用**。retain、recall、bank 隔離、團隊共享、MCP 端點都實測可用。 |
| 能不能原樣上線給組員？ | **不行**。內建驗證只有「一把全域 key」：拿到 key 的人可以讀寫**所有** bank，也能列出所有組別。需要一層「每人一個 token → 只能進一個 bank」的反向代理。我做了一個約 30 行的 PoC，實測可行。 |
| 會不會推翻 Brief 的架構？ | 不會，但有兩點要回饋到 SAD：(1) Hindsight 沒有「收件匣、給誰」的概念，G-02 的「給我的東西」仍然需要 Agent Mail 或另外的訊息層；(2) retain 會用 LLM 改寫內容，本地小模型會漏掉事實。 |

會改變判斷的新證據：Linux VPS 上實測的 RAM 超過 2 GB，或者正式 LLM 每次 retain 的成本超過 F-03 的上限。

---

## 1. 自架（任務 1）

| 項目 | 結果 | 證據 |
|---|---|---|
| 安裝 | ✅ `uv venv -p 3.12` + `pip install hindsight-api`（1.2.1） | venv 2.1 GB（含 torch 和本機 embedding、reranker） |
| 啟動 | ✅ 第一次啟動會下載 pg0 和 embedding 模型，之後 `Uvicorn running on http://127.0.0.1:8888` | `api.log` 11:48:50 |
| 資料庫 | ✅ 內嵌 pg0（PostgreSQL 18.1） | `home/.pg0/installation/18.1.0/bin/postgres` |
| LLM | ✅ `HINDSIGHT_API_LLM_PROVIDER=ollama`，模型 `qwen2.5:7b`，**不用 key** | 官方 models 文件「Local models through Ollama, with no key」；`ollama.log` 的 `/api/chat` 都是 200 |
| Docker | ⏸ 沒測。Docker daemon 沒在跑，pip 版已能回答所有問題，所以沒有請 PM 啟動 Docker Desktop。 | 映像大小改用 registry API 查，見 §5 |
| 隔離 | 啟動腳本把 `HOME` 指到 scratchpad，pg0 資料和 HF 快取都不寫進使用者家目錄。 | `run.sh` |

唯一寫到 scratchpad 以外的東西：Ollama 模型存在 `~/.ollama/models`（qwen2.5:7b，約 4.7 GB）。不需要時可以執行 `ollama rm qwen2.5:7b`。

## 2. bank 隔離與團隊記憶（任務 2）

測試寫入（都走 MCP `sync_retain`）：
- `group-a`（agent `claude-A1`）：「交接：A1 完成了登入頁的 Figma 稿，下一步請 A2 實作 /login 路由，截止 11/20。資料庫採 PostgreSQL。」
- `group-b`（agent `claude-B1`）：「交接：B 組決定用 MongoDB，後端由 B2 負責。」

| 測試 | 結果 | 證據 |
|---|---|---|
| 團隊記憶：另一個 agent（`codex-A2`，新的 MCP session）在 group-a 問「我下一步要做什麼？」 | ✅ 取回 A1 的交接，`metadata.author=claude-A1` | recall 回傳 id `c027d0ea…` |
| 隔離：B 組 agent 在 group-b 搜「登入頁 Figma 和 PostgreSQL 的交接」 | ✅ 只回 B 組的 MongoDB 紀錄，沒有 A 組內容 | recall 回傳 id `dcca35ea…` |
| 繞過嘗試 1：連 `/mcp/group-a/`，同時帶 `X-Bank-Id: group-b` | ✅ 仍然只回 group-a（URL path 優先，跟文件一致） | 回傳「截止日期是 2026-11-20」 |
| 繞過嘗試 2：在 `/mcp/group-a/` 呼叫 recall 時塞 `bank_id: group-b` | ✅ 參數被忽略，仍然只回 group-a | 同上 |
| **同一把 key 走多 bank 端點 `/mcp/` 呼叫 `list_banks`** | ❌ **列出所有組別**（group-a、group-b、筆數、最後寫入時間），也能用 `bank_id` 讀任何一組 | §4 |

所以，**資料層的隔離成立，存取權限的隔離不成立**，要靠 §4 的代理補上。

### 意外發現：retain 會改寫內容，而且會漏事實
- group-a 那段文字萃取出的事實裡，**沒有「資料庫採 PostgreSQL」**（list_memories 一開始只有 1 筆，consolidation 之後的 observation 也沒有）。
- group-b 的繁體中文被改寫成**簡體**：「B组决定使用MongoDB…」。
- 原文還留在 chunk 裡：recall 加 `include_chunks: true` 就能取回完整原文，包括 PostgreSQL 那句。
- 影響：交接、決策這類必須一字不差的內容，不能只靠萃取出的事實。對策：(a) 每次 recall 都帶 `include_chunks`，或用 `get_document` 取原文；(b) 正式環境換成能力更強的模型再重測；(c) 用 `retain_mission` 或 `HINDSIGHT_API_MCP_INSTRUCTIONS` 要求保留原語言。b、c 的效果都**待確認**，我沒有測。這只是 qwen2.5:7b 的結果，不能代表雲端模型。

## 3. 從 MCP client 連線（任務 3）

- 方式：用 Python httpx 走 MCP Streamable HTTP 的 JSON-RPC（`initialize` → `notifications/initialized` → `tools/list`、`tools/call`），帶 `Authorization: Bearer …` 和 `mcp-session-id`。**沒有改任何全域 MCP 設定。**
- 結果：`/mcp/group-a/` 有 **36 個工具**，`/mcp/` 有 **39 個**。官方 MCP 文件寫 27 個和 30 個，文件已經過時。
- 單一 bank 模式**預設就開放** `delete_bank`、`clear_memories`、`update_bank` 這類破壞性工具。
- 用 bank 層級設定 `mcp_enabled_tools` 限制成 `retain, sync_retain, recall, reflect, list_memories, get_memory` 之後，呼叫 `delete_bank`、`clear_memories`、`update_bank` 都回 `Unknown tool`。✅
- Claude Code 的專案層級設定 **待確認**。我沒有實際跑 Claude Code 連線，因為那可能動到使用者層級的 `~/.claude.json`。依官方文件的建議寫法（未實測）：

```json
// <專案>/.mcp.json
{ "mcpServers": { "hindsight": { "type": "http",
  "url": "https://<hub>/mcp/group-a/",
  "headers": { "Authorization": "Bearer ${HINDSIGHT_TOKEN}" } } } }
```

## 4. 驗證與 token（任務 4）

| 項目 | 結果 | 證據 |
|---|---|---|
| 預設 | ❌ **完全開放**，不用驗證 | `DefaultTenantExtension`「No authentication required」 |
| 內建 API key | ✅ `ApiKeyTenantExtension`：沒有 key → 401、錯的 key → 401、對的 key → 200，REST 和 MCP 都一樣 | 實測 |
| 每人一個 key、只能進自己的 bank | ❌ **沒有**。原始碼只比對**一把** `HINDSIGHT_API_TENANT_API_KEY`，通過後就能存取整個 schema 的所有 bank | `hindsight_api/extensions/builtin/tenant.py` |
| 官方延伸點 | 可以自己寫 `TenantExtension`，但只能依 key 切 **schema**，不是切 bank | 同檔 docstring：「implement a custom TenantExtension…」 |
| 文件不一致 | 設定文件另外提到 `HINDSIGHT_API_MCP_AUTH_TOKEN`。這和 tenant 是兩種機制，我只測了 tenant。**待確認** | configuration.mdx L2715 |

### 反向代理 PoC（`scripts/bank_proxy.py`，約 30 行，Starlette + httpx）
規則：token 對應唯一一個 bank；只允許 `/mcp/{自己的 bank}/`；移除 `X-Bank-Id`；上游的主 key 只存在代理裡。

| 測試 | 結果 |
|---|---|
| alice（group-a 的 token）→ `/mcp/group-a/` | 200 ✅ |
| alice → `/mcp/group-b/` | 403 ✅ |
| alice → `/mcp/`（多 bank 端點） | 403 ✅ |
| alice → REST `/v1/default/banks` | 403 ✅ |
| 沒有 token | 401 ✅ |
| 拿上游主 key 打代理 | 401 ✅（主 key 不能從外面用） |
| alice 帶 `X-Bank-Id: group-b` 再 recall | 200，只回 group-a ✅ |

→ 「每人一個 token、可以撤銷」（Brief 的 R-4）用代理就能做到：撤銷就是刪掉對應表的一列。正式版要補：token 存資料庫、TLS（Caddy）、串流回應、Hindsight 只綁 127.0.0.1。
→ **另一個缺口（待 SAD 決定）**：`metadata.author` 和 tag 由 agent 自己填，可以冒名。代理可以依 token 強制改寫 author。我沒有實作。

## 5. 資源（任務 5）

| 項目 | 數值 | 來源與限制 |
|---|---|---|
| API 程序 RSS（閒置） | ~300–350 MB | `ps`，macOS |
| API 程序 RSS 峰值 | **1,527 MB** | `api.log` 的 `peak_rss_mb`，啟動並載入本機 embedding、reranker 時 |
| 內嵌 Postgres | ~23 MB（postmaster phys_footprint）＋各連線 5–20 MB，合計約 100 MB | `footprint`、`ps` |
| Ollama qwen2.5:7b | ~4.7 GB RSS | 本機跑 LLM 才需要；VPS 用雲端 LLM 就沒有這筆 |
| 磁碟 | venv 2.1 GB、模型快取 388 MB、pg0 91 MB | `du` |
| Docker 映像 `ghcr.io/vectorize-io/hindsight:latest`（壓縮後的 layer 合計） | arm64 **1,069 MB**、amd64 **1,127 MB** | GHCR registry API（2026-11-16 查詢）；解壓後的大小未量 |
| 容器 RSS | **待確認**：Docker 沒有啟動，沒量 `docker stats` | — |

**每次 retain 的 LLM 用量**（取自 Hindsight 的 `/metrics`，2 筆短文字的平均）：

| 階段 | 呼叫次數 | 輸入 token | 輸出 token |
|---|---|---|---|
| `retain_extract_facts`（同步） | 1 | ~2,300 | ~100 |
| `consolidation`（retain 後背景執行） | 1 | ~3,500 | ~127 |
| **每次 retain 合計** | **2** | **~5,800** | **~230** |

- 啟動時另有 1 次 verification 呼叫（33 進／16 出）。recall 不呼叫 LLM（metrics 沒有 recall 的 LLM scope）。reflect 會呼叫，但我沒有測。
- 延遲：本機 7B 模型下，第一次 retain 17.4 秒（含冷啟動），第二次 4.9 秒。
- 估計：雲端模型的 token 數會隨內容長度和 prompt 變動；換算金額交給 F-03。
- **VPS 推論（估計，沒有實測）**：只計 Hindsight，峰值約 1.5 GB＋Postgres，所以 **1 GB 的 VPS 不夠**，2 GB 很勉強，建議以 4 GB 規劃。如果把 embedding、reranker 改用外部服務，可以壓低 RAM，但會多一筆費用。這是 SAD 和 F-03 要取捨的事。

---

## 6. 照抄、改造與缺口

| 類別 | 內容 |
|---|---|
| 可以直接抄 | retain／recall／reflect、一組一個 bank、每個 bank 的 MCP 端點、`mcp_enabled_tools` 白名單、tags 與 metadata、`/metrics` 的 token 計量（可以直接拿來做每日上限） |
| 需要改造 | ① 每人 token → bank 的反向代理（PoC 已驗證）；② 每個 bank 預設關掉破壞性工具；③ 交接、決策原文要用 `include_chunks` 或 document 取回；④ 代理強制寫入 author |
| Hindsight 不提供 | 收件匣、「給誰」、已讀狀態、即時通知 → G-02、G-03 仍然需要 Agent Mail（F-01）或另外的訊息層。F-04 的 V-4（兩者重疊）判斷：**不重疊，是互補**。 |

## 7. 待確認

1. Docker 版的容器 RSS 和解壓後的映像大小（要啟動 Docker Desktop，需要 PM 和 維護者 同意）。
2. Linux VPS 上的 RAM：macOS 的數值只能當估計。
3. Claude Code、Codex、Cursor、Antigravity 實際用專案層級設定連線（只測了 JSON-RPC）。
4. 換成正式雲端模型後，萃取還會不會漏事實或轉成簡體；`retain_mission` 的效果。
5. `HINDSIGHT_API_MCP_AUTH_TOKEN` 和 tenant extension 的關係。
6. reflect 的 LLM 用量（專案助理回答「現在做到哪」可能會用到）。

## 8. 需要 維護者／PM 決定的事（沒有代為決定）

- 正式環境要接受「retain 改寫內容」，還是規定交接一律存原文（例如 document 或 Agent Mail），Hindsight 只負責搜尋？
- VPS 規格要不要從 US$5／1 GB 上調。§5 的估計顯示 1 GB 不夠。

## 9. 來源（2026-11-16 查詢）

- https://github.com/vectorize-io/hindsight README（commit `5318be8`）
- https://hindsight.vectorize.io/developer/mcp-server：讀的是 repo 內的原始檔 `hindsight-docs/docs/developer/mcp-server.md`
- repo 內 `hindsight-docs/docs/developer/configuration.mdx`、`models.mdx`、`api/memory-banks.mdx`
- 原始碼 `hindsight-api-slim/hindsight_api/extensions/builtin/tenant.py`
- GHCR registry API：`ghcr.io/v2/vectorize-io/hindsight/manifests/latest`
