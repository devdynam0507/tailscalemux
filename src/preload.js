'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // tailscale
  listProfiles: () => ipcRenderer.invoke('ts:list'),
  status: () => ipcRenderer.invoke('ts:status'),
  switchTo: (id) => ipcRenderer.invoke('ts:switch', id),
  // iterm
  openIterm: (tailnet) => ipcRenderer.invoke('iterm:open', { tailnet }),
  // tmux
  tmuxInfo: () => ipcRenderer.invoke('tmux:available'),
  tmuxList: () => ipcRenderer.invoke('tmux:list'),
  tmuxAttach: (session, size) => ipcRenderer.invoke('tmux:attach', { session, ...size }),
  tmuxAction: (type, opts) => ipcRenderer.invoke('tmux:action', { type, ...opts }),
  // hosts (remote machines)
  hostsLoad: () => ipcRenderer.invoke('hosts:load'),
  hostsUpsert: (host) => ipcRenderer.invoke('hosts:upsert', host),
  hostsRemove: (id) => ipcRenderer.invoke('hosts:remove', id),
  hostConnect: (host, size) => ipcRenderer.invoke('hosts:connect', { host, ...size }),
  // clipboard + menu
  clipWrite: (text) => ipcRenderer.invoke('clip:write', text),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  // terminal
  termStart: (size) => ipcRenderer.send('term:start', size),
  termInput: (data) => ipcRenderer.send('term:input', data),
  termResize: (size) => ipcRenderer.send('term:resize', size),
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', () => cb()),
});
