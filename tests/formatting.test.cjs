const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parsePubmed, crossrefWork } = require('../src/sources.cjs');
const { titleRecord, pickRisFields, exportRis, parseRis, serializeRis, decodeRis } = require('../src/ris.cjs');
const { validateRules, parseCitation, transformRis, citationBibliography, titleFor } = require('../src/citation.cjs');
const { readBatch, batchResult, verifyMissing, registerFormatting } = require('../src/formatting.cjs');
const { styleLibrary, chatRules, readGuide, guideRules } = require('../src/styles.cjs');

const DOI = '10.1146/annurev-pharmtox-010814-124803';
const TITLE = 'DREADDs: chemogenetic tools';
const FULL = 'Annual Review of Pharmacology and Toxicology';
const SHORT = 'Annu Rev Pharmacol Toxicol';
const ARTICLE = [
  'TY  - JOUR', 'TI  - ' + TITLE, 'AU  - Urban, Daniel J.', 'AU  - Roth, Bryan L.',
  'T2  - ' + SHORT, 'JF  - ' + FULL, 'J2  - ' + SHORT,
  'PY  - 2015', 'VL  - 55', 'SP  - 399', 'EP  - 417', 'DO  - ' + DOI,
  'UR  - https://doi.org/' + DOI, 'UR  - https://pubmed.ncbi.nlm.nih.gov/25292433/',
  'AB  - Abstract line one', '      Abstract line two', 'XX  - 外部软件保留字段', 'ER  -', ''
].join('\n');
const BOOK = ['TY  - BOOK', 'TI  - Example handbook', 'AU  - Example, Alex', 'PY  - 2020',
  'PB  - Example Publisher', 'XX  - retained', 'ER  -', ''].join('\n');

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'endnote-workstation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('mixed RIS retains the number, types, author order, multiline abstracts, and unknown tags', () => {
  const records = parseRis(ARTICLE + '\n' + BOOK);
  assert.equal(records.length, 2);
  const rules = validateRules({ journal: 'full', titleCase: 'subtitle', risDoi: 'omit' });
  const changed = records.map(tags => transformRis(tags, rules).tags);
  const roundTrip = parseRis(serializeRis(changed));
  assert.deepEqual(roundTrip, changed);
  const data = parseCitation(roundTrip[0]);
  assert.equal(data.title, 'DREADDs: Chemogenetic tools');
  assert.equal(data.journal, FULL);
  assert.equal(data.doi, '');
  assert.deepEqual(data.authors, ['Urban, Daniel J.', 'Roth, Bryan L.']);
  assert.ok(roundTrip[0].some(item => item.name === 'AB' && item.value === 'Abstract line one\nAbstract line two'));
  assert.ok(roundTrip[0].some(item => item.name === 'XX' && item.value === '外部软件保留字段'));
  assert.ok(roundTrip[0].some(item => item.name === 'UR' && /pubmed/.test(item.value)));
  assert.deepEqual(roundTrip[1], records[1]);
  assert.equal(parseCitation(records[0]).doi, DOI);
  assert.equal(titleFor('DREADDs: miRNA Evaluations', 'sentence'), 'DREADDs: miRNA evaluations');
  assert.throws(() => parseRis('TY  - JOUR\nTI  - missing closure'), /缺少 ER/);
});

test('the shortened journal can be restored from a converted RIS without searching again', () => {
  const original = parseRis(ARTICLE.replace('T2  - ' + SHORT, 'T2  - ' + FULL))[0];
  const short = transformRis(original, validateRules({ journal: 'abbreviated' }));
  const reopened = parseRis(serializeRis([short.tags]))[0];
  assert.equal(parseCitation(reopened).journal, SHORT);
  assert.equal(parseCitation(reopened).journalFull, FULL);
  const long = transformRis(reopened, validateRules({ journal: 'full' }));
  assert.equal(parseCitation(long.tags).journal, FULL);
});

