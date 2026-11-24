const {
  FIELDS, fold, normalized, normalizeDoi, normalizeIssns, nameParts, authorListsCompatible,
  authorCompatible, richerAuthor
} = require('./bibliography.cjs');

function similarity(left, right) {
  const a = [...fold(left).slice(0, 500)];
  const b = [...fold(right).slice(0, 500)];
  if (!a.length || !b.length) return 0;
  if (a.join('') === b.join('')) return 1;
  const distance = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    let diagonal = distance[0];
    distance[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const upper = distance[j + 1];
      distance[j + 1] = Math.min(upper + 1, distance[j] + 1, diagonal + Number(a[i] !== b[j]));
      diagonal = upper;
    }
  }
  return 1 - distance[b.length] / Math.max(a.length, b.length);
}

function groupCandidates(works) {
  const groups = [];
  for (const work of works) {
    const matches = group => group.some(other => (work.doi && work.doi === other.doi) || (work.pmid && work.pmid === other.pmid)) &&
      group.every(other => (!work.doi || !other.doi || work.doi === other.doi) && (!work.pmid || !other.pmid || work.pmid === other.pmid));
    const group = groups.find(matches);
    if (!group) groups.push([work]);
    else if (!group.some(other => other.source === work.source)) group.push(work);
  }
  return groups;
}

function rankCandidates(record, works) {
  const { title, authors, year, volume, pages } = record.data;
  const journal = record.data.journal || record.periodicalTitle;
  const results = groupCandidates(works).map(group => {
    const matchTitle = Math.max(...group.flatMap(work => [similarity(title, work.title), similarity(title, work.otherTitle)]));
    const hasAuthors = group.some(work => work.authors.length);
    const matchAuthor = Boolean(authors[0]) && group.some(work => work.authors[0] && authorCompatible(authors[0], work.authors[0]));
    const matchYear = Boolean(year) && group.some(work => [work.year, work.onlineYear].includes(year));
    const matchJournal = Boolean(journal) && group.some(work => [work.journal, ...work.abbreviations].some(name => fold(name) === fold(journal)));
    const conflictingAuthor = Boolean(authors[0] && hasAuthors && !matchAuthor);
    const conflictingYear = /^\d{4}$/.test(year) && group.some(work => work.year) && !matchYear;
    const matchDoi = Boolean(record.ids.doi) && group.some(work => work.doi === record.ids.doi);
    const matchPmid = Boolean(record.ids.pmid) && group.some(work => work.pmid === record.ids.pmid);
    const conflictingId = group.some(work => (record.ids.doi && work.doi && record.ids.doi !== work.doi) ||
      (record.ids.pmid && work.pmid && record.ids.pmid !== work.pmid));
    const matchPosition = Boolean(volume && pages) && group.some(work => work.volume === volume && equivalentPages(pages, work.pages));
    const idConfirmed = matchDoi || matchPmid;
    const informativeTitle = fold(title).length >= 36 || (/[\p{Script=Han}]/u.test(title) && fold(title).length >= 16);
    const score = matchTitle * 65 + Number(matchAuthor) * 14 + Number(matchYear) * 8 +
      Number(matchJournal) * 7 + Number(matchPosition) * 5 + Number(idConfirmed) * 80 +
      Number(group.length > 1) * 3 - Number(conflictingId) * 28 -
      Number(conflictingAuthor) * 16 - Number(conflictingYear) * 9;
    const supportedTitle = (matchTitle === 1 && (informativeTitle || (matchAuthor && (matchYear || matchJournal)) ||
      group.filter(work => [work.title, work.otherTitle].some(name => fold(title) === fold(name))).length > 1)) ||
      (matchTitle >= 0.94 && informativeTitle && matchAuthor && (matchYear || matchJournal || idConfirmed));
    const safe = !conflictingId && !conflictingAuthor && !conflictingYear &&
      (idConfirmed ? (!title || matchTitle >= 0.85) : supportedTitle);
    return { group, score, matchTitle, idConfirmed, conflictingId, safe };
  }).filter(item => item.idConfirmed || item.matchTitle >= 0.55)
    .sort((a, b) => b.score - a.score);
  const [best, second] = results;
  const selected = best?.safe && (!second || best.score - second.score >= 12) ? 0 : null;
  return { candidates: results.slice(0, 6), selected };
}

