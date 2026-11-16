# H-02：把 Mail 接到既有系統 Caddy

操作人：維護者。程式與手冊：codex-senior-swe。依據：[SDS API-01／02／05](../05-sds.md)、[VPS 實際盤點與 PM 調整](vps-inventory.md)、[MVP 工作票](../07-tickets-mvp.md)。本文件的 VPS 指令由 維護者 執行，agent 沒有 SSH 權限。

目標是新增 `https://hub.example.invalid/mcp/`，同時保留 `office.example.invalid` 的既有行為。先啟 `mail-a`，完成驗收後再啟 H-05 HubClock 容器；既有 `/usr/bin/caddy` 繼續服務 80／443。不要重啟 Caddy、重開機、更新系統套件、重設防火牆或改其他服務。

## 1. 先把 Caddy 版本與原設定貼回 PM

在 維護者 已能金鑰登入的 VPS 視窗執行：

```sh
caddy version
sudo cat /etc/caddy/Caddyfile
sudo systemctl show caddy -p User -p MainPID -p ExecReload
python3 --version
```

預期：Caddy 實際版本、目前只有 office 的約 59 bytes 設定、服務帳號及 reload 命令。版本以實機輸出為準，不升級到本機驗證用的 v2.11.9。此時 Caddyfile 還沒有 hub token，可貼回 PM；後續的 `hub-private/auth.caddy`、`tokens.json`、`.env`、sender 檔與含秘密的錯誤 log 不貼。

請 PM 核對 office site 已有明確 `{ … }` 區塊，才能在區塊外加 import。若原檔是省略大括號的單站點格式，先請 PM 依原內容給最小包裹方式，不自行重寫代理。若服務不是從這個 Caddyfile reload、或服務帳號不是 `caddy`，先回報，不能硬套後面的預設路徑／owner。`command not found` 或 Python <3.10 也先回報。

在 Mac 另開 Terminal，記下 office 原狀與回應碼：

```sh
curl --noproxy '*' --connect-timeout 5 --max-time 15 -sS -o /dev/null \
  -w 'office_before=%{http_code}\n' https://office.example.invalid/
```

預期是原服務的回應碼；H-01 曾觀察到 **501**，所以不把原本的 501 當成 H-02 故障，也不一律要求改成 200。維護者 同時確認原本 office 操作能正常進行。部署後用同一請求比對。

## 2. 從 Mac 複製審過的程式，不帶任何秘密

在本 repo 的 Mac 終端機執行。`H02_COMMIT` 換成 PM 已審核的 H-02 commit；需包含這份 runbook、deploy、ops 與 H-03 client。下列 SSH／scp 由 維護者 親自操作，不把私鑰或 passphrase 給 agent。

```sh
H02_COMMIT='<PM提供的H02交付commit>'
mkdir -p .hub-local
git archive "$H02_COMMIT" deploy ops client > .hub-local/h02-code.tar
scp .hub-local/h02-code.tar root@<VPS_IP>:/root/h02-code.tar
```

預期 scp 傳送完成；archive 只含已提交的程式。若 Git 說找不到 commit，先核對 PM 的版本，不改用未審核分支。若主機指紋改變，停止核對，不跳過 SSH 主機驗證。

在 VPS 解開至本專案的新目錄：

```sh
sudo install -d -m 755 /opt/neighbor-hub
sudo tar -xf /root/h02-code.tar -C /opt/neighbor-hub
cd /opt/neighbor-hub
```

預期有 `deploy/compose.yaml`、`deploy/caddy/hub.caddy`、`ops/`、`client/`。若這個目錄已有其他用途，先停止，不覆蓋別人的部署。

## 3. 產生秘密、拉取固定 image、啟動 Mail

本機私密資料放 `/var/lib/neighbor-hub/private`，目錄 700、檔案 600。下面命令不顯示 token。重跑 init 保留原值；不會隱式輪替。

