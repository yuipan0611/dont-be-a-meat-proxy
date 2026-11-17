---
name: Hub 系統圖譜 v4
description: 每個零件都是一頁，沿著目錄與無限白板逐步讀懂協作系統。
colors:
  ink: "#183c32"
  muted: "#536d63"
  accent: "#136a4d"
  white: "#fff"
  paper: "#f3f5f1"
  line: "#dce5df"
  soft: "#eaf3ec"
  sidebar: "#f5f6f2"
  tree-current: "#e1eadd"
  tree-current-ink: "#184b34"
  tree-hover: "#e9ede4"
  canvas: "#fafbf7"
  canvas-dot: "#dce4d9"
  card-line: "#cad8c9"
  card-hover: "#fafff8"
  card-hover-line: "#83a88b"
  card-selected: "#f0f8ed"
  card-summary: "#4b6855"
  card-label: "#5a7462"
  boundary: "#eaf1e650"
  boundary-line: "#b9cbb8"
  edge: "#779384"
  edge-label: "#385b49"
  selection: "#6d9b801c"
  mode-selected: "#e3eee1"
  minimap: "#f8faf5"
  minimap-selected: "#a3c6ac"
  focus: "#bb730b"
  amber: "#845612"
  error: "#8e3327"
  error-background: "#fff1ed"
  code-background: "#142b23"
  code-text: "#deebdf"
  code-line-number: "#9ab8a6"
typography:
  headline:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.02em"
  headline-medium:
    fontSize: "23px"
  headline-mobile:
    fontSize: "20px"
  source-title:
    fontSize: "22px"
  source-title-mobile:
    fontSize: "19px"
  inspector-title:
    fontSize: "21px"
    lineHeight: 1.4
  card-title:
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.015em"
  card-title-mobile:
    fontSize: "18px"
  body:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "14px"
    lineHeight: 1.6
  reading:
    fontSize: "13px"
    lineHeight: 1.9
  card-summary:
    fontSize: "12px"
    lineHeight: 1.65
  label:
    fontSize: "11px"
    lineHeight: 1.4
  metadata:
    fontSize: "10px"
  compact-metadata:
    fontSize: "9px"
  source:
    fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
    fontSize: "13px"
    lineHeight: 1.8
rounded:
  selection: "4px"
  tag: "5px"
  tree-row: "6px"
  field: "7px"
  control: "8px"
  player: "9px"
  inset: "10px"
  card: "12px"
  surface: "14px"
  boundary: "16px"
spacing:
  compact: "8px"
  control: "12px"
  section: "16px"
  panel: "20px"
  heading: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "12px 18px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "7px 12px"
  page-card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "15px 17px"
  page-card-selected:
    backgroundColor: "{colors.card-selected}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  page-tree-current:
    backgroundColor: "{colors.tree-current}"
    textColor: "{colors.tree-current-ink}"
    rounded: "{rounded.tree-row}"
  inspector:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    padding: "20px"
  source-reader:
    backgroundColor: "{colors.code-background}"
    textColor: "{colors.code-text}"
    typography: "{typography.source}"
---

# Hub 系統圖譜的視覺系統

## Overview

目前權威是 v4「頁面目錄＋無限白板」；本文依 2026-11-18 的 `public/style.css` 最後覆寫、`public/board.css`、`public/board.jsx`、`public/explorer.js`、`public/pages.js` 與 `package.json` 記錄實作。白板使用 React Flow（`@xyflow/react` 13.0.2）與 React／React DOM 19.3.1。舊 v3 原生 SVG、五層 rail 與手機單欄圖的描述只屬歷史，不能用來指導目前介面。

沿用紙白、墨綠與淡綠責任邊界；畫布上的卡片既是可整理的零件，也是通往內部頁面的入口。左側像文件工作空間的頁面樹保留方向感，中央給白板最大的探索面積，右側說明可收合。這是對既有實作的記錄，沒有新增命名視覺概念或聲稱取得額外視覺稿核准。

**Key Characteristics:**

- 可搜尋、展開與收合的頁面目錄，配合麵包屑逐頁深入。
- 可平移、縮放、框選與拖動卡片的無限白板，保留小地圖和可讀文字。
- 用途、教學順序與來源快照各有清楚標示；程式碼維持受保護唯讀入口。

本文更新不等於部署或使用者驗收。先前 `/tmp/hub-board-detector.json` 對舊 DESIGN.md 報告 64 個 advisory；本次刻意記錄新增的白板／目錄色彩、緊湊字級與圓角角色，未重跑 detector，不能宣稱警告已清除。frontmatter 是重用視覺值的摘要；完整 selector、狀態與響應式覆寫仍以 CSS 為準。

## Colors

低彩度綠與暖白將導覽、白板及來源閱讀分成清楚的面；主動作維持單一深綠。

### Primary

- **深綠 `accent`**：主按鈕、已選卡片邊框、選取連線與框選外框。選取另以邊框粗細和文字標示補強。
- **琥珀 `focus`**：鍵盤焦點；與深綠選取狀態分開。

