const fs = require('node:fs');
const path = require('node:path');
const { XMLSerializer } = require('@xmldom/xmldom');
const CSL = require('citeproc');
const sanitize = require('sanitize-html');
const { convert } = require('html-to-text');
const { clean, fold, normalizeDoi, normalizePmid } = require('./bibliography.cjs');
const { parseXml, find } = require('./endnote.cjs');

const ARTICLE_TYPES = new Set(['JOUR', 'EJOUR', 'JFULL', 'JA']);
const CSL_TYPES = {
  BOOK: 'book', CHAP: 'chapter', CONF: 'paper-conference', CPAPER: 'paper-conference',
  THES: 'thesis', RPRT: 'report', WEB: 'webpage', ELEC: 'webpage', DATA: 'dataset', NEWS: 'article-newspaper'
};
const ENUMS = {
  journal: ['keep', 'full', 'abbreviated'],
  titleCase: ['keep', 'subtitle', 'sentence', 'headline'],
  risDoi: ['keep', 'omit'],
  doiDisplay: ['style', 'omit', 'url', 'bare'],
  authorNames: ['style', 'initials', 'full'],
  order: ['style', 'input', 'author', 'year-desc']
};
const DEFAULT_RULES = Object.freeze({
  journal: 'keep', titleCase: 'keep', risDoi: 'keep', doiDisplay: 'style',
  authorNames: 'style', order: 'style', etalMin: 0, etalUseFirst: 0,
  template: '', italicJournal: true, boldVolume: false, protect: []
});
const VARIABLES = [
  'authors', 'title', 'journal', 'year', 'volume', 'issue', 'pages', 'doi', 'url', 'publisher'
];
const TEMPLATE_HELP = '可用字段 {' + VARIABLES.join('}, {') + '}。[[...]] 内的字段齐全才显示该段。';
const citeLocales = new Map();

function validateRules(patch, base = DEFAULT_RULES) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('引文规则格式无效。');
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(ENUMS, key) && ENUMS[key].includes(value)) merged[key] = value;
    else if (['italicJournal', 'boldVolume'].includes(key) && typeof value === 'boolean') merged[key] = value;
    else if (['etalMin', 'etalUseFirst'].includes(key) && Number.isInteger(value) && value >= 0 && value <= 999) merged[key] = value;
    else if (key === 'protect' && Array.isArray(value) && value.length <= 40 && value.every(word =>
      typeof word === 'string' && /^[\p{L}\p{N}\p{M}-]{1,40}$/u.test(word))) merged[key] = [...new Set(value)];
    else if (key === 'template' && typeof value === 'string' && value.length <= 700) {
      const keys = [...value.matchAll(/\{([a-z]+)\}/g)].map(match => match[1]);
      const residue = value.replace(/\[\[([^\[\]]+)\]\]/g, '$1').replace(/\{[a-z]+\}/g, '');
      if (value.trim() && (!keys.length || keys.some(item => !VARIABLES.includes(item)) || /\[\[|\]\]|[{}]/.test(residue))) {
        throw new Error('引文模板的字段或括号无效。' + TEMPLATE_HELP);
      }
      merged[key] = value.trim();
    } else throw new Error('无法采用这项引文规则。');
  }
  if (merged.etalMin && (!merged.etalUseFirst || merged.etalUseFirst >= merged.etalMin)) {
    throw new Error('使用 et al. 时，保留人数必须小于触发人数。');
  }
  return merged;
}

function getTag(tags, ...names) {
  for (const name of names) {
    const value = clean(tags.find(item => item.name === name && clean(item.value))?.value);
    if (value) return value;
  }
  return '';
}

function getMany(tags, names) {
  return tags.filter(item => names.includes(item.name)).map(item => clean(item.value)).filter(Boolean);
}

function noteField(tags, label) {
  const prefix = label + ': ';
  return clean(tags.find(item => item.name === 'N1' && item.value.startsWith(prefix))?.value.slice(prefix.length));
}

