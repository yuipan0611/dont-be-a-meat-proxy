# 新手 UI 交付｜UI-01～05

2026-11-17；實作於 codex-senior-swe worktree，未 commit/push，未連線 VPS。

## 已實作

- 總覽、架構／串接、工作詳情；手機元件清單、首次導覽、鍵盤互動。
- 架構版本化、元件與路徑定位、Issue／commit／PR 連結、交接原文與未完成事項。
- 回報與證據分開；無標註不推測；不呼叫 LLM、不讀原始碼、不建立任務副本。
- Discord OAuth session、即時成員資格檢查、固定 group、唯讀 Mail 與 GitHub 查詢、故障與最後成功時間。
- client 選填 workContext，舊訊息相容；Compose、Caddy 路由範例與操作手冊。
- Discord 入口採專案頻道置頂普通登入連結，由操作者設定，避免更動尚在整合的 bot router。

## 本機證據

- web：9 個 server/data 測試通過（OAuth state、防重播、member 撤銷、到期、登出、跨組、非消費式 topic、快取故障、舊格式與不可信 metadata）。
- client：105 項中 92 通過、13 個原有環境依賴 integration skip，0 失敗。這不代表已通過實體 Mac／Windows 回歸。
- Playwright 桌面：總覽 → 工作詳情 → 架構定位，正確亮起 3 個元件；來源錯誤 0。初次缺 favicon 404 已修正。
- Playwright 390×844：元件清單與詳情可操作，document 寬度不超出 viewport；SVG Enter 選取後焦點保留；GitHub 路徑連結可見。
- Docker image 建置成功；Compose 在臨時假憑證環境 config --quiet 成功（未使用正式 secrets）。128 MiB、唯讀 filesystem 範例容器，100 次並行讀取成功，測量時 19.7 MiB；此數字不是完整 stack 或正式資料壓測。
- Caddy 2.11.9：route + fallback 組合 validate 成功。全部裝置撤銷的 fixture：Web 路由進入代理（未啟動 upstream 所以 502），MCP 維持 401；不把 502 當頁面驗收成功。
- Playwright 不可信內容：`<img onerror=...>` 以原文字面顯示，未建立圖片，也未執行事件。
- 畫面截圖：[桌面](ui/desktop.png)、[手機](ui/mobile.png)，合成範例資料。

## 票號對應

| 票 | 本機交付 | 上線前剩餘 |
|---|---|---|
| UI-01 畫面 | 三個視圖、首次導覽、手機版、截圖 | 三位新手測試 |
| UI-02 架構資料 | Hub 元件、串接、路徑、版本設定 | PM 核對正式部署狀態 |
| UI-03 資料 | workContext、唯讀投影、來源故障與快取 | 真 Mail/GitHub 與既有收件回歸 |
| UI-04 身分入口 | OAuth、session、成員與固定組別檢查、Caddy 範例 | 真 Discord callback／VPS 路由 |
| UI-05 整合 | 本機瀏覽器、容器、部署與回復文件 | 完整 stack RAM／原有流程驗收 |

## PM 後續驗收

真 Discord／VPS／TLS／Caddy 組合與既有入口回歸、真 Mail 資料、完整 stack RAM、新手 3 人測試均待操作者完成。沒有憑證或存取權時不宣稱已上線。

設計：同一個任務連到受影響架構與原始依據，降低新手接手成本；GitHub 保持正式任務來源。UI-01～05 本機交付，11-30 上線 Gate 仍須以上驗收。
