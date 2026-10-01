import { readLanguage, translate } from './i18n.mjs';

const token = new URLSearchParams(location.hash.slice(1)).get('launch');
try {
  if (window.parent === window || !token) throw new Error('Invalid modal launch');
  const response = await chrome.runtime.sendMessage({ type: 'claim-modal', token });
  if (!response?.ok) throw new Error('Invalid modal launch');
  // Never initialize history access in an iframe that was embedded by an unrelated page.
  await import('./app.mjs');
  document.getElementById('query').focus();
  document.addEventListener('keydown', event => {
    const selectOpen = CSS.supports('selector(select:open)') && document.querySelector('select:open');
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || document.querySelector('dialog[open]') || selectOpen || document.getElementById('suggestionsPanel')?.dataset.open === 'true') return;
    // Check nested layers before the search input consumes Escape to dismiss suggestions.
    event.preventDefault(); event.stopPropagation();
    window.parent.postMessage({ type: 'history-sweep:close-modal' }, '*');
  }, true);
} catch {
  const message = document.createElement('p'); message.className = 'modal-unavailable';
  message.textContent = translate(readLanguage(), 'modalLaunchFailed');
  document.getElementById('app').replaceChildren(message);
}
