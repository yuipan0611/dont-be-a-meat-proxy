# 02 PRD — don't be a meat proxy

- 負責人：swe-Tom（Claude）｜審查者：維護者｜協調：PM-Emily
- 日期：2026-11-16（G1 修訂：2026-11-16）｜狀態：**G1 修訂版**——Q-01～Q-10 已依 G1 回填；整份轉「已確認」由 PM 收件時確認
- G1 依據：`docs/gates/G1-decision.md`；下游：`docs/03-srs.md`（T5）
- 上游（唯一）：`docs/01-brief.md`（已確認，2026-11-16）。本文件的 G-xx、NG-xx、R-x、D-x、決策 #n 皆指 Brief 內編號。
- 模板：專案流程 `02-通用模板/02-prd.md`；提示詞 `03-通用提示詞/02-B-產品需求.md`；技能 `skills/to-spec`。
- 架構已由 G1 決定（D-1：Agent Mail Rust＋Hindsight＋Caddy＋GitHub Issues＋Discord bot）；本 PRD 仍只描述使用者可觀察的行為，系統規則見 SRS，介面見 SAD／SDS。
- 範圍：以 **S1** 為主；標 **〔S2〕**、**〔S3〕** 的 AC 只是前瞻承諾，S1 不驗收。
- 交付批次（G1 時程）：每個 US 標題後標 **〔MVP（11-23）〕**、**〔上線（11-30）〕** 或 **〔S2+〕**；同一 US 內個別 AC 批次不同時，在 AC 後另標。MVP＝VPS 上 Agent Mail＋Caddy 驗證，Mac↔Windows 非同步交接與同步傳訊；上線＝加 Hindsight 記憶、Discord bot、GitHub Issues，並開放組員 `/connect`。

## 名詞

| 詞 | 本文件的意思 |
|---|---|
| 成員 | 一位人類，身分＝其 Discord 帳號（決策 #8）。S1 只有 維護者 一位成員。 |
| agent | 成員在某台裝置、某個 AI 工具裡的工作階段（例：Mac 上 Orca 裡的 Claude、Windows 上的 Claude Code）。每個 agent 有可辨識的名稱，並歸屬於一位成員。 |
| Hub | 24 小時在線的共用服務，保存交接、決策、訊息（決策 #13：除任務外的唯一真相）。 |
| 項目 | agent 之間交換的內容，只有 4 種：**任務、交接、求助、決策**（決策 #6）。 |
| 問答類請求 | 只要求對方回答資訊、不改變任何檔案或狀態的請求。 |
| 動手類請求 | 要求對方接任務、改程式碼、合併等會改變狀態的請求（G-03）。 |
| 專案記憶 | Hub 內保存的交接、決策、訊息紀錄；Discord 對話不算正式紀錄。 |
| 專案助理 | 伺服器端 LLM，**唯讀**專案記憶，回答進度問題，不碰任何人的電腦。 |
| 在線／離線 | 某 agent 此刻是否連著 Hub、能即時收件。判定方式留給 SRS／SDS。 |

## 使用者、工作與情境

**主要使用者**：S1 是 維護者 本人，在 Mac（Orca 主控台）、Windows 桌電（Claude Code）、手機（Discord）三處切換工作；S2 擴到同組 7 人，S3 擴到全班 35 人。現在卡在：要讓一個 AI 的產出到另一個 AI 手上，只能人肉複製貼上（G-01）；對方不在線就只能等或留長訊息（G-02）；新 session 要重講背景；工具彼此不相通。Orca 的本機 orchestration 只能在同一台 Mac 內運作，不能跨電腦、跨人。

**主流程（非同步交接）**：維護者 在 Mac 的 agent 收工 → session 結束時交接自動寫入 Hub → 通知送到 Discord → 之後 維護者 在 Windows 開 Claude Code → 該 agent 先讀到「給我的項目＋專案現況」再開工。全程不需要貼任何東西。

**主流程（同步）**：兩端 agent 都在線 → A 問問題 → B 的 agent 直接回答；A 若要求 B 動手 → B 的畫面跳出確認 → B 同意才執行。B 可對指定的 A 開啟限時 auto mode，期間動手類請求自動執行並逐次留紀錄、通知。

