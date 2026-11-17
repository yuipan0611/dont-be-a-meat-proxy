---
name: Hub 系統圖譜 v5
description: 黑藍技術工作台，沿著頁面目錄與無限白板讀懂系統零件和真實來源。
colors:
  canvas: "#080c12"
  surface: "#0e141d"
  raised: "#141d29"
  text: "#edf4f8"
  muted: "#a4b3c3"
  accent: "#6ee7b7"
  source-accent: "#8bbdff"
  border: "#293746"
  control-border: "#52697d"
  card-border: "#526a7f"
  card-selected: "#10231f"
  primary-text: "#062317"
  sidebar: "#0b111a"
  tree-hover: "#17222f"
  tree-current: "#152c28"
  tree-current-text: "#bcf8df"
  tree-linked: "#16332e"
  tree-hovered: "#15283a"
  inspector: "#0e151f"
  code-background: "#080d14"
  code-text: "#dce8f6"
  code-line-number: "#8ca2b9"
  command-background: "#101925"
  command-active: "#1a3534"
  warning: "#f3c78a"
  error: "#ffb5c5"
  error-background: "#301b23"
typography:
  body:
    fontFamily: 'Inter,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "14px"
    lineHeight: 1.6
  headline:
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.025em"
  card-title:
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.015em"
  card-summary:
    fontSize: "12px"
    lineHeight: 1.65
  technical-label:
    fontFamily: '"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    fontSize: "11px"
    lineHeight: 1.4
  source:
    fontFamily: '"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    fontSize: "13px"
    lineHeight: 1.9
rounded:
  selection: "4px"
  mode-button: "5px"
  field: "6px"
  secondary: "7px"
  control: "8px"
  player: "9px"
  card: "10px"
  dialog: "12px"
  boundary: "16px"
spacing:
  small: "4px"
  compact: "8px"
  control: "12px"
  section: "16px"
  toolbar: "18px"
  panel: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.field}"
    padding: "12px 18px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.secondary}"
    padding: "7px 12px"
  page-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "15px 17px"
  page-card-selected:
    backgroundColor: "{colors.card-selected}"
    rounded: "{rounded.card}"
    padding: "15px 17px"
  page-tree-current:
    backgroundColor: "{colors.tree-current}"
    textColor: "{colors.tree-current-text}"
    rounded: "{rounded.field}"
  inspector:
    backgroundColor: "{colors.inspector}"
    padding: "20px"
  source-reader:
    backgroundColor: "{colors.code-background}"
    textColor: "{colors.code-text}"
    typography: "{typography.source}"
  command-dialog:
    backgroundColor: "{colors.command-background}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    width: "min(660px,calc(100vw - 32px))"
---

# Hub 系統圖譜的視覺系統

## Overview

目前視覺權威為 v5 黑藍技術工作台，保留 維護者 指定的 v4「Notion 形式頁面目錄＋無限白板」互動。維護者 選擇 Terax 與 InsForge 作為參考；實際取樣、截圖與來源見 [研究紀錄](../docs/ui/reference/research-notes.md)。沿用 Terax 的技術字體配對、檔案語境與清楚層級，以及 InsForge 的深底、薄分隔與薄荷綠重點；黑藍結構和藍色來源提示屬本專案的轉譯。

本文依 `public/style.css` → `public/board.css` → `public/tech.css` 的載入順序，以及 `public/board.jsx`、`public/explorer.js` 記錄已實作狀態。frontmatter 是可重用值摘要；完整 selector、狀態及響應式覆寫以實作為準。這次是既有介面的文件更新，沒有另立命名視覺概念、seed 或額外視覺稿核准。

**Key Characteristics:** 可搜尋的頁面層級、佔主要空間的可操作白板、可收合說明、受保護來源閱讀，以及同步的目錄／卡片／連線提示。本文不代表 detector 警告已清除、完整無障礙認證、部署或使用者驗收。

## Colors

以 `canvas`、`surface`、`raised` 三層黑藍區分畫布、面板及 hover；`text` 和 `muted` 分配主要閱讀與次要說明。`border` 是安靜的結構分隔，控制與卡片採較清楚的 `control-border`／`card-border`，不能用低對比裝飾線代替焦點。

