# 第四版：巢狀架構頁面與無限白板

2026-11-18，依 維護者「設計成無限白板那種 Notion 形式：可以點擊進去，旁邊當然還有目錄頁」實作。工作區 codex-senior-swe／example-org/ui-workbench；先 merge master 最新 `53a38d9`（包含 UI v3 merge `32779ce`）。不 push、不改 master、不操作 VPS、不碰 spikes。

## 可開啟的結果

本機預覽 **http://127.0.0.1:8084/**。使用獨立 loopback 埠，保留先前 8080／8083 的程序；demo 工作回報明示合成，來源模型來自 repo。

| 場景 | 桌面 1600×1000 | 手機 390×844 |
| --- | --- | --- |
| 白板全貌 | [總覽](ui/board-desktop-overview.png) | [總覽](ui/board-mobile-overview.png) |
| 打開一層 | [Hub VPS](ui/board-desktop-enter.png) | [Hub VPS](ui/board-mobile-enter.png) |
| 展開目錄樹 | [巢狀模組／函式](ui/board-desktop-tree.png) | [目錄抽屜](ui/board-mobile-tree.png) |
| 流程教學 | [交接流程](ui/board-desktop-flow.png) | [交接流程](ui/board-mobile-flow.png) |

另有 [原始碼頁](ui/board-desktop-code.png)。原 atlas-* 截圖保留作 v3 歷史，board-* 才是本次版本。

## 實際行為

主畫布使用 **React Flow core**，有空白拖曳平移、滾輪／雙指縮放、Shift 或按鈕框選、可拖卡片、分組框、可點連線、縮放控制與小地圖。圖沒有邊界；沒有新增筆畫／自由文字／寫入後端等本次未要求功能。框選不會批准或執行任何工作。

每個零件有目的頁：系統 → 服務白板 → 模組白板 → 函式白板 → 原碼頁。點卡片顯示白話說明；雙擊或明確「打開白板」深入；麵包屑返回。左側完整頁面樹可展開、收合、搜尋、鍵盤操作；目前頁高亮並捲到可見範圍。直接網址 `#page=...` 可還原頁面，仍受登入驗證。

每頁視野與拖動位置在目前 browser runtime 的記憶體保留；返回原頁還原。**重新整理會重置排版，不宣稱 server 永久保存、跨裝置同步或多人共編**。大頁面初次只取前六張卡片建立可讀視野；手機聚焦第一張卡片，其他零件用平移、小地圖或「適合畫面」探索。這是白板，不再把手機圖改成很長的清單。

頁面／相機過場會在 reduced-motion 下停用。流程教學沿用三條流程與前後步進；動畫代表先後順序，不是即時流量，Windows 仍主動讀 Mail。白話用途、需要原因、輸入／輸出、故障影響、關聯、來源行號、工作回報與原碼閱讀保留。設定類模組沒有函式時顯示實際來源說明卡，沒有空白占位或假函式。

## 選型與重用

兩個 Codex 子 agent 平行做授權研究與 React Flow adapter，獨立 Codex 做視覺審查，另一位整理設計文件。無 provider 替換或 worker 啟動失敗。

[研究新章節](research/F-12-architecture-viz.md) 比較 tldraw、Excalidraw、React Flow、AFFiNE 的官方授權、商用／浮水印、巢狀頁與性能考量。選 React Flow MIT 的實際套件，沒有自造平移／縮放／框選引擎；巢狀頁由本應用依架構模型建立。保留 React Flow attribution，依實際 bundle 彙整 17 個套件授權並提供 `/board-licenses.txt`；不將 tldraw 或 AFFiNE 全套誤稱 MIT。

固定版本 @xyflow/react 13.0.2、React／react-dom 19.3.1、esbuild 0.28.2；無 CDN，約 472 KiB JS、20 KiB CSS（未 gzip）。每頁掛載子圖且只渲染可見零件；沒有宣稱無限節點或跑分勝過其他套件。

## 驗證

| 項目 | 結果 | 證據 |
| --- | --- | --- |
| web | **19/19 pass，0 fail／skip**，包括頁面 ancestry、搜尋未展開函式、破損來源拒絕與既有 OAuth／group／白名單回歸 | [輸出](ui/evidence/board-web-test.txt) |
| client 全套 | **105 pass、13 既有環境依賴 skip、0 fail**；client 無修改 | [輸出](ui/evidence/board-client-test.txt) |
| Playwright 桌面＋手機 | 滾輪縮放、真正空白平移、一次框選 6 零件、頁面與 viewport 返回、搜尋→函式白板→43 行原碼→reload、播放／暫停／步進、點線看契約、手機無整頁溢位、減少動態效果；頁面錯誤／CSP 錯誤／寫入請求均 0 | [結果](ui/evidence/board-playwright.json)、[scenario](ui/evidence/board-browser-scenario.js) |
| Docker | 建置成功；包含本地 bundle／CSS／授權與來源模型；離線 128 MiB snapshot/asset smoke 通過，不是完整負載測試 | [建置](ui/evidence/board-docker-build.txt) |
| 獨立視覺審查 | 首輪指出卡片說明字行被 flex 壓縮；統一 180px 卡高與兩完整行預算後補拍確認，最終 **resolved — ship** | [審查](ui/board-finish-review.md) |
| 設計 detector | 舊 DESIGN.md 對新 token 的 64 個 advisory（字級 29、顏色 32、圓角 3），無阻擋等級；已交文件 agent 按實作更新設計文件，未捏造第二次 detector 全綠 | [輸出](ui/evidence/board-design-detector.json) |

原碼 API、Discord OAuth、每請求重新驗證有效組員與 server 固定 group、同源 logout、CSP 均保留。只新增固定靜態 asset allowlist；Caddy 路由保留 master 的 loopback 8781 與既有 MCP／memory 驗證分流。所有畫布操作只改本機狀態；測試未觀察到寫入 API。

建置器仍掃七個來源根目錄。新增 JSX／CSS 作來源模組盤點，明示 JSX 由 esbuild 編譯，沒有宣稱 Acorn 解析 JSX 函式；原有 JS／Python AST、Go 詞法及上游映像原碼缺口限制不變。

## 分段提交與待驗收

- `ecf4146`：官方方案授權比較、可導航的頁面樹模型與測試。
- `899d27c`：實際 React Flow adapter／bundle／巢狀頁／目錄樹與畫布整合。
- `24507e3`：獨立審查指出的卡片字行裁切修正。
- 最後文件／證據 commit：本報告、最終截圖、原始輸出與設計記錄。

仍待 PM 整合與 維護者 主觀確認是否符合想要的 Notion 白板體驗；真 Discord callback、VPS/TLS、真 Mail/GitHub、完整 stack RAM／流量與實體裝置／新手理解度沒有在本次宣稱通過。正式部署前請使用 [UI runbook](ops/runbook-UI-guide.md)，來源快照不等於已部署。

## v5 視覺接續（2026-11-18）

維護者 保留本版版型，要求參照 Terax／InsForge 改為深色科技風格與更多互動。現行外觀以 [v5 交付](13-dark-tech-workbench.md) 及 tech-* 截圖為準；board-* 保留本版歷史。
