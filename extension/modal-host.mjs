// executeScript serializes this function: all injected state must stay inside it.
export function injectModal(modalUrl) {
  const slot = '__historySweepModalHost';
  if (globalThis[slot]?.isConnected()) {
    globalThis[slot].close();
    return { opened: false };
  }
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.style.setProperty('all', 'initial', 'important');
  // The page cannot inspect the iframe launch token or alter the extension's inner UI.
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    dialog { box-sizing: border-box; width: min(960px, calc(100vw - 40px)); height: min(760px, calc(100vh - 40px)); max-width: none; max-height: none; padding: 0; border: 1px solid #ffffff90; border-radius: 24px; background: #f2f2f2; box-shadow: 0 24px 100px #00000040; overflow: hidden; }
    dialog::backdrop { background: #18181870; backdrop-filter: blur(5px); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #f2f2f2; }
    button { position: absolute; top: 16px; right: 16px; width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 9px; background: #e7e7e7; color: #333; cursor: pointer; font: 22px/1 -apple-system, sans-serif; }
    button:hover { background: #dadada; }
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
  function close() { dialog.close(); }
  function onMessage(event) {
    if (event.source === frame.contentWindow && event.origin === frameOrigin && event.data?.type === 'history-sweep:close-modal') close();
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', onMessage);
    host.remove(); delete globalThis[slot];
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }, { once: true });
  window.addEventListener('message', onMessage);
  dialog.append(frame, closeButton); root.append(dialog); document.documentElement.append(host);
  globalThis[slot] = { close, isConnected: () => host.isConnected };
  dialog.showModal();
  frame.addEventListener('load', () => frame.focus(), { once: true });
  return { opened: true };
}
