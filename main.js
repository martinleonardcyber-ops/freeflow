'use strict';
// OxoFlow main process: tray, global shortcut, overlay pill, hub window,
// dictation pipeline (overlay mic -> WAV -> local STT sidecar -> formatting ->
// clipboard + simulated paste -> history).
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, screen, nativeImage, nativeTheme, shell, session, systemPreferences, ClipboardItem } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createStore } = require('./lib/store');
const { formatText, countWords } = require('./lib/format');
const { pcm16ToWav, wavDurationMs } = require('./lib/wav');
const { Sidecar } = require('./lib/sidecar');
const { paste } = require('./lib/paste');
const { DEFAULT_VOCAB, normalizeVocab, parseSounds } = require('./lib/vocab');
const { aiFormat, discover, pickModel } = require('./lib/aiformat');
const { execFile, spawn } = require('child_process');

app.setName('OxoFlow');
// Start/stop sounds are played by the overlay, which never gets a user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.oxoria.oxoflow');

const ROOT = __dirname;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const ASSETS = path.join(ROOT, 'assets');
const DEFAULT_SETTINGS = {
  shortcut: IS_MAC ? 'Fn' : 'Ctrl+Alt+Space',   // macOS: hold fn, like Wispr Flow
  mode: IS_MAC ? 'ptt' : 'toggle',             // 'toggle' | 'ptt'
  language: 'auto',             // 'auto' | 'fr' | 'en'
  autoPaste: true,
  launchAtLogin: false,
  microphoneId: 'default',
  pasteDelayMs: 60,
  restoreClipboardMs: 400,
  modelCache: '',               // empty = %LOCALAPPDATA%\OxoFlow\models, or <userData>/models on macOS (filled in at first start)
  sidecarPort: 48123,
  maxDictationSec: 300,
  showHubAtStart: true,
  theme: 'system',              // 'system' | 'light' | 'dark'
  sounds: true,                 // short cues when listening starts / stops
  onboarded: false,             // the first-run assistant has been completed or dismissed
  flowBar: true,                // small pill always visible at the bottom of the screen
  aiFormat: false,              // clean-up by a LOCAL language model (LM Studio...), rules as fallback
  aiModel: '',                  // '' = pick one automatically
  aiEndpoint: '',               // pinned when the option is switched on; dictations go only there
  fnOffered: false,             // macOS: the old Ctrl+Alt+Space default was switched to fn once
  vocabSeeded: false,           // default vocabulary (n8n, Higgsfield...) added once
};
const OVERLAY_W = 460;
const OVERLAY_H = 140;
const TYPING_WPM = 40;          // typing speed used for the "time saved" estimate (labelled as such in the hub)

// ---- CLI flags (dev/verification) ------------------------------------------
const argv = {};
for (const a of process.argv.slice(1)) {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/i);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}
const DEV_MODE = !!(argv['test-pipeline'] || argv.screenshots || argv['ui-test']);
// --user-data-dir=<dir>: separate profile (tests, portable use); Windows ignores %APPDATA% for Electron.
if (typeof argv['user-data-dir'] === 'string' && argv['user-data-dir']) app.setPath('userData', path.resolve(argv['user-data-dir']));

// ---- Single instance -------------------------------------------------------
if (!app.requestSingleInstanceLock() && !DEV_MODE) {
  app.quit();
}

let userData, logDir, logFile;
let settings, dictionary, snippets, history;
let hub = null, overlay = null, tray = null, sidecar = null;
let quitting = false;
let shortcutOk = false;
let pttAvailable = false;
let uiohookMod = null;
const dictation = { phase: 'idle', startedAt: 0, stoppedAt: 0, toHub: false, noPaste: false, timer: null, idleTimer: null };

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  if (!app.isPackaged || DEV_MODE) console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