```sh
# VPS，工作目錄 /opt/neighbor-hub。
sudo python3 ops/init-secrets
sudo stat -c '%a %n' /var/lib/neighbor-hub/private /var/lib/neighbor-hub/private/*.env
sudo docker compose -p neighbor-hub -f deploy/compose.yaml config --quiet
sudo docker compose -p neighbor-hub -f deploy/compose.yaml pull
```

預期 init 回 `Private credentials ready`，stat 顯示目錄 700、三份 env 600，Compose config exit 0 無輸出，pull 回固定 digest。不要用不帶 `--quiet` 的 config、`docker inspect` 全文或 `cat *.env` 貼回 PM，裡面會有秘密。

固定 image 是官方 Linux amd64：

```text
ghcr.io/dicklesworthstone/mcp_agent_mail_rust@sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1
version: 0.3.40
release tag commit: 7d94ecf55dfa6a1ca157ee5ad7cf4dbfb1dd5b4d
```

PM 已核准此來源差異：SDS／F-01b 的 source 是 `a58b6d77cd16fa4e235359ae91f1b28779780d05`，本次 release image 是 `7d94ecf…`，不能聲稱同一個 build。F-01b Mac binary SHA-256 為 `4c3804feff45cd068e48fa57e1141f236849687e4e0e2e8394fc4b811735bead`，也不是 Linux binary 的雜湊。本次已對上述固定 image 跑真 MCP 與 H-03 整合測試，見 [驗證紀錄](H02-validation.md)。不在 VPS 編譯 Rust、不改用 latest。

```sh
sudo docker compose -p neighbor-hub -f deploy/compose.yaml up -d --wait --wait-timeout 120
sudo docker compose -p neighbor-hub -f deploy/compose.yaml ps
curl --noproxy '*' --connect-timeout 5 --max-time 10 -sS -o /dev/null \
  -w 'loopback_health=%{http_code}\n' http://127.0.0.1:8765/health/liveness
H02_CONTAINER=$(sudo docker compose -p neighbor-hub -f deploy/compose.yaml ps -q mail-a)
sudo docker inspect --format '{{.Config.User}} memory={{.HostConfig.Memory}} readonly={{.HostConfig.ReadonlyRootfs}} ports={{json .HostConfig.PortBindings}}' "$H02_CONTAINER"
```

預期 Mail 為 healthy、loopback health 200、user `10001:10001`、memory `536870912`、readonly `true`，port 只有 `HostIp:127.0.0.1`。容器 cap_drop ALL、no-new-privileges，rootfs 唯讀，只有專屬 `/data` volume 與限量 `/tmp` tmpfs 可寫。新 volume 的 UID 已在本機驗過；若 VPS 出現 Permission denied，不改用 root 常駐、不掛 Docker socket，回報 PM。

`mail_a_net` 採專用 bridge，這是 PM 針對系統 Caddy 核准的調整；原本 internal 網路無法提供這條 host 發布路徑。副作用是容器可 outbound；MVP 接受，並以關閉 semantic／LLM、無外部 key 與不執行來信指令限制用途。bridge 不提供跨組隔離的完整驗收證據，S3 仍另過 Gate。

若 `up --wait` 逾時，先查 `compose ps` 及本機私密日誌；不要無限重試或刪 volume。日誌可能含資料，只把去秘密的錯誤摘要貼回 PM。若 8765 已被占用，停下核對盤點，不換成公開 port。

### 從 Mac 確認 backend 沒有外露

```sh
curl --noproxy '*' --connect-timeout 5 --max-time 10 -I \
  http://<VPS_IP>:8765/health/liveness
printf 'backend_external_curl_exit=%s\n' "$?"
```

預期連線失敗，常見 exit 7 或 28，沒有 HTTP 回應。**任何 HTTP 回應，包括 401，都表示 backend 可直連，驗收失敗**；先停止本專案 Mail，回報 PM。這項需從 VPS 外的 Mac 執行；UFW 的規則表不能替代此測試。

## 4. 備份 office 設定，放 hub 檔，再驗證與 graceful reload

先完成第 1 節的 PM 核對。以下在 VPS 執行，不停止 office。

