'use strict';
// Overlay renderer: shows the pill states and captures the microphone
// (getUserMedia -> AudioWorklet -> PCM16) while "listening".
(() => {
  const pill = document.getElementById('pill');
  const barsEl = document.getElementById('bars');
  const labelEl = document.getElementById('label');
  const timerEl = document.getElementById('timer');
  const N_BARS = 23;                 // odd: the newest level sits in the middle and spreads outwards
  const HALF = (N_BARS + 1) / 2;
  const LABELS = {
    listening: 'Écoute',
    transcribing: 'Transcription…',
    formatting: 'Mise en forme…',
    done: 'Terminé',
    error: 'Erreur',
  };
  for (let i = 0; i < N_BARS; i++) barsEl.appendChild(document.createElement('span'));
  const bars = Array.from(barsEl.children);
  const levels = new Array(HALF).fill(0);
  let timerInt = null, startedAt = 0, maxSec = 300;
  let soundsOn = true, outCtx = null, lastPhase = 'idle';

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
  let ctx = null, stream = null, source = null, node = null, sink = null;
  let chunks = [], total = 0, recording = false, demoTimer = null, raf = null;
  let skip = 0;   // samples to drop at the start: the start chime must not be transcribed
  let flushResolve = null;

  function setBars() {
    const mid = HALF - 1;
    for (let i = 0; i < N_BARS; i++) {
      const d = Math.abs(i - mid);                     // distance from the centre = age of the level
      const taper = 1 - (d / HALF) * 0.45;             // edges a little calmer than the centre
      const h = 3 + Math.round(levels[HALF - 1 - d] * 25 * taper);
      bars[i].style.height = `${h}px`;
    }
  }
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
  function pushLevel(v) {
    levels.shift();
    levels.push(Math.max(0, Math.min(1, v)));
  }
  function renderLoop() {
    setBars();
    raf = requestAnimationFrame(renderLoop);
  }
  function stopRender() { if (raf) cancelAnimationFrame(raf); raf = null; }

  // Idle Flow bar: a small capsule that grows on hover; a click starts a hands-free dictation.
  function showMini(hint) {
    stopRender(); stopTimer(); stopDemoLevels();
    pill.dataset.phase = 'idle';
    pill.classList.add('show', 'mini');
    if (hint) document.getElementById('hint').textContent = hint;
  }
  pill.addEventListener('mouseenter', () => { pill.classList.add('hover'); window.freeflow.send('ff:overlay-mouse', true); });
  pill.addEventListener('mouseleave', () => { pill.classList.remove('hover'); window.freeflow.send('ff:overlay-mouse', false); });
  pill.addEventListener('click', () => window.freeflow.send('ff:overlay-click'));

  function show(phase, payload = {}) {
    pill.classList.remove('mini');
    pill.dataset.phase = phase;
    labelEl.textContent = LABELS[phase] || '';
    if (phase === 'done') {
      const verb = { pasted: 'Collé', clipboard: 'Copié', hub: 'Inséré', blocked: 'Copié' }[payload.pasted] || 'Terminé';
      labelEl.textContent = verb;
      if (payload.latencyMs) {
        const small = document.createElement('small');
        small.textContent = `${(payload.latencyMs / 1000).toFixed(1).replace('.', ',')} s`;
        labelEl.appendChild(small);
      }
    }
    if (phase === 'error') labelEl.textContent = payload.message || 'Erreur';
    pill.classList.add('show');
    if (phase === 'listening') {
      if (!raf) renderLoop();
      if (!timerInt || payload.startedAt) startTimer(payload.startedAt || (payload.demo ? Date.now() - 7000 : Date.now()), payload.maxSec);
    } else { stopRender(); stopTimer(); }
    if (payload.demo && phase === 'listening') startDemoLevels(); else stopDemoLevels();
  }
  function hide() {
    pill.classList.remove('show', 'mini', 'hover');
    stopRender();
    stopTimer();
    stopDemoLevels();
  }

  function startDemoLevels() {
    stopDemoLevels();
    let t = 0;
    demoTimer = setInterval(() => {
      t += 0.35;
      pushLevel(0.25 + 0.45 * Math.abs(Math.sin(t)) * (0.6 + 0.4 * Math.random()));
      setBars();
    }, 50);
  }
  function stopDemoLevels() { if (demoTimer) clearInterval(demoTimer); demoTimer = null; }

  // ---- microphone
  async function startRecording({ deviceId } = {}) {
    await cleanupAudio();
    chunks = []; total = 0; recording = true;
    levels.fill(0);
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
    node = new AudioWorkletNode(ctx, 'ff-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => {
      if (e.data && e.data.done) { if (flushResolve) flushResolve(); return; }
      const f32 = e.data;
      if (!(f32 instanceof Float32Array)) return;
      if (recording) {
        if (skip > 0) skip -= f32.length;
        else { chunks.push(f32); total += f32.length; }
      }
      // RMS -> level for the waveform
      let sum = 0;
      for (let i = 0; i < f32.length; i += 4) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / (f32.length / 4));
      const level = Math.min(1, Math.pow(rms * 6, 0.7));
      pushLevel(level);
      window.freeflow.send('ff:level', level);   // mirrored in the hub's waveform
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
    try { if (sink) sink.disconnect(); } catch { /* ignore */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
    node = source = sink = stream = ctx = null;
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

  setBars();
  window.freeflow.send('ff:overlay-ready');
})();
