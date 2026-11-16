# 08 資料層（Supabase 規格）— T15

- 版本 0.1｜2026-11-17｜作者：swe-Tom｜審查：PM-Emily
- 範圍：我們**自有**的資料（組、成員、裝置 token、HubClock 計時、Discord 綁定、稽核）。**上線批次 2026-11-30 起生效**；MVP（11-23）照舊用檔案（Caddy allowlist、HubClock 狀態檔）。
- 不在範圍：Mail 的 SQLite／archive、Hindsight 的表（不改原生 schema，SDS）；SDS 的 decisions／grants／bridge／budget 表（見 §10「待對齊」）。
- 產出：`supabase/config.toml`（`supabase init`，CLI 2.109.1 實際產生，只改 `project_id`）、`supabase/migrations/*.sql`、`supabase/seed.sql`、`supabase/tests/rls_test.sql`。

## 1. 原則

照 Supabase 慣例寫，現在跑在純 Postgres 上，日後原封不動搬。

| 慣例 | 怎麼做 | 來源（查詢 2026-11-17） |
|---|---|---|
| migration 檔名／位置 | `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`，依時間序執行；seed 在 `supabase/seed.sql` | [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations) |
| 三個 role | `anon`、`authenticated`（經 RLS 限制）、`service_role`（BYPASSRLS，只能放伺服器端） | [Postgres roles](https://supabase.com/docs/guides/database/postgres/roles)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) |
| RLS | 每表開 RLS；「開 RLS 後 publishable key 在建 policy 前讀不到資料」；「加 policy 不會收回 grant」→ 另外 revoke | 同上 RLS 頁 |
| 新表預設權限 | 舊雲端專案 public 新表對三 role 全授權；新 CLI 註明新表**不再自動公開**（`auto_expose_new_tables`）。我們一律明寫 revoke／grant，三種預設結果一致 | RLS 頁；`config.toml` 內 CLI 註解 |
| function | `set search_path = ''`、revoke execute from anon/authenticated | Supabase database advisor 慣例 |

**存取模型**：成員不直接連 DB、不用 Supabase Auth。所有讀寫都由伺服器元件（bot、bank-proxy、ops）以 `service_role` 進行；`anon`／`authenticated` 沒有任何表權限、也沒有 policy（兩層拒絕）。不用 `auth.uid()`，所以純 Postgres 也能跑。

## 2. 表

| 表 | 用途 | 重點欄位／不變量 |
|---|---|---|
| `groups` | 一組一 Mail 容器／bank | `id`=`group-a`、`project_key`=`/data/projects/group-a`、`mail_hostname`、`bank_id` |
| `members` | 人（S1 只有 維護者） | `role` owner／member；`status` active／removed，`removed_at` 必須一致 |
| `devices` | **每裝置一把入口 token** | 只存 `token_hash`（SHA-256 hex）＋`token_prefix`＋`token_id`；`status` active→revocation_pending→revoked；`revoked_at` 與 status 一致。觸發器：**revoked 不可復活、pending 不可退回 active、hash 不可改**（輪替＝撤舊＋新增一列） |
| `caddy_allowlist_export`（view） | render-caddy 的唯一輸入 | 只列 `status='active'` 且成員 active；`security_invoker=true` |
| `discord_links` | `/connect` 綁定 | Discord ID 存字串（不轉 JS number）；同 guild 一個 Discord 帳號同時只綁一位成員（partial unique） |
| `hub_clock_requests` | HubClock 計時（SDS API-06） | question：`deadline = root_created_at + 24h`；action：未 presented 不得有 deadline，presented 後 `deadline = presented_at + 30min`；`version` 供 compare-and-set；`resolved_at` 與終態一致 |
| `hub_clock_outbox` | 固定 idempotency key 的待寄結果 | `event_key` PK；`sent` 且 target=mail 必須有 `result_mail_id` |
| `hub_clock_cursors` | `fetch_inbox_events` cursor | 每 consumer 一列 |
| `audit_log` | append-only 稽核 | service_role 只有 SELECT＋INSERT；觸發器擋 UPDATE／DELETE，只有 2027-03-31 到期清除時 session 設 `hub.audit_purge=on` 才能刪。`details` 禁放 token 原值／Authorization |

token 為 ≥256 bit 隨機值，SHA-256 足以比對，不需 bcrypt／argon2 慢雜湊（工程判斷，非引用；若 PM 要求可改）。

## 3. 誰讀寫哪張表

| 元件（批次） | 讀 | 寫 |
|---|---|---|
| bot `/connect`、`/revoke`（L） | members、discord_links、devices | devices（發／請求撤銷）、discord_links、audit_log |
| host `TokenApplier`／`ops/render-caddy`、`ops/revoke`（L） | `caddy_allowlist_export`、devices | devices（`config_revision`、pending→revoked）、audit_log |
| bank-proxy（L） | devices（`token_hash`＋`status='active'`＋group）、groups（bank_id） | —（拒絕事件可寫 audit_log，待對齊） |
| `ops/lifecycle` HubClock（L 起；MVP 用檔案） | hub_clock_* | hub_clock_*、audit_log |
| Mail、Hindsight | **不連此 DB** | — |
| operator（postgres owner） | 全部 | migration、到期清除 |

## 4. 部署位置與網路隔離（純 Postgres，上線批次）

- **放在 Hindsight 的 pgvector Postgres 裡，另開一個 database `hub`**，不是在 Hindsight 的 database 裡開 schema。理由：(1) 搬 Supabase 時 `hub` 的 `public` 直接對應專案 `postgres` database 的 `public`，不和 Hindsight 的表混；(2) 權限：Hindsight 的 login role 與 hub 的 login role 各自只有自己 database 的 CONNECT（`revoke connect on database hub from public`）；(3) 備份、2027-03-31 清除可各自 `pg_dump`／`drop database`。
- **網路（SAD 改動，待對齊 T7／Codex）**：SAD 目前是「只有 Hindsight 能到 db」。本設計需讓 bot、bank-proxy 也連 db：新增 internal 網路 `hub-db-net`，`db` 同時加入原本的 Hindsight db 網與 `hub-db-net`；bot、bank-proxy 只加入 `hub-db-net`。host 上的 `ops/*` 以 `docker compose run --rm` 一次性容器（接 `hub-db-net`）執行，或 db 只綁 `127.0.0.1:5432`——兩案擇一待對齊；**都不對外發布 5432**。Mail 容器仍不加入任何 db 網。
- **login role（不進 migration，秘密不進 git）**，operator 在 VPS 執行：

```sql
-- 以 db superuser 執行；密碼由 secrets 檔提供，不寫進 shell history
create database hub;
revoke connect on database hub from public;
\c hub
-- 先跑 migrations（見 §6），再建 login role：
create role hub_app login noinherit password :'hub_app_password';
grant service_role to hub_app;
alter role hub_app set role = 'service_role';   -- 連上即切成 service_role，照 Supabase authenticator 切角色的做法
grant connect on database hub to hub_app;
```

bot、bank-proxy、ops 可以分三個 login role（同上，各自密碼），稽核時以 `actor_id` 區分；最小版本先共用 `hub_app`，待對齊。

## 5. 與 Caddy allowlist 的同步（DB 是權威）

**限制**：Caddy 的 `header Authorization "Bearer <token>"` 比對的是原值（SDS API-01），DB 只有 hash。所以：

- **DB 決定「誰該放行」**（`caddy_allowlist_export`）；token 原值放 VPS 私密檔 `secrets/tokens/<token_id>`（0600，只有 TokenApplier 讀），與 MVP 的 Caddyfile 明文秘密同等級（SDS 已要求限權、加密備份）。
- **render-caddy**：讀 view → 逐列讀私密檔 → 驗 `sha256(原值)=token_hash`，不符就整批中止（防止錯檔）→ 生成 → `caddy validate` → 原子 rename → reload → 成功後寫 `devices.config_revision` 與 `audit_log(device.config.applied)`。私密檔存在但 DB 不是 active 的，一律不輸出。
- **撤銷流程**：
  1. 同一交易：`devices.status='revocation_pending'`、`revocation_requested_at=now()`＋`audit_log(device.revoke.request)`。此刻 bank-proxy 立即拒絕（它直接查 DB `status='active'`），view 也立即排除。
  2. render-caddy → validate → reload。
  3. 用舊 token、原 MCP session 打一次，得 401。
  4. 同一交易：`status='revoked'`、`revoked_at=now()`＋`audit_log(device.revoke.applied)`；刪除私密檔。
  5. 任一步失敗：維持 `revocation_pending`（觸發器禁止回 active），報「待撤銷／失敗」找 operator；**不可回報成功**。還原備份後先重跑 render-caddy，DB 的 revoked 狀態蓋過舊 Caddyfile。
- **選項 B（待對齊，不在本票做）**：改用 Caddy `basic_auth`＋bcrypt hash（[basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)，未逐字查證細節），Caddyfile 只放 hash、VPS 不再存原值。代價：client header 從 Bearer 改 Basic，影響 H-02／H-04／onboarding，且每請求做 bcrypt 有 CPU 成本 → 11-30 前不建議改。

## 6. 套用與搬遷

| 環境 | 指令 |
|---|---|
| VPS 純 Postgres（上線批次） | 建議逐檔 `psql -v ON_ERROR_STOP=1 -f supabase/migrations/<檔>`。`supabase db push --db-url ...` 實測可套用並寫 `supabase_migrations.schema_migrations`，但之後會卡在拉 edge-runtime image（§9-B），exit code 不可靠。**正式環境不跑 seed** |
| Supabase 雲端 | `supabase login` → `supabase link --project-ref <ref>` → `supabase db push`（官方頁另寫 `--remote`；本機 CLI 2.109.1 的旗標是 `--linked`，以實際 `--help` 為準）。compat migration 在雲端是 no-op。資料：`pg_dump --data-only --table='public.*' hub` → `psql` 匯入雲端；匯入後重算 identity sequence |
| Supabase 自架版 | 依 [Self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker) 起整套後，`supabase db push --db-url ...` 指向其 Postgres；資料同上 |

- 版本：`config.toml` 的 `major_version = 17`（Supabase 雲端目前版本）；VPS 的 Hindsight 是 `pgvector/pgvector:pg18`。本 schema 只用 PG13+ 功能；**PG18→17 的 `pg_dump` 降版匯入是否乾淨，待確認**（搬遷時以 `--data-only` 降低風險）。
- 驗證以 Docker `postgres:17`（＝雲端版本）從零跑，見 §9。

## 7. 記憶體影響

- **不加新程序**：沿用上線批次已預算的 Postgres（SAD 預留 512 MiB）。新增的是 `hub` database 與 bot／bank-proxy／ops 的連線；F-05 實測每連線約 5–20 MB，連線池上限設 5 → 最多約 100 MB，仍在 512 MiB 內，**待 VPS `docker stats` 實測**。
- **完整 Supabase 自架**官方最低 4 GB RAM（建議 8 GB），含 Studio、Auth、PostgREST、Realtime、Storage、Supavisor 等十多個服務（同上連結）。SAD 上線批次合計 4,992 MiB、剩 2,637 MiB → 跑不下，符合 維護者 決定。

## 8. 對 H-05／上線批次票的改動清單

| 票 | 改動 |
|---|---|
| H-05（Tom，MVP） | **已做**（`ops/lifecycle/`）：MVP 用檔案 Store，介面對應 hub_clock_* 表；`20261118000000_hub_clock_align_h05.sql` 補 `recipient_agent`、session 可空、`hub_clock_processed` 等，上線批次只需寫 `store-pg.mjs` |
| H-02（Codex，MVP） | MVP 不改。L：`ops/render-caddy` 輸入從手寫清單改為 `caddy_allowlist_export`＋私密檔 hash 核對；`ops/revoke` 改走 §5 流程 |
| H-06（agy-1） | L：每日備份加 `pg_dump hub`；2027-03-31 清除含 `hub` database（`set hub.audit_purge='on'` 或直接 `drop database hub`） |
| 新票 L-DB | 在 Hindsight Postgres 建 `hub` database、login role、`hub-db-net`；`supabase db push --db-url` 套 migration；跑 `rls_test.sql` |
| 新票 L-bot `/connect` | 寫 members／discord_links／devices／audit_log；只透過 TokenApplier 發 token |
| 新票 L-bank-proxy | 以 `sha256(token)` 查 devices（active＋group）取代設定檔 |
| SDS／SAD | SDS「principal／L 入 glue DB」改為 PG `hub` database；SAD 網路圖加 `hub-db-net`（§4 待對齊） |

## 9. 驗證（2026-11-17，本機 Mac，Docker Server 29.9.3）

環境：`postgres:17`（image `sha256:0d938e975177…`，`show server_version` = `17.12 (Debian 17.12-1.pgdg13+1)`），只綁 `127.0.0.1:55432`，用完已 `docker rm -f`。

**A. psql 從零跑 migrations＋seed＋RLS 測試**

```sh
docker run -d --name t15-pg17 -e POSTGRES_PASSWORD=<local> -p 127.0.0.1:55432:5432 postgres:17
docker exec t15-pg17 psql -U postgres -c "create database hub"
for f in supabase/migrations/*.sql supabase/seed.sql; do
  docker exec -i t15-pg17 psql -U postgres -d hub -v ON_ERROR_STOP=1 -q < "$f"; done
docker exec -i t15-pg17 psql -U postgres -d hub -v ON_ERROR_STOP=1 < supabase/tests/rls_test.sql
```

```text
NOTICE:  T1 PASS: anon select devices -> permission denied
NOTICE:  T2 PASS: authenticated select devices -> permission denied
NOTICE:  T3 PASS: anon with mistaken GRANT still sees 0 rows (RLS)
NOTICE:  T4 PASS: service_role sees devices=2 export=2
NOTICE:  T5a PASS: revocation_pending token removed from caddy_allowlist_export
NOTICE:  T5b PASS: revoked -> active rejected (devices: revoked token tok_fakewin01 cannot be reactivated)
NOTICE:  T6a PASS: service_role update audit_log -> permission denied
NOTICE:  T6b PASS: service_role delete audit_log -> permission denied
NOTICE:  T7a PASS: question deadline != created+24h rejected
NOTICE:  T7b PASS: action deadline before presented rejected
NOTICE:  T8 PASS: anon select caddy_allowlist_export -> permission denied
ALL RLS TESTS PASSED
exit=0
```

compat migration 重跑一次：`DO`／`GRANT`，exit 0（冪等）。

**B. `supabase db push --db-url`（CLI 2.109.1）到另一個空 database**

```sh
PGSSLMODE=disable supabase db push --db-url 'postgresql://postgres:<local>@127.0.0.1:55432/hub_push2?sslmode=disable' --yes
```

- 三個 migration 全部套用；`supabase_migrations.schema_migrations` = `20261117000000_compat_supabase_roles, 20261117000100_hub_core_tables, 20261117000200_hub_rls_and_grants`。之後用 psql 套 seed、跑 `rls_test.sql` → `ALL RLS TESTS PASSED`。
- **兩個 CLI 狀況（照實記錄）**：(1) 只在 URL 寫 `?sslmode=disable` 時失敗：`tls error (server refused TLS connection)`；加環境變數 `PGSSLMODE=disable` 才連上（本機無 TLS 的 Postgres 才需要）。(2) 套完 migration 後 CLI 開始 `Pulling from supabase/edge-runtime v1.74.2`，不會自己結束；第一次加 `--include-seed` 時卡在此步、seed 沒跑，我手動 kill；第二次 `timeout 90` 結束（exit 124）。**migration 已寫入，但 CLI 的 exit code 不能當成功依據**，VPS 上建議 psql 逐檔套用，或另查這個 pull 的成因（待確認）。

**C. §4 login role 做法**：建立 `hub_app`（NOINHERIT＋`grant service_role`＋`alter role ... set role`）後登入 → `current_user=service_role, session_user=hub_app`，讀得到 `caddy_allowlist_export` 2 列；`update audit_log` → `permission denied`。

**沒驗的**：VPS 實際的 `pgvector/pgvector:pg18`、Supabase 雲端／自架實際 `db push`、`revoke connect` 擋跨 database 登入。

## 10. 待對齊／待確認

| 項目 | 原因 | 找誰 |
|---|---|---|
| SDS 的 decisions／grants／bridge cursors／outbox／budget／usage 是否也搬進 `hub` database | 本票只列六類表；同一 DB 可減少 SQLite 數量，但會擴大範圍 | PM（工程取捨，不需 維護者） |
| `hub-db-net` 與 host ops 連線方式（一次性容器 vs 127.0.0.1） | 改 SAD 網路圖 | T7／Codex |
| bot／bank-proxy／ops 是否分 login role | 稽核粒度 vs 維運成本 | PM |
| Caddy 選項 B（basic_auth＋bcrypt） | 會改 client header | PM／Codex，11-30 後 |
| PG18→17 降版匯入 | 未測 | 搬遷時實測 |
| Hindsight 自己的表在哪個 database／schema | F-05 只測過內嵌 pg0 | L-DB 票盤點 |
