# Explicit dry-run Hindsight fixture. No LLM, retain/recall, authentication or embeddings are tested.
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def do_PUT(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
HTTPServer(('0.0.0.0',8888),Handler).serve_forever()
