# 05 SDS — don't be a meat proxy

- 版本：0.3｜日期／查詢日期：2026-11-16｜作者：codex-senior-swe（T7）｜審查：PM-Emily → 維護者（G2）。
- 狀態：**設計草稿**；只產出文件，以下程式／設定為實作契約，沒有部署、安裝 hook 或修改使用者設定。上游：[SAD](04-sad.md)、G1 Brief、PRD、[SRS v0.1 §4.2／4.4](03-srs.md)、[GAP-01～22](diagrams/README.md)、F-01b／F-02／F-05／F-06／[F-07](research/F-07-llm-provider.md)／[F-08](research/F-08-hostinger-vscode.md)與本次 維護者 六項定案；末尾逐條追溯 FR／NFR／GAP，T8 的 TC 編號待 PM 整合。
- 批次：**M＝11-23 MVP**（Caddy＋Mail＋Claude Code）；**L＝11-30 上線**（記憶／Discord／GitHub／組員接入）；S3 多組另過 Gate。未標已測的新增接縫一律待實作驗證。
- 決策狀態：SRS §4.4 的 **question 24 h 未回答、session 結束待確認改失效、20,000 字元、2027-03-31 後刪除／每日備份留 7 天／每週快照**已定；本次 **維護者 已定** `hub.example.invalid`／Hostinger DNS、每裝置一 token、`/status` ephemeral、auto mode 在 11-30、M 最近 N 交接／L Hindsight 現況、兩槽 Haiku 5.5／每日共用 0.50 USD。這些覆蓋前版 PM 暫定及 SRS 舊措辭，不再列選型待決。

## 資料模型與不變量

Mail SQLite＋archive 是訊息、交接及確認結果的正式紀錄；GitHub 是任務真相；Hindsight 是可重建搜尋記憶。伺服器產生 Mail ID／UTC 保存時間；ops／glue 的狀態交易與 outbox 只協調／索引，正式控制結果寫回 Mail 後才回成功。期限以 VPS 時鐘／Mail 事件的伺服器時間算，測延遲用 monotonic clock，不以兩台電腦的時鐘相減。

| 資料／批次 | 鍵與必要欄位 | 不變量／生命週期 |
|---|---|---|
| `group`／M | `group_id`、固定 server `project_key`、Mail hostname、L 的 `bank_id` | A 組 `project_key=/data/projects/group-a`；Mac／Windows 共用此值，不能傳各自本機 repo path 變兩個專案；每組只掛自己的 `/data` |
| `principal`／M；L 入 glue DB | `token_id`、`discord_user_id`（字串，不轉 JS number）、`group_id`、`device_id`、允許 agent 集合、token hash、`revoked_at?` | **每裝置一把（維護者 已定）**，同裝置工具共用入口 token，agent 各自保有 registration token；M 手動，L 由成員名單核發。Mac／Windows 可單獨撤銷；Caddyfile 明文秘密仍須限權、遮蔽、加密備份 |
| `agent`／M | `(group_id, canonical_agent_name)`、owner mapping、program、model、裝置別名 | 名稱沿用 register 回傳；M 例 BlueLake＝Mac、RedStone＝Windows。此 mapping 是應用設定，Mail 原生不保證 Discord owner 不可冒名；一個 agent 同時只啟一個主 session |
| `item-v1`／M | JSON body：`v:1`、UUID `client_event_id`、`kind:handoff\|help\|decision\|task`、`intent:question\|action`；`source_session/summary/text` 為必填非空字串；`links` 為 URL 字串陣列、`unfinished` 為字串陣列（兩者可空） | 全文原樣放 `body_md`，Mail 決定 from／to／ID／時間；body 自報作者不當驗證。task 在 L 必有 Issue URL；未知 v／欄位不自動執行，保留原文並顯示需人工看 |
| 本機 journal／M | `(group,agent,session)`、seen IDs、event cursor、prepared handoff、待送 key、remote request state | 放 OS 使用者資料目錄，排除 Git；原子 rename 寫 checkpoint。收件 staging 與「已讀／同意／執行成功」分開；傳送失敗可在新 session 補送 |
| ops SQLite／M | `requests(root_mail_id,recipient_session,status,presented_mail_id?,deadline?,version)`、question deadline、session-end marker、cursor／outbox | host 計時排程使用；action 只一個 terminal 結果，question 24 h 無回答保留原文並標未回答。M 的正式狀態仍寫 Mail，不建立新 mailbox |
| glue SQLite／L | `decisions(draft_mail_id,status,version,confirmed_by?,confirmed_at?)`；`grants(recipient,source,expires_at,revoked_at?)` | 決策 `draft→confirmed\|rejected`，S1 維護者 確認、S2 非提出者組員確認且 維護者 可否決；每次轉態 append audit。grant 預設 1 h、最多 4 h、指定來源，不能用寄件者自報欄位開啟 |
| bridge／L | `cursors(group,recipient,consumer)`；`outbox(event_key,target,state,attempts,next_try_at)`；`ingests(mail_id,bank,document_id,status)` | 唯一 event_key；先同一交易寫 outbox＋cursor 再做外部副作用；各 consumer 的 cursor 分開，不代收件人標已讀 |
| 額度／L | `budget(scope="global",day,reserved_micro_usd,spent_micro_usd)`、`usage(request_id,role,provider,model,status)` | 兩角色共用唯一日帳本／500,000 micro-USD；role 只供統計不另給額度。先原子預留最大費用、再呼叫結算；超時未知帳單不直接退預留。價格表缺失拒絕付費呼叫，禁止 float 累加 |

不修改 Mail／Hindsight 原生 schema。M journal 是本機恢復資料，ops／L glue SQLite 是小型排程／業務索引；拒絕驗證時不可產生正式項目／Issue／通知，原始內容不是可執行指令。**保存至 2027-03-31（Asia/Taipei）後刪除、每日備份滾動留 7 天、每週 Hostinger 快照**依 SRS §4.4；清除包含 archive Git 歷史、記憶索引、journal／outbox 與專案備份，不能由 restore／重送復活，操作與共享快照責任見 SAD。

## API 與部署契約

### API-01｜公開入口與 Compose（M；memory 入口 L）

- **維護者 已定 Hostinger DNS**：A 記錄 `hub.example.invalid → <VPS 公網 IPv4>`；VPS IP 實值由 operator 提供。Mail URL 固定 `https://hub.example.invalid/mcp/`：Streamable HTTP JSON-RPC；保留 MCP session／protocol headers，依 initialize 協商版本。F-01b client 提議 2025-03-26、server 回 2024-11-05，實際 Claude Code 相容待驗。
- Caddy 的 bearer allowlist 套用**整個 site**，含 `/api/`、`/mail/*`、UI API、health、未知路徑；驗證成功後才換成本組 upstream bearer。不得只保護 `/mcp/`；backend liveness 原生可無 token，因此 backend 絕不能外露。
- 無／錯／已撤銷 token＝HTTP **401**（沒有資料副作用）；可用 token 但上游失聯＝**502**，不可回空 inbox。HTTP 200 還要檢查 JSON-RPC error／MCP `isError`。

