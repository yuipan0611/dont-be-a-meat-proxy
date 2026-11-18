# P-7 Hub 客戶端發行

安裝與更新共用 Node 22+ 的下載、SHA-256 驗證與啟動檢查。Shell 只負責引導，沿用串流啟動與使用者 PATH 的慣例。 [uv 安裝方式](https://docs.astral.sh/uv/getting-started/installation/) · [Bun 的 Windows 安裝腳本](https://bun.com/install.ps1) · [Deno 安裝腳本](https://github.com/denoland/deno_install)

## 建置並準備上線

1. 合併 P-7 後，在含合併版 `ops/release` 的 checkout 建置。用新的 semver。預設來源為本機 `master`，也可用 `--ref` 指定待驗的完整 commit。
   ```sh
   node ops/release/build.mjs --version 1.0.0 --out /tmp/hub-client-1.0.0
   ```
   建置需 Node 22+ 與 Git。固定讀取已提交的 runtime 檔，Git 以 commit 時間及固定樹順序打包。輸出包含兩種版本化 archive、`manifest.json`、兩個安裝腳本及 Node bootstrap。Manifest 記錄版本、commit、兩個 archive 的 SHA-256，以及包內檔案和公開安裝腳本的 SHA-256。`bootstrap.mjs` 是包內下載模組的副本。首次執行的信任根是 Hub HTTPS，後續依 manifest 驗證內容。
2. 準備一份獨立的公開 `config.json`。每組只放公開的 HubClock、MemoryBridge canonical agent 名稱與允許寄信的公開 peer 名稱。HubClock／MemoryBridge 名稱取自各組私有 sender 檔的 `agentName` 欄位；請手動擷取名稱。下面是格式示例，請填入實際值。
   ```json
   {
     "groups": {
       "group-a": {
         "clock_agent": "CanonicalClockAgent",
         "memory_agent": "CanonicalMemoryAgent",
         "peers": ["CanonicalPeerOne", "CanonicalPeerTwo"]
       }
     }
   }
   ```
   首次接入的組員需要 PM 配發 canonical Agent。Bot 的 `/connect` 會沿用該組員同組、同平台的有效裝置所登記的 `allowed_agents`。第一次沒有此紀錄時，請私下告知組員名稱，將名稱關聯到本次核發的裝置，並依既有程序配發獨立 sender token。測試前確認該 Agent 已在組內 Mail 註冊，且公開 peers 取自實際核准名單。
3. PM 將建置輸出、公開設定和同版 publish 腳本帶到 VPS。先用該版 Node 與同版 checkout 進行發佈，執行者須擁有公開根目錄。預設公開目錄是 `/var/www/hub-downloads`，Caddy 應有讀取權。發佈腳本先檢查 manifest、SHA-256 及公開設定欄位，最後才替換 manifest。保留舊版發行目錄供回復。
   ```sh
   sudo ops/release/publish.sh /tmp/hub-client-1.0.0 /tmp/hub-public-config.json
   ```
4. 首次啟用時，PM 備份目前的 `/etc/caddy/hub.caddy`。安裝 [Caddy 路由片段](../../deploy/caddy/client-downloads.routes) 為 `/etc/caddy/hub-client-downloads.routes`，在已上線的 Hub 站點 `route` 區塊中，在私有認證的 fallback `handle` **之前**新增 import。現有 web 路由仍按原順序執行。
   ```caddyfile
   route {
     import /etc/caddy/hub-private/web.routes
     import /etc/caddy/hub-client-downloads.routes
     handle {
       import /etc/caddy/hub-private/auth.caddy
     }
   }
   ```
   PM 依 L-09 流程，以 Caddy 服務帳號驗證整份 Caddyfile，再依排程 graceful reload。驗證輸出留在 VPS 私有檔案。在 Caddy 設定核准前不得向組員公告。後續只發新版靜態檔時，`publish.sh` 就會更新 manifest，Caddy 不需重載。 [L-09 Caddy 啟用與回復程序](runbook-L09-launch-deploy.md)
5. PM 先驗證公開路由，再部署新版 Discord bot。應可匿名 GET 或 HEAD `/install.sh`、`/install.ps1`、`/dist/manifest.json`、`/dist/config.json`、`/dist/bootstrap.mjs` 和 manifest 指向的包。公開路由的 POST 應回 405，`/dist/` 及 `/dist/private.env` 應回 404，匿名 MCP、memory、readiness 繼續使用現行的個別驗收判準。確認 office 正常。用測試組員及私有 token 實際走一次 Discord `/connect`、乾淨安裝、`hub claude`、`hub doctor`。Windows 核對 ACL 僅本人並分別測 PowerShell 5.1／7。 [組員接入手冊](../onboarding-S1.md)

## 更新與回復

- 客戶端在驗證 archive、逐檔雜湊、readiness 與 inbox 後才替換目前版本指標。驗證或切換失敗時舊版繼續運作。若行程在寫入期間被強制終止且下次看到 `change.lock`，先確認沒有任何 Hub 安裝、更新或卸載行程，再移除空的 `change.lock` 目錄後重試。
- 若發佈後發現版本有功能問題，用上一版建置輸出和對應的公開設定重跑 `publish.sh`。已更新的客戶端跑 `hub update` 會依目前 manifest 回到該版。舊版 archive 採不可變檔名，供已開始的下載及回復使用。
- 先關閉使用 Hub 的 Claude session 再執行 `hub uninstall`。卸載器移除這份安裝的程式、私有裝置 token 檔及它加入的設定，保留既有收件紀錄與其他工具設定。若要撤銷裝置授權，再於 Discord 執行 `/revoke`。

## 本機驗證

```sh
python3 ops/release/test/install_test.py -v
python3 ops/release/test/routes_test.py -v
docker run --rm -v "$PWD:/src:ro" -w /src node:22-bookworm python3 ops/release/test/install_test.py -v
docker run --rm -v "$PWD:/src:ro" -w /src node:22-alpine sh -c 'apk add --no-cache git python3 procps curl && python3 ops/release/test/install_test.py -v'
docker build --platform linux/amd64 -t hub-client-p7-pwsh-test -f ops/release/test/Dockerfile.pwsh ops/release/test
docker run --rm --platform linux/amd64 -v "$PWD:/src:ro" hub-client-p7-pwsh-test
```

假 Hub 測試使用暫存 HOME、loopback、PTY 與假 Claude。PowerShell 7 容器實際跑一行 PowerShell、ZIP、提示與更新流程；NTFS ACL、Windows PATH 和 PowerShell 5.1 由 PM 在 Windows 驗收。Claude 的 MCP 設定以環境變數載入 bearer，Hooks 使用可跨平台的 exec form。 [Claude Code MCP 變數展開](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json) · [Claude Code Hooks](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form) · [Cursor MCP 變數展開](https://cursor.com/docs/mcp#config-interpolation)
