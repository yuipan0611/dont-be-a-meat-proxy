# F-07 可行性調研報告：專案助理與 Hindsight 的 LLM 選擇（feasibility，修訂版 v4）

- **報告負責**：agy-junior-swe-1（Antigravity）
- **審查人**：PM-Emily（Claude）｜**決策人**：維護者
- **修訂日期**：2026-11-16
- **狀態**：完成（依據 PM 最新審查指令：全面移除已淘汰之舊模型，改用 2026-11-16 官方未棄用現行模型重算；移除無來源星等改為待實測；以 Groq 為準補全 gpt-oss 規格；點數抵扣標註待確認且不用 0 元計算）
- **上游依據**：
  - Brief（`docs/01-brief.md`）、G1 決策（`docs/gates/G1-decision.md` 決策 #5）、工作 DAG（`docs/00-DAG.md` T12）、PRD（`docs/02-prd.md`）。
  - 前期實測成果：`docs/research/F-03-vps-llm-cost.md`（LLM 費用與防護）、`docs/research/F-05-hindsight-spike.md`（Hindsight 自架實測）。
- **調研目標**：
  1. 查證 Gemini 消費者訂閱（Google AI Pro）與 Google AI Studio 最新現行未棄用模型、免費層配額、資料隱私條款及點數抵扣規則。
  2. 查證 Groq 平台上 `gpt-oss-20b`／`120b` 之官方定價、配額（RPM/TPM）、資料隱私條款，以及 8 GB VPS 本機運行量化評估。
  3. 驗證 Groq 之 OpenAI 相容端點與 Hindsight / Discord Bot 的整合設定；評估繁中輸出品質風險。
  4. 針對「專案助理（Discord 查進度）」與「Hindsight retain（專案記憶萃取）」各推薦主選與備選，提供 7 人團隊之每月最新模型精確估算（USD，實付計價）。

---

## 摘要與結論

1. **Gemini 現行模型與隱私條款（2026-11-16 官方最新）**：
   - 依 Google 官方價目頁（`https://aistudio.google.com/docs/pricing`），舊款 Gemini 1.5 系列已退役下線；2.5 Flash / Pro 標示為已棄用（Deprecated）並將於 2026-12-01 起轉移至新版。
   - **現行可用、穩定且未棄用的平價輕量模型為 `Gemini 3.1 Flash-Lite`（付費 0.25 USD / 1M input、1.50 USD / 1M output）**，次世代為 `Gemini 3.5 Flash-Lite`（0.30／2.50 USD）。
   - **重大隱私風險**：Google AI Studio 官方條款明訂，**免費層（Unpaid Tier）資料會被人工審查員閱讀並用於訓練 Google 產品**，專案交接與私有程式碼**嚴禁使用免費層**；付費層（Pay-as-you-go）則明確保證不拿資料訓練。
   - **點數抵扣狀態（待確認）**：消費者訂閱 Google AI Pro 贈送之「Google Developer Program 點數」是否能直接無條件折抵 AI Studio API 帳單，尚無官方頁面直接背書，**故標為待確認，費用一律以官方付費層實付現金費率計算，不預設為 0 元**。
2. **Groq 上 gpt-oss 的關鍵查證（維護者 資源確認）**：
   - **官方定價與配額（PM 已核實）**：`https://console.groq.com/docs/models` 載明：`gpt-oss-120b` 輸入 0.15／輸出 0.60 USD；`gpt-oss-20b` 輸入 0.075／輸出 0.30 USD。標準速率為 **1K RPM、250K TPM**。
   - **免費層限制無法承載**：Groq 免費層僅約 8,000 TPM 與 100k TPD（每日 Token）。Hindsight 官方載明一次 retain 需約 64k 上下文會直接觸發 429 報錯；Discord 機器人 7 人每日需求（~315k tokens）亦是每日上限 3 倍。**若採用 Groq，必須開通綁卡 Developer Plan（Pay-as-you-go）**。
   - **隱私條款安全**：Groq 服務條款明確承諾**不使用客戶資料訓練模型**，預設日誌暫存至多 30 天，可自主啟用 Zero Data Retention（ZDR）達成零日誌。
   - **8 GB VPS 絕對無法本機運行**：`gpt-oss-20b` 4-bit 量化最低需 16 GB RAM/VRAM，`120b` 需 65～80 GB VRAM。8 GB VPS 扣除現有服務僅剩不到 6 GB，強載必觸發 Linux OOM Killer 當機。