function parseCitation(tags) {
  const type = getTag(tags, 'TY').toUpperCase();
  const isArticle = ARTICLE_TYPES.has(type);
  const short = isArticle ? getTag(tags, 'J2', 'JA', 'J1') : '';
  const full = isArticle ? getTag(tags, 'JF') : '';
  const journal = isArticle ? getTag(tags, 'T2', 'JF', 'JO', 'J2', 'JA', 'J1') : getTag(tags, 'T2', 'BT');
  const sp = getTag(tags, 'SP');
  const ep = getTag(tags, 'EP');
  const date = getTag(tags, 'DA', 'Y1', 'PY');
  const year = getTag(tags, 'PY', 'Y1', 'DA').match(/\b[12]\d{3}\b/)?.[0] || '';
  const url = getTag(tags, 'UR', 'L2');
  const pubmedUrl = getMany(tags, ['UR', 'L2']).find(value => /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/?(?:[?#].*)?$/i.test(value));
  const pmid = normalizePmid(pubmedUrl?.match(/\.gov\/(\d+)/i)?.[1]) ||
    (/pubmed|medline/i.test(getTag(tags, 'DB', 'DP')) ? normalizePmid(getTag(tags, 'AN', 'ID')) : '');
  return {
    type, isArticle, title: getTag(tags, 'TI', 'T1', 'CT', 'BT'),
    authors: getMany(tags, ['AU']).length ? getMany(tags, ['AU']) : getMany(tags, ['A1']),
    journal, journalFull: noteField(tags, 'Journal full title') || (fold(full) !== fold(short) ? full : ''),
    journalAbbr: short, year, date, volume: getTag(tags, 'VL'), issue: getTag(tags, 'IS'),
    pages: sp && ep ? sp + '-' + ep : sp || noteField(tags, 'Article number'),
    doi: normalizeDoi(getTag(tags, 'DO')) || getMany(tags, ['UR', 'L2']).map(normalizeDoi).find(Boolean) || '',
    pmid, issn: getMany(tags, ['SN']).join(', '), url, publisher: getTag(tags, 'PB'),
    language: getTag(tags, 'LA')
  };
}

function replaceTags(tags, names, value, primary = names[0]) {
  const first = tags.findIndex(item => names.includes(item.name));
  const next = tags.filter(item => !names.includes(item.name));
  if (value) next.splice(first < 0 ? next.length : first, 0, { name: primary, value });
  return next;
}

function appendUnique(tags, additions) {
  const seen = new Set(tags.map(item => item.name + '\u0000' + clean(item.value)));
  const extra = additions.filter(item => {
    const key = item.name + '\u0000' + clean(item.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...tags, ...extra];
}

function withVerifiedFields(tags, fields) {
  const data = parseCitation(tags);
  const result = [...tags];
  const tag = (name, value) => { if (value) result.push({ name, value }); };
  if (!data.journalFull && fields.journal) tag('N1', 'Journal full title: ' + fields.journal);
  if (!data.journalAbbr) tag('J2', fields.journalAbbr);
  if (!data.journal) tag('JF', fields.journal);
  if (!data.title) tag('TI', fields.title);
  if (!data.authors.length) for (const author of fields.authors || []) tag('AU', author);
  if (!data.doi) tag('DO', fields.doi);
  if (!data.year) tag('PY', fields.year);
  if (!data.volume) tag('VL', fields.volume);
  if (!data.issue) tag('IS', fields.issue);
  if (!data.pages && fields.pages) {
    const pages = /^([a-z]*\d+)\s*[-‐‑‒–—−]\s*([a-z]*\d+)$/i.exec(fields.pages);
    tag('SP', pages ? pages[1] : fields.pages);
    if (pages) tag('EP', pages[2]);
  }
  return result;
}

function titleFor(title, rule, protectedWords = []) {
  if (rule === 'keep' || !title || !/[A-Za-z]/.test(title)) return title;
  const special = word => protectedWords.includes(word) || /[a-z][A-Z]|\d/.test(word) || /^[A-Z]{2,12}s?$/.test(word);
  const capitalize = word => special(word) ? word : word[0].toLocaleUpperCase('en-US') + word.slice(1);
  if (rule === 'subtitle') return title.replace(/(:\s*["'“‘(\[]*)([A-Za-z][A-Za-z0-9'-]*)/g,
    (_, start, word) => start + capitalize(word));
  const small = new Set('a an and as at but by for from in into of on or over per the to up via with'.split(' '));
  return title.replace(/[A-Za-z][A-Za-z0-9'-]*/g, (word, index) => {
    if (special(word)) return word;
    const first = !/[A-Za-z0-9]/.test(title.slice(0, index)) || /:\s*["'“‘(\[]*$/.test(title.slice(0, index));
    const lower = word.toLocaleLowerCase('en-US');
    if (rule === 'sentence') return first ? capitalize(lower) : lower;
    return first || index + word.length === title.length || !small.has(lower) ? capitalize(lower) : lower;
  });
}

function transformRis(raw, rules) {
  const before = parseCitation(raw);
  let tags = raw;
  const notes = [];
  const changes = [];
  const title = titleFor(before.title, rules.titleCase, rules.protect);
  if (title !== before.title) {
    // In a book the BT tag can be the title; in an article T2 belongs to the journal.
    const aliases = before.isArticle ? ['TI', 'T1', 'CT'] : ['TI', 'T1', 'CT', 'BT'];
    tags = tags.map(item => aliases.includes(item.name) && clean(item.value) === before.title ?
      { ...item, value: title } : item);
    changes.push('题名大小写');
  }
  if (before.isArticle && rules.journal !== 'keep') {
    const journal = rules.journal === 'full' ? before.journalFull : before.journalAbbr;
    if (!journal) notes.push(rules.journal === 'full' ? '缺少可核实的期刊全称' : '缺少标准期刊缩写');
    else if (journal !== before.journal || getTag(tags, 'JF', 'T2') !== journal) {
      if (rules.journal === 'abbreviated' && before.journalFull) {
        tags = appendUnique(tags, [{ name: 'N1', value: 'Journal full title: ' + before.journalFull }]);
      }
      tags = replaceTags(tags, ['T2', 'JF', 'JO'], journal, 'T2');
      tags = appendUnique(tags, [{ name: 'JF', value: journal }]);
      changes.push(rules.journal === 'full' ? '期刊全称' : '期刊缩写');
    }
  }
  if (rules.risDoi === 'omit' && (before.doi || getTag(tags, 'DO'))) {
    tags = tags.filter(item => item.name !== 'DO' && !(
      ['UR', 'L2'].includes(item.name) && /^https?:\/\/(?:dx\.)?doi\.org\//i.test(item.value)
    ));
    changes.push('RIS 省略 DOI');
  }
  const data = parseCitation(tags);
  if (rules.doiDisplay !== 'omit' && before.doi) data.doi = before.doi;
  if (!data.title) notes.push('未提供题名');
  if (!data.authors.length) notes.push('未提供作者');
  if (!data.year) notes.push('未提供年份');
  return { tags, data, notes, changes };
}

function orderRecords(records, order) {
  if (order === 'author') return [...records].sort((a, b) =>
    (a.data.authors[0] || '').localeCompare(b.data.authors[0] || ''));
  if (order === 'year-desc') return [...records].sort((a, b) => Number(b.data.year) - Number(a.data.year));
  return records;
}

function authorItem(value) {
  const parts = value.split(',').map(clean);
  if (parts.length > 1) {
    if (parts.length === 2 && !parts[1]) return { literal: parts[0] };
    return { family: parts[0], given: parts[1] || '', ...(parts[2] ? { suffix: parts[2] } : {}) };
  }
  const words = parts[0].split(' ');
  return { family: words.at(-1), given: words.slice(0, -1).join(' ') };
}

function dateFor(item) {
  const parts = item.date.match(/^([12]\d{3})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/);
  if (parts && (!item.year || parts[1] === item.year)) return parts.slice(1).filter(value => Number(value)).map(Number);
  return item.year ? [Number(item.year)] : [];
}

function cslItem(data, id, rules) {
  const journal = rules.journal === 'keep' ? data.journalFull || data.journal : data.journal;
  const issued = dateFor(data);
  return {
    id, type: data.isArticle ? 'article-journal' : CSL_TYPES[data.type] || 'document',
    title: data.title, author: data.authors.map(authorItem),
    'container-title': journal, 'container-title-short': rules.journal === 'full' ? journal : data.journalAbbr || data.journal,
    issued: issued.length ? { 'date-parts': [issued] } : undefined,
    volume: data.volume, issue: data.issue, page: data.pages, publisher: data.publisher,
    DOI: rules.doiDisplay === 'style' ? data.doi : '',
    URL: rules.doiDisplay === 'style' || !/^https?:\/\/(?:dx\.)?doi\.org\//i.test(data.url) ? data.url : '',
    language: data.language || undefined
  };
}

function modifyCsl(xml, rules) {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const bibliography = find(root, 'bibliography');
  if (!bibliography) throw new Error('此 CSL 样式未包含参考文献列表。');
  if (rules.order !== 'style') {
    const sort = find(bibliography, 'sort');
    if (sort) bibliography.removeChild(sort);
  }
  if (rules.etalMin) {
    for (const element of Array.from(root.getElementsByTagName('name'))) {
      element.removeAttribute('et-al-min');
      element.removeAttribute('et-al-use-first');
      element.removeAttribute('et-al-use-last');
    }
    bibliography.setAttribute('et-al-min', String(rules.etalMin));
    bibliography.setAttribute('et-al-use-first', String(rules.etalUseFirst));
    bibliography.setAttribute('et-al-use-last', 'false');
  }
  if (rules.authorNames !== 'style') {
    for (const node of Array.from(root.getElementsByTagName('names')).filter(node =>
      (node.getAttribute('variable') || '').split(/\s+/).includes('author'))) {
      let name = find(node, 'name');
      if (!name) {
        name = doc.createElementNS(root.namespaceURI, 'name');
        node.insertBefore(name, node.firstChild);
      }
      name.setAttribute('form', 'long');
      name.setAttribute('initialize', String(rules.authorNames === 'initials'));
      name.setAttribute('name-as-sort-order', 'all');
      if (rules.authorNames === 'initials') name.setAttribute('initialize-with', '. ');
      else {
        name.removeAttribute('initialize-with');
        for (const child of Array.from(name.getElementsByTagName('name-part'))) child.removeAttribute('initialize-with');
      }
    }
  }
  for (const node of Array.from(root.getElementsByTagName('text'))) {
    const variable = node.getAttribute('variable');
    if (rules.titleCase !== 'keep' && variable === 'title') node.removeAttribute('text-case');
    if (rules.journal !== 'keep' && ['container-title', 'container-title-short'].includes(variable)) {
      node.setAttribute('variable', 'container-title');
      node.removeAttribute('form');
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function renderAuthors(values, rules) {
  const available = rules.etalMin > 0 && values.length >= rules.etalMin;
  const list = available ? values.slice(0, rules.etalUseFirst) : values;
  const display = list.map(authorItem).map(author => {
    if (author.literal) return author.literal;
    const given = rules.authorNames === 'full' ? author.given : author.given
      .split(/[ .-]+/).filter(Boolean).map(word => (/^[A-Z]{2,4}$/.test(word) ? [...word].join('. ') : word[0]) + '.').join(' ');
    return [author.family, given, author.suffix].filter(Boolean).join(' ');
  });
  return [...display, ...(available ? ['et al.'] : [])].join(', ');
}

function renderPattern(data, rules) {
  const doi = rules.doiDisplay === 'omit' ? '' : rules.doiDisplay === 'bare' ? data.doi :
    (data.doi ? 'https://doi.org/' + data.doi : '');
  const fields = { ...data, authors: renderAuthors(data.authors, rules), doi };
  const escaped = rules.template.replace(/\[\[([^\[\]]+)\]\]/g, (_, group) => {
    const required = [...group.matchAll(/\{([a-z]+)\}/g)];
    return required.every(match => fields[match[1]]) ? group : '';
  }).split(/(\{[a-z]+\})/g).map(part => {
    const match = /^\{([a-z]+)\}$/.exec(part);
    if (!match) return escape(part);
    const val = escape(fields[match[1]] || '');
    if (match[1] === 'journal' && rules.italicJournal) return '<i>' + val + '</i>';
    if (match[1] === 'volume' && rules.boldVolume) return '<b>' + val + '</b>';
    return val;
  }).join('');
  return '<div class="csl-entry">' + escaped + '</div>';
}

function getLocale(locale) {
  const name = /^zh/i.test(locale) ? 'zh-CN' : /^en-GB/i.test(locale) ? 'en-GB' : 'en-US';
  if (!citeLocales.has(name)) citeLocales.set(name, fs.readFileSync(path.join(__dirname, 'styles', 'locales-' + name + '.xml'), 'utf8'));
  return citeLocales.get(name);
}

function citationBibliography(records, style, rules) {
  if (!records.length) return { html: '', text: '', entries: [] };
  let rendered;
  if (rules.template) rendered = records.map(item => renderPattern(item.data, rules));
  else {
    const entries = records.map((item, index) => cslItem(item.data, String(index + 1), rules));
    const values = new Map(entries.map(item => [item.id, item]));
    const engine = new CSL.Engine({ retrieveLocale: getLocale, retrieveItem: id => values.get(id) }, modifyCsl(style, rules));
    engine.setOutputFormat('html');
    engine.updateItems(entries.map(item => item.id));
    const bibliography = engine.makeBibliography();
    if (!bibliography) throw new Error('此 CSL 样式无法生成参考文献列表。');
    rendered = bibliography[1];
    if (['bare', 'url'].includes(rules.doiDisplay)) rendered = rendered.map((entry, index) => {
      const id = Number(bibliography[0].entry_ids?.[index]?.[0]);
      const doi = records[id - 1]?.data.doi;
      const text = rules.doiDisplay === 'bare' ? doi : 'https://doi.org/' + doi;
      return doi ? entry.replace(/<\/div>(\s*)$/, ' ' + escape(text) + '</div>$1') : entry;
    });
  }
  const options = { allowedTags: ['div', 'i', 'em', 'b', 'strong', 'span', 'sup', 'sub', 'u', 'a'],
    allowedAttributes: { div: ['class'], a: ['href'] }, allowedSchemes: ['https', 'http'], allowProtocolRelative: false };
  const safe = rendered.map(entry => sanitize(entry, options));
  const plain = safe.map(entry => convert(entry, {
    wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }]
  }).trim().replace(/^(\[?\d+\]?[.)]?)\s*\n\s*/, '$1 '));
  return { html: safe.join('\n'), text: plain.join('\n\n') + '\n', entries: plain };
}

module.exports = {
  DEFAULT_RULES, ENUMS, TEMPLATE_HELP, validateRules, parseCitation, transformRis, withVerifiedFields,
  orderRecords, citationBibliography, titleFor
};
