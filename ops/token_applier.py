"""L-03b host TokenApplier: the only writer of the Hub Caddy allowlist once the DB is the authority.

Bot side and spool protocol: docs/ops/runbook-L03-discord.md §4, bot/src/token-applier.mjs.
Flow per request (one at a time, single lock):
  issue : DB row active + sha256(credential) == token_hash → move credential to the private token dir
          → render allowlist → caddy validate → reload → probes (no token 401, new token 200)
          → devices.config_revision + audit → receipt applied.  Any failure → previous snippet kept,
          row moved to revocation_pending (fail closed), receipt failed.
  revoke: DB row revocation_pending (set by the bot) → render without it → validate → reload →
          probe old token == 401 → devices revoked + audit → delete credential → receipt applied
          (probe 401).  Any failure → stays revocation_pending, receipt failed.
Validate failure never reloads. Only the hub private snippet (default /etc/caddy/hub-private/auth.caddy)
is written; the office site is never touched. No token value is ever printed or put in receipts.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import shlex
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hub_ops import atomic_write, private_read, render, probe as http_probe, TOKEN  # noqa: E402

REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')
TOKEN_ID = re.compile(r'tok_[a-z0-9]{8,32}\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
AUTHORITY_MARKER = 'db-authority'


class ApplyError(RuntimeError):
    pass


def sha256(value):
    return hashlib.sha256(value.encode()).hexdigest()


# --------------------------------------------------------------------------- DB (psql, no host port)

class PsqlDb:
    """Runs SQL through `ops/postgres psql` (docker exec, superuser, hub DB). Values go in as psql
    variables, never string-formatted SQL; IDs are regex-checked before they get here anyway."""

    def __init__(self, command, group_id='group-a'):
        self.command = command
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,62}', group_id):
            raise ApplyError('invalid group_id')
        self.group_id = group_id

    def _sql(self, sql, **variables):
        variables['gid'] = self.group_id
        args = [*self.command, '-Atq']
        for key, value in variables.items():
            args += ['-v', f'{key}={value}']
        result = subprocess.run(args, input=sql, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ApplyError('database unavailable or query failed')
        return result.stdout.strip()

    def _json(self, sql, **v):
        out = self._sql(sql, **v)
        return json.loads(out) if out else None

    def export(self):
        return self._json("select coalesce(json_agg(json_build_object('token_id', token_id, 'token_hash', token_hash,"
                          " 'group_id', group_id) order by token_id), '[]') from public.caddy_allowlist_export where group_id = :'gid';")

    def all_hashes(self):
        return set(self._json("select coalesce(json_agg(token_hash), '[]') from public.devices where group_id = :'gid';"))

    def device(self, token_id):
        return self._json("select json_build_object('status', status, 'token_hash', token_hash, 'group_id', group_id)"
                          " from public.devices where group_id = :'gid' and token_id = :'tid';", tid=token_id)

    def next_revision(self):
        return int(self._sql("select coalesce(max(config_revision), 0) + 1 from public.devices where group_id = :'gid';"))

    def _audit(self, action):
        return (f"insert into public.audit_log (group_id, actor_type, actor_id, action, target_table, target_id, request_id, details)"
                f" select group_id, 'ops', 'TokenApplier', '{action}', 'devices', token_id, :'rid', json_build_object(%s)::jsonb"
                f" from public.devices where group_id = :'gid' and token_id = :'tid'")

    def mark_applied(self, token_id, revision, request_id):
        self._sql("begin; update public.devices set config_revision = :rev where group_id = :'gid' and token_id = :'tid' and status = 'active';"
                  + self._audit('device.config.applied') % "'config_revision', :rev" + "; commit;",
                  tid=token_id, rev=revision, rid=request_id)

    def fail_issue(self, token_id, request_id, reason):
        self._sql("begin; update public.devices set status = 'revocation_pending', revocation_requested_at = now(),"
                  " revoked_by = 'TokenApplier', revoke_reason = :'why' where group_id = :'gid' and token_id = :'tid' and status = 'active';"
                  + self._audit('device.issue.failed') % "'reason', :'why'" + "; commit;",
                  tid=token_id, rid=request_id, why=reason)

    def complete_revocation(self, token_id, revision, request_id):
        self._sql("begin; update public.devices set status = 'revoked', revoked_at = now(), config_revision = :rev"
                  " where group_id = :'gid' and token_id = :'tid' and status = 'revocation_pending';"
                  + self._audit('device.revoke.applied') % "'config_revision', :rev" + "; commit;",
                  tid=token_id, rev=revision, rid=request_id)

    def import_device(self, *, token_id, token_hash, label, platform, agent):
        """MVP token → DB row of the group's owner (idempotent on token_hash)."""
        self._sql("insert into public.devices (member_id, group_id, label, platform, token_id, token_prefix, token_hash, allowed_agents)"
                  " select m.id, m.group_id, :'label', :'plat', :'tid', 'mvp_' || left(:'tid', 8), :'hash', array[:'agent']"
                  " from public.members m where m.group_id = :'gid' and m.role = 'owner' and m.status = 'active'"
                  " order by m.created_at limit 1 on conflict do nothing;",
                  tid=token_id, hash=token_hash, label=label, plat=platform, agent=agent)
        return self.device(token_id)


