# F-01｜MCP Agent Mail 本機可行性實測

- 日期／查詢日期：2026-11-16（Asia/Taipei）。作者：codex-senior-swe；任務 T2。
- 狀態：研究完成、待 PM 審查與 G1／維護者 決策；不是採用或實作核准。
- 方法：依指導者 `skills/feasibility/SKILL.md` 的問題定義、決定性條件、隔離原型、證據判斷；已讀 PM 的 AGENTS、確認版 Brief、DAG 與專案流程總覽／模板說明。
- 範圍：只在本 worktree clone、venv、本機 HTTP 實測；沒有購買／連線 VPS、修改全域設定、修改上游程式、操作其他 worktree 或提交／推送專案變更。

## 結論與 G1 建議

**A-1 部分成立：HTTP MCP、多 agent、離線交接與重啟持久化實測成立；不能直接推出符合 Brief 的完整 Hub。建議 D-1 選「自寫精簡版」，由 維護者 在 G1 決定。** 若要保留 Agent Mail，應列為「改造＋補驗」，不能列為原樣採用。

主要理由：

1. Python 上游已明確停止維護、新安裝建議用 Rust；繼續承擔 Python fork 不利於 Brief 的一人維運限制。[Python README](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/README.md)
2. 有個別 agent token，但沒有現成 Discord 人身分綁定、每人 HTTP token 的管理／立即撤銷契約；JWT 有效性不等於 principal 與 agent／project 權限綁定。設定 audience 時另有實測拒絕有效 JWT 的相容性錯誤，見實驗 E6。
3. 多專案是資料分區，不能當 S3 多組安全隔離；共用 bearer 能建立其他專案與身分，web unified inbox 會回傳各專案訊息。JWT sub=A 也能看 B 的 web 訊息，見 E7。
4. 同步部分實際靠 client 主動讀取／輪詢；server 的 signal 是本機檔案，尚未讓異地 CLI 中正在工作的／idle 的 AI 自動醒來。Brief G-03 的問答自動處理、動手先確認、限時 auto mode 都不是已驗證功能。
5. 兩個版本實際 LICENSE 都是帶 OpenAI／Anthropic rider 的條款，不能只因 Python pyproject 寫 MIT 就按純 MIT 看待；採用前須由 PM／維護者 確認使用方式是否符合該原文，本文不作法律適用結論。[Python LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/LICENSE)、[Rust LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/LICENSE)

自寫的代價是必須自己負責儲存、授權、可靠讀取與測試；本 spike 沒有估算工期，也沒有證明自寫已完成或比較快。若 維護者 接受增加 Rust 驗證範圍與外層授權服務成本，改採 Rust＋薄閘道也可重評，但本任務只做 Rust 靜態比較。

## 成功條件、證據與限制

決定性條件取自 Brief：G-02 離線交接、G-03 同步、R-4 每人 token 可撤銷、S3 各組隔離，以及 S1 Mac↔Windows 的遠端連線。先測會推翻採用的認證／隔離，再看訊息與部署能力。

兩個身分 `BlueLake`（A，program=mac-simulation）與 `RedStone`（B，program=windows-simulation）使用兩個獨立 FastMCP client／MCP session，後端同一台 Mac 的 loopback server。**沒有實際 Windows、跨網際網路、TLS、Discord 或任一 IDE 的自動喚醒驗收。** 量測只有 n=5、小訊息、單機、無負載；不是容量數字、SLA、p95 或 VPS 延遲預測。

## 原始碼與執行環境

| 項目 | Python 實測版 | Rust 比較版（未編譯／未執行） |
|---|---|---|
| Repo | [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) |
| Clone | `spikes/agent-mail/` | `spikes/agent-mail-rust/` |
| HEAD SHA | `9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72` | `a58b6d77cd16fa4e235359ae91f1b28779780d05` |
| 最近 commit 日期 | `2026-11-01T12:36:14-05:00` | `2026-11-15T22:09:43-05:00` |
| 專案版本 | `0.3.4` | workspace `0.3.40`，不等於已驗證 release |
| 執行需求 | Python `>=3.12`；實際 uv 選 CPython `3.14.6` | Cargo 宣告 Rust `1.100`、edition 2024；toolchain `nightly-2026-08-31` |
| 授權原文 | MIT License **with OpenAI/Anthropic Rider**；pyproject 標 MIT 與原文不完全相同 | 同 rider；Cargo 標 `LicenseRef-MIT-Rider` |
| 維護現況 | README 明言 no longer maintained／superseded | 最近 commit 修 HTTP malformed request heads；README 提供 Docker release、TUI、web UI／robot CLI |

