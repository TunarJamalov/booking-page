import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createBlock,
  createBooking,
  openDatabase,
  saveEventType,
  validateEventType,
  validateWindows,
} from '../src/db.js';
import { bookingIcs, type Mailer } from '../src/mail.js';
import { createServer } from '../src/server.js';
import { availableDays, slotIsBookable, slotsForDay } from '../src/slots.js';
import { dateKey, fromWallTime, wallTime } from '../src/time.js';

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.AUTH_ENCRYPTION_KEY;
});

const TZ = 'Asia/Baku'; // UTC+4, no DST
// Monday 2026-03-02 08:00 in Baku = 04:00 UTC
const MONDAY_8AM = Date.UTC(2026, 2, 2, 4, 0);
const event = () =>
  saveEventType(
    db,
    validateEventType({
      name: 'Intro call',
      durationMinutes: 30,
      slotStepMinutes: 30,
      bufferMinutes: 0,
      minNoticeMinutes: 60,
      maxDaysAhead: 7,
      windows: [{ weekday: 1, start: '09:00', end: '12:00' }],
    })
  );

describe('time zones', () => {
  it('converts wall time in a zone to timestamps and back, including DST', () => {
    expect(fromWallTime({ year: 2026, month: 3, day: 2, hour: 9 }, TZ)).toBe(Date.UTC(2026, 2, 2, 5, 0));
    expect(wallTime(Date.UTC(2026, 2, 2, 5, 0), TZ)).toMatchObject({ hour: 9, minute: 0, weekday: 1 });
    // New York switches to DST on 2026-03-08; 09:00 local is 14:00 UTC before and 13:00 UTC after.
    expect(fromWallTime({ year: 2026, month: 3, day: 7, hour: 9 }, 'America/New_York')).toBe(
      Date.UTC(2026, 2, 7, 14, 0)
    );
    expect(fromWallTime({ year: 2026, month: 3, day: 9, hour: 9 }, 'America/New_York')).toBe(
      Date.UTC(2026, 2, 9, 13, 0)
    );
    expect(dateKey(Date.UTC(2026, 2, 2, 22, 30), TZ)).toBe('2026-03-03');
  });
});

describe('event types', () => {
  it('validates fields, windows and slugs', () => {
    expect(() => validateEventType({})).toThrow('name');
    expect(() => validateEventType({ name: 'x', durationMinutes: 2 })).toThrow('durationMinutes');
    expect(() => validateWindows([{ weekday: 7, start: '09:00', end: '10:00' }])).toThrow('weekday');
    expect(() => validateWindows([{ weekday: 1, start: '10:00', end: '09:00' }])).toThrow('after');
    expect(validateEventType({ name: 'Coffee Chat!' }).slug).toBe('coffee-chat');
    const saved = event();
    expect(() => saveEventType(db, validateEventType({ name: 'Other', slug: 'intro-call' }))).toThrow(
      'already used'
    );
    expect(saveEventType(db, validateEventType({ name: 'Renamed', slug: 'intro-call' }), saved.id).name).toBe(
      'Renamed'
    );
  });
});

describe('slots', () => {
  it('lists free slots inside windows, honouring notice, horizon, bookings, buffers and blocks', () => {
    const ev = event();
    const now = MONDAY_8AM;
    let slots = slotsForDay(db, ev, '2026-03-02', TZ, now);
    expect(slots.map((s) => wallTime(s.startsAt, TZ).hour + ':' + wallTime(s.startsAt, TZ).minute)).toEqual([
      '9:0',
      '9:30',
      '10:0',
      '10:30',
      '11:0',
      '11:30',
    ]);
    // Minimum notice of 60 minutes: at 08:45 the 09:00 and 09:30 slots are gone.
    expect(slotsForDay(db, ev, '2026-03-02', TZ, now + 45 * 60000)).toHaveLength(4);
    // Not a Monday.
    expect(slotsForDay(db, ev, '2026-03-03', TZ, now)).toEqual([]);
    // Beyond the horizon (7 days): the Monday after next.
    expect(slotsForDay(db, ev, '2026-03-16', TZ, now)).toEqual([]);
    expect(availableDays(db, ev, TZ, now)).toEqual(['2026-03-02']);
    // A booking at 10:00 removes 10:00; with a 30 minute buffer it also removes 09:30 and 10:30.
    const ten = fromWallTime({ year: 2026, month: 3, day: 2, hour: 10 }, TZ);
    createBooking(db, {
      eventTypeId: ev.id,
      startsAt: ten,
      endsAt: ten + 30 * 60000,
      guestName: 'A',
      guestEmail: 'a@b.c',
      guestTimeZone: TZ,
      notes: '',
    });
    slots = slotsForDay(db, ev, '2026-03-02', TZ, now);
    expect(slots.some((s) => s.startsAt === ten)).toBe(false);
    expect(slots).toHaveLength(5);
    expect(slotsForDay(db, { ...ev, bufferMinutes: 30 }, '2026-03-02', TZ, now)).toHaveLength(3);
    // A block over 11:00-12:00 removes the last two slots.
    createBlock(db, { startsAt: ten + 60 * 60000, endsAt: ten + 120 * 60000, reason: 'lunch' });
    expect(slotsForDay(db, ev, '2026-03-02', TZ, now)).toHaveLength(3);
    expect(slotIsBookable(db, ev, ten, TZ, now)).toBe(false);
    expect(slotIsBookable(db, ev, ten - 60 * 60000, TZ, now)).toBe(true);
    expect(slotIsBookable(db, ev, ten + 7 * 60000, TZ, now)).toBe(false);
  });
});

