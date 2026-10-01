import { Converter } from './vendor/opencc/t2cn.mjs';

const toSimplified = Converter({ from: 't', to: 'cn' });
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

export function normalizeSearchText(value) {
  const text = value.normalize('NFKC').toLowerCase();
  return /\p{Script=Han}/u.test(text) ? toSimplified(text) : text;
}

export function searchWords(text) {
  if (!/\p{Script=Han}/u.test(text)) return text.match(/[\p{L}\p{N}]+/gu) || [];
  return [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment);
}

export function highlightRanges(text, query) {
  // Keep offsets in the original text: case folding and compatibility characters can change length.
  const normalized = normalizeSearchText(text); const offsets = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const folded = normalizeSearchText(segment);
    for (let i = 0; i < folded.length; i++) offsets.push([index, index + segment.length]);
  }
  const ranges = [];
  for (const term of normalizeSearchText(query).split(/[\s,，;；]+/).filter(Boolean)) {
    let start = normalized.indexOf(term);
    while (start !== -1) {
      ranges.push([offsets[start][0], offsets[start + term.length - 1][1]]);
      start = normalized.indexOf(term, start + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges.reduce((merged, range) => {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
    return merged;
  }, []);
}
