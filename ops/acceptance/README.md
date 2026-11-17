# S1 驗收工具（P-2）

這些工具給 維護者 在部署後的 **VPS 本機 checkout** 執行。程式撰寫與測試不需要 VPS、Discord 或真 token；執行本文件的 live 命令才會讀指定的私密檔、查部署服務／建立固定測試 Mail。沒有 SSH 或 Discord 自動登入功能。

入口為 `tc-14.mjs`、`tc-16.mjs`～`tc-21.mjs`，Node ≥22，零新增套件。先看 [各 TC 清單](../../docs/evidence/S1/TC-16/checklist.md)。TC-15 已有實體驗收，不在此次腳本範圍。

## 一次性前置（PM 準備）

1. 部署依 `docs/ops/runbook-L09-launch-deploy.md` 完成；準備獨立測試組、已連結 Discord owner/member/非成員帳號。所有 TC 串行執行，期間暫停其他測試寫入。
2. 複製 `ops/acceptance/config.example.json` 到 Git 外 `/private/acceptance/s1.json`，填入此次部署的完整 `git rev-parse HEAD`、實際容器名、`since`（本輪開始 UTC）、測試組及通知 member UUID。範本是刻意不能直接執行的 placeholder。每輪用新 `runId`；TC 間可共用，同 TC 不並行。
3. `mail` 指向已註冊、可發送及讀取測試項目的專用 agent；`senderFile` 是既有 bootstrap 產生的 `{agentName,senderToken,projectKey}` 私密 JSON，projectKey 必須吻合測試組。`to` 是要收到通知的正式 agent 名，`cc` 是該組 MemoryBridge 的**實際註冊名稱**。不要直接沿用範例名稱。先確認 bot watchedAgents 包含收件 agent，MemoryBridge 正在監看 CC agent。TC-17 的 `statusSourceMailIds` 放其他允許引用的本組測試決策／交接 Mail ID（例如建立時間早於 since 的決策），腳本逐一回讀核實。
4. bearer 檔接受單一 token，或 `HUB_TOKEN=…`／`HTTP_BEARER_TOKEN=…`；私密檔限 0600 或 0400。**設定只放路徑，token 不放 argv／JSON 範本／Git／聊天。**TC-16 的 old/other/fresh 指向三份保留的設定檔及各自非秘密 token ID；其中 other 的檔案不因重發而覆寫。
5. 填正確的 `memoryCompose`（與正式部署完全相同的 Compose 檔及 env-file 參數），僅 TC-17 額度切換用到。它只重建 `llm-gateway`，不改 env-file、不重建 DB／Mail／Hindsight，不清 ledger、不猜測刪 lock。額度切換期間所有 LLM consumers 共用零額度；先完成 TC-21 indexing，再測 TC-17 的 zero gate。
6. `bridgeStateFile` 是該組 bridge 的現行 state 路徑，`receiptDir` 只讀 helper receipts，絕不掃 credentials 目錄。TC-14 額外設定第二組、真 TLS host、B 私有 marker 與獨立 /data volume；用 group A 的 bot 容器驗 DB／決策邊界。B 必須已有至少一位 member 與一筆 decision fixture。
7. 複製 [observations.example.json](observations.example.json) 到 Git 外。維護者 在看過畫面後填該 TC 的 `ok`、操作者、UTC、**已遮罩截圖檔名或訊息 ID 參照**；未看過維持 `null`。只記判斷及參照，不貼 ephemeral／DM 回覆原文。原始 `/connect` 截圖不能存證，先完全遮住 token／設定行／OAuth code。

`deploymentCommit` 會和 VPS checkout HEAD 核對，每次 capture 另記容器 image ID。這表示「操作者宣告的部署 commit + checkout + image IDs」；映像沒有 source revision label 時，不能單憑 checkout 推論映像一定由該 commit 建置，PM 應保留 L09 建置對照證據。

## 共用命令

