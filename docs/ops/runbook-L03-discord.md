# L-03：Discord bot（`/connect`、`/revoke`、`/status`、通知）

2026-11-17｜swe-Tom｜狀態：**本機測試通過，未部署、未接真 Discord／真 Anthropic**。部署由 PM 審本文後執行。

依據：`docs/research/F-06-discord-bridge.md`、PRD US-08／09／12、SRS SR-ID-05、SR-AST-01～05、SR-NTF-01～04、§4.5 #3／#9、SDS API-05、`docs/08-data-layer-supabase.md`、`docs/ops/runbook-L01-postgres.md`。

## 0. 先看這裡

| 功能 | 做了什麼 | 對應 |
|---|---|---|
| `/connect platform device?` | 只給成員；先 ephemeral defer；每次發**一把新的**裝置 token（256 bit），DB 只存 sha256＋前綴；**TokenApplier 確認 Caddy 套用後**才回「一行設定＋保存／刪除告知」；沒確認就作廢（`revocation_pending`），不顯示 token | TC-16、AC-12.1～12.3、SR-ID-05 |
| `/revoke token_id` | 本人才能撤；`active→revocation_pending→revoked`，**要 applier 回報 reload＋舊 token 401 probe** 才說「已撤銷」；否則維持待撤銷並明說未完成 | AC-12.4、12.5、API-05 |
| `/status question public?` | 只給成員、預設 ephemeral；Haiku 5.5（`claude-haiku-5-5`）；**只掛唯讀工具**（`recent_items`、`get_item`）；回答必須引用工具真的回傳過的 Mail ID，否則改成「記憶中沒有這項資訊」；回覆尾端固定附「依據：#ID（台北時間）」；決策一律標草稿（L-05 前） | TC-17、AC-08.1～08.7 |
| 每日上限 | 預設 0.50 USD／天（台北 00:00 日界，GAP-18）。每次呼叫前**原子預留最壞費用**，超過就回「今日查詢額度已用完」且不呼叫 LLM，並 DM owner 一次 | AC-08.5、SR-AST-04 |
| 通知 | bridge 用 Mail 的 `fetch_inbox_events`＋`resources/read` **偷看**（不標已讀）被監看 agent 的收件匣 → 只有 Hub 已保存的訊息才會通知；DM 內容：類型、寄件者、≤200 字摘要、Mail ID／時間、查看方式、「Discord 只通知，不能在這裡同意」 | TC-18、AC-09.1～09.4、§4.5 #3 |
| 離線 | 成員離線（presence）或積壓超過 10 分鐘（bot／Discord 停機）→ 不逐則補發，回來時送**一則**「你不在時有 N 則」；DM 失敗不自動重送，併入下一則彙總；送出結果不明記 `unknown`，不重送；DM 失敗不轉公開頻道 | §4.5 #9、SR-NTF-04 |
| HubClock 結果 | 進到成員 agent 收件匣的 result 以「HubClock 通知：已逾時／未回答…」推送（標籤與 L-00 一致）；presented／choice 等控制紀錄不推 | TC-18 |

**抄了什麼**：js-llmcord（MIT，SAD 釘的 c5615eb）的工具迴圈上限（`stopWhen: stepCountIs(max_steps)` → 這裡 `maxSteps=5`）、成員白名單概念、邀請 URL 格式；其餘（公開串回覆、RAG、多 provider）**不抄**——SDS 明定 `/status` 不用 js-llmcord 的公開預設。因為每一步都要先過費用閘門，所以用 Anthropic SDK 的手動迴圈，而不是 Bun＋Vercel AI SDK 整包 fork（VPS 也不裝 Bun）。

## 1. 檔案

