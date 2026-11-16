# H-01：準備既有 VPS 與 hub.example.invalid

日期：2026-11-17。負責：Codex 寫手冊，維護者 執行 VPS 指令，PM 收錄證據。期限：11-19；MVP 驗收：11-23。

依據：[SAD v0.3](../04-sad.md)、[SDS v0.3 API-01](../05-sds.md)、[H-01／H-02](../07-tickets-mvp.md)、[G2+G3 核准](../gates/G2G3-review.md)與 [F-08 第一部分 §2、§3](../research/F-08-hostinger-vscode.md)。有差異時，以核准決策與 SDS 為準。沿用既有 VPS，不使用 F-08 的重灌範本建議。

完成後應取得既有服務清單、可用的 Docker 與 Compose 版本、SSH 登入證據、防火牆規則，以及 `hub.example.invalid` 指向 VPS 的 DNS 查詢結果。Caddy、Mail、token 與憑證在 H-02 才部署。

追加分工：維護者 已授權 PM 透過 Hostinger 官方 MCP 查詢帳戶資料、只新增 `hub` A 記錄與 22／80／443 放行規則。此 worker 沒有暴露 Hostinger MCP 工具，PM 已接手這部分；下方 hPanel 步驟供 維護者 手動備援。執行前先看 PM 收據，避免重複新增。VPS 內的 Docker、ss、UFW 盤點仍由 維護者 操作。

## 1. 準備兩個終端機並確認金鑰登入

本手冊的「Mac」指 維護者 自己的 Terminal；「VPS」指 SSH 登入後的終端機。以下 shell 區塊可整段複製，先把引號內的 `<…>` 換成自己的值。畫面上的密碼、私鑰、token 都不貼回來，也不交給 agent。

1. 登入 hPanel，開 **VPS**，選擇原有的 2 vCPU／8 GB／100 GB 主機。
2. 在主機概覽記下公網 IPv4、主機識別、目前 OS 範本與狀態。使用 VPS 的 IP，不使用網站共享主機的 IP。
3. 留著原本能登入的 SSH 視窗，再開一個 Mac 視窗驗證。只改下面變數，沿用自己既有的帳號與 SSH port；預設是 22。

```sh
# 在 Mac 執行；這些變數不含秘密，只供這個視窗使用。
H01_VPS_IP='<VPS_IPV4>'
H01_SSH_USER='<既有登入帳號>'
H01_SSH_PORT='22'
ssh -v -o ControlMaster=no -o ControlPath=none \
  -o PreferredAuthentications=publickey -o PubkeyAuthentication=yes \
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
  -p "$H01_SSH_PORT" "$H01_SSH_USER@$H01_VPS_IP" 'id -un'
```