Caddy site 沿用 F-01b 的 stock matcher（同名 header matcher 是允許值集合）；hostname 已定，token 是佔位值。指定 Let's Encrypt，停用 TLS-ALPN challenge 以使用 **HTTP-01／TCP 80**；憑證／續期仍由 Caddy 自動管理：

```caddyfile
hub.example.invalid {
  tls {
    issuer acme {
      dir https://acme-v02.api.letsencrypt.org/directory
      disable_tlsalpn_challenge
    }
  }
  @allowed {
    header Authorization "Bearer <mac-device-token>"
    header Authorization "Bearer <windows-device-token>"
  }
  handle @allowed {
    @memory path /memory /memory/*
    handle @memory {
      respond "Memory is not enabled in MVP" 503
    }
    handle {
      reverse_proxy mail-a:8765 {
        header_up Authorization "Bearer <group-a-upstream>"
      }
    }
  }
  handle {
    respond "Unauthorized" 401
  }
}
```

admin 保留 container loopback／operator 本機操作，不對外 publish；Caddyfile 目錄整體掛載，讓原子替換後 reload 看得到新設定。正式配置保留 Authorization 日誌遮蔽；業務 HTTPS 與健康檢查須 token，ACME HTTP-01 路徑是 Caddy 自動處理的驗證例外。M 記憶路徑回 503；L 將此分支換成 `/memory/*` 的 strip-prefix 代理至 bank-proxy，保留個人 Authorization，不把 `/memory` 落到 Mail。此處只有 adapt 語法驗證，沒有執行 DNS／ACME。[Caddy issuer 文件](https://caddyserver.com/docs/caddyfile/directives/tls#acme)（查詢 2026-11-16）。

MVP Compose 的必要片段如下；`${...:?}` 是部署時必填，這不是已驗證可執行的完整部署包。`MAIL_IMAGE` 要填固定來源／架構／portable 功能確認後的 digest；secrets 檔僅在 VPS 本地、不可提交。

```yaml
services:
  caddy:
    image: ${CADDY_IMAGE:?pin v2.11.9 digest}
    ports: ["80:80", "443:443"]
    volumes: ["./private/caddy:/etc/caddy:ro", "caddy_data:/data", "caddy_config:/config"]
    networks: [mail_a_net]
    mem_limit: 128m
    restart: unless-stopped
  mail-a:
    image: ${MAIL_IMAGE:?pin verified Linux digest}
    command: ["serve", "--no-tui", "--host", "0.0.0.0", "--port", "8765", "--no-reuse-running"]
    env_file: ./private/mail-a.env
    environment:
      HTTP_PATH: /mcp/
      DATABASE_URL: sqlite:////data/mail.sqlite3
      STORAGE_ROOT: /data/archive
      HTTP_ALLOW_LOCALHOST_UNAUTHENTICATED: "false"
      HTTP_RBAC_DEFAULT_ROLE: writer
      MESSAGING_SESSION_IDENTITY: "true"
      MESSAGING_FAIL_CLOSED_SEND_PROFILE: "true"
      MESSAGING_AUTO_REGISTER_RECIPIENTS: "false"
      AM_SEARCH_SEMANTIC_ENABLED: "false"
      LLM_ENABLED: "false"
    volumes: ["mail_a_data:/data"]
    networks: [mail_a_net]
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    restart: unless-stopped
networks:
  mail_a_net: {internal: true}
volumes:
  mail_a_data: {}
  caddy_data: {}
  caddy_config: {}
```

Caddy 另接一般 egress 網路供 ACME；上面只展示與 Mail 的隔離連線，**不可只接 internal 網路就期待 ACME 成功**。`mail-a.env` 設專用 `HTTP_BEARER_TOKEN`，不向 client 發；XDG／HOME 所需可寫路徑也限本組 volume／tmpfs，先驗證 UID 與 volume 權限。沿用 F-01b 的 portable／關 LLM 範圍；`MESSAGING_AUTO_REGISTER_RECIPIENTS=false` 是固定 SHA 已有設定但本輪未執行驗證，目的是符合 AC-01.2 的未知收件人拒絕。

部署前置依 F-08／SAD：盤點既有 Ubuntu／Docker，範本僅為新機選項、不重灌；允許既有 SSH（預設 TCP 22）及 TCP 80／443，backend／DB 不 publish。**待對齊 SR-ID-02／NFR-04 的 loopback 字面要求**：不同 Compose 容器內 backend 必須聽內部介面 `0.0.0.0` 才能被 Caddy 達到；以專用 internal network＋不 publish 實現外部不可直連，不能硬改成 container `127.0.0.1` 造成代理失聯。

L 依 SAD 拓樸另加 `profiles: [live]` 的 db、hindsight、bank-proxy、bot；db 抄固定 SHA external-pg 的 PG18 volume layout，**不是舊版 `/var/lib/postgresql/data`**。設定 `HINDSIGHT_API_DATABASE_URL` 指 db，禁內嵌 pg0、禁公開 8888／9999／5432；限額依 SAD 表，PG 用量與 extensions migration 真啟動驗證。M／L 都加 container healthcheck、正常 stop grace、log rotation；依賴健康後才啟 ingest，健康未就緒時 command 回服務尚未就緒。

### API-02｜原生 Mail 工具（M）

初始化順序：`initialize` → `notifications/initialized` → `tools/list` → `ensure_project` → `register_agent`。先由 operator bootstrap BlueLake／RedStone／計時服務 HubClock 並設允許的 contact policy（F-01b 用 open，**它只允許寄信，不代表允許動手**）；重新連線時依原生 sender token 契約恢復，不關 fail-closed 以求通過。

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"project_key":"/data/projects/group-a","sender_name":"BlueLake","sender_token":"<registration_token，僅本機保存>","to":["RedStone"],"cc":["HubClock"],"subject":"交接登入頁","topic":"handoff","thread_id":"<REDACTED_VALUE>","body_md":"{\"v\":1,\"client_event_id\":\"<REDACTED_VALUE>\",\"kind\":\"handoff\",\"intent\":\"question\",\"source_session\":\"mac-session-01\",\"summary\":\"登入頁完成\",\"text\":\"測試已通過；下一步待確認\",\"links\":[],\"unfinished\":[]}","idempotency_key":"<REDACTED_VALUE>","convert_images":false}}}
```

- 成功：HTTP 200、`isError=false`，解析 `deliveries[].payload.id`／`count` 才顯示「已保存 #ID」。`verified_sender` 驗的是 Mail agent token，不是 Discord 人。未知收件人應回工具錯誤，沒有 placeholder；UI 不寫死 error type，依固定版本結果映射「收件者不存在」。
- 發送 adapter：必填欄位、v／enum、接收者 roster、連結格式先驗；缺 `intent` 時依 SRS 以 action 處理，不因缺性質就當 question。不要送本機 `attachment_paths`／inline file references，程式碼只放 GitHub 連結。`kind` 存 body envelope；另設原生 `topic=handoff|help|decision|task` 供分類查詢，topic 不是權限。疑似密鑰規則未全定，不能聲稱 native Mail 已會擋所有密碼。
- **20,000 字元（維護者 已定）**：`text` 以 Unicode code points 計數，保留原字串、不正規化；20,000 接受、20,001 拒絕（E-FIELD，不送原生工具），emoji 不以 JS UTF-16 的兩個 code units 誤算。更長內容放 GitHub 連結。summary／unfinished 是同內容的摘要，不用它們夾帶超限原文；包裝 metadata 不算使用者 text。原生只有 `MAX_MESSAGE_BODY_BYTES` 等 byte guard（固定 SHA `config.rs`／`messaging.rs` 已核對），**不能冒充字元檢查**。M 先由受控本機 adapter 驗；原生 MCP 直呼能繞過內容／附件檢查是已知缺口，若 G2 要求所有 Hub 入口強制拒收，須將薄 ingress validator 前移至 M（與「只兩個容器」範圍由 PM 對齊），不能只靠 prompt 宣稱 FR-04／內容上限已完整通過。
- **秘密偵測層（SR-MSG-04／L）**：以伺服器 ingress validator 作權威拒收，client 同規則預檢改善回饋；涵蓋已定最小類別 `sk-` 長字串、`ghp_`／`github_pat_`、PRIVATE KEY PEM。長度閾值／誤判解除流程未決，規則表版本化；拒收僅記 request ID／rule ID，不記原文。不能只讓 client 檢查，Mail／Hindsight／bot 的寫入口都要過同一 validator。
- 原生 `idempotency_key`：同 key 同參數重送回同 ID；不同參數回 `IDEMPOTENCY_KEY_CONFLICT`，不改舊訊息。固定 SHA schema／原始碼已核對，**未做新黑箱驗證**；預設去重窗 24 h，待送超窗先查原文／請人核對，不換 key 盲送並保證永不重複。
- 401 停止輪詢／發送並提示撤銷或驗證失敗；429／503／網路超時保留同 key 待送、退避重試；結果不明時顯示「保存結果未確認」，不是成功或斷言沒存。
- **SR-ERR-05 暫定工程值**：M 的 poll／一般 Mail 呼叫 timeout 10 秒，`start` 整體 20 秒、`end` flush 5 秒；超時回 E-HUB 並保留同 key，數值在 WAN 測試後校正。SRS 的「E-HUB 無資料副作用」只適用確定沒送到的情況；請求可能已提交的 timeout 必須保留「結果未知」而非斷言零副作用，待 PM 修正錯誤表。
- 受控 adapter 為新 root 設 `thread_id=client_event_id`，後續 answer／控制／確認結果用相同 thread；需要冪等發布時用原生 `send_message`＋同 thread／固定 key，不假定所有其他工具也支援 idempotency。

### API-03｜耐久收件與已讀（M；bridge 共用於 L）

優先沿用 `fetch_inbox_events(project_key,agent_name,after,limit:100)`，回 `{events,next_cursor,has_more,oldest_available_cursor,tail_cursor}`；事件含 `cursor,message_id,kind,delivered_ts,subject,from`。**cursor 是投遞序號，不是 message ID**；按 oldest-first 取頁，`has_more` 時接續讀，未處理完不提交 cursor，首次不能 `position_now:true` 跳過離線留言。這是本次核對固定 SHA 的 [原生工具](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/crates/mcp-agent-mail-tools/src/messaging.rs)，不是 F-01b 已測過的能力（查詢 2026-11-16）。

以 `resources/read` 的 `resource://message/<id>?project=<URL-encoded project_key>` 讀完整原文（同 SHA `resources.rs`，待黑箱驗證）；備援 `fetch_inbox(...include_bodies:true,mark_read:false)` 已有 F-01b 依據。不能只靠 newest 20 筆或嚴格 `since_ts` watermark 保證不漏信。`CURSOR_EXPIRED`／`CURSOR_AHEAD` 明示「收件游標需恢復」，全量核對未讀與歷史後重建，禁止重置成 tail 製造「沒有新信」。

