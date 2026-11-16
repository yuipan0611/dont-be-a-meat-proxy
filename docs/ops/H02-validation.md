# H-02 本機驗證與交付紀錄

日期：2026-11-17，Asia/Taipei。執行者：codex-senior-swe。分支：`example-org/codex-senior-swe`。VPS 沒有登入權限；以下只有本機合成測試，沒有改動真實 office 或 hub。

程式 commit：`b42e7ef90265924fa9ef50aedf7a93b0fc9c27db`；其後的文件 commit 補齊本紀錄與 runbook。整合時需同時保留程式與文件兩個 commit，不能只取文件。

## 交付範圍

- `deploy/compose.yaml`：只啟 `mail-a`，固定官方 amd64 digest、512 MiB、non-root、cap_drop ALL、no-new-privileges、read-only rootfs、專用 bridge 與 127.0.0.1 發布、持久 volume、healthcheck、log 輪替。
- `deploy/caddy/hub.caddy`：獨立 hub site，保留 HTTP-01，匯入 VPS 本地 600 的 auth snippet；不提交秘密，不新增 Caddy 容器。
- `ops/init-secrets`、`ops/render-caddy`、`ops/revoke`、`ops/issue`、`ops/bootstrap`：Python 標準庫 CLI，原子寫檔、單 writer lock、validate/reload/probe 後才成功；撤銷失敗保留 pending。issue 僅允許明確 revoke 後發新值，舊值持續拒絕。
- `ops/verify-h02.mjs`：維護者 在 Mac 可跑的 TC-01、05、10、11 與真 MCP／cursor 驗證，憑證只讀取本機私密檔。
- [部署／回滾手冊](runbook-H02-deploy.md)：以原 Caddy 版本和 office 設定為前置，備份、import、validate、graceful reload、實機驗收及回滾。

H-03 的 `client/mail-client.mjs` 與整合測試斷言未改，只在既有 helper 新增外接 loopback 容器的環境變數。這讓相同斷言直接跑在正式選用的 image，不用替身替代 Mail。

## 實際執行命令與結果

| 命令 | 實際輸出摘要／exit | 證據範圍 |
|---|---|---|
| `git merge master` | 起初 vps-inventory add/add 衝突；核對 stage 3 包含原模板與完整 PM／維護者 新紀錄，保留該完整版本後提交 merge `53a6dce` | 沒有覆蓋 PM 實測資料；master 未改 |
| `npm test --prefix client` | exit 0；tests 40、pass 40、fail 0、skipped 0 | H-03 單元基線與回歸 |
| `MAIL_BIN="$PWD/spikes/f01b/target/release/mcp-agent-mail" npm run test:integration --prefix client` | exit 0；tests 8、pass 8、fail 0、skipped 0 | 舊 F-01b Mac binary 基線；不是 Linux image 證據 |
| `python3 -m unittest discover -s ops/test -v` | exit 0；Ran 7 tests、OK | CLI 私密檔／權限、重跑保留、設定注入拒絕、all-revoked deny、失敗 pending 與 snippet 復原、active 裝置禁止直接 issue |
| `docker buildx imagetools inspect ghcr.io/dicklesworthstone/mcp_agent_mail_rust:0.3.40` | index `sha256:031d1d0e6764495f8db12f981704ade32d56fe9c12678efca1d533cde67fd3a5`，其中 amd64 manifest 為本次固定 digest | 不把可移動 tag 當部署鎖定 |
| `HUB_PRIVATE_DIR="$PWD/.hub-local/h02/private" HUB_MAIL_PORT=18765 docker compose -p neighbor-h02-test -f deploy/compose.yaml config --quiet` | exit 0、無輸出；私密 env 已先由 init 產生 | Compose 靜態格式與參數，沒有把 config 全文或 token 印出 |
| `node ops/test/local-stack.mjs` | exit 0；完整成功輸出見 [H02-local-stack.txt](evidence/H02-local-stack.txt) | 固定 Linux image、實際 Caddy、實際 MCP 與下表 |
| `node --check ops/verify-h02.mjs`、`node --check ops/test/local-stack.mjs` | exit 0、無輸出 | Node 語法 |
| `python3 <LOCAL_HOME>/.codex/skills/safely-modify-codebase/scripts/manage_config.py validate --repo . --strict` | exit 0、VALID；1 個 known unknown，為 VPS 專屬實測仍待 operator | Repo 邊界與保護項已記錄，不假裝未知已消失 |
| `git diff --check` | exit 0、無輸出 | whitespace 檢查；新檔加入暫存區後另跑 cached check |

文件額外檢查：以 Python 擷取 runbook 的 `sh` code fences 並逐一送 `bash -n`，實際回 `PASS: 22 H-02 runbook shell blocks parse with bash -n`；檢查 runbook／本報告相對連結，回 `PASS: 6 local links resolve in H-02 runbook/report`。另將 `.hub-local/h02` 中 registry／sender 檔的 token 欄位讀入記憶體比對交付檔，不印值，實際回 `PASS: no values from 29 generated fixture credentials in staged files or H-02 delivery docs`。

未指定 MAIL_BIN 的初始整合測試曾有 8 skipped，沒有列作成功；指定 binary 後取得上表真實基線。TDD 首輪在 CLI 尚不存在時測試紅燈，加入 init 後綠燈；Caddy snippet 驗證與明確 issue 限制也分別先看到缺少命令的失敗，再補實作，沒有先捏造通過紀錄。

### 完整本機環境驗證

`local-stack.mjs` 自己建隔離 Compose project、測試 volume、loopback Mail port、native Caddy 與合成 office site；finally 停 Caddy 並 `compose down --volumes --remove-orphans`，只作用於自己的 project。成功輪清理名稱見輸出最後一行；最終 `docker ps -a --filter name=neighbor-h02 --format '{{.Names}}'` 與同前綴 volume 查詢為空，network 名稱也沒有該前綴，未停止別人的容器或 Docker Desktop。

