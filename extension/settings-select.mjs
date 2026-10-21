// The select remains the draft value; its custom trigger and list own all user interaction.
export function setupSettingsSelects(dialog) {
  const events = new AbortController();
  const listen = (node, name, fn) => node.addEventListener(name, fn, { signal: events.signal });
  const content = dialog.querySelector('.preferences-content');
  const fields = [...dialog.querySelectorAll('[data-settings-select]')].map(field => {
    const source = field.querySelector('select');
    return { source, trigger: field.querySelector('[role=combobox]'), value: field.querySelector('.settings-select-value'), menu: dialog.querySelector(`#${source.id}Options`), active: source.selectedIndex };
  });
  let current = null;
  let typed = '';
  let typedAt = 0;

  function sync() {
    for (const item of fields) {
      item.value.textContent = item.source.selectedOptions[0]?.textContent || '';
      item.trigger.disabled = item.source.disabled;
      for (const option of item.menu.querySelectorAll('[role=option]')) option.setAttribute('aria-selected', String(option.dataset.value === item.source.value));
    }
  }
  function close(restoreFocus = false) {
    if (!current) return;
    const item = current; current = null; typed = '';
    item.menu.hidden = true;
    item.trigger.setAttribute('aria-expanded', 'false');
    item.trigger.removeAttribute('aria-activedescendant');
    if (restoreFocus) item.trigger.focus({ preventScroll: true });
  }
  function position() {
    if (!current) return;
    const { trigger, menu } = current;
    const anchor = trigger.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    const origin = dialog.getBoundingClientRect();
    if (!dialog.open || trigger.matches(':disabled') || anchor.top < viewport.top || anchor.bottom > viewport.bottom) { close(); return; }
    const gap = 6;
    const width = Math.min(anchor.width, origin.width - 16);
    menu.style.width = `${width}px`;
    const naturalHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    const above = Math.max(0, anchor.top - viewport.top - gap);
    const below = Math.max(0, viewport.bottom - anchor.bottom - gap);
    const upward = below < Math.min(naturalHeight, 260) && above > below;
    menu.style.maxHeight = `${Math.min(260, upward ? above : below)}px`;
    const left = Math.max(origin.left + 8, Math.min(anchor.left, origin.right - width - 8));
    menu.style.left = `${left - origin.left - dialog.clientLeft}px`;
    menu.style.top = `${(upward ? anchor.top - gap - menu.offsetHeight : anchor.bottom + gap) - origin.top - dialog.clientTop}px`;
    menu.dataset.placement = upward ? 'above' : 'below';
  }
  function activate(index, scroll = true) {
    if (!current) return;
    const options = [...current.menu.querySelectorAll('[role=option]')];
    current.active = Math.max(0, Math.min(options.length - 1, index));
    for (const [i, option] of options.entries()) option.dataset.active = String(i === current.active);
    const active = options[current.active];
    current.trigger.setAttribute('aria-activedescendant', active.id);
    if (!scroll) return;
    const menu = current.menu;
    if (active.offsetTop < menu.scrollTop) menu.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = active.offsetTop + active.offsetHeight - menu.clientHeight;
  }
  function open(item, index = item.source.selectedIndex) {
    if (item.trigger.matches(':disabled') || !dialog.open) return;
    close(); sync(); current = item;
    item.menu.hidden = false;
    item.trigger.setAttribute('aria-expanded', 'true');
    item.trigger.focus({ preventScroll: true });
    position(); activate(index);
  }
  function choose(value) {
    if (!current) return;
    const item = current;
    item.source.value = value;
    item.source.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }
  for (const item of fields) {
    listen(item.source, 'change', sync);
    listen(item.trigger, 'click', () => current === item ? close(true) : open(item));
    listen(item.trigger, 'keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Escape') { if (current) { close(true); event.preventDefault(); } return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        const wasOpen = current === item;
        if (!wasOpen) open(item);
        if (!current) return;
        if (event.key === 'Home') activate(0);
        else if (event.key === 'End') activate(item.source.options.length - 1);
        else if (wasOpen && event.key === 'ArrowDown') activate(item.active + 1);
        else if (wasOpen && event.key === 'ArrowUp') activate(item.active - 1);
        else if (wasOpen && ['Enter', ' '].includes(event.key)) choose(item.source.options[item.active].value);
        return;
      }
      if (event.key.length !== 1) return;
      event.preventDefault();
      if (current !== item) open(item);
      if (!current) return;
      const now = performance.now();
      typed = now - typedAt > 600 ? event.key : typed + event.key;
      typedAt = now;
      const query = [...typed].every(char => char === typed[0]) ? typed[0] : typed;
      for (let step = 1; step <= item.source.options.length; step++) {
        const index = (item.active + step) % item.source.options.length;
        if (item.source.options[index].textContent.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) { activate(index); break; }
      }
    });
    for (const [index, option] of [...item.menu.querySelectorAll('[role=option]')].entries()) {
      listen(option, 'pointerdown', event => event.preventDefault());
      listen(option, 'pointermove', () => { if (current === item) activate(index, false); });
      listen(option, 'click', () => choose(option.dataset.value));
    }
  }
  listen(content, 'scroll', position);
  listen(window, 'resize', position);
  sync();
  return {
    sync, close,
    isOpen: () => current !== null,
    contains: target => fields.some(item => item.trigger.contains(target)) || !!current?.menu.contains(target),
    destroy: () => { close(); events.abort(); },
  };
}