原文耐久放本機 staging → 注入 Claude context → agent 取到後 `mark_message_read`；單純背景 peek 不改已讀。`acknowledge_message` 只表示人／agent 收悉，**不表示接受 action**。bridge 有獨立 per-recipient MCP session／cursor，按 registry roster 讀取，不用會清除的 signal 檔或最多 1,000 筆的 UI feed 當耐久事件來源；多身分 session 的使用方式須在實作票驗證。

### API-04｜bank proxy／記憶同步（L）

公開記憶 URL 是 `https://hub.example.invalid/memory/mcp/group-a/`；Caddy 去掉 `/memory` 前綴後送 `/mcp/group-a/` 給 bank-proxy，**保留裝置 bearer**。代理查 registry、限制固定 group／bank、剝除 `X-Bank-Id`／客戶端內部身分 header，再換成 Hindsight tenant 主 key。bank-proxy 拒絕其多 bank `/mcp/`、其他 bank、REST／管理／metrics；Hub 根路徑 `/mcp/` 則仍是 Mail，兩者不能混路。保留 Streamable HTTP 的 session／DELETE／SSE 與背壓語意，不能只把 PoC 的 JSON POST 當完整代理。

| 呼叫者 | tools/list 與 tools/call 允許範圍 | 拒絕／副作用 |
|---|---|---|
| 一般 agent／唯讀助理 | `recall`、`list_memories`、`get_memory`，原文用 Mail resource | 未知／寫入工具回 MCP error `TOOL_NOT_ALLOWED`、不轉上游；跨 bank HTTP 403；無 token 401 |
| bridge 服務憑證 | 上述＋`retain`／`sync_retain`，只從已存 Mail 原文／正式狀態建立 document | 唯一 `document_id=mail:<group>:<mail_id>:<revision>`；author／Mail ID／來源 session 由程式填；一般 agent 不可自報 author retain |
| operator，僅內網 | 建 bank、設定 `mcp_enabled_tools`、migration | 外部 token 不可取得此權限；delete／clear 不提供成員 |

Hindsight bank 的 `mcp_enabled_tools` 同步關閉 delete／clear／update_bank；proxy 再檢查一次，不能只隱藏 tools/list。allowlist 取 F-05 實測工具子集，`reflect` 暫不給助理，避免隱藏 LLM 呼叫；SRS SR-KEEP-04 列的是 bank 最大允許集合，若要求每人都能 retain／reflect 則與 SR-AST-01 唯讀相衝突，需 PM 對齊角色子集。**SRS §4.2 索引補寫（GAP-16）**由唯一 bridge 執行，不讓 agent 雙寫：原文保存→耐久事件→同交易寫 ingest outbox／cursor→retain→記 indexed。失敗留 pending/error 與最後嘗試時間，可按 Mail ID 重跑；結果未知先查相同 document ID，替換／去重語意要在 1.2.1 做黑箱驗證，不能盲宣稱 exactly-once。回覆引用 **Mail 訊息 ID＋其伺服器時間／GitHub Issue URL**，Hindsight memory ID 只當檢索線索；附索引最新同步時間，不以萃取句取代原文。

SR-ID-08 的作者歸屬：proxy 依已驗證服務 token 強填 `recorded_by`（bridge principal）；`source_author`／來源 session 從指定 Mail ID 的正式紀錄及 registry 取得，展示原交接作者時引用後者。一般 agent 不可送 retain；忽略外來 `metadata.author`，不能讓 LLM 或 bridge 請求本文自稱另一個人就改作者。

