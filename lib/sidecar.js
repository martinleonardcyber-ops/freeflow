'use strict';
// Manages the local STT sidecar (faster-whisper HTTP server). Replaces Wispr's
// gRPC/WebSocket stream to api.wisprflow.ai with a loopback HTTP call.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class Sidecar extends EventEmitter {
  /**
   * @param {{port:number, hfHome:string, log:Function, appPath:string,
   *          resourcesPath:string, isPackaged:boolean, token?:string}} opts
   */
  constructor(opts) {
    super();
    this.port = opts.port;
    this.hfHome = opts.hfHome;
    this.log = opts.log || (() => {});
    this.appPath = opts.appPath;
    this.resourcesPath = opts.resourcesPath;
    this.isPackaged = opts.isPackaged;
    this.token = opts.token || '';  // shared secret for POST /transcribe and /shutdown
    this.child = null;
    this.external = false;      // true when we adopted an already-running server
    this.info = { ready: false, loading: true, error: null, device: null, compute_type: null, model: null, load_ms: null };
    this.restarts = 0;
    this._poll = null;
  }

  get base() { return `http://127.0.0.1:${this.port}`; }
  get ready() { return !!this.info.ready; }

  /** Candidate launch commands, first existing wins. */
  resolveCommand() {
    const exe = process.platform === 'win32' ? 'freeflow-stt.exe' : 'freeflow-stt';
    const exeCandidates = [
      path.join(this.resourcesPath || '', 'stt', 'freeflow-stt', exe),
      path.join(this.resourcesPath || '', 'freeflow-stt', exe),
      path.join(this.appPath, 'stt', 'dist', 'freeflow-stt', exe),
    ];
    if (process.env.FREEFLOW_STT_EXE) exeCandidates.unshift(process.env.FREEFLOW_STT_EXE);
    for (const exe of exeCandidates) {
      if (exe && fs.existsSync(exe)) return { cmd: exe, args: [], kind: 'exe' };
    }
    // macOS app bundle: a relocatable Python + its packages + the server script
    // in Resources/engine (scripts/build-mac.sh).
    const engine = path.join(this.resourcesPath || '', 'engine');
    const enginePy = path.join(engine, 'python', 'bin', 'python3');
    if (this.isPackaged && fs.existsSync(enginePy)) {
      return { cmd: enginePy, args: ['-s', path.join(engine, 'stt_server.py')], kind: 'python', pythonPath: path.join(engine, 'site-packages') };
    }
    const script = path.join(this.appPath, 'stt', 'stt_server.py');
    if (!this.isPackaged && fs.existsSync(script)) {
      // stt/.venv (see README) first, then the system interpreter.
      const venv = process.platform === 'win32' ? path.join(this.appPath, 'stt', '.venv', 'Scripts', 'python.exe') : path.join(this.appPath, 'stt', '.venv', 'bin', 'python');
      const py = process.env.FREEFLOW_PYTHON || (fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3');
      return { cmd: py, args: [script], kind: 'python' };
    }
    return null;
  }

  async start() {
    const existing = await this.health(1500);
    if (existing) {
      this.external = true;
      this.info = { ...this.info, ...existing };
      this.log(`sidecar: adopting existing server on :${this.port} (ready=${existing.ready})`);
      this._startPolling();
      if (existing.ready) this.emit('ready', this.info);
      return;
    }
    const cmd = this.resolveCommand();
    if (!cmd) {
      this.info = { ...this.info, loading: false, error: 'Moteur STT introuvable (stt/dist/freeflow-stt ou stt/stt_server.py)' };
      this.log('sidecar: no command found');
      this.emit('failed', this.info.error);
      return;
    }
    this.log(`sidecar: spawning ${cmd.kind} ${cmd.cmd} ${cmd.args.join(' ')}`);
    const env = { ...process.env, FREEFLOW_PORT: String(this.port), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    if (this.hfHome) env.HF_HOME = this.hfHome;
    if (this.token) env.FREEFLOW_TOKEN = this.token;
    if (cmd.pythonPath) { env.PYTHONPATH = cmd.pythonPath; env.PYTHONNOUSERSITE = '1'; }
    this.child = spawn(cmd.cmd, cmd.args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(cmd.kind === 'python' ? cmd.args[cmd.args.length - 1] : cmd.cmd) });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        this.log(`[stt out] ${line}`);
        if (line === 'READY') this.health(2000).then((h) => { if (h) { this.info = { ...this.info, ...h }; } else { this.info.ready = true; this.info.loading = false; } this.emit('ready', this.info); });
        if (line === 'FAILED') this.health(2000).then((h) => { this.info = { ...this.info, ...(h || {}), ready: false, loading: false }; this.emit('failed', this.info.error || 'Chargement du modèle impossible'); });
      }
    });
    // Line-buffered: an unbuffered Python print() can arrive split across chunks.
    let errBuf = '';
    this.child.stderr.on('data', (d) => {
      errBuf += d;
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop();
      for (const l of lines) {
        const line = l.trim();
        if (line) this.log(line.startsWith('[stt]') ? line : `[stt] ${line}`);
      }
    });
    this.child.on('exit', (code, sig) => {
      this.log(`sidecar: exited code=${code} sig=${sig}`);
      this.child = null;
      const wasReady = this.info.ready;
      this.info = { ...this.info, ready: false, loading: false, error: this.info.error || `Moteur arrêté (code ${code})` };
      this.emit('exit', code);
      if (!this.stopping && wasReady && this.restarts < 2) {
        this.restarts += 1;
        this.log('sidecar: restarting...');
        setTimeout(() => this.start(), 1000);
      }
    });
    this._startPolling();
  }

  _startPolling() {
    clearInterval(this._poll);
    this._poll = setInterval(async () => {
      const h = await this.health(1500);
      if (h) {
        const becameReady = h.ready && !this.info.ready;
        const before = JSON.stringify([this.info.phase, this.info.download]);
        this.info = { ...this.info, ...h };
        if (becameReady) this.emit('ready', this.info);
        else if (JSON.stringify([h.phase, h.download]) !== before) this.emit('progress', this.info);
      }
      if (this.info.ready) { clearInterval(this._poll); this._poll = null; }
    }, 1000);
  }

  async health(timeoutMs = 1500) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(`${this.base}/health`, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{text:string, language:string, duration_ms:number, audio_ms:number}>} */
  async transcribe(wav, { lang = 'auto', hints = [] } = {}) {
    if (!this.info.ready) throw new Error('Le moteur de transcription n’est pas prêt');
    const q = new URLSearchParams({ lang: lang || 'auto' });
    const h = (hints || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 80);
    if (h.length) q.set('hints', h.join(','));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 120000);
    try {
      const r = await fetch(`${this.base}/transcribe?${q}`, {
        method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav', 'X-FreeFlow-Token': this.token }, signal: ac.signal,
      });
      const json = await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error('Moteur refusé : un autre OxoFlow tourne déjà sur ce port');
      if (!r.ok) throw new Error(json.error || `STT HTTP ${r.status}`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this._poll);
    if (this.external || !this.child) return;
    const child = this.child;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 800);
      await fetch(`${this.base}/shutdown`, { method: 'POST', headers: { 'X-FreeFlow-Token': this.token }, signal: ac.signal }).catch(() => {});
      clearTimeout(t);
    } catch { /* ignore */ }
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done());
        } else done();
      }, 1200);
    });
    this.child = null;
  }
}

module.exports = { Sidecar };
