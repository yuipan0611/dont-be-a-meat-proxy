# L-02：Hindsight＋bank-proxy（記憶層）

2026-11-17，swe-Ben。**本機驗證完成，VPS 未部署**（PM 審本文件後部署）。依據：`docs/research/F-05-hindsight-spike.md`、SDS API-04／D-4／MOD-01、`docs/06-test-plan.md` TC-21、`docs/ops/runbook-L01-postgres.md`。

## 0. 一句話

組員的 agent 用自己的裝置 token 打 `https://hub.example.invalid/memory/mcp/group-a/`。Caddy 先擋 token，去掉 `/memory` 後交給 bank-proxy。bank-proxy 再用 DB 查一次 token（每次都查，撤銷立即生效），只放行**自己那組的 bank**和**唯讀工具**，然後換成 Hindsight 主 key 轉給 Hindsight。Hindsight 的 LLM 呼叫全部經 bank-proxy 內的 LLM gateway：**每次呼叫前先從全域日帳本預留費用**，超過 0.50 USD 就回 429，不送出。

```
agent ──Bearer 裝置 token──▶ Caddy(:443) ──/memory 去前綴──▶ bank-proxy :8780 (127.0.0.1)
                                                               │ token→DB(hub)：active？哪個 bank？
                                                               ▼
                                                    Hindsight :8888（不對外）──▶ Postgres(hindsight DB)
                                                               │ LLM（Anthropic SDK，base_url=gateway）
                                                               ▼
                                                    LLM gateway :8790（只在 memory-net）──▶ api.anthropic.com
                                                       └ 帳本 /state/llm-ledger.json：先預留、後結算
```

## 1. 部署契約

| 項目 | 內容 |
|---|---|
| Compose | `deploy/memory/compose.yaml`，project **neighbor-hub-memory**，services `hindsight`、`bank-proxy`。只啟停這個 project；需要 L-01 的 `neighbor-hub-db` 在跑 |
| Hindsight | `ghcr.io/vectorize-io/hindsight:1.2.1@sha256:d2bc230a…6b31`（multiarch index，2026-11-17 實查；VPS 用 `linux/amd64`）。只開 API（`HINDSIGHT_ENABLE_CP=false`），不發布任何 port。`HINDSIGHT_API_MCP_ENABLED_TOOLS=recall,list_memories,get_memory,get_document`（bank-proxy 之外的第二道牆）。`HINDSIGHT_API_LLM_OUTPUT_LANGUAGE` 要求繁體中文 |
| bank-proxy | `ops/bank-proxy/`（Node 22，唯一依賴 `pg@8.23.1`，base image 固定 digest）。`:8780` 只發布在 `127.0.0.1`；`:8790`（gateway）**不發布**。uid 10002、read-only rootfs、cap_drop ALL、128 MiB |
| DB | L-01 叢集新增 database **hindsight**、login **hindsight_app**（非 superuser、不能建 DB／角色、connection limit 12、擁有 hindsight 與其 public schema）。`REVOKE CONNECT ... FROM PUBLIC`。hindsight 只接 `hindsight-db-net`；bank-proxy 只接 `hub-db-net`，用 `hub_app` 查 `devices`（docs/08「最小版本先共用 hub_app」） |
| 網路 | `memory-net`（有對外，Hindsight 首次下載 embedding／reranker 模型、gateway 連 Anthropic）。Mail 不加入任何一個 |
| 成員權限 | 只有 `recall`、`list_memories`、`get_memory`、`get_document`。`retain`／`reflect`／delete／clear／update 一律 `TOOL_NOT_ALLOWED`，不轉上游。寫入 Hindsight 只由內部 bridge（GAP-16，另票）或 operator |
| 每日上限 | 全域 500,000 micro-USD（0.50 USD），台北時間 00:00 換日。Haiku 5.5 價格 $0.10／$0.50 per MTok（>100K prompt 為 $0.50／$2.50），cache 寫入以 2 倍、讀取以 1 倍輸入價**保守**計。預留＝請求 bytes×輸入價＋`max_tokens`×輸出價；結算依回應 `usage`。上游錯誤狀態→釋放；200 但讀不到 usage、串流中斷→整筆照預留扣；程序當掉時未結算的預留在重啟時整筆扣 |

