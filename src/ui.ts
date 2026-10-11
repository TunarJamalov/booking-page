/**
 * Server-rendered pages. Client scripts are plain strings without template interpolation so
 * no server value is ever placed inside executable code; page data travels through JSON APIs.
 */
export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

const css = `
:root{--bg:#f4f6f8;--panel:#fff;--border:#dbe1e8;--text:#15202b;--muted:#5f6b7a;--ok:#15803d;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--warn:#b45309;--warn-bg:#fef3c7;--accent:#2563eb;--accent-bg:#dbeafe}
@media(prefers-color-scheme:dark){:root{--bg:#0f141a;--panel:#171e26;--border:#2a3441;--text:#e6ebf0;--muted:#94a3b8;--ok:#4ade80;--ok-bg:#14532d;--bad:#fca5a5;--bad-bg:#7f1d1d;--warn:#fcd34d;--warn-bg:#78350f;--accent:#3b82f6;--accent-bg:#1e3a8a}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:auto;padding:20px 16px;background:var(--bg);color:var(--text);line-height:1.45}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}h3{font-size:.95rem;margin:14px 0 6px;color:var(--muted)}
a{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 16px;color:var(--muted)}
.panel,.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;background:var(--ok-bg);color:var(--ok);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.off{background:var(--bad-bg);color:var(--bad)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
button{padding:7px 11px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font:inherit;font-size:13px}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}
input,select,textarea{width:100%;padding:8px;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px}
textarea{min-height:70px}
label{display:block;font-size:13px}
form.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.wide{grid-column:span 2}.full{grid-column:1/-1}
@media(max-width:700px){form.grid{grid-template-columns:1fr}.wide,.full{grid-column:auto}}
.summary{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
.summary span{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px}
.msg{min-height:20px;margin:8px 0 0}.msg.error{color:var(--bad)}
.hidden{display:none !important}
pre{background:var(--bg);padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px}
.windows{display:grid;gap:6px}
.window{display:grid;grid-template-columns:110px 1fr 1fr auto;gap:8px;align-items:end}
.booking-layout{display:grid;grid-template-columns:260px 1fr;gap:16px}
@media(max-width:700px){.booking-layout{grid-template-columns:1fr}}
.days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.days button{padding:8px 0;font-size:13px}
.days button.selected{background:var(--accent);color:#fff;border-color:var(--accent)}
.days .dow{text-align:center;font-size:11px;color:var(--muted)}
.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px}
.slots button.selected{background:var(--accent);color:#fff;border-color:var(--accent)}
.center{max-width:560px;margin:40px auto}
.event-link{display:block;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--panel);margin:10px 0;text-decoration:none;color:var(--text)}
.event-link:hover{border-color:var(--accent)}
`;

function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const helpers = `
var $ = function (id) { return document.getElementById(id); };
var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var csrf = function () { var m = document.cookie.match(/(?:^|; )csrf=([^;]+)/); return m ? m[1] : ''; };
var api = function (url, method, body) {
  return fetch(url, { method: method || 'GET', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (r) { if (r.status === 401) { location = '/login'; throw new Error('Authentication required'); } return r; });
};
var showMessage = function (id, text, isError) { var el = $(id); el.textContent = text; el.className = 'msg' + (isError ? ' error' : ''); };
var fmt = function (ts, tz, opts) { return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }, opts || {})).format(new Date(ts)); };
var toLocalInput = function (ts) { var d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var clock = function (m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
`;

export function messagePage(title: string, message: string) {
  return page(
    title,
    `<div class="center card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`
  );
}

export function indexPage(events: any[]) {
  const owner = events[0]?.ownerName;
  return page(
    owner ? `Book time with ${owner}` : 'Book a time',
    `<div class="center"><h1>${escapeHtml(owner ? `Book time with ${owner}` : 'Book a time')}</h1><p class="muted">Choose what you would like to schedule.</p>${
      events
        .map(
          (e) =>
            `<a class="event-link" href="/book/${escapeHtml(e.slug)}"><strong>${escapeHtml(e.name)}</strong><div class="muted">${e.durationMinutes} minutes${e.location ? ` · ${escapeHtml(e.location)}` : ''}</div>${e.description ? `<div class="muted">${escapeHtml(e.description)}</div>` : ''}</a>`
        )
        .join('') || '<p class="muted">Nothing can be booked yet.</p>'
    }</div>`
  );
}

