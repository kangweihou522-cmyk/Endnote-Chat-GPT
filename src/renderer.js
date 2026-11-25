const byId = id => document.getElementById(id);
const api = window.endnote;
const notice = byId('notice');
const progress = byId('progress');
const model = byId('model');
const translate = byId('translate');
const language = byId('language');
const review = byId('review');

const results = new Map();
const selectedFields = new Map();
const rows = new Map();
let records = [];
let currentIndex = null;
let busy = '';
let accountBusy = '';
let accountConnected = false;
let fileName = '';
let hasModels = false;

const resultLabels = {
  skipped: '已跳过', missing: '未匹配', ambiguous: '待确认', failed: '查询失败'
};

const fieldLabels = {
  change: '可补全', review: '待确认', ai: '机器翻译',
  verified: '已核对', missing: '未收录', unverified: '暂无来源'
};

function make(tag, content, className) {
  const element = document.createElement(tag);
  if (content) element.textContent = content;
  if (className) element.className = className;
  if (tag === 'button') element.type = 'button';
  return element;
}

function asText(value) {
  return (Array.isArray(value) ? value.join('\n') : value) || '—';
}

function showCitation(target, sanitizedHtml) {
  const document = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
  for (const link of document.querySelectorAll('a')) link.removeAttribute('href');
  target.replaceChildren(...document.body.childNodes);
}

function inform(text, error = false) {
  notice.textContent = text;
  notice.parentElement.classList.toggle('error', error);
}

function sync() {
  const actionable = [...selectedFields.values()].filter(fields => fields.size).length;
  byId('open').disabled = Boolean(busy);
  byId('scan').disabled = Boolean(busy) || Boolean(accountBusy) || !records.some(record => record.supported);
  byId('save').disabled = Boolean(busy) || !actionable;
  byId('save').textContent = actionable ? '导出已选修改（' + actionable + '）' : '导出已选修改';
  byId('cancel').hidden = !['scan', 'ai'].includes(busy);
  byId('cancel').textContent = busy === 'ai' ? '取消 ChatGPT 请求' : '停止检查';
  byId('login').disabled = Boolean(busy) || Boolean(accountBusy && accountBusy !== 'login');
  byId('logout').disabled = Boolean(busy || accountBusy);
  byId('models').disabled = Boolean(busy || accountBusy);
  model.disabled = !hasModels || Boolean(busy || accountBusy);
  translate.disabled = !hasModels || Boolean(busy || accountBusy);
  language.disabled = Boolean(busy);
  for (const id of ['mode-ris', 'mode-xml', 'mode-batch']) byId(id).disabled = Boolean(busy || accountBusy);
  window.syncRis?.();
  window.syncBatch?.();
  window.styleControls?.sync();
}

for (const mode of ['ris', 'xml', 'batch']) {
  byId('mode-' + mode).addEventListener('click', () => {
    for (const view of ['ris', 'xml', 'batch']) {
      byId('mode-' + view).setAttribute('aria-pressed', String(view === mode));
      byId(view + '-workspace').hidden = view !== mode;
    }
    for (const id of ['xml-toolbar', 'xml-status']) byId(id).hidden = mode !== 'xml';
  });
}

function activeAccount(state, applyDefault = false) {
  accountConnected = state.connected;
  hasModels = state.connected && state.models.length > 0;
  byId('account-summary').textContent = hasModels ? 'ChatGPT 已授权' :
    state.connected ? 'ChatGPT 已授权 · 模型待连接' : '连接 ChatGPT';
  byId('account-status').textContent = state.message || (state.connected ?
    (hasModels ? '已授权 ChatGPT 订阅额度' + (state.email ? ' · ' + state.email.replace(/ · \d+$/, '') : '') :
      '账号已授权。可点击「刷新模型」读取可用模型。') :
    '登录 OpenAI 并授权使用你的 ChatGPT 套餐。');
  byId('login').textContent = state.connected ? '重新连接' : 'Continue with ChatGPT';
  byId('logout').hidden = !state.connected;
  byId('models').hidden = !state.connected;
  const previous = model.value;
  model.replaceChildren(...state.models.map(item => new Option(item.name, item.id)));
  if (!hasModels) model.add(new Option(state.connected ? '请刷新账户模型' : '请先登录', ''));
  else if (state.models.some(item => item.id === previous)) model.value = previous;
  if (!hasModels || applyDefault) translate.checked = hasModels;
  sync();
}