| 路徑 | 作用 |
|---|---|
| `bot/src/router.mjs` | slash 指令定義與處理（defer、成員檢查、非成員固定拒絕） |
| `bot/src/connect.mjs` | `/connect`、`/revoke` |
| `bot/src/token-applier.mjs` | TokenApplier 的 bot 端（spool 檔案協定，見 §4） |
| `bot/src/assistant.mjs` | `/status` 助理：唯讀工具、引用檢查 |
| `bot/src/budget.mjs` | 價格表、台北日界、預留／結算 |
| `bot/src/bridge.mjs`、`deliver.mjs`、`notify-format.mjs` | 通知：讀 Mail → outbox → DM／彙總 |
| `bot/src/store-pg.mjs` | 唯一的 DB 存取（hub DB，hub_app→service_role） |
| `bot/src/discord.mjs`、`main.mjs` | discord.js Gateway adapter、進入點（`run`／`once`／`register-commands`／`check-config`） |
| `bot/Dockerfile`、`deploy/bot/compose.bot.yaml` | 容器（node:24-alpine 同 HubClock digest）與 Compose override |
| `supabase/migrations/20261119000000_l03_discord_bot.sql` | 新增 4 表：`bridge_cursors`、`discord_notifications`、`discord_presence`、`assistant_budget`（RLS＋只授 service_role） |

## 2. 測試（本機，2026-11-17，Node v24.18.0，Docker 29.9.3，arm64）

```sh
cd bot && npm ci
npm test                    # 44 pass／0 fail：Discord、LLM、TokenApplier 全用替身
npm run test:integration    # 10 pass／0 fail：真 Postgres（L-01 同 digest pgvector:pg18，全部 5 個 migration＋seed，以 hub_app 連）＋真本機 Agent Mail 0.3.40
cd .. && HUB_PG_PLATFORM=linux/arm64 node --test ops/test/postgres.integration.test.mjs   # L-01 原測試 10 pass（已把 migration 數 4→5、RLS 表數 9→13）
```

整合測試沒有 Docker 或 Mail binary 時會 **skip**，不會假裝通過。替身測試涵蓋：TC-16 只給本人／非成員拒絕／撤銷後重發／applier 失敗作廢；TC-17 引用 ID＋時間、草稿標示、編造 ID 被擋、額度 0 不呼叫 LLM、20 個並行預留不超額、台北跨日；TC-18 Mac→Windows 一則 DM、未保存不通知、離線彙總、失敗不逐則重送、Hub 斷線不漏。

**沒驗的**：真 Discord（沒有 bot token）、真 Haiku 5.5 呼叫與 EVAL-02、VPS 上的容器網路與 systemd 實際觸發。TokenApplier host 端見 §4b（L-03b）。

## 3. Discord application（維護者 建立；**不要**把 token 貼到聊天）

1. Discord Developer Portal → New Application → Bot。複製 **Application ID**、**Bot Token**。
2. **Intents**：預設全部關。只有要用「成員離線時改送彙總」才開 **Presence Intent** 與 **Server Members Intent**（privileged），並設 `HUB_BOT_PRESENCE_DIGEST=1`。不開時，「離線」只指 bot／Discord 停機造成的積壓（仍會彙總）。**不需要** Message Content Intent。
3. **OAuth2 scopes**：`bot`、`applications.commands`。**Bot permissions**：View Channels、Send Messages、Read Message History（= `68608`，只用來在頻道裡被 @ 時回「請用 /status」）。DM 不需要額外權限。
   邀請網址：`https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=68608`
4. 維護者 要和 bot 在同一個 guild，且 Discord 隱私設定允許該 guild 成員私訊（否則 DM 會失敗，記 `failed`）。
5. Anthropic API key：建一把專用 key（可在 Console 另設 workspace 花費上限當第二層保護）。

## 4. TokenApplier 協定（bot ↔ host helper）

bot 沒有 Docker socket、沒有 Caddy admin。它只寫 spool（host `/var/lib/neighbor-hub/token-spool`，0700，bot uid 擁有）：

