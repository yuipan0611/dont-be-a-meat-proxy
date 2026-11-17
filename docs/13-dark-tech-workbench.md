# v5：保留巢狀白板版型的深色科技介面

2026-11-18。依 維護者 原話「目前先以這樣的版型」「更科技風格」「盡量模仿他們的元素，做互動性」，保留 v4 左目錄／中無限白板／右說明、巢狀頁與麵包屑。已先 merge master 最新 `9c9a3a6`（包含 v4 merge `3a4f959`）。工作區 codex-senior-swe／example-org/ui-workbench；未 push、未改 master、未碰 spikes、未操作 VPS。

## 開啟與截圖

本機預覽：**http://127.0.0.1:8085/**。獨立 loopback 埠，保留舊預覽程序。架構來源是真實 repo 快照，工作回報明示合成範例，不是正式環境驗收。

| 場景 | 桌面 1600×1000 | 手機 390×844 |
| --- | --- | --- |
| 總覽 | [白板](ui/tech-desktop-overview.png) | [白板](ui/tech-mobile-overview.png) |
| 進入一層 | [VPS](ui/tech-desktop-enter.png) | [VPS](ui/tech-mobile-enter.png) |
| 目錄樹 | [巢狀目錄](ui/tech-desktop-tree.png) | [目錄抽屜](ui/tech-mobile-tree.png) |
| 流程播放 | [沿線光點](ui/tech-desktop-flow.png) | [沿線光點](ui/tech-mobile-flow.png) |
| ⌘K | [命令面板](ui/tech-desktop-command.png) | [命令面板](ui/tech-mobile-command.png) |
| 原碼頁 | [原始碼](ui/tech-desktop-code.png) | [原始碼](ui/tech-mobile-code.png) |

[三站並排比較圖](ui/tech-comparison.png) 由本機 HTML＋Playwright 排列研究截圖產生；[可直接開啟的比較頁](ui/tech-comparison.html)。共 12 張 app 場景＋1 張比較圖；原 board-* 與 atlas-* 保留歷史。

## 參考與設計技能

