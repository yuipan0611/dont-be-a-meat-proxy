# v5 深色科技介面獨立視覺審查

最終：**Resolved — ship**。獨立 Codex `tech_visual_review` 先看 Terax／InsForge 參考截圖，再看桌面、手機各六個場景。未操作瀏覽器、未修改程式。

## 第一輪

- Persistence：目前頁、選取、流程步驟、來源與目錄狀態可辨識；不以截圖宣稱 server 保存。
- TYPE：Inter／Geist Mono 符合使用者提供的參考。保留它們，不能為通用「字型過度使用」警告而換掉已指定的風格。
- MATERIAL：深色階、薄框、薄荷綠選取、等寬 metadata 與畫布幾何成功轉譯參考元素，保留原有 app 版型，未看到複製品牌。
- Ceiling：VPS 關係密集沿用既有圖的組成，不是這次主題的阻擋問題。

唯一 material fix：播放中按鈕顯示「暫停」卻仍是三角播放圖示。應依 playing 狀態顯示 pause/play SVG；不用重建版型。

## 修正與複查

`6d9c25c` 改為播放中雙直線暫停圖示、暫停後三角播放圖示。Playwright 於桌面／手機都檢查兩種狀態並重新截圖。

複查 `tech-desktop-flow.png` 與 `tech-mobile-flow.png`：**resolved**，圖示與文字一致，視覺風格維持。最終 **ship**。

保留薄荷綠作用節點、可讀來源區、克制命令面板、同步高亮、小地圖、畫布背景、字型與 reduced-motion 行為。沒有截圖可見的對比阻擋問題；computed contrast 記錄比視覺推估更強。

設計 detector 原始 187 項（182 advisory、5 warning）保留：字型兩項是明確參考的選擇，字型文件兩項及 palette advisory 由新 DESIGN.md 記錄；stroke-width transition 已移除。未重跑 detector，也不宣稱機器警告已清零。
