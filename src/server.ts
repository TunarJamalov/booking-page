import express from 'express';
import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import {
  basicCredentials,
  createSession,
  deleteTotp,
  destroySession,
  hasTotp,
  initAuth,
  randomTotpSetup,
  saveTotp,
  session,
  validateAuthEncryptionKey,
  validCsrf,
  verifyTotp,
} from './auth.js';
import {
  cancelBooking,
  createBlock,
  dueReminders,
  markReminded,
  rescheduleBooking,
  createBooking,
  getBooking,
  getBookingByToken,
  getEventType,
  getEventTypeBySlug,
  listBlocks,
  listBookings,
  listEventTypes,
  removeBlock,
  removeEventType,
  saveEventType,
  stats,
  validateEventType,
  type EventType,
} from './db.js';
import { bookingIcs, notifyBooking, smtpConfigured, smtpMailer, type Mailer } from './mail.js';
import { availableDays, slotIsBookable, slotsForDay } from './slots.js';
import { dateKey, isValidTimeZone } from './time.js';
import {
  bookingPage,
  cancelPage,
  dashboardPage,
  indexPage,
  loginPage,
  messagePage,
  reschedulePage,
  securityPage,
} from './ui.js';

const SESSION_HOURS = 8;
const LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ServerOptions {
  baseUrl?: string;
  timeZone?: string;
  ownerName?: string;
  mailer?: Mailer;
  now?: () => number;
}

