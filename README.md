# don't be a meat proxy

本專案目前先完成 Orca 的多 agent 協作初始化：由 PM-Emily 統一派工，Claude、Codex、Antigravity 在各自 worktree 執行，再透過 Orca 原生 orchestration 回報。

直接在 Orca 的 PM-Emily 告知任務，PM 應依 AGENTS.md 建立／沿用 Run、派工並處理自動通知。協作通道不需要靠你在 agent 之間轉貼訊息。

- 協作規則：AGENTS.md
- 初始化與實測結果：docs/orca-initialization.md
- 主目錄：`<LOCAL_HOME>/orca/projects/don't be a meat proxy`
- 工作者：`<LOCAL_HOME>/orca/workspaces/don't be a meat proxy/`

應用程式的功能與交付形式尚未定義；此次設定不等於應用程式已完成。

## 新手專案導覽（11-30 批次）

唯讀 UI 提供專案總覽、可點架構、工作與交接定位；本機先看範例：`npm ci --prefix web --ignore-scripts`，再 `npm run demo --prefix web`，開啟 http://127.0.0.1:8080 。正式 Discord 登入與 VPS 尚需操作者配置及驗收。見 [使用說明](web/README.md)、[交付紀錄](docs/09-ui-delivery.md)、[部署手冊](docs/ops/runbook-UI-guide.md)。

架構工作台第二版已改為架構優先首頁，支援五層導覽與四條核心流程程式碼。見 [第二版交付與 PM 驗收](docs/10-architecture-workbench.md)。
