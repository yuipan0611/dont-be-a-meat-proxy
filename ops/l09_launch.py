"""L09 operator driver; subprocess output stays private (Caddy can echo credentials)."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import stat
import subprocess
import tarfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/var/lib/neighbor-hub/l09')
PRIVATE = Path('/var/lib/neighbor-hub/private')
CADDY = Path('/etc/caddy/Caddyfile')
SITE = Path('/etc/caddy/hub.caddy')
AUTH = Path('/etc/caddy/hub-private/group-a/auth.caddy')
SPOOL = Path('/var/lib/neighbor-hub/token-spool')
ENV = {'PATH': os.environ.get('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'),
       'HOME': '/root', 'LANG': 'C.UTF-8', 'DOCKER_HOST': 'unix:///var/run/docker.sock'}
J = {}


class Stop(RuntimeError):
    pass


def require(ok, label):
    if not ok:
        raise Stop(label)


def evidence(label, value='OK'):
    print(f'{label}={value}', flush=True)


def run(argv, label, *, data=None, env=None, timeout=900, check=True):
    # Never echo argv, stdout, stderr or an exception containing them.
    try:
        r = subprocess.run([str(a) for a in argv], input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=env or ENV, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop(label + ': unavailable/timeout; inspect privately, do not blindly retry') from None
    if check:
        require(r.returncode == 0, label + ': command failed (output suppressed)')
    return r


def dc(project, files, *args, **kwargs):
    return run(['docker', 'compose', '-p', project, *sum((['-f', ROOT / f] for f in files), []), *args],
               'compose ' + project + ' ' + str(args[0]), **kwargs)


BASE = ['deploy/compose.yaml', 'deploy/hubclock/compose.hubclock.yaml']
EXTRA = ['deploy/bot/compose.bot.yaml', 'deploy/memory-bridge/compose.bridge.yaml', 'deploy/web/compose.web.yaml']
VALID = ['deploy/validator/compose.validator.yaml', 'deploy/validator/compose.hubclock-validator.yaml']


def hub(*args, final=True, **kw):
    return dc('neighbor-hub', BASE + EXTRA + (VALID + ['deploy/l09/compose.launch.yaml'] if final else []), *args, **kw)


def mem(*args, **kw):
    files = ['deploy/memory/compose.yaml']
    if ENV.get('HUB_LLM_BACKEND', 'groq-api') == 'groq-api':
        files.append('deploy/memory/compose.groq.yaml')
    elif ENV.get('HUB_LLM_BACKEND') in ('gemini-api-free', 'gemini-api-paid'):
        files.append('deploy/memory/compose.gemini-api.yaml')
    return dc('neighbor-hub-memory', files, *args, **kw)


def pg(*args, data=None):
    return run([ROOT / 'ops/postgres', *args], 'postgres ' + args[0], data=data)


def sql(query):
    return pg('psql', '-Atq', data=query.encode()).stdout.decode().strip()


def save():
    write(STATE / 'journal.json', json.dumps(J, indent=2) + '\n')


def write(path, value, uid=0, gid=0, mode=0o600):
    require(not path.is_symlink(), 'refuse symlink destination')
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.l09-tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(value)
            os.fchmod(f.fileno(), mode)
            os.fchown(f.fileno(), uid, gid)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def directory(path, uid=0, gid=0, mode=0o700):
    require(not path.is_symlink(), 'refuse symlink directory')
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, mode)
    os.chown(path, uid, gid)


def secret_file(path, uid=0, modes=(0o600,)):
    require(path.is_file() and not path.is_symlink(), 'missing/non-regular private file: ' + path.name)
    s = path.stat()
    require(s.st_uid == uid and stat.S_IMODE(s.st_mode) in modes, 'unsafe owner/mode: ' + path.name)
    value = path.read_text().strip()
    require(bool(value), 'empty private file: ' + path.name)
    return value


def put_secret(path, value, uid=0, gid=0, mode=0o400):
    if path.exists():
        require(secret_file(path, uid, (mode,)) == value, 'existing secret differs; do not rotate: ' + path.name)
    else:
        write(path, value + '\n', uid, gid, mode)


def request(url, token=None):
    try:
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (OSError, ValueError):
        raise Stop('HTTP probe unreachable; details suppressed') from None


def office():
    code = request(ENV['L09_OFFICE_URL'])
    evidence('office_http', code)
    require(code == 200, 'office must be 200')


def containers():
    out = {}
    for service in ('mail-a', 'hubclock', 'db'):
        project = 'neighbor-hub-db' if service == 'db' else 'neighbor-hub'
        ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                   '--filter', 'label=com.docker.compose.service=' + service], 'container identity').stdout.decode().split()
        require(len(ids) == 1, 'expected exactly one running ' + service)
        obj = json.loads(run(['docker', 'inspect', ids[0]], 'inspect container').stdout)[0]
        require(not obj['State'].get('OOMKilled'), service + ' OOM')
        out[service] = {'id': obj['Id'], 'started': obj['State']['StartedAt']}
    return out


def unchanged(expected):
    now = containers()
    require(now == expected, 'unexpected Mail/HubClock/DB identity or StartedAt change')
    evidence('protected_containers', 'IDs+StartedAt unchanged')


def tcp_free(port):
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', int(port)))
        except OSError:
            raise Stop('new loopback port already in use: ' + port) from None


def step1():
    office()
    require(request(ENV['HUB_PUBLIC_URL'] + '/health/liveness') == 401, 'baseline hub must reject no-token')
    # Threshold covers ~1.7 GiB Hindsight RSS, its 2 GiB cap and the other new services + headroom.
    info = dict(re.findall(r'^(\w+):\s+(\d+)', Path('/proc/meminfo').read_text(), re.M))
    available = int(info['MemAvailable']) // 1024
    evidence('MemAvailable_MiB', available)
    require(available >= 3584, 'need >=3584 MiB available before adding Hindsight and consumers')
    free = shutil.disk_usage('/var/lib/docker').free // (1 << 30)
    evidence('docker_free_GiB', free)
    require(free >= 12, 'need >=12 GiB free for images/models/backups')
    v = run(['docker', 'compose', 'version', '--short'], 'compose version').stdout.decode().strip().lstrip('v')
    require(tuple(map(int, re.match(r'(\d+)\.(\d+)\.(\d+)', v).groups())) >= (2, 24, 4), 'Compose >=2.24.4 required')
    run(['caddy', 'version'], 'Caddy installed')
    # Existing db bind mounts must see this release without recreating L-01 Postgres.
    expected = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in (ROOT / 'supabase/migrations').glob('*.sql')}
    mounted = dc('neighbor-hub-db', ['deploy/postgres/compose.yaml'], 'exec', '-T', 'db',
                 'sh', '-c', 'sha256sum /supabase/migrations/*.sql').stdout.decode().splitlines()
    actual = {Path(line.split()[1]).name: line.split()[0] for line in mounted}
    require(actual == expected, 'existing db /supabase mount is stale; deploy files into its current bind source, do not recreate DB')

    hub('config', '--quiet')  # !reset parsing is part of this gate.
    mem('config', '--quiet')
    require(SITE.read_text().count('import /etc/caddy/hub-private/auth.caddy') == 1, 'site must contain exactly one legacy auth import')
    require(str(SITE) in CADDY.read_text(), 'Caddyfile must import existing hub site; inspect privately')
    for p in ('discord.token', 'discord-client.secret', 'postgres.password', 'hub-app.password', 'tokens.json'):
        secret_file(PRIVATE / p)
    if ENV.get('HUB_LLM_BACKEND') in ('gemini-api-free', 'gemini-api-paid'):
        secret_file(PRIVATE / 'gemini-api.key')
    if ENV.get('HUB_LLM_BACKEND', 'groq-api') == 'groq-api':
        secret_file(PRIVATE / 'groq.key')
    for p in (PRIVATE / 'bot/github.token', PRIVATE / 'web/github.token'):
        require(not p.exists(), 'this launch requires GitHub token absent (/task fail-closed)')
    for p in ('8780', '8781'):
        tcp_free(p)
    J['before'] = containers()
    evidence('baseline', 'mail-a+hubclock+db identities recorded')
    # Frozen throughout launch. Do not let an applier perform an extra reload in the maintenance window.
    for unit in ('hub-token-applier.path', 'hub-token-applier.timer', 'hub-token-applier@group-a.timer'):
        exists = run(['systemctl', 'cat', unit], 'unit existence', check=False).returncode == 0
        if exists:
            run(['systemctl', 'disable', '--now', unit], 'freeze token writer')
    require(run(['systemctl', 'is-active', 'hub-token-applier.service'], 'legacy applier idle', check=False).returncode != 0,
            'legacy applier still running; wait for completion before launch')
    require(run(['systemctl', 'is-active', 'hub-token-applier@group-a.service'], 'group applier idle', check=False).returncode != 0,
            'group applier still running; wait for completion before launch')
    require(not hub('ps', '-q', 'bot').stdout.strip(), 'bot must be stopped before launch')
    if not (STATE / 'caddy-before').exists():
        shutil.copytree('/etc/caddy', STATE / 'caddy-before')
    # Full original backup includes SQLite, private, HubClock and PG. No new consumer has started.
    backup_env = {**ENV, 'HUB_PG_BACKUP': '1', 'HUB_HINDSIGHT_BACKUP': '0'}
    run([ROOT / 'ops/backup', '--quiet'], 'prelaunch full backup', env=backup_env)
    backups = sorted(Path('/var/lib/neighbor-hub/backups').glob('hub-backup-*.tar.gz'))
    require(bool(backups), 'backup archive missing')
    archive = backups[-1]
    J['backup'] = str(archive)
    with tarfile.open(archive) as t:
        dump = t.extractfile('./postgres/hub.dump').read()
        manifest = json.load(t.extractfile('./manifest.json'))
    require(hashlib.sha256(dump).hexdigest() == manifest['postgres']['sha256'], 'PG dump hash mismatch')
    pg('verify-dump', data=dump)
    require(sql("select count(*) from pg_database where datname='hub_l09_restore';") == '0', 'restore test DB already exists')
    sql('create database hub_l09_restore; revoke connect on database hub_l09_restore from public;')
    dc('neighbor-hub-db', ['deploy/postgres/compose.yaml'], 'exec', '-T', 'db', 'pg_restore', '-U', 'postgres',
       '-d', 'hub_l09_restore', '--no-owner', '--exit-on-error', data=dump)
    restored = pg('psql', '-d', 'hub_l09_restore', '-Atqc', 'select count(*) from _hub_ops.migrations').stdout.decode().strip()
    evidence('restore_migrations', restored)
    require(restored == sql('select count(*) from _hub_ops.migrations;'), 'restore ledger count differs')
    sql('drop database hub_l09_restore;')
    evidence('backup_restore', 'full archive + hash + real isolated pg_restore PASS')
    unchanged(J['before'])


def step2():
    unchanged(J['before'])
    output = pg('migrate').stdout.decode()
    for line in output.splitlines():
        if re.fullmatch(r'(SKIP|APPLY) \d{14}_[a-z0-9_]+\.sql', line):
            evidence('migration', line)
    again = pg('migrate').stdout.decode()
    require('APPLY ' not in again, 'migration rerun not idempotent')
    count = sql('select count(*) from _hub_ops.migrations;')
    require(count == str(len(list((ROOT / 'supabase/migrations').glob('*.sql')))), 'migration ledger incomplete')
    evidence('migrations_total', count)
    # Snowflakes validated before interpolation; never seed production.
    guild, user = ENV['HUB_DISCORD_GUILD_ID'], ENV['L09_OWNER_DISCORD_ID']
    sql(f"""begin;
