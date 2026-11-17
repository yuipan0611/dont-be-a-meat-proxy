# 架構工作台第二版｜PM 交付

2026-11-17，維護者 已確認並要求實作；11-30 目標。工作區 `<LOCAL_HOME>/orca/workspaces/don't be a meat proxy/codex-senior-swe`，未 commit／push、未連 VPS。此文件補充 docs/09，第二版仍需 PM 整合與正式環境驗收。

## 已確認方向

首頁直接看到可逐層探索的系統架構，使用縮放＋點入；各部件有 overview，沿系統／服務／協議 API／模組／函式進到唯讀程式碼。工作回報附著在架構上。所有部件有 overview，四條核心流程做到程式碼；其餘不猜測尚未查證的內部。

## 本機交付

- 畫布拖曳、滑鼠／雙指縮放、縮放按鈕、小地圖、麵包屑與返回相機位置、元件／API／函式搜尋、可分享 hash。
- 中央通訊卡保留協議、method/path 與 MCP/控制事件操作；側欄列方向、驗證、輸入輸出與錯誤。
- 核心傳訊、收訊、交接、動作確認；3 個 JS 模組／17 個白名單函式。上游 Rust/Caddy/其他語言程式不宣稱已納入函式圖。
- AST 擷取真實程式碼與行號；revision、未提交狀態、SHA-256；白名單漂移時建置失敗。關係人工核對，非自動完整呼叫圖或實際執行追蹤。
- 新增受保護 `GET /api/code/:symbolId`；架構 API 只回傳符號 metadata。無任意 path／URL 讀取。workContext.symbols 選填、舊訊息相容。
- 跨組／成員撤銷限制沿既有 server 執行；靜態檔增加 `/explorer.js`，Caddy web.routes 必須同步更新。

## 證據

- `npm test --prefix web`：12/12 通過，含 AST、白名單與原始碼 API 的登入／撤銷／路徑拒絕。
- client：92 PASS、13 原有環境依賴 skip，0 fail；不是實體跨裝置回歸證據。
- Playwright：四條流程逐一取得程式碼，分別 43／65／53／17 行；頁面錯誤 0。搜尋 sendItem、重整還原程式碼、縮放矩陣改變；390px 手機清單無橫向溢位。
- Docker `hub-guide:lens` 建置成功，image 內建置快照；本機 artifact 約 44 KiB。尚未重測完整上線 stack 峰值 RAM。
- [全貌](ui/lens-overview.png)、[程式碼](ui/lens-code.png)、[手機](ui/lens-mobile.png) 皆為本機範例資料，不是正式環境截圖。

## PM 整合與剩餘驗收

收取 web/、deploy/web/、client 兩檔與文件增補；不要覆寫主分支 bot、memory 或其他 worker 修改。先建置 artifact，再啟動服務；Docker 會自行建置。更新 Caddy 公開靜態路由含 explorer.js，保留 API session 和 MCP bearer 的分流。

仍待：真 Discord callback、VPS/TLS 路由、真 Mail/GitHub 資料與原有流程回歸、完整 8 GB stack／128 MiB web 壓測、三位新手各自指出某流程的呼叫方向／介面／程式碼位置。source revision 與服務部署狀態另行核對，不把原始碼快照當作已部署。