describe('booking flow over HTTP', () => {
  const sent: { to: string; subject: string; text: string; ics?: string }[] = [];
  const mailer: Mailer = {
    send: async (to, subject, text, ics) => (sent.push({ to, subject, text, ics }), { success: true }),
  };
  async function listen(now = MONDAY_8AM) {
    const app = createServer(db, {
      baseUrl: 'https://book.example',
      timeZone: TZ,
      ownerName: 'Tunar',
      mailer,
      now: () => now,
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
  }
  const json = (
    base: string,
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('books a slot, prevents double booking, emails both sides, and cancels by token', async () => {
    process.env.OWNER_EMAIL = 'owner@example.com';
    sent.length = 0;
    const ev = event();
    const { server, base } = await listen();
    const info = await (await fetch(`${base}/api/book/intro-call`)).json();
    expect(info).toMatchObject({ name: 'Intro call', ownerName: 'Tunar', days: ['2026-03-02'] });
    const slots = (await (await fetch(`${base}/api/book/intro-call/slots?day=2026-03-02`)).json()).slots;
    expect(slots).toHaveLength(6);
    expect(
      (
        await json(base, '/api/book/intro-call', 'POST', {
          startsAt: slots[0].startsAt,
          name: 'Guest',
          email: 'nope',
        })
      ).status
    ).toBe(400);
    const booked = await json(base, '/api/book/intro-call', 'POST', {
      startsAt: slots[0].startsAt,
      name: 'Guest <b>',
      email: 'guest@example.com',
      notes: 'Hi',
      timeZone: 'Europe/Berlin',
    });
    expect(booked.status).toBe(201);
    const result = await booked.json();
    expect(result.cancelUrl).toMatch(/^https:\/\/book\.example\/cancel\/[A-Za-z0-9_-]+$/);
    expect(result.emailSent).toBe(true);
    expect(sent.map((m) => m.to).sort()).toEqual(['guest@example.com', 'owner@example.com']);
    expect(sent[0].ics).toContain('BEGIN:VEVENT');
    expect(sent[0].text).toContain('Europe/Berlin');
    const again = await json(base, '/api/book/intro-call', 'POST', {
      startsAt: slots[0].startsAt,
      name: 'Other',
      email: 'o@example.com',
    });
    expect(again.status).toBe(409);
    expect(
      (await (await fetch(`${base}/api/book/intro-call/slots?day=2026-03-02`)).json()).slots
    ).toHaveLength(5);
    const token = result.cancelUrl.split('/').pop();
    const ics = await (await fetch(`${base}/cancel/${token}/invite.ics`)).text();
    expect(ics).toContain('SUMMARY:Intro call with Tunar');
    expect(ics).toContain('METHOD:REQUEST');
    const cancelHtml = await (await fetch(`${base}/cancel/${token}`)).text();
    expect(cancelHtml).toContain('Cancel booking');
    expect(cancelHtml).not.toContain('Guest <b>');
    expect((await fetch(`${base}/api/cancel/${token}`, { method: 'POST' })).status).toBe(200);
    expect(
      (await (await fetch(`${base}/api/cancel/${token}`, { method: 'POST' })).json()).alreadyCancelled
    ).toBe(true);
    expect(
      (await (await fetch(`${base}/api/book/intro-call/slots?day=2026-03-02`)).json()).slots
    ).toHaveLength(6);
    expect(sent.at(-1)!.subject).toContain('Cancelled');
    expect(sent.at(-1)!.ics).toContain('METHOD:CANCEL');
    const admin = await (await fetch(`${base}/api/admin/bookings?past=true`)).json();
    expect(admin[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'guest', guestName: 'Guest <b>' });
    for (const path of [
      '/',
      '/book/intro-call',
      '/dashboard',
      '/dashboard/security',
      '/login',
      `/cancel/${token}`,
    ]) {
      const html = await (await fetch(`${base}${path}`)).text();
      const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
      if (script) expect(() => new Function(script)).not.toThrow();
    }
    expect((await fetch(`${base}/book/missing`)).status).toBe(404);
    server.close();
    delete process.env.OWNER_EMAIL;
  });

  it('manages event types, blocks and owner cancellations through the admin API', async () => {
    const { server, base } = await listen();
    const created = await json(base, '/api/admin/event-types', 'POST', {
      name: 'Demo',
      durationMinutes: 45,
      minNoticeMinutes: 30,
      windows: [{ weekday: 1, start: '09:00', end: '10:30' }],
    });
    expect(created.status).toBe(201);
    const ev = await created.json();
    const list = await (await fetch(`${base}/api/admin/event-types`)).json();
    expect(list[0].bookingUrl).toBe('https://book.example/book/demo');
    const slots = (await (await fetch(`${base}/api/book/demo/slots?day=2026-03-02`)).json()).slots;
    expect(slots).toHaveLength(2);
    const booking = await (
      await json(base, '/api/book/demo', 'POST', {
        startsAt: slots[0].startsAt,
        name: 'G',
        email: 'g@example.com',
      })
    ).json();
    const cancelled = await json(base, `/api/admin/bookings/${booking.id}/cancel`, 'POST');
    expect((await cancelled.json()).cancelledBy).toBe('owner');
    const block = await json(base, '/api/admin/blocks', 'POST', {
      startsAt: slots[0].startsAt,
      endsAt: slots[1].endsAt,
      reason: 'Away',
    });
    expect(block.status).toBe(201);
    expect((await (await fetch(`${base}/api/book/demo/slots?day=2026-03-02`)).json()).slots).toHaveLength(0);
    expect(
      (await fetch(`${base}/api/admin/blocks/${(await block.json()).id}`, { method: 'DELETE' })).status
    ).toBe(204);
    expect(
      (await json(base, `/api/admin/event-types/${ev.id}`, 'PUT', { name: 'Demo', active: false })).status
    ).toBe(200);
    expect((await fetch(`${base}/api/book/demo`)).status).toBe(404);
    expect((await fetch(`${base}/api/admin/event-types/${ev.id}`, { method: 'DELETE' })).status).toBe(204);
    server.close();
  });

  it('requires a session for the dashboard when credentials are configured', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'pw';
    process.env.AUTH_ENCRYPTION_KEY = 'k'.repeat(40);
    const { server, base } = await listen();
    expect((await fetch(`${base}/api/admin/overview`)).status).toBe(401);
    expect((await fetch(`${base}/`)).status).toBe(200);
    const login = await json(
      base,
      '/api/auth/login',
      'POST',
      {},
      { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') }
    );
    expect(login.status).toBe(200);
    const jar = login.headers
      .getSetCookie()
      .map((v) => v.split(';', 1)[0])
      .join('; ');
    expect((await fetch(`${base}/api/admin/overview`, { headers: { Cookie: jar } })).status).toBe(200);
    server.close();
  });
});

describe('ics', () => {
  it('escapes text and marks cancellations', () => {
    const ev = event();
    const b = createBooking(db, {
      eventTypeId: ev.id,
      startsAt: MONDAY_8AM,
      endsAt: MONDAY_8AM + 1800000,
      guestName: 'A, B; C',
      guestEmail: 'a@b.c',
      guestTimeZone: TZ,
      notes: 'line1\nline2',
    });
    const ics = bookingIcs({ ...b, status: 'cancelled' }, ev, {
      baseUrl: 'https://x.y',
      ownerName: '',
      timeZone: TZ,
    });
    expect(ics).toContain('ATTENDEE;CN=A\\, B\\; C:mailto:a@b.c');
    expect(ics).toContain('line1\\nline2');
    expect(ics).toContain('STATUS:CANCELLED');
  });
});
