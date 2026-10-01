import { parseDate, formatDate, moveDate, moveMonth, calendarDays } from './calendar-dates.mjs';

export function setupDatePicker({ lang, t }) {
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const fields = ['startDate', 'endDate'].map(id => document.getElementById(id));
  const toggles = fields.map(input => document.querySelector(`[data-calendar-for="${input.id}"]`));
  const dialog = document.createElement('dialog');
  dialog.id = 'datePicker'; dialog.className = 'date-picker';
  dialog.setAttribute('aria-label', t('calendarLabel'));
  dialog.innerHTML = `<div class="calendar-header"><button type="button" class="calendar-nav calendar-prev"></button><button type="button" class="calendar-heading" id="calendarMonth"></button><button type="button" class="calendar-nav calendar-next"></button></div><div class="calendar-weekdays" aria-hidden="true"></div><div class="calendar-grid" role="grid" aria-labelledby="calendarMonth"></div><div class="calendar-footer"><button type="button" class="calendar-clear"></button><button type="button" class="calendar-today"></button></div>`;
  document.body.append(dialog);
  const heading = dialog.querySelector('.calendar-heading');
  const previous = dialog.querySelector('.calendar-prev');
  const next = dialog.querySelector('.calendar-next');
  const weekdays = dialog.querySelector('.calendar-weekdays');
  const grid = dialog.querySelector('.calendar-grid');
  const clear = dialog.querySelector('.calendar-clear');
  const today = dialog.querySelector('.calendar-today');
  clear.textContent = t('calendarClear'); today.textContent = t('calendarToday');
  const locale = lang === 'en' ? 'en-US' : 'zh-CN';
  const monthFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' });
  const dayFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const shortMonth = new Intl.DateTimeFormat(locale, { month: 'short' });
  let activeInput, focusedDate, monthView = false;

  for (const name of t('calendarWeekdays').split(' ')) {
    const label = document.createElement('span'); label.textContent = name; weekdays.append(label);
  }
  function close(restoreFocus = false) {
    if (!dialog.open) return;
    dialog.close();
    toggles.forEach(button => button.setAttribute('aria-expanded', 'false'));
    const input = activeInput; activeInput = null;
    if (restoreFocus && !input?.disabled) input?.focus({ preventScroll: true });
  }
  function position() {
    if (!dialog.open) return;
    if (activeInput.disabled || !document.getElementById('filters').open || document.getElementById('customDates').hidden) return close();
    const anchor = activeInput.closest('.date-control').getBoundingClientRect();
    const box = dialog.getBoundingClientRect();
    // The same picker must fit inside the toolbar popup as well as a full browser tab.
    const below = anchor.bottom + 7;
    const top = below + box.height <= innerHeight - 8 ? below : anchor.top - box.height - 7;
    dialog.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`;
  }
  function focusCell() { grid.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }); }
  function render(focus = false) {
    const date = parseDate(focusedDate);
    const selected = activeInput.value;
    const currentDay = formatDate(new Date());
    const [start, end] = fields.map(input => parseDate(input.value) ? input.value : '');
    heading.textContent = monthView ? new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(date) : monthFormat.format(date);
    heading.setAttribute('aria-label', `${heading.textContent}, ${t(monthView ? 'calendarChooseDay' : 'calendarChooseMonth')}`);
    previous.setAttribute('aria-label', t(monthView ? 'calendarPreviousYear' : 'calendarPreviousMonth'));
    next.setAttribute('aria-label', t(monthView ? 'calendarNextYear' : 'calendarNextMonth'));
    previous.disabled = date.getFullYear() === 100 && (monthView || date.getMonth() === 0);
    next.disabled = date.getFullYear() === 9999 && (monthView || date.getMonth() === 11);
    weekdays.hidden = monthView;
    grid.classList.toggle('calendar-months', monthView);
    grid.replaceChildren();
    const values = monthView
      ? Array.from({ length: 12 }, (_, month) => `${String(date.getFullYear()).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`)
      : calendarDays(focusedDate);
    const columns = monthView ? 3 : 7;
    for (let offset = 0; offset < values.length; offset += columns) {
      const row = document.createElement('div'); row.className = 'calendar-row'; row.setAttribute('role', 'row');
      for (const value of values.slice(offset, offset + columns)) {
        const cell = document.createElement('button'); cell.type = 'button'; cell.setAttribute('role', 'gridcell');
        if (!value) { cell.disabled = true; cell.tabIndex = -1; cell.className = 'calendar-blank'; row.append(cell); continue; }
        const day = parseDate(value);
        cell.dataset.date = value;
        cell.textContent = monthView ? shortMonth.format(day) : String(day.getDate());
        cell.setAttribute('aria-label', monthView ? monthFormat.format(day) : dayFormat.format(day));
        const chosen = monthView ? value.slice(0, 7) === selected.slice(0, 7) : value === selected;
        cell.setAttribute('aria-selected', String(chosen));
        cell.tabIndex = (monthView ? value.slice(0, 7) === focusedDate.slice(0, 7) : value === focusedDate) ? 0 : -1;
        if (!monthView) {
          cell.classList.toggle('outside-month', day.getMonth() !== date.getMonth());
          cell.classList.toggle('in-range', !!start && !!end && start <= end && value > start && value < end);
          cell.classList.toggle('range-end', value === start || value === end);
          if (value === currentDay) cell.setAttribute('aria-current', 'date');
        }
        row.append(cell);
      }
      grid.append(row);
    }
    position(); if (focus) focusCell();
  }
  function open(input, focus) {
    if (input.disabled) return;
    activeInput = input; monthView = false;
    dialog.setAttribute('aria-label', `${t('calendarLabel')}: ${t(input.id)}`);
    // Browsing an empty field starts at the other endpoint or today, without assigning a value.
    focusedDate = formatDate(parseDate(input.value) || fields.map(field => parseDate(field.value)).find(Boolean) || new Date());
    if (!dialog.open) dialog.show();
    toggles.forEach(button => button.setAttribute('aria-expanded', String(button.dataset.calendarFor === input.id)));
    render(focus);
    if (!focus) input.focus({ preventScroll: true });
  }
  function choose(value) {
    const input = activeInput;
    input.value = value; close(true);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const [index, input] of fields.entries()) {
    listen(input, 'click', () => open(input, false));
    listen(input, 'keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); open(input, true); }
    });
    listen(input, 'input', () => { if (dialog.open && activeInput === input && parseDate(input.value)) { focusedDate = input.value; render(); } });
    listen(toggles[index], 'click', () => { if (dialog.open && activeInput === input) close(true); else open(input, true); });
  }
  listen(previous, 'click', () => { focusedDate = moveMonth(focusedDate, monthView ? -12 : -1); render(); });
  listen(next, 'click', () => { focusedDate = moveMonth(focusedDate, monthView ? 12 : 1); render(); });
  listen(heading, 'click', () => { monthView = !monthView; render(); });
  listen(grid, 'click', event => {
    const value = event.target.closest('button[data-date]')?.dataset.date;
    if (!value) return;
    if (monthView) { focusedDate = moveMonth(focusedDate, parseDate(value).getMonth() - parseDate(focusedDate).getMonth()); monthView = false; render(true); }
    else choose(value);
  });
  listen(grid, 'keydown', event => {
    if (!event.target.matches('button[data-date]')) return;
    const date = event.target.dataset.date;
    let target;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: monthView ? -3 : -7, ArrowDown: monthView ? 3 : 7 }[event.key];
      target = monthView ? moveMonth(date, step) : moveDate(date, step);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      target = moveMonth(date, (event.key === 'PageUp' ? -1 : 1) * (monthView || event.shiftKey ? 12 : 1));
    } else if (event.key === 'Home' || event.key === 'End') {
      const offset = monthView ? parseDate(date).getMonth() : parseDate(date).getDay();
      const step = (event.key === 'End' ? monthView ? 11 : 6 : 0) - offset;
      target = monthView ? moveMonth(date, step) : moveDate(date, step);
    }
    if (target) { event.preventDefault(); focusedDate = target; render(true); }
  });
  listen(clear, 'click', () => choose(''));
  listen(today, 'click', () => choose(formatDate(new Date())));
  listen(document, 'keydown', event => {
    if (dialog.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  listen(document, 'pointerdown', event => {
    if (dialog.open && !dialog.contains(event.target) && !activeInput.closest('.date-control').contains(event.target)) close();
  }, { capture: true });
  listen(document, 'focusin', event => {
    if (dialog.open && !dialog.contains(event.target) && !activeInput.closest('.date-control').contains(event.target)) close();
  });
  listen(document.getElementById('filters'), 'toggle', () => { if (!document.getElementById('filters').open) close(); });
  listen(window, 'resize', position);
  listen(document, 'scroll', event => { if (!dialog.contains(event.target)) position(); }, { capture: true });
  return {
    sync() {
      toggles.forEach((button, index) => { button.disabled = fields[index].disabled; });
      if (dialog.open && (activeInput.disabled || document.getElementById('customDates').hidden)) close();
    },
    destroy() { close(); events.abort(); dialog.remove(); },
  };
}
