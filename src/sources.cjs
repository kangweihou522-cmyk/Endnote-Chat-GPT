const { setTimeout: delay } = require('node:timers/promises');
const { parseXml, elements, find, value } = require('./endnote.cjs');
const { clean, sourceText, normalizeDoi, normalizePmid, normalizeIssns, formatAuthor, nameParts } = require('./bibliography.cjs');

const CROSSREF = 'https://api.crossref.org';
const PUBMED = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const AGENT = 'EndNote-ChatGPT/0.1 (https://github.com/kangweihou522-cmyk/Endnote-Chat-GPT)';
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.toLowerCase().split(' ');
const LIMIT = 6;

function dateParts([year, month, day] = []) {
  if (!/^[12]\d{3}$/.test(String(year || ''))) return [];
  const normalizedMonth = Number(month) || MONTHS.indexOf(String(month || '').slice(0, 3).toLowerCase()) + 1;
  if (!Number.isInteger(normalizedMonth) || normalizedMonth < 1 || normalizedMonth > 12) return [String(year)];
  const parts = [String(year), String(normalizedMonth).padStart(2, '0')];
  const lastDay = new Date(Date.UTC(Number(year), normalizedMonth, 0)).getUTCDate();
  if (Number.isInteger(Number(day)) && Number(day) >= 1 && Number(day) <= lastDay) parts.push(String(Number(day)).padStart(2, '0'));
  return parts;
}

function dates(publication, online = [], kind = 'issue') {
  const parts = publication.length ? publication : online;
  return {
    year: parts[0] || '', date: parts.length > 1 ? parts.join('-') : '',
    dateKind: publication.length ? kind : 'online', onlineYear: online[0] || '',
    epubDate: online.length > 1 ? online.join('-') : ''
  };
}

