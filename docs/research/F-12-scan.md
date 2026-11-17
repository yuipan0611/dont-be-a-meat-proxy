# F-12：由原始碼建立架構模型

## 產物與重建

執行 `cd web && npm run build`，產生 `web/.generated/architecture.json`。這份檔案包含既有 overview、受驗證的函式快照 `symbols`，以及供第三版 UI 使用的 `atlas`。生成目錄不納入 Git；正式映像在建置時重建。

掃描程式是 `web/scripts/scan-architecture.mjs`，人工白話解釋集中在 `web/scripts/architecture-notes.mjs`，Python 語法擷取由 `web/scripts/python-symbols.py` 完成。來源只讀取，不會 import 或執行被掃描的業務程式，也不連接 VPS、資料庫或正式服務。

掃描範圍包含全部已追蹤的 `client/`、`ops/`、`server/`、`bot/`、`web/`、`deploy/`、`supabase/`。`ops/lifecycle/`、`ops/bank-proxy/`、`ops/memory-bridge/`、`ops/token_applier.py` 與 Go validator 均有各自服務歸屬。測試、fixtures、文件和 manifest 留在 inventory 計數，但不進入原碼 API 白名單；private、`.env`、key、token、password、依賴與生成目錄不讀取內容。此次工作不讀寫 `spikes/`。

開發 checkout 以 `git ls-files` 決定範圍，因此新掃描工具加入版本管理前不會被它自己列入；正式映像沒有 `.git` 時，以同樣七個根目錄遞迴讀取，排除私密、生成、依賴目錄和符號連結。`atlas.coverage.inventoryMethod` 會顯示這個差別。

## 模型契約

| 欄位 | 內容與用途 |
| --- | --- |
| `atlas.services` | 13 個邏輯零件：client、gateway、validator、mail、clock、bank-proxy、memory、bridge、bot、web、postgres、token-applier、ops。各自包含白話用途、必要原因、輸入、輸出、錯誤邊界、來源與模組路徑。 |
| `atlas.modules` | 非測試程式、SQL 與部署檔案，含 `id`、`path`、`serviceId`、`symbolIds`、白話解釋及來源。人工作業說明標記 `human-reviewed`，其餘明確標為服務上下文說明，避免假裝已逐行語意理解。 |
| `symbols` | `path#scope.function` 為識別。保留第二版 17 個核心 ID，擴充所有被掃描的具名函式、具名變數函式與方法；含真正的程式片段、參數、起訖行號、檔案 SHA-256。 |
| `atlas.connections` | 20 條人工核對的跨零件關係。含誰傳給誰、協議、傳送內容、回傳內容及實際來源行號。client → Mail 額外標明是經 gateway、validator 的邏輯關係，並非繞過檢查站。 |
| `atlas.imports` | JavaScript AST 的 import。`from` 是模組路徑，`to` 是正規化的本地目標；套件 import 標 `external:true`。這是語法依賴，並不等於執行過的呼叫。 |
| `atlas.calls` | JavaScript AST 中直接以 identifier 呼叫的靜態候選；只記呼叫者 scope、名稱與行號，不推測動態物件／虛擬呼叫。 |
| `atlas.tables` | migration 的 CREATE TABLE、欄位、COMMENT、白話用途與輸入／輸出／錯誤說明，14 個 Hub 資料表。 |
| `atlas.messages` | 由 `KINDS`、`CLIENT_EVENTS`、`RESULT_EVENT` 的來源宣告擷取 12 種訊息，補上白話用途、輸入／輸出與錯誤邊界。 |
| `atlas.containers` | Compose services 區塊、image／build／command／ports／networks／depends_on 等明列屬性與行號。override 保持各自證據，不假裝已合併。 |
| `atlas.entrypoints` | Caddy 指令與人工核對的 HTTPS 網域、MCP、memory、OAuth、架構 API、函式 API；不讀取產生後的私密 Caddy 通行證檔。 |
| `atlas.inventory`、`atlas.coverage` | 全部範圍的檔案分類、各根目錄數量、實際符號數及限制，供 UI 呈現覆蓋範圍。 |

整合初次掃描在新增掃描工具尚未加入 Git 時，盤點 171 個檔案、89 個來源／部署模組、529 個具名符號、14 個資料表與 14 個 Compose 條目。這些是該次建置的快照數字，整合 UI 與掃描工具後會改變；交付時應以重建後 `atlas.coverage` 為準。

## 來源與白話解釋如何連起來

服務與跨服務連線使用「來源路徑＋必要 anchor」產生真實行號：例如 `ops/hub_ops.py` 的 `render`／`memory_block`、`server/validator/validator.go` 的 `ServeHTTP`、`ops/memory-bridge/bridge.mjs` 的 `createBridge`。anchor 消失時建置直接失敗，避免重構後留下假的來源行號。

JavaScript 使用 Acorn AST，Python 使用標準 `ast`。Go 開發環境沒有 Go toolchain，此版明確採取註解／字串遮罩與括號計數擷取函式宣告；每個 Go symbol 的 `extraction` 都標明不是 AST。SQL 與 Compose 是語法掃描，不是完整 SQL／YAML 語意解譯器。

對新手的重要邊界：Mail 原文與 SQLite/archive 屬於上游 Agent Mail 容器；Hindsight 的內部 schema、函式屬於上游映像，本 repo 沒有它們的原始碼，因此不捏造 L4。HubClock 目前程式使用檔案 store；migration 中有 HubClock 表格不表示正在用 PostgreSQL 執行該狀態機。模型供應商名稱以目前程式／Compose 的實際內容為準，文件中已提出的改用方案不是執行證據。

## 驗證與限制

`cd web && node --test test/architecture.test.mjs`：6/6 通過。新增檢查涵蓋箭頭／方法／巢狀函式、Go 字串與註解中的假括號、Compose override、SQL 欄位與說明、七根目錄覆蓋、Python／Go／JS 代表性 ID、每一函式片段與來源行號吻合、每個模組符號與每條連線沒有懸空參照、來源行號有效、測試／私密檔未進入符號白名單。

`cd web && npm test`：整合掃描時 16/16 通過，包含既有 OAuth、組別驗證、唯讀來源 API、來源錯誤狀態與 work-context 測試。整體 UI 整合後的完整測試與截圖另由交付紀錄記載。

這是建置時快照，不能當作 VPS 已部署、函式已被執行或服務健康。匿名 callback 不獨立建立節點；靜態 import 不等於執行連線；Compose 不展開環境變數、不合併 overrides；SQL 不執行 migrations；Go 不做型別解析。這些限制同時寫入 `atlas.coverage.warnings`，供 UI 顯示與機器讀取。