### API-05｜Discord、撤銷與確定性指令（L；M 撤銷用 operator 腳本）

- `/connect`：檢查 guild＋Discord user 成員表，3 秒內 ephemeral defer，再依工具發「一段設定＋短說明」，不在公開頻道／URL query 放 token；不執行遠端下載腳本。**每裝置一份 token（維護者 已定）**，該裝置不同工具沿用，不另發工具 token；新增另一裝置不影響其他裝置 token。同裝置原值遺失需明確輪替（撤銷舊 token ID，再核發新值），不提供原值重看；回覆列裝置標籤／token ID。M operator 分別給 Mac／Windows token，L 先套 registry／Caddy、validate／reload 成功才回憑證，不由 LLM 選組或發 token。
- `/revoke token_id`：只本人／operator 能撤；`active→revocation_pending→revoked`。先使 bank-proxy 拒絕，再套 Caddy allowlist／reload；成功後以舊 token、原 MCP session 做 401 probe 才回成功。Caddy 失敗時留 pending、報部分失敗並找 operator，不能回滾成重新開放。備份還原仍套最新 denylist；不承諾取消進行中的請求／SSE。
- `TokenApplier` 接縫（GAP-14）：bot 沒有 Docker socket／Caddy admin 權限；只寫本機受限 spool 的 `issue/revoke(request_id,group_id,token_id,credential_ref,expected_revision)`，等 host helper 回 `{request_id,config_revision,status,error?}`。helper 取單一 writer lock、檢查版本、由固定 group 映射生成設定，validate→原子 rename→固定 `docker compose exec caddy caddy reload ...`；不接受任意命令／路徑／Caddyfile。並行發／撤 token 依序處理，舊 revision 衝突重新讀 registry，不能整份舊清單蓋掉新撤銷；request ID 去重。validate 失敗不替換；reload 失敗保留上一個運行版本／收據，撤銷留 pending 並停止再發新 token，operator 依 denylist 重建與重試，不能默默「回復」被撤銷 token。M 手動、L 受管程序；spool／Caddy 私密目錄 0700、檔案 0600 或等效 ACL，收據不含 token，admin 仍不 publish。
- `/status`（維護者 已定，GAP-17）：**slash 指令、ephemeral**，只給本組唯讀 context；L 從 Hindsight recall 取現況，回覆有 Mail ID／時間與 Issue URL、草稿標籤。一般頻道打「現在做到哪」只提示改用 `/status`，不在公頻回專案摘要。公開分享要使用者明確選擇，不能由 js-llmcord 原本公開串回覆直接實作。
- `/issue`：結構化標題／內容／repo；取消 modal 不呼叫 GitHub；標題空回驗證錯誤。服務端 repo allowlist／GitHub App 或最小權限 token，由程式建 Issue，記 interaction ID／URL 後才通知；網路超時結果不明先以 interaction marker 查核，不盲建第二張。Projects 加入失敗顯示「Issue 已建立，看板待補」，PRD 半筆任務語意待 T5 對齊。
- 決策按鈕：引用持久 draft ID／version，確認 Discord actor＋狀態、單一交易 compare-and-set；重複按回已處理、陌生人拒絕、bot 重啟仍查 DB。交易先留待發布結果／outbox，將確認者／時間／draft ID 寫 Mail 原串、成功才發布 confirmed／回覆成功，再更新 Discord／Hindsight；Mail 失敗保持待發布，不能只憑 Discord 或 SQLite 宣稱正式確認。LLM 不能按鈕代確認。
- 通知：保存成功後才送，使用 outbox 防 crash 漏記。**依 SR-NTF-04：Q-06 未決前，Discord 送出失敗記 failed，不自動補發**；429 也記原因與 Retry-After，補發政策核准後才啟退避重試。Discord 與 DB 無共同交易，送出結果未知保留 unknown，人工／核准政策核對，不能承諾 exactly-once 或悄悄重發；DM 失敗不自動把內容轉公開。

token 撤銷單位依 維護者 定案為**每裝置**：撤 Windows token 會拒絕該裝置共用它的工具，Mac token 仍可收發。這覆蓋 Brief 的「每人」及舊 SRS 的「每裝置每工具」措辭，不再是選擇未決；同裝置輪替是明確的 revoke→issue，不因別台裝置 connect 而隱式撤銷。

### API-06｜問答、確認與 session 生命週期（M；grant 擴充 L）

**GAP-06 的計時由 VPS `ops/lifecycle` 負責，不靠 B 開著**。它是受管 host 排程（工程目標每 15 秒處理一次，單 writer lock），以專用服務 agent `HubClock` 的 MCP inbox events 消費 typed 控制紀錄；受控 client 對 question／action 根訊息及其 `presented/answer/choice/session.closed` 事件 CC HubClock。控制 envelope 為 `v,root_mail_id,recipient_session,event_type,choice?`，不把控制事件當待執行工作或交接。外層 Mail 決定 actor／時間；S1 互信，S2 必須經 SAD 的 principal adapter，不以 body 假冒 owner。

| 事件／判斷 | 固定行為與持久結果 |
|---|---|
| question 保存 | `deadline=根訊息 created_ts+24 h`；Ack／已讀不算回答。滿 24 h 尚無收件者的 answer 事件，寫「未回答」至同串並寄發問者；原問題仍可讀，不刪除、不代答。晚到答案另留原串，不抹掉曾逾時的紀錄（SRS §4.4） |
| B 顯示 action 確認 | B 先在本機顯示 requester／ID／內容／影響範圍，再回報 `presented`；server 保存此事件的 `created_ts` 作 t0，`deadline=t0+30 min`。離線期間沒有 presented、不開始 30 分鐘；這遵守 SR-CFM-02，**不採 GAP-06 表內「寄件時間＋30 分」的建議** |
| 同意／拒絕／到期競態 | host 先消化目前已保存的 choice／session.closed 事件再判 deadline；以 Mail 伺服器接受時間與 `version` compare-and-set，`t<deadline` 的首次有效 choice 才能採用，`t>=deadline` 為逾時。只一個 terminal 結果，重複操作回已處理；本機按下但尚未被 server 接受不算成功 |
| session.closed（維護者 已定） | end hook 上報後把該 session 的 pending 改「已失效」，同串通知寄件者「session 已結束，請重送」，不能恢復舊確認。即使還不到 30 分鐘也失效；不是把它改成同意 |
| 結果發布／執行 | ops DB 交易先記候選結果與 outbox，用固定 idempotency key 寫 Mail 原串；拿到結果 Mail ID 才標發布。B 動手前必須取得綁自己 session／root ID 的已發布同意結果，逾時、未發布或紀錄不明均不執行；執行後成功／失敗另寫 Mail |
| crash／離線 | host ops 重啟從 cursor／DB 補處理逾期，保留原 deadline；B 當機或 end 上報失敗時，舊 session 不能取得新執行許可，下次 start 補 session.closed，最晚由 30 分鐘 backstop 拒絕。**網路中斷時不能保證立即通知失效**，須保留待送／告警，不以推測在線狀態宣稱已正常結束 |

