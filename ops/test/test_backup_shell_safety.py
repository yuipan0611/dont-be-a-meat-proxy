"""Run the real shell scripts with hostile JSON data, never privileged paths."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class BackupShellSafetyTest(unittest.TestCase):
    def prepare(self, root):
        for name in ('data', 'private', 'clock', 'backups', 'caddy'):
            (root / name).mkdir(mode=0o700)
        with sqlite3.connect(root / 'data/mail.sqlite3') as db:
            db.execute('create table messages(id integer)')
        return {**os.environ, 'HUB_DATA_DIR': str(root / 'data'),
                'HUB_STATE_DIR': str(root / 'private'), 'HUB_CLOCK_DIR': str(root / 'clock'),
                'CADDY_SNIPPET': str(root / 'absent'), 'CADDY_PRIVATE_DIR': str(root / 'caddy'),
                'HUB_BRIDGE_STATE_DIR': str(root / 'absent-bridge'), 'BACKUP_DIR': str(root / 'backups'),
                'HUB_PG_BACKUP': '0', 'HUB_HINDSIGHT_BACKUP': '0'}

    def backup(self, env):
        result = subprocess.run([str(ROOT / 'ops/backup'), '--quiet'], env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, 'backup failed; output suppressed')

    def test_backup_does_not_execute_cursor_as_shell(self):
        with tempfile.TemporaryDirectory(prefix='p3-backup-') as work:
            root = Path(work)
            env = self.prepare(root)
            marker = root / 'executed'
            (root / 'clock/hubclock-state.json').write_text(json.dumps({'cursor': f'$(touch {marker})'}))
            self.backup(env)
            self.assertFalse(marker.exists(), 'backup executed a command from JSON cursor')

    def test_restore_does_not_execute_cursor_as_shell(self):
        with tempfile.TemporaryDirectory(prefix='p3-restore-') as work:
            root = Path(work)
            env = self.prepare(root)
            marker = root / 'executed'
            (root / 'clock/hubclock-state.json').write_text(json.dumps({'cursor': 7}))
            self.backup(env)
            source = root / 'unpacked'
            source.mkdir()
            subprocess.run(['tar', '-xzf', str(next((root / 'backups').glob('*.tar.gz'))), '-C', str(source)], check=True)
            (source / 'hubclock/hubclock-state.json').write_text(json.dumps({'cursor': f'$(touch {marker})'}))
            result = subprocess.run([str(ROOT / 'ops/restore'), '--backup', str(source),
                                     '--target-data-dir', str(root / 'restored-data'),
                                     '--target-clock-dir', str(root / 'restored-clock'), '--quiet'],
                                    env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, 'restore failed; output suppressed')
            self.assertFalse(marker.exists(), 'restore executed a command from JSON cursor')