```sh
sudo install -d -m 700 /var/lib/neighbor-hub/backups
if sudo test -e /var/lib/neighbor-hub/backups/pre-h02.path; then
  printf 'Existing pre-H02 backup retained; inspect pointer locally before proceeding\n'
else
  H02_BACKUP="/var/lib/neighbor-hub/backups/Caddyfile.pre-h02-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo cp -a /etc/caddy/Caddyfile "$H02_BACKUP"
  printf '%s\n' "$H02_BACKUP" | sudo tee /var/lib/neighbor-hub/backups/pre-h02.path >/dev/null
  sudo chmod 600 /var/lib/neighbor-hub/backups/pre-h02.path
fi
sudo install -m 644 deploy/caddy/hub.caddy /etc/caddy/hub.caddy
sudo python3 ops/render-caddy --prepare-only
sudo stat -c '%U:%G %a %n' /etc/caddy/hub-private /etc/caddy/hub-private/auth.caddy
```

預期有一份時間命名的完整 office 備份，render 回 `prepared; not validated or activated`。`/etc/caddy/hub.caddy` 只含 site 與 import；token 在 `/etc/caddy/hub-private/auth.caddy`，owner caddy、mode 600，目錄 root:caddy 750。不要讀或複製該秘密檔到 repo。若檔案 owner／權限不符，工具會拒絕，不直接放寬到 644。

以下只加一行，須位於 office 的大括號區塊外。先確認沒有既有 hub 站點；若有，停止核對，不能加第二個。

```sh
sudo grep -Fqx 'import /etc/caddy/hub.caddy' /etc/caddy/Caddyfile || \
  printf '\nimport /etc/caddy/hub.caddy\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
```

預期 office 原內容保留，新增 `import /etc/caddy/hub.caddy`。若是重跑，已存在的精確 import 不重複加入；不能把第二次備份當成原始 office 備份，首次成功後應保留原 `pre-h02.path`。

`caddy validate` 的錯誤可能含私密設定，所以保存在權限 600 的本機 log，只回報 exit code。驗證失敗時不要 reload，走第 7 節回滾。

```sh
if sudo sh -c 'umask 077; /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /var/lib/neighbor-hub/private/caddy-validate.log 2>&1'; then
  printf 'caddy_validate=0\n'
else
  printf 'caddy_validate=FAILED; do not reload; use rollback section\n'
fi
```

只有上一步顯示 `caddy_validate=0` 才執行：

```sh
if sudo sh -c 'umask 077; systemctl reload caddy > /var/lib/neighbor-hub/private/caddy-reload.log 2>&1'; then
  printf 'caddy_reload=0\n'
else
  printf 'caddy_reload=FAILED; use rollback section\n'
fi
sudo systemctl is-active caddy
sudo systemctl show caddy -p MainPID
```

預期 reload=0、active，MainPID 與第 1 節相同。這是 graceful reload，不用 `restart`。首次 hub 憑證由 Caddy 處理 Let's Encrypt HTTP-01，需 DNS 正確與 TCP 80／443 可達；不改 office 的 TLS 或全域 issuer。

SDS 的隔離 ACME staging 與實機公共 TLS 證據仍需由 PM／維護者 補齊。本機只驗過 site 的 issuer 語法，不是假造 ACME 簽發；不要在 office 主程序上為測試改全域 staging 或清憑證快取。依第 1 節的實際設定安排隔離驗證後再作正式放行。

在 Mac 檢查 office 與 hub：

```sh
curl --noproxy '*' --connect-timeout 5 --max-time 15 -sS -o /dev/null \
  -w 'office_after=%{http_code}\n' https://office.example.invalid/
curl --noproxy '*' --connect-timeout 5 --max-time 15 -sS -o /dev/null \
  -w 'hub_no_token=%{http_code}\n' https://hub.example.invalid/health/liveness
```

預期 office 與 before 原狀一致，hub 是可信公共 TLS 下的 401。若 TLS 尚未簽好，可等 Caddy 當次簽發後重查並記時間，不能用 `-k`、關閉 client 憑證驗證或把 HTTP 200 當 TLS 通過。office 有退步立即回滾；hub 為 502 表示代理或 Mail 未就緒，先查 loopback health。

