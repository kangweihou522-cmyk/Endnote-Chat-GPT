const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { FIELDS, clean, normalizeDoi, normalizePmid } = require('./bibliography.cjs');

const PATHS = {
  journal: ['titles', 'secondary-title'],
  title: ['titles', 'title'],
  authors: ['contributors', 'authors'],
  volume: ['volume'],
  issue: ['number'],
  pages: ['pages'],
  date: ['dates', 'pub-dates', 'date'],
  epubDate: ['edition'],
  doi: ['electronic-resource-num'],
  issn: ['isbn'],
  year: ['dates', 'year'],
  translatedTitle: ['titles', 'translated-title']
};

const ORDERS = {
  record: [
    'database', 'source-app', 'rec-number', 'foreign-keys', 'ref-type', 'contributors',
    'titles', 'periodical', 'pages', 'volume', 'number', 'issue', 'secondary-volume',
    'secondary-issue', 'num-vols', 'edition', 'section', 'reprint-edition', 'reprint-status',
    'keywords', 'dates', 'pub-location', 'publisher', 'orig-pub', 'isbn', 'accession-num',
    'call-num', 'report-id', 'coden', 'electronic-resource-num', 'label', 'abstract',
    'notes', 'research-notes', 'urls'
  ],
  titles: ['title', 'short-title', 'secondary-title', 'tertiary-title', 'alt-title', 'translated-title'],
  contributors: ['authors', 'secondary-authors', 'tertiary-authors', 'subsidiary-authors', 'translated-authors'],
  periodical: ['full-title', 'abbr-1', 'abbr-2', 'abbr-3'],
  dates: ['year', 'pub-dates', 'copyright-dates']
};

function elements(node, tag) {
  return Array.from(node?.childNodes || []).filter(child => child.nodeType === 1 && (!tag || child.tagName === tag));
}

function find(node, ...path) {
  return path.reduce((parent, tag) => elements(parent, tag)[0], node);
}

function value(node, ...path) {
  return clean(find(node, ...path)?.textContent);
}

function parseXml(text) {
  return new DOMParser({ onError: (_, message) => { throw new Error(message); } }).parseFromString(text, 'text/xml');
}

function decodeXml(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function existingDate(record) {
  const node = find(record, ...PATHS.date);
  const text = clean(node?.textContent);
  if (!node || text) return text;
  const parts = ['year', 'month', 'day'].map(key => node.getAttribute(key));
  if (!/^\d{4}$/.test(parts[0] || '')) return '';
  return parts.filter(Boolean).map(part => part.padStart(2, '0')).join('-');
}

function getIdentifiers(record, data) {
  const database = value(record, 'remote-database-name') || value(record, 'remote-source');
  let pmid = /pubmed|medline/i.test(database) ? normalizePmid(value(record, 'accession-num')) : '';
  let doi = normalizeDoi(data.doi);
  const urls = ['web-urls', 'related-urls'].flatMap(tag => elements(find(record, 'urls', tag), 'url'));
  for (const element of urls) {
    try {
      const url = new URL(clean(element.textContent));
      if (!['https:', 'http:'].includes(url.protocol)) continue;
      if (!pmid && url.hostname === 'pubmed.ncbi.nlm.nih.gov') pmid = normalizePmid(url.pathname.split('/')[1]);
      if (!doi && ['doi.org', 'dx.doi.org'].includes(url.hostname)) doi = normalizeDoi(url.href);
    } catch { /* Other URLs are unrelated to article identifiers. */ }
  }
  return { doi, pmid };
}

function readRecords(bytes) {
  let doc;
  try {
    const text = decodeXml(bytes);
    if (/<!DOCTYPE\s|<!ENTITY\s/i.test(text)) throw new Error('Unsupported declaration');
    doc = parseXml(text);
  } catch {
    throw new Error('无法读取 XML。请在 EndNote 中使用 File → Export 并选择 XML。');
  }
  const container = find(doc.documentElement, 'records');
  if (doc.documentElement?.tagName !== 'xml' || !container) {
    throw new Error('这个文件不是 EndNote XML。请从 EndNote 导出所选条目。');
  }
  const nodes = elements(container, 'record');
  if (!nodes.length) throw new Error('这个 XML 文件没有文献条目。');
  const records = nodes.map((node, index) => {
    const referenceType = find(node, 'ref-type');
    const typeName = clean(referenceType?.getAttribute('name'));
    const supported = /^journal article$/i.test(typeName) ||
      (!typeName && value(node, 'ref-type') === '17');
    const data = Object.fromEntries(FIELDS.map(([key]) => [key, value(node, ...PATHS[key])]));
    const periodicalTitle = value(node, 'periodical', 'full-title');
    data.issue ||= value(node, 'issue');
    data.issn ||= value(node, 'issn');
    data.date = existingDate(node);
    data.authors = elements(find(node, ...PATHS.authors), 'author')
      .map(author => clean(author.textContent)).filter(Boolean);
    const formattedTitle = elements(find(node, ...PATHS.title), 'style')
      .some(style => !['', 'normal'].includes(style.getAttribute('face')) ||
        !['', 'default'].includes(style.getAttribute('font')) ||
        !['', '100%'].includes(style.getAttribute('size')));
    return {
      index, number: value(node, 'rec-number'), supported, data, periodicalTitle,
      ids: getIdentifiers(node, data), formattedTitle, typeName
    };
  });
  return { doc, nodes, records };
}

function ensure(parent, tag) {
  const existing = find(parent, tag);
  if (existing) return existing;
  const position = ORDERS[parent.tagName]?.indexOf(tag) ?? -1;
  const after = position < 0 ? null : elements(parent).find(child => ORDERS[parent.tagName].indexOf(child.tagName) > position);
  return parent.insertBefore(parent.ownerDocument.createElement(tag), after || null);
}

function putText(element, text) {
  const doc = element.ownerDocument;
  while (element.firstChild) element.removeChild(element.firstChild);
  const style = doc.createElement('style');
  style.setAttribute('face', 'normal');
  style.setAttribute('font', 'default');
  style.setAttribute('size', '100%');
  style.appendChild(doc.createTextNode(text));
  element.appendChild(style);
}

function applyField(node, key, text) {
  const path = PATHS[key];
  const element = path.reduce(ensure, node);
  if (key === 'authors') {
    for (const author of elements(element, 'author')) element.removeChild(author);
    for (const name of text) putText(element.appendChild(node.ownerDocument.createElement('author')), name);
  } else {
    putText(element, text);
  }
  if (key === 'journal') putText(ensure(ensure(node, 'periodical'), 'full-title'), text);
  if (key === 'issue' && find(node, 'issue')) putText(find(node, 'issue'), text);
  if (key === 'issn' && find(node, 'issn')) putText(find(node, 'issn'), text);
  if (key === 'date') {
    for (const attr of ['year', 'month', 'day', 'julian']) element.removeAttribute(attr);
  }
}

function exportChanges(session, changes) {
  const root = session.doc.documentElement.cloneNode(false);
  const container = find(session.doc.documentElement, 'records').cloneNode(false);
  root.appendChild(container);
  for (const [index, selected] of [...changes].sort((a, b) => a[0] - b[0])) {
    if (!selected.length) continue;
    const node = session.nodes[index].cloneNode(true);
    for (const field of selected) applyField(node, field.key, field.proposed);
    container.appendChild(node);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root) + '\n';
}

module.exports = { parseXml, elements, find, value, readRecords, exportChanges };
