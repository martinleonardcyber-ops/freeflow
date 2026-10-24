'use strict';
// Hub renderer: dashboard, history, dictionary, snippets, settings.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const ff = window.freeflow;
  const MAC = ff.platform === 'darwin';
  document.documentElement.dataset.platform = ff.platform || '';
  let state = null;
  let phase = 'idle';
  let hubDictation = false;      // the current dictation targets the "try here" box
  let previewTimer = null;
  const drawn = {};              // last rendered signature per list, so state pushes (download progress...) do not rebuild them
  const openRaw = new Set();     // history entries showing their raw transcript
  let micTest = null;            // settings > Micro > Tester (declared early: navigate() stops it)

  // ---- navigation
  function navigate(section) {
    if (!document.getElementById(`section-${section}`)) section = 'home';
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === section));
    $$('.section').forEach((s) => s.classList.toggle('active', s.id === `section-${section}`));
    $('#content').scrollTop = 0;
    if (section === 'settings') refreshAi();
    else stopMicTest();
    try { localStorage.setItem('ff.section', section); } catch { /* ignore */ }
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.section)));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) navigate(g.dataset.goto); });
  ff.on('ff:navigate', navigate);
  try { navigate(localStorage.getItem('ff.section') || 'home'); } catch { navigate('home'); }

  // ---- helpers
  function toast(msg, kind) {
    const t = $('#toast');
    $('#toast-text').textContent = msg;
    t.classList.toggle('error', kind === 'error');
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2000);
  }
  const NF = new Intl.NumberFormat('fr-FR');
  function fmtNum(n) { return NF.format(n || 0); }
  function plural(n, one, many) { return `${fmtNum(n)} ${n > 1 ? many : one}`; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function icon(id) { return `<svg><use href="#${id}"/></svg>`; }
  function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; }
  function timeOf(iso) { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function dayTitle(iso) {
    const d = new Date(iso), today = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
    if (dayKey(d) === dayKey(today)) return 'Aujourd’hui';
    if (dayKey(d) === dayKey(y)) return 'Hier';
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
  }
  function relShort(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'à l’instant';
    if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
    if (dayKey(iso) === dayKey(new Date())) return timeOf(iso);
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  function fmtMinutes(min) {
    if (min < 60) return `${fmtNum(min)} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
  }
  function highlight(text, q) {
    if (!q) return esc(text);
    // Accent-insensitive match on the folded text, highlighted on the original.
    const f = fold(text), fq = fold(q);
    let out = '', i = 0, j;
    while (fq && (j = f.indexOf(fq, i)) !== -1) { out += esc(text.slice(i, j)) + `<mark>${esc(text.slice(j, j + fq.length))}</mark>`; i = j + fq.length; }
    return out + esc(text.slice(i));
  }
  const APP_NAMES = { 'google chrome': 'Chrome', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', code: 'VS Code', slack: 'Slack', notion: 'Notion', discord: 'Discord', outlook: 'Outlook', winword: 'Word', teams: 'Teams', 'ms-teams': 'Teams', windowsterminal: 'Terminal', explorer: 'Explorateur', notepad: 'Bloc-notes', obsidian: 'Obsidian', telegram: 'Telegram', whatsapp: 'WhatsApp', cursor: 'Cursor' };
  function appName(p) { const k = String(p || '').toLowerCase(); return APP_NAMES[k] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : ''); }

  // ---- hero waveform (decorative; speeds up while listening)
  const wave = $('#hero-wave');
  for (let i = 0; i < 30; i++) {
    const s = document.createElement('span');
    const center = 1 - Math.abs(i - 14.5) / 15;
    s.style.setProperty('--amp', (1.4 + center * 4.2 + Math.random() * 1.6).toFixed(2));
    s.style.animationDelay = `${(-Math.random() * 2.8).toFixed(2)}s`;
    wave.appendChild(s);
  }

  // ---- render
  function gpuName(eng) { return eng.device === 'cuda' ? 'GPU' : eng.device === 'mlx' ? 'GPU Metal' : 'CPU'; }
  function engineLabel(eng) {
    if (phase === 'listening') return { title: 'Écoute…', sub: '', cls: 'listening' };
    if (eng.ready) return { title: `Prêt · ${gpuName(eng)}`, sub: `Whisper ${eng.model}`, cls: 'ready' };
    if (eng.loading) return { title: eng.phase === 'downloading' ? 'Téléchargement du modèle' : 'Chargement du modèle…', sub: eng.phase === 'downloading' ? (state.loadingShort || '').replace(/^Téléchargement · /, '') : 'quelques secondes', cls: '' };
    return { title: 'Moteur indisponible', sub: 'voir Paramètres', cls: 'error' };
  }

  function renderKeysInto(node, acc, cls) {
    node.innerHTML = String(acc || '').split('+').filter(Boolean).map((k) => `<kbd>${esc(KEY_LABEL[k] || k)}</kbd>`).join(MAC ? '' : '<span class="plus">+</span>');
    if (cls) node.className = cls;
  }

  function render() {
    if (!state) return;
    const s = state.settings, st = state.stats, eng = state.sidecar || {};

    // Sidebar
    const e = engineLabel(eng);
    $('#engine-pill').className = 'engine ' + e.cls;
    $('#engine-text').textContent = e.title;
    $('#engine-sub').textContent = e.sub;
    const dl = eng.phase === 'downloading' && eng.download && eng.download.total ? eng.download : null;
    $('#engine-bar').hidden = !dl;
    if (dl) $('#engine-bar-fill').style.width = `${Math.min(100, (100 * (dl.done || 0)) / dl.total).toFixed(1)}%`;
    renderKeysInto($('#side-keys'), s.shortcut);
    $('#nav-history-count').textContent = st.dictations ? fmtNum(st.dictations) : '';
    $('#nav-dict-count').textContent = state.dictionary.length || '';
    $('#nav-snip-count').textContent = state.snippets.length || '';

    const needAx = MAC && state.accessibility === false;
    $('#ax-banner-settings').hidden = !needAx;
    renderSetup(eng);

    renderHome(s, st, eng);
    renderHistory();
    renderDictionary();
    renderSnippets();
    renderSettings(s, st, eng);
    renderTry();
  }

  // First-run checklist: only what is really missing, read from the system each time.
  function renderSetup(eng) {
    const steps = [];
    const model = $('#step-model');
    const dl = eng.phase === 'downloading' && eng.download ? eng.download : null;
    model.className = 'step ' + (eng.ready ? 'done' : eng.loading ? 'busy' : 'bad');
    $('#step-model-sub').textContent = eng.ready ? `Whisper ${eng.model} · ${gpuName(eng)}` : dl ? (state.loadingLabel || 'Téléchargement…').replace(/^Téléchargement du modèle · /, 'Téléchargement · ') : eng.loading ? 'Chargement en mémoire…' : (eng.error || 'Moteur indisponible');
    $('#step-model-bar').hidden = !(dl && dl.total);
    if (dl && dl.total) $('#step-model-fill').style.width = `${Math.min(100, (100 * (dl.done || 0)) / dl.total).toFixed(1)}%`;
    steps.push(!!eng.ready);
    const mic = state.microphone || 'granted';
    $('#step-mic').hidden = !MAC;
    $('#step-ax').hidden = !MAC;
    if (!MAC) $('#step-fn').hidden = true;
    if (MAC) {
      $('#step-mic').className = 'step ' + (mic === 'granted' ? 'done' : mic === 'denied' || mic === 'restricted' ? 'bad' : '');
      $('#step-mic-sub').textContent = mic === 'granted' ? 'Autorisé.' : mic === 'denied' ? 'Refusé : réactive-le dans Réglages Système.' : 'Pour t’entendre.';
      $('#step-mic-btn').textContent = mic === 'denied' ? 'Ouvrir les réglages' : 'Autoriser';
      steps.push(mic === 'granted');
      $('#step-ax').className = 'step ' + (state.accessibility ? 'done' : '');
      steps.push(!!state.accessibility);
      const fn = state.settings.shortcut === 'Fn';
      $('#step-fn').hidden = !fn;
      if (fn) { $('#step-fn').className = 'step ' + (state.fnUsage === 0 ? 'done' : ''); steps.push(state.fnUsage === 0); }
    }
    const done = steps.filter(Boolean).length;
    $('#setup').hidden = done === steps.length;
    $('#setup-count').textContent = `${done}/${steps.length}`;
    $('#setup-ring .arc').style.strokeDasharray = `${(100 * done) / steps.length} 100`;
    $('#setup-sub').textContent = done === steps.length - 1 ? `Plus qu’une étape : ${done} sur ${steps.length} déjà prêtes.` : `Encore ${steps.length - done} étapes, une seule fois.`;
  }

  function renderHome(s, st, eng) {
    const hour = new Date().getHours();
    const name = state.user ? state.user.charAt(0).toUpperCase() + state.user.slice(1) : '';
    $('#greeting').textContent = `${hour < 18 && hour >= 5 ? 'Bonjour' : 'Bonsoir'}${name ? ', ' + name : ''}`;
    const busy = phase === 'transcribing' || phase === 'formatting';
    const heroState = phase === 'listening' ? 'listening' : busy ? 'busy' : eng.ready ? 'ready' : eng.loading ? 'loading' : 'error';
    $('#hero').dataset.state = heroState;
    $('#hero-status').textContent = {
      listening: 'J’écoute…', busy: 'Transcription en cours…', ready: `Prêt · ${gpuName(eng)} · ${eng.model || ''}`,
      loading: eng.phase === 'downloading' ? (state.loadingLabel || 'Téléchargement du modèle') : 'Chargement du modèle…', error: 'Moteur indisponible',
    }[heroState];
    renderKeysInto($('#howto-shortcut'), s.shortcut);
    const ptt = s.mode === 'ptt';
    $('#howto-mode').textContent = ptt ? 'maintiens et parle, relâche pour coller' : 'pour démarrer, puis à nouveau pour coller';
    const gesture = s.shortcut === 'Fn' ? (ptt ? 'Maintiens fn et parle' : 'Appuie sur fn et parle') : (ptt ? 'Maintiens ton raccourci et parle' : 'Appuie sur ton raccourci et parle');
    $('#howto-line').textContent = s.autoPaste
      ? `${gesture}, dans un mail, Slack, Notion ou ton code. Le texte s’écrit là où est ton curseur.`
      : `${gesture} : le texte est copié, colle-le avec ${MAC ? '⌘V' : 'Ctrl + V'}.`;

    $('#stat-today').textContent = fmtNum(st.wordsToday);
    $('#stat-total-foot').textContent = `${fmtNum(st.totalWords)} mots au total`;
    $('#stat-wpm').textContent = fmtNum(st.avgWpm);
    $('#stat-saved').textContent = fmtMinutes(st.minutesSaved || 0);
    $('#chip-saved').title = `Estimation : temps de frappe à ${st.typingWpm || 40} mots/min moins le temps passé à parler`;
    $('#stat-streak').textContent = fmtNum(st.streak || 0);
    $('#stat-streak-unit').textContent = (st.streak || 0) > 1 ? 'jours' : 'jour';
    $('#stat-count-foot').textContent = plural(st.dictations, 'dictée', 'dictées');
    $('#home-sub').textContent = st.wordsToday
      ? `${plural(st.wordsToday, 'mot dicté', 'mots dictés')} aujourd’hui. Rien ne quitte ta machine.`
      : 'Ta voix, écrite partout. Rien ne quitte ta machine.';

    // Activity: real words per day from the history.
    const daily = st.daily || [];
    const sig = JSON.stringify(daily);
    if (drawn.chart !== sig) {
      drawn.chart = sig;
      const max = Math.max(1, ...daily.map((d) => d.words));
      const total = daily.reduce((a, d) => a + d.words, 0);
      $('#activity-total').innerHTML = `${fmtNum(total)}<small>mots en 14 jours</small>`;
      const chart = $('#chart'); chart.innerHTML = '';
      daily.forEach((d, i) => {
        const [y, m, dd] = d.day.split('-').map(Number);
        const date = new Date(y, m - 1, dd);
        const isToday = i === daily.length - 1;
        const h = d.words ? Math.max(8, Math.round((d.words / max) * 100)) : 3;
        const label = date.toLocaleDateString('fr-FR', { weekday: 'narrow' }).toUpperCase();
        const tip = `${date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${plural(d.words, 'mot', 'mots')}`;
        chart.appendChild(el(`<div class="col${isToday ? ' today-col' : ''}"><div class="bar${d.words ? ' has' : ''}${isToday && d.words ? ' today' : ''}" style="height:${h}%;animation-delay:${i * 25}ms"></div><span class="lbl">${esc(label)}</span><span class="tip">${esc(tip)}</span></div>`));
      });
      if (!total) chart.appendChild(el('<div class="chart-empty">Tes mots dictés apparaîtront ici, jour après jour.</div>'));
    }

    // Feed: the latest dictations, Wispr-style (one card per day, time on the left).
    const recent = state.history.slice(0, 12);
    const rsig = JSON.stringify([recent.map((h) => h.id), [...openRaw], dayKey(new Date())]);
    if (drawn.recent !== rsig) {
      drawn.recent = rsig;
      const list = $('#recent-list');
      if (!recent.length) {
        list.innerHTML = '';
        list.appendChild(el(`<div class="empty"><div class="empty-art">${icon('i-mic')}</div><strong>Aucune dictée pour l’instant</strong><span>Utilise ton raccourci dans n’importe quelle app, ou le micro « Essayer ici ».</span></div>`));
      } else buildFeed(list, recent, '', () => { drawn.recent = null; renderHome(state.settings, state.stats, state.sidecar || {}); });
    }
  }

  // One card per day; each row: time | text + meta | actions (on hover).
  function buildFeed(list, items, q, rerender) {
    list.innerHTML = '';
    let group = null, groupKey = null, n = 0;
    for (const h of items) {
      const k = dayKey(h.ts);
      if (k !== groupKey) {
        groupKey = k;
        const dayWords = items.filter((x) => dayKey(x.ts) === k).reduce((a, x) => a + (x.words || 0), 0);
        group = el(`<div class="day-group"><div class="day-title">${esc(dayTitle(h.ts))}<span>${plural(dayWords, 'mot', 'mots')}</span></div><div class="day-card"></div></div>`);
        list.appendChild(group);
        group = group.querySelector('.day-card');
      }
      const rawDiffers = h.raw && h.raw.trim() !== h.text.trim();
      const pasted = h.pasted === 'blocked' ? '<span class="pill warn">collage bloqué</span>' : h.pasted === 'clipboard' ? '<span class="pill">copié</span>' : '';
      const node = el(`<div class="entry" style="animation-delay:${Math.min(n++, 12) * 18}ms">
        <div class="time">${esc(timeOf(h.ts))}</div>
        <div class="body">
          <div class="text">${highlight(h.text, q)}</div>
          <div class="meta">
            ${h.app ? `<span class="pill app">${esc(appName(h.app))}</span>` : ''}
            <span class="pill">${plural(h.words, 'mot', 'mots')}</span>
            ${h.latencyMs ? `<span class="pill">${(h.latencyMs / 1000).toFixed(1).replace('.', ',')} s</span>` : ''}
            ${h.language ? `<span class="pill">${esc(String(h.language).toUpperCase())}</span>` : ''}
            ${pasted}
            ${h.ai ? `<span class="pill ai" title="Mis en forme par ${esc(h.ai.model)} en ${(h.ai.ms / 1000).toFixed(1).replace('.', ',')} s">IA</span>` : ''}
            ${rawDiffers ? `<button class="raw-toggle" type="button">${openRaw.has(h.id) ? 'Masquer le brut' : 'Voir le brut'}</button>` : ''}
          </div>
          ${rawDiffers && openRaw.has(h.id) ? `<div class="raw"><b>Transcription brute :</b> ${highlight(h.raw, q)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="copy" title="Copier">${icon('i-copy')}</button>
          <button class="icon-btn danger" data-act="del" title="Supprimer">${icon('i-trash')}</button>
        </div></div>`);
      node.querySelector('[data-act=copy]').addEventListener('click', async () => { await ff.invoke('ff:copy', h.text); toast('Copié dans le presse-papiers'); });
      node.querySelector('[data-act=del]').addEventListener('click', () => ff.invoke('ff:history', { action: 'delete', id: h.id }));
      const rt = node.querySelector('.raw-toggle');
      if (rt) rt.addEventListener('click', () => { openRaw.has(h.id) ? openRaw.delete(h.id) : openRaw.add(h.id); rerender(); });
      group.appendChild(node);
    }
  }

  function renderHistory() {
    const q = $('#history-search').value.trim();
    const items = q ? state.history.filter((h) => fold(h.text).includes(fold(q)) || fold(h.raw).includes(fold(q))) : state.history;
    const sig = JSON.stringify([q, items.map((h) => h.id), [...openRaw], dayKey(new Date())]);
    $('#history-sub').textContent = state.history.length
      ? (q ? `${plural(items.length, 'résultat', 'résultats')} sur ${plural(state.history.length, 'dictée', 'dictées')}` : `${plural(state.stats.dictations, 'dictée', 'dictées')}, les plus récentes en premier.`)
      : 'Tes dictées, les plus récentes en premier.';
    $('#history-clear').disabled = !state.history.length;
    if (drawn.history === sig) return;
    drawn.history = sig;
    const list = $('#history-list');
    if (!items.length) {
      list.innerHTML = '';
      list.appendChild(el(q
        ? `<div class="empty"><div class="empty-art">${icon('i-search')}</div><strong>Rien trouvé</strong><span>Aucune dictée ne contient « ${esc(q)} ».</span></div>`
        : `<div class="empty"><div class="empty-art">${icon('i-mic')}</div><strong>Aucune dictée pour le moment</strong><span>Appuie sur ton raccourci, parle : tout ce que tu dictes arrive ici.</span></div>`));
      return;
    }
    buildFeed(list, items, q, () => { drawn.history = null; renderHistory(); });
  }

  function renderDictionary() {
    const q = $('#dict-search').value.trim();
    const all = state.dictionary;
    const items = q ? all.filter((v) => fold(v.word).includes(fold(q)) || (v.sounds || []).some((x) => fold(x).includes(fold(q)))) : all;
    $('#dict-count').textContent = q ? `${items.length} sur ${plural(all.length, 'mot', 'mots')}` : plural(all.length, 'mot', 'mots');
    const sig = JSON.stringify([q, items]);
    if (drawn.dict !== sig) {
      drawn.dict = sig;
      const list = $('#dict-list'); list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el(q
          ? `<div class="empty"><div class="empty-art">${icon('i-search')}</div><strong>Aucun mot ne correspond</strong></div>`
          : `<div class="empty"><div class="empty-art">${icon('i-book')}</div><strong>Ton dictionnaire est vide</strong><span>Ajoute les noms que le modèle écorche : marques, outils, prénoms.</span></div>`));
      }
      items.forEach((v, i) => {
        const sounds = (v.sounds || []).length
          ? v.sounds.map((x) => `<span class="sound">${esc(x)}</span>`).join('')
          : '<span class="sound none">casse uniquement</span>';
        const node = el(`<div class="vocab" style="animation-delay:${Math.min(i, 16) * 15}ms"><div class="word">${esc(v.word)}</div><div class="sounds">${sounds}</div>
          <div class="actions"><button class="icon-btn" data-act="edit" title="Modifier">${icon('i-edit')}</button><button class="icon-btn danger" data-act="del" title="Supprimer">${icon('i-trash')}</button></div></div>`);
        node.querySelector('[data-act=edit]').addEventListener('click', () => editVocab(v));
        node.querySelector('[data-act=del]').addEventListener('click', async () => { await ff.invoke('ff:dictionary', { action: 'remove', word: v.word }); toast(`« ${v.word} » supprimé`); });
        list.appendChild(node);
      });
    }
    refreshPreview();
  }

  function renderSnippets() {
    const sig = JSON.stringify(state.snippets);
    if (drawn.snip === sig) return;
    drawn.snip = sig;
    const list = $('#snippet-list'); list.innerHTML = '';
    if (!state.snippets.length) list.appendChild(el(`<div class="empty"><div class="empty-art">${icon('i-bolt')}</div><strong>Aucun snippet</strong><span>Exemple : dis « ma signature », OxoFlow écrit « Bonne journée et à très vite ! ».</span></div>`));
    state.snippets.forEach((sn, i) => {
      const node = el(`<div class="snippet" style="animation-delay:${Math.min(i, 12) * 18}ms"><span class="trigger">${esc(sn.trigger)}</span><span class="to">${icon('i-arrow')}</span><span class="text">${esc(sn.expansion)}</span>
        <div class="actions"><button class="icon-btn" data-act="edit" title="Modifier">${icon('i-edit')}</button><button class="icon-btn danger" data-act="del" title="Supprimer">${icon('i-trash')}</button></div></div>`);
      node.querySelector('[data-act=edit]').addEventListener('click', () => editSnippet(sn));
      node.querySelector('[data-act=del]').addEventListener('click', () => ff.invoke('ff:snippets', { action: 'remove', id: sn.id }));
      list.appendChild(node);
    });
  }

  function renderSettings(s, st, eng) {
    updateShortcutUi();
    $$('input[name=mode]').forEach((r) => { r.checked = r.value === s.mode; });
    const pttInput = document.querySelector('input[name=mode][value=ptt]');
    const pttOk = state.pttAvailable || s.shortcut === 'Fn';   // fn has its own listener
    pttInput.disabled = !pttOk;
    $('#mode-ptt-label').classList.toggle('disabled', !pttOk);
    $('#shortcut-fn').hidden = !MAC || s.shortcut === 'Fn' || sc.recording;
    $('#ptt-hint').textContent = pttOk ? 'Garde la touche enfoncée ; un appui bref passe en mains libres.'
      : MAC && state.accessibility === false ? 'Autorise OxoFlow dans Accessibilité, puis relance-le, pour l’activer.' : 'Indisponible : le module uiohook-napi n’a pas pu être chargé.';
    for (const seg of $$('.segmented')) {
      const v = s[seg.dataset.setting] || (seg.dataset.setting === 'theme' ? 'system' : 'auto');
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === v));
    }
    $('#set-autopaste').checked = !!s.autoPaste;
    $('#set-login').checked = !!s.launchAtLogin;
    $('#set-sounds').checked = s.sounds !== false;
    $('#set-flowbar').checked = s.flowBar !== false;
    $('#set-ai').checked = !!s.aiFormat;

    const badge = $('#eng-badge');
    badge.className = 'engine-badge' + (eng.ready ? ' ready' : !eng.loading ? ' error' : '');
    $('#eng-state').textContent = eng.ready ? `Prêt, chargé en ${((eng.load_ms || 0) / 1000).toFixed(1).replace('.', ',')} s` : eng.loading ? (eng.phase === 'downloading' ? state.loadingLabel : 'Chargement du modèle…') : 'Moteur indisponible';
    $('#eng-error').textContent = eng.error && !eng.ready ? eng.error : eng.ready ? `${fmtNum(eng.transcriptions || 0)} transcription${(eng.transcriptions || 0) > 1 ? 's' : ''} depuis le démarrage` : '';
    $('#eng-device').textContent = eng.device ? ({ cuda: 'Carte graphique (CUDA)', mlx: 'Puce Apple (Metal)' }[eng.device] || 'Processeur') : '—';
    $('#eng-model').textContent = eng.model ? `Whisper ${eng.model}` : '—';
    $('#eng-compute').textContent = eng.compute_type || '—';
    $('#eng-port').textContent = eng.port ? `127.0.0.1:${eng.port}${eng.external ? ' (externe)' : ''}` : '—';
    $('#eng-latency').textContent = st.avgLatencyMs ? `${(st.avgLatencyMs / 1000).toFixed(1).replace('.', ',')} s` : '—';
    $('#eng-cache').textContent = s.modelCache || '—';
    $('#eng-cache').title = s.modelCache || '';
    $('#version').textContent = `OxoFlow ${state.version} · données : ${state.paths.userData}`;
    const micSel = $('#set-mic');
    if (micSel.querySelector(`option[value="${CSS.escape(s.microphoneId)}"]`)) micSel.value = s.microphoneId;
  }

  function renderTry() {
    const btn = $('#mic-btn'), status = $('#try-status');
    const mine = hubDictation;
    btn.classList.toggle('listening', phase === 'listening' && mine);
    btn.classList.toggle('busy', (phase === 'transcribing' || phase === 'formatting') && mine);
    const map = { idle: 'Prêt', listening: 'Écoute… clique pour arrêter', transcribing: 'Transcription…', formatting: 'Mise en forme…', done: 'Inséré', error: 'Erreur' };
    status.textContent = mine || phase === 'idle' ? map[phase] || 'Prêt' : `Dictée en cours ailleurs (${(map[phase] || phase).toLowerCase()})`;
    status.classList.toggle('live', phase === 'listening' && mine);
    btn.title = phase === 'listening' && mine ? 'Arrêter' : 'Dicter dans cette zone';
  }

  // ---- microphone test: live level of the selected device for 10 s
  async function stopMicTest() {
    if (!micTest) return;
    const t = micTest; micTest = null;
    cancelAnimationFrame(t.raf); clearTimeout(t.timer);
    t.stream.getTracks().forEach((x) => x.stop());
    try { await t.ctx.close(); } catch { /* ignore */ }
    $('#mic-meter').hidden = true; $('#mic-test').textContent = 'Tester';
  }
  $('#mic-test').addEventListener('click', async () => {
    if (micTest) return stopMicTest();
    const id = $('#set-mic').value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: id && id !== 'default' ? { deviceId: { exact: id } } : true });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      micTest = { stream, ctx, raf: 0, timer: setTimeout(stopMicTest, 10000) };
      $('#mic-meter').hidden = false; $('#mic-test').textContent = 'Arrêter';
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        $('#mic-meter-fill').style.width = `${Math.min(100, Math.pow(Math.sqrt(sum / buf.length) * 6, 0.7) * 100).toFixed(0)}%`;
        if (micTest) micTest.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Accès au micro refusé' : 'Micro indisponible', 'error'); }
  });
  $('#set-mic').addEventListener('change', () => { if (micTest) stopMicTest().then(() => $('#mic-test').click()); });

  // ---- per-OS wording
  $('#paste-last-kbd').textContent = MAC ? '⌃⌘V' : 'Ctrl+Alt+Maj+V';
  if (MAC) {
    $('#autopaste-sub').textContent = 'Sinon le texte est seulement copié : colle-le avec ⌘V.';
    $('#login-sub').textContent = 'OxoFlow attend dans la barre des menus.';
    $('#theme-sub').textContent = 'Suit le thème de macOS par défaut.';
  }
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-ax-prompt]')) return;
    const ok = await ff.invoke('ff:accessibility-prompt');
    if (ok) toast('Accessibilité autorisée');
  });

  // ---- microphones
  async function loadMics() {
    try {
      // Ask once so device labels are populated, then release the stream.
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch { /* labels may stay empty */ }
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const sel = $('#set-mic');
      const current = state ? state.settings.microphoneId : 'default';
      sel.innerHTML = '<option value="default">Micro par défaut</option>';
      for (const d of devs) {
        if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Micro ${sel.options.length}`;
        sel.appendChild(o);
      }
      if (sel.querySelector(`option[value="${CSS.escape(current)}"]`)) sel.value = current;
    } catch { /* ignore */ }
  }

  // ---- events: home
  $('#mic-btn').addEventListener('click', async () => {
    if (phase === 'idle') { hubDictation = true; $('#try-area').focus(); }
    await ff.invoke('ff:dictation-toggle', { toHub: true });
  });
  $('#try-clear').addEventListener('click', () => { $('#try-area').value = ''; $('#try-area').focus(); });

  // ---- events: history
  $('#history-search').addEventListener('input', () => state && renderHistory());
  $('#history-clear').addEventListener('click', () => { if (state && state.history.length && confirm('Effacer tout l’historique ? Cette action est définitive.')) ff.invoke('ff:history', { action: 'clear' }); });

  // ---- dictionary form (add / edit) + live test
  function resetVocabForm() {
    const f = $('#dict-form');
    delete f.dataset.editing;
    f.classList.remove('editing');
    $('#dict-form-title').textContent = 'Nouveau mot';
    $('#dict-word').value = ''; $('#dict-sounds').value = '';
    $('#dict-submit span').textContent = 'Ajouter';
    $('#dict-edit-cancel').hidden = true;
  }
  function editVocab(v) {
    const f = $('#dict-form');
    f.dataset.editing = v.word;
    f.classList.add('editing');
    $('#dict-form-title').textContent = `Modifier « ${v.word} »`;
    $('#dict-word').value = v.word;
    $('#dict-sounds').value = (v.sounds || []).join(', ');
    $('#dict-submit span').textContent = 'Enregistrer';
    $('#dict-edit-cancel').hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#dict-sounds').focus();
  }
  $('#dict-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = $('#dict-word').value.trim();
    if (!word) { $('#dict-word').focus(); return; }
    const editing = $('#dict-form').dataset.editing;
    await ff.invoke('ff:dictionary', { action: editing ? 'update' : 'add', word, sounds: $('#dict-sounds').value, previous: editing });
    toast(editing ? 'Mot mis à jour' : `« ${word} » ajouté`);
    resetVocabForm();
    $('#dict-word').focus();
  });
  $('#dict-edit-cancel').addEventListener('click', resetVocabForm);
  $('#dict-restore').addEventListener('click', async () => { await ff.invoke('ff:dictionary', { action: 'restore-defaults' }); toast('Mots par défaut ajoutés'); });
  $('#dict-search').addEventListener('input', () => state && renderDictionary());
  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const text = $('#dict-test').value;
      const out = $('#dict-test-out');
      if (!text.trim()) { out.textContent = 'Le résultat corrigé s’affiche ici.'; out.classList.add('muted'); return; }
      out.classList.remove('muted');
      out.textContent = await ff.invoke('ff:format-preview', text);
    }, 120);
  }
  $('#dict-test').addEventListener('input', refreshPreview);

  // ---- snippets form (add / edit)
  function resetSnippetForm() {
    const f = $('#snippet-form');
    delete f.dataset.editing;
    f.classList.remove('editing');
    $('#snippet-form-title').textContent = 'Nouveau snippet';
    $('#snippet-trigger').value = ''; $('#snippet-expansion').value = '';
    $('#snippet-submit span').textContent = 'Ajouter le snippet';
    $('#snippet-cancel').hidden = true;
  }
  function editSnippet(sn) {
    const f = $('#snippet-form');
    f.dataset.editing = sn.id;
    f.classList.add('editing');
    $('#snippet-form-title').textContent = 'Modifier le snippet';
    $('#snippet-trigger').value = sn.trigger; $('#snippet-expansion').value = sn.expansion;
    $('#snippet-submit span').textContent = 'Enregistrer';
    $('#snippet-cancel').hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#snippet-expansion').focus();
  }
  $('#snippet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const trig = $('#snippet-trigger'), exp = $('#snippet-expansion');
    if (!trig.value.trim()) { trig.focus(); return; }
    const id = $('#snippet-form').dataset.editing;
    await ff.invoke('ff:snippets', { action: id ? 'update' : 'add', id, trigger: trig.value, expansion: exp.value });
    toast(id ? 'Snippet mis à jour' : 'Snippet ajouté');
    resetSnippetForm();
  });
  $('#snippet-cancel').addEventListener('click', resetSnippetForm);

  // ---- settings
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => ff.invoke('ff:set-settings', { mode: r.value })));
  for (const seg of $$('.segmented')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      ff.invoke('ff:set-settings', { [seg.dataset.setting]: b.dataset.value });
    });
  }
  $('#set-mic').addEventListener('change', (e) => ff.invoke('ff:set-settings', { microphoneId: e.target.value }));
  $('#set-autopaste').addEventListener('change', (e) => ff.invoke('ff:set-settings', { autoPaste: e.target.checked }));
  $('#set-login').addEventListener('change', (e) => ff.invoke('ff:set-settings', { launchAtLogin: e.target.checked }));
  $('#set-sounds').addEventListener('change', (e) => ff.invoke('ff:set-settings', { sounds: e.target.checked }));
  $('#set-flowbar').addEventListener('change', (e) => ff.invoke('ff:set-settings', { flowBar: e.target.checked }));

  // ---- local AI formatting
  async function refreshAi() {
    const st = await ff.invoke('ff:ai-status');
    const sel = $('#set-aimodel');
    const wanted = state ? state.settings.aiModel : '';
    sel.innerHTML = '<option value="">Automatique</option>' + (st.models || []).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    sel.value = (st.models || []).includes(wanted) ? wanted : '';
    const host = (u) => u.replace(/^https?:\/\//, '').replace(/\/v1$/, '');
    $('#ai-status').textContent = st.pinned
      ? `Envoie uniquement à ${host(st.pinned)}${st.endpoint ? ` · ${st.model || 'aucun modèle'}${sel.value ? '' : ' (auto)'}` : ' (ne répond pas : LM Studio est-il lancé ?)'}`
      : st.endpoint ? `Serveur trouvé : ${host(st.endpoint)} · ${st.model || 'aucun modèle'}. Il sera retenu à l’activation.` : 'Aucun serveur local trouvé : lance LM Studio (ou Ollama) et charge un modèle.';
  }
  $('#set-ai').addEventListener('change', async (e) => {
    const r = await ff.invoke('ff:set-settings', { aiFormat: e.target.checked });
    if (r && r.aiError) { e.target.checked = false; toast(r.aiError, 'error'); }
    else if (e.target.checked) toast('Mise en forme IA activée');
    refreshAi();
  });
  $('#set-aimodel').addEventListener('change', async (e) => { await ff.invoke('ff:set-settings', { aiModel: e.target.value }); refreshAi(); });
  $('#ai-test-btn').addEventListener('click', async () => {
    const out = $('#ai-test-out'), btn = $('#ai-test-btn');
    btn.disabled = true; out.classList.add('muted'); out.textContent = 'Le modèle réfléchit… (le premier essai le charge en mémoire)';
    const r = await ff.invoke('ff:ai-test', $('#ai-test').value);
    btn.disabled = false; out.classList.toggle('muted', !r.ok);
    out.textContent = r.ok ? `${r.text}  ·  ${(r.ms / 1000).toFixed(1).replace('.', ',')} s` : `Indisponible : ${r.error}`;
  });
  $('#step-mic-btn').addEventListener('click', async () => { if (await ff.invoke('ff:mic-prompt')) toast('Micro autorisé'); });
  $('#step-fn-btn').addEventListener('click', () => ff.invoke('ff:open-keyboard-settings'));
  $('#shortcut-fn').addEventListener('click', async () => {
    await ff.invoke('ff:set-settings', { shortcut: 'Fn', mode: 'ptt' });
    toast('Raccourci : maintenir fn');
  });
  $('#open-logs').addEventListener('click', () => ff.invoke('ff:open-logs'));
  $('#open-data').addEventListener('click', () => ff.invoke('ff:open-path', state.paths.userData));

  // Shortcut recorder: "Enregistrer" starts listening (the active shortcut is
  // suspended so the keys reach this window), every new chord replaces the
  // previous one, "Arrêter" stops listening, "Confirmer" saves. Modifier-only
  // chords such as Ctrl+Win are allowed (handled by the low-level hook).
  const CODE_MAP = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`', CapsLock: 'Capslock' };
  function codeToKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
    return CODE_MAP[code] || null;
  }
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
  const MOD_CODES = { ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Super', MetaRight: 'Super', OSLeft: 'Super', OSRight: 'Super' };
  const MOD_FLAG = { Ctrl: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Super: 'metaKey' };
  const KEY_LABEL = MAC
    ? { Fn: 'fn', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘', Space: 'Espace', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Up: '↑', Down: '↓', Left: '←', Right: '→', Capslock: '⇪' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj', Super: 'Win', Space: 'Espace', Enter: 'Entrée', Backspace: 'Retour', Delete: 'Suppr', Insert: 'Inser', Up: '↑', Down: '↓', Left: '←', Right: '→', Capslock: 'Verr. Maj' };
  const MODS_TEXT = MAC ? '⌃, ⌥, ⇧ ou ⌘' : 'Ctrl, Alt, Maj ou Win';
  const MOD_EXAMPLE = MAC ? '⌃ + ⌘' : 'Ctrl + Win';
  const sc = { recording: false, held: new Set(), mods: new Set(), key: null, pending: null, error: null };

  function prettyAcc(acc) { return String(acc || '').split('+').filter(Boolean).map((k) => KEY_LABEL[k] || k).join(MAC ? '' : ' + '); }
  function accFrom(mods, key) { return [...MOD_ORDER.filter((m) => mods.has(m)), ...(key ? [key] : [])].join('+'); }
  function localCheck(acc) {
    const parts = String(acc || '').split('+').filter(Boolean);
    const mods = parts.filter((p) => MOD_ORDER.includes(p));
    const key = parts.find((p) => !MOD_ORDER.includes(p));
    if (!parts.length) return 'Appuie sur au moins une combinaison.';
    if (!key) return mods.length >= 2 ? null : `Avec seulement des touches de modification, il en faut au moins deux (ex. ${MOD_EXAMPLE}).`;
    if (!mods.length && !/^F\d{1,2}$/.test(key)) return `Ajoute ${MODS_TEXT} (ou utilise une touche F1 à F12).`;
    return null;
  }
  function renderKeys(acc, cls, placeholder) {
    const box = $('#shortcut-keys');
    box.className = 'shortcut-keys' + (cls ? ' ' + cls : '');
    if (!acc) { box.innerHTML = `<span class="placeholder">${esc(placeholder || '—')}</span>`; return; }
    box.innerHTML = acc.split('+').map((k) => `<kbd>${esc(KEY_LABEL[k] || k)}</kbd>`).join(MAC ? '' : '<span class="plus">+</span>');
  }
  function updateShortcutUi() {
    if (!state) return;
    const current = state.settings.shortcut;
    const pending = sc.pending && sc.pending !== current ? sc.pending : null;
    const problem = pending ? localCheck(pending) : null;
    let hint;
    if (sc.recording) {
      renderKeys(sc.pending, 'recording', 'Appuie sur tes touches…');
      hint = problem || 'Appuie sur la combinaison voulue (tu peux recommencer). Clique sur Arrêter quand c’est bon, puis sur Confirmer.';
    } else if (pending) {
      renderKeys(pending, problem || sc.error ? 'bad' : 'pending');
      hint = sc.error || problem || 'Nouveau raccourci prêt : clique sur Confirmer pour l’utiliser.';
    } else {
      renderKeys(current, state.shortcutOk ? '' : 'bad');
      hint = sc.error || (state.shortcutOk ? 'Raccourci actif. Clique sur Enregistrer pour en choisir un autre.' : 'Ce raccourci ne fonctionne pas (déjà pris par une autre application ?). Enregistres-en un autre.');
    }
    $('#shortcut-hint').textContent = hint;
    $('#shortcut-hint').classList.toggle('bad', !!(sc.error || (problem && !sc.recording) || (!sc.recording && !pending && !state.shortcutOk)));
    const rb = $('#shortcut-record');
    rb.innerHTML = sc.recording ? '<span class="rec-dot"></span>Arrêter' : 'Enregistrer';
    rb.classList.toggle('recording', sc.recording);
    $('#shortcut-confirm').disabled = !pending || !!problem;
    $('#shortcut-cancel').hidden = !(sc.recording || pending);
  }
  async function setRecording(on) {
    sc.recording = on; sc.held.clear(); sc.error = null;
    if (on) { sc.pending = null; sc.mods = new Set(); sc.key = null; }
    updateShortcutUi();
    try { await ff.invoke('ff:shortcut-suspend', on); } catch { /* ignore */ }
  }
  $('#shortcut-record').addEventListener('click', () => setRecording(!sc.recording));
  $('#shortcut-cancel').addEventListener('click', async () => { sc.pending = null; sc.error = null; if (sc.recording) await setRecording(false); updateShortcutUi(); });
  $('#shortcut-confirm').addEventListener('click', async () => {
    const acc = sc.pending;
    if (!acc) return;
    if (sc.recording) await setRecording(false);
    const test = await ff.invoke('ff:shortcut-test', acc);
    if (!test.ok) { sc.error = test.error || `« ${prettyAcc(acc)} » est indisponible.`; updateShortcutUi(); return; }
    await ff.invoke('ff:set-settings', { shortcut: acc });
    sc.pending = null; sc.error = null;
    toast(`Raccourci : ${prettyAcc(acc)}`);
    updateShortcutUi();
  });
  window.addEventListener('keydown', (e) => {
    if (!sc.recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    // Forget modifiers the OS released without telling us (e.g. Win opening the Start menu).
    for (const c of [...sc.held]) { const m = MOD_CODES[c]; if (m && c !== e.code && !e[MOD_FLAG[m]]) sc.held.delete(c); }
    if (!sc.held.size) { sc.mods = new Set(); sc.key = null; }    // a new chord replaces the previous one
    sc.held.add(e.code);
    const mod = MOD_CODES[e.code];
    if (mod) sc.mods.add(mod);
    else {
      const k = codeToKey(e.code);
      if (!k) { sc.error = `La touche « ${e.key} » n’est pas prise en charge.`; updateShortcutUi(); return; }
      sc.key = k;
    }
    sc.error = null;
    sc.pending = accFrom(sc.mods, sc.key);
    updateShortcutUi();
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!sc.recording) return;
    e.preventDefault(); e.stopPropagation();
    sc.held.delete(e.code);
  }, true);
  window.addEventListener('blur', () => { sc.held.clear(); });

  // ---- IPC from main
  ff.on('ff:state', (s) => { state = s; phase = s.phase || phase; render(); });
  ff.on('ff:dictation', (p) => {
    phase = p.phase;
    if (phase === 'idle') hubDictation = false;
    if (phase === 'error' && p.message) toast(p.message, 'error');
    render();
  });
  ff.on('ff:insert', (text) => {
    const ta = $('#try-area');
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start), after = ta.value.slice(end);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + sep + text + after;
    const pos = (before + sep + text).length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
  });

  // Live microphone level -> hero waveform + try-zone halo (only while listening).
  const waveBars = Array.from(wave.children);
  const lvHist = new Array(Math.ceil(waveBars.length / 2)).fill(0);
  let liveTimer = null;
  ff.on('ff:level', (v) => {
    if (phase !== 'listening') return;
    lvHist.shift(); lvHist.push(v);
    const hero = $('#hero');
    hero.classList.add('live');
    const mid = (waveBars.length - 1) / 2;
    waveBars.forEach((b, i) => {
      const d = Math.round(Math.abs(i - mid));
      const lv = lvHist[lvHist.length - 1 - Math.min(d, lvHist.length - 1)] || 0;
      b.style.setProperty('--lv', (1 + lv * 7 * (1 - d / (mid + 2))).toFixed(2));
    });
    $('#mic-btn').style.setProperty('--lv', (1 + v * 0.6).toFixed(2));
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { hero.classList.remove('live'); waveBars.forEach((b) => b.style.removeProperty('--lv')); }, 400);
  });

  // Keyboard: Cmd/Ctrl+1..5 sections, Cmd/Ctrl+F search, Esc clears a search.
  const SECTIONS = ['home', 'history', 'dictionary', 'snippets', 'settings'];
  window.addEventListener('keydown', (e) => {
    if (sc.recording) return;
    const mod = MAC ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) { e.preventDefault(); navigate(SECTIONS[Number(e.code.slice(5)) - 1]); return; }
    if (mod && e.code === 'KeyF') {
      e.preventDefault();
      const active = document.querySelector('.section.active');
      let input = active && active.querySelector('input[type=search]');
      if (!input) { navigate('history'); input = $('#history-search'); }
      input.focus(); input.select();
      return;
    }
    if (e.key === 'Escape' && e.target.matches('input[type=search]') && e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input')); }
  });

  // Relative times ("il y a 3 min") stay fresh.
  setInterval(() => { if (state) { drawn.recent = null; render(); } }, 60000);

  // ---- init
  ff.invoke('ff:get-state').then((s) => { state = s; phase = s.phase; render(); loadMics(); });
  ff.send('ff:hub-ready');
})();
