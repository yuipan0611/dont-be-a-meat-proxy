# G1 決策包

- PM：PM-Emily｜決策人：維護者｜日期：2026-11-16｜狀態：**已決定（2026-11-16）**，結果見文末
- 依據：`docs/01-brief.md`、`docs/02-prd.md`、`docs/reviews/T1R-brief-review.md`、`docs/research/F-01`～`F-06`
- 原則：維護者 定下「能參考的就抄，不要自己設計」

## 實測結果摘要

| 層 | 抄誰 | 實測結論 | 證據 |
|---|---|---|---|
| AI 通訊 | mcp_agent_mail_rust | ✅ 可以原樣抄，用部署補洞：離線交接與重啟後持久化通過；輪詢延遲約 0.2 秒；在 Caddy 撤銷後，同一 session 的下一個請求會被拒（401），其他人不受影響。**必須一組一個容器**：只靠不同資料夾隔離時，A 組可以讀到 B 組的檔案 | F-01、F-01b |
| 專案記憶 | Hindsight | ⚠️ 核心可以抄，但要加一層代理：bank 隔離與團隊共享都成立。內建驗證只有一把全域 key → 用每人一個 token 的代理補上（PoC 通過）；要關掉 delete／clear 工具。峰值約 1.5 GB RAM | F-05 |
| 任務 | GitHub Issues＋官方 MCP | ✅ 免費版可以讀寫 Issues；Projects v2 需要另外啟用 | F-02 |
| 人的入口 | Discord bot | 查進度以 js-llmcord（MIT）為底；決策按鈕抄 disclaw／OpenClaw；`/connect`、撤銷、通知**需要自己寫膠水程式** | F-06 |
| 工具接入 | 五種工具 | 都能用「一段設定」接上；只有 Claude Code、Antigravity 支援一行指令 | F-02 |
| 費用 | Claude Haiku 5.5 | US$0.10／0.50 每百萬 token（PM 已核對官方頁）；7 人每月約 US$0.7–1.4 | F-03 |

**容量**：一組（Agent Mail＋Hindsight＋Caddy＋bot）估計需要約 2.3 GB → **US$5／1 GB 方案不夠**。T4c 已查得官方價格：Vultr 東京 2 GB `vc2-1c-2gb` US$10／月、4 GB `vc2-2c-4gb` US$20／月；Linode 東京 2 GB US$12、4 GB US$24。一組的峰值約 2.27 GiB，**2 GB 方案的餘裕不足，建議用 4 GB**。

## 要 維護者 決定的事

| # | 決策 | PM 建議 | 依據 |
|---|---|---|---|
| 1 | D-1 架構 | 採用「抄」的組合：Agent Mail Rust（一組一個容器）＋ Hindsight（一組一個 bank）＋ Caddy 代理（每人一個 token、可撤銷）＋ GitHub ＋ Discord bot 膠水 | F-01b、F-05、F-06 |
| 2 | Agent Mail 授權附加條款 | 見下方說明，由 維護者 判斷 | LICENSE |
| 3 | D-2 VPS | Vultr 東京 4 GB（`vc2-2c-4gb`，US$20／月）；S3 前重新評估 | F-03、F-05 |
| 4 | S1 目標上線日（M-1） | 2026-12-07 | Brief 原時程 |
| 5 | 專案助理每日上限（M-4、Q-05） | 每日 US$0.50（約 95 次提問）；Anthropic Console 每月硬上限 US$5 | F-03 |
| 6 | 誰能把決策轉為正式（M-6、Q-03、Q-09） | S1：維護者；S2：決策提出者以外的任一組員＋維護者 可否決 | T1R |
| 7 | auto mode 時限（Q-01） | 預設 1 小時，最長 4 小時 | PRD |
| 8 | 確認請求的逾時（Q-02、P-2） | 30 分鐘；逾時視為拒絕並通知發送者 | F-06 |
| 9 | 任務的真相來源（M-5） | 從 Discord 或 AI 建立的任務，**一律先建立成 GitHub Issue**；Agent Mail 只傳 Issue 連結 | T1R |
| 10 | 交接是否一律保存原文（F-05） | 是。Hindsight 萃取會漏掉資訊，也會把繁中轉成簡體；原文另存並可取回 | F-05 |
| 11 | 查進度的回覆可見範圍（P-1） | 預設只給提問者看（ephemeral），可選擇公開 | F-06 |
| 12 | VS Code 上用的 AI 擴充（M-7） | 需要 維護者 提供事實（Copilot？Cline？） | T1R |
| 13 | PRD | 依上述答案修訂後轉為「已確認」 | PRD |

