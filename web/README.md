# Hub 專案導覽（UI-01～05）

唯讀、零 LLM 呼叫的專案總覽、架構定位、工作回報及交接原文。純 JS/CSS/SVG；Node 22、pg 8.23.1（package-lock 固定依賴）。Discord OAuth 採官方 authorization code flow；不取代 MCP 裝置驗證。

## 本機看畫面

```sh
npm ci --prefix web --ignore-scripts
npm run demo --prefix web
```

開啟 http://127.0.0.1:8080 。示範模式只綁 loopback，資料為合成範例；正式入口 `src/main.mjs` 沒有 demo 開關。畫面每 30 秒更新；鍵盤焦點在工作卡或架構時暫緩自動重繪，可隨時手動更新。可點工作 → 查看詳情 → 在架構定位；手機改為元件清單。

```sh
npm test --prefix web
node --test client/test/*.test.mjs
```

## 正式資料與界面

- `GET /api/me`：成員名稱。
- `GET /api/architecture`：版本化元件與連線設定。
- `GET /api/overview`：最近 100 則工作紀錄（四種 topic 各讀最近 30 則後去重）、最近 50 筆 GitHub Issue API 結果（排除 PR）、各來源成功時間與故障狀態。這些是近期窗口，並非完整歷史或全專案統計。
- `GET /api/items/:id`：近期窗口內的原文投影；窗口外 404，歷史原文仍可從原有 AI read 指令查詢。
- `GET /auth/login`、`GET /auth/callback`；`POST /auth/logout` 要求同源 Origin。
- 每個 API 都重新查有效 Discord link／member 與伺服器指定 group。忽略 client 的 group 選擇；每組部署一個實例／資料設定，不提供跨組瀏覽。
- `fetch_topic`（上游既有工具，F-01b schema）是非消費式讀取。既有 notification cursor、agent inbox/read state 完全不變。
- GitHub REST 讀取固定 repo，30 秒快取，8 秒逾時；Mail 使用既有 client 逾時。來源出錯保留舊資料與原成功時間。快取只在記憶體，重啟後重新讀取。
- session 最長 4 小時，隨機 256-bit ID，server 只保留雜湊；HttpOnly/Secure/SameSite=Lax。重啟登出。OAuth state 一次性 5 分鐘；最多 500 個進行中 flow 與 session，額滿 429。Discord access token 不送瀏覽器、不持久化。
- 沒有寫入 API、LLM 摘要、CI 自動驗證或即時檔案監控。所有測試結果固定標「AI 回報」；commit/PR 連結只代表有連結，不代表內容已核對或測試已通過。

## 架構維護

編輯 `architecture.json` 的 `nodes / edges / reviewedRevision / ref`。元件以相對路徑前綴匹配，並允許 AI 明確指定 component ID。未知元件不猜測。元件與連線皆可鍵盤 Enter／Space 操作；手機另提供可點元件與串接清單。`deployment` 為人工核對資訊，不能由 source tree 推論 VPS 已部署。

初始資料標「規劃中／待操作者核對」，部署前由 PM 核對正式環境；`reviewedRevision` 是資料來源版本，不是服務健康探測。GitHub 路徑連結使用 `ref`，目前設 master。

## AI 工作標註（向後相容）

沿用既有 `send`／`checkpoint`，加選填 `workContext`。開工、阻塞、checkpoint、交接完成時附在原有紀錄，不新增遠端動手請求。收件者沿用實際專案設定；不要照抄不存在的 agent。

```json
{
  "summary": "修復 Windows 訊息接收",
  "text": "已定位到收件與確認的接縫，下一步做實機驗證。",
  "unfinished": ["實體 Windows 驗證"],
  "workContext": {
    "issue": "https://github.com/example-org/dont-be-a-meat-proxy/issues/1",
    "components": ["client", "gateway", "mail"],
    "paths": ["client/hub-hook.mjs"],
    "stage": "in_progress",
    "test_result": "本機測試通過，尚未實機驗證"
  }
}
```