| 檔 | 誰寫 | 內容 |
|---|---|---|
| `credentials/<token_id>` | bot（0600） | token 原值（只有 issue）；helper 搬到 `secrets/tokens/<token_id>` 後刪除 |
| `requests/<request_id>.json` | bot（0600，tmp＋rename） | `{v:1, op:"issue"\|"revoke", request_id, group_id, token_id, credential_ref?, created_at}` |
| `receipts/<request_id>.json` | helper | `{request_id, status:"applied"\|"failed", config_revision?, probe?, error?}`；revoke 需 `probe:401`（舊 token 實測被拒） |

helper 依 docs/08 §5：讀 `caddy_allowlist_export`＋私密檔 → 驗 hash → `caddy validate` → 原子替換 → reload → 寫 receipt。30 秒沒有 receipt，bot 視為 `unknown`：issue 作廢、revoke 維持待撤銷。

## 4b. TokenApplier host 端（L-03b，`ops/token-applier`）

root 執行的 oneshot，由 systemd path unit（requests 目錄非空就觸發）＋每分鐘 timer 備援叫起；單一 flock，一次處理一個申請。

| 申請 | 檢查 | 成功 | 失敗 |
|---|---|---|---|
| issue | DB 列 `active`；credential 是一般檔、600、spool 擁有者；`sha256 == token_hash` | 原值搬到 `/var/lib/neighbor-hub/private/tokens-db/<token_id>`（root 600）→ 產生 allowlist → `caddy validate` → `systemctl reload caddy`（系統 Caddy 的 ExecReload＝`caddy reload --force`）→ probe：無 token 401、新 token 200 → `devices.config_revision`＋audit `device.config.applied` → receipt `applied` | **validate 失敗絕不 reload**；validate／reload 失敗都還原舊 snippet；列改 `revocation_pending`＋audit `device.issue.failed`；刪 credential；receipt `failed` |
| revoke | DB 列 `revocation_pending`（bot 已設） | 產生不含它的 allowlist → validate → reload → 舊 token probe 401 → `revoked`＋audit `device.revoke.applied` → 刪私密原值 → receipt `applied, probe:401` | 維持 `revocation_pending`；receipt `failed`（bot 回「還沒確認完成」） |

- **產生規則**（docs/08 §5）：`caddy_allowlist_export` 每列都要有私密原值且 hash 相符，**任一列缺／不符就整批不套用**。MVP `tokens.json` 的 Mac／Windows 若還沒匯入 DB，照舊放行；同一 hash 在 DB 或 tokens.json **任一邊不是 active 就排除**。upstream header 沿用 `tokens.json` 的 upstream。輸出格式與 `ops/render-caddy` 相同（共用 `hub_ops.render`），寫 `/etc/caddy/hub-private/auth.caddy`，owner caddy、600。
- **只動 hub 的 private snippet**：不寫 `/etc/caddy/Caddyfile`、不碰 office 站；systemd `ReadWritePaths` 只有 `/etc/caddy/hub-private`、spool、private 目錄。Caddy 的錯誤輸出一律不印（可能含 token）。
- **冪等**：同一 request ID 已有 receipt 就不再套用，只把申請移到 `done/`。
- **競態**：bot 30 秒逾時把列改 pending 時，applier 套用後會再比對 DB，必要時立刻再 render 一次，Caddy 不會留下 DB 已不允許的 token。
- **DB 連不上**：回 receipt `failed`（bot 不用等到逾時），不動 Caddy。
- **第一次套用後**，`private/db-authority` 標記存在：舊的 `ops/render-caddy`／`ops/revoke`／`ops/issue` 會拒絕執行（否則只依 tokens.json 重產會把 /connect 發的裝置全部切掉）。之後撤銷一律用 Discord `/revoke` 或 `ops/token-applier render`。

## 5. 部署（PM／operator，在 VPS root shell）

前提：L-01 已部署；H-02 的 `deploy/compose.yaml` 與 HubClock override 正常；維護者 已依 §3 給出 Application ID、guild ID，並把 token／key 放進私密檔（下面第 2 步）。

