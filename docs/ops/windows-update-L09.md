# Windows 客戶端更新（L-09）

適用於 維護者 桌面的 `hub-win`（A 組、Windows agent `RedStone`）。PM 提供的下載檔是 `hub-win-L09-update.zip`，包含完整的 `client/`、`ops/lifecycle/` 和 `SHA256SUMS.txt`。下載包沒有憑證。沿用原本的 `.hub-local/`、`.mcp.json`、`.claude/settings.json` 和啟動腳本。

比對基準是 PM 最初交付的 `hub-win.zip`。其中 `client/` 和 `ops/lifecycle/` 的 7 個檔案逐一核對，與當初的 master `9e14fbb` 一致。本包使用 L-09 上線後的 master `03eb622` 的客戶端檔案，另帶入 P-6 的 SessionStart 提醒（`c6cd3c4`）。Windows 中途換過版也照同一套步驟更新。 [MVP 交付紀錄](../delivery-MVP.md) · [S1 驗收紀錄](../delivery-S1.md)

## 1. 下載、解壓縮、核對檔案

🟡 1. 在原本的 Hub Claude Code 輸入 `/exit`；若顯示背景工作提示，選 **Exit and stop tasks**。

🟡 2. 從 PM 的 Google Drive 下載 `hub-win-L09-update.zip` 並放到桌面。

🟡 3. 開一個 PowerShell 視窗，把下方整段貼上執行。看到 `ZIP SHA256 OK` 才繼續。

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $root = Join-Path $desktop 'hub-win'
  $source = Join-Path $desktop 'hub-win-L09-update'
  $zip = Join-Path $desktop 'hub-win-L09-update.zip'
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne '5c3c7f8bc516acd9e612755c7dfceb1227b34430f7548cde2823ddfd6cc2aaa7') {
    throw 'ZIP SHA256 不符，請重新下載'
  }
  'ZIP SHA256 OK'
  if (Test-Path -LiteralPath $source) { throw '桌面已有同名解壓資料夾，請先將它改名' }
  Expand-Archive -LiteralPath $zip -DestinationPath $source
  $manifest = Join-Path $source 'SHA256SUMS.txt'
  function Test-L09Files($folder) {
    $entries = @(Get-Content -LiteralPath $manifest)
    if ($entries.Count -ne 24) { throw '檔案清單應有 24 筆' }
    foreach ($entry in $entries) {
      $expected, $relative = $entry -split '  ', 2
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $folder $relative)).Hash
      if ($actual -ne $expected) { throw "SHA256 不符：$relative" }
    }
    '24 files SHA256 OK'
  }
  Test-L09Files $source
}
```

🟡 4. 確認最後一行是 `24 files SHA256 OK`。若有紅字，先停在這裡；桌面上的舊版還可照原方式開啟。

## 2. 備份並換檔

🟡 1. 在同一個 PowerShell 視窗貼上下方整段。先把舊檔放到桌面上有時間戳記的備份資料夾，再複製新檔。

```powershell
. {
  $backup = Join-Path $desktop ('hub-win-L09-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  Get-Item -LiteralPath (Join-Path $root 'client'), (Join-Path $root 'ops/lifecycle'), (Join-Path $root 'hub-client.json') | Out-Null
  New-Item -ItemType Directory -Path $backup | Out-Null
  Write-Output "備份位置 $backup"
  Copy-Item -LiteralPath (Join-Path $root 'hub-client.json') -Destination $backup
  Move-Item -LiteralPath (Join-Path $root 'client') -Destination $backup
  Move-Item -LiteralPath (Join-Path $root 'ops/lifecycle') -Destination $backup
  Copy-Item -LiteralPath (Join-Path $source 'client') -Destination $root -Recurse
  Copy-Item -LiteralPath (Join-Path $source 'ops/lifecycle') -Destination (Join-Path $root 'ops') -Recurse
  Test-L09Files $root
}
```

🟡 2. 記下畫面上的「備份位置」；看到 `24 files SHA256 OK` 才繼續，有紅字就跳到「還原」。

🟡 3. 執行 `notepad (Join-Path $root 'hub-client.json')`，開啟 `hub-win` 根目錄裡的設定。

🟡 4. 在 `"clock_agent"` 那行後面新增 `"memory_agent": "NavyOrchid",`；若已經有 `memory_agent`，直接把值改成 `NavyOrchid`。

🟡 5. 用 UTF-8（無 BOM）存檔，並保留原設定的其他值。

以下是 A 組完整範例。`memory_agent` 是 MemoryBridge 的公開名稱；新交接、checkpoint、決策會透過它同步，之前送過的交接另由 PM 處理。

```json
{
  "v": 1,
  "group_id": "group-a",
  "project_key": "/data/projects/group-a",
  "hub_mail_url": "https://hub.example.invalid/mcp/",
  "agents": { "darwin": "BlueLake", "win32": "RedStone" },
  "peers": ["BlueLake", "RedStone"],
  "clock_agent": "SandyThrush",
  "memory_agent": "NavyOrchid",
  "recent_handoffs": 5,
  "poll_seconds": 15
}
```

## 3. 驗證這台 Windows

🟡 1. 在剛才的 PowerShell 貼上下方檢查。預期看到 Node `v22.x` 或更新版、`hub-client.json memory_agent OK`、`L09 imports OK`。

```powershell
. {
  Set-Location -LiteralPath $root
  node --version
  if ($env:HUB_MEMORY_AGENT -and $env:HUB_MEMORY_AGENT -cne 'NavyOrchid') {
    throw 'HUB_MEMORY_AGENT 覆蓋了 hub-client.json，請檢查後再啟動'
  }
  node -e "const c=JSON.parse(require('node:fs').readFileSync('hub-client.json','utf8')); if(c.memory_agent !== 'NavyOrchid') throw Error('memory_agent should be NavyOrchid'); console.log('hub-client.json memory_agent OK')"
  if ($LASTEXITCODE -ne 0) { throw '請檢查 hub-client.json 的逗號、引號和存檔編碼' }
  node --input-type=module -e "await import('./client/hub-hook.mjs'); console.log('L09 imports OK')"
  if ($LASTEXITCODE -ne 0) { throw '請檢查 client 與 ops/lifecycle 是否一起換檔' }
}
```

🟡 2. 用既有的桌面啟動方式開啟 Hub Claude Code，或在同一視窗執行 `.\start-hub-claude.ps1`。使用 PowerShell 腳本時預期印出 `device credentials present: RedStone`。

🟡 3. 在 Claude Code 輸入 `/mcp`，確認 `hub` 顯示 `Connected`。

🟡 4. 在 Claude Code 輸入 `/hooks`，確認看到這個資料夾的 `SessionStart`、`Stop`、`SessionEnd`。

🟡 5. 另開 PowerShell 看本次的 Hook 紀錄。預期看到同一個新 `sid` 的 `start` 與 `watch-arm`，且 `start` 的 `syncError` 欄空白（JSON 為 `null`）。若你有自訂 `HUB_DATA_DIR`，把路徑改成該資料夾的 `hook.log`。

```powershell
Get-Content -LiteralPath "$env:LOCALAPPDATA\hub-client\group-a\RedStone\hook.log" -Tail 30 |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.ev -in @('start', 'watch-arm') } |
  Select-Object -Last 2 -Property t, ev, sid, syncError
