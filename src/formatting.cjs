const fs = require('node:fs/promises');
const path = require('node:path');
const { clean, FIELDS } = require('./bibliography.cjs');
const { inspectRecord } = require('./review.cjs');
const { decodeRis, parseRis, serializeRis, pickRisFields, risData, risTags, risFileName } = require('./ris.cjs');
const { validateRules, parseCitation, transformRis, withVerifiedFields, orderRecords, citationBibliography } = require('./citation.cjs');
const { styleLibrary, readGuide, guideExcerpt, guideRules, chatRules } = require('./styles.cjs');

const MAX_BYTES = 60 * 1024 * 1024;
const MAX_RECORDS = 12000;
const canonicalName = name => process.platform === 'win32' ? name.toLowerCase() : name;

function bibliographicRecord(record, item) {
  return {
    index: record.id,
    supported: item.isArticle,
    ids: { doi: item.doi, pmid: item.pmid },
    data: Object.fromEntries(FIELDS.map(([key]) => [key, item[key] ?? (key === 'authors' ? [] : '')]))
  };
}

function summaryRecord(record) {
  const item = parseCitation(record.tags);
  return {
    id: record.id, file: record.file, type: item.type, title: item.title,
    journal: item.journal, year: item.year, author: item.authors[0] || ''
  };
}

async function readBatch(files, encoding) {
  const result = { records: [], files: [], errors: [], verified: new Map(), notices: new Map() };
  const seen = new Set();
  let bytes = 0;
  for (const filename of files) {
    const name = path.basename(filename);
    try {
      const real = await fs.realpath(filename);
      if (seen.has(canonicalName(real))) continue;
      seen.add(canonicalName(real));
      const stat = await fs.stat(real);
      if (!stat.isFile() || bytes + stat.size > MAX_BYTES) throw new Error('文件过大。每批 RIS 输入上限为 60 MB。');
      bytes += stat.size;
      const parsed = parseRis(decodeRis(await fs.readFile(real), encoding));
      if (result.records.length + parsed.length > MAX_RECORDS) throw new Error('整批最多可读取 12000 条 RIS 记录。');
      for (const tags of parsed) result.records.push({ id: result.records.length, tags, file: name });
      result.files.push({ name, path: real, count: parsed.length });
    } catch (error) {
      result.errors.push({ name, message: error.code ? '无法读取此文件。' : error.message });
    }
  }
  if (!result.records.length) {
    throw new Error(result.errors.map(error => error.name + ' · ' + error.message).join('\n') || '请先选择可用的 RIS 文件。');
  }
  return result;
}

function selectionOf(batch, ids) {
  if (!batch?.records.length || !Array.isArray(ids)) throw new Error('请先打开 RIS 文件。');
  const chosen = new Set(ids.filter(id => Number.isSafeInteger(id)));
  const records = batch.records.filter(record => chosen.has(record.id));
  if (!records.length) throw new Error('请至少勾选一条文献。');
  return records;
}

function needsLookup(item, rules) {
  return item.isArticle && (!item.journalFull && rules.journal === 'full' ||
    !item.journalAbbr && rules.journal === 'abbreviated' || !item.journal ||
    !item.doi && (rules.risDoi === 'keep' || rules.doiDisplay !== 'omit') ||
    !item.authors.length || !item.title || !item.year || !item.volume || !item.pages);
}

async function verifyMissing(batch, records, rules, sources, signal, progress) {
  const pending = records.filter(record => !batch.verified.has(record.id) && needsLookup(parseCitation(record.tags), rules));
  for (const [index, record] of pending.entries()) {
    signal.throwIfAborted();
    progress(index, pending.length);
    const item = parseCitation(record.tags);
    try {
      const research = bibliographicRecord(record, item);
      const match = await inspectRecord(research, sources, 'English', signal);
      const found = match.candidates?.[match.selected];
      if (found) {
        const fieldData = risData(pickRisFields(research, found.group, 'English'));
        batch.verified.set(record.id, withVerifiedFields(record.tags, fieldData));
        batch.notices.set(record.id, '已核对 · ' + found.group.map(work => work.source).join('、'));
      } else batch.notices.set(record.id, match.warning || match.note || '暂无可靠匹配。');
    } catch (error) {
      signal.throwIfAborted();
      batch.notices.set(record.id, '查询失败 · ' + error.message);
    }
  }
  progress(pending.length, pending.length);
}

