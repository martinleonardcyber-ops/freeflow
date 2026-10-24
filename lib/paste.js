'use strict';
// Simulated paste through native/PasteHelper.exe (SendInput, Windows) or
// native/PasteHelperMac (CGEvent Cmd+V, macOS). Mirrors Wispr's
// PasteText -> PasteOutcome {pasted|blocked|failed} with per-app overrides.
const { execFile } = require('child_process');

// Per-app overrides keyed by foreground process name (lowercase, no .exe).
// Wispr keeps a similar list (bundle IDs / windowsUri for Slack, Teams, Telegram,
// Discord, Signal...). Terminals want Shift+Insert, chat apps a longer delay.
const PER_APP = {
  windowsterminal: { shiftInsert: true },
  mintty: { shiftInsert: true },
  conhost: { shiftInsert: true },
  cmd: { shiftInsert: true },
  powershell: { shiftInsert: true },
  pwsh: { shiftInsert: true },
  alacritty: { shiftInsert: true },
  wezterm: { shiftInsert: true },
  slack: { delayMs: 120 },
  teams: { delayMs: 120 },
  'ms-teams': { delayMs: 120 },
  telegram: { delayMs: 100 },
  discord: { delayMs: 100 },
  signal: { delayMs: 100 },
};

function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      let out = null;
      try { out = JSON.parse(String(stdout).trim().split(/\r?\n/).pop()); } catch { /* ignore */ }
      if (!out) out = { outcome: err ? 'failed' : 'unknown', error: err ? String(err.message) : undefined };
      if (err && err.code && !out.exitCode) out.exitCode = err.code;
      resolve(out);
    });
  });
}

async function probeForeground(exe) {
  return run(exe, ['--info']);
}

/**
 * @param {string} exe path to PasteHelper.exe
 * @param {{dryRun?:boolean, delayMs?:number, shiftInsert?:boolean, log?:Function}} opts
 */
async function paste(exe, opts = {}) {
  const log = opts.log || (() => {});
  const fg = await probeForeground(exe);
  const proc = String(fg.process || '').toLowerCase();
  const override = PER_APP[proc] || {};
  const delayMs = override.delayMs ?? opts.delayMs ?? 60;
  // Shift+Insert is a Windows terminal convention; macOS terminals take Cmd+V.
  const shiftInsert = process.platform === 'win32' && (override.shiftInsert ?? opts.shiftInsert ?? false);
  const args = ['--delay', String(delayMs)];
  if (shiftInsert) args.push('--shift-insert');
  if (opts.dryRun) args.push('--dry-run');
  const res = await run(exe, args);
  log(`paste -> ${res.outcome}${res.reason ? ` (${res.reason})` : ''} (app=${fg.process || '?'} mode=${shiftInsert ? 'Shift+Insert' : process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V'} delay=${delayMs}ms)`);
  return { ...res, process: fg.process, title: fg.title, shiftInsert, delayMs };
}

module.exports = { paste, probeForeground, PER_APP };