```

🟡 6. 請 Windows 的 Claude 用 Hub Hook 給 `BlueLake` 發一則測試交接（`kind: handoff`），內容寫當下時間和測試用途；記下輸出的 `已保存 #ID`。

🟡 7. 回 Discord 用 `/status`，在 `question` 填「剛才 Windows 的測試交接 #ID 說了什麼？」；把 `#ID` 換成上一步的數字，保留 `public` 預設值。

🟡 8. 預期只有你看得到回覆，且「依據：#ID（台北時間）」能對上該筆。若已保存但仍查不到，把 Mail ID 與時間交給 PM 核對同步。

如果 Windows 收送正常，Discord 卻查不到該筆交接，保留本次設定供 PM 排查記憶同步。若 Windows 程式無法啟動或 Hook 報錯，先核對上一節的設定與雜湊，仍有問題即可還原。入口 401 依接入手冊核對裝置憑證。 [組員接入手冊](../onboarding-S1.md)

## 4. 還原

🟡 1. 在 Hub Claude Code 先 `/exit` 並停止背景工作，回到先前執行更新的 PowerShell。

🟡 2. 若先前的視窗已關閉，在新的 PowerShell 先貼以下三行，並把第三行的資料夾名稱改成當時記下的備份名稱。

```powershell
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$root = Join-Path $desktop 'hub-win'
$backup = Join-Path $desktop 'hub-win-L09-backup-填入原時間'
```

🟡 3. 貼上下方整段。此段把已換上的資料夾移到桌面上另一個有時間戳記的資料夾，再放回舊檔；更新若只做到一半，會依手上已有的備份還原。

```powershell
. {
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path -LiteralPath $backup -PathType Container)) { throw '找不到原本的備份資料夾' }
  $failed = Join-Path $desktop ('hub-win-L09-restore-saved-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $failed | Out-Null
  foreach ($relative in @('client', 'ops/lifecycle')) {
    $name = Split-Path -Leaf $relative
    $old = Join-Path $backup $name
    $active = Join-Path $root $relative
    if (Test-Path -LiteralPath $old) {
      if (Test-Path -LiteralPath $active) { Move-Item -LiteralPath $active -Destination $failed }
      Move-Item -LiteralPath $old -Destination $active
    }
  }
  $oldConfig = Join-Path $backup 'hub-client.json'
  if (Test-Path -LiteralPath $oldConfig) {
    $activeConfig = Join-Path $root 'hub-client.json'
    if (Test-Path -LiteralPath $activeConfig) { Copy-Item -LiteralPath $activeConfig -Destination $failed }
    Copy-Item -LiteralPath $oldConfig -Destination $root -Force
  }
  '舊版檔案已放回'
}
```