排程只寫狀態／通知，不回答 question、不執行任何 action，沒有外部 LLM。M 通知走 Mail，L 成功保存後再按 Discord 政策通知。排程漏跑可造成遲送通知，查詢時仍即時計算「期限已過」，不能因排程未跑而允許過期執行；排程延遲列監控。ops DB／cursor 與 Mail 一同備份，還原先對照歷史結果再重建，不能重開已處理請求。

## 用戶端、UI 與模組契約

### CLI-01｜Mac／Windows Claude Code 接入（M）

兩端專案 `.mcp.json` 使用相同範本；token 由啟動程序的環境／本機秘密儲存提供，不能提交實值。`HUB_MAIL_URL=https://hub.example.invalid/mcp/`；Mac／Windows 分別載入不同 `HUB_TOKEN`（裝置入口 token），同裝置工具共用，**不是 sender registration token**。

```json
{"mcpServers":{"hub":{"type":"http","url":"${HUB_MAIL_URL}","headers":{"Authorization":"Bearer ${HUB_TOKEN}"}}}}
```

Mac zsh 在該專案環境設 `export HUB_MAIL_URL='https://hub.example.invalid/mcp/'`；Windows PowerShell 設 `$env:HUB_MAIL_URL='https://hub.example.invalid/mcp/'`；各自以本機安全方式提供 `HUB_TOKEN` 後執行 `claude`，在 `/mcp` 確認並通過使用者原有的專案信任／MCP 核准。CLI 替代範例為 `claude mcp add --transport http --scope local hub https://hub.example.invalid/mcp/ --header "Authorization: Bearer <TOKEN>"`；這會改本機設定且實值可能進 shell history，提供模板較好，本次**沒有執行**。重開 terminal／IDE 必須確認仍能取到環境變數。[Claude MCP 設定](https://code.claude.com/docs/en/mcp)（查詢 2026-11-16）。

L 再加 `hindsight` HTTP server 指 `https://hub.example.invalid/memory/mcp/group-a/`。收發註冊設定用 repo 的非秘密 `hub-client.json`：`group_id`／server `project_key`／canonical agent／peer names；本地 repo path 是另欄，不用它當 Mail project key。Mac／Windows 分別安裝本機 Node runtime 才能執行下述相同 `.mjs` 膠水；版本在實作票鎖定，不在全域偷偷安裝。

### CLI-02｜A-4：開工與在線 ≤60 秒的設計（M，待兩機實測）

一般 `SessionStart` 只在啟動觸發，一般 async hook 只在下一回合交付；**它們單獨不能保證 idle 收信**。採官方 command hook 的 `asyncRewake:true`：背景 watcher 有新事件時 exit 2，把事件 ID 交回原 Claude session，然後 agent 讀原文；不啟新 AI、不鍵盤注入、不改權限模式。本機只確認 Claude Code **2.1.325** 已安裝，hook 行為尚未實跑；Windows 版本／shell／Orca 中的 Claude 是否載入同一 project hook 都要驗。[官方 hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)（查詢 2026-11-16）。

專案 `.claude/settings.json` 範本（`start`／`watch`／`stop`／`end` 是待寫的同一腳本模式）：

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

| 模式 | 輸入→輸出／狀態 |
|---|---|
| `start` | hook stdin 的 session／cwd，連 Hub、補報舊 session 關閉／恢復待送、以 `mark_read=false` 取離線原文；stdout 回 `hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"交接 #ID…"}`。M 先列未讀與最近 N 則交接，再處理「開始」；空 inbox 與服務不可達分開。N 是配置正整數，工程測試暫用 3、產品數值仍待指定；**11-30 L 現況改由 Hindsight recall**，附正式決策／Issue 引用與原文來源 |
| `watch` | 每 session 原子鎖，已有 watcher 則 exit 0；等 start 完成，**每 15 秒**讀耐久 events（timeout 10 秒），新事件先寫 staging 再 stderr 印固定格式 ID、exit 2 喚醒。沒有消息時不叫 LLM；55 分鐘到期送「重啟 watcher」提醒後 exit 2，低頻維護醒來由 Stop 重新 arm，不能安靜退出後永久不輪詢 |
| `stop` | 若有新事件，繼續取原文並分類；若工作變更但 checkpoint 缺失，最多 block 一次請當前 agent 整理交接，再正常停。檢查 `stop_hook_active`／工作 revision 避免無限 block；watch 重覆觸發只保留一個，不輪詢外部 Orca inbox |
| `end` | 先封閉本機 pending、上報 session.closed 讓 Hub 標失效，再停止 watcher／flush 已備交接，不臨時叫新 LLM；5 秒預算內未送出留 journal。SessionEnd 的輸出不當可見提示，下次 start 顯示失敗；舊 session 不可再執行同意結果 |

**GAP-01 已定讀取策略**：M 的 send adapter 設 `topic:"handoff"`，`start` 用原生 `fetch_topic(project_key,topic_name:"handoff",limit:N,include_bodies:true)`，以 `(created_ts,id)` 降冪呈現最近 N 筆，附 Mail ID／作者／時間；原生 schema 及 SQL 排序已在固定 SHA `messaging.rs`／`queries.rs` 核對，未做新黑箱測試。**L 的現況改讀 Hindsight recall**，經 API-04 對應 Mail 原文／決策狀態，索引落後／服務失聯明示，不默默把 M 摘要當最新完整現況。個人未讀原文仍由 API-03 獨立處理，不因 L 換記憶來源而漏交接；這個策略已定，只剩 N 數值待指定。

15 秒 poll＋10 秒請求預算給排程留餘裕，**不是 ≤60 秒的證明**。NFR-01 實測每方向 n≥5：A 以 monotonic clock 記 send 開始，B agent 真讀原文 ID 後回 receipt，A 記 receipt 返回；該 round-trip 是可保守驗 ≤60 秒的上界，不拿兩端未校時的 UTC 直接相減。另留 Mail created_ts、watcher 偵測、B context 首見 ID 的 log，涵蓋 idle／回答中／長工具／權限提示／斷網與睡眠恢復，逐筆列耗時與版本。背景 fetch 成功而模型沒看到仍失敗。若任一健康在線案例 >60 秒或不支援 asyncRewake，**A-4 未通過，依 Brief 降級成下一次對話收信**；只在 UserPromptSubmit／PostToolUse 拉信，把降級／風險提交 PM／維護者 記錄，不能算完整 NFR-01 通過或在 fallback 啟新 AI 代收。

### CLI-03｜A-5：每段 checkpoint＋結束交接（M 最小路徑；FR-12 完整驗收 L）

每個有實質工作變更的回合，agent 先準備 `summary/text/unfinished/links/source_session/revision`，`stop` 驗證後經原生 send 保存，取得 Mail ID 再標 delivered；同 revision 不重送，下一段用新 event ID。正常結束 `end` flush 最後 checkpoint（5 秒預算），不把整個 transcript 上傳；角色／作者標「agent 自動交接」。準備階段就要顯示發送成功／未寫入，不能等結束 hook 再保證螢幕可見。

kill -9／斷電不保證 SessionEnd，下一次 `start` 發現 open-session marker 或待送，顯示「上次 session 未正常交接／上次已保存 #ID」，只補送已有 checkpoint，**不編造遺失工作的摘要**。這承接 Brief A-5 的「每完成一段就寫入，結束前提醒」備案；AC-04.1 對所有正常結束的完整性須實測，強退補寫政策 Q-04 待 T5 對齊。

### CLI-04｜確認、auto mode 與其他工具（M 預設確認；L 完整狀態）

**GAP-08 介面**：B 在 Claude 的結構化確認問答（可用 AskUserQuestion 的版本）顯示「#request ID、來源 agent／裝置、原內容、將改什麼」，選同意一次／拒絕；缺此工具時 agent 在對話中顯示同卡，等待收件人的明確「同意 #ID」或拒絕，不能把一般聊天、已讀或無來源的原生權限提示當同意。人類選擇走 API-06 的 choice／持久結果後才動手；原工具的權限提示仍照常，不自動核准。M 不提供 Discord action 同意按鈕（SR-CFM-07 未決），決策確認按鈕是另一功能。

**GAP-04 在線**：不額外每 15 秒寄 Mail heartbeat。watch 的成功 fetch 會更新原生 agent `last_active_ts`，工程暫定 45 秒內只標「近期有活動」，超過顯示「連線狀態未知／最後活動時間」；bridge 讀取也可能刷新它，因此**不是人在該端在線的證據**。正常 session.closed 才有明確關閉事件。寄件成功一律顯示「已保存 #ID」，只有明確證據才加 session 已關閉標記；與 FR-05 固定「已保存，對方離線」文案待 PM 對齊，不把沒 fetch 當確知關機。離線／未知都不代答或代跑。

**GAP-09／10／11，auto mode 已定在 L（11-30）**：grant 存 server glue DB 並寫 Mail 稽核，鍵為 recipient device／agent＋指定 source agent／principal；server UTC 計 `expires_at`，未填時長 60 分、合法 1～240 整數分鐘。每次動手前重新查 server：owner／來源吻合、未撤銷、`now<expires_at`，server 不可達即確認／拒絕，不靠 client 時鐘。重啟不重設期限，start 重新載入尚有效 grant；已失效的舊 pending 不能復活。到期、提前關閉與每次執行都寫 Mail，L 再通知 Discord。auto mode 本身、發／撤 token 永遠不能由遠端 action 自動改，須 owner 本機操作。**待對齊 SR-AUTO-03 的時間邊界**：本設計同時要求到達時與執行前仍有效，較「只看到達時間」保守；已在執行的動作允許完成，不中途回滾，這不重開 auto mode 的批次決策。

**限制**：prompt 的 question/action 標籤不是可靠授權邊界；惡意外來文字可能誘導 agent。必須保留原工具原生核准，測「混合問題＋修檔要求」與跨人設定 grant 的負面案例；若 client 無法可靠綁定人類確認，停用該端自動執行／不宣稱完整 US-07。不得為趕 MVP 關閉 agent 審批或變更全域權限。

| 工具 | 接入差異／來源 | hook／喚醒承諾 |
|---|---|---|
| Codex CLI | F-02：TOML `[mcp_servers.hub]`，`url`＋`bearer_token_env_var="HUB_TOKEN"` | 不套 Claude hooks；自身 lifecycle 待驗，S2 前只承諾設定可讀，不宣稱 ≤60 秒 |
| Cursor | F-02：專案 `.cursor/mcp.json` 的 `mcpServers.hub.url/headers` | 不假設 Claude Stop／SessionStart 生效 |
| Antigravity | F-02：`agy mcp add --header ... <name> <URL>`／`mcp_config.json` 的 `serverUrl` | 模型與全域設定保持原狀；喚醒／交接待各端驗證 |
| VS Code Claude Code 擴充 | F-08：與 CLI 共用 `.mcp.json`／使用者 MCP 設定，Mac `~/.claude.json`、Windows `%USERPROFILE%\\.claude.json`；同 CLI-01 範本 | 擴充內附 CLI 版本可與終端不同；設定共用不證明 hook／asyncRewake 通過，兩端分別驗 |
| VS Code Codex 擴充 | F-08：與 CLI 共用 `~/.codex/config.toml`／Windows `%USERPROFILE%\\.codex\\config.toml`，同 `bearer_token_env_var` | VS Code process 要繼承 HUB_TOKEN；重開 extension host 後驗收發，不假設終端 export 已傳入 |
| Antigravity／原生 VS Code | F-08：獨立 AGY IDE 用自身 MCP 設定；使用者所稱「AGY 擴充」的實際名稱待確認。VS Code 原生是 `.vscode/mcp.json` 頂層 `servers`，**不是 `mcpServers`** | 不把原生／Copilot 設定當 AGY 擴充證據；F-02 `serverUrl` 與 F-08 `url` 的 AGY 差異待實際版本驗證，不發兩種猜測配置 |

以上依 [F-02](research/F-02-github-discord.md)＋[F-08](research/F-08-hostinger-vscode.md)，Claude 共用 MCP 設定另核對 [官方 VS Code 文件](https://code.claude.com/docs/en/vs-code#connect-to-external-tools-with-mcp)（查詢 2026-11-16）。文件支援不是本次五分鐘／喚醒實測；MVP 只驗 Mac／Windows Claude Code，L `/connect` 支援表要附實際版本、設定位置與首封收發證據。

### MOD-01｜可替換 LLM 與費用（L）

**D-4 已定**：專案助理與 Hindsight retain 都用 **Anthropic Claude Haiku 5.5，API model ID `claude-haiku-5-5`**；[官方 model ID](https://platform.claude.com/docs/en/models/overview)已核對（查詢 2026-11-16），不是猜測 display name。**每日共用總額 0.50 USD**，涵蓋助理及記憶 extraction／consolidation／背景驗證；不是兩角色各 0.50。日界 Asia/Taipei 00:00，金額轉整數 **500,000 micro-USD** 放同一 global ledger。

以下為專案設定契約，renderer 轉成各上游配置；key_ref 只指向 operator 佈署的秘密，不含真 key。兩槽獨立可換 provider／model／base URL，預設值已定；Gemini API、gpt-oss API 僅保留替換支援，不自動 fallback，也不重問 維護者 選型：

```yaml
llm:
  assistant:
    provider: anthropic
    model: claude-haiku-5-5
    base_url: https://api.anthropic.com
    key_ref: anthropic_api_key
  memory:
    provider: anthropic
    model: claude-haiku-5-5
    base_url: https://api.anthropic.com
    key_ref: anthropic_api_key
budget:
  scope: global
  daily_cap_usd: "0.50"
  time_zone: Asia/Taipei
```

兩槽另有 `max_input_tokens,max_output_tokens,price_usd` 配置；價格表依部署當天官方費率／長 context／cache 類型完整預留，不把 F-07 的月費試算當保證。API key／計費帳戶佈署與繁中萃取實測屬實作前置，不是 D-4 未決。缺秘密或價格表時回設定未就緒，不能叫另一家模型補上。

Hindsight 生成 `HINDSIGHT_API_LLM_PROVIDER=anthropic`、`HINDSIGHT_API_LLM_MODEL=claude-haiku-5-5`、`HINDSIGHT_API_LLM_BASE_URL=https://api.anthropic.com`，`HINDSIGHT_API_LLM_API_KEY` 由秘密載入；預留的 Gemini→`gemini`、gpt-oss→實際供應商 `groq`／OpenAI-compatible `openai` 映射只在明確換配置時使用。js-llmcord 沿用 `providers`／`models`／`remote_mcp.headers` renderer；Anthropic native provider adapter／鎖定 SDK 與 Haiku 的相容性必須 smoke 驗，若上游只有 OpenAI-compatible 接縫就補薄 Anthropic adapter，不偷偷改經第三方轉送。原生 Anthropic API 不當 OpenAI-compatible 端點混用。[Hindsight 固定 SHA 設定](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/configuration.mdx)、[js-llmcord 固定 SHA 範本](https://github.com/stanley2058/js-llmcord/blob/c5615eb3705aaf5ca369b5c817653834b9c8ac4c/config-example.yaml)（查詢 2026-11-16）。

`budget.reserve(request_id,role,max_cost)` 必須在**同一 global 日帳本**原子檢查 `spent+reserved+max_cost <= 500000 micro-USD`，涵蓋助理及 Hindsight extraction／consolidation／啟動驗證等每個付費呼叫；role 不能分出第二份 0.50 USD。只讀 metrics 是事後量測，不能當硬上限。實作以薄 provider adapter（Hindsight 現成 custom-provider 接點）在呼叫前預留，重用上游 provider、不改 retain 引擎；費用未知不重試到另一家。超額時助理回「今日查詢額度已用完，明日恢復」並通知 維護者，記憶工作留 pending，Mail／交接繼續。背景呼叫覆蓋與 provider 硬上限能力需實證，選型已定不代表 cap 實作已通過。

### MOD-02｜測試注入與失敗回饋（M／L）

- 接縫：`MailClient`、`MemoryClient`、`DiscordClient`、`IssueClient`、`ProviderClient`、`Clock(utcNow,monotonicNow)`、`TokenStore`、`Journal/GlueStore(path)` 注入；測試用 temp SQLite／獨立 compose volumes 與合成組別，不讀真個人 token、不向真人發通知。
- HTTP client 可注入 timeout／429／401／結果未知；FakeClock 驗 30 分鐘、1 h／4 h 到期與跨日額度，不真的等待。SQL 全參數化、DB 開啟 foreign keys／交易與忙碌 timeout；程序結束 flush journal、關 MCP／DB／watcher。
- Discord／Markdown 顯示 escape mentions，除預定收件人不允許外來文字 `@everyone`；確認 callback 驗 actor／draft ID／version。LLM 回覆無引用或要求寫入時，回資料不足／改用確定性指令；不執行輸出中的 shell 字串。
- 必要驗證落點：M＝TLS／全路徑 401／同 session 撤銷／跨組附件拒絕／原文重啟與還原／重試不重複／兩機 idle ≤60 秒／正常與強退交接；L＝跨 bank／未知工具／唯讀／假 actor／決策競態／通知 crash／額度背景呼叫。正式 TC 由 T8 對齊，不在本文件虛報通過。

## 追溯、變更與未決

### SRS §4.2 的七個實作接縫

| 實作項 | 本版回應 |
|---|---|
| SR-MSG-01 類型／性質存放 | API-02 的 `body_md` JSON envelope；`kind` 四選一、`intent` 缺失當 action，原生 topic 只供分類，不改 Mail schema |
| SR-MSG-05 冪等 | 原生 send_message 的 idempotency_key，固定 SHA 已有；client 只管理 key／journal，不另造去重核心；24 h 超窗與不同 payload 衝突見 API-02 |
| SR-MSG-04 秘密偵測 | L server ingress 權威＋client 預檢；規則版本化、最少類別已列；閾值／誤判待 維護者，拒收不記原文 |
| SR-MSG-10／FR-12 hooks | CLI-02 SessionStart＋asyncRewake／Stop；CLI-03 checkpoint＋SessionEnd flush；M 最小交接與 L 完整自動交接驗收分列 |
| SR-ID-07 組內冒名 | SAD GAP-13 的 S2 principal→agent ingress adapter Gate；M 明示組內互信，不把 sender_token 假稱 Discord 人證明 |
| SR-KEEP-03 索引補寫 | API-04 單一 bridge＋耐久 outbox／document ID；失敗不回退原文，重跑狀態可查 |
| agent 名稱／裝置顯示 | 以 register 回傳 canonical name 為 key；M BlueLake／RedStone，registry 顯示 `維護者 / Mac / Claude Code` 與 `維護者 / Windows / Claude Code`；peer 用 canonical name，不能拿顯示標籤當收件人 |

### FR／NFR 落點

| SRS 需求 | 設計落點／批次 | 尚未覆蓋或待對齊 |
|---|---|---|
| FR-01、FR-02、FR-04、FR-08 | API-01／02；M | 原文／roster／冪等設計；所有入口內容／附件強制驗證與 24 h 去重窗缺口明列 |
| FR-03、FR-07 | API-02／GAP-21；L／待決 | 秘密規則待審，撤回沒原生工具且未核准，不列 MVP 通過 |
| FR-05、FR-06、FR-14、FR-15 | CLI-04＋API-06；M | 離線只保存、question 自答、模糊 action；在線文案 GAP-04 待對齊 |
| FR-09、FR-10、FR-11、FR-13 | API-03／04、CLI-02；M／L | 先 peek、再已讀、原文 ID；M 最近 N 交接／L 改讀 Hindsight 已定，只有 N 數值待指定 |
| FR-12 | CLI-03；L（M 先做 checkpoint） | 正常 exit／強退／斷網實測；Q-04 補寫政策未全定 |
| FR-16、FR-17、FR-18 | API-06、CLI-04；M | 24 h 未回答已定；30 min 從 presented；session closed 失效，無成功持久結果不動手 |
| FR-19 | CLI-04／grant ledger；L | restart／UTC／來源限制；到達與執行時雙檢查待對齊 SR-AUTO-03 |
| FR-20、FR-21、FR-22、FR-29 | API-04／05、MOD-01；L | `/status` ephemeral／Haiku 5.5／每日共用 0.50 USD 已定；兩端關機可查與 provider adapter／硬上限待實測 |
| FR-23、FR-24、FR-25 | API-04／05；L | 通知失敗暫不補發；Issue 已建但 Projects 未加的半成功語意、二次確認待 T5／維護者；決策結果正式存 Mail |
| FR-26、FR-27、FR-28、FR-30 | API-01／05、CLI-01／04、SAD 隔離；M／L／S2+ | 每裝置 token／五工具模板；跨人冒名／跨組隔離／真實 Windows 是 Gate，不由文件算通過 |
| NFR-01、NFR-02、NFR-03 | CLI-02、API-02／03／05；M | 雙向 n≥5 60 秒／重啟逐字／同 session 撤銷；全部待實測 |
| NFR-04、NFR-09 | API-01／04、SAD；M／S2+ | internal network 無 host port 等效隔離需改 SRS loopback 字面；Linux 附件負面測試 |
| NFR-05、NFR-06 | SAD 資源／維運；L | 4,992 MiB 是保守預算而非 2.3 GB peak 或 SLA；24 h 服務需實機觀察 |
| NFR-07、NFR-08 | MOD-01／02＋錯誤契約；L／M | 額度不可僅靠 metrics；結果未知不可斷言未保存，TC 要含負面與邊界 |
| NFR-10 | API-05＋CLI-04；S2 | 實人從 connect 到首封收發計時 ≤5 分鐘，文件不能代替測試 |

### GAP-01～22 逐項回應

| 缺口 | 設計／狀態 | 實作或 Gate 驗證 |
|---|---|---|
| GAP-01 | **維護者 已定** M 最近 N 交接、L 改讀 Hindsight；CLI-02，測試 N=3，僅 N 的產品數值待指定 | 無交接／超過 N／原文太長／Hub 不通不能混淆，L 保留原文查核 |
| GAP-02 | CLI-02／03：SessionStart 讀；Stop 每段 checkpoint；SessionEnd flush，完整 FR-12 在 L | 新 session 只打開始；正常 exit／clear／resume／強退／斷網 |
| GAP-03 | API-03／CLI-02 明確 mark_read=false，先 staging／context 顯示，收件 agent 取得後才 mark_message_read | peek 後立刻 crash 再開仍可取；標已讀不是同意 |
| GAP-04 | CLI-04 近期活動僅診斷，不把 last_active／idle 說成人在線；固定文案待 PM 對齊 | B 關機／橋接輪詢／睡眠時不誤報在線或代答 |
| GAP-05 | asyncRewake＋15 s poll；CLI-02 雙向 n≥5、ID receipt 上界測法 | 未證明 60 s 即 A-4 降級「下次對話收到」，不計完整 NFR-01 通過 |
| GAP-06 | API-06 VPS 受管計時，不靠 B；SRS 的 presented 時間＋30 min 優先於圖表寄件時計時建議 | 離線不計時；29:59／30:00／30:01、B 結束、A/B 都關閉 |
| GAP-07 | 維護者 已定 question 24 h 未答標未回答、原文保留、通知發問者 | 已讀未答／恰 24 h／及時答覆事件還沒被 scheduler 消費 |
| GAP-08 | CLI-04 本機具來源與範圍的結構化問答／明確回覆＋API-06 結果 | 不把普通權限提示或寄件者自稱同意當核准；M 無 Discord action 同意 |
| GAP-09 | L server grant ledger＋Mail 稽核，不只放 B 本機 | Discord／B 重啟能取回同一 grant ID／狀態 |
| GAP-10 | L server UTC expires_at；每次執行前查；重啟不延長，離線不自動執行 | 到期前／等於／之後、重啟與 server 不可達；SR-AUTO-03 雙檢查待對齊 |
| GAP-11 | L 禁遠端 action 修改 auto mode／token；owner 本機操作，不吃 sender body 自報身分 | 開 grant／延長／換來源／撤 token 的遠端混合請求皆不能自動做 |
| GAP-12 | **維護者 已定每裝置一份 token**；不同工具共用，agent registration token 分開；明確輪替時撤舊再發新 | 撤 Windows 的所有共用工具皆 401、Mac 仍收發；原 session／輪替交叉測 |
| GAP-13 | SAD S1 互信限制＋S2 principal→agent ingress adapter 前置 Gate | A token 不可 register／send 成 B 或更改 B grant；未過不開跨人 auto |
| GAP-14 | API-05 TokenApplier 單 writer／revision／原子替換／validate／reload／pending | 並行發撤、validate／reload 失敗、重啟恢復不復活 denylist |
| GAP-15 | CLI-04＋F-08：按工具給 JSON／TOML；Claude／Codex 擴充共用 CLI 設定 | 實際 GUI process 的環境與設定繼承；AGY 產品身分／url 差異待驗 |
| GAP-16 | SAD／API-04 唯一 bridge 從已保存 Mail 寫 Hindsight；不要求 agent 雙寫 | 停 HS／補寫／重啟／同 document ID 結果未知；原文與 pending 狀態不丟 |
| GAP-17 | **維護者 已定 Discord `/status` slash＋ephemeral**；普通頻道問句只導引 slash | 非成員拒絕、公開必須明確選，不抄 js-llmcord 公開預設 |
| GAP-18 | **維護者 已定** 兩槽 Haiku 5.5、每日共用 0.50 USD；MOD-01 保留 provider 替換與預留費用 | 併發共用 cap、背景 consolidation、provider 超時／跨日／無價格表；metrics 不當硬上限 |
| GAP-19 | API-04／05 明定 Mail ID＋server timestamp、Issue URL；HS memory ID 僅輔助 | 手機回覆 ID 可反查逐字原文，草稿／正式分列 |
| GAP-20 | **維護者 已定 auto mode 在 11-30 上線批**，M 一律本機確認 | MVP 測試不把未做 auto mode 算缺陷或偷偷啟用全域 auto |
| GAP-21 | 已核對 F-01b 固定 SHA 45 tools，**未見 withdraw/retract 訊息工具**；不能把 retire_agent 當撤信 | FR-07 未核准，不做原生刪除；若 維護者 採用，另加同串撤回控制事件＋失效判定，不覆蓋原文 |
| GAP-22 | API-02 原生 idempotency_key；同 key 同 payload 回同 ID，不同 payload 衝突；預設 24 h | timeout／重啟／同鍵衝突／超過 24 h；schema 已核對但新黑箱尚未跑 |

### 仍需 維護者 決定／提供（不含已定六項）

| 尚未定案或缺資料 | 目前安全預設／責任 |
|---|---|
| 最近 N 的具體數字、離線備份目的地／存取安排 | 工程測試 N=3；每日留 7 天與保存截止已定，不重問政策 |
| 撤回功能是否納入、Discord 是否可同意 action | 依 SRS 未決前不做；M 只在收件端確認，決策按鈕另計 |
| 秘密偵測閾值／誤判解除、異常中斷交接補寫政策 | 預檢／原文 checkpoint 與錯誤可見；未驗證前不宣稱全入口安全或完整補寫 |
| 通知補發／摘要範圍、建 Issue 是否二次確認、決策草稿期限 | 沿 SRS：失敗先記錄不補發、二次確認未核准前不驗、草稿不自動過期；不可把這些當已確認永久政策 |
| S2 成員名單來源／資料刪除告知、AGY 實際產品名稱 | S1 名單只有 維護者；F-08 共用設定不代替產品身分／人測證據 |

上述由 PM 彙整給 維護者；API key、VPS IP、DNS A 生效、SDK／容器版本與硬上限測試屬 operator／工程前置。所有入口 validation、在線文案、loopback 字面與 SR-AUTO-03 時間邊界由 PM 先對齊需求，若改變產品承諾再交 維護者；**網域、token 粒度、`/status`、auto 批次、現況來源、Haiku／每日 0.50 USD 不再待決**。

契約變更同步 T5／T6／T8；本版納入 SRS §4.4 與最新 維護者 定案，不反寫上游。無既有產品資料需遷移；ops／glue schema 用版本化 migration，Mail／Hindsight 先備份、鎖 digest，不混任意 latest。可開 M 部署／MCP smoke／hook spike／lifecycle／備份票；以上工程缺口按對應 Gate 收斂，不能以設計草稿代替驗收。