### Neutral

- **墨綠 `ink`／灰綠 `muted`**：繁中主要閱讀與次要說明。
- **紙白 `paper`、白色 `white`、目錄底 `sidebar`**：工作台、卡片與頁面樹的層次；目前白板工作台覆寫為白底。
- **畫布 `canvas`／點陣 `canvas-dot`**：白板定位；點陣間距為 24px。
- **卡片 `card-line`、`card-hover`、`card-hover-line`、`card-selected`**：靜止、hover 與已選／目前教學步驟。
- **目錄 `tree-current`、`tree-current-ink`、`tree-hover`**：目前頁與指向狀態。
- **邊界 `boundary`／`boundary-line`**：半透明責任區；`edge`／`edge-label` 是關係線與標籤。
- **框選 `selection`、模式 `mode-selected`、小地圖 `minimap`／`minimap-selected`**：白板操作回饋，沒有健康度含義。
- **來源 `code-background`／`code-text`／`code-line-number`**：深底程式碼和真實行號。

阻塞沿用 `amber`，錯誤沿用 `error`／`error-background`；不將教學高亮當成即時流量或服務健康狀態。

## Typography

**Body / heading font:** `system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif`，沒有自訂 webfont。**Source font:** `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`。

白板卡片標題與摘要優先可讀；目錄、路徑及操作提示較緊湊。frontmatter 的 9–14px、17–23px 與 25px 是實際使用的角色值，不是單一比例尺；9–10px 用於次要提示和手機工具，不作主要卡片內文。

| 角色 | 使用方式 |
| --- | --- |
| 頁面標題 | `headline`；1100px 以下採 `headline-medium`，760px 以下採 `headline-mobile`。單行省略。 |
| 卡片標題 | `card-title`；手機採 `card-title-mobile`，摘要由 12px 增至 13px。標題單行、摘要最多兩行。 |
| 頁面樹 | 桌面 12px，手機 13px；目前頁字重 600。搜尋框桌面 11px、手機 13px。 |
| 說明欄 | `inspector-title`，lead 為 `reading`；欄位內文 12px / 1.9。 |
| 來源頁 | `source-title`，手機 `source-title-mobile`；程式碼 `source`，手機 12px，保留空白與橫向捲動。 |
| 輔助文字 | `label`、`metadata`、`compact-metadata` 依工具、狀態列及手機覆寫使用。 |

頁面摘要最多一行、最大 90ch；這是頁面標頭的限制，非所有內文的統一閱讀寬度。

## Layout

工作台填滿視窗。桌面標頭 54px，主區高 `calc(100dvh - 54px)`，取消舊的 1680px 最大寬與外層 padding；主分頁保留。探索區為左 252px 頁面樹＋彈性白板，沒有欄間空隙。目錄可收合為 0。白板內依序是麵包屑工具列、頁名、教學播放器（僅流程頁）、白板／來源頁、底部狀態列。

說明欄開啟時在白板右側占 294px，可獨立捲動；關閉後白板取回空間。左目錄亦獨立捲動。頁面目錄不是舊 L0–L4 固定 rail：系統首頁 → Hub VPS → 服務 → 模組 → 函式白板 → 原始碼頁；工作站與外部情境另有入口，流程教學也是樹中的頁面。

| 條件 | 目前行為 |
| --- | --- |
| ≤1100px | 左目錄 220px、說明欄 254px，縮小標頭與工具間距。 |
| ≤760px | 標頭 50px；目錄變左側覆蓋層，寬 `min(310px,90%)`；說明欄變右側覆蓋層，寬 `min(342px,94%)`。開頁後兩者收起；點卡片可打開說明。 |
| 首次開啟白板 | 桌面對前六個節點適合畫面，縮放限 .72–1；手機對第一卡片定位、zoom .9，先能閱讀再平移探索，並非縮小塞入全部節點。 |

一般卡片初始三欄排列、座標間隔 370×205，設定寬 290px；白板元件至少寬 260px、高 180px。使用者可拖動整理，責任區框保持固定。白板縮放範圍 .12–2.5，非有限寬 SVG 或垂直堆疊長圖。

每頁卡片位置和 viewport 存在本次掛載的瀏覽器記憶體 Map；換頁再回來可還原，重新整理後重設，沒有 localStorage、伺服器或跨裝置保存。URL hash 的 `page` 記錄導覽頁面，重新整理仍可返回該頁；它不保存座標或縮放。

## Elevation & Depth

桌面面板、卡片、白板控制和小地圖維持平面：白色／淡綠表面、1px 分隔與 2px 選取邊框建立層次。v4 有少量結構陰影，不能再描述為全站無陰影：白板提示使用 `0 2px 8px #203b2910`；手機目錄為 `12px 0 36px #1f38252b`，手機說明欄為 `-10px 0 30px #233d2624`，用來辨識覆蓋面板。

