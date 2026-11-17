# L-01：pgvector Postgres 與 Hub 資料庫

2026-11-17。本機驗證完成；**VPS 已部署並驗收（PM，2026-11-17 08:10～08:12 UTC，master 85c6a7f）**：§2～§5 全部照做，結果記於 `docs/00-DAG.md` L-01 列。部署前程式目錄備份於 VPS `/root/neighbor-hub.pre-L01`。

依據：`docs/08-data-layer-supabase.md`、SRS §4.4～4.5、`docs/ops/vps-inventory.md`。本票只部署資料庫，不切換既有 Caddy allowlist、HubClock Store、Mail SQLite，也不匯入正式成員與 token。既有 `deploy/compose.yaml` 與 office 系統 Caddy 不需變更。

## 部署契約

- 獨立 Compose：`deploy/postgres/compose.yaml`，project **neighbor-hub-db**，service **db**。只啟停這個專案。
- 官方 pgvector image `pgvector/pgvector:pg18` 固定 multiarch index digest `sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782`；預設 `linux/amd64` 對應 VPS。arm64 可設 `HUB_PG_PLATFORM=linux/arm64`。實際版本與測試收據見 `evidence/L01-local-validation.txt`。
- `512 MiB` hard limit（禁止額外 swap）、shared_buffers 128 MB、work_mem 2 MB、maintenance_work_mem 32 MB、max_connections 30。應用程式 pool 各自 ≤5，所有服務連線合計需預留維運連線；512 MiB 包含將來 Hindsight 共用負載，L-02 必須實測。盤點既有用量 1.6 GiB 是當時數字，部署前重查。
- **沒有 host port**，兩個 project-scoped internal bridge：`neighbor-hub-db_hub-db-net`、`neighbor-hub-db_hindsight-db-net`。ops 走 Docker exec；未掛 Docker socket 入容器。Mail 不加入 DB 網。L-02 只接 hindsight-db-net；bot／bank-proxy 接 hub-db-net。網路不提供資料庫身分授權。
- PG18 volume 掛在 `/var/lib/postgresql`，實際 PGDATA 是 `/var/lib/postgresql/18/docker`。保留 `neighbor-hub-db_pg_data`，不可沿用 PG17 data directory。
- `hub` 單獨 database；`postgres`、`template1`、`hub` 均撤回 PUBLIC CONNECT。hub_app 是 NOINHERIT login，預設切 service_role（具 BYPASSRLS，限伺服器使用），只授予 hub CONNECT。anon／authenticated NOLOGIN，所有業務表開 RLS（L-01 時 9 張；L-03 migration 後 13 張）、無成員直連權限。**service_role 不隔離組別**；S2/S3 的應用層隔離由 L-08 驗收。
- L-02 在同一叢集新建 `hindsight` database 與專用 login 時，必須 `REVOKE CONNECT ON DATABASE hindsight FROM PUBLIC`，只 grant 該 login；反向測試該 login 不能連 hub。此票保留網路，不建立 Hindsight 表或密碼。
- migrations 原樣保留，依檔名排序；psql ON_ERROR_STOP＋單一交易＋advisory lock。私有 `_hub_ops.migrations` 記 filename／SHA256，重跑跳過已套檔、已套檔內容變更會拒絕。此 ledger 是純 PG 維運資料，不冒充 Supabase CLI history；以後搬雲端時依 §08 的流程另行對齊。
- bootstrap 建 DB／撤 CONNECT 是交易前的叢集操作；後續 migration 失敗會保留空 hub，但不會留下半套業務 schema／ledger。角色初始化也在同一 migration 交易內。沒有自動 seed。