test('typed ISSNs, structured abstract, ORCID, authors, MeSH and identifiers enrich the RIS', () => {
  const pubmed = parsePubmed(`<PubmedArticleSet><PubmedArticle><MedlineCitation>
  <PMID>25292433</PMID><Article><Journal><ISSN IssnType="Electronic">1545-4304</ISSN>
  <JournalIssue><Volume>55</Volume><Issue>2 Suppl 1</Issue><PubDate><Year>2015</Year><Month>Jan</Month></PubDate></JournalIssue>
  <Title>${FULL}</Title><ISOAbbreviation>${SHORT}</ISOAbbreviation></Journal>
  <ArticleTitle>${TITLE}</ArticleTitle><Pagination><MedlinePgn>399-417</MedlinePgn></Pagination>
  <Language>eng</Language><Abstract><AbstractText Label="METHODS">Example methods.</AbstractText>
  <AbstractText Label="RESULTS">Example results.</AbstractText></Abstract>
  <AuthorList><Author><LastName>Urban</LastName><ForeName>Daniel J.</ForeName>
  <Identifier Source="ORCID">0000-0002-1825-0097</Identifier><AffiliationInfo><Affiliation>Example Unit</Affiliation></AffiliationInfo>
  </Author><Author><CollectiveName>Example Group</CollectiveName></Author></AuthorList>
  <PublicationTypeList><PublicationType>Review</PublicationType></PublicationTypeList></Article>
  <KeywordList><Keyword>Example keyword</Keyword></KeywordList>
  <MeshHeadingList><MeshHeading><DescriptorName>Example heading</DescriptorName>
  <QualifierName>methods</QualifierName></MeshHeading></MeshHeadingList>
  <MedlineJournalInfo><MedlineTA>${SHORT}</MedlineTA><ISSNLinking>0362-1642</ISSNLinking></MedlineJournalInfo>
  </MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${DOI}</ArticleId>
  <ArticleId IdType="pmc">PMC12345</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`)[0];
  const fields = pickRisFields(titleRecord(TITLE), [pubmed], 'English');
  const ris = exportRis(fields, [], [{ kind: 'freePdf', url: 'https://example.org/paper.pdf' }]);
  for (const fragment of [
    'AB  - METHODS: Example methods.', '      RESULTS: Example results.', 'KW  - Example keyword',
    'AN  - 25292433', 'DB  - PubMed', 'N1  - PMCID: PMC12345', 'N1  - Online ISSN: 1545-4304',
    'N1  - MeSH: Example heading/methods', 'N1  - Publication type: Review', 'N1  - Supplement: Suppl 1',
    'AU  - Example Group,', 'AD  - Urban, Daniel J. — Example Unit', 'https://orcid.org/0000-0002-1825-0097',
    'L1  - https://example.org/paper.pdf'
  ]) assert.ok(ris.includes(fragment), fragment);
});

test('multiple sources load with explicit encoding and selection, and missing facts can be verified', async t => {
  const dir = await scratch(t);
  const first = path.join(dir, 'first.ris');
  const second = path.join(dir, 'second.ris');
  const broken = path.join(dir, 'broken.ris');
  const legacy = ARTICLE.replace('JF  - ' + FULL + '\n', '').replace('J2  - ' + SHORT + '\n', '');
  await fs.writeFile(first, Buffer.from('\uFEFF' + legacy, 'utf16le'));
  await fs.writeFile(second, BOOK);
  await fs.writeFile(broken, 'PMID- 25292433');
  const batch = await readBatch([first, second, broken], 'auto');
  assert.equal(batch.records.length, 2);
  assert.equal(batch.errors.length, 1);
  assert.match(decodeRis(Buffer.from('545920202d204a4f55520a544920202d20b2e2cad40a455220202d0a', 'hex'), 'gb18030'), /测试/);
  const rules = validateRules({ journal: 'full', titleCase: 'subtitle' });
  const before = batchResult(batch, [0], rules);
  assert.ok(before[0].notes.some(note => note.includes('缺少可核实')));
  const work = crossrefWork({ type: 'journal-article', title: [TITLE], DOI, 'container-title': [FULL],
    'short-container-title': [SHORT], author: [{ family: 'Urban', given: 'Daniel J.' }, { family: 'Roth', given: 'Bryan L.' }],
    'published-print': { 'date-parts': [[2015]] }, volume: '55', page: '399-417' });
  await verifyMissing(batch, [batch.records[0]], rules, { Crossref: async () => [work] }, new AbortController().signal, () => {});
  const after = batchResult(batch, [0], rules);
  assert.equal(after[0].data.journal, FULL);
  assert.ok(after[0].changes.includes('联网补全'));
  assert.equal((await fs.readFile(first)).toString('utf16le'), '\uFEFF' + legacy);
});

test('journal profiles use CSL typography and can save local overrides', async t => {
  const dir = await scratch(t);
  const library = styleLibrary(dir, () => { throw new Error('Unexpected HTTP'); }, fs.writeFile);
  const style = await library.get('nature-methods');
  const rules = validateRules({ doiDisplay: 'omit' }, style.rules);
  const sample = transformRis(parseRis(ARTICLE)[0], rules);
  const citation = citationBibliography([sample], style.xml, rules);
  assert.match(citation.text, /Annu Rev Pharmacol Toxicol/);
  assert.doesNotMatch(citation.text, /10\.1146/);
  assert.match(citation.html, /<i>Annu Rev Pharmacol Toxicol<\/i>/);
  assert.ok(library.search('Nature Methods').some(item => item.file === 'dependent/nature-methods.csl'));
  const custom = await library.create({ name: 'My variants', baseId: 'nature-methods',
    rules: { journal: 'full', titleCase: 'subtitle', template: '{authors}. {title}. {journal}[[, {year}]].' } });
  const restored = await styleLibrary(dir, () => {}, fs.writeFile).get(custom.id);
  assert.equal(restored.rules.journal, 'full');
  assert.equal(restored.rules.titleCase, 'subtitle');
  assert.throws(() => validateRules({ etalMin: 5, etalUseFirst: 6 }), /少于|小于/);
  assert.throws(() => validateRules({ template: '{evil}' }), /无效/);
});

