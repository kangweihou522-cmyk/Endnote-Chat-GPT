const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { normalizeDoi, authorCompatible } = require('../src/bibliography.cjs');
const { readRecords, exportChanges, value, find } = require('../src/endnote.cjs');
const { providers, parsePubmed, crossrefWork } = require('../src/sources.cjs');
const { rankCandidates, pickFields, inspectRecord } = require('../src/review.cjs');
const { translateTitles, suggestCandidate } = require('../src/chatgpt.cjs');

const fixture = () => readRecords(readFileSync(path.join(__dirname, 'fixtures', 'dreadds.xml')));
const DOI = '10.1146/annurev-pharmtox-010814-124803';
const TITLE = 'DREADDs (Designer Receptors Exclusively Activated by Designer Drugs): Chemogenetic Tools with Therapeutic Utility';
const JOURNAL = 'Annual Review of Pharmacology and Toxicology';

// API-shaped fixtures based on the publication cited in the request.
const crossref = {
  type: 'journal-article', DOI, title: [TITLE], 'container-title': [JOURNAL],
  'short-container-title': ['Annu. Rev. Pharmacol. Toxicol.'],
  volume: '55', page: '399-417', ISSN: ['0362-1642', '1545-4304'],
  'published-print': { 'date-parts': [[2015, 1]] }, 'published-online': { 'date-parts': [[2014, 10, 9]] },
  author: [{ family: 'Urban', given: 'Daniel J.' }, { family: 'Roth', given: 'Bryan L.' }]
};
const pubmedXml = `<?xml version="1.0"?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed.dtd">
<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>25292433</PMID><Article>
<Journal><ISSN>1545-4304</ISSN><JournalIssue><Volume>55</Volume><PubDate><Year>2015</Year></PubDate></JournalIssue>
<Title>${JOURNAL}</Title><ISOAbbreviation>Annu Rev Pharmacol Toxicol</ISOAbbreviation></Journal>
<ArticleTitle>${TITLE.toLowerCase().replace('dreadds', 'DREADDs')}</ArticleTitle><Pagination><MedlinePgn>399-417</MedlinePgn></Pagination>
<AuthorList><Author><LastName>Urban</LastName><ForeName>Daniel J</ForeName><Initials>DJ</Initials></Author>
<Author><LastName>Roth</LastName><ForeName>Bryan L</ForeName><Initials>BL</Initials></Author></AuthorList>
<ArticleDate DateType="Electronic"><Year>2014</Year><Month>10</Month><Day>09</Day></ArticleDate>
</Article><MedlineJournalInfo><ISSNLinking>0362-1642</ISSNLinking></MedlineJournalInfo>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${DOI}</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle></PubmedArticleSet>`;

const field = (result, key) => result.fields.find(item => item.key === key);

test('title/author/year search checks the example and writes the selected fields into valid EndNote XML', async () => {
  const session = fixture();
  const called = [];
  const ds = providers(async input => {
    const url = new URL(input);
    called.push(url);
    if (url.hostname === 'api.crossref.org') return Response.json({ message: { items: [crossref] } });
    if (url.pathname.endsWith('/esearch.fcgi')) return Response.json({ esearchresult: { idlist: ['25292433'] } });
    return new Response(pubmedXml);
  });
  const result = await inspectRecord(session.records[0], ds, 'Simplified Chinese');
  assert.equal(result.status, 'matched');
  assert.equal(called.length, 3);
  assert.match(called.find(item => item.hostname === 'api.crossref.org').searchParams.get('query.bibliographic'), /DREADDs.*Urban.*2015/);
  assert.equal(field(result, 'journal').proposed, JOURNAL);
  assert.equal(field(result, 'journal').status, 'change');
  assert.equal(field(result, 'title').status, 'verified');
  assert.equal(field(result, 'issue').status, 'missing');
  assert.deepEqual(field(result, 'authors').proposed, ['Urban, Daniel J.', 'Roth, Bryan L.']);
  assert.equal(field(result, 'authors').status, 'change');
  assert.equal(field(result, 'date').proposed, '2015-01');
  assert.equal(field(result, 'epubDate').proposed, '2014-10-09');
  assert.equal(field(result, 'year').proposed, '2015');
  assert.equal(field(result, 'doi').proposed, DOI);
  assert.equal(field(result, 'issn').proposed, '0362-1642, 1545-4304');
  const exportXml = exportChanges(session, new Map([[0, result.fields.filter(item => item.status === 'change')]]));
  const reloaded = readRecords(Buffer.from(exportXml));
  assert.equal(reloaded.records[0].data.journal, JOURNAL);
  assert.equal(reloaded.records[0].data.pages, '399-417');
  assert.equal(reloaded.records[0].data.volume, '55');
  assert.equal(reloaded.records[0].data.epubDate, '2014-10-09');
  assert.equal(reloaded.records[0].data.doi, DOI);
  assert.equal(reloaded.records[0].data.title, session.records[0].data.title);
  assert.equal(session.records[0].data.doi, '');
  assert.equal(value(reloaded.nodes[0], 'notes'), 'XML 中的备注示例');
  assert.equal(find(reloaded.nodes[0], 'notes', 'style').getAttribute('face'), 'italic');
  assert.equal(value(reloaded.nodes[0], 'periodical', 'full-title'), JOURNAL);
});

