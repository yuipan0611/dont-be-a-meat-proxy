# Hub 系統圖譜（第三版）

給程式新手看的五層架構探索：系統全貌 → VPS 服務 → 串接與協議 → 來源模組 → 函式與原始碼。每個零件提供白話用途、需要原因、輸入輸出、故障影響及來源。沿用純 Node／JS／CSS／SVG、Discord OAuth 與既有唯讀 API。

## 本機預覽與驗證

需要 Node >=22、npm、Python 3；Python 僅在建置時使用標準 AST，不執行被掃描的程式。

```sh
npm ci --prefix web --ignore-scripts
npm run demo --prefix web
# 預設 8080 被占用時：
DEMO_PORT=8083 npm run demo --prefix web
npm test --prefix web
node --test client/test/*.test.mjs
```

`demo` 自動先建置架構，僅綁 127.0.0.1。工作紀錄是明確標示的合成範例，架構則來自目前 repo 的真實來源快照。正式 `src/main.mjs` 沒有 demo 開關。工作回報每 30 秒更新，焦點在工作卡／架構工作台時暫停自動重繪；不重置已讀程式碼。

## 看圖方式

- L0：你、Mac、Windows、VPS、Discord、GitHub。點一下看用途，點「進入內部」或雙擊下鑽。
- L1：入口／驗證／記憶門禁、Mail／HubClock／Bot／Bridge／web／token applier、記憶與資料庫、維運工具。這是邏輯服務，不把 Caddy／主機工具錯當 Docker 容器；詳情另列 Compose 設定證據。資料表可點選。
- L2：交接、動作確認、記憶索引三條流程可播放／暫停／前後步進。編號箭頭是**教學先後**；真正的發出呼叫方向在下方全部串接目錄，可點閱協議與來源。Windows 主動讀 Mail，並非 Mail 推送。訊息種類另有來源目錄。
- L3：按服務切換真實模組；圖上顯示最多 12 個，完整模組目錄可捲動。JavaScript import 僅代表靜態依賴。
- L4：選來源模組或搜尋函式，中央顯示受保護的真實程式碼、原檔行號與 SHA-256。完整函式索引可展開。未提供上游原碼的外部映像不捏造函式。

畫布可拖曳、Ctrl／Cmd＋滾輪縮放、按鈕縮放／重設，鍵盤方向鍵平移，Tab／Enter 操作零件與連線。手機單欄保持字體可讀，點選後捲到說明並可返回架構圖；程式碼區可水平捲動。`prefers-reduced-motion` 關閉移動與虛線動畫。URL hash 保存層級、服務、模組與函式；點中的圖上連線尚不保存 hash。

## 架構模型與來源限制

`npm run build --prefix web` 產生被 Git 忽略的 `web/.generated/architecture.json`。`atlas` 包含 services、modules、connections、tables、messages、containers、entrypoints、imports、calls、inventory、coverage；`symbols` 包含來源快照。交付時另保存 metadata-only 的 [`F-12-architecture-model.json`](../docs/research/F-12-architecture-model.json)，以其中 revision 為準。

掃描七個根目錄：client、ops、server、bot、web、deploy、supabase，包含 lifecycle／bank-proxy／memory-bridge／token_applier／validator。checkout 使用 `git ls-files`，所以新增來源必須先加入版本管理；沒有 .git 的 Docker image 使用排除私密檔與 symlink 的 filesystem fallback。測試、fixtures、private、.env、key、token、password、node_modules、generated 不納入原始碼 API。

JS 用 Acorn AST、Python 用標準 ast、Go 用註解／字串遮罩與括號計數（**不是 Go AST／型別分析**）；SQL／Compose／Caddy 是語法擷取。Compose 不展開秘密環境變數、不合併 override；資料表不是 VPS live schema。匿名 callback 不獨立建節點，本地呼叫只是靜態候選。跨服務關係及白話解釋人工核對；部分細部函式說明沿用模組上下文，完整行為仍須讀來源。

修改白話說明與跨服務連線：`scripts/architecture-notes.mjs`；擷取：`scripts/scan-architecture.mjs`、`scripts/python-symbols.py`。來源 anchor 缺失、核心 17 個符號漂移或解析失敗會讓建置失敗。每項帶來源路徑與行號。行號對應本機快照，能解析到函式的證據直接打開本機讀取器；「GitHub 參考」明示可能與本機不同。

## 正式 API 與隔離

- `GET /api/me`：有效成員名稱。
- `GET /api/architecture`：版本化模型及符號 metadata，排除 code。
- `GET /api/code/:symbolId`：建置白名單的函式原始碼；沒有任意 path／URL 讀取。
- `GET /api/overview`：最近 100 筆 Mail 工作回報、最近 GitHub Issues 結果與來源狀態。
- `GET /api/items/:id`：近期窗口中的交接原文。
- Discord `GET /auth/login`、`GET /auth/callback`；同源 `POST /auth/logout`。

每個 API 都重新查有效 Discord link／member 與 server 固定 group，不接受瀏覽器指定組別。session 4 小時，HttpOnly/Secure/SameSite=Lax；OAuth state 單次使用 5 分鐘。Mail fetch_topic 不消耗原有 inbox／通知游標。來源失敗保留原成功時間；不偽造新鮮零筆資料。未更動現有 OAuth／DB schema／client wire contract。

workContext 保留 components、paths、symbols、stage、test_result 等選填標註。AI 回報完成、commit 連結、測試結果分開呈現；不宣稱 CI 自動核對。網站不派工、不批准、不執行動作，也不呼叫 LLM。

Docker：`docker build -f web/Dockerfile -t hub-guide:atlas-v3 .`，image 內帶全部來源根目錄並重建快照；秘密由 Docker ignore 排除。`SOURCE_REVISION` 可作 build arg。來源快照與教學動畫都不能證明已部署或已執行。

## 交付與參考

[第三版交付與逐層截圖](../docs/11-architecture-atlas.md)、[掃描限制](../docs/research/F-12-scan.md)、[方案比較](../docs/research/F-12-architecture-viz.md)。借 C4／Structurizr 分層與 Dynamic 教學順序、Backstage 分類、React Flow 互動模式；沒有複製上游程式、導入整套平台或另加畫布依賴。正式部署沿用 [`runbook-UI-guide.md`](../docs/ops/runbook-UI-guide.md)，真實 OAuth、VPS/TLS、完整 stack 壓測與新手理解度仍需 PM/維護者 驗收。