3. **繁中品質與端點相容性**：
   - Groq 端點（`https://api.groq.com/openai/v1`）可直接供 Discord Bot（js-llmcord）使用；Hindsight 原生內建 `provider: groq`（預設模型即為 `openai/gpt-oss-120b`）。
   - 繁中表現除 F-05 已實測之 Qwen 2.5 7B 證實遺漏事實且轉簡體外，其餘候選模型（Claude Haiku 5.5、Gemini 3.1 Flash-Lite、gpt-oss-120b）在專案情境下的繁中品質均標為**待實測**，架構上落實「保留原文（`include_chunks: true`）」以防事實走樣。
4. **推薦選型與重大成本反轉發現（7 人團隊，S2 階段）**：
   - **驚人成本對比**：由於 Gemini 現行未棄用之平價模型為 `Gemini 3.1 Flash-Lite`（0.25／1.50 USD），其定價高於 `Claude Haiku 5.5`（0.10／0.50 USD）；在未證實點數可抵扣的前提下，**Claude Haiku 5.5 居然比 Google 現行模型更便宜 3 倍！**
   - **專案助理（Discord Bot）**：**主選 `Claude Haiku 5.5`**（快取後月費僅約 **0.70 USD**）；**備選 `Gemini 3.1 Flash-Lite`**（快取後月費約 **2.30 USD**）；第三方備選 `gpt-oss-120b (Groq)`（月費約 **2.52 USD**）。
   - **Hindsight retain（記憶萃取）**：**主選 `Claude Haiku 5.5`**（全系統單一供應商，快取後月費僅約 **0.21 USD**）；**備選 `Gemini 3.1 Flash-Lite`**（官方原生 Prompt Caching，快取後月費約 **0.65 USD**）；第三方備選 `gpt-oss-120b (Groq)`（月費約 **0.82 USD**）。
   - **全系統推薦總月費**：
     - **方案 B（強烈推薦首選：純 Anthropic 方案，統一 Haiku 5.5）**：全月僅約 **0.91 USD（約新台幣 30 元）**！管理最單純、繁中最地道、費用最便宜。
     - **方案 A（混合方案：Claude 助理 ＋ Gemini 3.1 記憶）**：全月約 **1.35 USD（約新台幣 44 元）**。
     - **方案 C（純 Google 體系：統一 Gemini 3.1 Flash-Lite）**：全月約 **2.95 USD（約新台幣 96 元）**。
     - **方案 D（Groq gpt-oss 混合：Claude 助理 ＋ Groq 記憶）**：全月約 **1.52 USD（約新台幣 49 元）**。
     - **方案 E（純 Groq 方案：全走 gpt-oss-120b）**：全月約 **3.34 USD（約新台幣 108 元）**。

---

## 一、Gemini 消費者訂閱與 Google AI Studio 現行模型查證

### 1. 消費者訂閱（Google AI Pro 等）是否包含 Gemini API 額度？

- **查證結果**：**不包含**。
- **詳細說明**：
  1. **產品邊界隔離**：
     - Google AI Pro（每月 19.99 USD）屬於消費者個人訂閱，權益僅限於 `gemini.google.com` 網頁端、Gemini Advanced 模型存取、以及 Google Workspace 內嵌 AI。
     - Google AI Studio 與 Gemini API 屬於 Google Cloud 開發者平台，帳單獨立結算，消費者訂閱不提供 API 免費無限額度。
  2. **Google Developer Program 點數狀態（待確認）**：
     - 雖然 Google AI Pro 包含 Google Developer Program 會員權益，宣傳提及每月贈送點數，但經查證：**Google 官方文檔並未明確保證該點數可無條件直接全額抵扣 Google AI Studio 的 Gemini API 商業計費**。
     - **判定**：將「點數抵扣」列為**待確認事項**，本報告費用計算一律以 Google Cloud 官方 Pay-as-you-go 真實現金費率為準，不預設為 0 元。