**失敗／取消**：收件人離線時，項目只保存並通知，不會被代為執行（決策 #2）；動手類請求被拒絕或逾時，什麼都不會改；任何失敗都不能留下「看起來成功」的紀錄。**確認已保存**的方法是：在 Discord 或下一次開啟的 agent 能查到該項目、作者、時間與狀態。**重新進入後**，agent 與 Discord 都能看到未讀項目與最新專案現況。

## 故事與驗收條件

AC 原則：每條只驗一項可判斷的承諾；「可查到」指在 Hub 的正式紀錄中、經由 agent 或 Discord 能讀到。

### US-01 agent 之間直接傳遞，不經人轉貼（G-01）〔MVP（11-23）〕

身為 維護者，我想讓一個 agent 直接把任務／求助／決策送給另一個 agent，以便我不再當轉接站。

- AC-01.1：Given Mac agent「mac-claude」與 Windows agent「win-claude」都已連上 Hub　When mac-claude 送出一則求助給 win-claude，內容 1,500 字並含一個 PR 連結　Then win-claude 收到的內容與送出內容逐字相同（含連結），且該項目可查到類型＝求助、作者＝mac-claude、收件者＝win-claude、送出時間。
- AC-01.2：Given 收件者名稱「win-claud」不存在　When mac-claude 送出項目　Then 寄件端看到「收件者不存在」錯誤及可用收件者清單；Hub 不留下該項目，也不發任何通知。
- AC-01.3：Given 項目內容含疑似密碼或 API key 的字串（例：`sk-` 開頭長字串）　When 送出　Then 送出被拒並提示「Hub 禁止存放密碼／API key」；Hub 不保存該內容（R-4）。〔偵測範圍待人工審查〕〔上線（11-30）〕
- AC-01.4：Given 一則項目要附上程式碼變更　When 送出　Then Hub 只保存 PR／commit 連結，不保存原始碼本身（NG-03）。
- AC-01.5：Given G-01 基準由 維護者 於 S1 上線前一週手動記錄　When S1 期間結束　Then 維護者 能以同一記錄方式比較轉貼次數；本系統不負責自動計數。〔量測方式待人工審查〕

### US-02 對方離線時留下交接（G-02）〔MVP（11-23）〕

身為 維護者，我想在收件 agent 不在線時也能留下交接／任務／求助，以便不必等對方上線。

- AC-02.1：Given win-claude 離線　When mac-claude 送出一則交接給 win-claude　Then 寄件端立即看到「已保存，對方離線」；項目狀態＝未讀；Discord 收到一則通知（見 US-09）。〔Discord 通知部分：上線（11-30）〕
- AC-02.2：Given win-claude 離線且有一則未讀交接　When 期間任何人或任何 agent 等待　Then 該交接**不會**被自動執行，也不會被其他 agent 代為處理，只保存＋通知（決策 #2）。
- AC-02.3：Given 一則未讀交接　When 寄件 agent 於收件者讀取前撤回　Then 收件者之後看到的是「已撤回」標示而非原內容要求其執行；撤回紀錄與原內容仍保存在 Hub 供查。〔撤回能力為本 PRD 補上的取消流程，待人工審查；批次待確認〕
- AC-02.4：Given 寄件時 Hub 無法連線　When mac-claude 送出交接　Then 寄件端看到明確的「未送達」錯誤，不得顯示已保存；網路恢復後可重送，且重送不會產生兩筆相同項目（重複判定規則待 SRS）。

### US-03 開工時先讀到給我的東西與專案現況（G-02）〔MVP（11-23）〕

身為重新開啟 AI 的 維護者，我想讓新 session 一開始就知道別人留給它的東西與專案進度，以便不用重講背景。

- AC-03.1：Given win-claude 離線期間累積 2 則未讀項目（1 交接、1 求助）　When 維護者 在 Windows 開啟新的 Claude Code session 並連上 Hub　Then agent 在開始執行使用者的第一個指令前，先取得這 2 則項目（依送出時間由舊到新）及專案現況摘要。〔專案現況摘要：上線（11-30），MVP 只取未讀項目〕
- AC-03.2：Given 沒有任何未讀項目　When 開新 session　Then agent 收到「沒有給你的新項目」與專案現況摘要；不顯示空白或錯誤。
- AC-03.3：Given agent 已讀取某則項目　When 再開另一個 session　Then 該項目標為已讀，不再以「新項目」出現，但仍可查到。
- AC-03.4：Given Hub 無法連線　When 開新 session　Then agent 明確告知「無法取得交接與專案現況」，不得假裝沒有未讀項目。