`accent` 的薄荷綠直接取自實際 InsForge 參考，用於主動作、目前教學步驟、選取及相關連線。`source-accent` 的藍色用於來源連結與鍵盤焦點；全域焦點為 2px outline、4px offset，白板控制另有內縮焦點。狀態同時保留文字、邊框或圖示，顏色不作唯一線索。

目錄區分 `tree-current`（所在頁）、`tree-linked`（已選卡片對應頁）及 `tree-hovered`（hover／焦點對應頁）。來源區另用 `code-background`、`code-text` 與 `code-line-number`。`warning`／`error` 表示明確狀態；薄荷綠教學高亮不表示服務健康或即時流量。提案與實作映射見 [design-tokens.md](../docs/ui/design-tokens.md)。

## Typography

UI／標題使用 **Inter**；技術種類、檔案路徑、來源與操作提示使用 **Geist Mono**。兩者均為 Fontsource variable **5.3.0**、未修改的 Latin WOFF2，透過同源 `/fonts/` 自行託管，`font-display: swap`。來源與雜湊見 [sources.json](public/fonts/sources.json)，保留的 SIL OFL 1.1 授權見 [LICENSES.txt](public/fonts/LICENSES.txt)。

Latin 字型不涵蓋繁中。中文由 CSS 中的系統 fallback 負責；`Noto Sans TC` 是 fallback 名稱，不代表本專案已下載該字型。此配對是依 維護者 指定參考而保留的選擇。

頁名桌面 25px／600，≤1100px 為 23px，≤760px 為 20px；卡片標題 17px／600、手機 18px。卡片摘要 12px／1.65、手機 13px，固定保留兩行 3.3em；頁面種類、標題與開頁按鈕不被 flex 壓縮。目錄桌面 12px、手機 13px。來源 13px／1.9、手機 12px，保留空白與區內橫向捲動。9–11px 僅用於緊湊工具、路徑或次要提示，不是主要說明文字規格。

## Layout

工作台填滿視窗；桌面標頭 54px，主區 `calc(100dvh - 54px)`。左側 252px 頁面樹＋彈性白板；目錄可收合為 0。白板依序保留麵包屑／搜尋工具列、頁名、流程教學（適用頁面）、畫布或來源頁，以及狀態列。右側說明開啟時佔 294px，與目錄各自捲動。

≤1100px 時目錄 220px、說明 254px。≤760px 時標頭 50px，目錄與說明改為左右覆蓋層，分別寬 `min(310px,90%)` 和 `min(342px,94%)`；開頁後收合，點卡片可開說明。手機先以 zoom .9 定位第一張卡片，再讓使用者平移探索；桌面初次適合前六個節點，zoom 限 .72–1。

一般卡片初始三欄、座標間隔 370×205、設定寬 290px；白板卡片至少寬 260px、高 180px。白板 zoom .12–2.5，左下縮放／適合畫面、右下可平移縮放小地圖；手機縮小小地圖並下移模式切換。頁面結構為系統首頁 → Hub VPS → 服務 → 模組 → 函式白板 → 原始碼頁，另有工作站／外部情境與流程教學入口。

每頁卡片位置與 viewport 僅存在本次掛載的記憶體 Map，換頁返回可還原，重新整理即重設；URL hash 的 `page` 保存導覽頁面，不保存位置。沒有 localStorage、伺服器或跨裝置位置保存。

## Elevation & Depth

深度以黑藍色階與細邊框為主，控制與小地圖沒有陰影。卡片 hover／高亮有克制的薄荷綠 glow（`0 6px 26px #6ee7b716`），選取使用 inset 1px 邊框，不改 padding。提示採 `0 4px 20px #0003`；手機覆蓋面板採 `0 20px 65px #0009`；命令對話框採 `0 28px 100px #0009` 與深色模糊 backdrop。

