"""Exercise the downloaded installers and real CLI in an isolated terminal and home."""
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import shutil
import sys
import subprocess
import tempfile
import threading
import time
import unittest

REPO = Path(__file__).resolve().parents[3]
TOKEN = 'mph_' + 't' * 43
POWERSHELL = os.getenv('P7_TEST_POWERSHELL')


def run(*args, **options):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
    if result.returncode:
        raise RuntimeError(result.stdout.decode(errors='replace'))
    return result.stdout


class FakeHub(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        if Path(path).suffix in ('.sh', '.ps1'):
            return 'text/plain'
        return super().guess_type(path)

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/health/readiness':
            assert self.headers['Authorization'] == f'Bearer {TOKEN}'
            assert TOKEN.encode() not in run('ps', '-eo', 'args'), 'token in process arguments'
            denied = getattr(self.server, 'deny_device', False)
            self.send_response(401 if denied else 200)
            self.end_headers()
            if denied:
                # Even an error body carrying the synthetic token must not reach doctor output.
                self.wfile.write(TOKEN.encode())
        else:
            super().do_GET()

    def do_POST(self):
        assert self.path == '/mcp/'
        assert self.headers['Authorization'] == f'Bearer {TOKEN}'
        message = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        method = message['method']
        if method == 'notifications/initialized':
            self.send_response(202)
            self.end_headers()
            return
        result = {}
        if method == 'tools/call':
            args = message['params']
            assert args['arguments']['project_key'] == '/data/projects/group-a'
            if args['name'] == 'fetch_inbox_events':
                assert args['arguments']['agent_name'] == 'BlueLake'
                payload = {'events': []}
            else:
                assert args['name'] == 'fetch_topic'
                assert args['arguments']['topic_name'] in ('handoff', 'decision')
                payload = {'messages': []}
            result = {'content': [{'text': json.dumps(payload)}], 'isError': False}
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}).encode())


