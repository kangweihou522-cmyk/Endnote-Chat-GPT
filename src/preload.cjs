const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const result = await ipcRenderer.invoke(channel, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('endnote', {
  account: () => invoke('auth-status'),
  login: () => invoke('auth-login'),
  cancelLogin: () => invoke('auth-cancel'),
  models: () => invoke('auth-models'),
  logout: () => invoke('auth-logout'),
  usage: () => invoke('open-usage'),
  open: () => invoke('open-file'),
  scan: options => invoke('scan-records', options),
  cancel: () => invoke('scan-cancel'),
  choose: options => invoke('choose-candidate', options),
  aiCandidate: options => invoke('ai-candidate', options),
  translate: options => invoke('translate-one', options),
  source: url => invoke('open-source', url),
  save: changes => invoke('save-file', changes),
  onResult: handle => { ipcRenderer.on('review-result', (_, value) => handle(value)); },
  onProgress: handle => { ipcRenderer.on('review-progress', (_, value) => handle(value)); }
});
