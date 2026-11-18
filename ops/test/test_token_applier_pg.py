"""L-03b PsqlDb against a real Postgres (L-01 pgvector:pg18 digest, all supabase migrations + seed).
Skips when Docker is unavailable. Also runs one issue → revoke round trip through process()."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops'))
sys.path.insert(0, str(ROOT / 'ops' / 'test'))
import token_applier as ta  # noqa: E402
import test_token_applier as unit  # noqa: E402

IMAGE = 'pgvector/pgvector:pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782'
NAME = f'l03b-pg-{os.getpid()}'
維護者 = '00000000-0000-4000-8000-0000000000a1'
DOCKER = (
    os.environ.get('HUB_TEST_NO_DOCKER') != '1'
    and shutil.which('docker') is not None
    and subprocess.run(['docker', 'info'], capture_output=True).returncode == 0
)


def sha(v):
    return hashlib.sha256(v.encode()).hexdigest()


def psql(sql, db='hub'):
    r = subprocess.run(['docker', 'exec', '-i', NAME, 'psql', '-X', '-Atq', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1'],
                       input=sql, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


@unittest.skipUnless(DOCKER, 'docker not available')
class PsqlDbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        platform = 'linux/arm64' if os.uname().machine == 'arm64' else 'linux/amd64'
        subprocess.run(['docker', 'run', '-d', '--rm', '--name', NAME, '--platform', platform,
                        '-e', 'POSTGRES_PASSWORD=' + secrets.token_hex(16), IMAGE], check=True, capture_output=True)
        for _ in range(240):
            if subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], capture_output=True).returncode == 0:
                break
            subprocess.run(['sleep', '0.5'])
        psql('create database hub_template;', db='postgres')
        for f in sorted((ROOT / 'supabase' / 'migrations').glob('*.sql')):
            psql(f.read_text(), db='hub_template')
        psql((ROOT / 'supabase' / 'seed.sql').read_text(), db='hub_template')

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True)

    def setUp(self):
        psql('drop database if exists hub; create database hub template hub_template;', db='postgres')
        self.db = ta.PsqlDb(['docker', 'exec', '-i', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'hub', '-v', 'ON_ERROR_STOP=1'])

    def add_device(self, tid, token):
        psql(f"insert into devices (member_id, group_id, label, platform, token_id, token_prefix, token_hash)"
             f" values ('{維護者}', 'group-a', '維護者 / t', 'linux', '{tid}', 'mph_xxxx', '{sha(token)}');")

    def test_group_scoped_reads_updates_and_import_as_service_role(self):
        member = '00000000-0000-4000-8000-0000000000b1'
        psql("insert into groups(id,display_name,project_key,mail_hostname) values ('grp-test2','B','/data/projects/grp-test2','b.local');"
             f"insert into members(id,group_id,display_name,role) values ('{member}','grp-test2','B','owner');"
             f"insert into devices(member_id,group_id,label,platform,token_id,token_prefix,token_hash) values ('{member}','grp-test2','B','linux','tok_foreign01','mph_test',repeat('b',64));")
        command = ['docker', 'exec', '-i', '-e', 'PGOPTIONS=-crole=service_role', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'hub', '-v', 'ON_ERROR_STOP=1']
        a, b = ta.PsqlDb(command, 'group-a'), ta.PsqlDb(command, 'grp-test2')
        self.assertEqual(len(a.export()), 2)
        self.assertEqual([r['token_id'] for r in b.export()], ['tok_foreign01'])
        self.assertIsNone(a.device('tok_foreign01'))
        self.assertIsNone(b.device('tok_fakemac01'))
        self.assertEqual(b.all_hashes(), {'b' * 64})
        a.mark_applied('tok_foreign01', 99, 'forbidden')
        a.fail_issue('tok_foreign01', 'forbidden', 'foreign')
        self.assertEqual(b.device('tok_foreign01')['status'], 'active')
        self.assertEqual(b.next_revision(), 1)
        row = b.import_device(token_id='tok_importb01', token_hash='c'*64, label='B', platform='linux', agent='RedStone')
        self.assertEqual(row['group_id'], 'grp-test2')

    def test_reads_and_state_transitions_with_audit(self):
        self.assertEqual([r['token_id'] for r in self.db.export()], ['tok_fakemac01', 'tok_fakewin01'])
        self.assertEqual(len(self.db.all_hashes()), 2)
        self.assertEqual(self.db.device('tok_fakemac01')['status'], 'active')
        self.assertIsNone(self.db.device('tok_nope0000'))
        self.assertEqual(self.db.next_revision(), 1)
        self.db.mark_applied('tok_fakemac01', 7, 'ix1')
        self.assertEqual(self.db.next_revision(), 8)
        self.db.fail_issue('tok_fakewin01', 'ix2', "it's quoted; drop table devices; --")
        self.assertEqual(self.db.device('tok_fakewin01')['status'], 'revocation_pending')
        self.db.complete_revocation('tok_fakewin01', 8, 'ix3')
        self.assertEqual(self.db.device('tok_fakewin01')['status'], 'revoked')
        actions = psql("select string_agg(action || ':' || target_id || ':' || request_id, ',' order by id) from audit_log where actor_id = 'TokenApplier'")
        self.assertEqual(actions, 'device.config.applied:tok_fakemac01:ix1,device.issue.failed:tok_fakewin01:ix2,device.revoke.applied:tok_fakewin01:ix3')
        self.assertEqual(psql("select details->>'reason' from audit_log where action = 'device.issue.failed'"), "it's quoted; drop table devices; --")
        # Trigger still guards: a failed issue never goes back to active through the applier.
        self.db.mark_applied('tok_fakewin01', 9, 'ix4')
        self.assertEqual(self.db.device('tok_fakewin01')['status'], 'revoked')

    def test_import_device_is_idempotent_and_db_down_raises(self):
        token = secrets.token_urlsafe(32)
        row = self.db.import_device(token_id='tok_mvpmac01', token_hash=sha(token), label="維護者 / mac (MVP)", platform='macos', agent='BlueLake')
        self.assertEqual(row['token_hash'], sha(token))
        self.db.import_device(token_id='tok_mvpmac01', token_hash=sha(token), label='x', platform='macos', agent='BlueLake')
        self.assertEqual(psql("select count(*) || ':' || array_to_string(allowed_agents, ',') from devices where token_id='tok_mvpmac01' group by allowed_agents"), '1:BlueLake')
        with self.assertRaises(ta.ApplyError):
            ta.PsqlDb(['docker', 'exec', '-i', 'no-such-container', 'psql']).export()

    def test_issue_then_revoke_round_trip_through_process(self):
        # Reuse the fake Caddy / spool rig from the unit tests, but with the real registry.
        rig = unit.TokenApplierTests('test_issue_success_validates_reloads_probes_and_records_revision')
        rig.setUp()
        try:
            rig.db = self.db
            for tid, token in (('tok_fakemac01', 'FAKE-mac-token-do-not-use'), ('tok_fakewin01', 'FAKE-windows-token-do-not-use')):
                ta.atomic_write(rig.cfg.token_dir / tid, token + '\n')  # seed rows' private values
            token = 'mph_' + secrets.token_urlsafe(32)
            self.add_device('tok_aaaa1111', token)
            cred = rig.d / 'spool' / 'credentials' / 'tok_aaaa1111'
            cred.write_text(token + '\n')
            cred.chmod(0o600)
            rig.request('ix1', 'issue', 'tok_aaaa1111')
            self.assertEqual(ta.process(rig.cfg, self.db), [('ix1', 'applied')])
            self.assertIn(token, rig.allowed())
            self.assertEqual(psql("select config_revision from devices where token_id='tok_aaaa1111'"), str(rig.receipt('ix1')['config_revision']))
            psql("update devices set status='revocation_pending', revocation_requested_at=now() where token_id='tok_aaaa1111'")
            rig.request('ix2', 'revoke', 'tok_aaaa1111')
            ta.process(rig.cfg, self.db)
            self.assertEqual(rig.receipt('ix2')['probe'], 401)
            self.assertEqual(psql("select status from devices where token_id='tok_aaaa1111'"), 'revoked')
            self.assertNotIn(token, rig.allowed())
            self.assertIn('FAKE-mac-token-do-not-use', rig.allowed())
        finally:
            rig.tearDown()


if __name__ == '__main__':
    unittest.main()
