const MIN_YEAR = 100;
const MAX_YEAR = 9999;

function parseParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // setFullYear avoids Date's special handling of constructor years 0 through 99.
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function parseDate(value) {
  return parseParts(value);
}

export function formatDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < MIN_YEAR || date.getFullYear() > MAX_YEAR) {
    throw new Error('INVALID_DATE');
  }
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function requireDate(value) {
  const date = parseParts(value);
  if (!date) throw new Error('INVALID_DATE');
  return date;
}

function requireInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_DATE_OFFSET');
  return value;
}

export function moveDate(value, days) {
  const date = requireDate(value);
  const offset = requireInteger(days);
  date.setDate(date.getDate() + offset);
  if (!Number.isFinite(date.getTime())) return offset < 0 ? '0100-01-01' : offset > 0 ? '9999-12-31' : value;
  if (date.getFullYear() < MIN_YEAR) return '0100-01-01';
  if (date.getFullYear() > MAX_YEAR) return '9999-12-31';
  return formatDate(date);
}

function daysInMonth(year, monthIndex) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex + 1, 0);
  return date.getDate();
}

export function moveMonth(value, amount) {
  const date = requireDate(value);
  const offset = requireInteger(amount);
  const targetMonth = date.getFullYear() * 12 + date.getMonth() + offset;
  const minMonth = MIN_YEAR * 12;
  const maxMonth = MAX_YEAR * 12 + 11;
  if (targetMonth < minMonth) return '0100-01-01';
  if (targetMonth > maxMonth) return '9999-12-31';

  const year = Math.floor(targetMonth / 12);
  const monthIndex = targetMonth % 12;
  const day = Math.min(date.getDate(), daysInMonth(year, monthIndex));
  return formatDate(parseDate(`${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`));
}

export function calendarDays(monthValue) {
  const month = requireDate(monthValue);
  const first = new Date(month.getTime());
  first.setDate(1);
  const start = new Date(first.getTime());
  start.setDate(1 - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime());
    date.setDate(start.getDate() + index);
    if (date.getFullYear() < MIN_YEAR || date.getFullYear() > MAX_YEAR) return null;
    return formatDate(date);
  });
}