test('a wrong DOI or another article with the same title requires confirmation', () => {
  const record = fixture().records[0];
  const first = crossrefWork(crossref);
  const second = { ...first, doi: '10.9999/another' };
  assert.equal(rankCandidates(record, [first, second]).selected, null);
  assert.equal(rankCandidates({ ...record, ids: { doi: second.doi } }, [first]).selected, null);
  const mismatched = { ...first, title: 'Unrelated article on an entirely different topic' };
  assert.equal(rankCandidates({ ...record, ids: { doi: first.doi } }, [mismatched]).selected, null);
  assert.equal(rankCandidates({ ...record, data: { ...record.data, title: '', authors: [], year: '' }, ids: { doi: first.doi } }, [first]).selected, 0);
});

test('keeps author order and only expands initials supported by the source', () => {
  assert.equal(authorCompatible('Wang, A. H.', 'Wang, Alina H.'), true);
  assert.equal(authorCompatible('Wang, AL', 'Wang, Alina N.'), false);
  assert.equal(authorCompatible('Wang, Amy', 'Wang, Alina'), false);
  const record = fixture().records[0];
  const work = crossrefWork(crossref);
  const incomplete = { ...work, authors: ['Urban, D. J.', 'Roth, B. L.'] };
  const prior = { ...record, data: { ...record.data, authors: work.authors } };
  assert.equal(pickFields(prior, [incomplete], 'English').find(row => row.key === 'authors').status, 'verified');
  const reversed = { ...work, source: 'PubMed', authors: [...work.authors].reverse() };
  assert.equal(pickFields(record, [work, reversed], 'English').find(row => row.key === 'authors').status, 'review');
});

test('treats an incompatible year as a conflict and never invents day, issue or ISSN', () => {
  const record = fixture().records[0];
  const first = crossrefWork(crossref);
  const [second] = parsePubmed(pubmedXml.replace('<Year>2015</Year>', '<Year>2016</Year>'));
  const result = { fields: pickFields(record, [first, second], 'English') };
  assert.equal(field(result, 'year').status, 'review');
  assert.equal(field(result, 'year').canApply, false);
  assert.equal(field(result, 'date').proposed, '2015-01');
  assert.equal(field(result, 'date').status, 'review');
  assert.equal(field(result, 'issue').proposed, '');
  const noIssn = crossrefWork({ ...crossref, ISSN: ['0362-1640'] });
  assert.deepEqual(noIssn.issns, []);
  assert.equal(normalizeDoi('https://doi.org/' + DOI.toUpperCase()), DOI);
});

test('a native source translation goes in EndNote Translated Title and is separate from the original', () => {
  const original = '阿尔茨海默病的临床评估与诊断';
  const foreign = pubmedXml.replace('<ArticleTitle>', '<VernacularTitle>' + original + '</VernacularTitle><ArticleTitle>[')
    .replace('</ArticleTitle>', '].</ArticleTitle>');
  const [work] = parsePubmed(foreign);
  const session = fixture();
  const record = { ...session.records[0], data: { ...session.records[0].data, title: original } };
  const fields = pickFields(record, [work], 'English');
  assert.equal(fields.find(item => item.key === 'title').proposed, original);
  const translation = fields.find(item => item.key === 'translatedTitle');
  assert.equal(translation.status, 'change');
  const reloaded = readRecords(Buffer.from(exportChanges(session, new Map([[0, [translation]]]))));
  assert.equal(reloaded.records[0].data.translatedTitle, work.otherTitle);
  assert.equal(reloaded.records[0].data.title, session.records[0].data.title);
});

test('rejects an unrelated XML or an entity declaration and skips non-articles', async () => {
  assert.throws(() => readRecords(Buffer.from('<rss/>')), /EndNote XML/);
  assert.throws(() => readRecords(Buffer.from('<!DOCTYPE xml [<!ENTITY note "x">]><xml/>')), /无法读取 XML/);
  const result = await inspectRecord({ supported: false }, { Crossref: () => assert.fail('unused') }, 'English');
  assert.equal(result.status, 'skipped');
});

test('treats missing provider access as a failed query rather than a verified empty field', async () => {
  const record = fixture().records[0];
  const result = await inspectRecord(record, {
    Crossref: async () => { throw new Error('HTTP 403'); },
    PubMed: async () => []
  }, 'English');
  assert.equal(result.status, 'failed');
  assert.match(result.warning, /Crossref HTTP 403/);
});

test('limits ChatGPT to title translation and candidate suggestions', async () => {
  const record = fixture().records[0];
  const translation = 'DREADDs：具有治疗潜力的化学遗传学工具';
  let seen;
  const auth = { generate: async options => { seen = options; return { text: JSON.stringify([translation]) }; } };
  assert.deepEqual(await translateTitles(auth, [record.data.title], 'Simplified Chinese', 'account-model'), [translation]);
  assert.deepEqual(JSON.parse(seen.messages[1].content), [record.data.title]);
  assert.equal(seen.model, 'account-model');
  const candidate = { group: [crossrefWork(crossref)] };
  await assert.rejects(suggestCandidate({ generate: async () => ({ text: '{"index":2,"reason":"超出列表"}' }) },
    record, [candidate], 'account-model'), /格式不完整/);
  await assert.rejects(translateTitles({ generate: async () => ({ text: '{"title":"bad"}' }) },
    [record.data.title], 'English', 'account-model'), /格式不完整/);
});