async function accountOperation(action) {
  accountBusy = action;
  const diagnostic = byId('account-diagnostic');
  diagnostic.hidden = true;
  diagnostic.textContent = '';
  if (action === 'login') {
    byId('login').textContent = '取消登录';
    byId('account-status').textContent = '请在默认浏览器中完成 OpenAI 登录并授权，然后返回此窗口。';
  } else if (action === 'models') byId('account-status').textContent = '正在读取可用模型…';
  sync();
  try {
    const result = await api[action]();
    if (!result.ok) throw Object.assign(new Error(result.error), { diagnostic: result.diagnostic });
    activeAccount(result.value, action === 'login' || (!hasModels && action === 'models'));
  } catch (error) {
    const state = await api.account().catch(() => null);
    if (state) activeAccount(state);
    byId('account-status').textContent = error.message;
    if (error.diagnostic) {
      diagnostic.textContent = error.diagnostic;
      diagnostic.hidden = false;
    }
  } finally {
    accountBusy = '';
    byId('login').textContent = accountConnected ? '重新连接' : 'Continue with ChatGPT';
    sync();
    renderReview();
  }
}

api.onAuthStep(step => {
  if (accountBusy !== 'login') return;
  const status = {
    exchange: '已收到浏览器回传，正在交换授权令牌…',
    identity: '正在验证 ChatGPT 账号身份…',
    models: '账号已授权，正在读取可用模型…'
  }[step];
  if (status) byId('account-status').textContent = status;
});

function rowState(index) {
  const row = rows.get(index);
  if (!row) return;
  const record = records[index];
  const item = results.get(index);
  const changes = selectedFields.get(index)?.size || 0;
  const state = item?.status === 'matched' ? (changes ? changes + ' 项已勾选' : '已检查') :
    (resultLabels[item?.status] || (!record.supported ? '非期刊论文' : '待检查'));
  row.detail.textContent = [record.number ? '#' + record.number : null, record.data.year, state].filter(Boolean).join(' · ');
  row.button.setAttribute('aria-current', index === currentIndex ? 'true' : 'false');
}

function setResult(result, reset = false) {
  const index = result.index;
  const prior = results.get(index);
  results.set(index, result);
  if (!prior || reset || prior.selected !== result.selected) {
    selectedFields.set(index, new Set((result.fields || []).filter(field =>
      field.canApply && ['change', 'ai'].includes(field.status)).map(field => field.key)));
  } else if (result.fields?.some(field => field.key === 'translatedTitle' && field.status === 'ai') &&
    !prior.fields?.some(field => field.key === 'translatedTitle' && field.status === 'ai')) {
    selectedFields.get(index)?.add('translatedTitle');
  }
  rowState(index);
  if (index === currentIndex) renderReview();
  sync();
}

function resourceLink(source) {
  if (!source.url) return make('span', source.name, 'field-note');
  const link = make('button', source.name, 'link');
  link.title = source.url;
  link.addEventListener('click', () => void api.source(source.url).catch(error => inform(error.message, true)));
  return link;
}

function selectedOptions() {
  return { index: currentIndex, language: language.value, model: model.value };
}

async function requestAi(action) {
  const options = selectedOptions();
  busy = 'ai';
  sync();
  renderReview();
  inform(action === 'translate' ? '正在生成译名…' : '正在核对候选…');
  try {
    const response = await api[action](options);
    if (!response.cancelled) setResult(response);
    inform(response.cancelled ? '已停止。' : 'ChatGPT 检查完成。');
  } catch (error) { inform(error.message, true); }
  finally { busy = ''; sync(); renderReview(); }
}