```sh
# 只顯示說明：不查 Docker、不讀 credential、不連網
node ops/acceptance/tc-17.mjs --help

# 在 維護者 完成清單中該階段的動作後，自動收集證據
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --step answered

# 自動建立固定繁中交接，保存 Mail ID、時間及 SHA256；不把原文寫入證據
node ops/acceptance/tc-21.mjs --config /private/acceptance/s1.json --live --seed handoff --step handoff

# 一次帶入所有本 TC 已親眼確認的觀察，離線判定
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --verify --observations /private/acceptance/observations.json

# 也可記單一觀察；reference 只接受無空白的非秘密檔名／ID
node ops/acceptance/tc-16.mjs --config /private/acceptance/s1.json --observe ephemeral --verdict pass --reference tc16-redacted.png
```

每次 capture／seed／觀察／verify 都輸出 `docs/evidence/S1/TC-XX/run-<UTC>.md`，包含 UTC、部署 commit、操作者、指令描述、非秘密輸出、操作 exit、整體 exit、判定及缺項。同 TC 的非秘密快照累積在 `state-<runId>.json`，權限 0600；不要刪除 state 再重送同一輪 fixture。`--verify` **完全離線**，不是正式驗收執行證據的替代品。

exit：`0=全通過`、`1=失敗／收集錯誤`、`2=缺證據／尚有 pending`。中途 capture 因尚有其他步驟而 exit 2 是預期的；不要用 `set -e` 串接整輪，最後以 `--verify` 判定。遇到明確 fail 應排查後重跑該 capture，不得修改 state 把 fail 改成 pass。

seed 先持久化發送 intent，再送一次；已有 label 就拒絕重送，包含送出結果不明的情況。bridge `unknown` 時只用同一個 `mail-<ID>` 跑 `get_document` 查證，不重送 Mail、不直接 retain；等待 bridge 自己的既有復原流程。若 seed 在拿到 Mail ID 前中斷，PM 用相同 idempotency key 查 Mail 結果，確認後另開新測試輪，不由腳本重發。

所有 subprocess 無 shell 展開，所有 HTTP 有 timeout 且不跟隨 redirect，原始 stdout/stderr 不轉貼。DB 使用 read-only transaction 及固定欄位投影；決策／Mail／memory 原文僅在記憶體比 SHA256。已保存 JSON 再套遮罩，保留通知 state、錯誤代碼等判定所需枚舉，不保留 token、OAuth code、DM 原文、摘要或 provider 錯誤全文。

## TC-17 零額度與恢復

```sh
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --step baseline
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --quota 0 --allow-recreate
# gateway ready 後取 quotaBefore，維護者 問一次，再取 quotaAfter
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --step quotaBefore
# 維護者: /status 問「現在做到哪」
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --step quotaAfter
# 不論成功或失敗都要恢復，原上限取本輪 baseline，不寫死 500
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --quota restore --allow-recreate
node ops/acceptance/tc-17.mjs --config /private/acceptance/s1.json --live --step restored
```

零額度以 runtime `/status` 的 dailyLimit=0、相同台北日界且 used/reserved 不增加及 bot audit `quota` 為證。保留既有 ledger；若請求尚在 reserved 狀態會拒絕重建。不要在台北午夜跨日做此比較；跨日不能算通過。兩次 runtime capture 失敗時不會自動 retry 模型，也不會報成功。重建剛完成、gateway 尚未啟動時，可重跑讀取 capture；不要重複點 Discord。

目前 F-11b gateway 限制的是**請求次數**，不是 USD 金額；TC-21 歷史 0.50 USD/day gate 不會被這個數字冒充通過。`groqCostGate` 必須附 PM 核實的 Groq 費用上限／花費證據，做不到就維持 pending；本工具不變更帳戶計費設定。

## 離線驗證

```sh
node --test ops/acceptance/test/*.test.mjs
```

假資料覆蓋每個 TC 的正／負／缺證據判定、SHA256、跨部署混用、遮罩與持久化、明示缺 GitHub token 的正式 task service、假 HTTP MCP JSON/SSE／401／redirect，以及 CLI 無 live 閘門／離線收據。假 HTTP 僅開本機 loopback，絕不讀部署設定；測試不能勾選 VPS／真 Discord 驗收。