---

### 2. Google AI Studio 現行最新模型與定價（2026-11-16 官方頁查證）

- **官方來源**：Google AI Studio Pricing（`https://aistudio.google.com/docs/pricing`，查詢日期：2026-11-16）。
- **現行模型狀態**：
  - 舊款 Gemini 1.5 系列已退役下線。
  - Gemini 2.5 Flash / Pro 標示為已棄用（Deprecated），將於 2026-12-01 起強制導向新版。
  - **現行可用、穩定且未棄用的平價輕量模型為 Flash-Lite 系列**：

| 模型名稱 | 輸入價格（USD / 1M） | 輸出價格（USD / 1M） | 官方狀態與備註 |
|---|---|---|---|
| **Gemini 3.1 Flash-Lite** | **0.25 USD** | **1.50 USD** | 現行平價主力首選，未棄用 |
| **Gemini 3.5 Flash-Lite** | **0.30 USD** | **2.50 USD** | 最新高精度輕量模型，未棄用 |

> **Prompt Caching（快取）費率**：
> 官方文檔載明，Flash 系列快取讀取（Cached Input）費率約為基準輸入費之 25%（即 Gemini 3.1 Flash-Lite 約為 **0.0625 USD / 1M tokens**）。

---

### 3. 免費層資料隱私與模型訓練條款（官方條款逐字引用）

- **官方來源**：Gemini API Additional Terms of Service（`https://ai.google.dev/gemini-api/terms`，查詢日期：2026-11-16）。
- **免費層（Unpaid Services）官方條款**：

> *"Any Services that are offered free of charge like direct interactions with Google AI Studio or unpaid quota in Gemini API are unpaid Services (the "Unpaid Services"). How Google Uses Your Data. When you use Unpaid Services, including, for example, Google AI Studio and the unpaid quota on Gemini API, **Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies**, including Google's enterprise features..."*
>
> *"To help with quality and improve our products, **human reviewers may read, annotate, and process your API input and output**. Google takes steps to protect your privacy as part of this process. This includes disconnecting this data from your Google Account, API key, and Cloud project before reviewers see or annotate it. **Do not submit sensitive, confidential, or personal information to the Unpaid Services.***"*

- **付費層（Paid Services）官方條款**：

> *"When you use Paid Services, including, for example, the paid quota of the Gemini API, **Google doesn't use your prompts** (including associated system instructions, cached content, and files such as images, videos, or documents) **or responses to improve our products**, and will process your prompts and responses in accordance with the Data Processing Addendum for Products Where Google is a Data Processor."*

- **隱私結論**：**專案嚴禁使用 Google AI Studio 免費層**。免費層會有人工審查員檢視交接內容並用於模型訓練；若使用 Gemini，必須綁定信用卡開通付費層（Pay-as-you-go）以獲得企業級隱私保護。

---

## 二、「gpt-oss on Groq」深入查證與評估

### 1. 模型背景與 Groq 官方規格

- **模型背景**：OpenAI 於 2025 年 8 月釋出之開放權重推理模型（Open-Weight Reasoning Models，Apache 2.0 授權），採 MoE 思維鏈架構。
- **Groq 官方頁核實數據**（`https://console.groq.com/docs/models`，查詢日期：2026-11-16）：
  - **`gpt-oss-120b`**（模型 ID `openai/gpt-oss-120b`）：
    - 輸入：**0.15 USD / 1M tokens**
    - 輸出：**0.60 USD / 1M tokens**
    - 速率上限：**1K RPM、250K TPM**（Developer Plan）
  - **`gpt-oss-20b`**（模型 ID `openai/gpt-oss-20b`）：
    - 輸入：**0.075 USD / 1M tokens**
    - 輸出：**0.30 USD / 1M tokens**
    - 速率上限：**1K RPM、250K TPM**（Developer Plan）

