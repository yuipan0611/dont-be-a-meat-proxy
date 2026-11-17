---
name: Hub 系統圖譜
description: 讓新手沿著零件、方向與來源，理解一條交接怎麼跨電腦。
colors:
  ink: "#183c32"
  muted: "#536d63"
  line: "#dce5df"
  accent: "#136a4d"
  paper: "#f3f5f1"
  white: "#fff"
  soft: "#eaf3ec"
  amber: "#845612"
  focus: "#bb730b"
  canvas: "#f8faf6"
  canvas-dot: "#d8e1d5"
  boundary: "#edf3e9"
  boundary-line: "#b9cbb8"
  card-line: "#c6d6c8"
  card-hover: "#f0f6ed"
  card-hover-line: "#659a71"
  card-selected: "#edf7ed"
  card-selected-line: "#176948"
  edge: "#789984"
  flow: "#14734d"
  primary-hover: "#0b5038"
  code-background: "#142b23"
  code-text: "#deebdf"
  code-line-number: "#9ab8a6"
typography:
  headline:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.025em"
  title:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "21px"
    lineHeight: 1.3
    letterSpacing: "-.015em"
  body:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  diagram-title:
    fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif'
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
  source:
    fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
    fontSize: "13px"
    lineHeight: 1.8
rounded:
  tag: "5px"
  chip: "6px"
  control: "7px"
  action: "8px"
  inset: "10px"
  card: "12px"
  surface: "14px"
  login: "16px"
spacing:
  compact: "8px"
  control: "12px"
  section: "16px"
  panel: "20px"
  workbench: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.action}"
    padding: "12px 18px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.soft}"
  button-play:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-play-hover:
    backgroundColor: "{colors.primary-hover}"
  diagram-card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "13px 15px"
  diagram-card-selected:
    backgroundColor: "{colors.card-selected}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  inspector:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "22px 20px"
  source-reader:
    backgroundColor: "{colors.code-background}"
    textColor: "{colors.code-text}"
    typography: "{typography.source}"
---

# Hub 系統圖譜的視覺系統

## Overview

範圍：`web/public`。模式：Read + Operate。這是 2026-11-17 對目前實作的文件化，依據 `public/style.css`、`public/index.html`、`public/explorer.js` 與 `PRODUCT.md`；未以瀏覽器重新驗收。上方 token 對應現有 CSS；尺寸依下文的響應式與狀態覆寫套用，不將現況推定為已部署或已通過新手驗收。

### 原始方向契約（保留）

範圍：web/public。模式：Read + Operate。依 2026-11-17 新手多層架構圖的明確任務重做。

THESIS：讓新手沿著零件、方向與來源，理解一條交接怎麼跨電腦。
OWN-WORLD：淺色閱讀用的系統地圖；墨綠文字、紙白表面、淡綠責任邊界，主動作只有深綠。系統字體適應繁中閱讀；monospace 僅用於原始碼與資料。
STORY：先定位使用者／工作站／VPS，再拆解服務、播放訊息旅程、看來源檔與函式。
FIRST VIEWPORT：明確五層導覽、流程播放、已填滿的系統全貌與說明欄同時可見，無空白 demo 卡。
FORM：C4 的語意與 Structurizr Dynamic 的編號序列；以現有原生 SVG/HTML 實作互動，未導入第三方畫布程式碼。幾何架構圖本身就是主視覺，不使用插畫模擬實物。

色彩來源：--ink #183c32、--muted #536d63、--accent #136a4d、--paper #f3f5f1、--line #dce5df。圓角 12–14px，無裝飾陰影。桌面左側固定層級、中間架構畫布、右側用途與證據；手機層級置頂，圖與說明依序閱讀，單欄零件保持可讀字級。

方向可選、連線可點，流程循序高亮並沿線移動圓點，prefers-reduced-motion 停止移動。資料表／訊息種類與來源模組使用目錄清單。詳細資料以為什麼、輸入輸出、故障、連接、來源的固定閱讀順序呈現。

### 實作定位

「淺色閱讀用的系統地圖」是既有方向用語，並無另行批准的視覺稿或 seed。清楚、有層次的卡片用來解釋架構，架構圖本身就是主視覺。幾何、線條、原生 SVG 圖示和文字承擔資訊，沒有另行創作的攝影、插畫或外部品牌素材。

