'use strict';
// Menu-bar panel: live state, quick toggles and actions. Opened by a click on
// the tray icon; actions that type into the user's app hide the panel first.
(() => {
  const $ = (s) => document.querySelector(s);
  const ff = window.freeflow;
  const MAC = ff.platform === 'darwin';
  document.documentElement.dataset.platform = ff.platform || '';
  let state = null, phase = 'idle', recentOpen = false;

  const NF = new Intl.NumberFormat('fr-FR');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = MAC ? { Fn: 'fn', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘', Space: 'Espace' } : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj', Super: 'Win', Space: 'Espace' };
  const pretty = (acc) => String(acc || '').split('+').filter(Boolean).map((k) => KEY[k] || k).join(MAC ? '' : '+');
  const LANG = { auto: 'Auto', fr: 'Français', en: 'Anglais' };

  if (!MAC) {
    $('#k-paste').textContent = 'Ctrl+Alt+Maj+V';
    $('#k-open').textContent = 'Ctrl+O';
    $('#k-settings').textContent = 'Ctrl+,';
    $('#k-quit').textContent = 'Ctrl+Q';
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1300);
  }

  function render() {
    if (!state) return;
    const s = state.settings, st = state.stats, eng = state.sidecar || {};
    const key = pretty(s.shortcut);
    const ptt = s.mode === 'ptt';
    // header
    const listening = phase === 'listening', busy = phase === 'transcribing' || phase === 'formatting';
    const st8 = listening ? ['listening', 'Écoute'] : busy ? ['', 'Transcription'] : eng.ready ? ['ready', 'Prêt'] : eng.loading ? ['', 'Chargement'] : ['error', 'Erreur'];
    $('#state').className = `state ${st8[0]}`;
    $('#state-text').textContent = st8[1];
    $('#sub').textContent = listening ? 'Je t’écoute…' : busy ? 'Transcription en cours…'
      : eng.ready ? `${ptt ? 'Maintiens' : 'Appuie sur'} ${key} pour dicter`
      : eng.loading ? (eng.phase === 'downloading' ? (state.loadingShort || 'Téléchargement du modèle') : 'Chargement du modèle…') : 'Moteur indisponible';
    // tiles
    $('#t-today').textContent = NF.format(st.wordsToday || 0);
    $('#t-wpm').textContent = NF.format(st.avgWpm || 0);
    $('#t-streak').textContent = NF.format(st.streak || 0);
    $('#t-lat').textContent = st.avgLatencyMs ? `${(st.avgLatencyMs / 1000).toFixed(1).replace('.', ',')} s` : '—';
    $('#t-engine').textContent = eng.ready ? (eng.device === 'cuda' ? 'GPU' : eng.device === 'mlx' ? 'Metal' : 'CPU') : '—';
    // toggles
    document.querySelectorAll('[data-set]').forEach((i) => {
      const k = i.dataset.set;
      i.checked = k === 'ptt' ? ptt : k === 'flowBar' || k === 'sounds' ? s[k] !== false : !!s[k];
    });
    $('#k-shortcut').textContent = key;
    $('#ai-note').textContent = s.aiFormat ? 'local' : '';
    $('#lang-val').textContent = LANG[s.language] || 'Auto';
    // recent
    const recent = state.history.slice(0, 5);
    $('#recent-count').textContent = state.stats.dictations ? NF.format(state.stats.dictations) : '';
    $('#recent').hidden = !recentOpen;
    $('#recent-chev').classList.toggle('open', recentOpen);
    $('#recent').innerHTML = recent.length
      ? recent.map((h, i) => `<button type="button" data-copy="${i}" title="Copier"><small>${esc(new Date(h.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))}</small>${esc(h.text)}</button>`).join('')
      : '<div class="none">Aucune dictée pour l’instant.</div>';
    // call to action + last dictation
    const cta = $('.cta');
    cta.classList.toggle('listening', listening);
    $('#cta-text').textContent = listening ? 'Arrêter et coller' : 'Dicter maintenant';
    $('#cta-key').textContent = ptt ? `${key} maintenu` : key;
    const last = state.history[0];
    $('#last').hidden = !last;
    if (last) $('#last-text').textContent = `« ${last.text} »`;
    reportSize();
  }

  // the window takes the height of the panel
  let lastH = 0;
  function reportSize() {
    requestAnimationFrame(() => {
      const h = Math.ceil($('#panel').getBoundingClientRect().height);
      if (h && h !== lastH) { lastH = h; ff.send('ff:menu-size', h); }
    });
  }

  // toggles
  document.querySelectorAll('[data-set]').forEach((i) => i.addEventListener('change', () => {
    const k = i.dataset.set;
    ff.invoke('ff:set-settings', k === 'ptt' ? { mode: i.checked ? 'ptt' : 'toggle' } : { [k]: i.checked }).then((r) => {
      if (r && r.aiError) { i.checked = false; toast('Aucun serveur IA local'); }
    });
  }));
  $('#lang').addEventListener('click', () => {
    const order = ['auto', 'fr', 'en'];
    const next = order[(order.indexOf(state.settings.language) + 1) % order.length];
    ff.invoke('ff:set-settings', { language: next });
  });
  $('#recent-toggle').addEventListener('click', () => { recentOpen = !recentOpen; render(); });
  $('#recent').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    await ff.invoke('ff:copy', state.history[Number(b.dataset.copy)].text);
    toast('Copié');
  });
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'copy-last') { await ff.invoke('ff:menu-action', 'copy-last'); toast('Copié'); return; }
    ff.invoke('ff:menu-action', a.dataset.act);
  });
  window.addEventListener('keydown', (e) => {
    const mod = MAC ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') ff.invoke('ff:menu-action', 'close');
    else if (mod && e.key === 'q') ff.invoke('ff:menu-action', 'quit');
    else if (mod && e.key === ',') ff.invoke('ff:menu-action', 'settings');
    else if (mod && e.key === 'o') ff.invoke('ff:menu-action', 'open');
  });

  ff.on('ff:state', (s) => { state = s; phase = s.phase || phase; render(); });
  ff.on('ff:dictation', (p) => { phase = p.phase; render(); });
  ff.on('ff:menu-shown', () => { recentOpen = false; ff.invoke('ff:get-state').then((s) => { state = s; phase = s.phase; render(); }); });
  ff.invoke('ff:get-state').then((s) => { state = s; phase = s.phase; render(); });
})();
