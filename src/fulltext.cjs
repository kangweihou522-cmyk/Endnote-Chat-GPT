const { normalizeDoi, normalizePmid } = require('./bibliography.cjs');

const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

function webUrl(raw) {
  if (typeof raw !== 'string') return '';
  const url = URL.parse(raw);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test)$/i.test(url.hostname)) return '';
  return url.href;
}

function addLink(links, raw, kind, source) {
  const url = webUrl(raw);
  if (url && !links.has(url)) links.set(url, { url, kind, source });
}

async function findFullText(group, signal, http = fetch) {
  const doi = group.find(work => work.doi)?.doi || '';
  const pmid = group.find(work => work.pmid)?.pmid || '';
  const links = new Map();
  const archives = new Set(group.map(work => work.pmcid).filter(Boolean));
  let warning = '';
  if (pmid || doi) {
    const query = pmid ? 'EXT_ID:' + pmid + ' AND SRC:MED' : 'DOI:"' + doi + '"';
    const endpoint = new URL(EUROPE_PMC);
    endpoint.search = new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: '10' });
    try {
      const timeout = AbortSignal.timeout(10000);
      const response = await http(endpoint, {
        headers: { Accept: 'application/json' }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) throw new Error('欧洲 PMC 查询失败');
      const api = await response.json();
      for (const item of api.resultList?.result || []) {
        const returnedDoi = normalizeDoi(item.doi);
        const returnedPmid = normalizePmid(item.pmid || (item.source === 'MED' ? item.id : ''));
        if ((doi && returnedDoi && doi !== returnedDoi) || (pmid && returnedPmid && pmid !== returnedPmid) ||
            !((doi && doi === returnedDoi) || (pmid && pmid === returnedPmid))) continue;
        if (/^PMC\d+$/.test(item.pmcid || '')) archives.add(item.pmcid);
        for (const link of item.fullTextUrlList?.fullTextUrl || []) {
          const available = /^(?:oa|f|free)$/i.test(link.availabilityCode || '') ||
            /^(?:open access|free|free access)$/i.test(link.availability || '');
          if (/^pdf$/i.test(link.documentStyle || '')) {
            addLink(links, link.url, available ? 'freePdf' : 'pdf', 'Europe PMC');
          }
        }
      }
    } catch {
      signal?.throwIfAborted();
      warning = 'Europe PMC 暂时不可用，已保留其他来源的链接。';
    }
  }

  for (const work of group) {
    for (const url of work.pdfUrls || []) addLink(links, url, 'pdf', work.source);
  }
  for (const id of archives) {
    if (/^PMC\d+$/.test(id)) addLink(links, 'https://pmc.ncbi.nlm.nih.gov/articles/' + id + '/', 'archive', 'PubMed Central');
  }
  if (doi) addLink(links, 'https://doi.org/' + encodeURI(doi).replace(/[?#]/g, encodeURIComponent), 'publisher', 'DOI');
  if (pmid) addLink(links, 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', 'index', 'PubMed');
  const rank = { freePdf: 0, pdf: 1, archive: 2, publisher: 3, index: 4 };
  return { links: [...links.values()].sort((a, b) => rank[a.kind] - rank[b.kind]), warning };
}

module.exports = { findFullText, webUrl };