### US-04 交接在 session 結束時自動寫入（G-02）〔上線（11-30）〕（MVP 期間交接以 US-02 手動送出；待對齊 T7 hook 可行性）

身為 維護者，我想讓 agent 在 session 結束時自動寫好交接，以便我不用記得手動寫。

- AC-04.1：Given mac-claude 的 session 有做事（例：改了檔案或完成任務）　When session 正常結束　Then Hub 自動新增一筆交接，含作者 agent、成員、結束時間、做了什麼、未完成事項、相關 PR／commit 連結；無須人確認即為有效紀錄（決策 #9）。
- AC-04.2：Given 交接自動寫入失敗（例：離線）　When session 結束　Then 使用者在該 session 畫面看到「交接未寫入」提示；不得留下半筆紀錄。補寫方式待決（Q-04）。
- AC-04.3：Given session 異常中斷（當機、強制關閉）　When 之後查詢　Then 不得出現假造的交接內容；如何標示「上次 session 未正常交接」待決（Q-04）。
- AC-04.4：Given 自動寫入的交接　When 任何人查看　Then 能分辨它是 agent 自動寫入（作者標記，R-1）。
- AC-04.5（G1 新增）：Given 任一則交接（手動或自動）　When 之後以其 ID 取回　Then 得到與寫入時逐字相同的原文（含繁體中文用字）；專案記憶產生的摘要或萃取不得取代原文（G1 #10、F-05）。〔原文保存：MVP；記憶索引：上線〕

### US-05 同步問答自動回答（G-03）〔MVP（11-23）〕

身為在線的 維護者，我想讓另一端 agent 的問題由我的 agent 直接回答，以便不用我介入就能拿到答案。

- AC-05.1：Given mac-claude 與 win-claude 都在線　When mac-claude 對 win-claude 提出問答類請求「目前 login 測試是否通過？」　Then win-claude 即時收到並自動回答，不跳出確認；mac-claude 收到回答，且問與答皆存入 Hub。
- AC-05.2：Given 一則請求同時包含問題與動手要求（例：「測試有沒有過？沒過就幫我修」）或無法判斷類型　When 送達　Then 一律視為動手類，走 US-06 的確認流程（安全預設）。〔分類邊界待人工審查〕
- AC-05.3：Given win-claude 已離線　When mac-claude 提出問答類請求　Then 轉為非同步：寄件端看到「對方離線，已保存」，請求以未讀項目等待（同 US-02），不由其他 agent 代答。
- AC-05.4：Given 收件 agent 在線但在回答時限內沒有回應（問答時限 G1 未決，見 Q-02）　When 時限到　Then 寄件端看到「未回應，已轉為留言」，請求保留為未讀。

### US-06 動手類請求需收件人確認（G-03）〔MVP（11-23）〕

身為收件人 維護者，我想在別的 agent 要求我的 agent 動手前先由我同意，以便我的程式不會被別人的 AI 改掉。

- AC-06.1：Given win-claude 在線、未開 auto mode　When mac-claude 送出動手類請求「接下 Issue #12 並開分支修改」　Then win-claude 的畫面顯示確認提示（請求者、內容、會做的事），在 維護者 同意前**不執行任何動作**。
- AC-06.2：Given 確認提示顯示中　When 維護者 同意　Then win-claude 執行；請求狀態＝已同意；mac-claude 收到「已同意，開始執行」；紀錄含同意者與時間。
- AC-06.3：Given 確認提示顯示中　When 維護者 拒絕（可附理由）　Then 不執行任何動作；狀態＝已拒絕；mac-claude 收到拒絕及理由。
- AC-06.4：Given 確認提示顯示中　When 確認提示顯示滿 30 分鐘仍無回應（G1）　Then 狀態＝已逾時，視同拒絕，不執行；mac-claude 收到逾時通知。
- AC-06.5：Given 寄件 agent 於收件人回應前撤回　When 收件人之後看到該請求　Then 顯示「已撤回」，無法再同意執行。
- AC-06.6：Given 收件 agent 離線　When 送出動手類請求　Then 只保存＋通知；收件人下次上線時仍需確認才執行，不會因為「累積等待」而自動執行。
- AC-06.7：Given 任何情況　When 遠端請求要求在未經確認、未開 auto mode 下直接操作他人電腦上的 AI　Then 系統不提供此能力（NG-02）。

