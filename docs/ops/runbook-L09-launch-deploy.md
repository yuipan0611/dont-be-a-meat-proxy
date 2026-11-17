# L-09｜S1 上線單一路徑（PM 在 VPS root 執行）

基線：master `0cc8934`，2026-11-17。此票整合部署程序；本機 Docker 假 VPS 演練不代表 `<VPS_IP>`、真 Discord、Anthropic、OAuth 或 Windows 已驗收。正式結果逐項寫入 [delivery-S1](../delivery-S1.md)。Codex 未登入 VPS、未 push、未修改 master。

**最新上線 gate（已 merge master `101363c`）**：[SRS §4.6](../03-srs.md) 的 維護者 新決策要求 VPS Gemini 訂閱後端，F-11 正在查證/實作；本票原派工與目前 Compose/bot/gateway 仍為 Anthropic。下列已演練的 Anthropic 路徑只能作整合基線，**F-11 完成接線、請求數限額、登入持久化與條款適用性核對之前，不得照此啟動正式 LLM consumers**；不把這次 dry-run 算 Gemini 驗收，也不自行切換 provider。PM 需確認 L09/F11 的接續範圍後才發正式部署令。

部署順序固定為 **1 備份 → 2 schema/私密副本 → 3 建置及新服務 → 4 validator 維護窗 → 5 一次 Caddy 切換 → 6 consumers/排程 → 7 技術檢查 → 人工驗收**。不要再交錯執行舊 runbook 的 reload／render-caddy 指令。

## 操作前交付與秘密

PM 先備份 VPS 舊 `/opt/neighbor-hub` 原始碼／Compose flags，再將審過的完整 commit 交付到該目錄；保留 `/var/lib/neighbor-hub`、現有 Compose project、volume 與秘密。用 `git rev-parse HEAD` 記正式版本；分段中途不得更新原始碼。腳本會鎖住 source fingerprint，拒絕中途換版、跳步與已 PASS 步驟重播。不要用 `git reset --hard` 覆蓋正式機上的未保存變更。

PM 在 Mac 執行（只有 PM 操作 SCP／VPS；下面不顯示檔案內容）：

```sh
ssh root@<VPS_IP> 'install -d -m 700 /var/lib/neighbor-hub/private'
scp ~/.config/hub-discord/bot.token root@<VPS_IP>:/var/lib/neighbor-hub/private/discord.token
scp ~/.config/hub-llm/anthropic.key root@<VPS_IP>:/var/lib/neighbor-hub/private/anthropic.key
ssh root@<VPS_IP> 'chown root:root /var/lib/neighbor-hub/private/discord.token /var/lib/neighbor-hub/private/anthropic.key; chmod 600 /var/lib/neighbor-hub/private/discord.token /var/lib/neighbor-hub/private/anthropic.key'
```

SCP 完成到 chmod 之間視為封閉準備期，不啟動服務。來源檔需 Mac owner-only；不要 `cat`、`echo`、`set -x` 或把秘密放 argv/env_file、Git、驗收收據。來源保留 root:root 600；腳本建立 bot／web／bank-proxy uid 10002 的 0400 專用副本、Hindsight uid 1000 的 0400 副本及 bridge 原有 ops UID 的 0600 副本，不輪替既有值。副本與來源不一致就停下查原因，不覆蓋。

UI 還需要 **Discord OAuth client secret**（不同於 bot token），PM 由 Developer Portal 以同等私密方式放到 `private/discord-client.secret`（root:root 600）。加精確 redirect `https://hub.example.invalid/auth/callback`、identify scope；不變更 Gateway/Interactions Endpoint。先準備 Application ID、guild ID、維護者 user ID、核對過的架構 map（可用 `/opt/neighbor-hub/web/architecture.json`）。UID 1000、10002 不應對應不受信任的 VPS 登入使用者；有衝突先停下規劃 UID，不讓秘密暴露給它們。

**GitHub token 尚無**：bot/web 目錄不可有 github.token；本次清除繼承的 GITHUB_TOKEN/PAT，web GITHUB_TOKEN_FILE 留空以啟動 UI，bot 仍指向缺少的檔案，`/task` 確認後回 E-GITHUB 且不發 API／不新增 Hub task。TC-19 正向維持待驗；不可填假 PAT。取得正式最小權限 token 後另做受控接線與 TC-19，不需要再次部署本輪。

在 VPS 建立 `/etc/neighbor-hub/l09.env`（root:root 600，純 `KEY=value`，不支援 shell expression／引號；**只含非秘密參數**）：

