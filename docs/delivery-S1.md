# 上線驗收紀錄（L-09，S1，目標 2026-11-30）

- 負責：維護者＋PM｜依據：`docs/06-test-plan.md` TC-14～21、EVAL-01；`docs/07b-tickets-launch-draft.md`
- 狀態：**進行中**（2026-11-17）：程式 L-00～L-08 全在 master；VPS 已上 L-00、L-01、L-06；其餘待金鑰到位後一次部署
- 規則：每項附實際輸出；沒過寫原因與處理。

| 項目 | 內容 | 狀態 | 證據 |
|---|---|---|---|
| TC-14 | 跨組隔離（上線前必過） | 🟡 本機 ✅，VPS 待部署 | 本機 grp-test／grp-test2：96 次跨組 401、附件 marker 無外洩、Hindsight／DB／決策隔離（`docs/ops/evidence/L08-L05-tc14-local.txt`） |
| TC-15 | auto mode | ✅ 正式 Hub＋真 Windows | 拒絕案例（Mac）：無對象 #73→#75、300 分鐘 #74→#76，皆 auto_rejected、無生效 grant。維護者 在 Windows 親手 `auto on --for BlueLake --minutes 3` → #79 auto_on；生效中 Mac 送 action #80 → #81 auto_approved → Windows 未跳卡直接建 tc15.txt → #83 auto_executed succeeded；到期 #84 auto_ended；到期後 #85 → Windows 跳確認卡（presented），無人回應 30 分鐘 → #87 expired「視同拒絕，未執行」。2026-11-17 08:29～09:02Z |
| TC-16 | Discord `/connect`／撤銷 | ⏳ 真 Discord＋VPS 待驗 | 本機既有 bot/PG tests；按 L09 清單取 ephemeral、非成員拒絕、applied/audit、舊 token 401/另一台 200 |
| TC-17 | `/status` 唯讀引用／上限 | ⏳ 真 Anthropic 待驗 | 問兩筆交接核對 #ID/台北時間；不存在資訊拒答；0 額度不呼叫 LLM；兩台關機仍可查 |
| TC-18 | 通知／離線彙總 | ⏳ 真 Discord 待驗 | Mac→Windows 已保存訊息 15 秒內 DM；不存在收件者／未保存不通知；離線/DM 失敗一次彙總 |
| TC-19 | `/task` | ⏳ 缺 GitHub token，保持 fail-closed | 先驗 E-GITHUB、不新增 Issue/Hub task；空標題、取消、非發起人、連點；token 到位後補 Issue URL＋唯一 Hub item 正向，不把拒絕算全過 |
| TC-20 | 決策草稿／確認 | ⏳ 真 Discord 待驗 | 指定目前版本 owner/member 身分，草稿→確認、拒絕他人、重複互動、Mail ID/內容/狀態一致 |
| TC-21 | Hindsight 原文、繁中 | ⏳ 待部署 | 本機 e2e：sha256 一致 |
| EVAL-01 | question／action 分類 | 🟡 1/3 次 | claude CLI 第 1 次 30/30 正確（`docs/ops/evidence/EVAL01-claude-cli-run1.md`） |

## L09 部署與正式驗收接線

唯一部署順序：[runbook-L09-launch-deploy](ops/runbook-L09-launch-deploy.md)，入口 `ops/deploy-l09.sh --step 1..7`。本機假 VPS 收據：[L09-launch-dry-run](ops/evidence/L09-launch-dry-run.txt)；它使用明示 systemd／Discord／Hindsight fixtures，**不能**勾選下列正式環境驗收。正常部署只 reload Caddy 一次；後續 `/connect`／`/revoke` 的 reload 另計憑證管理。步驟 4 只有 Mail 移除 raw host port、HubClock 改走 validator 各需重建一次，保留 state；其餘段落兩者與 DB 的 IDs/StartedAt 必須不變。

| Gate／TC | PM 在正式環境必須附的證據 | 狀態 |
|---|---|---|
| L09 1 | office_before=200、free/df、三容器 baseline、PG 全備份 hash／隔離 restore／ledger | ⏳ VPS 未執行 |
| L09 2 | migrations 5～8 APPLY、重跑全 SKIP、ledger=8、CONNECT 隔離、owner/link、秘密 owner/mode（無值） | ⏳ VPS 未執行 |
| L09 3～4 | Hindsight/bank-proxy health、web 8781 explorer.js、raw Mail 無 PortBindings、validator loopback 8765、clock 經 validator tick、PG StartedAt 不變 | ⏳ VPS 未執行 |
| L09 5 | import-mvp Mac+Windows active、validate 成功且一個 reload、MVP 200／無 token 401、UI+explorer 200／API 401、office_after=200 | ⏳ VPS 未執行 |
| L09 6～7 | group-a timer 真觸發、legacy writer disabled、bot ready/bridge tick、systemd 全備份含雙 DB＋bridge JSON、八服務無 OOM/重啟 | ⏳ VPS 未執行 |
| TC-14 VPS | 核准的獨立雙組真 hostname/TLS：跨組 bearer 401、foreign project/key/附件拒絕、DB／決策／bank 隔離、原組仍正常（L08 的本機 96 次不是 VPS 證據） | ⏳ 上線 gate |
| TC-16～18 | 各列真 Discord 證據；applier receipt/audit 對應，保留時間/ID，遮掉 token/OAuth code/DM 原文秘密 | ⏳ 見上表 |
| TC-19～20 | GitHub 缺 token 拒絕與後續真 API 正向分開；真決策確認/拒絕及 Mail 對照 | ⏳ 見上表 |
| TC-21 | handoff/decision→MemoryBridge→Hindsight；Mail 與 get_document 原文 sha256 相同、recall 原文、繁中回應；未知結果按相同 document_id 查證、不重送 Mail；費用 0.50 USD/day gate | ⏳ 真 Anthropic／VPS 未驗 |
| L07／既有流程 | 工作站 verify-l07 raw MCP 合法保存/長度/密鑰拒絕/<100ms；實體 Mac↔Windows、action 確認/撤銷回歸；TC-15 原證據保留，再確認部署未回歸 | ⏳ 待部署後回歸 |
| UI／資源 | 真 Discord OAuth 成員/非成員/state 重播/登出/撤銷；四條架構流程與 source revision；三位新手；web 十人並發＋retain 共用 8GB/office 的 available 最低與各容器峰值、無 OOM | ⏳ 未驗 |

正式收據存 `docs/evidence/S1/TC-14/`、`TC-16/`～`TC-21/` 與 `docs/evidence/S1/L09/`；每項記 UTC 時間、部署 commit、操作者、指令／非秘密輸出、exit、判定及未完成項。GitHub token 尚缺時 TC-19 正向保持 pending，不把整批服務啟動當所有 TC 通過。

最新上線 gate（master `101363c`／SRS §4.6）：維護者 改要求 VPS Gemini 訂閱後端，F-11 查證/接線中；L09 原 Anthropic 整合路徑的七段 Docker 演練已通過，但正式 LLM consumers 上線須等 F-11，TC-17／21 不得以此收據勾選 Gemini 通過。