### US-07 auto mode：收件人開、指定對象、限時、留紀錄（G-03）〔上線（11-30）〕

身為收件人 維護者，我想對特定 agent 暫時開放自動執行，以便連續協作時不用每次按同意，但又能控制風險（R-2）。

- AC-07.1：Given 維護者 是 win-claude 的擁有者　When 維護者 對 win-claude 開啟 auto mode，對象＝mac-claude、時長未指定　Then 時長採預設 1 小時（G1）；系統記錄開啟者、對象、開始與結束時間；Discord 收到「auto mode 已開啟」通知。
- AC-07.2：Given win-claude 的 auto mode 對 mac-claude 有效中　When mac-claude 送出動手類請求　Then win-claude 不跳確認、直接執行；每次執行都寫入紀錄（請求者、內容、執行結果、時間），並通知 維護者。
- AC-07.3：Given auto mode 只對 mac-claude 開啟　When 另一個 agent（例：〔S2〕組員 Ann 的 agent）送出動手類請求　Then 仍走 US-06 確認流程。
- AC-07.4：Given auto mode 於 14:00 到期　When mac-claude 於 14:01 送出動手類請求　Then 走 US-06 確認流程；到期時 Discord 收到「auto mode 已結束」通知。
- AC-07.5：Given auto mode 有效中　When 維護者 提前關閉　Then 立即失效，之後的請求需確認；關閉事件留紀錄。
- AC-07.6：Given 寄件者（非收件 agent 的擁有者）　When 嘗試替收件 agent 開啟 auto mode　Then 被拒並提示「只有收件人能開啟」；不產生任何生效紀錄。
- AC-07.7：Given 開啟 auto mode 時未指定對象，或時長超過 4 小時　When 送出設定　Then 被拒，提示「必須指定對象」或「最長 4 小時」；不得存在「對所有人」或「永不到期」的設定（G1：預設 1 小時、最長 4 小時）。
- AC-07.8：Given auto mode 期間某次執行失敗　When 執行結束　Then 紀錄與通知如實寫「失敗」及原因，不寫成成功。

### US-08 在 Discord 查進度（G-04）〔上線（11-30）〕

身為在手機上的 維護者，我想問 Discord bot「現在做到哪」，以便離開電腦也能掌握進度。

- AC-08.1：Given 專案記憶中有最近 3 筆交接與 GitHub 上 5 個進行中任務　When 維護者 在 Discord 問「現在做到哪」　Then 專案助理回覆進度摘要，並附依據（交接時間／作者、Issue 編號或連結）。
- AC-08.2：Given 問題涉及專案記憶沒有的資訊　When 提問　Then 助理回答「記憶中沒有這項資訊」，不臆測。
- AC-08.3：Given 有已確認決策與未確認草稿　When 助理引用決策　Then 明確標示哪些是「已確認」、哪些是「草稿」。
- AC-08.4：Given 任何提問　When 助理回答　Then 不修改專案記憶、不建任務、不對任何人的電腦下指令（唯讀）。要求它動手時，回覆應改用的功能（例：建任務指令）。
- AC-08.5：Given 當日 LLM 費用已達 維護者 設定的每日上限　When 再提問　Then bot 回覆「今日查詢額度已用完，明日恢復」，不再產生費用。上限數值與 LLM 供應商待 D-4／F-07（Q-05）。
- AC-08.6：Given 非成員的 Discord 帳號　When 提問　Then bot 拒絕並不透露任何專案內容。
- AC-08.7（G1 新增）：Given 成員在頻道問進度　When 助理回覆　Then 預設只有提問者看得到（ephemeral）；提問者明確選擇公開時才公開在頻道（G1 #11、F-06 P-1）。

### US-09 通知（G-04）〔上線（11-30）〕

身為 維護者，我想在有人交接給我或 @ 我時於 Discord 收到通知，以便不用一直盯著電腦。

