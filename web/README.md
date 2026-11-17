# Hub 架構白板（第五版深色科技主題）

Notion 形式的巢狀架構頁面，主畫布實際採用 React Flow。保留第三版的真實來源模型、白話說明、訊息流程與受保護原碼 API。

## 本機預覽

需要 Node >=22、npm、Python 3。Python 只在建置時使用標準 AST。

```sh
npm ci --prefix web --ignore-scripts
DEMO_PORT=8084 npm run demo --prefix web
npm test --prefix web
node --test client/test/*.test.mjs
```

開啟 http://127.0.0.1:8084/ 。不設定 DEMO_PORT 時預設 8080。demo 只綁 loopback，架構來自當前 repo；工作回報明確標為合成範例。正式入口 `src/main.mjs` 沒有 demo 開關。

`npm run build --prefix web` 會先掃描架構，再用 esbuild 打包 React Flow；產物位於 `.generated/architecture.json`、`.generated/ui/board.js`、`board.css`、`THIRD_PARTY_LICENSES.txt`，均不進 Git。正式 start／demo 及 Docker build 都會先建置。

## 白板與頁面

- 空白處拖曳平移、滾輪／雙指縮放；左下放大、縮小、適合畫面；右下小地圖可拖曳／縮放。
- Shift＋拖曳或上方「框選」模式選多個零件，選取數會顯示。卡片可拖動，連線端點隨之更新；不提供刪除、建立連線或改程式內容。
- 點卡片看白話說明；雙擊或「打開白板」進入零件自己的頁面。服務 → 模組 → 函式白板 → 原始碼頁。設定檔沒有函式時顯示真實來源與說明，不捏造函式。
- 左側是完整巢狀頁面樹：展開／收合、目前頁高亮、搜尋所有頁面（含尚未展開的函式）。方向鍵移動與展開，Enter 開頁；上方麵包屑返回父頁。URL `#page=...` 可分享／重載，仍需登入。
- 每頁的平移、縮放與卡片位置在目前瀏覽器執行期間記住，返回可還原。**重整會重置排版**；沒有向 server 儲存、跨裝置同步或多人編輯。
- 桌面左側目錄、中央白板、右側白話說明；手機以目錄和說明抽屜開啟。手機初始只聚焦可讀卡片，其他內容沿無限畫布平移查看；「適合畫面」才縮小全部零件。

上方流程教學包含交接、動作確認、記憶索引，可播放／暫停／步進。編號箭頭是教學先後，真正的 caller → callee 另列在本頁目錄。Windows 主動讀取 Mail，不是 Mail 推送。播放不發訊息或執行動作。減少動態效果偏好會停用邊線動畫、頁面過場與平滑相機移動。

## 來源、模型與唯讀限制

掃描 client、ops、server、bot、web、deploy、supabase，包含 lifecycle／bank-proxy／memory-bridge／token_applier／validator。checkout 只掃 Git 已追蹤來源；新來源先 `git add` 再建置。Docker 沒有 .git 時採排除秘密／依賴／生成檔／symlink 的 filesystem fallback。

Acorn 擷取 JS、Python ast 擷取 Python、Go 用明示限制的詞法範圍掃描；Compose／Caddy／SQL 是設定語法擷取。JSX／CSS 納入模組目錄；JSX 由 esbuild 編譯，沒有假稱 Acorn 能擷取它的函式。跨程序關係與白話解釋人工補充，部分細部函式沿模組上下文說明；不宣稱完整執行呼叫圖。外部 Mail／Hindsight 映像沒有 repo 原碼時不捏造內部函式。

維護模型：`scripts/architecture-notes.mjs`、`scan-architecture.mjs`、`python-symbols.py`。維護頁面樹：`public/pages.js`；白板套件接頭：`public/board.jsx`；導覽／說明／流程：`public/explorer.js`。來源 anchor 或核心函式漂移會使建置失敗。

## API、登入與組別隔離

沿用第三版 server 驗證：

- `/api/me`、`/api/architecture`、`/api/overview`、`/api/items/:id`、`/api/code/:symbolId` 每次檢查有效成員與固定 group，不接受瀏覽器選組。
- 架構 API 僅含 symbol metadata，原碼需由登入後的建置白名單端點讀取；沒有任意檔案／URL 讀取。
- Discord code grant／state、4h session、同源 logout、撤銷後下次請求拒絕均沿用。CSP 未放寬，無 CDN／遠端字型／瀏覽器 LLM。
- Mail 主題讀取不消耗既有 inbox／通知游標；來源失敗保留原時間，不偽造新鮮零筆結果。

工作標註 workContext 與 client wire 不變；AI 回報完成、commit 連結、測試結果分開，網站不派工、不批准、不執行動作。

新增固定靜態檔 `/pages.js`、`/board.js`、`/board.css`、`/board-licenses.txt`；Caddy 的 `deploy/web/caddy.routes` 已同步，仍保留 master 的 loopback 8781。正式部署沿用 [UI runbook](../docs/ops/runbook-UI-guide.md)，不要覆蓋既有 office／MCP bearer 設定。

## 套件與授權

實際使用固定版本 @xyflow/react 13.0.2、React／react-dom 19.3.1、esbuild 0.28.2。React Flow core 是 MIT；保留畫面 React Flow attribution，打包時依實際引用的 17 個套件彙整授權至 `/board-licenses.txt`，沒有把它們全部簡稱 MIT。

[官方方案比較與授權](../docs/research/F-12-architecture-viz.md) 新增第四版章節：tldraw、Excalidraw、React Flow、AFFiNE。頁面樹／麵包屑／每頁視野由本應用建模，React Flow 的 sub-flow 不是現成 Notion 頁面管理器。

[第四版交付、桌面手機截圖與驗證](../docs/12-infinite-architecture-board.md)。來源快照不等於已部署；本機瀏覽器檢查不替代真 Discord／VPS/TLS／實體裝置與新手理解度驗收。

## v5 深色科技主題

保留 v4 三欄與巢狀頁。參照 terax.app 的近黑層次與等寬 metadata、insforge.dev 的薄框／格線／薄荷綠，沒有複製 logo、文案或品牌圖片。Inter／Geist Mono 由同源提供，字型及 OFL notices 在 public/fonts；CJK 使用原有系統 fallback。

⌘K／Ctrl K 或頂部搜尋按鈕開啟命令面板，可搜尋未展開的頁面，用上下鍵選取、Enter 跳頁、Escape 關閉。卡片 hover 顯示柔和光暈與關聯線，白板選取和目錄互相高亮。播放有沿連線移動的光點；進入／返回有縮放過場。reduced-motion 動態切換會停用光點、CSS 過場與新相機動畫，並取消正在進行的頁面過場。工作定位改用虛線，不降低可操作文字的透明度。

新增固定同源資產 /tech.css、/fonts/inter-latin.woff2、/fonts/geist-mono-latin.woff2、/font-licenses.txt；CSP 與會員／group／原碼白名單未放寬。完整 [v5 交付與對比截圖](../docs/13-dark-tech-workbench.md)、[設計 tokens](../docs/ui/design-tokens.md)。
