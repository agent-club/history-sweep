import { normalizeSearchText, searchWords } from './search-text.mjs';
import { normalizeHostname } from './history-utils.mjs';

export const SUGGESTION_LIMIT = 10;

function grams(text, length) {
  const result = new Set();
  for (let i = 0; i <= text.length - length; i++) result.add(text.slice(i, i + length));
  return result;
}

function addPosting(index, key, id) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(id);
}

function compare(a, b) {
  return b.score - a.score || b.lastVisitTime - a.lastVisitTime || b.visitCount - a.visitCount || a.id - b.id;
}

function retainTop(top, candidate) {
  const duplicate = top.findIndex(row => row.completion === candidate.completion);
  if (duplicate !== -1) {
    if (compare(candidate, top[duplicate]) >= 0) return;
    top.splice(duplicate, 1);
  }
  if (top.length === SUGGESTION_LIMIT && compare(candidate, top.at(-1)) >= 0) return;
  let low = 0; let high = top.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(candidate, top[mid]) < 0) high = mid; else low = mid + 1;
  }
  top.splice(low, 0, candidate);
  if (top.length > SUGGESTION_LIMIT) top.pop();
}

export async function createSuggestionIndex(items, yieldControl = async () => {}) {
  const rows = []; const characters = new Map(); const trigrams = new Map(); const hosts = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.url) continue;
    let hostname;
    try { hostname = new URL(item.url).hostname.replace(/\.$/, ''); } catch { continue; }
    const title = normalizeSearchText(item.title || ''); const url = normalizeSearchText(item.url);
    const text = `${title}\n${url}`; const id = rows.length;
    const row = { id, item, hostname, title, url, words: searchWords(title), lastVisitTime: item.lastVisitTime ?? 0, visitCount: item.visitCount ?? 0 };
    rows.push(row);
    for (const key of grams(text, 1)) addPosting(characters, key, id);
    for (const key of grams(text, 3)) addPosting(trigrams, key, id);
    const representative = hosts.get(hostname);
    if (!representative || row.lastVisitTime > representative.lastVisitTime) hosts.set(hostname, row);
    // Large snapshots are built off the UI thread; yields let a newer snapshot cancel this build.
    if (i % 512 === 511) await yieldControl();
  }
  for (const index of [characters, trigrams]) {
    for (const [key, posting] of index) index.set(key, Uint32Array.from(posting));
  }
  const hostnames = [...hosts.keys()].sort();
  const suffixes = new Map();
  for (const hostname of hostnames) {
    const labels = hostname.split('.');
    for (let i = 0; i < labels.length; i++) {
      const key = labels.slice(i).join('.');
      if (!suffixes.has(key)) suffixes.set(key, []);
      suffixes.get(key).push(hostname);
    }
  }
  const suffixKeys = [...suffixes.keys()].sort();
  function *prefixKeys(keys, prefix) {
    let low = 0; let high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (keys[mid] < prefix) low = mid + 1; else high = mid;
    }
    for (let i = low; i < keys.length && keys[i].startsWith(prefix); i++) yield keys[i];
  }

  function candidates(term) {
    const index = term.length >= 3 ? trigrams : characters;
    const keys = grams(term, term.length >= 3 ? 3 : 1);
    let rarest;
    for (const key of keys) {
      const posting = index.get(key);
      if (!posting) return [];
      if (!rarest || posting.length < rarest.length) rarest = posting;
    }
    // The rarest posting is a superset. Verify the entire term so grams cannot create false positives.
    return rarest || [];
  }

  function suggest(query, mode) {
    const normalized = normalizeSearchText(query.trim());
    const terms = mode === 'contains' ? [normalized] : normalized.split(/[\s,，;；]+/);
    const term = terms.at(-1);
    if (!term) return { suggestions: [], examined: 0 };
    const rawTerm = query.trim().split(/[\s,，;；]+/).at(-1);
    const hostMode = mode.startsWith('host') || (mode === 'smart' && (/^[a-z0-9.:/\-]+$/i.test(term) || rawTerm.includes('.')));
    const top = []; let examined = 0;
    if (hostMode) {
      const needle = normalizeHostname(rawTerm);
      if (!needle) return { suggestions: [], examined };
      // Binary prefix lookup ranks distinct hosts, not every page or unrelated hostname.
      const matchingHosts = mode === 'host-exact'
        ? prefixKeys(hostnames, needle)
        : new Set([...prefixKeys(suffixKeys, needle)].flatMap(key => suffixes.get(key)));
      for (const hostname of matchingHosts) {
        const exact = hostname === needle || (mode !== 'host-exact' && hostname.endsWith(`.${needle}`));
        const prefix = hostname.startsWith(needle) || (mode !== 'host-exact' && hostname.split('.').some(label => label.startsWith(needle)));
        if (!exact && !prefix) continue;
        examined++;
        const row = hosts.get(hostname);
        retainTop(top, { ...row, score: exact ? 4 : 3, completion: hostname, display: hostname });
      }
    } else {
      for (const id of candidates(term)) {
        examined++;
        const row = rows[id]; const titleMatch = row.title.includes(term); const urlMatch = row.url.includes(term);
        if (!titleMatch && !urlMatch) continue;
        const score = row.title === term ? 5 : row.words.includes(term) ? 4 : row.words.some(word => word.startsWith(term)) ? 3 : titleMatch ? 2 : 1;
        // Use only actual history fields. A missing title leaves the URL as the suggestion itself.
        const completion = titleMatch ? row.item.title : row.item.url;
        retainTop(top, { ...row, score, completion, display: completion });
      }
    }
    return {
      suggestions: top.map(row => {
        const prefix = mode === 'contains' ? '' : query.slice(0, query.search(/[^\s,，;；]+\s*$/));
        return { key: row.item.url, text: row.display, url: row.item.url, query: prefix + row.completion };
      }),
      examined,
    };
  }
  return { suggest, size: rows.length };
}
