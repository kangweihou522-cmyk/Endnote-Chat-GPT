const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, shell, clipboard, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { readRecords, exportChanges } = require('./endnote.cjs');
const { providers } = require('./sources.cjs');
const { inspectRecord, pickFields, sourceDetails } = require('./review.cjs');
const { createDesktopAuth, translateTitles, suggestCandidate } = require('./chatgpt.cjs');

const { titleRecord, pickRisFields, risData, risTags, serializeRis, risFileName } = require('./ris.cjs');
const { findFullText } = require('./fulltext.cjs');
const { registerFormatting } = require('./formatting.cjs');

const ENTRY = path.join(__dirname, 'index.html');
const ALLOWED_LANGUAGES = ['Simplified Chinese', 'English'];
const MAX_XML = 50 * 1024 * 1024;
const AUTH_STEPS = {
  browser: '浏览器授权', exchange: '交换授权令牌', identity: '验证账号身份',
  permissions: '检查套餐权限', storage: '保存本机授权', models: '读取模型目录',
  refresh: '刷新授权令牌', generation: '请求 ChatGPT 模型', revoke: '撤销授权'
};

let window;
let auth;
let catalog = [];
let login;
let scan;
let session;
let risSession;
let recentRis;
let formatting;
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
    catch (error) {
      return {
        ok: false, error: error.message || '操作失败。',
        diagnostic: describeAuthFailure(error)
      };
    }
  });
}