**資源（本機實測，Apple Silicon、arm64 映像、Docker Desktop；VPS 是 amd64，要重量）**：見 §6 的實測數字。Hindsight 本身峰值約 1.6 GiB（載入本機 embedding＋reranker），所以 `mem_limit` 設 2 GiB；Postgres 在 retain／recall 期間遠低於 512 MiB。

## 2. 私密檔（root 在 VPS 執行；不印出任何值）

Compose 的 file secret 在 Linux 保留主機檔案的擁有者與權限，所以**每個容器使用者一個目錄**，檔案 0400、擁有者是該容器的 uid。tenant key 與 gateway key 兩邊各一份（同值）。

先確認 uid 1000、10002 在 VPS 上沒有被別的登入帳號使用（有的話改 `HUB_BANKPROXY_UID`；Hindsight 映像固定 1000）：

```bash
getent passwd 1000 10002 || true
```

```bash
install -d -m 711 /var/lib/neighbor-hub/private/memory
install -d -m 700 -o 1000 -g 1000 /var/lib/neighbor-hub/private/memory/hindsight
install -d -m 700 -o 10002 -g 10002 /var/lib/neighbor-hub/private/memory/bank-proxy
install -d -m 700 -o 10002 -g 10002 /var/lib/neighbor-hub/bank-proxy          # 帳本 state
python3 - <<'PY'
from pathlib import Path
import os, secrets
P = Path('/var/lib/neighbor-hub/private')
M = P / 'memory'
def put(path, value, uid):
    if path.exists():
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(fd, 'w') as f:
        f.write(value + '\n')
    os.chown(path, uid, uid)
hs_db = (P / 'hindsight-db.password')
if not hs_db.exists():
    put(hs_db, secrets.token_hex(32), 0)
pw = hs_db.read_text().strip()
tenant = secrets.token_hex(32); gateway = secrets.token_hex(32)
if (M / 'hindsight/hindsight-api.key').exists():
    tenant = (M / 'hindsight/hindsight-api.key').read_text().strip()
    gateway = (M / 'hindsight/llm-gateway.key').read_text().strip()
put(M / 'hindsight/hindsight-db.password', pw, 1000)
put(M / 'hindsight/hindsight-api.key', tenant, 1000)
put(M / 'hindsight/llm-gateway.key', gateway, 1000)
put(M / 'bank-proxy/hindsight-api.key', tenant, 10002)
put(M / 'bank-proxy/llm-gateway.key', gateway, 10002)
put(M / 'bank-proxy/hub-app.password', (P / 'hub-app.password').read_text().strip(), 10002)
print('memory secrets ready; no values printed')
PY
```

**Anthropic key（需要 維護者 提供，PM 不自行註冊）**：放到 `/var/lib/neighbor-hub/private/memory/bank-proxy/anthropic.key`（0400，擁有者 10002）。建議 維護者 在 Anthropic Console 為這把 key 另設 workspace 的月上限，當作 gateway 之外的第二道保險。沒有 key 時 bank-proxy 仍能啟動與查詢；只有 retain／consolidation 會失敗（Hindsight 留待重試），不會產生費用。

## 3. 建 hindsight database 與 login

