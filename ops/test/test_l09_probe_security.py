"""Acceptance probes must not send credentials to redirect destinations."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from ops import l09_launch as launch


class ProbeSecurityTest(unittest.TestCase):
    def test_redirect_is_not_followed_with_bearer(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/destination')
                else:
                    received.append(self.headers.get('Authorization'))
                    self.send_response(200)
                self.end_headers()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            code = launch.request(f'http://127.0.0.1:{server.server_port}/redirect', 'synthetic-probe-credential')
            self.assertEqual(received, [], 'probe followed redirect and forwarded its bearer')
            self.assertEqual(code, 302, 'acceptance must observe original endpoint status')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