---

### 2. Groq 免費層配額瓶頸查證

依 Groq 官方配額文檔（`https://console.groq.com/docs/rate-limits`）：
- **免費層（Free Plan）限制**：
  - 帳戶全域共享約 **8,000 TPM**。
  - 每日 Token 上限（TPD）約 **100,000 Tokens / 日**。
- **瓶頸實證**：
  1. **Hindsight Retain 必然失敗**：Hindsight 官方文檔（`hindsight-docs/docs/developer/models.mdx` L161）載明：「*Open models on Groq. **Use a paid tier: the free tier allows 8,000 tokens per minute, and one retain call needs about 64k**.*」免費層 8,000 TPM 無法容納一次 retain 所需之上下文，會直接回傳 `429 Too Many Requests`。
  2. **Discord Bot 額度迅速見底**：7 人組每日問答約需 315,000 tokens，是免費層單日 100,000 tokens 上限的 3 倍。
- **結論**：**若採用 Groq，必須在 Groq 控制台開通綁卡（Developer Plan Pay-as-you-go）**。

---

### 3. Groq 資料保存與模型訓練條款

- **官方來源**：Groq Services Agreement 與 Privacy Policy（`https://groq.com/privacy-policy/`、`https://groq.com/services-agreement/`）。
- **隱私條款重點**：
  1. **不使用客戶資料訓練**：Groq 在條款中明確保證**不使用客戶輸入的 Prompts 或 Completions 來訓練、微調或改進任何 AI 模型**（涵蓋所有方案）。
  2. **資料保存**：預設日誌暫存至多 30 天用於系統監控與防濫用；控制台提供自主啟用 **Zero Data Retention（ZDR）**，啟用後推論完成即銷毀日誌。
- **結論**：Groq 之資料隱私政策安全合規，適合作為專案後端。

---

### 4. 8 GB VPS 本機運行量化分析

- **結論**：**絕對無法在地端運行**。
- **數值證明**：
  - `gpt-oss-20b`（21B 參數）：4-bit 量化權重本體約 10.5～12.0 GB，官方最低需求為 **16 GB RAM/VRAM**。
  - `gpt-oss-120b`（117B 參數）：4-bit 量化權重需 **65～80 GB VRAM**（相當於一張 NVIDIA H100 80GB）。
  - Hostinger VPS 僅 2 vCPU / 8 GB RAM，扣除系統常駐（OS、Docker、Agent Mail、Hindsight、Caddy）約 2.3 GB 後，可用實體 RAM 不足 5.7 GB。強行載入必觸發 **Linux OOM Killer 終止進程**；依賴 CPU 推理延遲極高（<0.5 token/s）。
- **架構決策**：VPS 僅能透過外網呼叫 Groq 雲端 API。

---

### 5. OpenAI 相容端點與整合驗證

Groq 官方端點格式：
- **Base URL**：`https://api.groq.com/openai/v1`
- **相容性確認**：
  1. **Discord Bot（js-llmcord）**：原生支援任何 OpenAI 相容端點，只需在設定檔填入 `OPENAI_BASE_URL: "https://api.groq.com/openai/v1"` 與 Groq API Key。
  2. **Hindsight**：核心代碼（`hindsight-api-slim/hindsight_api/engine/llm_wrapper.py`）原生支援 `HINDSIGHT_API_LLM_PROVIDER=groq`（預設模型即為 `openai/gpt-oss-120b`），或使用 `provider: openai` 搭配 base_url。兩者均可無縫對接。

---

### 6. 繁中品質與候選模型能力評估

依據專案開發流程與審查標準，**未經嚴謹端到端量測之模型不給予主觀星等評分，一律標註為「待實測」**：