- AC-09.1：Given 有一則交接／任務／求助指定給 維護者 的任一 agent　When 項目保存成功　Then 維護者 在 Discord 收到通知，含類型、寄件者、摘要（不含全文中的敏感資訊）與查看方式。
- AC-09.2：Given 有人在項目或 Discord 中 @ 維護者　When 送出　Then 維護者 收到通知。
- AC-09.3：Given 一則動手類請求等待 維護者 確認、或 auto mode 執行了一次、或 auto mode 開始／結束　When 事件發生　Then 維護者 收到通知。
- AC-09.4：Given 項目保存失敗　When 送出失敗　Then 不發「已收到」通知（通知只反映已保存的事實）。
- AC-09.5：Given Discord 暫時無法送達　When 之後恢復　Then 項目本身不受影響、仍可在 agent 端查到；通知是否補發待決（Q-06）。

### US-10 從 Discord 建任務（G-04）〔上線（11-30）〕

身為在手機上的 維護者，我想從 Discord 建任務，以便想到就能排進看板。

- AC-10.1：Given 維護者 是成員　When 在 Discord 用建任務指令輸入標題「登入頁錯誤訊息改中文」（可選內容、指派對象）　Then GitHub Issues 新增一筆對應 Issue 並加入專案看板；bot 回覆 Issue 編號與連結。任務狀態以 GitHub 為準（決策 #11、#13）。
- AC-10.2：Given 標題為空　When 送出　Then bot 提示「標題必填」，GitHub 不新增任何 Issue。
- AC-10.3：Given GitHub 暫時無法連線或權限不足　When 送出　Then bot 回覆失敗原因；不得回報成功、不得留下只有一半的任務紀錄。
- AC-10.4：Given 維護者 在確認前取消建立（若建任務需確認步驟，見 Q-07）　When 取消　Then 不新增任何 Issue。
- AC-10.5（G1 新增）：Given agent 要把一件任務交給另一個 agent　When 送出任務類項目　Then 先建立 GitHub Issue，項目內只放 Issue 連結；Issue 建立失敗時項目不送出、寄件端看到失敗原因（G1 #9）。任務狀態一律以 GitHub 為準。

### US-11 決策：草稿入庫、確認才轉正式（G-04）〔上線（11-30）〕

身為 維護者，我想讓 agent 記下的決策先當草稿保存，由人在 Discord 確認後才算數，以便記憶不被低品質內容污染（R-1）。

- AC-11.1：Given 一個 agent 記下一則決策「登入改用 Discord OAuth」　When 寫入　Then Hub 保存為**草稿**（含作者 agent、時間），並在 Discord 發出待確認通知。
- AC-11.2：Given 一則草稿決策　When 維護者 在 Discord 確認　Then 狀態轉為**已確認**，記錄確認者與時間；之後 agent 開工時與助理回答時視為正式決策。
- AC-11.3：Given 一則草稿決策　When 維護者 在 Discord 駁回　Then 狀態＝已駁回，仍保存可查，但不得被當成正式決策引用。
- AC-11.4：Given 草稿尚未確認　When agent 開工讀取專案現況（US-03）　Then 草稿與已確認決策分開呈現並標示狀態。
- AC-11.5：Given 非成員或〔S2〕無權限者　When 嘗試確認決策　Then 被拒，狀態不變。確認者（G1）：S1 只有 維護者；〔S2〕提出者以外的任一成員可確認，維護者 可否決。
- AC-11.6（G1 新增）〔S2〕：Given 一則由提出者以外成員確認的決策　When 維護者 否決　Then 狀態＝已否決，記錄否決者與時間，不再被當成正式決策引用。

### US-12 用 Discord `/connect` 接上（G-05）〔上線（11-30）〕（MVP 期間由 維護者 手動發 token、在 Caddy 撤銷，見 SRS SR-ID）

身為新加入的組員，我想在 Discord 打 `/connect` 拿到一段設定，貼進我的 AI 工具就能用，以便 5 分鐘內上手且不用安裝 Orca（決策 #5、#8）。

