# Hub 備份、還原演練與到期刪除操作手冊（H-06）

- 負責：agy-junior-swe-1（H-06）｜審查：PM-Emily、維護者｜狀態：**已對齊 H-02 正式部署結構並通過端到端演練**
- 上游：`docs/ops/runbook-H02-deploy.md`、`docs/05-sds.md`（v0.3）、`docs/04-sad.md`、`docs/03-srs.md`（§4.4）、`docs/ops/vps-inventory.md`
- 核心事實（VPS 現況）：Ubuntu 26.04.1 LTS、Docker 29.9.1、系統 Caddy（`/etc/caddy`）、UFW 僅開放 22/80/443、可用磁碟空間約 76 GB。
- 維護者 決策定案：
  1. **每日備份**：VPS 本機滾動保留 7 天（7-day rolling rotation）。
  2. **每週加密拉回**：由 維護者 的 Mac 主動 pull（金鑰只在 Mac 本機，VPS 不存放任何加密私鑰或 Mac SSH 憑證）。
  3. **到期刪除**：所有專案資料保留至 2027-03-31（Asia/Taipei）後刪除；預設為 dry-run，需明確參數才執行真刪除。

---

## 0. VPS 前置依賴安裝

備份腳本需要 `sqlite3` CLI 以執行一致性在線備份快照（`.backup` 指令，確保 WAL 完整性）。

在 VPS 上執行：

```bash
sudo apt update && sudo apt install -y sqlite3
```

**檢查指令**：

```bash
sqlite3 --version
```

**預期輸出**：
顯示 SQLite 3.x 版本（例如 `3.45.1 2024-01-30 ...`）。

---

## 1. 架構與路徑變數（對齊 H-02）

依據 [`docs/ops/runbook-H02-deploy.md`](runbook-H02-deploy.md)，程式統一安裝於 `/opt/neighbor-hub`，Docker Compose 專案名稱為 `neighbor-hub`。

所有腳本支援透過環境變數或 CLI 參數覆蓋路徑。預設值對齊 H-02 正式部署：

| 變數名稱 | 預設路徑（VPS） | 說明 | 權限要求 |
|---|---|---|---|
| `HUB_DATA_DIR` | `/var/lib/docker/volumes/neighbor-hub_mail_a_data/_data` | mail-a 資料 volume（含 `mail.sqlite3` 與 `archive/`） | 容器用戶 `10001:10001` |
| `HUB_STATE_DIR` | `/var/lib/neighbor-hub/private` | 私密憑證目錄（含 `tokens.json`、`*.env`、`*.sender.json`，含 `hubclock.sender.json`） | 目錄 `0700`、檔案 `0600` |
| `CADDY_SNIPPET` | `/etc/caddy/hub.caddy` | 系統 Caddy 的 hub 站點配置片段 | root:root `0644` |
| `CADDY_PRIVATE_DIR` | `/etc/caddy/hub-private` | 系統 Caddy 私密認證片段目錄（含 `auth.caddy`） | 目錄 `0750`、檔案 `0600`（caddy 用戶） |
| `HUB_CLOCK_DIR` | `/var/lib/neighbor-hub/hubclock` | HubClock 狀態目錄（存放 `hubclock-state.json`、cursor、outbox） | 目錄 `0700`、檔案 `0600` |
| `BACKUP_DIR` | `/var/lib/neighbor-hub/backups` | 本地備份封裝目錄（滾動保留 7 天，與 H-02 之 `pre-h02.path` 共存不衝突） | 目錄 `0700`、檔案 `0600` |
| `RETENTION_DAYS` | `7` | 保留天數 | 正整數 |

---

## 2. VPS 每日備份

