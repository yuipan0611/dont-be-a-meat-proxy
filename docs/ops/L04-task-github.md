# L-04：從 Discord 建 GitHub Issue（`/task`）

2026-11-17｜agy-junior-swe-2（Antigravity）｜狀態：**本機實作與 TC-19 測試通過，56/56 tests passing**。

依據：SRS SR-TASK-01～05、§4.5 #10、PRD AC-10.1～10.4、`docs/06-test-plan.md` TC-19、`docs/research/F-02-github-discord.md`、`docs/research/F-06-discord-bridge.md`。

---

## 0. 核心設計與規則實現

| 規則 | 實作方式 | 對應 |
|---|---|---|
| **任務唯一真相是 GitHub Issue** | 先呼叫 GitHub REST API 建立 Issue 拿到 Issue 編號，才建立 Hub 任務項目並向使用者回報成功；GitHub 失敗則不建 Hub 項目、不回報成功 | SR-TASK-01、AC-10.1、10.3 |
| **Hub 任務項目必帶 Issue URL** | 建立 Hub（Agent Mail）項目時，`kind: 'task'`、`intent: 'action'`、`links: [issue.url]`，內文帶有 Issue URL 與建立者資訊 | SR-TASK-02、AC-10.5 |
| **標題必填** | trim 後為空字串直接回報 `[E-TITLE] 標題必填`，不建立 Issue、不送出 Hub 項目、不顯示二次確認卡 | SR-TASK-03、AC-10.2 |
| **GitHub 失敗回報原因** | 連線失敗、401（Bad credentials）、404、403（rate limit）等一律以 `E-GITHUB` 回報具體失敗原因，不留下半筆紀錄 | SR-TASK-04、AC-10.3 |
| **二次確認（§4.5 #10）** | `/task` 指令先回覆 ephemeral 確認卡：「將建立任務：標題／repo／內容」，附帶「確認建立」與「取消」按鈕 | §4.5 #10、AC-10.4 |
| **僅發起人能按確認／取消** | 按鈕互動檢查點擊者的 Discord User ID，非發起人點擊時回覆暫態拒絕提示，不觸發動作；發起人按「取消」則更新為已取消，不建立 Issue | §4.5 #10、AC-10.4 |
| **防連點／冪等性** | 點擊確認或取消後立即從 pending 移除 actionId，後續重複點擊提示過期／不存在，防止重複建立 Issue | 安全性防線 |
| **官方 GitHub REST API** | 使用官方 REST 端點 `POST /repos/{owner}/{repo}/issues`，標頭含 `Authorization: Bearer <TOKEN>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28` | F-02 |
| **Token 讀取路徑** | 優先從 private 檔案（`GITHUB_TOKEN_FILE`）讀取，亦支援環境變數（`GITHUB_TOKEN`／`GITHUB_PAT`），支援非空校驗 | 安全規範 |

---

## 1. 程式檔案結構

| 檔案 | 職責 |
|---|---|
| `bot/src/github.mjs` | 官方 GitHub REST API adapter（`createGitHubClient`、`loadGitHubToken`、`GitHubError`） |
| `bot/src/task.mjs` | 任務建立服務（`createTaskService`、`stageTask`、`confirmTask`、`cancelTask`、按鈕元件生成與提示文字） |
| `bot/src/router.mjs` | 擴充 `/task` slash 指令與按鈕互動分流（`handleButton`） |
| `bot/src/discord.mjs` | `wireEvents` 擴充支援 `isButton()` 元件事件分發至 router |
| `bot/src/main.mjs` | 注入 `github` 與 `taskService` 設定與依賴 |
| `bot/test/task.test.mjs` | TC-19 驗收與各項負向測試、單元測試套件 |
| `bot/test/helpers/fakes.mjs` | 擴充 `createFakeGitHub`、`fakeButtonInteraction` 與 fake mail 的 `sendItem` |
| `deploy/bot/compose.bot.yaml` | 加入 `GITHUB_TOKEN_FILE` 與 `GITHUB_DEFAULT_REPO` 設定 |

---

## 2. 測試驗證（Test Output）