// ---- Stores ----------------------------------------------------------------
// OxoFlow was FreeFlow: move the old profile (settings, dictionary, history,
// downloaded model) into the new folder once, so nothing is lost or re-downloaded.
function migrateFromFreeFlow() {
  if (argv['user-data-dir']) return;
  const old = path.join(app.getPath('appData'), 'FreeFlow');
  const cur = app.getPath('userData');
  if (old === cur || !fs.existsSync(path.join(old, 'settings.json')) || fs.existsSync(path.join(cur, 'settings.json'))) return;
  fs.mkdirSync(cur, { recursive: true });
  for (const name of fs.readdirSync(old)) {
    const to = path.join(cur, name);
    if (!fs.existsSync(to)) { try { fs.renameSync(path.join(old, name), to); } catch { /* left in place */ } }
  }
  try {   // the model cache path may point inside the old folder
    const f = path.join(cur, 'settings.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.modelCache && j.modelCache.startsWith(old)) { j.modelCache = cur + j.modelCache.slice(old.length); fs.writeFileSync(f, JSON.stringify(j, null, 2)); }
  } catch { /* defaults will apply */ }
  try { fs.rmdirSync(old); } catch { /* not empty: Chromium leftovers stay */ }
}

function initStores() {
  migrateFromFreeFlow();
  userData = app.getPath('userData');
  logDir = path.join(userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'oxoflow.log');
  settings = createStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS);
  if (!fs.existsSync(settings.path)) settings.set(settings.get()); // write defaults so the file is discoverable
  // Models (0,5 to 3 GB) go to %LOCALAPPDATA%\OxoFlow\models, never to the roaming profile.
  if (!settings.get().modelCache) settings.update({ modelCache: path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OxoFlow') : userData, 'models') });
  // macOS: profiles created with the old default move to "hold fn" once (Wispr Flow's gesture).
  if (IS_MAC && !settings.get().fnOffered) {
    const cur = settings.get();
    settings.update(cur.shortcut === 'Ctrl+Alt+Space' && cur.mode === 'toggle' ? { shortcut: 'Fn', mode: 'ptt', fnOffered: true } : { fnOffered: true });
  }
  dictionary = createStore(path.join(userData, 'dictionary.json'), []);
  // Vocabulary entries are { word, sounds[] }; migrate legacy string lists and seed the defaults once.
  let vocab = normalizeVocab(dictionary.get());
  if (!settings.get().vocabSeeded) {
    const have = new Set(vocab.map((e) => e.word.toLowerCase()));
    vocab = [...vocab, ...normalizeVocab(DEFAULT_VOCAB).filter((e) => !have.has(e.word.toLowerCase()))];
    settings.update({ vocabSeeded: true });
  }
  // Renamed app: FreeFlow's own entry becomes OxoFlow's, and Oxoria joins (once, keeps user edits).
  if (!settings.get().vocabOxo) {
    const defaults = normalizeVocab(DEFAULT_VOCAB);
    vocab = vocab.filter((e) => e.word.toLowerCase() !== 'freeflow');
    for (const w of ['OxoFlow', 'Oxoria']) if (!vocab.some((e) => e.word.toLowerCase() === w.toLowerCase())) vocab.push(defaults.find((e) => e.word === w));
    settings.update({ vocabOxo: true });
  }
  dictionary.set(vocab);
  snippets = createStore(path.join(userData, 'snippets.json'), []);
  history = createStore(path.join(userData, 'history.json'), []);
  // Someone who already dictates does not need the first-run assistant.
  if (!settings.get().onboarded && history.get().length) settings.update({ onboarded: true });
}

// Shared secret between the app and its STT engine, stable per install so a
// still-running engine from a previous session can be adopted.
function sidecarToken() {
  const file = path.join(userData, 'engine.token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch { /* first start */ }
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(file, t, { mode: 0o600 }); } catch (e) { log('token write:', e.message); }
  return t;
}

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function computeStats(hist) {
  const today = new Date().toDateString();
  let wordsToday = 0, total = 0, audioMs = 0, wordsTimed = 0, latency = 0, latencyN = 0;
  for (const h of hist) {
    total += h.words || 0;
    if (new Date(h.ts).toDateString() === today) wordsToday += h.words || 0;
    if (h.audioMs > 0) { audioMs += h.audioMs; wordsTimed += h.words || 0; }
    if (h.latencyMs > 0) { latency += h.latencyMs; latencyN += 1; }
  }
  // Words per day over the last 14 days, oldest first, plus the current streak of days with a dictation.
  const perDay = new Map();
  for (const h of hist) { const k = dayKey(h.ts); perDay.set(k, (perDay.get(k) || 0) + (h.words || 0)); }
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    daily.push({ day: dayKey(d), words: perDay.get(dayKey(d)) || 0 });
  }
  let streak = 0;
  const cur = new Date(); cur.setHours(12, 0, 0, 0);
  if (!perDay.has(dayKey(cur))) cur.setDate(cur.getDate() - 1);   // today not started yet: count from yesterday
  while (perDay.has(dayKey(cur))) { streak += 1; cur.setDate(cur.getDate() - 1); }
  const typingMin = total / TYPING_WPM;
  return {
    wordsToday,
    totalWords: total,
    dictations: hist.length,
    avgWpm: audioMs > 0 ? Math.round(wordsTimed / (audioMs / 60000)) : 0,
    avgLatencyMs: latencyN ? Math.round(latency / latencyN) : 0,
    minutesSpoken: Math.round(audioMs / 60000),
    minutesSaved: Math.max(0, Math.round(typingMin - audioMs / 60000)),
    typingWpm: TYPING_WPM,
    daily,
    streak,
  };
}

function buildState() {
  const hist = history.get();
  return {
    version: app.getVersion(),
    // First name only ("Bonjour, Alan"); --display-name=<x> overrides it for screenshots.
    user: typeof argv['display-name'] === 'string' ? argv['display-name'] : String(os.userInfo().username || '').split(/[\s._-]+/)[0],
    settings: settings.get(),
    dictionary: dictionary.get(),
    snippets: snippets.get(),
    history: hist.slice(0, 500),
    stats: computeStats(hist),
    sidecar: sidecar ? { ...sidecar.info, port: sidecar.port, external: sidecar.external } : { ready: false, loading: true },
    loadingLabel: loadingLabel(sidecar ? sidecar.info : null),
    loadingShort: loadingLabel(sidecar ? sidecar.info : null, true),
    pttAvailable,
    shortcutOk,
    shortcutSuspended,
    phase: dictation.phase,
    paths: { userData, logs: logDir, pasteHelper: pasteHelperPath() },
    platform: process.platform,
    devMode: DEV_MODE,
    // macOS: posting Cmd+V and the low-level keyboard hook both need the Accessibility permission.
    accessibility: IS_MAC ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    microphone: IS_MAC ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
    fnDenied,
    fnUsage,
  };
}

function pushState() {
  const hubOn = hub && !hub.isDestroyed(), menuOn = menuWin && !menuWin.isDestroyed() && menuWin.isVisible();
  if (!hubOn && !menuOn) return;
  const st = buildState();
  if (hubOn) hub.webContents.send('ff:state', st);
  if (menuOn) menuWin.webContents.send('ff:state', st);
}

// ---- Paths -----------------------------------------------------------------
function pasteHelperPath() {
  const name = IS_MAC ? 'PasteHelperMac' : 'PasteHelper.exe';
  const candidates = [
    path.join(process.resourcesPath || '', name),
    path.join(ROOT, 'native', name),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[1];
}

// ---- Windows ---------------------------------------------------------------
function createHub() {
  hub = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600,
    title: 'OxoFlow',
    backgroundColor: IS_MAC ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#0c0c10' : '#f6f5f2',
    icon: path.join(ASSETS, IS_WIN ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    // macOS: traffic lights over a translucent sidebar, like native Mac apps.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'active' } : {}),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hub.loadFile(path.join(ROOT, 'renderer', 'hub', 'index.html'));
  hub.on('page-title-updated', (e) => e.preventDefault());
  hub.on('close', (e) => { if (!quitting) { e.preventDefault(); hub.hide(); } });
  hub.on('hide', () => {
    if (shortcutSuspended) { shortcutSuspended = false; registerShortcut(); pushState(); }
    if (IS_MAC && app.dock) app.dock.hide();   // menu-bar app: a Dock icon only while the window is open
  });
  hub.on('focus', () => { readFnUsage(); pushState(); });   // e.g. a permission or the 🌐 key setting just changed
  hub.webContents.on('did-finish-load', pushState);
  hub.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function showHub() {
  if (!hub || hub.isDestroyed()) createHub();
  if (IS_MAC && app.dock) app.dock.show();
  if (!hub.isVisible()) hub.show();
  hub.focus();
  pushState();
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, movable: false,
    ...(IS_MAC ? { type: 'panel' } : {}),   // NSPanel: never activates OxoFlow, so Cmd+V lands in the app the user is in
    minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(ROOT, 'renderer', 'overlay', 'index.html'));
  overlay.webContents.on('did-finish-load', () => { if (flowBarOn() && dictation.phase === 'idle') { showOverlay(); setPhase('idle'); } });
  positionOverlay();
}

function positionOverlay() {
  if (!overlay) return;
  // The display the user is working on (cursor), not always the primary one.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlay.setBounds({
    x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2),
    y: Math.round(wa.y + wa.height - OVERLAY_H - 12),
    width: OVERLAY_W, height: OVERLAY_H,
  });
}

function overlaySend(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function showOverlay() {
  positionOverlay();
  if (!overlay.isVisible()) overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
}

// ---- Tray ------------------------------------------------------------------
function trayIcon(name) {
  // macOS menu bar: template images (tinted by the system) and @2x variants.
  if (IS_MAC) name = { 'tray.png': 'trayTemplate.png', 'tray-loading.png': 'tray-loadingTemplate.png', 'tray-rec.png': 'tray-rec-mac.png' }[name] || name;
  return nativeImage.createFromPath(path.join(ASSETS, name));
}

// ---- Menu-bar panel: a click on the tray icon opens a small rich window
// (state, quick toggles, actions); a right click keeps the plain native menu.
let menuWin = null, trayMenu = null, menuHiddenAt = 0;
const MENU_W = 360;
function createMenuWindow() {
  menuWin = new BrowserWindow({
    width: MENU_W, height: 560, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    // NSPanel that never activates OxoFlow: the user's app keeps the focus, so
    // "paste last" / "dictate" land in it once the panel closes.
    ...(IS_MAC ? { type: 'panel', vibrancy: 'popover', visualEffectState: 'active', roundedCorners: true } : {}),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  menuWin.setAlwaysOnTop(true, 'pop-up-menu');
  menuWin.loadFile(path.join(ROOT, 'renderer', 'menu', 'index.html'));
  menuWin.on('blur', () => hideMenu());
}
function hideMenu() {
  if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) { menuWin.hide(); menuHiddenAt = Date.now(); }
}
function placeMenu() {
  if (!tray || !menuWin) return;
  const b = tray.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const [w, h] = menuWin.getSize();
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - w / 2, wa.x + 8), wa.x + wa.width - w - 8));
  const below = b.y < wa.y + wa.height / 2;                 // menu bar at the top (macOS), taskbar at the bottom (Windows)
  const y = Math.round(below ? b.y + b.height + 6 : b.y - h - 8);
  menuWin.setPosition(x, Math.max(wa.y, y));
}
function toggleMenu() {
  if (!menuWin || menuWin.isDestroyed()) createMenuWindow();
  if (menuWin.isVisible()) { hideMenu(); return; }
  if (Date.now() - menuHiddenAt < 250) return;              // the click that closed it by blurring
  placeMenu();
  menuWin.show();
  menuWin.focus();
  menuWin.webContents.send('ff:menu-shown');
  pushState();
}
ipcMain.on('ff:menu-size', (_e, h) => {
  if (!menuWin || menuWin.isDestroyed()) return;
  menuWin.setSize(MENU_W, Math.max(200, Math.min(900, Math.round(Number(h) || 0))));
  if (menuWin.isVisible()) placeMenu();
});
ipcMain.handle('ff:menu-action', async (_e, action) => {
  const last = history.get()[0];
  switch (action) {
    case 'close': hideMenu(); break;
    case 'open': hideMenu(); showHub(); break;
    case 'settings': hideMenu(); showHub(); hub.webContents.send('ff:navigate', 'settings'); break;
    case 'dictate': hideMenu(); setTimeout(() => toggleDictation(), 120); break;
    case 'copy-last': if (last) await clipboard.writeText(last.text); break;
    case 'paste-last': hideMenu(); setTimeout(() => pasteLast().catch((e) => log('paste last:', e.message)), 180); break;
    case 'quit': quitApp(); break;
    default: break;
  }
  return true;
});