Rust 版 README 宣稱 45 tools、25 resources；這是文件描述，沒有本機工具列舉驗證。Rust SECURITY.md 明說預設模型是單一使用者／緊密互信的本機 operator，identity／project scope 不是不互信租戶間的 tenancy boundary；故換 Rust 本身不能當作 S3 已解決。[Rust SECURITY.md](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/SECURITY.md)、[Cargo.toml](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/Cargo.toml)、[toolchain](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/rust-toolchain.toml)。

Python 鎖定依賴實際安裝 125 packages，包含 FastMCP `2.13.0.2`、MCP SDK `1.25.0`、Authlib `1.5.2`、uvicorn `0.40.0`。未跑上游 install.sh，避免它安裝其他工具或改 AI 設定。LLM 設 `false`，沒有呼叫外部 LLM。

## 重現命令與資料位置

以下命令都從本 worktree 執行；clone 與安裝 exit=0：

```sh
git clone --depth 1 https://github.com/Dicklesworthstone/mcp_agent_mail.git spikes/agent-mail
git -C spikes/agent-mail log -1 --format='%H%n%cI%n%s'
git clone --depth 1 https://github.com/Dicklesworthstone/mcp_agent_mail_rust.git spikes/agent-mail-rust
git -C spikes/agent-mail-rust log -1 --format='%H%n%cI%n%s'
UV_CACHE_DIR="$PWD/spikes/.uv-cache" UV_PYTHON_INSTALL_DIR="$PWD/spikes/.python" \
  uv sync --project spikes/agent-mail --frozen --no-dev --python 3.14
spikes/agent-mail/.venv/bin/python spikes/run_spike.py > spikes/evidence/run.stdout 2>&1
spikes/agent-mail/.venv/bin/python spikes/run_supplement.py > spikes/evidence/supplement.stdout 2>&1
spikes/agent-mail/.venv/bin/python spikes/run_jwt_probe.py > spikes/evidence/jwt-no-audience.stdout 2>&1
```

三支量測程式的最終執行 exit 都為 0；失敗案例以 HTTP status／MCP isError 記錄，不因有拒絕案例把研究標失敗。它們實際用 `subprocess.Popen([venv_python, '-m', 'mcp_agent_mail.cli', 'serve-http'])` 啟動 server；選當下未占用 port，最後 SIGTERM 自己啟動的 PID。主流程 server 是 `127.0.0.1:60052`，重啟前後同 port／同 DB；最後程序 exit=-15（SIGTERM），log 有 application shutdown complete。補測各用另一個 loopback port。

主要環境變數（credential 全部是臨時隨機值，不入文件）：

```text
HTTP_HOST=127.0.0.1
HTTP_PORT=<動態 port>
HTTP_PATH=/api/                     # 使用上游預設
HTTP_BEARER_TOKEN=<redacted>
HTTP_ALLOW_LOCALHOST_UNAUTHENTICATED=false
HTTP_RBAC_DEFAULT_ROLE=writer
DATABASE_URL=sqlite+aiosqlite:///<worktree>/spikes/runtime/<run>/mail.sqlite3
STORAGE_ROOT=<worktree>/spikes/runtime/<run>/archive
LLM_ENABLED=false
TOOLS_LOG_ENABLED=false
LOG_RICH_ENABLED=false
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_SIGNALS_DIR=<worktree>/spikes/runtime/<run>/signals
LITELLM_LOCAL_MODEL_COST_MAP=true
HF_HUB_OFFLINE=1
MCP_AGENT_MAIL_OUTPUT_FORMAT=json
```