Read + Operate 的操作是搜尋、切換層級、選取零件、播放教學、縮放、導向來源與更新工作回報。工作台保留唯讀範圍，動作確認在 AI 工作站進行；Discord OAuth、組別隔離與白名單程式碼 API 是產品限制，不因新增介面而放寬。

**Key Characteristics:**

- 紙白底、墨綠文字、淡綠責任邊界與深綠主動作。
- 從白話問題走向來源行號；桌面同看架構與解說，手機依序閱讀。
- 教學順序、來源核對的連線、實際部署與即時流量維持清楚標示。

## Colors

全頁使用低彩度綠色與紙白層次。frontmatter 收錄主要重用色與圖譜狀態，精確 selector 與其餘局部色值仍以 `public/style.css` 為準。

### Primary

- `accent` 用於主動作、連結、播放按鈕與方向線 hover；播放 hover 使用 `primary-hover`。
- `card-selected-line` 與 `card-selected` 同時標示已選零件及目前教學步驟；邊框亦由 1px 變為 2px。
- `flow` 用於教學線與移動圓點，沒有健康度或實際流量含義。

### Neutral

- `paper` 是頁面底，`white` 是標頭、工具與解說面，`soft` 是輕量互動底。
- `ink` 是主要文字，`muted` 是次要文字，`line` 是面板及區塊分隔。
- `canvas` 加 `canvas-dot` 的 18px 點陣定位架構；責任區使用 `boundary`、65% 填色與 `boundary-line` 虛線。
- 程式碼使用 `code-background`、`code-text` 和 `code-line-number`，為目前主要的深色閱讀區。

### State colors

- 鍵盤焦點是 `focus` 的 3px outline，offset 4px。
- 阻塞標籤是 `#fff0d8` 底與 `amber` 文字；故障解說文字是 `#825121`。
- 錯誤訊息是 `#fff1ed` 底與 `#8e3327` 文字。保留既有工作／錯誤語意，不添加未存在的狀態。

## Typography

**Body / heading font:** `system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif`。沒有載入自訂 webfont。原始碼使用 `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`；資料表名稱也使用 monospace。

繁中白話解說採系統無襯線字，路徑與來源有換行規則。實作沒有固定的 `ch` 閱讀寬度，不另定不存在的字體比例。

| 角色 | 現行規格與用途 |
| --- | --- |
| 頁面標題 | `.heading h1` 27px、650、1.3、字距 -.025em；1100px 以下 25px、760px 以下 23px。通用 h1 為 30px。 |
| 區段標題 | h2 21px、1.3、字距 -.015em；未另設字重，沿用瀏覽器 bold。手機工具列 h2 20px。 |
| 零件名稱 | 17px、600、1.3，單行省略，完整內容由解說欄提供。 |
| 零件摘要 | 12px、1.5，最多兩行。 |
| 內文 | body 14px / 1.6；解說 lead 13px / 1.9，手機 14px；解說欄位內文 12px / 1.9，手機 13px。 |
| 來源與目錄 | 來源連結及目錄列最終覆寫為 12px；欄位標題 12px、600。 |
| 細節標記 | 工具／圖例多為 10–12px；手機層級名稱最終覆寫為 11px，L 編號 10px。 |
| 原始碼主閱讀區 | 最終覆寫為 13px / 1.8，手機 12px；保留空白、橫向捲動與真實行號。 |

## Layout

### Read + Operate 工作台

全頁容器最大寬 1680px，桌面水平 padding 32px、垂直 24px。白色標頭高 76px。頁面標題後接「探索架構／工作總覽／交接與紀錄」分頁，預設探索架構。登入、工作台與錯誤區依狀態顯示；本機預覽 notice 明示架構是 repo 快照、工作紀錄為合成範例。

桌面工作台先分為 174px 左側層級 rail 與彈性主區，gap 24px。主區依序是標題與搜尋、麵包屑、服務／模組選擇、教學播放器、架構畫布與解說欄。畫布和右側解說欄使用 `minmax(0,1fr) 292px`、gap 18px。rail sticky top 24px；解說欄 sticky top 20px、max-height 940px、內部捲動。原契約的「固定層級」在實作是 sticky 導覽。