- AC-12.1：Given 維護者 是成員（S1）　When 在 Discord 打 `/connect`　Then bot 回覆一段設定（Claude Code／Antigravity 可為一行指令，F-02）與貼到哪裡的簡短說明，且只有 維護者 看得到（不公開在頻道）。
- AC-12.2：Given 維護者 把設定貼進 Windows 的 Claude Code　When 重新啟動工具　Then 該 agent 能連上 Hub、以 維護者 名下的 agent 身分收發項目（可用 US-01 驗證）。
- AC-12.3：Given 非成員的 Discord 帳號　When 打 `/connect`　Then 被拒，不發設定。
- AC-12.4：Given 維護者 在 Discord 撤銷某一份設定（例：Windows 那份）　When 該 agent 再嘗試連線　Then 被拒並提示「連線已撤銷」；其他裝置的設定不受影響（R-4：每人一個 token、可撤銷）。
- AC-12.5：Given 撤銷後　When 再打 `/connect`　Then 取得新的可用設定，舊設定仍無效。
- AC-12.6：〔S2+〕Given 一位未用過本系統的組員與 Discord 成員資格　When 從打 `/connect` 開始計時到第一則項目收發成功　Then 耗時 ≤5 分鐘（暫定門檻，S2 實測）。〔待人工審查〕
- AC-12.7：〔S2+〕Given Codex、Cursor、Antigravity、VS Code 任一工具　When 貼上設定　Then 能接上；不支援的工具需明列（由 F-02 驗證，A-2）。

### US-13 S1 跨裝置互通：Mac ↔ Windows（G-02、G-03，S1 完成條件）〔MVP（11-23）〕

身為 維護者，我想讓 Mac 上 Orca 的 agent 與 Windows 上 Claude Code 的 agent 雙向互通，以便 S1 能上線。

- AC-13.1：Given Mac agent 與 Windows agent 都已連上　When 兩邊各自送一則問答類請求給對方　Then 兩個方向都即時收到並自動回答（US-05）。
- AC-13.2：Given Windows agent 離線　When Mac agent 留交接；之後 Windows agent 開新 session　Then 交接被讀到（US-02、US-03）；反方向（Windows 留、Mac 讀）同樣成立。
- AC-13.3：Given Mac agent 對 Windows agent 送出動手類請求　When 未開 auto mode　Then 在 Windows 畫面上確認後才執行（US-06）；反方向同樣成立。
- AC-13.4：Given Mac 或 Windows 任一台關機　When 手機在 Discord 問進度　Then 仍能得到回答（Hub 24 小時在線，US-08）。〔上線（11-30）〕
- AC-13.5：Given 兩台電腦不在同一網路（例：Windows 在家、Mac 在外）　When 互傳項目　Then 行為與同網路時相同。

### US-14 〔S2〕〔S3〕多人與多組隔離（前瞻）〔S2+〕

身為〔S2〕組員或〔S3〕他組成員，我需要身分與資料界線清楚，以便推廣時不互相干擾。

- AC-14.1：〔S2〕Given 組員 Ann 與 維護者 都已 `/connect`　When Ann 的 agent 送交接給 維護者 的 agent　Then 項目作者顯示 Ann（其 Discord 身分）與其 agent 名稱。
- AC-14.2：〔S2〕Given Ann 的 agent　When 嘗試為 維護者 的 agent 開 auto mode　Then 被拒（同 AC-07.6）。
- AC-14.3：〔S3〕Given A 組與 B 組各自使用　When A 組成員的 agent 或 Discord 查詢　Then 只看得到 A 組的項目、決策與進度；專案助理也只用 A 組記憶回答（NG-06 於 S3 解除）。
- AC-14.4：〔S3〕Given A 組成員　When 嘗試送項目給 B 組的 agent　Then 被拒。跨組協作是否需要待決（Q-08）。

## 產品規則與體驗

正常體驗：agent 之間送項目就像寄信——送出即保存，對方在線就即時收到、離線就等對方開工時讀到；問答自動、動手要確認；人用 Discord 看進度、收通知、建任務、確認決策。所有正式紀錄只在 Hub（任務在 GitHub），Discord 對話本身不算紀錄。

