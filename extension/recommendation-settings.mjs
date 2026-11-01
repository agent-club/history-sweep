import { parseProtectedSites } from './history-filters.mjs';

export const RECOMMENDATION_KEY = 'cleanupRecommendationSettings';
export const RECOMMENDATION_CUE_KEY = 'cleanupRecommendationCue';
export const recommendationDefaults = () => ({ version: 1, habit: { enabled: true, lookbackDays: 7, minimumDays: 2 }, types: { extension: true, application: true }, sites: [], cue: 'new' });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const days = value => Number.isInteger(value) && value >= 1 && value <= 365;
const invalid = () => { throw new Error('INVALID_RECOMMENDATION_SETTINGS'); };

export function recommendationDomain(value) {
  if (typeof value !== 'string' || !value.trim() || /[\s,，;；]/.test(value.trim())) invalid();
  const result = parseProtectedSites(value.trim());
  if (result.length !== 1 || result[0].length > 253) invalid();
  return result[0];
}

export function validateRecommendationSettings(value) {
  if (!keys(value, ['version', 'habit', 'types', 'sites', 'cue']) || value.version !== 1 ||
      !keys(value.habit, ['enabled', 'lookbackDays', 'minimumDays']) || typeof value.habit.enabled !== 'boolean' ||
      !days(value.habit.lookbackDays) || !days(value.habit.minimumDays) || value.habit.minimumDays > value.habit.lookbackDays ||
      !keys(value.types, ['extension', 'application']) || Object.values(value.types).some(flag => typeof flag !== 'boolean') ||
      !Array.isArray(value.sites) || value.sites.length > 100 || !['new', 'daily', 'weekly', 'never'].includes(value.cue)) invalid();
  const seen = new Set();
  const sites = value.sites.map(site => {
    if (!keys(site, ['domain', 'includeSubdomains', 'condition', 'days', 'enabled']) ||
        typeof site.includeSubdomains !== 'boolean' || typeof site.enabled !== 'boolean' ||
        !['always', 'inactive'].includes(site.condition) || (site.condition === 'inactive' ? !days(site.days) : site.days !== null)) invalid();
    const domain = recommendationDomain(site.domain);
    const signature = `${domain}|${site.includeSubdomains}`;
    if (seen.has(signature)) invalid();
    seen.add(signature);
    return { ...site, domain };
  });
  return { version: 1, habit: { ...value.habit }, types: { ...value.types }, sites, cue: value.cue };
}

export async function readRecommendationSettings(storage) {
  const saved = await storage.get(RECOMMENDATION_KEY);
  return saved[RECOMMENDATION_KEY] === undefined ? recommendationDefaults() : validateRecommendationSettings(saved[RECOMMENDATION_KEY]);
}

export async function saveRecommendationSettings(storage, value) {
  const clean = validateRecommendationSettings(value);
  await storage.set({ [RECOMMENDATION_KEY]: clean });
  return clean;
}

export function recommendationCueDue(cue, lastAt, now = new Date()) {
  if (cue === 'never') return false;
  if (cue === 'new') return true;
  if (!Number.isFinite(lastAt)) return true;
  const previous = new Date(lastAt);
  if (cue === 'daily') return previous.getFullYear() !== now.getFullYear() || previous.getMonth() !== now.getMonth() || previous.getDate() !== now.getDate();
  return cue === 'weekly' && now.getTime() - lastAt >= 7 * 86400000;
}