備份程式 `/opt/neighbor-hub/ops/backup` 採用 SQLite 官方在線備份 API（`.backup` 命令），在不停止 mail-a 服務的情況下獲取交易一致的資料庫快照（確保 WAL 頁面完整性），並同時備份：
- mail-a 資料庫 `mail.sqlite3` 與 storage root `archive/`
- Caddy 配置片段：`/etc/caddy/hub.caddy` 與私密認證 `/etc/caddy/hub-private/auth.caddy`
- 私密憑證與 token 檔：`/var/lib/neighbor-hub/private/`（`tokens.json`、`mail-a.env`、`mac.env`、`windows.env`、`mac.sender.json`、`windows.sender.json`、`hubclock.sender.json`）
- HubClock 狀態檔：`/var/lib/neighbor-hub/hubclock/hubclock-state.json`（保留 cursor、outbox、requests、processed，排除臨時 lock 檔）
- 自動生成 `manifest.json`（記錄備份時間、各檔案 SHA256、SQLite `PRAGMA integrity_check` 結果與資料庫筆數）

### 2.1 手動執行與單次驗證（VPS）

```bash
# 以 root 或具備 volume 存取權限的使用者執行
sudo /opt/neighbor-hub/ops/backup
```

**預期輸出**：

```text
[2026-11-17T03:15:00Z] Starting backup hub-backup-20261117-031500Z...
[2026-11-17T03:15:00Z] Source data: /var/lib/docker/volumes/neighbor-hub_mail_a_data/_data
[2026-11-17T03:15:00Z] Backup destination: /var/lib/neighbor-hub/backups
[2026-11-17T03:15:00Z] Creating consistent SQLite snapshot of mail.sqlite3...
[2026-11-17T03:15:00Z] SQLite backup verified ok (hash: 413d6668..., messages: 42)
[2026-11-17T03:15:00Z] Copying storage root archive/...
[2026-11-17T03:15:00Z] Copying Caddy snippet from /etc/caddy/hub.caddy...
[2026-11-17T03:15:00Z] Copying Caddy private auth snippet from /etc/caddy/hub-private...
[2026-11-17T03:15:00Z] Copying private tokens & sender files from /var/lib/neighbor-hub/private (permissions preserved 600)...
[2026-11-17T03:15:00Z] hubclock.sender.json included in backup (mode 600).
[2026-11-17T03:15:00Z] Copying HubClock lifecycle state from /var/lib/neighbor-hub/lifecycle...
[2026-11-17T03:15:01Z] Creating archive /var/lib/neighbor-hub/backups/hub-backup-20261117-031500Z.tar.gz...
[2026-11-17T03:15:01Z] Backup created successfully: /var/lib/neighbor-hub/backups/hub-backup-20261117-031500Z.tar.gz (SHA256: d6c5a375...)
[2026-11-17T03:15:01Z] Enforcing 7-day backup retention policy...
[2026-11-17T03:15:01Z] Backup complete. Retained: 7 backups. Rotated out: 1 old backups.
=== Hub Backup Receipt ===
Backup ID:    hub-backup-20261117-031500Z
Archive:      /var/lib/neighbor-hub/backups/hub-backup-20261117-031500Z.tar.gz
Checksum:     d6c5a375889f6c8424e8dd7ab79f4cb291283e0cc90462d6e66d7cfbbbc8e240
DB SHA256:    413d6668fb3e6d6a27876d13b35237bf7a511cb4fa2eb5f8e7ba531db0c24c5a
DB Integrity: ok
Retained:     7 (Rolling 7 days)
```

產出檔案說明：
- `/var/lib/neighbor-hub/backups/hub-backup-YYYYMMDD-HHMMSSZ.tar.gz`（權限 `0600`）
- `/var/lib/neighbor-hub/backups/hub-backup-YYYYMMDD-HHMMSSZ.tar.gz.sha256`（權限 `0600`）

---

### 2.2 設定 systemd timer 自動排程（推薦）

將專案範本部署到 systemd：

```bash
# 1. 複製 unit 檔案
sudo cp /opt/neighbor-hub/ops/templates/hub-backup.service /etc/systemd/system/
sudo cp /opt/neighbor-hub/ops/templates/hub-backup.timer /etc/systemd/system/

# 2. 重新載入並啟用計時器
sudo systemctl daemon-reload
sudo systemctl enable --now hub-backup.timer

# 3. 檢查計時器排程狀態
sudo systemctl list-timers hub-backup.timer
```

**預期狀態**：
`hub-backup.timer` 處於 `active (waiting)`，下次觸發時間為每日凌晨 03:15。