`writer` 是為測非 localhost bypass 條件下的寫工具；沒有停用 RBAC。上游 `HTTP_ALLOW_LOCALHOST_UNAUTHENTICATED` 預設 true，此次明確關閉，避免 localhost 被免驗而得到假陽性。JWT phase 另加 `HTTP_JWT_ENABLED=true`、臨時 secret、issuer；一輪有 audience、一輪無 audience。

主成功資料：`spikes/runtime/run-20261116-113519/`，SQLite 最終有 **11 messages／3 agents／2 projects**。archive 下有 canonical／sender outbox／recipient inbox Markdown，離線訊息 id=1，三份都存在。SQLite 與 archive 路徑分別設定，備份必須包含兩者；不能假設 DB 一定在 STORAGE_ROOT。

上游為 archive 自動建 Git 紀錄是被測儲存機制，沒有對外層專案或兩份 clone 執行 commit／push。runtime 含測試 registration token，已排除版本管理；只應交接遮蔽後 evidence。完整證據索引在文末。

## 實驗結果與指令／輸出摘要

### E1｜MCP 真連線與 CLI 呼叫：通過

實際以 `fastmcp.Client('http://127.0.0.1:<port>/mcp/', auth=<bearer>)` 建 session、initialize、list_tools／call_tool，列出 **41 tools**。包含 ensure_project、register_agent、send_message、fetch_inbox、reply_message、mark_message_read、acknowledge_message 等。A/B 是兩個 client instance；B 離線時已退出其 context manager。`/mcp/` 是會發 session ID 的 stateful alias，預設 `/api/` 是 stateless；本測試沒有把兩者混成同一身分 session。[HTTP 實作](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/src/mcp_agent_mail/http.py)

另實跑 CLI `curl -sS -i --config -`，透過 stdin 傳 header／POST JSON，避免 bearer 出現在 process argv。等價、已遮蔽的請求為：

```http
POST /api/
Authorization: Bearer <redacted>
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":"curl-1","method":"tools/call","params":{"name":"health_check","arguments":{}}}
```

curl exit=0，`HTTP/1.1 200 OK`，JSON-RPC result `status=ok`、`isError=false`。這符合任務允許的 curl JSON-RPC client；沒有修改 Claude／Codex 設定，也沒有宣稱那兩個 CLI 或五種 IDE 已驗收。

### E2｜非同步／持久化：通過

實際 `tools/call` 順序：

```text
ensure_project(human_key=<runtime>/team-one)
A: register_agent(project_key=..., name=BlueLake, program=mac-simulation, model=no-llm)
B: register_agent(project_key=..., name=RedStone, program=windows-simulation, model=no-llm)
B: set_contact_policy(project_key=..., agent_name=RedStone, policy=open)
B: 關閉 MCP session
A: send_message(sender_name=BlueLake, to=[RedStone], subject="F01 offline handoff",
                body_md="Persist this exact handoff: F01-ASYNC-20261116", thread_id=F01-spike)
停止 server → 相同 DB／archive 啟動新 server
B: 新 MCP session，fetch_inbox(agent_name=RedStone, registration_token=<B token>, include_bodies=true)
```

讀回 id=1、from=BlueLake、thread_id=F01-spike、完整原文且 read_at=null。代表不需 B 在線、server 重啟後仍在；只測正常停止／重啟，未測斷電、DB 損壞、磁碟滿或異地備援。B 的 `open` 是測通訊的明示設定，不是 Brief「動手先確認／auto mode」的實作。

### E3｜同步可見速度與通知機制：部分通過

B 在線，A 發送後 B 主動 fetch；五次 `F01-SYNC-0..4` 全部讀回。計時含 client 封裝及證據寫入。

| 方法／n=5 | 最小 | 中位數 | 最大 |
|---|---:|---:|---:|
| A 開始 send → B 立即 fetch 返回 | 62.726 ms | 65.276 ms | 78.654 ms |
| send 返回 → B 立即 fetch 返回 | 7.175 ms | 7.608 ms | 7.779 ms |
| B 先輪詢、每次空讀後 sleep 250 ms；A 開始 send → B 收到 | 194.632 ms | 198.144 ms | 200.782 ms |
| 同上，send 返回 → B 收到 | 122.073 ms | 128.273 ms | 134.826 ms |

