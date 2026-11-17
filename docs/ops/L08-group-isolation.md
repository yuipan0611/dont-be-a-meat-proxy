# L-08 跨組隔離與新增組別

基線：先在 `example-org/codex-L08` merge master（`adab44a`，Already up to date）。本票只改工作分支，不 push、不登入 VPS。

每組用不同 Compose project 啟動 `deploy/compose.yaml` + `deploy/validator/compose.validator.yaml`：每個 project 自有 mail-a、mail_a_data、mail_a_net、validator 與 secret 目錄。Mail 沒有 host port，只掛自己的一個 `/data` volume，不連其他組或 DB 網路；validator 只發布 loopback port。不可把兩個組放到同一 project，也不可共用 volume、upstream bearer 或 secret 目錄。宿主 root／Docker 管理員是信任邊界，成員沒有其存取權。

`HUB_GROUP_ID` 是 validator／bank-proxy／bot 正式入口的必要參數。validator 拒絕他組 project 參數（含 ensure_project human_key、project_key、project_a/b、group_id），所有附件沿用 L07 拒絕；OS volume 邊界阻止 server-local 檔案越組。Caddy 每組 hostname 匯入自己的 `auth.caddy`，不合法 token 在選路前全部 401；Mail Authorization 換成該組自己的 upstream bearer，memory 保留裝置 token 交給該組 bank-proxy 再查 DB。bank-proxy 每次查詢限制 group_id，拒絕有效的他組 token（401）、他組 bank 路徑／參數（403）、list_banks 與 multi-bank endpoint；Hindsight master key 只在內部網路。

bot 的 store 查詢與修改均綁 group_id：Discord membership、裝置、通知、presence、游標、預算與 audit。TokenApplier 的 DB SELECT／UPDATE／audit／export／MVP import 皆限制 group_id，並比對 request、DB row 與私有 registry；他組 export 列排除，request 越組不修改裝置。每組獨立 spool／token dir／allowlist。新組的 MVP import token_id 加組別 hash，避免全域 unique 衝突，既有 group-a ID 保留。migration 額外以 composite FK 防止 member_id/group_id 混組，bridge cursor 改為 `(group_id, agent_name)`。

`hub_app` 預設切成 BYPASSRLS 的 `service_role`，**原始 SQL 仍能看全部組別**；本票驗收的是應用程式的固定組別查詢，不宣稱 DB role 提供租戶隔離。不要提供成員 DB 憑證。測試使用真實登入 `session_user=hub_app/current_user=service_role`，不是用 RLS 或 mock 掩蓋。

## 本機 TC-14

需 Docker、Node 22+、bot 與 bank-proxy 的 npm ci，以及可執行 Caddy 2.11.9（`CADDY_BIN` 指定；沒有就明確失敗）。測試使用 pinned Mail、Go/gitleaks、Postgres 與 Hindsight image，不呼叫付費 LLM；Hindsight 需可下載初次模型檔。執行：

```sh
(cd bot && npm ci --ignore-scripts)
(cd ops/bank-proxy && npm ci --ignore-scripts)
CADDY_BIN=/absolute/path/to/caddy node ops/test/group-isolation-stack.mjs
```

腳本建立 grp-test／grp-test2，再逐一驗證：

1. 兩組獨立 volume/network、Mail 無 host port，兩方向 token 在所有公開路徑類別的 GET／POST／DELETE 皆 401。
2. 自己 project 可用，越組 ensure_project 拒絕；在 B 寫 marker，確認 A 容器看不到；attachment_paths／Markdown／HTML 三種帶出手法拒絕，A archive 全檔掃描無 marker。
3. 真實 Hindsight：自己 bank 能 initialize，list_banks、多 bank、他組 bank path、bank_id override 均拒絕；直接對兩個 group-bound proxy 用他組 token 亦 401。
4. 真實 hub_app/service_role：registry、Discord member、他組 pending/backlog、通知修改、裝置撤銷、預算與混組 ingest 拒絕；同名 RedStone 的 cursor 不互相覆蓋。