## 5. Bootstrap 並把裝置設定放到 維護者 的 Mac

在 VPS 執行 Python 3 工具，無須在 VPS 安裝 Node：

```sh
cd /opt/neighbor-hub
sudo python3 ops/bootstrap
```

預期印出 BlueLake、RedStone，以及 `role HubClock: <canonical name>`，憑證存成三個 600 的 `*.sender.json`。上游不接受 descriptive name `HubClock`；PM 核准它只當邏輯角色，register 不帶 name，由 server 回傳合法名稱。H-05 必須從 `hubclock.sender.json` 讀 `agentName`，不得寫死 HubClock。重跑 bootstrap 保留已儲存的 registration，不輪替已發出的 agent token。

在 Mac 的 repo 根目錄取回驗收所需的四個檔案。這是 維護者 自己的裝置設定，**不交給 agent，不貼聊天，不 commit**；不複製 upstream 的 `mail-a.env`、`tokens.json` 或計時服務 sender 檔。

```sh
mkdir -p .hub-local/h02-client
chmod 700 .hub-local/h02-client
scp root@<VPS_IP>:/var/lib/neighbor-hub/private/mac.env \
  root@<VPS_IP>:/var/lib/neighbor-hub/private/windows.env \
  root@<VPS_IP>:/var/lib/neighbor-hub/private/mac.sender.json \
  root@<VPS_IP>:/var/lib/neighbor-hub/private/windows.sender.json \
  .hub-local/h02-client/
chmod 600 .hub-local/h02-client/*.env .hub-local/h02-client/*.sender.json
node --version
```

預期 Node ≥22，四份設定在 gitignored `.hub-local`。Mac／Windows 的裝置 bearer 與各 agent 的 sender registration token 是不同用途，不能互換。Windows 正式接入依 H-07 手冊安全放置自己的兩份設定，不把兩裝置的驗收資料當成共享憑證發給組員。

## 6. 在 Mac 跑 TC-01、05、10、11

這些測試會在新部署的 group-a 建立清楚標示的合成交接。不要對已有他人資料的環境跑 H-03 的重註冊整合套件；H-03 容器測試只在本機隔離環境執行。

### TC-01 與真 MCP／TC-11

```sh
node ops/verify-h02.mjs unauthorized
node ops/verify-h02.mjs mcp --credentials-dir .hub-local/h02-client
```

預期第一行為 `PASS TC-01: 20 unauthorized requests returned 401`。第二個工具實際 initialize、send/read、比對繁中／換行／emoji、查 durable cursor，再送給未知 `win-claud`；預期 `E-RCPT` 且 delivery tail 不增加，最後保存 message ID 與 SHA-256 的 TC-05 checkpoint。HTTP 200 但 MCP `isError` 會失敗，不只看 health。

### TC-05：重啟 Mail 後讀回原文

在 VPS 記下啟動時間並只重啟本專案的 Mail，不重啟 Caddy：

```sh
cd /opt/neighbor-hub
H02_CONTAINER=$(sudo docker compose -p neighbor-hub -f deploy/compose.yaml ps -q mail-a)
sudo docker inspect --format '{{.State.StartedAt}}' "$H02_CONTAINER"
sudo docker compose -p neighbor-hub -f deploy/compose.yaml restart mail-a
sudo docker compose -p neighbor-hub -f deploy/compose.yaml up -d --wait --wait-timeout 120
sudo docker inspect --format '{{.State.StartedAt}}' "$H02_CONTAINER"
H02_READY=0
for H02_ATTEMPT in $(seq 1 30); do
  H02_HEALTH=$(curl --noproxy '*' --connect-timeout 1 --max-time 1 -s -o /dev/null \
    -w '%{http_code}' http://127.0.0.1:8765/health/liveness) || H02_HEALTH=000
  if [ "$H02_HEALTH" = 200 ]; then
    H02_READY=1
    printf 'READY TC-05 after Mail restart: health 200\n'
    break
  fi
  sleep 1
done
if [ "$H02_READY" != 1 ]; then
  printf 'FAIL TC-05 after Mail restart: health not 200 after 30 probes; stop before persistence/TC-10\n'
fi
```