export function createServer(db: Database.Database, options: ServerOptions = {}) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const configured = Boolean(username || password);
  if (configured && (!username || !password))
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured together');
  if (configured) validateAuthEncryptionKey();
  initAuth(db);
  const timeZone = options.timeZone ?? process.env.TIMEZONE?.trim() ?? 'UTC';
  if (!isValidTimeZone(timeZone)) throw new Error(`TIMEZONE "${timeZone}" is not a valid IANA time zone`);
  const ownerName = options.ownerName ?? process.env.OWNER_NAME?.trim() ?? '';
  const mailer = options.mailer ?? smtpMailer();
  const now = options.now ?? (() => Date.now());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(express.json({ limit: '50kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const baseUrl = (req: express.Request) =>
    (options.baseUrl ?? process.env.BASE_URL?.trim() ?? '').replace(/\/+$/, '') ||
    `${req.protocol}://${req.get('host')}`;
  const ctx = (req: express.Request) => ({ baseUrl: baseUrl(req), ownerName, timeZone });
  const cookie = (req: express.Request, name: string) =>
    req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const basicOk = (req: express.Request) => {
    const c = basicCredentials(req);
    return Boolean(
      c && username && password && sameString(c.username, username) && sameString(c.password, password)
    );
  };
  const setAuthCookies = (
    req: express.Request,
    res: express.Response,
    s: { token: string; csrf: string }
  ) => {
    const secure = process.env.NODE_ENV === 'production' || req.secure;
    const attrs = `Path=/; Max-Age=${SESSION_HOURS * 60 * 60}; SameSite=Strict${secure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', [`session=${s.token}; HttpOnly; ${attrs}`, `csrf=${s.csrf}; ${attrs}`]);
  };
  const clearAuthCookies = (res: express.Response) =>
    res.setHeader('Set-Cookie', [
      'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
      'csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);
  const failures = new Map<string, { count: number; until: number }>();
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!configured) return next();
    const row = session(db, cookie(req, 'session'));
    if (!row)
      return req.originalUrl.startsWith('/api/')
        ? res.status(401).json({ error: 'Authentication required' })
        : res.redirect('/login');
    if (req.method !== 'GET' && !validCsrf(row, req.headers['x-csrf-token'] as string))
      return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  };
  const setup = () => {
    const s = randomTotpSetup();
    return { ...s, otpauth: `otpauth://totp/Booking%20Page?secret=${s.secret}&issuer=Booking%20Page` };
  };
  const setupResponse = async (
    res: express.Response,
    s: { secret: string; codes: string[]; otpauth: string }
  ) =>
    res.json({
      secret: s.secret,
      recoveryCodes: s.codes,
      otpauth: s.otpauth,
      qrDataUrl: await QRCode.toDataURL(s.otpauth),
    });
  const badRequest = (res: express.Response, e: unknown) =>
    res.status(400).send(e instanceof Error ? e.message : 'Invalid request');
  const publicEvent = (req: express.Request, e: EventType) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    durationMinutes: e.durationMinutes,
    location: e.location,
    bookingUrl: `${baseUrl(req)}/book/${e.slug}`,
    ownerName,
    timeZone,
  });

  /* ---------- Public booking ---------- */
  app.get('/', (q, r) =>
    r.type('html').send(indexPage(listEventTypes(db, true).map((e) => publicEvent(q, e))))
  );
  app.get('/healthz', (_q, r) => r.json({ ok: true }));
  app.get('/robots.txt', (_q, r) =>
    r.type('text/plain').send('User-agent: *\nDisallow: /dashboard\nDisallow: /api/\nDisallow: /cancel/\n')
  );
  app.get('/book/:slug', (q, r) => {
    const event = getEventTypeBySlug(db, q.params.slug);
    if (!event || !event.active)
      return r.status(404).type('html').send(messagePage('Not found', 'This booking page does not exist.'));
    r.type('html').send(bookingPage(publicEvent(q, event)));
  });
  app.get('/api/book/:slug', (q, r) => {
    const event = getEventTypeBySlug(db, q.params.slug);
    if (!event || !event.active) return r.sendStatus(404);
    r.json({ ...publicEvent(q, event), days: availableDays(db, event, timeZone, now()) });
  });
  app.get('/api/book/:slug/slots', (q, r) => {
    const event = getEventTypeBySlug(db, q.params.slug);
    if (!event || !event.active) return r.sendStatus(404);
    const day = typeof q.query.day === 'string' ? q.query.day : dateKey(now(), timeZone);
    try {
      r.json({ day, slots: slotsForDay(db, event, day, timeZone, now()) });
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.post('/api/book/:slug', async (q, r) => {
    const event = getEventTypeBySlug(db, q.params.slug);
    if (!event || !event.active) return r.sendStatus(404);
    const body = q.body ?? {};
    const guestName = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    const guestEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
    const guestTimeZone =
      typeof body.timeZone === 'string' && isValidTimeZone(body.timeZone) ? body.timeZone : timeZone;
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';
    const startsAt = Number(body.startsAt);
    if (!guestName) return r.status(400).send('Please enter your name');
    if (!EMAIL_PATTERN.test(guestEmail)) return r.status(400).send('Please enter a valid email address');
    if (!Number.isFinite(startsAt)) return r.status(400).send('Choose a time slot');
    if (!slotIsBookable(db, event, startsAt, timeZone, now()))
      return r.status(409).send('That time is no longer available. Please pick another slot.');
    const booking = createBooking(db, {
      eventTypeId: event.id,
      startsAt,
      endsAt: startsAt + event.durationMinutes * 60000,
      guestName,
      guestEmail,
      guestTimeZone,
      notes,
    });
    const mail =
      smtpConfigured() || options.mailer ? await notifyBooking(mailer, booking, event, ctx(q)) : undefined;
    r.status(201).json({
      id: booking.id,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      cancelUrl: `${baseUrl(q)}/cancel/${booking.cancelToken}`,
      icsUrl: `${baseUrl(q)}/cancel/${booking.cancelToken}/invite.ics`,
      emailSent: Boolean(mail?.guest.success),
    });
  });
  app.get('/cancel/:token', (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    if (!booking)
      return r.status(404).type('html').send(messagePage('Not found', 'This booking link is not valid.'));
    r.type('html').send(cancelPage(booking, timeZone));
  });
  app.get('/cancel/:token/invite.ics', (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    const event = booking && getEventType(db, booking.eventTypeId);
    if (!booking || !event) return r.sendStatus(404);
    r.setHeader('Content-Disposition', 'attachment; filename="invite.ics"');
    r.type('text/calendar').send(bookingIcs(booking, event, ctx(q)));
  });
  app.get('/reschedule/:token', (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    const event = booking && getEventType(db, booking.eventTypeId);
    if (!booking || !event)
      return r.status(404).type('html').send(messagePage('Not found', 'This booking link is not valid.'));
    if (booking.status !== 'confirmed')
      return r
        .status(410)
        .type('html')
        .send(
          messagePage(
            'Booking cancelled',
            'A cancelled booking cannot be rescheduled. Book a new time instead.'
          )
        );
    r.type('html').send(reschedulePage(booking, publicEvent(q, event)));
  });
  app.get('/api/reschedule/:token', (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    const event = booking && getEventType(db, booking.eventTypeId);
    if (!booking || !event || booking.status !== 'confirmed') return r.sendStatus(404);
    const day = typeof q.query.day === 'string' ? q.query.day : undefined;
    try {
      r.json({
        ...publicEvent(q, event),
        startsAt: booking.startsAt,
        days: day ? undefined : availableDays(db, event, timeZone, now()),
        slots: day ? slotsForDay(db, event, day, timeZone, now(), booking.id) : undefined,
      });
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.post('/api/reschedule/:token', async (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    const event = booking && getEventType(db, booking.eventTypeId);
    if (!booking || !event) return r.sendStatus(404);
    if (booking.status !== 'confirmed')
      return r.status(410).send('A cancelled booking cannot be rescheduled');
    const startsAt = Number(q.body?.startsAt);
    if (!Number.isFinite(startsAt)) return r.status(400).send('Choose a time slot');
    if (startsAt === booking.startsAt) return r.status(400).send('That is the current time of the booking');
    if (!slotIsBookable(db, event, startsAt, timeZone, now(), booking.id))
      return r.status(409).send('That time is no longer available. Please pick another slot.');
    const moved = rescheduleBooking(db, booking.id, startsAt, event.durationMinutes)!;
    const mail =
      smtpConfigured() || options.mailer
        ? await notifyBooking(mailer, moved, event, ctx(q), 'rescheduled')
        : undefined;
    r.json({
      ok: true,
      startsAt: moved.startsAt,
      endsAt: moved.endsAt,
      emailSent: Boolean(mail?.guest.success),
    });
  });
  app.post('/api/cancel/:token', async (q, r) => {
    const booking = getBookingByToken(db, q.params.token);
    if (!booking) return r.sendStatus(404);
    if (booking.status === 'cancelled') return r.json({ ok: true, alreadyCancelled: true });
    const cancelled = cancelBooking(db, booking.id, 'guest', now())!;
    const event = getEventType(db, booking.eventTypeId)!;
    if (smtpConfigured() || options.mailer) await notifyBooking(mailer, cancelled, event, ctx(q));
    r.json({ ok: true });
  });

  /* ---------- Authentication ---------- */
  app.get('/login', (_q, r) => (configured ? r.type('html').send(loginPage()) : r.redirect('/dashboard')));
  app.post('/api/auth/login', (req, res) => {
    if (!configured) return res.status(401).json({ error: 'Authentication is not configured' });
    const ip = req.ip || 'unknown';
    const at = Date.now();
    const old = failures.get(ip);
    if (old && old.until > at && old.count >= LOGIN_ATTEMPTS)
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    const passwordOk = basicOk(req);
    const totpOk = !hasTotp(db) || (passwordOk && verifyTotp(db, String(req.body?.code ?? '').trim()));
    if (!passwordOk || !totpOk) {
      const count = (old?.count ?? 0) + 1;
      failures.set(ip, { count, until: at + (count >= LOGIN_ATTEMPTS ? LOCKOUT_MS : 60 * 1000) });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    failures.delete(ip);
    setAuthCookies(req, res, createSession(db));
    return res.json({ ok: true });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    destroySession(db, cookie(req, 'session'));
    clearAuthCookies(res);
    res.json({ ok: true });
  });

  /* ---------- Admin ---------- */
  app.use(['/dashboard', '/api/admin'], auth);
  app.get('/dashboard', (_q, r) => r.type('html').send(dashboardPage()));
  app.get('/dashboard/security', (_q, r) => r.type('html').send(securityPage()));
  app.get('/api/admin/security', (_q, r) =>
    r.json({ authConfigured: configured, totpConfigured: hasTotp(db) })
  );
  app.post('/api/admin/security/regenerate', async (_q, r) => {
    if (!configured)
      return r.status(400).json({ error: 'Set ADMIN_USERNAME and ADMIN_PASSWORD before enabling TOTP' });
    const s = setup();
    saveTotp(db, s.secret, s.codes);
    return setupResponse(r, s);
  });
  app.post('/api/admin/security/disable', (_q, r) => {
    deleteTotp(db);
    r.json({ ok: true });
  });

  app.get('/api/admin/overview', (_q, r) =>
    r.json({ ...stats(db, now()), timeZone, ownerName, smtpConfigured: smtpConfigured() })
  );
  app.get('/api/admin/event-types', (q, r) =>
    r.json(listEventTypes(db).map((e) => ({ ...e, bookingUrl: `${baseUrl(q)}/book/${e.slug}` })))
  );
  app.post('/api/admin/event-types', (q, r) => {
    try {
      r.status(201).json(saveEventType(db, validateEventType(q.body)));
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.put('/api/admin/event-types/:id', (q, r) => {
    if (!getEventType(db, Number(q.params.id))) return r.sendStatus(404);
    try {
      r.json(saveEventType(db, validateEventType(q.body), Number(q.params.id)));
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.delete('/api/admin/event-types/:id', (q, r) =>
    removeEventType(db, Number(q.params.id)) ? r.sendStatus(204) : r.sendStatus(404)
  );

  app.get('/api/admin/bookings', (q, r) => {
    const past = q.query.past === 'true';
    r.json(listBookings(db, past ? {} : { from: now() }));
  });
  app.post('/api/admin/bookings/:id/cancel', async (q, r) => {
    const booking = getBooking(db, Number(q.params.id));
    if (!booking) return r.sendStatus(404);
    if (booking.status === 'cancelled') return r.status(400).send('Already cancelled');
    const cancelled = cancelBooking(db, booking.id, 'owner', now())!;
    if (smtpConfigured() || options.mailer)
      await notifyBooking(mailer, cancelled, getEventType(db, booking.eventTypeId)!, ctx(q));
    r.json(cancelled);
  });

  app.get('/api/admin/blocks', (_q, r) => r.json(listBlocks(db, now() - 86400000)));
  app.post('/api/admin/blocks', (q, r) => {
    try {
      r.status(201).json(
        createBlock(db, {
          startsAt: Number(q.body?.startsAt),
          endsAt: Number(q.body?.endsAt),
          reason: q.body?.reason,
        })
      );
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.delete('/api/admin/blocks/:id', (q, r) =>
    removeBlock(db, Number(q.params.id)) ? r.sendStatus(204) : r.sendStatus(404)
  );

  /** Sends reminder emails for bookings starting within `hoursAhead`. Called by the process timer. */
  const sendReminders = async (hoursAhead: number) => {
    if (!(smtpConfigured() || options.mailer)) return 0;
    let sent = 0;
    for (const booking of dueReminders(db, hoursAhead, now())) {
      const event = getEventType(db, booking.eventTypeId);
      if (!event) continue;
      const base = {
        baseUrl:
          (options.baseUrl ?? process.env.BASE_URL?.trim() ?? '').replace(/\/+$/, '') || 'http://localhost',
        ownerName,
        timeZone,
      };
      const result = await notifyBooking(mailer, booking, event, base, 'reminder');
      if (result.guest.success || result.owner.success) {
        markReminded(db, booking.id, now());
        sent++;
      }
    }
    return sent;
  };
  (app as express.Express & { sendReminders: typeof sendReminders }).sendReminders = sendReminders;

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as any)?.type === 'entity.parse.failed' ? 400 : ((error as any)?.status ?? 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 400 ? 'Invalid JSON body' : 'Internal server error' });
  });
  return app as express.Express & { sendReminders: (hoursAhead: number) => Promise<number> };
}
