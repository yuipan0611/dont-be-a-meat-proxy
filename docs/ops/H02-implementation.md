# H-02 實作與驗證路徑

PM 的 2026-11-17 調整優先於 SDS 原本的雙容器部署。保留 office 的系統 Caddy，只新增 hub 的 import；Mail host port 只綁 127.0.0.1。PM 續准專用網路改一般 bridge，因 internal 網路無法走 host 發布；保留 non-root、cap_drop、512 MiB 與 read-only rootfs，只讓 /data 和 /tmp 可寫。Bridge 允許 outbound，是 MVP 已接受的差異，仍禁任意執行外來訊息。

影響範圍是 deploy 的 Compose／hub site、ops 的 token 生成與套用／撤銷、部署與驗證手冊。H-03 client 的 public API 與測試斷言保留；依 PM 指示，只對整合測試 helper 新增連線到外部測試容器的選項。

驗證以四個單位推進：

1. 先由 CLI 產生限權秘密檔，驗分裝置／upstream、權限、重跑不輪替。
2. 由同一來源產生全站 allowlist，驗 Caddy 語法、未知路徑驗證及逐裝置撤銷；失敗保留 pending，不回成功。
3. 啟動 PM 核准的官方 Linux amd64 image，驗 native MCP 收發／游標／未知收件者、原文重啟、Caddy 撤銷，以及 H-03 原有整合斷言。
4. 檢查 Compose、部署／回滾指令與完整 diff，將 VPS 專屬步驟交 維護者。

基線為 client 40 個單元測試通過；以 F-01b 的 Mac binary 指定 MAIL_BIN 後，8 個整合測試通過。未設 MAIL_BIN 的 8 個 skip 已辨識，不列為通過。

風險較高的邊界是 Caddy 共用主設定與 token 撤銷：禁止 restart、禁止覆寫 office site，保留備份；只有 validate、graceful reload 及實際 401 probe 都成功才回報撤銷。所有工具與本機測試資料寫在自己的 worktree，秘密只在 gitignored `.hub-local` 或 VPS 私密目錄。

PM 核准官方 release image 的 amd64 digest 為 `sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1`。其 v0.3.40 tag commit `7d94ecf55dfa6a1ca157ee5ad7cf4dbfb1dd5b4d` 與 SDS `a58b6d77cd16fa4e235359ae91f1b28779780d05` 不同，必須以容器驗收；任一 PM 指定測試失敗時停止並回報。

上游拒絕 `HubClock` 為 descriptive name，PM 已核准保留邏輯角色，register 不指定 name，以回傳 canonical name 存入 VPS 的 `hubclock.sender.json`；H-05 讀該 registry。之後不換 image、不關驗證的契約修正由工程師自行處理並記錄。Bootstrap 用 Python 3 標準庫，VPS 不新增 Node runtime；Mac 驗收工具沿用 H-03 的 Node client。