### 2.3 替代方案：crontab 排程

若不使用 systemd timer，可直接加入 root crontab：

```bash
sudo cp /opt/neighbor-hub/ops/templates/cron-backup /etc/cron.d/hub-backup
sudo chmod 644 /etc/cron.d/hub-backup
```

---

## 3. Mac 每週加密拉回（PULL 模式）

由 維護者 的 Mac 主動連線 VPS 拉回最新備份，並在 Mac 本機立即使用 `age`（或 `gpg`）加密保存。

> [!IMPORTANT]
> **安全防禦設計**：
> 1. PULL 架構避免在 VPS 放 Mac 的 SSH 私鑰或任何加密私鑰。
> 2. 即使 VPS 被破壞或洩漏，攻擊者無法解密已拉回 Mac 的備份副本。

### 3.1 前置需求（在 Mac 上）

```bash
# 安裝 age 或 gpg（二選一，推薦 age）
brew install age

# 若使用 age，生成一組專用備份金鑰（金鑰僅存放於 Mac 本機）
mkdir -p ~/.config/hub-backup
age-keygen -o ~/.config/hub-backup/key.txt
chmod 600 ~/.config/hub-backup/key.txt

# 查看公開金鑰（age1...）
grep "public key:" ~/.config/hub-backup/key.txt
```

### 3.2 手動執行拉回演練（Mac）

```bash
# 以 age 公鑰加密拉回最新備份（預設遠端目錄為 /var/lib/neighbor-hub/backups）
/path/to/ops/pull-weekly-backup.sh \
  --host <VPS_IP> \
  --user root \
  --port 22 \
  --remote-dir /var/lib/neighbor-hub/backups \
  --age-recipient-file ~/.config/hub-backup/key.txt \
  --local-dir ~/Backups/neighbor-hub \
  --keep-weeks 12
```

**預期輸出**：

```text
[2026-11-17T04:00:00Z] Encryption tool selected: age
[2026-11-17T04:00:00Z] Target VPS: root@<VPS_IP>:22
[2026-11-17T04:00:00Z] Local backup destination: <LOCAL_HOME>/Backups/neighbor-hub
[2026-11-17T04:00:00Z] Querying latest remote backup on VPS...
[2026-11-17T04:00:01Z] Latest remote backup identified: hub-backup-20261117-031500Z.tar.gz
[2026-11-17T04:00:01Z] Downloading hub-backup-20261117-031500Z.tar.gz via scp...
[2026-11-17T04:00:03Z] Downloaded archive SHA256: d6c5a375889f6c8424e8dd7ab79f4cb291283e0cc90462d6e66d7cfbbbc8e240
[2026-11-17T04:00:03Z] Checksum verified ok.
[2026-11-17T04:00:03Z] Encrypting with age -> <LOCAL_HOME>/Backups/neighbor-hub/hub-backup-20261117-031500Z.tar.gz.age...
[2026-11-17T04:00:04Z] Encrypted backup saved: <LOCAL_HOME>/Backups/neighbor-hub/hub-backup-20261117-031500Z.tar.gz.age (mode 0600)
[2026-11-17T04:00:04Z] Enforcing local weekly retention (keeping 12 most recent encrypted backups)...
=== Hub Weekly Pull Receipt ===
Remote Source:  root@<VPS_IP>:/var/lib/neighbor-hub/backups/hub-backup-20261117-031500Z.tar.gz
Archive SHA256: d6c5a375889f6c8424e8dd7ab79f4cb291283e0cc90462d6e66d7cfbbbc8e240
Encrypted File: <LOCAL_HOME>/Backups/neighbor-hub/hub-backup-20261117-031500Z.tar.gz.age
Tool Used:      age
Local Retained: 1 (Weekly rotation policy: 12 weeks)
Status:         PULL_AND_ENCRYPT_SUCCEEDED
```

### 3.3 設定 Mac launchd 每週自動執行（每週日 04:00）