function createTray() {
  tray = new Tray(trayIcon('tray-loading.png'));
  tray.setToolTip('OxoFlow — Chargement du modèle…');
  tray.on('click', toggleMenu);
  tray.on('right-click', () => { hideMenu(); if (trayMenu) tray.popUpContextMenu(trayMenu); });
  updateTray();
  createMenuWindow();
}

function prettyShortcut(acc) {
  if (acc === 'Fn') return 'fn';
  if (IS_MAC) {
    const mac = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘', Space: 'Espace' };
    return String(acc || '').split('+').map((k) => mac[k] || k).join('');
  }
  const names = { Super: 'Win', Space: 'Espace', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Maj' };
  return String(acc || '').split('+').map((k) => names[k] || k).join(' + ');
}

// "Téléchargement du modèle · 42 % (1,3 / 3,1 Go)" on first start (short: "Téléchargement · 42 %"),
// else "Chargement du modèle…".
function loadingLabel(info, short = false) {
  const d = info && info.phase === 'downloading' ? info.download : null;
  if (!d) return 'Chargement du modèle…';
  const go = (b) => (b / 1e9).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (!d.total) return short ? 'Téléchargement…' : `Téléchargement du modèle · ${go(d.done || 0)} Go`;
  const pct = Math.min(99, Math.floor((100 * (d.done || 0)) / d.total));
  return short ? `Téléchargement · ${pct} %` : `Téléchargement du modèle · ${pct} % (${go(d.done || 0)} / ${go(d.total)} Go)`;
}

// "Copier la dernière dictée" + the last three, as Wispr's "paste last transcript".
function recentMenu() {
  const recent = history ? history.get().slice(0, 3) : [];
  const short = (t) => (t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t);
  const copy = async (t) => { await clipboard.writeText(t); log('tray: copied a past dictation'); };
  return [
    { label: 'Copier la dernière dictée', enabled: !!recent.length, click: () => recent[0] && copy(recent[0].text) },
    { label: `Coller la dernière dictée (${IS_MAC ? '⌃⌘V' : 'Ctrl+Alt+Maj+V'})`, enabled: !!recent.length, click: () => pasteLast().catch((e) => log('paste last:', e.message)) },
    { label: 'Dictées récentes', enabled: recent.length > 1, submenu: recent.map((h) => ({ label: short(h.text), click: () => copy(h.text) })) },
  ];
}

function updateTray() {
  if (!tray) return;
  const s = settings.get();
  const listening = dictation.phase === 'listening';
  const busy = dictation.phase === 'transcribing' || dictation.phase === 'formatting';
  const info = sidecar ? sidecar.info : {};
  tray.setImage(trayIcon(listening ? 'tray-rec.png' : info.ready ? 'tray.png' : 'tray-loading.png'));
  const engine = info.ready ? `${info.device === 'cuda' ? 'GPU' : info.device === 'mlx' ? 'GPU Metal' : 'CPU'} · ${info.model}` : info.loading ? loadingLabel(info) : (info.error ? 'Moteur indisponible' : '…');
  tray.setToolTip(`OxoFlow — ${listening ? 'Écoute…' : busy ? 'Transcription…' : engine}\nRaccourci : ${prettyShortcut(s.shortcut)}`);
  if (IS_MAC) tray.setTitle(listening ? ' Écoute' : '');
  // Right-click fallback; a left click opens the panel (setContextMenu would swallow it).
  trayMenu = (Menu.buildFromTemplate([
    { label: 'Ouvrir OxoFlow', click: showHub },
    { label: listening ? 'Arrêter la dictée (mains libres)' : 'Démarrer la dictée (mains libres)', enabled: !!info.ready && !busy, click: () => toggleDictation() },
    { type: 'separator' },
    ...recentMenu(),
    { type: 'separator' },
    { label: `Raccourci : ${prettyShortcut(s.shortcut)}${shortcutOk ? '' : ' (indisponible)'}`, enabled: false },
    { label: info.ready ? `Moteur : ${engine} (${info.compute_type})` : `Moteur : ${engine}`, enabled: false },
    { type: 'separator' },
    { label: 'Quitter', click: quitApp },
  ]));
}

// ---- Dictation state machine ----------------------------------------------
// What the idle Flow bar says on hover.
function barHint() {
  const s = settings.get();
  return { key: prettyShortcut(s.shortcut), text: s.mode === 'ptt' ? 'Maintiens pour dicter · double-tape pour mains libres' : 'Appuie pour dicter · ou clique ici' };
}
const flowBarOn = () => settings.get().flowBar !== false;

function setPhase(phase, payload = {}) {
  dictation.phase = phase;
  overlaySend('ff:overlay', { phase, ...payload, ...(phase === 'idle' ? { bar: flowBarOn(), hint: barHint() } : {}) });
  if (hub && !hub.isDestroyed()) hub.webContents.send('ff:dictation', { phase, ...payload });
  if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) menuWin.webContents.send('ff:dictation', { phase });
  updateTray();
}

function scheduleIdle(ms) {
  clearTimeout(dictation.idleTimer);
  dictation.idleTimer = setTimeout(() => {
    setPhase('idle');
    // The Flow bar stays on screen between dictations; without it the pill leaves.
    setTimeout(() => { if (dictation.phase === 'idle' && overlay && overlay.isVisible() && !flowBarOn()) overlay.hide(); }, 420);
    pushState();
  }, ms);
}

function flashOverlay(phase, message, ms = 1600) {
  showOverlay();
  setPhase(phase, { message });
  scheduleIdle(ms);
}

