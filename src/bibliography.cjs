const { decodeHTML } = require('entities');

const FIELDS = [
  ['journal', '期刊全称'], ['title', '标题'], ['authors', '作者全名'],
  ['volume', '卷'], ['issue', '期'], ['pages', '页码 / 文章编号'],
  ['date', '出版日期'], ['epubDate', '网络发表日期'], ['doi', 'DOI'], ['issn', 'ISSN'],
  ['year', '年份'], ['translatedTitle', '译名（Translated Title）']
];

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function sourceText(value) {
  return clean(decodeHTML(clean(value).replace(/<\/?(?:[a-z]+:)?[a-z][\w.-]*(?:\s+[^<>]*)?\s*\/?>/gi, '')));
}

function normalized(value) {
  return clean(value).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function fold(value) {
  return normalized(value).replace(/ /g, '');
}

function normalizeDoi(value) {
  let doi = clean(value).replace(/^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '');
  if (/%[0-9a-f]{2}/i.test(doi)) {
    try { doi = decodeURIComponent(doi); } catch { /* Keep the deposited spelling. */ }
  }
  return /^10\.\d{4,9}\/[^\s<>"\u0000-\u001f]+$/iu.test(doi) ? doi.toLowerCase() : '';
}

function normalizePmid(value) {
  return /^[1-9]\d{0,9}$/.test(clean(value)) ? clean(value) : '';
}

function normalizeIssns(values) {
  return [...new Set(values.flatMap(value => [...clean(value).matchAll(/\b(\d{4})-?(\d{3}[\dX])\b/gi)]
    .map(match => (match[1] + '-' + match[2]).toUpperCase())))
  ].filter(issn => {
    const digits = issn.replace('-', '').split('').map(letter => letter === 'X' ? 10 : Number(letter));
    return digits.reduce((total, digit, index) => total + digit * (8 - index), 0) % 11 === 0;
  }).sort();
}

function formatAuthor({ family = '', given = '', suffix = '', collective = '' }) {
  if (collective) return collective + ',';
  return [family, given, suffix].filter(Boolean).join(', ');
}

function nameParts(author) {
  const comma = author.includes(',');
  const parts = author.split(',').map(clean);
  const [name, given = '', suffix = ''] = parts;
  if (comma && !given && author.endsWith(',')) return { family: fold(name), given: [], collective: true, suffix: '' };
  const words = name.split(' ');
  const givenText = comma ? given : words.slice(0, -1).join(' ');
  const givenWords = /^[A-Z]{2,4}$/.test(givenText) ? givenText.toLowerCase().split('') :
    normalized(givenText).split(' ').filter(Boolean);
  return {
    family: fold(comma ? name : words.at(-1)),
    given: givenWords,
    suffix: fold(suffix),
    collective: false
  };
}

function authorCompatible(left, right) {
  const a = nameParts(left);
  const b = nameParts(right);
  if (a.family !== b.family || !a.family || a.collective !== b.collective ||
      (a.suffix && b.suffix && a.suffix !== b.suffix)) return false;
  const aGiven = a.given;
  const bGiven = b.given;
  return aGiven.slice(0, bGiven.length).every((word, index) => {
    const other = bGiven[index];
    return word === other || (word[0] === other[0] && (word.length === 1 || other.length === 1));
  });
}

function richerAuthor(left, right) {
  const weight = name => {
    const parts = nameParts(name);
    return parts.given.join('').length + parts.suffix.length;
  };
  return weight(left) >= weight(right) ? left : right;
}

function authorListsCompatible(a, b) {
  return a.length === b.length && a.every((author, index) => authorCompatible(author, b[index]));
}

function display(value) {
  return Array.isArray(value) ? value.join('\n') : (value || '');
}

module.exports = {
  FIELDS, clean, sourceText, normalized, fold, normalizeDoi, normalizePmid, normalizeIssns,
  formatAuthor, nameParts, authorCompatible, authorListsCompatible, richerAuthor, display
};
