export function setupTimePicker(input, { root, label, hourLabel, minuteLabel, doneLabel }) {
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const panel = document.createElement('div');
  panel.id = `${input.id}Picker`;
  panel.className = 'auto-time-picker';
  // A popover stays above the settings dialog and outside its scrolling clip.
  panel.popover = 'manual';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  panel.innerHTML = '<div class="auto-time-heading"><span></span><output></output></div><div class="auto-time-columns"></div><div class="auto-time-footer"><button type="button"></button></div>';
  panel.querySelector('.auto-time-heading span').textContent = label;
  const output = panel.querySelector('output');
  const done = panel.querySelector('.auto-time-footer button');
  done.textContent = doneLabel;
  input.setAttribute('aria-controls', panel.id);
  root.append(panel);
  let opened = false;
  let typed = '', typedAt = 0;

  const columns = [hourLabel, minuteLabel].map((name, part) => {
    const column = document.createElement('div');
    column.className = 'auto-time-column';
    const heading = document.createElement('span');
    heading.id = `${panel.id}Label${part}`;
    heading.className = 'auto-time-column-label';
    heading.textContent = name;
    const list = document.createElement('div');
    list.className = 'auto-time-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', heading.id);
    const options = Array.from({ length: part === 0 ? 24 : 60 }, (_, value) => {
      const option = document.createElement('button');
      option.type = 'button'; option.className = 'auto-time-option';
      option.setAttribute('role', 'option'); option.tabIndex = -1;
      option.textContent = String(value).padStart(2, '0');
      option.dataset.value = option.textContent;
      listen(option, 'click', () => choose(part, value));
      list.append(option);
      return option;
    });
    column.append(heading, list);
    panel.querySelector('.auto-time-columns').append(column);
    listen(list, 'keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const current = options.indexOf(document.activeElement);
      let next = current;
      if (event.key === 'ArrowDown') next++;
      else if (event.key === 'ArrowUp') next--;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); typed = ''; typedAt = 0; focusPart(1 - part); return;
      } else if (/^\d$/.test(event.key)) {
        const now = performance.now();
        typed = now - typedAt < 800 ? typed + event.key : event.key;
        typedAt = now;
        if (typed.length > 2 || Number(typed) >= options.length) typed = event.key;
        next = Number(typed);
      } else return;
      event.preventDefault();
      next = Math.max(0, Math.min(next, options.length - 1));
      choose(part, next); focusPart(part);
    });
    return { list, options };
  });
  function sync() {
    output.textContent = input.value;
    const parts = input.value.split(':');
    columns.forEach(({ options }, part) => options.forEach(option => {
      const selected = option.dataset.value === parts[part];
      option.setAttribute('aria-selected', String(selected));
      option.tabIndex = selected ? 0 : -1;
    }));
  }
  function focusPart(part) {
    const option = columns[part].options.find(option => option.tabIndex === 0);
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: 'nearest' });
  }
  function choose(part, value) {
    const parts = input.value.split(':');
    parts[part] = String(value).padStart(2, '0');
    const next = parts.join(':');
    if (input.value === next) return;
    input.value = next; sync();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function close(restoreFocus = false) {
    if (!opened) return;
    opened = false; panel.hidePopover();
    input.setAttribute('aria-expanded', 'false');
    if (restoreFocus) input.focus({ preventScroll: true });
  }
  function position() {
    if (!opened) return;
    if (!input.checkVisibility() || input.disabled) return close();
    const anchor = input.getBoundingClientRect();
    const dialog = input.closest('dialog[open]');
    const bounds = dialog ? dialog.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const left = Math.max(8, bounds.left + 8), right = Math.min(innerWidth - 8, bounds.right - 8);
    const top = Math.max(8, bounds.top + 8), bottom = Math.min(innerHeight - 8, bounds.bottom - 8);
    const below = bottom - anchor.bottom - 6, above = anchor.top - top - 6;
    const openBelow = below >= Math.min(310, bottom - top) || below >= above;
    panel.style.width = `${Math.min(240, right - left)}px`;
    panel.style.maxHeight = `${Math.max(0, openBelow ? below : above)}px`;
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(left, Math.min(anchor.left, right - box.width))}px`;
    panel.style.top = `${openBelow ? anchor.bottom + 6 : anchor.top - box.height - 6}px`;
  }
  function open() {
    if (opened || input.disabled) return;
    typed = ''; typedAt = 0;
    sync(); panel.showPopover(); opened = true;
    input.setAttribute('aria-expanded', 'true'); position();
    columns.forEach(({ options, list }) => {
      const selected = options.find(option => option.tabIndex === 0);
      if (selected) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
    });
    focusPart(0);
  }
  listen(input, 'click', () => opened ? close(true) : open());
  listen(input, 'keydown', event => {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
  });
  listen(panel, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') {
      typed = ''; typedAt = 0;
      const part = columns.findIndex(column => column.list.contains(document.activeElement));
      if (event.shiftKey && part === 0 || !event.shiftKey && document.activeElement === done) close(true);
      else {
        event.preventDefault();
        if (event.shiftKey) focusPart(document.activeElement === done ? 1 : 0);
        else if (part === 0) focusPart(1);
        else done.focus();
      }
    }
  });
  listen(done, 'click', () => close(true));
  listen(document, 'pointerdown', event => { if (!panel.contains(event.target) && event.target !== input) close(); }, { capture: true });
  listen(document, 'focusin', event => { if (!panel.contains(event.target) && event.target !== input) close(); });
  listen(window, 'resize', position);
  listen(document, 'scroll', event => { if (!panel.contains(event.target)) position(); }, { capture: true });
  return { close, destroy: () => { close(); events.abort(); panel.remove(); } };
}