// Esc cancels a running dictation. Only registered while listening, so Esc
// keeps working normally in other apps the rest of the time.
function armEscape(on) {
  try {
    if (on && !globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', () => { if (dictation.phase === 'listening') { log('dictation: cancelled (Esc)'); cancelDictation(); } });
    if (!on && globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  } catch (e) { log('escape shortcut:', e.message); }
}

function startDictation(opts = {}) {
  if (dictation.phase !== 'idle') return false;
  if (!sidecar || !sidecar.ready) {
    flashOverlay('error', sidecar && sidecar.info.loading ? (sidecar.info.phase === 'downloading' ? `Modèle en téléchargement${(loadingLabel(sidecar.info, true).match(/\d+ %/) || ['…'])[0].replace(/^(\d)/, ' · $1')}` : 'Modèle en cours de chargement…') : 'Moteur de transcription indisponible');
    return false;
  }
  clearTimeout(dictation.idleTimer);
  dictation.toHub = !!opts.toHub;
  dictation.noPaste = !!opts.noPaste;
  dictation.startedAt = Date.now();
  dictation.stoppedAt = 0;
  showOverlay();
  setPhase('listening', { startedAt: dictation.startedAt, maxSec: settings.get().maxDictationSec });
  const s = settings.get();
  overlaySend('ff:rec-start', { deviceId: s.microphoneId, maxSec: s.maxDictationSec, sounds: s.sounds !== false });
  armEscape(true);
  clearTimeout(dictation.timer);
  dictation.timer = setTimeout(() => stopDictation(), (s.maxDictationSec || 300) * 1000);
  log('dictation: listening', opts);
  return true;
}

function stopDictation() {
  if (dictation.phase !== 'listening') return false;
  clearTimeout(dictation.timer);
  // If the audio or the engine never answers, do not stay stuck on "Transcription…".
  dictation.timer = setTimeout(() => {
    if (dictation.phase === 'transcribing' || dictation.phase === 'formatting') {
      log('dictation: no result after 45 s, giving up');
      setPhase('error', { message: 'Délai dépassé, réessaie' });
      scheduleIdle(2000);
    }
  }, 45000);
  dictation.stoppedAt = Date.now();
  armEscape(false);
  setPhase('transcribing');
  overlaySend('ff:rec-stop');
  return true;
}

function cancelDictation() {
  clearTimeout(dictation.timer);
  armEscape(false);
  overlaySend('ff:rec-cancel');
  setPhase('idle');
  scheduleIdle(0);
}

function toggleDictation(opts = {}) {
  if (dictation.phase === 'listening') return stopDictation();
  if (dictation.phase === 'idle') return startDictation(opts);
  return false;
}

ipcMain.on('ff:audio-done', (_e, payload) => {
  clearTimeout(dictation.timer);
  const pcm = Buffer.from(payload.pcm);
  const wav = pcm16ToWav(pcm, payload.sampleRate || 16000, 1);
  log(`audio: ${wavDurationMs(wav)} ms @ ${payload.sampleRate} Hz (${(wav.length / 1024).toFixed(0)} KiB)`);
  if (wavDurationMs(wav) < 400) {
    // Released before the microphone had anything: the gesture, not the voice, is the problem.
    const s = settings.get();
    setPhase('error', { message: s.mode === 'ptt' ? `Maintiens ${prettyShortcut(s.shortcut)} pendant que tu parles` : 'Rien entendu' });
    scheduleIdle(1800);
    return;
  }
  runPipeline(wav, { toHub: dictation.toHub, noPaste: dictation.noPaste }).catch(() => {});
});

// Live microphone level (0..1, ~10/s) from the overlay, mirrored in the hub's waveform.
ipcMain.on('ff:level', (_e, v) => {
  if (hub && !hub.isDestroyed() && hub.isVisible()) hub.webContents.send('ff:level', Number(v) || 0);
});

// Flow bar: the overlay window lets clicks through except over the pill.
ipcMain.on('ff:overlay-mouse', (_e, inside) => {
  if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(!inside, { forward: true });
});
ipcMain.on('ff:overlay-click', () => {
  if (dictation.phase === 'idle' || dictation.phase === 'listening') toggleDictation();
});

ipcMain.on('ff:audio-error', (_e, message) => {
  log('audio error:', message);
  setPhase('error', { message: message || 'Micro indisponible' });
  scheduleIdle(2000);
});

// Electron >= 44 clipboard API (W3C-like): read() -> ClipboardItem[], write(ClipboardItem[]).
// Every MIME type is materialised into a Blob now, because the items returned by
// read() may resolve lazily against a clipboard we are about to overwrite.
async function saveClipboard() {
  try {
    const items = await clipboard.read();
    const snap = [];
    for (const item of items) {
      const data = {};
      for (const type of item.types) {
        try { data[type] = await item.getType(type); } catch (e) { log(`clipboard save ${type}:`, e.message); }
      }
      if (Object.keys(data).length) snap.push(data);
    }
    return snap;
  } catch (e) {
    log('clipboard save:', e.message);
    try { return [{ 'text/plain': await clipboard.readText() }]; } catch { return []; }
  }
}

async function restoreClipboard(snap) {
  if (!snap || !snap.length) { clipboard.clear(); return; }
  await clipboard.write(snap.map((data) => new ClipboardItem(data)));
}

/**
 * WAV -> STT -> format -> clipboard (+ paste) -> history.
 * @param {Buffer} wav
 * @param {{toHub?:boolean, noPaste?:boolean}} opts
 */
async function runPipeline(wav, opts = {}) {
  const t0 = Date.now();
  const s = settings.get();
  if (dictation.phase !== 'transcribing') setPhase('transcribing');
  try {
    const res = await sidecar.transcribe(wav, { lang: s.language, hints: dictionary.get().map((e) => e.word) });
    setPhase('formatting');
    // Local AI first (disfluencies, self-corrections), then the rules (vocabulary, snippets, typography).
    let ai = null;
    if (s.aiFormat && res.text) {
      try { ai = await aiFormat(res.text, { endpoint: s.aiEndpoint, model: s.aiModel, vocabulary: dictionary.get().map((e) => e.word) }); log(`ai format: ${ai.model} ${ai.ms} ms`); }
      catch (e) { log('ai format skipped:', e.message); }
    }
    const text = formatText(ai ? ai.text : res.text, { language: res.language, snippets: snippets.get(), dictionary: dictionary.get() });
    if (!text) {
      setPhase('error', { message: 'Rien entendu' });
      scheduleIdle(1200);
      return { text: '', raw: res.text, sttMs: res.duration_ms, audioMs: res.audio_ms };
    }
    // Save the whole clipboard (text, HTML, RTF, image), not just its text: a
    // copied image or formatted text must survive a dictation.
    // Electron >= 44: clipboard reads/writes return Promises; awaiting a plain value is harmless.
    const previousClipboard = await saveClipboard();
    await clipboard.writeText(text);
    let pasteOutcome = null;
    const shouldPaste = s.autoPaste && !opts.noPaste && !opts.toHub;
    if (opts.toHub && hub && !hub.isDestroyed()) hub.webContents.send('ff:insert', text);
    if (shouldPaste) {
      pasteOutcome = await paste(pasteHelperPath(), { delayMs: s.pasteDelayMs, log });
      if (pasteOutcome.outcome === 'pasted') {
        setTimeout(async () => {
          // Only if nobody copied something else in the meantime.
          try { if ((await clipboard.readText()) === text) await restoreClipboard(previousClipboard); } catch (e) { log('clipboard restore:', e.message); }
        }, s.restoreClipboardMs || 400);
      }
    }
    const latencyMs = Date.now() - (dictation.stoppedAt || t0);
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      text,
      raw: res.text,
      words: countWords(text),
      audioMs: res.audio_ms || wavDurationMs(wav),
      sttMs: res.duration_ms,
      latencyMs,
      language: res.language,
      app: pasteOutcome ? pasteOutcome.process : (opts.toHub ? 'OxoFlow' : null),
      pasted: pasteOutcome ? pasteOutcome.outcome : (opts.toHub ? 'hub' : 'clipboard'),
      ai: ai ? { model: ai.model, ms: ai.ms } : null,
    };
    history.set([entry, ...history.get()].slice(0, 2000));
    updateTray();
    log(`dictation: ${entry.words} words, stt ${entry.sttMs} ms, latency ${latencyMs} ms, paste=${entry.pasted}`);
    setPhase('done', { text, latencyMs, pasted: entry.pasted });
    scheduleIdle(pasteOutcome && pasteOutcome.outcome === 'blocked' ? 2200 : 900);
    if (pasteOutcome && pasteOutcome.outcome === 'blocked') {
      setPhase('error', { message: pasteOutcome.reason === 'accessibility' ? 'Autorise OxoFlow dans Accessibilité · texte copié' : 'Collage bloqué — texte copié dans le presse-papiers' });
      if (pasteOutcome.reason === 'accessibility') pushState();
    }
    pushState();
    return entry;
  } catch (err) {
    log('pipeline error:', err);
    setPhase('error', { message: err.message || String(err) });
    scheduleIdle(2200);
    throw err;
  }
}

// ---- Shortcut / push-to-talk ----------------------------------------------
const MOD_KEYS = new Set(['ctrl', 'control', 'alt', 'shift', 'super', 'meta', 'cmd', 'command', 'commandorcontrol', 'cmdorctrl']);

function parseAccelerator(acc) {
  const parts = String(acc || '').split('+').map((p) => p.trim()).filter(Boolean);
  const out = { ctrl: false, alt: false, shift: false, meta: false, key: null };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'commandorcontrol' || l === 'cmdorctrl') out.ctrl = true;
    else if (l === 'alt') out.alt = true;
    else if (l === 'shift') out.shift = true;
    else if (l === 'super' || l === 'meta' || l === 'cmd' || l === 'command') out.meta = true;
    else out.key = p;
  }
  return out;
}

function uiohookKeycode(key) {
  if (!uiohookMod || !key) return null;
  const K = uiohookMod.UiohookKey;
  const map = {
    Space: 'Space', Enter: 'Enter', Return: 'Enter', Tab: 'Tab', Esc: 'Escape', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft',
    Right: 'ArrowRight', CapsLock: 'CapsLock', Capslock: 'CapsLock', Plus: 'Equal', Minus: 'Minus', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
    Semicolon: 'Semicolon', Quote: 'Quote', Backslash: 'Backslash', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', '/': 'Slash',
    ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote',
  };
  let name = map[key];
  if (!name && /^num\d$/i.test(key)) name = 'Numpad' + key.slice(3);
  if (!name) name = /^[a-z]$/i.test(key) ? key.toUpperCase() : /^[0-9]$/.test(key) ? key : /^F\d{1,2}$/i.test(key) ? key.toUpperCase() : key;
  return K[name] ?? null;
}

// One low-level keyboard hook (uiohook) handles push-to-talk AND modifier-only
// chords such as Ctrl+Win (Electron's globalShortcut cannot register those).
// It never blocks keys; for chords containing Win it taps an unassigned key so
// Windows does not open the Start menu on release (like Wispr's masking).
const hook = { active: false, mode: 'toggle', combo: null, modOf: null, down: new Map(), comboDown: false, pressedAt: 0, handsFree: false, spoiled: false };
let shortcutSuspended = false;     // true while the hub records a new shortcut

