import { MAX_HISTORY_RESULTS } from './history-utils.mjs';

// Chrome searches visits in the period, but HistoryItem timestamps describe
// the URL. Count visit details rather than filtering the URL's latest visit.
export async function readFrequencyHistory(history, { range = null, include = () => true, onProgress = () => {} } = {}) {
  if (!history?.search || !history?.getVisits) throw new Error('API_UNAVAILABLE');
  // Visit times can contain fractional milliseconds. Do not subtract a whole
  // millisecond here; the exact exclusive boundary is enforced on visit details.
  const candidates = await history.search({ text: '', startTime: range ? range.startTime : 0, ...(range ? { endTime: range.endTime } : {}), maxResults: MAX_HISTORY_RESULTS });
  // A truncated candidate set cannot establish a complete frequency ranking.
  if (candidates.length >= MAX_HISTORY_RESULTS) throw new Error('FREQUENCY_LIMIT');
  const pages = candidates.filter(item => item.url && include(item));
  const results = [];
  let cursor = 0;
  let completed = 0;
  let failed = false;
  onProgress(0, pages.length);
  const worker = async () => {
    while (!failed && cursor < pages.length) {
      const item = pages[cursor++];
      try {
        const visits = await history.getVisits({ url: item.url });
        if (!Array.isArray(visits) || visits.some(visit => !Number.isFinite(visit.visitTime))) throw new Error('FREQUENCY_VISITS_UNAVAILABLE');
        const seen = new Set();
        let count = 0;
        let last = -Infinity;
        for (const visit of visits) {
          if (range && (visit.visitTime < range.startTime || visit.visitTime >= range.endTime)) continue;
          if (visit.visitId != null && seen.has(visit.visitId)) continue;
          if (visit.visitId != null) seen.add(visit.visitId);
          count++;
          last = Math.max(last, visit.visitTime);
        }
        if (count) results.push({ ...item, periodVisitCount: count, periodLastVisitTime: last });
        onProgress(++completed, pages.length);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Drain in-flight reads before returning an error, so retries never overlap
  // with an abandoned scan. Never rank partial results after a failed read.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(8, pages.length) }, worker));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.sort((a, b) => b.periodVisitCount - a.periodVisitCount || b.periodLastVisitTime - a.periodLastVisitTime || a.url.localeCompare(b.url));
}