重跑需 Docker、Python 3、Node ≥22 與 native Caddy。此 worktree 預設使用 F-01b 的 `spikes/f01b/bin/caddy`；其他 checkout 應先從 [Caddy 官方 v2.11.9 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.9) 取得適合本機架構的 binary 到 gitignored 目錄，再用 `CADDY_BIN=<binary絕對路徑> node ops/test/local-stack.mjs`。Binary 不存在會在建立 Docker 資源之前失敗；沒有為測試安裝或更動全域 Caddy。

| 項目 | 實際結果 |
|---|---|
| image | Linux amd64，`0.3.40`，OCI revision `7d94ecf55dfa6a1ca157ee5ad7cf4dbfb1dd5b4d` |
| runtime 限制 | UID `10001:10001`、memory `536870912` bytes、cap_drop ALL、ReadonlyRootfs=true、HostIp 只有 127.0.0.1 |
| host 連線 | 專用 bridge 下 loopback health 200；先前 internal 網路會拒絕 host 發布，PM 已核准調整 |
| Caddy 語法 | 真 `caddy validate` 讀取正式 hub template、TLS／HTTP-01 issuer 與生成的私密 auth；exit 0 |
| TC-01 | 9 個路徑各做無／錯 token GET，加 MCP POST 無／錯 token，共 20 次全部 401 |
| bootstrap | BlueLake／RedStone；邏輯 HubClock 由 server 自動命名；第二次執行顯示 RETAINED，不換 registration |
| 真 MCP | initialize 有 serverInfo／session ID，send/read 繁中、換行與 emoji 逐字一致；cursor 包含新投遞 |
| TC-11 | 未知 win-claud 回 E-RCPT、not_saved；delivery tail 與事件數不增加 |
| memory 入口 | 正確 token 為 503；錯 token 仍 401 |
| H-03 原有整合套件 | 同一隔離容器，8 pass／0 fail／0 skip，包含原文 fixture、peek 不標讀、cursor resume、同 key 防重／衝突、未知收件者與錯 token |
| TC-05 | 實際 compose restart mail-a，再讀同一 message ID，原文與 SHA-256 不變 |
| TC-10 | Windows initialize 前後保留同一 MCP session，撤銷後下一個 tools/list 401；Mac 仍 200，Mail StartedAt 未變 |
| office 保護 | 同一次 native Caddy 的合成 office site，在 token reload 後仍 200 且文字相同；Caddy process 沒有重啟 |
| 明確重新核發 | Windows 已 revoked 才 issue 新值，新值可 initialize，舊 session 仍 401；office 200 |

本機 Caddy `version`：`v2.11.9 h1:bhZtcRKQOq0fuLvEgCdPYvUxXyGn9kzjG4lh2332DTE=`。Docker Server 29.9.3／Compose v5.7.0；Mac ARM64 上跑 amd64 image，不能代替 VPS x86_64 的效能或容量實測。此處 Caddy 用隔離 HTTP fixture 驗權限與 reload；正式 site 只做 validate，**沒有取得公共憑證**。

## 來源差異與工程決定

1. PM 核准固定官方 release manifest `sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1`。GitHub tag v0.3.40 的 annotated tag object 是 `b444b668…`，實際指向 commit `7d94ecf…`；SDS／F-01b source 為 `a58b6d7…`，兩者分列。本次沒有改 upstream code 或自行編 Linux image。
2. F-01b Mac binary 的 `shasum -a 256` 實值是 `4c3804feff45cd068e48fa57e1141f236849687e4e0e2e8394fc4b811735bead`，不當成 Linux binary checksum。官方 image 的實際功能由上面的容器測試證明。
3. 沿用 VPS 系統 Caddy，因此 Mail 專用網路改一般 bridge，保留 127.0.0.1-only port。Outbound 可用是 PM 接受的 MVP 副作用；不能把它說成 internal egress 封鎖。
4. 上游拒絕 descriptive name `HubClock`。PM 核准邏輯角色不變，以 register 回傳 canonical name 存於 `hubclock.sender.json`；H-05 讀該檔。這不是關閉身分驗證或改 native schema。
5. Python 3 負責 VPS operator glue，Node ≥22 只供 Mac 驗收與既有 client。VPS 不需要新裝 Node 或其他 Python 套件。
6. `ops/issue` 只補 SDS 已列的明確 revoke→issue 流程，讓 TC-10 完成後能給 Windows 新 token；禁止輪替 active 或 revocation_pending 裝置，沒有 token 原值重看介面。

## 維護者 還需要執行

1. 依 runbook 第一節回報實機 `caddy version`、原 Caddyfile、User／ExecReload，確認 office 原狀與 import 層級。
2. 複製審過的程式，產生 VPS 本地秘密，啟動 pinned Mail，確認 host loopback health 與 Mac 對公網 8765 無法直連。
3. 保留原始 office 備份，放 hub 檔與單一 import，validate、graceful reload；記 Caddy MainPID／office 前後回應碼與原功能。
4. 補隔離 ACME staging／實機公共 TLS 證據，再以正常 TLS 執行 Mac TC-01、MCP／TC-11、Mail restart／TC-05、同 session 撤銷／TC-10。失敗就照手冊保留證據或回滾，不跳過憑證驗證。
5. 明確 issue Windows 替代 token，再安全取回自己的裝置設定；H-05／H-06 接續計時與備份，H-02 不冒充兩票已部署。

本 worker 的實際遠端寫入為零。此交付完成程式與本機驗證，**沒有宣告 H-02 的 VPS 部署或真 office 驗收已完成**。