| 情境／規則 | 使用者看見的結果與資料變化 | 來源／AC |
|---|---|---|
| 收件人離線 | 只保存＋通知，不代為執行、不由他人代答 | 決策 #2；AC-02.1、02.2、05.3、06.6 |
| 問答 vs 動手無法判斷 | 視為動手類，需確認 | G-03、R-2；AC-05.2 |
| auto mode 設定 | 只收件人能開；必須指定對象＋時長；可提前關；每次執行留紀錄＋通知 | 決策 #3、R-2、NG-05；US-07 |
| 交接寫入 | session 結束自動寫入，不需確認；有作者標記 | 決策 #9、R-1；US-04 |
| 決策寫入 | 先存草稿，Discord 確認後才正式；駁回仍保留 | 決策 #9、R-1；US-11 |
| 任務真相 | 以 GitHub Issues／Projects 為準 | 決策 #11、#13；US-10 |
| 程式碼 | Hub 只存 PR／commit 連結 | NG-03；AC-01.4 |
| 密碼／API key | 不得存入 Hub；token 每人一份、可撤銷 | R-4；AC-01.3、12.4 |
| 失敗回報 | 任何未保存、未執行、未建立的動作，不得顯示成功、不得發「已收到」通知 | 專案流程「持久結果明確」；AC-02.4、04.2、09.4、10.3 |
| 重複送出 | 網路重試不產生兩筆相同項目 | AC-02.4（判定規則待 SRS） |
| 專案助理 | 唯讀；資料不足就說不知道；草稿與正式分開標示；有每日費用上限 | Brief 系統構成、限制；US-08 |
| 組員安裝 | 不需安裝 Orca，只貼一段設定 | 決策 #5；US-12 |
| 交接原文 | 一律保存並可逐字取回；記憶摘要不取代原文 | G1 #10；AC-04.5 |
| 任務先建 Issue | 任何來源的任務先成為 GitHub Issue，訊息只帶連結 | G1 #9；AC-10.5 |
| 時限 | 動手確認 30 分鐘逾時＝拒絕；auto mode 預設 1 小時、最長 4 小時 | G1 #7；AC-06.4、07.7 |

## 目標覆蓋（Gate 自查）

| 目標 | 使用者結果 | 故事 | S1 可驗？ |
|---|---|---|---|
| G-01 不當轉接站 | agent 直接互傳，內容不失真 | US-01（並由 US-02～07 支撐） | ✅ 行為可驗；減量 ≥70% 需 維護者 量基準（Brief ⚠️） |
| G-02 非同步交接 | 離線留交接、開工先讀、自動寫入 | US-02、03、04、13 | ✅ |
| G-03 同步溝通 | 問答自動、動手確認、auto mode | US-05、06、07、13 | ✅ |
| G-04 手機掌握進度 | 查進度、通知、建任務、確認決策 | US-08、09、10、11 | ✅ |
| G-05 5 分鐘接上 | `/connect` 一段設定、可撤銷 | US-12 | ⚠️ 流程 S1 可驗；≤5 分鐘門檻 S2 實測 |

## 範圍、依賴與待決

**範圍內（S1）**：US-01～US-13。**前瞻（不在 S1 驗收）**：標〔S2〕〔S3〕的 AC 與 US-14。

**交付批次總覽（G1 時程）**

| 批次 | 日期 | US |
|---|---|---|
| MVP | 2026-11-23 | US-01、02、03（未讀項目）、05、06、13（13.4 除外） |
| 上線 | 2026-11-30 | US-04、07、08、09、10、11、12；以及 AC-01.3、02.1 的 Discord 通知、03.1 的專案現況摘要、04.5 的記憶索引、13.4 |
| S2+ | 2026-11-30 起，另過 Gate | US-14；AC-11.6、12.6、12.7 |

**非目標**（沿用 Brief）：NG-01 網頁版 ChatGPT／Claude／Gemini；NG-02 非 auto mode 下遠端操作他人 AI；NG-03 Hub 存原始碼；NG-04 LINE 為主要入口；NG-05 完整角色／權限系統；NG-06 S1 支援多組。

**外部依賴**：GitHub Issues／Projects（官方 GitHub MCP）、Discord bot、VPS、伺服器端 LLM、各 AI 工具的遠端 MCP 支援（A-2）。

**阻塞與 Gate**（Brief 既有，決策人 維護者）：
- D-1：✅ G1 已決定——Agent Mail Rust（一組一容器）＋Hindsight（一組一 bank＋代理）＋Caddy＋GitHub＋Discord bot 膠水。
- D-2：✅ G1 已決定——既有 Hostinger 2 vCPU／8 GB／100 GB。
- D-3：S3 是否改由各組自備 LLM key（S2 Gate）。
- D-4：專案助理 LLM（F-07，11-18 前）。影響 AC-08.5。

### 本 PRD 新增的待決事項（需 維護者 決定，未決前不得當成已確認需求）