輪詢實驗每輪先啟動 B，再等約 70 ms 才送；每次均第二次 poll 收到，因此不是隨機相位或廣泛延遲分布。實際輪詢程式見 `run_supplement.py:receiver`。

機制判斷：跨網路收件依靠 `fetch_inbox`／inbox resource；未找到對應 inbox 的遠端訂閱／webhook 工具，沒有測得郵件 push。MCP HTTP 的 SSE／logging 回應不等於按收件人推送新信。開 `NOTIFICATIONS_ENABLED` 後，send 時確實建立 server 端 `signals/projects/<slug>/agents/RedStone.signal`，內含 id/from/subject；fetch 後清掉（所以主流程末尾 signal 清單是空）。它是本機檔案訊號，不會自己送到遠端 Windows。[signal 實作](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/src/mcp_agent_mail/storage.py)

**未驗證**：CLI／IDE 常駐輪詢、閒置 agent 自動喚醒、問答自動回答、動手確認／auto mode。這些仍需 client adapter／本機受控執行層，不能把 200 ms 本機 API 結果寫成完整 G-03 通過。

### E4｜HTTP token 驗證：通過（明確關 localhost bypass）

每例皆 POST `/api/`、JSON-RPC `tools/call health_check {}`：

| Authorization | HTTP | 結果 |
|---|---:|---|
| 不帶 | 401 | `{"detail":"Unauthorized"}` |
| Bearer incorrect-demo-token | 401 | 同上 |
| 正確臨時 bearer | 200 | status=ok、isError=false |

單一 `HTTP_BEARER_TOKEN` 是 server 共用憑證，不是每個人的憑證。此次沒有以「token 只提供給 A/B」冒充 Discord 帳號登入。

### E5｜個別 agent token：通過；每人可撤銷：未達成

register_agent 為 A/B 各回傳不同 `registration_token`，重啟後 B 的舊 token 仍可讀 B inbox。另用**新的 stateless 請求**避免已認證 session 干擾，執行 `fetch_inbox(project_key=team-one, agent_name=RedStone, registration_token=...)`：

| 個別 token | HTTP／MCP 結果 |
|---|---|
| 不帶 | HTTP 200，但 `isError=true`；AUTHENTICATION_REQUIRED 說需 registration_token |
| 錯誤值 | HTTP 200、isError=true；Invalid registration_token |
| A 的 token | HTTP 200、isError=true；不能當 B 使用 |
| B 的 token | HTTP 200、isError=false；讀回 B 的信 |

不可只看 HTTP 200 判定工具成功。來源還顯示已綁定 MCP session 可免再次帶 agent token；新 session 才須重新認證。[agent auth／註冊實作](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/src/mcp_agent_mail/app.py)

「每人一 token、Discord 撤銷」仍缺：41 tools 沒有 token issue/revoke/rotate API；原始碼 `_ensure_agent_registration_token(..., rotate=False)` 有內部旋轉分支，但目前呼叫點未暴露 rotate=True，CLI 只有 lookup，不能把內部 helper 當交付功能。retire／delete 身分也不等於管理使用者憑證的撤銷契約。沒有做修改 DB 的人造撤銷或既有 session 失效測試；即時失效策略**待確認**。需要新增 user→agent→project 綁定、token ID／雜湊、revoked_at、session 撤銷規則、Discord `/connect`／撤銷流程。

### E6｜每人不同 JWT：有條件可用，audience 模式失敗

實測自己簽發 HS256 JWT，sub 分別 `discord-A`／`discord-B`，role=writer、issuer=f01-spike、有效 exp；沒有使用真 Discord credential 或外部 IdP。

