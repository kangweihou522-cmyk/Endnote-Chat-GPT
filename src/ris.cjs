const { FIELDS, clean, normalizeDoi, normalizePmid, normalizeIssns, fold } = require('./bibliography.cjs');
const { pickFields, sourceDetails } = require('./review.cjs');

const EXTENDED_FIELDS = [
  ['journalAbbr', '期刊标准缩写'], ['publisher', '出版商'], ['supplement', '增刊'],
  ['articleNumber', '文章编号'], ['pmid', 'PMID'], ['pmcid', 'PMCID'],
  ['printIssn', '印刷 ISSN'], ['onlineIssn', '电子 ISSN'],
  ['abstract', '摘要'], ['keywords', '作者关键词', true], ['mesh', 'MeSH 主题词', true],
  ['language', '语言', true], ['publicationTypes', '文献类型', true],
  ['affiliations', '作者单位', true], ['orcids', '作者 ORCID', true]
];

function titleRecord(raw) {
  const title = clean(raw);
  if (!fold(title) || title.length > 750) throw new Error('请输入 750 字以内的论文标题或 DOI。');
  const doi = normalizeDoi(title);
  const data = Object.fromEntries(FIELDS.map(([key]) => [key, key === 'authors' ? [] : '']));
  data.title = doi ? '' : title;
  data.doi = doi;
  return { index: 0, supported: true, data, ids: { doi, pmid: '' } };
}

function pickRisFields(record, group, language) {
  const ordered = [...group].sort((a, b) => Number(b.source === 'PubMed') - Number(a.source === 'PubMed'));
  const extended = EXTENDED_FIELDS.map(([key, label, multiple]) => {
    const sources = ordered.filter(work => work[key]?.length);
    const proposed = multiple ? Array.from(new Map(sources.flatMap(work => work[key])
      .map(item => [item.toLowerCase(), item])).values()) : sources[0]?.[key] || '';
    const conflict = !multiple && ['articleNumber', 'pmid', 'pmcid'].includes(key) &&
      sources.some(work => fold(work[key]) !== fold(proposed));
    return {
      key, label, old: multiple ? [] : '', proposed, sources: sourceDetails(sources),
      status: conflict ? 'review' : proposed.length ? 'change' : 'missing',
      note: conflict ? '来源记录存在差异。' : '', canApply: Boolean(proposed.length)
    };
  });
  // The search terms identify a work. Export fields describe the matched record.
  const blank = { ...record, data: { ...record.data, title: '', doi: '' } };
  return [...pickFields(blank, group, language), ...extended];
}

function risData(fields, approved = []) {
  return Object.fromEntries(fields
    .filter(field => field.status !== 'review' || approved.includes(field.key))
    .map(field => [field.key, field.proposed]));
}

function risDate(date) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date || '');
  return match ? [match[1], match[2] || '', match[3] || '', ''].join('/') : '';
}

function risPages(pages) {
  const text = clean(pages);
  const range = /^([a-z]*\d+)\s*[-‐‑‒–—−]\s*([a-z]*\d+)$/i.exec(text);
  return range ? [range[1], range[2]] : [text, ''];
}

