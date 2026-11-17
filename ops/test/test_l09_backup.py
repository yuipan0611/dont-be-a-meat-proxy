"""L09 regression: bridge recovery state joins the same protected archive, never a runtime lease."""
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class BridgeBackupTest(unittest.TestCase):
    def test_archive_preserves_bridge_json_without_lease_or_symlink(self):
        with tempfile.TemporaryDirectory() as work:
            d = Path(work)
            for name in ('data', 'private', 'clock', 'bridge', 'backups', 'caddy'):
                (d / name).mkdir(mode=0o700)
            with sqlite3.connect(d / 'data/mail.sqlite3') as db:
                db.execute('create table messages(id integer)')
            state = '{"cursor":"opaque","requests":{"mail-7":{"status":"unknown"}}}\n'
            (d / 'bridge/hubclock-state.json').write_text(state)
            (d / 'bridge/hubclock.lock').write_text('live lease')
            (d / 'bridge/foreign.json').symlink_to(d / 'bridge/hubclock-state.json')
            env = {**os.environ, 'HUB_DATA_DIR': str(d / 'data'), 'HUB_STATE_DIR': str(d / 'private'),
                   'HUB_CLOCK_DIR': str(d / 'clock'), 'HUB_BRIDGE_STATE_DIR': str(d / 'bridge'),
                   'CADDY_SNIPPET': str(d / 'none'), 'CADDY_PRIVATE_DIR': str(d / 'caddy'),
                   'BACKUP_DIR': str(d / 'backups'), 'HUB_PG_BACKUP': '0', 'HUB_HINDSIGHT_BACKUP': '0'}
            result = subprocess.run([str(ROOT / 'ops/backup'), '--quiet'], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, 'backup failed; private output suppressed')
            archive = next((d / 'backups').glob('*.tar.gz'))
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            with tarfile.open(archive) as t:
                member = t.getmember('./memory-bridge/hubclock-state.json')
                self.assertEqual(t.extractfile(member).read().decode(), state)
                self.assertEqual(member.mode & 0o777, 0o600)
                self.assertNotIn('./memory-bridge/hubclock.lock', t.getnames())
                self.assertNotIn('./memory-bridge/foreign.json', t.getnames())