**重啟後先等 health 200 再測**。預期 StartedAt 改變、healthy，並出現 `READY TC-05 after Mail restart: health 200`；上面最多 30 次，每次 curl 最長 1 秒、間隔 1 秒，等待約在 60 秒內結束。若看到 FAIL，先停止並查 Mail，不執行原文讀取或 TC-10；Compose 的 healthy 狀態不能代替這個實際 HTTP 檢查。確認 READY 後才在 Mac 執行：

```sh
node ops/verify-h02.mjs persistence --credentials-dir .hub-local/h02-client
```

預期 `PASS TC-05`，同 ID、原文與 SHA-256 不變。記錄兩次 StartedAt，證明真的重啟；不要只重跑讀取工具就宣稱重啟持久性通過。

### TC-10：保持同一 session，再撤 Windows token

先在 Mac 執行，下列程式會 initialize Windows MCP session，停在 READY 等待：

```sh
node ops/verify-h02.mjs revoke-session --credentials-dir .hub-local/h02-client
```

看到 READY 後，在 VPS 執行。先記錄 Mail StartedAt，再撤銷：

```sh
cd /opt/neighbor-hub
H02_CONTAINER=$(sudo docker compose -p neighbor-hub -f deploy/compose.yaml ps -q mail-a)
sudo docker inspect --format '{{.State.StartedAt}}' "$H02_CONTAINER"
sudo python3 ops/revoke --device windows
sudo docker inspect --format '{{.State.StartedAt}}' "$H02_CONTAINER"
sudo systemctl show caddy -p MainPID
```

預期工具先記 revocation_pending，再生成 600 的 auth 檔、validate、`systemctl reload caddy`、probe 舊 Windows 401 與 Mac 200，最後才印 `Revoked windows`。Mail StartedAt 與 Caddy MainPID 不變。回 Mac 的 READY 視窗按 Enter，預期 **同一個** Windows MCP session 下一請求 401、Mac initialize 仍成功。

validate／reload 失敗會恢復上一份 snippet，registry 保留 pending，exit 非 0；不回報成功，也不把 Windows 改回 active。probe 失敗也留 pending，不自動重試到另一個服務。排除原因後重跑同一個 `ops/revoke --device windows`，不手改整份 allowlist。詳細錯誤只在自己的機器查，不把 secret log 貼回。

驗收後要讓 Windows 重新接入，必須**明確核發新值**，不能把舊 token 加回去：

```sh
# VPS；只有已確認 revoked 的裝置才可核發替代值。
sudo python3 ops/issue --device windows
```

預期新 token 的 probe 成功，舊 token 仍 401，更新 `windows.env`，不輸出值、不改 Mac 或 sender registration。失敗時不要手動復活舊值；重跑 issue 會使用同一個待核發值。成功後在 Mac 只重取 Windows env，再跑一次 mcp：

```sh
scp root@<VPS_IP>:/var/lib/neighbor-hub/private/windows.env .hub-local/h02-client/windows.env
chmod 600 .hub-local/h02-client/windows.env
node ops/verify-h02.mjs mcp --credentials-dir .hub-local/h02-client
```

最後再做第 4 節的 office 原狀比對，將去秘密的 PASS 行、StartedAt、MainPID、HTTP 回應碼與實機 Caddy 版本交給 PM。

### 啟動 H-05 HubClock 容器，驗證第二實例 standby

依 [H-05 驗證紀錄](H05-validation.md) 與既有 `deploy/hubclock/compose.hubclock.yaml`，將容器 override 疊在基本 Compose 上，不在 VPS 安裝 Node，也不啟用備案 systemd unit。以下在 VPS 的 `/opt/neighbor-hub` 執行，且第 5 節 bootstrap 已成功。