預期：debug 訊息出現 `Authenticated to … using "publickey"`，最後一行是登入帳號。這次連線只允許公鑰驗證，而且不共用舊連線，成功才算確認金鑰登入。`Enter passphrase for key …` 問的是本機金鑰的解鎖密語，可在自己的 Mac 輸入；不是要把密語貼給 PM。記錄成功與否及時間即可，不貼整份 debug log。[OpenSSH 選項說明](https://man.openbsd.org/ssh_config#PreferredAuthentications)。

常見錯誤：

- `Permission denied (publickey)`：帳號或所選金鑰不符。先保留舊連線，確認原本的登入方法；若原本使用 `-i`，在上面命令加 `-i '<自己本機的私鑰路徑>'`。若只有密碼可登入，回報 PM「金鑰登入待處理」，先不改防火牆或 SSH 設定。
- 首次連線詢問指紋：先以既有可信登入資料或 Hostinger 主控台核對主機指紋，再接受。
- `REMOTE HOST IDENTIFICATION HAS CHANGED`：停止，核對主機與 IP；不要刪掉 known_hosts 或略過驗證。
- 逾時：核對 VPS 是否運作、IP、實際 SSH port，以及目前來源 IP 是否在既有允許範圍。

確認後，另外開一個互動 SSH 視窗，用來跑下一節。預期看到 VPS 提示字元；這個視窗先保持開啟。

```sh
# 在同一個 Mac 視窗執行，沿用上面的變數。
ssh -p "$H01_SSH_PORT" "$H01_SSH_USER@$H01_VPS_IP"
```

## 2. 在 VPS 盤點，只讀取、不安裝

每個區塊分開執行，保留指令與完整輸出。缺少命令也是盤點結果，先貼原錯誤，不為了蒐集資料而安裝套件。不執行 `docker inspect`、`printenv` 或讀 `.env`，避免把秘密帶進回報。

### 2.1 讀取時間、OS、CPU 架構與 SSH port

```sh
# 在 VPS 執行。
date -u '+%Y-%m-%dT%H:%M:%SZ'
cat /etc/os-release
uname -m
getconf _NPROCESSORS_ONLN
printf '%s\n' "$SSH_CONNECTION" | awk '{print "目前 SSH server port:", $4}'
```

預期：UTC 時間、例如 `PRETTY_NAME="Ubuntu 24.04…"`、`x86_64` 或 `aarch64`、CPU 數及 SSH port。OS 與架構以實際值為準，不能把 hPanel 的範本名稱當成即時 OS 版本。若 port 空白，可能不是透過 SSH 登入，從原本登入命令和下一節的監聽清單核對。非 Ubuntu 也先回報，不改套用 Ubuntu 安裝指令。

### 2.2 讀取 Docker、Compose 與全部容器

```sh
# 在 VPS 執行；ps 不列 Command 欄，避免啟動參數中的秘密出現在回報。
docker version
docker compose version
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

預期：`docker version` 同時有 Client 與 Server 的版本及 API；`docker compose version` 有版本號；`ps -a` 列出執行中與已停止的容器。只有表頭表示沒有容器。`0.0.0.0:80->…` 或 `[::]:443->…` 表示已有容器發布該 host port。

常見錯誤：

- `docker: command not found`：Docker 未安裝，走 §3。
- `permission denied … docker.sock`：不能判成未安裝。維護者 有 sudo 權限時，用下面命令重查；sudo 密碼只在自己的終端輸入。不把帳號加入 docker 群組來繞過這次盤點。
- `Cannot connect to the Docker daemon`：可能是服務未啟動或 Docker context 指錯，不直接啟動或重啟服務，走 §3。
- `docker: 'compose' is not a docker command`：Compose plugin 缺少，走 §3。

```sh
# 只在上一段遇到 docker.sock 權限問題時，在 VPS 執行。
sudo docker version
sudo docker compose version
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

### 2.3 讀取監聽 port、記憶體、磁碟與 UFW

```sh
# 在 VPS 執行；sudo 才比較看得到監聽程序名稱。
sudo ss -tlnp
free -h
df -h
sudo ufw status verbose
sudo ufw status numbered
```

預期與判讀：

| 指令 | 應看到的資訊 | 常見錯誤或下一步 |
|---|---|---|
| `sudo ss -tlnp` | `LISTEN`、Local Address:Port、程序名稱；特別找 22 或實際 SSH port、80、443 | 沒有 80／443 列是部署前合理結果；有則走 §3。Docker 某些發布方式不出現在 ss，必須同看 docker ps 的 Ports |
| `free -h` | `Mem:` 的 total、used、available；看 available 判斷目前餘裕 | `command not found` 原樣回報；不假設規格上的 8 GB 都可用 |
| `df -h` | 根目錄及 Docker 所在檔案系統的 Size、Avail、Use% | 70% 起列容量提醒，85% 起先處理容量再部署；不要刪既有服務或 prune volume |
| `ufw status verbose` | `Status: active` 加 policy 與規則，或 `Status: inactive` | inactive 代表 UFW 未啟用，不代表 Hostinger 防火牆沒啟用 |
| `ufw status numbered` | 既有規則與編號 | `ufw: command not found` 代表未安裝；可能另有防火牆，回報 PM，不當成「完全開放」 |

SAD 的 MVP 規劃預留約 1,920 MiB，包含 OS／維運及備份餘裕；這不是實測峰值或部署門檻。PM 依既有負載與可用空間重新判斷。

### 2.4 把輸出貼回 PM

用 [vps-inventory.md](vps-inventory.md) 的空白模板，每組指令一個區塊，記時間、在哪裡執行、原始輸出及錯誤。可以貼給 PM，由 PM 更新版本管理裡的檔案。主機名稱與公網 IP 可列入本專案盤點，秘密不貼；若輸出意外含秘密，先改成 `<REDACTED>`，並註明遮蔽欄位。

預期：缺少命令或權限問題也有紀錄，不用把所有格子填成成功。此文件交付時，模板仍是「待 維護者 執行」，沒有冒充已完成 VPS 盤點。

## 3. 遇到衝突，先選保留既有服務的路

此節列處理選項，H-01 不直接安裝、升級、停機或更換代理。把選項及影響交給 PM／維護者 決定，再由後續部署票給出適用於實際 OS 的指令。

| 盤點結果 | 建議與其他選項 | 此時可複製的唯讀查詢與預期結果 |
|---|---|---|
| 80 或 443 已由 nginx、Apache、Caddy、Traefik 或其他容器使用 | 建議先確認服務用途與維護者，保留服務。選項一：既有代理依 hostname 把 hub 導到 SDS 的 Caddy，需另設計 HTTP-01／TLS 轉送並由 PM 核准；選項二：安排維護窗搬移既有入口、讓 SDS Caddy 接手；選項三：另用已核准主機。直接改 hub 到 8443 不符合固定 URL。未定前不做 H-02 port 綁定 | 重跑下面的 ss 與 ps，應能對出程序、容器與 host port |
| Docker 未安裝 | 建議依實際 OS 採 Docker 官方套件庫，在既有 OS 安裝 Engine 與 Compose plugin；先審查會衝突的套件。不要用 Hostinger OS 範本重灌。另一選項是沿用相容且仍受維護的既有發行版套件 | 下面的 apt-cache 僅適用 Debian／Ubuntu，預期 Installed／Candidate 或未找到套件；這一步不安裝 |
| Docker 太舊或缺 Compose | SDS 沒定 Engine 最低版本，不虛構數字。需仍受維護且支援 H-02 的 Compose 設定；不能只看 Client 版本。建議排維護窗更新既有來源套件，先備份並評估其他容器；另一選項是先在隔離主機證明現有版本相容。只有 `docker-compose` 舊指令不能當作 `docker compose` 可用 | 重跑 `docker version`、`docker compose version` 並記版本；H-02 再驗 `docker compose config --quiet` 與真實啟動 |
| Docker daemon 連不上 | 先分辨停用、rootless 或遠端 context，不直接 `start`／`restart`；讓 PM 評估啟動是否會連帶拉起既有容器 | 下方 systemctl 會顯示 active、inactive、failed 或找不到 unit；context show 只顯示目前名稱，非 default 回報 PM |

```sh
# 在 VPS 讀取 port 與容器對照。
sudo ss -tlnp
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

```sh
# 只在 Debian／Ubuntu VPS 查詢套件來源；其他 OS 不執行。
apt-cache policy docker-ce docker.io docker-compose-plugin docker-compose-v2
```

```sh
# 在 VPS 查詢服務與 context，不啟動服務。
systemctl is-active docker
systemctl --no-pager status docker
docker context show
```

若 `systemctl is-active` 顯示 inactive／failed，exit code 非 0 是有用的盤點結果。無 systemd 或 rootless Docker 可能沒有 system-wide unit，不因此判定未安裝。`apt-cache` 找不到 candidate 可能只是官方套件庫尚未設定；別直接跟著網路文章移除 `containerd` 或既有 Docker。

[Docker Ubuntu 官方安裝與升級說明](https://docs.docker.com/engine/install/ubuntu/)列出相容 OS、套件來源及衝突套件。此票保留既有服務，安裝命令等盤點後再由對應票提供。

## 4. 在 hPanel 放行 TCP 22、80、443

先確認 PM 是否已透過 MCP 完成。手動操作沿用 [F-08 §3](../research/F-08-hostinger-vscode.md)與 [Hostinger 官方 Firewall 說明](https://www.hostinger.com/support/8172641-how-to-use-a-managed-vps-firewall-at-hostinger/)。Hostinger 的預設是未允許的連入流量丟棄；保留舊 SSH 視窗不足以證明新連線可用。

1. 開 **VPS → 這台既有主機 → Security → Firewall**。
2. 記錄目前啟用的 firewall group、是否也套用其他 VPS，以及全部既有規則。若 group 共用，先回報 PM，避免同時影響其他主機。
3. 已有 active group 時，按該列 **⋯ → Edit**，只新增缺少的 accept 規則。若沒有 active group，先核對 §2 的全部既有服務與實際 SSH port；若啟用只含三個 port 的 group 會阻擋既有服務，停止並回報 PM，不直接啟用。
4. 確認沒有衝突後，缺 group 才按 **Add Firewall → 輸入名稱 → Create**，進 **Edit**。先加 SSH，再加 HTTP／HTTPS，最後才啟用；沿用既有服務需要的規則與 SSH 來源限制，不刪除既有規則。
5. 在 **Add firewall rule** 逐項填寫下表，按 **Add rule**。已存在且涵蓋需求的規則不重複加。

| Action | Protocol | Port | Traffic source |
|---|---|---|---|
| accept | TCP | 22 | 沿用既有 SSH 來源限制；若已有固定管理 IP／CIDR 就保留，不擴成 Anywhere |
| accept | TCP | 80 | Anywhere，供 HTTP-01 驗證及 HTTP 導向 |
| accept | TCP | 443 | Anywhere，供 HTTPS |

若 SSH 實際不是 22，仍須保留真實 SSH port 的規則。這張票要求的 22 也列入待新增清單，不改 sshd 監聽 port；如既有策略刻意封鎖 22，交 PM 確認後處理。若有明確 reject／drop 與新增規則衝突，停止並回報，不自行更改順序或刪規則。

6. 確認目標 group 是 **Active**，保存畫面與時間。官方說明變更通常在兩分鐘內套用，重新載入確認狀態。
7. 從 Mac 的新視窗重做 §1 的公鑰限定登入測試。預期再次看到 publickey 成功；失敗先保留原連線，透過 hPanel 的主控台查核，不反覆關閉防火牆。

預期畫面包含上述 accept 規則、原有規則及 active 狀態。不要開 8765、8888、9999、5432、Caddy admin 2019 或 Docker daemon 2375／2376。TCP 443 足供本案，不需要為 HTTP/3 另開 UDP 443。

### 4.1 UFW 是另一道門，先看目前狀態

```sh
# 在 VPS 再查一次；這不會更動規則。
sudo ufw status verbose
sudo ufw status numbered
```

若 UFW 已 active，且 §2 已確認新增 80／443 不與既有明確 deny 規則衝突，維護者 可在自己的 VPS 新增下列規則。這不修改 SSH 規則或預設 policy。

```sh
# 僅在上述條件成立時，由 維護者 在 VPS 執行。
sudo ufw allow 80/tcp comment 'Hub HTTP-01'
sudo ufw allow 443/tcp comment 'Hub HTTPS'
sudo ufw status numbered
```

預期 `Rule added`，或已存在時 `Skipping adding existing rule`，最後有對應的 ALLOW IN。若 sudo 權限不足，回報原錯誤；若前面有 deny 可能仍被擋，不自行刪掉或 insert 規則。UFW inactive／未安裝時先記錄，交 PM 安排；本票不直接跑 `ufw enable`、`reset` 或改 default policy，以免切斷原有服務。

Docker 的 host port 發布可能繞過 UFW，所以 H-02 必須從 Compose 就不發布 backend port，且從外網驗證，不能只看 ALLOW／DENY 表。[Docker 防火牆限制](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)。

## 5. 在 Hostinger 新增 hub 的 A 記錄

先看 PM 的 MCP 收據與 DNS 清單。只新增尚不存在的 `hub` A 記錄；若 hub 已有任何記錄，先停下回報 PM，核對是否已由 PM 完成，或與既有用途衝突。不得覆寫、刪除既有 DNS，尤其不動 MX、TXT、根網域或其他子網域。

1. 在 hPanel 開 **Domains → DNS → 選 example.invalid**。不同版面可從網域的 **Manage → DNS / Nameservers → DNS records** 進入。
2. 核對這個 domain 的實際 nameservers 確實由 Hostinger 託管；若不是，停止並回報 PM，不改 nameservers。新增前搜尋 `hub`，記下是否已有 A、AAAA、CNAME 或其他同名記錄。
3. 在 **Manage DNS records** 填下列值，按 **Add Record**。

```text
Type: A
Name / Host: hub
Points to / Value: <這台 VPS 的公網 IPv4>
TTL: 300
```

4. 重新載入列表，預期只多一筆 `A | hub | <VPS_IPV4> | 300`；核對既有記錄還在，留存時間與收據。

本票採 TTL **300 秒**，方便初次部署驗證；這是本案授權值，Hostinger 預設常為 14400。TTL 不保證五分鐘全球一致，舊的正向或負向快取仍可能存在。若介面拒絕 300，保留原錯誤交 PM，不自行換值。Name 只填 `hub`，不是 `@`、網址或 `hub.example.invalid.example.invalid`。不新增 AAAA；IPv6 可達性尚未驗證。[Hostinger DNS 入口與新增流程](https://www.hostinger.com/support/1583249-how-to-manage-dns-records-at-hostinger/)、[A 記錄欄位](https://www.hostinger.com/support/4468886-how-to-manage-a-records-at-hostinger/)。

常見錯誤：IP 欄填了 `https://` 或 port 會失敗，改成純 IPv4；已有 CNAME／其他記錄則回報 PM；查詢仍是舊 IP 先看 §6，不能靠刪除其他子網域排查。

## 6. 從 Mac 驗證 DNS，再記 HTTP 現況

### 6.1 DNS 應回傳該 VPS 的 IPv4

```sh
# 在 Mac 執行，不需要 SSH 或 token。
date -u '+%Y-%m-%dT%H:%M:%SZ'
dig +short hub.example.invalid
dig +short A hub.example.invalid @1.1.1.1
dig +short A hub.example.invalid @8.8.8.8
dig hub.example.invalid A +noall +comments +answer
dig +short AAAA hub.example.invalid
```

預期前三次都只回一行 `<VPS 公網 IPv4>`，與 hPanel 主機 IP 相同。下方是文件示範 IP，不能填進真實 DNS：

```text
203.0.113.10
```

完整 A 查詢應有 `status: NOERROR` 及 `hub.example.invalid. … IN A <VPS_IPV4>`。AAAA 預期空白；若已存在則回報 PM，不自行刪除。各地解析一致仍不是 TLS 或 MCP 驗收。

| 實際結果 | 判讀與下一步 |
|---|---|
| short 空白 | 單看空白無法分辨不存在、沒有 A、SERVFAIL 或逾時。看完整查詢的 status 與錯誤，再查權威 DNS |
| NXDOMAIN | 名稱尚不存在或負向快取未過期，核對 Host 欄與 authoritative answer |
| SERVFAIL | DNS／DNSSEC 等解析異常，回報 PM，不關 DNSSEC 硬解 |
| 回舊 IP、多個 IP 或 CNAME | 核對快取與既有記錄；若權威結果也不符，停止並回報 PM |
| `connection timed out` | 這個網路無法查該 resolver，不等於記錄未新增；保留錯誤，換可用網路重查 |

需要比對權威 DNS 時，先查 NS，再把其中一個實際名稱填入第二段命令。

```sh
# 在 Mac 執行；不修改 nameservers。
dig +short NS example.invalid
```

```sh
# 在 Mac 執行；換成上一段實際查到的其中一台 NS。
H01_AUTH_NS='<權威NS名稱>'
dig @"$H01_AUTH_NS" hub.example.invalid A +noall +comments +answer
```

預期權威回覆為正確 A；若權威已正確而其他 resolver 舊值未消失，等快取更新後再查，記錄時間與結果。若查不到 NS，回報 PM。Hostinger 提醒 DNS 傳播可能需到 24 小時；不要持續刪加記錄。[官方 DNS 傳播說明](https://www.hostinger.com/support/1583249-how-to-manage-dns-records-at-hostinger/)。

### 6.2 Caddy 部署前，HTTP 連不上可能是合理結果

先確認 DNS 已對到 VPS，再執行。`-I` 只讀 response headers；加上時間限制，避免一直等待。不帶 token、不加 `-k`、不自動跟隨跳轉。

```sh
# 在 Mac 執行；就是 curl -I http://hub.example.invalid 的限時版本。
curl --noproxy '*' --connect-timeout 5 --max-time 10 -I http://hub.example.invalid
printf 'curl_exit=%s\n' "$?"
```

| Caddy 部署前的實際結果 | 意義與預期處理 |
|---|---|
| `curl: (7) Failed to connect…`，exit 7 | DNS 正確、80 沒服務監聽時常見；記錄「尚未部署 HTTP」，不是 DNS 失敗。也可能是防火牆主動拒絕，仍須對照盤點 |
| `curl: (28) …timed out`，exit 28 | 可能被 Hostinger／OS 防火牆丟棄或網路不通；不算防火牆已驗通，交 PM 查核 |
| `curl: (6) Could not resolve host`，exit 6 | DNS 尚未可解析，回 §6.1 |
| `HTTP/1.1 200`、301、302、404 或其他 HTTP 回應，通常 exit 0 | 已有 HTTP 服務，不表示本案已部署；對照 §2 的 port 占用，先查現有服務用途。curl 未用 `--fail`，HTTP 錯誤碼也可能 exit 0 |

沒有 listener 時，單靠連線失敗無法證明 80／443 已對外放行。本票只記錄規則與現況；H-02 Caddy 啟動後，才驗 HTTP 導向、公共 TLS 與全路徑 token 驗證。現在不預期一定有 `200`、`308` 或 `401`。

## 7. 把結果交給 PM，確認 H-01 是否可結案

完成 [盤點模板](vps-inventory.md)的輸出區塊，讓 PM 核對：

- 公鑰限定的新 SSH 連線成功，實際 port／來源限制有紀錄。
- OS、Docker Client／Server、Compose、既有容器、監聽 port、RAM、磁碟與 UFW 都有結果或原始錯誤。
- 80／443 衝突及 Docker 安裝／升級需求已列負責人與處理方式。
- Hostinger 防火牆含需要的規則且 active，保留既有規則與服務；未能驗通的 port 標「待 H-02」。
- DNS 新增操作有 PM 的 MCP 回應或 hPanel 收據，`dig +short hub.example.invalid` 實值等於 VPS IPv4，HTTP 現況有紀錄。

有阻擋 H-02 的事項就標「受阻」，不要把文件完成寫成 VPS 或 H-01 實際驗收完成。

## 8. H-02 時 維護者 需要做的事，這次只列清單

- 確認 H-01 盤點與入口衝突已處理，約定可能影響既有服務的維護時段。
- 依 H-02 指令備份既有相關資料，核對現有快照狀態；本票不建立、刪除或還原快照。
- 取回審過的 `deploy/` 與 `ops/`，核對 commit、Linux CPU 架構、Mail artifact 與 image digest；Caddy 固定 v2.11.9，Mail 固定 SDS 來源。VPS 不編譯 Rust。
- 在 VPS 本地建立限權的私密目錄與設定，分別保存 Mac／Windows 裝置 token、A 組 upstream token；秘密不入 Git、不貼回聊天。
- 建立 A 組資料 volume、UID 10001 所需權限、Caddy 的 `/data`／`/config` 持久化與專用網路；Caddy 要有 ACME 出網，Mail 不 publish backend port。
- 驗證 Compose、Caddy allowlist 及記憶體限制，先做隔離 ACME staging，再由 Caddy 正式申請 HTTP-01 憑證；不跳過 TLS 驗證。
- 啟動 Caddy 與 `mail-a`，檢查 health、logs、資源與外網 port。MVP 不啟 Hindsight、資料庫、Discord bot。
- Bootstrap BlueLake、RedStone、HubClock，安全地把各裝置入口與註冊憑證放到對應本機。
- 跑真 MCP initialize、send／read、TC-01、TC-05、TC-10、TC-11，保存去秘密的實際輸出；備份排程由 H-06 接續，lifecycle 計時實作由 H-05 接續。

## 9. 文件驗證範圍

本手冊的 shell 區塊只做本機語法檢查，盤點區塊另外核對為唯讀命令；這不能證明 VPS 指令已執行、SSH 可登入、防火牆可達或 DNS 已生效。此 worker 未取得 SSH 權限，也沒有使用 Hostinger MCP。實際檢查命令及結果見 [H-01 文件驗證紀錄](H01-validation.md)。官方操作文件查詢日期為 2026-11-17。