function candidatePanel(item) {
  const section = make('div', null, 'candidates');
  if (item.ai) section.append(make('p', (item.ai.index ? 'ChatGPT 建议检查候选 ' + item.ai.index : 'ChatGPT 无法确认候选') +
    ' · ' + item.ai.reason, 'muted'));
  item.candidates.forEach((candidate, index) => {
    const card = make('div', null, 'candidate');
    const detail = [candidate.author, candidate.journal, candidate.year, candidate.doi].filter(Boolean).join(' · ');
    card.append(make('h3', (index + 1) + '. ' + candidate.title), make('p', detail));
    const links = make('div', null, 'candidate-links');
    links.append(...candidate.sources.map(resourceLink));
    const choose = make('button', '使用此候选');
    choose.disabled = Boolean(busy);
    choose.addEventListener('click', async () => {
      const options = { ...selectedOptions(), candidate: index };
      try { setResult(await api.choose(options), true); }
      catch (error) { inform(error.message, true); }
    });
    links.append(choose);
    card.append(links);
    section.append(card);
  });
  return section;
}

function resultTable(item) {
  const table = make('table');
  const head = table.createTHead().insertRow();
  for (const heading of ['应用', '字段', '原值', '建议值', '来源']) head.append(make('th', heading));
  const body = table.createTBody();
  const selected = selectedFields.get(item.index) || new Set();
  for (const field of item.fields) {
    const row = body.insertRow();
    const check = make('input');
    check.type = 'checkbox';
    check.setAttribute('aria-label', '应用' + field.label);
    check.checked = selected.has(field.key);
    check.disabled = !field.canApply || Boolean(busy);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(field.key);
      else selected.delete(field.key);
      rowState(item.index);
      sync();
    });
    row.insertCell().append(check);
    row.insertCell().append(make('div', field.label), make('span', fieldLabels[field.status], 'field-status ' + field.status));
    row.insertCell().textContent = asText(field.old);
    const suggestion = row.insertCell();
    suggestion.textContent = asText(field.proposed);
    if (field.note) suggestion.append(make('small', field.note, 'field-note'));
    const source = row.insertCell();
    source.append(...field.sources.map(resourceLink));
    if (!field.sources.length) source.textContent = '—';
  }
  return table;
}

function renderReview() {
  const record = records[currentIndex];
  if (!record) return;
  const item = results.get(currentIndex);
  const meta = [record.data.journal, record.data.year, record.number && '条目 #' + record.number].filter(Boolean).join(' · ');
  review.replaceChildren(make('h2', record.data.title || record.data.doi || '无题名', 'review-title'), make('p', meta, 'review-meta'));
  if (!item) {
    review.append(make('p', record.supported ? '点击「一键检查补全」开始查找。' : '当前支持期刊论文（Journal Article）。', 'muted'));
    return;
  }
  if (item.warning) review.append(make('p', item.warning, 'review-note'));
  if (item.note) review.append(make('p', item.note, 'muted'));
  if (item.status === 'ambiguous') {
    const ask = make('button', '请 ChatGPT 核对候选');
    ask.disabled = !hasModels || Boolean(busy || accountBusy);
    ask.addEventListener('click', () => void requestAi('aiCandidate'));
    review.append(make('div', null, 'controls'));
    review.lastChild.append(ask);
    review.append(candidatePanel(item));
  } else if (item.fields?.length) {
    const translation = item.fields.find(field => field.key === 'translatedTitle');
    if (translation && !translation.old && !translation.proposed && item.fields.find(field => field.key === 'title')?.status !== 'review') {
      const action = make('button', '用 ChatGPT 补译名');
      action.disabled = !hasModels || Boolean(busy || accountBusy);
      action.addEventListener('click', () => void requestAi('translate'));
      review.append(action);
    }
    review.append(resultTable(item));
  }
}

