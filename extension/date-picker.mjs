import { parseDate, formatDate, moveDate, moveMonth } from './calendar-dates.mjs';
import { resolveTimeRange } from './history-filters.mjs';

export function setupDatePicker({ lang, t }) {
  const events = new AbortController();
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: events.signal });
  const panel = document.getElementById('filters');
  const calendar = document.getElementById('datePicker');
  const range = document.getElementById('timeRange');
  const fields = ['startDate', 'endDate'].map(id => document.getElementById(id));
  const toggles = fields.map(input => document.querySelector('[data-calendar-for="' + input.id + '"]'));
  const grid = calendar.querySelector('.range-calendar-grid');
  const heading = document.getElementById('rangeCalendarMonth');
  const summary = document.getElementById('timeRangeDates');
  const locale = lang === 'en' ? 'en-US' : 'zh-CN';
  const monthFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' });
  const dayFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const shortDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  let month = formatDate(new Date()), focusedDate = month, choosingEnd = false, lastDraft = '';
  let activeField;
  let restoreGridFocus = false;
  const draft = () => ({ range: range.value, startDate: fields[0].value, endDate: fields[1].value });
  const names = t('calendarWeekdays').split(' ');
  for (const name of [...names.slice(1), names[0]]) {
    const label = document.createElement('span'); label.textContent = name; calendar.querySelector('.range-calendar-weekdays').append(label);
  }
  function endpoints() {
    if (range.value === 'custom') return fields.map(input => parseDate(input.value) ? input.value : '');
    const period = resolveTimeRange(draft());
    return period ? [formatDate(new Date(period.startTime)), formatDate(new Date(period.endTime - 1))] : ['', ''];
  }
  function render(focus = false) {
    const restore = focus || grid.contains(document.activeElement) || restoreGridFocus && document.activeElement === document.body;
    // Scanning temporarily disables dates; restore the same keyboard position when it finishes.
    restoreGridFocus = restore && range.disabled;
    const [start, end] = endpoints();
    const view = parseDate(month);
    heading.textContent = monthFormat.format(view);
    if (start && end) {
      const withYear = parseDate(start).getFullYear() !== new Date().getFullYear() || parseDate(end).getFullYear() !== new Date().getFullYear();
      const formatter = withYear ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : shortDate;
      summary.textContent = formatter.format(parseDate(start)) + ' — ' + formatter.format(parseDate(end)) + ' · ' + t('localDates');
    } else summary.textContent = range.value === 'all' ? t('timeAll') : t(start ? 'chooseRangeEnd' : 'chooseRangeStart');
    grid.replaceChildren();
    const first = parseDate(month); first.setDate(1);
    // Keep Monday-first presentation local to this panel.
    const offsetToMonday = (first.getDay() + 6) % 7;
    const values = Array.from({ length: 42 }, (_, index) => {
      const day = new Date(first); day.setDate(first.getDate() - offsetToMonday + index);
      return day.getFullYear() < 100 || day.getFullYear() > 9999 ? null : formatDate(day);
    });
    const currentDay = formatDate(new Date());
    for (let offset = 0; offset < values.length; offset += 7) {
      if (offset >= 28 && (!values[offset] || values[offset].slice(0, 7) > month.slice(0, 7))) break;
      const row = document.createElement('div'); row.className = 'range-calendar-row'; row.setAttribute('role', 'row');
      for (const value of values.slice(offset, offset + 7)) {
        if (!value) { const blank = document.createElement('span'); blank.setAttribute('role', 'gridcell'); row.append(blank); continue; }
        const day = parseDate(value);
        const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'range-calendar-day';
        cell.dataset.date = value; cell.textContent = String(day.getDate()); cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', dayFormat.format(day));
        cell.setAttribute('aria-selected', String(!!start && !!end && value >= start && value <= end));
        cell.tabIndex = value === focusedDate ? 0 : -1; cell.disabled = range.disabled;
        cell.classList.toggle('outside-month', day.getMonth() !== view.getMonth());
        cell.classList.toggle('in-range', !!start && !!end && start <= end && value > start && value < end);
        cell.classList.toggle('range-end', value === start || value === end);
        if (value === currentDay) cell.setAttribute('aria-current', 'date');
        row.append(cell);
      }
      grid.append(row);
    }
    if (!grid.querySelector('[tabindex="0"]')) grid.querySelector('[data-date="' + month + '"]')?.setAttribute('tabindex', '0');
    for (const nav of calendar.querySelectorAll('[data-range-month]')) nav.disabled = range.disabled || moveMonth(month, Number(nav.dataset.rangeMonth)) === month;
    toggles.forEach((toggle, index) => { toggle.disabled = fields[index].disabled; });
    if (restore && !range.disabled) grid.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }
  function sync(reset = false) {
    const key = JSON.stringify(draft());
    if (reset || key !== lastDraft) {
      lastDraft = key;
      const [start, end] = endpoints();
      month = start || end || formatDate(new Date()); focusedDate = month;
      choosingEnd = range.value === 'custom' && !!start && !end;
    }
    render();
  }
  function choose(value) {
    if (range.disabled) return;
    let changed;
    if (activeField) {
      activeField.value = value; changed = activeField; activeField = undefined;
    } else if (!choosingEnd) {
      range.value = 'custom'; fields[0].value = value; fields[1].value = ''; choosingEnd = true; changed = range;
    } else {
      const start = fields[0].value;
      fields[0].value = value < start ? value : start; fields[1].value = value < start ? start : value;
      choosingEnd = false; changed = fields[1];
    }
    changed.dispatchEvent(new Event('change', { bubbles: true }));
    focusedDate = value; month = value; render(true);
  }
  listen(grid, 'click', event => { const value = event.target.closest('[data-date]')?.dataset.date; if (value) choose(value); });
  listen(grid, 'keydown', event => {
    const value = event.target.closest('[data-date]')?.dataset.date;
    if (!value) return;
    let target;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (step) target = moveDate(value, step);
    else if (event.key === 'PageUp' || event.key === 'PageDown') target = moveMonth(value, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
    else if (event.key === 'Home' || event.key === 'End') {
      const day = (parseDate(value).getDay() + 6) % 7;
      target = moveDate(value, (event.key === 'End' ? 6 : 0) - day);
    }
    if (target) { event.preventDefault(); month = target; focusedDate = target; render(true); }
  });
  for (const nav of calendar.querySelectorAll('[data-range-month]')) listen(nav, 'click', () => {
    month = moveMonth(month, Number(nav.dataset.rangeMonth)); focusedDate = month; render();
  });
  for (const [index, input] of fields.entries()) {
    listen(toggles[index], 'click', () => { activeField = input; focusedDate = parseDate(input.value) ? input.value : month; month = focusedDate; render(true); });
    listen(input, 'keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); activeField = input; render(true); } });
    listen(input, 'focus', () => { activeField = input; });
  }
  listen(range, 'change', () => { activeField = undefined; });
  listen(panel, 'toggle', () => { if (panel.open) sync(true); else activeField = undefined; });
  sync();
  return { sync, destroy() { events.abort(); } };
}