| 設定／請求 | 實際結果 |
|---|---|
| `HTTP_JWT_AUDIENCE=f01-local`，A/B 都帶匹配 aud／iss／exp | 兩者 **401**；不是宣稱支援就通過 |
| 不設定 HTTP_JWT_AUDIENCE，保留 issuer，A/B 有效 JWT | 兩者 200、工具成功 |
| 同上，已過期 A JWT | 401 |
| 同上，錯誤簽章 JWT | 401 |
| 另簽一個過期 A JWT 後，再用原有效 A JWT | 仍 200；新發 credential 不會使舊 credential 自動失效 |

縮小原因的實際命令：用 venv Python import `authlib.jose.JsonWebToken/JsonWebKey`，對本機簽發 token decode，呼叫 `claims.validate_aud('f01-local')`；輸出 `TypeError: JWTClaims.validate_aud() takes 1 positional argument but 2 were given`，`inspect.signature` 得 `()`（bound）／`(self)`（class）。上游 http.py `_decode_jwt` 正好用該錯誤呼叫，外層 suppress 把錯誤轉成驗證失敗。**未改上游／未把停用 audience 當正式安全配置建議。**

JWT middleware 未見 jti denylist、Discord membership 或逐人即時撤銷檢查；exp 可到期不等於 Discord 立即撤銷。JWKS／非 HS256 驗證、撤 key 的快取行為均未實測。此處只是確認兩個 bearer 可同時被接受，不能據此宣稱 R-4 已滿足。

### E7｜多專案／多組隔離與 web UI：隔離失敗；UI HTTP 可用

用同一 server bearer、沒有另一組成員關係資料，實際呼叫：

```text
fetch_inbox(project_key=team-two, agent_name=RedStone, registration_token=<B>)
  → isError=true：Project not found
ensure_project(human_key=team-two)
  → 200／isError=false，建立第二 project
register_agent(project_key=team-two, name=BlueLake, program=outsider, model=no-llm)
  → 200／isError=false，建立另一 project 的同名 agent
GET /mail/api/unified-inbox?include_projects=true （只有共用 bearer）
  → 200；11 messages、兩專案列表；包含 B 的 F01 offline handoff 與完整 body
```

無 audience 的 JWT phase 再測：sub=A 帶 B registration token 可成功 fetch B；這表示 agent token 是能力憑證，middleware 沒有把 sub=A 限定為 agent A。**A 不持 B token 時不能直接用 fetch_inbox 冒充 B（E5 已拒絕）**，但同一 JWT A 單獨 GET unified-inbox 仍 200、含 B 的 subject/body，不需 B token。這正是 multi-user Hub 必須加的路由／租戶授權邊界，不能只保護 MCP 工具而放任人類 web UI。

web route HTTP 驗證：`/mail/` 不帶 bearer=401、帶 bearer=200（HTML 211089 bytes）；`/docs` 與 `/openapi.json` 同樣 401／200。沒有做瀏覽器視覺、互動、易用性、手機或每人登入驗收。OpenAPI 刻意不列 `/mail/*`；UI JSON helper 存在不代表穩定公開 REST 契約。[UI／middleware 實作](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/src/mcp_agent_mail/http.py)

## 跨網路與部署：文件可行，實際遠端未驗證

