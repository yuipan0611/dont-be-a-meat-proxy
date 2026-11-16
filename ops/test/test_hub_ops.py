import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class OperatorTests(unittest.TestCase):
    def setUp(self):
        work = ROOT / '.hub-local' / 'h02'
        work.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=work)
        self.dir = Path(self.tmp.name)
        self.state = self.dir / 'private'

    def tearDown(self):
        self.tmp.cleanup()

    def run_op(self, name, *args):
        return subprocess.run(
            ['python3', str(ROOT / 'ops' / name), '--state-dir', str(self.state), *args],
            text=True, capture_output=True,
        )

    def test_operator_can_create_distinct_private_device_and_upstream_credentials(self):
        result = self.run_op('init-secrets')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.state / 'tokens.json').read_text())
        values = [data['upstream'], *(d['token'] for d in data['devices'].values())]
        self.assertEqual(len(set(values)), 3)
        self.assertEqual(set(data['devices']), {'mac', 'windows'})
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        for name in ['tokens.json', 'mail-a.env', 'mac.env', 'windows.env']:
            self.assertEqual(stat.S_IMODE((self.state / name).stat().st_mode), 0o600)
        self.assertTrue(all(v not in result.stdout + result.stderr for v in values))

    def test_prepared_allowlist_is_private_and_valid_with_existing_office_site(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        output = self.dir / 'caddy-private' / 'auth.caddy'
        result = self.run_op('render-caddy', '--output', str(output), '--owner', 'self', '--prepare-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        config = self.dir / 'Caddyfile'
        config.write_text('{\n admin off\n auto_https off\n}\n'
                          'http://office.localhost:18880 {\n respond "office untouched" 200\n}\n'
                          'http://hub.localhost:18881 {\n import ' + json.dumps(str(output)) + '\n}\n')
        caddy = os.environ.get('CADDY_BIN', str(ROOT / 'spikes/f01b/bin/caddy'))
        checked = subprocess.run([caddy, 'validate', '--config', str(config), '--adapter', 'caddyfile'],
                                 capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, 'Caddy rejected the prepared configuration')
        data = json.loads((self.state / 'tokens.json').read_text())
        self.assertTrue(all(d['token'] not in result.stdout + result.stderr for d in data['devices'].values()))

    def test_rerunning_init_keeps_credentials_and_refuses_a_modified_export(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        before = (self.state / 'tokens.json').read_bytes()
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        self.assertEqual((self.state / 'tokens.json').read_bytes(), before)
        (self.state / 'mac.env').write_text('operator-owned change\n')
        self.assertNotEqual(self.run_op('init-secrets').returncode, 0)
        self.assertEqual((self.state / 'mac.env').read_text(), 'operator-owned change\n')

    def test_failed_revoke_keeps_pending_and_restores_previous_snippet(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        output = self.dir / 'caddy-private' / 'auth.caddy'
        prepared = self.run_op('render-caddy', '--output', str(output), '--owner', 'self', '--prepare-only')
        self.assertEqual(prepared.returncode, 0)
        old = output.read_bytes()
        result = self.run_op('revoke', '--device', 'windows', '--output', str(output),
                             '--owner', 'self', '--caddy-bin', '/no-such-caddy')
        self.assertNotEqual(result.returncode, 0)
        registry = json.loads((self.state / 'tokens.json').read_text())
        self.assertEqual(registry['devices']['windows']['status'], 'revocation_pending')
        self.assertEqual(registry['devices']['mac']['status'], 'active')
        self.assertEqual(output.read_bytes(), old)
        self.assertIn('pending', result.stderr)
        self.assertTrue(all(d['token'] not in result.stdout + result.stderr for d in registry['devices'].values()))

    def test_world_readable_registry_and_config_injection_are_rejected(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        path = self.state / 'tokens.json'
        output = self.dir / 'auth.caddy'
        path.chmod(0o644)
        self.assertNotEqual(self.run_op('render-caddy', '--output', str(output), '--owner', 'self', '--prepare-only').returncode, 0)
        path.chmod(0o600)
        data = json.loads(path.read_text())
        data['devices']['mac']['token'] = 'unsafe\nrespond 200'
        path.write_text(json.dumps(data))
        self.assertNotEqual(self.run_op('render-caddy', '--output', str(output), '--owner', 'self', '--prepare-only').returncode, 0)
        self.assertFalse(output.exists())

    def test_all_devices_revoked_still_produces_deny_all(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        path = self.state / 'tokens.json'
        data = json.loads(path.read_text())
        for device in data['devices'].values():
            device['status'] = 'revoked'
        path.write_text(json.dumps(data))
        output = self.dir / 'caddy-private' / 'auth.caddy'
        result = self.run_op('render-caddy', '--output', str(output), '--owner', 'self', '--prepare-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('respond "Unauthorized" 401', output.read_text())
        self.assertNotIn('@hub_allowed', output.read_text())

    def test_issue_refuses_to_rotate_an_active_or_unconfirmed_device(self):
        self.assertEqual(self.run_op('init-secrets').returncode, 0)
        path = self.state / 'tokens.json'
        before = path.read_bytes()
        result = self.run_op('issue', '--device', 'windows')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('revoked', result.stderr)
        self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