const bookingScript = `
${helpers}
var slug = location.pathname.split('/').pop();
var info = null, days = [], selectedDay = null, selectedSlot = null, month = null;
var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function renderCalendar() {
  var first = new Date(month.getFullYear(), month.getMonth(), 1);
  var html = '<div class="row"><button type="button" id="prev">&lsaquo;</button><strong>' + first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + '</strong><button type="button" id="next">&rsaquo;</button></div><div class="days">';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { html += '<div class="dow">' + d + '</div>'; });
  for (var i = 0; i < first.getDay(); i++) html += '<div></div>';
  var count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (var d = 1; d <= count; d++) {
    var key = dayKey(new Date(month.getFullYear(), month.getMonth(), d));
    var free = days.indexOf(key) >= 0;
    html += '<button type="button" data-day="' + key + '"' + (free ? '' : ' disabled') + (key === selectedDay ? ' class="selected"' : '') + '>' + d + '</button>';
  }
  $('calendar').innerHTML = html + '</div>';
  $('prev').onclick = function () { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderCalendar(); };
  $('next').onclick = function () { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderCalendar(); };
}
$('calendar').onclick = async function (e) {
  var b = e.target.closest('[data-day]'); if (!b) return;
  selectedDay = b.getAttribute('data-day'); selectedSlot = null; renderCalendar();
  $('slots').innerHTML = '<p class="muted">Loading...</p>';
  var r = await fetch('/api/book/' + slug + '/slots?day=' + selectedDay);
  var data = await r.json();
  $('slot-title').textContent = new Date(selectedDay + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('slots').innerHTML = data.slots.map(function (s) { return '<button type="button" data-slot="' + s.startsAt + '">' + fmt(s.startsAt, tz, { dateStyle: undefined, timeStyle: 'short' }) + '</button>'; }).join('') || '<p class="muted">No free times on this day.</p>';
};
$('slots').onclick = function (e) {
  var b = e.target.closest('[data-slot]'); if (!b) return;
  selectedSlot = Number(b.getAttribute('data-slot'));
  Array.from($('slots').children).forEach(function (el) { el.classList.toggle('selected', el === b); });
  $('chosen').textContent = fmt(selectedSlot, tz) + ' (' + tz + ')';
  $('form').classList.remove('hidden');
  $('name').focus();
};
$('book-form').onsubmit = async function (e) {
  e.preventDefault();
  if (!selectedSlot) return;
  $('submit').disabled = true;
  var r = await fetch('/api/book/' + slug, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startsAt: selectedSlot, name: $('name').value, email: $('email').value, notes: $('notes').value, timeZone: tz }) });
  $('submit').disabled = false;
  if (!r.ok) { showMessage('book-message', await r.text(), true); if (r.status === 409 && selectedDay) { var again = document.querySelector('[data-day="' + selectedDay + '"]'); if (again) again.click(); } return; }
  var data = await r.json();
  $('picker').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('done-when').textContent = fmt(data.startsAt, tz) + ' (' + tz + ')';
  $('done-email').textContent = data.emailSent ? 'A confirmation was sent to ' + $('email').value + '.' : 'Save the calendar file below; no confirmation email was sent.';
  $('ics').href = data.icsUrl; $('cancel-link').href = data.cancelUrl;
};
(async function () {
  var r = await fetch('/api/book/' + slug);
  if (!r.ok) { $('calendar').innerHTML = '<p class="muted">This booking page is not available.</p>'; return; }
  info = await r.json(); days = info.days;
  $('tz').textContent = 'Times are shown in your time zone: ' + tz;
  var firstDay = days.length ? new Date(days[0] + 'T12:00:00') : new Date();
  month = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1);
  renderCalendar();
})();
`;

