# P-3 上線前安全與正確性交叉審查

日期：2026-11-18（Asia/Taipei）。審查者：Codex，獨立執行，沒有 helper worker。

**結論：暫不建議開放正式 token 發放與決策確認；R-04 已於後續修正，R-05 仍會在 Mail 同步失敗後回覆決策成功。** 共 10 項：阻擋上線 5 項（本分支已修 4、未修 1）、上線後修 3 項、建議 2 項。以下「已修」僅表示本分支的本機證據，不表示 master 已整合或 VPS 已套用。

## 審查版本與方法

- master 固定為 `2d37280deaea695b16ff3ff58aba4488ddd1700a`；工作區起點 `e93e18e6c7829a9c3f1c4b7693a9c0a213dddb37`，兩者只有 `docs/00-DAG.md` 派工文字差異，審查範圍內程式碼相同。
- 範圍：`deploy/`、`ops/`、`client/`、`bot/`、`ops/llm-gateway/`、`ops/bank-proxy/`、`ops/memory-bridge/`、`server/validator/`、全部 8 份 `supabase/migrations/`；另追查 Caddy 公開 `/api/*` 的唯讀 web 路由。
- 靜態追蹤認證／資料流，執行本機 Node、Python、Go、真 Postgres／Caddy 測試；以鎖定的正式 Mail image 做額外決策寫回重現。未接真 VPS、未 push、未用 spikes 執行檔、未讀真 provider key、未呼叫真 Discord／LLM，未改其他 worktree。
- 檔案行號以受審 master 為準；已修項目另外列本分支測試與 commit。證據：[pre-launch-security-evidence.txt](pre-launch-security-evidence.txt)。診斷腳本只用合成資料，輸出已知問題的觀察值，**不是通過驗收的測試套件**。

| ID | 嚴重度 | 發現 | 狀態 |
| --- | --- | --- | --- |
| R-01 | 阻擋上線 | 備份／還原對 JSON cursor 使用 shell eval | 已修 `91b6959` |
| R-02 | 阻擋上線 | L09 拒絕文件指定的 Groq 模型名稱 | 已修 `1afbba2` |
| R-03 | 阻擋上線 | L09 探測跟隨 redirect 並轉送 Bearer | 已修 `68d901e` |
| R-04 | 阻擋上線 | 發放失敗／逾時後 Caddy token 可能仍有效 | 已修，見後續修正 |
| R-05 | 阻擋上線 | 決策回覆成功但 Mail 寫回失敗，bot writer 未完整接線 | 未修；啟用相關寫入前必須處理 |
| R-06 | 上線後修 | query 與上游錯誤原文進入 log／狀態 | 未修 |
| R-07 | 上線後修 | client 本機全文暫存未限制 600／700 | 未修 |
| R-08 | 上線後修 | task 確認沒有重查有效成員或檢查期限 | 未修；目前 L09 無 GitHub token |
| R-09 | 建議 | LLM ledger 未驗證 JSON counter 型別 | 未修 |
| R-10 | 建議 | bridge 缺少 bank 與群組身份的啟動一致性檢查 | 未修；S2 前加 guard |

## 阻擋上線

### R-01｜JSON cursor 可在 root 備份／還原時執行 shell

- **位置：** `ops/backup:206`、`ops/restore:255`；root 執行路徑見 `ops/templates/hub-backup.service:8`。
- **情境與影響：** 能改寫 HubClock state 的服務 UID，或提供被操作員採用的備份資料者，將 cursor 設為字串 `$(touch /tmp/<合成測試標記>)`。`JSON.stringify` 仍保留 `$()`；輸出再交給 shell `eval`，命令以備份／還原程序身份執行，可能跨出 Hub 影響 office。這是本機資料到 root 的信任邊界，不是宣稱一般成員僅靠正常 Mail 就能控制 cursor。
- **重現：** 新增 `ops/test/test_backup_shell_safety.py`，對真實 shell scripts 和一次性 SQLite／JSON fixture 執行；修前 backup 與 restore 兩個測試均產生 marker、assertion FAIL。restore 測試使用 script 本來支援的解開目錄輸入；cursor 的 hash 原先也沒有被還原流程驗證。
- **修法與結果：** 移除兩處 eval，cursor 僅接受非負 safe integer，其他型別在摘要顯示 null；備份採 `read -r`、還原採普通 command substitution。全文 state 保留為資料；沒有變更正式路徑、owner、Caddy reload 或 office。
- **TDD／commit：** 兩個失敗測試轉綠，Python 全套與 shell syntax 通過；獨立 commit **`91b6959`**。

