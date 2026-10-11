/**
 * Time zone helpers built on Intl only, so no time zone library is needed.
 * All timestamps are milliseconds since the epoch (UTC); "wall time" means local time in a zone.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string) {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock time of a timestamp in the given zone. */
export function wallTime(timestamp: number, timeZone: string): WallTime {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(timestamp))
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** Timestamp of a wall-clock time in the given zone (handles DST by iterating the offset). */
export function fromWallTime(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string
) {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallTime(guess, timeZone);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const diff = asUtc - seen;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

/** YYYY-MM-DD of a timestamp in a zone. */
export function dateKey(timestamp: number, timeZone: string) {
  const w = wallTime(timestamp, timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function parseDateKey(key: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

/** Adds whole days to a date key. */
export function addDays(key: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(key.year, key.month - 1, key.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatInZone(timestamp: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** "09:00" -> minutes since midnight, or undefined when malformed. */
export function parseClock(value: string) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
