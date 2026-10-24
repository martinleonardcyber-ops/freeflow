"""HTTP layer of stt/stt_server.py (token, Host check, no CORS), without the
speech libraries: they are replaced by stubs, so this runs anywhere."""
import os
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request

for name in ("numpy", "faster_whisper", "faster_whisper.utils"):
    mod = types.ModuleType(name)
    sys.modules[name] = mod
sys.modules["numpy"].zeros = lambda *a, **k: None
sys.modules["numpy"].float32 = float
sys.modules["faster_whisper"].WhisperModel = object
sys.modules["faster_whisper"].decode_audio = lambda *a, **k: None
sys.modules["faster_whisper.utils"]._MODELS = {}
sys.modules["faster_whisper.utils"].download_model = lambda *a, **k: ""

PORT = 48999
os.environ["FREEFLOW_PORT"] = str(PORT)
os.environ["FREEFLOW_TOKEN"] = "s3cret"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "stt"))
import stt_server  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402


def req(path, method="GET", headers=None, host=None):
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                               data=b"" if method == "POST" else None, headers=headers or {})
    if host:
        r.add_unredirected_header("Host", host)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


class ServerSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stt_server.SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), stt_server.Handler)
        threading.Thread(target=stt_server.SERVER.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        stt_server.SERVER.shutdown()

    def test_health_is_open_locally(self):
        self.assertEqual(req("/health")[0], 200)

    def test_foreign_host_refused(self):          # DNS rebinding
        self.assertEqual(req("/health", host="evil.example:48999")[0], 403)

    def test_post_needs_the_token(self):
        self.assertEqual(req("/transcribe", "POST")[0], 403)
        self.assertEqual(req("/shutdown", "POST", {"X-FreeFlow-Token": "nope"})[0], 403)

    def test_no_cors_header(self):
        self.assertNotIn("Access-Control-Allow-Origin", req("/health")[1])

    def test_hallucination_filter(self):
        self.assertTrue(stt_server._is_hallucination("Sous-titres réalisés par la communauté d'Amara.org"))
        self.assertFalse(stt_server._is_hallucination("Merci pour le dossier"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
