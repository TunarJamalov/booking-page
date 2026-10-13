import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { initAuth } from './auth.js';
import { parseClock } from './time.js';

/** One availability window: weekday 0-6 (Sunday first), start and end as minutes since midnight. */
export interface Window {
  weekday: number;
  start: number;
  end: number;
}
export interface EventType {
  id: number;
  slug: string;
  name: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  slotStepMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  location: string;
  active: boolean;
  windows: Window[];
  createdAt: number;
}
export type BookingStatus = 'confirmed' | 'cancelled';
export interface Booking {
  id: number;
  eventTypeId: number;
  eventName: string;
  startsAt: number;
  endsAt: number;
  guestName: string;
  guestEmail: string;
  guestTimeZone: string;
  notes: string;
  status: BookingStatus;
  cancelToken: string;
  cancelledAt: number | null;
  cancelledBy: string | null;
  /** Incremented on every reschedule so calendar clients update the existing event. */
  sequence: number;
  rescheduledFrom: number | null;
  reminderSentAt: number | null;
  createdAt: number;
}
export interface Block {
  id: number;
  startsAt: number;
  endsAt: number;
  reason: string;
}

export const DEFAULT_WINDOWS: Window[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start: 9 * 60,
  end: 17 * 60,
}));
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

export function openDatabase(filename: string): Database.Database {
  const dir = path.dirname(filename);
  if (dir !== '.' && filename !== ':memory:') fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initAuth(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL,
      buffer_minutes INTEGER NOT NULL DEFAULT 0,
      slot_step_minutes INTEGER NOT NULL DEFAULT 30,
      min_notice_minutes INTEGER NOT NULL DEFAULT 120,
      max_days_ahead INTEGER NOT NULL DEFAULT 30,
      location TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      windows_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type_id INTEGER NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      guest_time_zone TEXT NOT NULL DEFAULT 'UTC',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'confirmed',
      cancel_token TEXT NOT NULL UNIQUE,
      cancelled_at INTEGER,
      cancelled_by TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      rescheduled_from INTEGER,
      reminder_sent_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS bookings_time ON bookings(status, starts_at);
    CREATE INDEX IF NOT EXISTS blocks_time ON blocks(starts_at, ends_at);
  `);
  for (const statement of [
    'ALTER TABLE bookings ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE bookings ADD COLUMN rescheduled_from INTEGER',
    'ALTER TABLE bookings ADD COLUMN reminder_sent_at INTEGER',
  ]) {
    try {
      db.exec(statement);
    } catch {
      /* Existing installations already have this column. */
    }
  }
  return db;
}

/* ---------- Event types ---------- */
const eventColumns =
  'id,slug,name,description,duration_minutes as durationMinutes,buffer_minutes as bufferMinutes,slot_step_minutes as slotStepMinutes,min_notice_minutes as minNoticeMinutes,max_days_ahead as maxDaysAhead,location,active,windows_json as windowsJson,created_at as createdAt FROM event_types';
const toEvent = (row: any): EventType => {
  const { windowsJson, ...rest } = row;
  return { ...rest, active: Boolean(row.active), windows: JSON.parse(windowsJson) };
};

/** Accepts windows as {weekday, start: "09:00", end: "17:00"} or as minutes. */
export function validateWindows(raw: unknown): Window[] {
  if (!Array.isArray(raw)) throw new Error('windows must be a list');
  const windows = raw.map((w: any) => {
    const weekday = Number(w?.weekday);
    const start = typeof w?.start === 'string' ? parseClock(w.start) : Number(w?.start);
    const end = typeof w?.end === 'string' ? parseClock(w.end) : Number(w?.end);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
      throw new Error('weekday must be 0 (Sunday) to 6 (Saturday)');
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end))
      throw new Error('window times must be HH:MM');
    if (end <= start || start < 0 || end > 24 * 60) throw new Error('window end must be after its start');
    return { weekday, start, end };
  });
  return windows.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
}

export function validateEventType(raw: unknown) {
  const e = (raw ?? {}) as Record<string, unknown>;
  const name = typeof e.name === 'string' ? e.name.trim().slice(0, 120) : '';
  if (!name) throw new Error('name is required');
  const slug =
    typeof e.slug === 'string' && e.slug.trim()
      ? e.slug.trim().toLowerCase()
      : name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 64);
  if (!SLUG_PATTERN.test(slug)) throw new Error('slug may contain lowercase letters, digits and dashes');
  const int = (key: string, fallback: number, min: number, max: number) => {
    const value = e[key] == null || e[key] === '' ? fallback : Number(e[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  return {
    slug,
    name,
    description: typeof e.description === 'string' ? e.description.trim().slice(0, 2000) : '',
    durationMinutes: int('durationMinutes', 30, 5, 24 * 60),
    bufferMinutes: int('bufferMinutes', 0, 0, 24 * 60),
    slotStepMinutes: int('slotStepMinutes', 30, 5, 24 * 60),
    minNoticeMinutes: int('minNoticeMinutes', 120, 0, 60 * 24 * 365),
    maxDaysAhead: int('maxDaysAhead', 30, 1, 365),
    location: typeof e.location === 'string' ? e.location.trim().slice(0, 500) : '',
    active: e.active !== false,
    windows: e.windows === undefined ? DEFAULT_WINDOWS : validateWindows(e.windows),
  };
}
export function listEventTypes(db: Database.Database, activeOnly = false): EventType[] {
  return db
    .prepare(`SELECT ${eventColumns}${activeOnly ? ' WHERE active=1' : ''} ORDER BY name`)
    .all()
    .map(toEvent);
}
export function getEventType(db: Database.Database, id: number): EventType | undefined {
  const row = db.prepare(`SELECT ${eventColumns} WHERE id=?`).get(id);
  return row ? toEvent(row) : undefined;
}
export function getEventTypeBySlug(db: Database.Database, slug: string): EventType | undefined {
  const row = db.prepare(`SELECT ${eventColumns} WHERE slug=?`).get(slug.toLowerCase());
  return row ? toEvent(row) : undefined;
}
export function saveEventType(
  db: Database.Database,
  input: ReturnType<typeof validateEventType>,
  id?: number
): EventType {
  const clash = getEventTypeBySlug(db, input.slug);
  if (clash && clash.id !== id) throw new Error(`"${input.slug}" is already used by another event type`);
  const values = [
    input.slug,
    input.name,
    input.description,
    input.durationMinutes,
    input.bufferMinutes,
    input.slotStepMinutes,
    input.minNoticeMinutes,
    input.maxDaysAhead,
    input.location,
    input.active ? 1 : 0,
    JSON.stringify(input.windows),
  ];
  if (id) {
    const changes = db
      .prepare(
        'UPDATE event_types SET slug=?,name=?,description=?,duration_minutes=?,buffer_minutes=?,slot_step_minutes=?,min_notice_minutes=?,max_days_ahead=?,location=?,active=?,windows_json=? WHERE id=?'
      )
      .run(...values, id).changes;
    if (!changes) throw new Error('Event type not found');
    return getEventType(db, id)!;
  }
  const created = db
    .prepare(
      'INSERT INTO event_types (slug,name,description,duration_minutes,buffer_minutes,slot_step_minutes,min_notice_minutes,max_days_ahead,location,active,windows_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(...values, Date.now()).lastInsertRowid;
  return getEventType(db, Number(created))!;
}
export function removeEventType(db: Database.Database, id: number) {
  return db.prepare('DELETE FROM event_types WHERE id=?').run(id).changes > 0;
}

/* ---------- Bookings ---------- */
const bookingColumns =
  'b.id,b.event_type_id as eventTypeId,e.name as eventName,b.starts_at as startsAt,b.ends_at as endsAt,b.guest_name as guestName,b.guest_email as guestEmail,b.guest_time_zone as guestTimeZone,b.notes,b.status,b.cancel_token as cancelToken,b.cancelled_at as cancelledAt,b.cancelled_by as cancelledBy,b.sequence,b.rescheduled_from as rescheduledFrom,b.reminder_sent_at as reminderSentAt,b.created_at as createdAt FROM bookings b JOIN event_types e ON e.id=b.event_type_id';

export function listBookings(
  db: Database.Database,
  options: { from?: number; to?: number; status?: BookingStatus; eventTypeId?: number } = {}
): Booking[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.from !== undefined) (where.push('b.ends_at>?'), params.push(options.from));
  if (options.to !== undefined) (where.push('b.starts_at<?'), params.push(options.to));
  if (options.status) (where.push('b.status=?'), params.push(options.status));
  if (options.eventTypeId !== undefined) (where.push('b.event_type_id=?'), params.push(options.eventTypeId));
  return db
    .prepare(
      `SELECT ${bookingColumns}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY b.starts_at`
    )
    .all(...params) as Booking[];
}
export function getBooking(db: Database.Database, id: number): Booking | undefined {
  return db.prepare(`SELECT ${bookingColumns} WHERE b.id=?`).get(id) as Booking | undefined;
}
export function getBookingByToken(db: Database.Database, token: string): Booking | undefined {
  return db.prepare(`SELECT ${bookingColumns} WHERE b.cancel_token=?`).get(token) as Booking | undefined;
}
/** Busy intervals (confirmed bookings including buffers, plus manual blocks) overlapping [from, to). */
export function busyIntervals(
  db: Database.Database,
  from: number,
  to: number,
  bufferMinutes = 0,
  excludeBookingId: number | null = null
) {
  const buffer = bufferMinutes * 60000;
  const bookings = db
    .prepare(
      "SELECT starts_at as startsAt, ends_at as endsAt FROM bookings WHERE status='confirmed' AND ends_at+?>? AND starts_at-?<? AND id IS NOT ?"
    )
    .all(buffer, from, buffer, to, excludeBookingId) as { startsAt: number; endsAt: number }[];
  const blocks = db
    .prepare('SELECT starts_at as startsAt, ends_at as endsAt FROM blocks WHERE ends_at>? AND starts_at<?')
    .all(from, to) as { startsAt: number; endsAt: number }[];
  return [...bookings.map((b) => ({ startsAt: b.startsAt - buffer, endsAt: b.endsAt + buffer })), ...blocks];
}
export function createBooking(
  db: Database.Database,
  input: {
    eventTypeId: number;
    startsAt: number;
    endsAt: number;
    guestName: string;
    guestEmail: string;
    guestTimeZone: string;
    notes: string;
  }
): Booking {
  const token = randomBytes(24).toString('base64url');
  const id = db
    .prepare(
      'INSERT INTO bookings (event_type_id,starts_at,ends_at,guest_name,guest_email,guest_time_zone,notes,cancel_token,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      input.eventTypeId,
      input.startsAt,
      input.endsAt,
      input.guestName,
      input.guestEmail,
      input.guestTimeZone,
      input.notes,
      token,
      Date.now()
    ).lastInsertRowid;
  return getBooking(db, Number(id))!;
}
/** Moves a confirmed booking to a new start; the caller has already checked that the slot is free. */
export function rescheduleBooking(
  db: Database.Database,
  id: number,
  startsAt: number,
  durationMinutes: number
) {
  const current = getBooking(db, id);
  if (!current || current.status !== 'confirmed') return undefined;
  db.prepare(
    'UPDATE bookings SET starts_at=?,ends_at=?,rescheduled_from=?,sequence=sequence+1,reminder_sent_at=NULL WHERE id=?'
  ).run(startsAt, startsAt + durationMinutes * 60000, current.startsAt, id);
  return getBooking(db, id);
}
/** Confirmed bookings that start within the reminder window and have not been reminded yet. */
export function dueReminders(db: Database.Database, hoursAhead: number, now = Date.now()): Booking[] {
  if (!hoursAhead) return [];
  return db
    .prepare(
      `SELECT ${bookingColumns} WHERE b.status='confirmed' AND b.reminder_sent_at IS NULL AND b.starts_at>? AND b.starts_at<=? ORDER BY b.starts_at`
    )
    .all(now, now + hoursAhead * 3600000) as Booking[];
}
export function markReminded(db: Database.Database, id: number, at = Date.now()) {
  db.prepare('UPDATE bookings SET reminder_sent_at=? WHERE id=?').run(at, id);
}
export function cancelBooking(db: Database.Database, id: number, by: 'guest' | 'owner', at = Date.now()) {
  const changes = db
    .prepare(
      "UPDATE bookings SET status='cancelled',cancelled_at=?,cancelled_by=? WHERE id=? AND status='confirmed'"
    )
    .run(at, by, id).changes;
  return changes > 0 ? getBooking(db, id) : undefined;
}

/* ---------- Blocks ---------- */
export function listBlocks(db: Database.Database, from = 0): Block[] {
  return db
    .prepare(
      'SELECT id,starts_at as startsAt,ends_at as endsAt,reason FROM blocks WHERE ends_at>? ORDER BY starts_at'
    )
    .all(from) as Block[];
}
export function createBlock(
  db: Database.Database,
  input: { startsAt: number; endsAt: number; reason?: string }
): Block {
  if (!Number.isFinite(input.startsAt) || !Number.isFinite(input.endsAt) || input.endsAt <= input.startsAt)
    throw new Error('A block needs a start before its end');
  const id = db
    .prepare('INSERT INTO blocks (starts_at,ends_at,reason) VALUES (?,?,?)')
    .run(input.startsAt, input.endsAt, (input.reason ?? '').trim().slice(0, 200)).lastInsertRowid;
  return db
    .prepare('SELECT id,starts_at as startsAt,ends_at as endsAt,reason FROM blocks WHERE id=?')
    .get(id) as Block;
}
export function removeBlock(db: Database.Database, id: number) {
  return db.prepare('DELETE FROM blocks WHERE id=?').run(id).changes > 0;
}

export function stats(db: Database.Database, now = Date.now()) {
  const n = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    eventTypes: n('SELECT COUNT(*) as n FROM event_types WHERE active=1'),
    upcoming: n("SELECT COUNT(*) as n FROM bookings WHERE status='confirmed' AND starts_at>=?", now),
    today: n(
      "SELECT COUNT(*) as n FROM bookings WHERE status='confirmed' AND starts_at>=? AND starts_at<?",
      now - (now % 86400000),
      now - (now % 86400000) + 86400000
    ),
    cancelled: n("SELECT COUNT(*) as n FROM bookings WHERE status='cancelled'"),
  };
}