### R-02｜照 L09 文件設定 Groq 時，第一步必定拒絕

- **位置：** `ops/l09_launch.py:523`；指定值見 `docs/ops/runbook-L09-launch-deploy.md:36`。
- **情境與影響：** `HUB_LLM_UPSTREAM_MODEL=openai/gpt-oss-120b` 含 slash，模型專用 regex 卻不接受 `/`，所有 step 都在 config parse 時失敗，尚未進實際部署。省略該設定恰好走 default 並不能使文件流程成立。
- **重現：** `test_documented_groq_model_reaches_launch_step` 經真 `main()` parser，僅替換 root／鎖／部署副作用邊界；修前輸出 `STEP 1 FAIL; invalid/non-allowlisted non-secret config`，回傳 1 而非 0。
- **修法與結果：** 原有模型字元集合加上 `/`，保留 key allowlist、長度限制與所有其他安全檢查；不放行 shell meta characters。
- **TDD／commit：** 該測試轉綠，原 4 個 gateway launch 測試也通過；獨立 commit **`1afbba2`**。

### R-03｜L09 帶憑證探測會跟隨 redirect，並錯認目的地狀態

- **位置：** `ops/l09_launch.py:129`，敏感呼叫見 `ops/l09_launch.py:417`。
- **情境與影響：** 若被探測 Hub 路由因設定錯誤或受控上游回傳 302，預設 `urllib.request.urlopen` 會將 Authorization 帶到重新導向位置；原端點的 302 也可能被最終 200 掩蓋。此 helper 會攜帶 upstream／MVP token，並使用 Python 繼承的 proxy 設定。這是部署探測錯誤處理，不是已觀測到正式站外洩。
- **重現：** 本機兩個路由 `/redirect` → `/destination`，修前 destination 收到合成 Bearer，測試 FAIL。另以不同 loopback port 驗證修後不跟隨跨 origin redirect。
- **修法與結果：** 建立不跟隨 redirect 且 `ProxyHandler({})` 的 opener；直接回報原始 302，關閉 HTTPError response；保留既有固定錯誤輸出，不加入 response body。
- **TDD／commit：** `ops/test/test_l09_probe_security.py` 由失敗轉綠，修後跨 origin probe 為 `302 destination_requests=0`；獨立 commit **`68d901e`**。

### R-04｜發放失敗或晚到的成功回執，可能留下 DB 不再允許的 Caddy token

- **位置：** `ops/token_applier.py:269`、`ops/token_applier.py:237`、`ops/token_applier.py:313`；bot 路徑 `bot/src/connect.mjs:41`、`bot/src/token-applier.mjs:45`。
- **已重現情境：** 原 MVP tokens 全撤銷，發放唯一新 token；Caddy validate／reload 成功，但新 token probe 回 503。`handle_issue` 把 DB 改為 revocation_pending、刪 credential，再呼叫 `settle(cfg, db, {})`；desired tokens 已空，與傳入的空集合相等，因此不重 render／reload，剛套用的 token 還在 snippet。
- **具體證據：** 真 `process()`／`apply()` 搭配既有 unit 的假 Caddy／probe fixture，得到 `[(lateprobe, failed)] DB=revocation_pending token_still_in_Caddy_snippet=True reloads=1`。這證明程式產生的 allowlist 與 DB 相反；未冒稱已在 VPS 實測舊 token。
- **另一個時序缺口：** helper 在 30 秒 bot timeout 前已套用並完成最後一次 settle，之後 bot 才將 DB row 改 pending；`connect()` 沒排新的 revoke，`process()` 只跑 spool request，沒有定期依 DB 對帳。若 receipt 晚到／遺失，token 可留在載入的 Caddy config；bank-proxy 的每次 DB 查詢只能阻擋 memory，無法阻擋 Mail。
- **建議修法：** 持久化待撤銷／補償工作並重試到 Caddy 401 證據成立；定期以 DB desired state 對帳，明確處理已載入 config 與失敗的 probe／reload；發放回覆不能把 DB pending 當入口已拒絕。對最後一把 token、空集合、晚回執、helper crash 與 bot timeout 的交錯補 integration tests。
- **未修原因：** 單改空集合比較只能修一個分支，仍留下跨程序 late-receipt race；需要 bot、spool、applier 的完整補償契約。交由 PM 派工，未以局部 patch 宣稱 fail-closed 完成。

