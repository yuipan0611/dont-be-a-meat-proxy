# F-06 Discord 橋接調研：能抄就抄

- 作者：swe-Tom（Claude）｜審查者：PM-Emily → 維護者（G1）｜日期：2026-11-16｜狀態：**草稿**
- 觸發：F-04 結論「唯一要寫的膠水是 Discord bot」（`/connect` 發設定、通知、查進度、建 GitHub issue、決策確認按鈕）。本文找現成專案可抄的部分。
- 方法：**只讀文件，沒有執行任何專案。** 用 `gh api`（GitHub REST）取 repo 資料，用 `gh api .../readme` 與 `contents/` 讀 README 與 docs，另做網路搜尋。所有查詢日期都是 **2026-11-16**。星數、最近 commit 是當天預設分支的數字。
- 對照的需求：`docs/02-prd.md` 的 US-08～US-12（PRD 狀態仍是草稿）。
- 用詞：**可抄**＝直接 fork 或沿用程式／設定，改動很小。**需改**＝有接近的現成實作，但要改行為或接到我們的 Hub。**需自寫**＝找不到現成的，只能參考行為。

---

## 0. 結論（先看這裡）

1. **找不到現成專案能一次包辦五件事。** 主要有三類：
   - 「Discord 上的 LLM＋MCP client」：可以抄來做**查進度**。
   - 「Discord↔Claude Code 遙控器」：可以抄**按鈕確認的 UI 行為**。
   - 「Discord→GitHub issue bot」：可以抄來做**建任務**。
2. **`/connect` 發 token 與撤銷沒有任何專案做過**（每個成員一個遠端 MCP token）。這部分**需自寫**，但規則可以照抄 OpenClaw 的 pairing 與 Rakazo 的 link code。
3. **Agent Mail 與 Hindsight 都沒有官方的 Discord 整合**（兩個 repo 的檔案樹裡都沒有 discord 相關檔）。通知要靠膠水程式。事件從哪裡來（Agent Mail 是否能主動推送）**待確認**，見 F-01 與 V-3。
4. 查進度的建議起點是 **js-llmcord（MIT，支援遠端 MCP）**，備選 **Vercade（Apache-2.0，Pydantic AI＋MCP）**。js-llmcord 星數很少（6），只有一位維護者，最近 commit 在 2026-02，所以有 fork 後要自己維護的風險。
5. 有幾個 repo **沒有授權**（cline/gitbot、DisCode、IssueBot、EIRTeam）。依著作權預設，它們的程式碼**不能抄**，只能參考行為。

---

## 1. 現成開源專案

### 1A. Discord bot 當 MCP client／Discord 上的 LLM 助理

