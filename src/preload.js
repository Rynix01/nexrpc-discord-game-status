const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexrpc', {
  getState: () => ipcRenderer.invoke('state:get'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  addAccount: (data) => ipcRenderer.invoke('account:add', data),
  updateAccount: (data) => ipcRenderer.invoke('account:update', data),
  setAccountToken: (data) => ipcRenderer.invoke('account:set-token', data),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  connectAccount: (id) => ipcRenderer.invoke('account:connect', id),
  disconnectAccount: (id) => ipcRenderer.invoke('account:disconnect', id),
  connectAll: () => ipcRenderer.invoke('account:connect-all'),
  disconnectAll: () => ipcRenderer.invoke('account:disconnect-all'),

  saveProfile: (data) => ipcRenderer.invoke('profile:save', data),
  removeProfile: (id) => ipcRenderer.invoke('profile:remove', id),
  exportProfile: (id) => ipcRenderer.invoke('profile:export', id),
  importProfile: () => ipcRenderer.invoke('profile:import'),

  applyPresence: (data) => ipcRenderer.invoke('presence:apply', data),
  clearPresence: (accountId) => ipcRenderer.invoke('presence:clear', accountId),

  saveSchedule: (data) => ipcRenderer.invoke('schedule:save', data),
  removeSchedule: (id) => ipcRenderer.invoke('schedule:remove', id),

  updateSettings: (data) => ipcRenderer.invoke('settings:update', data),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  onState: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },
  onLog: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('log:new', handler);
    return () => ipcRenderer.removeListener('log:new', handler);
  }
});