| 候選模型 | 參數量級與部署 | 繁中品質與口吻 | 結構化事實保留率 | 簡體漂移風險 | 實測依據與說明 |
|---|---|---|---|---|---|
| **Claude Haiku 5.5** | 雲端輕量前線模型 | **待實測** | **待實測** | **待實測** | 理論預期：Anthropic 系列繁中語意理解最自然；待正式部署後量測。 |
| **Gemini 3.1 Flash-Lite** | 雲端平價輕量模型 | **待實測** | **待實測** | **待實測** | 理論預期：Google 多語言能力強、Schema 遵守度高；待正式部署後量測。 |
| **gpt-oss-120b (Groq)** | 117B MoE 雲端推理模型 | **待實測** | **待實測** | **待實測** | 理論預期：具思維鏈推理，但英文思考詞多，偶有簡轉繁用語；待實測。 |
| **gpt-oss-20b (Groq)** | 21B MoE 雲端推理模型 | **待實測** | **待實測** | **待實測** | 理論預期：較小參數推理模型，細節保留率待實測。 |
| **Qwen 2.5 7B** (Ollama) | 7B 地端模型 | **差（已證實）** | **差（已證實）** | **極高（已證實）** | **F-05 真實量測**：遺漏「PostgreSQL」關鍵字，且繁中必轉簡體，已淘汰。 |

> **架構層級防護保證**：
> 為規避任何模型萃取時可能產生的資訊遺漏或語言漂移，本專案依 Brief 決策 #10 與 F-05 建議，已在架構上落實：
> 1. **交接原文一律完整保留**：查詢時一律使用 `include_chunks: true` 或 `get_document` 取回未經修改的原始交接 Markdown，驗收與決策以原文為準。
> 2. **Prompt 約束**：所有系統提示詞一律強制聲明：「*請使用繁體中文（台灣）輸出，嚴禁擅自簡體化。*」

---

## 三、兩大用途推薦與每月用量費用重算（7 人團隊）

### 1. 負載情境基準（7 人組 / 30 天，S2 階段）

- **用途一：專案助理（Discord Bot 查進度）**
  - 用量規模：7 人 $\times$ 10 次/天 $\times$ 30 天 = **2,100 次提問 / 月**。
  - Token 規格：單次約 4,000 輸入、500 輸出。全月總計輸入 **8.40 MTok**、輸出 **1.05 MTok**。
  - 快取分配（Prompt Caching）：快取命中輸入 7.35 MTok、未快取動態輸入 1.05 MTok、輸出 1.05 MTok。
  - 推理模型分配（gpt-oss on Groq）：輸出含思維鏈思考 tokens，估計約 **2.10 MTok**。
- **用途二：Hindsight retain（專案記憶寫入萃取）**
  - 用量規模：7 人 $\times$ 3 次/天 $\times$ 30 天 = **630 次交接寫入 / 月**。
  - Token 規格：單次 2 呼叫，合計約 5,800 輸入、230 輸出。全月總計輸入 **3.654 MTok**、輸出 **0.145 MTok**。
  - 快取分配：快取命中約 70%（2.558 MTok 快取、1.096 MTok 未快取、0.145 MTok 輸出）。
  - 推理模型分配（gpt-oss on Groq）：輸出含思維鏈思考 tokens，估計約 **0.445 MTok**。

---

### 2. 候選模型單價基準（官方頁一手查證，查詢日期：2026-11-16）

| 模型名稱 | 供應商 | 輸入單價 (USD/1M) | 輸出單價 (USD/1M) | 快取讀取單價 (USD/1M) | 官方數據來源 |
|---|---|---|---|---|---|
| **Claude Haiku 5.5** | Anthropic | **0.100 USD** | **0.500 USD** | **0.010 USD** | `https://docs.anthropic.com/en/docs/about-claude/pricing` |
| **Gemini 3.1 Flash-Lite** | Google Cloud | **0.250 USD** | **1.500 USD** | **0.0625 USD** | `https://aistudio.google.com/docs/pricing` |
| **gpt-oss-120b** | GroqCloud | **0.150 USD** | **0.600 USD** | — | `https://console.groq.com/docs/models` |
| **gpt-oss-20b** | GroqCloud | **0.075 USD** | **0.300 USD** | — | `https://console.groq.com/docs/models` |