在 `bot/` 執行 `npm test`：
```
> test
> node --test test/*.test.mjs

✔ TC-16: /connect replies ephemerally with one config line; DB keeps only the hash
✔ SR-ID-05: every /connect issues a NEW token; older tokens stay valid
✔ TC-16 / AC-12.3: a non-member is refused and no token is created
✔ TC-16 / AC-12.4～12.5: revoke one device → revoked after 401 probe; others unaffected; /connect again gives a new token
✔ revoke: Caddy not confirmed or probe ≠ 401 → stays revocation_pending and is NOT reported as done
✔ connect: applier failure → no token shown, row fails closed to revocation_pending
✔ bad input: bad platform / malformed token id are rejected without side effects
✔ spool applier: writes 0600 request + credential atomically and reads the helper receipt
✔ mailToken reads HTTP_BEARER_TOKEN from mail-a.env or a bare token, rejects junk
✔ slash commands: exactly connect / revoke / status / task; no write-capable assistant command
✔ classify: handoff label, summary ≤200 code points, emoji intact
✔ classify: HubClock result → 「HubClock 通知：<狀態>」; other control records are not notified
✔ classify: replies, help/action labels; a summary that looks like a secret is hidden
✔ render: no full text, has type/sender/summary/how to view, Discord-only-notifies, mentions neutralised
✔ TC-18: Mac→Windows handoff produces one DM to the owner with type, sender, summary
✔ TC-18 negative (AC-09.4): a send the Hub never saved creates no notification
✔ history before the bot starts watching is not notified; same mail to two of my agents → one DM
✔ HubClock result reaching my agent is pushed with the HubClock label
✔ §4.5 #9: offline member gets no per-item DMs, then ONE digest when back
✔ §4.5 #9 + SR-NTF-04: a failed DM is not resent by itself; it joins one digest later
✔ unknown send outcome is recorded unknown and never resent
✔ bot was down: a backlog older than 10 min becomes one digest, not a replay
✔ Hub down: cursor stays, nothing lost; next tick picks the item up
✔ revoked device / unlinked member: its agent is no longer watched
✔ TC-17: answer cites the latest handoff ID and time; reply is ephemeral
✔ TC-17: recent_items marks decisions as drafts (AC-08.3)
✔ AC-08.2: an answer that cites nothing the tools returned becomes 記憶中沒有這項資訊
✔ get_item reads the original but only for this group; unknown tool → error result, not a crash
✔ SR-AST-01: a tool that is not read-only cannot be mounted
✔ TC-17 / AC-08.5: cap 0 → 今日額度已用完, the LLM is never called, owner notified once
✔ budget: reserve worst case before the call, settle to actual usage after
✔ budget: when the remaining cap cannot cover a worst-case call, refuse before calling
✔ budget: day boundary is Asia/Taipei 00:00 and a new day starts fresh
✔ budget: a 4xx before generation is not charged; a 5xx/timeout keeps the worst case charged
✔ AC-08.6 / FR-22: a non-member gets one fixed refusal, no LLM call, no content
✔ AC-08.7: public only when the asker explicitly chooses it
✔ refusal and step limit give a plain error, never a fabricated answer
✔ membership: active link + active member only
✔ device lifecycle: issue → request revocation (owner only, once) → revoked
✔ watched agents come from active devices of linked members
✔ ingest is idempotent per (member, mail) and the cursor only moves forward
✔ pending → sent only once; hold/backlog/digest; recent items newest-first and distinct
✔ budget: reserve within cap, refuse beyond, settle, notify once
✔ discord send errors: 4xx/429 = failed (not delivered); 5xx/timeout/network = unknown
✔ loadGitHubToken: reads from private file or env var, handles missing file
✔ createGitHubClient: official REST API headers and success response (201)
✔ createGitHubClient: rejects empty title with E-TITLE
✔ createGitHubClient: converts non-201 response and network error to E-GITHUB
✔ TC-19: create task with title "TC19 測試任務" -> confirm -> GitHub issue created, bot returns number & url, Hub task item saved
✔ TC-19 negative: empty or whitespace title -> prompt 標題必填, GitHub count unchanged, no Hub item
✔ TC-19 negative: GitHub token fails (401 Bad credentials) -> E-GITHUB with reason, not reported as success, no Hub item
✔ §4.5 #10: two-step confirmation cancellation -> click cancel -> cancelled, no Issue created, no Hub item
✔ §4.5 #10: only initiator can confirm or cancel; stranger is rejected, task remains pending
✔ double click protection: second click reports already handled / expired, no duplicate issue
✔ non-member cannot use /task: refused with NOT_MEMBER
✔ custom options: repo, body, assignee are preserved and forwarded
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
```
全部 56 項測試通過，0 項失敗。

---

## 3. 部署與設定指引

在 VPS 部署 Discord bot 時：
1. 將 GitHub Personal Access Token（PAT，具備 repo / issues 寫入權限）寫入 secret 檔案：
   ```sh
   echo "<TOKEN>" > /var/lib/neighbor-hub/private/bot/github.token
   chown $BOT_UID:$BOT_GID /var/lib/neighbor-hub/private/bot/github.token
   chmod 400 /var/lib/neighbor-hub/private/bot/github.token
   ```
2. 註冊 Discord Slash 指令：
   ```sh
   docker compose -f deploy/compose.yaml -f deploy/hubclock/compose.hubclock.yaml -f deploy/bot/compose.bot.yaml run --rm --no-deps bot register-commands
   ```
   輸出包含 `task`：
   `{"ev":"commands.registered","names":["connect","revoke","status","task"]}`
3. 重新啟動 bot 服務：
   ```sh
   docker compose -f deploy/compose.yaml -f deploy/hubclock/compose.hubclock.yaml -f deploy/bot/compose.bot.yaml up -d --build bot
   ```
