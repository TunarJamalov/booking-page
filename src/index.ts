import 'dotenv/config';
import { openDatabase } from './db.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/bookings.db');
const app = createServer(db);
const reminderHours = Math.max(0, Number(process.env.REMINDER_HOURS ?? 24) || 0);
const reminderTimer = setInterval(() => {
  app
    .sendReminders(reminderHours)
    .catch((error) =>
      console.error(`Reminder run failed: ${error instanceof Error ? error.message : error}`)
    );
}, 60 * 1000);
const port = Number(process.env.PORT ?? 3300);
const host = process.env.HOST ?? '0.0.0.0';
const server = app.listen(port, host, () => console.log(`Booking page listening on http://${host}:${port}`));
server.on('error', (error) => {
  console.error(`Cannot listen on port ${port}: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  clearInterval(reminderTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