---

### 3. 用途一：專案助理（Discord Bot 查進度）試算

1. **【主選推薦】`Claude Haiku 5.5`（Anthropic API）**
   - 快取版本費用：
     - 快取命中：$7.35 \times 0.010 = 0.0735\text{ USD}$
     - 未快取輸入：$1.05 \times 0.100 = 0.1050\text{ USD}$
     - 輸出：$1.05 \times 0.500 = 0.5250\text{ USD}$
     - **全月總額：0.704 USD / 月**（約新台幣 23 元）。無快取為 **1.365 USD / 月**。
   - 推薦理由：繁中口吻最受團隊好評，且單價與快取費率均極低，全月僅約 0.70 USD。
2. **【備選推薦】`Gemini 3.1 Flash-Lite`（Google AI Studio 付費層）**
   - 快取版本費用：
     - 快取命中：$7.35 \times 0.0625 = 0.4594\text{ USD}$
     - 未快取輸入：$1.05 \times 0.250 = 0.2625\text{ USD}$
     - 輸出：$1.05 \times 1.500 = 1.5750\text{ USD}$
     - **全月總額：2.297 USD / 月**（約新台幣 74 元）。無快取為 **3.675 USD / 月**。
   - 評估：現行未棄用之 3.1 Flash-Lite 輸出費率較高，無快取下月費約 3.68 USD，成本高於 Haiku 5.5。
3. **【第三方備選】`gpt-oss-120b`（GroqCloud 付費層）**
   - 費用計算（含思維鏈輸出）：
     - 輸入：$8.40 \times 0.150 = 1.260\text{ USD}$
     - 輸出：$2.10 \times 0.600 = 1.260\text{ USD}$
     - **全月總額：2.520 USD / 月**（約新台幣 81 元）。
   - 評估：LPU 推理極速（回應 <1 秒），但思考 token 使輸出費用略高。

---

### 4. 用途二：Hindsight retain（專案記憶寫入萃取）試算

1. **【主選推薦】`Claude Haiku 5.5`（Anthropic API）**
   - 快取版本費用：
     - 快取命中：$2.558 \times 0.010 = 0.0256\text{ USD}$
     - 未快取輸入：$1.096 \times 0.100 = 0.1096\text{ USD}$
     - 輸出：$0.145 \times 0.500 = 0.0725\text{ USD}$
     - **全月總額：0.208 USD / 月**（約新台幣 7 元）。無快取為 **0.438 USD / 月**。
   - 推薦理由：在 Gemini 3.1 Flash-Lite 單價較高的情況下，Haiku 5.5 成為萃取成本最低且精度極高之選擇。
2. **【備選推薦】`Gemini 3.1 Flash-Lite`（Google AI Studio 付費層）**
   - 快取版本費用：
     - 快取命中：$2.558 \times 0.0625 = 0.1599\text{ USD}$
     - 未快取輸入：$1.096 \times 0.250 = 0.2740\text{ USD}$
     - 輸出：$0.145 \times 1.500 = 0.2175\text{ USD}$
     - **全月總額：0.651 USD / 月**（約新台幣 21 元）。無快取為 **1.131 USD / 月**。
   - 推薦理由：Hindsight 官方原生深度支援 Gemini 驅動。
3. **【第三方備選】`gpt-oss-120b`（GroqCloud 付費層）**
   - 費用計算（含思維鏈輸出）：
     - 輸入：$3.654 \times 0.150 = 0.548\text{ USD}$
     - 輸出：$0.445 \times 0.600 = 0.267\text{ USD}$
     - **全月總額：0.815 USD / 月**（約新台幣 26 元）。
   - 評估：Hindsight 原生預設支援，但思考耗時會增加 2～5 秒交接延遲。

---

### 5. 全系統部署方案組合與總持有成本（TCO）重算對照表

針對 7 人團隊（S2 階段），全月 LLM 總開銷方案重算如下（均以付費層實付現金計）：