### R-05｜決策的成功訊息早於真正 Mail 寫回，writer 身份也尚未接好

- **位置：** `bot/src/decisions.mjs:101`、`bot/src/decisions.mjs:126`、`bot/src/decisions.mjs:143`、`bot/src/decisions.mjs:153`；共用 reader 建立於 `bot/src/main.mjs:62`，task 的寫回錯誤也在 `bot/src/task.mjs:149` 被吞下。
- **重現：** `node docs/reviews/pre-launch-mail-reproduce.mjs`，用正式 digest Mail image、合成 draft #1 和假的 owner interaction：DB 已 confirmed、出現 `decision.mail_sync_error`、使用者仍收到正式決策確認；真正 Mail 回傳 **INVALID_THREAD_ID**。再改成合法 thread 做獨立 writer probe，`sender_name=HubBot` 得 **DESCRIPTIVE_NAME**，顯示硬編碼名稱不是可用的註冊 writer。
- **影響：** DB／Discord 與 Mail 分歧，author agent 沒收到狀態。共用 client 沒載入註冊 writer 的 sender token；decision send 也沒有持久化 idempotency key。task 雖保留已建立的 GitHub Issue，卻未告知 Hub 同步失敗。L09 明訂無 GitHub token、TC-19 success path 待驗，因此不把既有 E-GITHUB gate 本身列為缺陷。
- **建議修法：** 註冊並掛入專用 canonical bot sender／token；合法 thread 與穩定 idempotency key；以 durable outbox 重試、呈現「已確認／待同步」，直到 Mail 收據成功。新增 writer 後走 validator，不能沿用目前 reader 直連 raw Mail 的 URL 來繞過秘密掃描。

## 上線後修

### R-06｜未消毒的 query／上游錯誤原文進入營運資料

- **位置：** `ops/bank-proxy/bank-proxy.mjs:100`；`ops/memory-bridge/hindsight-client.mjs:19`、`:49` → `ops/memory-bridge/bridge.mjs:123` → `ops/memory-bridge/main.mjs:70`。
- **重現：** 有效的合成 device token 請求 `/mcp/group-b/?key=SYNTHETIC_QUERY_SECRET`，拒絕日誌仍保存完整 query。另用本機 Hindsight fixture 回 500 並在 body 放合成 secret，client 的 Error.message 包含它；bridge 會保存成 lastError，status 命令再印出。
- **證據：** `node docs/reviews/pre-launch-reproduce.mjs` 印出 `bank-proxy_query_persisted_in_log=true`、`bridge_error_contains_backend_body=true`。沒有拿真 key 驗證外洩，也不假定 Hindsight 每次錯誤都會回顯 master key。
- **建議修法：** path 只記路由類別或 pathname，刪 query；upstream 錯誤只保留 status／固定分類，`success:false` 同樣不拼接 JSON 原文；清理已存入 lastError 的歷史資料。

### R-07｜client staging／outbox／journal 的權限依賴使用者 umask

- **位置：** `client/hub-hook.mjs:96`、`:106`、`:111`；`client/mail-client.mjs:431`、`:433`。
- **情境與證據：** 新的 data root、umask 022、Hub 暫時離線，checkpoint 將完整交接寫入 outbox。診斷結果 `client_data_mode=755 outbox_mode=644 contains_private_text=true`。staging 原文也採預設模式；若上層路徑可被其他本機帳號 traversable，就可讀專案資料。這不是已證明 token 被寫入 outbox。
- **建議修法：** Unix data／staging／outbox／session 目錄 0700、檔案與 hook.log 0600，既有路徑驗 owner／mode；Windows 另驗使用者 ACL。不要只依賴 home 目錄剛好封閉。

### R-08｜task 確認只比對原發起人，未重查成員有效性或期限