function comboActive() {
  const c = hook.combo;
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  let keyDown = false, others = 0;
  for (const code of hook.down.keys()) {
    const m = hook.modOf.get(code);
    if (m) mods[m] = true;
    else if (c.keycode != null && code === c.keycode) keyDown = true;
    else others += 1;
  }
  if (mods.ctrl !== c.ctrl || mods.alt !== c.alt || mods.shift !== c.shift || mods.meta !== c.meta) return false;
  if (others) return false;
  return c.keycode == null ? true : keyDown;
}

function foreignKeyHeld() {
  for (const code of hook.down.keys()) if (!hook.modOf.has(code) && code !== hook.combo.keycode) return true;
  return false;
}

function maskWinKey() {
  if (!IS_WIN) return;            // the Start-menu problem does not exist elsewhere
  execFile(pasteHelperPath(), ['--mask'], { windowsHide: true, timeout: 3000 }, () => {});
}

function onComboDown() {
  if (hook.combo.meta) maskWinKey();
  if (hook.mode === 'ptt') {
    if (dictation.phase === 'listening' && hook.handsFree) { hook.handsFree = false; stopDictation(); return; }
    if (dictation.phase === 'idle') startDictation();
  }
}

function onComboUp() {
  const held = Date.now() - hook.pressedAt;
  if (hook.mode === 'ptt') {
    if (dictation.phase !== 'listening') return;
    if (hook.spoiled && held < 700) { cancelDictation(); return; }   // e.g. Ctrl+Win+D: not a dictation
    if (held < 300) {
      // A lone tap is usually an accident (old emoji habit, fn shortcuts): cancel.
      // Two quick taps = hands-free; the second one keeps the dictation open.
      const now = Date.now();
      if (now - (hook.lastTapAt || 0) < 650) { hook.handsFree = true; hook.lastTapAt = 0; return; }
      hook.lastTapAt = now;
      cancelDictation();
      return;
    }
    stopDictation();
  } else if (!hook.spoiled) {
    toggleDictation();                                                // modifier-only chord fires on release
  }
}

function stopHook() {
  if (hook.active && uiohookMod) {
    try { uiohookMod.uIOhook.removeAllListeners(); uiohookMod.uIOhook.stop(); } catch (e) { log('uiohook stop:', e.message); }
  }
  hook.active = false; hook.comboDown = false; hook.handsFree = false; hook.down.clear();
}

function startHook(acc, mode) {
  const combo = parseAccelerator(acc);
  combo.keycode = combo.key ? uiohookKeycode(combo.key) : null;
  if (combo.key && combo.keycode == null) { log(`hook: unknown key in "${acc}"`); return false; }
  const K = uiohookMod.UiohookKey;
  hook.modOf = new Map([[K.Ctrl, 'ctrl'], [K.CtrlRight, 'ctrl'], [K.Alt, 'alt'], [K.AltRight, 'alt'], [K.Shift, 'shift'], [K.ShiftRight, 'shift'], [K.Meta, 'meta'], [K.MetaRight, 'meta']]);
  hook.combo = combo; hook.mode = mode; hook.down.clear(); hook.comboDown = false; hook.handsFree = false;
  const { uIOhook } = uiohookMod;
  uIOhook.on('keydown', (e) => {
    const now = Date.now();
    if (!hook.comboDown) for (const [code, t] of hook.down) if (now - t > 8000) hook.down.delete(code); // missed key-ups (lock screen...)
    if (!hook.down.has(e.keycode)) hook.down.set(e.keycode, now);
    if (!hook.comboDown) {
      if (comboActive()) { hook.comboDown = true; hook.spoiled = false; hook.pressedAt = now; onComboDown(); }
    } else if (!comboActive()) {
      hook.spoiled = true;                                            // another key joined the chord
    }
  });
  uIOhook.on('keyup', (e) => {
    hook.down.delete(e.keycode);
    if (!hook.comboDown || comboActive()) return;
    if (foreignKeyHeld()) { hook.spoiled = true; return; }            // wait until the foreign key is released
    hook.comboDown = false;
    onComboUp();
  });
  try { uIOhook.start(); hook.active = true; log(`hook: started for ${acc} (${mode}${combo.key ? '' : ', modifier-only'})`); return true; } catch (e) { log('uiohook start failed:', e.message); return false; }
}

// macOS "Press 🌐 key to": 0 = do nothing; anything else (emoji, input source,
// Apple dictation; missing = system default) fights with "hold fn".
let fnUsage = null;
function readFnUsage() {
  if (!IS_MAC) return;
  execFile('defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'], (err, out) => {
    const v = err ? -1 : Number(String(out).trim());
    if (v !== fnUsage) { fnUsage = v; pushState(); }
  });
}

// macOS fn key: native/FnKeyMac prints down / up / spoil; the same push-to-talk
// logic as the uiohook path drives the dictation.
let fnProc = null;
let fnDenied = false;      // macOS refused the keyboard tap: Input Monitoring / Accessibility missing
let fnRetry = null;
function fnHelperPath() {
  return [path.join(process.resourcesPath || '', 'FnKeyMac'), path.join(ROOT, 'native', 'FnKeyMac')].find((p) => fs.existsSync(p)) || null;
}
function stopFnHook() {
  clearTimeout(fnRetry);
  if (fnProc) { const p = fnProc; fnProc = null; try { p.kill(); } catch { /* ignore */ } }
}
function startFnHook(mode) {
  const exe = fnHelperPath();
  if (!exe) { log('fn: native/FnKeyMac missing (npm run build:native:mac)'); return false; }
  hook.mode = mode; hook.combo = { ctrl: false, alt: false, shift: false, meta: false, keycode: null };
  hook.comboDown = false; hook.handsFree = false; hook.spoiled = false;
  const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  fnProc = proc;
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (ev === 'down') { hook.comboDown = true; hook.spoiled = false; hook.pressedAt = Date.now(); onComboDown(); }
      else if (ev === 'spoil') hook.spoiled = true;
      else if (ev === 'up' && hook.comboDown) { hook.comboDown = false; onComboUp(); }
      else if (ev === 'ready') log(`fn: listening (${mode})`);
      else if (ev === 'denied') {
        if (!fnDenied) log('fn: keyboard access denied (Input Monitoring / Accessibility), retrying every 4 s');
        fnDenied = true; shortcutOk = false; updateTray(); pushState();
      } else if (ev === 'ready' && fnDenied) { fnDenied = false; log('fn: keyboard access granted'); pushState(); }
    }
  });
  proc.on('exit', (code) => {
    if (fnProc !== proc) return;
    fnProc = null;
    if (code === 2) {   // permission not granted yet: try again quietly until it is
      clearTimeout(fnRetry);
      fnRetry = setTimeout(() => { if (!fnProc && settings.get().shortcut === 'Fn' && !shortcutSuspended) shortcutOk = startFnHook(settings.get().mode); }, 4000);
      return;
    }
    log(`fn: helper exited (${code})`);
    if (code) { shortcutOk = false; updateTray(); pushState(); }
  });
  return true;
}

// "Coller la dernière dictée" (Wispr's paste-last-transcript): the latest
// dictation goes back where the cursor is, the clipboard is restored after.
const PASTE_LAST = IS_MAC ? 'Control+Command+V' : 'Control+Alt+Shift+V';
async function pasteLast() {
  const last = history.get()[0];
  if (!last || !last.text) return;
  const previous = await saveClipboard();
  await clipboard.writeText(last.text);
  const r = await paste(pasteHelperPath(), { delayMs: settings.get().pasteDelayMs, log });
  log(`paste last: ${r.outcome}`);
  if (r.outcome === 'pasted') {
    setTimeout(async () => { try { if ((await clipboard.readText()) === last.text) await restoreClipboard(previous); } catch (e) { log('clipboard restore:', e.message); } }, settings.get().restoreClipboardMs || 400);
  } else if (r.reason === 'accessibility') flashOverlay('error', 'Autorise OxoFlow dans Accessibilité · texte copié', 2200);
}