```bash
cd /opt/neighbor-hub
/opt/neighbor-hub/ops/postgres hindsight-init      # 建 DB、login、vector extension
/opt/neighbor-hub/ops/postgres hindsight-init      # 重跑：已存在就跳過，不改密碼
/opt/neighbor-hub/ops/postgres psql -Atqc "select has_database_privilege('public','hindsight','CONNECT'), rolsuper from pg_roles where rolname='hindsight_app'"  # f|f
pgc() { docker compose -p neighbor-hub-db -f /opt/neighbor-hub/deploy/postgres/compose.yaml "$@"; }
# 反向測試（真 TCP 登入；密碼由 root shell 讀檔、以變數名傳入）
PGPASSWORD="$(cat /var/lib/neighbor-hub/private/hindsight-db.password)" pgc exec -T -e PGPASSWORD db psql -X -h 127.0.0.1 -U hindsight_app -d hindsight -Atqc 'select current_user'   # hindsight_app
PGPASSWORD="$(cat /var/lib/neighbor-hub/private/hindsight-db.password)" pgc exec -T -e PGPASSWORD db psql -X -h 127.0.0.1 -U hindsight_app -d hub -Atqc 'select 1'   # permission denied for database "hub"
PGPASSWORD="$(cat /var/lib/neighbor-hub/private/hub-app.password)" pgc exec -T -e PGPASSWORD db psql -X -h 127.0.0.1 -U hub_app -d hindsight -Atqc 'select 1'        # permission denied for database "hindsight"
```

## 4. 啟動記憶層

```bash
memc() { docker compose -p neighbor-hub-memory -f /opt/neighbor-hub/deploy/memory/compose.yaml "$@"; }
free -h; docker stats --no-stream            # 先看餘量：Hindsight 需要約 1.6 GiB
memc config --quiet
memc build bank-proxy
memc pull hindsight
memc up -d --wait --wait-timeout 600 hindsight bank-proxy   # 第一次要下載模型，數分鐘
memc ps
memc port bank-proxy 8780                    # 127.0.0.1:8780
memc port bank-proxy 8790 || true            # 沒有發布（預期失敗）
memc exec -T bank-proxy node /app/main.mjs budget-status   # {"day":…,"capMicros":500000,"spentMicros":…,"reservedMicros":0}
```

建 bank（operator，只在容器內呼叫；Hindsight 不對外）：

```bash
hs() { memc exec -T hindsight python -c '
import sys, urllib.request
key = open("/run/secrets/hindsight_api_key").read().strip()
data = sys.stdin.read().encode() or None
r = urllib.request.Request("http://127.0.0.1:8888" + sys.argv[2], data=data, method=sys.argv[1],
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
print(urllib.request.urlopen(r, timeout=600).read().decode())' "$@"; }
echo '{"name":"group-a"}' | hs PUT /v1/default/banks/group-a
```

## 5. 裝置登記與 Caddy

bank-proxy 從 `hub` 的 `devices` 查 token（`status='active'`、成員 active、`groups.bank_id` 有值）。上線批次的 `/connect`（L-03）會寫這張表；在那之前，用 MVP 的 `tokens.json` 登記現有兩台裝置（只寫 sha256，不印原值）：

```bash
python3 - <<'PY' | /opt/neighbor-hub/ops/postgres psql -v ON_ERROR_STOP=1
import hashlib, json
d = json.load(open('/var/lib/neighbor-hub/private/tokens.json'))['devices']
h = {k: hashlib.sha256(v['token'].encode()).hexdigest() for k, v in d.items() if v['status'] == 'active'}
print("insert into public.groups (id, display_name, project_key, mail_hostname, bank_id) values ('group-a','A 組','/data/projects/group-a','hub.example.invalid','group-a') on conflict (id) do update set bank_id='group-a';")
print("insert into public.members (id, group_id, display_name, role) values ('00000000-0000-4000-8000-0000000000a1','group-a','維護者','owner') on conflict do nothing;")
for key, plat, label, agent in [('mac','macos','維護者 / Mac','BlueLake'), ('windows','windows','維護者 / Windows','RedStone')]:
    if key in h:
        print(f"insert into public.devices (member_id, group_id, label, platform, token_id, token_prefix, token_hash, allowed_agents) values ('00000000-0000-4000-8000-0000000000a1','group-a','{label}','{plat}','tok_mvp{key}01','mvp_{key[:4]}','{h[key]}','{{{agent}}}') on conflict (token_hash) do nothing;")
PY
/opt/neighbor-hub/ops/postgres psql -Atqc "select token_id, status from public.devices order by 1"
```

> 注意：MVP 的 `ops/revoke` 只改 `tokens.json`＋Caddy。上線批次之前若要撤銷，**兩邊都要改**：`ops/revoke …` 之後再 `update public.devices set status='revocation_pending', revocation_requested_at=now() where token_id='tok_mvp…01'`（bank-proxy 立即拒絕）。L-03 的 `/revoke` 會把這兩步合一。

