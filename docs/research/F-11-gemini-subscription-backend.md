# F-11：VPS 訂閱 LLM 後端與共用 gateway

查證日期：**2026-11-17（Asia/Taipei）**。分支 `example-org/codex-F11`，由 `101363c`（起始時本機 master 最新）開始，交付前再 merge `d1746d6`（含 L-09 新部署程式）；沒有 push、改 master、SSH、帳號登入或 Chrome 操作。範圍含 PM 後續要求的 Antigravity CLI、AI Studio 免費 API 與付費 Flash-Lite 比較。

## 結論先看

1. **原方案目前有官方停用阻礙**：Google 的 [consumer accounts 停用公告](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)（頁面更新 2026-10-09）寫明 **2026-06-18 起**，個人免費版、Google AI Pro／Ultra 不能再以 Login with Google 使用 Gemini CLI；[Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)（2026-05-19）交叉確認同一時程。CLI 的認證、Plans、quota 頁仍列舊方案，是官方資料互相矛盾，**不能據舊表保證 維護者 訂閱現在可用**。本次沒有登入來驗證特定帳號例外。
2. **Antigravity 是官方遷移方向，但不等於可拿個人訂閱供多人 bot 使用**：它支援 SSH OAuth、headless；[附加條款第 6 點](https://antigravity.google/terms)限制透過第三方軟體／工具／服務存取，並列停權風險。用 gateway 包裝官方執行檔與直接重用 OAuth token 的技術不同，然而前者也沒有多人後端的明確授權；不能藉此宣稱符合條款。需 維護者 決定是否向 Google 確認此具體用途，或選 API。
3. **API 是文件明確針對自建應用的路徑**；免費 API 的資料使用政策不適合未經處理的組員交接／記憶。付費 `gemini-3.1-flash-lite` 的文字輸入／輸出單價分別為 **US$0.25／1.50 per 1M tokens**，下方列可重算估算，沒有替 維護者 選方案。
4. 已提供 `ops/llm-gateway/`：設定選 `gemini-cli`、`antigravity-cli`、`gemini-api-free`、`gemini-api-paid`；**預設 `disabled`，沒有自動換 provider、轉付費或消耗 AI credits**。bot／Hindsight／EVAL 的正式設定只連 gateway。fake CLI／fake HTTP 通過是工程證據，不是訂閱可用、條款核准或模型品質的證據。

## 官方來源的適用範圍

下列連結均於 2026-11-17 查閱；來源的事件日期與頁面更新日期另註，不把今天查到的舊數字當今天仍有效。

| 來源 | 用途與限制 |
| --- | --- |
| [Gemini CLI stable v0.68.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0)、[npm official package](https://www.npmjs.com/package/@google/gemini-cli) | GitHub latest 與 npm latest 均為 0.68.0；發布於 2026-11-10T21:17:07Z；不是本機已安裝版本 |
| [CLI installation](https://geminicli.com/docs/get-started/installation/)、[authentication](https://geminicli.com/docs/get-started/authentication/) | 安裝、Google OAuth 與 cached headless 工作流程；consumer eligibility 另受停用公告限制 |
| [CLI quotas](https://geminicli.com/docs/resources/quota-and-pricing/)、[舊 GitHub Pages quota](https://google-gemini.github.io/gemini-cli/docs/quota-and-pricing.html)、[Cloud quotas](https://docs.cloud.google.com/gemini/docs/quotas) | quota 與一個 prompt 可引發多個 model requests；舊表不能當個人訂閱現行權益 |
| [CLI terms](https://geminicli.com/docs/resources/tos-privacy/)、[Code Assist terms 索引](https://developers.google.com/gemini-code-assist/resources/privacy-notices)、[Google Terms](https://policies.google.com/terms)、[Google One terms](https://one.google.com/terms-of-service) | 軟體 Apache 2.0 不等於後端服務授權；Google One 條款更新 2026-10-01；不要把其 AI credits 規則套成全部訂閱 quota 規則 |
| [Antigravity authentication](https://antigravity.google/docs/install)、[headless](https://antigravity.google/docs/cli/headless)、[reference](https://antigravity.google/docs/cli/reference)、[plans](https://antigravity.google/docs/plans)、[terms](https://antigravity.google/terms) | 遷移方案的 SSH 登入、非互動格式、quota 與第三方存取限制 |
| [Gemini API terms](https://ai.google.dev/gemini-api/terms)、[Google APIs terms](https://developers.google.com/terms)、[API quotas](https://ai.google.dev/gemini-api/docs/rate-limits)、[pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite) | 免費／付費自建應用、資料使用、限制及月費估算；API terms 生效日 2026-03-23 |

## Gemini CLI：可查證的機制與已停用的訂閱權益

### 安裝與 headless 登入

官方 npm 安裝：`npm install -g @google/gemini-cli@0.68.0`；本次固定版本於 Dockerfile，不使用執行時 `npx latest`。官方支援 Node.js 20+，本專案 image 使用固定 digest Node 22。

官方 headless 會沿用已快取的認證；沒有快取時不能靠 `gemini -p` 完成首次 OAuth。從 [v0.68.0 oauth2.ts](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/code_assist/oauth2.ts) 可確認：互動終端設定 `NO_BROWSER=true` 時，CLI 印 URL，使用者在自己的瀏覽器授權後，把 authorization code 貼回終端；採 PKCE、offline access，回碼等待約 5 分鐘。**不是 RFC 8628 device-code polling**，也不能讓無 TTY 的服務自行完成登入。

VPS 若日後有合格帳號，預期由 維護者 在專用容器內執行一次互動 `NO_BROWSER=true gemini`，之後服務以 `gemini --model <model> --output-format json -p <固定指示>`、stdin 傳送內容。**此流程描述不推翻個人訂閱已停用的公告，現在不應照做並期待 Pro 成功。**

### 憑證位置、有效期與 refresh

預設 Google OAuth 檔為 `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json`，見 [storage.ts](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/config/storage.ts)。保存 access／refresh token、expiry_date；[oauth2.ts](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/code_assist/oauth2.ts)以 mode 0600 的暫存檔及 rename 更新。access token 使用憑證中的到期時間；不可把固定一小時或 refresh 永久有效當保證。CLI 的 Google auth library 會取／更新 access token，token 事件回存；撤銷、長時間未使用、帳號或管理政策變更仍可能要求重新登入，見 [Google OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration)。

0.68.0 另有 opt-in `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`：經 OS keyring，必要時落到 `.gemini/gemini-credentials.json`，見 [OAuthCredentialStorage](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/code_assist/oauth-credential-storage.ts)、[FileKeychain](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/services/fileKeychain.ts)。檔案加密 key 與 hostname／OS username 有關，不能假設把檔案複製到另一容器即可解密。本 adapter 明確使用官方預設 OAuth 檔（0600），關閉此 opt-in；不匯出／解析 token，不呼叫 Code Assist 的內部 HTTP 端點。

### 配額與模型：不要混用產品

| 認證／方案 | 文件曾列 RPD | RPM 的可確認程度 | 目前判讀 |
| --- | ---: | --- | --- |
| CLI 個人免費 Google OAuth | 1,000 | 舊 GitHub Pages 列 60 | consumer CLI 已停用；不是可配置的可用免費後端 |
| CLI Google AI Pro | 1,500 | 現行 CLI quota 頁未列固定數字 | consumer CLI 已停用；不可宣稱仍有 1,500 |
| CLI Google AI Ultra | 2,000 | 現行 CLI quota 頁未列固定數字 | 同上 |
| Code Assist Standard／Enterprise | 1,500／2,000 | 舊表列 120，但 Cloud 現行頁只說 per-minute 限制及容量可變 | 這是企業授權；不能套用到 維護者 個人 Pro，且有另行停用時程 |

CLI 與 IDE agent mode 配額共用，跨模型累計；一次 CLI 呼叫可能有多次 model requests／重試／路由。**本地 gateway 的 500 次／台北日是本專案設定，不是 Google quota，更不保證供應商的日界是台北。**

[0.68.0 models.ts](https://github.com/google-gemini/gemini-cli/blob/v0.68.0/packages/core/src/config/models.ts)含 `gemini-2.5-pro`、`gemini-3.1-pro-preview`，Flash base 為 `gemini-3.5-flash`、experiment-gated latest 為 `gemini-3.8-flash`；網站部分 model 頁仍列 2.5／3 preview，屬版本差異。原始碼常數表示 CLI 認識的模型，不證明某帳號 entitlement。需要在合格帳號完成登入後由 維護者 查模型清單，gateway 設定只允許一個 upstream model，不讓成員隨意換模型。

### 非互動、安全與品質

[Headless reference](https://geminicli.com/docs/cli/headless/)定義 `-p`、`--output-format json`，JSON 包含 `response`／`stats`／可選 `error`，另有 stream-json；一般錯誤 exit 1，輸入錯誤 42，turn limit 53。adapter 採非串流 JSON，stdout 上限 8 MiB、stderr 僅內部分類，上游內容不回傳到錯誤 log。逾時預設 90 秒會 kill process group；**gateway 不重試**。CLI 內部可能重試，無法靠殺 process 保證 Google 沒計次。

執行 cwd 每次用全新暫存目錄，原文走 stdin、不入 argv；不載專案 GEMINI.md。專用設定禁 MCP／extensions／skills／hooks、core tools 空集合，另用 [admin deny-all policy](https://geminicli.com/docs/reference/policy-engine/)排除全部 native tools；沒有使用 yolo 或改任何現存 agent 的權限。

**繁中品質／延遲未實測**：fake 回傳繁中只驗證 UTF-8 與協定，不是模型能力。建議真正驗收包含 30 則 EVAL 分類、既有 1,500 字繁中交接 retain／recall、10 組工具取證問答，分別記錄錯誤率、簡體字、來源 ID、冷啟動／暖呼叫 p50／p95 與逾時率。不得從官方範例的秒數外推 VPS SLA。

## 條款判讀：哪些能確認、哪些不能

[Gemini CLI terms](https://geminicli.com/docs/resources/tos-privacy/)明示，第三方直接存取 CLI 背後服務（例如重用 CLI OAuth）違反政策，可能停權；Apache 2.0 只涵蓋 CLI 軟體。Code Assist 個人版條款索引／privacy 舊連結會導向 consumer 停用頁，也不能當在此日期仍接受個人訂閱的證據。

我們沒有重用 token 或仿冒官方 client。**推論與未決處**：多人 Discord bot／記憶後端是自建服務；即使只 spawn 官方 binary，不能從 headless 自動化文件推出個人訂閱已允許共用服務、轉售或多人代用。Google Terms、Google One benefits 條款及實際帳號接受版本須併讀。此報告不代替 維護者 作契約決定，也沒有取得 Google 的例外授權。

## PM 追加選項一：Antigravity CLI + Pro／Ultra

### 能力、安裝與 headless

[Quickstart](https://antigravity.google/docs/getting-started)提供 Linux／macOS 的官方安裝腳本 `https://antigravity.google/cli/install.sh`，CLI 指令 `agy`。本次沒有執行安裝腳本；部署應由 維護者 先檢視腳本、取得固定版本 binary，記錄版本及 SHA256。本專案 Alpine image 能否執行該 Linux binary（含 glibc 相容性）與 Linux keyring／token fallback **尚未驗證**，需要時改成經驗證的 Debian image，不能把 fake 測試當 Linux binary 驗收。

[Authenticate](https://antigravity.google/docs/install)寫明 Google OAuth 可用個人帳號，CLI／app／SDK 共用認證；SSH 會列 URL，由 維護者 在自己電腦瀏覽器授權後貼 code 回 VPS。之後 cached credentials 可供非互動呼叫。官方未在已讀文件保證無 D-Bus／keyring 的容器如何永久保存 token、refresh 的固定 TTL 或可攜格式；不要猜檔名、複製 Mac keyring，也不要以 SDK 自行重用其 token。

[Headless](https://antigravity.google/docs/cli/headless)支援 `agy -p ... --output-format json`、`--print-timeout`、`--json-schema`，亦可 `--input-format stream-json --output-format stream-json` 從 stdin 輸入 user event，EOF 結束。JSON 成功須 `status=SUCCESS`；error／WAITING／permission soft-denied 都不能算模型完成。adapter 使用一次 user event、只接受一個成功 result，不 resume session，不跨組重用 conversation；偵測 native tool／subagent 事件就拒絕。

專用帳號的 `.gemini/antigravity-cli/settings.json` 要套 `ops/llm-gateway/antigravity-settings.json`：strict + 各 action namespace deny-all、`useG1Credits=false`，不使用 skip-permissions。adapter 啟動前檢查這份專用設定，拒絕含 hooks／MCP／plugins 的 profile；**不讀寫 維護者 目前任何 agent 的全域設定**。預設不自動消耗 overage credits；以官方 `/config` 再核對實際版本。

### 配額、隱私與多人後端

[Plans](https://antigravity.google/docs/plans)與 [pricing](https://antigravity.google/pricing)列 Pro／Ultra 的 5 小時補充 quota 和週上限，免費版按週；耗用與工作量、模型及可用容量有關，**沒有可用的固定 RPM／RPD 數字**。用 `/usage`／帳號 Settings 查看。訂閱已由 維護者 付款不代表此服務沒有機會成本。

[Antigravity 附加條款](https://antigravity.google/terms)第 6 點對第三方軟體／工具／服務存取列明限制及停權後果；**比「沒找到禁止」強得多，供多人 bot 的方案有重大不允許風險**，不應自動部署。第 5 點還載 Interactions 可能改善模型並由員工／承包商閱覽，可調 telemetry 偏好；即使關閉也仍為服務與安全處理資料。Pro 不是自動等同企業資料保護。是否向 Google 取得此 gateway 用途確認、改用官方 SDK 的允許情境，或完全採 API，交 維護者 決策；本次不把 Antigravity 當已核准替代。

## PM 追加選項二：AI Studio／Gemini Developer API 免費層

用自己 Google Cloud project 的 API key，直接呼叫 [官方 generateContent](https://ai.google.dev/api/generate-content)，不需要互動 OAuth、不讀 CLI token，也不消耗 Google AI Pro 的 CLI quota。API key 是否免費／付費由 **Google project 的 billing 狀態**決定；把設定名選成 `gemini-api-free` 不會讓已連 billing 的 key 強制免費。免費選項應使用未啟用付費的專案，不自動連結信用卡。

### 配額

[Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)以 RPM／TPM／RPD 管控，按 project 而不是按 key，RPD 在 Pacific 午夜重置。**現行官方頁要求登入 AI Studio 看 active limits，沒有給此帳號的 Flash-Lite 固定免費 RPM／TPM／RPD 表**；沒有登入所以不能填 15 RPM／1,000 RPD 等歷史數字。價格頁列 `gemini-3.1-flash-lite` 有免費 input／output，不代表每個新專案立即得到相同容量；需 維護者 在 [AI Studio rate limits](https://aistudio.google.com/rate-limit?timeRange=last-28-days)確認模型、三種上限與可用地區。gateway 的 500／台北日不覆蓋 Google 的 TPM 或 Pacific 日界。

### 隱私、商用／多人

[API additional terms](https://ai.google.dev/gemini-api/terms#unpaid-services)明載 unpaid 輸入及產出會用於改善產品／服務／機器學習，人工 reviewer 也可能閱覽；禁止提交敏感、機密或個人資訊。對台灣專案不可假設歐洲等地的例外適用。**未經去識別的個人、Discord 成員、交接內容與記憶原文，不應直接送免費層**；需要成員知情及資料範圍決策，不能只靠 prompt 承諾保密。

同一 [API terms](https://ai.google.dev/gemini-api/terms#use-restrictions)針對開發專業／商業用途的 API clients，並沒有把免費 API 限成單人非商用；因此可作自建多人應用的候選，仍須符合 API Terms、適用地區、使用限制／禁止用途、年齡（18+，不得做可能供未成年人存取的 client）及個資規範。EEA／瑞士／英國 client 另只允許 Paid Services。這是與個人 coding 訂閱不同的授權路徑，不等於所有 bot 都無條件可商用。

## PM 追加選項三：付費 Gemini 3.1 Flash-Lite API

[Standard pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)（文字，查證日 2026-11-17）：input **US$0.25／1M**、output（含 thinking）**US$1.50／1M**。本估算不用 batch／cache／搜尋或媒體，不含 VPS、稅與原有訂閱。

公式：`月費 USD = 月請求數 × (平均 input tokens × 0.25 + 平均 output+thinking tokens × 1.50) / 1,000,000`。

| 明示假設（不是測量） | 月請求數（30 天） | token 假設／次（input / billed output） | 月費 USD |
| --- | ---: | ---: | ---: |
| S2 7 人，各每天 10 個 backend calls | 2,100 | 3,000 / 500 | **3.15** |
| S2 7 人，各每天 10 個較長 retain calls | 2,100 | 10,000 / 1,500 | **9.98** |
| 整班 35 人，同上短呼叫 | 10,500 | 3,000 / 500 | **15.75** |
| gateway 預設每天 500 次全用完 | 15,000 | 3,000 / 500 | **22.50** |

一次 `/status` 可能跑 2～5 次模型迴圈，retain 另有 extraction／consolidation 等；不能把一次 Discord 指令當一次 backend call。thinking 多、schema 重試或長 context 會增加費用；上表不是 500 次的最壞金額保證。**F-11 改為請求數上限，已取消舊 0.50 USD/day 的保證**；若選付費要由 維護者 決定 Google project 的 billing spend cap 與新的 request limit，後續可另加 token／USD 硬上限。

[Paid Services 資料條款](https://ai.google.dev/gemini-api/terms#paid-services)表示 prompt／response 不用於改善產品或模型，但仍有安全偵測、法規與短期 logging 等處理，不能宣稱零保存；仍須核對 account、project、billing 與適用條款。

## 工程變更、介面與限制

影響範圍：`ops/llm-gateway`（新增）、L-02 service wiring、bot `/status` 與 owner 通知、EVAL provider、memory Compose／本機測試 overlay、備份 request ledger。風險高，原因是跨共用 LLM 介面與認證／用量邊界；不更動 member auth、Mail 協定、DB schema 或正式索引原文。先保留 L-02 ledger 原子預留／fsync／rename／crash 保守補記的實作，再用 request 單位 wrapper；原成本模組僅留作歷史回歸測試，正式 bank-proxy 不再啟動 Anthropic listener。

實作順序與驗證：先完成 backend／request budget／queue，再加 JSON／buffered SSE shim 與 bot／EVAL wiring，最後 Compose／部署指引與回歸。基線 L-02＋EVAL 36/36；bot 初次因未安裝依賴而失敗，`npm ci --prefix bot` 後基線 64/64。改後實際命令／結果見本文末段及 [F-11-validation.txt](F-11-validation.txt)。

```text
Discord /status ─ Messages client ─┐
Hindsight 1.2.1 ─ OpenAI client ───┼─ private gateway :8790 ─ one FIFO ─ one request ledger ─ configured backend
EVAL ─────────── Messages client ─┘                          (one active)       (Taipei day)
```

* 保留 `POST /v1/messages`（`x-api-key` 或 bearer）給 bot／EVAL，新增 `POST /v1/chat/completions` 給 Hindsight；`stream=true` 保留 SSE 介面，但完整生成後才輸出事件，不是逐 token 串流。每種 consumer 用不同內部 key，從檔案載入；不傳 provider key 到 bot／Hindsight。
* 支援 text、以 JSON envelope 模擬 function call、tool results 歷史、`json_object`／**非 strict** json_schema。僅允許宣告的工具名／object arguments，由呼叫者執行工具；gateway 不執行 Mail、shell 或 MCP。bot 原有 readonly registry、引文 ID 與群組邊界仍保留。
* 不是完整 Anthropic／OpenAI 實作：Responses API、strict schema／grammar enforcement 拒絕；SSE 為 buffered compatibility；多模態、cache、thinking／effort 控制未承諾。`max_tokens` 在 CLI 是 prompt 提示，在 API 是 `maxOutputTokens`。對照 [Hindsight v1.2.1 OpenAI-compatible provider](https://github.com/vectorize-io/hindsight/blob/v1.2.1/hindsight-api-slim/hindsight_api/engine/providers/openai_compatible_llm.py)，設定 openai provider、base_url `/v1`、strict schema=false，再由 Hindsight/Pydantic 驗證 extraction JSON；**真 Hindsight retain 整合尚未跑本後端**。
* 每個 backend launch／HTTP attempt 先 reserve 1，完成或不明失敗 charge 1；未執行的 queue 拒絕、缺執行檔、未設定 backend、專用 profile 不合規釋放。上限、耗盡、跨 consumer、跨日及 crash 都測試。CLI 內部 retries／額外模型請求不一定一對一，因此本地硬上限是 **backend invocations**，不是供應商 model requests 精確上限；API adapter 一次 invocation 一個 HTTP request，無自動 retry。
* 每個 gateway 只有一個 active，FIFO 最多 20 waiting、等待 30 秒；滿／過久回 503、日額滿回 429 `DAILY_LIMIT`，都不呼叫 backend；沒有偷偷改用付費／其他 provider。SDK／Hindsight 自己重試 HTTP 時視為新 request，同受閘門限制。
* `/healthz` 是 process liveness；`/readyz` 只有曾成功且目前沒報錯時 200，否則 503；認證的 `/status` 回 backend／queue／request totals，不含原文或 credential。ready 是最近觀測，沒有主動計費測試，也不是未來 credential 永不過期的保證。
* bot 每輪 tick 讀 status（不呼叫模型）；Hindsight 觸發 `AUTH_REQUIRED` 後也能由 bot 通知 owner。認證通知同一 process 故障期間一次、成功後可再通知；重啟可能再通知。日上限通知沿用 DB 的 group/day 去重；DB upsert 支援尚無成本 row 的新日，不再拿 USD ledger 管正式費用。
* EVAL 只允許 `fake` 或 `gemini-gateway`，舊 `anthropic-api`／`claude-cli` 明確拒絕；provider 錯誤另計且評測一律 fail，避免錯誤 fallback 被當成功。

## VPS 部署設計（尚未執行）

### 固定使用者與目錄

容器專用帳號 `gemini` uid/gid **10004**；維護者 先確認 VPS 無同 uid 衝突，必要時一致調 Dockerfile／Compose／host 擁有者。container 正規 home 為 `/home/gemini`；不要掛 維護者、root 或其他 agent 的 home／keyring。CLI binaries 是固定 image 的 0.68.0 或 維護者 放在 `/var/lib/neighbor-hub/agy-bin/agy` 的官方固定版本；API 不需要 CLI 認證。

| VPS host path | 容器 path / 讀寫者 | 權限與用途 |
| --- | --- | --- |
| `/var/lib/neighbor-hub/gemini` | `/home/gemini`；只給 gateway 10004，RW | 目錄 0700、認證／設定檔 0600；refresh 必須能寫，不能只 mount 單一 credential 檔或 ro |
| `.../gemini/.gemini/oauth_creds.json` | 同一路徑 | Gemini CLI 官方預設 token 檔；個人訂閱目前不可用，僅機制說明 |
| Antigravity OS keyring／token store | 專用使用者／同一容器環境 | 官方文件未保證檔案位置及純容器 fallback，先完成 Linux proof；只掛 `.gemini` 不足以聲稱保留 OS keyring |
| `/var/lib/neighbor-hub/llm-gateway` | `/state`；只給 gateway 10004，RW | 0700；`gemini-requests.json` 與 lock 0600；獨立於舊 USD ledger |
| `/var/lib/neighbor-hub/private/llm-gateway` | Compose secrets；gateway | 0700、key 檔 0600／owner 10004：`hindsight.key`、`bot.key`、`eval.key`，選 API 才加 `gemini-api.key` |
| Hindsight 既有 `.../hindsight/llm-gateway.key` | Hindsight uid1000，ro secret | 與新 `hindsight.key` **同值**，各自 owner，不用 provider key |
| bot 的 `.../bot/llm-gateway.key` | `/run/bot/llm-gateway.key`，bot owner，ro | 與新 `bot.key` 同值；刪去舊 Anthropic key 的需求 |

memory Compose 不發布 gateway host port；Hindsight 與 bot 加同一 internal `neighbor-hub-memory_llm-net`，gateway 另有 Google egress。bank-proxy 維持既有 member endpoint 與 DB 網路。先啟動 memory project 建立 llm-net，再啟動 bot。EVAL 建議在 gateway container 內用 eval secret 呼叫 loopback，不另外公開 port。

### 維護者 最少操作

先完成目錄擁有者／內部三把不同隨機 key 與 consumer 同值副本（不要把 key 放 shell argv、Git 或 log）；此處沒有生成正式 secret。預設先保留 `HUB_LLM_BACKEND=disabled`。

1. **Gemini CLI 原方案**：依停用公告，目前個人訂閱沒有可承諾的登入步驟。若 Google 日後確認合格 entitlement，才在停掉 gateway 後，用相同 image、uid、profile 互動執行 `NO_BROWSER=true GEMINI_CLI_HOME=/home/gemini gemini`，由 維護者 貼回 code，退出後再啟服務；不要讓 agent 代登入。
2. **Antigravity 訂閱候選**：先釐清條款第 6 點；由 維護者 從官方 Quickstart 取得固定 binary、確認 image 相容性與 `/usage`、用專用使用者的 SSH 終端執行 `agy` 完成 URL/code。Linux keyring／重建後可讀性驗證成功，且專用 profile 套上 `antigravity-settings.json` 後，才設定 `HUB_LLM_BACKEND=antigravity-cli`、`HUB_LLM_UPSTREAM_MODEL='Gemini 3.8 Flash'`；模型名稱依該 binary 的 `agy models` 確認。**此項仍未完成登入／可部署性驗收。**
3. **API 免費／付費候選**：維護者 選 Google project，從 AI Studio 建 key，以自己的安全編輯方式存 `gemini-api.key`（0600 owner10004）。選 `HUB_LLM_BACKEND=gemini-api-free` 或 `gemini-api-paid`，`HUB_LLM_UPSTREAM_MODEL=gemini-3.1-flash-lite`；合併 `deploy/memory/compose.gemini-api.yaml` 才會把 provider key 掛給 gateway。免費需核對 billing 未啟用與資料政策；付費需另設 project spend cap。程式不因 free 設定替 project 關閉 billing。

切換 backend 保持同一 state／daily request limit，不能藉重建或換 provider 歸零。啟動命令由 維護者 在自己的 VPS repo 內執行：

```sh
# CLI 候選省略第二個 -f；API 才加 provider-key overlay。
docker compose -p neighbor-hub-memory -f deploy/memory/compose.yaml \
  -f deploy/memory/compose.gemini-api.yaml up -d --build llm-gateway hindsight bank-proxy
```

### 過期通知、恢復與備份

cached auth 無效／invalid_grant 等 → gateway 回 503 `AUTH_REQUIRED`、status `auth_required`；bot tick 下一輪（預設 15 秒）通知 owner，`/status` 一般用戶只看到暫時不可用。背景 retain 保留既有 bridge pending／重試語意。Google quota 的 429 為 `UPSTREAM_QUOTA`，不冒稱是台北日額用盡；不自動消耗 credits，也不換 key。

bot 離線時沒有 Discord 通知保證：維護者 需監看 gateway `/readyz`、容器 liveness 及 bot log；不建另一條含 token 的外部通知路徑。重新登入／修正 key 由 維護者 執行，保持同一專用使用者；成功請求後 readiness 恢復。不要刪 request ledger 來「修認證」。

單 writer lock：正常關閉會清除 `gemini-requests.json.lock`；SIGKILL／host crash 可能留檔而 fail closed。此時 **先 stop gateway 並確認沒有同 state 的其他容器／process**，只移除 `.lock`，保留 ledger 後重新啟動；舊 open reservation 在 load 時補 charge。不要 scale replicas；`/status` 是唯讀，不另外開 ledger writer 查用量。

`HUB_HINDSIGHT_BACKUP=1` 時 `ops/backup` 額外備份 request ledger 及 SHA256；保留舊 ledger 相容性，不把 auth profile／OS keyring 複製進索引備份。還原 request ledger 要停 writer、restore 至相同 `/state` 並修正 10004/0600；同一天還原較舊快照會低估已用次數，需人工加回或等下一日才開放。OAuth profile 故障優先由 維護者 重登，不能認為加密 token 可跨機還原。

## 驗證狀態與交付界線

* 來源查證、provider 設定切換、fake Gemini／Antigravity executable、fake API、共用 request cap／FIFO／逾時／crash、shim／bot tool loop／EVAL 與認證通知均有本機證據。
* 正式帳號 entitlement、條款例外、VPS 登入／refresh／容器重建、Antigravity Linux binary／keyring、真實品質／延遲／Hindsight retain 均**未驗收**；沒有任何真 Google／Anthropic 生成請求。
* `docs/ops/runbook-L02-memory.md`、L-03、L02b 與 EVAL 舊文件中的 Anthropic／USD 部分為歷史紀錄，以本文件的正式 wiring 與限制為準。舊本機 Ollama 整合測試使用 **test-only** overlay，不讓 production env 繞過 gateway。
* 最終測試數、Compose 與 image build 結果在 [F-11-validation.txt](F-11-validation.txt)；未跑／skip 與失敗都分開列，不作訂閱可用證明。

最終驗證摘要（2026-11-17）：核心 gateway／L-02／EVAL **58 pass / 0 fail**（其中 F-11 22）；bot **65 pass / 0 fail**；memory bridge **16 pass / 0 fail**；真 Postgres **13 pass / 0 fail / 1 skip**（原生 Mail binary 缺少）。三種 Compose 與 test-only overlay 的 `config --quiet` 通過；gateway／bot／bank-proxy image 建置通過，image 內 `gemini --version` 為 **0.68.0**（沒有生成或登入）。

整合最新 master 的 L-09 後，已同步其 secrets／gateway 啟動與 API overlay 選擇：不要求 Anthropic key，gateway 內部 keys 10004/0600，預設 disabled，L09 只驗 gateway liveness；新增 L09 wiring／既有 bridge-backup 共 **4 項 Python 測試通過**，F-11 ledger backup 合併後再次 **1/1 通過**。L09 完整 nested Docker 演練尚未重跑，舊收據不延伸成 F-11 上線驗收。