| 專案 | 授權 | ★ | 最近 commit | 語言 | 能抄哪一段 | 缺什麼 |
|---|---|---|---|---|---|---|
| [stanley2058/js-llmcord](https://github.com/stanley2058/js-llmcord) | MIT | 6 | 2026-02-07 | TypeScript（Bun、Vercel AI SDK） | 回覆串當對話歷史；**本機與遠端 MCP 工具呼叫**；`max_steps` 限制工具迴圈次數；`permissions` 白名單（users／roles／channels）；Docker compose；Anthropic prompt caching | 沒有每日費用上限（只有 `stats_for_nerds` 顯示 token 用量，上限機制**待確認**）；不能限制「只用唯讀工具」，要自己挑選掛上的 MCP 工具；維護者只有一人 |
| [jakobdylanc/llmcord](https://github.com/jakobdylanc/llmcord) | MIT | 843 | 2026-08-14 | Python（約 300 行） | 行為規則：@bot 開始對話、回覆接續、不需資料庫；`permissions` 的 allowed／blocked／admin_ids；訊息超量時顯示警告 | README **沒有提到 MCP**（截至查詢日）。要接工具得自己加 |
| [lintyourcode/vercade](https://github.com/lintyourcode/vercade)（舊名 friendbot） | Apache-2.0 | 2 | 2026-09-19 | Python（Pydantic AI） | 透過 MCP server 給 agent 工具；支援 Agent Skills；可以收到訊息時跑，也可以排程跑；Docker | README 自稱「early development, not production」；沒看到權限或費用上限 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | MIT | 394,546 | 2026-11-16 | TypeScript | **規則可抄**：Discord DM pairing、guild allowlist、mention gating、按鈕 `allowedUsers`、callback TTL、exec approvals（見 §3C） | 這是完整的個人助理平台，拿來當我們唯讀的專案助理太重；是否以 MCP client 連我們的 Hub **待確認**（沒讀到 MCP 相關文件） |

### 1B. Discord↔Claude Code 遙控器（參考確認按鈕的行為）

> 這類專案是讓**你自己**從 Discord 遙控**自己**那台機器上的 Claude Code。我們的 Hub 不能這樣做（PRD AC-06.7／NG-02：不從遠端直接操作別人的 AI），所以**只抄 UI 行為，不抄架構**。

| 專案 | 授權 | ★ | 最近 commit | 語言 | 能抄哪一段 | 缺什麼 |
|---|---|---|---|---|---|---|
| [zebbern/claude-code-discord](https://github.com/zebbern/claude-code-discord) | MIT | 234 | 2026-08-01 | TypeScript（Agent SDK） | Allow／Deny 按鈕；AskUserQuestion 按鈕；限定特定 Discord role 才能用危險指令（RBAC）；任務完成時 @USER_ID；「頻道歷史就是稽核紀錄」 | 正式紀錄放在 Discord 頻道，跟我們「Discord 對話不算正式紀錄」相反 |
| [chadingTV/claudecode-discord](https://github.com/chadingTV/claudecode-discord) | MIT | 65 | 2026-05-01 | TypeScript（discord.js v14、SQLite、zod、vitest） | 工具使用的核准／拒絕按鈕；Stop 按鈕；使用者白名單；rate limit；防止重複啟動；一台機器一個 bot、一個頻道對一個專案 | 是單人遙控器，不是跨人 Hub；有 `/auto-approve` 開關，但沒有「指定對象＋限時」 |
| [six-ddc/disclaw](https://github.com/six-ddc/disclaw) | MIT | 14 | 2026-06-18 | TypeScript | 按鈕 Allow／Deny／Always Allow，附工具名稱與輸入預覽；Plan Review 用 embed 加三個按鈕；一個 thread 就是一個 session；pager 把長輸出收合 | 同上 |
| [fredchu/discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) | MIT | 5 | 2026-08-04 | TypeScript（單檔） | 一個 thread 對一個 CLI session；權限提示轉成按鈕 | 規模很小 |
| [raylin01/DisCode](https://github.com/raylin01/DisCode) | **無授權** | 2 | 2026-03-10 | HTML／TS | 支援多台機器、核准按鈕（只參考行為） | **沒有授權，程式碼不能抄** |

### 1C. Discord↔GitHub issue bot

| 專案 | 授權 | ★ | 最近 commit | 語言 | 能抄哪一段 | 缺什麼 |
|---|---|---|---|---|---|---|
| [Effect-TS/discord-bot](https://github.com/Effect-TS/discord-bot)（`/issueify`，檔案 `packages/discord-bot/src/Issueifier.ts`） | MIT | 102 | 2026-10-29 | TypeScript（Effect） | 把整個 thread 的訊息交給 LLM 摘成標題與內文，再建 issue（依搜尋摘要；原文件頁 mintlify 回 410，**細節待確認**） | 和 Effect 框架綁得很深，要拆出來；用的是 OpenAI key |
| [StephanAkkerman/github-issue-bot](https://github.com/StephanAkkerman/github-issue-bot) | MIT | 3 | 2024-05-25 | Python（discord.py＋PyGithub） | 最簡單的「指令→建 issue」；用 emoji 對應 label | 很久沒更新；README 建議給 bot 全部權限（**不要照做**） |
| [cline/gitbot](https://github.com/cline/gitbot) | **無授權** | 4 | 2025-04-03 | JavaScript | 行為可參考：用**結構化表單**建 issue；**GitHub App 驗證**；記錄 Discord 使用者↔issue 的對應；列出／關閉 issue | **沒有授權，程式碼不能抄** |
| [theCapypara/IssueBot](https://github.com/theCapypara/IssueBot) | 無授權 | 1 | 2020-09 | JS | — | 太舊，也沒有授權 |

> 也可以不抄 bot，讓查進度的 LLM 透過**官方 GitHub MCP**（F-02）建 issue。但查進度助理在 PRD 中規定**唯讀**（AC-08.4），所以建任務要走另一條路：獨立的 slash command，由 bot 呼叫 GitHub。

### 1D. Agent Mail／Hindsight 的 Discord 整合

| 對象 | 查到的結果 |
|---|---|
| [Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)（授權欄 NOASSERTION、★256、2026-11-16、Rust） | 檔案樹裡**沒有 Discord**。有 `notifications` 測試 fixture（debounce、pending signals），代表內部有某種通知或訊號機制。這個機制能不能被外部 bot 訂閱**待確認**（屬於 F-01 的範圍）。授權實際條款**待確認**。 |
| [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)（★2,235） | repo 描述已標示 Deprecated，改由 Rust 版取代。 |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)（MIT、★61,239、2026-11-14） | 檔案樹**沒有 Discord**。查進度可以透過它的 MCP 端點做 recall（F-04），所以不需要專門的 Discord 整合。 |
| 第三方「agent→Discord」MCP server（例：[SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) MIT ★606；[alii/neuron](https://github.com/alii/neuron) MIT ★7） | 方向相反：讓 agent 操作 Discord。可以讓 agent 自己發通知，但通知會變成每台機器各自發，不經過 Hub，Hub 也不會有紀錄。**不建議**拿來做正式通知（PRD AC-09.4 規定通知只反映已保存的事實）。 |

---

## 2. 對照 PRD US-08～US-12

| PRD | 判定 | 抄誰／怎麼做 | 我們要補的 |
|---|---|---|---|
| **US-08 查進度** | **需改** | 以 js-llmcord（或 Vercade）為底：@bot 或 slash 提問 → LLM 透過 MCP 讀 Hindsight recall、GitHub（唯讀）、Agent Mail（唯讀） | 只掛**唯讀**工具（AC-08.4）；回答附依據並區分草稿／已確認（AC-08.1、08.3）；**每日費用上限**（AC-08.5，查無現成，**需自寫**；可照抄 Rakazo「超過上限先拒絕，不先問」的行為）；非成員拒絕（AC-08.6，可抄 llmcord 的 `permissions.allowed_ids`） |
| AC-08.2 記憶沒有就說不知道 | 需改 | 寫進 system prompt | 由測試計畫驗證 |
| **US-09 通知** | **需自寫**（膠水） | Discord bot 發 DM 或在頻道 @人（zebbern 的 `USER_ID` mention 寫法）；整理成摘要的規則抄 Rakazo「Group updates into a periodic digest」 | **事件來源**：Hub 保存成功後才發通知（AC-09.4），需要 Agent Mail 或 Hub 提供事件（**待確認**，F-01）；失敗重送（Q-06） |
| **US-10 建任務** | **可抄**（行為）＋**需改**（程式） | 行為抄 cline/gitbot：結構化表單（Discord modal）、GitHub App 驗證、記錄 Discord 使用者；程式可參考 StephanAkkerman（MIT）或 Effect-TS issueify（MIT） | 標題必填（AC-10.2）；失敗不得回報成功（AC-10.3）；modal 取消＝不建（AC-10.4，modal 本身就有取消）；中央 bot token 代發並標註 Discord 使用者（F-02 建議） |
| **US-11 決策確認按鈕** | **需改** | 按鈕 UI 抄 disclaw／zebbern（MIT）；權限與時效抄 OpenClaw：按鈕 `allowedUsers`、不符者收到 ephemeral 拒絕、callback TTL | 草稿要**先寫入 Hub** 再發按鈕（AC-11.1）；按下後狀態寫回 Hub（AC-11.2、11.3），Discord 訊息本身不算紀錄；誰能確認（Q-03）；bot 重啟後按鈕仍可用（需持久化，OpenClaw 文件也提到持久化） |
| **US-12 `/connect`** | **需自寫** | 回覆方式抄 F-02：**ephemeral reply**；規則抄 OpenClaw pairing（短碼、限時、等待中請求有上限）和 Rakazo link code（10 分鐘內有效、可 Unlink） | 發「一行設定」＋每份裝置一個 token；撤銷（AC-12.4）要和 F-04 的反向代理驗證層串接；撤銷後重新發（AC-12.5）。查無現成專案 |

**判定統計**：可抄 1（US-10 的行為）、需改 2（US-08、US-11）、需自寫 2（US-09 的事件膠水、US-12）。

---

## 3. 可以照抄的行為規則（給 SRS 用，不是程式碼）

括號內是建議對應的 PRD AC。標「**建議改**」的是原專案的預設值和我們 PRD 衝突的地方。

### 3A. OpenMausBot：permission broker

來源：[docs/approval-levels.md](https://github.com/milind-soni/OpenMausBot/blob/main/docs/approval-levels.md)、[approvals-and-inspector.mdx](https://github.com/milind-soni/OpenMausBot/blob/main/apps/docs/content/docs/features/approvals-and-inspector.mdx)、[permissions-and-secrets.mdx](https://github.com/milind-soni/OpenMausBot/blob/main/apps/docs/content/docs/security/permissions-and-secrets.mdx)、`server/drivers/claude.ts`（`createPermissionBroker`）、[duplicate ask id 修正計畫](https://github.com/milind-soni/OpenMausBot/blob/main/docs/plans/2026-08-18-001-fix-permission-broker-ask-id-collision-plan.md)。

| # | 規則 | 對應 |
|---|---|---|
| OMB-1 | 核准請求顯示成卡片，**附在原本的任務／對話上**，列出要做的動作和範圍；不能藏在終端機輸出裡。 | AC-06.1 |
| OMB-2 | **拒絕不會讓整件事失敗**，而是把控制權交還 agent，讓它改走更安全的路。 | AC-06.3 |
| OMB-3 | **核准請求逾時就自動拒絕**（原始碼預設 15 分鐘），並告訴 agent「沒人回應，跳過這個動作，完成其他能做的」。**單純問題不設逾時**。 | AC-06.4、AC-05.4、Q-02 |
| OMB-4 | 回合／session 結束時，**關閉所有還沒回應的請求**，舊的核准不能在結束後才被按下。 | AC-06.5、AC-04.3 |
| OMB-5 | 遇到**重複的請求 ID**：拒絕後來那一筆、保留原本那一筆，並記錄診斷訊息（fail-closed）。 | AC-02.4（不重複） |
| OMB-6 | 「Always allow」範圍很窄：綁在一筆特定的請求上，不是給某台裝置任意執行的權限。 | US-07（auto mode 要綁定對象） |
| OMB-7 | 執行中改變權限等級：**下一個請求起生效**；已顯示的請求仍等人回應；已在執行的動作會跑完。 | AC-07.5（提前關 auto mode） |
| OMB-8 | bot 自己改設定時，對話裡出現一行說明，附「Details」和「Undo」。 | AC-07.2（auto mode 執行要留紀錄） |
| OMB-9 | **金鑰絕不在聊天中傳**，改用安全卡片；回應中會遮蔽金鑰。 | AC-01.3、AC-12.1 |
| OMB-10 | **建議改**：OMB 預設是 Full access（不問直接做）。我們預設必須是「問答自動、動手要確認」（決策 #3）。 | US-06 |

### 3B. Rakazo：群組 @bot 互動

來源：[docs/groups.md](https://github.com/elie222/rakazo/blob/main/docs/groups.md)、[docs/approvals.md](https://github.com/elie222/rakazo/blob/main/docs/approvals.md)、[docs/messaging-apps.md](https://github.com/elie222/rakazo/blob/main/docs/messaging-apps.md)。

| # | 規則 | 對應 |
|---|---|---|
| RKZ-1 | 群組裡**沒有 @ 時由預設 bot 回答**；`@名字` 叫醒那個 bot；`@everyone` 叫醒全部。 | US-08（頻道裡誰回答） |
| RKZ-2 | bot 和 bot 之間的對話，在聊天中顯示「Messaged／Message from ＜名稱＞」，點開可以看，**但只能看不能改**。 | US-01、US-05（Discord 上可以看到 agent 之間的往來） |
| RKZ-3 | 核准卡片有三個選項：**Allow once／Always allow／Deny**；**卡片不擋住聊天**，可以晚點再回；bot 在等人時會發通知。 | AC-06.1、AC-09.3 |
| RKZ-4 | 有些動作就算設了 Always allow **也一定要問**（例：改 bot 的指令或模型）。 | AC-07.6（只有收件人能開 auto mode） |
| RKZ-5 | 綁定聊天 App：畫面顯示一組碼，**10 分鐘內**從那個 App 傳出去；可以 **Unlink**。 | US-12 |
| RKZ-6 | 在共用頻道裡，bot **只對綁定的本人**使用私人記憶，對其他人用一般群組模式回答。 | AC-08.6、〔S3〕AC-14.3 |
| RKZ-7 | 頻道可以設定 **Listen all** 或 **Mentions only**；對自動發訊者（其他 bot、整合）可選 **Ignore／Group updates（摘要）／Always act／Treat like a person**。 | US-09（agent 事件整理成摘要，避免洗版） |
| RKZ-8 | 外來內容、不是本人啟動的執行（webhook、聊天 App 訊息），**寫入記憶前要問**。 | US-11（決策先草稿、要確認） |
| RKZ-9 | **花費上限**：超過時直接拒絕，不先問人，並告知原因；上限只有帳號本人能改。 | AC-08.5 |
| RKZ-10 | 群組邀請可以回 **YES／NO** 核准，**一天內有效**。 | US-11（確認時效，Q-03） |

### 3C. OpenClaw：Discord 存取控制（補充，F-04 未列）

來源：[docs/channels/pairing.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/pairing.md)、[discord/access-control.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/discord/access-control.md)、[discord/rich-messages.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/discord/rich-messages.md)。

| # | 規則 | 對應 |
|---|---|---|
| OC-1 | DM 預設是 **pairing**：陌生人會收到一組碼，**在核准前不處理他的訊息**。 | AC-08.6、AC-12.3 |
| OC-2 | 配對碼 8 碼、全大寫、不含容易混淆的字（0O1I）、**1 小時後過期**；每個帳號最多 **3 筆**等待中的請求。 | US-12（若 `/connect` 採兩段式，待 SRS） |
| OC-3 | 核准只開放 DM，**不會順便開放群組權限**；駁回不是永久封鎖。 | 〔S2〕成員名單 |
| OC-4 | 按鈕可以設 `allowedUsers`，**其他人按下會收到 ephemeral 拒絕**。 | AC-11.5、AC-07.6 |
| OC-5 | 按鈕**預設只能用一次**；callback 預設 **30 分鐘**到期、上限 24 小時；「選能用的最短 TTL」。 | US-11、AC-06.4 |
| OC-6 | slash 指令的互動回覆是 **ephemeral**，**只有下指令的人能操作**。 | AC-12.1 |

---

## 4. 建議組合（待 G1 與 SAD 決定）

| 功能 | 建議 | 自寫範圍 |
|---|---|---|
| 查進度 | fork js-llmcord，只掛唯讀 MCP 工具 | 費用上限、只允許唯讀工具的白名單、回答附依據的 prompt |
| 通知 | 同一個 bot 程序 | 訂閱 Hub 或 Agent Mail 的事件 → 發 DM 或摘要 |
| 建任務 | slash＋modal → GitHub App | 約一個指令的程式量 |
| 決策確認 | 按鈕（規則照 OC-4、OC-5） | 寫回 Hub、bot 重啟後還原按鈕 |
| `/connect` | ephemeral 回覆 | 發 token、撤銷 token，並和代理層串接 |

> 是否把五個功能放在**同一個 bot 程序**、要用 TS（js-llmcord）還是 Python（llmcord／Vercade）屬於技術選擇，留給 SAD（T7）。這兩項不需要 維護者 做產品決策。

## 5. 未解決／待確認

| ID | 事項 | 為什麼未定 | 誰來確認 |
|---|---|---|---|
| V6-1 | Agent Mail（Rust）能否把「新訊息」事件推給外部 bot | 只看到測試 fixture，沒讀到 API | F-01 實測（codex-senior-swe） |
| V6-2 | js-llmcord 遠端 MCP 的驗證方式（能否帶 Bearer header） | 只讀過 README | 實測 spike |
| V6-3 | js-llmcord 是否有費用上限機制 | README 沒寫 | 讀原始碼或實測 |
| V6-4 | Effect-TS `/issueify` 的實際流程 | 官方文件頁回 410，只看過搜尋摘要 | 讀 `Issueifier.ts` |
| V6-5 | mcp_agent_mail_rust 的實際授權條款（GitHub 顯示 NOASSERTION） | 沒讀 LICENSE 檔 | F-01 |
| V6-6 | OpenClaw 能否當作 MCP client 連我們的 Hub | 沒讀到相關文件 | 有需要才查 |
| P-1 | 查進度要在**公開頻道**回答，還是 ephemeral／DM | 牽涉組員能看到什麼，屬於產品決策；S1 只有 維護者，影響小 | 維護者，S2 前（本次不阻塞，不 ask） |
| P-2 | auto mode 與動手確認的逾時要不要沿用 OMB 的 15 分鐘或 OC 的 30 分鐘 | 對應 PRD Q-01、Q-02 | 維護者，G1 |

## 來源（全部查詢於 2026-11-16）

- GitHub repo 資料：`gh api repos/<owner>/<repo>`、`gh api repos/<owner>/<repo>/commits?per_page=1`（上表中的所有 repo）
- https://github.com/stanley2058/js-llmcord ・ https://github.com/jakobdylanc/llmcord ・ https://github.com/lintyourcode/vercade
- https://github.com/zebbern/claude-code-discord ・ https://github.com/chadingTV/claudecode-discord ・ https://github.com/six-ddc/disclaw ・ https://github.com/fredchu/discord-claude-code-bot ・ https://github.com/raylin01/DisCode
- https://github.com/Effect-TS/discord-bot ・ https://www.mintlify.com/Effect-TS/discord-bot/commands/issueify（回 410）・ https://github.com/StephanAkkerman/github-issue-bot ・ https://github.com/cline/gitbot ・ https://github.com/theCapypara/IssueBot
- https://github.com/Dicklesworthstone/mcp_agent_mail_rust ・ https://github.com/Dicklesworthstone/mcp_agent_mail ・ https://github.com/vectorize-io/hindsight ・ https://github.com/SaseQ/discord-mcp ・ https://github.com/alii/neuron
- https://github.com/elie222/rakazo（docs/groups.md、approvals.md、messaging-apps.md）
- https://github.com/milind-soni/OpenMausBot（docs/approval-levels.md、apps/docs/.../approvals-and-inspector.mdx、permissions-and-secrets.mdx、server/drivers/claude.ts、docs/plans/2026-08-18-001-...md）
- https://github.com/openclaw/openclaw（docs/channels/pairing.md、discord/access-control.md、discord/rich-messages.md）
- 上游：`docs/research/F-04-oss-landscape.md`、`docs/research/F-02-github-discord.md`、`docs/02-prd.md`