export function bookingPage(event: any) {
  return page(
    `${event.name} · ${event.ownerName || 'Booking'}`,
    `<div class="center" style="max-width:860px"><a href="/" class="muted">&larr; All event types</a><h1>${escapeHtml(event.name)}</h1><p class="muted">${event.durationMinutes} minutes${event.ownerName ? ` with ${escapeHtml(event.ownerName)}` : ''}${event.location ? ` · ${escapeHtml(event.location)}` : ''}</p>${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}<p class="muted" id="tz"></p>
<div id="picker" class="booking-layout"><div class="panel" id="calendar"></div><div><div class="panel"><h2 id="slot-title">Pick a day</h2><div id="slots" class="slots"><p class="muted">Select a day to see free times.</p></div></div>
<div id="form" class="panel hidden"><h2>Your details</h2><p class="muted" id="chosen"></p><form id="book-form"><label>Name<input id="name" required autocomplete="name"></label><label>Email<input id="email" type="email" required autocomplete="email"></label><label>Notes (optional)<textarea id="notes" placeholder="Anything the host should know"></textarea></label><p><button class="primary" id="submit">Confirm booking</button></p></form><p id="book-message" class="msg"></p></div></div></div>
<div id="done" class="panel hidden"><h2>You are booked</h2><p><strong id="done-when"></strong></p><p class="muted" id="done-email"></p><p><a id="ics" href="#">Add to calendar (.ics)</a> · <a id="cancel-link" href="#">Cancel this booking</a></p></div></div>`,
    bookingScript
  );
}

export function cancelPage(booking: any, timeZone: string) {
  const cancelled = booking.status === 'cancelled';
  return page(
    'Cancel booking',
    `<div class="center card"><h1>${cancelled ? 'Booking cancelled' : 'Cancel booking'}</h1><p><strong>${escapeHtml(booking.eventName)}</strong></p><p id="when" class="muted"></p>${cancelled ? '<p>This booking has already been cancelled.</p>' : '<p>Do you want to cancel this booking?</p><p><button class="danger" id="confirm">Yes, cancel it</button></p>'}<p id="m" class="msg"></p><p><a href="/cancel/${escapeHtml(booking.cancelToken)}/invite.ics">Download calendar file</a></p></div>`,
    `var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ${JSON.stringify(timeZone)};
document.getElementById('when').textContent = new Intl.DateTimeFormat(undefined, { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(${Number(booking.startsAt)})) + ' (' + tz + ')';
var b = document.getElementById('confirm');
if (b) b.onclick = async function () {
  b.disabled = true;
  var r = await fetch('/api/cancel/' + location.pathname.split('/')[2], { method: 'POST' });
  var m = document.getElementById('m');
  if (r.ok) { m.textContent = 'Your booking has been cancelled.'; b.remove(); } else { m.textContent = 'Could not cancel the booking.'; m.className = 'msg error'; b.disabled = false; }
};`
  );
}

export function loginPage() {
  return page(
    'Sign in',
    `<section class="panel center"><h1>Sign in</h1><form id="f"><label>Username<input id="u" autocomplete="username" required></label><label>Password<input id="p" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code<input id="t" autocomplete="one-time-code" placeholder="Leave empty if TOTP is not enabled"></label><p><button class="primary">Sign in</button></p></form><p id="m" class="msg"></p></section>`,
    `document.getElementById('f').onsubmit = async function (e) {
  e.preventDefault();
  var auth = 'Basic ' + btoa(document.getElementById('u').value + ':' + document.getElementById('p').value);
  var r = await fetch('/api/auth/login', { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('t').value }) });
  if (r.ok) { location = '/dashboard'; return; }
  var data = await r.json().catch(function () { return {}; });
  var m = document.getElementById('m'); m.textContent = data.error || 'Sign-in failed'; m.className = 'msg error';
};`
  );
}