```ini
HUB_DISCORD_GUILD_ID=實際17到20位數字
HUB_DISCORD_APPLICATION_ID=實際17到20位數字
L09_OWNER_DISCORD_ID=實際17到20位數字
HUB_WEB_MAP_FILE=/opt/neighbor-hub/web/architecture.json
```

既有 ops UID/GID 自動從 `private/hubclock.sender.json` 取；不要修改原 clock／Mail 憑證 owner。部署固定 group-a、project `neighbor-hub`／`neighbor-hub-db`／`neighbor-hub-memory`，memory 8780、web 8781、validator 8765，皆只綁 127.0.0.1。正式機使用 image 原平台；本機 arm64 演練才設定 HUB_PG_PLATFORM/HUB_HS_PLATFORM/HUB_VALIDATOR_PLATFORM。

依賴：Linux root、Python 3、Bash、sqlite3、curl、flock/runuser、Docker/Compose ≥2.24.4（實際須解析 !reset）、既有 systemd Caddy／備份服務與 timer、可正常使用的 Postgres 4 migrations。預設檔案契約為 `/etc/caddy/Caddyfile` import `/etc/caddy/hub.caddy`，後者有唯一 `import /etc/caddy/hub-private/auth.caddy`；若現況不同，先由 PM 核對並適配腳本，腳本會拒絕猜測。既有 DB 的 /supabase bind mount 必須已看到這次完整 migrations；若不符，PM 將檔案交付至原 bind source（保留目錄 inode），不為換路徑重建 DB。不輸出完整 Compose config／Docker .Config.Env／Caddy 錯誤，這些可能含秘密。

## 每步共通規則與證據

```sh
cd /opt/neighbor-hub
ops/deploy-l09.sh --step 1   # 依序 1..7，一次只做一段
# 每段 stdout 只有固定證據、非秘密計數與 STEP N PASS/FAIL；exit 0 才能進下一段。
# 原始 journal/備份均 root-only，不把包含秘密的 /etc/caddy snapshot 上傳 Git。
```

journal：`/var/lib/neighbor-hub/l09/journal.json`，保存來源 fingerprint、步驟、保護容器 ID/StartedAt、備份路徑及 reload barrier。每次 invocation 同時持有 launch.lock 與全組 applier global.lock，杜絕並行 writer。僅把終端固定 PASS/FAIL 與去秘密的驗收證據回填文件，不貼 private、backup archive 或原始 inspect。

步驟失敗預設停在當前狀態，不假裝全交易回滾。未 PASS 段可能有可保留的資源；先依下面對應處置後再重跑。**不要刪 journal、回復舊 DB、重發 reload、用 blanket compose up 或 down -v 來消除錯誤**。第一次成功前需保留 S2／新組使用者入口關閉，測試維護窗不讓其他人同時寫入。

## 1｜盤點、凍結 writer、全備份與還原演練

前置：office 正常、既有 Mail/HubClock/PG 三者在線、token/key/OAuth secret 就位、8780/8781 空閒、舊 bot 尚未跑。原始碼與 Caddy 的部署前副本已保存。

先保存現有排程狀態（只有 unit 名稱／狀態，不含秘密），用於取消部署時恢復原先啟用者：

```sh
systemctl list-unit-files 'hub-token-applier*' --no-pager
systemctl list-units --all 'hub-token-applier*' --no-pager
```

執行 `ops/deploy-l09.sh --step 1`。它檢查 office 200、Hub 無 token 401，記三個既有容器 ID/StartedAt，量 `/proc/meminfo` MemAvailable 與 Docker 磁碟。Hindsight 已知約 **1.7 GiB RSS**、cap 2 GiB；本程序設最少 **3584 MiB available、12 GiB 磁碟** 作保守啟動門檻，仍須正式尖峰負載驗證，不能拿當時總 RAM 8 GB 當餘裕。

腳本只停用存在的 legacy applier path/timer 與 group-a timer，確認兩種 applier service 不在執行；整輪期間不准有其他手動 writer。存 `/etc/caddy` 私密副本，執行 `HUB_PG_BACKUP=1 ops/backup`（沿用既有 SQLite／clock／private），核對 hub.dump 的 manifest hash、pg_restore --list，真正還原至 **hub_l09_restore**，核對 ledger 數，再 drop 測試 DB。沒有對正式 hub 跑 seed。

預期證據：`office_http=200`、MemAvailable/free 數值、`restore_migrations=4`（若正式機已提前有 schema，應與來源 ledger 相等）、`backup_restore=...PASS`、保護容器 IDs+StartedAt unchanged、`STEP 1 PASS`。