```bash
# 1. 複製 plist 到使用者 LaunchAgents
cp /path/to/ops/templates/invalid.example.hub-weekly-backup.plist ~/Library/LaunchAgents/

# 2. 載入排程
launchctl load ~/Library/LaunchAgents/invalid.example.hub-weekly-backup.plist

# 3. 檢查狀態
launchctl list | grep invalid.example.hub-weekly-backup
```

---

## 4. 災難還原演練步驟（Disaster Recovery Drill）

還原腳本 `/opt/neighbor-hub/ops/restore` 會自動校驗 tarball 雜湊、SQLite 結構完整性（`PRAGMA integrity_check`）與原始 manifest 中的 sha256 記錄。

### 4.1 演練步驟

```bash
# 步驟 1：選定要還原的備份檔案
BACKUP_FILE="/var/lib/neighbor-hub/backups/hub-backup-20261117-031500Z.tar.gz"

# 步驟 2：先進行唯讀驗證（--verify-only，不寫入任何目錄）
/opt/neighbor-hub/ops/restore --backup "$BACKUP_FILE" --verify-only

# 步驟 3：停止目前 mail-a 服務（H-02 部署）
sudo docker compose -p neighbor-hub -f /opt/neighbor-hub/deploy/compose.yaml stop mail-a

# 步驟 4：執行還原到乾淨 volume 目錄
sudo /opt/neighbor-hub/ops/restore \
  --backup "$BACKUP_FILE" \
  --target-data-dir /var/lib/docker/volumes/neighbor-hub_mail_a_data/_data \
  --target-state-dir /var/lib/neighbor-hub/private \
  --target-caddy-snippet /etc/caddy/hub.caddy \
  --target-caddy-private /etc/caddy/hub-private \
  --target-clock-dir /var/lib/neighbor-hub/hubclock \
  --force

# 步驟 5：重新啟動 mail-a 服務
sudo docker compose -p neighbor-hub -f /opt/neighbor-hub/deploy/compose.yaml up -d mail-a

# 步驟 6：檢查容器健康狀態
sudo docker compose -p neighbor-hub -f /opt/neighbor-hub/deploy/compose.yaml ps
```

**預期還原收據輸出**：

```text
=== Hub Restore Receipt ===
Backup ID:        hub-backup-20261117-031500Z
Target Data Dir:  /var/lib/docker/volumes/neighbor-hub_mail_a_data/_data
DB SHA256:        413d6668fb3e6d6a27876d13b35237bf7a511cb4fa2eb5f8e7ba531db0c24c5a
DB Integrity:     ok
Message Count:    42
HubClock State:   restored (cursor: 42, hash: e3b0c442...)
Status:           RESTORE_SUCCEEDED
```

### 4.2 業務原文校驗（驗證 sha256 與 cursor）

還原後使用 `client/mail-client.mjs` 透過 `fetchEvents` 與 `readMessage` 讀回訊息：
1. `events.length` 與 `tailCursor` 必須與備份前一致。
2. 逐則計算 `readMessage(id)` 的 `message.body_md` 內 `text` 欄位 SHA256，必須與備份前雜湊 100% 逐字吻合。

### 4.3 HubClock 重啟後不重發校驗（No-Replay on Restart Verification）

災難還原後，HubClock 重新啟動時必須確保「重啟後不重發」：
1. **Cursor 不倒退**：`hubclock-state.json` 內的 `cursor` 完整保留，HubClock 不會從第 0 號事件重新拉取整份 Mail inbox。
2. **事件不重跑**：`processed` 陣列記錄的已處理 message ID 仍存在，歷史訊息不會被重複解析或觸發。
3. **Outbox 不重發**：`outbox` 中已標記為 `state: "sent"` 的通知項目不會重複向 Mail 發送信件（`flush()` 僅拉取 `state: "pending"`）。

**驗證方式（以容器或本機 CLI 執行單次 tick 驗收）**：
```bash
# 啟動 HubClock 執行一次生命週期 tick
docker compose -f /opt/neighbor-hub/deploy/compose.yaml -f /opt/neighbor-hub/deploy/hubclock/compose.hubclock.yaml run --rm hubclock node /app/ops/lifecycle/main.mjs once
```
**預期結果**：
- `ingested: 0`（無新增事件需要消費）
- `resolved: 0`（無過期需決議之項目）
- `sent: 0`（已送出的通知絕不重複發送）
- Mail inbox 訊息總數未增加，未產生重複通知郵件。