test('AI applies confirmed templates and requires explicit export intent', async () => {
  const reply = { reply: '使用已选条目。', profileId: 'zju', rules: { titleCase: 'subtitle' }, intent: 'export', format: 'ris', enrich: false };
  const auth = { generate: async () => ({ text: JSON.stringify(reply) }) };
  const profiles = [{ id: 'zju', name: '浙大学位论文', rules: validateRules({ journal: 'full' }) }];
  const request = { profileId: 'nlm', profiles, rules: validateRules({ journal: 'abbreviated' }), selected: 2 };
  assert.equal((await chatRules(auth, { request: { ...request, message: '只预览，先别导出' } })).intent, 'preview');
  const result = await chatRules(auth, { request: { ...request, message: '用浙大模板，立即导出 RIS' } });
  assert.equal(result.intent, 'export');
  assert.equal(result.profileId, 'zju');
  assert.equal(result.rules.journal, 'full');
  assert.equal(result.rules.titleCase, 'subtitle');
  await assert.rejects(chatRules(auth, { request: { ...request, profiles: [], message: '导出' } }), /先选择或添加/);
});

test('publisher HTML is cleaned and the rule draft only shows evidence found in the guide', async () => {
  const url = 'https://example.org/author-guide';
  const guide = await readGuide(async (address, options) => {
    assert.equal(address, url);
    assert.equal(options.credentials, 'omit');
    return new Response('<html><body><nav>Noise</nav><h2>References</h2><p>Use full journal names and keep page ranges.</p></body></html>',
      { headers: { 'content-type': 'text/html' } });
  }, url);
  assert.match(guide.text, /Use full journal names/);
  assert.doesNotMatch(guide.text, /Noise/);
  const draft = await guideRules({ generate: async () => ({ text: JSON.stringify({
    rules: { journal: 'full' }, summary: '期刊用全称。', evidence: ['Use full journal names', 'Not in the source']
  }) }) }, { text: guide.text, name: 'Example', base: { name: 'Example', rules: validateRules({}) } });
  assert.deepEqual(draft.evidence, ['Use full journal names']);
});

test('a journal matched in the CSL index resolves its dependent style and caches it locally', async t => {
  const dir = await scratch(t);
  const paths = [];
  const parent = await fs.readFile(path.join(__dirname, '..', 'src', 'styles', 'nature.csl'), 'utf8');
  const library = styleLibrary(dir, async url => {
    const file = new URL(url).pathname.split('/').at(-1);
    paths.push(file);
    if (file === 'nature.csl') return new Response(parent);
    return new Response(`<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
    <info><title>Journal of Clinical Medicine</title><id>http://www.zotero.org/styles/journal-of-clinical-medicine</id>
    <link rel="independent-parent" href="http://www.zotero.org/styles/nature"/></info></style>`);
  }, fs.writeFile);
  const entry = library.search('journal of clinical medicine').find(item => item.file === 'dependent/journal-of-clinical-medicine.csl');
  const selected = await library.install(entry.file);
  assert.equal(selected.name, 'Journal of Clinical Medicine');
  assert.equal(selected.rules.journal, 'abbreviated');
  assert.deepEqual(paths, ['journal-of-clinical-medicine.csl', 'nature.csl']);
  assert.equal((await library.install(entry.file)).id, selected.id);
  assert.equal(paths.length, 2);
});

test('batch saving uses a new path and does not overwrite a selected file', async t => {
  const dir = await scratch(t);
  const initial = path.join(dir, 'input.ris');
  const output = path.join(dir, 'output.ris');
  await fs.writeFile(initial, ARTICLE);
  const ipc = new Map();
  let target = initial;
  let recent;
  registerFormatting({
    register: (method, handler) => ipc.set(method, handler),
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [initial] }),
      showSaveDialog: async () => ({ canceled: false, filePath: target })
    },
    getWindow() {},
    userData: dir,
    saveOutput: fs.writeFile,
    withScan: fn => fn(new AbortController().signal),
    setRecent: value => { recent = value; }
  });
  const loaded = await ipc.get('batch-open')({ encoding: 'auto' });
  const arguments_ = { ids: loaded.records.map(record => record.id), profileId: 'zju-draft', format: 'ris' };
  await assert.rejects(ipc.get('batch-output')(arguments_), /新文件名/);
  assert.equal(await fs.readFile(initial, 'utf8'), ARTICLE);
  target = output;
  const saved = await ipc.get('batch-output')(arguments_);
  assert.equal(saved.count, 1);
  assert.equal(recent, output);
  const data = parseCitation(parseRis(await fs.readFile(output, 'utf8'))[0]);
  assert.equal(data.journal, FULL);
  assert.equal(data.title, 'DREADDs: Chemogenetic tools');
});