```bash
cd /opt/neighbor-hub            # 部署本票核准的 commit
# 1) migration（只新增 4 表；預期前 4 個 SKIP、1 個 APPLY）
/opt/neighbor-hub/ops/postgres migrate
/opt/neighbor-hub/ops/postgres psql -Atqc 'select count(*) from _hub_ops.migrations'   # 5

# 2) bot 專用秘密（root 建、chown 給 bot uid、0400；不要 echo 內容）
BOT_UID=10002; BOT_GID=10002
install -d -m 700 -o $BOT_UID -g $BOT_GID /var/lib/neighbor-hub/private/bot /var/lib/neighbor-hub/token-spool
#   discord.token、anthropic.key：由 維護者 以編輯器直接寫入（不經聊天、不進 shell history）
install -m 400 -o $BOT_UID -g $BOT_GID /var/lib/neighbor-hub/private/hub-app.password /var/lib/neighbor-hub/private/bot/hub-app.password
install -m 400 -o $BOT_UID -g $BOT_GID /var/lib/neighbor-hub/private/mail-a.env       /var/lib/neighbor-hub/private/bot/mail-a.env
chown $BOT_UID:$BOT_GID /var/lib/neighbor-hub/private/bot/discord.token /var/lib/neighbor-hub/private/bot/anthropic.key
chmod 400 /var/lib/neighbor-hub/private/bot/discord.token /var/lib/neighbor-hub/private/bot/anthropic.key

# 3) 正式成員資料（S1 只有 維護者；不要跑 seed.sql）。ID 用字串。
/opt/neighbor-hub/ops/postgres psql -v guild="'<GUILD_ID>'" -v duser="'<OWNER_DISCORD_USER_ID>'" <<'SQL'
insert into groups (id, display_name, project_key, mail_hostname) values ('group-a','A 組','/data/projects/group-a','hub.example.invalid') on conflict do nothing;
insert into members (group_id, display_name, role) values ('group-a','維護者','owner') on conflict do nothing;
insert into discord_links (member_id, guild_id, discord_user_id)
  select id, :guild, :duser from members where group_id='group-a' and display_name='維護者';
SQL
#    通知要知道「哪個 agent 屬於 維護者」：在 維護者 的裝置列上設 allowed_agents（例 {BlueLake}、{RedStone}）。
#    MVP 的 Mac／Windows token 由第 5 步 `ops/token-applier import-mvp` 以 hash 匯入（allowed_agents 取 tokens.json 的 agent）；
#    /connect 發的新裝置列要另外 update allowed_agents（agent 名稱 register 後才知道）。
#    私密原值放 private/tokens-db/，隨既有每日備份（private 目錄）一起備份。

# 4) 啟動
export HUB_DISCORD_GUILD_ID=<GUILD_ID> HUB_DISCORD_APPLICATION_ID=<APP_ID> HUB_BOT_UID=$BOT_UID HUB_BOT_GID=$BOT_GID
export HUB_OPS_UID=... HUB_OPS_GID=...   # HubClock override 原本需要的值
DC="docker compose -f deploy/compose.yaml -f deploy/hubclock/compose.hubclock.yaml -f deploy/bot/compose.bot.yaml"
$DC build bot
$DC run --rm --no-deps bot check-config        # {"ev":"config.ok",...}
$DC run --rm --no-deps bot register-commands   # {"ev":"commands.registered","names":["connect","revoke","status"]}
$DC up -d bot

# 5) host TokenApplier（L-03b）
install -m 644 ops/templates/hub-token-applier.service ops/templates/hub-token-applier.path ops/templates/hub-token-applier.timer /etc/systemd/system/
systemctl daemon-reload
/opt/neighbor-hub/ops/token-applier import-mvp   # 把 MVP Mac／Windows token 以 hash 匯入 DB（需 §3 的 維護者 owner 列），套一次：validate→reload→probe
#   預期：Imported under DB authority: tok_mvpmac01, tok_mvpwindows01；Mac／Windows 原設定仍可用
#   之後依 tokens.json 的 agent 設 allowed_agents（import 已帶入 BlueLake／RedStone），bridge 會開始監看
systemctl enable --now hub-token-applier.path hub-token-applier.timer
systemctl list-timers hub-token-applier.timer --no-pager
journalctl -u hub-token-applier.service -n 20 --no-pager   # 每筆申請一行 {"request_id":…,"status":…}，不含 token
$DC logs --tail 20 bot                          # 一行 ready，之後每 15 秒一行 tick
```

