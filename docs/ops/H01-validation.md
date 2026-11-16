# H-01 文件驗證紀錄

執行者：codex-senior-swe。日期：2026-11-17，Asia/Taipei。基底：`d0a8d63`。範圍：runbook、盤點空白模板與本紀錄，沒有部署程式。

## 開工與檢查結果

| 實際指令／檢查 | 輸出摘要 | 能證明的範圍 |
|---|---|---|
| `git stash push -u -m pre-G23-drafts -- AGENTS.md CLAUDE.md docs` | exit 0，`Saved working directory and index state On example-org/codex-senior-swe: pre-G23-drafts` | 舊草稿已保留在 stash；本票不取回或刪 stash |
| `git merge --ff-only master` | exit 0，`Updating 0ac25b6..d0a8d63`，`Fast-forward` | 自己的分支快轉到核准文件基底，未修改 master |
| `git log --oneline -1`，開工時 | `d0a8d63 docs: G1–G3 checkpoint (brief, PRD, SRS, SAD/SDS v0.3, test plan, MVP tickets)` | 符合指定 checkpoint |
| 下方 shell 語法檢查，建立文件前 | exit 1，`FileNotFoundError: … docs/ops/runbook-H01-vps-prep.md` | 紅燈：交付物尚不存在，沒有 shell 範例可檢查 |
| 同一檢查，建立文件後 | exit 0，`PASS: 15 shell blocks parse with bash -n` | 綠燈：shell 範例語法可解析，沒有執行其中命令 |
| 下方盤點唯讀檢查 | 見下方實際結果 | 盤點區塊沒有混入安裝、啟動服務或修改 firewall 的命令 |
| 下方相對連結檢查 | 見下方實際結果 | 三份文件的本地相對連結均有目標檔 |
| `git diff --cached --check`，加入暫存區後 | exit 0，無輸出 | 新增文件沒有 Git whitespace error；不證明主機設定正確 |

採用指導者 `skills/tdd/SKILL.md` 的先紅後綠檢查交付物，並依 `skills/implement/SKILL.md` 對文件／設定做相稱驗證。沒有產品程式可跑單元測試，也沒有用替身冒充 VPS 操作。

## 可重跑的文件檢查

在本 repo 根目錄執行，使用 Python 3 與 bash。這段只讀文件、解析 shell 語法，不會連 VPS 或執行 runbook 的命令。

```sh
python3 - <<'PY'
from pathlib import Path
import re, subprocess
p = Path('docs/ops/runbook-H01-vps-prep.md')
s = p.read_text()
blocks = re.findall(r'^```sh\n(.*?)^```', s, re.M | re.S)
assert blocks, '沒有可複製的 shell 指令'
for i, code in enumerate(blocks, 1):
    r = subprocess.run(['bash', '-n'], input=code, text=True, capture_output=True)
    assert r.returncode == 0, f'block {i}: {r.stderr}'
print(f'PASS: {len(blocks)} shell blocks parse with bash -n')
PY
```

盤點區塊限定為讀取命令；檢查範圍以 §2 標題切出，避免把後續由 維護者 執行的 UFW 新增步驟算進盤點。

```sh
python3 - <<'PY'
from pathlib import Path
import re, shlex
s = Path('docs/ops/runbook-H01-vps-prep.md').read_text()
inventory = s.split('## 2. ', 1)[1].split('## 3. ', 1)[0]
allowed = {'date', 'cat', 'uname', 'getconf', 'printf', 'awk', 'free', 'df'}
count = 0
for block in re.findall(r'^```sh\n(.*?)^```', inventory, re.M | re.S):
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        assert not any(c in line for c in (';', '>', '`')), line
        assert '$(' not in line, line
        for segment in line.split('|'):
            args = shlex.split(segment)
            if args[0] == 'sudo':
                args = args[1:]
            if args[0] == 'docker':
                assert args[1:] == ['version'] or args[1:3] in (
                    ['compose', 'version'], ['ps', '-a']), line
            elif args[0] == 'ufw':
                assert args[1] == 'status', line
            elif args[0] == 'ss':
                assert args[1:] == ['-tlnp'], line
            else:
                assert args[0] in allowed, line
        count += 1
print(f'PASS: {count} inventory command lines contain only read operations')
PY
```

檢查本票三份文件的相對連結。網頁來源已透過瀏覽工具查讀官方文件，此處不重新發網路請求。

```sh
python3 - <<'PY'
from pathlib import Path
import re
paths = [Path('docs/ops') / name for name in (
    'runbook-H01-vps-prep.md', 'vps-inventory.md', 'H01-validation.md')]
count = 0
for p in paths:
    for target in re.findall(r'\]\(([^)]+)\)', p.read_text()):
        if '://' in target or target.startswith('#'):
            continue
        dest = (p.parent / target.split('#', 1)[0]).resolve()
        assert dest.is_file(), f'{p}: {target}'
        count += 1
print(f'PASS: {count} relative links resolve in 3 delivery documents')
PY
```

上述三段依序執行，皆 exit 0，實際輸出：

```text
PASS: 15 shell blocks parse with bash -n
PASS: 16 inventory command lines contain only read operations
PASS: 10 relative links resolve in 3 delivery documents
```

## 本機公開 DNS 查詢，不是 VPS 驗收

查詢時間：`2026-11-16T17:07:41Z` 附近，即台灣 2026-11-17 01:07。位置：這台 Mac 的預設 resolver；不是 Hostinger 帳戶 API 或權威 DNS 查詢。

```sh
dig +short hub.example.invalid
dig hub.example.invalid A +noall +comments +answer
```

實際第一個命令 exit 0，輸出空白；第二個命令 exit 0，包含以下結果：

```text
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 4172
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
```

DNS 查詢命令能執行成功，不等於記錄已存在；此次沒有得到目標 A 記錄。結果僅代表該時點 resolver 回覆，PM 新增後仍需依 runbook 重查並與實際 VPS IP 比對，不能用這份舊結果斷言後續新增失敗。

## Hostinger MCP 限制與後續操作

- 工具發現：本 worker 的 `ALL_TOOLS` 以 `/hostinger/i` 比對 name 與 description，結果為 `[]`；沒有可呼叫的 Hostinger 官方 MCP 工具，也沒有發出帳戶 API 請求，因此沒有 API 原始錯誤或寫入回應可附。
- 已用 orchestration escalation 回報 PM；PM 回覆改由協調端官方 MCP 處理 DNS A 與防火牆，此 worker 完成 runbook 與空白模板，保留手動備援步驟。
- 本 worker 的遠端寫入操作為零；沒有查帳戶憑證、另用 HTTP API、SSH、安裝 MCP 或更動全域設定。
- 未執行：VPS 內 OS／Docker／port／資源／UFW 盤點、SSH 公鑰新連線驗證、Hostinger 帳戶狀態與快照查詢、DNS 與防火牆寫入、HTTP 可達測試、Caddy／Mail 部署。前兩類由 維護者 執行，帳戶查詢與寫入由 PM 接手，部署另開 H-02。
- `docs/ops/vps-inventory.md` 仍為空白模板，PM 應填入去秘密的 MCP 查詢／寫入收據、再次讀取驗證與實際 dig 輸出；維護者 補 VPS 命令結果。

交付的是可供操作的文件；H-01 的實際 DNS／盤點驗收仍待 PM／維護者 收齊證據。
