const MAX_DATE = 8.64e15;
const invalidSchedule = () => new Error('AUTO_INVALID_SCHEDULE');

function validTimestamp(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidSchedule();
  if (input.type === 'once' && Number.isSafeInteger(input.at) && input.at > 0 && validTimestamp(input.at)) {
    return { type: 'once', at: input.at };
  }
  if (input.type === 'daily' && validTime(input.time)) return { type: 'daily', time: input.time };
  if (input.type === 'weekly' && validTime(input.time) && Number.isInteger(input.weekday) && input.weekday >= 0 && input.weekday <= 6) {
    return { type: 'weekly', weekday: input.weekday, time: input.time };
  }
  if (input.type === 'monthly' && validTime(input.time) && Number.isInteger(input.day) && input.day >= 1 && input.day <= 31) {
    return { type: 'monthly', day: input.day, time: input.time };
  }
  throw invalidSchedule();
}

function localDate(year, month, day, hour, minute) {
  // setFullYear handles years 0–99 without Date's constructor's 1900 offset.
  const result = new Date(0);
  result.setFullYear(year, month, day);
  result.setHours(hour, minute, 0, 0);
  return result;
}

function candidateForDate(year, month, day, hour, minute) {
  const candidate = localDate(year, month, day, hour, minute);
  const timestamp = candidate.getTime();
  return validTimestamp(timestamp) ? timestamp : null;
}

export function nextOccurrence(input, after) {
  const schedule = normalizeSchedule(input);
  if (!validTimestamp(after)) throw invalidSchedule();
  if (schedule.type === 'once') return schedule.at > after ? schedule.at : null;

  const reference = new Date(after);
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const day = reference.getDate();
  const [hour, minute] = schedule.time.split(':').map(Number);

  if (schedule.type === 'daily') {
    for (let offset = 0; offset <= 1; offset++) {
      const candidate = candidateForDate(year, month, day + offset, hour, minute);
      if (candidate !== null && candidate > after) return candidate;
    }
    return null;
  }

  if (schedule.type === 'weekly') {
    const daysUntil = (schedule.weekday - reference.getDay() + 7) % 7;
    for (const offset of [daysUntil, daysUntil + 7]) {
      const candidate = candidateForDate(year, month, day + offset, hour, minute);
      if (candidate !== null && candidate > after) return candidate;
    }
    return null;
  }

  // A monthly candidate is at most one month away; the next month covers a
  // schedule whose time has already passed this month.
  for (let offset = 0; offset <= 1; offset++) {
    const monthDate = localDate(year, month + offset, 1, 0, 0);
    if (!Number.isFinite(monthDate.getTime())) return null;
    const lastDayDate = new Date(monthDate);
    lastDayDate.setMonth(lastDayDate.getMonth() + 1);
    lastDayDate.setDate(0);
    const candidateDay = Math.min(schedule.day, lastDayDate.getDate());
    const candidate = candidateForDate(monthDate.getFullYear(), monthDate.getMonth(), candidateDay, hour, minute);
    if (candidate !== null && candidate > after) return candidate;
  }
  return null;
}
