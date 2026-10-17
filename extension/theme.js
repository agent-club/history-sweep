// Apply appearance before the stylesheet and application render to avoid a light flash.
(() => {
  const key = 'theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['dark', 'light', 'system'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch {}
  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = theme; root.dataset.themePreference = preference; root.style.colorScheme = theme;
    document.dispatchEvent(new Event('history-sweep:theme-changed'));
    if (window.parent !== window) window.parent.postMessage({ type: 'history-sweep:theme', theme }, '*');
  }
  document.addEventListener('history-sweep:set-theme', event => {
    if (!['dark', 'light', 'system'].includes(event.detail)) return;
    preference = event.detail;
    try { localStorage.setItem(key, preference); } catch {}
    apply();
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = event.key === null ? 'system' : valid(event.newValue); apply();
  });
  apply();
})();