`stage`：`in_progress / blocked / handoff / completed`，全部是作者回報。client 驗證欄位／長度／相對路徑並檢查密鑰；wire 欄位是 `work_context`。舊 client 不帶欄位仍有效。UI 把內容當文字，來源連結僅允許設定 repo 的 HTTPS GitHub URL。

目前無逐次編輯 hook；未回報不會自動亮起「正在處理」。要讓任務有精準定位，需要 agent 在原有交接帶上標註。

正式部署及 PM 驗收見 `docs/ops/runbook-UI-guide.md`。

## 參考與重用

- 重用本專案 `client/mail-client.mjs` 的 MCP transport（本分支基線 5bcb3ce），上游 Agent Mail image 版本沿原 Compose 固定 digest，不改上游。
- Discord 官方 OAuth2：https://docs.discord.com/developers/topics/oauth2 （查詢 2026-11-17）。只使用 code grant / identify / state；未複製第三方 OAuth 範例程式。
- PostgreSQL driver 沿現有 bot 的 pg 8.23.1；Node 22。沒有另加前端 framework、圖形套件、圖資料庫或模型 API。
- UI、固定 SVG layout、唯讀投影與 OAuth 接縫為本專案膠水程式。Node 容器基底沿 node:22-alpine，正式 release 若要求不可變基底，需由操作者鎖實際平台 digest。

## 架構工作台（第二版）

登入後首頁為架構畫布，五層：系統 → 服務 → 介面 → 模組 → 函式。四條核心流程提供完整下鑽入口：傳送訊息、接收訊息、工作交接、動作確認。其他服務明示本批可查證的深度。這是版本化設計與程式碼導覽，並非 runtime trace。

- 畫布：拖曳／滾輪／雙指縮放、＋／−／適合畫面、小地圖、麵包屑與搜尋；點節點看 overview，再「進入內部」。手機可切清單。鍵盤 Tab/Enter 操作；畫布方向鍵移動、＋／− 縮放。
- 中央通訊卡：HTTP method/path、MCP operation、協議；點「查看契約」查看驗證、輸入輸出與錯誤。函式間連線只列人工核對的本地呼叫，不推測動態呼叫。
- 程式碼：Acorn 8.15.0 在建置時依白名單擷取 3 個來源模組中的 17 個具名函式。快照含 revision、工作目錄未提交旗標、檔案與快照 SHA-256、行號與參數。白名單函式改名／缺失、語法錯誤會讓建置失敗。建置器不掃描 secrets 目錄，不提供任意檔案讀取 API。
- `GET /api/architecture` 回傳符號中繼資料，不含 code；`GET /api/code/:symbolId` 在同樣的成員／固定 group 驗證後讀快照。symbolId URL-encode，例如 `client/mail-client.mjs#createMailClient.sendItem`。不存在或路徑穿越要求 404。
- 工作標註可選 `symbols` 陣列（最多 40 筆），wire 仍為 `work_context`。若有精準 symbol 標註，函式只對應相同 ID；否則退回元件範圍，不推測變更函式。
- URL hash 保存 scope／selected／flow；分享後仍需登入。麵包屑返回會還原該層相機位置。

先 `npm ci --prefix web --ignore-scripts`；`npm run build --prefix web` 產生被 Git 忽略的 `.generated/architecture.json`。`npm run demo`／`npm start` 已加入 pre script。直接 `node src/main.mjs` 前也必須建置。

Dockerfile 在 image build 內重新產生快照，不使用宿主舊 artifact。可傳 `--build-arg SOURCE_REVISION=<完整 commit>`；容器內無 .git，因此保守標記來源尚未核對提交狀態，檔案雜湊仍精準對應快照。正式發布由 PM 核對 revision 與工作目錄，不能拿 source hash 當成 VPS 部署證明。

加入白名單函式請編輯 `scripts/build-architecture.mjs` definitions 與 `public/explorer.js` 的對應介面／說明。這份導覽明確針對 Hub 核心流程；接入其他 repo 需重新審查白名單與架構設定，不能只換 repo 名稱。