- **位置：** `bot/src/router.mjs:71`、`bot/src/task.mjs:74`、`:100`、`:108`。
- **重現：** stage 合法 task 後，把建立時間設為過期值、撤銷成員；同一 Discord user 點 confirm，仍呼叫 GitHub。診斷為 `expired_revoked_task_issue_created=true membership_checks=0`。這裡 GitHub 是本機 fake，沒有建立真 Issue。
- **影響與界線：** task 的原發起人驗證和同步刪除 pending 可以擋陌生人與連點；但無法撤回先前已 stage 的操作權限。只有配置了 GitHub writer token 才有實際外部副作用，L09 此次刻意缺該 token。
- **建議修法：** confirm 時依 instance group／guild 重新查 active membership，加短 TTL，將過期／撤銷結果 ephemeral 回覆；仍在首次 await 外先 claim action，避免修正時引入並發重放。

## 建議

### R-09｜LLM ledger JSON 應驗 schema，再視為可信的預算證據

- **位置：** `ops/bank-proxy/budget.mjs:76`、`:82`、`:116`，由 `ops/llm-gateway/request-budget.mjs:7` 使用。
- **重現：** 私有 ledger 的今日 spentMicros 設為字串 `invalid`，dailyLimit=1；真 reserve／charge 連做三次全部准入，因 JavaScript 的非數字比較不會觸發上限分支。診斷 `malformed_ledger_daily_limit=1 allowed=3`。
- **界線：** 正常 HTTP caller 不能改 0700 state／0600 ledger；正常程式輸出也不是這個型別，因此列為損壞／不正確還原的防護建議，不是遠端 member 可直接繞過的洞。
- **建議修法：** 驗 v、days／open 的 shape、日界與非負 safe integer counter；拒絕損壞或不支援版本，交由 operator 對帳。保留 unknown reservation 全額計數原則。

### R-10｜bridge bank／project／state 的跨組一致性應由程式擋下

- **位置：** `deploy/memory-bridge/compose.bridge.yaml:23`、`:36`；`ops/memory-bridge/main.mjs:80`、`:83`；`ops/memory-bridge/bridge.mjs:119`。
- **可重現配置：** 沿用 override 啟動另一組的 sender/private dir，卻未另外覆寫 bank／state，仍得到 group-a 與原 state 預設；`main()` 不比對 sender.projectKey 與 bank 就傳入 retain。若兩組 Hindsight 共用 DB／tenant key，錯 bank 會造成混組寫入；不同 Hindsight instance 也不能取代此檢查。
- **界線：** `docs/ops/L08-group-isolation.md:49` 已明令不能直接複用 group-a 預設，L09 driver 也固定單一 group-a。此項是避免操作配置失誤的建議，**不宣稱目前 S1 已發生跨組資料外洩**。
- **建議修法：** bank／state 必填或由經驗證的群組配置導出；啟動時核對 sender project、group、bank，拒絕 mismatch；S2 加兩個實際 bridge 的負面測試。

## 已確認的防線與限制