研究 agent 實際以瀏覽器查看 [Terax](https://terax.app/) 與 [InsForge](https://insforge.dev/)，記錄 computed styles／hover、桌面與手機畫面。六張原站截圖在 [reference/](ui/reference/research-notes.md)，包括 editor／agent mode。

Terax 提供近黑中性色、薄框、等寬資訊與光線動態的參考；InsForge 提供黑色格線、細分隔與實際 `#6ee7b7` 薄荷綠。沒有把原站 logo、文案或品牌圖片放進 app；原站品牌只出現在明確標示的研究截圖與比較圖中。主 app 的版型、Hub 識別、資料與文字保留。

已讀取並依 `impeccable` 的 new-work／operate／animate／craft-floor 執行，方向以 維護者 明確指定的兩站與既有版型為準。亦讀 `svg-driven-ui`：其適用表將主流 React 一般元件及流式 RWD 排除，因此沿現有 React Flow 直接實作、瀏覽器驗證，未啟用不適用的 SVG 人工確認流程。實際 tokens 與來源／實作映射寫於 [design-tokens.md](ui/design-tokens.md)，DESIGN.md 從完成的 v5 更新。

兩位 Codex 子 agent 平行做原站研究與白板互動，獨立 Codex 做視覺審查，另位文件 agent 整理實作設計系統；沒有 provider 替換或啟動失敗。

## 實作

- 深黑／navy 層次：`#080c12`、`#0e141d`、`#141d29`；文字 `#edf4f8`、次要文字 `#a4b3c3`；mint `#6ee7b7` 為動作／選取，blue `#8bbdff` 為來源／焦點。
- 同源自架 Inter／Geist Mono，Fontsource 5.3.0 的未修改 Latin variable WOFF2，合計約 70 KiB；OFL 1.1 授權及 SHA-256 在 `web/public/fonts/`。中文使用既有系統 fallback。沒有字型 CDN。
- 卡片 hover 柔和光暈與關聯線高亮，目錄 hover 對應白板卡片、白板選取對應目錄。工作定位不再將仍可操作卡片文字降透明度，而以虛線區別。
- 流程播放使用沿真實畫布連線路徑移動的 SVG 光點／halo，配合文字步驟；停止／分頁隱藏／reduced-motion 停止移動。教學順序不是 live trace，Windows 仍主動收件。
- 進入／返回頁面有相機 zoom 與輕微頁面 scale 過場，保留每頁 viewport／卡片位置。reduced-motion 不建立新過場，動態切換也會取消正在進行的頁面 Web Animation。
- ⌘K／Ctrl K 或頂部按鈕開命令面板；可搜尋未展開的服務、模組、函式。上下鍵選項、Enter 跳頁、Escape 關閉；native dialog 焦點限制與關閉後焦點回復。手機可直接點搜尋圖示。
- 原碼頁保留真實行號、完整原文、版本與白名單 API，以深色區塊、等寬字、行 hover、可讀行號顯示，未改寫程式內容。

v4 的平移／滾輪縮放／框選／拖動／小地圖／巢狀頁保留，排版仍只存 browser runtime；重新整理會重置，不宣稱跨裝置保存或多人共編。

## 可讀性與驗證

[原始測試與瀏覽器證據](ui/evidence/tech-playwright.json)：

| 驗證 | 結果 |
| --- | --- |
| web | [19/19 pass，0 fail／skip](ui/evidence/tech-web-test.txt)，含既有 OAuth／fixed group／來源白名單與頁面樹 |
| client 全套 | [105 pass、13 既有環境依賴 skip、0 fail](ui/evidence/tech-client-test.txt)，本次 client 無修改 |
| Playwright | 桌面＋手機 12 場景；命令鍵盤跳頁／Escape、雙向高亮、hover glow、沿線光點、動態 reduced-motion、43 行 sendItem 原碼、自架字型、無整頁溢位；頁面錯誤／CSP 錯誤／寫入請求 0 |
| 文字對比抽查 | 兩個 viewport 共 20 個 computed style／背景合成樣本，最低 **約 8.60:1**，均超過正常文字 AA 4.5:1；[資料](ui/evidence/tech-playwright.json) |
| 有意義邊界計算 | control 3.23:1、card 3.28:1、group 3.59:1；可見焦點採高對比 blue。裝飾格線不作唯一狀態訊號 |
| v4 操作回歸 | wheel／空白 pan／返回 viewport／多選、工作定位文字 opacity 見 [補充結果](ui/evidence/tech-regression.json) |
| Docker | [最終 image 建置](ui/evidence/tech-docker-build.txt)；bundle／theme／font／授權 smoke 見 [image 記錄](ui/evidence/tech-image-smoke.json)，不是 full stack 負載測試 |
| 獨立視覺審查 | [Resolved — ship](ui/tech-finish-review.md)，唯一 material fix 為播放／暫停圖示一致性，已修正與補拍 |

對比是實際抽查及 token 計算，不宣稱通過所有 WCAG 條文的完整認證。焦點可見、狀態除顏色外有邊框／文字／圖示，動態效果有減量偏好。

設計 detector 原始 [187 項](ui/evidence/tech-design-detector.json)：182 advisory 多為舊 v4 文件與新 palette 不符；5 warning 是 Inter／Geist Mono 過度使用兩項、字型文件兩項、stroke-width transition 一項。字型符合明確參考所以保留，文件已更新，stroke-width transition 已移除；未重跑 detector，也不宣稱警告機器清零。

## 邊界與提交

只擴充固定靜態 allowlist：`/tech.css`、兩個字型、`/font-licenses.txt`；Caddy 公開靜態路由同步且保留 loopback 8781。Discord OAuth、member／link 撤銷、固定 group、唯讀資料與 code 白名單、CSP 沒有放寬，沒有外部 CDN 或 LLM 呼叫。

- `5fc4b0d`：兩站實拍、tokens／研究、字型與授權。
- `ddeed54`：深色主題、命令面板、光點、同步高亮與縮放過場。
- `6d9c25c`：播放中 pause glyph，停止後 play glyph。
- `f66076f`：工作定位保持文字可讀與動態 reduced-motion 取消頁面過場。
- 後續 evidence commit：最終截圖、比較圖、驗證、更新後設計文件與本報告。

待 PM 整合及 維護者 主觀風格確認；真 Discord、VPS/TLS、真 Mail/GitHub、完整 stack／實體裝置與新手實測仍依既有驗收執行。此次沒有宣稱正式部署完成。
