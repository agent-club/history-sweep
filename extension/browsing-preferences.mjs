const key = 'browsingPreferences';
export const browsingDefaults = () => ({ view: 'website', range: '7days' });

function validate(value) {
  if (!value || !['date', 'website', 'frequency'].includes(value.view) || !['all', 'today', '3days', '7days', '30days'].includes(value.range)) throw new Error('INVALID_BROWSING_PREFERENCES');
  return { view: value.view, range: value.range };
}

export async function readBrowsingPreferences(storage) {
  const data = await storage.get(key);
  return data[key] === undefined ? browsingDefaults() : validate(data[key]);
}

export async function saveBrowsingPreferences(storage, value) {
  const preference = validate(value);
  await storage.set({ [key]: preference });
  return preference;
}
