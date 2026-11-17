# L-07：伺服器端訊息 validator

## 實作前設計（2026-11-17）

基線：分支已 fast-forward master `0dd3531`（包含 `ca0b239`）；讀 SRS §4.4 #6、§4.5 #5、L 批次票與 L-01 runbook。Agent Mail 官方 image 不改，office 不改。

| 方案 | 取捨 |
| --- | --- |
| 只在 client adapter 驗證 | 直接 MCP 可繞過，不符合 SRS |
| Caddy expression／自行列 regex | 無法直接重用完整 gitleaks 規則與 entropy／allowlist 語義；不採用 |
| 每次啟動 gitleaks CLI | 重複編譯規則、process overhead，不利 100 ms 預算 |
| 常駐小代理，直接使用 gitleaks Go library | 採用；一次載入官方 default config，掃描全程只在 RAM，不產 report／暫存訊息 |
| fork Agent Mail | 違反不可改上游的限制 |

路徑：**系統 Caddy → validator → mail-a**。以 opt-in Compose override 把原本 `127.0.0.1:8765` mapping 交給 validator，mail-a 不再 publish host port；Caddy site 與私密 auth snippet 不需變更。代理轉送既有 Authorization、MCP session headers 與串流回應，固定 upstream Host 為 mail-a。後端仍驗 bearer。HubClock 另加 `compose.hubclock-validator.yaml` 改經 validator；只有 Mail 時不加該檔。另保留基本 compose 給未部署 L-07 的 MVP，但開放組員前必須啟用 override 並驗 port。

只開放 `/mcp/`（含無 trailing slash）與唯讀 health；其他 UI／REST 路徑拒絕，避免其他寫入介面繞過。附件路徑、convert_images=true、Markdown/HTML image 語法一律拒絕，且 Mail 的 CONVERT_IMAGES=false，避免讀入尚未掃描的 server 檔案。POST 僅接受單一 JSON-RPC object，拒絕 batch、壓縮 body、duplicate keys、無效 UTF-8／JSON；所有 tools/call 都掃 arguments，涵蓋 send、reply、macro 的文字。sender_token 是協定憑證，不當訊息內容掃描。拒絕發生在任何 upstream HTTP request 之前；錯誤只有固定說明與官方 rule ID，無原文、match、secret、hash、動態欄位路徑。

長度用 Unicode code points：純 body_md 上限 20,000；現有 v1 client envelope 的 `.text` 上限 20,000，JSON 結構與 metadata 不算入 text，其他字串欄位也各有 20,000 上限。掃描會解開 JSON 字串中的 JSON（包含 envelope 與 Unicode escapes），不會因傳輸 escape 漏掃；body 大小及解析深度另設上限。不是 encoded-secret 解碼器，仍遵循 gitleaks 預設的文字掃描範圍。