確認：`docker ps` 的 bot 沒有 ports；mail-a、hubclock、db 的 StartedAt 不變（mail-a 只有在 HTTP_ALLOWED_HOSTS 原本不是 mail-a 時才會重建）；office 200、Hub 無 token 401。記錄 `docker stats` 的 bot 記憶體（上限 256 MiB，SAD 預算 384）。

## 6. 驗收（手機 Discord，證據放 `docs/evidence/S1/TC-16..18/`，不放 token）

- **TC-16**：維護者 `/connect platform:Windows` → 只有自己看到、有一行設定與保存／刪除告知。測試小帳號 `/connect` → 「你不是這個專案的成員」。`/revoke <token_id>` → 「已撤銷…實測 401」；再 `/connect` 拿到新的；舊的 curl 仍 401；另一台裝置照常 200。每一步在 `journalctl -u hub-token-applier` 有一行 applied，`audit_log` 有 `device.config.applied`／`device.revoke.applied`。office.example.invalid 前後都 200。故障演練（可選）：暫時讓 validate 失敗（例如在測試 VPS 改壞 Caddyfile 再改回），`/connect` 應回「發放失敗」、Caddy 沒有 reload、舊設定照常。
- **TC-17**：先有兩筆交接 → `/status 現在做到哪` → 回覆有「依據：#ID（時間）」、只有自己看得到；問記憶沒有的事 → 「記憶中沒有這項資訊」；`BOT_DAILY_CAP_USD=0` 重啟 bot 再問 → 「今日查詢額度已用完」且 Anthropic 用量沒增加；兩台電腦關機再問一次。
- **TC-18**：Mac 交接給 Windows → 15 秒內 DM（類型、寄件者、摘要、Mail #ID）；送給不存在的收件者 → 沒有 DM。

## 7. 回滾

`$DC stop bot && $DC rm -f bot`。migration 只新增表，保留不刪（之後 forward migration 才改）；`audit_log` 與通知列保留作稽核。撤銷進行中（`revocation_pending`）的裝置**不可改回 active**（觸發器擋），由 operator 依 docs/08 §5 完成撤銷。若 Discord token 外洩：Developer Portal Reset Token → 換檔 → `$DC restart bot`。

## 8. 未完成／待決

| 項目 | 狀態 | 誰 |
|---|---|---|
| TokenApplier host helper | **L-03b 已實作**（§4b）：本機假 Caddy／假 spool＋真 Postgres＋真 Caddy 2.11.9 validate 通過；VPS systemd 觸發與真 reload 未驗 | PM 部署（§5-5） |
| 真 Discord bot token／Application／guild ID | 等 維護者 依 §3 建立 | 維護者 |
| 是否開 Presence＋Server Members（privileged）以做「成員離線→彙總」 | 預設不開；不開時只對 bot／Discord 停機積壓做彙總 | 維護者／PM |
| Hindsight recall 唯讀工具 | L-02 完成後加到 `createReadOnlyTools`（同樣 `readOnly:true`） | Tom（L-02 後） |
| 決策「已確認」狀態 | L-05 前一律標草稿 | L-05 |
| EVAL-02、真 Haiku 5.5 回答品質 | 未跑（沒有 key、跑會花錢） | 上線驗收 |
| MVP 既有 Mac／Windows token 補進 `devices` 以便監看 | `ops/token-applier import-mvp`（§5-5） | operator |
| L-01 runbook 的 migration／RLS 表數 | L-03b 已改為 5／13 | — |
| `/status` 的資料來源只含 bot 開始監看後的項目 | 監看前的歷史不進索引（第一次從 tail 開始） | 接受（Hindsight 上線後補） |
