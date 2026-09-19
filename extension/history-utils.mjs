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

function matchesSmartTerm(item, term) {
  if (!item.url) return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(item.url);
  } catch {
    return false;
  }

  const hostname = parsedUrl.hostname.toLowerCase().replace(/\.$/, "");
  const looksLikeDomain = term.includes(".") || term.includes("://");

  if (looksLikeDomain) {
    const domain = normalizeHostname(term);
    return Boolean(domain) && (hostname === domain || hostname.endsWith(`.${domain}`));
  }

  if (/^[a-z0-9-]+$/i.test(term)) {
    return hostname.split(".").includes(term);
  }

  const title = (item.title || "").toLowerCase();
  return title.includes(term) || item.url.toLowerCase().includes(term);
}

export function filterHistoryItems(items, query, mode) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  if (mode === "smart") {
    const terms = parseSmartTerms(normalizedQuery);
    return items.filter((item) => terms.some((term) => matchesSmartTerm(item, term)));
  }

  if (mode === "contains") {
    return items.filter((item) => {
      const url = (item.url || "").toLowerCase();
      const title = (item.title || "").toLowerCase();
      return url.includes(normalizedQuery) || title.includes(normalizedQuery);
    });
  }

  const hostnames = parseHostnames(query);
  if (hostnames.length === 0) return [];

  return items.filter((item) => {
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
  });
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