function risTags(data, links = []) {
  if (!clean(data.title)) throw new Error('请确认论文题名后再保存 RIS。');
  const tags = [];
  const tag = (name, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    tags.push({ name, value: value.trim() });
  };
  const repeated = (name, values = []) => {
    if (Array.isArray(values)) for (const value of values) tag(name, value);
  };
  tag('TY', 'JOUR');
  tag('TI', data.title);
  repeated('AU', data.authors);
  tag('T2', data.journal);
  tag('JF', data.journal);
  tag('J2', data.journalAbbr);
  tag('PB', data.publisher);
  tag('PY', data.year);
  tag('DA', risDate(data.date));
  tag('VL', data.volume);
  tag('IS', data.issue);
  const [startPage, endPage] = risPages(data.pages || data.articleNumber);
  tag('SP', startPage);
  tag('EP', endPage);
  const doi = normalizeDoi(data.doi);
  tag('DO', doi);
  repeated('SN', normalizeIssns([data.issn, data.printIssn, data.onlineIssn]));
  tag('TT', data.translatedTitle);
  tag('AB', data.abstract);
  repeated('KW', data.keywords);
  repeated('LA', data.language);
  repeated('AD', data.affiliations);
  const pmid = normalizePmid(data.pmid);
  if (pmid) {
    tag('AN', pmid);
    tag('DB', 'PubMed');
  }
  // RIS filters vary in how extensions map. Retain less portable fields in Notes.
  const notes = [
    ['Epub date', data.epubDate], ['Supplement', data.supplement], ['Article number', data.articleNumber],
    ['PMCID', data.pmcid], ['Print ISSN', data.printIssn], ['Online ISSN', data.onlineIssn],
    ['Publication type', data.publicationTypes], ['MeSH', data.mesh], ['ORCID', data.orcids]
  ];
  for (const [label, item] of notes) {
    const content = Array.isArray(item) ? item.join(' | ') : item;
    if (content) tag('N1', label + ': ' + content);
  }
  if (doi) tag('UR', 'https://doi.org/' + encodeURI(doi).replace(/[?#]/g, encodeURIComponent));
  if (pmid) tag('UR', 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/');
  if (/^PMC\d+$/.test(data.pmcid || '')) tag('UR', 'https://pmc.ncbi.nlm.nih.gov/articles/' + data.pmcid + '/');
  for (const link of links.filter(link => link.kind === 'freePdf' || link.kind === 'pdf')) tag('L1', link.url);
  return tags;
}

function serializeRis(records) {
  return records.map(tags => {
    const lines = tags.map(({ name, value }) => {
      const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .split(/\r\n|\r|\n/).map(line => line.trim()).join('\r\n      ');
      return name + '  - ' + text;
    });
    return [...lines, 'ER  -', ''].join('\r\n');
  }).join('\r\n');
}

function exportRis(fields, approved = [], links = []) {
  return serializeRis([risTags(risData(fields, approved), links)]);
}

function parseRis(text) {
  const records = [];
  let tags = [];
  for (const [index, line] of text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/).entries()) {
    const match = /^([A-Z][A-Z0-9])[ \t]{1,4}-[ \t]?(.*)$/u.exec(line);
    if (match) {
      const [, name, value] = match;
      if (name === 'ER' && tags.length) {
        records.push(tags);
        tags = [];
      } else if (name === 'TY' && !tags.length && clean(value)) tags.push({ name, value });
      else if (name !== 'TY' && tags.length) tags.push({ name, value });
      else throw new Error('第 ' + (index + 1) + ' 行附近的 RIS 条目边界无效。');
    } else if (tags.length) tags.at(-1).value += '\n' + line.trim();
    else if (line.trim()) throw new Error('第 ' + (index + 1) + ' 行没有以 TY 开始的 RIS 条目。');
  }
  if (tags.length) throw new Error('最后一条记录缺少 ER 结束标记。');
  if (!records.length) throw new Error('文件中没有可读取的 RIS 条目。');
  return records;
}

function decodeRis(bytes, encoding = 'auto') {
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' :
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : '';
  if (!['auto', 'utf-8', 'gb18030', 'windows-1252'].includes(encoding)) throw new Error('不支持此文本编码。');
  try { return new TextDecoder(bom || (encoding === 'auto' ? 'utf-8' : encoding), { fatal: true }).decode(bytes); }
  catch { throw new Error('无法按所选编码读取。旧版中文 RIS 可选择 GB18030 后重新打开。'); }
}

function risFileName(title) {
  const base = clean(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
    .slice(0, 90).replace(/^[ .]+|[ .]+$/g, '');
  return (!base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? 'reference' : base) + '.ris';
}

module.exports = { titleRecord, pickRisFields, risData, risTags, exportRis, parseRis, serializeRis, decodeRis, risFileName };