function describeAuthFailure(error) {
  if (!Object.hasOwn(AUTH_STEPS, error.stage)) return '';
  return [
    AUTH_STEPS[error.stage],
    Number.isInteger(error.status) && error.status >= 100 && error.status < 600 ? 'HTTP ' + error.status : '',
    error.webpage ? '返回网页' : '',
    /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : '',
    /^ERR_[A-Z_]{1,80}$/.test(error.networkCode || '') ? error.networkCode : '',
    /^req_[A-Za-z0-9_-]{1,96}$/.test(error.requestId || '') ? error.requestId : ''
  ].filter(Boolean).join(' · ');
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
  try { catalog = await auth.listModels({ signal }); }
  catch (error) { error.stage ||= 'models'; throw error; }
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

function setTranslation(field, proposed) {
  Object.assign(field, {
    proposed, status: 'ai', canApply: true,
    sources: [{ name: 'ChatGPT', url: '' }], note: '机器翻译，建议核对术语。'
  });
}

async function applyTranslations(batch, language, model, signal) {
  const translations = await translateTitles(auth, batch.map(item => item.original), language, model, signal);
  batch.forEach(({ index, result, field }, position) => {
    const proposed = translations[position];
    if (!proposed) return;
    setTranslation(field, proposed);
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

function risState(job) {
  return {
    ...publicResult(0, job.result),
    links: job.links,
    pdfWarning: job.pdfWarning,
    aiWarning: job.aiWarning
  };
}

async function saveOutput(target, content) {
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

function currentRis(requireMatch = true) {
  const job = risSession;
  if (!job || (requireMatch && !job.result.fields.length)) throw new Error('请先确认一篇论文。');
  return job;
}

function registerRisHandlers() {
  const sources = providers();
  register('ris-search', ({ title, language }) => withScan(async signal => {
    risSession = undefined;
    const record = titleRecord(title);
    const result = await inspectRecord(record, sources, validLanguage(language), signal);
    if (result.selected !== null && result.candidates?.[result.selected]) {
      result.fields = pickRisFields(record, result.candidates[result.selected].group, validLanguage(language));
    }
    risSession = { record, result, links: [], pdfWarning: '', aiWarning: '' };
    return risState(risSession);
  }));

  register('ris-choose', ({ candidate, language }) => {
    if (scan) throw new Error('请等待当前查询结束。');
    const job = currentRis(false);
    const choice = Number.isInteger(candidate) && job.result.candidates?.[candidate];
    if (!choice) throw new Error('请选择列表中的论文。');
    Object.assign(job.result, {
      selected: candidate, status: 'matched', note: '',
      fields: pickRisFields(job.record, choice.group, validLanguage(language))
    });
    job.links = [];
    job.pdfWarning = '';
    job.aiWarning = '';
    return risState(job);
  });

  register('ris-suggest', ({ model }) => withScan(async signal => {
    const job = currentRis(false);
    if (!job.result.candidates?.length) throw new Error('暂无可核对的候选。');
    job.result.ai = await suggestCandidate(auth, job.record, job.result.candidates, getModel(true, model), signal);
    return risState(job);
  }));

  register('ris-enrich', ({ translate, model, language }) => withScan(async signal => {
    const job = currentRis();
    const candidate = job.result.candidates[job.result.selected];
    const pdf = findFullText(candidate.group, signal).then(({ links, warning }) => {
      signal.throwIfAborted();
      job.links = links;
      job.pdfWarning = warning;
      emit('ris-update', risState(job));
    });
    const pending = translate && translationEntry(0, job.result);
    const ai = pending ? (async () => {
      try {
        const [translated] = await translateTitles(auth, [pending.original], validLanguage(language), getModel(true, model), signal);
        if (translated) setTranslation(pending.field, translated);
      } catch (error) {
        signal.throwIfAborted();
        job.aiWarning = [error.message, describeAuthFailure(error)].filter(Boolean).join(' · ');
      }
    })() : null;
    await Promise.all([pdf, ai]);
    return risState(job);
  }));

  register('ris-link', async ({ url, copy }) => {
    const link = currentRis().links.find(item => item.url === url);
    if (!link) throw new Error('此链接不在当前论文的查询结果中。');
    if (copy) clipboard.writeText(link.url);
    else await shell.openExternal(link.url);
  });

  function currentTags(approved) {
    const job = currentRis();
    return risTags(risData(job.result.fields, Array.isArray(approved) ? approved : []), job.links);
  }

  register('ris-style-preview', ({ approved, profileId }) => formatting.preview(currentTags(approved), profileId));
  register('ris-style-copy', async ({ approved, profileId }) => {
    const citation = await formatting.preview(currentTags(approved), profileId);
    clipboard.write({ text: citation.text, html: citation.html });
  });

  register('ris-save', async ({ approved, profileId }) => {
    const job = currentRis();
    const { tags, profileName } = await formatting.adjusted(currentTags(approved), profileId);
    const content = serializeRis([tags]);
    const title = job.result.fields.find(field => field.key === 'title')?.proposed;
    const filename = profileName ? (title || '').slice(0, 55) + '_' + profileName : title;
    const save = await dialog.showSaveDialog(window, {
      title: '保存 RIS 文献', defaultPath: risFileName(filename),
      filters: [{ name: 'RIS', extensions: ['ris'] }]
    });
    if (save.canceled) return null;
    const target = /\.ris$/i.test(save.filePath) ? save.filePath : save.filePath + '.ris';
    await saveOutput(target, content);
    recentRis = target;
    return path.basename(target);
  });
}

function registerHandlers() {
  registerRisHandlers();
  register('auth-status', accountState);
  register('auth-login', async () => {
    if (login || scan) throw new Error('请等待当前操作完成。');
    login = new AbortController();
    catalog = [];
    try {
      await auth.login({ signal: login.signal, onStep: step => emit('auth-step', step) });
      emit('auth-step', 'models');
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
    await saveOutput(outputPath, exportChanges(session, selected));
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
    auth = createDesktopAuth({ shell, safeStorage, userData: app.getPath('userData'), http: net.fetch });
    formatting = registerFormatting({
      register, dialog, clipboard, shell, getWindow: () => window, userData: app.getPath('userData'),
      http: net.fetch, saveOutput, withScan, modelFor: getModel, auth, emit,
      getRecent: () => recentRis, setRecent: file => { recentRis = file; }, sources: providers()
    });
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
