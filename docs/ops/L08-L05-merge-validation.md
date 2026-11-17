# L-08 接續合併 L-05

工作分支 `example-org/codex-L08` 合併 master `bea0dc5`，解決 `bot/src/main.mjs`、`bot/src/store-pg.mjs` 的衝突。保留 L-05 決策管理器、router 按鈕、tick 提醒、decision ingest 與 status 顯示，同時保留 L-08 的固定 group store／分組 TokenApplier。

新增的真實 Postgres RED 測試先證明 A store 的 `getDecisionByMailId` 會傳回 B 草稿，見 `docs/ops/evidence/L08-L05-decision-red.txt`。修正覆蓋所有決策入口：Mail ID／draft ID 查詢、列表、確認／駁回、提醒查詢／更新與 recentItems 的 decision join。新增草稿與 ingest 綁定原 store group，狀態變更還要求確認者屬於同組 active member；陌生人拒絕事件的 audit 歸於本 bot 固定組別，保留原本權限拒絕回覆。

每個 Mail 容器都可能配置相同數字 message ID。新增 append-only migration `20261122000000_l08_l05_decision_groups.sql` 將 Mail／draft 唯一索引改成含 group_id 的 composite constraint，另補 `(confirmed_by, group_id)` member FK；部署時須依序執行 L05、L08 與本 migration，不修改既有 migration。若舊資料存在跨組 confirmer，migration 會失敗，應先調查，不刪資料繞過。

真實 Postgres 回歸含相同 Mail/draft ID 的兩組草稿、他組讀寫／提醒／確認者拒絕、recentItems 不 join 他組決策，以及決策按鈕 confirm、reject、duplicate、stranger 與他組草稿的結果。TC14 的 grp-test／grp-test2 也加入同一份決策組別驗證，仍使用真實 Caddy、Mail、Hindsight 與 hub_app→service_role。

## 驗證命令與證據

- `cd bot && npm test` → `L08-L05-bot-unit.txt`。
- `MAIL_BIN=<既有 F01b native binary> node --test bot/test/integration/*.test.mjs` → `L08-L05-bot-pg.txt`；包含真實 Mail→Postgres→DM 測試，沒有略過 Mail 測試。
- `MAIL_BIN=<同一 binary> node --test client/test/*.test.mjs` → `L08-L05-client-all.txt`；涵蓋 mail-client 與 hub-hook 的單元／整合全部檔案。
- `CADDY_BIN=<既有 Caddy 2.11.9> node ops/test/group-isolation-stack.mjs` → `L08-L05-tc14-local.txt`。

以上證據位於 `docs/ops/evidence/`；測試資料與 secrets 仍只留在忽略的私有 scratch。未 push、未改 master、未登入 VPS；這次結果不代表已驗收 VPS/TLS 或真實 Discord 的接入操作。

已完成：bot 單元 64／64、bot Postgres 整合 13／13（均 0 skipped），TC14 的 96 次跨組公開請求全為 401，Mail marker／Hindsight／DB／決策隔離全過；client 全套 118／118（0 skipped，含 TC13 雙向各五次量測），合計 195 個 Node tests 通過；數字與輸出見上述各 evidence。