結束清除測試容器／volumes；generated credentials、原始診斷與 archive 留在被 Git 忽略的私有 scratch。僅把無憑證摘要放 `docs/ops/evidence/L08-*`。各組公網 TLS、VPS 檔案 owner 與實際 Discord `/connect` 仍須操作者驗收；本機通過不等於已開放上線。

## VPS 新增一組（操作者執行，本票未登入）

1. 先備份 hub DB 與既有組資料；按 L01 跑 `ops/postgres migrate`，包含 `20261121000000_l08_group_boundaries.sql`。migration 若碰到混組舊列會失敗，先調查，不刪資料繞過。
2. 複製 `deploy/groups/group.env.example` 到 `/etc/neighbor-hub/groups/<group>.env`（600，root owned）。group_id 只能小寫英數與 hyphen，2–63 字；填唯一 `COMPOSE_PROJECT_NAME`、loopback Mail/Memory ports、私有目錄、spool、memory project 與 hostname。不要在這檔放 token。每組 secret 產生方式沿用 L02/L03 的 owner/mode runbook，不能直接複製另一組上游 token。
3. 以 root 建立該組 private／validator／tokens-db／token-spool（700）、policy JSON `{"entries":[]}`（600，validator 可讀），以及 `/etc/caddy/hub-private/<group>`、共用 `/var/lib/neighbor-hub/applier-lock`。依 L03 設 bot spool owner；bot 不可讀其他組 secret。執行 `ops/init-secrets --state-dir <private> --group-id <group>`；重跑時若 group 不符會拒絕。正式群組新增 DB groups／members／discord_links，project_key 固定 `/data/projects/<group>`、bank_id 唯一等於 group_id；用 psql `-v` 傳值並用 `:'variable'`，不要拼接未檢查的輸入。**不要執行 seed.sql**。
4. 設定該組 env 檔的非秘密變數後，先啟動 Mail + validator：

```sh
docker compose --env-file /etc/neighbor-hub/groups/GROUP.env \
  -f deploy/compose.yaml -f deploy/validator/compose.validator.yaml \
  up -d --build --wait mail-a validator
ops/bootstrap --state-dir /var/lib/neighbor-hub/groups/GROUP/private \
  --url http://127.0.0.1:PORT/mcp/
```

`GROUP`、`PORT` 以實際值替換。bootstrap 從該組 registry 決定 project，不再硬編 group-a。loopback port 是 validator，不是 raw Mail；初始化後仍不能改回發布 raw Mail。

5. 依 L02 的 owner/mode 與 Hindsight DB provision 步驟啟動該組 memory project（同一份 memory Compose，指定唯一 `-p <HUB_MEMORY_PROJECT>`）。若多個 Hindsight instance 共用 L01 DB，它們使用同一 DB 但 bank_id 不同；不要公開 Hindsight port/master key。對 bank-proxy 設該組 HUB_GROUP_ID。若啟用 memory bridge，必須依組配置 bridge bank、sender 與 state（原 L02b override 的 group-a 預設不能直接複用）。
6. 用 `ops/render-caddy --state-dir ... --prepare-only --owner caddy --output /etc/caddy/hub-private/GROUP/auth.caddy --upstream 127.0.0.1:MAILPORT --memory-upstream 127.0.0.1:MEMPORT` 產生該組初始 allowlist；新增該組 hostname 的獨立 Caddy site，只 import 該組 auth.caddy。沿用既有 TLS issuer/DNS 慣例，先 `caddy validate`，成功才 reload，並確認原有各組與 office 仍正常。
7. 安裝本票的 `hub-token-applier@.service`／`.timer`，`systemctl enable --now hub-token-applier@GROUP.timer`。所有組都透過共用 global.lock 序列化 Caddy reload；先把既有 group-a 一併遷移到 template，停用舊 `hub-token-applier.service/path/timer`，避免沒有共用鎖的舊 writer 同時修改 Caddy。手動 render/import-mvp 同樣加 `/usr/bin/flock /var/lib/neighbor-hub/applier-lock/global.lock`，完整帶入 `--group-id`、`--state`、`--token-dir`、`--spool`、`--output`、`--upstream`、`--memory-upstream`、`--probe-url`（該組 HTTPS URL）。DB authority 啟用後禁止用 legacy render-caddy 覆蓋。
8. bot 加入 L03 override 時設定該組 HUB_GROUP_ID、MAIL_PROJECT_KEY、HUB_PUBLIC_URL、Discord guild/application、private/spool，與既有組使用不同 Discord application/guild；只有該組 DB member 會被識別。先 check-config，再啟動單一副本。新組 `/connect` 應匯出該組 hostname；不能共用全域 hub URL。
9. 在開放 `/connect` 前，於實際入口對新舊組執行同等 TC14 三步與 DB 應用測試、核對 raw Mail 沒有 host port，保留結果。任何一步不過，保持新組不開放。此票只提供本機自動化，尚未替 VPS 做實際驗收。