# --------------------------------------------------------------------------- files

def read_owned_secret(path, *, owner_uid=None):
    """Regular file, mode 600, optional owner, one base64url token."""
    if path.is_symlink() or not path.is_file():
        raise ApplyError('credential must be a regular file')
    st = path.stat()
    if stat.S_IMODE(st.st_mode) != 0o600 or (owner_uid is not None and st.st_uid != owner_uid):
        raise ApplyError('credential must be mode 600 and owned by the spool owner')
    value = path.read_text().strip()
    if not TOKEN.fullmatch(value) and not re.fullmatch(r'mph_[A-Za-z0-9_-]{40,60}', value):
        raise ApplyError('credential has an unexpected format')
    return value


def write_receipt(cfg, request_id, receipt):
    path = cfg.spool / 'receipts' / f'{request_id}.json'
    st = cfg.spool.stat()
    # The bot (spool owner) must be able to read it; mode stays 600.
    atomic_write(path, json.dumps({'request_id': request_id, **receipt}) + '\n',
                 owner=(st.st_uid, st.st_gid) if os.geteuid() == 0 else None)


@contextmanager
def applier_lock(state):
    fd = os.open(state / '.token-applier.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


# --------------------------------------------------------------------------- render + apply

def mvp_registry(cfg):
    path = cfg.state / 'tokens.json'
    registry = json.loads(private_read(path))
    if registry['group_id'] != getattr(cfg, 'group_id', registry['group_id']):
        raise ApplyError('registry group does not match configured group')
    return registry


def desired_tokens(cfg, db):
    """{token_id: token} that Caddy should accept. DB export wins; MVP tokens.json devices that were never
    imported stay allowed while active there. Anything non-active on EITHER side is excluded (fail closed)."""
    registry = mvp_registry(cfg)
    group_id = getattr(cfg, 'group_id', registry['group_id'])
    export = db.export()
    db_hashes = db.all_hashes()
    mvp_inactive = {sha256(d['token']) for d in registry['devices'].values() if d['status'] != 'active'}
    allowed = {}
    for row in export:
        if row['group_id'] != group_id:
            continue
        if not TOKEN_ID.fullmatch(row['token_id']) or not HASH.fullmatch(row['token_hash']):
            raise ApplyError('unexpected row in caddy_allowlist_export')
        path = cfg.token_dir / row['token_id']
        try:
            value = private_read(path).strip()
        except (RuntimeError, OSError):
            raise ApplyError(f"missing private credential for {row['token_id']}; nothing applied") from None
        if sha256(value) != row['token_hash']:
            raise ApplyError(f"credential hash mismatch for {row['token_id']}; nothing applied")
        if row['token_hash'] not in mvp_inactive:
            allowed[row['token_id']] = value
    for key, device in registry['devices'].items():
        h = sha256(device['token'])
        if device['status'] == 'active' and h not in db_hashes:
            allowed[f'mvp_{key}'] = device['token']
    return registry, allowed


def apply(cfg, db, *, expect_ok=(), expect_denied=()):
    """Render → validate → reload → probe. Returns the config revision. Raises ApplyError with the previous
    snippet restored when validate/reload fails (no reload happens after a failed validate)."""
    registry, allowed = desired_tokens(cfg, db)
    revision = db.next_revision()
    data = {'revision': revision, 'upstream': registry['upstream'],
            'devices': {k: {'token': v, 'status': 'active'} for k, v in sorted(allowed.items())}}
    text = render(data, cfg.upstream, getattr(cfg, 'memory_upstream', None))
    output = cfg.output
    if output.is_symlink() or output.parent.is_symlink():
        raise ApplyError('Caddy output must not be a symlink')
    old = private_read(output) if output.exists() else None
    account = pwd.getpwuid(os.getuid()) if cfg.owner == 'self' else pwd.getpwnam(cfg.owner)
    owner = (account.pw_uid, account.pw_gid)
    atomic_write(output, text, owner=owner)
    try:
        run_quiet([cfg.caddy_bin, 'validate', '--config', str(cfg.config), '--adapter', 'caddyfile'], 'caddy validate')
        run_quiet(cfg.reload_cmd, 'caddy reload')
    except ApplyError:
        if old is None:
            output.unlink()
        else:
            atomic_write(output, old, owner=owner)
        raise
    (cfg.state / AUTHORITY_MARKER).touch(mode=0o600, exist_ok=True)
    if cfg.probe(cfg.probe_url, None) != 401:
        raise ApplyError('no-token probe was not 401; applied config unconfirmed')
    for token in expect_ok:
        if cfg.probe(cfg.probe_url, token) != 200:
            raise ApplyError('new token probe was not 200; applied config unconfirmed')
    codes = [cfg.probe(cfg.probe_url, token) for token in expect_denied]
    return revision, allowed, codes


def run_quiet(command, what):
    try:
        result = subprocess.run(command, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise ApplyError(f'{what} could not run') from None
    if result.returncode:
        # Caddy output may echo parts of the private snippet: never print it.
        raise ApplyError(f'{what} failed; output suppressed')


def settle(cfg, db, applied_tokens):
    """If the DB changed while we applied (e.g. the bot gave up and marked the row pending), render again
    so Caddy never keeps a token the DB no longer allows."""
    _, now = desired_tokens(cfg, db)
    if set(now.values()) != set(applied_tokens.values()):
        apply(cfg, db)


# --------------------------------------------------------------------------- requests

def handle_issue(cfg, db, req):
    tid, rid = req['token_id'], req['request_id']
    cred = cfg.spool / 'credentials' / tid
    dev = db.device(tid)
    if not dev or dev['group_id'] != getattr(cfg, 'group_id', 'group-a') or req.get('group_id') != dev['group_id'] or dev['status'] != 'active':
        cred.unlink(missing_ok=True)
        return {'status': 'failed', 'error': 'device is not active in the registry'}
    try:
        token = read_owned_secret(cred, owner_uid=cfg.spool.stat().st_uid if os.geteuid() == 0 else None)
    except ApplyError as e:
        db.fail_issue(tid, rid, 'credential_invalid')
        cred.unlink(missing_ok=True)
        return {'status': 'failed', 'error': str(e)}
    if sha256(token) != dev['token_hash']:
        db.fail_issue(tid, rid, 'hash_mismatch')
        cred.unlink(missing_ok=True)
        return {'status': 'failed', 'error': 'credential does not match the registry hash'}
    target = cfg.token_dir / tid
    atomic_write(target, token + '\n')
    cred.unlink(missing_ok=True)
    try:
        revision, applied, _ = apply(cfg, db, expect_ok=[token])
    except ApplyError as e:
        db.fail_issue(tid, rid, 'apply_failed')
        target.unlink(missing_ok=True)
        try:
            settle(cfg, db, {})
        except ApplyError:
            pass  # previous snippet is still live; the pending row is excluded on the next successful run
        return {'status': 'failed', 'error': str(e)}
    db.mark_applied(tid, revision, rid)
    settle(cfg, db, applied)
    return {'status': 'applied', 'config_revision': revision}


def handle_revoke(cfg, db, req):
    tid, rid = req['token_id'], req['request_id']
    dev = db.device(tid)
    if not dev or dev['group_id'] != getattr(cfg, 'group_id', 'group-a') or req.get('group_id') != dev['group_id'] or dev['status'] == 'active':
        return {'status': 'failed', 'error': 'device is not pending revocation'}
    secret = cfg.token_dir / tid
    try:
        old = private_read(secret).strip()
    except (RuntimeError, OSError):
        return {'status': 'failed', 'error': 'no private credential to probe; operator must verify'}
    try:
        revision, _, codes = apply(cfg, db, expect_denied=[old])
    except ApplyError as e:
        return {'status': 'failed', 'error': str(e)}
    if codes != [401]:
        return {'status': 'failed', 'probe': codes[0], 'error': 'old token still accepted'}
    db.complete_revocation(tid, revision, rid)
    secret.unlink(missing_ok=True)
    return {'status': 'applied', 'config_revision': revision, 'probe': 401}


def parse_request(path):
    req = json.loads(path.read_text())
    if (req.get('v') != 1 or req.get('op') not in {'issue', 'revoke'}
            or not isinstance(req.get('request_id'), str) or not REQUEST_ID.fullmatch(req['request_id'])
            or req['request_id'] != path.stem
            or not isinstance(req.get('token_id'), str) or not TOKEN_ID.fullmatch(req['token_id'])):
        raise ValueError('malformed request')
    return req


def process(cfg, db):
    """Handle every pending request once. Returns a list of (request_id, status) for logging."""
    done = []
    with applier_lock(cfg.state):
        requests = sorted((cfg.spool / 'requests').glob('*.json'), key=lambda p: (p.stat().st_mtime, p.name))
        for path in requests:
            rid = path.stem
            archive = cfg.spool / 'done'
            archive.mkdir(mode=0o700, exist_ok=True)
            if not REQUEST_ID.fullmatch(rid):
                path.rename(archive / 'invalid.json')
                continue
            if (cfg.spool / 'receipts' / f'{rid}.json').exists():
                path.rename(archive / path.name)  # already answered: idempotent, never re-applied
                done.append((rid, 'duplicate'))
                continue
            try:
                req = parse_request(path)
            except (ValueError, json.JSONDecodeError, OSError):
                write_receipt(cfg, rid, {'status': 'failed', 'error': 'malformed request'})
                path.rename(archive / path.name)
                done.append((rid, 'malformed'))
                continue
            try:
                receipt = handle_issue(cfg, db, req) if req['op'] == 'issue' else handle_revoke(cfg, db, req)
            except ApplyError as e:
                # DB unreachable etc.: answer so the bot does not wait; issue rows stay whatever the DB says
                # (the bot already treats no-confirm as fail closed).
                receipt = {'status': 'failed', 'error': str(e)}
            write_receipt(cfg, rid, receipt)
            path.rename(archive / path.name)
            done.append((rid, receipt['status']))
    return done


def import_mvp(cfg, db):
    """Move the MVP Mac/Windows tokens under DB authority (hash in devices, value in the token dir)."""
    registry = mvp_registry(cfg)
    imported = []
    with applier_lock(cfg.state):
        for key, device in sorted(registry['devices'].items()):
            if device['status'] != 'active':
                continue
            group_id = getattr(cfg, 'group_id', 'group-a')
            tid = f'tok_mvp{key}01' if group_id == 'group-a' else 'tok_mvp' + sha256(group_id + ':' + key)[:16]
            atomic_write(cfg.token_dir / tid, device['token'] + '\n')
            row = db.import_device(token_id=tid, token_hash=sha256(device['token']),
                                   label=f'維護者 / {key} (MVP)', platform='macos' if key == 'mac' else 'windows',
                                   agent=device.get('agent', ''))
            if not row or row['token_hash'] != sha256(device['token']):
                (cfg.token_dir / tid).unlink(missing_ok=True)
                raise ApplyError(f'import of {key} did not land in the registry (owner member missing?)')
            imported.append(tid)
        apply(cfg, db, expect_ok=[d['token'] for d in registry['devices'].values() if d['status'] == 'active'])
    return imported


# --------------------------------------------------------------------------- CLI

def build_config(args):
    cfg = argparse.Namespace(**vars(args))
    cfg.reload_cmd = shlex.split(args.reload_cmd)
    cfg.probe = http_probe
    for directory in (cfg.state, cfg.token_dir):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise ApplyError(f'{directory} must be mode 700 and not a symlink')
    if cfg.spool.is_symlink() or stat.S_IMODE(cfg.spool.stat().st_mode) != 0o700:
        raise ApplyError('spool directory must be mode 700 and not a symlink')
    for sub in ('requests', 'receipts', 'credentials'):
        (cfg.spool / sub).mkdir(mode=0o700, exist_ok=True)
    return cfg


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('command', choices=['process', 'render', 'import-mvp'])
    p.add_argument('--group-id', default='group-a')
    p.add_argument('--state', type=Path, default=Path('/var/lib/neighbor-hub/private'))
    p.add_argument('--token-dir', type=Path, default=Path('/var/lib/neighbor-hub/private/tokens-db'))
    p.add_argument('--spool', type=Path, default=Path('/var/lib/neighbor-hub/token-spool'))
    p.add_argument('--output', type=Path, default=Path('/etc/caddy/hub-private/auth.caddy'))
    p.add_argument('--config', type=Path, default=Path('/etc/caddy/Caddyfile'))
    p.add_argument('--owner', default='caddy')
    p.add_argument('--memory-upstream')
    p.add_argument('--upstream', default='127.0.0.1:8765')
    p.add_argument('--caddy-bin', default='/usr/bin/caddy')
    p.add_argument('--reload-cmd', default='systemctl reload caddy')  # system Caddy ExecReload = caddy reload --force
    p.add_argument('--probe-url', default='https://hub.example.invalid/health/liveness')
    p.add_argument('--psql', default=shlex.quote(str(Path(__file__).resolve().parent / 'postgres')) + ' psql')
    args = p.parse_args(argv)
    try:
        cfg = build_config(args)
        db = PsqlDb(shlex.split(args.psql), args.group_id)
        if args.command == 'process':
            for rid, status in process(cfg, db):
                print(json.dumps({'t': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'request_id': rid, 'status': status}))
        elif args.command == 'render':
            with applier_lock(cfg.state):
                apply(cfg, db)
            print('Allowlist rendered from the registry, validated, reloaded; no-token probe 401')
        elif args.command == 'import-mvp':
            print('Imported under DB authority: ' + ', '.join(import_mvp(cfg, db)))
    except ApplyError as e:
        print('FAILED: ' + str(e), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, RuntimeError):
        print('FAILED: private state could not be applied; inspect permissions, registry and service locally', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