🟡 4. 看到 `舊版檔案已放回` 後，照原方式啟動，並用 `/mcp` 確認 `hub` 已連線。

## 更新包檔案與 SHA-256

「替換」和「新增」以原始 MVP ZIP 為準。「同版」也已放入更新包，才能整個目錄一起替換。舊版 Windows 啟動只用到 `ops/lifecycle/protocol.mjs`；本次把整個目錄配套交付，Windows 仍照原方式啟動 Claude。

| 相對路徑 | 相對於 MVP ZIP | SHA-256 |
| --- | --- | --- |
| `client/README.md` | 替換 | `954c5c09af13ce2822353c0d516966d8a80fb8591782a396856c50dc7641b06f` |
| `client/hub-hook.mjs` | 替換 | `bf464461db37fab4b0c4ee640f12d8b8fbd4acce97386aeb9b85d845ceee3692` |
| `client/mail-client.mjs` | 替換 | `562cfcf69d8a3c6b16929c0d960781d7235e2b5f9f552f6c8d18632b03413526` |
| `client/package.json` | 同版 | `c2ebea3952e5708f7f384a5d3ac10a67d7d530d83382b01c0e803074df26df4b` |
| `client/templates/claude-settings.json` | 同版 | `dfa4c9b03dbe3c5989d918d12c3a2b1aeb55e34e52c723b5330578bde878b979` |
| `client/templates/hub-client.json` | 替換 | `604d207bb3e60667e8a813b05ba253ec55f470cf647bd996f06da7244893b422` |
| `client/test/fixtures/handoff-1500.sha256` | 新增 | `61a7de5b3045d39dd7f30a6082ce3d418af0585f19edc2d23fe96f0465b3bded` |
| `client/test/fixtures/handoff-1500.txt` | 新增 | `5507281a978ce237736a5ec0f1caa04689a101b92d8ddfb27146e9c33d237fff` |
| `client/test/helpers/fake-hub.mjs` | 新增 | `34f71e2a1742d581598eedbf1082b62f67ea32482455fe6ef4cb181461b1a471` |
| `client/test/helpers/fakes.mjs` | 新增 | `9a070c5a801a896386062fdd79d8e5ca1f25fe45b04c30496586293ccc0af0a0` |
| `client/test/helpers/local-mail-server.mjs` | 新增 | `8182a14a096a9b68e4cad88a6368186e64d5a66e71e3000c206941993445ada2` |
| `client/test/hub-hook.integration.test.mjs` | 新增 | `59003db08b94afab866290a1fd965da0b24eb20ea29850c277c2682be90fbfb2` |
| `client/test/hub-hook.test.mjs` | 新增 | `bcb79827b2cca2e8f1a70bef337e7456b7b0da23cf0b00e695d18c554b3ee9f2` |
| `client/test/mail-client.integration.test.mjs` | 新增 | `3eebdfff7f0fe6c33db1dd6e48544a8433172cdf5b749a6a1f92ffef148d98d5` |
| `client/test/mail-client.test.mjs` | 新增 | `22474ffa79d04e535f94b4f800a90e3ea7f284e2704dc186980814ccd7f83a04` |
| `ops/lifecycle/README.md` | 新增 | `38b663b99443f8dd64282564e19b5f105578ee1071eb465f4796872ce232e015` |
| `ops/lifecycle/lifecycle.mjs` | 新增 | `3107da344b94f99b51160f12a502292b56badd1c4ded25c8227a71d8a6653056` |
| `ops/lifecycle/main.mjs` | 新增 | `4d30d25810578a16870ee9781bdc56e1347c472f7a52b9dd311b27d3c517ed2e` |
| `ops/lifecycle/protocol.mjs` | 替換 | `28e3e2ebb3ff5274fe13cfc6b82c13d4734580e2bf922f4d9be9c34146948fdc` |
| `ops/lifecycle/store-file.mjs` | 新增 | `dcfc5508f289c43fd5b53406e2e0f6ed75c3049760b37e934c812bd9b791b6c5` |
| `ops/lifecycle/test/auto-mode.test.mjs` | 新增 | `170bd8a12ddd14a43e211ef666102a317318ed1de9b9d8a053b7330d2a8a86db` |
| `ops/lifecycle/test/helpers.mjs` | 新增 | `8d1fd060a45b8047fb1ccc690378391c6ddc26af5496a9b9198e8ec61fc19121` |
| `ops/lifecycle/test/lifecycle.integration.test.mjs` | 新增 | `2a6b0f084c4f5db43a751002109482fe44b8351cb77d5d92b5e022cdd5084dbe` |
| `ops/lifecycle/test/lifecycle.test.mjs` | 新增 | `b0e795f39c731b75d25923a85cd7fb502b740af50fd12015006f86af71911664` |
