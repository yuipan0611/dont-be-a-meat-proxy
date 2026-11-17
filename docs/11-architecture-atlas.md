# 第三版：給程式新手的系統圖譜

2026-11-17，依 維護者 直接要求完成本機實作。工作區 codex-senior-swe／分支 example-org/ui-workbench；先 fast-forward master 至 `101363c`。沒有 push、操作 master／其他工作區、登入 VPS 或修改 spikes。第二版被判定太簡陋，這版以真實全庫模型填滿每一層。

## 可直接檢視的成果

本機預覽：**http://127.0.0.1:8083/**。原有 8080 已被既有程序占用，本次保留它，另外以 `DEMO_PORT=8083 npm run demo --prefix web` 啟動。預覽使用目前 repo 的架構快照，工作紀錄明確標示合成範例；不是正式服務驗收。

| 層 | 內容 | 桌面 1600px | 手機 390px |
| --- | --- | --- | --- |
| L0 | 人、Mac、Windows、VPS、Discord、GitHub；使用關係與進入 VPS | [全貌](ui/atlas-desktop-L0.png) | [全貌](ui/atlas-mobile-L0.png) |
| L1 | 12 個 VPS 邏輯零件，分安全入口、協作、資料、維運；可點資料表／Compose 證據 | [服務](ui/atlas-desktop-L1.png) | [服務](ui/atlas-mobile-L1.png) |
| L2 | 交接、動作確認、記憶索引三條教學；20 條真正串接與 12 種訊息 | [協議](ui/atlas-desktop-L2.png) | [協議](ui/atlas-mobile-L2.png) |
| L3 | 依服務切換真實來源模組，靜態 import，完整模組目錄 | [模組](ui/atlas-desktop-L3.png) | [模組](ui/atlas-mobile-L3.png) |
| L4 | 真實函式、參數、原檔行號、唯讀快照與完整函式索引 | [函式](ui/atlas-desktop-L4.png) | [函式](ui/atlas-mobile-L4.png) |

另有 [寬版程式碼](ui/atlas-desktop-code.png)、[手機程式碼區](ui/atlas-mobile-code.png)、[交接流程](ui/atlas-desktop-flow.png)。共 13 張最終 Playwright 截圖。

每個零件都有一句白話用途、需要原因、輸入／輸出、連接對象、故障影響與證據。圖上的點選／雙擊、明確下鑽按鈕、五層導覽、搜尋、麵包屑、分享 hash、拖曳／按鈕與 Ctrl/Cmd 滾輪縮放可用。手機點選捲到詳情並有返回；原碼區可橫向捲動，頁面本身沒有水平溢位。

## 研究與平行分工

兩個 Codex 子 agent 平行完成研究與全庫掃描；之後獨立 Codex 讀取兩輪截圖進行視覺審查，另一個文件 agent 整理實際設計系統。沒有切換到其他 provider，沒有 helper 啟動失敗。

[研究比較 F-12](research/F-12-architecture-viz.md) 核對四組官方方案：C4＋Structurizr、Backstage、React Flow＋ELK、Mermaid Architecture。採 C4 的逐層語意與 Structurizr Dynamic 編號教學、Backstage 元件／API／資源分類、React Flow 畫布選取與沿線標記模式。保留現有 SVG／CSP／Node 架構，**沒有宣稱已導入或複製這些套件程式**。L2 協議是本專案增加的層，不是 C4 官方的 L0–L4 編號。

## 模型與可查證範圍

掃描來源：client、ops、server、bot、web、deploy、supabase，包含 lifecycle、bank-proxy、memory-bridge、validator、token_applier。JS／Python 用 AST，Go 明確採詞法宣告範圍掃描；Compose／Caddy／SQL migration 擷取設定與來源行號，人工補白話與跨服務關係。

截圖與保存模型對應 `bdd155f7e51b1c7a992229be604134c0f7751451` 的乾淨來源快照，SHA-256 `7e932e294c8a63e96cd1c05b3d6393688229f1990de42cafaa4e4a964c1aa603`：176 個檔案盤點、92 個來源／部署模組、541 個具名函式、13 個邏輯服務（含工作站）、20 條關係、14 張 Hub 表、12 種訊息、14 個 Compose overlay 條目。完整 inventory 包含測試／manifest／文件分類；測試、私密檔、相依套件與生成檔不進原碼白名單。