密鑰規則使用 **gitleaks v8.30.1**，來源 commit `83d9cd684c87d95d656c1458ef04895a7f1cbd8e`，Go module `github.com/zricethezav/gitleaks/v8`；直接呼叫 `detect.NewDetectorDefaultConfig()`，其嵌入的 [官方 config](https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml) 不另寫／抄改 regex。保留官方 global/rule allowlists、entropy 與 keywords；強制 `IgnoreGitleaksAllow=true`，寄件者不能透過 `gitleaks:allow` 自行豁免。[官方 library 實作](https://github.com/gitleaks/gitleaks/blob/v8.30.1/detect/detect.go)。

維護者 額外 allowlist：`/var/lib/neighbor-hub/private/validator/validator-allowlist.json`，0600，唯讀 mount，範例在 repo。只接受指定官方 rule ID＋finding secret 的 SHA-256＋reason，沒有整類規則關閉或寄件者可控 regex；hash 不在拒絕回應中。每次工具呼叫重新讀私密檔，原子換檔後下一次工具呼叫生效（macOS Docker 檔案共享可能短暫不可讀，該段時間拒絕流量；用 readiness probe 等待，絕不重送寫入）；檔案不存在、寬鬆權限或格式錯誤時 fail closed，回 generic unavailable。代理不連 L-01 DB，不存拒絕訊息或 gitleaks finding，不改 Mail／Hindsight schema。

驗證順序：先 Go HTTP tests 紅燈，再實作；local-stack 使用固定 Mail image、真實 Caddy、直接 raw MCP（不經 client validator），核對合法保存／超長與密鑰無 delivery、無 SQLite/archive 原文、allowlist 生效／撤回、office 保持回應；用同一已保存的最大長度訊息交錯成對重送，比較直連與經 validator 的 latency，另記錄首次寫入與重送時 validation 本身耗時。VPS、TLS、office 實站驗收由 PM 審本 runbook 後執行。

## 部署 runbook（PM 審閱後執行；Codex 不登入 VPS）

### 1. 保留現況，建立私密 policy

部署來源必須是 PM 審過的本票 commit，將 `server/validator`、`deploy/validator`、`ops/verify-l07.mjs` 一起交付。沿用 L-01 的資料庫、備份與 token，不跑 init-secrets、不輪替任何憑證。記錄 office 回應／Caddy PID／原 Mail、HubClock 的 image、StartedAt 與所有正式 compose flags，保留目前 code snapshot。只操作 `neighbor-hub` project，不動 `neighbor-hub-db` 或 office。

```bash
cd /opt/neighbor-hub
docker compose version  # 本部署要求 >= 2.24.4，且 config 必須支援 !reset
free -h  # 保留 office 與既有服務的餘裕，再加 validator 的 192 MiB hard budget
systemctl show caddy -p MainPID
curl --fail --silent --output /dev/null --write-out 'office_before=%{http_code}\n' https://office.example.invalid
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
# 不覆寫已存在的 allowlist；由 維護者 維護。
install -d -o 10001 -g 10001 -m 700 /var/lib/neighbor-hub/private/validator
if [ ! -e /var/lib/neighbor-hub/private/validator/validator-allowlist.json ]; then
  install -o 10001 -g 10001 -m 600 server/validator/allowlist.example.json \
    /var/lib/neighbor-hub/private/validator/validator-allowlist.json
fi
stat -c '%u:%g %a %n' /var/lib/neighbor-hub/private/validator /var/lib/neighbor-hub/private/validator/validator-allowlist.json
```

預期 10001:10001、目錄 700／檔案 600。只 mount `private/validator/`，不把整個 private 或 Docker socket 掛入代理。若 HubClock 原來用其他 UID/GID，設定既有 `HUB_OPS_UID/GID`，policy owner 同步為該 UID/GID。目錄 mount 讓原子 rename 可見，單檔 bind mount 會黏住舊 inode。既有 H-06 備份已涵蓋整個 private，policy 會隨之保存，仍須依原加密／600 規則保管。

### 2. 準備 image，確認完整 compose

```bash
# 以下 wrapper 只存在本次 operator shell；之後的 service 操作也必須帶齊這四個檔。
# 若沒有 HubClock，移除第 2、4 個 -f；不要建立缺憑證的 clock service。
export HUB_OPS_UID=10001 HUB_OPS_GID=10001
hc() {
  docker compose -p neighbor-hub \
    -f /opt/neighbor-hub/deploy/compose.yaml \
    -f /opt/neighbor-hub/deploy/hubclock/compose.hubclock.yaml \
    -f /opt/neighbor-hub/deploy/validator/compose.validator.yaml \
    -f /opt/neighbor-hub/deploy/validator/compose.hubclock-validator.yaml "$@"
}
hc config --quiet
hc build validator
# 記錄實際 image ID，不輸出完整 compose config／env／token。
docker image inspect neighbor-hub-validator:l07 --format '{{.Id}} {{.Architecture}}'
```

固定 Go builder digest，Go library 依 `go.mod/go.sum` 下載校驗；runtime 是 scratch，只含 binary 與 gitleaks MIT license，無 shell／報告目錄／額外常駐服務。192 MiB memory＋swap hard cap、GOMEMLIMIT=96MiB soft target、read-only、non-root、drop ALL；無 DB 網路與 DB credential。可在工作站用 `docker build --platform linux/amd64 -t neighbor-hub-validator:l07 server/validator` 先建，依既有 PM 部署通道交付 `docker save` archive 與 SHA-256，VPS `docker load`，避免正式機編譯尖峰；記錄載入 image ID。

`ports: !reset []` 依 [Docker 官方 merge 規格](https://docs.docker.com/reference/compose-file/merge/#reset-value) 清除 Mail 的原 port 列表；切換後以實際 PortBindings 驗收。

**之後不要只用基本 compose 重新 up mail-a**，否則會恢復 MVP 的直接 host mapping。正式部署工具、定時作業與後續票都沿用完整 flags；L-07 是 S2 開放前 gate。`config --quiet` 不會列出 env 秘密；不要把 `config` 或 `docker inspect .Config.Env` 貼回聊天。

### 3. Hub 短暫維護窗切換，office 不重載

原 host port 8765 要由 Mail 交給 validator，因此 **mail-a 會被重建一次**、Hub 暫停數十秒；volume 不變。先停止 HubClock，避免它在切換期間持續呼叫。系統 Caddy、office、Postgres 不重建、不 reload；Caddy upstream 位址與 auth snippet 都維持原值。

```bash
hc stop hubclock  # 若未部署 HubClock，略過
hc up -d --wait --wait-timeout 120 mail-a validator
MAIL_ID=$(hc ps -q mail-a)
VALIDATOR_ID=$(hc ps -q validator)
docker inspect "$MAIL_ID" --format '{{json .HostConfig.PortBindings}}'  # {} 或 null；不得有 host port
docker inspect "$VALIDATOR_ID" --format '{{json .HostConfig.PortBindings}}' # 8766/tcp 只對 127.0.0.1:8765
hc ps
hc stats --no-stream
# 無 token 的公開入口仍應 401。
curl --silent --output /dev/null --write-out 'hub_unauth=%{http_code}\n' https://hub.example.invalid/health/readiness
curl --fail --silent --output /dev/null --write-out 'office_after=%{http_code}\n' https://office.example.invalid
systemctl show caddy -p MainPID
hc up -d --wait --wait-timeout 120 hubclock  # 若未部署，略過
```

核對 office 與 before 一致、Caddy PID 不變。validator readiness 同時要求私密 policy 可用與 Mail readiness 正常；liveness 僅轉送 Mail health。錯誤 policy／缺檔會 503、停止送往 Mail；啟動時 policy 不合格則代理不監聽。healthcheck 是 Mail liveness，用來判斷容器是否運作，不能取代帶 token 的 policy readiness 驗收。若 HubClock 發生 `tick_failed`，先看其固定 event 類別，不放寬權限／Host／token 檢查。核對 clock 的 URL 指向 validator，再確認一次成功 tick。

### 4. 真入口驗收與效能

在已裝 Node ≥22 的 維護者 工作站，用其既有 600 憑證目錄執行（不是讓 VPS 安裝 Node；不將秘密交給 agent）：

```bash
node ops/verify-l07.mjs --url https://hub.example.invalid/mcp/ --credentials-dir /實際的私密憑證目錄
```

該程式直接送 JSON-RPC，合法訊息保存後讀回原文；20,001 中文、20,001 emoji envelope、合成 PAT 與 Unicode escape 版本共 4 次拒絕，檢查 delivery cursor 不變、無密鑰回顯。只產固定 PASS／FAIL，不列 response body 或 token；同組其他 agent 若正在寫入，cursor 會改變，所以驗收須在這個 Hub 維護窗內做。測試會留一則明確標記的合法驗收訊息；正式不修改 allowlist、也不真的保存密鑰。

拒絕的 RPC error code `-32007`／HTTP 200，現有 client 會當作 not_saved、顯示說明；無效 transport 回 400／413／415，policy／busy／upstream 故障回 503。拒絕回應只有類別（官方 rule IDs）與固定說明；數字與正常字串 RPC ID 都保留 correlation；若將 gitleaks 可偵測的密鑰放進字串 ID，直接擋下並用 id=null 回報類別，避免上游錯誤反射該密鑰。ID 是協定欄位，不支援以訊息 allowlist 豁免密鑰型 ID。

合法 POST 的 `Server-Timing: hub_validation;dur=<ms>` 量的是收 body、strict decode、policy read、完整 gitleaks scan，到轉送前的時間，不含 Mail SQLite／Git archive／網路回應。效能驗收同時看這個增量耗時，以及同一 Docker 網路內直連 Mail／經 validator 的 30 對冪等重送，逐對交錯先後順序。首次經 validator 真正保存 20,000 emoji，後續每次 sample 均要求相同 message ID 與 idempotent_replay=true，隔離 Mail 的非同步 Git archive／磁碟寫入抖動，測的是新增驗證與轉送成本。首次真正寫入的 validation duration 也必須 <100 ms。Caddy 不在這個隔離效能量測內，真實 Caddy 的合法保存、拒絕與 office 維持另行驗證。報告逐對增量 p50／p95／max、兩條路徑完整耗時，以及 validator 自身最大耗時。端到端最大值可能含 Mail 磁碟抖動，不把它稱為純 validator 耗時。正式 VPS 的 CPU／磁碟／實際負載與本機不同，PM 在維護窗記錄 header 與原文保存結果，確認 <100 ms 後才開放組員。

### 5. 維護者 維護 allowlist

範例是空清單。必要時用私密 editor 填入：

```json
{
  "entries": [
    {
      "rule_id": "官方錯誤回報的 rule ID",
      "sha256": "該 finding secret 原值之 SHA-256 lowercase hex（64 字）",
      "reason": "由 維護者 說明為何這個確切樣本可豁免"
    }
  ]
}
```

hash 對象是 gitleaks `finding.Secret`（某些規則是 regex capture group），不是整行／整封訊息；一個值若同時命中多類，各類各自明列。不要把真正有效的密鑰加入 allowlist，優先換成無效樣本。密鑰／allowlist 原文不進 Git、argv、history、stdout。以同目錄暫存檔、owner 不變、mode 600 寫好，再原子 rename；先讀帶 token 的 readiness 200，再重送明確被拒絕的原訊息；保存結果未確認者只沿用同一 idempotency key 走既有 outbox 重試，不另建一封。移除例外後下一請求就會擋；規則未知、hash 不符格式／大小寫、空 reason、未知欄位、重複 JSON key、檔案超過 64 KiB 均 fail closed。policy logs 只列固定 `policy-open/stat/read/json/schema/entry/file-mode-or-size`，不記錄條目或錯誤原文。

### 6. 回滾與交接

若 validator 故障，**保持 fail closed，先不開放 S2 組員**。保存目前 private／資料 volume／image ID 與去秘密的收據，修正 policy 或回前一個已驗證 validator image，再 `hc up -d --no-deps --wait validator`；這不需要重啟 Mail 或 Caddy。

若 PM 決定退回部署前 S1 基線：停止 HubClock、停止 validator，以部署前保留的完整 compose flags 重新 up mail-a，讓原 loopback port 回 Mail，再恢復原 HubClock URL／啟動；不要同時讓兩個容器搶 host 8765。此回滾**會移除 L-07 的強制驗證**，S2 gate 必須保持關閉。不做 `down -v`、不回放舊 token registry、不動 office／Caddy／Postgres／全域設定。policy 檔仍保留供修復與原備份。

## 本機重現與證據

```bash
cd server/validator
go test -race -v ./...
go vet ./...
cd ../..
node ops/test/validator-local-stack.mjs
npm --prefix client test
node --test client/test/hub-hook.test.mjs ops/lifecycle/test/lifecycle.test.mjs ops/test/readiness.test.mjs
python3 -m unittest discover -s ops/test -p 'test_hub_ops.py'
```

local-stack 需要 Docker／Compose、Python 3、Node ≥22、native Caddy（`CADDY_BIN`，預設既有 spike binary）；Go 由 pinned Docker builder 執行，不改 host 全域設定。harness 建獨立 `neighbor-l07-*` project，所有秘密在 gitignored `.hub-local/l07/`，finally 只刪自己 project 的容器／網路／volume。保留私密 scratch 作本機診斷，Git 只保存去秘密的收據。拒絕樣本檢查是在加入任何 allowlist 例外之前複製自己的 Mail volume、用 host Python 掃 SQLite dump 與 archive，沒有要求在正式 Mail image 安裝 Python。

固定版本的官方 `config/gitleaks.toml` SHA-256：`e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`（由 v8.30.1 tag 的原檔計算）；程式實際使用 Go module 的嵌入內容，不下載可變 master 規則。額外 allowlist 只放私密目錄；還原備份後由 維護者 核對舊例外是否仍獲准，不能直接恢復已撤回的例外。

### 驗證摘要（2026-11-17，本機；VPS 尚未執行）

- Go TDD：先 pass-through baseline 看到長度／密鑰／allowlist／其他入口失敗，再實作；內嵌重複 key、附件、readiness、timing 也各自保留紅燈收據。`go test -race -v ./...`：**12 pass、0 fail**；`go vet ./...` exit 0。
- 既有單元測試：`npm --prefix client test` **45 pass**；hook／lifecycle／readiness 合計 **71 pass、0 skip**；Python ops **7 pass**，真 Caddy validate 未 skip。
- local-stack：固定 linux/amd64 Mail 與 validator，在 macOS ARM Docker 上執行；合法原文、20,000 emoji、v1 envelope 原文保存／讀回；8 種 raw MCP 拒絕；SQLite＋archive 無拒絕樣本；allowlist 原子更新／撤除、壞 policy 503；未授權 401、其他寫入 API 404；operator probe 另外 4 次拒絕；HubClock 經 validator 成功 tick；合成 office HTTP／內容與 Caddy 程序不變。
- 最大長度隔離量測（80,000 UTF-8 bytes）：首次寫入 validation **5.618 ms**；30 對冪等重送之新增延遲 p50 **5.827 ms**、p95 **7.391 ms**、max **7.844 ms**；重送時 validation max **6.380 ms**。每次都確認原 message ID 與 replay receipt，沒有省略掃描。這是 validator＋轉送的增量測量，**不冒充正式 VPS 新訊息寫入的端到端 SLA**。最初分批／新寫入比較受到 Mail archive IO 明顯抖動，曾超過 100 ms，故保留這個限制並改用固定已保存訊息隔離元件成本；正式負載仍由 PM 在 VPS 補驗。
- 完整既有 MCP 整合：Mail **8**、hook **5**（保留 TC-13 真 15 秒輪詢、雙向各 5 次）、lifecycle **10**，合計 **23 pass、0 fail、0 skip**；每個 suite 都斷言代理零重啟／無 OOM。harness 的 command budget 已提高到 1,200 秒，涵蓋既有 TC-13 的 900 秒 case budget，未縮短測試計時。字串 RPC ID 相容性另以 core acceptance 直接送原生 MCP 覆驗：首次寫入 validation 6.714 ms，30 對新增延遲 p95 8.760 ms、max 8.890 ms，validation max 7.545 ms。
- 收據：[Go tests](evidence/L07-go-tests.txt)、[TDD red](evidence/L07-tdd-red.txt)、[既有單元測試](evidence/L07-existing-unit-tests.txt)、[完整 local-stack／既有 MCP suites](evidence/L07-local-stack-final.txt)、[原生字串 ID core acceptance](evidence/L07-string-id-core.txt)。

gitleaks 測試使用其 [官方 Slack bot token fixture](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/generate/config/rules/slack.go)，另有固定合成 PAT、inline allow 與 Unicode escape 變體；沒有 provider 發出的有效憑證。維持 upstream 的低熵與 global allowlist 行為，不能拿全 `x` 或完整英文字母表當成必須命中的測試樣本。

未完成／交接：PM 審閱並部署本票完整 compose flags、正式 image／owner 核對、VPS 公開 TLS 下的 raw MCP 驗收、真實 office 前後對照與 VPS 增量效能量測；維護者 維護正式 allowlist。S2 gate 在這些正式驗收之前保持關閉；本票未改 master、未 push、未登入 VPS、未修改 Agent Mail source、權限模式或全域設定。

記憶體修正：初始 128 MiB cap 在 AMD64-on-ARM Docker 的長輪詢回歸期間實際出現一次 OOM／exit 137（[紅燈](evidence/L07-memory-red.txt)）；即使功能 suite 通過也不能接受此重啟，因此改為 192 MiB hard cap、96 MiB Go managed-memory soft target，替 runtime／健康檢查／非 Go 記憶體保留空間，並逐 suite 斷言 RestartCount=0 與無 OOM。Go soft limit 不等於 OS RSS hard cap，依 [Go 官方 GC memory-limit 說明](https://go.dev/doc/gc-guide#Memory_limit) 配置；VPS operator 必須重查與記錄共用負載。