function chooseRow(index) {
  const previous = currentIndex;
  currentIndex = index;
  rowState(previous);
  rowState(index);
  review.scrollTop = 0;
  renderReview();
}

byId('account').addEventListener('toggle', () => {
  if (byId('account').open && accountConnected && !hasModels && !accountBusy && !busy) void accountOperation('models');
});
byId('login').addEventListener('click', () => {
  if (accountBusy === 'login') void api.cancelLogin();
  else void accountOperation('login');
});
byId('logout').addEventListener('click', () => void accountOperation('logout'));
byId('models').addEventListener('click', () => void accountOperation('models'));
byId('usage').addEventListener('click', () => void api.usage().catch(error => inform(error.message, true)));

byId('open').addEventListener('click', async () => {
  busy = 'open';
  sync();
  try {
    const value = await api.open();
    if (!value) return;
    ({ records, fileName } = value);
    rows.clear();
    results.clear();
    selectedFields.clear();
    currentIndex = null;
    byId('count').textContent = records.length + ' 条';
    const list = document.createDocumentFragment();
    for (const record of records) {
      const li = make('li');
      const button = make('button');
      const detail = make('span', null, 'entry-detail');
      button.append(make('span', record.data.title || record.data.doi || '无题名', 'entry-title'), detail);
      button.addEventListener('click', () => chooseRow(record.index));
      li.append(button);
      rows.set(record.index, { button, detail });
      rowState(record.index);
      list.append(li);
    }
    byId('records').replaceChildren(list);
    chooseRow(records.find(record => record.supported)?.index ?? 0);
    inform(fileName + ' · ' + records.filter(record => record.supported).length + ' 条期刊论文');
  } catch (error) { inform(error.message, true); }
  finally { busy = ''; sync(); }
});

byId('scan').addEventListener('click', async () => {
  busy = 'scan';
  sync();
  results.clear();
  selectedFields.clear();
  rows.forEach((_, index) => rowState(index));
  renderReview();
  progress.max = records.length;
  progress.value = 0;
  progress.hidden = false;
  inform('正在联网检查文献…');
  try {
    const outcome = await api.scan({ translate: translate.checked, language: language.value, model: model.value });
    const { matched, ambiguous, failed } = outcome.summary;
    const status = outcome.cancelled ? '检查已停止，已完成的结果可导出' : '检查完成';
    inform(status + ' · ' + matched + ' 条匹配 · ' + ambiguous + ' 条待确认 · ' + failed + ' 条查询失败' +
      (outcome.aiError ? ' · ChatGPT ' + outcome.aiError : ''), Boolean(outcome.aiError || failed));
  } catch (error) { inform(error.message, true); }
  finally { busy = ''; progress.hidden = true; sync(); renderReview(); }
});
byId('cancel').addEventListener('click', () => void api.cancel());

byId('save').addEventListener('click', async () => {
  busy = 'save';
  sync();
  try {
    const changes = [...selectedFields].filter(([, keys]) => keys.size).map(([index, keys]) => [index, [...keys]]);
    const saved = await api.save(changes);
    if (saved) inform('已导出 ' + saved.count + ' 条到 ' + saved.fileName + '。可以在 EndNote 的测试文献库中导入检查。');
  } catch (error) { inform(error.message, true); }
  finally { busy = ''; sync(); }
});

api.onResult(item => setResult(item));
api.onProgress(value => {
  if (busy !== 'scan') return;
  progress.max = value.total;
  progress.value = value.done;
  inform((value.stage === 'translation' ? 'ChatGPT 生成译名' : '联网核对') + ' · ' + value.done + ' / ' + value.total);
});
api.account().then(state => {
  activeAccount(state);
  if (state.connected && !state.models.length) void accountOperation('models');
}).catch(error => { byId('account-status').textContent = error.message; });