| ID | 問題 | 影響 AC | 建議決定時點 | 狀態 |
|---|---|---|---|---|
| Q-01 | auto mode 時長的上限與預設值（例：最長 4 小時？） | AC-07.1、07.7 | G1 | **已確認（G1）**：預設 1 小時、最長 4 小時，到期自動關閉 |
| Q-02 | 同步問答與動手確認的等待時限各多久，逾時後如何處理 | AC-05.4、06.4 | G1（或 SRS 前） | **部分已確認（G1）**：動手確認 30 分鐘，逾時視為拒絕並通知寄件者。**問答的回答時限仍待決**（SRS SR-MSG-09 暫列待確認） |
| Q-03 | S2 起誰可以確認決策：只有 維護者、決策相關人、或任一組員 | AC-11.5 | S2 前 | **已確認（G1）**：S1 只有 維護者；S2 起提出者以外任一成員，維護者 可否決 |
| Q-04 | 交接自動寫入失敗或 session 異常中斷時：自動補寫、下次開工提示、或標記「未交接」 | AC-04.2、04.3 | G1（或 SRS 前） | 待決（G1 未涵蓋；Brief A-5 備案「每完成一段就寫入」由 SDS 定） |
| Q-05 | 專案助理每日 LLM 費用上限金額（依 F-03 查價） | AC-08.5 | G1 | 待決：「要有每日上限、超過即停」已確認（Brief 限制）；金額隨 D-4 LLM 選擇（11-18 前）定 |
| Q-06 | Discord 通知送不出時是否補發、補發多久內 | AC-09.5 | SRS 前 | 待決 |
| Q-07 | 從 Discord 建任務是否需要二次確認步驟 | AC-10.4 | SRS 前 | 待決 |
| Q-08 | 〔S3〕是否允許跨組送項目 | AC-14.4 | S3 前 | 待決（S3 前） |
| Q-09 | S1 只有 維護者 一位成員：Mac 與 Windows 的 agent 皆屬 維護者，「收件人確認」與「auto mode 只有收件人能開」在 S1 是否以「該 agent 所在畫面的操作者」為準 | US-06、07、13 | G1 | **已確認（G1 #6）**：S1 所有 agent 屬 維護者，確認與開 auto mode 都由 維護者 在收件 agent 的畫面操作 |
| Q-10 | 「專案現況摘要」的內容範圍（最近幾筆交接？進行中任務？已確認決策？） | AC-03.1、03.2 | SRS 前 | 待決（G1 未涵蓋；上線批次才需要） |

### 待人工審查的 AC

以下 AC 是本 PRD 依 Brief 推導或補上的，Brief 未逐字寫明，請 維護者 確認是否保留：

1. **AC-01.3** 密碼／API key 偵測並拒收——Brief 只說「禁止存放」，自動偵測的範圍與誤判處理需確認。
2. **AC-01.5** G-01 量測由 維護者 手動記錄、系統不自動計數——確認是否要系統輔助計數。
3. **AC-02.3、AC-06.5** 寄件者撤回——為滿足「取消」流程而新增，Brief 未提。
4. **AC-02.4** 重送不重複——屬可靠性承諾，判定規則留 SRS。
5. **AC-05.2** 無法判斷類型時一律當動手類——安全預設，但可能增加確認次數。
6. **AC-06.7** 明確不提供未經確認的遠端操作（NG-02 轉為 AC）。
7. **AC-07.7** 不允許「對所有人」或「永不到期」的 auto mode。
8. **AC-08.6、AC-12.3** 非成員一律拒絕——S1 成員只有 維護者；S2 成員名單的來源（Discord 伺服器角色？手動名單？）待 SRS。
9. **AC-09.1** 通知不含全文敏感資訊——摘要長度與規則待 SRS。
10. **AC-12.1** `/connect` 回覆只給本人看見——依 R-4 推導。
11. **AC-12.6** ≤5 分鐘的計時起訖點（從 `/connect` 到第一則項目收發成功）。
12. **AC-13.5** 跨網路行為與同網路相同——依「跨電腦」目標推導，實際受 A-1 驗證結果影響。

> 審查重點：每個 G 都有使用者結果（見目標覆蓋表）；成功、拒絕、取消／離線、持久結果均有 AC；核心規則有 Brief 來源；只有 G1 已決定的 Q 標「已確認（G1）」，其餘 Q 與待人工審查的 AC 未被寫成已確認需求；每個 US 都有交付批次。