insert into groups(id,display_name,project_key,mail_hostname,bank_id)
values('group-a','A 組','/data/projects/group-a','hub.example.invalid','group-a')
on conflict(id) do update set bank_id='group-a';
insert into members(group_id,display_name,role) values('group-a','維護者','owner') on conflict do nothing;
insert into discord_links(member_id,guild_id,discord_user_id)
select id,'{guild}','{user}' from members where group_id='group-a' and display_name='維護者' and status='active'
on conflict do nothing; commit;""")
    require(sql(f"select count(*) from discord_links l join members m on m.id=l.member_id where m.group_id='group-a' and m.role='owner' and m.status='active' and l.status='active' and l.guild_id='{guild}' and l.discord_user_id='{user}';") == '1', 'owner/link mismatch')
    # Container-specific copies. Never overwrite a different previously provisioned secret.
    botuid = int(ENV['HUB_BOT_UID']); opsuid = int(ENV['HUB_OPS_UID']); opsgid = int(ENV['HUB_OPS_GID'])
    for name, uid in (('bot', botuid), ('web', botuid)):
        directory(PRIVATE / name, uid, uid)
        for filename in ('hub-app.password', 'mail-a.env'):
            # Original mail-a.env may belong to the pre-existing ops UID.
            value = (PRIVATE / filename).read_text().strip()
            put_secret(PRIVATE / name / filename, value, uid, uid)
    for filename in ('discord.token',):
        put_secret(PRIVATE / 'bot' / filename, secret_file(PRIVATE / filename), botuid, botuid)
    put_secret(PRIVATE / 'web/discord-client.secret', secret_file(PRIVATE / 'discord-client.secret'), botuid, botuid)
    directory(SPOOL, botuid, botuid)
    for sub in ('requests', 'receipts', 'credentials'):
        directory(SPOOL / sub, botuid, botuid)
    mp = PRIVATE / 'memory'
    directory(mp, mode=0o711)
    directory(mp / 'hindsight', 1000, 1000)
    directory(mp / 'bank-proxy', botuid, botuid)
    directory(Path('/var/lib/neighbor-hub/bank-proxy'), botuid, botuid)
    for path in (PRIVATE / 'hindsight-db.password', mp / 'hindsight/hindsight-api.key', mp / 'hindsight/llm-gateway.key'):
        if not path.exists():
            uid = 0 if path.parent == PRIVATE else 1000
            write(path, secrets.token_hex(32) + '\n', uid, uid, 0o600 if uid == 0 else 0o400)
    put_secret(mp / 'hindsight/hindsight-db.password', secret_file(PRIVATE / 'hindsight-db.password'), 1000, 1000)
    for filename in ('hindsight-api.key',):
        put_secret(mp / 'bank-proxy' / filename, secret_file(mp / 'hindsight' / filename, 1000, (0o400,)), botuid, botuid)
    for filename in ('hub-app.password',):
        put_secret(mp / 'bank-proxy' / filename, secret_file(PRIVATE / filename), botuid, botuid)
    # F-11: provider credentials exist only in the dedicated gateway; never rotate an existing key.
    gateway_uid = 10004
    gateway_private = PRIVATE / 'llm-gateway'
    directory(gateway_private, gateway_uid, gateway_uid)
    for name in ('gemini', 'llm-gateway', 'agy-bin'):
        directory(Path('/var/lib/neighbor-hub') / name, gateway_uid, gateway_uid)
    put_secret(gateway_private / 'hindsight.key', secret_file(mp / 'hindsight/llm-gateway.key', 1000, (0o400,)), gateway_uid, gateway_uid, 0o600)
    for name in ('bot', 'eval'):
        path = gateway_private / (name + '.key')
        if not path.exists():
            write(path, secrets.token_hex(32) + '\n', gateway_uid, gateway_uid)
        secret_file(path, gateway_uid)
    put_secret(PRIVATE / 'bot/llm-gateway.key', secret_file(gateway_private / 'bot.key', gateway_uid), botuid, botuid)
    if ENV.get('HUB_LLM_BACKEND') in ('gemini-api-free', 'gemini-api-paid'):
        put_secret(gateway_private / 'gemini-api.key', secret_file(PRIVATE / 'gemini-api.key'), gateway_uid, gateway_uid, 0o600)
    if ENV.get('HUB_LLM_BACKEND', 'groq-api') == 'groq-api':
        put_secret(gateway_private / 'groq.key', secret_file(PRIVATE / 'groq.key'), gateway_uid, gateway_uid, 0o600)
    put_secret(PRIVATE / 'memorybridge.hindsight-api.key', secret_file(mp / 'hindsight/hindsight-api.key', 1000, (0o400,)), opsuid, opsgid, 0o600)
    directory(Path('/var/lib/neighbor-hub/memory-bridge'), opsuid, opsgid)
    directory(PRIVATE / 'validator', opsuid, opsgid)
    policy = PRIVATE / 'validator/validator-allowlist.json'
    if not policy.exists():
        write(policy, (ROOT / 'server/validator/allowlist.example.json').read_text(), opsuid, opsgid)
    pg('hindsight-init')
    require(sql("select has_database_privilege('hindsight_app','hub','CONNECT'),has_database_privilege('hub_app','hindsight','CONNECT'),has_database_privilege('public','hindsight','CONNECT');") == 'f|f|f', 'database CONNECT isolation failed')
    evidence('secrets_and_db', 'private copies; owner linked; hindsight provisioned; cross DB CONNECT denied')
    unchanged(J['before'])


def step3():
    unchanged(J['before'])
    mem('build', 'bank-proxy', 'llm-gateway')
    mem('pull', 'hindsight')
    hub('build', 'validator', 'bot', 'web')
    mem('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'llm-gateway', timeout=180)
    mem('up', '-d', '--no-deps', '--wait', '--wait-timeout', '600', 'hindsight', 'bank-proxy', timeout=1200)
    # Bank creation requires no LLM call. It is internal, never an exposed master credential.
    py = """import urllib.request
