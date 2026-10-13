import type Database from 'better-sqlite3';
import { busyIntervals, type EventType } from './db.js';
import { addDays, fromWallTime, parseDateKey } from './time.js';

export interface Slot {
  startsAt: number;
  endsAt: number;
}

interface Interval {
  startsAt: number;
  endsAt: number;
}

const overlaps = (a: Interval, b: Interval) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * Free slots of an event type on one calendar day of the owner's time zone.
 * `day` is YYYY-MM-DD in the owner's zone. Slots are aligned to the event's step size,
 * respect minimum notice and the booking horizon, and exclude bookings and blocks.
 */
export function slotsForDay(
  db: Database.Database,
  event: EventType,
  day: string,
  timeZone: string,
  now = Date.now(),
  excludeBookingId: number | null = null
): Slot[] {
  const key = parseDateKey(day);
  if (!key) throw new Error('day must be YYYY-MM-DD');
  const dayStart = fromWallTime(key, timeZone);
  const nextDay = fromWallTime(addDays(key, 1), timeZone);
  const earliest = now + event.minNoticeMinutes * 60000;
  const latest = now + event.maxDaysAhead * 86400000;
  if (nextDay <= earliest || dayStart > latest) return [];
  // Weekday of the calendar date itself (independent of any zone offset).
  const weekday = new Date(Date.UTC(key.year, key.month - 1, key.day)).getUTCDay();
  const windows = event.windows.filter((w) => w.weekday === weekday);
  if (!windows.length) return [];
  const busy = busyIntervals(
    db,
    dayStart - 86400000,
    nextDay + 86400000,
    event.bufferMinutes,
    excludeBookingId
  );
  const duration = event.durationMinutes * 60000;
  const step = event.slotStepMinutes * 60000;
  const slots: Slot[] = [];
  for (const w of windows) {
    const windowStart = fromWallTime(
      { ...key, hour: Math.floor(w.start / 60), minute: w.start % 60 },
      timeZone
    );
    const windowEnd = fromWallTime({ ...key, hour: Math.floor(w.end / 60), minute: w.end % 60 }, timeZone);
    for (let start = windowStart; start + duration <= windowEnd; start += step) {
      const slot = { startsAt: start, endsAt: start + duration };
      if (slot.startsAt < earliest || slot.startsAt > latest) continue;
      if (busy.some((b) => overlaps(slot, b))) continue;
      slots.push(slot);
    }
  }
  return slots.sort((a, b) => a.startsAt - b.startsAt);
}

/** Days (YYYY-MM-DD, owner zone) within the horizon that have at least one free slot. */
export function availableDays(
  db: Database.Database,
  event: EventType,
  timeZone: string,
  now = Date.now()
): string[] {
  const days: string[] = [];
  const start = parseDateKey(new Date(now).toISOString().slice(0, 10))!;
  for (let i = -1; i <= event.maxDaysAhead + 1; i++) {
    const key = addDays(start, i);
    const day = `${key.year}-${String(key.month).padStart(2, '0')}-${String(key.day).padStart(2, '0')}`;
    if (slotsForDay(db, event, day, timeZone, now).length) days.push(day);
  }
  return days;
}

/** True when the exact slot is still free and valid for the event right now. */
export function slotIsBookable(
  db: Database.Database,
  event: EventType,
  startsAt: number,
  timeZone: string,
  now = Date.now(),
  excludeBookingId: number | null = null
) {
  const key = parseDateKey(new Date(startsAt).toISOString().slice(0, 10))!;
  // The slot's calendar day in the owner's zone may differ from the UTC day; check both neighbours.
  for (const offset of [-1, 0, 1]) {
    const k = addDays(key, offset);
    const day = `${k.year}-${String(k.month).padStart(2, '0')}-${String(k.day).padStart(2, '0')}`;
    if (slotsForDay(db, event, day, timeZone, now, excludeBookingId).some((s) => s.startsAt === startsAt))
      return true;
  }
  return false;
}
