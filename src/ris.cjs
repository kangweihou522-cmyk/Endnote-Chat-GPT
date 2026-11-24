const { FIELDS, clean, normalizeDoi, normalizeIssns, fold } = require('./bibliography.cjs');

function titleRecord(raw) {
  const title = clean(raw);
  if (!fold(title) || title.length > 750) throw new Error('请输入 750 字以内的论文标题或 DOI。');
  const doi = normalizeDoi(title);
  const data = Object.fromEntries(FIELDS.map(([key]) => [key, key === 'authors' ? [] : '']));
  data.title = doi ? '' : title;
  data.doi = doi;
  return { index: 0, supported: true, data, ids: { doi, pmid: '' } };
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

function exportRis(fields, approved = []) {
  const data = Object.fromEntries(fields
    .filter(field => field.status !== 'review' || approved.includes(field.key))
    .map(field => [field.key, field.proposed]));
  if (!clean(data.title)) throw new Error('请确认论文题名后再保存 RIS。');

  const lines = ['TY  - JOUR'];
  const tag = (name, value) => {
    const text = clean(value).replace(/[\u0000-\u001f\u007f]/g, '');
    if (text) lines.push(name + '  - ' + text);
  };

  tag('TI', data.title);
  if (Array.isArray(data.authors)) for (const author of data.authors) tag('AU', author);
  // T2 supports the RefMan RIS journal mapping. JF explicitly preserves the full name.
  tag('T2', data.journal);
  tag('JF', data.journal);
  tag('PY', data.year);
  tag('DA', risDate(data.date));
  tag('VL', data.volume);
  tag('IS', data.issue);
  const [startPage, endPage] = risPages(data.pages);
  tag('SP', startPage);
  tag('EP', endPage);
  const doi = normalizeDoi(data.doi);
  tag('DO', doi);
  for (const issn of normalizeIssns([data.issn])) tag('SN', issn);
  tag('TT', data.translatedTitle);
  if (data.epubDate) tag('N1', 'Epub date: ' + data.epubDate);
  if (doi) tag('UR', 'https://doi.org/' + encodeURI(doi).replace(/[?#]/g, encodeURIComponent));
  lines.push('ER  -', '');
  return lines.join('\r\n');
}

function risFileName(title) {
  const base = clean(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
    .slice(0, 90).replace(/^[ .]+|[ .]+$/g, '');
  return (!base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? 'reference' : base) + '.ris';
}

module.exports = { titleRecord, exportRis, risFileName };
