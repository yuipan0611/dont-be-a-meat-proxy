# F-04 開源方案盤點：能抄就抄

- 作者：PM-Emily｜日期：2026-11-16｜狀態：草稿，待 G1 時由 維護者 審查
- 觸發：維護者 指定三個參考專案，並定下原則「**能參考的就抄，不要自己設計**」
- 方法：讀各專案的 GitHub 頁面與 README（2026-11-16 查詢）。**本文只讀過文件，還沒有實際執行。** 星數等數字取自頁面當下的顯示。
- 相關文件：F-01（Agent Mail 實測）、F-02（GitHub MCP＋Discord）、F-03（VPS＋費用，修正中）

## 1. 三個專案各自是什麼

| 專案 | 一句話 | 授權 | 規模 | 與我們需求的關係 |
|---|---|---|---|---|
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | 「自己的 AI bot 團隊，放在聊天 App 裡」；每個 bot 背後是**你本機的 `claude`／`codex` CLI**，沿用自己的訂閱 | Apache-2.0（`enterprise/` 另計） | 約 23.5k★，自稱 "Early but real" | **單人**工具。harness 綁 `127.0.0.1`；MCP 是 stdio（本機）；多人只能靠匯出檔案分享。**不是跨人 Hub** |
| [Rakazo](https://github.com/elie222/rakazo) | 開源的「AI 隊友」平台：群組聊天 @bot、bot 會分工互查；有 web、桌面、手機版 | Apache-2.0 | 約 8.7k★ | **多人平台**（帳號、組織、共享電腦、Postgres＋Better Auth）。但 bot 跑在**伺服器沙盒**、用 API key，**不是組員自己的 Claude Code**；README 未提到對外提供 MCP |
| [Hindsight](https://github.com/vectorize-io/hindsight) | Agent 記憶層：retain／recall／reflect；**每個 bank 內建一個 MCP 端點** `/mcp/{bank_id}/` | **MIT** | 約 61.2k★，有論文、有雲端版 | **直接對應「專案記憶」這一層**：一個 bank 可以是「一個專案」，bank 之間「嚴格隔離」 |

## 2. 關鍵發現

1. **沒有一個專案能直接解決「不同人的本機 AI 互傳」。** OpenMausBot 能用本機 CLI 但只支援單人；Rakazo 支援多人，但 bot 不是組員自己的 CLI。我們的核心差異仍然是「**每個組員自己的 Claude Code／Codex 接上同一個中心**」。
2. **記憶層可以直接採用 Hindsight**，不必自己設計：
   - 一組一個 bank → 解決 S3 隔離（README："Isolation is strict: no cross-bank leakage"）。
   - 內建 MCP → 組員的 AI 工具加一段設定就能 retain／recall。
   - 注意：retain 會呼叫 LLM 萃取記憶（會產生費用）；需要 Postgres＋pgvector；README 沒有寫 RAM 需求，**US$5／1 GB 的 VPS 可能不夠**，要實測。
   - 自架版的驗證（API key）README 沒寫清楚，只提到 "auth extension points" → 要實測。
3. **AI 通訊層也可以抄**，不照 F-01 的建議自寫。F-01 發現的三個缺口，都可以用「部署方式＋現成工具」補上，不必寫新程式：

| F-01 缺口 | 抄的解法（不自己設計） |
|---|---|
| Python 版已停止維護 | 改用仍在維護的 **mcp_agent_mail_rust**（F-01 只讀過文件，需要實測） |
| S3 跨組會互相看到（0 分） | **一組一個 Agent Mail 實例**（Docker 容器），用部署切開隔離，不寫 ACL |
| 缺少逐人撤銷 | 前面加現成的反向代理驗證（例如 Caddy＋forward auth，或 Tailscale），在代理層撤銷 |

4. **可以參考的設計**（看它們怎麼做，照著做）：
   - OpenMausBot 的 **permission broker**（把核准請求浮到使用者面前）→ 正好是我們「動手類要人確認」的做法。
   - Rakazo 的**群組 @bot、分工互查**互動 → Discord 頻道裡的互動模式可以照抄。

## 3. 「能抄就抄」組合（取代 F-01 的自寫建議，待驗證）

| 層 | 抄誰 | 我們只寫的部分 |
|---|---|---|
| 任務 | GitHub Issues＋官方 GitHub MCP（F-02） | 無 |
| AI 通訊 | mcp_agent_mail_rust，一組一個實例 | 部署設定 |
| 專案記憶 | Hindsight，一組一個 bank，內建 MCP | 部署設定 |
| 驗證／撤銷 | 反向代理（Caddy／Tailscale 等現成方案） | 設定 |
| 人的入口 | Discord bot（需再找現成的 Discord↔MCP 橋接專案） | 膠水程式碼：`/connect`、通知、查進度 |
| 確認流程 | 參考 OpenMausBot permission broker | 照抄其行為 |

我們自己要寫的程式碼，只剩 **Discord bot 這段膠水**，加上 **部署設定**。

## 4. 待驗證（會改變結論的事）

- V-1：Rust 版 Agent Mail 能否實際執行、一組一個實例的隔離是否成立、代理層撤銷是否即時生效。
- V-2：Hindsight 能否自架、bank 隔離、MCP 能否從 Claude Code 連線、自架驗證方式、記憶體需求、retain 的 LLM 費用。
- V-3：是否已有現成的 Discord↔MCP／Agent Mail 橋接專案可以抄。
- V-4：Hindsight 與 Agent Mail 是否重疊（訊息是否也要存進記憶）→ 由 SAD 決定。

## 來源（2026-11-16 查詢）

- https://github.com/milind-soni/OpenMausBot
- https://github.com/elie222/rakazo
- https://github.com/vectorize-io/hindsight
- F-01：`docs/research/F-01-agent-mail-spike.md`（Rust 版 SHA 與評分表）
