const { test } = require('node:test');
const assert = require('node:assert/strict');
const { titleRecord, exportRis, risFileName } = require('../src/ris.cjs');
const { findFullText } = require('../src/fulltext.cjs');
const { inspectRecord } = require('../src/review.cjs');
const { crossrefWork } = require('../src/sources.cjs');

const TITLE = 'DREADDs (Designer Receptors Exclusively Activated by Designer Drugs): Chemogenetic Tools with Therapeutic Utility';
const DOI = '10.1146/annurev-pharmtox-010814-124803';
const work = crossrefWork({
  type: 'journal-article', DOI, title: [TITLE],
  'container-title': ['Annual Review of Pharmacology and Toxicology'],
  volume: '55', page: '399–417', ISSN: ['0362-1642', '1545-4304'],
  'published-print': { 'date-parts': [[2015, 1]] },
  author: [{ family: 'Urban', given: 'Daniel J.' }, { family: 'Roth', given: 'Bryan L.' }]
});

test('title only finds the record and exports UTF-8 RIS with a separate translated title', async () => {
  const result = await inspectRecord(titleRecord(TITLE), { Crossref: async () => [work] }, 'Simplified Chinese');
  assert.equal(result.status, 'matched');
  const translation = result.fields.find(field => field.key === 'translatedTitle');
  Object.assign(translation, { proposed: 'DREADDs：具有治疗潜力的化学遗传学工具', status: 'ai' });
  const lines = exportRis(result.fields).split('\r\n');
  assert.deepEqual(lines, [
    'TY  - JOUR', 'TI  - ' + TITLE, 'AU  - Urban, Daniel J.', 'AU  - Roth, Bryan L.',
    'T2  - Annual Review of Pharmacology and Toxicology', 'JF  - Annual Review of Pharmacology and Toxicology',
    'PY  - 2015', 'DA  - 2015/01//', 'VL  - 55', 'SP  - 399', 'EP  - 417',
    'DO  - ' + DOI, 'SN  - 0362-1642', 'SN  - 1545-4304',
    'TT  - DREADDs：具有治疗潜力的化学遗传学工具', 'UR  - https://doi.org/' + DOI, 'ER  -', ''
  ]);
  assert.equal(titleRecord('https://doi.org/' + DOI).ids.doi, DOI);
});

test('homonymous titles require selection and field conflicts require opt-in', async () => {
  const result = await inspectRecord(titleRecord(TITLE), {
    Crossref: async () => [work, { ...work, doi: '10.1000/other' }]
  }, 'Simplified Chinese');
  assert.equal(result.selected, null);
  const title = { key: 'title', proposed: 'A title\r\nER  - injected', status: 'review' };
  const issue = { key: 'issue', proposed: '2', status: 'review' };
  assert.throws(() => exportRis([title, issue]), /确认论文题名/);
  assert.doesNotMatch(exportRis([title, issue], ['title']), /\r\nIS  -|\r\nER  - injected/);
  assert.match(exportRis([title, issue], ['title', 'issue']), /\r\nIS  - 2/);
  assert.equal(risFileName('CON'), 'reference.ris');
});

test('PDF search checks identifiers, deduplicates links, and prioritizes free PDFs', async () => {
  const found = await findFullText([{ ...work, pmid: '25292433', pdfUrls: [
    'https://publisher.example.org/preview.pdf', 'file:///account.txt'
  ] }], undefined, async url => {
    assert.equal(url.searchParams.get('query'), 'EXT_ID:25292433 AND SRC:MED');
    return Response.json({ resultList: { result: [
      { doi: DOI, pmid: '25292433', pmcid: 'PMC1234', fullTextUrlList: { fullTextUrl: [
        { url: 'https://archive.example.org/file.pdf', availabilityCode: 'F', documentStyle: 'pdf' },
        { url: 'https://archive.example.org/file.pdf', availabilityCode: 'OA', documentStyle: 'pdf' },
        { url: 'https://archive.example.org/page', documentStyle: 'html' },
        { url: 'https://127.0.0.1/file.pdf', availabilityCode: 'OA', documentStyle: 'pdf' }
      ] } },
      { doi: '10.1000/another', pmid: '25292433', fullTextUrlList: { fullTextUrl: [
        { url: 'https://archive.example.org/wrong.pdf', availabilityCode: 'OA', documentStyle: 'pdf' }
      ] } }
    ] } });
  });
  assert.deepEqual(found.links.map(link => link.kind), ['freePdf', 'pdf', 'archive', 'publisher', 'index']);
  assert.equal(found.links[0].url, 'https://archive.example.org/file.pdf');
  assert.equal(found.links[2].url, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234/');
});

test('PDF service failure still returns the verified publication page', async () => {
  const found = await findFullText([work], undefined, async () => new Response('', { status: 503 }));
  assert.match(found.warning, /Europe PMC/);
  assert.deepEqual(found.links, [{ url: 'https://doi.org/' + DOI, kind: 'publisher', source: 'DOI' }]);
});
