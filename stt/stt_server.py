"""FreeFlow STT sidecar.

Local replacement for Wispr Flow's cloud speech backend (api.wisprflow.ai).
Stdlib-only HTTP server in front of faster-whisper:

  GET  /health                 -> {"status","ready","device","compute_type","model",...}
  POST /transcribe?lang=auto|fr|en&hints=a,b,c   body = WAV bytes
                               -> {"text","language","language_probability",
                                   "duration_ms","audio_ms","segments"}
  POST /shutdown               -> exits the process

POST endpoints require the header X-FreeFlow-Token when FREEFLOW_TOKEN is set
(the app always sets it): a web page open in the browser can reach 127.0.0.1
too, and without the token it could stop the engine or use it. Requests whose
Host is not the loopback address are refused (DNS rebinding).

Prints READY on stdout once the model is loaded and warm. Env vars:
  FREEFLOW_PORT     listening port (default 48123)
  FREEFLOW_MODEL    whisper model for the GPU path (default large-v3)
  FREEFLOW_CPU_MODEL fallback model when CUDA fails (default small)
  FREEFLOW_DEVICE   force "cuda" or "cpu" (default: try cuda, fall back to cpu)
  FREEFLOW_TOKEN    shared secret for the POST endpoints (empty = no check, manual runs)
  HF_HOME           Hugging Face cache (the app passes <userData>\\models)

The first launch downloads the model from the Hugging Face Hub; /health then
reports phase="downloading" and download={"model","done","total"} in bytes.
"""
import glob
import hmac
import io
import json
import os
import site
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def _log(*args):
    print("[stt]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Environment: HF cache + CUDA DLL discovery (must run before importing
# ctranslate2, which LoadLibrary()s cublas64_12.dll / cudnn64_9.dll lazily).
# ---------------------------------------------------------------------------
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _add_dll_dir(d):
    if not os.path.isdir(d):
        return False
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(d)
    except (AttributeError, OSError):
        pass
    return True


def _setup_cuda_dlls():
    found = []
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        meipass = getattr(sys, "_MEIPASS", exe_dir)
        for d in (os.path.join(exe_dir, "cuda"), os.path.join(meipass, "cuda"), meipass):
            if _add_dll_dir(d):
                found.append(d)
    else:
        roots = list(site.getsitepackages()) + [site.getusersitepackages()]
        for root in roots:
            for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
                if _add_dll_dir(d):
                    found.append(d)
    if found:
        _log("CUDA DLL dirs:", "; ".join(found))
    else:
        _log("no extra CUDA DLL dir found (GPU may be unavailable)")


_setup_cuda_dlls()

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel, decode_audio  # noqa: E402
from faster_whisper.utils import _MODELS, download_model  # noqa: E402

PORT = int(os.environ.get("FREEFLOW_PORT", "48123"))
GPU_MODEL = os.environ.get("FREEFLOW_MODEL", "large-v3")
CPU_MODEL = os.environ.get("FREEFLOW_CPU_MODEL", "small")
FORCE_DEVICE = os.environ.get("FREEFLOW_DEVICE", "").lower().strip()
TOKEN = os.environ.get("FREEFLOW_TOKEN", "")
_ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", "127.0.0.1", "localhost"}
# Files faster-whisper needs from a CTranslate2 Whisper repo (same list as download_model).
_MODEL_FILES = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.")

STATE = {
    "ready": False,
    "loading": True,
    "phase": "starting",          # starting | downloading | loading | ready | error
    "download": None,             # {"model", "done", "total"} while downloading
    "error": None,
    "device": None,
    "compute_type": None,
    "model": None,
    "load_ms": None,
    "transcriptions": 0,
}
MODEL = None
MODEL_LOCK = threading.Lock()
SERVER = None


def _repo_dir(repo_id):
    hub = os.environ.get("HF_HUB_CACHE") or os.path.join(
        os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"), "hub")
    return os.path.join(hub, "models--" + repo_id.replace("/", "--"))


def _dir_bytes(d):
    """Bytes of the real files under d (symlinks skipped so blobs are not counted twice)."""
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            try:
                if not os.path.islink(p):
                    total += os.path.getsize(p)
            except OSError:
                pass
    return total


def _expected_bytes(repo_id):
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo_id, files_metadata=True)
        return sum(s.size or 0 for s in info.siblings if s.rfilename.startswith(_MODEL_FILES)) or None
    except Exception as e:
        _log(f"model size unknown ({type(e).__name__}: {e})")
        return None


def _complete(path):
    """True when every file faster-whisper needs is in the snapshot. snapshot_download
    with local_files_only returns the folder even after an interrupted download."""
    try:
        names = os.listdir(path)
    except OSError:
        return False
    need = ("model.bin", "config.json", "tokenizer.json")
    return all(os.path.isfile(os.path.join(path, n)) for n in need) and any(n.startswith("vocabulary.") for n in names)


def _ensure_model(name):
    """Local path of the model, downloading it first (with progress in STATE) if needed.
    An interrupted download resumes where it stopped."""
    try:
        path = download_model(name, local_files_only=True)
        if _complete(path):
            return path
        _log(f"{name}: incomplete local copy, resuming the download")
    except Exception:
        pass
    repo_id = _MODELS.get(name, name)
    cache = _repo_dir(repo_id)
    dl = {"model": name, "done": _dir_bytes(cache), "total": None}
    STATE.update(phase="downloading", download=dl)
    _log(f"{name} not in local cache, downloading {repo_id}...")
    dl["total"] = _expected_bytes(repo_id)
    stop = threading.Event()

    def poll():
        while not stop.wait(0.5):
            dl["done"] = _dir_bytes(cache)

    threading.Thread(target=poll, daemon=True).start()
    try:
        path = download_model(name)
    finally:
        stop.set()
    dl["done"] = dl["total"] or _dir_bytes(cache)
    _log(f"downloaded {repo_id} ({dl['done'] / 1e9:.2f} GB)")
    return path


def _cuda_devices():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count()
    except Exception as e:
        _log(f"CUDA unavailable ({type(e).__name__}: {e})")
        return 0


def _load(model_name, device, compute_type):
    path = _ensure_model(model_name)
    STATE.update(phase="loading", download=None)
    return WhisperModel(path, device=device, compute_type=compute_type)


def _warm(model):
    """First CUDA call initialises cuBLAS/cuDNN; do it before announcing READY."""
    silence = np.zeros(16000, dtype=np.float32)
    segs, _ = model.transcribe(silence, beam_size=1, vad_filter=False, language="fr")
    list(segs)


def load_model():
    global MODEL
    t0 = time.time()
    attempts = []
    # No NVIDIA GPU: skip the large GPU model entirely (no multi-GB download for nothing).
    if FORCE_DEVICE == "cuda" or (FORCE_DEVICE != "cpu" and _cuda_devices() > 0):
        attempts.append((GPU_MODEL, "cuda", "float16"))
        attempts.append((GPU_MODEL, "cuda", "int8_float16"))   # GPUs with less VRAM
        attempts.append((GPU_MODEL, "cuda", "int8"))           # older GPUs without fast float16 (GTX 10xx)
    if FORCE_DEVICE != "cuda":
        attempts.append((CPU_MODEL, "cpu", "int8"))
    last_err = None
    for name, device, ctype in attempts:
        try:
            _log(f"loading {name} on {device} ({ctype})...")
            m = _load(name, device, ctype)
            _warm(m)
            MODEL = m
            STATE.update(ready=True, loading=False, phase="ready", download=None, device=device,
                         compute_type=ctype, model=name, load_ms=int((time.time() - t0) * 1000), error=None)
            _log(f"model ready: {name} {device}/{ctype} in {STATE['load_ms']} ms")
            print("READY", flush=True)
            return
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            _log(f"failed on {device}: {last_err}")
            traceback.print_exc(file=sys.stderr)
    STATE.update(ready=False, loading=False, phase="error", download=None, error=last_err)
    print("FAILED", flush=True)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def _wav_to_float32(body):
    """Decode any container PyAV understands (WAV, webm/opus, mp3...) to 16 kHz mono."""
    try:
        return decode_audio(io.BytesIO(body), sampling_rate=16000)
    except Exception:
        # Fallback: plain PCM16 WAV via the wave module.
        import wave
        with wave.open(io.BytesIO(body), "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            width = w.getsampwidth()
            raw = w.readframes(w.getnframes())
        if width != 2:
            raise ValueError("only 16-bit PCM WAV is supported by the fallback decoder")
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            pcm = pcm.reshape(-1, ch).mean(axis=1)
        if rate != 16000:
            n = int(len(pcm) * 16000 / rate)
            pcm = np.interp(np.linspace(0, len(pcm), n, endpoint=False),
                            np.arange(len(pcm)), pcm).astype(np.float32)
        return pcm


def transcribe(body, lang="auto", hints=None):
    audio = _wav_to_float32(body)
    audio_ms = int(len(audio) / 16.0)
    language = None if lang in ("", "auto") else lang
    initial_prompt = None
    if hints:
        # Dictionary words become the decoder prompt, the same way Wispr feeds
        # its "Dictionary" to the server.
        initial_prompt = ", ".join(h.strip() for h in hints if h.strip())
    t0 = time.time()
    with MODEL_LOCK:
        segments, info = MODEL.transcribe(
            audio,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                for s in segments]
    text = " ".join(s["text"] for s in segs if s["text"]).strip()
    STATE["transcriptions"] += 1
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(float(info.language_probability or 0), 3),
        "duration_ms": int((time.time() - t0) * 1000),
        "audio_ms": audio_ms,
        "segments": segs,
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter than the default
        _log(self.command, self.path, fmt % args)

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        return (self.headers.get("Host") or "").lower() in _ALLOWED_HOSTS

    def _token_ok(self):
        if not TOKEN:
            return True
        return hmac.compare_digest(self.headers.get("X-FreeFlow-Token") or "", TOKEN)

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            return self._json(200, {"status": "ok" if STATE["ready"] else ("loading" if STATE["loading"] else "error"),
                                    "port": PORT, **STATE})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._host_ok() or not self._token_ok():
            self.close_connection = True   # the body was not read
            return self._json(403, {"error": "forbidden"})
        url = urlparse(self.path)
        if url.path == "/shutdown":
            self._json(200, {"ok": True})
            threading.Thread(target=SERVER.shutdown, daemon=True).start()
            return
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        if not STATE["ready"]:
            return self._json(503, {"error": "model not ready", **STATE})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if len(body) < 100:
            return self._json(400, {"error": "empty audio"})
        q = parse_qs(url.query)
        lang = (q.get("lang") or ["auto"])[0]
        hints = (q.get("hints") or [""])[0]
        hints = [h for h in hints.split(",") if h.strip()] if hints else None
        try:
            return self._json(200, transcribe(body, lang, hints))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    global SERVER
    SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    SERVER.daemon_threads = True
    _log(f"listening on http://127.0.0.1:{PORT}  (HF_HOME={os.environ.get('HF_HOME')})")
    print(f"LISTENING {PORT}", flush=True)
    threading.Thread(target=load_model, daemon=True).start()
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass
    _log("bye")


if __name__ == "__main__":
    main()