Python README 提供 Streamable HTTP、NGINX TLS termination、JWT／bearer、RBAC、rate limit 與備份說明；預設只聽 `127.0.0.1`。外網架構可讓 server 留在 loopback，只有反向代理聽 443；若容器／內網需直連才考慮 `HTTP_HOST=0.0.0.0`，而非直接裸露 8765。[Security and ops](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/README.md#security-and-ops)

需落實：可驗證憑證的 HTTPS、保留 Authorization／MCP session headers、Streamable HTTP／SSE 的 timeout 與 buffering 行為、關閉 localhost bypass、外層逐人／逐組授權、限制 UI／管理路由、只開必要防火牆 port、持久 DB＋archive、備份與還原；這些是部署工作清單，**尚未配置／驗收**。本文未 bind 0.0.0.0、未簽憑證、未連 VPS，所以「跨網路已通」仍是待確認。

Docker 有 Dockerfile、docker-compose.yml、systemd sample；未跑 Docker build／compose／systemd。Python Dockerfile 不只裝 Python，還從 `toon_rust` 建 encoder，預設 ref=main、需 Rust toolchain，增加建置依賴；Compose 例使用 PostgreSQL＋archive volume，需另處理 token、憑證、資料庫 driver／URL 與備份配置，不是直接 production-ready。此次 SQLite 一程序＋venv 路線實際可啟動，但沒有 VPS RAM／CPU／費用量測。[Dockerfile](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/Dockerfile)、[compose](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/9138f34b1ed220235dbfeaa3f1fc9fe4444f4e72/docker-compose.yml)

Rust 提供 release Dockerfile 與 `serve --no-tui` 的文件路徑，有較近期維護；但沒有編譯、拉 image 或驗證其 HTTP/token 行為，不能把 Python 通過數字轉給 Rust。[Rust README](https://github.com/Dicklesworthstone/mcp_agent_mail_rust/blob/a58b6d77cd16fa4e235359ae91f1b28779780d05/README.md)

## 需求逐項評分

評分：2＝在本機範圍實測符合；1＝部分符合／需要外層改造；0＝當前不符合；?＝未驗證。此為決策用覆蓋表，不加總為成功率。維護、部署列另注明文件證據，避免把靜態閱讀當實測。

| 要求 | 分 | 判定與依據 |
|---|---:|---|
| 多 agent 身分 | 2 | A/B 兩 session、各自 registration token；不含 Discord 人身分 |
| 收件匣 | 2 | 個別 fetch、body／thread；錯 agent token 被拒 |
| 同步 | 1 | 輪詢可用且已量測；遠端 AI 自動醒來／問答與執行授權未驗證 |
| 非同步 | 2 | B session 離線後收信，稍後讀回 |
| 持久化 | 2 | 正常重啟仍在；SQLite＋Git／Markdown；災難恢復未驗證 |
| HTTP token 驗證 | 2 | 無／錯 token 401，正確 200；bypass 關閉 |
| 每人 token＋Discord 撤銷 | 1 | 個別 agent token、兩 JWT 可用但無人綁定／立即撤銷 API，audience 設定失敗；完整 R-4 不通過 |
| 多專案 | 2 | 兩 project 建立、同名 agent 可並存 |
| S3 多組隔離 | 0 | server credential 可跨 project 建身分，web feed 跨專案／人讀取；未有 membership ACL |
| web UI | 1 | HTML／JSON 200、未認證 401；視覺／互動未驗證、無 per-user 隔離 |
| 維護活躍度 | 0 | Python 已停止維護；Rust 比較版最近 commit 11/15，但未執行 |
| 部署難度 | 1 | venv 本機可啟動、Docker／systemd 文件存在；TLS／VPS／Docker 未驗證，需額外授權層 |
| Discord bot 接縫 | 1 | bot 可做 MCP client；有 UI JSON helper／本機 signal，未見現成 Discord adapter／outbound webhook |

## Discord 串接接縫與最小改造面

最穩定的已測接縫是 bot 後端當 MCP client：發訊息／讀 inbox／查 thread，對外提供 Discord command。通知要自己做「帶 cursor 的輪詢＋去重＋重試」或 server 本地 signal watcher，再發 Discord 通知；signal 是 best-effort、可被 fetch 清掉，不可當耐久事件佇列。未找到獨立、版本承諾的 send-message REST／outbound webhook API；`/mail/api/unified-inbox` 有 JSON 但屬 UI helper，且有上述隔離問題。以上只是設計可行接縫，沒有連 Discord、送外部通知或改 bot。

若改造 Agent Mail，至少仍需：Discord user／組 membership＋token lifecycle gateway、所有 MCP 與 UI route 的一致授權、durable notifications／delivery cursor、CLI polling／喚醒整合、內容類型與草稿／確認決策狀態、收件人確認與 auto mode 稽核。只在代理層檢查 bearer、有正確 project_key 就放行，無法解決本次看到的 S3 問題。

## 若自寫：最小工具清單（提案，非已開工）

| MCP 工具 | 最小責任 |
|---|---|
| `whoami` | 從已驗證 token 回傳 Discord user／agent／組 membership，不能由 payload 假冒 sender |
| `send_message` | 類型限任務／交接／求助／決策，server 決定 sender、檢查租戶與收件人、idempotency key、耐久保存後回 id |
| `fetch_inbox` | 只取本人授權範圍，durable cursor／limit；離線可補讀，不因讀取丟失訊息 |
| `ack_message` | 區分收到／已讀／已處理，檢查 recipient，容許重試 |
| `reply_message` | 沿 thread 回覆並保留作者／因果與 tenant 檢查 |
| `get_project_context` | 讀授權範圍的交接、決策、進度引用；任務狀態仍以 GitHub 為準 |
| `record_handoff` | session 結束寫交接，保留作者／來源／冪等識別 |
| `propose_decision` | 寫決策草稿；正式確認從 Discord 人類身分進入受控後端，不能由 agent 自行核准 |

另需非 MCP 管理能力：Discord `/connect` 發 token、撤銷 token／關聯 session；租戶 membership；通知 outbox／重試與 cursor；決策確認 endpoint；收件人授權／限對象限時 auto mode 的 policy 與稽核。執行程式碼仍需本機使用者控制的 client，不讓 VPS 直接控制別人的電腦。這份清單是支援 Brief 的最小責任範圍，正式名稱／契約由 G1 後的 SRS／SAD 決定。

## 失敗紀錄、未解決事項與會改變結論的證據

- 量測程式前兩次 exit=1：FastMCP `result.data` 產生動態 `Root` 物件，第一次 `TypeError: Object of type Root is not JSON serializable`，第二次 `AttributeError: 'Root' object has no attribute 'model_dump'`；當次已完成 offline 重啟，finally 都停止自己的 server。修正的是本地 harness 改解析 text JSON，未改上游；第三次全流程 exit=0。保留 first／second-run 證據，沒有把這兩次當完整通過。
- audience JWT 401 是被測產品／鎖依賴組合的可重現失敗；未修復、未跑上游完整 suite。撤銷／S3／自動喚醒沒有用假造通過補齊。
- 遠端 TLS、Mac↔Windows 兩機、實際 CLI／IDE hooks、Discord `/connect`／撤銷／通知、負載與 VPS 資源、Docker、災難還原均待確認；不能由單機測試外推。這些應在選路後的任務／測試計畫明列。
- Rust 只讀文件與 metadata，授權適用性待 PM／維護者 確認，沒有代替 維護者 做 D-1 或 D-2 決策。
- 若能提出「受維護版本＋可接受授權＋逐人撤銷在現有 session 也有效＋跨組負面案例通過＋遠端 CLI 收件自動化」的證據，會改變自寫建議；只證明 health_check 200 不會。

## 證據索引

所有相對路徑以本 worktree 為根，PM 可先收報告與遮蔽後 evidence，不要收 runtime／venv／上游 clone：

- `spikes/run_spike.py`：啟停、兩身分、離線重啟、立即 fetch、HTTP／agent 拒絕案例、第二 project、UI route。
- `spikes/evidence/results.json`、`run.stdout`、`server.log`：完整主流程（成功那次與 server log 中保留的前次嘗試）。
- `spikes/run_supplement.py`、`spikes/evidence/supplement/results.json`、`supplement.stdout`：curl 真呼叫、250 ms 輪詢、signal、web 跨組讀取、audience JWT 失敗。
- `spikes/run_jwt_probe.py`、`spikes/evidence/jwt-no-audience/results.json`、`jwt-no-audience.stdout`：Authlib signature、兩有效 JWT、到期／錯簽章拒絕、JWT sub 與 agent token／web feed 對照。
- `spikes/evidence/first-run.stdout`、`first-run-results.json`、`second-run.stdout`、`second-run-results.json`：harness 失敗原始紀錄。

本文的所有上游網路引用皆於 2026-11-16 查詢；行為判定優先採本機固定 SHA 的實際輸出，沒有把 README 宣稱當測試結果。
