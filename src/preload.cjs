const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const result = await ipcRenderer.invoke(channel, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('endnote', {
  account: () => invoke('auth-status'),
  login: () => ipcRenderer.invoke('auth-login'),
  cancelLogin: () => invoke('auth-cancel'),
  models: () => ipcRenderer.invoke('auth-models'),
  logout: () => ipcRenderer.invoke('auth-logout'),
  usage: () => invoke('open-usage'),
  onAuthStep: handle => { ipcRenderer.on('auth-step', (_, value) => handle(value)); },
  open: () => invoke('open-file'),
  scan: options => invoke('scan-records', options),
  cancel: () => invoke('scan-cancel'),
  choose: options => invoke('choose-candidate', options),
  aiCandidate: options => invoke('ai-candidate', options),
  translate: options => invoke('translate-one', options),
  source: url => invoke('open-source', url),
  save: changes => invoke('save-file', changes),
  risSearch: options => invoke('ris-search', options),
  risChoose: options => invoke('ris-choose', options),
  risSuggest: options => invoke('ris-suggest', options),
  risEnrich: options => invoke('ris-enrich', options),
  risLink: options => invoke('ris-link', options),
  risSave: options => invoke('ris-save', options),
  risStylePreview: options => invoke('ris-style-preview', options),
  risStyleCopy: options => invoke('ris-style-copy', options),
  styleList: () => invoke('style-list'),
  styleSearch: options => invoke('style-search', options),
  styleInstall: options => invoke('style-install', options),
  styleSource: options => invoke('style-source', options),
  styleGuide: options => invoke('style-guide', options),
  styleSaveGuide: () => invoke('style-save-guide'),
  styleSaveVariation: options => invoke('style-save-variation', options),
  batchOpen: options => invoke('batch-open', options),
  batchPreview: options => invoke('batch-preview', options),
  batchChat: options => invoke('batch-chat', options),
  batchOutput: options => invoke('batch-output', options),
  onBatchProgress: handle => { ipcRenderer.on('batch-progress', (_, value) => handle(value)); },
  onRisUpdate: handle => { ipcRenderer.on('ris-update', (_, value) => handle(value)); },
  onResult: handle => { ipcRenderer.on('review-result', (_, value) => handle(value)); },
  onProgress: handle => { ipcRenderer.on('review-progress', (_, value) => handle(value)); }
});
