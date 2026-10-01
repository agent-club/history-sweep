import { highlightRanges } from './search-text.mjs';

export function appendHighlighted(element, text, query) {
  let cursor = 0;
  for (const [start, end] of highlightRanges(text, query)) {
    element.append(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement('mark'); mark.textContent = text.slice(start, end); element.append(mark);
    cursor = end;
  }
  element.append(document.createTextNode(text.slice(cursor)));
}

export function setupSuggestions({ input, mode, panel, list, readHistory, onChoose }) {
  const worker = new Worker(new URL('./suggestions-worker.mjs', import.meta.url), { type: 'module' });
  const events = new AbortController();
  let timer; let requestId = 0; let snapshot = false; let loading; let active = -1; let suggestions = []; let composing = false;

  function close() {
    clearTimeout(timer); requestId++; active = -1;
    panel.dataset.open = 'false'; panel.inert = true;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function activate(index) {
    active = index;
    for (const [i, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (!suggestions[index]) return;
    input.value = suggestions[index].query; close(); input.focus(); onChoose();
  }
  function setHistory(items) {
    snapshot = true;
    worker.postMessage({ type: 'index', items });
  }
  function invalidate() { snapshot = false; loading = null; close(); }
  async function update(id) {
    try {
      if (!snapshot) {
        loading ||= readHistory();
        const items = await loading;
        if (id !== requestId) return;
        setHistory(items); loading = null;
      }
      if (id === requestId && !input.disabled && input.value.trim()) worker.postMessage({ type: 'suggest', id, query: input.value, mode: mode.value });
    } catch {
      loading = null;
      if (id === requestId) close();
    }
  }
  function schedule() {
    clearTimeout(timer); requestId++; active = -1; panel.inert = true;
    input.removeAttribute('aria-activedescendant');
    if (composing || input.disabled || !input.value.trim()) { close(); return; }
    const id = requestId;
    timer = setTimeout(() => update(id), 90);
  }
  worker.onmessage = ({ data }) => {
    if (data.id !== requestId || input.disabled) return;
    suggestions = data.suggestions;
    const fragment = document.createDocumentFragment();
    for (const [index, suggestion] of suggestions.entries()) {
      const option = document.createElement('div'); option.className = 'suggestion-option'; option.id = `suggestion-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.dataset.key = suggestion.key;
      const text = document.createElement('span'); text.className = 'suggestion-text'; appendHighlighted(text, suggestion.text, input.value);
      const url = document.createElement('span'); url.className = 'suggestion-url'; appendHighlighted(url, suggestion.url, input.value);
      option.append(text, url); option.title = suggestion.text;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      option.addEventListener('pointermove', () => activate(index));
      fragment.append(option);
    }
    list.replaceChildren(fragment); active = -1;
    panel.dataset.open = String(suggestions.length > 0); panel.inert = !suggestions.length;
    input.setAttribute('aria-expanded', String(suggestions.length > 0));
  };
  worker.onerror = () => close();
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: events.signal });
  listen(input, 'input', schedule); listen(input, 'focus', schedule);
  listen(input, 'compositionstart', () => { composing = true; close(); });
  listen(input, 'compositionend', () => { composing = false; schedule(); });
  listen(mode, 'change', schedule);
  listen(input, 'keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close();
    else if (!panel.inert && panel.dataset.open === 'true' && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      activate((active + (event.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + suggestions.length) % suggestions.length);
    } else if (!panel.inert && event.key === 'Enter' && panel.dataset.open === 'true' && active >= 0) {
      event.preventDefault(); choose(active);
    }
  });
  listen(document, 'pointerdown', event => { if (!panel.parentElement.contains(event.target)) close(); });
  listen(document, 'focusin', event => { if (!panel.parentElement.contains(event.target)) close(); });
  for (const event of [globalThis.chrome?.history?.onVisited, globalThis.chrome?.history?.onVisitRemoved]) event?.addListener(invalidate);
  return {
    close, setHistory, invalidate,
    destroy() {
      close(); events.abort(); worker.terminate();
      for (const event of [globalThis.chrome?.history?.onVisited, globalThis.chrome?.history?.onVisitRemoved]) event?.removeListener(invalidate);
    },
  };
}
