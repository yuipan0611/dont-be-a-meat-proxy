"""L-03b TokenApplier: fake Caddy, fake reload, fake spool, in-memory registry (same SQL semantics as
the PsqlDb methods; the real-Postgres path is covered by test_token_applier_pg.py)."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops'))
import token_applier as ta  # noqa: E402
import hub_ops  # noqa: E402


def sha(v):
    return hashlib.sha256(v.encode()).hexdigest()


class FakeDb:
    def __init__(self):
        self.devices = {}  # token_id -> dict(status, token_hash, group_id, config_revision, member_active)
        self.audit = []
        self.down = False

    def _check(self):
        if self.down:
            raise ta.ApplyError('database unavailable or query failed')

    def add(self, tid, token, status='active'):
        self.devices[tid] = {'status': status, 'token_hash': sha(token), 'group_id': 'group-a', 'config_revision': None}

    def export(self):
        self._check()
        return [{'token_id': t, 'token_hash': d['token_hash'], 'group_id': d['group_id']}
                for t, d in sorted(self.devices.items()) if d['status'] == 'active']

    def all_hashes(self):
        self._check()
        return {d['token_hash'] for d in self.devices.values()}

    def device(self, tid):
        self._check()
        d = self.devices.get(tid)
        return {k: d[k] for k in ('status', 'token_hash', 'group_id')} if d else None

    def next_revision(self):
        self._check()
        return max([d['config_revision'] or 0 for d in self.devices.values()] + [0]) + 1

    def mark_applied(self, tid, rev, rid):
        self._check()
        if self.devices[tid]['status'] == 'active':
            self.devices[tid]['config_revision'] = rev
        self.audit.append(('device.config.applied', tid, rid))

    def fail_issue(self, tid, rid, why):
        self._check()
        if tid in self.devices and self.devices[tid]['status'] == 'active':
            self.devices[tid]['status'] = 'revocation_pending'
        self.audit.append(('device.issue.failed', tid, why))

    def complete_revocation(self, tid, rev, rid):
        self._check()
        if self.devices[tid]['status'] == 'revocation_pending':
            self.devices[tid].update(status='revoked', config_revision=rev)
        self.audit.append(('device.revoke.applied', tid, rid))

    def import_device(self, *, token_id, token_hash, label, platform, agent):
        if not any(d['token_hash'] == token_hash for d in self.devices.values()):
            self.devices[token_id] = {'status': 'active', 'token_hash': token_hash, 'group_id': 'group-a', 'config_revision': None}
        return self.device(token_id)


class TokenApplierTests(unittest.TestCase):
    def setUp(self):
        work = ROOT / '.hub-local' / 'l03b'
        work.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=work)
        d = Path(self.tmp.name)
        self.d = d
        for name in ('state', 'tokens', 'spool', 'caddy-private'):
            (d / name).mkdir(mode=0o700)
        self.log = d / 'calls.log'
        caddy = d / 'fake-caddy'
        caddy.write_text('#!/bin/sh\necho "caddy $*" >> "%s"\n[ -e "%s" ] && { echo "Error near Bearer secret" >&2; exit 1; }\nexit 0\n'
                         % (self.log, d / 'validate-fails'))
        reload_ = d / 'fake-reload'
        reload_.write_text('#!/bin/sh\necho "reload" >> "%s"\n[ -e "%s" ] && exit 1\nexit 0\n' % (self.log, d / 'reload-fails'))
        for f in (caddy, reload_):
            f.chmod(0o755)
        self.mac, self.win, self.upstream = (secrets.token_urlsafe(32) for _ in range(3))
        registry = {'version': 1, 'revision': 1, 'group_id': 'group-a', 'upstream': self.upstream,
                    'devices': {'mac': {'token': self.mac, 'status': 'active', 'agent': 'BlueLake'},
                                'windows': {'token': self.win, 'status': 'active', 'agent': 'RedStone'}}}
        hub_ops.atomic_write(d / 'state' / 'tokens.json', json.dumps(registry))
        self.output = d / 'caddy-private' / 'auth.caddy'
        self.office = 'office.example.invalid {\n respond "office" 200\n}\n'
        self.caddyfile = d / 'Caddyfile'
        self.caddyfile.write_text(self.office + 'import ' + str(self.output) + '\n')
        self.db = FakeDb()
        self.cfg = ta.argparse.Namespace(
            state=d / 'state', token_dir=d / 'tokens', spool=d / 'spool', output=self.output, config=self.caddyfile,
            owner='self', upstream='127.0.0.1:8765', caddy_bin=str(caddy), reload_cmd=[str(reload_)],
            probe_url='http://127.0.0.1:9/health/liveness', probe=self.fake_probe)
        for sub in ('requests', 'receipts', 'credentials'):
            (d / 'spool' / sub).mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    # Probe answers from the snippet Caddy would have loaded (last successful reload).
    def fake_probe(self, url, token):
        if not self.output.exists():
            return 200 if token else 401
        allowed = re.findall(r'header Authorization "Bearer ([^"]+)"', self.output.read_text())
        return 200 if token in allowed else 401

    def allowed(self):
        return set(re.findall(r'header Authorization "Bearer ([^"]+)"', self.output.read_text()))

    def bot_issue(self, rid, tid, token=None, *, db_row=True):
        token = token or 'mph_' + secrets.token_urlsafe(32)
        if db_row:
            self.db.add(tid, token)
        cred = self.d / 'spool' / 'credentials' / tid
        cred.write_text(token + '\n')
        cred.chmod(0o600)
        self.request(rid, 'issue', tid)
        return token

    def request(self, rid, op, tid):
        body = {'v': 1, 'op': op, 'request_id': rid, 'group_id': 'group-a', 'token_id': tid}
        if op == 'issue':
            body['credential_ref'] = f'credentials/{tid}'
        p = self.d / 'spool' / 'requests' / f'{rid}.json'
        p.write_text(json.dumps(body))
        p.chmod(0o600)

    def receipt(self, rid):
        return json.loads((self.d / 'spool' / 'receipts' / f'{rid}.json').read_text())

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    # ------------------------------------------------------------------ tests

    def test_registry_group_mismatch_cannot_import_before_apply(self):
        self.cfg.group_id = 'group-b'
        with self.assertRaises(ta.ApplyError):
            ta.import_mvp(self.cfg, self.db)
        self.assertEqual(self.db.devices, {}, 'registry mismatch must be detected before DB writes')

    def test_foreign_export_excluded_and_foreign_request_cannot_mutate(self):
        self.cfg.group_id = 'group-a'
        foreign = self.bot_issue('foreign1', 'tok_foreign01')
        self.db.devices['tok_foreign01']['group_id'] = 'group-b'
        ta.atomic_write(self.cfg.token_dir / 'tok_foreign01', foreign + '\n')
        _, allowed = ta.desired_tokens(self.cfg, self.db)
        self.assertNotIn(foreign, allowed.values())
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('foreign1')['status'], 'failed')
        self.assertEqual(self.db.devices['tok_foreign01']['status'], 'active')
        self.assertEqual(self.calls(), [])

    def test_request_group_mismatch_rejected_before_apply(self):
        self.cfg.group_id = 'group-a'
        self.bot_issue('foreign2', 'tok_foreign02')
        path = self.cfg.spool / 'requests' / 'foreign2.json'
        req = json.loads(path.read_text()); req['group_id'] = 'group-b'
        path.write_text(json.dumps(req))
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('foreign2')['status'], 'failed')
        self.assertEqual(self.calls(), [])

    def test_issue_success_validates_reloads_probes_and_records_revision(self):
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        result = ta.process(self.cfg, self.db)
        self.assertEqual(result, [('ix1', 'applied')])
        r = self.receipt('ix1')
        self.assertEqual(r['status'], 'applied')
        self.assertEqual(r['config_revision'], 1)
        self.assertEqual(self.allowed(), {token, self.mac, self.win}, 'MVP tokens kept until imported')
        self.assertEqual(self.calls()[0].split()[:2], ['caddy', 'validate'])
        self.assertEqual(self.calls()[1], 'reload')
        self.assertEqual(self.db.devices['tok_aaaa1111']['config_revision'], 1)
        self.assertFalse((self.d / 'spool' / 'credentials' / 'tok_aaaa1111').exists(), 'credential left the spool')
        self.assertEqual((self.d / 'tokens' / 'tok_aaaa1111').read_text().strip(), token)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.d / 'tokens' / 'tok_aaaa1111').stat().st_mode), 0o600)
        self.assertNotIn(token, json.dumps(r))
        self.assertTrue((self.d / 'spool' / 'done' / 'ix1.json').exists())
        self.assertEqual(self.caddyfile.read_text(), self.office + 'import ' + str(self.output) + '\n', 'office untouched')

    def test_validate_failure_never_reloads_keeps_old_snippet_and_fails_closed(self):
        first = self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        before = self.output.read_text()
        (self.d / 'validate-fails').touch()
        self.log.unlink()
        second = self.bot_issue('ix2', 'tok_bbbb2222')
        ta.process(self.cfg, self.db)
        self.assertNotIn('reload', self.calls(), 'no reload after a failed validate')
        self.assertEqual(self.output.read_text(), before)
        self.assertEqual(self.receipt('ix2')['status'], 'failed')
        self.assertNotIn('secret', self.receipt('ix2')['error'], 'Caddy output is suppressed')
        self.assertEqual(self.db.devices['tok_bbbb2222']['status'], 'revocation_pending')
        self.assertFalse((self.d / 'tokens' / 'tok_bbbb2222').exists())
        self.assertIn(first, self.allowed())
        self.assertNotIn(second, self.allowed())

    def test_reload_failure_restores_previous_snippet_and_fails_closed(self):
        (self.d / 'reload-fails').touch()
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix1')['status'], 'failed')
        self.assertFalse(self.output.exists(), 'no previous snippet → none left behind')
        self.assertEqual(self.db.devices['tok_aaaa1111']['status'], 'revocation_pending')
        self.assertNotIn(token, (self.d / 'calls.log').read_text())

    def test_db_unavailable_answers_failed_without_touching_caddy(self):
        self.bot_issue('ix1', 'tok_aaaa1111')
        self.db.down = True
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix1')['status'], 'failed')
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.output.exists())

    def test_db_unavailable_via_cli_exits_nonzero_and_prints_no_secret(self):
        self.bot_issue('ix1', 'tok_aaaa1111', db_row=False)
        res = subprocess.run([sys.executable, str(ROOT / 'ops' / 'token-applier'), 'process',
                              '--state', str(self.cfg.state), '--token-dir', str(self.cfg.token_dir), '--spool', str(self.cfg.spool),
                              '--output', str(self.output), '--config', str(self.caddyfile), '--owner', 'self',
                              '--caddy-bin', self.cfg.caddy_bin, '--reload-cmd', shlex.quote(self.cfg.reload_cmd[0]), '--psql', 'false'],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)  # the request is answered, not left hanging
        self.assertEqual(self.receipt('ix1'), {'request_id': 'ix1', 'status': 'failed', 'error': 'database unavailable or query failed'})
        self.assertEqual(self.calls(), [])

    def test_duplicate_request_is_idempotent(self):
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        first = self.receipt('ix1')
        reloads = self.calls().count('reload')
        self.request('ix1', 'issue', 'tok_aaaa1111')  # bot retried / re-delivered the same request ID
        self.assertEqual(ta.process(self.cfg, self.db), [('ix1', 'duplicate')])
        self.assertEqual(self.receipt('ix1'), first)
        self.assertEqual(self.calls().count('reload'), reloads, 'not applied twice')
        self.assertIn(token, self.allowed())

    def test_revoke_success_probe_401_marks_revoked_and_deletes_credential(self):
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        self.db.devices['tok_aaaa1111']['status'] = 'revocation_pending'  # bot step 1
        self.request('ix2', 'revoke', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        r = self.receipt('ix2')
        self.assertEqual((r['status'], r['probe']), ('applied', 401))
        self.assertEqual(self.db.devices['tok_aaaa1111']['status'], 'revoked')
        self.assertNotIn(token, self.allowed())
        self.assertEqual(self.allowed(), {self.mac, self.win}, 'other devices unaffected')
        self.assertFalse((self.d / 'tokens' / 'tok_aaaa1111').exists())

    def test_revoke_failure_stays_pending_and_is_not_reported_done(self):
        self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        self.db.devices['tok_aaaa1111']['status'] = 'revocation_pending'
        (self.d / 'validate-fails').touch()
        self.request('ix2', 'revoke', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix2')['status'], 'failed')
        self.assertEqual(self.db.devices['tok_aaaa1111']['status'], 'revocation_pending')
        # Revoking an active row (bot skipped step 1) is refused.
        self.request('ix3', 'revoke', 'tok_bbbb0000')
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix3')['status'], 'failed')

    def test_issue_refused_when_row_not_active_or_hash_mismatch_or_bad_file(self):
        self.bot_issue('ix1', 'tok_aaaa1111', db_row=False)  # bot timed out / no row
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix1')['status'], 'failed')
        self.assertFalse((self.d / 'spool' / 'credentials' / 'tok_aaaa1111').exists())
        self.db.add('tok_cccc3333', 'mph_' + secrets.token_urlsafe(32))
        self.bot_issue('ix2', 'tok_cccc3333', db_row=False)  # different value than the hash
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix2')['error'], 'credential does not match the registry hash')
        self.assertEqual(self.db.devices['tok_cccc3333']['status'], 'revocation_pending')
        tok = self.bot_issue('ix3', 'tok_dddd4444')
        (self.d / 'spool' / 'credentials' / 'tok_dddd4444').chmod(0o644)
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix3')['status'], 'failed')
        self.assertFalse(self.output.exists() and tok in self.allowed())

    def test_malformed_requests_get_a_failed_receipt(self):
        p = self.d / 'spool' / 'requests' / 'ix9.json'
        p.write_text(json.dumps({'v': 1, 'op': 'rm -rf', 'request_id': 'ix9', 'token_id': '../x'}))
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix9')['status'], 'failed')
        self.assertEqual(self.calls(), [])

    def test_registry_wins_and_inactive_on_either_side_is_excluded(self):
        # MVP mac imported then revoked in the DB → excluded even though tokens.json still says active.
        self.db.devices['tok_mvpmac01'] = {'status': 'revoked', 'token_hash': sha(self.mac), 'group_id': 'group-a', 'config_revision': None}
        _, allowed = ta.desired_tokens(self.cfg, self.db)
        self.assertEqual(set(allowed.values()), {self.win})
        # Missing private credential for an active DB row → whole render refused (nothing applied).
        self.db.add('tok_eeee5555', 'mph_' + secrets.token_urlsafe(32))
        with self.assertRaises(ta.ApplyError):
            ta.apply(self.cfg, self.db)
        self.assertEqual(self.calls(), [])

    def test_race_bot_gave_up_during_apply_is_settled(self):
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        real_mark = self.db.mark_applied

        def bot_times_out_first(tid, rev, rid):
            self.db.devices[tid]['status'] = 'revocation_pending'  # bot's 30 s timeout fired meanwhile
            real_mark(tid, rev, rid)
        self.db.mark_applied = bot_times_out_first
        ta.process(self.cfg, self.db)
        self.assertNotIn(token, self.allowed(), 'Caddy does not keep a token the DB no longer allows')

    def test_prepare_import_stages_without_reload_or_probe_and_blocks_legacy_writer(self):
        self.cfg.probe = lambda *a: self.fail('prepare must not probe live Caddy')
        self.assertEqual(ta.import_mvp(self.cfg, self.db, prepare_only=True),
                         ['tok_mvpmac01', 'tok_mvpwindows01'])
        self.assertEqual(self.allowed(), {self.mac, self.win})
        self.assertFalse(self.log.exists(), 'prepare must not run Caddy or reload')
        self.assertTrue((self.cfg.state / 'db-authority').exists())
        self.db.devices['tok_mvpmac01']['status'] = 'revocation_pending'
        ta.import_mvp(self.cfg, self.db, prepare_only=True)
        self.assertNotIn(self.mac, self.allowed(), 'prepare cannot revive a pending token')

    def test_import_mvp_moves_mac_windows_under_db_and_blocks_legacy_render(self):
        (self.d / 'state' / '.lock').touch()
        self.assertEqual(ta.import_mvp(self.cfg, self.db), ['tok_mvpmac01', 'tok_mvpwindows01'])
        self.assertEqual(self.allowed(), {self.mac, self.win})
        self.assertEqual(ta.import_mvp(self.cfg, self.db), ['tok_mvpmac01', 'tok_mvpwindows01'], 'idempotent')
        self.assertEqual(len(self.db.devices), 2)
        legacy = subprocess.run([sys.executable, str(ROOT / 'ops' / 'render-caddy'), '--state-dir', str(self.cfg.state),
                                 '--output', str(self.output), '--owner', 'self', '--prepare-only'], capture_output=True, text=True)
        self.assertEqual(legacy.returncode, 1)
        self.assertIn('token-applier', legacy.stderr)

    def test_real_caddy_validate_accepts_snippet_next_to_office_and_rejects_without_reload(self):
        """Caddy 2.11.9 (pinned digest, Docker). Skips without Docker; never fakes a pass."""
        if subprocess.run(['docker', 'info'], capture_output=True).returncode:
            self.skipTest('docker not available; real Caddy validation not run')
        image = 'caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b'
        wrapper = self.d / 'real-caddy'
        # Mounted at /cfg (Docker Desktop cannot mount at the host path); the Caddyfile imports relatively.
        wrapper.write_text('#!/bin/sh\n[ "$1" = validate ] || exit 9\n'
                           'exec docker run --rm -v "%s:/cfg:ro" %s caddy validate --config /cfg/Caddyfile --adapter caddyfile\n' % (self.d, image))
        wrapper.chmod(0o755)
        self.cfg.caddy_bin = str(wrapper)
        self.caddyfile.write_text('{\n admin off\n auto_https off\n}\n'
                                  'http://office.localhost:18880 {\n respond "office untouched" 200\n}\n'
                                  'http://hub.localhost:18881 {\n import caddy-private/auth.caddy\n}\n')
        token = self.bot_issue('ix1', 'tok_aaaa1111')
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix1')['status'], 'applied', self.receipt('ix1'))
        self.assertIn(token, self.allowed())
        good = self.output.read_text()
        # Someone broke the office block: validate must fail and nothing may reload.
        self.caddyfile.write_text(self.caddyfile.read_text().replace('respond "office untouched" 200', 'respond "office" 200 extra junk'))
        self.log.write_text('')
        self.bot_issue('ix2', 'tok_bbbb2222')
        ta.process(self.cfg, self.db)
        self.assertEqual(self.receipt('ix2')['status'], 'failed')
        self.assertNotIn('reload', self.calls())
        self.assertEqual(self.output.read_text(), good)
        self.assertEqual(self.db.devices['tok_bbbb2222']['status'], 'revocation_pending')

    def test_systemd_units_are_hardened_and_only_touch_hub_paths(self):
        svc = (ROOT / 'ops' / 'templates' / 'hub-token-applier.service').read_text()
        path = (ROOT / 'ops' / 'templates' / 'hub-token-applier.path').read_text()
        timer = (ROOT / 'ops' / 'templates' / 'hub-token-applier.timer').read_text()
        self.assertIn('ExecStart=/opt/neighbor-hub/ops/token-applier process', svc)
        self.assertIn('ReadWritePaths=/etc/caddy/hub-private /var/lib/neighbor-hub/token-spool', svc)
        self.assertNotRegex(svc, r'ReadWritePaths=.*/etc/caddy(\s|$)')
        self.assertIn('DirectoryNotEmpty=/var/lib/neighbor-hub/token-spool/requests', path)
        self.assertIn('OnUnitActiveSec=', timer)


if __name__ == '__main__':
    unittest.main()