- **Git 秘密：** Gitleaks **8.30.1** 對固定 master 的受審路徑完整可達歷史執行 redacted scan，50 commits、約 1.22 MB、20 個命中。逐一定位均為合成 PAT／公開 scanner Slack sample、固定假 credential／UUID、測試 Discord ID；未發現可確認的真憑證。這不是自訂 token 格式、外部檔案或所有未審路徑的無秘密保證；報告未收錄原值。
- **入口／port：** 完整 L09 Compose 順序含 validator `ports: !reset []`，raw Mail 不 publish；validator／bank-proxy／web 僅綁 loopback 8765／8780／8781；PG、Hindsight、gateway 沒有 host port。Caddy 的非 web authenticated fallback 指向 validator；公開 `/api/*` 交由 web session／membership 驗證且拒絕寫入。bot 仍持有 raw Mail reader 能力，R-05 修 writer 時必須處理。
- **RLS／跨組：** migrations 對 14 個 public base tables 開 RLS，anon／authenticated 無業務 grant／policy；hub_app 繼承 service_role、BYPASSRLS 是既有設計，不是資料庫級每組隔離。真 PG integration 驗證 bound-group store、registry、decision ID 隔離與 composite FK；member-facing API 仍必須維持所有 SQL group 限制。
- **Discord：** slash command 預設 ephemeral、membership 查詢固定 instance group；task 按鈕驗發起人，pending 在副作用前同步移除；decision 驗 active owner，DB update 以 draft predicate 原子拒絕第二次處理。DM 失敗不改公開頻道，unknown per-item 不直接重送；這些是本機邏輯證據，未登入真 Discord 做 TC-16～20。
- **LLM：** gateway 先認 internal key、固定模型、FIFO，reserve 持久化後才呼叫；未知結果不退款，正常 cap／crash／日界測試通過。bot 僅掛 recent_items／get_item，groupId 來自 server context，未知工具不執行；gateway 只回工具呼叫，不持有資料庫寫入工具。未發現單靠 prompt injection 可選其他 group 或掛入 writer 的路徑；不保證模型文字本身不可被注入或事實判斷永遠正確。
- **花費：** F-11 已明訂取消舊 USD 0.50/day 保證，正式 gate 是每日共用 500 個 backend invocations；此審查不把舊的 USD ledger 當成 Groq 花費上限。Groq Console spend／帳號配額與資料保留設定仍由 PM 確認；沒有在本任務登入或消費。
- **部署／office：** driver 不綁 8421、不 restart Caddy，不 blanket up／down 正式 stack；完整 site validate 後才單次 reload，有 source fingerprint、journal barrier、既有容器 identity、備份／隔離 restore 與 office HTTP check。失敗流程是停止並按 runbook 人工恢復，不是全交易自動 rollback；R-01 說明為何 root ops 仍需資料邊界防護。未驗真 VPS 的 Caddy、TLS、防火牆、systemd／office 8421 或 RAM 尖峰。

## 驗證收據與交付

| 檢查 | 結果 |
| --- | --- |
| Node：bot、client、hook、gateway、bank、bridge、lifecycle／auto、readiness、EVAL | **295 pass、0 fail、0 skip** |
| bot PG integration ＋ bot／bank tests | **104 pass、0 fail、1 skip**（缺 native Mail binary 的整段 TC-18；另有鎖定 Mail image 的 R-05 重現，不能互相冒充） |
| `python3 -m unittest discover -s ops/test -v` | **40 tests，39 pass、1 skip**（原生 Caddy 不在 PATH；另一項真 Docker Caddy 2.11.9 validate 測試有跑且通過） |
| pinned `golang:1.27.4-alpine`：`go test ./...` | **PASS**，`ok neighbor-hub/validator 0.353s` |
| shell syntax／`git diff --check` | **PASS** |
| R-01／R-02／R-03 TDD | **各自先 assertion FAIL，再轉綠**；完整紀錄見 evidence |
| 真 Discord／Groq／Hindsight provider／VPS／完整 L09 dry-run | **未執行** |

初始 Node baseline 因新 worktree 尚未 `npm ci` 而有 pg／discord.js module 缺失；已用 lockfile 安裝（ignore scripts）後重跑，最終 Node 無失敗。原生 Go 不存在，最初 network-none 容器也因缺 module cache 失敗；改用可下載依賴的同一鎖定 builder，最後 Go 測試通過。沒有改測試來掩蓋 baseline failure 或把 skip 算成功。

程式修正各自獨立 commit：`91b6959`（備份／還原 eval）、`1afbba2`（Groq model parser）、`68d901e`（HTTP probes）。**仍須 PM 整合後修 R-04、R-05 並驗證，再決定是否開放 token 發放與決策確認；本報告不是部署批准。**

## 後續修正 R-04

TokenApplier 保留每把 token 的私有撤銷憑證，每次 process 即使 spool 已空也依 DB 狀態對帳；失敗、探測斷線與晚回執導致的 pending row 會持續重試，直到重新載入且舊 token 實測 401 才完成撤銷並刪憑證。空 allowlist 同樣會產生並套用全拒絕設定；bot 發放失敗只回報待撤銷，不宣稱入口已拒絕。TDD 與真本機 Caddy 200→401、其他裝置仍 200 的收據見 evidence；無法連線或 Caddy 持續拒絕 reload 時維持 pending 並留下補償記錄，需 timer 持續運作及服務恢復後收斂，不保證故障中的 Caddy 可立刻改變載入設定。