class InstallerTest(unittest.TestCase):
    def terminal(self, cmd, answers=()):
        master, slave = pty.openpty()
        # Explicitly give the child a controlling terminal so the piped POSIX installer
        # exercises its /dev/tty path. Exec the shell in a separate process before using ioctl.
        bootstrap = ('import fcntl, os, sys, termios; '
                     'fcntl.ioctl(0, termios.TIOCSCTTY, 0); os.execvp(sys.argv[1], sys.argv[1:])')
        proc = subprocess.Popen([sys.executable, '-c', bootstrap, *cmd], cwd=self.project, env=self.env,
                                stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 30
        try:
            for prompt, answer in (*answers, (None, None)):
                while prompt is None or prompt not in output:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([master], [], [], remaining)[0]:
                        self.fail(f'terminal timed out waiting for {prompt!r}: {output.decode(errors="replace")}')
                    try:
                        data = os.read(master, 4096)
                    except OSError as exc:
                        if exc.errno != errno.EIO:
                            raise
                        data = b''
                    if not data:
                        self.assertIsNone(prompt, f'process exit {proc.poll()}: {output.decode(errors="replace")}')
                        break
                    output.extend(data)
                if prompt is not None:
                    argv = run('ps', '-eo', 'args').decode(errors='replace')
                    self.assertNotIn(TOKEN, argv)
                    os.write(master, answer + b'\n')
            return proc.wait(timeout=5), output.decode(errors='replace')
        finally:
            os.close(master)
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def activate(self, directory):
        config = self.base / 'config.json'
        config.write_text(json.dumps({'groups': {'group-a': {
            'clock_agent': 'SandyThrush', 'memory_agent': 'NavyOrchid', 'peers': ['BlueLake', 'RedStone']
        }}}))
        run('sh', str(REPO / 'ops/release/publish.sh'), str(directory), str(config), str(self.public.parent))

    def build(self, version):
        out = self.base / f'build-{version}'
        run('node', str(REPO / 'ops/release/build.mjs'), '--ref', 'HEAD',
            '--version', version, '--out', str(out), cwd=self.source)
        return out

    def test_node_20_is_rejected_before_download(self):
        with tempfile.TemporaryDirectory(prefix='p7-node-check-') as temp:
            node = Path(temp, 'node')
            node.write_text('#!/bin/sh\nprintf "v20.19.0\\n"\nexit 1\n' if not POWERSHELL else
                            '#!/bin/sh\nprintf "v20.19.0\\n"\n')
            node.chmod(0o700)
            command = ([POWERSHELL, '-NoLogo', '-NoProfile', '-File', str(REPO / 'install/install.ps1')]
                       if POWERSHELL else ['sh', str(REPO / 'install/install.sh')])
            result = subprocess.run(command, env={**os.environ, 'PATH': temp + ':' + os.environ['PATH']},
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('https://nodejs.org/en/download', result.stdout)

    def test_release_install_update_and_rollback(self):
        with tempfile.TemporaryDirectory(prefix='P7 release ') as temp:
            self.base = Path(temp)
            self.public = self.base / 'web' / 'dist'
            self.public.mkdir(parents=True)
            self.source = self.base / 'source'
            self.source.mkdir()
            shutil.copytree(REPO / 'client', self.source / 'client', ignore=shutil.ignore_patterns('node_modules'))
            shutil.copytree(REPO / 'ops/lifecycle', self.source / 'ops/lifecycle')
            shutil.copytree(REPO / 'install', self.source / 'install')
            run('git', 'init', '-q', '-b', 'master', cwd=self.source)
            run('git', 'add', '.', cwd=self.source)
            run('git', '-c', 'user.name=P7 Fixture', '-c', 'user.email=maintainer [at] example.invalid',
                'commit', '-qm', 'synthetic packaging input', cwd=self.source)
            first = self.build('1.0.0')
            bytes_before = {p.name: p.read_bytes() for p in first.iterdir()}
            self.build('1.0.0')
            self.assertEqual(bytes_before, {p.name: p.read_bytes() for p in first.iterdir()})
            manifest = json.loads((first / 'manifest.json').read_text())
            self.assertIn('ops/lifecycle/protocol.mjs', manifest['files'])
            self.assertTrue(all('/test/' not in name for name in manifest['files']))
            self.activate(first)

            handler = partial(FakeHub, directory=self.public.parent)
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                home = self.base / 'home'
                home.mkdir()
                self.project = self.base / 'starter project'
                self.project.mkdir()
                (self.project / '.mcp.json').write_text('{"mcpServers":{"existing":{"command":"existing"}}}')
                (self.project / '.claude').mkdir()
                local_settings = self.project / '.claude/settings.local.json'
                local_settings.write_text('{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"existing"}]}]}}')
                bindir = self.base / 'tools'
                bindir.mkdir()
                # Exercise registration using a CLI double with Claude's project-scope storage.
                claude = bindir / 'claude'
                claude.write_text(f'#!{shutil.which("node")}\n' + """
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') process.exit(0);
if (a[0] !== 'mcp' || a[1] !== 'add') process.exit(1);
const settings = fs.existsSync('.mcp.json') ? JSON.parse(fs.readFileSync('.mcp.json')) : {mcpServers: {}};
settings.mcpServers.hub = {type: 'http', url: a[a.indexOf('hub') + 1],
  headers: {Authorization: a[a.indexOf('--header') + 1].replace(/^Authorization: /, '')}};
fs.writeFileSync('.mcp.json', JSON.stringify(settings));
""")
                claude.chmod(0o700)
                self.env = dict(os.environ, HOME=str(home), SHELL='/bin/sh', PATH=str(bindir) + ':' + os.environ['PATH'],
                                HUB_DIST_URL=f'http://127.0.0.1:{server.server_port}/dist/')
                for key in ('HUB_TOKEN', 'HUB_SENDER_TOKEN', 'CLAUDE_PROJECT_DIR'):
                    self.env.pop(key, None)
                source = f'http://127.0.0.1:{server.server_port}'
                installer = ([POWERSHELL, '-NoLogo', '-NoProfile', '-Command',
                              f"& ([scriptblock]::Create((Invoke-RestMethod '{source}/install.ps1')))"]
                             if POWERSHELL else ['sh', '-c', f"curl -fsS '{source}/install.sh' | sh"])
                status, output = self.terminal(installer, [
                    (b'Agent name', b'BlueLake'), (b'Platform', b'macos' if os.uname().sysname == 'Darwin' else b'linux'),
                    (b'Device token', TOKEN.encode()),
                ])
                self.assertEqual(status, 0, output)
                self.assertIn('readiness 200', output)
                self.assertIn('inbox', output)
                self.assertNotIn(TOKEN, output)
                root = home / '.hub-client'
                installed = root / 'device.json'
                self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(installed.read_text())['token'], TOKEN)
                self.assertNotIn(TOKEN, (self.project / '.mcp.json').read_text())
                self.assertIn('${HUB_TOKEN}', (self.project / '.mcp.json').read_text())
                hook_settings = json.loads((self.project / '.claude/settings.local.json').read_text())
                start = hook_settings['hooks']['SessionStart'][0]['hooks'][0]
                self.assertEqual(start['args'], [str(root / 'launch.mjs'), 'hook', 'start'])
                self.assertIn('hub-client/bin', (home / '.profile').read_text())
                hub = root / 'bin/hub'
                state = root / 'state.json'
                before = state.read_bytes()
                self.assertEqual(json.loads(before)['profile']['clock_agent'], 'SandyThrush')
                self.assertEqual(json.loads(before)['profile']['memory_agent'], 'NavyOrchid')
                status, output = self.terminal(['sh', '-c', '. "$HOME/.profile"; hub doctor'])
                self.assertEqual(status, 0, output)
                self.assertNotIn(TOKEN, output)

                status, output = self.terminal([hub, 'hook', 'inbox'])
                self.assertEqual(status, 0, output)
                self.assertIn('沒有給你的新項目', output)
                self.assertNotIn(TOKEN, output)

                session = json.dumps({'session_id': 'p7-installer-fixture'})
                status, output = self.terminal([hub, 'hook', 'start', '--json', session])
                self.assertEqual(status, 0, output)
                self.assertIn('hub hook inbox', output)
                self.assertNotIn('無法取得', output)
                self.env['HUB_WATCH_MAX_MS'] = '1'
                status, output = self.terminal([hub, 'hook', 'watch', '--json', session])
                self.env.pop('HUB_WATCH_MAX_MS')
                self.assertEqual(status, 2, output)
                self.assertIn('例行重新掛載', output)

                server.deny_device = True
                status, output = self.terminal([hub, 'doctor'])
                self.assertNotEqual(status, 0, output)
                self.assertIn('device token denied', output)
                self.assertNotIn(TOKEN, output)
                server.deny_device = False

                second = self.build('1.1.0')
                self.activate(second)
                bad_archive = json.loads((second / 'manifest.json').read_text())['archives']['zip' if POWERSHELL else 'tar.gz']['name']
                (self.public / bad_archive).write_bytes(b'corrupt')
                status, output = self.terminal([hub, 'update'])
                self.assertNotEqual(status, 0, output)
                self.assertIn('SHA-256', output)
                self.assertEqual(before, state.read_bytes())

                shutil.copyfile(second / bad_archive, self.public / bad_archive)
                changed = json.loads((self.public / 'manifest.json').read_text())
                changed['files']['client/hub.mjs'] = '0' * 64
                (self.public / 'manifest.json').write_text(json.dumps(changed))
                status, output = self.terminal([hub, 'update'])
                self.assertNotEqual(status, 0, output)
                self.assertIn('SHA-256 mismatch: client/hub.mjs', output)
                self.assertEqual(before, state.read_bytes())

                self.activate(second)
                status, output = self.terminal([hub, 'update'])
                self.assertEqual(status, 0, output)
                self.assertIn('1.1.0', output)
                working = state.read_bytes()
                self.assertNotEqual(before, working)
                self.assertTrue(json.loads(working)['previous'])
                self.assertEqual(json.loads(installed.read_text())['token'], TOKEN)

                # The archive and per-file hashes are valid, but the candidate cannot run.
                with (self.source / 'client/hub.mjs').open('a') as file:
                    file.write('\nthrow new Error("broken candidate");\n')
                run('git', '-c', 'user.name=P7 Fixture', '-c', 'user.email=maintainer [at] example.invalid',
                    'commit', '-qam', 'fault injection for candidate self-check', cwd=self.source)
                self.activate(self.build('1.2.0'))
                status, output = self.terminal([hub, 'update'])
                self.assertNotEqual(status, 0, output)
                self.assertEqual(working, state.read_bytes())
                self.assertEqual(self.terminal([hub, 'doctor'])[0], 0)
                self.assertNotIn(TOKEN, output)
                status, output = self.terminal([hub, 'uninstall'])
                self.assertEqual(status, 0, output)
                self.assertFalse(installed.exists())
                self.assertNotIn('hub-client/bin', (home / '.profile').read_text())
                remaining = json.loads((self.project / '.mcp.json').read_text())['mcpServers']
                self.assertEqual(remaining, {'existing': {'command': 'existing'}})
                remaining_hooks = json.loads(local_settings.read_text()).get('hooks', {})
                self.assertEqual(list(remaining_hooks), ['PreToolUse'])

                self.activate(first)
                claude.unlink()
                self.env['PATH'] = ':'.join(dict.fromkeys([str(Path(shutil.which('node')).parent),
                    str(Path(shutil.which(POWERSHELL)).parent) if POWERSHELL else '/usr/bin', '/usr/bin', '/bin']))
                status, output = self.terminal(installer, [
                    (b'Agent name', b'BlueLake'), (b'Platform', b''),
                    (b'Device token', TOKEN.encode()),
                ])
                self.assertEqual(status, 0, output)
                self.assertIn('[mcp_servers.hub]', output)
                self.assertIn('${env:HUB_TOKEN}', output)
                self.assertNotIn(TOKEN, output)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
