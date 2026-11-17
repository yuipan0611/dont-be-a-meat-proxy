# 上線驗收紀錄（L-09，S1，目標 2026-11-30）

- 負責：維護者＋PM｜依據：`docs/06-test-plan.md` TC-14～21、EVAL-01；`docs/07b-tickets-launch-draft.md`
- 狀態：**進行中**（2026-11-17）：程式 L-00～L-08 全在 master；VPS 已上 L-00、L-01、L-06；其餘待金鑰到位後一次部署
- 規則：每項附實際輸出；沒過寫原因與處理。

| 項目 | 內容 | 狀態 | 證據 |
|---|---|---|---|
| TC-14 | 跨組隔離（上線前必過） | 🟡 本機 ✅，VPS 待部署 | 本機 grp-test／grp-test2：96 次跨組 401、附件 marker 無外洩、Hindsight／DB／決策隔離（`docs/ops/evidence/L08-L05-tc14-local.txt`） |
| TC-15 | auto mode | ✅ 正式 Hub＋真 Windows | 拒絕案例（Mac）：無對象 #73→#75、300 分鐘 #74→#76，皆 auto_rejected、無生效 grant。維護者 在 Windows 親手 `auto on --for BlueLake --minutes 3` → #79 auto_on；生效中 Mac 送 action #80 → #81 auto_approved → Windows 未跳卡直接建 tc15.txt → #83 auto_executed succeeded；到期 #84 auto_ended；到期後 #85 → Windows 跳確認卡（presented），無人回應 30 分鐘 → #87 expired「視同拒絕，未執行」。2026-11-17 08:29～09:02Z |
| TC-16～20 | Discord `/connect`、`/status`、通知、`/task`、決策 | ⏳ 待部署 | 本機 bot 64/64、pg 整合 13/13 |
| TC-21 | Hindsight 原文、繁中 | ⏳ 待部署 | 本機 e2e：sha256 一致 |
| EVAL-01 | question／action 分類 | 🟡 1/3 次 | claude CLI 第 1 次 30/30 正確（`docs/ops/evidence/EVAL01-claude-cli-run1.md`） |
