(() => {
  const input = byId('ris-title');
  const output = byId('ris-result');
  const message = byId('ris-status');
  const language = byId('ris-language');
  const aiEnabled = byId('ris-translate');
  const profile = byId('ris-profile');
  const stylePanel = byId('ris-style-panel');
  const approved = new Set();
  const extended = new Set(['publisher', 'supplement', 'articleNumber', 'pmid', 'pmcid', 'printIssn', 'onlineIssn',
    'abstract', 'keywords', 'mesh', 'language', 'publicationTypes', 'affiliations', 'orcids']);
  let result;
  let activity = '';
  let saving = false;
  let hadModels = false;
  let styleRevision = 0;

  const linkLabels = {
    freePdf: '开放 PDF', pdf: 'PDF（可能需要权限）', archive: 'PubMed Central 全文',
    publisher: '出版社页面', index: 'PubMed 记录'
  };

  function notify(text, error = false) {
    message.textContent = text;
    message.classList.toggle('error', error);
  }

  window.syncRis = () => {
    if (hasModels && !hadModels) aiEnabled.checked = true;
    if (!hasModels) aiEnabled.checked = false;
    hadModels = hasModels;
    input.disabled = Boolean(busy);
    byId('ris-search').disabled = Boolean(busy || accountBusy);
    byId('ris-cancel').hidden = !['search', 'enrich', 'suggest'].includes(activity);
    language.disabled = Boolean(busy);
    aiEnabled.disabled = !hasModels || Boolean(busy || accountBusy);
    profile.disabled = Boolean(busy || saving);
    byId('ris-add-style').disabled = Boolean(busy || saving);
    refreshSave();
  };

  function canSave() {
    const title = result?.fields?.find(field => field.key === 'title');
    return !saving && Boolean(title?.proposed && (title.status !== 'review' || approved.has('title')));
  }

  async function previewStyle() {
    const revision = ++styleRevision;
    const chosen = window.styleControls.get(profile.value);
    const view = byId('ris-style-preview');
    const note = byId('ris-style-note');
    byId('ris-style-source').hidden = !chosen?.source;
    byId('ris-style-ens').hidden = !chosen?.ens;
    byId('ris-style-detail').textContent = chosen?.detail || '';
    note.hidden = true;
    if (!chosen || !canSave() || stylePanel.hidden) {
      view.textContent = chosen && !canSave() ? '确认题名字段后可预览。' : '';
      return;
    }
    try {
      const preview = await api.risStylePreview({ profileId: profile.value, approved: [...approved] });
      if (revision !== styleRevision) return;
      showCitation(view, preview.html);
      note.textContent = [...preview.changes, ...preview.notes].join(' · ');
      note.hidden = !note.textContent;
    } catch (error) {
      if (revision === styleRevision) view.textContent = error.message;
    }
  }

  function options() {
    return { model: model.value, language: language.value, translate: aiEnabled.checked };
  }

  async function run(kind, task) {
    if (activity || busy || accountBusy || saving) return;
    activity = kind;
    busy = 'ris';
    sync();
    render();
    try { await task(); }
    catch (error) { notify(error.message, true); }
    finally {
      activity = '';
      busy = '';
      sync();
      render();
    }
  }

  async function enrich() {
    activity = 'enrich';
    sync();
    notify('正在查找全文' + (aiEnabled.checked ? '并准备译名…' : '…'));
    const response = await api.risEnrich(options());
    if (response.cancelled) {
      notify('已停止补充查询，现有题录仍可导出。');
      return;
    }
    result = response;
    notify(response.aiWarning ? '题录已匹配。ChatGPT：' + response.aiWarning : '论文已匹配。', Boolean(response.aiWarning));
  }

  function candidates() {
    const list = make('div', null, 'candidates');
    if (result.ai) {
      const { index, reason } = result.ai;
      list.append(make('p', (index ? 'ChatGPT 建议查看候选 ' + index : 'ChatGPT 无法确认') + ' · ' + reason, 'muted'));
    }
    if (!result.fields?.length) {
      const ask = make('button', '请 ChatGPT 核对候选');
      ask.disabled = Boolean(activity || accountBusy || !hasModels);
      ask.onclick = () => void run('suggest', async () => {
        notify('正在核对候选…');
        const response = await api.risSuggest(options());
        if (!response.cancelled) result = response;
        notify(response.cancelled ? '已停止。' : '请从候选中选择对应的论文。');
      });
      list.append(ask);
    }
    result.candidates.forEach((candidate, index) => {
      const card = make('div', null, 'candidate');
      card.append(make('h3', candidate.title),
        make('p', [candidate.author, candidate.journal, candidate.year, candidate.doi].filter(Boolean).join(' · ')));
      const controls = make('div', null, 'candidate-links');
      const choose = make('button', index === result.selected ? '当前论文' : '选择这篇');
      choose.disabled = Boolean(activity || index === result.selected);
      choose.onclick = () => void run('choose', async () => {
        approved.clear();
        result = await api.risChoose({ candidate: index, ...options() });
        render();
        await enrich();
      });
      controls.append(choose, ...candidate.sources.map(resourceLink));
      card.append(controls);
      list.append(card);
    });
    return list;
  }

  function pdfPanel() {
    const panel = make('section', null, 'ris-card');
    panel.append(make('h2', 'PDF 与全文'));
    if (!result.links?.some(link => ['pdf', 'freePdf'].includes(link.kind))) {
      panel.append(make('p', activity === 'enrich' && !result.links?.length && !result.pdfWarning ?
        '正在查询全文地址…' : '暂无已收录的 PDF 直链。', 'ris-below-title'));
    }
    if (result.pdfWarning) panel.append(make('p', result.pdfWarning, 'review-note'));
    const list = make('ul', null, 'ris-pdf-list');
    for (const link of result.links || []) {
      const row = make('li');
      const label = linkLabels[link.kind];
      row.append(make('h3', label), make('p', link.source + ' · ' + new URL(link.url).hostname));
      const actions = make('div', null, 'ris-link-actions');
      for (const copy of [false, true]) {
        const button = make('button', copy ? '复制链接' : '打开链接', 'link');
        button.setAttribute('aria-label', (copy ? '复制' : '打开') + label);
        button.onclick = () => api.risLink({ url: link.url, copy })
          .then(() => { if (copy) notify('已复制链接。'); })
          .catch(error => notify(error.message, true));
        actions.append(button);
      }
      row.append(actions);
      list.append(row);
    }
    panel.append(list);
    return panel;
  }

  function metadataPanel() {
    const panel = make('section', null, 'ris-card');
    panel.append(make('h2', 'RIS 题录'));
    const list = make('dl', null, 'ris-fields');
    const more = make('dl', null, 'ris-fields');
    const values = [...result.fields].sort((a, b) => Number(b.key === 'journalAbbr') - Number(a.key === 'journalAbbr'));
    for (const field of values) {
      if (field.key === 'title' && field.status !== 'review') continue;
      const label = make('dt', field.label);
      const value = make('dd', asText(field.proposed));
      if (field.note) value.append(make('span', field.note, 'field-note'));
      if (field.status === 'ai') value.append(make('span', 'ChatGPT 机器译名', 'field-note'));
      else if (field.sources?.length) {
        value.append(make('span', [...new Set(field.sources.map(source => source.name))].join(' · '), 'field-note'));
      } else if (field.status === 'missing') value.append(make('span', '来源未提供', 'field-note'));
      if (field.status === 'review' && field.proposed) {
        const control = make('label', null, 'field-note');
        const check = make('input');
        check.type = 'checkbox';
        check.checked = approved.has(field.key);
        check.setAttribute('aria-label', '采用' + field.label);
        check.onchange = () => {
          if (check.checked) approved.add(field.key);
          else approved.delete(field.key);
          refreshSave();
          void previewStyle();
        };
        control.append(check, ' 采用此值');
        value.append(control);
      }
      (extended.has(field.key) ? more : list).append(label, value);
    }
    panel.append(list);
    const details = make('details', null, 'ris-extended');
    details.append(make('summary', '扩展题录'), more);
    panel.append(details);
    return panel;
  }

  function refreshSave() {
    const save = byId('ris-save');
    if (save) save.disabled = !canSave();
    for (const id of ['ris-adapted-save', 'ris-style-copy']) {
      byId(id).disabled = !canSave() || !profile.value || Boolean(busy);
    }
  }

  async function saveRis(profileId) {
    if (!canSave()) return;
    saving = true;
    refreshSave();
    try {
      const file = await api.risSave({ approved: [...approved], profileId });
      if (file) notify('已保存 ' + file + '。可用 RefMan RIS 导入 EndNote。');
    } catch (error) { notify(error.message, true); }
    finally { saving = false; refreshSave(); }
  }

  function render() {
    output.replaceChildren();
    stylePanel.hidden = !result?.fields?.length;
    if (stylePanel.hidden) styleRevision++;
    if (!result) return;
    if (!result.fields?.length) {
      if (result.candidates?.length) output.append(candidates());
      if (result.warning) output.append(make('p', result.warning, 'review-note'));
      return;
    }
    const fields = Object.fromEntries(result.fields.map(field => [field.key, field.proposed]));
    const head = make('section', null, 'ris-card');
    const top = make('div', null, 'ris-overview');
    const title = make('div');
    title.append(make('h2', fields.title), make('p', [fields.journal, fields.year].filter(Boolean).join(' · '), 'ris-below-title'));
    const save = make('button', '保存完整 RIS', 'primary');
    save.id = 'ris-save';
    save.onclick = () => void saveRis();
    top.append(title, save);
    head.append(top);
    const matches = result.candidates[result.selected];
    if (matches?.sources.length) {
      const links = make('div', null, 'controls');
      links.append(...matches.sources.map(resourceLink));
      head.append(links);
    }
    if (result.warning) head.append(make('p', result.warning, 'review-note'));
    const grid = make('div', null, 'ris-grid');
    grid.append(metadataPanel(), pdfPanel());
    output.append(head, grid);
    if (result.candidates.length > 1) {
      const alternative = make('details', null, 'ris-card ris-alternatives');
      alternative.append(make('summary', '查看其他候选'), candidates());
      output.append(alternative);
    }
    refreshSave();
    void previewStyle();
  }

  profile.onchange = () => { refreshSave(); void previewStyle(); };
  byId('ris-add-style').onclick = () => window.styleControls.show(profile);
  byId('ris-adapted-save').onclick = () => void saveRis(profile.value);
  byId('ris-style-copy').onclick = () => api.risStyleCopy({ profileId: profile.value, approved: [...approved] })
    .then(() => notify('已复制排版引文。')).catch(error => notify(error.message, true));
  for (const [id, kind] of [['ris-style-source', 'source'], ['ris-style-ens', 'ens']]) {
    byId(id).onclick = () => api.styleSource({ profileId: profile.value, kind }).catch(error => notify(error.message, true));
  }
  document.addEventListener('citation-profiles', () => {
    refreshSave();
    if (!stylePanel.hidden) void previewStyle();
  });
  byId('ris-cancel').onclick = () => void api.cancel();
  byId('ris-form').onsubmit = event => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    void run('search', async () => {
      result = null;
      approved.clear();
      render();
      notify('正在 Crossref 和 PubMed 检索…');
      const response = await api.risSearch({ title, ...options() });
      if (response.cancelled) { notify('已停止查询。'); return; }
      result = response;
      render();
      if (result.fields?.length) await enrich();
      else notify(result.status === 'ambiguous' ? '请确认与你的标题对应的论文。' :
        result.note || '没有找到可用题录，请试试完整标题或 DOI。', result.status === 'failed');
    });
  };
  api.onRisUpdate(item => {
    if (activity !== 'enrich') return;
    result = item;
    render();
  });
  sync();
})();