const nav = (active: string) =>
  `<nav>${[
    ['/dashboard', 'Dashboard'],
    ['/dashboard/security', 'Security'],
    ['/', 'Public page'],
  ]
    .map(([href, label]) =>
      href === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`
    )
    .join(' · ')} · <button id="logout">Log out</button></nav>`;
const logoutScript = `$('logout').onclick = function () { api('/api/auth/logout', 'POST').then(function () { location = '/login'; }); };`;

const dashboardScript = `
${helpers}
var events = [], bookings = [], blocks = [], editing = null, windows = [], overview = {};
function renderWindows() {
  $('windows').innerHTML = windows.map(function (w, i) {
    return '<div class="window" data-i="' + i + '"><label>Day<select data-f="weekday">' + WEEKDAYS.map(function (n, d) { return '<option value="' + d + '"' + (d === w.weekday ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label><label>From<input type="time" data-f="start" value="' + clock(w.start) + '"></label><label>To<input type="time" data-f="end" value="' + clock(w.end) + '"></label><button type="button" data-remove>Remove</button></div>';
  }).join('') || '<p class="muted">No availability windows: nothing can be booked.</p>';
}
$('windows').onchange = function (e) {
  var box = e.target.closest('[data-i]'); if (!box) return;
  var w = windows[Number(box.getAttribute('data-i'))], f = e.target.getAttribute('data-f'), v = e.target.value;
  if (f === 'weekday') w.weekday = Number(v); else { var p = v.split(':'); w[f] = Number(p[0]) * 60 + Number(p[1]); }
};
$('windows').onclick = function (e) { var b = e.target.closest('[data-remove]'); if (!b) return; windows.splice(Number(b.closest('[data-i]').getAttribute('data-i')), 1); renderWindows(); };
$('add-window').onclick = function () { windows.push({ weekday: 1, start: 540, end: 1020 }); renderWindows(); };
function fillForm(ev) {
  editing = ev ? ev.id : null;
  ['name', 'slug', 'description', 'durationMinutes', 'bufferMinutes', 'slotStepMinutes', 'minNoticeMinutes', 'maxDaysAhead', 'location'].forEach(function (k) { $(k).value = ev ? ev[k] : $(k).defaultValue; });
  $('active').value = ev ? String(ev.active) : 'true';
  windows = ev ? ev.windows.map(function (w) { return Object.assign({}, w); }) : [1, 2, 3, 4, 5].map(function (d) { return { weekday: d, start: 540, end: 1020 }; });
  renderWindows();
  $('form-title').textContent = ev ? 'Edit event type' : 'New event type';
  $('cancel').classList.toggle('hidden', !ev);
  if (ev) window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('cancel').onclick = function () { fillForm(null); showMessage('form-message', ''); };
$('event-form').onsubmit = async function (e) {
  e.preventDefault();
  var body = { windows: windows, active: $('active').value === 'true' };
  ['name', 'slug', 'description', 'durationMinutes', 'bufferMinutes', 'slotStepMinutes', 'minNoticeMinutes', 'maxDaysAhead', 'location'].forEach(function (k) { body[k] = $(k).value; });
  var r = await api('/api/admin/event-types' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', body);
  if (r.ok) { showMessage('form-message', 'Saved'); fillForm(null); load(); } else showMessage('form-message', await r.text(), true);
};
function eventCard(ev) {
  return '<article class="card" data-event="' + ev.id + '"><div class="row"><div><strong>' + esc(ev.name) + '</strong> <span class="muted">' + ev.durationMinutes + ' min · step ' + ev.slotStepMinutes + ' min · buffer ' + ev.bufferMinutes + ' min · notice ' + ev.minNoticeMinutes + ' min · up to ' + ev.maxDaysAhead + ' days ahead</span><div class="muted"><a href="' + esc(ev.bookingUrl) + '" target="_blank" rel="noopener">' + esc(ev.bookingUrl) + '</a></div><div class="muted">' + ev.windows.map(function (w) { return WEEKDAYS[w.weekday].slice(0, 3) + ' ' + clock(w.start) + '-' + clock(w.end); }).join(', ') + '</div></div>' + (ev.active ? '<span class="badge">ACTIVE</span>' : '<span class="badge off">HIDDEN</span>') + '</div><div class="actions"><button data-action="copy">Copy link</button><button data-action="edit">Edit</button><button data-action="delete" class="danger">Delete</button></div></article>';
}
function bookingRow(b) {
  var past = b.endsAt < Date.now();
  return '<article class="card" data-booking="' + b.id + '"><div class="row"><div><strong>' + esc(fmt(b.startsAt, overview.timeZone)) + '</strong> <span class="muted">(' + esc(overview.timeZone) + ')</span><div>' + esc(b.eventName) + ' · ' + esc(b.guestName) + ' &lt;' + esc(b.guestEmail) + '&gt;</div>' + (b.notes ? '<div class="muted">' + esc(b.notes) + '</div>' : '') + '<div class="muted">Guest time zone ' + esc(b.guestTimeZone) + ' · booked ' + esc(fmt(b.createdAt, overview.timeZone)) + (b.cancelledAt ? ' · cancelled by ' + esc(b.cancelledBy) : '') + '</div></div>' + (b.status === 'cancelled' ? '<span class="badge off">CANCELLED</span>' : past ? '<span class="badge warn">PAST</span>' : '<span class="badge">CONFIRMED</span>') + '</div>' + (b.status === 'confirmed' && !past ? '<div class="actions"><a href="/cancel/' + esc(b.cancelToken) + '/invite.ics">Calendar file</a> <button data-action="cancel-booking" class="danger">Cancel booking</button></div>' : '') + '</article>';
}
function render() {
  $('summary').innerHTML = '<span>Upcoming ' + overview.upcoming + '</span><span>Today ' + overview.today + '</span><span>Event types ' + overview.eventTypes + '</span><span>Email ' + (overview.smtpConfigured ? 'on' : 'off') + '</span><span>Zone ' + esc(overview.timeZone) + '</span>';
  $('events').innerHTML = events.map(eventCard).join('') || '<p class="muted">No event types yet. Create one above.</p>';
  $('bookings').innerHTML = bookings.map(bookingRow).join('') || '<p class="muted">No bookings.</p>';
  $('blocks').innerHTML = blocks.map(function (b) { return '<div class="row" data-block="' + b.id + '"><span>' + esc(fmt(b.startsAt, overview.timeZone)) + ' → ' + esc(fmt(b.endsAt, overview.timeZone)) + (b.reason ? ' · ' + esc(b.reason) : '') + '</span><button data-action="delete-block">Remove</button></div>'; }).join('') || '<p class="muted">No blocked time.</p>';
}
async function load() {
  overview = await (await api('/api/admin/overview')).json();
  events = await (await api('/api/admin/event-types')).json();
  bookings = await (await api('/api/admin/bookings?past=' + $('show-past').checked)).json();
  blocks = await (await api('/api/admin/blocks')).json();
  render();
}
$('show-past').onchange = load;
document.body.onclick = async function (e) {
  var button = e.target.closest('[data-action]'); if (!button) return;
  var action = button.getAttribute('data-action');
  button.disabled = true;
  try {
    if (action === 'copy') { var ev = events.find(function (x) { return x.id === Number(button.closest('[data-event]').getAttribute('data-event')); }); await navigator.clipboard.writeText(ev.bookingUrl); button.textContent = 'Copied'; }
    else if (action === 'edit') fillForm(events.find(function (x) { return x.id === Number(button.closest('[data-event]').getAttribute('data-event')); }));
    else if (action === 'delete') { var id = Number(button.closest('[data-event]').getAttribute('data-event')); if (!confirm('Delete this event type and all of its bookings?')) return; await api('/api/admin/event-types/' + id, 'DELETE'); if (editing === id) fillForm(null); load(); }
    else if (action === 'cancel-booking') { var bid = Number(button.closest('[data-booking]').getAttribute('data-booking')); if (!confirm('Cancel this booking? The guest will be emailed if SMTP is configured.')) return; await api('/api/admin/bookings/' + bid + '/cancel', 'POST'); load(); }
    else if (action === 'delete-block') { await api('/api/admin/blocks/' + button.closest('[data-block]').getAttribute('data-block'), 'DELETE'); load(); }
  } finally { button.disabled = false; }
};
$('block-form').onsubmit = async function (e) {
  e.preventDefault();
  var r = await api('/api/admin/blocks', 'POST', { startsAt: new Date($('block-start').value).getTime(), endsAt: new Date($('block-end').value).getTime(), reason: $('block-reason').value });
  showMessage('block-message', r.ok ? 'Time blocked' : await r.text(), !r.ok);
  if (r.ok) { $('block-reason').value = ''; load(); }
};
${logoutScript}
fillForm(null);
load();
`;

export function dashboardPage() {
  return page(
    'Dashboard',
    `<h1>Booking dashboard</h1>${nav('/dashboard')}<div id="summary" class="summary"></div>
<section class="panel"><h2 id="form-title">New event type</h2><form id="event-form" class="grid">
<label class="wide">Name<input id="name" placeholder="30 minute call" required></label>
<label>URL slug<input id="slug" placeholder="auto from name"></label>
<label class="full">Description<textarea id="description" placeholder="What this meeting is for"></textarea></label>
<label>Duration (min)<input id="durationMinutes" type="number" min="5" value="30"></label>
<label>Slot step (min)<input id="slotStepMinutes" type="number" min="5" value="30"></label>
<label>Buffer around bookings (min)<input id="bufferMinutes" type="number" min="0" value="0"></label>
<label>Minimum notice (min)<input id="minNoticeMinutes" type="number" min="0" value="120"></label>
<label>Bookable days ahead<input id="maxDaysAhead" type="number" min="1" value="30"></label>
<label>Visibility<select id="active"><option value="true">Active</option><option value="false">Hidden</option></select></label>
<label class="full">Location or link<input id="location" placeholder="Google Meet link, phone, office address"></label>
<div class="full"><span class="muted">Weekly availability (your time zone)</span><div id="windows" class="windows"></div><p><button type="button" id="add-window">Add window</button></p></div>
<div class="full actions"><button class="primary">Save event type</button><button type="button" id="cancel" class="hidden">Cancel edit</button></div>
</form><p id="form-message" class="msg"></p></section>
<h2>Event types</h2><div id="events"></div>
<div class="row"><h2>Bookings</h2><label style="width:auto"><input type="checkbox" id="show-past" style="width:auto"> Show past and cancelled</label></div><div id="bookings"></div>
<section class="panel"><h2>Blocked time</h2><form id="block-form" class="grid"><label>From<input id="block-start" type="datetime-local" required></label><label>To<input id="block-end" type="datetime-local" required></label><label>Reason (optional)<input id="block-reason" placeholder="Vacation"></label><div class="full actions"><button class="primary">Block time</button></div></form><p id="block-message" class="msg"></p><div id="blocks"></div></section>`,
    dashboardScript
  );
}

const securityScript = `
${helpers}
async function load() {
  var x = await (await api('/api/admin/security')).json();
  $('auth-state').textContent = x.authConfigured ? 'Admin credentials are configured. ' + (x.totpConfigured ? 'TOTP is enabled.' : 'TOTP is not enabled: sign-in only needs the password.') : 'Admin credentials are not configured: the dashboard is open. Set ADMIN_USERNAME, ADMIN_PASSWORD and AUTH_ENCRYPTION_KEY to protect it.';
  $('setup').disabled = !x.authConfigured; $('disable').disabled = !x.totpConfigured;
  $('setup').textContent = x.totpConfigured ? 'Regenerate authenticator' : 'Enable authenticator';
}
$('setup').onclick = async function () {
  if (!confirm('This replaces any existing authenticator and recovery codes. Continue?')) return;
  var x = await (await api('/api/admin/security/regenerate', 'POST')).json();
  $('qr').src = x.qrDataUrl; $('qr').classList.remove('hidden');
  $('secret').textContent = 'Secret: ' + x.secret;
  $('codes').textContent = 'Recovery codes (each works once):\\n' + x.recoveryCodes.join('\\n');
  load();
};
$('disable').onclick = async function () {
  if (!confirm('Disable TOTP?')) return;
  await api('/api/admin/security/disable', 'POST');
  $('qr').classList.add('hidden'); $('codes').textContent = ''; $('secret').textContent = '';
  load();
};
${logoutScript}
load();
`;

export function securityPage() {
  return page(
    'Security',
    `<h1>Security</h1>${nav('/dashboard/security')}<section class="panel"><h2>Two-factor authentication (TOTP)</h2><p id="auth-state" class="muted">Loading...</p><div class="actions"><button id="setup" class="primary">Enable authenticator</button><button id="disable" class="danger">Disable TOTP</button></div><p><img id="qr" class="hidden" alt="TOTP QR code" style="max-width:260px;background:#fff;padding:8px;border-radius:8px"></p><p id="secret" class="muted"></p><pre id="codes"></pre></section>`,
    securityScript
  );
}
