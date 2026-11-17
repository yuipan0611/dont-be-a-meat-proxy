# UI-01～05｜新手專案導覽部署與驗收

2026-11-17；目標 11-30 最小唯讀版。此分支尚未接 VPS；以下供操作者操作，不是部署成功紀錄。

## 前提與設定

- 先整合本分支的 `web/`、`deploy/web/`、client workContext 變更；保留 PM 主分支其他 bot／memory／資料層修改。本實作不更改他人 worktree。
- 現有 Postgres hub 成員表與 discord_links 已有有效成員。網頁以 hub_app/service_role 讀取，只使用參數化、固定 group 查詢；此角色可繞過 RLS，隔離由 server 每個 API 的資格檢查與固定 group 強制。瀏覽器不持有 DB 或 Mail 憑證。
- 沿用既有 Discord application，於 Developer Portal 加精確 redirect `https://hub.example.invalid/auth/callback`。只需 identify scope，沿用現有成員名單，不開放自行加入。不要改 bot 的 Gateway／Interactions Endpoint 設定。
- 另建 web-only secret 目錄（0700），只放 hub-app.password、mail-a.env、discord-client.secret、github.token，檔案 0600 並讓容器 UID 可讀。GitHub token 僅給指定 repo 的 Issues read 權限。不可掛整個 bot 私密目錄。金鑰不得出現在指令、Git、畫面或日誌。
- 未提供 GitHub token 時不掛假檔；保持 HUB_WEB_GITHUB_TOKEN_FILE 空值，Issues 來源顯示未設定。取得正式唯讀 token 後設 HUB_WEB_GITHUB_TOKEN_FILE=/run/web/github.token。
- 設定 HUB_GROUP_ID=group-a、HUB_WEB_UID／HUB_WEB_GID、HUB_WEB_SECRET_DIR、HUB_WEB_MAP_FILE（核對後架構檔的**絕對路徑**）、HUB_DISCORD_GUILD_ID／HUB_DISCORD_APPLICATION_ID、HUB_WEB_ORIGIN。
- 架構設定中的 deployment 由操作者核對。未核對者維持待確認，不先宣稱已部署。

## Compose 與入口

在 repo 根目錄，沿用原本環境檔：

```sh
docker compose -f deploy/compose.yaml -f deploy/web/compose.web.yaml config --quiet
docker compose -f deploy/compose.yaml -f deploy/web/compose.web.yaml up -d --build web
```

需要 L-01 的 `neighbor-hub-db_hub-db-net` 已存在，Mail 所在網路仍為既有 mail_a_net；web 只發布 127.0.0.1:8781。先確認埠未被占用。memory 的 bank-proxy 使用 8780；web 預設 8781，可用 HUB_WEB_PORT 更改並同步 caddy.routes。128 MiB 為容器硬上限；既有 RAM 預算需加此項，並用完整上線 stack 壓測，總量須小於 8 GB。

**不要直接覆蓋 Caddy 設定。** 在既有 hub site 保留 TLS 設定，將原本單一 auth import 改成下列明確順序；先把 `deploy/web/caddy.routes` 放到 `/etc/caddy/hub-private/web.routes`：

```caddy
route {
  import /etc/caddy/hub-private/web.routes
  handle {
    import /etc/caddy/hub-private/auth.caddy
  }
}
```

使用 route/fallback handle，避免「所有裝置 token 都撤銷時 auth 檔只剩 respond 401」搶在網頁之前拒絕請求。Web `/`、assets、`/auth/*` 可公開，`/api/*` 交 web session 驗證。MCP `/mcp/`、memory 與其他路徑保留裝置 bearer 驗證。

對實際組合執行 caddy adapt／validate 成功後才 reload。驗收無 token 的 MCP 仍 401；若失敗立即回復原 Caddy 設定。office.example.invalid 不得受影響。

Discord 入口：由成員手動在專案頻道置頂「專案導覽：https://hub.example.invalid/」。這是普通登入連結，不含 token、code 或 session。首版不新增 slash command，也不更改現有 bot router。

## 驗收清單

- 本機：`npm test --prefix web`；client 回歸；demo 在桌面及 390px 手機可走「工作 → 架構 → 元件 → 工作」；鍵盤可操作，沒有橫向溢位。
- 真實登入：有效成員成功；非成員拒絕；拒絕 OAuth、state 錯誤／重播、登出、4h 到期都能重新登入。移除 member／link 後下一請求 401。
- 真實資料：既有 Mail 的 handoff/task/help/decision 顯示；讀網頁前後未讀狀態與 bot cursor 不變；缺標註顯示未知，不猜測。
- 正確性：AI completed、commit／PR 連結、AI 測試回報分開；GitHub Issue closed 不等於測試通過。沒有 CI 自動核對能力，不能出現「系統已驗證 CI 通過」。
- 故障：Mail／GitHub 暫斷、429、DB 失聯時有明確錯誤；舊來源顯示原時間；不顯示假的零筆新資料。重啟需重新登入且可重新取回資料。
- 作用範圍：不同 group 不能讀此實例；未知 item 404；網頁不支援派工／確認／撤銷；原有 Mac↔Windows、動手確認、撤銷流程回歸通過。
- 3 位新手各 2 分鐘：指出訊息保存元件、指定任務影響元件、結果依據。記錄成功人數與卡點，不以工程師測試替代。
- RAM：完整 stack 查 docker stats、主機 available memory；web 併發 10 人且重複更新不 OOM。容器加總不代替主機峰值驗證。

## 備份、日誌與回復

網頁沒有新增持久資料：session/cache 重啟丟棄，架構設定隨 repo 管理；Mail/PG 沿既有備份還原流程。已存在的成員撤銷紀錄由原系統保存。不要記錄 OAuth code、Cookie、Authorization 或原文；Caddy 不新增包含 query／憑證的 access log，既有日誌規則須排除 callback。

回復：停用 web，還原新增前的 Caddy 路由並驗證/reload，移除 Discord 置頂入口。Mail、DB、bot 原服務繼續；client 舊版忽略 work_context，無須改訊息或回滾資料庫。

## 已完成與尚未驗收

本機實作與測試結果見 `docs/09-ui-delivery.md`。VPS/TLS/真 Discord callback、完整 stack 8 GB 預算與三位新手測試必須由操作者補證據後才算上線驗收。

## 架構工作台第二版整合

新增靜態模組 `/explorer.js`：必須重新複製 `deploy/web/caddy.routes`，依原步驟驗證/reload；否則首頁模組可能被舊 bearer 規則擋住。`npm start` 會先建置 source snapshot；直接呼叫 Node 前需 `npm run build --prefix web`。Compose image build 自行重建，不依賴宿主 artifact。新 API `/api/code/:symbolId` 仍在原 `/api/*` session 驗證範圍內。

進階畫布、白名單維護及證據見 `docs/10-architecture-workbench.md`、`web/README.md`。正式 source revision 可經 Docker build arg SOURCE_REVISION 傳入；無 git 的 image 保守顯示未核對狀態，不假稱已發布。此 UI 仍唯讀、無 LLM 費用或新增持久資料。