key=open('/run/secrets/hindsight_api_key').read().strip()
r=urllib.request.Request('http://127.0.0.1:8888/v1/default/banks/group-a',data=b'{"name":"group-a"}',method='PUT',headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
assert urllib.request.urlopen(r,timeout=60).status==200
"""
    mem('exec', '-T', 'hindsight', 'python', '-c', py)
    hub('up', '-d', '--no-deps', 'web')
    run(['curl', '--fail', '--silent', '--retry', '15', '--retry-connrefused', '--retry-all-errors', '--retry-delay', '1',
         '--connect-timeout', '2', '--max-time', '5', '--retry-max-time', '30',
         '--output', '/dev/null', 'http://127.0.0.1:8781/explorer.js'], 'UI explorer readiness')
    hub('run', '--rm', '--no-deps', 'bot', 'check-config')
    # Run bootstrap only on loopback, retaining prior Mac/Windows/clock sender identities.
    run([ROOT / 'ops/bootstrap', '--state-dir', PRIVATE, '--url', 'http://127.0.0.1:8765/mcp/'], 'MemoryBridge registration')
    p = PRIVATE / 'memorybridge.sender.json'
    os.chown(p, int(ENV['HUB_OPS_UID']), int(ENV['HUB_OPS_GID']))
    evidence('new_services', 'gateway liveness only (not LLM readiness); Hindsight healthy; bank created; bank-proxy healthy; explorer.js 200; bot config OK')
    unchanged(J['before'])
    office()


def step4():
    unchanged(J['before'])
    office()
    # The only two authorized protected-container recreations. Never use a blanket compose up.
    hub('stop', 'hubclock')
    hub('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'mail-a', 'validator')
    mail_id = containers_without_clock('mail-a')
    validator_id = containers_without_clock('validator')
    def bindings(cid):
        return json.loads(run(['docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', cid], 'port bindings').stdout)
    require(not bindings(mail_id), 'raw Mail still publishes a port')
    b = bindings(validator_id)
    require(b == {'8766/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8765'}]}, 'validator binding must be loopback 8765 only')
    hub('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'hubclock')
    J['after_cutover'] = containers()
    require(J['before']['db'] == J['after_cutover']['db'], 'DB recreated unexpectedly')
    evidence('protected_recreation', 'mail-a: remove raw host port + disable images; hubclock: URL now validator (one each)')
    registry = json.loads((PRIVATE / 'tokens.json').read_text())
    upstream = registry['upstream']
    require(request('http://127.0.0.1:8765/health/readiness', upstream) == 200, 'validator policy readiness failed')
    office()


def containers_without_clock(service):
    value = hub('ps', '-q', service).stdout.decode().strip()
    require(bool(value), 'service absent: ' + service)
    return value


def applier_args():
    return ['--group-id', 'group-a', '--state', str(PRIVATE), '--token-dir', str(PRIVATE / 'tokens-db'),
            '--spool', str(SPOOL), '--output', str(AUTH), '--upstream', '127.0.0.1:8765',
            '--memory-upstream', '127.0.0.1:8780', '--probe-url', ENV['HUB_PUBLIC_URL'] + '/health/liveness']


def step5():
    unchanged(J['after_cutover'])
    require(not J.get('reload_attempted'), 'reload was already attempted; operator recovery required (never blind retry)')
    require(not list((SPOOL / 'requests').glob('*.json')), 'pending token requests must settle before launch')
    office()
    caddy_user = pwd.getpwnam('caddy')
    directory(AUTH.parent, caddy_user.pw_uid, caddy_user.pw_gid)
    run([ROOT / 'ops/token-applier', 'import-mvp', '--prepare-only', *applier_args()], 'prepare DB allowlist')
    # Import must include the exact two active MVP devices, and cannot revive a DB-revoked token.
    registry = json.loads((PRIVATE / 'tokens.json').read_text())
    require(set(registry['devices']) >= {'mac', 'windows'}, 'MVP Mac/Windows entries missing')
    require(sql("select count(*) from caddy_allowlist_export where group_id='group-a' and token_id in ('tok_mvpmac01','tok_mvpwindows01');") == '2', 'MVP tokens not active in DB; investigate, never reactivate')
    routes = (ROOT / 'deploy/web/caddy.routes').read_text().replace('127.0.0.1:8780', '127.0.0.1:8781')
    write(AUTH.parent / 'web.routes', routes, caddy_user.pw_uid, caddy_user.pw_gid)
    old = SITE.read_text()
    replacement = ('route {\n    import ' + str(AUTH.parent / 'web.routes') + '\n    handle {\n      import ' + str(AUTH) + '\n    }\n  }')
    candidate = old.replace('import /etc/caddy/hub-private/auth.caddy', replacement)
    require(candidate != old, 'site import did not change')
    write(SITE, candidate, mode=0o644)
    # Validate as the same caddy service user: also verifies private traversal and all office imports.
    valid = run(['runuser', '-u', 'caddy', '--', 'caddy', 'validate', '--config', CADDY, '--adapter', 'caddyfile'],
                'candidate Caddy validate', check=False)
    if valid.returncode:
        write(SITE, old, mode=0o644)
        raise Stop('Caddy validate failed; original site restored; reload NOT attempted')
    evidence('caddy_validate', 'PASS (all sites, as caddy user)')
    # Durable barrier before reload: a crash or timeout cannot cause a second automatic reload.
    J['reload_attempted'] = True
    save()
    result = run(['systemctl', 'reload', 'caddy'], 'single launch reload', check=False)
    if result.returncode:
        write(SITE, old, mode=0o644)
        raise Stop('reload failed/uncertain; old disk site restored; operator inspect running config before recovery')
    J['reload_confirmed'] = True
    save()
    require(request(ENV['HUB_PUBLIC_URL'] + '/health/liveness') == 401, 'no-token probe must be 401')
    from token_applier import PsqlDb, desired_tokens
    cfg = argparse.Namespace(state=PRIVATE, token_dir=PRIVATE / 'tokens-db', group_id='group-a')
    db = PsqlDb([str(ROOT / 'ops/postgres'), 'psql'])
    _, allowed = desired_tokens(cfg, db)
    for tid in ('tok_mvpmac01', 'tok_mvpwindows01'):
        require(tid in allowed, 'MVP credential missing from DB export')
        require(request(ENV['HUB_PUBLIC_URL'] + '/health/readiness', allowed[tid]) == 200, 'MVP public readiness failed')
    for path in ('/', '/explorer.js'):
        require(request(ENV['HUB_PUBLIC_URL'] + path) == 200, 'public UI route failed')
    require(request(ENV['HUB_PUBLIC_URL'] + '/api/architecture') == 401, 'UI API must require session')
    require(request(ENV['HUB_PUBLIC_URL'] + '/memory/mcp/group-a/') == 401, 'memory must require bearer')
    require(request(ENV['HUB_PUBLIC_URL'] + '/memory/mcp/group-b/', allowed['tok_mvpmac01']) == 403,
            'memory routing/DB authentication/foreign-bank refusal failed')
    evidence('memory_auth', 'own active token reaches bank-proxy DB; foreign bank 403')
    office()
    evidence('launch_reload_count', 1)
    evidence('DB_authority', 'MVP Mac+Windows readiness 200; unauth MCP/memory 401; UI+explorer 200; API 401')
    unchanged(J['after_cutover'])


def step6():
    unchanged(J['after_cutover'])
    require(J.get('reload_confirmed'), 'Caddy activation unconfirmed')
    require(not list((SPOOL / 'requests').glob('*.json')), 'pending requests before enabling applier')
    directory(Path('/var/lib/neighbor-hub/applier-lock'))
    # Existing MVP private directory retained; stock group template assumes groups/%i, so write a
    # group-a drop-in replacing only sandbox paths and ExecStart with the actual deployed paths.
    unit = Path('/etc/systemd/system/hub-token-applier@.service')
    shutil.copyfile(ROOT / 'ops/templates/hub-token-applier@.service', unit)
    shutil.copyfile(ROOT / 'ops/templates/hub-token-applier@.timer', unit.with_suffix('.timer'))
    groupenv = Path('/etc/neighbor-hub/groups/group-a.env')
    groupenv.parent.mkdir(parents=True, exist_ok=True)
    write(groupenv, '\n'.join(f'{k}={ENV[k]}' for k in ('HUB_GROUP_ID', 'HUB_PRIVATE_DIR', 'HUB_TOKEN_SPOOL_DIR', 'HUB_MAIL_PORT', 'HUB_BANKPROXY_PORT', 'HUB_PUBLIC_URL')) + '\n')
    dropin = Path('/etc/systemd/system/hub-token-applier@group-a.service.d/l09.conf')
    command = ' '.join([str(ROOT / 'ops/token-applier'), 'process', *applier_args()])
    write(dropin, '[Service]\nExecStart=\nExecStart=/usr/bin/flock /var/lib/neighbor-hub/applier-lock/global.lock ' + command +
          '\nReadWritePaths=\nReadWritePaths=/var/lib/neighbor-hub/private /var/lib/neighbor-hub/token-spool /var/lib/neighbor-hub/applier-lock /etc/caddy/hub-private/group-a\n', mode=0o644)
    backup_dropin = Path('/etc/systemd/system/hub-backup.service.d/l09.conf')
    write(backup_dropin, '[Service]\nEnvironment="HUB_PG_BACKUP=1"\nEnvironment="HUB_HINDSIGHT_BACKUP=1"\n', mode=0o644)
    run(['systemctl', 'daemon-reload'], 'systemd reload units')
    run(['systemctl', 'enable', '--now', 'hub-token-applier@group-a.timer'], 'enable group timer')
    require(run(['systemctl', 'is-active', 'hub-token-applier@group-a.timer'], 'group timer active').stdout.strip() == b'active', 'group timer inactive')
    hub('run', '--rm', '--no-deps', 'bot', 'register-commands')  # Explicit operator deployment includes registering slash commands.
    hub('up', '-d', '--no-deps', 'bot', 'memory-bridge')
    # Start the real systemd backup, so its sandbox is exercised on the VPS, not merely a CLI dump.
    run(['systemctl', 'start', 'hub-backup.service'], 'systemd full backup')
    require(run(['systemctl', 'show', 'hub-backup.service', '-p', 'Result', '--value'], 'backup unit result').stdout.strip() == b'success', 'backup systemd failure')
    latest = sorted(Path('/var/lib/neighbor-hub/backups').glob('hub-backup-*.tar.gz'))[-1]
    with tarfile.open(latest) as t:
        manifest = json.load(t.extractfile('./manifest.json'))
        for key in ('postgres', 'hindsight'):
            item = manifest[key]
            require(item['present'], 'systemd backup missing database: ' + key)
            payload = t.extractfile('./' + item['file']).read()
            require(hashlib.sha256(payload).hexdigest() == item['sha256'], 'systemd backup hash mismatch: ' + key)
        require(any(n.startswith('./memory-bridge/') for n in t.getnames()), 'systemd backup missing bridge state directory')
    evidence('backup_contents', 'hub+hindsight hashes verified; bridge state directory present')
    evidence('consumers', 'bot+memory-bridge started; group-a timer active; legacy writers remain disabled; full backup success')
    evidence('task_GitHub', 'token absent: E-GITHUB expected; TC-19 success path PENDING')
    office()
    unchanged(J['after_cutover'])


def step7():
    unchanged(J['after_cutover'])
    office()
    ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=neighbor-hub'], 'running services').stdout.decode().split()
    ids += run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=neighbor-hub-memory'], 'memory services').stdout.decode().split()
    objects = json.loads(run(['docker', 'inspect', *ids], 'resource health').stdout)
    present = set()
    for o in objects:
        service = o['Config']['Labels']['com.docker.compose.service']
        present.add(service)
        require(o['State']['Running'] and not o['State'].get('OOMKilled') and o['RestartCount'] == 0, 'unhealthy/restarted service: ' + service)
        evidence('service_' + service, 'running; restart=0; OOM=false')
    require({'mail-a', 'hubclock', 'validator', 'web', 'bot', 'memory-bridge', 'hindsight', 'bank-proxy', 'llm-gateway'} <= present, 'launch service missing')
    evidence('technical_deployment', 'PASS; real Discord/OAuth/TC-14 VPS/TC-16..21 and peak RAM still require delivery-S1 evidence')


def main():
    global J
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--step', type=int, choices=range(1, 8), required=True)
    p.add_argument('--config', type=Path, default=Path('/etc/neighbor-hub/l09.env'))
    args = p.parse_args()
    label = f'STEP {args.step}'
    try:
        require(os.geteuid() == 0, 'run as VPS root')
        config = secret_file(args.config)
        allowed = {'HUB_DISCORD_GUILD_ID', 'HUB_DISCORD_APPLICATION_ID', 'L09_OWNER_DISCORD_ID', 'HUB_OPS_UID', 'HUB_OPS_GID',
                   'HUB_BOT_UID', 'HUB_BOT_GID', 'HUB_WEB_UID', 'HUB_WEB_GID', 'HUB_WEB_MAP_FILE', 'HUB_PUBLIC_URL', 'L09_OFFICE_URL',
                   'HUB_PG_PLATFORM', 'HUB_HS_PLATFORM', 'HUB_VALIDATOR_PLATFORM',
                   'HUB_LLM_BACKEND', 'HUB_LLM_UPSTREAM_MODEL', 'HUB_LLM_DAILY_REQUEST_LIMIT'}
        config_keys = set()
        for line in config.splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            k, sep, v = line.partition('=')
            valid_value = re.fullmatch(r'[A-Za-z0-9_./:@-]+', v)
            if k == 'HUB_LLM_UPSTREAM_MODEL':
                valid_value = re.fullmatch(r'[A-Za-z0-9 ._-]{1,128}', v)
            require(sep and k in allowed and valid_value, 'invalid/non-allowlisted non-secret config')
            ENV[k] = v
            config_keys.add(k)
        for k in ('HUB_DISCORD_GUILD_ID', 'HUB_DISCORD_APPLICATION_ID', 'L09_OWNER_DISCORD_ID'):
            require(re.fullmatch(r'\d{17,20}', ENV.get(k, '')), 'missing/invalid Discord ID: ' + k)
        require('HUB_WEB_MAP_FILE' in config_keys and Path(ENV['HUB_WEB_MAP_FILE']).is_file(), 'architecture map required')
        opsowner = (PRIVATE / 'hubclock.sender.json').stat()
        ENV.setdefault('HUB_OPS_UID', str(opsowner.st_uid))
        ENV.setdefault('HUB_OPS_GID', str(opsowner.st_gid))
        for k in ('HUB_BOT_UID', 'HUB_BOT_GID', 'HUB_WEB_UID', 'HUB_WEB_GID'):
            ENV.setdefault(k, '10002')
        require(ENV['HUB_BOT_UID'] == ENV['HUB_BOT_GID'] == ENV['HUB_WEB_UID'] == ENV['HUB_WEB_GID'] == '10002', 'L09 container copies require uid/gid 10002')
        ENV.setdefault('HUB_PUBLIC_URL', 'https://hub.example.invalid')
        ENV.setdefault('L09_OFFICE_URL', 'https://office.example.invalid')
        ENV.setdefault('HUB_LLM_BACKEND', 'groq-api')
        require(ENV['HUB_LLM_BACKEND'] in ('groq-api', 'disabled', 'gemini-cli', 'antigravity-cli', 'gemini-api-free', 'gemini-api-paid'), 'unknown LLM backend')
        ENV.update(HUB_GROUP_ID='group-a', HUB_PRIVATE_DIR=str(PRIVATE), HUB_TOKEN_SPOOL_DIR=str(SPOOL),
                   HUB_PG_PROJECT='neighbor-hub-db', HUB_MAIL_PORT='8765', HUB_BANKPROXY_PORT='8780', HUB_WEB_PORT='8781',
                   HUB_WEB_GITHUB_TOKEN_FILE='', HUB_WEB_ORIGIN=ENV['HUB_PUBLIC_URL'])
        # Do not permit inherited env credentials to bypass the intended missing-GitHub gate.
        for k in ('GITHUB_TOKEN', 'GITHUB_PAT', 'HINDSIGHT_LLM_BASE_URL', 'HINDSIGHT_LLM_PROVIDER'):
            ENV.pop(k, None)
        directory(STATE)
        lock = open('/var/lib/neighbor-hub/l09/launch.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        directory(Path('/var/lib/neighbor-hub/applier-lock'))
        global_lock = open('/var/lib/neighbor-hub/applier-lock/global.lock', 'a')
        fcntl.flock(global_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (STATE / 'journal.json').exists():
            J = json.loads((STATE / 'journal.json').read_text())
        # Source fingerprint catches updates between steps even in a deployment without .git.
        paths = [f for d in ('ops', 'deploy', 'supabase', 'bot', 'web', 'client', 'server/validator')
                 for f in (ROOT / d).rglob('*') if f.is_file() and not {'node_modules', '.generated', '__pycache__'} & set(f.parts)]
        digest = hashlib.sha256(config.encode())
        for f in sorted(paths):
            digest.update(str(f.relative_to(ROOT)).encode() + b'\0' + f.read_bytes())
        revision = digest.hexdigest()
        require(not J or J.get('source') == revision, 'deployment source changed across steps; stop and reconcile')
        require(args.step not in J.get('passed', []), 'step already PASS; do not replay (use journal evidence)')
        require(all(i in J.get('passed', []) for i in range(1, args.step)), 'prior step has not passed')
        J['source'] = revision
        save()
        globals()[f'step{args.step}']()
        J.setdefault('passed', []).append(args.step)
        save()
        print(label + ' PASS; evidence=' + str(STATE / 'journal.json'))
        return 0
    except Exception as e:  # Every segment ends FAIL; foreign exception text may contain private input.
        message = str(e) if isinstance(e, Stop) else 'local state/permission/format error (details suppressed)'
        print(label + ' FAIL; ' + message, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