## #2 授權附加條款說明（不是法律意見）

mcp_agent_mail（Python 版與 Rust 版）採用的是 MIT License，但附加了一份 OpenAI／Anthropic rider：

- 受限對象："Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC; any of their respective Affiliates，以及代表它們行事的人。
- "no rights are granted to any Restricted Party."
- 禁止提供、散布、託管給受限對象，或供其用於訓練、評測、benchmarking、testing、analyzing 等用途；違反時授權自動終止。

PM 觀察：維護者 是個人，自用並不是受限對象本身。但本系統的 agent 正是 Claude／Codex（由 Anthropic／OpenAI 提供的服務），軟體的內容會經由這些服務處理，所以「提供給受限對象」的範圍存在解釋空間。可以選擇：

- (a) 接受風險並採用
- (b) 不採用 Agent Mail，改找授權乾淨的替代品（需要再調研，例如 F-01 提到的 agent-inbox 等），或自己寫一個精簡收件匣（與「能抄就抄」原則衝突）

## G1 結果（維護者，2026-11-16）

| # | 決策 | 維護者 的答案 | PM 處理 |
|---|---|---|---|
| 1 | 架構 | 未反對，照建議 | 進 SAD |
| 2 | Agent Mail 授權附加條款 | **接受風險**（take the risk） | Brief R-6 |
| 3 | VPS | **用既有 Hostinger 2 vCPU／8 GB／100 GB**，不另買 | 一組峰值約 2.3 GB、五組約 3.9 GB，8 GB 足夠到 S3 |
| 4 | 時程 | **一週 MVP（11-23），兩週上線（11-30）** | 流程壓縮，見 `docs/00-DAG.md` |
| 5 | 專案助理 LLM | 維護者 已有 **Gemini 訂閱**與 **gpt-oss API（Groq）** | 派 T12 查證（F-07）：Gemini 訂閱不等於 API 額度；Hindsight 能否接；繁中品質；資料是否被拿去訓練 |
| 6 | 決策確認者 | 照建議 | Brief 決策 #19 |
| 7 | auto mode／確認逾時 | 照建議（1 h／4 h；30 分鐘） | Brief G-03 |
| 8 | 三條資料規則 | 未反對，照建議 | Brief「系統構成」 |
| 9 | VS Code 擴充 | Claude Code、Codex（GPT）、Antigravity 擴充 | 派 T13 確認是否沿用 CLI 的 MCP 設定（F-08） |

## G1 之後的補充決定

| 日期 | 事項 | 維護者 的答案 |
|---|---|---|
| 2026-11-16 | SRS 4.1 #1／#4／#6／#13 | 照建議（見 `docs/03-srs.md` 4.4） |
| 2026-11-16 | gpt-oss 供應商 | Groq |
| 2026-11-16 | 網域 | 有自有網域；用子網域指向 VPS（名稱、DNS 託管商待提供） |
| 2026-11-16 | 網域名稱與 DNS | `example.invalid`，DNS 在 Hostinger；Hub 用子網域（暫定 `hub.example.invalid`） |
| 2026-11-16 | GAP-20 auto mode 批次 | 放上線批次（11-30） |
| 2026-11-16 | GAP-01 MVP 專案現況 | 最近 N 則交接；11-30 改用專案記憶 |
| 2026-11-16 | GAP-12 token 粒度 | 每裝置一份 |
| 2026-11-16 | GAP-17 查進度入口 | Discord `/status` slash 指令（回覆只給提問者看） |
| 2026-11-16 | D-4 LLM | 方案 B：專案助理與 Hindsight 都用 Claude Haiku 5.5（約 0.91 USD／月）；設定保持可替換 |