HubClock 需要讀取 upstream env 與自己的 sender registry，並寫入 `/var/lib/neighbor-hub/hubclock`。這兩個 mode-600 檔案與新狀態目錄使用 UID/GID `10001:10001`，讓容器可用非 root 身分執行。root 的 H-02 CLI 仍可管理這兩個檔案，私密 registry 目錄維持 root 管理。若已有舊 HubClock 狀態，先停服務核對 owner，不直接覆蓋；不要對整個 private 目錄遞迴 chown。

```sh
cd /opt/neighbor-hub
sudo chown 10001:10001 /var/lib/neighbor-hub/private/mail-a.env \
  /var/lib/neighbor-hub/private/hubclock.sender.json
sudo chmod 600 /var/lib/neighbor-hub/private/mail-a.env \
  /var/lib/neighbor-hub/private/hubclock.sender.json
sudo install -d -o 10001 -g 10001 -m 700 /var/lib/neighbor-hub/hubclock
H02_CLOCK_UID=$(sudo stat -c %u /var/lib/neighbor-hub/private/hubclock.sender.json)
H02_CLOCK_GID=$(sudo stat -c %g /var/lib/neighbor-hub/private/hubclock.sender.json)
sudo stat -c '%u:%g %a %n' /var/lib/neighbor-hub/private/mail-a.env \
  /var/lib/neighbor-hub/private/hubclock.sender.json /var/lib/neighbor-hub/hubclock
h02_clock_stack() {
  sudo env HUB_OPS_UID="$H02_CLOCK_UID" HUB_OPS_GID="$H02_CLOCK_GID" \
    docker compose -p neighbor-hub -f /opt/neighbor-hub/deploy/compose.yaml \
    -f /opt/neighbor-hub/deploy/hubclock/compose.hubclock.yaml "$@"
}
h02_clock_stack config --quiet
h02_clock_stack pull hubclock
h02_clock_stack up -d --wait --wait-timeout 120 hubclock
h02_clock_stack ps
```

預期兩個憑證檔 `10001:10001 600`、狀態目錄 `10001:10001 700`，Mail healthy、HubClock running。Node image 已由 H-05 固定 digest；HubClock cap_drop ALL、read-only rootfs、128 MiB、不 publish port。只讀掛入 client、lifecycle 程式及自己的兩份憑證檔，狀態保存在上述主機目錄，不能換成未初始化 owner 的 root-owned named volume。

Mail 的基本設定與 override 都保留 **`HTTP_ALLOWED_HOSTS: mail-a`**。HubClock 從專用網路呼叫 `http://mail-a:8765/mcp/`；此欄只填主機名 `mail-a`，不是 `mail-a:8765`。否則上游回 421；這不是 token 壞掉，不能因此關閉驗證或開放任意 Host。新增這個 Host 不改 127.0.0.1-only 發布規則。

先在 VPS 本機看 log，等到真的完成一次 Mail tick，不能把 running 當成可用：

```sh
h02_clock_stack logs --no-color --tail 20 hubclock
h02_clock_stack run --rm --no-deps hubclock node /app/ops/lifecycle/main.mjs status
```

預期出現 `"ev":"tick"` 及 ingested／sent 數字，status 能列出 cursor 與 outbox 摘要；首次空收件匣的數字可以是 0。`tick_failed`、`fatal`、`crash` 都不算成功；排查 owner、600 檔與 Host allowlist。只回報 tick／錯誤 code 摘要，異常 msg 留在自己的 VPS 檢查。

主實例完成 tick 且仍在執行後，測第二個實例共用同一份狀態：

```sh
H02_STANDBY_EXIT=0
h02_clock_stack run --rm --no-deps hubclock node /app/ops/lifecycle/main.mjs once || H02_STANDBY_EXIT=$?
printf 'hubclock_secondary_exit=%s\n' "$H02_STANDBY_EXIT"
h02_clock_stack ps hubclock
```

預期第二個實例印 `"ev":"standby"` 且 exit **3**，主服務繼續 running。exit 3 是單 writer lock 正常阻止第二個 writer，不能列成部署故障；exit 0 或其他錯誤則先查主服務與 lock，不刪 lock 檔硬搶。