來源：[pgvector 官方 Docker](https://github.com/pgvector/pgvector#docker)、[Postgres image 的 PGDATA／FILE 說明](https://hub.docker.com/_/postgres)、[Supabase pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。digest 由 `docker buildx imagetools inspect pgvector/pgvector:pg18` 實查。

## 1. PM 核准後，VPS 前置檢查

下列命令供 operator 在 VPS root shell 執行；Codex 未登入 VPS。先將本票核准的 Git 版本部署到 `/opt/neighbor-hub`，包含 `deploy/postgres/`、`ops/postgres`、更新的 `ops/backup` 與 `supabase/`；保留 `/var/lib/neighbor-hub/private` 與原部署檔。部署版本記入驗收紀錄。

```bash
cd /opt/neighbor-hub
free -h
df -h /var/lib/docker
docker compose version
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
# 比較部署前後 StartedAt，確認既有容器未被重建。
docker ps -q | xargs -r docker inspect --format '{{.Name}} {{.State.StartedAt}}'
curl --fail --silent --output /dev/null --write-out 'office_before=%{http_code}\n' https://office.example.invalid
# 不帶 token 的 Hub health 預期 401。
curl --silent --output /dev/null --write-out 'hub_before=%{http_code}\n' https://hub.example.invalid/health/liveness
```

若 office 非預期 200、既有 hub 異常或記憶體／磁碟不足，先處理現況，不啟動本票。保留當前正常 hub-backup 收據。確認 5432 未對外發布；不要修改 Caddy、防火牆或重新啟動 Docker。

## 2. 私密檔與啟動

下列初始化只建立不存在的檔，不覆寫既有秘密；root 700 目錄、600 檔案。不要把秘密放 repo、argv、env_file 或貼到聊天。正式密碼為 32 random bytes 的 hex，hub_app secret 預期 64 lowercase hex。

```bash
install -d -m 700 /var/lib/neighbor-hub/private
python3 - <<'PY'
from pathlib import Path
import os, secrets
for name in ('postgres.password', 'hub-app.password'):
    p = Path('/var/lib/neighbor-hub/private') / name
    if p.exists():
        continue
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_hex(32) + '\n')
PY
pgc() { docker compose -p neighbor-hub-db -f /opt/neighbor-hub/deploy/postgres/compose.yaml "$@"; }
pgc config --quiet
pgc pull db
pgc up -d --wait --wait-timeout 90 db
/opt/neighbor-hub/ops/postgres migrate
/opt/neighbor-hub/ops/postgres migrate  # 全部 SKIP，驗冪等（L-03 後共 5 個 migration）
/opt/neighbor-hub/ops/postgres psql -Atqc 'select filename from _hub_ops.migrations order by filename'
/opt/neighbor-hub/ops/postgres psql -Atqc 'select count(*) from public.devices' # 0；正式 DB 不跑 seed
/opt/neighbor-hub/ops/postgres psql -Atqc "select '[1,2,3]'::extensions.vector OPERATOR(extensions.<->) '[1,2,3]'::extensions.vector" # 0
```

postgres superuser 僅供 migration／備份／維運；不把其密碼交給 app。Compose secrets 在 Linux 保留 bind 檔原本的 root:root 600，因此 migrate 的 root operator 在 shell 讀檔，用 psql 的環境變數載入密碼；postgres server 不直接讀 root 秘密檔。`hub_app` 只在不存在時建立，重跑 migration 不重設密碼。更換 secret 檔**不會**變更既有 DB 密碼；密碼輪替需另排維運。

## 3. VPS 驗收（不在正式 hub seed）

RLS 測試需要 2 台假裝置，故從尚未接 app 的空 hub 複製到暫時 DB；若 hub 已有 app 連線或業務資料，不再用 template 複製，改在獨立測試 project 執行本機 harness。

```bash
/opt/neighbor-hub/ops/postgres psql -c 'create database hub_rls_test template hub'
/opt/neighbor-hub/ops/postgres psql -c 'revoke connect on database hub_rls_test from public'
/opt/neighbor-hub/ops/postgres psql -d hub_rls_test -f /supabase/seed.sql
/opt/neighbor-hub/ops/postgres psql -d hub_rls_test -f /supabase/tests/rls_test.sql
# 預期 T1～T9（含子項）共 14 PASS、ALL RLS TESTS PASSED、exit 0。
/opt/neighbor-hub/ops/postgres psql -c 'drop database hub_rls_test'
# 真 TCP 連線；只輸出身分，不輸出密碼。
pgc exec -T db bash -ceu 'export PGPASSWORD="$(cat /run/secrets/hub_app_password)"; exec psql -X -h 127.0.0.1 -U hub_app -d hub -Atqc "select session_user,current_user"'
# 預期 hub_app|service_role；換 -d postgres 應 permission denied（exit 非 0）。
pgc exec -T db bash -ceu 'export PGPASSWORD="$(cat /run/secrets/hub_app_password)"; exec psql -X -h 127.0.0.1 -U hub_app -d postgres -Atqc "select 1"'
pgc stats --no-stream
pgc ps
pgc port db 5432  # 無 host mapping；可能 exit 非 0，這是預期。
ss -tlnp | grep ':5432'  # 無新增監聽；不要因此開防火牆。
docker ps -q | xargs -r docker inspect --format '{{.Name}} {{.State.StartedAt}}'
curl --fail --silent --output /dev/null --write-out 'office_after=%{http_code}\n' https://office.example.invalid
curl --silent --output /dev/null --write-out 'hub_after=%{http_code}\n' https://hub.example.invalid/health/liveness
```

核對 office 200、Hub 無 token 401、既有 mail-a／hubclock StartedAt 不變。另按 H-02 原本的方法測合法 Hub token，不在命令列或記錄中輸出。記錄 Postgres idle／migrations／RLS 後記憶體；L-02 接 Hindsight 後要補尖峰、OOM 與連線池測試。

本機重現命令：`node --test ops/test/postgres.integration.test.mjs`。它建立唯一測試 project／暫存秘密，只清理自己建立的容器與 volume；涵蓋不發布 port、512 MiB、5 migrations 重跑（含 L-03）、SQL 失敗全批回滾、checksum drift 拒絕、14 RLS 斷言、真實 login／跨 DB 拒絕、重啟持久化、每日備份還原與 DB 離線時備份失敗。

## 4. 納入既有每日備份

`ops/backup` 預設 `HUB_PG_BACKUP=0`，保留 MVP 行為；啟用後用同 image 的 pg_dump，將一致性邏輯快照 `postgres/hub.dump` 放進**同一個** hub-backup tar.gz，manifest 增加 `postgres.present/database/file/sha256`。dump／驗證失敗就 exit 非 0，不產出缺 PG 的成功備份。dump 不包含 role 密碼；migration 重建 roles、私密檔隨原 tokens/ 備份。這是 hub 的備份，**不含將來的 Hindsight database**；L-02 要追加自己的 dump。

```bash
install -d -m 755 /etc/systemd/system/hub-backup.service.d
cat > /etc/systemd/system/hub-backup.service.d/postgres.conf <<'UNIT'
[Service]
Environment="HUB_PG_BACKUP=1"
Environment="HUB_PG_PROJECT=neighbor-hub-db"
Environment="HUB_PRIVATE_DIR=/var/lib/neighbor-hub/private"
UNIT
systemctl daemon-reload
systemctl start hub-backup.service
systemctl status hub-backup.service --no-pager
systemctl list-timers hub-backup.timer --no-pager
```

沿用 03:17 UTC 每日 timer、7 天輪替、Mac 每週加密拉回與原 snapshot 計畫，不另排一個相互競爭的排程。既有 unit 的 ProtectSystem／PrivateTmp 仍保留；Docker CLI 經 host socket exec 執行 dump，不需開 port 或放寬權限。首次啟用一定用實際 systemd service 驗證；本機未模擬 systemd sandbox。Mac 每週拉回仍受既有 ssh-agent 解鎖限制。

SQLite、HubClock 檔案與 PG 各自有一致性快照，但不是跨系統同一筆交易；未來 app 整合後仍需沿用 idempotency／outbox 補對齊。每日 archive 包含秘密，維持 root 600、離機加密，不能貼到 Git。

## 5. 還原演練與回滾

**第一次接 app 前完成還原演練。**以下供 operator 選定已知正常 archive 路徑後執行，只建 hub_restore，不碰正式 hub。`ops/restore --verify-only` 目前只驗 SQLite／外層 archive，不能當 PG 還原已驗證。

```bash
# 將此路徑改成實際選定備份，不要使用未存在的範例時間。
BACKUP_FILE=/var/lib/neighbor-hub/backups/hub-backup-YYYYMMDD-HHMMSSZ.tar.gz
/opt/neighbor-hub/ops/restore --backup "$BACKUP_FILE" --verify-only
L01_RESTORE_DIR="$(mktemp -d /var/lib/neighbor-hub/l01-restore.XXXXXX)"
chmod 700 "$L01_RESTORE_DIR"
tar -xzf "$BACKUP_FILE" -C "$L01_RESTORE_DIR"
python3 - "$L01_RESTORE_DIR" <<'PY'
import hashlib, json, pathlib, sys
p=pathlib.Path(sys.argv[1]); m=json.loads((p/'manifest.json').read_text())['postgres']
assert m['present'] and m['database']=='hub'
assert hashlib.sha256((p/'postgres/hub.dump').read_bytes()).hexdigest()==m['sha256']
print('POSTGRES_DUMP_SHA256_OK')
PY
/opt/neighbor-hub/ops/postgres verify-dump < "$L01_RESTORE_DIR/postgres/hub.dump" > /dev/null
/opt/neighbor-hub/ops/postgres psql -c 'create database hub_restore'
/opt/neighbor-hub/ops/postgres psql -c 'revoke connect on database hub_restore from public'
pgc exec -T db pg_restore -U postgres -d hub_restore --no-owner --exit-on-error < "$L01_RESTORE_DIR/postgres/hub.dump"
/opt/neighbor-hub/ops/postgres psql -d hub_restore -Atqc 'select count(*) from _hub_ops.migrations' # 本版 5（L-01 時 4，L-03 加 1）
/opt/neighbor-hub/ops/postgres psql -d hub_restore -Atqc "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity" # 本版 13（L-01 時 9，L-03 加 4）
/opt/neighbor-hub/ops/postgres psql -d hub_restore -Atqc "select has_table_privilege('anon','devices','SELECT'),has_table_privilege('service_role','audit_log','UPDATE')" # f|f
# 與來源備份時的業務筆數／原文 hash 核對，再刪演練 DB 與含秘密的暫存目錄。
/opt/neighbor-hub/ops/postgres psql -c 'drop database hub_restore'
rm -rf -- "$L01_RESTORE_DIR"
```

全新機器：先恢復 private 秘密檔（root 600），以相同 digest 起 DB，跑 migrate 建好空 hub 與 roles，再依上面流程建 hub_restore／還原。pg_dump 不保存 cluster roles 或 database CONNECT ACL，這些由 provisioning 與上列 REVOKE 補回。

真正資料回滾時，先停止**新 DB consumers**（bot／bank-proxy／Hindsight，依各票 runbook），保留最新事故快照與 audit；原 Mail／office 不需停。確認 hub_restore 資料正確後，從 `postgres` database 連線、確認兩個 DB 都沒有 active sessions，將原 hub 改名為 `hub_before_restore`，hub_restore 改名為 hub，再 `REVOKE CONNECT ... FROM PUBLIC; GRANT CONNECT ... TO hub_app`，重跑 migrate 核對 ledger 後再啟用 consumers。不要對既有 schema 直接 pg_restore --clean，也不要為失敗 migration 編輯已套檔；優先修正後加 forward migration。還原過舊資料可能復活已撤銷 token，重新接 allowlist 前按 §08 的 DB 撤銷／render-caddy 流程核對，不可直接回放舊 Caddy 私密檔。

若只撤回尚無 consumer 的本票部署：先移除本票 backup service drop-in 並 daemon-reload（回到原 MVP 備份），保留一次含 PG 的事故備份，`pgc stop db` 即可；資料 volume、秘密與備份保留。**不用 down -v、不動原 neighbor-hub、不重啟 Caddy／Docker**。PG major version 不能直接以舊 image 指向新 PGDATA；回原 image 用原 volume，版本降級須另 volume 邏輯還原。

## 6. 到期處置與交接

SRS 保存至 2027-03-31 後刪除。本票未擴張 `ops/purge` 的破壞性範圍；既有 purge 不知道新 project／volume，**不能宣稱已清掉 Postgres**。到期由 PM／維護者 確認後停止所有 DB consumers、只移除 `neighbor-hub-db` 的 DB／volume 與兩個 password 檔，並涵蓋每日 archive、Mac 加密備份及 Hostinger snapshots；若 Hindsight 共用此 PG，不能單為刪 hub 就刪整個 volume。到期前應補獨立清除驗收票。

未完成：VPS 部署與上述全部 VPS 驗收／systemd 備份／還原演練；L-02 實際 Hindsight database、專屬 login、雙向 CONNECT 拒絕與共用負載；L-03 等 consumers 接線；未來 PG18→Supabase PG17 搬遷。這些均未計入本機測試通過。
