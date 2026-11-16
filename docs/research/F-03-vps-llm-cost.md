# F-03 可行性調研報告：VPS 選擇與專案助理 LLM 費用評估（修訂版 v2）

- **報告負責**：agy-junior-swe-2（Antigravity）
- **審查人**：PM-Emily（Claude）｜**決策人**：維護者
- **修訂日期**：2026-11-16
- **狀態**：完成（依據最新實測數據 F-05 Hindsight 峰值 RSS ~1.5 GB、F-01b Agent Mail ~250–370 MiB、Caddy ~46 MiB，新增 2 GB / 4 GB 升級評估與官方報價）
- **依據與背景**：
  - Brief（`docs/01-brief.md`）：限制個人預算（原預估 VPS 約 US$5/月；S1/S2 LLM 費用由 維護者 付費並設每日上限）、維護者 一人維運。
  - 實測新證據：依主目錄實測報告（`docs/research/F-05-hindsight-spike.md` 與 `docs/research/F-01b-agent-mail-rust.md`），本機載入 embedding/reranker 模型之 Hindsight 峰值 RSS 達 **1,527 MB**、Agent Mail 每組最高取樣達 **369 MiB**、Caddy 約 **46 MiB**。原 1 GB 方案已證實**不足以負載完整系統**。
  - 對應待決事項：**D-2（VPS 供應商、機房地區與記憶體規格）**、假設 **A-3（專案助理費用在預算上限內足夠 S1、S2 使用）**。
  - 調研方法：依據專案流程 `feasibility` 與 PM 審查標準，全面採用官方頁面與官方 REST API 之一手數據，逐字引用，不使用過期記憶。

---

## 一、專案助理 LLM 費用估算與防護機制（A-3 驗證）

### 1. Anthropic 官方價格頁逐字引用