- 可重建完整模型：`npm run build --prefix web` → `web/.generated/architecture.json`（不進 Git，含唯讀原碼）。
- 已提交的 metadata 模型：[F-12-architecture-model.json](research/F-12-architecture-model.json)，排除原碼，保留所有符號、來源、服務／模組／表／訊息／連線與 coverage。
- [掃描方法與限制](research/F-12-scan.md)。來源 anchor 缺失或核心符號漂移會使建置失敗。

不捏造上游 Agent Mail／Hindsight 的內部函式；Compose 不展開秘密或合併 overrides；SQL 不是現場 schema；匿名 callback 不獨立建圖；部分細部函式沿模組上下文說明，並非全函式語意分析。HubClock 目前仍是檔案 store，不能因 migration 有表就宣稱使用那些表。模型供應商的未實作決策不當作已部署現況。

## 呼叫與教學的區別

交接真正送出方向是 Mac → Caddy → validator → Mail；收件由 Windows 主動查詢 Mail（仍經入口與檢查站），不是 Mail 推送。播放器中的編號箭頭表示先後步驟／資料旅程，畫布與詳情均標明；真正 caller → callee 在完整串接目錄。播放不發網路訊息、不執行動作、不代表即時流量。偏好減少動態效果時停用移動標記與虛線動畫。

來源能對應函式時直接開啟本機受保護快照；外部連結標「GitHub 參考」，提醒可能與本機 revision 不同。函式原碼放中央寬版區，不擠在側欄。連線選取目前不寫 URL；節點／模組／函式可還原。

## 驗證證據

| 驗證 | 結果 | 原始輸出 |
| --- | --- | --- |
| `npm test --prefix web` | **16/16 pass，0 fail、0 skip**；含來源範圍／對照、7 根目錄、無懸空參照、OAuth／撤銷／固定 group、來源白名單與穿越拒絕 | [web](ui/evidence/atlas-v3-web-test.txt) |
| `node --test client/test/*.test.mjs` | **105 pass、13 既有環境依賴 skip、0 fail**；client 本次無修改 | [client](ui/evidence/atlas-v3-client-test.txt) |
| Playwright Chromium | 桌面＋手機五層；三條播放／暫停、動畫、點邊、雙擊下鑽、搜尋 JS／Python／Go、hash 重載、縮放／重設、reduced-motion；頁面錯誤 0、水平溢位 0 | [結果 JSON](ui/evidence/atlas-v3-playwright.json)、[CLI scenario](ui/evidence/atlas-v3-browser-scenario.js) |
| source API 實讀 | sendItem 43 行、PsqlDb.export 3 行、validator.ServeHTTP 148 行、createPgStore 320 行 | 同上 |
| Docker `hub-guide:atlas-v3` | 建置成功；image 內 filesystem fallback 產生 13 服務／92 模組／541 符號，Python／Go 來源存在 | [build](ui/evidence/atlas-v3-docker-build.txt) |
| image 離線解析 smoke | `--network none --memory 128m` 成功讀取模型；僅為快照解析檢查，不是完整服務負載測試 | 本報告 |
| 設計 detector／獨立 review | detector `[]`；兩輪截圖後 **ship**，6 項 material fixes 全 resolved | [detector](ui/evidence/atlas-v3-design-detector.json)、[review](ui/atlas-v3-finish-review.md) |

重播瀏覽器 scenario：先啟動本機 8083，再使用 Playwright CLI `open`，把 scenario 檔內容作 `run-code` 的單一參數；結束時回傳 JSON。它不會操作真實登入或正式服務。

Dockerfile 新增 Python 3 及七個來源根目錄，image 建置時重新產生模型，忽略秘密／本機產物；未更動正式 Caddy route／OAuth 資格判定／DB schema／client wire。

## 提交與交接

1. `a6352f7`：官方方案研究、全庫掃描器、機器模型與來源一致性測試。
2. `bdd155f`：五層 UI、真實目錄、流程播放、來源閱讀器、手機與 Docker 來源建置。
3. 後續 evidence commit：本報告、13 張截圖、可審查 metadata 模型、測試輸出及設計文件。

剩餘驗收：PM 整合分支、維護者 真 Discord callback／有效組員與撤銷、VPS/TLS、真 Mail/GitHub 資料、完整 8 GB stack／128 MiB web 負載，以及三位新手能否指出流程方向、各零件責任與來源位置。本次沒有登入 VPS，來源快照與本機測試不計為這些項目已通過。