色彩／陰影轉場約 120–150ms；頁名與來源進場 220ms，換頁內容及 viewport 推進／返回縮放 280ms。流程播放時，光點與 halo 沿實際 smoothstep 連線移動，週期 1.8s；靜止的高亮、箭頭及文字仍表示目前步驟。這是教學訊號，不是執行遙測。

`prefers-reduced-motion` 即時變更會更新白板並取消已開始的換頁 Web Animation：移除訊號移動、頁面動畫與轉場，viewport duration 為 0，目錄定位使用 instant；CSS 同時停用動畫／轉場與 backdrop blur。暫停流程或頁面進入背景時亦停止沿線訊號。保留立即的選取、焦點與步驟文字。

## Shapes

卡片 10px、責任框 16px、命令對話框 12px（手機 10px）；目錄／搜尋／主按鈕 6px、白板控制／小地圖 8px、教學面板 9px。責任框用虛線、卡片用實線；箭頭表示方向。內嵌 SVG 線條圖示服務於頁面、來源與動作，不以裝飾插圖取代結構。

## Components

- **頁面樹與麵包屑：** 分開的展開／開頁按鈕、12px 深度縮排、可捲動目錄；搜尋名稱、說明與來源路徑，最多 60 筆並顯示祖先。方向鍵、Home、End 操作樹，保留 `treeitem`、`aria-expanded`、目前頁和祖先返回。
- **命令面板：** 工具列或 Cmd+K／Ctrl+K 開啟原生 modal `<dialog>`；搜尋頁面最多 18 筆。↑／↓ 移動、Enter 開頁、Escape 關閉；combobox／listbox 宣告目前結果。原生 modal 限制焦點範圍，取消返回觸發前焦點，開頁則聚焦頁名。搜尋區 focus-within 另有薄荷綠底線。
- **白板卡片與連線：** 拖空白平移、滾輪／捏合縮放、Shift 拖曳或模式切換框選；卡片可拖動，單擊選取／更新說明，雙擊或底部按鈕開頁。hover／焦點同步卡片、相關連線及目錄列；選取保持獨立標示。工作情境中未匹配卡片維持完整不透明度，以虛線邊框區分，保留閱讀對比。卡片內按鈕排除拖曳。沒有刪除、建立連線或重新接線。
- **說明與資料目錄：** 保留用途、需要原因、輸入輸出、故障影響、連接、來源行號及快照。頁底文字目錄可展開所有零件；無函式的設定模組使用真實設定來源葉節點，不補假函式。
- **教學播放器：** 播放／暫停、流程切換、前後步驟及 chips，caption 為 polite live region。Windows 主動輪詢 Mail；Mail → Windows 圖示不是服務推送。靜態 import／呼叫候選不證明執行順序。
- **來源閱讀器：** 函式先開自己的白板，再開獨立來源頁；保留樹與麵包屑，以來源內容取代畫布。受保護 `/api/code/:symbolId` 回傳完整選取函式、真實行號及 SHA-256，含讀取、失敗與重試。Discord OAuth、組別隔離、唯讀白名單與既有 CSP 維持原邊界；字型等新增資產均同源，沒有新增外部 CDN。

## Do's and Don'ts

- **Do** 延續 v4 的逐頁目錄／無限白板，用 v5 黑藍、薄荷綠選取與藍色來源／焦點建立一致線索。
- **Do** 保留繁中兩行摘要、手機第一卡片可讀視角、鍵盤操作與即時 reduced-motion。
- **Do** 將 URL 導覽、本次執行期間的位置記憶、來源快照與部署狀態分開說明。
- **Don't** 將舊紙白／墨綠 v4 配色、固定 L0–L4 rail 或原生 SVG 長圖當作目前視覺規格。
- **Don't** 複製參考站的品牌、行銷版面或截圖到應用；也不把本專案 hover glow 說成 InsForge 的實際 hover。
- **Don't** 把教學訊號當真實流量、把位置整理當永久共享保存，或擴大受保護來源入口成任意檔案讀取。
- **Don't** 以文件更新宣稱 detector、完整 WCAG、Discord callback、VPS/TLS 或新手理解度已驗收。