// Every 1.5 s, cheap checks that no OS event reports:
//  - the Accessibility permission was just granted: re-arm fn / push-to-talk without a restart;
//  - the cursor moved to another display: the idle Flow bar follows it.
let lastTrusted = null, lastDisplayId = null;
function watchdog() {
  if (IS_MAC) {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (trusted !== lastTrusted) {
      const gained = lastTrusted === false && trusted;
      lastTrusted = trusted;
      if (gained) {
        log('accessibility: granted, re-arming the shortcut');
        if (uiohookMod && uiohookMod.uIOhook) pttAvailable = true;
        registerShortcut();
      }
      pushState();
    }
  }
  if (overlay && dictation.phase === 'idle' && flowBarOn() && overlay.isVisible()) {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (d.id !== lastDisplayId) { lastDisplayId = d.id; positionOverlay(); }
  }
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  stopHook();
  stopFnHook();
  try { if (!shortcutSuspended) globalShortcut.register(PASTE_LAST, () => { pasteLast().catch((e) => log('paste last:', e.message)); }); } catch (e) { log('paste-last shortcut:', e.message); }
  shortcutOk = false;
  if (shortcutSuspended) { log('shortcut: suspended while recording'); updateTray(); return; }
  const s = settings.get();
  if (s.shortcut === 'Fn') {
    if (IS_MAC) { shortcutOk = startFnHook(s.mode); updateTray(); return; }
    settings.update({ shortcut: DEFAULT_SETTINGS.shortcut === 'Fn' ? 'Ctrl+Alt+Space' : DEFAULT_SETTINGS.shortcut });
    return registerShortcut();
  }
  const combo = parseAccelerator(s.shortcut);
  const modifierOnly = !combo.key;
  if ((s.mode === 'ptt' || modifierOnly) && pttAvailable) {
    shortcutOk = startHook(s.shortcut, s.mode);
    if (!shortcutOk && s.mode === 'ptt' && !modifierOnly) { settings.update({ mode: 'toggle' }); return registerShortcut(); }
  } else if (modifierOnly) {
    log(`shortcut ${s.shortcut}: modifier-only chords need uiohook-napi`);
  } else {
    try { shortcutOk = globalShortcut.register(s.shortcut, () => toggleDictation()); } catch (e) { log('shortcut error:', e.message); shortcutOk = false; }
    log(`shortcut ${s.shortcut}: ${shortcutOk ? 'registered' : 'FAILED'}`);
  }
  updateTray();
}

// macOS app menu, in French. ⌘, opens the settings; the Edit menu keeps ⌘C / ⌘V / ⌘A working in the hub.
function buildAppMenu() {
  if (!IS_MAC) return;
  const go = (section) => () => { showHub(); hub.webContents.send('ff:navigate', section); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'OxoFlow', submenu: [
      { label: 'À propos de OxoFlow', role: 'about' },
      { type: 'separator' },
      { label: 'Réglages…', accelerator: 'Command+,', click: go('settings') },
      { type: 'separator' },
      { label: 'Masquer OxoFlow', role: 'hide' },
      { label: 'Masquer les autres', role: 'hideOthers' },
      { type: 'separator' },
      { label: 'Quitter OxoFlow', accelerator: 'Command+Q', click: quitApp },
    ] },
    { label: 'Édition', submenu: [
      { label: 'Annuler', role: 'undo' }, { label: 'Rétablir', role: 'redo' }, { type: 'separator' },
      { label: 'Couper', role: 'cut' }, { label: 'Copier', role: 'copy' }, { label: 'Coller', role: 'paste' }, { label: 'Tout sélectionner', role: 'selectAll' },
    ] },
    { label: 'Aller', submenu: [
      { label: 'Accueil', accelerator: 'Command+1', click: go('home') },
      { label: 'Historique', accelerator: 'Command+2', click: go('history') },
      { label: 'Dictionnaire', accelerator: 'Command+3', click: go('dictionary') },
      { label: 'Snippets', accelerator: 'Command+4', click: go('snippets') },
      { label: 'Réglages', accelerator: 'Command+5', click: go('settings') },
    ] },
    { label: 'Fenêtre', role: 'windowMenu', submenu: [
      { label: 'Fermer', accelerator: 'Command+W', role: 'close' }, { label: 'Placer dans le Dock', role: 'minimize' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { label: 'Recharger', role: 'reload' }, { label: 'Outils de développement', role: 'toggleDevTools' }]),
    ] },
  ]));
  app.setAboutPanelOptions({ applicationName: 'OxoFlow', applicationVersion: app.getVersion(), credits: 'Dictée vocale 100 % locale · MIT' });
}

function applyTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  if (hub && !hub.isDestroyed()) hub.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0c0c10' : '#f6f5f2');
}

// ---- IPC (hub) --------------------------------------------------------------
ipcMain.handle('ff:get-state', () => buildState());

ipcMain.handle('ff:set-settings', async (_e, patch) => {
  patch = { ...(patch || {}) };
  delete patch.aiEndpoint;          // pinned below, never from the renderer
  if (patch.aiFormat === true && !settings.get().aiEndpoint) {
    // Switching the option on pins the server found now (shown in the settings);
    // later dictations never go to whatever else starts answering on those ports.
    const found = await discover('', { fresh: true });
    if (!found.endpoint) return { ...buildState(), aiError: 'Aucun serveur local trouvé : lance LM Studio (ou Ollama), puis réessaie.' };
    patch.aiEndpoint = found.endpoint;
    log(`ai format: server pinned ${found.endpoint}`);
  }
  if (patch.aiFormat === false) patch.aiEndpoint = '';
  const before = settings.get();
  const next = settings.update(patch);
  if (next.shortcut !== before.shortcut || next.mode !== before.mode) registerShortcut();
  if (next.theme !== before.theme) applyTheme(next.theme);
  if (next.aiFormat && (!before.aiFormat || next.aiModel !== before.aiModel)) warmAi();
  if (next.flowBar !== before.flowBar || next.shortcut !== before.shortcut || next.mode !== before.mode) {
    if (next.flowBar !== false && dictation.phase === 'idle') { showOverlay(); setPhase('idle'); }
    else if (next.flowBar === false && dictation.phase === 'idle' && overlay) overlay.hide();
  }
  if (next.launchAtLogin !== before.launchAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: !!next.launchAtLogin, path: process.execPath, args: app.isPackaged ? [] : [ROOT] }); } catch (e) { log('login item:', e.message); }
  }
  updateTray();
  const state = buildState();
  pushState();
  return state;
});

