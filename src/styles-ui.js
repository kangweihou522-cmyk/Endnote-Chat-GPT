(() => {
  const dialog = byId('styles-dialog');
  const status = byId('styles-status');
  const results = byId('styles-results');
  const draft = byId('styles-draft');
  const labels = {
    journal: { full: '期刊全称', abbreviated: '标准期刊缩写', keep: '沿用期刊名' },
    titleCase: { subtitle: '冒号后首词大写', sentence: '句式大小写', headline: '标题式大小写', keep: '沿用题名' },
    risDoi: { keep: 'RIS 保留 DOI', omit: 'RIS 省略 DOI' },
    doiDisplay: { omit: '引文省略 DOI', url: '引文 DOI 使用链接', bare: '引文 DOI 使用标识符' },
    authorNames: { initials: '引文作者名用首字母', full: '引文作者使用全名' },
    order: { input: '保持输入顺序', author: '按第一作者排序', 'year-desc': '年份从新到旧' }
  };

  let profiles = [];
  let loading;
  let target;
  let running = false;

  function describe(rules) {
    const known = Object.entries(labels).map(([field, choices]) => choices[rules[field]]).filter(Boolean);
    if (rules.etalMin) known.push('作者达到 ' + rules.etalMin + ' 位时列出前 ' + rules.etalUseFirst + ' 位');
    if (rules.template) known.push('自定义引文模板');
    if (rules.protect?.length) known.push('保留大小写 ' + rules.protect.join('、'));
    return known.join(' · ');
  }

  function fill() {
    for (const select of document.querySelectorAll('[data-profile-picker]')) {
      const selected = select.value || select.dataset.defaultProfile || 'nlm';
      select.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
      if (profiles.some(profile => profile.id === selected)) select.value = selected;
    }
  }

  function announce() { document.dispatchEvent(new Event('citation-profiles')); }

  function load() {
    if (!loading) loading = api.styleList().then(list => {
      profiles = list;
      fill();
      announce();
    }).catch(error => {
      loading = null;
      status.textContent = error.message;
      throw error;
    });
    return loading;
  }

  function add(profile, select = target) {
    const existing = profiles.findIndex(item => item.id === profile.id);
    if (existing >= 0) profiles[existing] = profile;
    else profiles.push(profile);
    fill();
    if (select) {
      select.value = profile.id;
      select.dispatchEvent(new Event('change'));
    }
    announce();
    if (dialog.open) dialog.close();
  }

  function sync() {
    const disabled = Boolean(busy || accountBusy || running);
    byId('styles-close').disabled = running;
    byId('styles-analyze').disabled = disabled || !hasModels;
    byId('styles-model-note').hidden = hasModels;
    const submit = byId('styles-search-form').querySelector('button[type=submit]');
    submit.disabled = disabled;
    for (const button of results.querySelectorAll('button')) button.disabled = disabled;
    const apply = byId('styles-save-guide');
    if (apply) apply.disabled = disabled;
  }

  function show(select) {
    if (busy || accountBusy) return;
    target = select;
    byId('styles-base').value = select.value || 'nlm';
    status.textContent = '';
    results.replaceChildren();
    draft.replaceChildren();
    draft.hidden = true;
    dialog.showModal();
    byId('styles-query').focus();
    void load().catch(() => {});
  }

  async function work(message, action) {
    if (running || busy || accountBusy) return;
    running = true;
    busy = 'styles';
    status.textContent = message;
    window.styleControls.sync();
    window.sync?.();
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally {
      running = false;
      busy = '';
      window.sync?.();
      sync();
    }
  }

  function searchCard(item) {
    const entry = make('article', null, 'styles-entry');
    const labels = make('div');
    labels.append(make('h3', item.name), make('p', item.file.replace(/^dependent\//, ''), 'field-note'));
    const select = make('button', '使用此样式');
    select.addEventListener('click', () => void work('正在加载期刊样式…', async () => {
      const profile = await api.styleInstall({ file: item.file });
      if (profile.cancelled) return;
      add(profile);
    }));
    entry.append(labels, select);
    return entry;
  }

  byId('styles-close').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (running) event.preventDefault(); });
  byId('styles-search-form').onsubmit = event => {
    event.preventDefault();
    void work('正在搜索样式…', async () => {
      const found = await api.styleSearch({ query: byId('styles-query').value });
      results.replaceChildren(...found.map(searchCard));
      status.textContent = found.length ? '' : '没有找到匹配项。可以粘贴投稿指南生成模板。';
      if (!found.length) {
        byId('styles-guide-section').open = true;
        byId('styles-name').value = byId('styles-query').value.trim();
      }
    });
  };
  byId('styles-guide-form').onsubmit = event => {
    event.preventDefault();
    void work('正在用 ChatGPT 提取引文规则…', async () => {
      draft.hidden = true;
      const value = await api.styleGuide({
        name: byId('styles-name').value, url: byId('styles-url').value,
        text: byId('styles-guide-text').value, baseId: byId('styles-base').value, model: model.value
      });
      if (value.cancelled) return;
      draft.replaceChildren(make('h3', value.name), make('p', value.summary), make('p', describe(value.rules), 'field-note'));
      for (const sample of value.evidence) draft.append(make('blockquote', sample));
      if (value.source) draft.append(make('p', value.source, 'field-note'));
      if (value.sample) draft.append(make('p', value.sample, 'citation-preview'));
      const save = make('button', '确认并保存模板', 'primary');
      save.id = 'styles-save-guide';
      save.onclick = () => void work('正在保存模板…', async () => add(await api.styleSaveGuide()));
      draft.append(save);
      draft.hidden = false;
      status.textContent = '请核对规则和引文样例。';
    });
  };

  window.styleControls = {
    show, sync, add, describe, load,
    get: id => profiles.find(profile => profile.id === id)
  };
  void load().catch(() => {});
})();
