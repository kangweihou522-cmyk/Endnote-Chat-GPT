const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { readRecords, exportChanges } = require('./endnote.cjs');
const { providers } = require('./sources.cjs');
const { inspectRecord, pickFields, sourceDetails } = require('./review.cjs');
const { createDesktopAuth, translateTitles, suggestCandidate } = require('./chatgpt.cjs');

const ENTRY = path.join(__dirname, 'index.html');
const ALLOWED_LANGUAGES = ['Simplified Chinese', 'English'];
const MAX_XML = 50 * 1024 * 1024;

let window;
let auth;
let catalog = [];
let login;
let scan;
let session;
let resultMap = new Map();

function createWindow() {
  window = new BrowserWindow({
    width: 1240, height: 830, minWidth: 960, minHeight: 640,
    backgroundColor: '#f5f7fa',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => {
    scan?.abort();
    login?.abort();
    window = null;
  });
  return window.loadFile(ENTRY);
}

function register(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(ENTRY).href) {
      throw new Error('无效的应用窗口。');
    }
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作失败。' }; }
  });
}

function emit(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function publicResult(index, result) {
  return {
    index, status: result.status, note: result.note, warning: result.warning, selected: result.selected,
    fields: result.fields, ai: result.ai,
    candidates: result.candidates?.map(({ group }) => {
      const first = group[0];
      return { title: first.title, author: first.authors[0], year: first.year, journal: first.journal,
        doi: group.find(work => work.doi)?.doi, sources: sourceDetails(group) };
    })
  };
}

function accountState() {
  return auth.status().then(status => ({ connected: status.connected, email: status.accountLabel, models: catalog }));
}

async function renewCatalog(signal) {
  catalog = [];
  catalog = await auth.listModels({ signal });
  return accountState();
}

async function withScan(task) {
  if (scan) throw new Error('已有检查任务正在运行。');
  scan = new AbortController();
  try { return await task(scan.signal); }
  catch (error) {
    if (scan.signal.aborted) return { cancelled: true };
    throw error;
  } finally { scan = null; }
}

function getModel(enable, model) {
  if (!enable) return '';
  if (!catalog.some(item => item.id === model)) throw new Error('请连接 ChatGPT 订阅并选择账户模型。');
  return model;
}

function validLanguage(language) {
  return ALLOWED_LANGUAGES.includes(language) ? language : ALLOWED_LANGUAGES[0];
}

function recordAt(index) {
  const record = Number.isSafeInteger(index) && session?.records[index];
  if (!record) throw new Error('请先打开并选择 EndNote 条目。');
  return record;
}

function publishResult(index, result) {
  resultMap.set(index, result);
  emit('review-result', publicResult(index, result));
}

function translationEntry(index, result) {
  const field = result.fields?.find(item => item.key === 'translatedTitle');
  const title = result.fields?.find(item => item.key === 'title');
  if (!field || field.old || field.proposed || title?.status === 'review') return null;
  const original = title?.proposed || title?.old;
  return original ? { index, result, field, original } : null;
}

async function applyTranslations(batch, language, model, signal) {
  const translations = await translateTitles(auth, batch.map(item => item.original), language, model, signal);
  batch.forEach(({ index, result, field }, position) => {
    const proposed = translations[position];
    if (!proposed) return;
    Object.assign(field, {
      proposed, status: 'ai', canApply: true,
      sources: [{ name: 'ChatGPT', url: '' }], note: '机器翻译，建议核对术语。'
    });
    publishResult(index, result);
  });
}

async function scanRecords({ translate, model, language }, signal) {
  if (!session) throw new Error('请先打开 EndNote XML。');
  const preferred = validLanguage(language);
  const selectedModel = getModel(translate, model);
  const sources = providers();
  const queue = [];
  resultMap = new Map();
  let done = 0;
  let aiError = '';
  for (const record of session.records) {
    signal.throwIfAborted();
    const result = await inspectRecord(record, sources, preferred, signal);
    publishResult(record.index, result);
    emit('review-progress', { stage: 'metadata', done: ++done, total: session.records.length });
    if (selectedModel) {
      const pending = translationEntry(record.index, result);
      if (pending) queue.push(pending);
    }
  }
  if (queue.length) {
    emit('review-progress', { stage: 'translation', done: 0, total: queue.length });
    for (let start = 0; start < queue.length; start += 6) {
      signal.throwIfAborted();
      const batch = queue.slice(start, start + 6);
      try {
        await applyTranslations(batch, preferred, selectedModel, signal);
      } catch (error) {
        signal.throwIfAborted();
        aiError = error.message;
        break;
      }
      emit('review-progress', { stage: 'translation', done: start + batch.length, total: queue.length });
    }
  }
  return { aiError };
}

function registerHandlers() {
  register('auth-status', accountState);
  register('auth-login', async () => {
    if (login || scan) throw new Error('请等待当前操作完成。');
    login = new AbortController();
    catalog = [];
    try {
      await auth.login({ signal: login.signal });
      return await renewCatalog(login.signal);
    } finally { login = null; }
  });
  register('auth-cancel', () => login?.abort());
  register('auth-models', async () => {
    if (login || scan) throw new Error('请等待当前操作完成。');
    return renewCatalog();
  });
  register('auth-logout', async () => {
    if (login || scan) throw new Error('请等待当前操作完成。');
    catalog = [];
    const status = await auth.logout();
    return { ...await accountState(), message: status.message };
  });
  register('open-usage', () => shell.openExternal('https://chatgpt.com/settings/usage'));

  register('open-file', async () => {
    if (scan) throw new Error('请等待当前检查完成。');
    const opened = await dialog.showOpenDialog(window, {
      title: '选择 EndNote 导出的 XML', properties: ['openFile'], filters: [{ name: 'EndNote XML', extensions: ['xml'] }]
    });
    if (opened.canceled) return null;
    const file = opened.filePaths[0];
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_XML) throw new Error('请选择 50 MB 以内的 XML 文件。');
    session = { ...readRecords(await fs.readFile(file)), file };
    resultMap = new Map();
    return { fileName: path.basename(file), records: session.records };
  });

  register('scan-records', async options => {
    const result = await withScan(signal => scanRecords(options, signal));
    const summary = { matched: 0, ambiguous: 0, failed: 0 };
    for (const record of resultMap.values()) {
      if (record.status in summary) summary[record.status]++;
    }
    return { ...result, summary };
  });

  register('scan-cancel', () => scan?.abort());

  register('choose-candidate', ({ index, candidate, language }) => {
    if (scan) throw new Error('请等待当前检查完成。');
    const record = recordAt(index);
    const result = resultMap.get(index);
    if (!Number.isSafeInteger(candidate) || !result?.candidates?.[candidate]) throw new Error('请选择有效候选。');
    result.selected = candidate;
    result.status = 'matched';
    result.note = '';
    result.fields = pickFields(record, result.candidates[candidate].group, validLanguage(language));
    return publicResult(index, result);
  });

  register('ai-candidate', ({ index, model }) => withScan(async signal => {
    const record = recordAt(index);
    const result = resultMap.get(index);
    if (!result?.candidates?.length) throw new Error('没有可供核对的候选。');
    result.ai = await suggestCandidate(auth, record, result.candidates, getModel(true, model), signal);
    return publicResult(index, result);
  }));

  register('translate-one', ({ index, language, model }) => withScan(async signal => {
    recordAt(index);
    const result = resultMap.get(index);
    const pending = result && translationEntry(index, result);
    if (!pending) throw new Error('请先确认题名及文献匹配。');
    await applyTranslations([pending], validLanguage(language), getModel(true, model), signal);
    return publicResult(index, result);
  }));

  register('open-source', async raw => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['doi.org', 'pubmed.ncbi.nlm.nih.gov'].includes(url.hostname)) throw new Error('无效的来源地址。');
    await shell.openExternal(url.href);
  });

  register('save-file', async requested => {
    if (!session || scan) throw new Error('请先完成检查。');
    if (!Array.isArray(requested)) throw new Error('请先选择要导出的字段。');
    const selected = new Map();
    for (const [index, keys] of requested) {
      const result = resultMap.get(index);
      if (!result?.fields || !Array.isArray(keys)) continue;
      const changes = result.fields.filter(field => field.canApply && keys.includes(field.key));
      if (changes.length) selected.set(index, changes);
    }
    if (!selected.size) throw new Error('没有选中的字段。');
    const opened = await dialog.showSaveDialog(window, {
      title: '导出补全后的条目', defaultPath: path.join(path.dirname(session.file),
        path.basename(session.file, path.extname(session.file)) + '-补全.xml'),
      filters: [{ name: 'EndNote XML', extensions: ['xml'] }]
    });
    if (opened.canceled) return null;
    const outputPath = path.resolve(opened.filePath);
    const canonicalInput = await fs.realpath(session.file);
    const canonicalOutput = await fs.realpath(outputPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return outputPath;
    });
    const absolute = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
    if (absolute(canonicalInput) === absolute(canonicalOutput)) throw new Error('请使用新文件名保存补全后的条目。');
    const temporary = outputPath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, exportChanges(session, selected), { mode: 0o600, flag: constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL });
      await fs.rename(temporary, outputPath);
    } finally { await fs.rm(temporary, { force: true }); }
    return { count: selected.size, fileName: path.basename(outputPath) };
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
    auth = createDesktopAuth({ shell, safeStorage, userData: app.getPath('userData') });
    registerHandlers();
    return createWindow();
  }).catch(error => {
    dialog.showErrorBox('EndNote ChatGPT', error.message);
    app.quit();
  });
  app.on('activate', () => { if (!window && auth) void createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => auth?.dispose());
}