將實際 canonical name 交給 PM／H-04 填 `clock_agent`，來源是 600 的 `hubclock.sender.json`，不能寫死 `HubClock` 或 `hub-clock`。狀態路徑需交 H-06：目前備份預設仍為 `/var/lib/neighbor-hub/lifecycle`，部署備份時要明確指定 `--clock-dir /var/lib/neighbor-hub/hubclock`，並在一致性備份前停 HubClock、與 Mail 成套還原；只啟服務不代表備份排程已對齊。

## 7. office 有退步或部署失敗時回滾

以下只移除本次 hub 入口，恢復初始 office 設定；不刪 volume、不還原舊 token registry、不清 Caddy 憑證、不執行 `down -v`。先確認 `pre-h02.path` 指向**第一次部署前**的 office 備份，不是已包含 hub import 的後續備份。

```sh
# VPS，工作目錄 /opt/neighbor-hub。
H02_BACKUP=$(sudo cat /var/lib/neighbor-hub/backups/pre-h02.path)
sudo test -f "$H02_BACKUP"
sudo cp -a "$H02_BACKUP" /etc/caddy/Caddyfile
if sudo sh -c 'umask 077; /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /var/lib/neighbor-hub/private/caddy-rollback-validate.log 2>&1'; then
  sudo systemctl reload caddy
else
  printf 'rollback validate failed; do not restart Caddy; contact PM\n'
fi
H02_CLOCK_CONTAINER=$(sudo docker ps -q --filter label=com.docker.compose.project=neighbor-hub \
  --filter label=com.docker.compose.service=hubclock)
if [ -n "$H02_CLOCK_CONTAINER" ]; then
  sudo docker stop "$H02_CLOCK_CONTAINER"
fi
sudo docker compose -p neighbor-hub -f deploy/compose.yaml stop mail-a
sudo systemctl is-active caddy
```

預期 office 原服務繼續 active，hub 不再匯入，HubClock／Mail 停止但原文、計時狀態與 registry 留存。再從 Mac 比對 office 原回應碼與操作。若連已知備份都 validate 失敗，保留仍在運作的 Caddy、不要 restart，請 PM 協助。只讓 operator 在已核准範圍回退；不要為修 hub 去重灌整台主機。

## 8. 常見錯誤與證據界線

| 結果 | 下一步 |
|---|---|
| image pull 失敗 | 保留 registry／網路原錯誤；不換 tag 或 source |
| bootstrap 失敗 | 先查 loopback health 與 600 檔；不要關 fail-closed 或送上游 token 到聊天 |
| Mac 驗證回 FAIL／E-AUTH | 核對是否取了正確裝置 env、是否已撤銷；不把錯誤當成空 inbox |
| hub TLS 錯誤 | 查 DNS、HTTP-01、Caddy 私密日誌；不使用 `curl -k` |
| loopback 200，hub 502 | 查系統 Caddy 讀取權限、匯入路徑與 upstream；不公開 backend 排錯 |
| office 原狀改變 | 立即第 7 節回滾，不把原本 501 擅改成 200 |

本機已驗 Compose、官方 amd64 image、私密 token 工具、原生 MCP、H-03 8 個整合測試與隔離 HTTP Caddy。**尚未執行** VPS 的 import／systemd reload、實機公共 TLS／ACME、真 office 原狀比對、Mac 對 VPS backend 的外部不可達驗證。這些由 維護者 照本手冊收齊，未跑就保留未執行。

H-05 的計時規則依其單元／整合測試，本手冊補容器部署與 standby 驗證；H-06 的備份／還原排程仍須另行部署，不能由 health／收發測試冒充。原文、token registry、sender registry、HubClock 狀態與 Caddy 設定必須納入 H-06 備份，恢復入口前先套用最新撤銷紀錄。

官方參考：[Caddy import](https://caddyserver.com/docs/caddyfile/directives/import)、[Caddy Linux service 與 reload](https://caddyserver.com/docs/running#linux-service)、[Docker Compose port 綁定](https://docs.docker.com/reference/compose-file/services/#ports)。查詢日期：2026-11-17；以 VPS 實際 Caddy 版本驗證為準。