function equivalentPages(a, b) {
  const expand = pages => pages.replace(/[\s‐‑‒–—−]/gu, char => /\s/u.test(char) ? '' : '-')
    .replace(/^(\d+)-(\d+)$/, (all, start, end) => end.length < start.length ?
      start + '-' + start.slice(0, start.length - end.length) + end : all).toLowerCase();
  return expand(a) === expand(b);
}

function dateCompatible(a, b) {
  return a === b || a.startsWith(b + '-') || b.startsWith(a + '-');
}

function scalarEquals(key, a, b) {
  if (key === 'doi') return Boolean(normalizeDoi(a)) && normalizeDoi(a) === normalizeDoi(b);
  if (key === 'pages') return equivalentPages(a, b);
  if (key === 'date' || key === 'epubDate') return dateCompatible(a, b);
  return fold(a) === fold(b);
}

function sourceDetails(works) {
  return works.map(work => ({ name: work.source, url: work.url }));
}

function pickFields(record, group, language) {
  const ordered = [...group].sort((a, b) => Number(b.source === 'Crossref') - Number(a.source === 'Crossref'));
  const datePriority = { issue: 3, unspecified: 2, online: 1 };
  const chronology = ordered.filter(work => work.year)
    .sort((a, b) => datePriority[b.dateKind] - datePriority[a.dateKind] || b.date.length - a.date.length);
  const primaryDate = chronology[0];
  const journalNames = ordered.flatMap(work => [work.journal, ...work.abbreviations]).filter(Boolean);
  return FIELDS.map(([key, label]) => {
    const old = record.data[key];
    let usable = ordered.filter(work => work[key]);
    if (key === 'date' || key === 'year') {
      usable = chronology.filter(work => work[key] && work.year === primaryDate?.year && work.dateKind === primaryDate?.dateKind);
    }
    if (key === 'epubDate') usable.sort((a, b) => b.epubDate.length - a.epubDate.length);
    let proposed = usable[0]?.[key] || '';
    let conflict = usable.slice(1).some(work => !scalarEquals(key, proposed, work[key]));
    let sources = usable.length ? sourceDetails(usable) : [];
    let note = '';
    let safeReplacement = false;

    if (key === 'year' && primaryDate) {
      conflict = chronology.some(work => work.dateKind === primaryDate.dateKind && work.year !== primaryDate.year);
    }
    if (key === 'epubDate' && proposed) safeReplacement = old.length < proposed.length && dateCompatible(old, proposed);
    if (key === 'date' && proposed) {
      conflict ||= chronology.some(work => work.dateKind === primaryDate.dateKind && work.year !== primaryDate.year);
      safeReplacement = old.length < proposed.length && dateCompatible(old, proposed);
      if (primaryDate.dateKind === 'online') note = '网络发表日期。';
      else if (primaryDate.dateKind === 'issue') note = '卷期出版日期。';
    }
    if (key === 'journal') {
      safeReplacement = journalNames.some(name => fold(old) === fold(name));
      conflict = usable.some(work => fold(work.journal) !== fold(proposed) &&
        !usable.some(other => other.abbreviations.some(abbr => fold(abbr) === fold(work.journal))));
      const full = usable.find(work => !usable.some(other => other !== work &&
        fold(other.journal) !== fold(work.journal) &&
        other.abbreviations.some(abbr => fold(abbr) === fold(work.journal))));
      proposed = full?.journal || proposed;
    }
    if (key === 'title') {
      const nativeTitle = ordered.find(work => work.translationLanguage && work.otherTitle &&
        ordered.some(other => fold(work.otherTitle) === fold(other.title) || fold(work.title) === fold(other.title)));
      proposed = nativeTitle?.title || proposed;
      conflict = usable.some(work => ![work.title, work.otherTitle].filter(Boolean).some(title => fold(title) === fold(proposed)) &&
        !ordered.some(other => fold(other.title) === fold(proposed) && other.otherTitle && fold(other.otherTitle) === fold(work.title)));
      if (record.formattedTitle && old && proposed && fold(old) !== fold(proposed)) note = '替换会重设原题名的富文本格式。';
    }
    if (key === 'authors') {
      usable = ordered.filter(work => work.authors.length);
      sources = sourceDetails(usable);
      proposed = usable[0]?.authors || [];
      conflict = usable.some(work => !authorListsCompatible(proposed, work.authors));
      if (!conflict) {
        for (const work of usable.slice(1)) proposed = proposed.map((name, index) => richerAuthor(name, work.authors[index]));
      }
      safeReplacement = authorListsCompatible(old, proposed);
      if (safeReplacement) proposed = proposed.map((name, index) => richerAuthor(old[index], name));
      if (proposed.some(name => {
        const person = nameParts(name);
        return !person.collective && person.given.every(word => word.length === 1);
      })) note = '部分作者的来源记录只提供姓氏或首字母。';
    }
    if (key === 'issn') {
      usable = ordered.filter(work => work.issns.length);
      sources = sourceDetails(usable);
      const current = normalizeIssns([old]);
      const discovered = [...new Set(usable.flatMap(work => work.issns))].sort();
      proposed = discovered.join(', ');
      safeReplacement = current.length > 0 && current.every(issn => discovered.includes(issn));
      conflict = usable.length > 1 && !usable[0].issns.some(issn => usable[1].issns.includes(issn));
    }
    if (key === 'translatedTitle') {
      const translations = ordered.filter(work => work.otherTitle && work.translationLanguage === language);
      sources = sourceDetails(translations);
      proposed = translations[0]?.otherTitle || '';
      conflict = false;
    }
    if (key === 'pages') safeReplacement = equivalentPages(old, proposed) && proposed.length > old.length;

    const hasProposal = Boolean(proposed?.length);
    const hasOld = Boolean(old?.length);
    let equivalent = hasOld && hasProposal && scalarEquals(key, old, proposed);
    if (key === 'authors') equivalent = hasOld && old.join('\n') === proposed.join('\n');
    if (key === 'journal') equivalent = old === proposed;
    if (key === 'issn') equivalent = normalizeIssns([old]).join(', ') === proposed && hasProposal;
    if (safeReplacement && ['date', 'epubDate', 'pages'].includes(key)) equivalent = false;
    const status = !hasProposal ? (hasOld ? 'unverified' : 'missing') :
      conflict ? 'review' : equivalent ? 'verified' : (!hasOld || safeReplacement) ? 'change' : 'review';
    if (conflict) note = '来源记录存在差异。' + note;
    return { key, label, old, proposed, sources, status, note, canApply: hasProposal && !equivalent };
  });
}

