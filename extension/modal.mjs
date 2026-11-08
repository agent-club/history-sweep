import { readLanguage, translate } from './i18n.mjs';

const token = new URLSearchParams(location.hash.slice(1)).get('launch');
try {
  if (window.parent === window || !token) throw new Error('Invalid modal launch');
  const response = await chrome.runtime.sendMessage({ type: 'claim-modal', token });
  if (!response?.ok) throw new Error('Invalid modal launch');
  // Never initialize history access in an iframe that was embedded by an unrelated page.
  await import('./app.mjs');
  const close = () => window.parent.postMessage({ type: 'history-sweep:close-modal' }, '*');
  const closeButton = document.getElementById('closeModalWorkspace');
  closeButton.addEventListener('click', close);
  const revealClose = () => {
    // Keep the workspace control in the same document as the settings dialog.
    // The parent control stays available if the workspace fails to load.
    closeButton.hidden = false;
    window.parent.postMessage({ type: 'history-sweep:workspace-close-ready' }, '*');
  };
  if (document.body.hasAttribute('data-startup')) {
    document.addEventListener('history-sweep:startup-dismissed', revealClose, { once: true });
  } else {
    revealClose();
  }
  document.addEventListener('keydown', event => {
    const selectOpen = CSS.supports('selector(select:open)') && document.querySelector('select:open');
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || document.querySelector('dialog[open]') || selectOpen || document.getElementById('suggestionsPanel')?.dataset.open === 'true') return;
    // Check nested layers before the search input consumes Escape to dismiss suggestions.
    event.preventDefault(); event.stopPropagation();
    close();
  }, true);
} catch {
  const message = document.createElement('p'); message.className = 'modal-unavailable';
  message.textContent = translate(readLanguage(), 'modalLaunchFailed');
  document.getElementById('app').replaceChildren(message);
  document.dispatchEvent(new Event('history-sweep:startup-ready'));
}