---

## 5. 到期刪除程序（2027-03-31 後）

依據 SRS §4.4，所有專案資料保存至 2027-03-31（Asia/Taipei）後刪除。

> [!CAUTION]
> **多重防誤刪保護**：
> 1. **時間硬防線**：在 **2027-04-01 00:00:00（Asia/Taipei）** 之前，腳本直接拒絕執行並報錯退出（除非帶有測試專用 override）。
> 2. **預設 DRY-RUN**：不加參數只會列印即將清除的清單與釋放磁碟量，絕不刪檔。
> 3. **顯式確認旗標**：必須明確輸入 `--confirm-purge-data-permanently` 才會實施刪除。

### 5.1 檢查清單（Dry-Run）

```bash
sudo /opt/neighbor-hub/ops/purge
```

**預期輸出**：

```text
=== Hub Data Purge [DRY-RUN MODE] ===
Current Time:      2027-04-01T08:00:00+0800 (Asia/Taipei)
Expiry Deadline:   2027-03-31

The following items are scheduled for permanent deletion:
 - [EXISTS] /var/lib/docker/volumes/neighbor-hub_mail_a_data/_data (51200 KB)
 - [EXISTS] /var/lib/neighbor-hub/private (64 KB)
 - [EXISTS] /etc/caddy/hub.caddy (4 KB)
 - [EXISTS] /etc/caddy/hub-private (4 KB)
 - [EXISTS] /var/lib/neighbor-hub/lifecycle (128 KB)
 - [EXISTS] /var/lib/neighbor-hub/backups/hub-backup-20270331-031500Z.tar.gz (10240 KB)

Estimated disk space to reclaim: ~61 MB (62832640 bytes)

[DRY-RUN] No files were deleted or modified.
To permanently execute deletion, rerun with:
  /opt/neighbor-hub/ops/purge --confirm-purge-data-permanently
```

### 5.2 執行正式清除

```bash
# 1. 停止相關服務與容器（移除 volume）
sudo docker compose -p neighbor-hub -f /opt/neighbor-hub/deploy/compose.yaml down -v

# 2. 執行永久刪除
sudo /opt/neighbor-hub/ops/purge --confirm-purge-data-permanently
```

**產出審計日誌**：
清除作業會將最後資料庫的 SHA256 簽名、操作者 UID 與刪除項目時間戳持久記錄於 `/var/log/neighbor-hub/purge-receipt-YYYYMMDD-HHMMSSZ.log`（權限 `0600`）。

---

## 6. 常見錯誤與排查（Troubleshooting）

| 錯誤現象 | 可能原因 | 解決步驟 |
|---|---|---|
| `sqlite3: command not found` | VPS 尚未安裝 sqlite3 套件 | 依第 0 節執行 `sudo apt update && sudo apt install -y sqlite3` |
| `boundary check failed ... Purge is NOT permitted before 2027-04-01` | 系統時間尚未超過 2027-03-31 | 依 SRS 4.4 不得提前清除資料。若為開發測試，加入 `--ignore-date-for-testing` |
| `Target data directory ... is not empty` | 還原目標目錄內已有檔案 | 確認舊資料已處置後，加上 `--force` 參數覆蓋 |
| `Archive checksum mismatch` | 備份 tarball 在傳輸中損壞或被改動 | 重新從 VPS 拉取；檢查 VPS 本地 `.sha256` 檔比對雜湊 |
| `SQLite integrity check failed` | 資料庫檔案損壞或異常中斷 | 檢查來源 `mail.sqlite3`；若 WAL 模式異常，執行 `sqlite3 mail.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"` 後重新備份 |
| `Permission denied`（SSH pull） | Mac SSH 金鑰無 VPS 登入權限 | 檢查 `~/.ssh/config`，確認 `ssh -p 22 root@<VPS_IP>` 能成功連線 |
| `Neither 'age' nor 'gpg' is installed` | Mac 缺少加密工具 | 執行 `brew install age` 或 `brew install gnupg` |