回滾：停新組 bot／timer、移除新組 Caddy import 後 validate/reload，保留 DB 與 volume 以便調查；不要 down -v 正式資料，也不要將多組合回同一 Mail 容器。Schema 的 composite FK／cursor 複合主鍵保留，舊版 bot 不相容新的 cursor conflict target，回滾應用時要保留本票 store 實作。

## 本票驗證結果

TDD RED：`L08-go-red.txt` 證明 12 個 foreign project 變體到達 Mail；`L08-bank-red.txt` 證明有效他組 token 沒有回 401；`L08-applier-red.txt` 證明 foreign export 被納入 allowlist（測試生成值已遮除）；`L08-bot-red.txt` 證明 service_role store 回傳他組 member。環境最初沒有 host Go，改用同一 pinned Go image 跑；RED 對應修改前源碼快照。

GREEN 證據均在 `docs/ops/evidence/`：

| 檔案 | 結果 |
| --- | --- |
| L08-tc14-local.txt | 真實 grp-test／grp-test2 全部 TC14 步驟，96 次公開路徑越組 token 401；清除測試 stacks |
| L08-go-green.txt | validator 全部 Go tests 通過 |
| L08-bank-green.txt | bank-proxy／LLM gateway／budget 26 tests 通過 |
| L08-applier-green.txt | TokenApplier 18 tests 通過（含真實 Caddy validate） |
| L08-applier-pg.txt | TokenApplier 真實 Postgres 4 tests 通過，包含 service_role 組別 SQL、越組修改無效、他組 import |
| L08-bot-pg-green.txt | bot 真實 Postgres 10 tests 通過，hub_app 預設 service_role |
| L08-bot-unit.txt | bot 56 tests 通過 |
| L08-ops-regression.txt | ops 8 tests 通過，真實 Caddy 配置驗證無 skip |
| L08-l07-regression.txt | L07 真實 Caddy→validator→Mail 核心驗收、SQLite/archive、allowlist、latency 與 HubClock；此輪明確未重跑 L07 三套額外 client/lifecycle 整合套件 |

未完成的環境驗收：VPS 部署、各組 hostname/TLS、Linux secret owner/mode、實際 Discord `/connect`。未 push、未改 master、未登入 VPS；本機通過不能代替上述項目。原 L02 含 Ollama retain/recall 的完整付費模型/內容回歸未重跑；本票以真實 Hindsight initialize 加拒絕測試驗證隔離，並同步原測試對新的 401／403 契約。

L07 首輪在同時建置 TC14 stacks 時，paired p95 130.346 ms／max 152.838 ms，未達 100 ms；原始摘要保留於 `L08-l07-latency-first-run.txt`。清理競爭 stacks 後，單獨重跑 p95 7.852 ms／max 8.140 ms、validator max 6.676 ms，核心驗收及 HubClock 均通過；沒有修改延遲測試或門檻。另以 `L08-import-red.txt` 記錄發現的 registry/cfg 組別不符時 import 先寫 DB 的缺口，修正後 18 個 TokenApplier tests 通過。

L05 合併後的決策 DB 組別邊界、migration 與整合驗證另見 `docs/ops/L08-L05-merge-validation.md`；部署新增 `20261122000000_l08_l05_decision_groups.sql`，以免跨組相同 Mail/draft ID 衝突。
