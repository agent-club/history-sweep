import { normalizeSearchText } from './search-text.mjs';

export const MAX_HISTORY_RESULTS = 100000;

export function normalizeHostname(value) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    return new URL(candidate).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function parseHostnames(value) {
  const tokens = value
    .split(/[\s,，;；]+/)
    .map(normalizeHostname)
    .filter(Boolean);

  return [...new Set(tokens)];
}

export function parseSmartTerms(value) {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[\s,，;；]+/)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
}

export function createHistoryMatcher(query, mode) {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return () => false;

  if (mode === "smart") {
    // Compile query terms once per scan, and parse each candidate URL only once.
    const terms = parseSmartTerms(normalizedQuery).map(term => ({
      term,
      domain: term.includes('.') || term.includes('://') ? normalizeHostname(term) : undefined,
      label: /^[a-z0-9-]+$/i.test(term),
    }));
    return item => {
      if (!item.url) return false;
      let hostname;
      try { hostname = new URL(item.url).hostname.toLowerCase().replace(/\.$/, ''); }
      catch { return false; }
      let labels, title, url;
      return terms.some(({ term, domain, label }) => {
        if (domain !== undefined) return Boolean(domain) && (hostname === domain || hostname.endsWith(`.${domain}`));
        if (label) return (labels ??= hostname.split('.')).includes(term);
        return (title ??= normalizeSearchText(item.title || '')).includes(term) || (url ??= normalizeSearchText(item.url)).includes(term);
      });
    };
  }

  if (mode === "contains") {
    return item => {
      const url = normalizeSearchText(item.url || "");
      const title = normalizeSearchText(item.title || "");
      return url.includes(normalizedQuery) || title.includes(normalizedQuery);
    };
  }

  const hostnames = parseHostnames(query);
  if (hostnames.length === 0) return () => false;

  return item => {
    if (!item.url) return false;

    let hostname;
    try {
      hostname = new URL(item.url).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return false;
    }

    if (mode === "host-exact") {
      return hostnames.includes(hostname);
    }

    return hostnames.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  };
}

export function filterHistoryItems(items, query, mode) {
  return items.filter(createHistoryMatcher(query, mode));
}

export function sortByLastVisit(items) {
  return [...items].sort(
    (left, right) => (right.lastVisitTime || 0) - (left.lastVisitTime || 0),
  );
}

export function formatVisitTime(timestamp, locale = "zh-CN") {
  if (!timestamp) return "未知";

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
