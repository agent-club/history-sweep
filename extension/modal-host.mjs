// executeScript serializes this function: all injected state must stay inside it.
export function injectModal(modalUrl) {
  const slot = '__historySweepModalHost';
  if (globalThis[slot]?.isConnected()) {
    globalThis[slot].close();
    return { opened: false };
  }
  const previousFocus = document.activeElement;
  const page = document.documentElement;
  const hadInlineStyle = page.hasAttribute('style');
  const scrollPosition = { left: window.scrollX, top: window.scrollY };
  const scrollProperties = ['overflow-x', 'overflow-y', 'overscroll-behavior-x', 'overscroll-behavior-y', 'scrollbar-gutter'];
  const previousStyles = scrollProperties.map(property => [property, page.style.getPropertyValue(property), page.style.getPropertyPriority(property)]);
  const scrollbarGutter = getComputedStyle(page).scrollbarGutter;
  const scrollEvents = new AbortController();
  const host = document.createElement('div');
  host.style.setProperty('all', 'initial', 'important');
  // The page cannot inspect the iframe launch token or alter the extension's inner UI.
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    dialog { box-sizing: border-box; width: min(960px, calc(100vw - 40px)); height: min(760px, calc(100vh - 40px)); max-width: none; max-height: none; padding: 0; border: 1px solid #ffffff90; border-radius: 24px; background: #f2f2f2; box-shadow: 0 24px 100px #00000040; overflow: hidden; }
    dialog::backdrop { background: #18181870; backdrop-filter: blur(5px); }
    /* Wait for the extension's saved theme before exposing the iframe surface. */
    dialog { opacity: 0; transition: opacity 160ms ease; }
    dialog[data-theme] { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { dialog { transition: none; } }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #f2f2f2; }
    button { position: absolute; top: 16px; right: 16px; width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 9px; background: #e7e7e7; color: #333; cursor: pointer; font: 22px/1 -apple-system, sans-serif; }
    button[hidden] { display: none; }
    button:hover { background: #dadada; }
    dialog[data-theme=dark] { background: #161616; border-color: #424242; }
    dialog[data-theme=dark] iframe { background: #161616; }
    dialog[data-theme=dark] button { background: #303030; color: #ededed; }
    dialog[data-theme=dark] button:hover { background: #3a3a3a; }
    button:focus-visible { outline: 2px solid #555; outline-offset: 2px; }
    @media (max-width: 520px) { dialog { width: calc(100vw - 16px); height: calc(100vh - 16px); border-radius: 18px; } button { right: 12px; } }
  `);
  root.adoptedStyleSheets = [sheet];
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'History Sweep');
  const frame = document.createElement('iframe');
  frame.title = 'History Sweep';
  frame.src = modalUrl;
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', '关闭 History Sweep / Close History Sweep');
  const parsedUrl = new URL(modalUrl);
  const frameOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  let dismissRequest = 0;
  let pendingDismiss = null;
  function close() { dialog.close(); }
  function dismissLayer() {
    // Ask the extension frame first: a calendar/filter must absorb the first backdrop click.
    pendingDismiss = ++dismissRequest;
    frame.contentWindow.postMessage({ type: 'history-sweep:dismiss-layer', requestId: pendingDismiss }, frameOrigin);
  }
  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    if (event.data?.type === 'history-sweep:theme' && ['light', 'dark'].includes(event.data.theme)) dialog.dataset.theme = event.data.theme;
    if (event.data?.type === 'history-sweep:close-modal') close();
    if (event.data?.type === 'history-sweep:preferences' && typeof event.data.open === 'boolean') closeButton.hidden = event.data.open;
    if (event.data?.type === 'history-sweep:layer-dismissed' && event.data.requestId === pendingDismiss && typeof event.data.handled === 'boolean') {
      pendingDismiss = null;
      if (!event.data.handled) close();
    }
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dismissLayer();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismissLayer(); });
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', onMessage);
    scrollEvents.abort();
    for (const [property, value, priority] of previousStyles) {
      if (value) page.style.setProperty(property, value, priority);
      else page.style.removeProperty(property);
    }
    host.remove(); delete globalThis[slot];
    window.scrollTo({ ...scrollPosition, behavior: 'instant' });
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (!hadInlineStyle && page.getAttribute('style') === '') page.removeAttribute('style');
  }, { once: true });
  window.addEventListener('message', onMessage);
  dialog.append(frame, closeButton); root.append(dialog); document.documentElement.append(host);
  globalThis[slot] = { close, isConnected: () => host.isConnected };
  dialog.showModal();
  // A modal dialog makes the page inert, but does not lock its viewport scrolling.
  page.style.setProperty('overflow-x', 'hidden', 'important');
  page.style.setProperty('overflow-y', 'hidden', 'important');
  page.style.setProperty('overscroll-behavior-x', 'none', 'important');
  page.style.setProperty('overscroll-behavior-y', 'none', 'important');
  page.style.setProperty('scrollbar-gutter', scrollbarGutter === 'auto' ? 'stable' : scrollbarGutter, 'important');
  const blockBackgroundScroll = event => {
    if (!event.ctrlKey && !(event.touches?.length > 1)) event.preventDefault();
  };
  // Events inside the iframe stay there; only host/backdrop gestures reach these listeners.
  for (const type of ['wheel', 'touchmove']) document.addEventListener(type, blockBackgroundScroll, { capture: true, passive: false, signal: scrollEvents.signal });
  frame.addEventListener('load', () => {
    if (!dialog.dataset.theme) dialog.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    frame.focus();
  }, { once: true });
  return { opened: true };
}