ipcMain.handle('ff:shortcut-test', (_e, acc) => {
  if (acc === 'Fn') return IS_MAC ? { ok: true } : { ok: false, error: 'La touche fn seule n’est disponible que sur Mac.' };
  const c = parseAccelerator(acc);
  const nMods = [c.ctrl, c.alt, c.shift, c.meta].filter(Boolean).length;
  if (!c.key) {
    if (!pttAvailable) return { ok: false, error: 'Les raccourcis sans touche normale demandent le module uiohook-napi.' };
    if (nMods < 2) return { ok: false, error: `Avec seulement des touches de modification, il en faut au moins deux (ex. ${IS_MAC ? '⌃ + ⌘' : 'Ctrl + Win'}).` };
    return { ok: true };
  }
  if (!nMods && !/^F\d{1,2}$/i.test(c.key)) return { ok: false, error: `Ajoute au moins une touche de modification (${IS_MAC ? '⌃, ⌥, ⇧, ⌘' : 'Ctrl, Alt, Maj, Win'}), ou utilise une touche F1 à F12.` };
  if (settings.get().mode === 'ptt' && pttAvailable) {
    return uiohookKeycode(c.key) != null ? { ok: true } : { ok: false, error: `La touche « ${c.key} » n’est pas reconnue en mode maintenu.` };
  }
  if (acc === settings.get().shortcut && shortcutOk) return { ok: true };
  try {
    const ok = globalShortcut.register(acc, () => {});
    if (ok) globalShortcut.unregister(acc);
    return ok ? { ok } : { ok, error: 'Déjà utilisé par une autre application.' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// While the hub records a shortcut, release the current one so the keys reach the recorder
// (and do not start a dictation).
ipcMain.handle('ff:shortcut-suspend', (_e, on) => {
  const next = !!on;
  if (next !== shortcutSuspended) { shortcutSuspended = next; registerShortcut(); }
  return { suspended: shortcutSuspended, ok: shortcutOk };
});

ipcMain.handle('ff:dictionary', (_e, { action, word, sounds, previous } = {}) => {
  let list = normalizeVocab(dictionary.get());
  const w = String(word || '').trim();
  const snd = parseSounds(sounds);
  const find = (k) => list.find((e) => e.word.toLowerCase() === String(k || '').trim().toLowerCase());
  if (action === 'add' && w) {
    const ex = find(w);
    if (ex) ex.sounds = [...ex.sounds, ...snd]; else list.push({ word: w, sounds: snd });
  }
  if (action === 'update' && w) {
    const ex = find(previous || w);
    if (ex) { ex.word = w; ex.sounds = snd; } else list.push({ word: w, sounds: snd });
  }
  if (action === 'remove') list = list.filter((e) => e.word.toLowerCase() !== w.toLowerCase());
  if (action === 'restore-defaults') {
    const have = new Set(list.map((e) => e.word.toLowerCase()));
    list = [...list, ...normalizeVocab(DEFAULT_VOCAB).filter((e) => !have.has(e.word.toLowerCase()))];
  }
  dictionary.set(normalizeVocab(list));
  pushState();
  return dictionary.get();
});

// Live preview of the formatting + vocabulary on typed text (Dictionnaire > Tester).
ipcMain.handle('ff:format-preview', (_e, text) => {
  const s = settings.get();
  return formatText(String(text || ''), { language: s.language === 'en' ? 'en' : 'fr', snippets: snippets.get(), dictionary: dictionary.get() });
});

ipcMain.handle('ff:snippets', (_e, { action, id, trigger, expansion }) => {
  let list = snippets.get();
  if (action === 'add' && trigger && trigger.trim()) list = [...list, { id: Date.now().toString(36), trigger: trigger.trim(), expansion: String(expansion || '') }];
  if (action === 'update' && trigger && trigger.trim()) list = list.map((x) => (x.id === id ? { ...x, trigger: trigger.trim(), expansion: String(expansion || '') } : x));
  if (action === 'remove') list = list.filter((x) => x.id !== id);
  snippets.set(list);
  pushState();
  return list;
});

ipcMain.handle('ff:history', (_e, { action, id }) => {
  let list = history.get();
  if (action === 'delete') list = list.filter((x) => x.id !== id);
  if (action === 'clear') list = [];
  history.set(list);
  updateTray();
  pushState();
  return list;
});

ipcMain.handle('ff:dictation-toggle', (_e, opts) => { toggleDictation(opts || {}); return dictation.phase; });
ipcMain.handle('ff:dictation-cancel', () => { cancelDictation(); return dictation.phase; });
ipcMain.handle('ff:copy', async (_e, text) => { await clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('ff:open-logs', () => shell.openPath(logDir));
// macOS: ask for the microphone (system dialog the first time, the settings pane once refused).
// Local AI formatting: which server/model would be used, and a dry run on typed text.
ipcMain.handle('ff:ai-status', async () => {
  const s = settings.get();
  const found = await discover(s.aiEndpoint, { fresh: true });
  return { ...found, pinned: s.aiEndpoint || '', model: pickModel(found.models, s.aiModel) };
});
ipcMain.handle('ff:ai-test', async (_e, text) => {
  const s = settings.get();
  try {
    const r = await aiFormat(String(text || ''), { endpoint: s.aiEndpoint, model: s.aiModel, vocabulary: dictionary.get().map((e) => e.word), timeoutMs: 30000 });
    return { ok: true, model: r.model, ms: r.ms, text: formatText(r.text, { language: s.language === 'en' ? 'en' : 'fr', snippets: snippets.get(), dictionary: dictionary.get() }) };
  } catch (e) { return { ok: false, error: e.message }; }
});
// The first request loads the model (several seconds): do it ahead of the first dictation.
function warmAi() {
  const s = settings.get();
  if (!s.aiFormat) return;
  aiFormat('bonjour, ceci est un essai', { endpoint: s.aiEndpoint, model: s.aiModel, timeoutMs: 60000 })
    .then((r) => log(`ai format ready: ${r.model} (${r.ms} ms)`)).catch((e) => log('ai format warm-up:', e.message));
}
ipcMain.handle('ff:open-input-monitoring', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'));
ipcMain.handle('ff:open-keyboard-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension'));
ipcMain.handle('ff:mic-prompt', async () => {
  if (!IS_MAC) return true;
  let ok = false;
  try { ok = systemPreferences.getMediaAccessStatus('microphone') === 'granted' || await systemPreferences.askForMediaAccess('microphone'); } catch (e) { log('microphone prompt:', e.message); }
  if (!ok) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  pushState();
  return ok;
});
// macOS: ask for the Accessibility permission (system dialog) and open the right settings pane.
ipcMain.handle('ff:accessibility-prompt', async () => {
  if (!IS_MAC) return true;
  const ok = systemPreferences.isTrustedAccessibilityClient(true);
  if (!ok) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  pushState();
  return ok;
});
ipcMain.handle('ff:open-path', (_e, p) => shell.openPath(p));

// Dev / verification commands: run the pipeline on a WAV file with paste forced off.
ipcMain.handle('ff:test-pipeline', async (_e, wavPath) => testPipeline(wavPath));
ipcMain.handle('ff:screenshot', async (_e, { which, out }) => takeScreenshot(which, out));

async function testPipeline(wavPath) {
  const wav = fs.readFileSync(wavPath);
  const previousClipboard = await saveClipboard();
  showOverlay();
  setPhase('transcribing');
  dictation.stoppedAt = Date.now();
  try {
    const entry = await runPipeline(wav, { noPaste: true });
    return { ...entry, clipboard: await clipboard.readText() };
  } finally {
    await restoreClipboard(previousClipboard);   // a test must not leave text in the user's clipboard
  }
}

// UI self-test of the shortcut recorder and the vocabulary page. Key events are
// dispatched INSIDE the hub page only (never sent to the OS / other windows).
async function uiTest(dir) {
  const wc = hub.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const shot = async (name) => { await new Promise((r) => setTimeout(r, 350)); const img = await wc.capturePage(); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); };
  const key = (type, code, keyName, mods) => js(`window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}', key: '${keyName}', ctrlKey: ${!!mods.ctrl}, altKey: ${!!mods.alt}, shiftKey: ${!!mods.shift}, metaKey: ${!!mods.meta}, bubbles: true, cancelable: true }))`);
  const original = settings.get().shortcut;
  showHub(); wc.send('ff:navigate', 'settings');
  await shot('01-settings');
  await js(`document.querySelector('#shortcut-record').click()`);
  await shot('02-recording-empty');
  console.log('UI suspended=' + shortcutSuspended);
  await key('keydown', 'ControlLeft', 'Control', { ctrl: true });
  await key('keydown', 'MetaLeft', 'Meta', { ctrl: true, meta: true });
  await shot('03-recording-ctrl-win');
  await key('keyup', 'MetaLeft', 'Meta', { ctrl: true });
  await key('keyup', 'ControlLeft', 'Control', {});
  // a second chord replaces the first one
  await key('keydown', 'ControlLeft', 'Control', { ctrl: true });
  await key('keydown', 'AltLeft', 'Alt', { ctrl: true, alt: true });
  await key('keydown', 'KeyD', 'd', { ctrl: true, alt: true });
  await key('keyup', 'KeyD', 'd', { ctrl: true, alt: true });
  await key('keyup', 'AltLeft', 'Alt', { ctrl: true });
  await key('keyup', 'ControlLeft', 'Control', {});
  await shot('04-recording-ctrl-alt-d');
  await js(`document.querySelector('#shortcut-record').click()`);
  await shot('05-stopped-pending');
  console.log('UI confirmDisabled=' + await js(`document.querySelector('#shortcut-confirm').disabled`) + ' suspended=' + shortcutSuspended);
  await js(`document.querySelector('#shortcut-confirm').click()`);
  await new Promise((r) => setTimeout(r, 600));
  console.log('UI after confirm shortcut=' + settings.get().shortcut + ' ok=' + shortcutOk);
  await shot('06-confirmed');
  // modifier-only chord through the low-level hook
  await js(`document.querySelector('#shortcut-record').click()`);
  await key('keydown', 'ControlLeft', 'Control', { ctrl: true });
  await key('keydown', 'MetaLeft', 'Meta', { ctrl: true, meta: true });
  await key('keyup', 'MetaLeft', 'Meta', { ctrl: true });
  await key('keyup', 'ControlLeft', 'Control', {});
  await js(`document.querySelector('#shortcut-confirm').click()`);
  await new Promise((r) => setTimeout(r, 800));
  console.log('UI modifier-only shortcut=' + settings.get().shortcut + ' ok=' + shortcutOk + ' hook=' + hook.active);
  await shot('07-confirmed-ctrl-win');
  // restore the user's shortcut
  settings.update({ shortcut: original }); registerShortcut(); pushState();
  console.log('UI restored shortcut=' + settings.get().shortcut + ' ok=' + shortcutOk);
  // vocabulary page
  wc.send('ff:navigate', 'dictionary');
  await js(`(() => { const i = document.querySelector('#dict-test'); i.value = "euh j'automatise tout avec N huit N et x field, puis je poste sur tic toc avec post iz"; i.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 500));
  console.log('UI preview=' + await js(`document.querySelector('#dict-test-out').textContent`));
  await shot('08-dictionary');
  console.log('UI vocab entries=' + dictionary.get().length);
  // microphone test meter (run with a fake capture device to get a level)
  wc.send('ff:navigate', 'settings');
  await new Promise((r) => setTimeout(r, 500));
  await js(`document.querySelector('#mic-test').click()`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('UI mic meter=' + await js(`document.querySelector('#mic-meter-fill').style.width + ' visible=' + !document.querySelector('#mic-meter').hidden`));
  await shot('09-mic-meter');
  await js(`document.querySelector('#mic-test').click()`);
}

async function takeScreenshot(which, out) {
  if (which === 'menu') {             // the menu-bar panel, opened as by a click on the icon
    if (!menuWin || !menuWin.isVisible()) toggleMenu();
    await new Promise((r) => setTimeout(r, 900));
    const img = await menuWin.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    hideMenu();
    return out;
  }
  let win = which.startsWith('overlay') ? overlay : hub;
  if (win === hub) {
    // "hub:home@560" = the home section scrolled down by 560 px
    showHub();
    // capturePage cannot see macOS vibrancy: give the sidebar an opaque background in captures.
    hub.webContents.executeJavaScript(`document.documentElement.dataset.capture = '1'`).catch(() => {});
    const [section, scroll] = (which.split(':')[1] || '').split('@');
    if (section === 'onboard') {
      // "hub:onboard@2" = the first-run assistant, two steps in
      setTimeout(() => hub.webContents.executeJavaScript(`document.querySelector('#open-onboard').click();
        for (let i = 0; i < ${Number(scroll) || 0}; i++) (document.querySelector('.ob-pane.show [data-ob-next]') || document.querySelector('#ob-skip')).click();`), 200);
    } else if (section) hub.webContents.send('ff:navigate', section);
    if (scroll && section !== 'onboard') setTimeout(() => hub.webContents.executeJavaScript(`document.querySelector('#content').scrollTop = ${Number(scroll) || 0}`), 400);
  }
  else {
    showOverlay();
    const phase = which.split(':')[1] || 'listening';
    overlaySend('ff:overlay', { phase, demo: true, message: phase === 'error' ? 'Collage bloqué' : undefined, latencyMs: 640, pasted: 'pasted', text: 'La réunion est demain à 11 h, et il faut que tu ramènes le dossier.' });
  }
  await new Promise((r) => setTimeout(r, which.startsWith('overlay') ? 700 : 900));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  return out;
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sidecar.ready) return true;
    if (!sidecar.info.loading && sidecar.info.error) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runDevCommands() {
  try {
    if (argv['test-pipeline']) {
      const ok = await waitReady(240000);
      console.log('TEST_SIDECAR ' + JSON.stringify(sidecar.info));
      log('TEST_SIDECAR ' + JSON.stringify(sidecar.info));
      if (!ok) throw new Error('sidecar not ready: ' + sidecar.info.error);
      const res = await testPipeline(String(argv['test-pipeline']));
      console.log('TEST_PIPELINE_RESULT ' + JSON.stringify(res));
      log('TEST_PIPELINE_RESULT ' + JSON.stringify(res));   // the log file too: Windows GUI apps have no console in CI
    }
    if (argv.screenshots) {
      const dir = typeof argv.screenshots === 'string' ? argv.screenshots : path.join(ROOT, 'screenshots');
      if (argv['wait-ready']) await waitReady(240000);
      await new Promise((r) => setTimeout(r, 1200));
      const list = argv['screenshots-only'] ? String(argv['screenshots-only']).split(',') : null;
      for (const which of list || ['hub:home', 'hub:home@560', 'hub:history', 'hub:settings@1050', 'hub:dictionary', 'hub:snippets', 'hub:settings', 'overlay:listening', 'overlay:transcribing', 'overlay:done', 'overlay:error']) {
        const out = path.join(dir, which.replace(':', '-').replace('@', '-') + '.png');
        await takeScreenshot(which, out);
        console.log('SCREENSHOT ' + out);
      }
      setPhase('idle');
      overlay.hide();
    }
    if (argv['ui-test']) {
      await new Promise((r) => setTimeout(r, 1500));
      await uiTest(String(argv['ui-test']));
      console.log('UI_TEST_DONE');
    }
  } catch (e) {
    console.log('DEV_ERROR ' + (e.stack || e.message));
  }
  if (argv.exit) setTimeout(quitApp, 300);
}

// ---- Lifecycle ---------------------------------------------------------------
async function quitApp() {
  if (quitting) return;
  quitting = true;
  log('quitting');
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  stopHook();
  stopFnHook();
  if (sidecar) await sidecar.stop();
  if (tray) tray.destroy();
  app.exit(0);
}

app.on('second-instance', () => showHub());
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); quitApp(); } });

app.whenReady().then(async () => {
  initStores();
  applyTheme(settings.get().theme);
  log(`OxoFlow ${app.getVersion()} starting (packaged=${app.isPackaged}, electron=${process.versions.electron})`);

  // Microphone permission for our own renderers.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'audioCapture'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'audioCapture');

  if (IS_MAC) {
    // The first getUserMedia would ask anyway; asking up front avoids losing the first dictation to the dialog.
    // Not awaited: an unanswered system dialog must not hold the whole app back.
    // Installed app, first launches: macOS's own dialog points to the Accessibility pane.
    // (On first launch the assistant asks, with an explanation: no dialog out of the blue.)
    if (!DEV_MODE && app.isPackaged && settings.get().onboarded && !systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
    if (!DEV_MODE && settings.get().onboarded && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').then((ok) => { log('microphone access:', ok); pushState(); }).catch((e) => log('microphone access:', e.message));
    }
  }
  try { uiohookMod = require('uiohook-napi'); pttAvailable = !!(uiohookMod && uiohookMod.uIOhook); } catch (e) { pttAvailable = false; log('uiohook-napi unavailable:', e.message); }
  // macOS: the keyboard hook needs the Accessibility permission; without it, push-to-talk stays off.
  if (IS_MAC && pttAvailable && !systemPreferences.isTrustedAccessibilityClient(false)) { pttAvailable = false; log('uiohook: waiting for the Accessibility permission'); }

  const s = settings.get();
  sidecar = new Sidecar({ port: s.sidecarPort, hfHome: s.modelCache, log, appPath: ROOT, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged, token: sidecarToken() });
  sidecar.on('ready', (info) => { log('sidecar ready', info); updateTray(); pushState(); });
  sidecar.on('failed', (err) => { log('sidecar failed', err); updateTray(); pushState(); });
  sidecar.on('exit', () => { updateTray(); pushState(); });
  sidecar.on('progress', () => { updateTray(); pushState(); });

  buildAppMenu();
  readFnUsage();
  createTray();
  createOverlay();
  createHub();
  registerShortcut();
  screen.on('display-metrics-changed', positionOverlay);
  setInterval(watchdog, 1500);
  if (s.showHubAtStart || DEV_MODE) showHub();
  else if (IS_MAC && app.dock) app.dock.hide();
  if (process.env.FREEFLOW_NO_SIDECAR) {
    // UI-only development: skip the engine entirely.
    sidecar.info = { ...sidecar.info, loading: false, error: 'Moteur désactivé (FREEFLOW_NO_SIDECAR)' };
    updateTray();
  } else {
    sidecar.start();
  }
  if (DEV_MODE) runDevCommands();
  warmAi();
});