- **官方來源網址**：[`https://docs.anthropic.com/en/docs/about-claude/pricing`](https://docs.anthropic.com/en/docs/about-claude/pricing)
- **查詢日期**：2026-11-16
- **現行最新 Haiku 型號**：**`Claude Haiku 5.5`**（Anthropic 最新一代輕量快速模型）

#### 官方文件表格逐字引用（Table 0: Model Pricing）

```text
Model | Base tokens | Prompt caching
Name | Input | Output | 5m writes | 1h writes | Hits and refreshes
Claude Haiku 5.5 For high-volume, latency-sensitive tasks such as classification, extraction, and routing | $0.10 / MTok for prompts up to 100,000 tokens | $0.50 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok
```

> **官方定價細節補充**：
> - **Input Token（輸入，100k tokens 內）**：**0.10 USD / MTok**（即 0.00010 USD / 1k tokens）
> - **Input Token（超過 100k tokens）**：0.50 USD / MTok
> - **Output Token（輸出）**：**0.50 USD / MTok**（即 0.00050 USD / 1k tokens）
> - **Prompt Caching 5-minute Writes（快取寫入）**：0.125 USD / MTok
> - **Prompt Caching 1-hour Writes（快取寫入）**：0.20 USD / MTok
> - **Prompt Caching Hits and Refreshes（快取命中讀取）**：**0.01 USD / MTok**（相較於無快取輸入費降了 90%！）
>
> *(備註：舊版 Claude 3.5 Haiku 原定價 0.80/4.00 USD 已屬前代歷史資料；現行官方最新部署型號為 Claude Haiku 5.5，單價大幅降低 80%~87%。)*

---

### 2. 單次提問成本基準計算（Claude Haiku 5.5）

- **情境假設**：
  - 輸入：約 4,000 tokens（遠低於 100k 門檻，適用 0.10 USD / MTok 費率）
  - 輸出：約 500 tokens（適用 0.50 USD / MTok 費率）

#### (1) 標準無快取（Uncached）單次費用
$$\text{輸入費用} = \frac{4,000}{1,000,000} \times 0.10\text{ USD} = 0.00040\text{ USD}$$
$$\text{輸出費用} = \frac{500}{1,000,000} \times 0.50\text{ USD} = 0.00025\text{ USD}$$
$$\textbf{單次問答總成本} = 0.00040 + 0.00025 = \mathbf{0.00065\text{ USD}}\text{（約新台幣 0.021 元，即約 2 分錢）}$$

#### (2) 啟用 Prompt Caching 單次費用
專案助理之輸入中，系統提示詞（System Prompt）與專案規則約佔 3,500 tokens，可常駐快取；每次使用者動態輸入約 500 tokens。
$$\text{快取命中輸入（3,500 tokens）} = \frac{3,500}{1,000,000} \times 0.01\text{ USD} = 0.000035\text{ USD}$$
$$\text{動態未快取輸入（500 tokens）} = \frac{500}{1,000,000} \times 0.10\text{ USD} = 0.000050\text{ USD}$$
$$\text{動態輸出（500 tokens）} = \frac{500}{1,000,000} \times 0.50\text{ USD} = 0.000250\text{ USD}$$
$$\textbf{快取後單次問答總成本} = 0.000035 + 0.000050 + 0.000250 = \mathbf{0.000335\text{ USD}}\text{（相較無快取再降 48.5%）}$$

---

### 3. 情境月費重算（每月以 30 天計）

| 使用情境 | 每日問答量 | 無快取每日費用 | 無快取每月費用 (30天) | 快取版本每日費用 | 快取版本每月費用 (30天) |
|---|---|---|---|---|---|
| **情境 A：S2 階段（7 人組內）**<br>每人每天 10 次 | 70 次/天 | **0.0455 USD / 天**<br>(約 NT 1.48) | **1.365 USD / 月**<br>(約 NT 44.4) | **0.0235 USD / 天**<br>(約 NT 0.76) | **0.704 USD / 月**<br>(約 NT 22.9) |
| **情境 B：S3 階段（35 人全班）**<br>每人每天 10 次 | 350 次/天 | **0.2275 USD / 天**<br>(約 NT 7.39) | **6.825 USD / 月**<br>(約 NT 221.8) | **0.1173 USD / 天**<br>(約 NT 3.81) | **3.518 USD / 月**<br>(約 NT 114.3) |

> **成本結論**：
> 採用最新 Claude Haiku 5.5 後，**S2 組內 7 人全月 LLM 總開銷僅約 0.70 ~ 1.37 USD（約新台幣 23 ~ 45 元）**！就算擴大至全班 35 人，月費亦僅約 3.52 ~ 6.83 USD（約新台幣 115 ~ 222 元）。原 Brief 假設 A-3 完全成立，且遠低於原預估負擔。

---

### 4. 每日上限建議評估：0.50 USD / 天 是否仍合理？

- **分析評估**：
  1. **正常用量對比**：S2 階段（7 人）全組每日正常耗費僅為 **0.0455 USD / 天**（快取後僅 0.0235 USD / 天）。
  2. **容錯與防護倍數**：若維持 **0.50 USD / 天** 上限，相當於正常日用量的 **11 倍**。這代表：
     - 組員在專案衝刺期即使單日提問量爆發至 700 次，也不會誤觸熔斷。
     - 若遭遇程式無窮迴圈、Discord 機器人回覆無限循環、或 API 金鑰異常洩漏，每日最大損害將被嚴格卡死在 0.50 USD（約新台幣 16 元）。
  3. **35 人規模適用性**：即使在 S3 階段全班 35 人正常用量 0.2275 USD / 天 下，0.50 USD / 天 依然能提供 2.2 倍的裕度（可支援單日約 770 次提問）。
- **具體設定建議**：
  - **維持每日全域熔斷上限為 0.50 USD / 天**：作為系統緊急安全防暴衝天花板（Anti-runaway Hard Cap）。
  - **新增個人每日配額（Per-User Quota）**：Discord Bot 記錄每人每天最多 10 次提問，避免單一組員或單一腳本佔用當日過多額度。
  - **Anthropic Console 設定**：
    - 帳戶採用預付儲值（Prepaid Balance），初始存入 10.00 USD。
    - 設定 Monthly Spend Limit 為 15.00 USD，設定 75%（11.25 USD）告警通知。

---

## 二、VPS 候選基礎比較（1 GB 方案回顧與排除原因）

### 1. 候選服務商 1 GB 規格與定價查證（查詢日期：2026-11-16）

| 服務商與方案 | 方案名稱與月費 (官方 API/頁面引用) | 規格 (vCPU / RAM / SSD) | 台灣附近機房 | 流量配額 | 付款方式與門檻 | 一人維運與結論 |
|---|---|---|---|---|---|---|
| **Vultr** | `vc2-1c-1gb`<br>**5.00 USD / 月**<br>*(官方 API)* | 1 vCPU<br>1 GB RAM<br>25 GB SSD | **東京 (nrt)**<br>新加坡 (sgp) | 1 TB/月 | 台灣信用卡、簽帳卡、PayPal；免證件審核 | 原推薦 1GB 首選；但實測已證實 1GB 不足。 |
| **Linode** | `Nanode 1GB`<br>**5.00 USD / 月**<br>*(官方 API)* | 1 vCPU<br>1 GB RAM<br>25.6 GB SSD | **東京 (jp-tyo)**<br>新加坡 (sg-sin) | 1 TB/月 | 台灣信用卡、PayPal | 原推薦 1GB 備選；但實測已證實 1GB 不足。 |
| **DigitalOcean** | `Basic Droplet (1GB)`<br>**6.00 USD / 月** | 1 vCPU<br>1 GB RAM<br>25 GB SSD | 新加坡 (sgp1)<br>*(無東京機房)* | 1 TB/月 | 台灣信用卡、PayPal | 不推薦：$4 僅 512MB RAM；1GB 需 $6 且無東京節點。 |
| **Hetzner** | `CPX12`<br>**15.99 EUR / 月 (未稅)**<br>*(官方頁面)* | 1 vCPU (AMD)<br>2 GB RAM<br>40 GB NVMe | 新加坡 (sin)<br>*(無平價 CX)* | 依地區分配 | 信用卡、PayPal；⚠️ 新用戶需護照審核 | 不推薦：新加坡月費約 17.3 USD；歐洲機房延遲 >250ms。 |
| **Oracle Cloud** | `Always Free A1`<br>**0.00 USD / 月** | 4 vCPU<br>24 GB RAM | 東京、新加坡 | 10 TB/月 | 需綁定信用卡 | 不推薦：台灣發行卡極難通過，亞洲節點常態 Out of Capacity，7天閒置回收。 |

> **官方來源存取註記**：
> 1. Vultr 官網首頁遭 Cloudflare Turnstile 攔截，價格數據由官方公開 API（`https://api.vultr.com/v2/plans`）取得。方案 `vc2-1c-1gb` 逐字包含 `"monthly_cost": 5`。
> 2. Linode 官網轉址後遭 Akamai Bot Manager HTTP 403 攔截，價格數據由官方公開 API（`https://api.linode.com/v4/linode/types`）取得。方案 `g6-nanode-1` 標籤為 `"Nanode 1GB"`，逐字包含 `"monthly": 5.0`。
> 3. Hetzner 新加坡最低方案經官網（`https://www.hetzner.com/cloud-singapore/`）逐字查得為 `CPX12`，未稅月費 `15.99 EUR`（約 17.30 USD）。官方文件（`docs.hetzner.com/cloud/general/locations/`）載明新加坡非自有機房、營運成本高而採個別定價（different prices），無固定「20–40%」條款文字。

---

## 三、VPS 記憶體容量升級評估（因應實測負載：2 GB 與 4 GB 方案）

### 1. 背景與實測數據瓶頸

依據專案真實實測證據（主目錄 `docs/research/F-05-hindsight-spike.md` 與 `docs/research/F-01b-agent-mail-rust.md`）：
- **Hindsight 專案記憶引擎**：本機載入 embedding 與 reranker 模型時，**峰值 RSS 高達 1,527 MB**（內嵌 Postgres 約 100 MB，合計約 1.6 GB）。
- **MCP Agent Mail**：實測取樣單組 RSS 為 **250 – 370 MiB**（F-01b 保守採計 384 MiB / 組）。
- **Caddy 反向代理**：約 **46 MiB**。
- **Linux 系統常駐**：Ubuntu OS、systemd、sshd、Docker daemon 等基礎保留約 **256 – 300 MiB**。
- **Discord Bot / Bridge**：約 **50 – 80 MiB**。

**瓶頸結論**：原 5.00 USD / 月 的 1 GB 方案（1,024 MB）在啟動 Hindsight 時即會立刻觸發 Linux OOM Killer 導致伺服器崩潰，**確定無法使用**。必須升級至 2 GB 或 4 GB 方案。

---

### 2. 官方方案名稱與月費逐字引用（2 GB 與 4 GB 方案）

所有數據均調用各服務商官方公共 REST API 查證（查詢日期：**2026-11-16**）：

#### (1) Vultr 東京機房（Tokyo, `nrt`）官方 API 逐字引用
- **資料來源 API**：[`https://api.vultr.com/v2/plans`](https://api.vultr.com/v2/plans)（查詢日期：2026-11-16）
- **2 GB 方案逐字引用**：
  ```json
  {
    "id": "vc2-1c-2gb",
    "type": "vc2",
    "vcpu_count": 1,
    "ram": 2048,
    "disk": 55,
    "bandwidth": 2048,
    "monthly_cost": 10,
    "hourly_cost": 0.014
  }
  ```
  - **方案名稱 / ID**：`vc2-1c-2gb`（Cloud Compute - Regular Performance）
  - **月費**：**10.00 USD / 月**（小時計費 0.014 USD / 小時）
  - **規格**：1 vCPU / 2048 MB RAM (2 GB) / 55 GB SSD / 2 TB 頻寬
- **4 GB 方案逐字引用**：
  ```json
  {
    "id": "vc2-2c-4gb",
    "type": "vc2",
    "vcpu_count": 2,
    "ram": 4096,
    "disk": 80,
    "bandwidth": 3072,
    "monthly_cost": 20,
    "hourly_cost": 0.027
  }
  ```
  - **方案名稱 / ID**：`vc2-2c-4gb`（Cloud Compute - Regular Performance）
  - **月費**：**20.00 USD / 月**（小時計費 0.027 USD / 小時）
  - **規格**：2 vCPU / 4096 MB RAM (4 GB) / 80 GB SSD / 3 TB 頻寬

---

#### (2) Linode / Akamai 東京機房（Tokyo, `jp-tyo`）官方 API 逐字引用
- **資料來源 API**：[`https://api.linode.com/v4/linode/types`](https://api.linode.com/v4/linode/types)（查詢日期：2026-11-16）
- **2 GB 方案逐字引用**：
  ```json
  {
    "id": "g6-standard-1",
    "label": "Linode 2GB",
    "memory": 2048,
    "vcpus": 1,
    "disk": 51200,
    "transfer": 2000,
    "price": {
      "hourly": 0.018,
      "monthly": 12.0
    },
    "addons": {
      "backups": {
        "price": {
          "monthly": 2.5
        }
      }
    }
  }
  ```
  - **方案名稱 / 標籤**：`Linode 2GB`（方案 ID: `g6-standard-1`）
  - **月費**：**12.00 USD / 月**（小時計費 0.018 USD / 小時；備份外掛 +2.50 USD / 月）
  - **規格**：1 vCPU / 2048 MB RAM (2 GB) / 50 GB SSD / 2 TB 流量
- **4 GB 方案逐字引用**：
  ```json
  {
    "id": "g6-standard-2",
    "label": "Linode 4GB",
    "memory": 4096,
    "vcpus": 2,
    "disk": 81920,
    "transfer": 4000,
    "price": {
      "hourly": 0.036,
      "monthly": 24.0
    },
    "addons": {
      "backups": {
        "price": {
          "monthly": 5.0
        }
      }
    }
  }
  ```
  - **方案名稱 / 標籤**：`Linode 4GB`（方案 ID: `g6-standard-2`）
  - **月費**：**24.00 USD / 月**（小時計費 0.036 USD / 小時；備份外掛 +5.00 USD / 月）
  - **規格**：2 vCPU / 4096 MB RAM (4 GB) / 80 GB SSD / 4 TB 流量

---

### 3. 容量需求推算與選型建議

#### (1) 情境一：「S1/S2 一組」記憶體需求估算
- **服務清單與預估佔用**：
  - Linux OS、systemd、Docker：~300 MiB
  - Caddy 反向代理：~46 MiB
  - Agent Mail（1 組）：~370 MiB
  - Discord Bot：~80 MiB
  - Hindsight（含內嵌 Postgres，峰值載入本機模型）：~1,527 MiB
- **合計峰值需求**：
  $$300 + 46 + 370 + 80 + 1,527 \approx \mathbf{2,323 \text{ MiB}}\text{（約 2.27 GiB）}$$
- **容量等級匹配分析**：
  - **2 GB 方案（2,048 MB）**：**不足／極度危險**。峰值需求 2.32 GB 已超出實體記憶體，即使配置 Swap，模型載入時也會引發嚴重 Swap Thrashing，導致系統延遲劇增或連線逾時。
    *(例外架構路線：若後續 SAD 設計將 Hindsight 的 Embedding/Reranker 改為呼叫外部雲端 API，Hindsight 閒置常駐僅約 350 MB，則 2 GB 即可容納；但在本機全功能部署前提下，2 GB 不夠。)*
  - **4 GB 方案（4,096 MB）**：**推薦安全規格**。峰值佔用約 57%，剩餘 1.7 GB 可供系統緩衝與 I/O Page Cache，保證穩定運行零 OOM。
- **S1/S2 結論**：在現有本機模型架構下，**S1/S2 需配置 4 GB 方案（Vultr 為 20.00 USD / 月；Linode 為 24.00 USD / 月）**。

---

#### (2) 情境二：「S3 五組」記憶體需求估算
- **服務清單與預估佔用**：
  - Linux OS、Docker 常駐：~384 MiB
  - Caddy 反向代理（共用實例）：~46 MiB
  - Agent Mail（5 組獨立進程）：$5 \times 370\text{ MiB} \approx \mathbf{1,850 \text{ MiB}}$（約 1.8 GiB）
  - Discord Bot：~100 MiB
  - Hindsight（共用單一實例／多個 Memory Bank）：峰值約 1,600 MiB
- **合計峰值需求**：
  $$384 + 46 + 1,850 + 100 + 1,600 \approx \mathbf{3,980 \text{ MiB}}\text{（約 3.89 GiB）}$$
- **容量等級匹配分析**：
  - **2 GB 方案**：完全不可行。
  - **4 GB 方案（4,096 MB）**：**緊繃臨界點（佔比約 97%）**。若五組同時活躍並發送交接訊息，記憶體將達到上限。
- **S3 結論**：
  - 若維持現有架構，4 GB 方案必須搭配**架構輕量化**（如 Agent Mail 進程整併、或 Hindsight 改用外部 Embedding 節省 1.2 GB 記憶體，使總量降至 2.8 GB 內），此時 **4 GB 方案（Vultr 20.00 USD / 月 或 Linode 24.00 USD / 月）** 即可平穩支撐全班五組。
  - 若不做任何記憶體優化，S3 五組在並行高峰需考慮預留 8 GB 方案。

---

## 四、一人維運方案：備份、HTTPS 與存活監控（零額外成本）

```
                  ┌──────────────────────────────────────────────┐
                  │            VPS (Vultr Tokyo 4GB)             │
  [外部存活監控]   │                                              │
  Better Stack ───┼──> HTTPS (443) ──> [Caddy 反向代理]           │
  (免費 3分探測)  │                   (自動 Let's Encrypt 證書)   │
                  │                           │                  │
                  │                           ▼                  │
                  │                   [Hub / Agent Mail]         │
                  │                   [Discord Bot 容器]         │
                  │                           │                  │
                  │                           ▼                  │
                  │                   [Hindsight / SQLite]       │
                  │                           │                  │
                  │                   [每日 cron 備份]           │
                  └───────────────────────────┼──────────────────┘
                                              ▼
                             [免費 Cloudflare R2 雲端儲存]
```

1. **自動備份（Automated Backups）**：
   - 採用 Linux 排程 `cron` + `restic`。
   - 每日凌晨自動將資料庫加密傳送至 **Cloudflare R2**（官方免費額度每月 10 GB 儲存空間，下載出流量完全免費，網址：[`cloudflare.com/developer-platform/r2/`](https://www.cloudflare.com/developer-platform/r2/)）。
   - 軟體與儲存費用：**0.00 USD / 月**。
2. **自動 HTTPS 憑證管理**：
   - 採用 **Caddy Web Server**（官方網站：[`caddyserver.com`](https://caddyserver.com/)）。
   - 內建 Let's Encrypt / ZeroSSL 自動簽發與自動續簽，反向代理設定僅需 3 行 `Caddyfile`，記憶體佔用僅 46 MiB。
   - 費用：**0.00 USD / 月**。
3. **存活監控（Uptime Monitoring）**：
   - 採用 **Better Stack (Better Uptime) Free Tier**（官方網址：[`betterstack.com`](https://betterstack.com/)，查詢日期：2026-11-16）。
   - 免費方案包含：**10 個 Monitors**、**3 分鐘檢查頻率**、支援 Email 與 Discord Webhook 異常告警、贈送 1 個公開狀態頁。
   - 費用：**0.00 USD / 月**。

---

## 五、總結與 G1 Gate 決策建議

### 1. 專案整體月維護總成本（TCO）更新

因應 Hindsight 實測峰值 1.5 GB，VPS 規格調整為 4 GB 方案重估：

| 項目 | 採用方案 | S2 月費用 (7人一組) | S3 月費用 (35人五組) | 備註 |
|---|---|---|---|---|
| **VPS 伺服器** | Vultr 東京 4GB (`vc2-2c-4gb`) | **20.00 USD** | **20.00 USD** | 2 vCPU / 4GB RAM / 80GB SSD / 3TB 流量 |
| *(若採 Linode)* | Linode 東京 4GB (`Linode 4GB`) | *(24.00 USD)* | *(24.00 USD)* | 2 vCPU / 4GB RAM / 80GB SSD / 4TB 流量 |
| **專案助理 LLM** | Claude Haiku 5.5 (啟用 Prompt Caching) | **0.70 USD**<br>(無快取約 1.37) | **3.52 USD**<br>(無快取約 6.83) | 採官方最新 0.10/0.50 MTok 重算 |
| **自動備份** | cron + restic + Cloudflare R2 | **0.00 USD** | **0.00 USD** | 免費額度 10GB 內 |
| **HTTPS 憑證** | Caddy + Let's Encrypt | **0.00 USD** | **0.00 USD** | 全自動免維護 |
| **存活監控** | Better Stack Free Tier | **0.00 USD** | **0.00 USD** | 3 分鐘頻率 + Discord 告警 |
| **合計總月費** | **全專案月維運開銷 (採 Vultr)** | **約 20.70 ~ 21.37 USD / 月**<br>**(約新台幣 670 ~ 695 元)** | **約 23.52 ~ 26.83 USD / 月**<br>**(約新台幣 760 ~ 870 元)** | **支撐全功能本機 Hindsight** |

---

### 2. G1 Gate 決策建議（對應 D-2 與預算）

1. **VPS 規格升級決策（D-2）**：
   - **實測結論**：1 GB 方案（5.00 USD/月）無法容納 Hindsight 峰值 1.5 GB，確定淘汰。
   - **建議選型**：首選 **Vultr 東京機房 4 GB 方案（`vc2-2c-4gb`，月費 20.00 USD / 月）**。
     - 次選：Linode 東京機房 4 GB 方案（`Linode 4GB`，月費 24.00 USD / 月）。
     - S1/S2 一組峰值約 2.27 GiB，4 GB 方案佔比 57%，穩定不當機；S3 五組峰值約 3.89 GiB，在 4 GB 下搭配輕量化架構即可穩定運作。
2. **預算確認**：
   - VPS 升至 4 GB 後，S2 總持有成本從原估計約 6 USD 上調至約 **20.70 USD / 月（約新台幣 670 元）**。
   - 請 維護者 於 G1 Gate 確認此預算調整是否在自費可接受範圍內；若需嚴格壓回 10 USD 預算，則需在 T7（SAD）將 Hindsight 改用外部 Embedding API，以換取退回 2 GB 方案（Vultr 10.00 USD / 月）。
3. **專案助理 LLM 決策**：
   - 確認採用 **`Claude Haiku 5.5`**，啟用 **Prompt Caching**。
   - 每日上限維持 **0.50 USD / 天** 作為安全防暴衝熔斷機制。