失敗回復：不執行 migration；保留備份與原始碼副本。若 restore DB 留下，先確認名字與沒有 app 連線，再刪 **hub_l09_restore**，不可 drop hub。writer 已停者維持停，決定取消此次部署時才恢復先前實際啟用的 unit（不得無條件全 enable）；Mail／clock／PG／office 都不需重建。

## 2｜schema 5～8、正式 owner/link、隔離秘密與 Hindsight DB

前置：步驟 1 PASS／可還原備份。執行 `ops/deploy-l09.sh --step 2`。

`ops/postgres migrate` 只 exec 既有 L-01 db，不 up/recreate db。20261117000000～20261118000000 四檔 SKIP，預期 APPLY：

| 序 | Migration |
|---|---|
| 5 | 20261119000000_l03_discord_bot.sql |
| 6 | 20261120000000_l05_decisions.sql |
| 7 | 20261121000000_l08_group_boundaries.sql |
| 8 | 20261122000000_l08_l05_decision_groups.sql |

再次 migrate 必須全 SKIP、ledger=8。checksum 漂移會拒絕，業務 migration batch 有 transaction/advisory lock；不要編輯已套檔。

建立/核對 group-a、維護者 active owner、唯一 active Discord link，設 bank_id=group-a；不 seed 測試成員。建立專用秘密與 state 目錄（不同 container 只 mount 自己必要檔案），空 validator policy 不覆寫既有 維護者 allowlist。`ops/postgres hindsight-init` 在同一 L-01 cluster 建 hindsight database／hindsight_app、vector，保留密碼，驗 `hindsight_app→hub`、`hub_app→hindsight`、PUBLIC→hindsight 的 CONNECT 都是 false。

預期：各 APPLY/SKIP、`migrations_total=8`、`secrets_and_db=...cross DB CONNECT denied`、三個原容器不變、STEP 2 PASS。

失敗回復：留 schema、audit、秘密與 volume，先修正前置後重跑此段；不要把 pending/revoked 裝置改 active。migration 失敗先查 checksum／SQL，優先 forward migration；若確需資料回復，停止本輪新 DB consumers，走 [L-01 §5](runbook-L01-postgres.md) 隔離 restore／改名程序，重新核對所有已撤銷 token，絕不直接 pg_restore --clean 正式 hub。

## 3｜先建新服務，不動既有 Mail/clock

前置：步驟 2 PASS、下載／編譯時資源仍足夠。執行 `ops/deploy-l09.sh --step 3`。

建 bank-proxy、validator、bot、web images；pull Hindsight；啟動獨立 `neighbor-hub-memory` 的 hindsight/bank-proxy（health 等待 600 秒，首次模型下載可能較久），在容器內建立 group-a bank，不花 LLM 費用。web 用 8781、HUB_WEB_MAP_FILE 實際接到 WEB_MAP_FILE，鏡像會建 source snapshot。啟動 web 用 `--no-deps`；bot 僅 run --no-deps check-config，尚不連 Discord。`ops/bootstrap` 用既有 loopback Mail 註冊 MemoryBridge，保留已有 Mac／Windows／HubClock sender，不輪替憑證。原容器每段前後都比對。

預期：Hindsight/bank-proxy healthy、`http://127.0.0.1:8781/explorer.js` 200、bot config OK、office 200、IDs+StartedAt unchanged、STEP 3 PASS。

失敗回復：只 stop 新 web／memory，保留 Hindsight volume、DB／ledger。修復後重跑未 PASS 段；不重建 DB、Mail 或 clock，不開放 8780/8781 firewall。

## 4｜唯一 Mail/HubClock 維護窗（明確例外）

前置：步驟 3 PASS、已有 image、正式訊息寫入暫停。執行 `ops/deploy-l09.sh --step 4`。

L-07 `ports: !reset []` 必須從 raw Mail 移除 host 8765，且設定 CONVERT_IMAGES=false；Docker 不能原地更改 PortBindings，因此 **mail-a 需重建一次**（同 volume）。HubClock 的 HUBCLOCK_MAIL_URL 改成 validator:8766，環境變更因此 **hubclock 需重建一次**（同 state/sender）；先 stop clock，up mail-a/validator 完成後再 up clock。這是本輪僅有的兩個原容器例外；其他段落必須沿用它們新的 StartedAt。PG 不重建、Caddy 此段不 reload，office 保持 200。

預期：Mail PortBindings={}／null，validator 只有 `8766/tcp→127.0.0.1:8765`，帶 upstream credential 的 validator `/health/readiness` 200；保存新的 mail/clock IDs+StartedAt、PG 不變、STEP 4 PASS。真正寫入驗收另由 PM 工作站跑 `node ops/verify-l07.mjs --url https://hub.example.invalid/mcp/ --credentials-dir <私密目錄>`，保留合法原文與拒絕／<100ms 證據。

