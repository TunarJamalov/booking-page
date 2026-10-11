import 'dotenv/config';
import { openDatabase } from './db.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/bookings.db');
const app = createServer(db);
const port = Number(process.env.PORT ?? 3300);
const host = process.env.HOST ?? '0.0.0.0';
const server = app.listen(port, host, () => console.log(`Booking page listening on http://${host}:${port}`));
server.on('error', (error) => {
  console.error(`Cannot listen on port ${port}: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
