'use strict';
// Browser-only stand-in for preload.js, to design the renderers without
// Electron or Windows: serve the repo root over HTTP and open
// /dev/preview.html?page=hub (or ?page=overlay&phase=listening).
// The history/dictionary below is DEMO data and never leaves this page.
(() => {
  const listeners = {};
  const emit = (ch, ...a) => (listeners[ch] || []).forEach((cb) => cb(...a));
  const params = new URLSearchParams(location.search);
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const sample = [
    ['Salut Julie, je te confirme le point de demain à 10 h 30. Je t’envoie le lien Notion juste après.', 'slack', 6],
    ['Ajoute un test pour le cas où le presse-papiers contient une image, et vérifie la restauration.', 'code', 42],
    ['J’automatise tout avec n8n et je publie sur TikTok via Postiz.', 'chrome', 95],
    ['Peux-tu me résumer les trois points clés de la réunion d’hier ?', 'chrome', 60 * 20],
    ['Bonne journée et à très vite !', 'outlook', 60 * 26],
    ['Le modèle tourne en local sur la carte graphique, rien ne sort du PC.', 'notion', 60 * 50],
  ];
  const history = [];
  sample.forEach(([text, app, min], i) => history.push({ id: 'h' + i, ts: ago(min), text, raw: i === 2 ? 'euh j’automatise tout avec n huit n et je publie sur tic toc via post iz' : text, words: text.split(/\s+/).length, audioMs: 4000 + i * 900, sttMs: 420, latencyMs: 520 + i * 60, language: 'fr', app, pasted: i === 4 ? 'blocked' : 'pasted' }));
  for (let d = 2; d < 13; d++) if (d % 3) history.push({ id: 'o' + d, ts: ago(d * 1440 + 30), text: 'Dictée de démonstration.', raw: 'Dictée de démonstration.', words: 30 + ((d * 53) % 170), audioMs: 20000, latencyMs: 600, language: 'fr', app: 'chrome', pasted: 'pasted' });
  const day = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const perDay = {};
  history.forEach((h) => { const x = new Date(h.ts); const k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; perDay[k] = (perDay[k] || 0) + h.words; });
  const daily = []; for (let i = 13; i >= 0; i--) daily.push({ day: day(i), words: perDay[day(i)] || 0 });
  const total = history.reduce((a, h) => a + h.words, 0);
  const state = {
    version: '1.1.0', user: 'alan', phase: 'idle', pttAvailable: true, shortcutOk: true, shortcutSuspended: false, platform: 'win32',
    settings: { shortcut: 'Ctrl+Alt+Space', mode: 'toggle', language: 'auto', autoPaste: true, launchAtLogin: false, microphoneId: 'default', modelCache: 'C:\\Users\\alan\\AppData\\Local\\OxoFlow\\models', theme: 'system' },
    dictionary: [
      { word: 'n8n', sounds: ['n huit n', 'aine huit aine', 'en huit en'] },
      { word: 'Higgsfield', sounds: ['x field', 'hicks field', 'higgs field'] },
      { word: 'Claude Code', sounds: ['clode code', 'cloud code'] },
      { word: 'GitHub', sounds: ['git hub', 'guit hub'] },
      { word: 'ChatGPT', sounds: ['chat gpt', 'tchat g p t'] },
      { word: 'TikTok', sounds: ['tic toc', 'tik tok'] },
      { word: 'Postiz', sounds: ['post iz', 'postise'] },
      { word: 'Opus', sounds: [] },
    ],
    snippets: [
      { id: 's1', trigger: 'ma signature', expansion: 'Bonne journée et à très vite !\nAlan' },
      { id: 's2', trigger: 'mon adresse', expansion: '12 rue des Lilas, 75011 Paris' },
    ],
    history,
    stats: { wordsToday: 61, totalWords: total, dictations: history.length, avgWpm: 142, avgLatencyMs: 640, minutesSpoken: 9, minutesSaved: Math.round(total / 40 - 9), typingWpm: 40, daily, streak: 3 },
    sidecar: { ready: true, loading: false, phase: 'ready', device: 'cuda', model: 'large-v3', compute_type: 'float16', port: 48123, load_ms: 6400, transcriptions: 12 },
    loadingLabel: '', loadingShort: '',
    paths: { userData: 'C:\\Users\\alan\\AppData\\Roaming\\OxoFlow', logs: '' },
  };
  if (params.get('engine') === 'downloading') {
    state.sidecar = { ready: false, loading: true, phase: 'downloading', download: { done: 1.3e9, total: 3.1e9 }, port: 48123 };
    state.loadingLabel = 'Téléchargement du modèle · 41 % (1,3 / 3,1 Go)'; state.loadingShort = 'Téléchargement · 41 %';
  }
  // ?platform=darwin: Mac layout and wording. ?setup=1: first start (engine downloading, permissions missing).
  state.platform = params.get('platform') || 'win32';
  state.accessibility = true; state.microphone = 'granted';
  if (state.platform === 'darwin') { state.settings.shortcut = 'Fn'; state.settings.mode = 'ptt'; state.fnUsage = params.get('setup') ? -1 : 0; }
  if (params.get('setup')) {
    state.accessibility = false; state.microphone = 'not-determined';
    state.sidecar = { ready: false, loading: true, phase: 'downloading', download: { done: 0.66e9, total: 1.61e9 }, port: 48123 };
    state.loadingLabel = 'Téléchargement du modèle · 41 % (0,7 / 1,6 Go)'; state.loadingShort = 'Téléchargement · 41 %';
  }
  if (params.get('empty')) { state.history = []; state.stats = { ...state.stats, wordsToday: 0, totalWords: 0, dictations: 0, avgWpm: 0, minutesSaved: 0, minutesSpoken: 0, streak: 0, daily: daily.map((d) => ({ ...d, words: 0 })) }; }

  let format = (t) => t;
  const push = () => emit('ff:state', JSON.parse(JSON.stringify(state)));
  const handlers = {
    'ff:get-state': () => JSON.parse(JSON.stringify(state)),
    'ff:set-settings': (p) => {
      Object.assign(state.settings, p);
      if (p.theme) document.documentElement.dataset.mockTheme = p.theme;
      push(); return state;
    },
    'ff:format-preview': (t) => format(t, { language: 'fr', dictionary: state.dictionary, snippets: state.snippets }),
    'ff:dictionary': ({ action, word, sounds, previous }) => {
      const parse = (x) => String(x || '').split(',').map((v) => v.trim()).filter(Boolean);
      if (action === 'add') state.dictionary.push({ word, sounds: parse(sounds) });
      if (action === 'update') { const e = state.dictionary.find((v) => v.word === previous); if (e) { e.word = word; e.sounds = parse(sounds); } }
      if (action === 'remove') state.dictionary = state.dictionary.filter((v) => v.word.toLowerCase() !== word.toLowerCase());
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
      const set = (phase, extra = {}) => { state.phase = phase; emit('ff:dictation', { phase, ...extra }); };
      if (state.phase === 'idle') {
        set('listening', { startedAt: Date.now() });
        // fake voice: a few syllables per second
        let t = 0; const iv = setInterval(() => { if (state.phase !== 'listening') return clearInterval(iv); t += 0.1; emit('ff:level', Math.max(0, Math.sin(t * 7) * 0.5 + Math.random() * 0.4)); }, 100);
      }
      else if (state.phase === 'listening') {
        set('transcribing');
        setTimeout(() => { emit('ff:insert', 'Ceci est un essai de dictée, transcrit en local.'); set('done', { latencyMs: 610, pasted: 'hub' }); }, 900);
        setTimeout(() => set('idle'), 1900);
      }
      return state.phase;
    },
    'ff:shortcut-test': () => ({ ok: true }),
    'ff:ai-status': () => ({ endpoint: 'http://127.0.0.1:8080/v1', models: ['hermes-3-llama-3.1-8b', 'qwen/qwen3.5-9b'], model: 'hermes-3-llama-3.1-8b' }),
    'ff:ai-test': () => ({ ok: true, model: 'hermes-3-llama-3.1-8b', ms: 640, text: 'La réunion, c’est demain à 11 h, et il faut que tu ramènes le dossier n8n.' }),
    'ff:mic-prompt': () => { state.microphone = 'granted'; push(); return true; },
    'ff:open-keyboard-settings': () => { state.fnUsage = 0; push(); },
    'ff:open-input-monitoring': () => {},
    'ff:accessibility-prompt': () => { state.accessibility = true; push(); return true; },
    'ff:shortcut-suspend': (on) => ({ suspended: on, ok: true }),
  };
  window.freeflow = {
    platform: state.platform,
    invoke: async (ch, ...a) => (handlers[ch] ? handlers[ch](...a) : null),
    send: () => {},
    on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); return () => {}; },
    _emit: emit,
  };

  // Real formatting code (CommonJS) for the dictionary test box.
  window.__mockReady = (async () => {
    try {
      const mods = {};
      const load = async (name) => {
        const src = await (await fetch(`/lib/${name}.js`)).text();
        const module = { exports: {} };
        new Function('module', 'exports', 'require', src)(module, module.exports, (p) => mods[p.replace('./', '')]);
        mods[name] = module.exports;
      };
      await load('vocab'); await load('format');
      format = mods.format.formatText;
    } catch (e) { console.warn('format preview unavailable', e); }
  })();
})();