function crossrefWork(work) {
  if (work?.type !== 'journal-article') return null;
  const doi = normalizeDoi(work.DOI);
  const depositedTitle = sourceText(work.title?.[0]);
  const original = sourceText(work['original-title']?.[0]);
  const title = original || depositedTitle;
  if (!title || !doi) return null;
  const parts = field => dateParts(work[field]?.['date-parts']?.[0]);
  const articlePrint = parts('published-print');
  const issuePrint = dateParts(work['journal-issue']?.['published-print']?.['date-parts']?.[0]);
  const print = articlePrint.length ? articlePrint : issuePrint;
  const online = parts('published-online');
  const general = parts('published').length ? parts('published') : parts('issued');
  return {
    source: 'Crossref', url: 'https://doi.org/' + encodeURI(doi).replace(/[?#]/g, encodeURIComponent),
    title, otherTitle: original && original !== depositedTitle ? depositedTitle : '',
    translationLanguage: '', authors: (work.author || []).map(author => formatAuthor({
      family: clean(author.family), given: clean(author.given), suffix: clean(author.suffix),
      collective: clean(author.name)
    })).filter(Boolean),
    journal: sourceText(work['container-title']?.[0]),
    abbreviations: (work['short-container-title'] || []).map(sourceText).filter(Boolean),
    volume: clean(work.volume), issue: clean(work.issue || work['journal-issue']?.issue),
    pages: clean(work.page || work['article-number']), doi, pmid: '',
    issns: normalizeIssns([...(work.ISSN || []), ...(work['issn-type'] || []).map(item => item.value)]),
    ...dates(print.length || online.length ? print : general, online, print.length ? 'issue' : 'unspecified')
  };
}

function parsePubmed(text) {
  // NCBI declares its public DTD. No external entities or DTD are needed for citation fields.
  const xml = text.replace(/<!DOCTYPE PubmedArticleSet PUBLIC "[^"]+" "[^"]+"\s*>/i, '');
  if (/<!DOCTYPE\s|<!ENTITY\s/i.test(xml)) throw new Error('PubMed XML 包含不支持的声明。');
  const doc = parseXml(xml);
  if (doc.documentElement?.tagName !== 'PubmedArticleSet') throw new Error('PubMed 没有返回有效的文献记录。');
  return elements(doc.documentElement, 'PubmedArticle').map(node => {
    const medline = find(node, 'MedlineCitation');
    const article = find(medline, 'Article');
    const journal = find(article, 'Journal');
    const issue = find(journal, 'JournalIssue');
    const pubDate = find(issue, 'PubDate');
    const pubmed = find(node, 'PubmedData');
    const pmid = normalizePmid(value(medline, 'PMID'));
    const identifiers = elements(find(pubmed, 'ArticleIdList'), 'ArticleId');
    const locations = elements(article, 'ELocationID').filter(id => id.getAttribute('ValidYN') !== 'N');
    const doi = normalizeDoi(identifiers.find(id => id.getAttribute('IdType') === 'doi')?.textContent)
      || normalizeDoi(locations.find(id => id.getAttribute('EIdType') === 'doi')?.textContent);
    const englishTitle = value(article, 'ArticleTitle');
    const original = value(article, 'VernacularTitle');
    const title = original || englishTitle;
    const authors = elements(find(article, 'AuthorList'), 'Author').map(author => formatAuthor({
      family: value(author, 'LastName'), given: value(author, 'ForeName') || value(author, 'Initials'),
      suffix: value(author, 'Suffix'), collective: value(author, 'CollectiveName')
    })).filter(Boolean);
    const electronic = elements(article, 'ArticleDate').find(item => item.getAttribute('DateType') === 'Electronic')
      || elements(find(pubmed, 'History'), 'PubMedPubDate').find(item => item.getAttribute('PubStatus') === 'epublish');
    const issueDate = dateParts([value(pubDate, 'Year'), value(pubDate, 'Month'), value(pubDate, 'Day')]);
    const medlineDate = value(pubDate, 'MedlineDate');
    const year = issueDate.length ? issueDate : dateParts([medlineDate.match(/^[12]\d{3}\b/)?.[0]]);
    const online = dateParts([value(electronic, 'Year'), value(electronic, 'Month'), value(electronic, 'Day')]);
    const pagination = find(article, 'Pagination');
    const firstPage = value(pagination, 'StartPage');
    const lastPage = value(pagination, 'EndPage');
    const pageRange = firstPage && lastPage ? firstPage + '-' + lastPage : '';
    return {
      source: 'PubMed', url: pmid ? 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/' : '',
      pmid, doi, title, otherTitle: original ? englishTitle.replace(/^\[(.*)\]\.?$/u, '$1') : '',
      translationLanguage: original && englishTitle ? 'English' : '',
      authors, journal: value(journal, 'Title'),
      abbreviations: [value(journal, 'ISOAbbreviation'), value(medline, 'MedlineJournalInfo', 'MedlineTA')].filter(Boolean),
      volume: value(issue, 'Volume'), issue: value(issue, 'Issue'),
      pages: pageRange || value(pagination, 'MedlinePgn') || firstPage ||
        clean(locations.find(id => id.getAttribute('EIdType') === 'pii')?.textContent),
      issns: normalizeIssns([value(journal, 'ISSN'), value(medline, 'MedlineJournalInfo', 'ISSNLinking')]),
      ...dates(year, online)
    };
  }).filter(work => work.pmid && work.title);
}

function urlFor(base, parameters) {
  const url = new URL(base);
  for (const [key, val] of Object.entries(parameters)) url.searchParams.set(key, val);
  return url;
}

function providers(http = fetch) {
  const lastStart = new Map();

  async function request(service, url, signal, json = true) {
    const interval = service === 'Crossref' ? 1100 : 350;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = (lastStart.get(service) || 0) + interval - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal?.throwIfAborted();
      lastStart.set(service, Date.now());
      let response;
      try {
        response = await http(url, {
          headers: { 'User-Agent': AGENT, Accept: json ? 'application/json' : 'application/xml' },
          redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(14000)]) : AbortSignal.timeout(14000)
        });
        if (response.ok) return await (json ? response.json() : response.text());
        if (response.status === 404) return null;
        const retryable = response.status === 429 || response.status >= 500;
        const retryHeader = response.headers.get('retry-after');
        const retry = retryHeader && !/^\d+$/.test(retryHeader)
          ? Math.max(0, Date.parse(retryHeader) - Date.now()) / 1000
          : Number(retryHeader || 1);
        await response.body?.cancel();
        if (retryable && attempt === 0 && retry <= 8) {
          await delay(retry * 1000, undefined, { signal });
          continue;
        }
        throw new Error('HTTP ' + response.status);
      } catch (error) {
        signal?.throwIfAborted();
        if (!response && attempt === 0) continue;
        throw new Error(error.message.startsWith('HTTP ') ? error.message : '连接或响应异常');
      }
    }
  }

  async function crossref(record, mode, signal) {
    if (mode === 'identifier') {
      if (!record.ids.doi) return [];
      const message = (await request('Crossref', CROSSREF + '/works/' + record.ids.doi.split('/').map(encodeURIComponent).join('/'), signal))?.message;
      return [crossrefWork(message)].filter(Boolean);
    }
    const data = record.data;
    if (!data.title) return [];
    const search = urlFor(CROSSREF + '/works', {
      'query.bibliographic': [data.title, data.authors[0], data.year, data.journal].filter(Boolean).join(' ').slice(0, 750),
      rows: LIMIT, filter: 'type:journal-article'
    });
    const items = (await request('Crossref', search, signal))?.message?.items;
    return (items || []).map(crossrefWork).filter(Boolean);
  }

  async function pubmed(record, mode, signal) {
    const params = { db: 'pubmed', tool: 'EndNoteChatGPT' };
    let ids;
    if (mode === 'identifier' && record.ids.pmid) ids = [record.ids.pmid];
    else {
      const title = record.data.title.replace(/[\[\]"]/g, ' ').slice(0, 750).trim();
      const doi = record.ids.doi.replace(/"/g, '');
      if (mode === 'identifier' ? !doi : !title) return [];
      const titleTerm = '"' + title + '"[Title]';
      const surname = record.data.authors[0] ? nameParts(record.data.authors[0]).family : '';
      const term = mode === 'identifier' ? '"' + doi + '"[AID]' : titleTerm;
      const search = (term) => request('PubMed', urlFor(PUBMED + '/esearch.fcgi', {
        ...params, term, retmode: 'json', retmax: LIMIT, sort: 'relevance'
      }), signal);
      let results = (await search(term))?.esearchresult;
      if (mode === 'title' && !results?.idlist?.length && surname) {
        const words = title.match(/[\p{L}\p{N}]+/gu) || [];
        const unique = [...new Set(words.filter(word => word.length > 4))].slice(0, 9);
        if (unique.length >= 3) {
          results = (await search(unique.map(word => word + '[Title]').join(' AND ') + ' AND ' + surname + '[Author]'))?.esearchresult;
        }
      }
      ids = (results?.idlist || []).map(normalizePmid).filter(Boolean);
    }
    if (!ids.length) return [];
    const text = await request('PubMed', urlFor(PUBMED + '/efetch.fcgi', {
      ...params, id: ids.join(','), retmode: 'xml'
    }), signal, false);
    return text ? parsePubmed(text) : [];
  }

  return { Crossref: crossref, PubMed: pubmed };
}

module.exports = { providers, crossrefWork, parsePubmed };