Caddy：把 `/memory/*` 從 MVP 的 503 換成 bank-proxy（設定裡**不**覆寫 Authorization，裝置自己的 bearer 原樣送到 bank-proxy）：

```bash
/opt/neighbor-hub/ops/render-caddy --memory-upstream 127.0.0.1:8780
```

**之後每次跑 `ops/render-caddy`、`ops/revoke`、`ops/issue` 都要帶 `--memory-upstream 127.0.0.1:8780`**；沒帶會回到 MVP 的 503（安全方向，但記憶會斷）。

## 6. 驗收（VPS，PM 執行）

1. **TC-21**（需要 Anthropic key）：用 operator `hs` 把 `client/test/fixtures/handoff-1500.txt` retain 進 group-a（`document_id` 用 Mail ID），再用 Mac 的裝置 token 走 `https://hub.example.invalid/memory/mcp/group-a/` 呼叫 `get_document` 與 `recall(include_chunks=true)`。預期兩者的原文 sha256 都是 `5507281a…7fff`。萃取出的事實是否繁體只記錄，不列入通過條件。
2. **隔離**：Mac token 打 `/memory/mcp/group-b/`、`/memory/mcp/`、`/memory/v1/default/banks` → 403；`retain`／`delete_bank` → `TOOL_NOT_ALLOWED`；無 token → 401（Caddy）。
3. **撤銷**：開著 MCP session，把該裝置 `revocation_pending` → 下一個請求 401。
4. **上限**：暫時以 `LLM_DAILY_CAP_MICROS=1` 重建 bank-proxy，觸發一次 retain → Hindsight log 出現 429／`rate_limit_error`，`budget-status` 的 spent 不增加；還原為 500000。
5. **資源**：retain 期間 `docker stats`，記 Hindsight／Postgres／bank-proxy 峰值；`docker inspect … .State.OOMKilled` 三個都 false；`select usename,count(*) from pg_stat_activity group by 1`（hindsight_app ≤12、hub_app ≤3＋其他 app）。記到 `docs/00-DAG.md` L-02 列。

## 7. 備份、回滾

- 每日備份：在 L-01 的 drop-in 加 `Environment="HUB_HINDSIGHT_BACKUP=1"`，同一個 hub-backup tar 會多 `postgres/hindsight.dump` 與 `bank-proxy/llm-ledger.json`，manifest 多 `hindsight` 欄。Hindsight 是可重建的搜尋索引，Mail 仍是正式紀錄；還原後若缺資料，由 bridge 依 Mail ID 補寫。
- 回滾（不刪資料）：`ops/render-caddy`（不帶 `--memory-upstream`）回到 503 → `memc stop` → 保留 volume、DB、秘密。**不用 `down -v`**。完全移除另開清除票（Hindsight 共用 L-01 叢集，不能為刪記憶刪整個 PG volume）。

## 8. 已知限制／待決

- **reflect 不開放**（隱藏 LLM 呼叫，SDS API-04）；專案助理（L-03）要用 reflect 時，改由 bot 經 gateway 自己呼叫，並共用同一本帳。
- **gateway 是唯一硬上限**：Hindsight 若改用別的 provider 或繞過 base_url，就不受管。compose 已固定 provider／base_url；Anthropic Console 的 workspace 上限是第二道保險（需 維護者 設）。
- **Hindsight 預設每次 `max_tokens=64000`**，所以每次呼叫先預留約 0.032 USD，結算後退回差額；`HINDSIGHT_API_LLM_MAX_CONCURRENT=2` 時同時最多預留約 0.064 USD。
- **在 S1 是互信的**：`principal` 只從 DB 對照，不證明背後是哪個人（GAP-13）。
- 本機用 Ollama `qwen2.5:7b` 測 retain，**沒有用 Haiku 5.5 實測**萃取品質與實際成本（要 key）。gateway 的計價／預留／結算由單元測試與假上游覆蓋。
