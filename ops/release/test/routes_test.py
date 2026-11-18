"""Run the real Caddy route against synthetic public/private canaries."""
import http.client
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from uuid import uuid4

REPO = Path(__file__).resolve().parents[3]
IMAGE = 'caddy:2.11.9'


class CaddyRoutesTest(unittest.TestCase):
    def test_read_only_public_allowlist_before_auth(self):
        with tempfile.TemporaryDirectory(prefix='p7-caddy-') as temp:
            folder = Path(temp)
            (folder / 'dist').mkdir()
            archive = 'hub-client-1.0.0-' + ('a' * 40) + '.zip'
            files = ('/dist/manifest.json', '/dist/config.json', '/dist/bootstrap.mjs',
                     '/dist/' + archive, '/install.sh', '/install.ps1')
            for path in (*files, '/dist/private.env', '/unlisted'):
                folder.joinpath(path[1:]).write_text('fixture only')
            config = folder / 'Caddyfile'
            config.write_text("""{
  admin off
  auto_https off
}
:8080 {
  route {
    import /fixture/client-downloads.routes
    handle {
      respond "protected" 401
    }
  }
}
""")
            name = 'p7-caddy-' + uuid4().hex[:12]
            run = ['docker', 'run', '--rm',
                   '-v', f'{folder}:/var/www/hub-downloads:ro',
                   '-v', f'{config}:/etc/caddy/Caddyfile:ro',
                   '-v', f'{REPO}/deploy/caddy:/fixture:ro']
            subprocess.run([*run, IMAGE, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'],
                           check=True, stderr=subprocess.PIPE)
            subprocess.run([*run, '-d', '--name', name, '-p', '127.0.0.1::8080',
                            IMAGE], check=True, stdout=subprocess.DEVNULL)
            try:
                endpoint = subprocess.check_output(['docker', 'port', name, '8080/tcp'], text=True).strip()
                host, port = endpoint.split(':')

                def request(path, method='GET'):
                    connection = http.client.HTTPConnection(host, int(port), timeout=2)
                    try:
                        connection.request(method, path)
                        result = connection.getresponse()
                        return result.status, result.getheaders(), result.read()
                    finally:
                        connection.close()

                deadline = time.monotonic() + 15
                while True:
                    try:
                        request('/install.sh')
                        break
                    except (OSError, http.client.HTTPException):
                        if time.monotonic() >= deadline:
                            self.fail('local Caddy did not start')
                        time.sleep(0.1)
                for path in files:
                    response, headers, body = request(path)
                    self.assertEqual((response, body), (200, b'fixture only'), path)
                    self.assertEqual(request(path, 'HEAD')[0], 200)
                    self.assertEqual(request(path, 'POST')[0], 405)
                    if path.startswith('/install.'):
                        self.assertEqual(dict(headers)['Content-Type'], 'text/plain; charset=utf-8')
                for path in ('/dist', '/dist/', '/dist/private.env', '/dist/.publish.lock',
                             '/dist/manifest.json/', '/dist/hub-client-1.0.0-invalid.zip'):
                    self.assertEqual(request(path)[0], 404, path)
                for path in ('/mcp/', '/memory', '/health/readiness', '/unlisted', '/dist/../unlisted', '/dist/%2e%2e/unlisted'):
                    self.assertEqual(request(path)[0], 401, path)
            finally:
                subprocess.run(['docker', 'stop', name], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