失敗回復：預設保持 fail-closed，修 policy／validator 後 `up -d --no-deps --wait validator`。若連維護窗都不能完成，停止 clock，依部署前完整 flags 恢復 Mail 原 loopback mapping，再恢復原 clock；這是**另一次故障回復重建**，需記原因且 S2 gate 保持關閉。不得讓 raw Mail／validator 同時搶 port，也不得用只含 base Compose 的 up 無意移除 validator。

## 5｜import-mvp 與一次 Caddy reload

前置：步驟 4 PASS、全部 token writer 關閉、spool requests 為空、沒有同時 /connect/revoke。執行 `ops/deploy-l09.sh --step 5`。

`ops/token-applier import-mvp --prepare-only` 將既有 Mac／Windows 原 token 的 hash、allowed_agents 收編至 DB（原值只進 root-only tokens-db），在**尚未被引用**的 `/etc/caddy/hub-private/group-a/auth.caddy` 準備 DB allowlist；不呼叫 validate/reload/probe，不宣稱啟用完成。db-authority marker 立即擋 legacy render-caddy/issue/revoke，避免另一個工具覆蓋收編結果。任一 token 已 pending/revoked 就中止，不復活。

同次準備 group-a/web.routes（含 `/explorer.js`，指向 8781）；只替換既有 hub.caddy 唯一 auth import 成 route：先 web handle、再 fallback DB auth；保留 hub 原 TLS 內容，`/memory` 指向 8780，MCP 上游 8765 已是 validator。**根 Caddyfile 與 office block 完全不改**。以 **caddy 服務使用者**對完整 `/etc/caddy/Caddyfile` 執行 `caddy validate --adapter caddyfile`（含所有 office imports 與權限），成功才持久寫 reload_attempted barrier，然後唯一一次 `systemctl reload caddy`。

預期：`caddy_validate=PASS`、`launch_reload_count=1`、MVP Mac+Windows 公開 readiness 200、無 token MCP/memory 401、首頁/explorer 200、/api/architecture 無 session 401、合法 Mac token 對他 bank 403（證實 memory 路由與 DB 查驗）、office 200、STEP 5 PASS。不把 token 或 Caddy private stderr 印出來。

validate 失敗：自動還原原 hub.caddy，**不 reload**，保留 inactive 新檔／DB import 供修復，legacy writer 仍不可用；修後可重跑未 PASS 的步驟 5。reload 失敗／timeout／probe 失敗：保留 reload_attempted，拒絕自動重試；reload 失敗會還原磁碟 site，但 running config 需 PM 實查，不能當它沒生效。此時保持 bot/timer 停止、不要反覆 reload。

緊急回復由 PM 明確執行：先暫停新入口與 consumer，**核對目前 DB 撤銷狀態**；若本輪尚無新 token／撤銷，可從 `l09/caddy-before/hub.caddy` 恢復 site，`runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 成功後再 reload。這是有紀錄的**事故回復第二次 reload**，不是正常流程的一部分；舊 allowlist 已不符合 DB 時不得回放舊 snippet，應由 TokenApplier 產生現況 allowlist。office 回復後仍需 200；不刪 db-authority，不改回 legacy render-caddy。

## 6｜啟用 TokenApplier、bot、bridge 與完整備份

前置：步驟 5 PASS、公開 probe 正常、spool requests 仍空。執行 `ops/deploy-l09.sh --step 6`。

安裝 group template timer/service；group-a drop-in 明確指向**既有** private／token-spool 路徑，重設 ReadWritePaths，避免 stock template 的 groups/%i 假設導致 sandbox 啟動失敗。legacy 單組 path/timer 保持 disabled。新 timer 每 5 秒 process（與目前 template 一致），共用 global.lock；**之後正常 /connect/revoke 的 reload 屬憑證管理，不計入本輪部署唯一一次 reload**。

register-commands 是此部署的明確外部操作，會在指定 guild 註冊目前 bot 定義（connect/revoke/status/task/decision 等依版本）；再 `up -d --no-deps bot memory-bridge`，不重建 Mail/clock。bridge 走 validator（本輪會另外覆蓋 bridge 的 MAIL URL），只索引 Mail 的 handoff/decision，原文保存成功才記 indexed。client 須設 `memory_agent` 為實際 bootstrap 名稱；舊訊息按 Mail ID reindex，不重送 Mail，不把歷史自動算已索引。

安裝 backup service drop-in：HUB_PG_BACKUP=1、HUB_HINDSIGHT_BACKUP=1，同一每日 archive 保含 hub/hindsight dump、private、clock、bank-proxy ledger。本票另納入 memory-bridge/*.json（排除 live locks）；JSON 原子換檔，與 Mail／DB 非跨系統交易一致快照。恢復 bridge 時停 writer、從 archive/memory-bridge 原 owner 600 還原 JSON，刪 runtime lease，unknown 狀態按同 document ID 查明後補寫。啟動**真 systemd hub-backup.service**驗 sandbox，不用單次 CLI 成功冒充 systemd。

預期：group-a timer active、legacy writers disabled、bot/bridge running、backup Result=success、office 200、保護容器 IDs+StartedAt unchanged、STEP 6 PASS。由 PM 檢查安全 event logs 的 ready/tick（不貼原始 response／credentials），journalctl 的 request receipt 與 audit 對應。

失敗回復：只 stop 新 bot/memory-bridge、disable group-a timer；保留 DB authority、audit、private、spool/receipts，已 pending 撤銷需完成，不回 active。備份 failure 先修 sandbox/路徑，不接受缺 PG/hindsight 的「成功」archive；不移除原備份 timer。此時也不自動 reload Caddy。

接管後若需 operator 手動重產，必須與 service 使用同一組路徑及全域鎖（這是憑證維運 reload，不在本輪正常部署再執行）：

```sh
flock /var/lib/neighbor-hub/applier-lock/global.lock /opt/neighbor-hub/ops/token-applier render \
  --group-id group-a --state /var/lib/neighbor-hub/private \
  --token-dir /var/lib/neighbor-hub/private/tokens-db --spool /var/lib/neighbor-hub/token-spool \
  --output /etc/caddy/hub-private/group-a/auth.caddy --upstream 127.0.0.1:8765 \
  --memory-upstream 127.0.0.1:8780 --probe-url https://hub.example.invalid/health/liveness
