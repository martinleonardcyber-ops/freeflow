'use strict';
// Overlay renderer: the pill at the bottom of the screen. It captures the
// microphone (getUserMedia -> AudioWorklet -> PCM16) while "listening" and
// draws a live voice spectrum on a canvas; its size morphs between states.
(() => {
  const pill = document.getElementById('pill');
  const row = document.getElementById('row');
  const labelEl = document.getElementById('label');
  const previewEl = document.getElementById('preview');
  const timerEl = document.getElementById('timer');
  const canvas = document.getElementById('wave');
  const LABELS = {
    listening: 'Écoute',
    transcribing: 'Transcription…',
    formatting: 'Mise en forme…',
    done: 'Terminé',
    error: 'Erreur',
  };
  let timerInt = null, startedAt = 0, maxSec = 300;
  let soundsOn = true, outCtx = null, lastPhase = 'idle';
  let phase = 'idle', demo = false;

  // ---- size morphing: the pill hugs its centred content
  const HEIGHTS = { mini: 8, hint: 32, listening: 40, transcribing: 40, formatting: 40, done: 36, error: 36 };
  let kind = 'mini';
  function apply() {
    const w = kind === 'mini' ? 46 : Math.ceil(row.getBoundingClientRect().width) + (kind === 'listening' ? 22 : 30);
    pill.style.setProperty('--w', `${w}px`);
    pill.style.setProperty('--h', `${HEIGHTS[kind] || 40}px`);
  }
  function fit(next) { kind = next; requestAnimationFrame(apply); }
  // The content can still change size after a state switch (font loaded, timer text): follow it.
  new ResizeObserver(() => apply()).observe(row);

  // ---- sound cues (synthesised: no audio files to ship)
  function chime(freqs, { step = 0.075, len = 0.11, gain = 0.05 } = {}) {
    if (!soundsOn) return;
    try {
      outCtx = outCtx || new AudioContext();
      const t0 = outCtx.currentTime + 0.01;
      freqs.forEach((f, i) => {
        const o = outCtx.createOscillator(), g = outCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = t0 + i * step;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(outCtx.destination);
        o.start(t); o.stop(t + len + 0.02);
      });
    } catch { /* no audio output: stay silent */ }
  }

  // ---- audio capture state
  let ctx = null, stream = null, source = null, node = null, sink = null, analyser = null;
  let chunks = [], total = 0, recording = false;
  let skip = 0;   // samples to drop at the start: the start chime must not be transcribed
  let flushResolve = null;

  // ---- live spectrum
  // 25 mirrored bars: the lowest voice band in the centre, higher bands outwards.
  const BARS = 25, MID = (BARS - 1) / 2, BANDS = MID + 1;
  const vals = new Float32Array(BARS);        // what is drawn (smoothed)
  const bands = new Float32Array(BANDS);      // latest band energies, 0..1
  let freq = null, edges = null, raf = null, t0 = performance.now();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const CW = 132, CH = 26;
  canvas.width = CW * dpr; canvas.height = CH * dpr;
  const g2 = canvas.getContext('2d');
  g2.scale(dpr, dpr);
  const grad = g2.createLinearGradient(0, 0, CW, 0);
  grad.addColorStop(0, '#9d85ff'); grad.addColorStop(0.5, '#e48cf0'); grad.addColorStop(1, '#ff8a66');

  function readBands() {
    if (!analyser) return;
    if (!freq || freq.length !== analyser.frequencyBinCount) {
      freq = new Uint8Array(analyser.frequencyBinCount);
      const hz = ctx.sampleRate / analyser.fftSize;
      // log-spaced edges from 90 Hz to 4.2 kHz (where speech lives)
      edges = Array.from({ length: BANDS + 1 }, (_, k) => Math.max(1, Math.round((90 * Math.pow(4200 / 90, k / BANDS)) / hz)));
    }
    analyser.getByteFrequencyData(freq);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0, n = 0;
      for (let i = edges[b]; i < Math.max(edges[b] + 1, edges[b + 1]); i++) { sum += freq[i] || 0; n++; }
      const v = (sum / n) / 255;
      bands[b] = Math.min(1, Math.pow(v, 1.7) * (1.5 + b * 0.09));   // higher bands are naturally quieter
    }
  }

  function demoBands(t) {
    for (let b = 0; b < BANDS; b++) bands[b] = Math.max(0, (0.75 - b * 0.045) * (0.55 + 0.45 * Math.sin(t * 7 + b * 0.9)) * (0.7 + 0.3 * Math.sin(t * 2.3)));
  }

  function draw(now) {
    const t = (now - t0) / 1000;
    const listening = phase === 'listening';
    const thinking = phase === 'transcribing' || phase === 'formatting';
    if (listening) { if (demo) demoBands(t); else readBands(); }
    let energy = 0;
    for (let i = 0; i < BARS; i++) {
      const d = Math.abs(i - MID);
      let target;
      if (listening) target = bands[Math.min(BANDS - 1, Math.round(d))] * (1 - (d / BARS) * 0.5);
      else if (thinking) target = 0.08 + 0.42 * Math.pow(Math.max(0, Math.sin(i * 0.5 - t * 7)), 3);   // a wave sweeping across
      else target = 0;
      // fast attack, soft release
      vals[i] += (target - vals[i]) * (target > vals[i] ? 0.5 : 0.14);
      energy += vals[i];
    }
    if (listening) pill.style.setProperty('--lv', Math.min(1, energy / BARS * 2.2).toFixed(3));
    g2.clearRect(0, 0, CW, CH);
    const bw = 3, gap = (CW - BARS * bw) / (BARS - 1);
    for (let i = 0; i < BARS; i++) {
      const h = Math.max(3, 3 + vals[i] * (CH - 4));
      const x = i * (bw + gap), y = (CH - h) / 2;
      g2.globalAlpha = thinking ? 0.45 + vals[i] * 1.1 : 0.55 + Math.min(0.45, vals[i] * 1.2);
      g2.fillStyle = thinking ? '#f6f4fb' : grad;
      g2.beginPath();
      g2.roundRect(x, y, bw, h, bw / 2);
      g2.fill();
    }
    g2.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }
  function startDraw() { if (!raf) { t0 = performance.now(); raf = requestAnimationFrame(draw); } }
  function stopDraw() { if (raf) cancelAnimationFrame(raf); raf = null; vals.fill(0); bands.fill(0); }

  function fmtTime(sec) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
  function tick() {
    const el = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const left = maxSec - el;
    // Last 30 s: show the time left instead, in amber.
    timerEl.textContent = left <= 30 ? `-${fmtTime(Math.max(0, left))}` : fmtTime(el);
    timerEl.classList.toggle('warn', left <= 30);
  }
  function startTimer(at, max) {
    startedAt = at || Date.now(); maxSec = max || 300;
    clearInterval(timerInt); tick(); timerInt = setInterval(tick, 250);
  }
  function stopTimer() { clearInterval(timerInt); timerInt = null; }

  // ---- idle Flow bar: a thin capsule that grows on hover; a click starts a hands-free dictation.
  function showMini(hint) {
    stopDraw(); stopTimer();
    phase = 'idle';
    pill.dataset.phase = 'idle';
    pill.classList.add('show', 'mini');
    if (hint) {
      document.getElementById('hint-key').textContent = hint.key || 'fn';
      document.getElementById('hint-text').textContent = hint.text || '';
    }
    fit(pill.classList.contains('hover') ? 'hint' : 'mini');
  }
  pill.addEventListener('mouseenter', () => {
    pill.classList.add('hover'); window.freeflow.send('ff:overlay-mouse', true);
    if (pill.classList.contains('mini')) fit('hint');
  });
  pill.addEventListener('mouseleave', () => {
    pill.classList.remove('hover'); window.freeflow.send('ff:overlay-mouse', false);
    if (pill.classList.contains('mini')) fit('mini');
  });
  pill.addEventListener('click', () => window.freeflow.send('ff:overlay-click'));

  function show(next, payload = {}) {
    pill.classList.remove('mini');
    phase = next;
    demo = !!payload.demo;
    pill.dataset.phase = next;
    labelEl.textContent = LABELS[next] || '';
    previewEl.textContent = '';
    if (next === 'done') {
      const verb = { pasted: 'Collé', clipboard: 'Copié', hub: 'Inséré', blocked: 'Copié' }[payload.pasted] || 'Terminé';
      labelEl.textContent = verb;
      if (payload.latencyMs) {
        const small = document.createElement('small');
        small.textContent = `${(payload.latencyMs / 1000).toFixed(1).replace('.', ',')} s`;
        labelEl.appendChild(small);
      }
      const text = String(payload.text || '').replace(/\s+/g, ' ').trim();
      if (text) previewEl.textContent = `« ${text.length > 34 ? text.slice(0, 33).trimEnd() + '…' : text} »`;
    }
    if (next === 'error') labelEl.textContent = payload.message || 'Erreur';
    pill.classList.add('show');
    if (next === 'listening') {
      startDraw();
      if (!timerInt || payload.startedAt) startTimer(payload.startedAt || (payload.demo ? Date.now() - 7000 : Date.now()), payload.maxSec);
    } else stopTimer();
    if (next === 'transcribing' || next === 'formatting') startDraw();      // the bars become the thinking wave
    if (next === 'done' || next === 'error') stopDraw();
    fit(next);
  }
  function hide() {
    pill.classList.remove('show', 'mini', 'hover');
    phase = 'idle';
    stopDraw();
    stopTimer();
  }

  // ---- microphone
  async function startRecording({ deviceId } = {}) {
    await cleanupAudio();
    chunks = []; total = 0; recording = true;
    const constraints = {
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
    if (deviceId && deviceId !== 'default') constraints.audio.deviceId = { exact: deviceId };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (deviceId && deviceId !== 'default') {
        // The chosen device vanished: fall back to the default one.
        delete constraints.audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else throw e;
    }
    try { ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -20;
    source.connect(analyser);
    node = new AudioWorkletNode(ctx, 'ff-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => {
      if (e.data && e.data.done) { if (flushResolve) flushResolve(); return; }
      const f32 = e.data;
      if (!(f32 instanceof Float32Array)) return;
      if (recording) {
        if (skip > 0) skip -= f32.length;
        else { chunks.push(f32); total += f32.length; }
      }
      // RMS -> level, mirrored in the hub's waveform
      let sum = 0;
      for (let i = 0; i < f32.length; i += 4) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / (f32.length / 4));
      window.freeflow.send('ff:level', Math.min(1, Math.pow(rms * 6, 0.7)));
    };
    sink = ctx.createGain();
    sink.gain.value = 0; // worklet needs a path to the destination to keep processing
    source.connect(node).connect(sink).connect(ctx.destination);
    if (ctx.state !== 'running') await ctx.resume();
    skip = soundsOn ? Math.round(ctx.sampleRate * 0.3) : 0;
  }

  async function finishRecording() {
    if (!node) return null;
    recording = true;
    await new Promise((resolve) => {
      flushResolve = resolve;
      node.port.postMessage({ cmd: 'flush' });
      setTimeout(resolve, 300);
    });
    flushResolve = null;
    recording = false;
    const sampleRate = ctx ? ctx.sampleRate : 16000;
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        pcm[o++] = s < 0 ? s * 32768 : s * 32767;
      }
    }
    chunks = []; total = 0;
    await cleanupAudio();
    return { pcm: pcm.buffer, sampleRate };
  }

  async function cleanupAudio() {
    recording = false;
    try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch { /* ignore */ }
    try { if (source) source.disconnect(); } catch { /* ignore */ }
    try { if (analyser) analyser.disconnect(); } catch { /* ignore */ }
    try { if (sink) sink.disconnect(); } catch { /* ignore */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    node = source = sink = stream = ctx = analyser = null;
  }

  // ---- IPC
  window.freeflow.on('ff:overlay', (payload) => {
    if (!payload) return;
    if (!payload.demo) {
      if (payload.phase === 'transcribing' && lastPhase === 'listening') chime([880, 587], { gain: 0.04 });
      if (payload.phase === 'error' && lastPhase !== 'error') chime([330, 262], { step: 0.09, gain: 0.035 });
      lastPhase = payload.phase;
    }
    if (payload.phase === 'idle' && payload.bar) showMini(payload.hint);
    else if (payload.phase === 'idle' || payload.phase === 'hide') hide();
    else show(payload.phase, payload);
  });

  window.freeflow.on('ff:rec-start', async (opts) => {
    soundsOn = !opts || opts.sounds !== false;
    chime([587, 880]);
    try {
      await startRecording(opts || {});
    } catch (e) {
      await cleanupAudio();
      window.freeflow.send('ff:audio-error', e && e.name === 'NotAllowedError' ? 'Accès au micro refusé' : `Micro indisponible (${e && e.message})`);
    }
  });

  window.freeflow.on('ff:rec-stop', async () => {
    try {
      const out = await finishRecording();
      if (out) window.freeflow.send('ff:audio-done', out);
      else window.freeflow.send('ff:audio-error', 'Aucun audio capturé');
    } catch (e) {
      window.freeflow.send('ff:audio-error', `Erreur audio (${e && e.message})`);
    }
  });

  window.freeflow.on('ff:rec-cancel', () => { cleanupAudio(); hide(); });

  window.freeflow.send('ff:overlay-ready');
})();