| 方案組合 | 專案助理（Discord） | Hindsight Retain | 助理月費 (USD) | Retain 月費 (USD) | **全系統 LLM 月總費 (USD)** | **折合新台幣** | 特性與建議 |
|---|---|---|---|---|---|---|---|
| **方案 B：純 Anthropic 方案（強烈推薦）** | **Claude Haiku 5.5** | **Claude Haiku 5.5** | **0.70 USD** | **0.21 USD** | **0.91 USD** | **約 NT 30** | **綜合最優解**：月費最低（不到 1 美元）、繁中最佳、單一 API 最易維護。 |
| **方案 A：混合方案（Claude 助理 ＋ Gemini 記憶）** | **Claude Haiku 5.5** | **Gemini 3.1 Flash-Lite** | 0.70 USD | 0.65 USD | **1.35 USD** | **約 NT 44** | 專案助理享受最優繁中，記憶走 Google 官方深度支援。 |
| **方案 D：Groq gpt-oss 混合方案** | **Claude Haiku 5.5** | **gpt-oss-120b (Groq)** | 0.70 USD | 0.82 USD | **1.52 USD** | **約 NT 49** | 專案助理維持最佳體驗，後端記憶走 維護者 既有 Groq。 |
| **方案 C：純 Google 體系方案** | **Gemini 3.1 Flash-Lite** | **Gemini 3.1 Flash-Lite** | 2.30 USD | 0.65 USD | **2.95 USD** | **約 NT 96** | 全走 Google AI Studio 付費層（因 3.1 定價較高，總費略高於 Claude）。 |
| **方案 E：純 Groq gpt-oss 方案** | **gpt-oss-120b (Groq)** | **gpt-oss-120b (Groq)** | 2.52 USD | 0.82 USD | **3.34 USD** | **約 NT 108** | 全走 維護者 既有 Groq 帳戶（需開通綁卡 Developer Plan）。 |

---

## 四、待確認事項與後續交接

### 1. 待確認事項（待 維護者 決策或提供）

1. **GroqCloud 帳戶綁卡開通狀態**：
   - 維護者 之 Groq 帳戶是否已綁定信用卡開通 **Developer Plan（Pay-as-you-go）**？若為免費層，受 8,000 TPM 與 100k TPD 限制，無法承載 Hindsight 與 Discord Bot。
2. **Google Developer Program 點數折抵真實性**：
   - 經官方文檔查證，點數能否直接無條件折抵 Google AI Studio API 帳單尚無明確條款背書，目前列為待確認；因此暫不將其作為主力零成本依據。
3. **D-4 LLM 最終選型決策（2026-11-18 前定案）**：
   - 請 維護者 在 G2/G3 前定案選擇【方案 B 純 Anthropic】（約 0.91 USD/月，推薦）、【方案 A 混合】（約 1.35 USD/月）或【方案 D Groq 混合】（約 1.52 USD/月）。

### 2. 官方文檔與程式碼引用索引

- **Google 官方價目與條款**：
  - AI Studio Pricing: `https://aistudio.google.com/docs/pricing`（2026-11-16 查詢）
  - Gemini API Terms: `https://ai.google.dev/gemini-api/terms`（2026-11-16 查詢）
- **Groq 官方文檔與定價**：
  - Groq Models: `https://console.groq.com/docs/models`（2026-11-16 查詢）
  - Groq Rate Limits: `https://console.groq.com/docs/rate-limits`（2026-11-16 查詢）
  - Groq Privacy & Services Agreement: `https://groq.com/privacy-policy/`、`https://groq.com/services-agreement/`（2026-11-16 查詢）
- **Anthropic 官方價格**：
  - Anthropic Pricing: `https://docs.anthropic.com/en/docs/about-claude/pricing`（2026-11-16 查詢）
- **Hindsight 專案來源（commit `5318be8`）**：
  - 文檔：`hindsight-docs/docs/developer/models.mdx`（Groq 8k TPM 限制見 L161；Gemini 見 L145；OpenAI 相容端點見 L99）
  - 核心工廠：`hindsight-api-slim/hindsight_api/engine/llm_wrapper.py`（L628–L895）
