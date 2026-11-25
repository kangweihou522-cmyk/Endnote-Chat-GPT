(() => {
  const profile = byId('batch-profile');
  const online = byId('batch-online');
  const status = byId('batch-status');
  const pages = byId('batch-pages');
  const progress = byId('batch-progress');
  const thread = byId('batch-thread');
  const prompt = byId('batch-prompt');
  const selected = new Set();
  const pageSize = 22;
  const controls = [...document.querySelectorAll('[data-batch-rule]')];

  let records = [];
  let changes = new Map();
  let history = [];
  let overrides = {};
  let activity = '';
  let outputFormat = 'ris';
  let page = 0;
  let revision = 0;

  function notice(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function syncBatch() {
    const blocked = Boolean(busy || accountBusy);
    const canWork = !blocked && Boolean(selected.size && profile.value);
    for (const id of ['batch-open', 'batch-recent', 'batch-add-style', 'batch-encoding', 'batch-profile', 'batch-online']) {
      byId(id).disabled = blocked;
    }
    for (const id of ['batch-export', 'batch-text', 'batch-copy']) byId(id).disabled = !canWork;
    for (const id of ['batch-all', 'batch-none']) byId(id).disabled = blocked || !records.length;
    byId('batch-cancel').hidden = !['chat', 'output'].includes(activity);
    byId('batch-send').disabled = !hasModels || !canWork;
    prompt.disabled = blocked;
    byId('batch-chat-status').textContent = hasModels ?
      (records.length ? selected.size + ' 条已勾选' : '打开 RIS 后可对当前批次提出要求。') :
      '连接 ChatGPT 并选择模型后可使用对话。';
    for (const control of controls) control.disabled = blocked || !profile.value;
    byId('batch-save-style').disabled = blocked;
    for (const control of byId('batch-items').querySelectorAll('input')) control.disabled = blocked;
  }

  function updateProfile() {
    const chosen = window.styleControls.get(profile.value);
    byId('batch-style-source').hidden = !chosen?.source;
    byId('batch-style-ens').hidden = !chosen?.ens;
    const detail = byId('batch-style-detail');
    detail.textContent = chosen?.detail || '';
    detail.hidden = !chosen?.detail;
    const rules = { ...chosen?.rules, ...overrides };
    for (const control of controls) {
      if (rules[control.dataset.batchRule]) control.value = rules[control.dataset.batchRule];
    }
    const modified = Object.keys(overrides).length > 0;
    byId('batch-save-rule').hidden = !modified;
    const note = byId('batch-custom-rules');
    note.textContent = modified ? window.styleControls.describe(rules) : '';
    note.hidden = !modified;
  }

  function options() {
    return { ids: [...selected], profileId: profile.value, overrides, online: online.checked };
  }

  function renderRecords() {
    const list = byId('batch-items');
    if (!records.length) {
      list.replaceChildren();
      pages.hidden = true;
      return;
    }
    list.replaceChildren(...records.slice(page * pageSize, (page + 1) * pageSize).map(record => {
      const row = make('article', null, 'batch-record');
      const checkbox = make('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(record.id);
      checkbox.disabled = Boolean(busy || accountBusy);
      checkbox.setAttribute('aria-label', '选择 ' + (record.title || record.file) + ' · ' + (record.id + 1));
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(record.id);
        else selected.delete(record.id);
        syncBatch();
        void refreshPreview();
      };
      const body = make('div');
      body.append(make('h3', record.title || '未提供题名'),
        make('p', [record.author, record.journal, record.year, record.type].filter(Boolean).join(' · '), 'muted'));
      const change = changes.get(record.id);
      if (change && checkbox.checked) {
        if (change.title && change.title !== record.title) {
          body.append(make('p', '题名将写为 ' + change.title, 'batch-change'));
        }
        if (change.journal && change.journal !== record.journal) {
          body.append(make('p', '期刊将写为 ' + change.journal, 'batch-change'));
        }
        if (change.changes.length) body.append(make('p', change.changes.join(' · '), 'batch-change'));
        if (change.notes.length) body.append(make('p', change.notes.join(' · '), 'batch-warning'));
      }
      row.append(checkbox, body);
      return row;
    }));
    pages.hidden = records.length <= pageSize;
    byId('batch-page').textContent = (page + 1) + ' / ' + Math.ceil(records.length / pageSize);
    byId('batch-back').disabled = !page;
    byId('batch-next').disabled = (page + 1) * pageSize >= records.length;
  }

  async function refreshPreview() {
    const current = ++revision;
    const samples = byId('batch-samples');
    const count = byId('batch-preview-count');
    if (!selected.size || !profile.value) {
      changes.clear();
      samples.replaceChildren();
      count.hidden = true;
      renderRecords();
      return;
    }
    try {
      const preview = await api.batchPreview(options());
      if (current !== revision) return;
      changes = new Map(preview.rows.map(row => [row.id, row]));
      showCitation(samples, preview.sampleHtml);
      count.textContent = '预览所选前 ' + preview.sampleCount + ' 条 · 共选中 ' + preview.count + ' 条';
      count.hidden = false;
      renderRecords();
    } catch (error) {
      if (current !== revision) return;
      samples.replaceChildren();
      count.textContent = error.message;
      count.hidden = false;
    }
  }

  async function run(kind, action) {
    if (busy || accountBusy || activity) return;
    busy = 'batch';
    activity = kind;
    sync();
    try { await action(); }
    catch (error) { notice(error.message, true); }
    finally {
      activity = '';
      busy = '';
      progress.hidden = true;
      sync();
    }
  }

  function resetBatch(loaded) {
    records = loaded.records;
    selected.clear();
    for (const record of records) selected.add(record.id);
    history = [];
    changes.clear();
    thread.replaceChildren();
    page = 0;
    overrides = {};
    updateProfile();
    byId('batch-files').textContent = loaded.files.map(file => file.name + '（' + file.count + ' 条）').join(' · ');
    byId('batch-files').hidden = false;
    const errors = byId('batch-errors');
    errors.replaceChildren(...loaded.errors.map(file => make('li', file.name + ' · ' + file.message)));
    errors.hidden = !loaded.errors.length;
    notice('已读取 ' + records.length + ' 条，全部勾选。' + (loaded.errors.length ? ' 部分文件无法读取。' : ''),
      loaded.errors.length > 0);
    renderRecords();
  }

  function open(recent) {
    void run('open', async () => {
      const loaded = await api.batchOpen({ recent, encoding: byId('batch-encoding').value });
      if (!loaded) return;
      resetBatch(loaded);
      await refreshPreview();
    });
  }

  function addMessage(role, text) {
    const item = make('article', null, 'batch-message ' + role);
    item.append(make('h3', role === 'user' ? '你' : 'ChatGPT'), make('p', text));
    thread.append(item);
    thread.scrollTop = thread.scrollHeight;
    history.push({ role, text });
  }

  async function output(format) {
    activity = 'output';
    outputFormat = format === 'text' ? 'text' : 'ris';
    syncBatch();
    notice('正在准备 ' + (format === 'ris' ? 'RIS' : '排版引文') + '…');
    const saved = await api.batchOutput({ ...options(), format });
    if (saved.cancelled) notice('已停止任务。可继续预览已查到的结果。');
    else if (saved.notSaved) notice('已取消保存。');
    else if (format === 'copy') notice('已复制 ' + saved.count + ' 条排版引文。');
    else notice('已导出 ' + saved.count + ' 条到 ' + saved.file + '。' +
      (saved.warnings ? ' 有 ' + saved.warnings + ' 条含核对提示。' : ''));
    await refreshPreview();
  }

  byId('batch-open').onclick = () => open(false);
  byId('batch-recent').onclick = () => open(true);
  byId('batch-add-style').onclick = () => window.styleControls.show(profile);
  byId('batch-style-source').onclick = () => api.styleSource({ profileId: profile.value, kind: 'source' })
    .catch(error => notice(error.message, true));
  byId('batch-style-ens').onclick = () => api.styleSource({ profileId: profile.value, kind: 'ens' })
    .catch(error => notice(error.message, true));
  byId('batch-cancel').onclick = () => void api.cancel();
  byId('batch-export').onclick = () => void run('output', () => output('ris'));
  byId('batch-text').onclick = () => void run('output', () => output('text'));
  byId('batch-copy').onclick = () => void run('output', () => output('copy'));

  for (const id of ['batch-all', 'batch-none']) {
    byId(id).onclick = () => {
      selected.clear();
      if (id === 'batch-all') for (const row of records) selected.add(row.id);
      syncBatch();
      renderRecords();
      void refreshPreview();
    };
  }
  byId('batch-back').onclick = () => { page--; renderRecords(); };
  byId('batch-next').onclick = () => { page++; renderRecords(); };

  profile.onchange = () => {
    overrides = {};
    updateProfile();
    syncBatch();
    void refreshPreview();
  };
  for (const control of controls) {
    control.onchange = () => {
      overrides = { ...overrides, [control.dataset.batchRule]: control.value };
      updateProfile();
      void refreshPreview();
    };
  }
  byId('batch-save-style').onclick = () => void run('template', async () => {
    const name = byId('batch-rule-name').value.trim();
    const created = await api.styleSaveVariation({ name, baseId: profile.value, rules: overrides });
    byId('batch-rule-name').value = '';
    window.styleControls.add(created, profile);
    notice('已保存模板 ' + created.name + '。');
  });

  byId('batch-chat-form').onsubmit = event => {
    event.preventDefault();
    const message = prompt.value.trim();
    if (!message || !hasModels) return;
    void run('chat', async () => {
      const prior = history.slice(-8);
      addMessage('user', message);
      prompt.value = '';
      notice('ChatGPT 正在理解格式要求…');
      const result = await api.batchChat({
        ...options(), message, history: prior, model: model.value, format: outputFormat
      });
      if (result.cancelled) { notice('已停止对话请求。'); return; }
      addMessage('assistant', result.reply);
      if (result.intent === 'clarify') { notice('请补充对话中的格式要求。'); return; }
      if (result.profileId) profile.value = result.profileId;
      overrides = result.rules;
      online.checked = result.enrich;
      updateProfile();
      outputFormat = result.format;
      await refreshPreview();
      if (result.intent === 'export') await output(result.format);
      else notice('已将这轮要求应用到预览。');
    });
  };

  api.onBatchProgress(value => {
    if (activity !== 'output') return;
    progress.hidden = !value.total;
    progress.max = Math.max(1, value.total);
    progress.value = value.done;
    notice('正在联网核对待补字段 · ' + value.done + ' / ' + value.total);
  });

  document.addEventListener('citation-profiles', () => {
    updateProfile();
    syncBatch();
    void refreshPreview();
  });
  window.syncBatch = syncBatch;
  updateProfile();
  syncBatch();
})();