| 尺寸條件 | 實際變化 |
| --- | --- |
| ≥1500px | 解說欄 320px，padding 25px。 |
| ≤1100px | 頁面 padding 20px；rail 140px、gap 16px；解說欄 250px、gap 12px；搜尋寬 200px。 |
| ≤760px | 標頭 64px；頁面 padding 16px 12px；rail 成為頂部五等分格；工具列、搜尋、畫布、解說欄單欄依序排列。解說欄取消 sticky 與高度上限。 |

圖譜桌面 viewBox 寬 1000，手機 400。L1–L4 一般節點採桌面三欄、手機一欄；節點高 116、列距 150、左右 pad 32、欄 gap 22。L0 有獨立上下文座標，手機六個角色亦為單欄。手機節點點擊後捲到解說欄，L4 函式點擊後捲到來源閱讀區；解說欄提供「回到架構圖」。捲動目標 scroll-margin-top 15px。

### 五層閱讀路徑

| 層級 | 導覽名稱與白話問題 | 主要內容 |
| --- | --- | --- |
| L0 | 系統全貌／誰在使用？ | 使用者、Mac、Windows、VPS、Discord、GitHub 與使用關係。 |
| L1 | VPS 服務／裡面有哪些零件？ | 安全入口、協作與連接、記憶與資料、主機維運責任區；資料表目錄。 |
| L2 | 串接與協議／訊息怎麼走？ | 教學編號序列、完整服務串接目錄、訊息種類。 |
| L3 | 程式模組／程式放在哪裡？ | 服務選擇、來源檔、靜態 import；完整來源模組目錄。 |
| L4 | 函式與原始碼／這段程式做什麼？ | 模組與函式索引、完整選取函式的來源快照與行號。 |

這是 C4 衍生的專案閱讀層級，L2 是額外的通訊契約層，不宣稱五層是 C4 原始標準。L3／L4 圖面最多顯示 12 個模組／函式，完整集合由目錄提供。來源閱讀區提供完整 API 回傳的選取函式，不是任意檔案瀏覽器。

工作總覽統計是三欄卡片，內容為 1.5fr / 1fr；交接與紀錄為等寬雙欄。手機將內容區改為單欄，統計仍保留三欄縮排。一般目錄最高 440px、手機 360px，超出時內部捲動。

## Elevation & Depth

目前沒有 box-shadow 或裝飾陰影。層次由紙白頁底、白色面板、淡綠責任區、1px 邊框和 selected 的 2px 邊框建立。畫布點陣與虛線責任邊界表示結構；解說以留白和分隔線建立閱讀順序，程式碼深底區分內容。

節點 hover 對背景與邊框做 `.15s` transition，沒有位移。教學線有 `1.8s linear infinite` 虛線動畫，圓點沿路徑移動 1.8s，教學自動步進間隔 2400ms。`prefers-reduced-motion: reduce` 取消 CSS 動畫與 transition，程式亦不建立移動圓點；教學文字／步驟仍可繼續更新。點擊捲動目前由 JS 指定 smooth，不能僅憑 CSS 規則宣稱所有程式捲動皆停止平滑效果。

## Shapes

主面板 14px，節點、播放器與一般卡片 12px。解說內原始碼 inset 10px；主來源閱讀區採直角 code block，沿用畫布外層裁切。按鈕依變體使用 6–8px，標籤 5px，登入面板 16px。圓形用於步驟編號、圖示與教學圓點。

責任邊界 1px 虛線；連線使用箭頭、1.6px 線和 20px 透明點擊軌道，使用關係採 `5 4` 虛線。SVG 圖示為內嵌 24×24、1.5px currentColor 筆畫，不需額外圖示套件。Hub 標記是 HTML 內嵌 SVG。

## Components

### Buttons and fields

