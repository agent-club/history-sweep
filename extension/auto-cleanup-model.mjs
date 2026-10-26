import { normalizeSchedule } from './auto-cleanup-schedule.mjs';

export const DAY_MS = 86400000;

const invalidRule = () => new Error('AUTO_INVALID_RULE');
const publicSuffixOnly = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in', 'ind.in',
  'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.sg', 'net.sg', 'org.sg', 'com.hk', 'net.hk', 'org.hk',
]);

function hostnameOfDomain(value) {
  if (typeof value !== 'string') throw invalidRule();
  const input = value.trim();
  // Accept a hostname only. A URL parser alone would silently accept paths or ports.
  if (!input || !/^[\p{L}\p{N}.-]+$/u.test(input)) throw invalidRule();

  let hostname;
  try { hostname = new URL(`http://${input}`).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { throw invalidRule(); }

  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some(label =>
    !label || label.length > 63 || label.startsWith('-') || label.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(label))) throw invalidRule();
  // Numeric hosts are IP addresses, not domain retention rules.
  if (labels.every(label => /^\d+$/.test(label))) throw invalidRule();
  // Do not let a top-level or commonly used multi-label public suffix become a rule.
  if (publicSuffixOnly.has(hostname)) throw invalidRule();
  return hostname;
}

export function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRule();
  const domain = hostnameOfDomain(input.domain);
  if (typeof input.includeSubdomains !== 'boolean' || (input.days !== null &&
      (!Number.isSafeInteger(input.days) || input.days < 1 ||
      !Number.isSafeInteger(input.days * DAY_MS)))) throw invalidRule();
  return { domain, includeSubdomains: input.includeSubdomains, days: input.days,
    ...(Object.hasOwn(input, 'schedule') ? { schedule: normalizeSchedule(input.schedule) } : {}) };
}

export function ruleMatches(ruleInput, value) {
  const rule = normalizeRule(ruleInput);
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return hostname === rule.domain ||
    (rule.includeSubdomains && hostname.endsWith(`.${rule.domain}`));
}

function containsDomain(parent, child) {
  return child === parent || child.endsWith(`.${parent}`);
}

export function rulesOverlap(leftInput, rightInput) {
  const left = normalizeRule(leftInput);
  const right = normalizeRule(rightInput);
  if (left.domain === right.domain) return true;
  if (left.includeSubdomains && containsDomain(left.domain, right.domain)) return true;
  if (right.includeSubdomains && containsDomain(right.domain, left.domain)) return true;
  return false;
}

export function isExpired(lastVisitTime, days, now) {
  if (!Number.isFinite(lastVisitTime) || lastVisitTime <= 0 ||
      !Number.isFinite(now) || now < 0) return false;
  if (days === null) return lastVisitTime <= now;
  if (
      !Number.isSafeInteger(days) || days < 1 ||
      !Number.isSafeInteger(days * DAY_MS) ||
      lastVisitTime > now) return false;
  return lastVisitTime <= now - days * DAY_MS;
}
