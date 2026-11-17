"""Operator-only Hub configuration; no changes to the Mail engine or office site."""
import argparse
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse

DEFAULT_STATE = '/var/lib/neighbor-hub/private'
TOKEN = re.compile(r'[A-Za-z0-9_-]{32,128}\Z')


def atomic_write(path, text, *, owner=None):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.hub-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600)
            if owner:
                os.fchown(f.fileno(), *owner)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def private_read(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Private state must be a regular file, not a symlink')
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise RuntimeError('Private state must have mode 600')
    return path.read_text()


@contextmanager
def state_lock(state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.is_symlink() or stat.S_IMODE(state.stat().st_mode) != 0o700:
        raise RuntimeError('State directory must have mode 700 and not be a symlink')
    fd = os.open(state / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def load_state(state):
    data = json.loads(private_read(state / 'tokens.json'))
    if data.get('version') != 1 or not isinstance(data.get('revision'), int):
        raise RuntimeError('Unsupported token registry version')
    if set(data.get('devices', {})) != {'mac', 'windows'}:
        raise RuntimeError('Registry must contain the mac and windows device IDs')
    values = [data.get('upstream')]
    for device in data['devices'].values():
        if device.get('status') not in {'active', 'revocation_pending', 'revoked'}:
            raise RuntimeError('Invalid device status')
        values.append(device.get('token'))
        if device.get('pending_token'):
            values.append(device['pending_token'])
    if any(not isinstance(v, str) or not TOKEN.fullmatch(v) for v in values):
        raise RuntimeError('Credentials must be 32-128 base64url characters')
    if len(set(values)) != len(values):
        raise RuntimeError('Device and upstream credentials must be distinct')
    return data


def save_state(state, data):
    atomic_write(state / 'tokens.json', json.dumps(data, indent=2) + '\n')


def init_secrets(state):
    with state_lock(state):
        if (state / 'tokens.json').exists():
            data = load_state(state)
        else:
            data = {
                'version': 1, 'revision': 1, 'group_id': 'group-a',
                'upstream': secrets.token_urlsafe(32),
                'devices': {
                    'mac': {'token': secrets.token_urlsafe(32), 'status': 'active', 'agent': 'BlueLake'},
                    'windows': {'token': secrets.token_urlsafe(32), 'status': 'active', 'agent': 'RedStone'},
                },
            }
            save_state(state, data)
        files = {'mail-a.env': 'HTTP_BEARER_TOKEN=' + data['upstream'] + '\n'}
        for key, device in data['devices'].items():
            files[key + '.env'] = 'HUB_MAIL_URL=https://hub.example.invalid/mcp/\nHUB_TOKEN=' + device['token'] + '\n'
        for name, content in files.items():
            path = state / name
            if path.exists():
                if private_read(path) != content:
                    raise RuntimeError('Existing credential export differs; inspect locally, do not overwrite')
            else:
                atomic_write(path, content)
    print('Private credentials ready; no values printed; existing tokens retained')


def check_loopback(upstream, what):
    if not re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}', upstream) or int(upstream.split(':')[1]) > 65535:
        raise RuntimeError(what + ' upstream must be a loopback address and valid port')


def memory_block(memory_upstream):
    # MVP: memory is off. L-02: strip /memory and hand the request to bank-proxy WITH the device's own
    # bearer (no header_up Authorization): bank-proxy maps that token to exactly one bank.
    if memory_upstream is None:
        return [' handle @memory {', '  respond "Memory is not enabled in MVP" 503', ' }']
    check_loopback(memory_upstream, 'Memory')
    return [' handle @memory {', '  uri strip_prefix /memory', '  reverse_proxy ' + memory_upstream + ' {',
            '   header_up Host ' + memory_upstream, '   flush_interval -1', '  }', ' }']


def render(data, upstream, memory_upstream=None):
    check_loopback(upstream, 'Mail')
    active = [d['token'] for d in data['devices'].values() if d['status'] == 'active']
    if not active:
        return '# Hub revision ' + str(data['revision']) + '\nrespond "Unauthorized" 401\n'
    lines = ['# Hub revision ' + str(data['revision']), '@hub_allowed {']
    lines.extend(' header Authorization "Bearer ' + value + '"' for value in active)
    lines.extend([
        '}', 'handle @hub_allowed {', ' @memory path /memory /memory/*',
        *memory_block(memory_upstream),
        ' handle {', '  reverse_proxy ' + upstream + ' {',
        '   header_up Authorization "Bearer ' + data['upstream'] + '"',
        '   header_up Host ' + upstream, '  }', ' }', '}',
        'handle {', ' respond "Unauthorized" 401', '}',
    ])
    return '\n'.join(lines) + '\n'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(url, token=None):
    # Never forward credentials through an environment proxy or HTTP redirect.
    parsed = urlparse(url)
    if not ((parsed.scheme == 'https' and parsed.netloc == 'hub.example.invalid') or
            (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1')):
        raise RuntimeError('Probe URL must be HTTPS Hub or loopback HTTP test service')
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, urllib.error.URLError):
        raise RuntimeError('Hub probe failed; no authorization result confirmed') from None


class BootstrapSession:
    def __init__(self, url, token):
        parsed = urlparse(url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/mcp/':
            raise RuntimeError('Bootstrap must use the loopback Mail /mcp/ endpoint')
        self.url, self.token, self.session, self.sequence = url, token, None, 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        initialized = self.rpc('initialize', {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'hub-bootstrap', 'version': '1'},
        })
        if not initialized.get('serverInfo') or not self.session:
            raise RuntimeError('MCP initialize did not return serverInfo/session identity')
        self.rpc('notifications/initialized', {}, notify=True)

    def rpc(self, method, params, notify=False):
        self.sequence += 1
        body = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notify:
            body['id'] = self.sequence
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                   'Authorization': 'Bearer ' + self.token}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        request = urllib.request.Request(self.url, json.dumps(body).encode(), headers, method='POST')
        with self.opener.open(request, timeout=15) as response:
            self.session = response.headers.get('mcp-session-id') or self.session
            text = response.read().decode()
            if notify:
                return None
            if 'text/event-stream' in response.headers.get('Content-Type', ''):
                text = [line[5:].strip() for line in text.splitlines() if line.startswith('data:')][-1]
            payload = json.loads(text)
        if payload.get('error') or 'result' not in payload:
            raise RuntimeError('MCP bootstrap RPC was rejected; credentials not printed')
        return payload['result']

    def tool(self, name, arguments):
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        if result.get('isError'):
            raise RuntimeError('MCP bootstrap tool failed: ' + name + '; details suppressed')
        return result.get('structuredContent') or json.loads(result['content'][0]['text'])


def bootstrap(args):
    project = '/data/projects/group-a'
    with state_lock(args.state_dir):
        data = load_state(args.state_dir)
        for device, expected in [('mac', 'BlueLake'), ('windows', 'RedStone'), ('hubclock', None)]:
            path = args.state_dir / (device + '.sender.json')
            if path.exists():
                saved = json.loads(private_read(path))
                if saved.get('projectKey') != project or not saved.get('senderToken') or not saved.get('agentName'):
                    raise RuntimeError('Existing agent registry is invalid; not rotating it')
                if expected and saved['agentName'] != expected:
                    raise RuntimeError('Existing agent registry does not match the device')
                print('RETAINED registration for role ' + device + ': ' + saved['agentName'])
                continue
            session = BootstrapSession(args.url, data['upstream'])
            session.tool('ensure_project', {'human_key': project})
            fields = {'project_key': project, 'program': 'hub-operator', 'model': 'none'}
            if expected:
                fields['name'] = expected
            registered = session.tool('register_agent', fields)
            name, credential = registered['name'], registered['registration_token']
            if not credential or (expected and name != expected):
                raise RuntimeError('Unexpected canonical registration result')
            session.tool('set_contact_policy', {'project_key': project, 'agent_name': name, 'policy': 'open'})
            saved = {'agentName': name, 'senderToken': credential, 'projectKey': project,
                     'logicalRole': 'HubClock' if device == 'hubclock' else device}
            atomic_write(path, json.dumps(saved, indent=2) + '\n')
            print('BOOTSTRAPPED role ' + saved['logicalRole'] + ': ' + name + '; registration saved privately')


def caddy_command(args, *command):
    result = subprocess.run([args.caddy_bin, *command], capture_output=True, timeout=45)
    if result.returncode:
        # Caddy errors may echo parts of the private configuration.
        raise RuntimeError('Caddy command failed; output suppressed to protect credentials')


def apply_config(args, data):
    output = args.output.resolve()
    if args.output.is_symlink() or args.output.parent.is_symlink():
        raise RuntimeError('Caddy output must not be a symlink')
    account = pwd.getpwuid(os.getuid()) if args.owner == 'self' else pwd.getpwnam(args.owner)
    owner = (account.pw_uid, account.pw_gid)
    output.parent.mkdir(parents=True, mode=0o750, exist_ok=True)
    if stat.S_IMODE(output.parent.stat().st_mode) & 0o027:
        raise RuntimeError('Caddy private directory must not be writable by group or accessible to others')
    if os.geteuid() == 0:
        os.chown(output.parent, 0, owner[1])
    old = private_read(output) if output.exists() else None
    atomic_write(output, render(data, args.upstream, args.memory_upstream), owner=owner)
    if args.prepare_only:
        print('Private Caddy snippet prepared; not validated or activated')
        return
    try:
        caddy_command(args, 'validate', '--config', str(args.config), '--adapter', 'caddyfile')
        if args.reload_mode == 'systemd':
            result = subprocess.run(['systemctl', 'reload', 'caddy'], capture_output=True, timeout=45)
            if result.returncode:
                raise RuntimeError('systemctl reload caddy failed')
        else:
            if not re.fullmatch(r'127\.0\.0\.1:[0-9]+', args.admin):
                raise RuntimeError('Test Caddy admin must be loopback')
            caddy_command(args, 'reload', '--config', str(args.config), '--adapter', 'caddyfile', '--address', args.admin)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        if old is None:
            output.unlink()
        else:
            atomic_write(output, old, owner=owner)
        raise RuntimeError('Validate/reload failed; previous snippet restored; pending revocations remain pending') from None
    if probe(args.probe_url) != 401:
        raise RuntimeError('No-token request was not 401; application is unconfirmed')
    for device in data['devices'].values():
        expected = 200 if device['status'] == 'active' else 401
        if probe(args.probe_url, device['token']) != expected:
            raise RuntimeError('Device authorization probe failed; application is unconfirmed')
    print('Caddy validated and reloaded; device authorization probes confirmed')


def revoke(args):
    with state_lock(args.state_dir):
        data = load_state(args.state_dir)
        device = data['devices'][args.device]
        if device['status'] == 'active':
            device['status'] = 'revocation_pending'
            data['revision'] += 1
            save_state(args.state_dir, data)
        apply_config(args, data)
        device['status'] = 'revoked'
        save_state(args.state_dir, data)
    print('Revoked ' + args.device + '; old credential rejected; other active devices confirmed')


def issue(args):
    # Explicit revoke -> issue only. Never silently invalidate an active device.
    with state_lock(args.state_dir):
        data = load_state(args.state_dir)
        device = data['devices'][args.device]
        if device['status'] != 'revoked':
            raise RuntimeError('Device must be confirmed revoked before issuing a replacement')
        old = device['token']
        if 'pending_token' not in device:
            device['pending_token'] = secrets.token_urlsafe(32)
            save_state(args.state_dir, data)
        candidate = copy.deepcopy(data)
        fresh = candidate['devices'][args.device]
        fresh['token'] = fresh.pop('pending_token')
        fresh['status'] = 'active'
        fresh.setdefault('retired_token_sha256', []).append(hashlib.sha256(old.encode()).hexdigest())
        candidate['revision'] += 1
        apply_config(args, candidate)
        if probe(args.probe_url, old) != 401:
            raise RuntimeError('Replacement unconfirmed: old credential was not rejected')
        # On a crash before save_state, re-running issue reuses the same pending token.
        atomic_write(args.state_dir / (args.device + '.env'),
                     'HUB_MAIL_URL=https://hub.example.invalid/mcp/\nHUB_TOKEN=' + fresh['token'] + '\n')
        save_state(args.state_dir, candidate)
    print('Issued replacement for ' + args.device + '; old credential stays rejected; fetch the new private export')


def main(command):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=Path(DEFAULT_STATE))
    if command == 'bootstrap':
        parser.add_argument('--url', default='http://127.0.0.1:8765/mcp/')
    elif command != 'init-secrets':
        parser.add_argument('--output', type=Path, default=Path('/etc/caddy/hub-private/auth.caddy'))
        parser.add_argument('--config', type=Path, default=Path('/etc/caddy/Caddyfile'))
        parser.add_argument('--owner', default='caddy')
        parser.add_argument('--upstream', default='127.0.0.1:8765')
        parser.add_argument('--memory-upstream', default=None,
                            help='L-02 bank-proxy loopback address (e.g. 127.0.0.1:8780); omit to keep memory off')
        parser.add_argument('--caddy-bin', default='/usr/bin/caddy')
        parser.add_argument('--reload-mode', choices=['systemd', 'caddy'], default='systemd')
        parser.add_argument('--admin', default='127.0.0.1:2019')
        parser.add_argument('--probe-url', default='https://hub.example.invalid/health/liveness')
        parser.add_argument('--prepare-only', action='store_true')
        if command in {'revoke', 'issue'}:
            parser.add_argument('--device', choices=['mac', 'windows'], required=True)
    args = parser.parse_args()
    if command in {'render-caddy', 'revoke', 'issue'} and (args.state_dir / 'db-authority').exists():
        # L-03b: once ops/token-applier has applied the DB registry, a tokens.json-only render would drop
        # every /connect device. Refuse instead of silently cutting them off.
        print('FAILED: the DB registry is now the token authority; use ops/token-applier '
              '(render | import-mvp) or Discord /revoke instead', file=sys.stderr)
        return 1
    try:
        if command == 'init-secrets':
            init_secrets(args.state_dir)
        elif command == 'bootstrap':
            bootstrap(args)
        elif command == 'render-caddy':
            with state_lock(args.state_dir):
                apply_config(args, load_state(args.state_dir))
        elif command == 'revoke':
            if args.prepare_only:
                raise RuntimeError('Revocation requires validate, reload and probes; prepare-only is forbidden')
            revoke(args)
        elif command == 'issue':
            if args.prepare_only:
                raise RuntimeError('Issuance requires validate, reload and probes; prepare-only is forbidden')
            issue(args)
    except RuntimeError as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired):
        print('FAILED: private state could not be applied; inspect permissions, registry and service locally', file=sys.stderr)
        return 1
    return 0
