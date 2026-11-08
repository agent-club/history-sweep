// Apply appearance before the stylesheet and application render to avoid a light flash.
(() => {
  const key = 'theme';
  // Keep presets local while WebDAV and disk backups still use the existing mode-only format.
  const presetKey = 'themePreset';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['dark', 'light', 'system'].includes(value) ? value : 'system';
  const validPreset = value => ['classic', 'warm-paper', 'mist-blue', 'moss-green', 'dusk-plum'].includes(value) ? value : 'classic';
  let preference = 'system';
  let preset = 'classic';
  try {
    preference = valid(localStorage.getItem(key));
    preset = validPreset(localStorage.getItem(presetKey));
  } catch {}
  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = theme; root.dataset.themePreference = preference; root.style.colorScheme = theme;
    root.dataset.themePreset = preset;
    document.dispatchEvent(new Event('history-sweep:theme-changed'));
    if (window.parent !== window) window.parent.postMessage({ type: 'history-sweep:theme', theme, preset }, '*');
  }
  document.addEventListener('history-sweep:set-theme', event => {
    if (!['dark', 'light', 'system'].includes(event.detail)) return;
    preference = event.detail;
    try { localStorage.setItem(key, preference); } catch {}
    apply();
  });
  document.addEventListener('history-sweep:set-theme-preset', event => {
    if (validPreset(event.detail) !== event.detail || preset === event.detail) return;
    preset = event.detail;
    try { localStorage.setItem(presetKey, preset); } catch {}
    apply();
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== presetKey && event.key !== null) return;
    if (event.key !== presetKey) preference = valid(event.newValue);
    if (event.key !== key) preset = validPreset(event.newValue);
    apply();
  });
  apply();
})();