```

不可省略 --output；舊預設 `/etc/caddy/hub-private/auth.caddy` 在本輪之後已不是 active import。

## 7｜技術收尾與真人驗收

前置：步驟 6 PASS。執行 `ops/deploy-l09.sh --step 7`。預期完整八服務 running、RestartCount=0、OOMKilled=false、office 200、原容器不再改變；STEP 7 PASS **只代表當下技術檢查**。不把 idle RSS 當尖峰、不把 fixture／單元測試當正式驗收。

PM 接著記 `free -h`、`docker stats --no-stream`，在 retain 與 web 十人並發／持續更新時取樣，確認 Hindsight/PG/validator/bot/web 都無 OOM／重啟，保留主機 MemAvailable 最低值、PG pool 實際 usename/count。8 GB 全 stack＋office 需有餘裕。失敗只停新負載／consumer，修後重驗，不調高上限掩蓋問題。

交付清單已接 [delivery-S1](../delivery-S1.md)：TC-14 **VPS 真雙組**、TC-16～18 真 Discord、TC-19 缺 GitHub 的 fail-closed 與後續正向、TC-20 決策、TC-21 bridge 原文 sha256／繁中、真 OAuth、既有 Mac↔Windows/action/revoke 回歸、三位新手與完整資源預算。新組另依 [L-08](L08-group-isolation.md) 使用獨立 project／volume／hostname／tokens；本輪不為驗收偷偷建立正式第二組或 seed 測試身份，PM 應先選核准的隔離驗收組再測。

## 來源與本機證據

實際 owning runbook：[L-01](runbook-L01-postgres.md)、[L-02](runbook-L02-memory.md)、[L-02b](L02b-memory-bridge.md)、[L-03/L-03b](runbook-L03-discord.md)、[L-04](L04-task-github.md)、[L-07](L07-validator.md)、[L-08](L08-group-isolation.md)、[UI](runbook-UI-guide.md)、[架構工作台](../10-architecture-workbench.md)。本文件是這一輪的唯一順序，舊文的 schema=5、web port=8780、各自 reload 與 legacy render-caddy 指令不適用本輪。

本機重現：`bash ops/test/l09-dry-run.sh`；收據見 [L09-launch-dry-run.txt](evidence/L09-launch-dry-run.txt)。假的僅是 VPS 的 systemd adapter、Discord provider 及 Hindsight provider fixture（不花 LLM 費用）；真 Docker Compose／PG migrations+restore／Caddy validate+reload／Mail／validator／bank-proxy／web 與 Linux owner/mode 確實執行。validator 先在外層 Docker 從本次 source 建置再載入假 VPS（內層 go mod download 曾 exit 1），不是替身 binary；正式 VPS 的 build/download 可用性仍待 PM。fixture 範圍與未驗項必須與輸出一起保存，不可宣稱真服務驗收。
