import nodemailer from 'nodemailer';
import type { Booking, EventType } from './db.js';
import { formatInZone } from './time.js';

export interface MailContext {
  baseUrl: string;
  ownerName: string;
  timeZone: string;
}

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.ALERT_FROM);
}

function icsDate(timestamp: number) {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
function icsText(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[,;]/g, (c) => `\\${c}`);
}

/** iCalendar file for a booking; works with Google Calendar, Outlook, and Apple Calendar. */
export function bookingIcs(booking: Booking, event: EventType, ctx: MailContext) {
  const cancelled = booking.status === 'cancelled';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//booking-page//EN',
    `METHOD:${cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:booking-${booking.id}@${new URL(ctx.baseUrl).hostname}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(booking.startsAt)}`,
    `DTEND:${icsDate(booking.endsAt)}`,
    `SUMMARY:${icsText(`${event.name} with ${ctx.ownerName || 'host'}`)}`,
    `DESCRIPTION:${icsText(`${event.description}${booking.notes ? `\n\nNotes: ${booking.notes}` : ''}\n\nCancel: ${ctx.baseUrl}/cancel/${booking.cancelToken}`)}`,
    event.location ? `LOCATION:${icsText(event.location)}` : '',
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `ATTENDEE;CN=${icsText(booking.guestName)}:mailto:${booking.guestEmail}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

export function bookingText(booking: Booking, event: EventType, ctx: MailContext, forOwner: boolean) {
  const when = `${formatInZone(booking.startsAt, booking.guestTimeZone)} (${booking.guestTimeZone})`;
  const ownerWhen = `${formatInZone(booking.startsAt, ctx.timeZone)} (${ctx.timeZone})`;
  const lines = [
    booking.status === 'cancelled' ? `Cancelled: ${event.name}` : `Confirmed: ${event.name}`,
    '',
    `When: ${forOwner ? ownerWhen : when}`,
    forOwner ? `Guest: ${booking.guestName} <${booking.guestEmail}>` : `With: ${ctx.ownerName || 'host'}`,
    `Duration: ${event.durationMinutes} minutes`,
    event.location ? `Where: ${event.location}` : '',
    booking.notes ? `Notes: ${booking.notes}` : '',
    '',
    booking.status === 'cancelled' ? '' : `Cancel this booking: ${ctx.baseUrl}/cancel/${booking.cancelToken}`,
  ];
  return lines
    .filter((l, i) => l !== '' || lines[i - 1] !== '')
    .join('\n')
    .trim();
}

export interface Mailer {
  send(
    to: string,
    subject: string,
    text: string,
    ics?: string
  ): Promise<{ success: boolean; error?: string }>;
}

export function smtpMailer(): Mailer {
  return {
    async send(to, subject, text, ics) {
      if (!smtpConfigured()) return { success: false, error: 'SMTP is not configured' };
      try {
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
            : undefined,
        });
        await transport.sendMail({
          from: process.env.ALERT_FROM,
          to,
          subject,
          text,
          icalEvent: ics
            ? { method: ics.includes('METHOD:CANCEL') ? 'CANCEL' : 'REQUEST', content: ics }
            : undefined,
        });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Email failed: ${message}`);
        return { success: false, error: message };
      }
    },
  };
}

/** Sends confirmation or cancellation emails to the guest and the owner. Never throws. */
export async function notifyBooking(mailer: Mailer, booking: Booking, event: EventType, ctx: MailContext) {
  const subject = `${booking.status === 'cancelled' ? 'Cancelled' : 'Confirmed'}: ${event.name} on ${formatInZone(booking.startsAt, booking.guestTimeZone)}`;
  const ics = bookingIcs(booking, event, ctx);
  const owner = process.env.OWNER_EMAIL?.trim() || process.env.ALERT_FROM?.trim();
  const results = await Promise.all([
    mailer.send(booking.guestEmail, subject, bookingText(booking, event, ctx, false), ics),
    owner
      ? mailer.send(owner, `${subject} (${booking.guestName})`, bookingText(booking, event, ctx, true), ics)
      : Promise.resolve({ success: false, error: 'No owner email' }),
  ]);
  return { guest: results[0], owner: results[1] };
}