頁名與來源區有 .22s、5px 上移進場；換頁白板有 230ms、6px 上移／淡入；viewport 導覽與縮放使用 280ms。`prefers-reduced-motion: reduce` 關閉頁面動畫和流程虛線動畫，viewport duration 為 0，換頁不呼叫 Web Animations；頁面樹自動定位也明確改用 instant，平常才用 smooth。教學步驟仍按 2400ms 更新，動畫不承擔唯一資訊。

## Shapes

卡片採 `card`，責任框採 `boundary`；目錄列、提示、控制／小地圖與教學面板依 frontmatter 的 `tree-row`、`control`、`player` 分工。新增 `selection` 是框選矩形的輕微圓角。舊登入、工作總覽與程式碼 inset 的 `surface`／`inset` 仍保留各自用途。

卡片與面板用細邊框，責任區用虛線，選取卡片邊框增至 2px 並扣除 1px padding 保持內容位置。箭頭標示連線方向，內嵌 SVG 線條圖示用於頁面、來源與動作；白板由 React Flow 管理，沒有用裝飾插圖替代結構。

## Components

### Page tree and breadcrumbs

目錄是可捲動的文件頁面樹，12px 深度縮排，分開的展開鈕與開頁鈕；搜尋比對名稱、說明及來源路徑，最多 60 筆結果並顯示祖先路徑。樹支援方向鍵、Home、End，有 `treeitem`、`aria-expanded` 與目前頁標示。麵包屑可回任意祖先；URL 支援頁面深連結及舊層級 hash 的轉換。

### Infinite canvas and page cards

拖曳空白平移，滾輪／捏合縮放；Shift 拖曳或切換「框選」模式可部分交疊框選，並顯示已選零件數。卡片可拖動；單擊選取並更新說明，雙擊或卡片底部「打開白板」進入內頁。卡片內按鈕排除拖曳與平移。白板不提供刪除、建立連線或重新接線。

左下提供縮放和適合畫面，右下小地圖可平移／縮放；右上是平移／框選模式。手機縮小小地圖並將模式控制下移，避免與左上提示重疊。主要鍵盤焦點沿用琥珀 outline，卡片與連線另有明確 focus 處理。

### Inspector and directory

說明按用途、需要原因、輸入輸出、故障影響、連接與來源排列；有關閉鈕、來源行號與快照版本。底部「本頁零件與資料目錄」可展開，提供所有本頁零件的文字入口；服務與流程另列真正呼叫方向、資料表或訊息種類。沒有函式的設定模組採「設定來源」類型葉節點，開啟真實來源與用途說明，不補假函式或假程式碼。

### Tutorial player and connections

流程教學頁保留播放／暫停、流程選擇、上一步／下一步與步驟 chips，caption 使用 polite live region。React Flow 的 smoothstep 線、箭頭與可選標籤呈現關係；播放中高亮／虛線表示教學當前步驟。Windows 主動輪詢 Mail，教學 Mail → Windows 並非服務推送；import／靜態呼叫候選也不證明執行順序。

### Source reader and controls

函式先進入自己的白板，再開獨立原始碼頁；來源頁取代畫布和小地圖，麵包屑及頁面樹保留。沿用受保護的 `/api/code/:symbolId`，讀取完整選取函式與真實行號，顯示 SHA-256、讀取中、失敗與重試狀態。Discord OAuth、組別隔離及白名單邊界未因換畫布而變更。

共用主按鈕深綠白字；次要控制白底細框、淡綠 hover，白板工具依場景縮小 padding。搜尋、按鈕及來源連結保留鍵盤焦點；GitHub 來源參考另開視窗並提醒版本可能不同。

## Do's and Don'ts

### Do

- **Do** 以頁面樹、麵包屑和可點入卡片保持層級方向；以拖動與縮放探索空間。
- **Do** 維持手機第一卡片可讀的初始視角與覆蓋式導覽，讓使用者再平移探索。
- **Do** 將位置記憶描述為本次瀏覽器執行期間，將 URL 描述為頁面導覽。
- **Do** 使用文件化的白板、目錄狀態色、字級和圓角，保留焦點與 reduced-motion 處理。
- **Do** 保留真實來源行號、受保護程式碼 API、設定葉節點和資料不足提示。

### Don't

- **Don't** 依照 v3 的原生 SVG、固定五層 rail 或手機單欄圖規格新增目前畫面。
- **Don't** 把卡片位置整理宣稱為可永久保存、共享協作或已寫入伺服器。
- **Don't** 將教學高亮、靜態 import、來源快照或本機合成工作資料當作即時流量與已部署證據。
- **Don't** 為無函式的設定來源捏造程式碼，或把受保護來源入口擴為任意檔案瀏覽。
- **Don't** 以本文件更新聲稱 detector、瀏覽器、Discord callback 或 VPS/TLS 驗收已通過。

第四版獨立審查補正：卡片最小高度 180px，段落固定保留兩完整行（3.3em），標題／頁面種類／按鈕不可被 flex 壓縮，避免繁中字形垂直裁切。
