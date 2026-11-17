#!/usr/bin/env python3
"""Fake VPS only: real Caddy reload/backup; no claim to exercise systemd sandbox or Discord."""
import os
from pathlib import Path
import subprocess
import sys
args = sys.argv[1:]
if args[:2] == ['reload', 'caddy']:
    p = Path('/run/l09-reloads')
    p.write_text(str(int(p.read_text() if p.exists() else '0') + 1))
    sys.exit(subprocess.run(['runuser','-u','caddy','--','caddy','reload','--force','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode)
if args[:2] == ['start', 'hub-backup.service']:
    env = {**os.environ, 'HUB_PG_BACKUP':'1','HUB_HINDSIGHT_BACKUP':'1'}
    sys.exit(subprocess.run(['/opt/neighbor-hub/ops/backup','--quiet'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode)
if args and args[0] == 'cat':
    sys.exit(1)  # baseline has no token applier installed
if args and args[0] == 'is-active':
    if args[-1].endswith('.timer'):
        print('active')
        sys.exit(0)
    sys.exit(3)
if args and args[0] == 'show':
    print('success')
sys.exit(0)
