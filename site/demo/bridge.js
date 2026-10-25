'use strict';
// Website demo of the real OxoFlow window: the hub's own HTML/CSS/JS (copied by
// scripts/build-site-demo.sh) talks to this stand-in for preload.js instead of
// the app. Everything stays in the visitor's browser: example data, the real
// formatting rules for the dictionary test, a simulated dictation, and a fake
// microphone (the browser never asks for the real one).
(() => {
  const listeners = {};
  const emit = (ch, ...a) => (listeners[ch] || []).forEach((cb) => cb(...a));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const words = (t) => (t.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

  // ---- example history (made up for the demo, labelled as such on the site)
  const SAMPLES = [
    ['Salut Julie, je te confirme la réunion de demain à 11 h. Je t’envoie le lien juste après.', 'Slack', 7, true],
    ['Ajoute un test pour le cas où le presse-papiers contient une image, et vérifie qu’elle est restaurée.', 'Code', 46, false],
    ['J’automatise tout avec n8n et je publie les vidéos sur TikTok via Postiz.', 'Notion', 95, true],
    ['Peux-tu me résumer les trois points clés de la réunion d’hier ?', 'ChatGPT', 60 * 21, false],
    ['Bonne journée et à très vite !', 'Mail', 60 * 26, false],
    ['Le modèle tourne en local sur la puce, rien ne sort du Mac.', 'Notes', 60 * 50, true],
  ];
  const history = SAMPLES.map(([text, app, min, ai], i) => ({
    id: `d${i}`, ts: ago(min), text, raw: ai ? 'euh ' + text.toLowerCase().replace(/[.,!?’]/g, '') : text,
    words: words(text), audioMs: words(text) * 410, sttMs: 280, latencyMs: 560 + i * 60, language: 'fr', app, pasted: 'pasted',
    ai: ai ? { model: 'hermes-3-llama-3.1-8b', ms: 900 } : null,
  }));
  for (let d = 2; d < 13; d++) if (d % 3) history.push({ id: `o${d}`, ts: ago(d * 1440 + 200), text: 'Dictée d’exemple.', raw: 'Dictée d’exemple.', words: 40 + ((d * 53) % 170), audioMs: (40 + ((d * 53) % 170)) * 400, latencyMs: 640, language: 'fr', app: 'Chrome', pasted: 'pasted', ai: null });

  // ---- stats computed like main.js does
  const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  function stats() {
    const today = new Date().toDateString();
    let total = 0, wordsToday = 0, audioMs = 0, timed = 0, lat = 0, latN = 0;
    const perDay = new Map();
    for (const h of state.history) {
      total += h.words;
      if (new Date(h.ts).toDateString() === today) wordsToday += h.words;
      if (h.audioMs) { audioMs += h.audioMs; timed += h.words; }
      if (h.latencyMs) { lat += h.latencyMs; latN++; }
      perDay.set(dayKey(h.ts), (perDay.get(dayKey(h.ts)) || 0) + h.words);
    }
    const daily = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(); d.setHours(12); d.setDate(d.getDate() - i); daily.push({ day: dayKey(d), words: perDay.get(dayKey(d)) || 0 }); }
    let streak = 0; const c = new Date(); c.setHours(12);
    if (!perDay.has(dayKey(c))) c.setDate(c.getDate() - 1);
    while (perDay.has(dayKey(c))) { streak++; c.setDate(c.getDate() - 1); }
    return { wordsToday, totalWords: total, dictations: state.history.length, avgWpm: audioMs ? Math.round(timed / (audioMs / 60000)) : 0,
      avgLatencyMs: latN ? Math.round(lat / latN) : 0, minutesSpoken: Math.round(audioMs / 60000), minutesSaved: Math.max(0, Math.round(total / 40 - audioMs / 60000)),
      typingWpm: 40, daily, streak };
  }

  const state = {
    version: '1.6', user: '', phase: 'idle', platform: 'darwin', devMode: false,
    pttAvailable: true, shortcutOk: true, shortcutSuspended: false, accessibility: true, microphone: 'granted', fnUsage: 0, fnDenied: false,
    settings: { shortcut: 'Fn', mode: 'ptt', language: 'auto', autoPaste: true, launchAtLogin: false, microphoneId: 'default', sounds: true, flowBar: true,
      theme: 'system', aiFormat: false, onboarded: true, modelCache: '~/Library/Application Support/OxoFlow/models' },
    dictionary: [], snippets: [{ id: 's1', trigger: 'ma signature', expansion: 'Bonne journée,\nMartin' }, { id: 's2', trigger: 'mon adresse', expansion: '12 rue des Lilas, 75011 Paris' }],
    history,
    sidecar: { ready: true, loading: false, phase: 'ready', device: 'mlx', model: 'large-v3-turbo', compute_type: 'float16', port: 48123, load_ms: 1900, transcriptions: 6 },
    loadingLabel: '', loadingShort: '',
    paths: { userData: '~/Library/Application Support/OxoFlow (démo)', logs: '' },
  };
  state.stats = stats();
  const push = () => { state.stats = stats(); emit('ff:state', clone(state)); };

  // ---- simulated dictation (the "Essayer ici" microphone and the assistant)
  const SPOKEN = [
    'Ceci est une démo : dans l’app, ta voix est transcrite sur ta machine en moins d’une seconde.',
    'Rappelle-moi d’envoyer le devis à Thomas demain matin.',
    'J’automatise tout avec n8n et je publie sur TikTok.',
  ];
  let spoken = 0, levelTimer = null;
  function setPhase(phase, extra = {}) { state.phase = phase; emit('ff:dictation', { phase, ...extra }); }
  function stopDictation() {
    clearInterval(levelTimer);
    setPhase('transcribing');
    setTimeout(() => {
      const text = SPOKEN[spoken++ % SPOKEN.length];
      emit('ff:insert', text);
      state.history.unshift({ id: `n${Date.now()}`, ts: new Date().toISOString(), text, raw: text, words: words(text), audioMs: words(text) * 400, sttMs: 300, latencyMs: 640, language: 'fr', app: 'OxoFlow', pasted: 'hub', ai: null });
      setPhase('done', { latencyMs: 640, pasted: 'hub', text });
      push();
      setTimeout(() => setPhase('idle'), 900);
    }, 700);
  }

  // ---- real formatting rules for "Dictionnaire › Tester": lib/format.js and
  // lib/vocab.js, wrapped by scripts/build-site-demo.sh into window.OxoLib (no eval).
  let format = (t) => t;
  const ready = (async () => {
    const lib = window.OxoLib;
    if (!lib) { console.warn('demo: formatting unavailable'); return; }
    format = lib.format.formatText;
    state.dictionary = lib.vocab.normalizeVocab(lib.vocab.DEFAULT_VOCAB);
  })();

  const handlers = {
    'ff:get-state': async () => { await ready; state.stats = stats(); return clone(state); },
    'ff:set-settings': (p) => { Object.assign(state.settings, p || {}); push(); return clone(state); },
    'ff:format-preview': (t) => format(t, { language: 'fr', dictionary: state.dictionary, snippets: state.snippets }),
    'ff:dictionary': ({ action, word, sounds, previous } = {}) => {
      const parse = (x) => String(x || '').split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean);
      const find = (k) => state.dictionary.find((v) => v.word.toLowerCase() === String(k || '').toLowerCase());
      if (action === 'add') { const e = find(word); if (e) e.sounds.push(...parse(sounds)); else state.dictionary.push({ word, sounds: parse(sounds) }); }
      if (action === 'update') { const e = find(previous || word); if (e) { e.word = word; e.sounds = parse(sounds); } }
      if (action === 'remove') state.dictionary = state.dictionary.filter((v) => v.word.toLowerCase() !== String(word).toLowerCase());
      push(); return state.dictionary;
    },
    'ff:snippets': ({ action, id, trigger, expansion }) => {
      if (action === 'add') state.snippets.push({ id: String(Date.now()), trigger, expansion });
      if (action === 'update') state.snippets = state.snippets.map((s) => (s.id === id ? { ...s, trigger, expansion } : s));
      if (action === 'remove') state.snippets = state.snippets.filter((s) => s.id !== id);
      push(); return state.snippets;
    },
    'ff:history': ({ action, id }) => { state.history = action === 'clear' ? [] : state.history.filter((h) => h.id !== id); push(); return state.history; },
    'ff:dictation-toggle': () => {
      if (state.phase === 'idle') {
        setPhase('listening', { startedAt: Date.now() });
        let t = 0;
        levelTimer = setInterval(() => { t += 0.1; emit('ff:level', Math.max(0, Math.sin(t * 7) * 0.45 + Math.random() * 0.4)); }, 100);
        setTimeout(() => { if (state.phase === 'listening') stopDictation(); }, 3200);
      } else if (state.phase === 'listening') stopDictation();
      return state.phase;
    },
    'ff:dictation-cancel': () => { clearInterval(levelTimer); setPhase('idle'); return 'idle'; },
    'ff:copy': async (t) => { try { await navigator.clipboard.writeText(String(t || '')); } catch { /* not allowed in a frame */ } return true; },
    'ff:shortcut-test': () => ({ ok: true }),
    'ff:shortcut-suspend': (on) => ({ suspended: on, ok: true }),
    'ff:mic-prompt': () => true,
    'ff:accessibility-prompt': () => true,
    'ff:ai-status': () => ({ endpoint: null, models: [], pinned: '', model: null }),
    'ff:ai-test': () => ({ ok: false, error: 'dans la démo, pas de modèle local : installe OxoFlow et LM Studio' }),
  };

  window.freeflow = {
    platform: 'darwin',
    invoke: async (ch, ...a) => (handlers[ch] ? handlers[ch](...a) : null),
    send: () => {},
    on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); return () => {}; },
  };

  // ---- fake microphone: a synthetic "voice" for Paramètres › Micro › Tester,
  // so the visitor's browser never asks for the real microphone.
  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'builtin', label: 'Micro du MacBook Pro', groupId: '' },
    { kind: 'audioinput', deviceId: 'usb', label: 'Micro USB', groupId: '' },
  ];
  md.getUserMedia = async () => {
    const ctx = new AudioContext();
    try { await ctx.resume(); } catch { /* ignore */ }
    const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), gain = ctx.createGain(), depth = ctx.createGain(), out = ctx.createMediaStreamDestination();
    osc.frequency.value = 180; lfo.frequency.value = 3.2; gain.gain.value = 0.08; depth.gain.value = 0.07;
    lfo.connect(depth).connect(gain.gain); osc.connect(gain).connect(out);
    osc.start(); lfo.start();
    const stream = out.stream;
    stream.getTracks().forEach((tr) => { const stop = tr.stop.bind(tr); tr.stop = () => { stop(); ctx.close(); }; });
    return stream;
  };
})();