- 主動作為深綠底白字。通用登入按鈕 padding 12px 18px、8px 圓角；解說欄主動作滿寬、padding 10px、12px 字；播放按鈕 padding 8px 12px、7px 圓角，hover 深綠。
- 次要按鈕白底、1px `line` 邊框，hover 淡綠底及 `#8ab6a0` 邊框。禁用按鈕 opacity .6、cursor wait，這是現行共用樣式。
- 搜尋欄為白色 8px 圓角容器，桌面 padding 8px 11px、12px 字；手機全寬、padding 10px，input 最終 13px。結果是服務／模組／函式清單，最多 18 筆。
- select 白底、1px 邊框、7px 圓角、padding 7px、12px 字；沒有額外的自訂選單系統。
- 按鈕、連結、欄位、summary 與 tabindex 目標保留可見焦點。頁首 skip link 以鍵盤焦點顯示。

### Navigation

主分頁以 2px 綠色底線、文字加重標示 `aria-current=page`。層級按鈕含 L 編號、名稱、白話問題與線條圖示；active 使用淡綠底，手機 active 改白底，隱藏圖示與副說明。麵包屑提供返回路徑；URL hash 記錄層級、服務、模組、選取項與流程。

### Diagram cards and inspector

節點白底、1px `card-line` 邊框、padding 13px 15px、12px 圓角。selected／current-step 是 2px 綠邊與淡綠底，padding 減為 12px 14px 保持內容位置。點擊選取；雙擊或解說欄的主動作進入內部。

解說欄先呈現種類、名稱與用途，再按內容提供為什麼需要、輸入／輸出、故障影響、連接、來源與相關回報。連線另顯示誰送給誰與協議；教學步驟另顯示教學順序及實際方向。函式顯示簽名與快照 SHA-256。缺少欄位時保留核對來源的提示，不虛構資料。

### Tutorial player and connections

播放器為白色 12px 面板，含播放／暫停、流程 select、教學模式文字；L2 有上一步／下一步。步驟 chips 橫向捲動，active 同時改底、邊框與編號圓形；caption 用 `aria-live=polite` 更新說明。既有流程為 Mac 交接給 Windows、動作確認與逾時、交接變成可搜尋記憶。

L2 編號箭頭表示教學步驟先後，真正服務呼叫方向由下方完整串接目錄與解說呈現。Windows 主動輪詢 Mail，教學上的 Mail → Windows 步驟不代表 Mail 推送。L3 import 線也不代表執行時呼叫順序。手機隱藏 SVG 連線文字，保留可點的線與目錄；L0 合作關係目錄在手機預設展開。

### Source reader and provenance

選取 L4 函式時，主畫布切換為滿畫布欄寬的來源閱讀區，隱藏 SVG 與縮放控制；右側解說仍保留。閱讀區標示語言、名稱、檔案與起迄行號；白色標頭 padding 20px，深底 code block 可捲動，最高 600px、最小 220px，手機最高 500px。行號欄至少 50px 寬；程式碼不裁成摘要。

讀取中有文字提示，失敗有重試按鈕；資料經受保護的 `/api/code/:symbolId` 取得。能對到函式的來源按鈕開本機快照；其餘 GitHub 連結另開視窗並說明可能與本機版本不同。provenance 明示建置快照、盤點數與動態行為仍需實測。空模組或外部映像採文字與來源入口，不補虛構節點。

## Do's and Don'ts

### Do

- **Do** 延續紙白、墨綠、無裝飾陰影的卡片層次，以責任邊界幫助新手閱讀。
- **Do** 維持 L0–L4 名稱、白話問題、來源行號與完整目錄的對應。
- **Do** 在手機保留單欄可讀節點、點擊捲到詳情與返回圖面的入口。
- **Do** 明示教學、靜態關係、本機快照、合成工作紀錄和來源版本差異。
- **Do** 保留鍵盤焦點、可操作的方向線與 reduced-motion 的既有處理。

### Don't

- **Don't** 把教學編號或動畫當作真實呼叫方向、即時流量或部署健康度。
- **Don't** 用插畫取代架構主視覺，或聲稱已有未存在的批准視覺稿與素材。
- **Don't** 將唯讀原始碼入口擴為任意檔案讀取，或將播放器做成實際傳訊／批准操作。
- **Don't** 以 GitHub 分支連結證明本機快照已推送，或以來源盤點證明服務已部署。
- **Don't** 將目前 CSS／程式碼記錄描述成已完成瀏覽器、新手理解、真 Discord callback 或 VPS/TLS 驗收。