function batchResult(batch, ids, rules) {
  const rows = selectionOf(batch, ids).map(record => {
    const transformed = transformRis(batch.verified.get(record.id) || record.tags, rules);
    const notice = batch.notices.get(record.id);
    if (notice) transformed.notes.push(notice);
    if (batch.verified.get(record.id)?.length > record.tags.length) transformed.changes.push('联网补全');
    return { ...transformed, id: record.id };
  });
  return orderRecords(rows, rules.order);
}

function registerFormatting(context) {
  const { register, dialog, clipboard, shell, getWindow, userData, http, saveOutput,
    withScan, modelFor, auth, emit, getRecent, setRecent, sources } = context;
  const library = styleLibrary(userData, http, saveOutput);
  let batch;
  let guideDraft;

  register('style-list', () => library.list());
  register('style-search', ({ query }) => library.search(query));
  register('style-install', ({ file }) => withScan(signal => library.install(file, signal)));
  register('style-source', async ({ profileId, kind }) => {
    const profile = await library.get(profileId);
    const url = kind === 'ens' ? profile.ens : profile.source;
    if (!url || !url.startsWith('https://')) throw new Error('此模板暂无该链接。');
    await shell.openExternal(url);
  });
  register('style-guide', ({ url, text, name, baseId, model }) => withScan(async signal => {
    if (typeof name !== 'string' || !clean(name) || clean(name).length > 90) throw new Error('请输入期刊或模板名称。');
    const activeModel = modelFor(true, model);
    const base = await library.get(baseId);
    const guide = typeof text === 'string' && text.trim() ?
      { text: guideExcerpt(text.slice(0, 380000)), url: '' } : await readGuide(http, url, signal);
    if (guide.text.length < 20) throw new Error('请补充参考文献要求或样例。');
    const draft = await guideRules(auth, { text: guide.text, name, base, model: activeModel, signal });
    signal.throwIfAborted();
    const sample = transformRis(risTags({
      title: 'DREADDs (designer receptors exclusively activated by designer drugs): chemogenetic tools with therapeutic utility',
      authors: ['Urban, Daniel J.', 'Roth, Bryan L.'], journal: 'Annual Review of Pharmacology and Toxicology',
      journalAbbr: 'Annu Rev Pharmacol Toxicol', year: '2015', volume: '55', pages: '399-417',
      doi: '10.1146/annurev-pharmtox-010814-124803'
    }), draft.rules);
    guideDraft = { ...draft, baseId, name, source: guide.url,
      sample: citationBibliography([sample], base.xml, draft.rules).text };
    return guideDraft;
  }));
  register('style-save-guide', async () => {
    if (!guideDraft) throw new Error('请先生成并查看指南规则。');
    const style = await library.create({ ...guideDraft, detail: guideDraft.summary });
    guideDraft = undefined;
    return style;
  });
  register('style-save-variation', ({ name, baseId, rules }) =>
    library.create({ name, baseId, rules, detail: '本机保存的格式规则' }));

  register('batch-open', async ({ recent, encoding }) => {
    if (recent && !getRecent()) throw new Error('本次运行还没有保存 RIS。');
    const opened = recent ? { filePaths: [getRecent()] } : await dialog.showOpenDialog(getWindow(), {
      title: '打开 RIS 文件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'RIS', extensions: ['ris', 'txt'] }]
    });
    if (opened.canceled) return null;
    const loaded = await readBatch(opened.filePaths, encoding);
    batch = loaded;
    return {
      files: batch.files.map(({ name, count }) => ({ name, count })), errors: batch.errors,
      records: batch.records.map(summaryRecord)
    };
  });

  async function selectedStyle(profileId, overrides) {
    const profile = await library.get(profileId);
    return { profile, rules: validateRules(overrides || {}, profile.rules) };
  }

  async function preview(tags, profileId) {
    const { profile, rules } = await selectedStyle(profileId);
    const result = transformRis(tags, rules);
    return {
      profile: profile.name, changes: result.changes, notes: result.notes,
      ...citationBibliography([result], profile.xml, rules)
    };
  }

  async function adjusted(tags, profileId) {
    if (!profileId) return { tags, profileName: '' };
    const { profile, rules } = await selectedStyle(profileId);
    return { tags: transformRis(tags, rules).tags, profileName: profile.name };
  }

  register('batch-preview', async ({ ids, profileId, overrides }) => {
    const { profile, rules } = await selectedStyle(profileId, overrides);
    const rows = batchResult(batch, ids, rules);
    const bibliography = citationBibliography(rows.slice(0, 6), profile.xml, rules);
    return {
      rows: rows.map(item => ({
        id: item.id, title: item.data.title, journal: item.data.journal,
        doi: rules.risDoi === 'omit' ? '' : item.data.doi,
        changes: item.changes, notes: item.notes
      })),
      sampleHtml: bibliography.html, sampleCount: bibliography.entries.length, count: rows.length
    };
  });

  register('batch-chat', payload => withScan(async signal => {
    const { ids, profileId, overrides, message, history, online, model, format } = payload;
    if (typeof message !== 'string' || !clean(message) || message.length > 2200) {
      throw new Error('请输入 2200 字以内的处理要求。');
    }
    const records = selectionOf(batch, ids);
    const { profile, rules } = await selectedStyle(profileId, overrides);
    const recent = Array.isArray(history) ? history.slice(-8).filter(item => typeof item?.text === 'string')
      .map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', text: item.text.slice(0, 900) })) : [];
    const available = (await library.list()).map(item => ({ id: item.id, name: item.name, rules: item.rules }));
    const result = await chatRules(auth, {
      model: modelFor(true, model), signal,
      request: {
        message, history: recent, journalTemplate: profile.name, profileId, rules, profiles: available,
        selected: records.length, total: batch.records.length,
        journalArticles: records.filter(record => parseCitation(record.tags).isArticle).length,
        output: format === 'text' ? 'text' : 'ris', enrich: Boolean(online)
      }
    });
    return result;
  }));

  register('batch-output', payload => withScan(async signal => {
    const { ids, profileId, overrides, online, format } = payload;
    if (!['ris', 'text', 'copy'].includes(format)) throw new Error('请选择 RIS 或排版引文。');
    const records = selectionOf(batch, ids);
    const { profile, rules } = await selectedStyle(profileId, overrides);
    if (online) await verifyMissing(batch, records, rules, sources, signal,
      (done, total) => emit('batch-progress', { done, total }));
    signal.throwIfAborted();
    const rows = batchResult(batch, ids, rules);
    const bibliography = format === 'ris' ? null : citationBibliography(rows, profile.xml, rules);
    if (format === 'copy') {
      clipboard.write({ text: bibliography.text, html: bibliography.html });
      return { count: rows.length };
    }
    const extension = format === 'ris' ? 'ris' : 'txt';
    const title = batch.files.length === 1 ? path.basename(batch.files[0].name, path.extname(batch.files[0].name)) : '批量文献';
    const base = risFileName(title.slice(0, 50) + '_' + profile.name).slice(0, -4);
    const saved = await dialog.showSaveDialog(getWindow(), {
      title: '另存 ' + (format === 'ris' ? '期刊版 RIS' : '参考文献列表'),
      defaultPath: base + '.' + extension, filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    });
    if (saved.canceled) return { notSaved: true };
    const suppliedExtension = path.extname(saved.filePath).toLowerCase() === '.' + extension;
    const target = path.resolve(suppliedExtension ? saved.filePath : saved.filePath + '.' + extension);
    const real = await fs.realpath(target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (batch.files.some(file => canonicalName(file.path) === canonicalName(real || target))) {
      throw new Error('请使用新文件名保存转换结果。');
    }
    if (real && !suppliedExtension) throw new Error('自动添加扩展名后发现同名文件，请选择新名称。');
    signal.throwIfAborted();
    await saveOutput(target, format === 'ris' ? serializeRis(rows.map(item => item.tags)) : bibliography.text);
    if (format === 'ris') setRecent(target);
    return { count: rows.length, file: path.basename(target), warnings: rows.filter(row => row.notes.length).length };
  }));

  return { preview, adjusted };
}

module.exports = { registerFormatting, readBatch, batchResult, verifyMissing };
