# F-12｜給新手看的分層架構工作台：參考方案與選擇

研究日期：2026-11-17。研究範圍是第三版架構工作台；依 維護者「能參考的就抄，不要自己設計」的要求，採用已有的資訊架構與互動模式。以下區分「借用模式」和「直接導入／複製套件程式」；本研究未複製外部程式碼、未引入新服務，也未改變 Discord OAuth、組別隔離或程式碼 API。

## 選擇

採 **C4＋Structurizr 的分層、導覽與逐步播放模式**為骨架，借用 **Backstage 的元件／API／資源目錄**組織詳情，並參考 **React Flow 的畫布與連線動畫範例**。本版可沿用現有 SVG 實作這些已存在的模式；若將來需要自由編輯大型圖，再用 React Flow＋ELK 取代畫布。Mermaid 留作文件輸出候選。

這是有意識的模式重用，不能宣稱已「導入 React Flow／ELK／Backstage／Structurizr」或已複製它們的程式。現成工具並不會自行理解本專案的 Go 驗證器、Node hook、Python token applier、資料庫 migration 與組別隔離；真實架構仍須由本庫擷取並逐項附來源。

## 四組方案比較

| 方案與官方來源 | 可直接參考的內容 | 對本專案的適用性與限制 | 本版決定 |
| --- | --- | --- | --- |
| **C4＋Structurizr**：[C4 四種抽象](https://c4model.com/)、[Structurizr 導覽](https://docs.structurizr.com/ui/diagrams/navigation)、[播放](https://docs.structurizr.com/ui/diagrams/animation) | 從系統環境、容器、元件到程式碼；點入下一層；圖上的來源連結；逐步揭露元件與關係 | 最符合新手先看全貌再看細節的需求。C4 的 Container 指可執行應用或資料儲存等邊界，不應直接等同 Docker container；本專案的協議層是額外視圖 | **採用核心模式**。每一層有固定問題、名稱與麵包屑；播放顯示順序及目前這一步 |
| **Backstage Software Catalog**：[System Model](https://backstage.io/docs/features/software-catalog/system-model/)、[Catalog Graph](https://backstage.io/docs/features/software-catalog/creating-the-catalog-graph/) | Component、API、Resource 分開建模，再以 System 聚合；API 是元件間的邊界 | 適合把服務、資料表／儲存、對外契約分清楚。整套入口網站的導入範圍超出本次唯讀工作台；目錄資料也不會自動證明呼叫在執行中發生 | **採用分類方式**。詳情固定提供用途、輸入輸出、連到誰、來源；不導入完整 Backstage |
| **React Flow＋ELK**：[ELK layout 範例](https://reactflow.dev/examples/layout/elkjs)、[Animating Edges](https://reactflow.dev/examples/edges/animating-edges)、[Sub Flows](https://reactflow.dev/learn/layouting/sub-flows) | 節點與邊資料模型、縮放控制、父子群組、有向分層佈局、沿連線移動標記的範例 | 可用現成畫布元件承載本庫模型；ELK 解決佈局，不負責推導系統架構。轉 React 需重新整合目前純 Node／靜態前端建置；移動小圓點本身也不能取代逐步解說 | **參考互動與佈局**。採節點卡、明確箭頭、可點連線、播放標記；本版保留既有畫布與 OAuth/API，未安裝兩套件 |
| **Mermaid Architecture**：[官方語法與範例](https://mermaid.js.org/syntax/architecture.html)、[官方專案](https://github.com/mermaid-js/mermaid) | group、service、edge、junction 的文字模型；群組內服務與資料資源圖示 | 適合把機器模型輸出成可審閱文件。官方仍將 Architecture 標為 beta；單一靜態圖無法直接提供本需求的五層詳情、搜尋、API 程式碼與流程播放器 | **保留為文件輸出候選**。不以 Mermaid 靜態圖代替互動工作台 |

表中「適用性／決定」是針對本庫現況的工程判斷，並非上游對本專案的保證。

## 可以照著做的具體模式

### 1. C4 與 Structurizr：用不同視圖回答不同問題

C4 的 Context 圖把人、目標系統與外部系統放在同一張全貌圖，避免在第一眼塞入協議細節；Dynamic 圖則以有編號的互動說明某個使用情境。這兩個模式分別解決「我在哪裡」和「事情如何發生」。[Context 官方說明](https://c4model.com/diagrams/system-context)、[Dynamic 官方說明](https://c4model.com/diagrams/dynamic)

Structurizr 已提供點入更細層、關係連到資源、書籤式視圖，以及播放／前後步進。本版應照這個導覽順序，另加明顯「進入內部」按鈕給手機和新手，避免只靠雙擊。[導覽](https://docs.structurizr.com/ui/diagrams/navigation)、[靜態站功能](https://docs.structurizr.com/export/static-site)、[動畫](https://docs.structurizr.com/ui/diagrams/animation)

**本專案 L0–L4 是 UI 層級，不是 C4 的官方編號：**

| UI 層 | 新手要能回答 | 對應內容與圖中一定要出現的東西 |
| --- | --- | --- |
| L0 系統全貌 | 誰在使用？東西放在哪裡？ | 人、Mac、Windows、VPS、Discord、GitHub；用短句說明用途。此層混合 Context 與部署位置，標明「本專案全貌」 |
| L1 服務 | VPS 裡有哪些零件？ | Caddy、validator、Mail、HubClock、Bot、memory bridge、bank proxy、Hindsight、Postgres、web、token applier；依真實模型分組，不把不同責任合成一張「安全入口」卡 |
| L2 串接 | 誰把什麼送給誰？ | 有向連線、HTTPS/MCP/SQL/本機檔案等協議、輸入→輸出；選一條線後看來源檔與錯誤。這是本專案增加的協議視圖 |
| L3 模組 | 哪個檔案負責這件事？ | 真實目錄與模組，按所屬服務篩選；檔名旁先說白話用途，來源行號可查 |
| L4 函式與程式碼 | 這件事實際在哪幾行完成？ | 自動擷取函式與參數、行號、版本快照；經既有唯讀 API 顯示程式。外部映像若沒有來源，明確顯示可查證深度 |

L1 的部署狀態必須另行核對，不能由 repo 有 compose／程式檔推定 VPS 已部署。L2 的模型是可查證的設計與靜態來源，不能假裝成即時流量追蹤。

### 2. Backstage：零件、介面、資源分開，詳情格式一致

Backstage 的官方模型把軟體元件、元件間 API、執行所需 Resource 分開，System 才是合作集合。[System Model](https://backstage.io/docs/features/software-catalog/system-model/)

本版直接借這個分類：服務卡呈現責任；連線呈現契約；資料表另有資料資源清單。每個詳情依固定順序回答：一句話用途 → 為什麼需要 → 輸入 → 輸出 → 連到誰 → 出錯會怎樣 → 原始碼證據。每項來源保存 `{path,line}`，而不是只有不可定位的整個目錄。

### 3. React Flow：畫布動作與資訊閱讀分開

官方 ELK 範例示範節點／邊交給佈局引擎，Animated Edges 範例示範沿路徑移動的標記。應重用這個互動概念：箭頭與文字保留可讀，選中某一步才讓標記通過，側欄同步解說。[ELK 範例](https://reactflow.dev/examples/layout/elkjs)、[連線動畫範例](https://reactflow.dev/examples/edges/animating-edges)

建議首條教學流程是「Mac 保存交接 → Caddy → validator → Mail → Windows 開工讀取」。最後一步必須說清楚由 Windows hook 發出讀取，不要讓移動圓點暗示 Mail 會主動推送或已證明遠端成功；播放是教學模擬。可用播放／暫停／上一步／下一步和文字步驟清單，支援減少動態效果；手機可用相同模型的垂直步驟卡閱讀。

## 本庫現況與補強理由

研究起點是 `101363c` 的第二版。`web/scripts/build-architecture.mjs:18` 的 curated definitions 僅納入 3 個 JS 檔、17 個函式；`web/public/explorer.js:29` 起的圖把 Caddy 與 validator 合併，並對未納入的服務只提供 overview。這些是當時明確寫出的範圍，見 [`docs/10-architecture-workbench.md`](../10-architecture-workbench.md)，無法滿足此次「掃整個 repo」與細部串接要求。

本次需要把 `client/`、`ops/`（含 lifecycle、bank-proxy、memory-bridge、token_applier）、`server/validator/`、`bot/`、`web/`、`deploy/`、`supabase/` 的來源納入同一份可重建模型。函式／模組用語法擷取，部署與資料表從 compose、Caddy、migration 擷取；白話用途及跨程序關係人工核對。自動擷取範圍、失敗與外部來源缺口應列入模型 coverage，而非把靜態掃描宣稱為完整執行呼叫圖。

## 授權與重用邊界

本研究只借用上述資訊架構與操作模式，未複製上游程式、圖檔或商標。若後續直接導入／複製，下列官方授權是核對起點，不應把不同專案都當 MIT：

- C4 網站與範例圖：原站頁尾標示 [CC BY 4.0](https://c4model.com/diagrams/system-context)；若改編其圖文，保留作者 Simon Brown／C4 model、來源、授權與修改說明。本版使用本專案自己的模型與圖。
- React Flow／xyflow：官方 [`LICENSE`](https://github.com/xyflow/xyflow/blob/main/LICENSE) 為 MIT；複製 substantial portions 時保留授權與版權聲明。不可因此推定所有 Pro 範例都可直接取得或複製。
- ELKJS：官方 [`LICENSE.md`](https://github.com/kieler/elkjs/blob/master/LICENSE.md) 為 EPL-2.0；本版未包含 ELKJS 程式。
- Backstage：官方 [`LICENSE`](https://github.com/backstage/backstage/blob/master/LICENSE) 為 Apache-2.0；本版未包含 Backstage 程式。
- Mermaid：官方專案標示 [MIT](https://github.com/mermaid-js/mermaid)。Structurizr 本版只參考功能文件，沒有引入其執行檔；若未來選擇特定發行版，再核對該版授權，不能用 C4 的授權替代工具授權。

## 第三版應驗證的結果

1. L0–L4 每層都由本庫模型填入內容，手機與桌面各有實際截圖；來源缺口有解釋而不是空白畫布。
2. 使用者可從 Mac→VPS 看見 Caddy 與 validator 的分工，再找到 `client/mail-client.mjs` 的實際函式與行號。
3. 點連線後能讀懂方向、送出的資料、協議及失敗後果；播放器每一步有文字，不靠顏色猜方向。
4. OAuth、撤銷、跨組隔離、唯讀與任意路徑拒絕沿既有 API 驗證；視覺層不另開繞過 API 的來源讀取。
5. 本機 demo 的工作紀錄、教學播放、原始碼快照和真實部署狀態有清楚標示。自動測試通過後，仍應由新手實際指出某條流程的方向、責任與來源位置，才能確認教學效果。

## 第四版補充：Notion 式巢狀頁與無限白板選型（2026-11-17）

維護者 在第三版併入 master 後要求：「設計成無限白板那種 Notion 形式：可以點擊進去，旁邊當然還有目錄頁」。這次的選擇由「參考畫布模式」改為**實際採用 React Flow（`@xyflow/react`）作為白板引擎**；既有架構模型、來源 API、OAuth／組別隔離保持原有責任。以下以查詢當日官方文件與實際 LICENSE 為準，不把舊發布文章、GitHub 的自動授權標籤或商業雲端版功能直接套到 SDK。

### 四個現成方案的比較

| 方案 | 商用、MIT 與浮水印／署名 | 巢狀頁與目錄能力 | 效能與整合判斷 | 本次決定 |
| --- | --- | --- | --- | --- |
| **tldraw SDK** | **不是 MIT**，目前是 source-available SDK；預設授權僅供開發。正式環境須有效 trial／commercial／hobby key，商用使用 commercial 授權；hobby 為非商用且須保留「made with tldraw」浮水印。不可用舊 v3 發布文推論「商用只保留浮水印即可」 | 原生多頁 scene；每頁有自己的 camera、selection，切換可還原。官方 pages 預設上限 40，可配置；Notion 式任意父子頁樹與零件語意仍需本應用建立 | 已有完整相機、選取、頁面與大型圖的效能選項，白板體驗成熟；但本次不宜新增正式上線 license key／商務授權流程 | 不採用。授權條件不符合本次優先簡單商用可用套件的方向 |
| **Excalidraw OSS SDK** | **MIT**，可商用、修改、散布，須保留 copyright／license notice；MIT 本身沒有要求畫面浮水印。OSS SDK 與 Excalidraw+ 的帳號／工作空間／商業功能須分開看 | SDK 提供 scene elements、app state、`initialData`、`updateScene` 等介面；可以由宿主應用切換 scenes，但這些 API 不是現成 Notion 頁面樹。Frame／group 也不等於遞迴頁面路由 | 適合自由繪圖與手繪元素。可嵌 React／bundler；本案主要是資料驅動 HTML 卡片、有向協議線與程式碼閱讀，若採它需把模型轉成繪圖元素並自行補頁樹／契約互動；未做效能跑分 | 不採用。繪圖優勢不是本次主要需求，宿主頁面與資料契約整合仍多 |
| **React Flow／xyflow** | **MIT**，可商用，須保留授權及版權 notice。預設角落 attribution 連回 React Flow；官方明說 MIT 不能法律上要求保留該畫面署名，隱藏時請支持／訂閱。本次**保留預設 attribution**，不把付費 Pro 範例當作已取得 | 內建 `group`／`parentId` sub-flow，可把子節點相對父節點定位；**sub-flow 不是另一張獨立頁**。本案以獨立 page ID／parent ID、麵包屑、目錄樹及每頁 viewport 管理巢狀白板；MiniMap、pan／zoom、框選與可點 edge 使用現成元件／互動 | 適合資料驅動服務／模組／函式卡片，能保留現有白話詳情與原碼讀取器。官方針對大型圖建議穩定／memoized 元件與 callbacks、避免無關節點更新、收合大樹與簡化樣式；每頁僅掛載當頁子圖是本案控制成本的方法 | **採用**。直接重用圖形引擎，不再自行實作整套座標／選取／minimap |
| **AFFiNE／Edgeless** | **不能把整庫簡稱 MIT**。當日 `canary/LICENSE` 把 backend 與 common/native 指向子授權，其餘指定內容 MIT；backend 子授權包含 EE production 訂閱條件，CE／client-side 部分另有 MPL-2.0 條款。商用／再散布必須依實際取用目錄與發行版核對，沒有從上述文件推定全套可無條件去品牌 | 官方每個 doc 有 Page Mode／Edgeless Mode，最接近「文件同時是一張白板」的產品模式，值得參考；但整套 workspace／doc／block 模型不是本專案目前的 atlas／source API | 完整知識工作台而非只換畫布元件；導入其儲存、同步、編輯與權限模型會大幅擴張範圍。未做本機跨方案效能測量，不能宣稱其比 React Flow 快或慢 | 不導入整套。只參考「左側文件目錄＋每頁空間畫布」的資訊架構 |

授權證據：[tldraw 現行 license](https://tldraw.dev/community/license)、[tldraw FAQ](https://tldraw.dev/faq)、[Excalidraw LICENSE](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)、[xyflow LICENSE](https://github.com/xyflow/xyflow/blob/main/LICENSE)、[React Flow attribution 說明](https://reactflow.dev/api-reference/types/pro-options)、[AFFiNE root LICENSE](https://github.com/toeverything/AFFiNE/blob/canary/LICENSE)、[AFFiNE backend/server LICENSE](https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/LICENSE)、[AFFiNE LICENSE-MIT](https://github.com/toeverything/AFFiNE/blob/canary/LICENSE-MIT)。這是對官方授權文字的工程選型整理；本次沒有納入 tldraw、Excalidraw 或 AFFiNE 的程式。

功能證據：[tldraw pages](https://tldraw.dev/sdk-features/pages)、[tldraw performance options](https://tldraw.dev/sdk-features/options)、[Excalidraw 整合](https://plus.excalidraw.com/docs/sdk/excalidraw/integration)、[Excalidraw initialData](https://plus.excalidraw.com/docs/sdk/excalidraw/api/props/initialdata)、[Excalidraw scene API](https://plus.excalidraw.com/docs/sdk/excalidraw/api/props/excalidraw-api)、[React Flow sub-flows](https://reactflow.dev/learn/layouting/sub-flows)、[MiniMap](https://reactflow.dev/api-reference/components/minimap)、[viewport pan/zoom](https://reactflow.dev/learn/concepts/the-viewport)、[React Flow performance](https://reactflow.dev/learn/advanced-use/performance)、[AFFiNE Page／Edgeless 概念](https://docs.affine.pro/core-concepts/elements-of-affine/page-mode)。

### 實作對應：直接重用哪些部分

1. **白板引擎**：採 React Flow 的 viewport、選取框、節點／群組、edge、Controls 與 MiniMap；使用專案自己的卡片與真實 atlas 資料。框選／拖曳只是瀏覽器中的選取與版面操作，不因此新增伺服器寫入或架構編輯權限。
2. **巢狀頁**：本應用建立「系統 → 服務 → 模組 → 函式 → 原碼」頁面樹。卡片開啟相應 page，返回使用父頁關係，保存每頁 camera；左側目錄樹展開、收合、搜尋與目前位置高亮。這是宿主功能，不能宣稱 React Flow 的 sub-flow 自動提供 Notion 的頁面資料庫。
3. **閱讀與來源**：白話說明、協議／輸入輸出、原檔行號與受保護 code API 繼續由現有資料層負責；播放器是教學先後，不是真實訊息執行。縮放／平移應是同一張畫布的 viewport 變化，不能用長網頁捲動冒充無限白板。
4. **效能邊界**：只渲染目前頁的直接內容，目錄樹按需展開；節點與 edge renderer、callbacks 保持穩定，播放器不要重建整份樹。無限畫布指可平移的空間，不代表無限節點、記憶體或任意手機效能；本次以真實 atlas 的桌面／手機 Playwright 驗證為準，沒有跨套件 benchmark。
5. **授權交付**：鎖定實際安裝版於 `web/package-lock.json`，保留套件 LICENSE／copyright notice 與預設畫面 attribution；不連外 CDN 載入畫布套件，不新增商業授權金鑰。若未來改為隱藏署名、使用 Pro 範例或換套件，依當時版本重新核對條件。

第四版驗收除既有 OAuth／來源白名單回歸外，至少包含：白板平移／滾輪縮放／框選、卡片進入與返回、每頁視野還原、目錄樹展開與搜尋、連線詳情、教學流程及原碼閱讀；桌面與手機各保存總覽、深入一層、目錄展開、播放畫面。此章是選型依據，實際通過情形由第四版交付報告記錄。