async function inspectRecord(record, sources, language, signal) {
  if (!record.supported) return { status: 'skipped', note: '当前仅检查期刊论文（Journal Article）。' };
  if (!record.data.title && !record.ids.doi && !record.ids.pmid) return { status: 'missing', note: '请提供题名、DOI 或 PMID。' };
  const works = [];
  const errors = new Map();
  async function lookup(mode) {
    await Promise.all(Object.entries(sources).map(async ([name, search]) => {
      try {
        works.push(...await search(record, mode, signal));
        errors.delete(name);
      } catch (error) {
        signal?.throwIfAborted();
        errors.set(name, error.message);
      }
    }));
  }
  if (record.ids.doi || record.ids.pmid) await lookup('identifier');
  let ranked = rankCandidates(record, works);
  if (record.data.title && ranked.selected === null) {
    await lookup('title');
    ranked = rankCandidates(record, works);
  }
  const warning = [...errors.entries()].map(([name, error]) => name + ' ' + error).join(' · ');
  const status = ranked.selected !== null ? 'matched' :
    ranked.candidates.length ? 'ambiguous' : warning ? 'failed' : 'missing';
  return {
    ...ranked, status, warning,
    fields: ranked.selected === null ? [] : pickFields(record, ranked.candidates[ranked.selected].group, language),
    note: status === 'missing' ? '没有找到可核验的匹配条目。' :
      status === 'ambiguous' ? '请核对候选后选择对应论文。' : ''
  };
}

module.exports = { inspectRecord, pickFields, rankCandidates, sourceDetails };
