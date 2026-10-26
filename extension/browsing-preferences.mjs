const key = 'browsingPreferences';
const views = ['date', 'website', 'frequency'];
export const browsingDefaults = () => ({ view: 'website', range: '7days', viewOrder: [...views], hiddenViews: [] });

function validate(value) {
  if (!value || !['date', 'website', 'frequency'].includes(value.view) || !['all', 'today', '3days', '7days', '30days'].includes(value.range)) throw new Error('INVALID_BROWSING_PREFERENCES');
  // Existing installations only stored view/range; retain their three visible tabs.
  const viewOrder = value.viewOrder === undefined ? [...views] : value.viewOrder;
  const hiddenViews = value.hiddenViews === undefined ? [] : value.hiddenViews;
  if (!Array.isArray(viewOrder) || viewOrder.length !== views.length || new Set(viewOrder).size !== views.length || viewOrder.some(view => !views.includes(view)) ||
      !Array.isArray(hiddenViews) || new Set(hiddenViews).size !== hiddenViews.length || hiddenViews.some(view => !views.includes(view)) || hiddenViews.includes(value.view)) throw new Error('INVALID_BROWSING_PREFERENCES');
  return { view: value.view, range: value.range, viewOrder: [...viewOrder], hiddenViews: [...hiddenViews] };
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
