'use strict';
// Context-isolated bridge between the renderers (hub / overlay) and main.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_SEND = new Set(['ff:audio-done', 'ff:audio-error', 'ff:overlay-ready', 'ff:hub-ready']);
const ALLOWED_ON = new Set(['ff:state', 'ff:dictation', 'ff:insert', 'ff:overlay', 'ff:rec-start', 'ff:rec-stop', 'ff:rec-cancel', 'ff:navigate']);

contextBridge.exposeInMainWorld('freeflow', {
  platform: process.platform,   // known before the first state push: the hub lays itself out per OS
  invoke: (channel, ...args) => {
    if (typeof channel !== 'string' || !channel.startsWith('ff:')) return Promise.reject(new Error('bad channel'));
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    if (ALLOWED_SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel, cb) => {
    if (!ALLOWED_ON.has(channel)) return () => {};
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
